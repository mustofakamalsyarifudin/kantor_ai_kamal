import "dotenv/config";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import dotenv from "dotenv";
import { Redis } from "ioredis";
import { Worker, type Job } from "bullmq";
import OpenAI from "openai";
import { AgentState, Prisma, PrismaClient, RunStatus, TaskStatus } from "@prisma/client";
import {
  createRedisConnection,
  TASK_QUEUE_NAME,
  WORKER_EVENT_CHANNEL,
  WORKER_HEARTBEAT_KEY,
  type TaskJobPayload
} from "./task-queue.js";

dotenv.config({ path: path.resolve(process.cwd(), "../../.env") });

const prisma = new PrismaClient();
const redisUrl = process.env.REDIS_URL || "redis://127.0.0.1:6379";
const projectRoot = path.resolve(process.cwd(), path.basename(process.cwd()) === "api" ? "../.." : ".");
const artifactsRoot = path.resolve(projectRoot, process.env.ARTIFACTS_DIR || "data/artifacts");
const executorMode = (process.env.TASK_EXECUTOR_MODE || "dry-run").trim().toLowerCase();
const openAiApiKey = process.env.OPENAI_API_KEY?.trim() || "";
const openAiModel = process.env.OPENAI_MODEL?.trim() || "gpt-5.5";
const openAiMaxOutputTokensRaw = Number(process.env.OPENAI_MAX_OUTPUT_TOKENS || 2048);
const openAiMaxOutputTokens = Number.isFinite(openAiMaxOutputTokensRaw)
  ? Math.max(128, Math.min(8192, Math.trunc(openAiMaxOutputTokensRaw)))
  : 2048;
const openAiClient = openAiApiKey && !openAiApiKey.startsWith("CHANGE_ME")
  ? new OpenAI({ apiKey: openAiApiKey, timeout: 120_000, maxRetries: 1 })
  : null;
const concurrencyRaw = Number(process.env.TASK_WORKER_CONCURRENCY || 2);
const concurrency = Number.isFinite(concurrencyRaw) ? Math.max(1, Math.min(8, Math.trunc(concurrencyRaw))) : 2;
const publisher = new Redis(redisUrl, { maxRetriesPerRequest: null, enableReadyCheck: false });
const workerConnection = createRedisConnection();
const workerStartedAt = new Date().toISOString();
let shuttingDown = false;
let heartbeatTimer: NodeJS.Timeout | undefined;

class TaskStoppedError extends Error {
  constructor(readonly taskStatus: TaskStatus) {
    super(`Task dihentikan dengan status ${taskStatus}.`);
    this.name = "TaskStoppedError";
  }
}

async function publish(workspaceId: string, type: string, data: unknown) {
  const message = JSON.stringify({ workspaceId, type, data, at: new Date().toISOString() });
  await publisher.publish(WORKER_EVENT_CHANNEL, message);
}

async function recordEvent(
  workspaceId: string,
  taskId: string,
  runId: string | null,
  eventType: string,
  message: string,
  payload: Record<string, unknown> = {}
) {
  const event = await prisma.runEvent.create({
    data: {
      taskId,
      runId,
      eventType,
      actorType: "WORKER",
      message,
      payload: payload as Prisma.InputJsonValue
    }
  });
  await publish(workspaceId, eventType.startsWith("task.") ? eventType : `task.${eventType}`, {
    taskId,
    runId,
    eventId: event.id,
    eventType,
    message,
    payload,
    createdAt: event.createdAt.toISOString()
  });
  return event;
}

async function getCurrentTaskStatus(taskId: string, workspaceId: string): Promise<TaskStatus | null> {
  const current = await prisma.task.findFirst({
    where: { id: taskId, workspaceId },
    select: { status: true }
  });
  return current?.status ?? null;
}

async function throwIfStopped(taskId: string, workspaceId: string) {
  const status = await getCurrentTaskStatus(taskId, workspaceId);
  if (!status) throw new Error("Task tidak ditemukan selama eksekusi.");
  if (status === TaskStatus.PAUSED || status === TaskStatus.CANCELLED) throw new TaskStoppedError(status);
  if (status !== TaskStatus.RUNNING) throw new Error(`Status task berubah di luar siklus worker: ${status}.`);
}

