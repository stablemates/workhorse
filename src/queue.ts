import { CronExpressionParser } from "cron-parser";
import type {
  ClaimedJob,
  EnqueueIdempotency,
  EnqueueIdempotencyConflictDetails,
  EnqueueIdempotencyConflictField,
  EnqueueOptions,
  EnqueueRequest,
  JobCheckpoint,
  JobSnapshot,
  JobWait,
  Json,
  Queryable,
  QueueHealth,
  RetryPolicy,
  RetentionPolicy,
  RetentionPolicyDefinition,
} from "./types.js";

export interface ScheduleJobDefinition {
  type: string;
  payload: Json;
  queue?: string;
  maxAttempts?: number;
  retryPolicy?: RetryPolicy;
}

export interface ScheduleDefinition {
  name: string;
  schedule: string;
  enabled?: boolean;
  job: ScheduleJobDefinition;
}

export interface StoredSchedule {
  namespace: string;
  name: string;
  schedule: string;
  revision: bigint;
  lastOccurrenceAt: Date | null;
}

export type MaintenancePhase =
  | "promote"
  | "recover"
  | "history_partitions"
  | "event_retention"
  | "attempt_retention"
  | "schedule_occurrences"
  | "enqueue_idempotency"
  | "terminal_jobs";

export interface MaintenancePhaseResult {
  phase: MaintenancePhase;
  rowsAffected: number;
  durationMs: number;
  skippedLock: boolean;
  error: Json;
}
import {
  DEFAULT_IDEMPOTENCY_SCOPE,
  DEFAULT_IDEMPOTENCY_TTL_MS,
  MAX_ENQUEUE_BATCH_SIZE,
  MAX_WAIT_DURATION_MS,
} from "./types.js";

type ClaimRow = {
  job_id: string;
  job_type: string;
  payload: Json;
  attempt: number;
  max_attempts: number;
  retry_policy: RetryPolicy | null;
  fence_token: string;
  lease_expires_at: Date;
};

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
  | {
      durationMs?: never;
      wakeAt: Date;
    };

export interface ScheduleWaitResult {
  status: "scheduled" | "elapsed";
  wait: JobWait;
}

type MaintenancePhaseRow = {
  phase: MaintenancePhase;
  rows_affected: number;
  duration_ms: number;
  skipped_lock: boolean;
  error: Json;
};

type RetentionPolicyRow = {
  job_identity_retention_days: number | null;
  terminal_outcome_retention_days: number | null;
  job_event_retention_days: number | null;
  attempt_history_retention_days: number | null;
  schedule_occurrence_retention_days: number | null;
  terminal_job_prune_limit: number;
  history_partitions_per_pass: number;
  default_partition_rows_per_pass: number;
  occurrence_rows_per_pass: number;
  updated_at: Date;
};

function maintenancePhaseResult(row: MaintenancePhaseRow): MaintenancePhaseResult {
  return {
    phase: row.phase,
    rowsAffected: row.rows_affected,
    durationMs: row.duration_ms,
    skippedLock: row.skipped_lock,
    error: row.error,
  };
}

function retentionPolicy(row: RetentionPolicyRow): RetentionPolicy {
  return {
    jobIdentityRetentionDays: row.job_identity_retention_days,
    terminalOutcomeRetentionDays: row.terminal_outcome_retention_days,
    jobEventRetentionDays: row.job_event_retention_days,
    attemptHistoryRetentionDays: row.attempt_history_retention_days,
    scheduleOccurrenceRetentionDays: row.schedule_occurrence_retention_days,
    terminalJobPruneLimit: row.terminal_job_prune_limit,
    historyPartitionsPerPass: row.history_partitions_per_pass,
    defaultPartitionRowsPerPass: row.default_partition_rows_per_pass,
    occurrenceRowsPerPass: row.occurrence_rows_per_pass,
    updatedAt: row.updated_at,
  };
}

