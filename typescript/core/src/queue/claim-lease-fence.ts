import { SQL_STATEMENTS } from "./sql-catalogue.generated.js";
import { expectOneRow, FastTierUnsupportedError, fastTierRejection } from "../errors.js";
import {
  taskMetricAttributes,
  taskSpanAttributes,
  logDebug,
  logInfo,
  recordCancellation,
  recordHeartbeatFailure,
  telemetryMetrics,
  type WorkhorseTelemetrySpan,
  withSpan,
} from "../telemetry.js";
import type {
  CancellationRequest,
  CancelResult,
  BatchExecutionRecord,
  ClaimedTask,
  CompletionClaim,
  CompletionClaimResult,
  ExpireOwnedStatus,
  HeartbeatStatus,
  Json,
  ReleaseOwnedStatus,
  RetryPolicy,
  TraceContext,
} from "../types.js";
import { QueueModule } from "./module-context.js";
import { nullableRowTimestamp, rowTimestamp } from "./row-mapping.js";

type ClaimRow = {
  task_id: string;
  task_type: string;
  priority: number;
  payload: Json;
  contract_version: string | null;
  result_max_bytes: number;
  redact_error_details: boolean;
  trace_context: TraceContext | null;
  attempt: number;
  max_attempts: number;
  retry_policy: RetryPolicy | null;
  deadline_at: Date | string | null;
  execution_timeout_ms: string | null;
  attempt_timeout_at: Date | string | null;
  fence_token: string;
  lease_expires_at: Date | string;
};

// The first row carries the accepted ids. A call that claims nothing returns one row whose claim
// columns are all null.
type CompletionClaimRow = Omit<ClaimRow, "task_id"> & {
  accepted: string[] | null;
  task_id: string | null;
};

/** One completion waiting for the next fused `complete_many_and_claim_v1` round trip. */
interface PendingCompletion {
  task: ClaimedTask;
  serializedResult: string;
  limit: number;
  resolve(result: CompletionClaimResult): void;
  reject(error: unknown): void;
}

interface PendingCompletionBatch {
  workerId: string;
  queue: string;
  leaseMs: number;
  entries: PendingCompletion[];
}

/** complete_many_and_claim_v1 takes at most this many completions and claims per call. */
const COMPLETION_BATCH_LIMIT = 100;

type CancelRow = {
  status: CancelResult["status"];
  state: CancelResult["state"];
  current_attempt: number | null;
  requested_at: Date | null;
  requested_by: string | null;
  reason: string | null;
  finished_at: Date | null;
};

export interface RecoveryTelemetry {
  rows_affected: number;
  expired_leases: number;
  retried: number;
  retry_dimensions: Array<{ queue: string; type: string }>;
}

export type FailureStatus =
  | "ready"
  | "scheduled"
  | "failed"
  | "cancel_requested"
  | "deadline_exceeded"
  | "timeout_exceeded"
  | "stale";

/** The three values PostgreSQL requires to authorize an owned lifecycle transition. */
class FencedLease {
  private constructor(readonly sqlParameters: readonly [string, string, string]) {}

  static from(task: ClaimedTask, workerId: string): FencedLease {
    return new FencedLease([task.id, workerId, task.fenceToken.toString()]);
  }
}

const REDACTED_ERROR_MESSAGE = "Task handler failed; details redacted";
const REDACTED_ERROR_NAME = "RedactedTaskError";
/** The name recorded when a handler throws a value that is not an Error. */
const NON_ERROR_NAME = "NonErrorThrown";

export function errorForTelemetry(error: unknown, redactDetails: boolean): Error | string {
  if (!redactDetails) return error instanceof Error ? error : String(error);
  const redacted = new Error(REDACTED_ERROR_MESSAGE);
  redacted.name = REDACTED_ERROR_NAME;
  return redacted;
}

