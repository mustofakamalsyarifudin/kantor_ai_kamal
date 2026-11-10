import "dotenv/config";
import path from "node:path";
import fs from "node:fs/promises";
import dotenv from "dotenv";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import cors from "@fastify/cors";
import jwt from "@fastify/jwt";
import bcrypt from "bcryptjs";
import OpenAI from "openai";
import {
  Prisma,
  PrismaClient,
  AgentState,
  RunStatus,
  TaskPriority,
  TaskStatus,
} from "@prisma/client";
import { Server as SocketServer } from "socket.io";
import { z, ZodError } from "zod";
import {
  createRedisConnection,
  createTaskQueue,
  priorityForQueue,
  TASK_QUEUE_NAME,
  WORKER_EVENT_CHANNEL,
  WORKER_HEARTBEAT_KEY,
  type TaskJobPayload,
} from "./task-queue.js";

dotenv.config({ path: path.resolve(process.cwd(), "../../.env") });

const prisma = new PrismaClient();
const apiHost = process.env.API_HOST || "127.0.0.1";
const apiPort = Number(process.env.API_PORT || 4000);
const frontendOrigin = process.env.FRONTEND_ORIGIN || "http://localhost:5173";
const jwtSecret = process.env.JWT_SECRET;
if (!jwtSecret || jwtSecret.startsWith("CHANGE_ME") || jwtSecret.length < 32) {
  throw new Error(
    "JWT_SECRET belum diatur. Salin .env.example menjadi .env dan isi JWT_SECRET acak minimal 32 karakter.",
  );
}

const app = Fastify({ logger: true, bodyLimit: 1_000_000 });
await app.register(cors, {
  origin: frontendOrigin,
  methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  credentials: true,
});
await app.register(jwt, { secret: jwtSecret, sign: { expiresIn: "4h" } });

const io = new SocketServer(app.server, {
  cors: { origin: frontendOrigin, methods: ["GET", "POST"], credentials: true },
  transports: ["websocket", "polling"],
});

const taskQueue = createTaskQueue();
const workerEventSubscriber = createRedisConnection();
const redisHealthClient = createRedisConnection();
const projectRoot = path.resolve(
  process.cwd(),
  path.basename(process.cwd()) === "api" ? "../.." : ".",
);
const artifactRoot = path.resolve(
  projectRoot,
  process.env.ARTIFACTS_DIR || "data/artifacts",
);
const executorMode = (process.env.TASK_EXECUTOR_MODE || "dry-run")
  .trim()
  .toLowerCase();
const openAiApiKey = process.env.OPENAI_API_KEY?.trim() || "";
const openAiModel = process.env.OPENAI_MODEL?.trim() || "gpt-5.5";
const openAiConfigured = Boolean(
  openAiApiKey && !openAiApiKey.startsWith("CHANGE_ME"),
);

function safeProviderError(error: unknown): string {
  const raw =
    error instanceof Error
      ? error.message
      : "Kesalahan provider OpenAI yang tidak diketahui.";
  return raw
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, "[REDACTED_API_KEY]")
    .replace(/Bearer\s+[^\s]+/gi, "Bearer [REDACTED]")
    .slice(0, 500);
}

io.use((socket, next) => {
  const token = socket.handshake.auth?.token;
  if (typeof token !== "string" || !token)
    return next(new Error("UNAUTHORIZED"));
  try {
    const payload = app.jwt.verify(token) as {
      sub: string;
      workspaceId: string;
    };
    if (!payload.workspaceId || !payload.sub)
      return next(new Error("UNAUTHORIZED"));
    socket.data.userId = payload.sub;
    socket.data.workspaceId = payload.workspaceId;
    next();
  } catch {
    next(new Error("UNAUTHORIZED"));
  }
});

io.on("connection", (socket) => {
  socket.join(`workspace:${String(socket.data.workspaceId)}`);
  socket.emit("workspace:connected", { workspaceId: socket.data.workspaceId });
});

void workerEventSubscriber
  .subscribe(WORKER_EVENT_CHANNEL)
  .catch((error: unknown) => {
    app.log.error(
      { err: error },
      "Tidak dapat subscribe event task worker dari Redis",
    );
  });
workerEventSubscriber.on("message", (channel: string, rawMessage: string) => {
  if (channel !== WORKER_EVENT_CHANNEL) return;
  try {
    const event = JSON.parse(rawMessage) as {
      workspaceId?: string;
      type?: string;
      data?: unknown;
      at?: string;
    };
    if (!event.workspaceId || !event.type) return;
    emitWorkspace(event.workspaceId, event.type, event.data);
  } catch (error) {
    app.log.warn({ err: error }, "Pesan event worker tidak valid");
  }
});

function emitWorkspace(workspaceId: string, type: string, data: unknown) {
  io.to(`workspace:${workspaceId}`).emit("workspace:event", {
    type,
    data,
    at: new Date().toISOString(),
  });
}

async function authenticate(request: FastifyRequest, reply: FastifyReply) {
  try {
    await request.jwtVerify();
  } catch {
    return reply.code(401).send({
      error: "UNAUTHORIZED",
      message: "Sesi tidak valid atau sudah berakhir. Silakan login kembali.",
    });
  }
}

function workspaceIdOf(request: FastifyRequest): string {
  return request.user.workspaceId;
}

function safeAgent(agent: any) {
  if (!agent) return agent;
  const { systemPrompt, ...safe } = agent;
  return { ...safe, hasSystemPrompt: Boolean(systemPrompt) };
}

function slugify(value: string) {
  return (
    value
      .normalize("NFKD")
      .toLowerCase()
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 55) || "agent"
  );
}

async function uniqueAgentSlug(workspaceId: string, name: string) {
  const base = slugify(name);
  let candidate = base;
  let suffix = 2;
  while (
    await prisma.agent.findUnique({
      where: { workspaceId_slug: { workspaceId, slug: candidate } },
      select: { id: true },
    })
  ) {
    candidate = `${base}-${suffix++}`;
  }
  return candidate;
}

const loginSchema = z.object({
  email: z.string().email().max(254),
  password: z.string().min(1).max(200),
});
const agentCreateSchema = z.object({
  name: z.string().trim().min(2).max(60),
  role: z.string().trim().min(2).max(100),
  departmentCode: z.string().trim().min(2).max(40),
  description: z.string().trim().max(2000).optional().default(""),
  systemPrompt: z.string().max(12000).optional().default(""),
  provider: z.string().trim().max(50).optional().nullable(),
  model: z.string().trim().max(100).optional().nullable(),
  allowedTools: z
    .array(z.string().trim().min(1).max(80))
    .max(50)
    .optional()
    .default([]),
  dailyBudget: z.number().positive().max(10000).optional().nullable(),
  visualConfig: z.record(z.unknown()).optional().nullable(),
});
const agentUpdateSchema = agentCreateSchema
  .partial()
  .extend({ enabled: z.boolean().optional() });
const taskCreateSchema = z.object({
  title: z.string().trim().min(3).max(180),
  instruction: z.string().trim().min(3).max(12000),
  priority: z.nativeEnum(TaskPriority).optional().default(TaskPriority.NORMAL),
  assignedAgentId: z.string().optional().nullable(),
  dueAt: z.string().datetime().optional().nullable(),
  submitNow: z.boolean().optional().default(false),
});
const taskStatusSchema = z.object({ status: z.nativeEnum(TaskStatus) });
const managerPlanTaskSchema = z.object({
  title: z.string().trim().min(3).max(160),
  instruction: z.string().trim().min(10).max(6000),
  assignedAgentId: z.string().min(1),
  priority: z.nativeEnum(TaskPriority).default(TaskPriority.NORMAL),
  rationale: z.string().trim().max(1200).default(""),
  acceptanceCriteria: z.string().trim().max(1200).default(""),
});
const managerPlanSchema = z.object({
  planTitle: z.string().trim().min(3).max(180),
  summary: z.string().trim().min(10).max(3000),
  tasks: z.array(managerPlanTaskSchema).min(2).max(6),
});
const managerPlanRequestSchema = z.object({
  goal: z.string().trim().min(10).max(5000),
  maxTasks: z.number().int().min(2).max(6).optional().default(4),
});
const managerLaunchSchema = z.object({
  goal: z.string().trim().min(10).max(5000),
  plan: managerPlanSchema,
  launchKey: z.string().trim().min(16).max(100),
});

const transitions: Record<TaskStatus, TaskStatus[]> = {
  DRAFT: ["QUEUED", "CANCELLED"],
  QUEUED: ["PLANNING", "RUNNING", "PAUSED", "CANCELLED", "BLOCKED"],
  PLANNING: ["RUNNING", "REVIEW_REQUIRED", "BLOCKED", "FAILED", "CANCELLED"],
  RUNNING: [
    "REVIEW_REQUIRED",
    "COMPLETED",
    "BLOCKED",
    "FAILED",
    "PAUSED",
    "CANCELLED",
  ],
  REVIEW_REQUIRED: ["COMPLETED", "RUNNING", "CANCELLED"],
  COMPLETED: [],
  PAUSED: ["QUEUED", "RUNNING", "CANCELLED"],
  FAILED: ["QUEUED", "CANCELLED"],
  CANCELLED: [],
  BLOCKED: ["QUEUED", "CANCELLED"],
};

function httpError(statusCode: number, message: string) {
  return Object.assign(new Error(message), { statusCode });
}