function errorEnvelope(error: unknown): Json {
  // Persist a bounded JSON representation instead of relying on Error's non-enumerable fields.
  if (error instanceof Error) {
    return { name: error.name, message: error.message, stack: error.stack ?? null };
  }
  return { name: "NonErrorThrown", message: String(error) };
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

export class CheckpointLeaseLostError extends Error {
  constructor(jobId: string, checkpointName: string) {
    super(
      `Cannot save checkpoint ${checkpointName} for job ${jobId} because the lease is stale or expired`,
    );
    this.name = "CheckpointLeaseLostError";
  }
}

/** The same scoped enqueue key is still retained for a materially different request. */
export class EnqueueIdempotencyConflictError extends Error {
  constructor(readonly details: EnqueueIdempotencyConflictDetails) {
    super(
      `Enqueue idempotency conflict in scope ${details.scope} for key ${details.keyPreview} (${details.keyDigest}); fields: ${details.conflictingFields.join(", ")}`,
    );
    this.name = "EnqueueIdempotencyConflictError";
  }

  get scope(): string {
    return this.details.scope;
  }
  get keyPreview(): string {
    return this.details.keyPreview;
  }
  get keyDigest(): string {
    return this.details.keyDigest;
  }
  get keyLength(): number {
    return this.details.keyLength;
  }
  get existingJobId(): string {
    return this.details.existingJobId;
  }
  get ordinal(): number {
    return this.details.ordinal;
  }
  get conflictingFields(): EnqueueIdempotencyConflictField[] {
    return this.details.conflictingFields;
  }
  get storedRequestDigest(): string {
    return this.details.storedRequestDigest;
  }
  get rejectedRequestDigest(): string {
    return this.details.rejectedRequestDigest;
  }
}

const enqueueConflictFields = new Set<EnqueueIdempotencyConflictField>([
  "queue",
  "type",
  "payload",
  "tags",
  "runAt",
  "maxAttempts",
  "retryPolicy",
  "ttlMs",
]);
const enqueueConflictDetailKeys = new Set([
  "scope",
  "keyPreview",
  "keyDigest",
  "keyLength",
  "existingJobId",
  "ordinal",
  "conflictingFields",
  "storedRequestDigest",
  "rejectedRequestDigest",
]);

const sanitizedEnqueueConflictDetails: EnqueueIdempotencyConflictDetails = {
  scope: "unknown",
  keyPreview: "unknown",
  keyDigest: "000000000000",
  keyLength: 0,
  existingJobId: "unknown",
  ordinal: 0,
  conflictingFields: [],
  storedRequestDigest: "0".repeat(64),
  rejectedRequestDigest: "0".repeat(64),
};

function validEnqueueConflictDetails(value: unknown): value is EnqueueIdempotencyConflictDetails {
  if (typeof value !== "object" || value === null) return false;
  const detail = value as Record<string, unknown>;
  const keys = Object.keys(detail);
  return (
    keys.length === enqueueConflictDetailKeys.size &&
    keys.every((key) => enqueueConflictDetailKeys.has(key)) &&
    typeof detail.scope === "string" &&
    detail.scope.length > 0 &&
    [...detail.scope].length <= 256 &&
    typeof detail.keyPreview === "string" &&
    detail.keyPreview.length > 0 &&
    [...detail.keyPreview].length <= 16 &&
    typeof detail.keyDigest === "string" &&
    /^[0-9a-f]{12}$/.test(detail.keyDigest) &&
    typeof detail.keyLength === "number" &&
    Number.isSafeInteger(detail.keyLength) &&
    detail.keyLength >= 1 &&
    detail.keyLength <= 512 &&
    typeof detail.existingJobId === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      detail.existingJobId,
    ) &&
    typeof detail.ordinal === "number" &&
    Number.isSafeInteger(detail.ordinal) &&
    detail.ordinal >= 1 &&
    detail.ordinal <= MAX_ENQUEUE_BATCH_SIZE &&
    Array.isArray(detail.conflictingFields) &&
    detail.conflictingFields.length > 0 &&
    detail.conflictingFields.every(
      (field): field is EnqueueIdempotencyConflictField =>
        typeof field === "string" &&
        enqueueConflictFields.has(field as EnqueueIdempotencyConflictField),
    ) &&
    new Set(detail.conflictingFields).size === detail.conflictingFields.length &&
    detail.conflictingFields.every(
      (field, index, fields) => index === 0 || fields[index - 1]! < field,
    ) &&
    typeof detail.storedRequestDigest === "string" &&
    /^[0-9a-f]{64}$/.test(detail.storedRequestDigest) &&
    typeof detail.rejectedRequestDigest === "string" &&
    /^[0-9a-f]{64}$/.test(detail.rejectedRequestDigest)
  );
}

function enqueueConflictDetails(error: unknown): EnqueueIdempotencyConflictDetails {
  const seen = new Set<object>();
  let current = error;

  for (let depth = 0; depth < 16; depth++) {
    if (typeof current !== "object" || current === null || seen.has(current)) break;
    seen.add(current);

    try {
      if ("detail" in current && typeof current.detail === "string") {
        try {
          const detail: unknown = JSON.parse(current.detail);
          if (validEnqueueConflictDetails(detail)) return detail;
        } catch {
          // Continue through adapter wrappers in case PostgreSQL's DETAIL is on a cause.
        }
      }
      current = "cause" in current ? current.cause : undefined;
    } catch {
      break;
    }
  }

  return sanitizedEnqueueConflictDetails;
}

function enqueueConflict(error: unknown): EnqueueIdempotencyConflictError | null {
  if (typeof error !== "object" || error === null || !("code" in error) || error.code !== "P1001") {
    return null;
  }
  return new EnqueueIdempotencyConflictError(enqueueConflictDetails(error));
}

export class CheckpointConflictError extends Error {
  constructor(jobId: string, checkpointName: string) {
    super(`Checkpoint ${checkpointName} for job ${jobId} already exists with a different value`);
    this.name = "CheckpointConflictError";
  }
}

export class WaitLeaseLostError extends Error {
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

export class WaitConflictError extends Error {
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

export class WaitLimitExceededError extends Error {
  constructor(readonly jobId: string) {
    super(`Job ${jobId} already has the maximum of 1000 durable waits`);
    this.name = "WaitLimitExceededError";
  }
}

/**
 * Thin TypeScript facade over the versioned PostgreSQL protocol.
 *
 * Correctness lives in SQL functions. Keeping this layer thin prevents each runtime client from
 * inventing its own locking, fencing, or history behavior.
 */
export class Queue {
  constructor(
    private readonly database: Queryable,
    readonly defaultQueue = "default",
  ) {}

  async enqueue<TPayload extends Json>(
    type: string,
    payload: TPayload,
    options: EnqueueOptions = {},
    transaction: Queryable = this.database,
  ): Promise<string> {
    return (
      await this.enqueueMany([{ type, payload, options, tags: options.tags }], transaction)
    )[0]!;
  }