export function errorEnvelope(error: unknown, redactDetails = false): Json {
  // Persist a bounded JSON representation instead of relying on Error's non-enumerable fields.
  // A redacted envelope carries the two fields `redact_error_details_v1` writes, so redacting here
  // produces exactly what PostgreSQL would have produced. Every other envelope carries all three
  // fields, with a null stack when the thrown value supplies none.
  if (redactDetails) return { name: REDACTED_ERROR_NAME, message: REDACTED_ERROR_MESSAGE };
  if (error instanceof Error) {
    return { name: error.name, message: error.message, stack: error.stack ?? null };
  }
  return { name: NON_ERROR_NAME, message: String(error), stack: null };
}

export function recordRecoveryTelemetry(
  span: WorkhorseTelemetrySpan,
  recovery: RecoveryTelemetry,
): void {
  span.setAttributes({
    "workhorse.recovery.rows_affected": recovery.rows_affected,
    "workhorse.recovery.expired_leases": recovery.expired_leases,
    "workhorse.recovery.retried": recovery.retried,
  });
  telemetryMetrics.expiredLeases.add(recovery.expired_leases);
  const retriesByTask = new Map<string, { count: number; queue: string; type: string }>();
  for (const dimension of recovery.retry_dimensions ?? []) {
    const key = `${dimension.queue}\u0000${dimension.type}`;
    const existing = retriesByTask.get(key);
    if (existing === undefined) {
      retriesByTask.set(key, { count: 1, ...dimension });
    } else {
      existing.count += 1;
    }
  }
  let attributedRetries = 0;
  for (const retry of retriesByTask.values()) {
    attributedRetries += retry.count;
    telemetryMetrics.retried.add(retry.count, {
      "workhorse.queue.name": retry.queue,
      "workhorse.task.type": retry.type,
    });
  }
  if (attributedRetries < recovery.retried) {
    telemetryMetrics.retried.add(recovery.retried - attributedRetries, {
      "workhorse.queue.name": "unknown",
      "workhorse.task.type": "unknown",
    });
  }
}

/** Owns cancellation, claiming, fenced settlement, heartbeat, and lease recovery. */
export class ClaimLeaseFenceModule extends QueueModule {
  private claimedTask<TPayload extends Json>(
    row: ClaimRow,
    queueName: string,
  ): ClaimedTask<TPayload> {
    return {
      id: row.task_id,
      queue: queueName,
      type: row.task_type,
      priority: row.priority,
      payload: row.payload as TPayload,
      contractVersion: row.contract_version,
      resultMaxBytes: row.result_max_bytes,
      redactErrorDetails: row.redact_error_details === true,
      traceContext: row.trace_context,
      attempt: row.attempt,
      maxAttempts: row.max_attempts,
      retryPolicy: row.retry_policy,
      deadlineAt: nullableRowTimestamp(row.deadline_at, "deadline_at"),
      executionTimeoutMs:
        row.execution_timeout_ms === null ? null : Number(row.execution_timeout_ms),
      attemptTimeoutAt: nullableRowTimestamp(row.attempt_timeout_at, "attempt_timeout_at"),
      fenceToken: BigInt(row.fence_token),
      leaseExpiresAt: rowTimestamp(row.lease_expires_at, "lease_expires_at"),
    };
  }

  private recordClaims(
    span: WorkhorseTelemetrySpan,
    tasks: ClaimedTask[],
    queueName: string,
    workerId: string,
    startedAt: number,
  ): void {
    telemetryMetrics.claimDuration.record(performance.now() - startedAt, {
      "workhorse.queue.name": queueName,
      "workhorse.claim.result": tasks.length === 0 ? "empty" : "claimed",
    });
    if (tasks[0]) span.setAttributes(taskSpanAttributes(tasks[0]));
    for (const task of tasks) {
      telemetryMetrics.claimed.add(1, taskMetricAttributes(task));
      logDebug("workhorse.task.claimed", "Task claimed", {
        ...taskSpanAttributes(task),
        "workhorse.queue.name": queueName,
        "workhorse.worker.id": workerId,
      });
    }
  }

