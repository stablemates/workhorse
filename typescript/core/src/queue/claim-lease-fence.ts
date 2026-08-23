import type { Span } from "@opentelemetry/api";
import { expectOneRow } from "../errors.js";
import {
  jobMetricAttributes,
  jobSpanAttributes,
  logDebug,
  logInfo,
  recordCancellation,
  recordHeartbeatFailure,
  telemetryMetrics,
  withSpan,
} from "../telemetry.js";
import type {
  CancellationRequest,
  CancelResult,
  BatchExecutionRecord,
  ClaimedJob,
  ExpireOwnedStatus,
  HeartbeatStatus,
  Json,
  RetryPolicy,
  TraceContext,
} from "../types.js";
import { QueueModule } from "./module-context.js";
import { nullableRowTimestamp, rowTimestamp } from "./row-mapping.js";

type ClaimRow = {
  job_id: string;
  job_type: string;
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

  static from(job: ClaimedJob, workerId: string): FencedLease {
    return new FencedLease([job.id, workerId, job.fenceToken.toString()]);
  }
}

const REDACTED_ERROR_MESSAGE = "Job handler failed; details redacted";
const REDACTED_ERROR_NAME = "RedactedJobError";

export function errorForTelemetry(error: unknown, redactDetails: boolean): Error | string {
  if (!redactDetails) return error instanceof Error ? error : String(error);
  const redacted = new Error(REDACTED_ERROR_MESSAGE);
  redacted.name = REDACTED_ERROR_NAME;
  return redacted;
}

function errorEnvelope(error: unknown, redactDetails = false): Json {
  // Persist a bounded JSON representation instead of relying on Error's non-enumerable fields.
  if (redactDetails) return { name: REDACTED_ERROR_NAME, message: REDACTED_ERROR_MESSAGE };
  if (error instanceof Error) {
    return { name: error.name, message: error.message, stack: error.stack ?? null };
  }
  return { name: "NonErrorThrown", message: String(error) };
}

export function recordRecoveryTelemetry(span: Span, recovery: RecoveryTelemetry): void {
  span.setAttributes({
    "workhorse.recovery.rows_affected": recovery.rows_affected,
    "workhorse.recovery.expired_leases": recovery.expired_leases,
    "workhorse.recovery.retried": recovery.retried,
  });
  telemetryMetrics.expiredLeases.add(recovery.expired_leases);
  const retriesByJob = new Map<string, { count: number; queue: string; type: string }>();
  for (const dimension of recovery.retry_dimensions ?? []) {
    const key = `${dimension.queue}\u0000${dimension.type}`;
    const existing = retriesByJob.get(key);
    if (existing === undefined) {
      retriesByJob.set(key, { count: 1, ...dimension });
    } else {
      existing.count += 1;
    }
  }
  let attributedRetries = 0;
  for (const retry of retriesByJob.values()) {
    attributedRetries += retry.count;
    telemetryMetrics.retried.add(retry.count, {
      "workhorse.queue.name": retry.queue,
      "workhorse.job.type": retry.type,
    });
  }
  if (attributedRetries < recovery.retried) {
    telemetryMetrics.retried.add(recovery.retried - attributedRetries, {
      "workhorse.queue.name": "unknown",
      "workhorse.job.type": "unknown",
    });
  }
}

