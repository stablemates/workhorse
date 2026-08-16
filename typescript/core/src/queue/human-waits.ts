import { expectOneRow, WorkhorseError } from "../errors.js";
import { logInfo } from "../telemetry.js";
import type { ClaimedJob, Json } from "../types.js";
import {
  externalWaitCursor,
  externalWaitRecord,
  type ExternalWaitCursor,
  type ExternalWaitListOptions,
  type ExternalWaitOptions,
  type ExternalWaitRecord,
  type ExternalWaitRow,
  validateExternalWaitListOptions,
  validateExternalWaitOptions,
} from "./external-waits.js";
import { QueueModule } from "./module-context.js";

const MAX_NAME_CHARACTERS = 200;
const MAX_VALUE_BYTES = 65_536;
const MAX_KEY_BYTES = 512;
const MAX_ACTOR_CHARACTERS = 200;

export type WaitForHumanStatus = "waiting" | "completed";
export interface WaitForHumanResult<TResult extends Json = Json> {
  status: WaitForHumanStatus;
  result: TResult | null;
}
export interface CompleteHumanWaitRequest {
  idempotencyKey: string;
  completedBy: string;
}
export type CompleteHumanWaitStatus =
  | "completed"
  | "duplicate"
  | "not_waiting"
  | "already_completed"
  | "stale"
  | "not_found";
export interface CompleteHumanWaitResult<TResult extends Json = Json> {
  status: CompleteHumanWaitStatus;
  jobId: string;
  name: string;
  result: TResult | null;
  completedAt: Date | null;
  completedBy: string | null;
}

export interface HumanWait<TContext extends Json = Json> extends ExternalWaitRecord {
  context: TContext;
}

export interface HumanWaitPage<TContext extends Json = Json> {
  items: HumanWait<TContext>[];
  nextCursor: ExternalWaitCursor | null;
}

type HumanWaitRow = ExternalWaitRow & {
  context: Json;
};

type WaitRow = {
  status: WaitForHumanStatus | "stale" | "limit_exceeded" | "conflict";
  result: Json | null;
};
type CompleteRow = {
  status: CompleteHumanWaitStatus | "conflict";
  result: Json | null;
  completed_at: Date | string | null;
  completed_by: string | null;
};

function validateName(name: string): void {
  if (typeof name !== "string") throw new TypeError("Human wait name must be a string");
  if (name.length < 1 || name.length > MAX_NAME_CHARACTERS) {
    throw new RangeError("Human wait name must contain between 1 and 200 characters");
  }
  if (name.trim() !== name) {
    throw new RangeError("Human wait name must not have leading or trailing whitespace");
  }
}

function encodeValue(value: Json, label: string): string {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new TypeError(`${label} must be JSON serializable`);
  if (Buffer.byteLength(encoded) > MAX_VALUE_BYTES) {
    throw new RangeError(`${label} must be at most 65536 bytes`);
  }
  return encoded;
}

function validateRequest(request: CompleteHumanWaitRequest): void {
  if (typeof request.idempotencyKey !== "string") {
    throw new TypeError("Human wait idempotency key must be a string");
  }
  const keyBytes = Buffer.byteLength(request.idempotencyKey);
  if (keyBytes < 1 || keyBytes > MAX_KEY_BYTES) {
    throw new RangeError("Human wait idempotency key must contain between 1 and 512 UTF-8 bytes");
  }
  if (
    typeof request.completedBy !== "string" ||
    request.completedBy.length < 1 ||
    request.completedBy.length > MAX_ACTOR_CHARACTERS
  ) {
    throw new RangeError("Human wait completedBy must contain between 1 and 200 characters");
  }
}

export class HumanWaitLeaseLostError extends WorkhorseError {
  constructor(
    readonly jobId: string,
    readonly tokenName: string,
  ) {
    super(
      `Human wait ${tokenName} for job ${jobId} cannot be recorded because the lease is stale or expired`,
    );
    this.name = "HumanWaitLeaseLostError";
  }
}
export class HumanWaitLimitExceededError extends WorkhorseError {
  constructor(readonly jobId: string) {
    super(`Job ${jobId} already has the maximum of 1000 human waits`);
    this.name = "HumanWaitLimitExceededError";
  }
}
export class HumanWaitConflictError extends WorkhorseError {
  constructor(
    readonly jobId: string,
    readonly tokenName: string,
  ) {
    super(`Human wait ${tokenName} for job ${jobId} was replayed with different context`);
    this.name = "HumanWaitConflictError";
  }
}
export class HumanWaitIdempotencyConflictError extends WorkhorseError {
  constructor(
    readonly jobId: string,
    readonly tokenName: string,
  ) {
    super(
      `Human wait ${tokenName} for job ${jobId} received a different completion for a retained idempotency key`,
    );
    this.name = "HumanWaitIdempotencyConflictError";
  }
}