  async cancel(taskId: string, request: CancellationRequest = {}): Promise<CancelResult> {
    // PostgreSQL validates metadata and serializes cancellation with every lifecycle transition.
    // requestedBy is caller attribution only; this API does not claim authorization.
    const result = await this.context.database.query<CancelRow>(SQL_STATEMENTS["cancel_v1"], [
      taskId,
      request.requestedBy ?? null,
      request.reason ?? null,
    ]);
    const row = expectOneRow(result, "workhorse.cancel_v1");
    recordCancellation(row.status);
    logInfo("workhorse.task.cancellation_processed", "Task cancellation processed", {
      "workhorse.task.id": taskId,
      "workhorse.task.state": row.state ?? "not_found",
      "workhorse.operation.status": row.status,
    });
    return {
      status: row.status,
      taskId,
      state: row.state,
      currentAttempt: row.current_attempt,
      requestedAt: row.requested_at,
      requestedBy: row.requested_by,
      reason: row.reason,
      finishedAt: row.finished_at,
    };
  }

  async claim<TPayload extends Json = Json>(
    workerId: string,
    options: { queue?: string; leaseMs?: number } = {},
  ): Promise<ClaimedTask<TPayload> | null> {
    const queueName = options.queue ?? this.context.defaultQueue;
    const startedAt = performance.now();
    return withSpan("workhorse.claim", { "workhorse.queue.name": queueName }, async (span) => {
      // claim_v1 commits ownership before returning the payload. Handler code must run only after
      // this query resolves so no row lock or claim transaction spans user code.
      const result = await this.context.database.query<ClaimRow>(SQL_STATEMENTS["claim_v1"], [
        queueName,
        workerId,
        options.leaseMs ?? 30_000,
      ]);
      const row = result.rows[0];
      const task = row ? this.claimedTask<TPayload>(row, queueName) : null;
      this.recordClaims(span, task ? [task] : [], queueName, workerId, startedAt);
      return task;
    });
  }

  async claimMany<TPayload extends Json = Json>(
    workerId: string,
    limit: number,
    options: { queue?: string; leaseMs?: number } = {},
  ): Promise<ClaimedTask<TPayload>[]> {
    const queueName = options.queue ?? this.context.defaultQueue;
    const startedAt = performance.now();
    return withSpan("workhorse.claim", { "workhorse.queue.name": queueName }, async (span) => {
      const result = await this.context.database.query<ClaimRow>(SQL_STATEMENTS["claim_many_v1"], [
        queueName,
        workerId,
        limit,
        options.leaseMs ?? 30_000,
      ]);
      const tasks = result.rows.map((row) => this.claimedTask<TPayload>(row, queueName));
      this.recordClaims(span, tasks, queueName, workerId, startedAt);
      return tasks;
    });
  }

  private batchEventParameters(batch: BatchExecutionRecord): readonly unknown[] {
    return [
      batch.batchId,
      batch.tasks.map((task) => task.id),
      batch.tasks.map((task) => task.attempt),
      batch.tasks.map((task) => task.fenceToken.toString()),
      batch.workerId,
    ];
  }

  private assertBatchRecorded(
    result: { rows: Array<{ recorded: number }> },
    sqlFunction: string,
    expected: number,
  ): void {
    const recorded = Number(expectOneRow(result, `workhorse.${sqlFunction}`).recorded);
    if (recorded !== expected) {
      throw new Error(`${sqlFunction} recorded ${recorded} of ${expected} members`);
    }
  }

  async recordBatchDispatch(batch: BatchExecutionRecord): Promise<void> {
    const result = await this.context.database.query<{ recorded: number }>(
      SQL_STATEMENTS["record_batch_dispatch_v1"],
      this.batchEventParameters(batch),
    );
    this.assertBatchRecorded(result, "record_batch_dispatch_v1", batch.tasks.length);
  }