async function queueTaskRecord(
  taskId: string,
  workspaceId: string,
  actorId: string,
  allowedFrom: TaskStatus[],
) {
  const task = await prisma.task.findFirst({
    where: { id: taskId, workspaceId },
    include: { assignedAgent: true },
  });
  if (!task) throw httpError(404, "Tugas tidak ditemukan di workspace ini.");
  if (!allowedFrom.includes(task.status)) {
    throw httpError(
      409,
      `Tugas berstatus ${task.status} tidak dapat dimasukkan ke antrean dari tindakan ini.`,
    );
  }
  if (!task.assignedAgentId || !task.assignedAgent) {
    throw httpError(
      400,
      "Pilih agent penanggung jawab sebelum memasukkan tugas ke antrean.",
    );
  }
  if (!task.assignedAgent.enabled)
    throw httpError(
      400,
      "Agent penanggung jawab tidak aktif. Aktifkan agent atau pilih agent lain.",
    );

  const changed = await prisma.$transaction(async (tx) => {
    const update = await tx.task.updateMany({
      where: { id: task.id, workspaceId, status: task.status },
      data: { status: TaskStatus.QUEUED },
    });
    if (update.count !== 1)
      throw httpError(
        409,
        "Status tugas berubah saat akan dimasukkan ke antrean. Muat ulang data dan coba lagi.",
      );
    await tx.runEvent.create({
      data: {
        taskId: task.id,
        eventType: "task.queued",
        actorType: "USER",
        message: `Tugas dimasukkan ke antrean dari status ${task.status}.`,
        payload: {
          from: task.status,
          to: TaskStatus.QUEUED,
          priority: task.priority,
        },
      },
    });
    await tx.auditLog.create({
      data: {
        workspaceId,
        actorId,
        action: "task.queued",
        entityType: "task",
        entityId: task.id,
        metadata: { from: task.status, priority: task.priority },
      },
    });
    return tx.task.findUniqueOrThrow({
      where: { id: task.id },
      include: {
        assignedAgent: {
          select: { id: true, name: true, role: true, state: true },
        },
      },
    });
  });

  try {
    const jobPayload: TaskJobPayload = {
      taskId: changed.id,
      workspaceId,
      actorId,
      queuedAt: new Date().toISOString(),
    };
    const job = await taskQueue.add("execute-task", jobPayload, {
      jobId: `${changed.id}-${Date.now()}`,
      priority: priorityForQueue(changed.priority),
      attempts: 1,
      removeOnComplete: 500,
      removeOnFail: 1000,
    });
    await prisma.runEvent.create({
      data: {
        taskId: changed.id,
        eventType: "queue.job_added",
        actorType: "SYSTEM",
        message: "Job diterima antrean Redis/BullMQ.",
        payload: {
          jobId: job.id ?? null,
          queue: TASK_QUEUE_NAME,
          priority: changed.priority,
        },
      },
    });
    emitWorkspace(workspaceId, "task.queued", {
      ...changed,
      jobId: job.id,
      queue: TASK_QUEUE_NAME,
    });
    return changed;
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Koneksi antrean tidak tersedia.";
    const blocked = await prisma.$transaction(async (tx) => {
      await tx.task.updateMany({
        where: { id: changed.id, workspaceId, status: TaskStatus.QUEUED },
        data: { status: TaskStatus.BLOCKED },
      });
      await tx.runEvent.create({
        data: {
          taskId: changed.id,
          eventType: "queue.enqueue_failed",
          actorType: "SYSTEM",
          message: "Tugas tidak dapat dimasukkan ke antrean Redis.",
          payload: { error: message },
        },
      });
      await tx.auditLog.create({
        data: {
          workspaceId,
          actorId,
          action: "task.enqueue_failed",
          entityType: "task",
          entityId: changed.id,
          metadata: { error: message },
        },
      });
      return tx.task.findUniqueOrThrow({
        where: { id: changed.id },
        include: {
          assignedAgent: {
            select: { id: true, name: true, role: true, state: true },
          },
        },
      });
    });
    emitWorkspace(workspaceId, "task.queue_failed", {
      taskId: changed.id,
      message,
      status: TaskStatus.BLOCKED,
    });
    return {
      ...blocked,
      queueWarning:
        "Redis/BullMQ tidak menerima job. Periksa layanan Redis dan task worker.",
    };
  }
}

async function removeWaitingJobs(taskId: string) {
  const jobs = await taskQueue
    .getJobs(["waiting", "delayed", "paused"], 0, 1000, true)
    .catch(() => []);
  await Promise.allSettled(
    jobs.filter((job) => job.data.taskId === taskId).map((job) => job.remove()),
  );
}

async function changeControlTaskStatus(
  taskId: string,
  workspaceId: string,
  actorId: string,
  nextStatus: TaskStatus,
  allowedFrom: TaskStatus[],
  eventType: string,
  message: string,
) {
  const existing = await prisma.task.findFirst({
    where: { id: taskId, workspaceId },
  });
  if (!existing)
    throw httpError(404, "Tugas tidak ditemukan di workspace ini.");
  if (!allowedFrom.includes(existing.status))
    throw httpError(
      409,
      `Tugas berstatus ${existing.status} tidak dapat ${message.toLowerCase()}.`,
    );
  const updated = await prisma.$transaction(async (tx) => {
    const update = await tx.task.updateMany({
      where: { id: taskId, workspaceId, status: existing.status },
      data: { status: nextStatus },
    });
    if (update.count !== 1)
      throw httpError(
        409,
        "Status tugas berubah saat tindakan diproses. Muat ulang data dan coba lagi.",
      );
    await tx.runEvent.create({
      data: {
        taskId,
        eventType,
        actorType: "USER",
        message,
        payload: { from: existing.status, to: nextStatus },
      },
    });
    await tx.auditLog.create({
      data: {
        workspaceId,
        actorId,
        action: eventType,
        entityType: "task",
        entityId: taskId,
        metadata: { from: existing.status, to: nextStatus },
      },
    });
    return tx.task.findUniqueOrThrow({
      where: { id: taskId },
      include: {
        assignedAgent: {
          select: { id: true, name: true, role: true, state: true },
        },
        _count: { select: { runs: true, artifacts: true } },
      },
    });
  });
  emitWorkspace(workspaceId, eventType, updated);
  return updated;
}

async function syncManagerPlanParentStatus(
  childTaskId: string,
  workspaceId: string,
) {
  const child = await prisma.task.findFirst({
    where: { id: childTaskId, workspaceId },
    select: { parentTaskId: true },
  });
  if (!child?.parentTaskId) return;
  const parent = await prisma.task.findFirst({
    where: { id: child.parentTaskId, workspaceId },
  });
  if (!parent) return;
  const metadata =
    parent.metadata &&
    typeof parent.metadata === "object" &&
    !Array.isArray(parent.metadata)
      ? (parent.metadata as Record<string, unknown>)
      : {};
  if (metadata.managerPlan !== true) return;
  const children = await prisma.task.findMany({
    where: { workspaceId, parentTaskId: parent.id },
    select: { status: true },
  });
  if (children.length === 0) return;
  const statuses = children.map((item) => item.status);
  let nextStatus: TaskStatus = parent.status;
  let planState = String(metadata.managerPlanStatus || "RUNNING");
  if (statuses.every((status) => status === TaskStatus.COMPLETED)) {
    nextStatus = TaskStatus.REVIEW_REQUIRED;
    planState = "REVIEW_REQUIRED";
  } else if (
    statuses.every((status) =>
      new Set<TaskStatus>([
        TaskStatus.COMPLETED,
        TaskStatus.FAILED,
        TaskStatus.BLOCKED,
        TaskStatus.CANCELLED,
      ]).has(status),
    ) &&
    statuses.some((status) =>
      new Set<TaskStatus>([
        TaskStatus.FAILED,
        TaskStatus.BLOCKED,
        TaskStatus.CANCELLED,
      ]).has(status),
    )
  ) {
    nextStatus = TaskStatus.BLOCKED;
    planState = "BLOCKED";
  } else if (
    parent.status === TaskStatus.BLOCKED &&
    statuses.some((status) =>
      new Set<TaskStatus>([
        TaskStatus.DRAFT,
        TaskStatus.QUEUED,
        TaskStatus.PLANNING,
        TaskStatus.RUNNING,
        TaskStatus.REVIEW_REQUIRED,
      ]).has(status),
    )
  ) {
    nextStatus = TaskStatus.PLANNING;
    planState = "RUNNING";
  }
  if (
    nextStatus === parent.status &&
    planState === String(metadata.managerPlanStatus || "RUNNING")
  )
    return;
  const nextMetadata = {
    ...metadata,
    managerPlanStatus: planState,
    childTaskCount: children.length,
  } as Prisma.InputJsonValue;
  const updated = await prisma.task.update({
    where: { id: parent.id },
    data: { status: nextStatus, metadata: nextMetadata },
  });
  await prisma.runEvent.create({
    data: {
      taskId: parent.id,
      eventType: "manager.plan_status_changed",
      actorType: "SYSTEM",
      message: `Status rencana Manager AI diperbarui menjadi ${nextStatus}.`,
      payload: { status: nextStatus, planState, childStatuses: statuses },
    },
  });
  emitWorkspace(workspaceId, "task.manager_plan_status_changed", {
    taskId: parent.id,
    status: updated.status,
    planState,
    childCount: children.length,
  });
}

function asJsonRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function managerPlanChildReady(metadataValue: unknown): boolean {
  const metadata = asJsonRecord(metadataValue);
  if (metadata.managerPlanChild !== true) return true;
  if (metadata.managerPlanReady === true) return true;
  if (metadata.managerPlanReady === false) return false;
  // Backward compatibility for older M4 tasks: only sequence 1 is a root task.
  return Number(metadata.sequence) === 1;
}

function safeArtifactPath(storageKey: string): string {
  const filePath = path.resolve(artifactRoot, storageKey);
  const allowedPrefix = artifactRoot.endsWith(path.sep)
    ? artifactRoot
    : `${artifactRoot}${path.sep}`;
  if (!filePath.startsWith(allowedPrefix)) {
    throw new Error(
      "Lokasi artefak berada di luar direktori penyimpanan yang diizinkan.",
    );
  }
  return filePath;
}

async function readLatestMarkdownArtifact(workspaceId: string, taskId: string) {
  const artifacts = await prisma.artifact.findMany({
    where: { workspaceId, taskId, mimeType: "text/markdown" },
    orderBy: { createdAt: "desc" },
    take: 10,
  });
  const artifact =
    artifacts.find((item) => item.name.toLowerCase().endsWith(".md")) ||
    artifacts[0];
  if (!artifact) return null;
  const metadata = asJsonRecord(artifact.metadata);
  if (metadata.diagnosticOnly === true) {
    throw new Error(
      "Artefak sumber hanya diagnostik dan tidak boleh dipakai sebagai hasil AI.",
    );
  }
  const content = await fs.readFile(
    safeArtifactPath(artifact.storageKey),
    "utf8",
  );
  return { artifact, content };
}

