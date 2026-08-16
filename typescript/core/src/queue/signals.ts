import { expectOneRow, WorkhorseError } from "../errors.js";
import { logInfo } from "../telemetry.js";
import type { ClaimedJob, Json } from "../types.js";
import { type ExternalWaitOptions, validateExternalWaitOptions } from "./external-waits.js";
import { QueueModule } from "./module-context.js";

const MAX_SIGNAL_NAME_CHARACTERS = 200;
const MAX_SIGNAL_PAYLOAD_BYTES = 65_536;
const MAX_SIGNAL_IDEMPOTENCY_KEY_BYTES = 512;
const MAX_SIGNAL_ACTOR_CHARACTERS = 200;

export type WaitForSignalStatus = "waiting" | "delivered";

export interface WaitForSignalResult<TPayload extends Json = Json> {
  status: WaitForSignalStatus;
  payload: TPayload | null;
}

export interface SendSignalRequest {
  idempotencyKey: string;
  requestedBy: string;
}

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

type WaitForSignalRow = {
  status: WaitForSignalStatus | "stale" | "limit_exceeded";
  payload: Json | null;
};

type SendSignalRow = {
  status: SendSignalStatus | "conflict";
  payload: Json | null;
  delivered_at: Date | string | null;
  delivered_by: string | null;
};

function validateSignalName(name: string): void {
  if (typeof name !== "string") throw new TypeError("Signal name must be a string");
  if (name.length < 1 || name.length > MAX_SIGNAL_NAME_CHARACTERS) {
    throw new RangeError("Signal name must contain between 1 and 200 characters");
  }
}

function validateSignalPayload(payload: Json): string {
  const encoded = JSON.stringify(payload);
  if (encoded === undefined) throw new TypeError("Signal payload must be JSON serializable");
  if (Buffer.byteLength(encoded) > MAX_SIGNAL_PAYLOAD_BYTES) {
    throw new RangeError("Signal payload must be at most 65536 bytes");
  }
  return encoded;
}

function validateSendRequest(request: SendSignalRequest): void {
  if (typeof request.idempotencyKey !== "string") {
    throw new TypeError("Signal idempotency key must be a string");
  }
  const keyBytes = Buffer.byteLength(request.idempotencyKey);
  if (keyBytes < 1 || keyBytes > MAX_SIGNAL_IDEMPOTENCY_KEY_BYTES) {
    throw new RangeError("Signal idempotency key must contain between 1 and 512 UTF-8 bytes");
  }
  if (
    typeof request.requestedBy !== "string" ||
    request.requestedBy.length < 1 ||
    request.requestedBy.length > MAX_SIGNAL_ACTOR_CHARACTERS
  ) {
    throw new RangeError("Signal requestedBy must contain between 1 and 200 characters");
  }
}

export class SignalWaitLeaseLostError extends WorkhorseError {
  constructor(
    readonly jobId: string,
    readonly signalName: string,
  ) {
    super(
      `Signal wait ${signalName} for job ${jobId} cannot be recorded because the lease is stale or expired`,
    );
    this.name = "SignalWaitLeaseLostError";
  }
}

export class SignalWaitLimitExceededError extends WorkhorseError {
  constructor(readonly jobId: string) {
    super(`Job ${jobId} already has the maximum of 1000 signal waits`);
    this.name = "SignalWaitLimitExceededError";
  }
}

export class SignalIdempotencyConflictError extends WorkhorseError {
  constructor(
    readonly jobId: string,
    readonly signalName: string,
  ) {
    super(
      `Signal ${signalName} for job ${jobId} received a different request for a retained idempotency key`,
    );
    this.name = "SignalIdempotencyConflictError";
  }
}

/** Owns durable named signal waits and idempotent external delivery. */
export class SignalsModule extends QueueModule {
  async waitForSignal<TPayload extends Json = Json>(
    job: ClaimedJob<unknown>,
    workerId: string,
    name: string,
    options: ExternalWaitOptions = {},
  ): Promise<WaitForSignalResult<TPayload>> {
    validateSignalName(name);
    if (typeof workerId !== "string" || workerId.length === 0) {
      throw new TypeError("Worker ID must be a non-empty string");
    }
    const result = await this.context.database.query<WaitForSignalRow>(
      `SELECT status, payload
         FROM workhorse.wait_for_signal_v1($1::uuid, $2::text, $3::bigint, $4::text, $5::bigint)`,
      [job.id, workerId, job.fenceToken.toString(), name, validateExternalWaitOptions(options)],
    );
    const row = expectOneRow(result, "workhorse.wait_for_signal_v1");
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
    validateSignalName(name);
    validateSendRequest(request);
    const encodedPayload = validateSignalPayload(payload);
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