/** Owns named human decisions that suspend a handler until an attributed completion. */
export class HumanWaitsModule extends QueueModule {
  async listHumanWaits<TContext extends Json = Json>(
    options: ExternalWaitListOptions = {},
  ): Promise<HumanWaitPage<TContext>> {
    const { limit, cursor } = validateExternalWaitListOptions(options);
    const result = await this.context.database.query<HumanWaitRow>(
      `SELECT job_id, queue_name, job_type, token_name AS wait_name, context, attempt,
              created_at, deadline_at, created_at::text AS cursor_created_at
         FROM workhorse.dashboard_human_wait_v1
        WHERE ($2::timestamptz IS NULL OR (created_at, job_id, token_name) >
              ($2::timestamptz, $3::uuid, $4::text))
        ORDER BY created_at, job_id, token_name
        LIMIT $1::integer`,
      [limit + 1, cursor?.createdAt ?? null, cursor?.jobId ?? null, cursor?.name ?? null],
    );
    const pageRows = result.rows.slice(0, limit);
    return {
      items: pageRows.map((row) => ({
        ...externalWaitRecord(row),
        context: row.context as TContext,
      })),
      nextCursor:
        result.rows.length > limit ? externalWaitCursor(pageRows[pageRows.length - 1]!) : null,
    };
  }

  async waitForHuman<TContext extends Json, TResult extends Json = Json>(
    job: ClaimedJob<unknown>,
    workerId: string,
    name: string,
    context: TContext,
    options: ExternalWaitOptions = {},
  ): Promise<WaitForHumanResult<TResult>> {
    validateName(name);
    if (typeof workerId !== "string" || workerId.length === 0) {
      throw new TypeError("Worker ID must be a non-empty string");
    }
    const query = await this.context.database.query<WaitRow>(
      `SELECT status, result
         FROM workhorse.wait_for_human_v1($1::uuid, $2::text, $3::bigint, $4::text, $5::jsonb, $6::bigint)`,
      [
        job.id,
        workerId,
        job.fenceToken.toString(),
        name,
        encodeValue(context, "Human wait context"),
        validateExternalWaitOptions(options),
      ],
    );
    const row = expectOneRow(query, "workhorse.wait_for_human_v1");
    if (row.status === "stale") throw new HumanWaitLeaseLostError(job.id, name);
    if (row.status === "limit_exceeded") throw new HumanWaitLimitExceededError(job.id);
    if (row.status === "conflict") throw new HumanWaitConflictError(job.id, name);
    if (row.status !== "waiting" && row.status !== "completed") {
      throw new Error(`Unexpected human wait status: ${String(row.status)}`);
    }
    return { status: row.status, result: row.result as TResult | null };
  }

  async completeHumanWait<TResult extends Json>(
    jobId: string,
    name: string,
    result: TResult,
    request: CompleteHumanWaitRequest,
  ): Promise<CompleteHumanWaitResult<TResult>> {
    validateName(name);
    validateRequest(request);
    const query = await this.context.database.query<CompleteRow>(
      `SELECT status, result, completed_at, completed_by
         FROM workhorse.complete_human_wait_v1($1::uuid, $2::text, $3::jsonb, $4::text, $5::text)`,
      [
        jobId,
        name,
        encodeValue(result, "Human wait result"),
        request.idempotencyKey,
        request.completedBy,
      ],
    );
    const row = expectOneRow(query, "workhorse.complete_human_wait_v1");
    if (row.status === "conflict") throw new HumanWaitIdempotencyConflictError(jobId, name);
    logInfo("workhorse.job.human_wait_processed", "Human wait completion processed", {
      "workhorse.job.id": jobId,
      "workhorse.human_wait.name": name,
      "workhorse.human_wait.status": row.status,
    });
    return {
      status: row.status,
      jobId,
      name,
      result: row.result as TResult | null,
      completedAt: row.completed_at === null ? null : new Date(row.completed_at),
      completedBy: row.completed_by,
    };
  }
}