async function releaseManagerPlanDependents(
  sourceTaskId: string,
  workspaceId: string,
  actorId: string,
): Promise<{ released: number; warning: string | null }> {
  const source = await prisma.task.findFirst({
    where: { id: sourceTaskId, workspaceId },
  });
  if (
    !source ||
    source.status !== TaskStatus.COMPLETED ||
    !source.parentTaskId
  ) {
    return { released: 0, warning: null };
  }
  const sourceMetadata = asJsonRecord(source.metadata);
  if (sourceMetadata.managerPlanChild !== true)
    return { released: 0, warning: null };
  const sourceSequence = Number(sourceMetadata.sequence);
  if (!Number.isInteger(sourceSequence) || sourceSequence < 1)
    return { released: 0, warning: null };

  const parent = await prisma.task.findFirst({
    where: { id: source.parentTaskId, workspaceId },
  });
  if (!parent || asJsonRecord(parent.metadata).managerPlan !== true) {
    return { released: 0, warning: null };
  }

  const sourceArtifact = await readLatestMarkdownArtifact(
    workspaceId,
    source.id,
  );
  if (!sourceArtifact) {
    return {
      released: 0,
      warning:
        "Hasil Markdown subtugas prasyarat belum tersedia; subtugas lanjutan tetap menunggu.",
    };
  }
  const clippedSource = sourceArtifact.content.slice(0, 14000);
  const truncatedNote =
    sourceArtifact.content.length > 14000
      ? "\n[Catatan: konteks dipotong pada 14.000 karakter agar tetap terukur.]\n"
      : "";
  const contextBlock = [
    "KONTEKS KOLABORASI — HASIL SUBTUGAS YANG TELAH DISETUJUI MANUSIA",
    `Sumber: ${source.title}`,
    `Artefak sumber: ${sourceArtifact.artifact.name} (ID: ${sourceArtifact.artifact.id})`,
    "Gunakan materi berikut sebagai konteks kerja. Pertahankan fakta yang didukung; tandai klaim yang memerlukan verifikasi. Jangan menganggapnya sebagai sumber hukum resmi jika sumber resmi tidak disertakan.",
    "--- AWAL HASIL SUMBER ---",
    clippedSource,
    truncatedNote,
    "--- AKHIR HASIL SUMBER ---",
  ]
    .filter(Boolean)
    .join("\n\n");

  const children = await prisma.task.findMany({
    where: { workspaceId, parentTaskId: parent.id },
    orderBy: { createdAt: "asc" },
  });
  let released = 0;
  let warning: string | null = null;
  for (const child of children) {
    const childMetadata = asJsonRecord(child.metadata);
    const dependencies = Array.isArray(childMetadata.dependsOnSequence)
      ? childMetadata.dependsOnSequence.map(Number)
      : [];
    if (
      childMetadata.managerPlanChild !== true ||
      !dependencies.includes(sourceSequence)
    )
      continue;
    if (
      child.status !== TaskStatus.DRAFT &&
      child.status !== TaskStatus.BLOCKED
    ) {
      continue;
    }
    const contextAlreadyAttached =
      childMetadata.managerPlanContextSourceTaskId === source.id &&
      childMetadata.managerPlanReady === true;
    const updatedChild = await prisma.task.update({
      where: { id: child.id },
      data: {
        ...(contextAlreadyAttached
          ? {}
          : {
              instruction: `${child.instruction}\n\n${contextBlock}`,
            }),
        metadata: {
          ...childMetadata,
          managerPlanReady: true,
          managerPlanStage: "READY",
          managerPlanContextSourceTaskId: source.id,
          managerPlanContextArtifactId: sourceArtifact.artifact.id,
          managerPlanContextInjectedAt: contextAlreadyAttached
            ? typeof childMetadata.managerPlanContextInjectedAt === "string"
              ? childMetadata.managerPlanContextInjectedAt
              : new Date().toISOString()
            : new Date().toISOString(),
        } as Prisma.InputJsonValue,
      },
    });
    if (!contextAlreadyAttached) {
      await prisma.runEvent.create({
        data: {
          taskId: child.id,
          eventType: "manager.context_attached",
          actorType: "MANAGER",
          message: `Konteks hasil '${source.title}' dilampirkan sebelum subtugas ini dijalankan.`,
          payload: {
            sourceTaskId: source.id,
            sourceArtifactId: sourceArtifact.artifact.id,
            sourceSequence,
          },
        },
      });
    }

    const queued = await queueTaskRecord(
      updatedChild.id,
      workspaceId,
      actorId,
      [TaskStatus.DRAFT, TaskStatus.BLOCKED],
    );
    if ("queueWarning" in queued && queued.queueWarning) {
      warning = warning || queued.queueWarning;
      continue;
    }
    released += 1;
    await prisma.runEvent.create({
      data: {
        taskId: child.id,
        eventType: "manager.subtask_released",
        actorType: "MANAGER",
        message:
          "Subtugas dibuka setelah hasil prasyarat disetujui dan konteks disiapkan.",
        payload: {
          sourceTaskId: source.id,
          sequence: childMetadata.sequence ?? null,
        },
      },
    });
  }
  if (released > 0) {
    emitWorkspace(workspaceId, "task.manager_dependents_released", {
      parentTaskId: parent.id,
      sourceTaskId: source.id,
      releasedCount: released,
    });
  }
  return { released, warning };
}

app.setErrorHandler((error, request, reply) => {
  if (error instanceof ZodError) {
    return reply.code(400).send({
      error: "VALIDATION_ERROR",
      message: "Periksa kembali data yang dikirim.",
      details: error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
    });
  }
  if (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2002"
  ) {
    return reply.code(409).send({
      error: "CONFLICT",
      message: "Data dengan identitas tersebut sudah ada.",
    });
  }
  const statusCode = Number(
    (error as Error & { statusCode?: number }).statusCode || 500,
  );
  if (statusCode >= 400 && statusCode < 500) {
    return reply.code(statusCode).send({
      error: "REQUEST_ERROR",
      message: error instanceof Error ? error.message : String(error),
    });
  }
  request.log.error({ err: error }, "Unhandled request error");
  return reply.code(500).send({
    error: "INTERNAL_ERROR",
    message: "Terjadi kesalahan internal. Periksa log API untuk detail.",
  });
});

app.get("/health", async (_request, reply) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return {
      status: "ok",
      database: "connected",
      service: "kantorai-api",
      time: new Date().toISOString(),
    };
  } catch {
    return reply.code(503).send({
      status: "degraded",
      database: "unavailable",
      service: "kantorai-api",
    });
  }
});

app.post("/api/auth/login", async (request, reply) => {
  const body = loginSchema.parse(request.body);
  const user = await prisma.user.findUnique({
    where: { email: body.email.toLowerCase() },
    include: { workspace: true },
  });
  if (
    !user ||
    !user.active ||
    !(await bcrypt.compare(body.password, user.passwordHash)) ||
    !user.workspace
  ) {
    return reply.code(401).send({
      error: "INVALID_CREDENTIALS",
      message: "Email atau password tidak sesuai, atau workspace belum dibuat.",
    });
  }
  const token = app.jwt.sign({
    sub: user.id,
    email: user.email,
    name: user.name,
    workspaceId: user.workspace.id,
  });
  return {
    accessToken: token,
    tokenType: "Bearer",
    expiresInSeconds: 14400,
    user: { id: user.id, email: user.email, name: user.name },
    workspace: {
      id: user.workspace.id,
      name: user.workspace.name,
      slug: user.workspace.slug,
    },
  };
});

app.get("/api/me", { preHandler: authenticate }, async (request) => {
  return {
    user: {
      id: request.user.sub,
      email: request.user.email,
      name: request.user.name,
    },
    workspaceId: request.user.workspaceId,
  };
});

app.get("/api/departments", { preHandler: authenticate }, async (request) => {
  return prisma.department.findMany({
    where: { workspaceId: workspaceIdOf(request) },
    orderBy: { sortOrder: "asc" },
  });
});

app.get("/api/agents", { preHandler: authenticate }, async (request) => {
  const agents = await prisma.agent.findMany({
    where: { workspaceId: workspaceIdOf(request) },
    include: { department: { select: { id: true, code: true, name: true } } },
    orderBy: [{ enabled: "desc" }, { createdAt: "asc" }],
  });
  return agents.map(safeAgent);
});

app.get<{ Params: { id: string } }>(
  "/api/agents/:id",
  { preHandler: authenticate },
  async (request, reply) => {
    const agent = await prisma.agent.findFirst({
      where: { id: request.params.id, workspaceId: workspaceIdOf(request) },
      include: { department: true },
    });
    if (!agent)
      return reply
        .code(404)
        .send({ error: "NOT_FOUND", message: "Agent tidak ditemukan." });
    return safeAgent(agent);
  },
);

app.post(
  "/api/agents",
  { preHandler: authenticate },
  async (request, reply) => {
    const body = agentCreateSchema.parse(request.body);
    const workspaceId = workspaceIdOf(request);
    const department = await prisma.department.findFirst({
      where: { workspaceId, code: body.departmentCode },
    });
    if (!department)
      return reply.code(400).send({
        error: "INVALID_DEPARTMENT",
        message: "Departemen tidak ditemukan di workspace ini.",
      });
    const slug = await uniqueAgentSlug(workspaceId, body.name);
    const agent = await prisma.agent.create({
      data: {
        workspaceId,
        slug,
        name: body.name,
        role: body.role,
        departmentId: department.id,
        description: body.description,
        systemPrompt: body.systemPrompt,
        provider: body.provider ?? null,
        model: body.model ?? null,
        allowedTools: body.allowedTools,
        dailyBudget:
          body.dailyBudget == null
            ? null
            : new Prisma.Decimal(body.dailyBudget),
        visualConfig:
          body.visualConfig == null
            ? Prisma.JsonNull
            : (body.visualConfig as Prisma.InputJsonValue),
      },
      include: { department: { select: { id: true, code: true, name: true } } },
    });
    emitWorkspace(workspaceId, "agent.created", safeAgent(agent));
    await prisma.auditLog.create({
      data: {
        workspaceId,
        actorId: request.user.sub,
        action: "agent.created",
        entityType: "agent",
        entityId: agent.id,
        metadata: { name: agent.name, role: agent.role },
      },
    });
    return safeAgent(agent);
  },
);

app.patch<{ Params: { id: string } }>(
  "/api/agents/:id",
  { preHandler: authenticate },
  async (request, reply) => {
    const body = agentUpdateSchema.parse(request.body);
    const workspaceId = workspaceIdOf(request);
    const existing = await prisma.agent.findFirst({
      where: { id: request.params.id, workspaceId },
    });
    if (!existing)
      return reply
        .code(404)
        .send({ error: "NOT_FOUND", message: "Agent tidak ditemukan." });
    const data: Prisma.AgentUpdateInput = {};
    if (body.name !== undefined) data.name = body.name;
    if (body.role !== undefined) data.role = body.role;
    if (body.description !== undefined) data.description = body.description;
    if (body.systemPrompt !== undefined) data.systemPrompt = body.systemPrompt;
    if (body.provider !== undefined) data.provider = body.provider;
    if (body.model !== undefined) data.model = body.model;
    if (body.allowedTools !== undefined) data.allowedTools = body.allowedTools;
    if (body.dailyBudget !== undefined)
      data.dailyBudget =
        body.dailyBudget == null ? null : new Prisma.Decimal(body.dailyBudget);
    if (body.visualConfig !== undefined)
      data.visualConfig =
        body.visualConfig == null
          ? Prisma.JsonNull
          : (body.visualConfig as Prisma.InputJsonValue);
    if (body.enabled !== undefined) {
      data.enabled = body.enabled;
      if (!body.enabled) data.state = AgentState.DISABLED;
      else if (existing.state === AgentState.DISABLED)
        data.state = AgentState.IDLE;
    }
    if (body.departmentCode !== undefined) {
      const department = await prisma.department.findFirst({
        where: { workspaceId, code: body.departmentCode },
      });
      if (!department)
        return reply.code(400).send({
          error: "INVALID_DEPARTMENT",
          message: "Departemen tidak ditemukan di workspace ini.",
        });
      data.department = { connect: { id: department.id } };
    }
    const agent = await prisma.agent.update({
      where: { id: existing.id },
      data,
      include: { department: { select: { id: true, code: true, name: true } } },
    });
    emitWorkspace(workspaceId, "agent.updated", safeAgent(agent));
    await prisma.auditLog.create({
      data: {
        workspaceId,
        actorId: request.user.sub,
        action: "agent.updated",
        entityType: "agent",
        entityId: agent.id,
        metadata: { name: agent.name },
      },
    });
    return safeAgent(agent);
  },
);