  async recordBatchFailure(batch: BatchExecutionRecord): Promise<void> {
    const result = await this.context.database.query<{ recorded: number }>(
      SQL_STATEMENTS["record_batch_failure_v1"],
      this.batchEventParameters(batch),
    );
    this.assertBatchRecorded(result, "record_batch_failure_v1", batch.tasks.length);
  }

  async heartbeat(task: ClaimedTask, workerId: string, leaseMs = 30_000): Promise<boolean> {
    return (await this.heartbeatStatus(task, workerId, leaseMs)) === "accepted";
  }

  async heartbeatStatus(
    task: ClaimedTask,
    workerId: string,
    leaseMs = 30_000,
  ): Promise<HeartbeatStatus> {
    return withSpan("workhorse.heartbeat", taskSpanAttributes(task), async (span) => {
      const lease = FencedLease.from(task, workerId);
      // Cancellation and stale ownership both stop compatibility callers, while workers can use the
      // status API to deliver a distinct cooperative cancellation signal.
      const result = await this.context.database.query<{ status: HeartbeatStatus }>(
        SQL_STATEMENTS["heartbeat_v1"],
        [...lease.sqlParameters, leaseMs],
      );
      const status = expectOneRow(result, "workhorse.heartbeat_v1").status;
      span.setAttribute("workhorse.heartbeat.status", status);
      if (status !== "accepted") {
        recordHeartbeatFailure(status);
        logInfo("workhorse.task.heartbeat_rejected", "Task heartbeat rejected", {
          ...taskSpanAttributes(task),
          "workhorse.heartbeat.status": status,
          "workhorse.worker.id": workerId,
        });
      } else {
        logDebug("workhorse.task.heartbeat_accepted", "Task heartbeat accepted", {
          ...taskSpanAttributes(task),
          "workhorse.worker.id": workerId,
        });
      }
      return status;
    });
  }

  async heartbeatMany(
    tasks: readonly ClaimedTask[],
    workerId: string,
    leaseMs = 30_000,
  ): Promise<Map<string, HeartbeatStatus>> {
    const leases = tasks.map((task) => ({
      taskId: task.id,
      fenceToken: task.fenceToken.toString(),
      leaseMs,
    }));
    const result = await this.context.database.query<{
      task_id: string;
      status: HeartbeatStatus;
    }>(SQL_STATEMENTS["heartbeat_many_v1"], [workerId, JSON.stringify(leases)]);
    const statuses = new Map(result.rows.map((row) => [row.task_id, row.status]));
    for (const task of tasks) {
      const status = statuses.get(task.id) ?? "stale";
      if (status !== "accepted") {
        recordHeartbeatFailure(status);
        logInfo("workhorse.task.heartbeat_rejected", "Task heartbeat rejected", {
          ...taskSpanAttributes(task),
          "workhorse.heartbeat.status": status,
          "workhorse.worker.id": workerId,
        });
      } else {
        logDebug("workhorse.task.heartbeat_accepted", "Task heartbeat accepted", {
          ...taskSpanAttributes(task),
          "workhorse.worker.id": workerId,
        });
      }
    }
    return statuses;
  }

  async expireOwned(task: ClaimedTask, workerId: string): Promise<ExpireOwnedStatus> {
    const lease = FencedLease.from(task, workerId);
    const result = await this.context.database.query<{
      status: ExpireOwnedStatus;
      retry_state: "ready" | "scheduled" | null;
    }>(SQL_STATEMENTS["expire_owned_telemetry_v1"], lease.sqlParameters);
    const expiration = expectOneRow(result, "workhorse.expire_owned_telemetry_v1");
    if (expiration.retry_state !== null) {
      await withSpan("workhorse.retry", taskSpanAttributes(task), async (span) => {
        span.setAttribute("workhorse.retry.outcome", expiration.retry_state!);
        telemetryMetrics.retried.add(1, taskMetricAttributes(task));
      });
    }
    logInfo("workhorse.task.ownership_expired", "Owned task lease expired", {
      ...taskSpanAttributes(task),
      "workhorse.expiration.status": expiration.status,
      "workhorse.worker.id": workerId,
    });
    return expiration.status;
  }

