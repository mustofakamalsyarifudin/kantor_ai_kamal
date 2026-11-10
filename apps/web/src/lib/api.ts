export const API_URL = (import.meta.env.VITE_API_URL || "http://127.0.0.1:4000").replace(/\/$/, "");
const TOKEN_KEY = "kantorai_access_token";

export type Department = { id: string; code: string; name: string; description?: string | null; sortOrder: number };
export type Agent = {
  id: string; slug: string; name: string; role: string; description?: string | null;
  provider?: string | null; model?: string | null; state: string; enabled: boolean;
  allowedTools: string[]; dailyBudget?: string | number | null; department?: Department | null;
  hasSystemPrompt?: boolean; visualConfig?: Record<string, unknown> | null; createdAt: string; updatedAt: string;
};
export type Task = {
  id: string; title: string; instruction: string; status: string; priority: string;
  assignedAgentId?: string | null; assignedAgent?: Pick<Agent,"id"|"name"|"role"|"state"> | null;
  parentTaskId?: string | null;
  createdAt: string; updatedAt: string; dueAt?: string | null;
  metadata?: Record<string, unknown> | null;
  queueWarning?: string;
  managerPlanReleasedSubtasks?: number;
  managerPlanReleaseWarning?: string | null;
  _count?: { runs: number; artifacts: number };
};
export type TaskArtifact = {
  id: string; name: string; mimeType: string; sizeBytes?: string | null;
  metadata?: Record<string, unknown> | null; createdAt: string;
};
export type TaskRunEvent = {
  id: string; taskId: string; runId?: string | null; eventType: string;
  actorType: string; message?: string | null; payload?: unknown; createdAt: string;
};
export type TaskRun = {
  id: string; taskId: string; agentId: string; status: string;
  provider?: string | null; model?: string | null; input?: unknown; output?: unknown;
  errorMessage?: string | null; startedAt: string; finishedAt?: string | null;
  agent?: Pick<Agent,"id"|"name"|"role">;
  events: TaskRunEvent[]; artifacts: TaskArtifact[];
};
export type WorkspaceEvent = {
  id: string; taskId: string; runId?: string | null; eventType: string;
  actorType: string; message?: string | null; payload?: unknown; createdAt: string;
  task?: { id: string; title: string; status: string; assignedAgent?: { id: string; name: string } | null };
  run?: { id: string; status: string; provider?: string | null; model?: string | null } | null;
};
export type QueueStatus = {
  status: string; queue: string; redis: string; workerOnline: boolean;
  worker?: { online?: boolean; lastSeenAt?: string; executorMode?: string; concurrency?: number } | null;
  executorMode: string; aiProviderConfigured: boolean; aiProviderInvokedByM2Worker: boolean;
  openAiModel?: string; providerCanExecute?: boolean;
  counts?: { waiting?: number; active?: number; completed?: number; failed?: number; delayed?: number; paused?: number };
};
export type ManagerPlanPriority = "LOW" | "NORMAL" | "HIGH" | "URGENT";
export type ManagerPlanTask = {
  title: string;
  instruction: string;
  assignedAgentId: string;
  priority: ManagerPlanPriority;
  rationale: string;
  acceptanceCriteria: string;
};
export type ManagerPlanResponse = {
  planTitle: string;
  summary: string;
  tasks: ManagerPlanTask[];
  manager: { id: string; name: string; role: string };
  model: string;
  usage?: { inputTokens: number | null; outputTokens: number | null; totalTokens: number | null } | null;
  responseId: string;
};
export type ManagerLaunchResponse = {
  parent: Task;
  subtasks: Task[];
  queueWarning?: string | null;
  workflowMessage?: string | null;
  idempotentReplay?: boolean;
};
export type ManagerFinalReviewResponse = {
  parentTaskId: string;
  reused: boolean;
  model?: string;
  artifact: TaskArtifact;
  outputPreview: string;
};

export type CurrentUser = { user: { id: string; email: string; name: string }; workspaceId: string };
export type SocketEvent = { type: string; data: unknown; at: string };

export function getToken() { return sessionStorage.getItem(TOKEN_KEY); }
export function setToken(token: string) { sessionStorage.setItem(TOKEN_KEY, token); }
export function clearToken() { sessionStorage.removeItem(TOKEN_KEY); }

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = getToken();
  const headers = new Headers(init.headers);
  if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  if (token) headers.set("Authorization", `Bearer ${token}`);
  const response = await fetch(`${API_URL}${path}`, { ...init, headers });
  const contentType = response.headers.get("content-type") || "";
  const body = contentType.includes("application/json") ? await response.json() : await response.text();
  if (!response.ok) {
    if (response.status === 401) clearToken();
    const message = typeof body === "object" && body && "message" in body ? String(body.message) : `Request gagal (${response.status}).`;
    throw new Error(message);
  }
  return body as T;
}