for (const enabled of [false, true]) {
  app.post<{ Params: { id: string } }>(
    `/api/agents/:id/${enabled ? "enable" : "disable"}`,
    { preHandler: authenticate },
    async (request, reply) => {
      const workspaceId = workspaceIdOf(request);
      const existing = await prisma.agent.findFirst({
        where: { id: request.params.id, workspaceId },
      });
      if (!existing)
        return reply
          .code(404)
          .send({ error: "NOT_FOUND", message: "Agent tidak ditemukan." });
      const agent = await prisma.agent.update({
        where: { id: existing.id },
        data: {
          enabled,
          state: enabled ? AgentState.IDLE : AgentState.DISABLED,
        },
        include: {
          department: { select: { id: true, code: true, name: true } },
        },
      });
      emitWorkspace(workspaceId, "agent.updated", safeAgent(agent));
      await prisma.auditLog.create({
        data: {
          workspaceId,
          actorId: request.user.sub,
          action: enabled ? "agent.enabled" : "agent.disabled",
          entityType: "agent",
          entityId: agent.id,
        },
      });
      return safeAgent(agent);
    },
  );
}

app.get("/api/tasks", { preHandler: authenticate }, async (request) => {
  return prisma.task.findMany({
    where: { workspaceId: workspaceIdOf(request) },
    include: {
      assignedAgent: {
        select: { id: true, name: true, role: true, state: true },
      },
      _count: { select: { runs: true, artifacts: true } },
    },
    orderBy: { createdAt: "desc" },
    take: 200,
  });
});

app.post("/api/tasks", { preHandler: authenticate }, async (request, reply) => {
  const body = taskCreateSchema.parse(request.body);
  const workspaceId = workspaceIdOf(request);
  if (body.submitNow && !body.assignedAgentId) {
    return reply.code(400).send({
      error: "AGENT_REQUIRED",
      message:
        "Pilih agent penanggung jawab sebelum memasukkan tugas ke antrean.",
    });
  }
  if (body.assignedAgentId) {
    const agent = await prisma.agent.findFirst({
      where: { id: body.assignedAgentId, workspaceId, enabled: true },
    });
    if (!agent)
      throw httpError(
        400,
        "Agent tidak ditemukan, tidak aktif, atau di luar workspace.",
      );
  }
  const task = await prisma.task.create({
    data: {
      workspaceId,
      title: body.title,
      instruction: body.instruction,
      priority: body.priority,
      status: TaskStatus.DRAFT,
      assignedAgentId: body.assignedAgentId ?? null,
      dueAt: body.dueAt ? new Date(body.dueAt) : null,
      runEvents: {
        create: {
          eventType: "task.created",
          actorType: "USER",
          message: "Draft tugas dibuat.",
          payload: { status: TaskStatus.DRAFT, priority: body.priority },
        },
      },
    },
    include: {
      assignedAgent: {
        select: { id: true, name: true, role: true, state: true },
      },
      _count: { select: { runs: true, artifacts: true } },
    },
  });
  emitWorkspace(workspaceId, "task.created", task);
  await prisma.auditLog.create({
    data: {
      workspaceId,
      actorId: request.user.sub,
      action: "task.created",
      entityType: "task",
      entityId: task.id,
      metadata: { status: task.status, title: task.title },
    },
  });
  if (body.submitNow)
    return queueTaskRecord(task.id, workspaceId, request.user.sub, [
      TaskStatus.DRAFT,
    ]);
  return task;
});

app.post<{ Params: { id: string } }>(
  "/api/tasks/:id/queue",
  { preHandler: authenticate },
  async (request, reply) => {
    const workspaceId = workspaceIdOf(request);
    const existing = await prisma.task.findFirst({
      where: { id: request.params.id, workspaceId },
      select: { status: true, metadata: true },
    });
    if (!existing)
      return reply
        .code(404)
        .send({
          error: "NOT_FOUND",
          message: "Tugas tidak ditemukan di workspace ini.",
        });
    if (!managerPlanChildReady(existing.metadata)) {
      return reply.code(409).send({
        error: "MANAGER_PLAN_DEPENDENCY_PENDING",
        message:
          "Subtugas ini menunggu hasil dan persetujuan subtugas prasyarat. Jangan antrekan secara manual dulu.",
      });
    }
    const updated = await queueTaskRecord(
      request.params.id,
      workspaceId,
      request.user.sub,
      [TaskStatus.DRAFT],
    );
    await syncManagerPlanParentStatus(request.params.id, workspaceId).catch(
      (error) =>
        request.log.warn(
          { err: error, taskId: request.params.id },
          "Status rencana induk tidak dapat disinkronkan",
        ),
    );
    return updated;
  },
);

app.post<{ Params: { id: string } }>(
  "/api/tasks/:id/retry",
  { preHandler: authenticate },
  async (request, reply) => {
    const workspaceId = workspaceIdOf(request);
    const existing = await prisma.task.findFirst({
      where: { id: request.params.id, workspaceId },
      select: { status: true, metadata: true },
    });
    if (!existing)
      throw httpError(404, "Tugas tidak ditemukan di workspace ini.");
    const metadata =
      existing.metadata &&
      typeof existing.metadata === "object" &&
      !Array.isArray(existing.metadata)
        ? (existing.metadata as Record<string, unknown>)
        : {};
    if (!managerPlanChildReady(metadata)) {
      return reply.code(409).send({
        error: "MANAGER_PLAN_DEPENDENCY_PENDING",
        message:
          "Subtugas ini belum dilepas oleh workflow Manager AI karena hasil prasyarat belum disetujui.",
      });
    }
    const retryableStatuses: TaskStatus[] = [
      TaskStatus.FAILED,
      TaskStatus.BLOCKED,
    ];
    if (
      existing.status === TaskStatus.REVIEW_REQUIRED &&
      metadata.diagnosticOnly === true
    )
      retryableStatuses.push(TaskStatus.REVIEW_REQUIRED);
    const updated = await queueTaskRecord(
      request.params.id,
      workspaceId,
      request.user.sub,
      retryableStatuses,
    );
    await syncManagerPlanParentStatus(request.params.id, workspaceId).catch(
      (error) =>
        request.log.warn(
          { err: error, taskId: request.params.id },
          "Status rencana induk tidak dapat disinkronkan",
        ),
    );
    return updated;
  },
);

app.post<{ Params: { id: string } }>(
  "/api/tasks/:id/resume",
  { preHandler: authenticate },
  async (request) => {
    const workspaceId = workspaceIdOf(request);
    const updated = await queueTaskRecord(
      request.params.id,
      workspaceId,
      request.user.sub,
      [TaskStatus.PAUSED],
    );
    await syncManagerPlanParentStatus(request.params.id, workspaceId).catch(
      (error) =>
        request.log.warn(
          { err: error, taskId: request.params.id },
          "Status rencana induk tidak dapat disinkronkan",
        ),
    );
    return updated;
  },
);

app.post<{ Params: { id: string } }>(
  "/api/tasks/:id/pause",
  { preHandler: authenticate },
  async (request) => {
    const workspaceId = workspaceIdOf(request);
    const updated = await changeControlTaskStatus(
      request.params.id,
      workspaceId,
      request.user.sub,
      TaskStatus.PAUSED,
      [TaskStatus.QUEUED, TaskStatus.PLANNING, TaskStatus.RUNNING],
      "task.paused",
      "Tugas dijeda oleh pengguna.",
    );
    await removeWaitingJobs(request.params.id);
    return updated;
  },
);

app.post<{ Params: { id: string } }>(
  "/api/tasks/:id/cancel",
  { preHandler: authenticate },
  async (request) => {
    const workspaceId = workspaceIdOf(request);
    const updated = await changeControlTaskStatus(
      request.params.id,
      workspaceId,
      request.user.sub,
      TaskStatus.CANCELLED,
      [
        TaskStatus.DRAFT,
        TaskStatus.QUEUED,
        TaskStatus.PLANNING,
        TaskStatus.RUNNING,
        TaskStatus.REVIEW_REQUIRED,
        TaskStatus.PAUSED,
        TaskStatus.FAILED,
        TaskStatus.BLOCKED,
      ],
      "task.cancelled",
      "Tugas dibatalkan oleh pengguna.",
    );
    await removeWaitingJobs(request.params.id);
    await syncManagerPlanParentStatus(request.params.id, workspaceId).catch(
      (error) =>
        request.log.warn(
          { err: error, taskId: request.params.id },
          "Status rencana induk tidak dapat disinkronkan",
        ),
    );
    return updated;
  },
);

app.get<{ Params: { id: string } }>(
  "/api/tasks/:id/runs",
  { preHandler: authenticate },
  async (request, reply) => {
    const workspaceId = workspaceIdOf(request);
    const task = await prisma.task.findFirst({
      where: { id: request.params.id, workspaceId },
      select: { id: true },
    });
    if (!task)
      return reply.code(404).send({
        error: "NOT_FOUND",
        message: "Tugas tidak ditemukan di workspace ini.",
      });
    const runs = await prisma.agentRun.findMany({
      where: { taskId: task.id, workspaceId },
      include: {
        agent: { select: { id: true, name: true, role: true } },
        events: { orderBy: { createdAt: "asc" }, take: 100 },
        artifacts: {
          orderBy: { createdAt: "desc" },
          select: {
            id: true,
            name: true,
            mimeType: true,
            sizeBytes: true,
            metadata: true,
            createdAt: true,
          },
        },
      },
      orderBy: { startedAt: "desc" },
      take: 30,
    });
    return runs.map((run) => ({
      ...run,
      artifacts: run.artifacts.map((artifact) => ({
        ...artifact,
        sizeBytes:
          artifact.sizeBytes === null ? null : artifact.sizeBytes.toString(),
      })),
    }));
  },
);

app.get<{ Params: { id: string } }>(
  "/api/tasks/:id/events",
  { preHandler: authenticate },
  async (request, reply) => {
    const workspaceId = workspaceIdOf(request);
    const task = await prisma.task.findFirst({
      where: { id: request.params.id, workspaceId },
      select: { id: true },
    });
    if (!task)
      return reply.code(404).send({
        error: "NOT_FOUND",
        message: "Tugas tidak ditemukan di workspace ini.",
      });
    return prisma.runEvent.findMany({
      where: { taskId: task.id },
      include: { run: { select: { id: true, status: true } } },
      orderBy: { createdAt: "desc" },
      take: 200,
    });
  },
);

app.get("/api/events", { preHandler: authenticate }, async (request) => {
  const workspaceId = workspaceIdOf(request);
  const events = await prisma.runEvent.findMany({
    where: { task: { is: { workspaceId } } },
    include: {
      task: {
        select: {
          id: true,
          title: true,
          status: true,
          assignedAgent: { select: { id: true, name: true } },
        },
      },
      run: { select: { id: true, status: true, provider: true, model: true } },
    },
    orderBy: { createdAt: "desc" },
    take: 100,
  });
  return events;
});