  async enqueueMany(
    requests: readonly EnqueueRequest[],
    transaction: Queryable = this.database,
  ): Promise<string[]> {
    if (requests.length === 0) return [];
    if (requests.length > MAX_ENQUEUE_BATCH_SIZE) {
      throw new RangeError(`enqueueMany accepts at most ${MAX_ENQUEUE_BATCH_SIZE} requests`);
    }

    // Supplying an active PoolClient makes the whole batch participate in the caller's transaction.
    const input = requests.map(({ type, payload, options = {}, tags }) => {
      const idempotency: EnqueueIdempotency | undefined = options.idempotency;
      return {
        queue: options.queue ?? this.defaultQueue,
        type,
        payload,
        ...(options.runAt === undefined && idempotency !== undefined
          ? {}
          : { runAt: (options.runAt ?? new Date()).toISOString() }),
        maxAttempts: options.maxAttempts ?? 25,
        retryPolicy: options.retryPolicy ?? null,
        tags: tags ?? options.tags ?? [],
        ...(idempotency === undefined
          ? {}
          : {
              idempotency: {
                key: idempotency.key,
                scope: idempotency.scope ?? DEFAULT_IDEMPOTENCY_SCOPE,
                ttlMs: idempotency.ttlMs ?? DEFAULT_IDEMPOTENCY_TTL_MS,
              },
            }),
      };
    });
    try {
      const result = await transaction.query<{ job_id: string }>(
        "SELECT job_id FROM workhorse.enqueue_many_v1($1::jsonb) ORDER BY ordinal",
        [JSON.stringify(input)],
      );
      return result.rows.map((row) => row.job_id);
    } catch (error) {
      throw enqueueConflict(error) ?? error;
    }
  }

  async promote(limit = 100): Promise<number> {
    // Promotion is bounded so a large delayed backlog cannot create one long lock transaction.
    const result = await this.database.query<{ count: number }>(
      "SELECT workhorse.promote_v1($1) AS count",
      [limit],
    );
    return result.rows[0]!.count;
  }

  async pauseQueue(queueName = this.defaultQueue): Promise<void> {
    await this.database.query("SELECT workhorse.pause_queue_v1($1)", [queueName]);
  }

  async resumeQueue(queueName = this.defaultQueue): Promise<void> {
    await this.database.query("SELECT workhorse.resume_queue_v1($1)", [queueName]);
  }

  async purgeQueue(queueName = this.defaultQueue): Promise<number> {
    const result = await this.database.query<{ count: number }>(
      "SELECT workhorse.purge_queue_v1($1) AS count",
      [queueName],
    );
    return result.rows[0]!.count;
  }

  async tick(
    options: { promoteLimit?: number; recoverLimit?: number } = {},
  ): Promise<MaintenancePhaseResult[]> {
    const result = await this.database.query<MaintenancePhaseRow>(
      "SELECT * FROM workhorse.tick_v1($1, $2)",
      [options.promoteLimit ?? 1_000, options.recoverLimit ?? 1_000],
    );
    return result.rows.map(maintenancePhaseResult);
  }

  async housekeep(
    options: { occurrenceRetentionDays?: number; occurrencePruneLimit?: number } = {},
  ): Promise<MaintenancePhaseResult[]> {
    const result = await this.database.query<MaintenancePhaseRow>(
      "SELECT * FROM workhorse.housekeep_v1($1, $2)",
      [options.occurrenceRetentionDays ?? null, options.occurrencePruneLimit ?? null],
    );
    return result.rows.map(maintenancePhaseResult);
  }

  async syncRetentionPolicy(definition: RetentionPolicyDefinition): Promise<RetentionPolicy> {
    const result = await this.database.query<RetentionPolicyRow>(
      `SELECT (policy).* FROM workhorse.sync_retention_policy_v1(
         $1, $2, $3, $4, $5, $6, $7, $8, $9
       ) policy`,
      [
        definition.jobIdentityRetentionDays,
        definition.terminalOutcomeRetentionDays,
        definition.jobEventRetentionDays,
        definition.attemptHistoryRetentionDays,
        definition.scheduleOccurrenceRetentionDays,
        definition.terminalJobPruneLimit ?? null,
        definition.historyPartitionsPerPass ?? null,
        definition.defaultPartitionRowsPerPass ?? null,
        definition.occurrenceRowsPerPass ?? null,
      ],
    );
    return retentionPolicy(result.rows[0]!);
  }

  async getRetentionPolicy(): Promise<RetentionPolicy> {
    const result = await this.database.query<RetentionPolicyRow>(
      "SELECT (policy).* FROM workhorse.get_retention_policy_v1() policy",
    );
    return retentionPolicy(result.rows[0]!);
  }

  async syncSchedules(
    namespace: string,
    definitions: readonly ScheduleDefinition[],
    options: { prune?: boolean } = {},
  ): Promise<void> {
    for (const definition of definitions) {
      try {
        CronExpressionParser.parse(definition.schedule);
      } catch (error) {
        throw new Error(`Invalid cron expression for schedule ${definition.name}`, {
          cause: error,
        });
      }
    }
    const input = definitions.map((definition) => ({
      name: definition.name,
      schedule: definition.schedule,
      enabled: definition.enabled ?? true,
      queue: definition.job.queue ?? this.defaultQueue,
      type: definition.job.type,
      payload: definition.job.payload,
      maxAttempts: definition.job.maxAttempts ?? 25,
      retryPolicy: definition.job.retryPolicy ?? null,
    }));
    await this.database.query("SELECT workhorse.sync_schedule_definitions_v1($1, $2::jsonb, $3)", [
      namespace,
      JSON.stringify(input),
      options.prune ?? true,
    ]);
  }