async function sleepWithCooperativeCheck(taskId: string, workspaceId: string, durationMs = 450) {
  await new Promise(resolve => setTimeout(resolve, durationMs));
  await throwIfStopped(taskId, workspaceId);
}

function safeErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : "Kesalahan provider AI yang tidak diketahui.";
  const withoutSecrets = raw
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, "[REDACTED_API_KEY]")
    .replace(/Bearer\s+[^\s]+/gi, "Bearer [REDACTED]");
  return withoutSecrets.slice(0, 800);
}

function safeFileSlug(value: string): string {
  return value.normalize("NFKD").toLowerCase()
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 70) || "hasil-tugas";
}

async function syncManagerParentPlanStatus(childTaskId: string, workspaceId: string) {
  const child = await prisma.task.findFirst({ where: { id: childTaskId, workspaceId }, select: { parentTaskId: true } });
  if (!child?.parentTaskId) return;
  const parent = await prisma.task.findFirst({ where: { id: child.parentTaskId, workspaceId } });
  if (!parent) return;
  const metadata = parent.metadata && typeof parent.metadata === "object" && !Array.isArray(parent.metadata)
    ? parent.metadata as Record<string, unknown> : {};
  if (metadata.managerPlan !== true) return;
  const children = await prisma.task.findMany({ where: { workspaceId, parentTaskId: parent.id }, select: { status: true } });
  if (!children.length) return;
  const statuses = children.map(item => item.status);
  let nextStatus: TaskStatus = parent.status;
  let planState = String(metadata.managerPlanStatus || "RUNNING");
  if (statuses.every(status => status === TaskStatus.COMPLETED)) {
    nextStatus = TaskStatus.REVIEW_REQUIRED;
    planState = "REVIEW_REQUIRED";
  } else if (statuses.every(status => new Set<TaskStatus>([TaskStatus.COMPLETED, TaskStatus.FAILED, TaskStatus.BLOCKED, TaskStatus.CANCELLED]).has(status)) && statuses.some(status => new Set<TaskStatus>([TaskStatus.FAILED, TaskStatus.BLOCKED, TaskStatus.CANCELLED]).has(status))) {
    nextStatus = TaskStatus.BLOCKED;
    planState = "BLOCKED";
  } else if (parent.status === TaskStatus.BLOCKED && statuses.some(status => new Set<TaskStatus>([TaskStatus.DRAFT, TaskStatus.QUEUED, TaskStatus.PLANNING, TaskStatus.RUNNING, TaskStatus.REVIEW_REQUIRED]).has(status))) {
    nextStatus = TaskStatus.PLANNING;
    planState = "RUNNING";
  }
  if (nextStatus === parent.status && planState === String(metadata.managerPlanStatus || "RUNNING")) return;
  await prisma.task.update({ where: { id: parent.id }, data: { status: nextStatus, metadata: { ...metadata, managerPlanStatus: planState, childTaskCount: children.length } as Prisma.InputJsonValue } });
  const event = await prisma.runEvent.create({ data: { taskId: parent.id, eventType: "manager.plan_status_changed", actorType: "WORKER", message: `Status rencana Manager AI diperbarui menjadi ${nextStatus}.`, payload: { status: nextStatus, planState, childStatuses: statuses } } });
  await publish(workspaceId, "task.manager_plan_status_changed", { taskId: parent.id, eventId: event.id, status: nextStatus, planState, childCount: children.length });
}

async function markTaskBlocked(task: { id: string; workspaceId: string; title: string }, reason: string, actorId?: string) {
  const changed = await prisma.$transaction(async tx => {
    const update = await tx.task.updateMany({
      where: { id: task.id, workspaceId: task.workspaceId, status: TaskStatus.QUEUED },
      data: { status: TaskStatus.BLOCKED }
    });
    if (update.count === 0) return false;
    await tx.runEvent.create({
      data: {
        taskId: task.id,
        eventType: "task.blocked",
        actorType: "WORKER",
        message: reason,
        payload: { reason }
      }
    });
    await tx.auditLog.create({
      data: {
        workspaceId: task.workspaceId,
        actorId: actorId || null,
        action: "task.blocked",
        entityType: "task",
        entityId: task.id,
        metadata: { reason }
      }
    });
    return true;
  });
  if (changed) {
    await publish(task.workspaceId, "task.blocked", { taskId: task.id, title: task.title, reason, status: "BLOCKED" });
    await syncManagerParentPlanStatus(task.id, task.workspaceId).catch(error => console.warn("[worker] Status rencana induk tidak dapat disinkronkan:", safeErrorMessage(error)));
  }
  return changed;
}

