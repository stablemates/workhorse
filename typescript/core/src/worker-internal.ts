import type { ClaimedTask, Json } from "./types.js";

/** Package-internal Queue capabilities used to build one handler activation snapshot. */
export const workerCheckpointsRead = Symbol("workhorse.worker.checkpoints-read");
export const workerProgressRead = Symbol("workhorse.worker.progress-read");
export const workerWaitsRead = Symbol("workhorse.worker.waits-read");

/**
 * Validates a handler result and returns the fenced write that completes the task. The worker
 * charges a validation error to the handler and treats a write error as a settlement failure.
 */
export const workerCompletionPrepare = Symbol("workhorse.worker.completion-prepare");

export interface WorkerCompletionPreparation {
  [workerCompletionPrepare](
    task: ClaimedTask,
    workerId: string,
    result: Json,
  ): Promise<() => Promise<boolean>>;
}