  async schedules(namespaces: readonly string[]): Promise<StoredSchedule[]> {
    if (namespaces.length === 0) return [];
    const result = await this.database.query<{
      namespace: string;
      schedule_name: string;
      cron_expression: string;
      revision: string;
      last_occurrence_at: Date | null;
    }>(
      `SELECT definition.namespace, definition.schedule_name, definition.cron_expression,
              definition.revision::text,
              max(occurrence.occurrence_at) AS last_occurrence_at
         FROM workhorse.schedule_definition definition
         LEFT JOIN workhorse.schedule_occurrence occurrence
           ON occurrence.namespace = definition.namespace
          AND occurrence.schedule_name = definition.schedule_name
        WHERE definition.enabled AND definition.namespace = ANY($1::text[])
        GROUP BY definition.namespace, definition.schedule_name
        ORDER BY definition.namespace, definition.schedule_name`,
      [namespaces],
    );
    return result.rows.map((row) => ({
      namespace: row.namespace,
      name: row.schedule_name,
      schedule: row.cron_expression,
      revision: BigInt(row.revision),
      lastOccurrenceAt: row.last_occurrence_at,
    }));
  }

  async fireSchedule(
    namespace: string,
    name: string,
    revision: bigint,
    occurrenceAt: Date,
  ): Promise<string | null> {
    const result = await this.database.query<{ job_id: string | null }>(
      "SELECT workhorse.fire_schedule_v1($1, $2, $3, $4) AS job_id",
      [namespace, name, revision.toString(), occurrenceAt.toISOString()],
    );
    return result.rows[0]!.job_id;
  }

  async claim<TPayload = Json>(
    workerId: string,
    options: { queue?: string; leaseMs?: number } = {},
  ): Promise<ClaimedJob<TPayload> | null> {
    // claim_v1 commits ownership before returning the payload. Handler code must run only after
    // this query resolves so no row lock or claim transaction spans user code.
    const result = await this.database.query<ClaimRow>(
      "SELECT * FROM workhorse.claim_v1($1, $2, $3)",
      [options.queue ?? this.defaultQueue, workerId, options.leaseMs ?? 30_000],
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      id: row.job_id,
      type: row.job_type,
      payload: row.payload as TPayload,
      attempt: row.attempt,
      maxAttempts: row.max_attempts,
      retryPolicy: row.retry_policy,
      fenceToken: BigInt(row.fence_token),
      leaseExpiresAt: row.lease_expires_at,
    };
  }

  async heartbeat(job: ClaimedJob<unknown>, workerId: string, leaseMs = 30_000): Promise<boolean> {
    // False means the worker/fence is stale or the lease already expired. The caller must stop
    // treating the job as owned even if local handler code is still running.
    const result = await this.database.query<{ accepted: boolean }>(
      "SELECT workhorse.heartbeat_v1($1, $2, $3, $4) AS accepted",
      [job.id, workerId, job.fenceToken.toString(), leaseMs],
    );
    return result.rows[0]!.accepted;
  }

  async getCheckpoint<TValue extends Json = Json>(
    jobId: string,
    name: string,
  ): Promise<JobCheckpoint<TValue> | null> {
    const result = await this.database.query<CheckpointRow>(
      `SELECT job_id, checkpoint_name, checkpoint_value, attempt, fence_token::text,
              worker_id, created_at
         FROM workhorse.job_checkpoint
        WHERE job_id = $1 AND checkpoint_name = $2`,
      [jobId, name],
    );
    const row = result.rows[0];
    return row ? checkpointRecord<TValue>(row) : null;
  }

  async listCheckpoints<TValue extends Json = Json>(
    jobId: string,
  ): Promise<JobCheckpoint<TValue>[]> {
    const result = await this.database.query<CheckpointRow>(
      `SELECT job_id, checkpoint_name, checkpoint_value, attempt, fence_token::text,
              worker_id, created_at
         FROM workhorse.job_checkpoint
        WHERE job_id = $1
        ORDER BY created_at, checkpoint_name`,
      [jobId],
    );
    return result.rows.map((row) => checkpointRecord<TValue>(row));
  }

  async saveCheckpoint<TValue extends Json>(
    job: ClaimedJob<unknown>,
    workerId: string,
    name: string,
    value: TValue,
  ): Promise<JobCheckpoint<TValue>> {
    const encodedValue = JSON.stringify(value);
    if (encodedValue === undefined) {
      throw new TypeError("Checkpoint value must be JSON serializable");
    }
    const result = await this.database.query<SaveCheckpointRow>(
      `SELECT status, checkpoint_value, attempt, fence_token::text, worker_id, created_at
         FROM workhorse.save_checkpoint_v1($1, $2, $3, $4, $5::jsonb)`,
      [job.id, workerId, job.fenceToken.toString(), name, encodedValue],
    );
    const row = result.rows[0]!;
    if (row.status === "stale") throw new CheckpointLeaseLostError(job.id, name);
    if (row.status === "conflict") throw new CheckpointConflictError(job.id, name);
    if (row.status !== "saved" && row.status !== "existing") {
      throw new Error(`Unexpected checkpoint status: ${String(row.status)}`);
    }
    return checkpointRecord<TValue>({
      ...row,
      job_id: job.id,
      checkpoint_name: name,
    });
  }