async function stopRun(taskId: string, workspaceId: string, runId: string, agentId: string, status: TaskStatus) {
  const message = status === TaskStatus.PAUSED ? "Eksekusi dijeda atas permintaan pengguna." : "Eksekusi dibatalkan atas permintaan pengguna.";
  await prisma.$transaction(async tx => {
    await tx.agentRun.updateMany({
      where: { id: runId, workspaceId, status: RunStatus.STARTED },
      data: {
        status: RunStatus.CANCELLED,
        errorMessage: message,
        output: { stoppedStatus: status, stoppedBy: "USER" } as Prisma.InputJsonValue,
        finishedAt: new Date()
      }
    });
    await tx.agent.updateMany({
      where: { id: agentId, workspaceId, enabled: true, state: { not: AgentState.DISABLED } },
      data: { state: AgentState.IDLE }
    });
    await tx.runEvent.create({
      data: {
        taskId,
        runId,
        eventType: status === TaskStatus.PAUSED ? "run.paused" : "run.cancelled",
        actorType: "WORKER",
        message,
        payload: { status }
      }
    });
  });
  await publish(workspaceId, status === TaskStatus.PAUSED ? "task.paused" : "task.cancelled", { taskId, runId, status, message });
  await syncManagerParentPlanStatus(taskId, workspaceId).catch(error => console.warn("[worker] Status rencana induk tidak dapat disinkronkan:", safeErrorMessage(error)));
}

