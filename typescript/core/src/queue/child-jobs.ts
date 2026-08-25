import { SQL_STATEMENTS } from "./sql-catalogue.generated.js";
import { WorkhorseError } from "../errors.js";
import { logInfo } from "../telemetry.js";
import type {
  ChildJob,
  ChildJobOptions,
  ChildJobRequest,
  ChildOutcomes,
  ClaimedJob,
  CreateChildResult,
  CreateChildrenResult,
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

interface CreateChildrenRow {
  status: string;
  children: Array<{
    childJobId: string;
    name: string;
    type: string;
    createdAt: string;
    joinedAt: string | null;
    result?: Json;
    outcome?: Json;
  }> | null;
  results: Record<string, Json> | null;
  result_bytes: number | null;
  result_limit_bytes: number | null;
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
    super(`Job ${parentJobId} exceeds the supported child limit`);
    this.name = "ChildLimitExceededError";
  }
}

export class ChildResultLimitExceededError extends WorkhorseError {
  constructor(
    readonly parentJobId: string,
    readonly resultBytes: number,
    readonly resultLimitBytes: number,
  ) {
    super(`Joined child results for job ${parentJobId} exceed its configured size limit`);
    this.name = "ChildResultLimitExceededError";
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

function validateChildName(name: string): void {
  if (typeof name !== "string" || name.length < 1 || [...name].length > 200) {
    throw new TypeError("Child name must contain 1 to 200 characters");
  }
}

/** Owns fenced child creation and result joining behind the Queue facade. */
export class ChildJobsModule extends QueueModule {
  constructor(
    context: QueueModuleContext,
    private readonly enqueueContracts: EnqueueContractsModule,
  ) {
    super(context);
  }

  private async childRequest<TPayload extends Json>(
    parent: ClaimedJob,
    type: string,
    payload: TPayload,
    options: ChildJobOptions,
  ): Promise<Record<string, unknown>> {
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
    const acceptance = await this.enqueueContracts.jobAcceptance(type, payload);
    return {
      queue: options.queue ?? this.context.defaultQueue,
      type,
      payload,
      priority: validateJobPriority(options.priority),
      ...acceptance,
      ...(parent.traceContext === null ? {} : { traceContext: parent.traceContext }),
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
  }

  async createChild<TPayload extends Json, TResult extends Json = Json>(
    parent: ClaimedJob,
    workerId: string,
    name: string,
    type: string,
    payload: TPayload,
    options: ChildJobOptions = {},
  ): Promise<CreateChildResult<TResult>> {
    validateChildName(name);
    if (typeof workerId !== "string" || workerId.length === 0) {
      throw new TypeError("Worker ID must be a non-empty string");
    }
    const request = await this.childRequest(parent, type, payload, options);
    const result = await this.context.database.query<CreateChildRow>(
      SQL_STATEMENTS["create_child_v1"],
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

  async createChildren<TResult extends Record<string, Json> = Record<string, Json>>(
    parent: ClaimedJob,
    workerId: string,
    children: readonly ChildJobRequest[],
  ): Promise<CreateChildrenResult<ChildOutcomes<TResult>>> {
    return this.createChildrenWithMode<ChildOutcomes<TResult>>(
      parent,
      workerId,
      children,
      "settled",
    );
  }

  async createChildrenAll<TResult extends Record<string, Json> = Record<string, Json>>(
    parent: ClaimedJob,
    workerId: string,
    children: readonly ChildJobRequest[],
  ): Promise<CreateChildrenResult<TResult>> {
    return this.createChildrenWithMode<TResult>(parent, workerId, children, "all_success");
  }

  private async createChildrenWithMode<TResult extends Record<string, Json>>(
    parent: ClaimedJob,
    workerId: string,
    children: readonly ChildJobRequest[],
    mode: "settled" | "all_success",
  ): Promise<CreateChildrenResult<TResult>> {
    if (!Array.isArray(children)) throw new TypeError("Children must be an array");
    if (typeof workerId !== "string" || workerId.length === 0) {
      throw new TypeError("Worker ID must be a non-empty string");
    }
    if (children.length > 100) throw new ChildLimitExceededError(parent.id);
    const names = new Set<string>();
    const requests = await Promise.all(
      children.map(async ({ name, type, payload, options = {} }) => {
        validateChildName(name);
        if (names.has(name)) throw new TypeError("Child names must be unique");
        names.add(name);
        return {
          name,
          request: await this.childRequest(parent, type, payload, options),
        };
      }),
    );
    const result = await this.context.database.query<CreateChildrenRow>(
      SQL_STATEMENTS["create_children_v1"],
      [parent.id, workerId, parent.fenceToken.toString(), JSON.stringify(requests), mode],
    );
    const row = expectOneRow(result, "workhorse.create_children_v1");
    if (row.status === "stale") throw new ChildLeaseLostError(parent.id);
    if (row.status === "conflict") throw new ChildConflictError(parent.id, "child set");
    if (row.status === "limit_exceeded") throw new ChildLimitExceededError(parent.id);
    if (row.status === "result_too_large") {
      throw new ChildResultLimitExceededError(
        parent.id,
        row.result_bytes ?? 0,
        row.result_limit_bytes ?? 0,
      );
    }
    if ((row.status !== "created" && row.status !== "completed") || row.children === null) {
      throw new Error(`Unexpected child-set status: ${row.status}`);
    }
    const mapped = row.children.map((child) => ({
      parentJobId: parent.id,
      childJobId: child.childJobId,
      name: child.name,
      type: child.type,
      createdAt: new Date(child.createdAt),
      joinedAt: child.joinedAt === null ? null : new Date(child.joinedAt),
      result: child.result ?? null,
    }));
    logInfo("workhorse.job.child_processed", "Child set processed", {
      "workhorse.job.id": parent.id,
      "workhorse.child.count": mapped.length,
      "workhorse.child.status": row.status,
      "workhorse.worker.id": workerId,
    });
    const joinedResults = Object.fromEntries(
      row.children.map((child) => [child.name, mode === "settled" ? child.outcome : child.result]),
    ) as TResult;
    return row.status === "created"
      ? { status: "created", children: mapped }
      : { status: "completed", children: mapped, results: joinedResults };
  }
}
