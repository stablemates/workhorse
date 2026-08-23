/** Package-internal Queue capabilities used to build one handler activation snapshot. */
export const workerCheckpointsRead = Symbol("workhorse.worker.checkpoints-read");
export const workerProgressRead = Symbol("workhorse.worker.progress-read");
export const workerWaitsRead = Symbol("workhorse.worker.waits-read");
