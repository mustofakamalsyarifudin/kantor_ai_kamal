import { Redis } from "ioredis";
import { Queue } from "bullmq";
import type { TaskPriority } from "@prisma/client";

export const TASK_QUEUE_NAME = "kantorai-task-execution";
export const WORKER_EVENT_CHANNEL = "kantorai:worker-events";
export const WORKER_HEARTBEAT_KEY = "kantorai:worker:heartbeat";

export type TaskJobPayload = {
  taskId: string;
  workspaceId: string;
  actorId?: string;
  queuedAt: string;
};

export function createRedisConnection() {
  const redisUrl = process.env.REDIS_URL || "redis://127.0.0.1:6379";
  return new Redis(redisUrl, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    lazyConnect: false
  });
}

export function createTaskQueue() {
  return new Queue<TaskJobPayload>(TASK_QUEUE_NAME, {
    connection: createRedisConnection(),
    defaultJobOptions: {
      removeOnComplete: 500,
      removeOnFail: 1000
    }
  });
}

export function priorityForQueue(priority: TaskPriority): number {
  switch (priority) {
    case "URGENT": return 1;
    case "HIGH": return 2;
    case "NORMAL": return 3;
    case "LOW": return 4;
    default: return 3;
  }
}