  async getWait(jobId: string, name: string): Promise<JobWait | null> {
    validateWaitName(name);
    const result = await this.database.query<WaitRow>(
      `SELECT job_id, wait_name, mode, duration_ms::text, requested_wake_at, wake_at,
              attempt, fence_token::text, worker_id, created_at
         FROM workhorse.job_wait
        WHERE job_id = $1 AND wait_name = $2`,
      [jobId, name],
    );
    const row = result.rows[0];
    return row ? waitRecord(row) : null;
  }

  async listWaits(jobId: string): Promise<JobWait[]> {
    const result = await this.database.query<WaitRow>(
      `SELECT job_id, wait_name, mode, duration_ms::text, requested_wake_at, wake_at,
              attempt, fence_token::text, worker_id, created_at
         FROM workhorse.job_wait
        WHERE job_id = $1
        ORDER BY created_at, wait_name`,
      [jobId],
    );
    return result.rows.map(waitRecord);
  }

  async scheduleWait(
    job: ClaimedJob<unknown>,
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

    const result = await this.database.query<ScheduleWaitRow>(
      `SELECT status, wait_name, mode, duration_ms::text, requested_wake_at, wake_at,
              attempt, fence_token::text, worker_id, created_at
         FROM workhorse.schedule_wait_v1($1, $2, $3, $4, $5::bigint, $6::timestamptz)`,
      [job.id, workerId, job.fenceToken.toString(), name, durationWire, wakeAtWire],
    );
    const row = result.rows[0]!;
    if (row.status === "stale") throw new WaitLeaseLostError(job.id, name);
    if (row.status === "conflict") {
      throw new WaitConflictError(job.id, name, waitRecord({ ...row, job_id: job.id }));
    }
    if (row.status === "limit_exceeded") throw new WaitLimitExceededError(job.id);
    if (row.status !== "scheduled" && row.status !== "elapsed") {
      throw new Error(`Unexpected wait status: ${String(row.status)}`);
    }
    return {
      status: row.status,
      wait: waitRecord({ ...row, job_id: job.id }),
    };
  }

  async complete<TResult extends Json>(
    job: ClaimedJob<unknown>,
    workerId: string,
    result: TResult,
  ): Promise<boolean> {
    // Completion is conditional on the exact unexpired lease and fence. A stale worker gets false
    // rather than overwriting the result of a recovered attempt.
    const query = await this.database.query<{ accepted: boolean }>(
      "SELECT workhorse.complete_v1($1, $2, $3, $4::jsonb) AS accepted",
      [job.id, workerId, job.fenceToken.toString(), JSON.stringify(result)],
    );
    return query.rows[0]!.accepted;
  }

  async fail(
    job: ClaimedJob<unknown>,
    workerId: string,
    error: unknown,
    retryDelayMs?: number,
  ): Promise<"ready" | "scheduled" | "failed" | "stale"> {
    // PostgreSQL decides whether retry budget remains and atomically closes the old attempt before
    // creating the next projection. Undefined selects SQL-owned backoff; a number explicitly
    // overrides it, including zero for an immediate retry.
    const result = await this.database.query<{ state: "ready" | "scheduled" | "failed" | "stale" }>(
      "SELECT workhorse.fail_v1($1, $2, $3, $4::jsonb, $5) AS state",
      [
        job.id,
        workerId,
        job.fenceToken.toString(),
        JSON.stringify(errorEnvelope(error)),
        retryDelayMs ?? null,
      ],
    );
    return result.rows[0]!.state;
  }

  async recoverExpired(limit = 100, retryDelayMs?: number): Promise<number> {
    // Recovery may be called by many workers. SKIP LOCKED inside the function partitions work
    // between callers while fence checks prevent an old lease from recovering a newer attempt.
    const result = await this.database.query<{ count: number }>(
      "SELECT workhorse.recover_expired_v1($1, $2) AS count",
      [limit, retryDelayMs ?? null],
    );
    return result.rows[0]!.count;
  }