  /**
   * Give an owned task back to its queue without consuming its attempt.
   *
   * A claim carries no task-type filter, so a worker can hold a task it cannot run. Failing that
   * claim would charge the attempt to a worker that never reached the handler, which during a
   * rolling deployment dead-letters every task type the new release introduced.
   */
  async releaseOwned(task: ClaimedTask, workerId: string): Promise<ReleaseOwnedStatus> {
    const lease = FencedLease.from(task, workerId);
    const result = await this.context.database.query<{ status: ReleaseOwnedStatus }>(
      SQL_STATEMENTS["release_owned_v1"],
      lease.sqlParameters,
    );
    const status = expectOneRow(result, "workhorse.release_owned_v1").status;
    logInfo("workhorse.task.release_processed", "Owned task release processed", {
      ...taskSpanAttributes(task),
      "workhorse.release.status": status,
      "workhorse.worker.id": workerId,
    });
    return status;
  }

  async acknowledgeCancel(task: ClaimedTask, workerId: string): Promise<boolean> {
    const lease = FencedLease.from(task, workerId);
    const result = await this.context.database.query<{ accepted: boolean }>(
      SQL_STATEMENTS["acknowledge_cancel_v1"],
      lease.sqlParameters,
    );
    const accepted = expectOneRow(result, "workhorse.acknowledge_cancel_v1").accepted;
    logInfo("workhorse.task.cancellation_acknowledged", "Task cancellation acknowledged", {
      ...taskSpanAttributes(task),
      "workhorse.cancel.accepted": accepted,
      "workhorse.worker.id": workerId,
    });
    return accepted;
  }

  async complete<TResult extends Json>(
    task: ClaimedTask,
    workerId: string,
    _result: TResult,
    validateResult: () => Promise<string>,
  ): Promise<boolean> {
    return withSpan("workhorse.complete", taskSpanAttributes(task), async (span) => {
      const serializedResult = await validateResult();
      const lease = FencedLease.from(task, workerId);
      // Completion is conditional on the exact unexpired lease and fence. A stale worker gets false
      // rather than overwriting the result of a recovered attempt.
      const query = await this.context.database.query<{ accepted: boolean }>(
        SQL_STATEMENTS["complete_v1"],
        [...lease.sqlParameters, serializedResult],
      );
      const accepted = expectOneRow(query, "workhorse.complete_v1").accepted;
      span.setAttribute("workhorse.complete.accepted", accepted);
      this.recordCompletion(task, workerId, accepted);
      return accepted;
    });
  }

  // Completions of one worker that target the same queue and lease share one round trip. They
  // collect until the current turn of the event loop ends, so a batch never delays a completion by
  // more than the work already queued behind it.
  private readonly pendingCompletions = new Map<string, PendingCompletionBatch>();

  /**
   * Completes a fast-tier attempt and claims up to `claim.limit` replacements in the same round
   * trip. Concurrent calls from one worker for one queue are fused into one statement.
   */
  completeAndClaim(
    task: ClaimedTask,
    workerId: string,
    serializedResult: string,
    claim: CompletionClaim,
  ): Promise<CompletionClaimResult> {
    const leaseMs = claim.leaseMs ?? 30_000;
    const limit = Math.max(0, Math.min(COMPLETION_BATCH_LIMIT, Math.floor(claim.limit)));
    const key = JSON.stringify([workerId, claim.queue, leaseMs]);
    let batch = this.pendingCompletions.get(key);
    if (!batch) {
      batch = { workerId, queue: claim.queue, leaseMs, entries: [] };
      this.pendingCompletions.set(key, batch);
      setImmediate(() => {
        this.pendingCompletions.delete(key);
        void this.flushCompletions(batch!);
      });
    }
    const entries = batch.entries;
    return new Promise((resolve, reject) => {
      entries.push({ task, serializedResult, limit, resolve, reject });
    });
  }

