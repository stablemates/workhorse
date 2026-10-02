import { SQL_STATEMENTS } from "./sql-catalogue.generated.js";
import { queryFencedWrite } from "./fenced-write.js";
import { WorkhorseError } from "../errors.js";
import { logInfo } from "../telemetry.js";
import type {
  ChildTask,
  ChildTaskOptions,
  ChildTaskRequest,
  ChildOutcomes,
  ClaimedTask,
  CreateChildResult,
  CreateChildrenResult,
  EnqueueOptions,
  Json,
} from "../types.js";
import { expectOneRow } from "../errors.js";
import { QueueModule, type QueueModuleContext } from "./module-context.js";
import type { EnqueueContractsModule } from "./enqueue-contracts.js";
import {
  TaskContractValidationError,
  TaskValueSizeLimitError,
  validateTaskPriority,
} from "./enqueue-contracts.js";

// Missing or changed children use the current contract; null preserves an uncontracted child.
type ChildVersions = ReadonlyMap<string, { type: string; version: string | null }>;
type BuildChildRequest = (versions?: ChildVersions) => Promise<string>;

function childVersion(versions: ChildVersions | undefined, name: string, type: string) {
  const stored = versions?.get(name);
  return stored?.type === type ? stored.version : undefined;
}

function contractRejected(error: unknown): boolean {
  return error instanceof TaskContractValidationError || error instanceof TaskValueSizeLimitError;
}

interface CreateChildRow {
  status: string;
  child_task_id: string | null;
  child_type: string | null;
  created_at: Date | string | null;
  joined_at: Date | string | null;
  result: Json | null;
}