app.get<{ Params: { id: string } }>(
  "/api/artifacts/:id/download",
  { preHandler: authenticate },
  async (request, reply) => {
    const workspaceId = workspaceIdOf(request);
    const artifact = await prisma.artifact.findFirst({
      where: { id: request.params.id, workspaceId },
    });
    if (!artifact)
      return reply.code(404).send({
        error: "NOT_FOUND",
        message: "Artefak tidak ditemukan di workspace ini.",
      });
    const filePath = path.resolve(artifactRoot, artifact.storageKey);
    const allowedPrefix = artifactRoot.endsWith(path.sep)
      ? artifactRoot
      : `${artifactRoot}${path.sep}`;
    if (!filePath.startsWith(allowedPrefix))
      return reply.code(400).send({
        error: "INVALID_ARTIFACT_PATH",
        message: "Lokasi artefak tidak valid.",
      });
    try {
      const content = await fs.readFile(filePath);
      const safeName = artifact.name.replace(/[\r\n\"\/\\]/g, "_");
      return reply
        .type(artifact.mimeType || "application/octet-stream")
        .header("Content-Disposition", `attachment; filename="${safeName}"`)
        .send(content);
    } catch (error) {
      request.log.error(
        { err: error, artifactId: artifact.id },
        "File artefak tidak dapat dibaca",
      );
      return reply.code(404).send({
        error: "ARTIFACT_FILE_NOT_FOUND",
        message: "File artefak tidak tersedia di penyimpanan lokal.",
      });
    }
  },
);

app.get("/api/provider/status", { preHandler: authenticate }, async () => {
  return {
    provider: "openai",
    configured: openAiConfigured,
    model: openAiModel,
    executorMode,
    canExecuteTasks: openAiConfigured && executorMode === "openai",
    apiKeyExposed: false,
  };
});

app.post(
  "/api/provider/test",
  { preHandler: authenticate },
  async (request, reply) => {
    if (!openAiConfigured) {
      return reply.code(400).send({
        error: "OPENAI_NOT_CONFIGURED",
        message:
          "OPENAI_API_KEY belum diatur di .env. Tambahkan API key secara lokal, lalu restart API. Jangan kirim API key lewat chat atau browser.",
      });
    }
    try {
      const client = new OpenAI({
        apiKey: openAiApiKey,
        timeout: 25_000,
        maxRetries: 0,
      });
      const response = await client.responses.create({
        model: openAiModel,
        input: "Balas tepat dengan teks: KantorAI OpenAI connection OK.",
        max_output_tokens: 32,
        store: false,
      });
      const output = response.output_text?.trim();
      if (!output)
        throw new Error("OpenAI tidak menghasilkan teks pada tes koneksi.");
      await prisma.auditLog.create({
        data: {
          workspaceId: workspaceIdOf(request),
          actorId: request.user.sub,
          action: "provider.openai_test_succeeded",
          entityType: "provider",
          entityId: "openai",
          metadata: {
            model: response.model || openAiModel,
            responseId: response.id,
          } as Prisma.InputJsonValue,
        },
      });
      return {
        ok: true,
        provider: "openai",
        model: response.model || openAiModel,
        responseId: response.id,
        message: output,
      };
    } catch (error) {
      const message = safeProviderError(error);
      request.log.warn(
        { provider: "openai", message },
        "Tes koneksi OpenAI gagal",
      );
      return reply
        .code(502)
        .send({ error: "OPENAI_CONNECTION_FAILED", message });
    }
  },
);

app.post(
  "/api/manager/plan",
  { preHandler: authenticate },
  async (request, reply) => {
    const body = managerPlanRequestSchema.parse(request.body);
    const workspaceId = workspaceIdOf(request);
    if (!openAiConfigured) {
      return reply.code(400).send({
        error: "OPENAI_NOT_CONFIGURED",
        message:
          "OpenAI belum dikonfigurasi. Isi OPENAI_API_KEY di .env lokal terlebih dahulu.",
      });
    }
    if (executorMode !== "openai") {
      return reply.code(409).send({
        error: "OPENAI_EXECUTOR_REQUIRED",
        message:
          "Mode executor harus openai agar subtugas yang diluncurkan benar-benar diproses model. Atur TASK_EXECUTOR_MODE=openai, lalu restart API dan worker.",
      });
    }
    const availableAgents = await prisma.agent.findMany({
      where: { workspaceId, enabled: true },
      include: { department: { select: { code: true, name: true } } },
      orderBy: { createdAt: "asc" },
    });
    if (availableAgents.length < 2) {
      return reply.code(400).send({
        error: "NOT_ENOUGH_AGENTS",
        message:
          "Aktifkan minimal dua AI employee sebelum meminta Nara membagi pekerjaan.",
      });
    }
    const manager =
      availableAgents.find((agent) => agent.slug === "nara") ||
      availableAgents.find((agent) =>
        /manager|operations manager/i.test(agent.role),
      );
    if (!manager) {
      return reply.code(400).send({
        error: "MANAGER_AGENT_NOT_FOUND",
        message:
          "Agent Nara/Manager AI tidak ditemukan atau tidak aktif. Aktifkan agent Manager terlebih dahulu.",
      });
    }
    const agentRoster = availableAgents.map((agent) => ({
      id: agent.id,
      name: agent.name,
      role: agent.role,
      department: agent.department?.name || "Tanpa departemen",
      description: agent.description || "Tidak ada deskripsi tambahan.",
    }));
    const client = new OpenAI({
      apiKey: openAiApiKey,
      timeout: 60_000,
      maxRetries: 1,
    });
    try {
      const response = await client.responses.create({
        model: openAiModel,
        instructions: [
          `Anda adalah ${manager.name}, Manager AI KantorAI. Tugas Anda menyusun rencana kerja dan membagi subtugas ke agent aktif.`,
          "Output wajib berupa json valid (satu objek JSON), tanpa Markdown atau teks tambahan. Gunakan struktur: {planTitle:string,summary:string,tasks:[{title:string,instruction:string,assignedAgentId:string,priority:'LOW'|'NORMAL'|'HIGH'|'URGENT',rationale:string,acceptanceCriteria:string}] }.",
          `Buat antara 2 dan ${body.maxTasks} subtugas. Setiap subtugas harus berupa pekerjaan konkret, instruksi mandiri, dan memiliki hasil yang dapat diperiksa manusia.`,
          "Gunakan hanya assignedAgentId dari daftar agent aktif yang diberikan. Jangan membuat ID, agent, kemampuan, atau tools baru. Jika peran tidak tepat, pilih agent aktif yang paling dekat dan jelaskan keterbatasannya dalam rationale.",
          "Rancang pekerjaan agar dapat dijalankan secara paralel jika memungkinkan; sistem belum menjamin urutan/dependensi antar-subtugas. Hindari publikasi, pengiriman pesan, pembayaran, penghapusan data, deployment, atau tindakan eksternal. Tidak ada tools yang dipanggil pada tahap ini.",
          "Jawab dalam Bahasa Indonesia. Jangan menyatakan pekerjaan sudah dilakukan; Anda hanya membuat rencana yang akan diperiksa pengguna sebelum diluncurkan.",
        ].join("\n\n"),
        input: `Return the result as JSON. The output must be a valid JSON object.\n${JSON.stringify(
          {
            goal: body.goal,
            maxTasks: body.maxTasks,
            activeAgents: agentRoster,
          },
        )}`,
        text: { format: { type: "json_object" } },
        max_output_tokens: Math.max(
          900,
          Math.min(
            3000,
            Number(process.env.MANAGER_PLAN_MAX_OUTPUT_TOKENS || 2400),
          ),
        ),
        store: false,
      });
      const output = response.output_text?.trim();
      if (!output)
        throw new Error("Model Manager AI tidak menghasilkan rencana teks.");
      let json: unknown;
      try {
        json = JSON.parse(output);
      } catch {
        throw new Error(
          "Model Manager AI mengembalikan JSON yang tidak dapat dibaca. Coba buat rencana lagi.",
        );
      }
      const parsed = managerPlanSchema.safeParse(json);
      if (!parsed.success) {
        request.log.warn(
          {
            issues: parsed.error.issues.map((issue) => ({
              path: issue.path,
              code: issue.code,
            })),
          },
          "Format rencana Manager AI tidak sesuai skema",
        );
        throw new Error(
          "Rencana dari model tidak memenuhi format wajib. Coba buat rencana lagi.",
        );
      }
      const plan = parsed.data;
      if (plan.tasks.length > body.maxTasks)
        plan.tasks = plan.tasks.slice(0, body.maxTasks);
      const enabledIds = new Set(availableAgents.map((agent) => agent.id));
      if (plan.tasks.some((task) => !enabledIds.has(task.assignedAgentId))) {
        throw new Error(
          "Rencana memilih agent yang tidak aktif/tersedia. Buat rencana baru dan periksa penugasan sebelum meluncurkan.",
        );
      }
      await prisma.auditLog.create({
        data: {
          workspaceId,
          actorId: request.user.sub,
          action: "manager.plan_generated",
          entityType: "manager_plan",
          metadata: {
            planTitle: plan.planTitle,
            taskCount: plan.tasks.length,
            model: response.model || openAiModel,
            responseId: response.id,
            usage: response.usage
              ? {
                  inputTokens: response.usage.input_tokens,
                  outputTokens: response.usage.output_tokens,
                  totalTokens: response.usage.total_tokens,
                }
              : null,
          } as Prisma.InputJsonValue,
        },
      });
      return {
        ...plan,
        manager: { id: manager.id, name: manager.name, role: manager.role },
        model: response.model || openAiModel,
        usage: response.usage
          ? {
              inputTokens: response.usage.input_tokens,
              outputTokens: response.usage.output_tokens,
              totalTokens: response.usage.total_tokens,
            }
          : null,
        responseId: response.id,
      };
    } catch (error) {
      const message = safeProviderError(error);
      request.log.warn(
        { provider: "openai", message },
        "Pembuatan rencana Manager AI gagal",
      );
      return reply.code(502).send({ error: "MANAGER_PLAN_FAILED", message });
    }
  },
);

app.post(
  "/api/manager/launch",
  { preHandler: authenticate },
  async (request, reply) => {
    const body = managerLaunchSchema.parse(request.body);
    const workspaceId = workspaceIdOf(request);
    if (executorMode !== "openai" || !openAiConfigured) {
      return reply.code(409).send({
        error: "OPENAI_EXECUTOR_REQUIRED",
        message:
          "Executor OpenAI tidak aktif. Rencana tidak diluncurkan agar tidak berubah menjadi dry-run tanpa hasil AI.",
      });
    }
    const manager = await prisma.agent.findFirst({
      where: {
        workspaceId,
        enabled: true,
        OR: [
          { slug: "nara" },
          { role: { contains: "manager", mode: "insensitive" } },
        ],
      },
      orderBy: { createdAt: "asc" },
    });
    if (!manager)
      return reply.code(400).send({
        error: "MANAGER_AGENT_NOT_FOUND",
        message: "Aktifkan Nara/Manager AI terlebih dahulu.",
      });
    // Idempotensi: permintaan ulang dengan launchKey sama menggunakan tugas yang sudah ada.
    const priorManagerParents = await prisma.task.findMany({
      where: { workspaceId, parentTaskId: null, assignedAgentId: manager.id },
      orderBy: { createdAt: "desc" },
      take: 100,
      include: {
        assignedAgent: {
          select: { id: true, name: true, role: true, state: true },
        },
        _count: { select: { subtasks: true, runs: true, artifacts: true } },
      },
    });
    const priorLaunch = priorManagerParents.find((task) => {
      const metadata =
        task.metadata &&
        typeof task.metadata === "object" &&
        !Array.isArray(task.metadata)
          ? (task.metadata as Record<string, unknown>)
          : {};
      return (
        metadata.managerPlan === true && metadata.launchKey === body.launchKey
      );
    });
    if (priorLaunch) {
      const previousSubtasks = await prisma.task.findMany({
        where: { workspaceId, parentTaskId: priorLaunch.id },
        include: {
          assignedAgent: {
            select: { id: true, name: true, role: true, state: true },
          },
          _count: { select: { subtasks: true, runs: true, artifacts: true } },
        },
        orderBy: { createdAt: "asc" },
      });
      // Pemanggilan ulang tidak boleh melewati dependensi. Hanya antrekan subtugas yang sudah siap.
      for (const child of previousSubtasks) {
        if (
          managerPlanChildReady(child.metadata) &&
          (child.status === TaskStatus.DRAFT ||
            child.status === TaskStatus.BLOCKED)
        ) {
          try {
            await queueTaskRecord(child.id, workspaceId, request.user.sub, [
              child.status,
            ]);
          } catch (error) {
            request.log.warn(
              { err: error, taskId: child.id },
              "Retry antrean subtugas siap pada peluncuran berulang gagal",
            );
          }
        }
      }
      await syncManagerPlanParentStatus(priorLaunch.id, workspaceId).catch(
        (error) =>
          request.log.warn(
            { err: error, taskId: priorLaunch.id },
            "Status rencana induk tidak dapat disinkronkan pada retry",
          ),
      );
      const replayParent = await prisma.task.findFirst({
        where: { id: priorLaunch.id, workspaceId },
        include: {
          assignedAgent: {
            select: { id: true, name: true, role: true, state: true },
          },
          _count: { select: { subtasks: true, runs: true, artifacts: true } },
        },
      });
      const replaySubtasks = await prisma.task.findMany({
        where: { workspaceId, parentTaskId: priorLaunch.id },
        include: {
          assignedAgent: {
            select: { id: true, name: true, role: true, state: true },
          },
          _count: { select: { subtasks: true, runs: true, artifacts: true } },
        },
        orderBy: { createdAt: "asc" },
      });
      return reply.code(200).send({
        parent: replayParent || priorLaunch,
        subtasks: replaySubtasks,
        queueWarning: replaySubtasks.some(
          (task) => task.status === TaskStatus.BLOCKED,
        )
          ? "Peluncuran ini sudah tercatat; ada subtugas yang Terhambat. Periksa Redis/worker."
          : null,
        workflowMessage:
          "Peluncuran ini sudah tercatat. Subtugas yang menunggu prasyarat tetap Draft dan tidak akan diantrekan sebelum hasil tahap 1 disetujui.",
        idempotentReplay: true,
      });
    }
    const requestedAgentIds = [
      ...new Set(body.plan.tasks.map((task) => task.assignedAgentId)),
    ];
    const activeAgents = await prisma.agent.findMany({
      where: { workspaceId, enabled: true, id: { in: requestedAgentIds } },
      select: { id: true, name: true, role: true },
    });
    if (activeAgents.length !== requestedAgentIds.length) {
      return reply.code(400).send({
        error: "PLAN_AGENT_UNAVAILABLE",
        message:
          "Rencana mencantumkan agent yang tidak aktif atau bukan milik workspace ini. Buat ulang/periksa rencana sebelum meluncurkan.",
      });
    }
    const activeIds = new Set(activeAgents.map((agent) => agent.id));
    if (body.plan.tasks.some((task) => !activeIds.has(task.assignedAgentId))) {
      return reply.code(400).send({
        error: "PLAN_AGENT_UNAVAILABLE",
        message:
          "Satu atau lebih subtugas memiliki penanggung jawab yang tidak tersedia.",
      });
    }
    const created = await prisma.$transaction(async (tx) => {
      const parent = await tx.task.create({
        data: {
          workspaceId,
          assignedAgentId: manager.id,
          title: body.plan.planTitle,
          instruction: body.goal,
          status: TaskStatus.PLANNING,
          priority: TaskPriority.NORMAL,
          metadata: {
            managerPlan: true,
            launchKey: body.launchKey,
            managerPlanStatus: "RUNNING",
            managerWorkflowVersion: "M4.1",
            managerFinalReviewStatus: "PENDING",
            managerContextStrategy: "FIRST_SUBTASK_REVIEW_THEN_REMAINDER",
            planSummary: body.plan.summary,
            childTaskCount: body.plan.tasks.length,
            model: openAiModel,
          } as Prisma.InputJsonValue,
          runEvents: {
            create: {
              eventType: "manager.plan_created",
              actorType: "USER",
              message:
                "Rencana kerja Nara disetujui untuk diluncurkan; subtugas akan dijalankan oleh agent spesialis.",
              payload: {
                taskCount: body.plan.tasks.length,
                model: openAiModel,
              },
            },
          },
        },
        include: {
          assignedAgent: {
            select: { id: true, name: true, role: true, state: true },
          },
        },
      });
      const children = [] as Array<{
        id: string;
        title: string;
        instruction: string;
        assignedAgentId: string | null;
        status: TaskStatus;
      }>;
      for (const [index, item] of body.plan.tasks.entries()) {
        const instruction = [
          item.instruction,
          item.acceptanceCriteria
            ? `Kriteria hasil yang diharapkan:\n${item.acceptanceCriteria}`
            : "",
          item.rationale
            ? `Konteks pembagian oleh Nara:\n${item.rationale}`
            : "",
          "Buat hasil yang dapat diperiksa. Jangan mengklaim telah menjalankan tools atau melakukan tindakan eksternal jika belum benar-benar dilakukan.",
        ]
          .filter(Boolean)
          .join("\n\n");
        const childTask = await tx.task.create({
          data: {
            workspaceId,
            parentTaskId: parent.id,
            assignedAgentId: item.assignedAgentId,
            title: item.title,
            instruction,
            priority: item.priority,
            status: TaskStatus.DRAFT,
            metadata: {
              managerPlanChild: true,
              managerPlanParentId: parent.id,
              rationale: item.rationale,
              acceptanceCriteria: item.acceptanceCriteria,
              sequence: index + 1,
              dependsOnSequence: index === 0 ? [] : [1],
              managerPlanReady: index === 0,
              managerPlanStage:
                index === 0 ? "READY" : "WAITING_FOR_PREREQUISITE_REVIEW",
            } as Prisma.InputJsonValue,
            runEvents: {
              create: {
                eventType:
                  index === 0
                    ? "manager.subtask_ready"
                    : "manager.subtask_waiting_dependency",
                actorType: "MANAGER",
                message:
                  index === 0
                    ? "Subtugas pertama siap diproses sebagai sumber konteks untuk tim."
                    : `Subtugas ${index + 1} menunggu subtugas 1 selesai dan disetujui.`,
                payload: {
                  parentTaskId: parent.id,
                  sequence: index + 1,
                  dependsOnSequence: index === 0 ? [] : [1],
                  assignedAgentId: item.assignedAgentId,
                  priority: item.priority,
                },
              },
            },
          },
          select: {
            id: true,
            title: true,
            instruction: true,
            assignedAgentId: true,
            status: true,
          },
        });
        children.push(childTask);
      }
      await tx.auditLog.create({
        data: {
          workspaceId,
          actorId: request.user.sub,
          action: "manager.plan_launched",
          entityType: "task",
          entityId: parent.id,
          metadata: {
            taskCount: children.length,
            agentIds: children.map((child) => child.assignedAgentId),
            model: openAiModel,
          } as Prisma.InputJsonValue,
        },
      });
      return { parent, children };
    });
    const initialChild = created.children[0];
    let initialQueueResult: Awaited<ReturnType<typeof queueTaskRecord>> | null =
      null;
    if (initialChild) {
      initialQueueResult = await queueTaskRecord(
        initialChild.id,
        workspaceId,
        request.user.sub,
        [TaskStatus.DRAFT],
      );
    }
    await syncManagerPlanParentStatus(created.parent.id, workspaceId).catch(
      (error) =>
        request.log.warn(
          { err: error, taskId: created.parent.id },
          "Status rencana induk tidak dapat disinkronkan",
        ),
    );
    emitWorkspace(workspaceId, "task.manager_plan_launched", {
      parentTaskId: created.parent.id,
      childTaskIds: created.children.map((child) => child.id),
      readyChildTaskIds: initialChild ? [initialChild.id] : [],
      waitingChildTaskIds: created.children.slice(1).map((child) => child.id),
      childCount: created.children.length,
    });
    const parent = await prisma.task.findFirst({
      where: { id: created.parent.id, workspaceId },
      include: {
        assignedAgent: {
          select: { id: true, name: true, role: true, state: true },
        },
        _count: { select: { subtasks: true, runs: true, artifacts: true } },
      },
    });
    const subtasks = await prisma.task.findMany({
      where: { workspaceId, parentTaskId: created.parent.id },
      include: {
        assignedAgent: {
          select: { id: true, name: true, role: true, state: true },
        },
        _count: { select: { subtasks: true, runs: true, artifacts: true } },
      },
      orderBy: { createdAt: "asc" },
    });
    const initialQueueWarning =
      initialQueueResult && "queueWarning" in initialQueueResult
        ? initialQueueResult.queueWarning
        : null;
    return reply.code(201).send({
      parent,
      subtasks,
      queueWarning:
        initialQueueWarning ||
        (initialQueueResult?.status === TaskStatus.BLOCKED
          ? "Subtugas pertama belum masuk antrean. Periksa Redis/worker sebelum melanjutkan."
          : null),
      workflowMessage:
        "Tahap 1 sudah disiapkan untuk berjalan terlebih dahulu. Subtugas berikutnya tetap Draft sampai tahap 1 selesai dan disetujui; setelah itu hasilnya dilampirkan dan subtugas lanjutan masuk antrean.",
      idempotentReplay: false,
    });
  },
);

app.post<{ Params: { id: string } }>(
  "/api/manager/tasks/:id/final-review",
  { preHandler: authenticate },
  async (request, reply) => {
    const workspaceId = workspaceIdOf(request);
    if (!openAiConfigured || executorMode !== "openai") {
      return reply.code(409).send({
        error: "OPENAI_EXECUTOR_REQUIRED",
        message:
          "Final review memerlukan OPENAI_API_KEY aktif dan TASK_EXECUTOR_MODE=openai.",
      });
    }
    const parent = await prisma.task.findFirst({
      where: { id: request.params.id, workspaceId },
    });
    if (!parent)
      return reply
        .code(404)
        .send({
          error: "NOT_FOUND",
          message: "Rencana Manager AI tidak ditemukan.",
        });
    const parentMetadata = asJsonRecord(parent.metadata);
    if (parentMetadata.managerPlan !== true) {
      return reply
        .code(400)
        .send({
          error: "NOT_MANAGER_PLAN",
          message: "Tugas ini bukan tugas induk Manager AI.",
        });
    }

    const children = await prisma.task.findMany({
      where: { workspaceId, parentTaskId: parent.id },
      include: {
        assignedAgent: { select: { id: true, name: true, role: true } },
      },
      orderBy: { createdAt: "asc" },
    });
    if (!children.length) {
      return reply
        .code(409)
        .send({
          error: "MANAGER_PLAN_CHILDREN_MISSING",
          message: "Rencana ini belum memiliki subtugas.",
        });
    }
    const pending = children.filter(
      (child) => child.status !== TaskStatus.COMPLETED,
    );
    if (pending.length) {
      return reply.code(409).send({
        error: "MANAGER_PLAN_CHILDREN_PENDING",
        message: `Final review menunggu ${pending.length} subtugas selesai dan disetujui.`,
        pending: pending.map((child) => ({
          id: child.id,
          title: child.title,
          status: child.status,
        })),
      });
    }

    // Idempotensi final review: gunakan artefak final yang sudah ada tanpa memanggil OpenAI lagi.
    const parentArtifacts = await prisma.artifact.findMany({
      where: { workspaceId, taskId: parent.id, mimeType: "text/markdown" },
      orderBy: { createdAt: "desc" },
      take: 30,
    });
    const existingFinal = parentArtifacts.find(
      (item) => asJsonRecord(item.metadata).managerFinalReview === true,
    );
    if (existingFinal) {
      try {
        const previewText = await fs.readFile(
          safeArtifactPath(existingFinal.storageKey),
          "utf8",
        );
        return reply.code(200).send({
          parentTaskId: parent.id,
          reused: true,
          model: asJsonRecord(existingFinal.metadata).model || openAiModel,
          artifact: {
            id: existingFinal.id,
            name: existingFinal.name,
            mimeType: existingFinal.mimeType,
            sizeBytes: existingFinal.sizeBytes?.toString() ?? null,
            metadata: existingFinal.metadata,
            createdAt: existingFinal.createdAt.toISOString(),
          },
          outputPreview: previewText.slice(0, 3200),
        });
      } catch (error) {
        request.log.error(
          { err: error, artifactId: existingFinal.id },
          "Artefak final Manager AI tidak dapat dibaca",
        );
        return reply
          .code(409)
          .send({
            error: "MANAGER_FINAL_REVIEW_ARTIFACT_MISSING",
            message:
              "Artefak final sudah tercatat tetapi file tidak tersedia. Periksa folder data/artifacts sebelum mencoba membuat ulang.",
          });
      }
    }

    const sources: Array<{
      taskId: string;
      title: string;
      agentName: string;
      agentRole: string;
      artifactId: string;
      artifactName: string;
      content: string;
    }> = [];
    for (const child of children) {
      let source;
      try {
        source = await readLatestMarkdownArtifact(workspaceId, child.id);
      } catch (error) {
        return reply.code(409).send({
          error: "MANAGER_PLAN_SOURCE_ARTIFACT_UNREADABLE",
          message: `Artefak subtugas '${child.title}' tidak dapat dibaca. ${error instanceof Error ? error.message : "Periksa folder artefak."}`,
        });
      }
      if (!source) {
        return reply.code(409).send({
          error: "MANAGER_PLAN_SOURCE_ARTIFACT_MISSING",
          message: `Artefak Markdown subtugas '${child.title}' belum tersedia. Final review belum dijalankan.`,
        });
      }
      sources.push({
        taskId: child.id,
        title: child.title,
        agentName: child.assignedAgent?.name || "Agent tidak diketahui",
        agentRole: child.assignedAgent?.role || "Peran tidak diketahui",
        artifactId: source.artifact.id,
        artifactName: source.artifact.name,
        content:
          source.content.length > 14000
            ? `${source.content.slice(0, 14000)}\n[CATATAN: ARTEFAK SUMBER DIPOTONG PADA 14.000 KARAKTER.]`
            : source.content,
      });
    }

    const manager = await prisma.agent.findFirst({
      where: { id: parent.assignedAgentId || "", workspaceId, enabled: true },
    });
    if (!manager) {
      return reply
        .code(409)
        .send({
          error: "MANAGER_AGENT_NOT_FOUND",
          message:
            "Agent Manager AI/Nara yang ditugaskan pada rencana tidak aktif.",
        });
    }
    const selectedModel = manager.model?.trim() || openAiModel;
    const startedAt = new Date();
    const run = await prisma.agentRun.create({
      data: {
        workspaceId,
        taskId: parent.id,
        agentId: manager.id,
        status: RunStatus.STARTED,
        provider: "openai",
        model: selectedModel,
        input: {
          kind: "manager_final_review",
          sourceTaskIds: sources.map((source) => source.taskId),
          sourceArtifactIds: sources.map((source) => source.artifactId),
          startedAt: startedAt.toISOString(),
        } as Prisma.InputJsonValue,
      },
    });
    await prisma.runEvent.create({
      data: {
        taskId: parent.id,
        runId: run.id,
        eventType: "manager.final_review_started",
        actorType: "MANAGER",
        message:
          "Nara mulai meninjau dan menyatukan artefak seluruh subtugas yang telah disetujui.",
        payload: {
          sourceTaskIds: sources.map((source) => source.taskId),
          sourceArtifactIds: sources.map((source) => source.artifactId),
        },
      },
    });
    emitWorkspace(workspaceId, "task.manager_final_review_started", {
      parentTaskId: parent.id,
      runId: run.id,
      sourceTaskCount: sources.length,
    });

    try {
      const client = new OpenAI({
        apiKey: openAiApiKey,
        timeout: 120_000,
        maxRetries: 1,
      });
      const response = await client.responses.create({
        model: selectedModel,
        instructions: [
          `Anda adalah ${manager.name}, Manager AI KantorAI. Lakukan final review dari dokumen kerja yang diberikan; jangan mengulang pekerjaan spesialis dari nol.`,
          "Susun satu paket final dalam Bahasa Indonesia dengan bagian: Ringkasan eksekutif; Analisis topik dan audiens; Outline carousel final; Naskah video final; Pemeriksaan konsistensi antarformat; Klaim/fakta hukum yang masih perlu diverifikasi; Checklist sebelum publikasi.",
          "Gunakan artefak spesialis sebagai sumber utama. Jangan mengarang hasil riset, angka, peraturan, pasal, keputusan, kutipan, atau sumber resmi yang tidak tersedia di artefak. Jika klaim hukum belum didukung sumber resmi, beri label PERLU VERIFIKASI dan jelaskan apa yang harus diperiksa.",
          "Perbaiki ketidaksesuaian yang jelas (misalnya jumlah slide atau durasi) dan catat perubahan penting. Jangan mengklaim publikasi atau tindakan eksternal telah dilakukan. Akhiri dengan status: DRAFT UNTUK REVIEW MANUSIA.",
        ].join("\n\n"),
        input: JSON.stringify({
          goal: parent.instruction,
          planTitle: parent.title,
          planSummary: parentMetadata.planSummary || "",
          sourceDocuments: sources,
          reviewRules: [
            "konsistensi antarformat",
            "akurasi dan dukungan sumber",
            "kesesuaian kriteria hasil",
            "tanpa publikasi otomatis",
          ],
        }),
        max_output_tokens: Math.max(
          1200,
          Math.min(
            6000,
            Number(process.env.MANAGER_FINAL_REVIEW_MAX_OUTPUT_TOKENS || 3800),
          ),
        ),
        store: false,
      });
      const output = response.output_text?.trim();
      if (!output)
        throw new Error("OpenAI tidak menghasilkan isi paket final.");
      const finishedAt = new Date();
      const slug =
        parent.title
          .normalize("NFKD")
          .toLowerCase()
          .replace(/[\u0300-\u036f]/g, "")
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-+|-+$/g, "")
          .slice(0, 55) || "paket-final";
      const markdownName = `paket-final-${slug}.md`;
      const artifactDir = path.resolve(
        artifactRoot,
        workspaceId,
        parent.id,
        run.id,
      );
      await fs.mkdir(artifactDir, { recursive: true });
      const markdownPath = path.resolve(artifactDir, markdownName);
      const markdown = `# Paket Final: ${parent.title}\n\n> Disusun oleh ${manager.name} (${manager.role}) melalui OpenAI Responses API.\n> Status: DRAFT UNTUK REVIEW MANUSIA.\n> Sumber: artefak subtugas yang telah disetujui.\n\n${output}\n`;
      await fs.writeFile(markdownPath, markdown, { flag: "wx" });
      const storageKey = path
        .relative(artifactRoot, markdownPath)
        .split(path.sep)
        .join("/");
      const usage = response.usage
        ? {
            inputTokens: response.usage.input_tokens,
            outputTokens: response.usage.output_tokens,
            totalTokens: response.usage.total_tokens,
          }
        : null;
      const finalArtifact = await prisma.$transaction(async (tx) => {
        const createdArtifact = await tx.artifact.create({
          data: {
            workspaceId,
            taskId: parent.id,
            runId: run.id,
            name: markdownName,
            mimeType: "text/markdown",
            storageKey,
            sizeBytes: BigInt(Buffer.byteLength(markdown, "utf8")),
            metadata: {
              managerFinalReview: true,
              diagnosticOnly: false,
              provider: "openai",
              model: response.model || selectedModel,
              responseId: response.id,
              sourceTaskIds: sources.map((source) => source.taskId),
              sourceArtifactIds: sources.map((source) => source.artifactId),
            } as Prisma.InputJsonValue,
          },
        });
        await tx.agentRun.update({
          where: { id: run.id },
          data: {
            status: RunStatus.SUCCEEDED,
            provider: "openai",
            model: response.model || selectedModel,
            output: {
              responseId: response.id,
              artifactId: createdArtifact.id,
              artifactName: markdownName,
              outputPreview: output.slice(0, 2200),
              usage,
              sourceTaskIds: sources.map((source) => source.taskId),
              sourceArtifactIds: sources.map((source) => source.artifactId),
              aiProviderInvoked: true,
              diagnosticOnly: false,
            } as Prisma.InputJsonValue,
            finishedAt,
          },
        });
        const finalParentStatus =
          parent.status === TaskStatus.COMPLETED
            ? TaskStatus.REVIEW_REQUIRED
            : parent.status;
        await tx.task.update({
          where: { id: parent.id },
          data: {
            status: finalParentStatus,
            metadata: {
              ...parentMetadata,
              managerPlanStatus:
                finalParentStatus === TaskStatus.REVIEW_REQUIRED
                  ? "REVIEW_REQUIRED"
                  : String(
                      parentMetadata.managerPlanStatus || "REVIEW_REQUIRED",
                    ),
              managerFinalReviewStatus: "READY_FOR_REVIEW",
              managerFinalReviewArtifactId: createdArtifact.id,
              managerFinalReviewRunId: run.id,
              managerFinalReviewModel: response.model || selectedModel,
            } as Prisma.InputJsonValue,
          },
        });
        await tx.runEvent.create({
          data: {
            taskId: parent.id,
            runId: run.id,
            eventType: "manager.final_review_succeeded",
            actorType: "MANAGER",
            message:
              "Nara selesai menyatukan hasil spesialis; paket final disimpan sebagai artefak dan menunggu review manusia.",
            payload: {
              artifactId: createdArtifact.id,
              sourceTaskIds: sources.map((source) => source.taskId),
              usage,
            },
          },
        });
        await tx.auditLog.create({
          data: {
            workspaceId,
            actorId: request.user.sub,
            action: "manager.final_review_succeeded",
            entityType: "task",
            entityId: parent.id,
            metadata: {
              runId: run.id,
              artifactId: createdArtifact.id,
              sourceTaskIds: sources.map((source) => source.taskId),
              model: response.model || selectedModel,
              usage,
            } as Prisma.InputJsonValue,
          },
        });
        return createdArtifact;
      });
      emitWorkspace(workspaceId, "task.manager_final_review_succeeded", {
        parentTaskId: parent.id,
        runId: run.id,
        artifactId: finalArtifact.id,
      });
      return reply.code(201).send({
        parentTaskId: parent.id,
        reused: false,
        model: response.model || selectedModel,
        artifact: {
          id: finalArtifact.id,
          name: finalArtifact.name,
          mimeType: finalArtifact.mimeType,
          sizeBytes: finalArtifact.sizeBytes?.toString() ?? null,
          metadata: finalArtifact.metadata,
          createdAt: finalArtifact.createdAt.toISOString(),
        },
        outputPreview: markdown.slice(0, 3200),
      });
    } catch (error) {
      const message = safeProviderError(error);
      await prisma.agentRun
        .update({
          where: { id: run.id },
          data: {
            status: RunStatus.FAILED,
            errorMessage: message,
            finishedAt: new Date(),
          },
        })
        .catch(() => {});
      await prisma.runEvent
        .create({
          data: {
            taskId: parent.id,
            runId: run.id,
            eventType: "manager.final_review_failed",
            actorType: "MANAGER",
            message:
              "Nara gagal menyusun paket final. Subtugas tetap tersimpan dan dapat diperiksa; coba lagi setelah penyebab diperbaiki.",
            payload: { error: message },
          },
        })
        .catch(() => {});
      request.log.warn(
        { err: error, parentTaskId: parent.id, runId: run.id },
        "Manager final review gagal",
      );
      return reply
        .code(502)
        .send({ error: "MANAGER_FINAL_REVIEW_FAILED", message });
    }
  },
);

app.get(
  "/api/queue/status",
  { preHandler: authenticate },
  async (request, reply) => {
    try {
      const [counts, heartbeatRaw, redisStatus] = await Promise.all([
        taskQueue.getJobCounts(
          "waiting",
          "active",
          "completed",
          "failed",
          "delayed",
          "paused",
        ),
        redisHealthClient.get(WORKER_HEARTBEAT_KEY),
        redisHealthClient.ping(),
      ]);
      let worker: Record<string, unknown> | null = null;
      if (heartbeatRaw) {
        try {
          worker = JSON.parse(heartbeatRaw) as Record<string, unknown>;
        } catch {
          worker = null;
        }
      }
      const lastSeenAt =
        typeof worker?.lastSeenAt === "string"
          ? Date.parse(worker.lastSeenAt)
          : 0;
      const workerOnline = Boolean(
        worker?.online && lastSeenAt > 0 && Date.now() - lastSeenAt < 12000,
      );
      return {
        status: redisStatus === "PONG" ? "ok" : "degraded",
        queue: TASK_QUEUE_NAME,
        redis: redisStatus === "PONG" ? "connected" : "unavailable",
        workerOnline,
        worker: workerOnline ? worker : null,
        executorMode,
        aiProviderConfigured: openAiConfigured,
        openAiModel,
        providerCanExecute: openAiConfigured && executorMode === "openai",
        aiProviderInvokedByM2Worker: false,
        counts,
      };
    } catch (error) {
      request.log.warn({ err: error }, "Status antrean tidak dapat diambil");
      return reply.code(503).send({
        status: "degraded",
        queue: TASK_QUEUE_NAME,
        redis: "unavailable",
        workerOnline: false,
        executorMode,
        aiProviderConfigured: openAiConfigured,
        openAiModel,
        providerCanExecute: openAiConfigured && executorMode === "openai",
        counts: {},
      });
    }
  },
);

app.patch<{ Params: { id: string } }>(
  "/api/tasks/:id/status",
  { preHandler: authenticate },
  async (request, reply) => {
    const { status } = taskStatusSchema.parse(request.body);
    const workspaceId = workspaceIdOf(request);
    const task = await prisma.task.findFirst({
      where: { id: request.params.id, workspaceId },
    });
    if (!task)
      return reply
        .code(404)
        .send({ error: "NOT_FOUND", message: "Tugas tidak ditemukan." });
    if (status !== TaskStatus.COMPLETED) {
      return reply.code(409).send({
        error: "USE_TASK_ACTION",
        message:
          "Status antrean, eksekusi, jeda, pembatalan, dan kegagalan dikelola oleh Task Execution Engine. Gunakan aksi task yang tersedia.",
      });
    }
    const metadata =
      task.metadata &&
      typeof task.metadata === "object" &&
      !Array.isArray(task.metadata)
        ? (task.metadata as Record<string, unknown>)
        : {};
    if (status === TaskStatus.COMPLETED && metadata.managerPlanChild === true) {
      try {
        const outputArtifact = await readLatestMarkdownArtifact(
          workspaceId,
          task.id,
        );
        if (!outputArtifact) {
          return reply.code(409).send({
            error: "MANAGER_SUBTASK_ARTIFACT_REQUIRED",
            message:
              "Subtugas belum memiliki artefak Markdown hasil kerja yang dapat diperiksa. Jangan tandai selesai sebelum hasil tersedia.",
          });
        }
      } catch (error) {
        return reply.code(409).send({
          error: "MANAGER_SUBTASK_ARTIFACT_UNREADABLE",
          message:
            error instanceof Error
              ? error.message
              : "Artefak subtugas tidak dapat dibaca.",
        });
      }
    }
    if (status === TaskStatus.COMPLETED && metadata.diagnosticOnly === true) {
      return reply.code(409).send({
        error: "DIAGNOSTIC_ONLY",
        message:
          "Run terakhir hanya laporan diagnostik M2. Ini bukan hasil kerja AI dan belum boleh ditandai selesai sebelum provider AI diintegrasikan pada M3.",
      });
    }
    if (metadata.managerPlan === true && status === TaskStatus.COMPLETED) {
      if (metadata.managerFinalReviewStatus !== "READY_FOR_REVIEW") {
        return reply.code(409).send({
          error: "MANAGER_FINAL_REVIEW_REQUIRED",
          message:
            "Susun dan periksa paket final Nara terlebih dahulu. Tugas induk baru dapat disetujui setelah artefak final tersedia.",
        });
      }
      const children = await prisma.task.findMany({
        where: { workspaceId, parentTaskId: task.id },
        select: { status: true },
      });
      if (
        children.length === 0 ||
        children.some((child) => child.status !== TaskStatus.COMPLETED)
      ) {
        return reply.code(409).send({
          error: "MANAGER_PLAN_CHILDREN_PENDING",
          message:
            "Rencana induk baru dapat disetujui setelah seluruh subtugas selesai dan disetujui.",
        });
      }
    }
    if (metadata.managerPlan === true && status !== TaskStatus.COMPLETED) {
      return reply.code(409).send({
        error: "MANAGER_PLAN_STATUS_CONTROLLED",
        message:
          "Status rencana induk dikelola dari progres seluruh subtugas. Selesaikan review subtugas terlebih dahulu.",
      });
    }
    if (!transitions[task.status].includes(status)) {
      return reply.code(409).send({
        error: "INVALID_TRANSITION",
        message: `Transisi dari ${task.status} ke ${status} tidak diizinkan.`,
        allowed: transitions[task.status],
      });
    }
    const nextTaskMetadata =
      metadata.managerPlan === true && status === TaskStatus.COMPLETED
        ? ({
            ...metadata,
            managerPlanStatus: "COMPLETED",
            managerFinalReviewStatus: "APPROVED",
            managerFinalReviewApprovedAt: new Date().toISOString(),
          } as Prisma.InputJsonValue)
        : undefined;
    const updated = await prisma.$transaction(async (tx) => {
      const changed = await tx.task.update({
        where: { id: task.id },
        data: {
          status,
          ...(nextTaskMetadata ? { metadata: nextTaskMetadata } : {}),
        },
        include: {
          assignedAgent: {
            select: { id: true, name: true, role: true, state: true },
          },
        },
      });
      await tx.runEvent.create({
        data: {
          taskId: task.id,
          eventType: "task.status_changed",
          actorType: "USER",
          message: `${task.status} → ${status}`,
          payload: { from: task.status, to: status },
        },
      });
      await tx.auditLog.create({
        data: {
          workspaceId,
          actorId: request.user.sub,
          action: "task.status_changed",
          entityType: "task",
          entityId: task.id,
          metadata: { from: task.status, to: status },
        },
      });
      return changed;
    });
    let managerPlanReleasedSubtasks = 0;
    let managerPlanReleaseWarning: string | null = null;
    if (
      task.parentTaskId &&
      metadata.managerPlanChild === true &&
      status === TaskStatus.COMPLETED
    ) {
      try {
        const releaseResult = await releaseManagerPlanDependents(
          task.id,
          workspaceId,
          request.user.sub,
        );
        managerPlanReleasedSubtasks = releaseResult.released;
        managerPlanReleaseWarning = releaseResult.warning;
      } catch (error) {
        managerPlanReleaseWarning =
          error instanceof Error
            ? error.message
            : "Subtugas lanjutan tidak dapat dilepas otomatis.";
        request.log.warn(
          { err: error, taskId: task.id },
          "Konteks/antrean subtugas lanjutan gagal disiapkan",
        );
      }
    }
    if (task.parentTaskId)
      await syncManagerPlanParentStatus(task.id, workspaceId).catch((error) =>
        request.log.warn(
          { err: error, taskId: task.id },
          "Status rencana induk tidak dapat disinkronkan",
        ),
      );
    emitWorkspace(workspaceId, "task.status_changed", updated);
    return {
      ...updated,
      managerPlanReleasedSubtasks,
      managerPlanReleaseWarning,
    };
  },
);

const closeGracefully = async () => {
  app.log.info("Menutup KantorAI API...");
  io.close();
  await app.close();
  await Promise.allSettled([
    taskQueue.close(),
    workerEventSubscriber.quit(),
    redisHealthClient.quit(),
    prisma.$disconnect(),
  ]);
};
process.once("SIGINT", () => {
  void closeGracefully().finally(() => process.exit(0));
});
process.once("SIGTERM", () => {
  void closeGracefully().finally(() => process.exit(0));
});

try {
  await app.listen({ host: apiHost, port: apiPort });
  app.log.info(`KantorAI API berjalan di http://${apiHost}:${apiPort}`);
} catch (error) {
  app.log.error(error);
  await prisma.$disconnect();
  process.exit(1);
}
