import { expectOneRow, WorkhorseError } from "../errors.js";
import { logInfo } from "../telemetry.js";
import { MAX_EXTERNAL_WAITS_PER_JOB, type ClaimedJob, type Json } from "../types.js";
import {
  encodeExternalWaitValue,
  externalWaitCursor,
  externalWaitRecord,
  type ExternalWaitDeliveryRequest,
  type ExternalWaitCursor,
  type ExternalWaitListOptions,
  type ExternalWaitOptions,
  type ExternalWaitRecord,
  type ExternalWaitRow,
  validateExternalWaitDeliveryRequest,
  validateExternalWaitListOptions,
  validateExternalWaitName,
  validateExternalWaitOptions,
} from "./external-waits.js";
import { QueueModule } from "./module-context.js";

export type WaitForSignalStatus = "waiting" | "delivered";

export interface WaitForSignalResult<TPayload extends Json = Json> {
  status: WaitForSignalStatus;
  payload: TPayload | null;
}

export type SendSignalRequest = ExternalWaitDeliveryRequest;

export type SendSignalStatus =
  | "delivered"
  | "duplicate"
  | "not_waiting"
  | "already_delivered"
  | "stale"
  | "not_found";

export interface SendSignalResult<TPayload extends Json = Json> {
  status: SendSignalStatus;
  jobId: string;
  name: string;
  payload: TPayload | null;
  deliveredAt: Date | null;
  deliveredBy: string | null;
}

export type SignalWait = ExternalWaitRecord;

export interface SignalWaitPage {
  items: SignalWait[];
  nextCursor: ExternalWaitCursor | null;
}

type WaitForSignalRow = {
  status: WaitForSignalStatus | "already_waiting" | "stale" | "limit_exceeded";
  payload: Json | null;
};

type SendSignalRow = {
  status: SendSignalStatus | "conflict";
  payload: Json | null;
  delivered_at: Date | string | null;
  delivered_by: string | null;
};

export class SignalWaitLeaseLostError extends WorkhorseError {
  constructor(
    readonly jobId: string,
    readonly waitName: string,
  ) {
    super(
      `Signal wait ${waitName} for job ${jobId} cannot be recorded because the lease is stale or expired`,
    );
    this.name = "SignalWaitLeaseLostError";
  }
}

export class SignalWaitConflictError extends WorkhorseError {
  constructor(
    readonly jobId: string,
    readonly waitName: string,
  ) {
    super(`Signal wait ${waitName} for job ${jobId} is already waiting for delivery`);
    this.name = "SignalWaitConflictError";
  }
}

export class SignalWaitLimitExceededError extends WorkhorseError {
  constructor(readonly jobId: string) {
    super(`Job ${jobId} already has the maximum of ${MAX_EXTERNAL_WAITS_PER_JOB} signal waits`);
    this.name = "SignalWaitLimitExceededError";
  }
}

export class SignalIdempotencyConflictError extends WorkhorseError {
  constructor(
    readonly jobId: string,
    readonly waitName: string,
  ) {
    super(
      `Signal ${waitName} for job ${jobId} received a different request for a retained idempotency key`,
    );
    this.name = "SignalIdempotencyConflictError";
  }
}

/** Owns durable named signal waits and idempotent external delivery. */
export class SignalsModule extends QueueModule {
  async listSignalWaits(options: ExternalWaitListOptions = {}): Promise<SignalWaitPage> {
    const { limit, cursor } = validateExternalWaitListOptions(options);
    const result = await this.context.database.query<ExternalWaitRow>(
      `SELECT job_id, queue_name, job_type, signal_name AS wait_name, attempt,
              created_at, deadline_at, created_at::text AS cursor_created_at
         FROM workhorse.dashboard_signal_wait_v1
        WHERE ($2::timestamptz IS NULL OR (created_at, job_id, signal_name) >
              ($2::timestamptz, $3::uuid, $4::text))
        ORDER BY created_at, job_id, signal_name
        LIMIT $1::integer`,
      [limit + 1, cursor?.createdAt ?? null, cursor?.jobId ?? null, cursor?.name ?? null],
    );
    const pageRows = result.rows.slice(0, limit);
    return {
      items: pageRows.map(externalWaitRecord),
      nextCursor:
        result.rows.length > limit ? externalWaitCursor(pageRows[pageRows.length - 1]!) : null,
    };
  }

  async waitForSignal<TPayload extends Json = Json>(
    job: ClaimedJob<unknown>,
    workerId: string,
    name: string,
    options: ExternalWaitOptions = {},
  ): Promise<WaitForSignalResult<TPayload>> {
    validateExternalWaitName(name, "Signal");
    if (typeof workerId !== "string" || workerId.length === 0) {
      throw new TypeError("Worker ID must be a non-empty string");
    }
    const result = await this.context.database.query<WaitForSignalRow>(
      `SELECT status, payload
         FROM workhorse.wait_for_signal_v1($1::uuid, $2::text, $3::bigint, $4::text, $5::bigint)`,
      [job.id, workerId, job.fenceToken.toString(), name, validateExternalWaitOptions(options)],
    );
    const row = expectOneRow(result, "workhorse.wait_for_signal_v1");
    if (row.status === "already_waiting") throw new SignalWaitConflictError(job.id, name);
    if (row.status === "stale") throw new SignalWaitLeaseLostError(job.id, name);
    if (row.status === "limit_exceeded") throw new SignalWaitLimitExceededError(job.id);
    if (row.status !== "waiting" && row.status !== "delivered") {
      throw new Error(`Unexpected signal wait status: ${String(row.status)}`);
    }
    return { status: row.status, payload: row.payload as TPayload | null };
  }

  async sendSignal<TPayload extends Json>(
    jobId: string,
    name: string,
    payload: TPayload,
    request: SendSignalRequest,
  ): Promise<SendSignalResult<TPayload>> {
    validateExternalWaitName(name, "Signal");
    validateExternalWaitDeliveryRequest(request, "Signal");
    const encodedPayload = encodeExternalWaitValue(payload, "Signal payload");
    const result = await this.context.database.query<SendSignalRow>(
      `SELECT status, payload, delivered_at, delivered_by
         FROM workhorse.send_signal_v1($1::uuid, $2::text, $3::jsonb, $4::text, $5::text)`,
      [jobId, name, encodedPayload, request.idempotencyKey, request.requestedBy],
    );
    const row = expectOneRow(result, "workhorse.send_signal_v1");
    if (row.status === "conflict") throw new SignalIdempotencyConflictError(jobId, name);
    logInfo("workhorse.job.signal_processed", "Job signal processed", {
      "workhorse.job.id": jobId,
      "workhorse.signal.name": name,
      "workhorse.signal.status": row.status,
    });
    return {
      status: row.status,
      jobId,
      name,
      payload: row.payload as TPayload | null,
      deliveredAt: row.delivered_at === null ? null : new Date(row.delivered_at),
      deliveredBy: row.delivered_by,
    };
  }
}
