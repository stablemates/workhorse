import { SQL_STATEMENTS } from "./sql-catalogue.generated.js";
import { expectOneRow, WorkhorseError } from "../errors.js";
import { logInfo } from "../telemetry.js";
import { MAX_EXTERNAL_WAITS_PER_JOB, type ClaimedJob, type Json } from "../types.js";
import {
  encodeExternalWaitValue,
  externalWaitCursor,
  externalWaitRecord,
  type ExternalWaitDeliveryRequest,
  type ExternalWaitCursor,
  type ExternalWaitQuery,
  type ExternalWaitOptions,
  type ExternalWaitRecord,
  type ExternalWaitRow,
  validateExternalWaitDeliveryRequest,
  validateExternalWaitListOptions,
  validateExternalWaitName,
  validateExternalWaitOptions,
} from "./external-waits.js";
import { QueueModule } from "./module-context.js";

export type WaitForHumanStatus = "waiting" | "completed";
export interface WaitForHumanResult<TResult extends Json = Json> {
  status: WaitForHumanStatus;
  payload: TResult | null;
}
export type CompleteHumanWaitRequest = ExternalWaitDeliveryRequest;
export type HumanWaitCompletionStatus =
  | "completed"
  | "duplicate"
  | "not_waiting"
  | "already_completed"
  | "stale"
  | "not_found";
export interface HumanWaitCompletionResult<TResult extends Json = Json> {
  status: HumanWaitCompletionStatus;
  jobId: string;
  name: string;
  payload: TResult | null;
  completedAt: Date | null;
  completedBy: string | null;
}

/** @deprecated Renamed to {@link HumanWaitCompletionStatus}. Removed in 1.0.0. */
export type CompleteHumanWaitStatus = HumanWaitCompletionStatus;

/** @deprecated Renamed to {@link HumanWaitCompletionResult}. Removed in 1.0.0. */
export type CompleteHumanWaitResult<TResult extends Json = Json> =
  HumanWaitCompletionResult<TResult>;

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
  status: WaitForHumanStatus | "already_waiting" | "stale" | "limit_exceeded" | "conflict";
  result: Json | null;
};
type CompleteRow = {
  status: HumanWaitCompletionStatus | "conflict";
  result: Json | null;
  completed_at: Date | string | null;
  completed_by: string | null;
};

export class HumanWaitLeaseLostError extends WorkhorseError {
  constructor(
    readonly jobId: string,
    readonly waitName: string,
  ) {
    super(
      `Human wait ${waitName} for job ${jobId} cannot be recorded because the lease is stale or expired`,
    );
    this.name = "HumanWaitLeaseLostError";
  }
}
export class HumanWaitAlreadyWaitingError extends WorkhorseError {
  constructor(
    readonly jobId: string,
    readonly waitName: string,
  ) {
    super(`Human wait ${waitName} for job ${jobId} is already waiting for completion`);
    this.name = "HumanWaitAlreadyWaitingError";
  }
}
export class HumanWaitLimitExceededError extends WorkhorseError {
  constructor(readonly jobId: string) {
    super(`Job ${jobId} already has the maximum of ${MAX_EXTERNAL_WAITS_PER_JOB} human waits`);
    this.name = "HumanWaitLimitExceededError";
  }
}
export class HumanWaitConflictError extends WorkhorseError {
  constructor(
    readonly jobId: string,
    readonly waitName: string,
  ) {
    super(`Human wait ${waitName} for job ${jobId} was replayed with different context`);
    this.name = "HumanWaitConflictError";
  }
}
export class HumanWaitIdempotencyConflictError extends WorkhorseError {
  constructor(
    readonly jobId: string,
    readonly waitName: string,
  ) {
    super(
      `Human wait ${waitName} for job ${jobId} received a different completion for a retained idempotency key`,
    );
    this.name = "HumanWaitIdempotencyConflictError";
  }
}

/** Owns named human decisions that suspend a handler until an attributed completion. */
export class HumanWaitsModule extends QueueModule {
  async listHumanWaits<TContext extends Json = Json>(
    options: ExternalWaitQuery = {},
  ): Promise<HumanWaitPage<TContext>> {
    const { limit, cursor } = validateExternalWaitListOptions(options);
    const result = await this.context.database.query<HumanWaitRow>(
      SQL_STATEMENTS["dashboard_human_wait_v1"],
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
    job: ClaimedJob,
    workerId: string,
    name: string,
    context: TContext,
    options: ExternalWaitOptions = {},
  ): Promise<WaitForHumanResult<TResult>> {
    validateExternalWaitName(name, "Human wait");
    if (typeof workerId !== "string" || workerId.length === 0) {
      throw new TypeError("Worker ID must be a non-empty string");
    }
    const query = await this.context.database.query<WaitRow>(SQL_STATEMENTS["wait_for_human_v1"], [
      job.id,
      workerId,
      job.fenceToken.toString(),
      name,
      encodeExternalWaitValue(context, "Human wait context"),
      validateExternalWaitOptions(options),
    ]);
    const row = expectOneRow(query, "workhorse.wait_for_human_v1");
    if (row.status === "already_waiting") throw new HumanWaitAlreadyWaitingError(job.id, name);
    if (row.status === "stale") throw new HumanWaitLeaseLostError(job.id, name);
    if (row.status === "limit_exceeded") throw new HumanWaitLimitExceededError(job.id);
    if (row.status === "conflict") throw new HumanWaitConflictError(job.id, name);
    if (row.status !== "waiting" && row.status !== "completed") {
      throw new Error(`Unexpected human wait status: ${String(row.status)}`);
    }
    return { status: row.status, payload: row.result as TResult | null };
  }

  async completeHumanWait<TResult extends Json>(
    jobId: string,
    name: string,
    result: TResult,
    request: CompleteHumanWaitRequest,
  ): Promise<HumanWaitCompletionResult<TResult>> {
    validateExternalWaitName(name, "Human wait");
    validateExternalWaitDeliveryRequest(request, "Human wait");
    const query = await this.context.database.query<CompleteRow>(
      SQL_STATEMENTS["complete_human_wait_v1"],
      [
        jobId,
        name,
        encodeExternalWaitValue(result, "Human wait result"),
        request.idempotencyKey,
        request.requestedBy,
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
      payload: row.result as TResult | null,
      completedAt: row.completed_at === null ? null : new Date(row.completed_at),
      completedBy: row.completed_by,
    };
  }
}
