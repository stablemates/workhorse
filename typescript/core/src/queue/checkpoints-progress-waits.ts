import { SQL_STATEMENTS } from "./sql-catalogue.generated.js";
import { expectOneRow, WorkhorseError } from "../errors.js";
import { jobSpanAttributes, logDebug, logInfo } from "../telemetry.js";
import type { ClaimedJob, JobCheckpoint, JobProgress, JobWait, Json } from "../types.js";
import { MAX_WAIT_DURATION_MS } from "../types.js";
import { QueueModule } from "./module-context.js";

type CheckpointRow = {
  job_id: string;
  checkpoint_name: string;
  checkpoint_value: Json;
  attempt: number;
  fence_token: string;
  worker_id: string;
  created_at: Date;
};

type SaveCheckpointRow = Omit<CheckpointRow, "job_id" | "checkpoint_name"> & {
  status: "saved" | "existing" | "conflict" | "stale";
};

export type ProgressRow = {
  job_id: string;
  progress_value: Json;
  revision: string;
  attempt: number;
  fence_token: string;
  worker_id: string;
  created_at: Date;
  updated_at: Date;
};

type UpdateProgressRow = Omit<ProgressRow, "job_id"> & {
  status: "updated" | "unchanged" | "rate_limited" | "stale";
  retry_after_ms: string | null;
};

type WaitRow = {
  job_id: string;
  wait_name: string;
  mode: JobWait["mode"];
  duration_ms: string | null;
  requested_wake_at: Date | null;
  wake_at: Date;
  attempt: number;
  fence_token: string;
  worker_id: string;
  created_at: Date;
};

type ScheduleWaitRow = Omit<WaitRow, "job_id"> & {
  status: "scheduled" | "elapsed" | "conflict" | "limit_exceeded" | "stale";
};

export type ScheduleWaitRequest =
  | { durationMs: number; wakeAt?: never }
  | { durationMs?: never; wakeAt: Date };

export interface ScheduleWaitResult {
  status: "scheduled" | "elapsed";
  wait: JobWait;
}

function checkpointRecord<TValue extends Json>(row: CheckpointRow): JobCheckpoint<TValue> {
  return {
    jobId: row.job_id,
    name: row.checkpoint_name,
    value: row.checkpoint_value as TValue,
    attempt: row.attempt,
    fenceToken: BigInt(row.fence_token),
    workerId: row.worker_id,
    createdAt: row.created_at,
  };
}

