import { WorkhorseError } from "../errors.js";
import { logInfo } from "../telemetry.js";
import type {
  ChildJob,
  ChildJobOptions,
  ClaimedJob,
  CreateChildResult,
  EnqueueOptions,
  Json,
} from "../types.js";
import { expectOneRow } from "../errors.js";
import { QueueModule, type QueueModuleContext } from "./module-context.js";
import type { EnqueueContractsModule } from "./enqueue-contracts.js";
import { validateJobPriority } from "./enqueue-contracts.js";

interface CreateChildRow {
  status: string;
  child_job_id: string | null;
  child_type: string | null;
  created_at: Date | string | null;
  joined_at: Date | string | null;
  result: Json | null;
}

export class ChildLeaseLostError extends WorkhorseError {
  constructor(readonly parentJobId: string) {
    super(`Cannot create a child for job ${parentJobId} because the lease is stale or expired`);
    this.name = "ChildLeaseLostError";
  }
}

export class ChildConflictError extends WorkhorseError {
  constructor(
    readonly parentJobId: string,
    readonly childName: string,
  ) {
    super(`Child ${childName} for job ${parentJobId} already exists with a different request`);
    this.name = "ChildConflictError";
  }
}

export class ChildLimitExceededError extends WorkhorseError {
  constructor(readonly parentJobId: string) {
    super(`Job ${parentJobId} already has its one supported child`);
    this.name = "ChildLimitExceededError";
  }
}

function childRecord<TResult extends Json>(
  parentJobId: string,
  name: string,
  row: CreateChildRow,
): ChildJob<TResult> {
  if (!row.child_job_id || !row.child_type || !row.created_at) {
    throw new Error("Child operation returned an incomplete row");
  }
  return {
    parentJobId,
    childJobId: row.child_job_id,
    name,
    type: row.child_type,
    createdAt: new Date(row.created_at),
    joinedAt: row.joined_at === null ? null : new Date(row.joined_at),
    result: row.result as TResult | null,
  };
}

/** Owns fenced child creation and single-result joining behind the Queue facade. */
export class ChildJobsModule extends QueueModule {
  constructor(
    context: QueueModuleContext,
    private readonly enqueueContracts: EnqueueContractsModule,
  ) {
    super(context);
  }

  async createChild<TPayload extends Json, TResult extends Json = Json>(
    parent: ClaimedJob<unknown>,
    workerId: string,
    name: string,
    type: string,
    payload: TPayload,
    options: ChildJobOptions = {},
  ): Promise<CreateChildResult<TResult>> {
    if (typeof name !== "string" || name.length < 1 || [...name].length > 200) {
      throw new TypeError("Child name must contain 1 to 200 characters");
    }
    if (typeof workerId !== "string" || workerId.length === 0) {
      throw new TypeError("Worker ID must be a non-empty string");
    }
    const unsafe = options as EnqueueOptions;
    if (
      unsafe.idempotency !== undefined ||
      unsafe.debounce !== undefined ||
      unsafe.throttle !== undefined ||
      unsafe.prerequisiteJobId !== undefined ||
      unsafe.dependencies !== undefined
    ) {
      throw new TypeError("Child jobs cannot use coalescing or dependency enqueue options");
    }

    const acceptance = this.enqueueContracts.jobAcceptance(type, payload);
    const traceContext = parent.traceContext;
    const request = {
      queue: options.queue ?? this.context.defaultQueue,
      type,
      payload,
      priority: validateJobPriority(options.priority),
      ...acceptance,
      ...(traceContext === null ? {} : { traceContext }),
      ...(options.runAt === undefined ? {} : { runAt: options.runAt.toISOString() }),
      deadline: options.deadline?.toISOString() ?? null,
      concurrencyKey: options.concurrencyKey ?? null,
      executionTimeoutMs: options.executionTimeoutMs ?? null,
      maxAttempts: options.maxAttempts ?? 25,
      retryPolicy: options.retryPolicy ?? null,
      prerequisiteJobId: null,
      dependencies: null,
      tags: options.tags ?? [],
    };
    const result = await this.context.database.query<CreateChildRow>(
      `SELECT status, child_job_id, child_type, created_at, joined_at, result
         FROM workhorse.create_child_v1($1::uuid, $2::text, $3::bigint, $4::text, $5::jsonb)`,
      [parent.id, workerId, parent.fenceToken.toString(), name, JSON.stringify(request)],
    );
    const row = expectOneRow(result, "workhorse.create_child_v1");
    if (row.status === "stale") throw new ChildLeaseLostError(parent.id);
    if (row.status === "conflict") throw new ChildConflictError(parent.id, name);
    if (row.status === "limit_exceeded") throw new ChildLimitExceededError(parent.id);
    if (row.status !== "created" && row.status !== "completed") {
      throw new Error(`Unexpected child status: ${row.status}`);
    }
    logInfo("workhorse.job.child_processed", "Child job processed", {
      "workhorse.job.id": parent.id,
      "workhorse.child.name": name,
      "workhorse.child.status": row.status,
      "workhorse.worker.id": workerId,
    });
    return { status: row.status, child: childRecord<TResult>(parent.id, name, row) };
  }
}