async function processJob(job: Job<TaskJobPayload>) {
  const { taskId, workspaceId, actorId } = job.data;
  const task = await prisma.task.findFirst({
    where: { id: taskId, workspaceId },
    include: { assignedAgent: true }
  });
  if (!task) {
    console.warn(`[worker] Job ${job.id} dilewati; task ${taskId} tidak ditemukan.`);
    return { skipped: true, reason: "TASK_NOT_FOUND" };
  }
  if (task.status !== TaskStatus.QUEUED) {
    await publish(workspaceId, "task.job_skipped", { taskId, status: task.status, reason: "TASK_NOT_QUEUED" });
    return { skipped: true, reason: "TASK_NOT_QUEUED", status: task.status };
  }
  if (!task.assignedAgentId || !task.assignedAgent || !task.assignedAgent.enabled) {
    const reason = !task.assignedAgentId || !task.assignedAgent
      ? "Tugas belum memiliki agent aktif. Tetapkan AI employee sebelum mengantrekan tugas."
      : "Agent penanggung jawab sudah dinonaktifkan.";
    await markTaskBlocked(task, reason, actorId);
    return { blocked: true, reason };
  }
  if (executorMode !== "dry-run" && executorMode !== "openai") {
    const reason = `Executor mode '${executorMode}' tidak didukung. Gunakan 'dry-run' atau 'openai'.`;
    await markTaskBlocked(task, reason, actorId);
    return { blocked: true, reason };
  }
  if (executorMode === "openai" && !openAiClient) {
    const reason = "Provider OpenAI belum dikonfigurasi. Tambahkan OPENAI_API_KEY yang valid ke .env, lalu restart API dan worker.";
    await markTaskBlocked(task, reason, actorId);
    return { blocked: true, reason };
  }
  if (executorMode === "openai" && task.assignedAgent.provider && task.assignedAgent.provider.toLowerCase() !== "openai") {
    const reason = `Agent ini dikonfigurasi dengan provider '${task.assignedAgent.provider}', sedangkan executor M3 saat ini hanya mendukung OpenAI.`;
    await markTaskBlocked(task, reason, actorId);
    return { blocked: true, reason };
  }

  const agent = task.assignedAgent;
  const selectedModel = agent.model?.trim() || openAiModel;
  let runId: string | null = null;
  try {
    const run = await prisma.$transaction(async tx => {
      const claim = await tx.task.updateMany({
        where: { id: task.id, workspaceId, status: TaskStatus.QUEUED },
        data: { status: TaskStatus.RUNNING }
      });
      if (claim.count !== 1) return null;
      const createdRun = await tx.agentRun.create({
        data: {
          workspaceId,
          taskId: task.id,
          agentId: agent.id,
          status: RunStatus.STARTED,
          provider: executorMode === "openai" ? "openai" : null,
          model: executorMode === "openai" ? selectedModel : null,
          input: {
            executorMode,
            taskTitle: task.title,
            taskInstructionLength: task.instruction.length,
            priority: task.priority,
            provider: executorMode === "openai" ? "openai" : null,
            model: executorMode === "openai" ? selectedModel : null,
            aiProviderInvoked: false
          } as Prisma.InputJsonValue
        }
      });
      await tx.agent.update({ where: { id: agent.id }, data: { state: AgentState.WORKING } });
      await tx.runEvent.create({
        data: {
          taskId: task.id,
          runId: createdRun.id,
          eventType: "run.started",
          actorType: "WORKER",
          message: `Worker mengambil tugas '${task.title}'. Mode: ${executorMode}.`,
          payload: { executorMode, agentId: agent.id, aiProviderInvoked: false }
        }
      });
      await tx.auditLog.create({
        data: {
          workspaceId,
          actorId: actorId || null,
          action: "task.run_started",
          entityType: "task",
          entityId: task.id,
          metadata: { runId: createdRun.id, agentId: agent.id, executorMode }
        }
      });
      return createdRun;
    });
    if (!run) {
      await publish(workspaceId, "task.job_skipped", { taskId, reason: "CLAIM_RACE" });
      return { skipped: true, reason: "CLAIM_RACE" };
    }
    runId = run.id;
    await publish(workspaceId, "task.run_started", { taskId, runId, agentId: agent.id, agentName: agent.name, status: "RUNNING", executorMode, provider: executorMode === "openai" ? "openai" : null, model: executorMode === "openai" ? selectedModel : null });

    if (executorMode === "openai") {
      if (!openAiClient) throw new Error("Provider OpenAI belum siap. Periksa OPENAI_API_KEY dan restart worker.");
      await throwIfStopped(task.id, workspaceId);
      await recordEvent(workspaceId, task.id, run.id, "run.progress", "Menyiapkan instruksi agent dan menghubungi OpenAI Responses API.", {
        progress: 25, provider: "openai", model: selectedModel, aiProviderInvoked: true
      });
      await job.updateProgress(25);
      await publish(workspaceId, "task.run_progress", { taskId, runId: run.id, progress: 25, message: "Mengirim instruksi ke model OpenAI.", status: "RUNNING", provider: "openai", model: selectedModel });

      const systemInstructions = [
        `Anda adalah ${agent.name}, bertugas sebagai ${agent.role} di workspace KantorAI.`,
        agent.description ? `Tanggung jawab agent: ${agent.description}` : "Kerjakan tugas sesuai jabatan Anda dengan cermat.",
        agent.systemPrompt ? `Instruksi tambahan dari pemilik workspace:\n${agent.systemPrompt}` : "",
        "Hasilkan keluaran kerja yang nyata, terstruktur, dan bisa diperiksa manusia. Gunakan Bahasa Indonesia kecuali tugas meminta bahasa lain.",
        "Jangan mengklaim telah menjalankan tools, mengubah file, mengakses layanan luar, mengirim pesan, atau menyelesaikan tindakan di luar model jika hal itu tidak benar-benar dilakukan.",
        "Pada milestone ini Anda hanya menghasilkan teks/draf. Jangan meminta atau mengungkap API key, password, token, atau rahasia lingkungan. Jika data kurang, nyatakan asumsi dan keterbatasannya."
      ].filter(Boolean).join("\n\n");
      const userInput = [
        `Nama tugas: ${task.title}`,
        `Prioritas: ${task.priority}`,
        `Agent: ${agent.name} — ${agent.role}`,
        "Instruksi pemilik workspace:",
        task.instruction,
        "",
        "Berikan hasil langsung dalam format yang paling berguna untuk tugas ini. Sertakan ringkasan, isi utama, dan langkah lanjutan jika relevan. Jangan menyatakan pekerjaan final yang memerlukan tool atau file yang belum tersedia."
      ].join("\n");

      const response = await openAiClient.responses.create({
        model: selectedModel,
        instructions: systemInstructions,
        input: userInput,
        max_output_tokens: openAiMaxOutputTokens,
        store: false
      });
      await throwIfStopped(task.id, workspaceId);
      const outputText = response.output_text?.trim();
      if (!outputText) throw new Error("OpenAI merespons tanpa teks keluaran. Periksa model, batas token, atau detail run di log API.");
      await recordEvent(workspaceId, task.id, run.id, "run.progress", "Keluaran OpenAI diterima; menyimpan hasil sebagai artefak untuk review manusia.", {
        progress: 80, provider: "openai", model: response.model || selectedModel, responseId: response.id,
        inputTokens: response.usage?.input_tokens ?? null, outputTokens: response.usage?.output_tokens ?? null
      });
      await job.updateProgress(80);
      await publish(workspaceId, "task.run_progress", { taskId, runId: run.id, progress: 80, message: "Menyimpan hasil AI sebagai artefak.", status: "RUNNING", provider: "openai", model: response.model || selectedModel });

      const finishedAt = new Date();
      const artifactDir = path.resolve(artifactsRoot, workspaceId, task.id, run.id);
      await fs.mkdir(artifactDir, { recursive: true });
      const markdownName = `hasil-${safeFileSlug(task.title)}.md`;
      const reportName = `openai-run-${run.id.slice(0, 8)}.json`;
      const markdownPath = path.resolve(artifactDir, markdownName);
      const reportPath = path.resolve(artifactDir, reportName);
      const markdown = `# ${task.title}\n\n> Dihasilkan oleh ${agent.name} (${agent.role}) melalui OpenAI Responses API.\n\n${outputText}\n`;
      const usage = {
        inputTokens: response.usage?.input_tokens ?? null,
        outputTokens: response.usage?.output_tokens ?? null,
        totalTokens: response.usage?.total_tokens ?? null
      };
      const report = {
        reportType: "kantorai.m3.openai-result",
        generatedAt: finishedAt.toISOString(),
        mode: "openai",
        diagnosticOnly: false,
        taskInstructionExecuted: true,
        aiProviderInvoked: true,
        provider: "openai",
        model: response.model || selectedModel,
        responseId: response.id,
        usage,
        task: { id: task.id, title: task.title, priority: task.priority },
        agent: { id: agent.id, name: agent.name, role: agent.role },
        outputArtifact: markdownName,
        note: "Ini adalah keluaran teks model AI dan wajib diperiksa manusia. Eksekusi kode, penggunaan tools, dan tindakan eksternal belum diaktifkan pada M3."
      };
      const reportBuffer = Buffer.from(`${JSON.stringify(report, null, 2)}\n`, "utf8");
      await fs.writeFile(markdownPath, markdown, { flag: "wx" });
      await fs.writeFile(reportPath, reportBuffer, { flag: "wx" });
      const markdownKey = path.relative(artifactsRoot, markdownPath).split(path.sep).join("/");
      const reportKey = path.relative(artifactsRoot, reportPath).split(path.sep).join("/");
      const actualModel = response.model || selectedModel;

      const finalState = await prisma.$transaction(async tx => {
        const current = await tx.task.findFirst({ where: { id: task.id, workspaceId }, select: { status: true } });
        if (!current || current.status !== TaskStatus.RUNNING) return current?.status ?? TaskStatus.CANCELLED;
        const outputArtifact = await tx.artifact.create({
          data: {
            workspaceId, taskId: task.id, runId: run.id, name: markdownName, mimeType: "text/markdown",
            storageKey: markdownKey, sizeBytes: BigInt(Buffer.byteLength(markdown, "utf8")),
            metadata: { provider: "openai", model: actualModel, responseId: response.id, diagnosticOnly: false } as Prisma.InputJsonValue
          }
        });
        const reportArtifact = await tx.artifact.create({
          data: {
            workspaceId, taskId: task.id, runId: run.id, name: reportName, mimeType: "application/json",
            storageKey: reportKey, sizeBytes: BigInt(reportBuffer.byteLength),
            metadata: { provider: "openai", model: actualModel, reportType: report.reportType, diagnosticOnly: false } as Prisma.InputJsonValue
          }
        });
        await tx.agentRun.update({
          where: { id: run.id },
          data: {
            status: RunStatus.SUCCEEDED, provider: "openai", model: actualModel,
            output: {
              provider: "openai", model: actualModel, responseId: response.id, outputPreview: outputText.slice(0, 1800),
              artifactIds: [outputArtifact.id, reportArtifact.id], artifacts: [markdownName, reportName], usage,
              diagnosticOnly: false, aiProviderInvoked: true
            } as Prisma.InputJsonValue,
            finishedAt
          }
        });
        await tx.task.update({
          where: { id: task.id },
          data: {
            status: TaskStatus.REVIEW_REQUIRED,
            metadata: { executorMode: "openai", provider: "openai", model: actualModel, diagnosticOnly: false, aiProviderInvoked: true, lastRunId: run.id, usage } as Prisma.InputJsonValue
          }
        });
        await tx.agent.update({ where: { id: agent.id }, data: { state: AgentState.IDLE } });
        await tx.runEvent.create({
          data: { taskId: task.id, runId: run.id, eventType: "run.succeeded", actorType: "WORKER", message: "OpenAI menghasilkan keluaran; artefak tersimpan dan menunggu review manusia.", payload: { provider: "openai", model: actualModel, responseId: response.id, artifactIds: [outputArtifact.id, reportArtifact.id], usage, diagnosticOnly: false } }
        });
        await tx.runEvent.create({
          data: { taskId: task.id, runId: run.id, eventType: "task.review_required", actorType: "WORKER", message: "Periksa hasil AI sebelum menyetujui tugas.", payload: { status: TaskStatus.REVIEW_REQUIRED, provider: "openai", model: actualModel, artifactIds: [outputArtifact.id, reportArtifact.id] } }
        });
        await tx.auditLog.create({
          data: { workspaceId, actorId: actorId || null, action: "task.openai_completed", entityType: "task", entityId: task.id, metadata: { runId: run.id, provider: "openai", model: actualModel, responseId: response.id, artifactIds: [outputArtifact.id, reportArtifact.id], usage } as Prisma.InputJsonValue }
        });
        return TaskStatus.REVIEW_REQUIRED;
      });

      if (finalState === TaskStatus.PAUSED || finalState === TaskStatus.CANCELLED) {
        await stopRun(task.id, workspaceId, run.id, agent.id, finalState);
        return { stopped: true, status: finalState, runId: run.id };
      }
      if (finalState !== TaskStatus.REVIEW_REQUIRED) {
        await publish(workspaceId, "task.run_state_changed", { taskId, runId: run.id, status: finalState });
        return { status: finalState, runId: run.id };
      }
      await job.updateProgress(100);
      await publish(workspaceId, "task.run_completed", { taskId, runId: run.id, agentId: agent.id, status: "REVIEW_REQUIRED", executorMode, diagnosticOnly: false, aiProviderInvoked: true, provider: "openai", model: actualModel });
      await syncManagerParentPlanStatus(task.id, workspaceId).catch(error => console.warn("[worker] Status rencana induk tidak dapat disinkronkan:", safeErrorMessage(error)));
      return { status: "REVIEW_REQUIRED", runId: run.id, diagnosticOnly: false, aiProviderInvoked: true, provider: "openai", model: actualModel };
    }

    const phases = [
      { progress: 20, code: "worker.claimed", message: "Worker berhasil mengambil task dari antrean." },
      { progress: 55, code: "worker.validated", message: "Task, workspace, dan agent diperiksa; provider AI tidak dipanggil dalam dry-run." },
      { progress: 85, code: "worker.artifact_preparing", message: "Menyiapkan artefak diagnostik untuk memverifikasi jalur eksekusi." }
    ];
    for (const phase of phases) {
      await sleepWithCooperativeCheck(task.id, workspaceId, 350);
      await recordEvent(workspaceId, task.id, run.id, "run.progress", phase.message, {
        progress: phase.progress,
        code: phase.code,
        executorMode,
        aiProviderInvoked: false
      });
      await job.updateProgress(phase.progress);
      await publish(workspaceId, "task.run_progress", { taskId, runId: run.id, progress: phase.progress, message: phase.message, status: "RUNNING" });
    }

    const finishedAt = new Date();
    const report = {
      reportType: "kantorai.m2.dry-run",
      generatedAt: finishedAt.toISOString(),
      mode: "dry-run",
      diagnosticOnly: true,
      taskInstructionExecuted: false,
      aiProviderInvoked: false,
      task: {
        id: task.id,
        title: task.title,
        priority: task.priority,
        instructionLength: task.instruction.length
      },
      agent: { id: agent.id, name: agent.name, role: agent.role },
      executionEngine: {
        jobClaimed: true,
        databaseRunCreated: true,
        progressEventsRecorded: true,
        artifactStorageEnabled: true
      },
      message: "Task Execution Engine M2 berhasil memproses siklus worker. Instruksi tugas belum dijalankan oleh model AI. Artefak ini hanya laporan diagnostik, bukan hasil kerja final.",
      nextMilestone: "M3 — integrasi provider AI"
    };
    const artifactDir = path.resolve(artifactsRoot, workspaceId, task.id, run.id);
    await fs.mkdir(artifactDir, { recursive: true });
    const artifactPath = path.resolve(artifactDir, "M2-dry-run-report.json");
    const artifactBuffer = Buffer.from(`${JSON.stringify(report, null, 2)}\n`, "utf8");
    await fs.writeFile(artifactPath, artifactBuffer, { flag: "wx" }).catch(async error => {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      await fs.writeFile(artifactPath, artifactBuffer);
    });
    const storageKey = path.relative(artifactsRoot, artifactPath).split(path.sep).join("/");

    const finalState = await prisma.$transaction(async tx => {
      const current = await tx.task.findFirst({ where: { id: task.id, workspaceId }, select: { status: true } });
      if (!current || current.status !== TaskStatus.RUNNING) return current?.status ?? TaskStatus.CANCELLED;
      const artifact = await tx.artifact.create({
        data: {
          workspaceId,
          taskId: task.id,
          runId: run.id,
          name: "M2-dry-run-report.json",
          mimeType: "application/json",
          storageKey,
          sizeBytes: BigInt(artifactBuffer.byteLength),
          metadata: { executorMode, diagnosticOnly: true, aiProviderInvoked: false } as Prisma.InputJsonValue
        }
      });
      await tx.agentRun.update({
        where: { id: run.id },
        data: {
          status: RunStatus.SUCCEEDED,
          output: { ...report, artifactId: artifact.id } as Prisma.InputJsonValue,
          finishedAt
        }
      });
      await tx.task.update({ where: { id: task.id }, data: { status: TaskStatus.REVIEW_REQUIRED, metadata: { executorMode, diagnosticOnly: true, aiProviderInvoked: false } as Prisma.InputJsonValue } });
      await tx.agent.update({ where: { id: agent.id }, data: { state: AgentState.IDLE } });
      await tx.runEvent.create({
        data: {
          taskId: task.id,
          runId: run.id,
          eventType: "run.succeeded",
          actorType: "WORKER",
          message: "Siklus worker selesai; artefak diagnostik dibuat. Instruksi belum dijalankan AI.",
          payload: { artifactId: artifact.id, executorMode, aiProviderInvoked: false, diagnosticOnly: true }
        }
      });
      await tx.runEvent.create({
        data: {
          taskId: task.id,
          runId: run.id,
          eventType: "task.review_required",
          actorType: "WORKER",
          message: "Periksa artefak diagnostik M2. Jangan menganggapnya sebagai hasil akhir AI.",
          payload: { artifactId: artifact.id, status: TaskStatus.REVIEW_REQUIRED, diagnosticOnly: true }
        }
      });
      await tx.auditLog.create({
        data: {
          workspaceId,
          actorId: actorId || null,
          action: "task.dry_run_completed",
          entityType: "task",
          entityId: task.id,
          metadata: { runId: run.id, artifactId: artifact.id, diagnosticOnly: true, aiProviderInvoked: false }
        }
      });
      return TaskStatus.REVIEW_REQUIRED;
    });

    if (finalState === TaskStatus.PAUSED || finalState === TaskStatus.CANCELLED) {
      await stopRun(task.id, workspaceId, run.id, agent.id, finalState);
      return { stopped: true, status: finalState, runId: run.id };
    }
    if (finalState !== TaskStatus.REVIEW_REQUIRED) {
      await publish(workspaceId, "task.run_state_changed", { taskId, runId: run.id, status: finalState });
      return { status: finalState, runId: run.id };
    }
    await publish(workspaceId, "task.run_completed", { taskId, runId: run.id, agentId: agent.id, status: "REVIEW_REQUIRED", executorMode, diagnosticOnly: true, aiProviderInvoked: false });
    await syncManagerParentPlanStatus(task.id, workspaceId).catch(error => console.warn("[worker] Status rencana induk tidak dapat disinkronkan:", safeErrorMessage(error)));
    return { status: "REVIEW_REQUIRED", runId: run.id, diagnosticOnly: true };
  } catch (error) {
    if (error instanceof TaskStoppedError && runId) {
      await stopRun(task.id, workspaceId, runId, agent.id, error.taskStatus);
      return { stopped: true, status: error.taskStatus, runId };
    }
    const message = safeErrorMessage(error);
    if (runId) {
      await prisma.$transaction(async tx => {
        await tx.agentRun.updateMany({
          where: { id: runId as string, workspaceId, status: RunStatus.STARTED },
          data: { status: RunStatus.FAILED, errorMessage: message, finishedAt: new Date() }
        });
        await tx.task.updateMany({ where: { id: task.id, workspaceId, status: TaskStatus.RUNNING }, data: { status: TaskStatus.FAILED } });
        await tx.agent.updateMany({ where: { id: agent.id, workspaceId, state: { not: AgentState.DISABLED } }, data: { state: AgentState.IDLE } });
        await tx.runEvent.create({ data: { taskId: task.id, runId: runId as string, eventType: "run.failed", actorType: "WORKER", message, payload: { error: "WORKER_EXECUTION_ERROR" } } });
        await tx.auditLog.create({ data: { workspaceId, actorId: actorId || null, action: "task.run_failed", entityType: "task", entityId: task.id, metadata: { runId, message } } });
      }).catch(dbError => console.error("[worker] Gagal mencatat kegagalan eksekusi:", dbError));
      await publish(workspaceId, "task.run_failed", { taskId, runId, status: "FAILED", message }).catch(() => {});
      await syncManagerParentPlanStatus(task.id, workspaceId).catch(syncError => console.warn("[worker] Status rencana induk tidak dapat disinkronkan:", safeErrorMessage(syncError)));
    } else {
      await prisma.task.updateMany({ where: { id: task.id, workspaceId, status: TaskStatus.QUEUED }, data: { status: TaskStatus.FAILED } }).catch(() => {});
      await recordEvent(workspaceId, task.id, null, "task.run_failed", message, { error: "WORKER_EXECUTION_ERROR" }).catch(() => {});
    }
    throw error;
  }
}