export function progressRecord<TValue extends Json>(row: ProgressRow): JobProgress<TValue> {
  return {
    jobId: row.job_id,
    value: row.progress_value as TValue,
    revision: BigInt(row.revision),
    attempt: row.attempt,
    fenceToken: BigInt(row.fence_token),
    workerId: row.worker_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function waitRecord(row: WaitRow): JobWait {
  return {
    jobId: row.job_id,
    name: row.wait_name,
    mode: row.mode,
    durationMs: row.duration_ms === null ? null : Number(row.duration_ms),
    requestedWakeAt: row.requested_wake_at,
    wakeAt: row.wake_at,
    attempt: row.attempt,
    fenceToken: BigInt(row.fence_token),
    workerId: row.worker_id,
    createdAt: row.created_at,
  };
}

function validateWaitName(name: string): void {
  if (typeof name !== "string") throw new TypeError("Wait name must be a string");
  const length = [...name].length;
  if (length < 1 || length > 200) {
    throw new RangeError("Wait name must contain between 1 and 200 characters");
  }
}

export class CheckpointLeaseLostError extends WorkhorseError {
  constructor(jobId: string, checkpointName: string) {
    super(
      `Cannot save checkpoint ${checkpointName} for job ${jobId} because the lease is stale or expired`,
    );
    this.name = "CheckpointLeaseLostError";
  }
}

export class ProgressLeaseLostError extends WorkhorseError {
  constructor(jobId: string) {
    super(`Cannot update progress for job ${jobId} because the lease is stale or expired`);
    this.name = "ProgressLeaseLostError";
  }
}

export class ProgressRateLimitError extends WorkhorseError {
  constructor(
    readonly jobId: string,
    readonly retryAfterMs: number,
  ) {
    super(`Cannot update progress for job ${jobId} yet; retry after ${retryAfterMs} milliseconds`);
    this.name = "ProgressRateLimitError";
  }
}

export class CheckpointConflictError extends WorkhorseError {
  constructor(jobId: string, checkpointName: string) {
    super(`Checkpoint ${checkpointName} for job ${jobId} already exists with a different value`);
    this.name = "CheckpointConflictError";
  }
}

export class WaitLeaseLostError extends WorkhorseError {
  constructor(
    readonly jobId: string,
    readonly waitName: string,
  ) {
    super(
      `Cannot schedule wait ${waitName} for job ${jobId} because the lease is stale or expired`,
    );
    this.name = "WaitLeaseLostError";
  }
}

export class WaitConflictError extends WorkhorseError {
  constructor(
    readonly jobId: string,
    readonly waitName: string,
    readonly existing: JobWait,
  ) {
    super(
      `Wait ${waitName} for job ${jobId} already exists with a different mode or absolute target`,
    );
    this.name = "WaitConflictError";
  }
}

export class WaitLimitExceededError extends WorkhorseError {
  constructor(readonly jobId: string) {
    super(`Job ${jobId} already has the maximum of 1000 durable waits`);
    this.name = "WaitLimitExceededError";
  }
}

/** Owns checkpoint, progress, and durable-wait operations behind the Queue facade. */
export class CheckpointsProgressWaitsModule extends QueueModule {
  async getCheckpoint<TValue extends Json = Json>(
    jobId: string,
    name: string,
  ): Promise<JobCheckpoint<TValue> | null> {
    const result = await this.context.database.query<CheckpointRow>(
      SQL_STATEMENTS["get_checkpoint"],
      [jobId, name],
    );
    const row = result.rows[0];
    return row ? checkpointRecord<TValue>(row) : null;
  }

  async listCheckpoints<TValue extends Json = Json>(
    jobId: string,
  ): Promise<JobCheckpoint<TValue>[]> {
    const result = await this.context.database.query<CheckpointRow>(
      SQL_STATEMENTS["list_checkpoints"],
      [jobId],
    );
    return result.rows.map((row) => checkpointRecord<TValue>(row));
  }

  async saveCheckpoint<TValue extends Json>(
    job: ClaimedJob,
    workerId: string,
    name: string,
    value: TValue,
  ): Promise<JobCheckpoint<TValue>> {
    const encodedValue = JSON.stringify(value);
    if (encodedValue === undefined) {
      throw new TypeError("Checkpoint value must be JSON serializable");
    }
    const result = await this.context.database.query<SaveCheckpointRow>(
      SQL_STATEMENTS["save_checkpoint_v1"],
      [job.id, workerId, job.fenceToken.toString(), name, encodedValue],
    );
    const row = expectOneRow(result, "workhorse.save_checkpoint_v1");
    if (row.status === "stale") throw new CheckpointLeaseLostError(job.id, name);
    if (row.status === "conflict") throw new CheckpointConflictError(job.id, name);
    if (row.status !== "saved" && row.status !== "existing") {
      throw new Error(`Unexpected checkpoint status: ${String(row.status)}`);
    }
    logDebug("workhorse.job.checkpoint_saved", "Job checkpoint persisted", {
      ...jobSpanAttributes(job),
      "workhorse.checkpoint.name": name,
      "workhorse.checkpoint.status": row.status,
      "workhorse.worker.id": workerId,
    });
    return checkpointRecord<TValue>({ ...row, job_id: job.id, checkpoint_name: name });
  }

  async getProgress<TValue extends Json = Json>(
    jobId: string,
  ): Promise<JobProgress<TValue> | null> {
    const result = await this.context.database.query<ProgressRow>(SQL_STATEMENTS["get_progress"], [
      jobId,
    ]);
    const row = result.rows[0];
    return row ? progressRecord<TValue>(row) : null;
  }

  async updateProgress<TValue extends Json>(
    job: ClaimedJob,
    workerId: string,
    value: TValue,
  ): Promise<JobProgress<TValue>> {
    const encodedValue = JSON.stringify(value);
    if (encodedValue === undefined) {
      throw new TypeError("Progress value must be JSON serializable");
    }
    const result = await this.context.database.query<UpdateProgressRow>(
      SQL_STATEMENTS["update_progress_v1"],
      [job.id, workerId, job.fenceToken.toString(), encodedValue],
    );
    const row = expectOneRow(result, "workhorse.update_progress_v1");
    if (row.status === "stale") throw new ProgressLeaseLostError(job.id);
    if (row.status === "rate_limited") {
      throw new ProgressRateLimitError(job.id, Number(row.retry_after_ms));
    }
    if (row.status !== "updated" && row.status !== "unchanged") {
      throw new Error(`Unexpected progress status: ${String(row.status)}`);
    }
    logDebug("workhorse.job.progress_updated", "Job progress persisted", {
      ...jobSpanAttributes(job),
      "workhorse.progress.status": row.status,
      "workhorse.worker.id": workerId,
    });
    return progressRecord<TValue>({ ...row, job_id: job.id });
  }

  async getWait(jobId: string, name: string): Promise<JobWait | null> {
    validateWaitName(name);
    const result = await this.context.database.query<WaitRow>(SQL_STATEMENTS["get_wait"], [
      jobId,
      name,
    ]);
    const row = result.rows[0];
    return row ? waitRecord(row) : null;
  }

  async listWaits(jobId: string): Promise<JobWait[]> {
    const result = await this.context.database.query<WaitRow>(SQL_STATEMENTS["list_waits"], [
      jobId,
    ]);
    return result.rows.map(waitRecord);
  }

  async scheduleWait(
    job: ClaimedJob,
    workerId: string,
    name: string,
    request: ScheduleWaitRequest,
  ): Promise<ScheduleWaitResult> {
    validateWaitName(name);
    if (typeof workerId !== "string" || workerId.length === 0) {
      throw new TypeError("Worker ID must be a non-empty string");
    }

    const hasDuration = "durationMs" in request && request.durationMs !== undefined;
    const hasWakeAt = "wakeAt" in request && request.wakeAt !== undefined;
    if (hasDuration === hasWakeAt) {
      throw new TypeError("Exactly one of durationMs or wakeAt is required");
    }

    let durationWire: string | null = null;
    let wakeAtWire: string | null = null;
    if (hasDuration) {
      const durationMs = request.durationMs;
      if (!Number.isSafeInteger(durationMs)) {
        throw new TypeError("Wait durationMs must be a safe integer number of milliseconds");
      }
      if (durationMs < 1 || durationMs > MAX_WAIT_DURATION_MS) {
        throw new RangeError(`Wait durationMs must be between 1 and ${MAX_WAIT_DURATION_MS}`);
      }
      // pg must receive bigint as text so JavaScript never rounds the wire value.
      durationWire = durationMs.toString();
    } else {
      const wakeAt = request.wakeAt;
      if (!(wakeAt instanceof Date) || !Number.isFinite(wakeAt.getTime())) {
        throw new TypeError("Wait wakeAt must be a finite Date");
      }
      if (wakeAt.getTime() - Date.now() > MAX_WAIT_DURATION_MS) {
        throw new RangeError("Wait wakeAt must be no more than 365 days in the future");
      }
      wakeAtWire = wakeAt.toISOString();
    }

    const result = await this.context.database.query<ScheduleWaitRow>(
      SQL_STATEMENTS["schedule_wait_v1"],
      [job.id, workerId, job.fenceToken.toString(), name, durationWire, wakeAtWire],
    );
    const row = expectOneRow(result, "workhorse.schedule_wait_v1");
    if (row.status === "stale") throw new WaitLeaseLostError(job.id, name);
    if (row.status === "conflict") {
      throw new WaitConflictError(job.id, name, waitRecord({ ...row, job_id: job.id }));
    }
    if (row.status === "limit_exceeded") throw new WaitLimitExceededError(job.id);
    if (row.status !== "scheduled" && row.status !== "elapsed") {
      throw new Error(`Unexpected wait status: ${String(row.status)}`);
    }
    logInfo("workhorse.job.wait_processed", "Durable job wait processed", {
      ...jobSpanAttributes(job),
      "workhorse.wait.name": name,
      "workhorse.wait.status": row.status,
      "workhorse.worker.id": workerId,
    });
    return { status: row.status, wait: waitRecord({ ...row, job_id: job.id }) };
  }
}