  /**
   * Claims from a fast-tier queue through the fused completion statement with no completions. A
   * full-tier queue rejects the call with `FastTierUnsupportedError`, which is how a worker learns
   * the queue's tier.
   */
  async claimFast<TPayload extends Json = Json>(
    workerId: string,
    limit: number,
    options: { queue?: string; leaseMs?: number } = {},
  ): Promise<ClaimedTask<TPayload>[]> {
    const queueName = options.queue ?? this.context.defaultQueue;
    const startedAt = performance.now();
    // A full-tier answer is the probe working, so it ends the span without an error status.
    const outcome = await withSpan(
      "workhorse.claim",
      { "workhorse.queue.name": queueName },
      async (span) => {
        try {
          const { claimed } = await this.completeManyAndClaim(
            workerId,
            queueName,
            options.leaseMs ?? 30_000,
            [],
            limit,
          );
          this.recordClaims(span, claimed, queueName, workerId, startedAt);
          return { claimed: claimed as ClaimedTask<TPayload>[] };
        } catch (error) {
          if (!(error instanceof FastTierUnsupportedError)) throw error;
          span.setAttribute("workhorse.queue.tier", "full");
          return { rejection: error };
        }
      },
    );
    if ("rejection" in outcome) throw outcome.rejection;
    return outcome.claimed;
  }

  // Splits the batch into statements within the per-call limits. Each statement's claimed tasks go
  // to its entries in order, up to each entry's own limit. A failed statement rejects only its own
  // entries, and none of them is known to have completed.
  private async flushCompletions(batch: PendingCompletionBatch): Promise<void> {
    const chunks: PendingCompletion[][] = [];
    let chunk: PendingCompletion[] = [];
    let chunkLimit = 0;
    for (const entry of batch.entries) {
      if (
        chunk.length === COMPLETION_BATCH_LIMIT ||
        chunkLimit + entry.limit > COMPLETION_BATCH_LIMIT
      ) {
        chunks.push(chunk);
        chunk = [];
        chunkLimit = 0;
      }
      chunk.push(entry);
      chunkLimit += entry.limit;
    }
    chunks.push(chunk);
    await Promise.all(chunks.map((entries) => this.flushCompletionChunk(batch, entries)));
  }

  private async flushCompletionChunk(
    batch: PendingCompletionBatch,
    entries: readonly PendingCompletion[],
  ): Promise<void> {
    const startedAt = performance.now();
    const limit = entries.reduce((total, entry) => total + entry.limit, 0);
    let outcome: { accepted: ReadonlySet<string>; claimed: ClaimedTask[] };
    try {
      outcome = await withSpan(
        "workhorse.complete",
        { "workhorse.queue.name": batch.queue, "workhorse.complete.batch_size": entries.length },
        async (span) => {
          const result = await this.completeManyAndClaim(
            batch.workerId,
            batch.queue,
            batch.leaseMs,
            entries,
            limit,
          );
          this.recordClaims(span, result.claimed, batch.queue, batch.workerId, startedAt);
          return result;
        },
      );
    } catch (error) {
      for (const entry of entries) entry.reject(error);
      return;
    }
    let next = 0;
    for (const entry of entries) {
      const accepted = outcome.accepted.has(entry.task.id);
      this.recordCompletion(entry.task, batch.workerId, accepted);
      const claimed = outcome.claimed.slice(next, next + entry.limit);
      next += claimed.length;
      entry.resolve({ accepted, claimed });
    }
  }