  async getJob<TResult = Json>(id: string): Promise<JobSnapshot<TResult> | null> {
    // A job exists in exactly one lifecycle relation: runtime while live, outcome when terminal.
    const result = await this.database.query<{
      id: string;
      queue_name: string;
      job_type: string;
      payload: Json;
      tags: string[];
      state: JobSnapshot["state"];
      current_attempt: number;
      max_attempts: number;
      retry_policy: RetryPolicy | null;
      version: string;
      run_at: Date;
      result: TResult | null;
      error: Json | null;
      created_at: Date;
      updated_at: Date;
    }>(
      `SELECT j.id, j.queue_name, j.job_type, j.payload, j.tags, j.retry_policy,
              COALESCE(r.state, o.state) AS state,
              COALESCE(r.current_attempt, o.current_attempt) AS current_attempt,
              j.max_attempts, COALESCE(r.fence_token, o.fence_token) AS version,
              COALESCE(r.run_at, o.run_at) AS run_at, o.result,
              COALESCE(r.error, o.error) AS error, j.created_at,
              COALESCE(r.updated_at, o.updated_at) AS updated_at
         FROM workhorse.job j
         LEFT JOIN workhorse.job_runtime r ON r.job_id = j.id
         LEFT JOIN workhorse.job_outcome o ON o.job_id = j.id
        WHERE j.id = $1`,
      [id],
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      id: row.id,
      queue: row.queue_name,
      type: row.job_type,
      payload: row.payload,
      tags: row.tags,
      state: row.state,
      currentAttempt: row.current_attempt,
      maxAttempts: row.max_attempts,
      retryPolicy: row.retry_policy,
      fenceToken: BigInt(row.version),
      runAt: row.run_at,
      result: row.result,
      error: row.error,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  async health(): Promise<QueueHealth> {
    // Run independent read-only diagnostics concurrently. PostgreSQL statistics are observations,
    // not transactional facts, and can lag until the statistics collector flushes.
    const [version, counts, depths, relations, activity, notification, retention] =
      await Promise.all([
        this.database.query<{ version: number }>(
          `SELECT CASE
                  WHEN count(*) = 1
                   AND min(version) = max(version)
                   AND NOT EXISTS (
                     SELECT 1
                       FROM unnest(ARRAY['job_current', 'ready_job', 'scheduled_job', 'lease'])
                         AS legacy(relation_name)
                      WHERE to_regclass(format('workhorse.%I', relation_name)) IS NOT NULL
                   )
                  THEN min(version)::integer
                  ELSE NULL
                END AS version
           FROM workhorse.schema_version`,
        ),
        this.database.query<{ state: JobSnapshot["state"]; count: string }>(
          `SELECT state, count(*)::text AS count
           FROM (SELECT state FROM workhorse.job_runtime UNION ALL
                 SELECT state FROM workhorse.job_outcome) lifecycle
          GROUP BY state`,
        ),
        this.database.query<{
          ready: string;
          scheduled: string;
          sleeping: string;
          overdue_waits: string;
          next_wake_at: Date | null;
          active: string;
          expired: string;
          oldest_ready_age_ms: number | null;
        }>(`
        SELECT count(*) FILTER (WHERE state = 'ready')::text AS ready,
               count(*) FILTER (WHERE state = 'scheduled')::text AS scheduled,
               count(*) FILTER (WHERE state = 'scheduled' AND wait_name IS NOT NULL)::text AS sleeping,
               count(*) FILTER (
                 WHERE state = 'scheduled' AND wait_name IS NOT NULL
                   AND run_at <= clock_timestamp()
               )::text AS overdue_waits,
               min(run_at) FILTER (
                 WHERE state = 'scheduled' AND wait_name IS NOT NULL
               ) AS next_wake_at,
               count(*) FILTER (WHERE state = 'active')::text AS active,
               count(*) FILTER (WHERE state = 'active' AND expires_at <= clock_timestamp())::text AS expired,
               extract(epoch FROM clock_timestamp() - min(ready_at) FILTER (WHERE state = 'ready')) * 1000
                 AS oldest_ready_age_ms
          FROM workhorse.job_runtime`),
        this.database.query<{
          relation: string;
          total_bytes: string;
          table_bytes: string;
          index_bytes: string;
          live_tuples: string;
          dead_tuples: string;
          modifications_since_analyze: string;
          hot_update_ratio: number | null;
          last_vacuum: Date | null;
          last_autovacuum: Date | null;
        }>(`
        SELECT c.relname AS relation, pg_total_relation_size(c.oid)::text AS total_bytes,
               pg_relation_size(c.oid)::text AS table_bytes, pg_indexes_size(c.oid)::text AS index_bytes,
               COALESCE(s.n_live_tup, 0)::text AS live_tuples, COALESCE(s.n_dead_tup, 0)::text AS dead_tuples,
               COALESCE(s.n_mod_since_analyze, 0)::text AS modifications_since_analyze,
               CASE WHEN COALESCE(s.n_tup_upd, 0) = 0 THEN NULL
                    ELSE s.n_tup_hot_upd::double precision / s.n_tup_upd END AS hot_update_ratio,
               s.last_vacuum, s.last_autovacuum
          FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          LEFT JOIN pg_stat_user_tables s ON s.relid = c.oid
         WHERE n.nspname = 'workhorse' AND c.relkind IN ('r', 'p')
         ORDER BY c.relname`),
        this.database.query<{ age_ms: number | null; lock_wait_count: string }>(`
        SELECT extract(epoch FROM clock_timestamp() - min(xact_start)) * 1000 AS age_ms,
               count(*) FILTER (WHERE wait_event_type = 'Lock')::text AS lock_wait_count
          FROM pg_stat_activity WHERE pid <> pg_backend_pid()`),
        this.database.query<{ usage: number }>("SELECT pg_notification_queue_usage() AS usage"),
        this.database.query<
          RetentionPolicyRow & {
            oldest_job_identity_at: Date | null;
            oldest_terminal_outcome_at: Date | null;
            oldest_job_event_at: Date | null;
            oldest_attempt_history_at: Date | null;
            oldest_schedule_occurrence_at: Date | null;
            job_identity_lag_ms: number | null;
            terminal_outcome_lag_ms: number | null;
            job_event_lag_ms: number | null;
            attempt_history_lag_ms: number | null;
            schedule_occurrence_lag_ms: number | null;
            eligible_event_partitions: string;
            eligible_attempt_partitions: string;
            default_event_rows: string;
            default_attempt_rows: string;
            default_event_rows_capped: boolean;
            default_attempt_rows_capped: boolean;
          }
        >(`
        WITH policy AS (
          SELECT * FROM workhorse.retention_policy WHERE singleton
        ), boundaries AS (
          SELECT
            (SELECT job.created_at
               FROM workhorse.job job
               JOIN workhorse.job_outcome outcome ON outcome.job_id = job.id
              ORDER BY job.created_at, job.id LIMIT 1)
              AS oldest_job_identity_at,
            (SELECT finished_at FROM workhorse.job_outcome ORDER BY finished_at, job_id LIMIT 1)
              AS oldest_terminal_outcome_at,
            (SELECT job.created_at
               FROM workhorse.job job
               JOIN workhorse.job_outcome outcome ON outcome.job_id = job.id
              WHERE policy.job_identity_retention_days IS NOT NULL
                AND policy.terminal_outcome_retention_days IS NOT NULL
                AND job.created_at < clock_timestamp()
                  - make_interval(days => policy.job_identity_retention_days)
                AND outcome.finished_at < clock_timestamp()
                  - make_interval(days => policy.terminal_outcome_retention_days)
              ORDER BY job.created_at, job.id LIMIT 1)
              AS eligible_job_identity_at,
            (SELECT outcome.finished_at
               FROM workhorse.job job
               JOIN workhorse.job_outcome outcome ON outcome.job_id = job.id
              WHERE policy.job_identity_retention_days IS NOT NULL
                AND policy.terminal_outcome_retention_days IS NOT NULL
                AND job.created_at < clock_timestamp()
                  - make_interval(days => policy.job_identity_retention_days)
                AND outcome.finished_at < clock_timestamp()
                  - make_interval(days => policy.terminal_outcome_retention_days)
              ORDER BY outcome.finished_at, outcome.job_id LIMIT 1)
              AS eligible_terminal_outcome_at,
            (SELECT occurred_at FROM workhorse.job_event ORDER BY occurred_at, event_id LIMIT 1)
              AS oldest_job_event_at,
            (SELECT occurred_at FROM workhorse.job_event
              WHERE tableoid <> 'workhorse.job_event_default'::regclass
              ORDER BY occurred_at, event_id LIMIT 1) AS oldest_partitioned_job_event_at,
            (SELECT occurred_at FROM workhorse.job_event_default
              ORDER BY occurred_at, event_id LIMIT 1) AS oldest_default_job_event_at,
            (SELECT occurred_at FROM workhorse.attempt_history ORDER BY occurred_at, attempt_id LIMIT 1)
              AS oldest_attempt_history_at,
            (SELECT occurred_at FROM workhorse.attempt_history
              WHERE tableoid <> 'workhorse.attempt_history_default'::regclass
              ORDER BY occurred_at, attempt_id LIMIT 1) AS oldest_partitioned_attempt_history_at,
            (SELECT occurred_at FROM workhorse.attempt_history_default
              ORDER BY occurred_at, attempt_id LIMIT 1) AS oldest_default_attempt_history_at,
            (SELECT occurrence_at FROM workhorse.schedule_occurrence ORDER BY occurrence_at LIMIT 1)
              AS oldest_schedule_occurrence_at
          FROM policy
        ), partitions AS (
          SELECT parent.relname AS parent_name,
                 ((regexp_match(
                   pg_get_expr(child.relpartbound, child.oid),
                   'TO \\(''([^'']+)''\\)'
                 ))[1])::timestamptz AS upper_bound
            FROM pg_inherits inheritance
            JOIN pg_class parent ON parent.oid = inheritance.inhparent
            JOIN pg_namespace namespace ON namespace.oid = parent.relnamespace
            JOIN pg_class child ON child.oid = inheritance.inhrelid
           WHERE namespace.nspname = 'workhorse'
             AND parent.relname IN ('job_event', 'attempt_history')
             AND child.relname <> parent.relname || '_default'
        ), eligible AS (
          SELECT
            count(*) FILTER (
              WHERE parent_name = 'job_event'
                AND policy.job_event_retention_days IS NOT NULL
                AND upper_bound <= clock_timestamp()
                  - make_interval(days => policy.job_event_retention_days)
                AND upper_bound <= date_trunc('week', clock_timestamp())
            )::text AS eligible_event_partitions,
            count(*) FILTER (
              WHERE parent_name = 'attempt_history'
                AND policy.attempt_history_retention_days IS NOT NULL
                AND upper_bound <= clock_timestamp()
                  - make_interval(days => policy.attempt_history_retention_days)
                AND upper_bound <= date_trunc('week', clock_timestamp())
            )::text AS eligible_attempt_partitions
          FROM partitions CROSS JOIN policy
        ), default_rows AS (
          SELECT event_rows::text AS default_event_rows,
                 attempt_rows::text AS default_attempt_rows,
                 event_rows > 10000 AS default_event_rows_capped,
                 attempt_rows > 10000 AS default_attempt_rows_capped
            FROM (
              SELECT
                (SELECT count(*) FROM (
                  SELECT 1 FROM workhorse.job_event_default LIMIT 10001
                ) sampled_events) AS event_rows,
                (SELECT count(*) FROM (
                  SELECT 1 FROM workhorse.attempt_history_default LIMIT 10001
                ) sampled_attempts) AS attempt_rows
            ) sampled
        )
        SELECT policy.*, boundaries.*,
               CASE WHEN policy.job_identity_retention_days IS NULL
                           OR boundaries.eligible_job_identity_at IS NULL THEN NULL
                    ELSE GREATEST(0, extract(epoch FROM
                      clock_timestamp() - make_interval(days => policy.job_identity_retention_days)
                      - boundaries.eligible_job_identity_at) * 1000) END AS job_identity_lag_ms,
               CASE WHEN policy.terminal_outcome_retention_days IS NULL
                           OR boundaries.eligible_terminal_outcome_at IS NULL THEN NULL
                    ELSE GREATEST(0, extract(epoch FROM
                      clock_timestamp() - make_interval(days => policy.terminal_outcome_retention_days)
                      - boundaries.eligible_terminal_outcome_at) * 1000) END AS terminal_outcome_lag_ms,
               CASE WHEN policy.job_event_retention_days IS NULL
                           OR boundaries.oldest_job_event_at IS NULL THEN NULL
                    ELSE GREATEST(
                      0,
                      COALESCE(extract(epoch FROM
                        date_trunc('week', clock_timestamp()
                          - make_interval(days => policy.job_event_retention_days))
                        - boundaries.oldest_partitioned_job_event_at) * 1000, 0),
                      COALESCE(extract(epoch FROM
                        clock_timestamp() - make_interval(days => policy.job_event_retention_days)
                        - boundaries.oldest_default_job_event_at) * 1000, 0)
                    ) END AS job_event_lag_ms,
               CASE WHEN policy.attempt_history_retention_days IS NULL
                           OR boundaries.oldest_attempt_history_at IS NULL THEN NULL
                    ELSE GREATEST(
                      0,
                      COALESCE(extract(epoch FROM
                        date_trunc('week', clock_timestamp()
                          - make_interval(days => policy.attempt_history_retention_days))
                        - boundaries.oldest_partitioned_attempt_history_at) * 1000, 0),
                      COALESCE(extract(epoch FROM
                        clock_timestamp()
                        - make_interval(days => policy.attempt_history_retention_days)
                        - boundaries.oldest_default_attempt_history_at) * 1000, 0)
                    ) END AS attempt_history_lag_ms,
               CASE WHEN policy.schedule_occurrence_retention_days IS NULL
                           OR boundaries.oldest_schedule_occurrence_at IS NULL THEN NULL
                    ELSE GREATEST(0, extract(epoch FROM
                      clock_timestamp()
                      - make_interval(days => policy.schedule_occurrence_retention_days)
                      - boundaries.oldest_schedule_occurrence_at) * 1000) END
                 AS schedule_occurrence_lag_ms,
               eligible.*, default_rows.*
          FROM policy CROSS JOIN boundaries CROSS JOIN eligible CROSS JOIN default_rows`),
      ]);

    const stateCounts: QueueHealth["counts"] = {
      scheduled: 0,
      ready: 0,
      active: 0,
      succeeded: 0,
      failed: 0,
    };
    for (const row of counts.rows) stateCounts[row.state] = Number(row.count);
    const depth = depths.rows[0]!;
    const retentionRow = retention.rows[0]!;
    return {
      schemaVersion: version.rows[0]?.version ?? null,
      counts: stateCounts,
      readyDepth: Number(depth.ready),
      scheduledDepth: Number(depth.scheduled),
      sleepingJobs: Number(depth.sleeping),
      overdueWaits: Number(depth.overdue_waits),
      nextWakeAt: depth.next_wake_at,
      activeLeases: Number(depth.active),
      expiredLeases: Number(depth.expired),
      oldestReadyAgeMs:
        depth.oldest_ready_age_ms === null ? null : Number(depth.oldest_ready_age_ms),
      retentionPolicy: retentionPolicy(retentionRow),
      retentionLagMs: {
        jobIdentity:
          retentionRow.job_identity_lag_ms === null
            ? null
            : Number(retentionRow.job_identity_lag_ms),
        terminalOutcome:
          retentionRow.terminal_outcome_lag_ms === null
            ? null
            : Number(retentionRow.terminal_outcome_lag_ms),
        jobEvents:
          retentionRow.job_event_lag_ms === null ? null : Number(retentionRow.job_event_lag_ms),
        attemptHistory:
          retentionRow.attempt_history_lag_ms === null
            ? null
            : Number(retentionRow.attempt_history_lag_ms),
        scheduleOccurrences:
          retentionRow.schedule_occurrence_lag_ms === null
            ? null
            : Number(retentionRow.schedule_occurrence_lag_ms),
      },
      oldestRetainedAt: {
        jobIdentity: retentionRow.oldest_job_identity_at,
        terminalOutcome: retentionRow.oldest_terminal_outcome_at,
        jobEvents: retentionRow.oldest_job_event_at,
        attemptHistory: retentionRow.oldest_attempt_history_at,
        scheduleOccurrences: retentionRow.oldest_schedule_occurrence_at,
      },
      eligibleHistoryPartitions: {
        jobEvents: Number(retentionRow.eligible_event_partitions),
        attemptHistory: Number(retentionRow.eligible_attempt_partitions),
      },
      defaultHistoryRows: {
        jobEvents: Number(retentionRow.default_event_rows),
        attemptHistory: Number(retentionRow.default_attempt_rows),
      },
      defaultHistoryRowsCapped: {
        jobEvents: retentionRow.default_event_rows_capped,
        attemptHistory: retentionRow.default_attempt_rows_capped,
      },
      relations: relations.rows.map((row) => ({
        relation: row.relation,
        totalBytes: Number(row.total_bytes),
        tableBytes: Number(row.table_bytes),
        indexBytes: Number(row.index_bytes),
        liveTuples: Number(row.live_tuples),
        deadTuples: Number(row.dead_tuples),
        modificationsSinceAnalyze: Number(row.modifications_since_analyze),
        hotUpdateRatio: row.hot_update_ratio === null ? null : Number(row.hot_update_ratio),
        lastVacuum: row.last_vacuum,
        lastAutovacuum: row.last_autovacuum,
      })),
      oldestTransactionAgeMs:
        activity.rows[0]?.age_ms === null ? null : Number(activity.rows[0]?.age_ms ?? 0),
      lockWaitCount: Number(activity.rows[0]?.lock_wait_count ?? 0),
      notificationQueueUsage: Number(notification.rows[0]?.usage ?? 0),
    };
  }
}