/** Owns cancellation, claiming, fenced settlement, heartbeat, and lease recovery. */
export class ClaimLeaseFenceModule extends QueueModule {
  async cancel(jobId: string, request: CancellationRequest = {}): Promise<CancelResult> {
    // PostgreSQL validates metadata and serializes cancellation with every lifecycle transition.
    // requestedBy is caller attribution only; this API does not claim authorization.
    const result = await this.context.database.query<CancelRow>(
      `SELECT status, state, current_attempt, requested_at, requested_by, reason, finished_at
         FROM workhorse.cancel_v1($1::uuid, $2::text, $3::text)`,
      [jobId, request.requestedBy ?? null, request.reason ?? null],
    );
    const row = expectOneRow(result, "workhorse.cancel_v1");
    recordCancellation(row.status);
    logInfo("workhorse.job.cancellation_processed", "Job cancellation processed", {
      "workhorse.job.id": jobId,
      "workhorse.job.state": row.state ?? "not_found",
      "workhorse.operation.status": row.status,
    });
    return {
      status: row.status,
      jobId,
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
  ): Promise<ClaimedJob<TPayload> | null> {
    const queueName = options.queue ?? this.context.defaultQueue;
    const startedAt = performance.now();
    return withSpan("workhorse.claim", { "workhorse.queue.name": queueName }, async (span) => {
      // claim_v1 commits ownership before returning the payload. Handler code must run only after
      // this query resolves so no row lock or claim transaction spans user code.
      const result = await this.context.database.query<ClaimRow>(
        "SELECT * FROM workhorse.claim_v1($1::text, $2::text, $3::integer)",
        [queueName, workerId, options.leaseMs ?? 30_000],
      );
      const row = result.rows[0];
      telemetryMetrics.claimDuration.record(performance.now() - startedAt, {
        "workhorse.queue.name": queueName,
        "workhorse.claim.result": row === undefined ? "empty" : "claimed",
      });
      if (!row) return null;
      span.setAttributes({
        "workhorse.job.id": row.job_id,
        "workhorse.job.type": row.job_type,
        "workhorse.job.attempt": row.attempt,
      });
      telemetryMetrics.claimed.add(1, {
        "workhorse.queue.name": queueName,
        "workhorse.job.type": row.job_type,
      });
      logDebug("workhorse.job.claimed", "Job claimed", {
        "workhorse.job.id": row.job_id,
        "workhorse.job.type": row.job_type,
        "workhorse.job.attempt": row.attempt,
        "workhorse.queue.name": queueName,
        "workhorse.worker.id": workerId,
      });
      return {
        id: row.job_id,
        queue: queueName,
        type: row.job_type,
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
    });
  }

  private batchEventParameters(batch: BatchExecutionRecord): readonly unknown[] {
    return [
      batch.batchId,
      batch.jobs.map((job) => job.id),
      batch.jobs.map((job) => job.attempt),
      batch.jobs.map((job) => job.fenceToken.toString()),
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
      "SELECT workhorse.record_batch_dispatch_v1($1::uuid, $2::uuid[], $3::integer[], $4::bigint[], $5::text) AS recorded",
      this.batchEventParameters(batch),
    );
    this.assertBatchRecorded(result, "record_batch_dispatch_v1", batch.jobs.length);
  }

  async recordBatchFailure(batch: BatchExecutionRecord): Promise<void> {
    const result = await this.context.database.query<{ recorded: number }>(
      "SELECT workhorse.record_batch_failure_v1($1::uuid, $2::uuid[], $3::integer[], $4::bigint[], $5::text) AS recorded",
      this.batchEventParameters(batch),
    );
    this.assertBatchRecorded(result, "record_batch_failure_v1", batch.jobs.length);
  }

  async heartbeat(job: ClaimedJob, workerId: string, leaseMs = 30_000): Promise<boolean> {
    return (await this.heartbeatStatus(job, workerId, leaseMs)) === "accepted";
  }

  async heartbeatStatus(
    job: ClaimedJob,
    workerId: string,
    leaseMs = 30_000,
  ): Promise<HeartbeatStatus> {
    return withSpan("workhorse.heartbeat", jobSpanAttributes(job), async (span) => {
      const lease = FencedLease.from(job, workerId);
      // Cancellation and stale ownership both stop compatibility callers, while workers can use the
      // status API to deliver a distinct cooperative cancellation signal.
      const result = await this.context.database.query<{ status: HeartbeatStatus }>(
        "SELECT workhorse.heartbeat_v1($1::uuid, $2::text, $3::bigint, $4::integer) AS status",
        [...lease.sqlParameters, leaseMs],
      );
      const status = expectOneRow(result, "workhorse.heartbeat_v1").status;
      span.setAttribute("workhorse.heartbeat.status", status);
      if (status !== "accepted") {
        recordHeartbeatFailure(status);
        logInfo("workhorse.job.heartbeat_rejected", "Job heartbeat rejected", {
          ...jobSpanAttributes(job),
          "workhorse.heartbeat.status": status,
          "workhorse.worker.id": workerId,
        });
      } else {
        logDebug("workhorse.job.heartbeat_accepted", "Job heartbeat accepted", {
          ...jobSpanAttributes(job),
          "workhorse.worker.id": workerId,
        });
      }
      return status;
    });
  }

  async expireOwned(job: ClaimedJob, workerId: string): Promise<ExpireOwnedStatus> {
    const lease = FencedLease.from(job, workerId);
    const result = await this.context.database.query<{
      status: ExpireOwnedStatus;
      retry_state: "ready" | "scheduled" | null;
    }>(
      "SELECT * FROM workhorse.expire_owned_telemetry_v1($1::uuid, $2::text, $3::bigint)",
      lease.sqlParameters,
    );
    const expiration = expectOneRow(result, "workhorse.expire_owned_telemetry_v1");
    if (expiration.retry_state !== null) {
      await withSpan("workhorse.retry", jobSpanAttributes(job), async (span) => {
        span.setAttribute("workhorse.retry.outcome", expiration.retry_state!);
        telemetryMetrics.retried.add(1, jobMetricAttributes(job));
      });
    }
    logInfo("workhorse.job.ownership_expired", "Owned job lease expired", {
      ...jobSpanAttributes(job),
      "workhorse.expiration.status": expiration.status,
      "workhorse.worker.id": workerId,
    });
    return expiration.status;
  }

  async acknowledgeCancel(job: ClaimedJob, workerId: string): Promise<boolean> {
    const lease = FencedLease.from(job, workerId);
    const result = await this.context.database.query<{ accepted: boolean }>(
      "SELECT workhorse.acknowledge_cancel_v1($1::uuid, $2::text, $3::bigint) AS accepted",
      lease.sqlParameters,
    );
    const accepted = expectOneRow(result, "workhorse.acknowledge_cancel_v1").accepted;
    logInfo("workhorse.job.cancellation_acknowledged", "Job cancellation acknowledged", {
      ...jobSpanAttributes(job),
      "workhorse.cancel.accepted": accepted,
      "workhorse.worker.id": workerId,
    });
    return accepted;
  }

  async complete<TResult extends Json>(
    job: ClaimedJob,
    workerId: string,
    result: TResult,
    validateResult: () => Promise<void>,
  ): Promise<boolean> {
    return withSpan("workhorse.complete", jobSpanAttributes(job), async (span) => {
      await validateResult();
      const lease = FencedLease.from(job, workerId);
      // Completion is conditional on the exact unexpired lease and fence. A stale worker gets false
      // rather than overwriting the result of a recovered attempt.
      const query = await this.context.database.query<{ accepted: boolean }>(
        "SELECT workhorse.complete_v1($1::uuid, $2::text, $3::bigint, $4::jsonb) AS accepted",
        [...lease.sqlParameters, JSON.stringify(result)],
      );
      const accepted = expectOneRow(query, "workhorse.complete_v1").accepted;
      span.setAttribute("workhorse.complete.accepted", accepted);
      if (accepted) telemetryMetrics.completed.add(1, jobMetricAttributes(job));
      logInfo(
        accepted ? "workhorse.job.completed" : "workhorse.job.completion_rejected",
        accepted ? "Job completed" : "Stale job completion rejected",
        {
          ...jobSpanAttributes(job),
          "workhorse.complete.accepted": accepted,
          "workhorse.worker.id": workerId,
        },
      );
      return accepted;
    });
  }

  async fail(
    job: ClaimedJob,
    workerId: string,
    error: unknown,
    retryDelayMs?: number,
  ): Promise<FailureStatus> {
    return withSpan("workhorse.retry", jobSpanAttributes(job), async (span) => {
      const lease = FencedLease.from(job, workerId);
      // PostgreSQL decides whether retry budget remains and atomically closes the old attempt before
      // creating the next projection. Undefined selects SQL-owned backoff; a number explicitly
      // overrides it, including zero for an immediate retry.
      const result = await this.context.database.query<{ state: FailureStatus }>(
        "SELECT workhorse.fail_v1($1::uuid, $2::text, $3::bigint, $4::jsonb, $5::integer) AS state",
        [
          ...lease.sqlParameters,
          JSON.stringify(errorEnvelope(error, job.redactErrorDetails)),
          retryDelayMs ?? null,
        ],
      );
      const state = expectOneRow(result, "workhorse.fail_v1").state;
      span.setAttribute("workhorse.retry.outcome", state);
      telemetryMetrics.failed.add(1, {
        ...jobMetricAttributes(job),
        "workhorse.attempt.outcome": state,
      });
      if (state === "ready" || state === "scheduled") {
        telemetryMetrics.retried.add(1, jobMetricAttributes(job));
      }
      logInfo("workhorse.job.failure_processed", "Job attempt failure processed", {
        ...jobSpanAttributes(job),
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
        "SELECT * FROM workhorse.recover_expired_telemetry_v1($1::integer, $2::integer)",
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