interface CreateChildrenRow {
  status: string;
  children: Array<{
    childTaskId: string;
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
  constructor(readonly parentTaskId: string) {
    super(`Cannot create a child for task ${parentTaskId} because the lease is stale or expired`);
    this.name = "ChildLeaseLostError";
  }
}

export class ChildConflictError extends WorkhorseError {
  constructor(
    readonly parentTaskId: string,
    readonly childName: string,
  ) {
    super(`Child ${childName} for task ${parentTaskId} already exists with a different request`);
    this.name = "ChildConflictError";
  }
}

export class ChildLimitExceededError extends WorkhorseError {
  constructor(readonly parentTaskId: string) {
    super(`Task ${parentTaskId} exceeds the supported child limit`);
    this.name = "ChildLimitExceededError";
  }
}

export class ChildResultLimitExceededError extends WorkhorseError {
  constructor(
    readonly parentTaskId: string,
    readonly resultBytes: number,
    readonly resultLimitBytes: number,
  ) {
    super(`Joined child results for task ${parentTaskId} exceed its configured size limit`);
    this.name = "ChildResultLimitExceededError";
  }
}

function childRecord<TResult extends Json>(
  parentTaskId: string,
  name: string,
  row: CreateChildRow,
): ChildTask<TResult> {
  if (!row.child_task_id || !row.child_type || !row.created_at) {
    throw new Error("Child operation returned an incomplete row");
  }
  return {
    parentTaskId,
    childTaskId: row.child_task_id,
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
export class ChildTasksModule extends QueueModule {
  constructor(
    context: QueueModuleContext,
    private readonly enqueueContracts: EnqueueContractsModule,
  ) {
    super(context);
  }

  private async childRequest<TPayload extends Json>(
    parent: ClaimedTask,
    type: string,
    payload: TPayload,
    options: ChildTaskOptions,
    version?: string | null,
  ): Promise<Record<string, unknown>> {
    const unsafe = options as EnqueueOptions;
    if (
      unsafe.idempotency !== undefined ||
      unsafe.debounce !== undefined ||
      unsafe.throttle !== undefined ||
      unsafe.prerequisiteTaskId !== undefined ||
      unsafe.dependencies !== undefined
    ) {
      throw new TypeError("Child tasks cannot use coalescing or dependency enqueue options");
    }
    const acceptance = await this.enqueueContracts.taskAcceptance(type, payload, version);
    return {
      queue: options.queue ?? this.context.defaultQueue,
      type,
      payload,
      priority: validateTaskPriority(options.priority),
      ...acceptance,
      ...(parent.traceContext === null ? {} : { traceContext: parent.traceContext }),
      ...(options.runAt === undefined ? {} : { runAt: options.runAt.toISOString() }),
      deadline: options.deadline?.toISOString() ?? null,
      concurrencyKey: options.concurrencyKey ?? null,
      budget: options.budget ?? null,
      executionTimeoutMs: options.executionTimeoutMs ?? null,
      maxAttempts: options.maxAttempts ?? 25,
      retryPolicy: options.retryPolicy ?? null,
      prerequisiteTaskId: null,
      dependencies: null,
      tags: options.tags ?? [],
    };
  }

  private async acceptedChildVersions(parentTaskId: string): Promise<ChildVersions> {
    const edges = await this.context.database.query<{
      parent_task_id: string;
      child_task_id: string;
      child_name: string;
      child_type: string;
    }>(SQL_STATEMENTS["task_child"], [parentTaskId, 101]);
    const versions = new Map<string, { type: string; version: string | null }>();
    for (const edge of edges.rows) {
      if (edge.parent_task_id.toLowerCase() !== parentTaskId.toLowerCase()) continue;
      const child = await this.context.database.query<{ contract_version: string | null }>(
        SQL_STATEMENTS["get_task"],
        [edge.child_task_id],
      );
      versions.set(edge.child_name, {
        type: edge.child_type,
        version: expectOneRow(child, "get_task").contract_version,
      });
    }
    return versions;
  }

  private async initialChildRequest(
    parentTaskId: string,
    build: BuildChildRequest,
  ): Promise<string> {
    try {
      return await build();
    } catch (error) {
      if (!contractRejected(error)) throw error;
      const versions = await this.acceptedChildVersions(parentTaskId);
      if (versions.size === 0) throw error;
      try {
        return await build(versions);
      } catch (acceptedError) {
        if (contractRejected(acceptedError)) throw error;
        throw acceptedError;
      }
    }
  }

  private async replayedChildRow<TRow extends { status: string }>(
    parentTaskId: string,
    row: TRow,
    request: string,
    build: BuildChildRequest,
    write: (request: string) => Promise<TRow>,
  ): Promise<TRow> {
    if (row.status !== "conflict") return row;
    const versions = await this.acceptedChildVersions(parentTaskId);
    if (versions.size === 0) return row;
    let accepted: string;
    try {
      accepted = await build(versions);
    } catch (error) {
      if (contractRejected(error)) return row;
      throw error;
    }
    // PostgreSQL still compares the entire request. Re-stamping never accepts a changed payload,
    // type, option, or set, and a second conflict is returned without another retry.
    return accepted === request ? row : write(accepted);
  }

  async createChild<TPayload extends Json, TResult extends Json = Json>(
    parent: ClaimedTask,
    workerId: string,
    name: string,
    type: string,
    payload: TPayload,
    options: ChildTaskOptions = {},
  ): Promise<CreateChildResult<TResult>> {
    validateChildName(name);
    if (typeof workerId !== "string" || workerId.length === 0) {
      throw new TypeError("Worker ID must be a non-empty string");
    }
    const build: BuildChildRequest = async (versions) =>
      JSON.stringify(
        await this.childRequest(parent, type, payload, options, childVersion(versions, name, type)),
      );
    const request = await this.initialChildRequest(parent.id, build);
    const write = async (encoded: string): Promise<CreateChildRow> => {
      const result = await queryFencedWrite<CreateChildRow>(
        this.context.database,
        SQL_STATEMENTS["create_child_v1"],
        [parent.id, workerId, parent.fenceToken.toString(), name, encoded],
      );
      return expectOneRow(result, "workhorse.create_child_v1");
    };
    const row = await this.replayedChildRow(parent.id, await write(request), request, build, write);
    if (row.status === "stale") throw new ChildLeaseLostError(parent.id);
    if (row.status === "conflict") throw new ChildConflictError(parent.id, name);
    if (row.status === "limit_exceeded") throw new ChildLimitExceededError(parent.id);
    if (row.status !== "created" && row.status !== "completed") {
      throw new Error(`Unexpected child status: ${row.status}`);
    }
    logInfo("workhorse.task.child_processed", "Child task processed", {
      "workhorse.task.id": parent.id,
      "workhorse.child.name": name,
      "workhorse.child.status": row.status,
      "workhorse.worker.id": workerId,
    });
    return { status: row.status, child: childRecord<TResult>(parent.id, name, row) };
  }

  async createChildren<TResult extends Record<string, Json> = Record<string, Json>>(
    parent: ClaimedTask,
    workerId: string,
    children: readonly ChildTaskRequest[],
  ): Promise<CreateChildrenResult<ChildOutcomes<TResult>>> {
    return this.createChildrenWithMode<ChildOutcomes<TResult>>(
      parent,
      workerId,
      children,
      "settled",
    );
  }

  async createChildrenAll<TResult extends Record<string, Json> = Record<string, Json>>(
    parent: ClaimedTask,
    workerId: string,
    children: readonly ChildTaskRequest[],
  ): Promise<CreateChildrenResult<TResult>> {
    return this.createChildrenWithMode<TResult>(parent, workerId, children, "all_success");
  }

  private async createChildrenWithMode<TResult extends Record<string, Json>>(
    parent: ClaimedTask,
    workerId: string,
    children: readonly ChildTaskRequest[],
    mode: "settled" | "all_success",
  ): Promise<CreateChildrenResult<TResult>> {
    if (!Array.isArray(children)) throw new TypeError("Children must be an array");
    if (typeof workerId !== "string" || workerId.length === 0) {
      throw new TypeError("Worker ID must be a non-empty string");
    }
    if (children.length > 100) throw new ChildLimitExceededError(parent.id);
    const names = new Set<string>();
    for (const { name } of children) {
      validateChildName(name);
      if (names.has(name)) throw new TypeError("Child names must be unique");
      names.add(name);
    }
    const build: BuildChildRequest = async (versions) =>
      JSON.stringify(
        await Promise.all(
          children.map(async ({ name, type, payload, options = {} }) => ({
            name,
            request: await this.childRequest(
              parent,
              type,
              payload,
              options,
              childVersion(versions, name, type),
            ),
          })),
        ),
      );
    const request = await this.initialChildRequest(parent.id, build);
    const write = async (encoded: string): Promise<CreateChildrenRow> => {
      const result = await queryFencedWrite<CreateChildrenRow>(
        this.context.database,
        SQL_STATEMENTS["create_children_v1"],
        [parent.id, workerId, parent.fenceToken.toString(), encoded, mode],
      );
      return expectOneRow(result, "workhorse.create_children_v1");
    };
    const row = await this.replayedChildRow(parent.id, await write(request), request, build, write);
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
      parentTaskId: parent.id,
      childTaskId: child.childTaskId,
      name: child.name,
      type: child.type,
      createdAt: new Date(child.createdAt),
      joinedAt: child.joinedAt === null ? null : new Date(child.joinedAt),
      result: child.result ?? null,
    }));
    logInfo("workhorse.task.child_processed", "Child set processed", {
      "workhorse.task.id": parent.id,
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