  private async completeManyAndClaim(
    workerId: string,
    queueName: string,
    leaseMs: number,
    entries: readonly Pick<PendingCompletion, "task" | "serializedResult">[],
    limit: number,
  ): Promise<{ accepted: ReadonlySet<string>; claimed: ClaimedTask[] }> {
    let result: { rows: CompletionClaimRow[] };
    try {
      result = await this.context.database.query<CompletionClaimRow>(
        SQL_STATEMENTS["complete_many_and_claim_v1"],
        [
          workerId,
          entries.map((entry) => entry.task.id),
          entries.map((entry) => entry.task.fenceToken.toString()),
          entries.map((entry) => entry.serializedResult),
          queueName,
          limit,
          leaseMs,
        ],
      );
    } catch (error) {
      throw fastTierRejection(error) ?? error;
    }
    const first = expectOneRow(result, "workhorse.complete_many_and_claim_v1");
    const claimed: ClaimedTask[] = [];
    for (const row of result.rows) {
      if (row.task_id !== null) claimed.push(this.claimedTask(row as ClaimRow, queueName));
    }
    return { accepted: new Set(first.accepted ?? []), claimed };
  }

  private recordCompletion(task: ClaimedTask, workerId: string, accepted: boolean): void {
    if (accepted) telemetryMetrics.completed.add(1, taskMetricAttributes(task));
    logInfo(
      accepted ? "workhorse.task.completed" : "workhorse.task.completion_rejected",
      accepted ? "Task completed" : "Stale task completion rejected",
      {
        ...taskSpanAttributes(task),
        "workhorse.complete.accepted": accepted,
        "workhorse.worker.id": workerId,
      },
    );
  }

  async fail(
    task: ClaimedTask,
    workerId: string,
    error: unknown,
    retryDelayMs?: number,
  ): Promise<FailureStatus> {
    return withSpan("workhorse.retry", taskSpanAttributes(task), async (span) => {
      const lease = FencedLease.from(task, workerId);
      // PostgreSQL decides whether retry budget remains and atomically closes the old attempt before
      // creating the next projection. Undefined selects SQL-owned backoff; a number explicitly
      // overrides it, including zero for an immediate retry.
      const result = await this.context.database.query<{ state: FailureStatus }>(
        SQL_STATEMENTS["fail_v1"],
        [
          ...lease.sqlParameters,
          JSON.stringify(errorEnvelope(error, task.redactErrorDetails)),
          retryDelayMs ?? null,
        ],
      );
      const state = expectOneRow(result, "workhorse.fail_v1").state;
      span.setAttribute("workhorse.retry.outcome", state);
      telemetryMetrics.failed.add(1, {
        ...taskMetricAttributes(task),
        "workhorse.attempt.outcome": state,
      });
      if (state === "ready" || state === "scheduled") {
        telemetryMetrics.retried.add(1, taskMetricAttributes(task));
      }
      logInfo("workhorse.task.failure_processed", "Task attempt failure processed", {
        ...taskSpanAttributes(task),
        "workhorse.attempt.outcome": state,
        "workhorse.worker.id": workerId,
      });
      return state;
    });
  }

  async recoverExpired(limit = 100, retryDelayMs?: number): Promise<number> {
    return withSpan("workhorse.recovery", {}, async (span) => {
      // Recovery may be called by many workers. SKIP LOCKED inside the function partitions work
      // between callers while fence checks prevent an old lease from recovering a newer attempt.
      const result = await this.context.database.query<RecoveryTelemetry>(
        SQL_STATEMENTS["recover_expired_telemetry_v1"],
        [limit, retryDelayMs ?? null],
      );
      const recovery = expectOneRow(result, "workhorse.recover_expired_telemetry_v1");
      recordRecoveryTelemetry(span, recovery);
      if (recovery.rows_affected > 0) {
        logInfo("workhorse.leases.recovered", "Expired leases recovered", {
          "workhorse.recovery.rows_affected": recovery.rows_affected,
          "workhorse.recovery.expired_leases": recovery.expired_leases,
          "workhorse.recovery.retried": recovery.retried,
        });
      }
      return recovery.rows_affected;
    });
  }
}