const worker = new Worker<TaskJobPayload>(TASK_QUEUE_NAME, processJob, {
  connection: workerConnection,
  concurrency,
  lockDuration: 60_000,
  stalledInterval: 30_000
});

worker.on("ready", () => {
  console.log(`[worker] KantorAI task worker siap (concurrency=${concurrency}, mode=${executorMode}).`);
});
worker.on("active", job => {
  console.log(`[worker] Memproses job=${job.id}, task=${job.data.taskId}`);
});
worker.on("completed", (job, result) => {
  console.log(`[worker] Job ${job.id} selesai ditangani:`, result);
});
worker.on("failed", (job, error) => {
  console.error(`[worker] Job ${job?.id ?? "unknown"} gagal:`, safeErrorMessage(error));
});
worker.on("error", error => {
  console.error("[worker] Worker error:", safeErrorMessage(error));
});

async function writeHeartbeat() {
  try {
    await publisher.set(WORKER_HEARTBEAT_KEY, JSON.stringify({
      online: true,
      pid: process.pid,
      host: os.hostname(),
      startedAt: workerStartedAt,
      lastSeenAt: new Date().toISOString(),
      executorMode,
      concurrency
    }), "EX", 12);
  } catch (error) {
    console.warn("[worker] Tidak dapat memperbarui heartbeat:", error instanceof Error ? error.message : error);
  }
}

heartbeatTimer = setInterval(() => { void writeHeartbeat(); }, 4000);
void writeHeartbeat();

async function closeWorker(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[worker] Menerima ${signal}; menutup worker...`);
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  await publisher.del(WORKER_HEARTBEAT_KEY).catch(() => 0);
  await worker.close();
  await Promise.allSettled([workerConnection.quit(), publisher.quit(), prisma.$disconnect()]);
}
process.once("SIGINT", () => { void closeWorker("SIGINT").finally(() => process.exit(0)); });
process.once("SIGTERM", () => { void closeWorker("SIGTERM").finally(() => process.exit(0)); });
