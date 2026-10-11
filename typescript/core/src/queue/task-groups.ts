import { MAX_ENQUEUE_BATCH_SIZE, SQL_STATEMENTS } from "./sql-catalogue.generated.js";
import {
  databaseErrorCode,
  databaseErrorDetails,
  expectOneRow,
  WorkhorseError,
} from "../errors.js";
import type {
  ClaimedTask,
  EnqueueRequest,
  EnqueueResult,
  Json,
  Queryable,
  TaskState,
} from "../types.js";
import type { EnqueueContractsModule, EnqueueRow } from "./enqueue-contracts.js";
import { QueueModule, type QueueModuleContext } from "./module-context.js";
import { nullableRowTimestamp, rowTimestamp } from "./row-mapping.js";

/** The largest number of member tasks one task group holds (ADR 0095). */
export const MAX_TASK_GROUP_MEMBERS = 100_000;
/** The largest number of member tasks one read of a group's members returns. */
export const MAX_TASK_GROUP_PAGE_SIZE = 1_000;
/** The largest number of drifted groups one drift read or repair examines. */
export const MAX_TASK_GROUP_DRIFT_LIMIT = 10_000;

/**
 * `open` accepts tasks. `sealed` accepts tasks only from a running member task. `finished` means
 * every member task is finished and the callbacks are enqueued.
 */
export type TaskGroupState = "open" | "sealed" | "finished";
/** `succeeded` when every member task succeeded, otherwise `failed`. */
export type TaskGroupResult = "succeeded" | "failed";
export type TaskGroupCallbackKind = "onFinish" | "onSuccess" | "onFailure";
/** The outcome a group counted for one member task. */
export type TaskGroupMemberOutcome = "succeeded" | "failed" | "canceled";

/**
 * The callbacks of a task group. Each one is an ordinary enqueue request without enqueue
 * idempotency, debounce, or throttle. A callback can be on any queue, the fast tier included.
 */
export interface TaskGroupCallbacks {
  /** Runs when every member task is finished. */
  onFinish?: EnqueueRequest;
  /** Runs when every member task is finished and every member task succeeded. */
  onSuccess?: EnqueueRequest;
  /** Runs when every member task is finished and one or more member tasks did not succeed. */
  onFailure?: EnqueueRequest;
}

export interface TaskGroupCounts {
  total: number;
  succeeded: number;
  failed: number;
  canceled: number;
  pending: number;
}

/** A requested callback, and the task the finished group enqueued for it. */
export interface TaskGroupCallback {
  kind: TaskGroupCallbackKind;
  /** Null until the group finishes, and null for the callback that the result does not select. */
  taskId: string | null;
}

export interface TaskGroup {
  id: string;
  state: TaskGroupState;
  result: TaskGroupResult | null;
  counts: TaskGroupCounts;
  createdAt: Date;
  sealedAt: Date | null;
  finishedAt: Date | null;
  canceledAt: Date | null;
  canceledBy: string | null;
  cancelReason: string | null;
  callbacks: TaskGroupCallback[];
}

export interface TaskGroupMember {
  /** One-based order in which the member joined its group. */
  position: number;
  taskId: string;
  /** Null after the task is deleted, by a purge or by retention. */
  queue: string | null;
  type: string | null;
  state: TaskState | null;
  /** The outcome the group counted, or null while the member is pending. */
  outcome: TaskGroupMemberOutcome | null;
  addedAt: Date;
  countedAt: Date | null;
}

export interface TaskGroupMemberQuery {
  /** Return members after this position. */
  after?: number;
  limit?: number;
}

export interface TaskGroupMemberPage {
  members: TaskGroupMember[];
  /** The `after` value of the next page, or null on the last page. */
  nextAfter: number | null;
}

/** The group of a running task, as its handler sees it through `ctx.taskGroup`. */
export interface TaskGroupLink {
  /** `member` for a member task, `callback` for a callback task. */
  role: "member" | "callback";
  /** The kind of callback, for a callback task. */
  callback: TaskGroupCallbackKind | null;
  group: TaskGroup;
}

export type TaskGroupEventType =
  | "created"
  | "sealed"
  | "canceled"
  | "finished"
  | "callback_enqueued"
  | "callback_failed"
  | "counter_repaired";

export interface TaskGroupEvent {
  id: string;
  type: TaskGroupEventType;
  details: Json;
  occurredAt: Date;
}

/** Collects the tasks of the block form. Each call holds at most 1,000 requests. */
export interface TaskGroupBuilder {
  add(requests: readonly EnqueueRequest[]): void;
}

export interface TaskGroupBlockResult {
  group: TaskGroup;
  /** One result for each added request, in order. */
  tasks: EnqueueResult[];
}

/** What a repair does to one drifted group. */
export type TaskGroupRepairAction = "recounted" | "finished";

/** One group whose counters disagree with its member outcomes, or that should have finished. */
export interface TaskGroupDrift {
  groupId: string;
  state: TaskGroupState;
  /** The counters the group row records. */
  recorded: Omit<TaskGroupCounts, "pending">;
  /** The counts the member outcomes give. */
  counted: TaskGroupCounts;
  action: TaskGroupRepairAction;
}

export interface TaskGroupRepair {
  groupId: string;
  recordedPending: number;
  pending: number;
  action: TaskGroupRepairAction;
}

/** Why a task group refused an add. */
export type TaskGroupRefusal = "sealed" | "finished" | "canceled" | "not_running_member";

export interface TaskGroupClosedDetails {
  groupId: string;
  state: TaskGroupState;
  reason: TaskGroupRefusal;
}

/** The group does not accept tasks: it is sealed, finished, or canceled (`P1008`). */
export class TaskGroupClosedError extends WorkhorseError {
  constructor(readonly details: TaskGroupClosedDetails) {
    super(`Task group ${details.groupId} does not accept tasks (${details.reason})`);
    this.name = "TaskGroupClosedError";
  }
}

export interface TaskGroupLimitDetails {
  groupId: string;
  limit: number;
  total: number;
  requested: number;
}

/** An add would take the group above its member limit (`P1009`). */
export class TaskGroupLimitExceededError extends WorkhorseError {
  constructor(readonly details: TaskGroupLimitDetails) {
    super(
      `Task group ${details.groupId} holds ${details.total} tasks and accepts at most ${details.limit}`,
    );
    this.name = "TaskGroupLimitExceededError";
  }
}

export interface TaskGroupMembershipConflictDetails {
  groupId: string;
  taskId: string;
  ordinal: number;
  /** The group the existing task belongs to, or null. */
  memberOf: string | null;
}

/** An enqueue idempotency hit returned a task that is not a member of this group (`P1010`). */
export class TaskGroupMembershipConflictError extends WorkhorseError {
  constructor(readonly details: TaskGroupMembershipConflictDetails) {
    super(
      `Enqueue idempotency returned task ${details.taskId}, which is not a member of task group ${details.groupId}`,
    );
    this.name = "TaskGroupMembershipConflictError";
  }
}

function parsedDetail<T>(error: unknown, valid: (value: unknown) => value is T): T | null {
  for (const detail of databaseErrorDetails(error)) {
    try {
      const parsed: unknown = JSON.parse(detail);
      if (valid(parsed)) return parsed;
    } catch {
      // An ORM or PostgreSQL supplied unrelated DETAIL text; try the next one.
    }
  }
  return null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/** Translate the task group SQLSTATEs into their errors, or return null. */
function taskGroupRejection(error: unknown): WorkhorseError | null {
  switch (databaseErrorCode(error)) {
    case "P1008":
      return new TaskGroupClosedError(
        parsedDetail(
          error,
          (value): value is TaskGroupClosedDetails =>
            isRecord(value) &&
            typeof value.groupId === "string" &&
            typeof value.state === "string" &&
            typeof value.reason === "string",
        ) ?? { groupId: "unknown", state: "finished", reason: "finished" },
      );
    case "P1009":
      return new TaskGroupLimitExceededError(
        parsedDetail(
          error,
          (value): value is TaskGroupLimitDetails =>
            isRecord(value) &&
            typeof value.groupId === "string" &&
            typeof value.limit === "number" &&
            typeof value.total === "number" &&
            typeof value.requested === "number",
        ) ?? { groupId: "unknown", limit: MAX_TASK_GROUP_MEMBERS, total: 0, requested: 0 },
      );
    case "P1010":
      return new TaskGroupMembershipConflictError(
        parsedDetail(
          error,
          (value): value is TaskGroupMembershipConflictDetails =>
            isRecord(value) &&
            typeof value.groupId === "string" &&
            typeof value.taskId === "string" &&
            typeof value.ordinal === "number" &&
            (value.memberOf === null || typeof value.memberOf === "string"),
        ) ?? { groupId: "unknown", taskId: "unknown", ordinal: 0, memberOf: null },
      );
    default:
      return null;
  }
}

async function translated<T>(work: Promise<T>): Promise<T> {
  try {
    return await work;
  } catch (error) {
    throw taskGroupRejection(error) ?? error;
  }
}

interface TaskGroupRow {
  group_id: string;
  state: TaskGroupState;
  result: TaskGroupResult | null;
  total: number;
  succeeded: number;
  failed: number;
  canceled: number;
  pending: number;
  created_at: Date | string;
  sealed_at: Date | string | null;
  finished_at: Date | string | null;
  canceled_at: Date | string | null;
  canceled_by: string | null;
  cancel_reason: string | null;
  callbacks: Record<string, { taskId: string | null }>;
}

const callbackKinds: Readonly<Record<string, TaskGroupCallbackKind>> = {
  on_finish: "onFinish",
  on_success: "onSuccess",
  on_failure: "onFailure",
};

function taskGroup(row: TaskGroupRow): TaskGroup {
  return {
    id: row.group_id,
    state: row.state,
    result: row.result,
    counts: {
      total: row.total,
      succeeded: row.succeeded,
      failed: row.failed,
      canceled: row.canceled,
      pending: row.pending,
    },
    createdAt: rowTimestamp(row.created_at, "created_at"),
    sealedAt: nullableRowTimestamp(row.sealed_at, "sealed_at"),
    finishedAt: nullableRowTimestamp(row.finished_at, "finished_at"),
    canceledAt: nullableRowTimestamp(row.canceled_at, "canceled_at"),
    canceledBy: row.canceled_by,
    cancelReason: row.cancel_reason,
    callbacks: Object.entries(row.callbacks).map(([kind, callback]) => ({
      kind: callbackKinds[kind]!,
      taskId: callback.taskId,
    })),
  };
}

function validateRequestCount(requests: readonly EnqueueRequest[]): void {
  if (requests.length > MAX_ENQUEUE_BATCH_SIZE) {
    throw new RangeError(`a task group add accepts at most ${MAX_ENQUEUE_BATCH_SIZE} tasks`);
  }
  for (const request of requests) {
    if (request.options?.debounce !== undefined || request.options?.throttle !== undefined) {
      throw new TypeError("a task group add cannot use debounce or throttle");
    }
  }
}

function validateLimit(limit: number, maximum: number): void {
  if (!Number.isInteger(limit) || limit < 1 || limit > maximum) {
    throw new RangeError(`limit must be an integer from 1 to ${maximum}`);
  }
}

/** Owns task groups behind the Queue and Admin facades (ADR 0095). */
export class TaskGroupsModule extends QueueModule {
  constructor(
    context: QueueModuleContext,
    private readonly enqueueContracts: EnqueueContractsModule,
  ) {
    super(context);
  }

  private async serializeCallbacks(
    callbacks: TaskGroupCallbacks,
    transaction: Queryable,
  ): Promise<string> {
    const entries: string[] = [];
    for (const kind of ["onFinish", "onSuccess", "onFailure"] as const) {
      const request = callbacks[kind];
      if (request === undefined) continue;
      entries.push(
        `${JSON.stringify(kind)}:${await this.enqueueContracts.serializeCallbackRequest(request, transaction)}`,
      );
    }
    return `{${entries.join(",")}}`;
  }

  async create(
    callbacks: TaskGroupCallbacks = {},
    transaction: Queryable = this.context.database,
  ): Promise<TaskGroup> {
    return (await this.createWith(callbacks, [], false, transaction)).group;
  }

  /** Create, add, and seal in one statement, so in one transaction. */
  async createSealed(
    callbacks: TaskGroupCallbacks,
    build: (group: TaskGroupBuilder) => void | Promise<void>,
    transaction: Queryable = this.context.database,
  ): Promise<TaskGroupBlockResult> {
    const requests: EnqueueRequest[] = [];
    await build({
      add(added) {
        validateRequestCount(added);
        if (requests.length + added.length > MAX_TASK_GROUP_MEMBERS) {
          throw new RangeError(`a task group holds at most ${MAX_TASK_GROUP_MEMBERS} tasks`);
        }
        requests.push(...added);
      },
    });
    return this.createWith(callbacks, requests, true, transaction);
  }

  private async createWith(
    callbacks: TaskGroupCallbacks,
    requests: readonly EnqueueRequest[],
    seal: boolean,
    transaction: Queryable,
  ): Promise<TaskGroupBlockResult> {
    let groupId: string | null = null;
    // A contract mismatch of a member or a callback creates nothing, and the retry serializes the
    // callbacks again under the contract versions the mismatch refreshed.
    const submit = async (serializedInput: string): Promise<EnqueueRow[]> => {
      const serializedCallbacks = await this.serializeCallbacks(callbacks, transaction);
      const result = await transaction.query<EnqueueRow & { group_id: string | null }>(
        SQL_STATEMENTS["create_task_group_v1"],
        [serializedCallbacks, serializedInput, seal],
      );
      groupId = result.rows[0]?.group_id ?? null;
      return result.rows.filter((row) => row.ordinal !== null);
    };
    const tasks = await translated(
      this.enqueueContracts.submitEnqueueRequests(requests, transaction, submit),
    );
    if (groupId === null) throw new Error("PostgreSQL created no task group");
    const group = await this.get(groupId, transaction);
    if (group === null) throw new Error(`Task group ${groupId} disappeared after its creation`);
    return { group, tasks };
  }

  async add(
    groupId: string,
    requests: readonly EnqueueRequest[],
    transaction: Queryable = this.context.database,
    member?: { task: ClaimedTask; workerId: string },
  ): Promise<EnqueueResult[]> {
    validateRequestCount(requests);
    if (requests.length === 0) return [];
    return translated(
      this.enqueueContracts.submitEnqueueRequests(
        requests,
        transaction,
        async (serializedInput) =>
          (
            await transaction.query<EnqueueRow>(SQL_STATEMENTS["add_task_group_members_v1"], [
              groupId,
              serializedInput,
              member?.task.id ?? null,
              member?.workerId ?? null,
              member?.task.fenceToken.toString() ?? null,
            ])
          ).rows,
      ),
    );
  }

  async addAsMember(
    task: ClaimedTask,
    workerId: string,
    requests: readonly EnqueueRequest[],
  ): Promise<EnqueueResult[]> {
    const link = await this.forTask(task.id);
    if (link?.role !== "member") {
      throw new TypeError(`Task ${task.id} is not a member of a task group`);
    }
    return this.add(link.group.id, requests, this.context.database, { task, workerId });
  }

  async seal(groupId: string, transaction: Queryable = this.context.database): Promise<TaskGroup> {
    const result = await transaction.query<TaskGroupRow>(SQL_STATEMENTS["seal_task_group_v1"], [
      groupId,
    ]);
    return taskGroup(expectOneRow(result, "workhorse.seal_task_group_v1"));
  }

  async get(
    groupId: string,
    database: Queryable = this.context.database,
  ): Promise<TaskGroup | null> {
    const result = await database.query<TaskGroupRow>(SQL_STATEMENTS["get_task_group_v1"], [
      groupId,
    ]);
    const row = result.rows[0];
    return row === undefined ? null : taskGroup(row);
  }

  async forTask(taskId: string): Promise<TaskGroupLink | null> {
    const result = await this.context.database.query<
      TaskGroupRow & { role: "member" | "callback"; callback_kind: string | null }
    >(SQL_STATEMENTS["task_group_for_task_v1"], [taskId]);
    const row = result.rows[0];
    if (row === undefined) return null;
    return {
      role: row.role,
      callback: row.callback_kind === null ? null : callbackKinds[row.callback_kind]!,
      group: taskGroup(row),
    };
  }

  async listMembers(
    groupId: string,
    query: TaskGroupMemberQuery = {},
  ): Promise<TaskGroupMemberPage> {
    const limit = query.limit ?? 100;
    validateLimit(limit, MAX_TASK_GROUP_PAGE_SIZE);
    const after = query.after ?? 0;
    if (!Number.isInteger(after) || after < 0) {
      throw new RangeError("after must be a non-negative integer");
    }
    const result = await this.context.database.query<{
      position: number;
      task_id: string;
      queue_name: string | null;
      task_type: string | null;
      state: TaskState | null;
      outcome: TaskGroupMemberOutcome | null;
      added_at: Date | string;
      counted_at: Date | string | null;
    }>(SQL_STATEMENTS["list_task_group_members_v1"], [groupId, after, limit]);
    const members = result.rows.map((row) => ({
      position: row.position,
      taskId: row.task_id,
      queue: row.queue_name,
      type: row.task_type,
      state: row.state,
      outcome: row.outcome,
      addedAt: rowTimestamp(row.added_at, "added_at"),
      countedAt: nullableRowTimestamp(row.counted_at, "counted_at"),
    }));
    return {
      members,
      nextAfter: members.length === limit ? members[members.length - 1]!.position : null,
    };
  }

  async listEvents(groupId: string, limit: number): Promise<TaskGroupEvent[]> {
    validateLimit(limit, MAX_TASK_GROUP_PAGE_SIZE);
    const result = await this.context.database.query<{
      event_id: string;
      event_type: TaskGroupEventType;
      details: Json;
      occurred_at: Date | string;
    }>(SQL_STATEMENTS["list_task_group_events_v1"], [groupId, limit]);
    return result.rows.map((row) => ({
      id: row.event_id,
      type: row.event_type,
      details: row.details,
      occurredAt: rowTimestamp(row.occurred_at, "occurred_at"),
    }));
  }

  async cancel(
    groupId: string,
    audit: { actor: string; reason: string; requestId: string },
  ): Promise<TaskGroup | null> {
    const result = await this.context.database.query<TaskGroupRow>(
      SQL_STATEMENTS["cancel_task_group_v1"],
      [groupId, audit.actor, audit.reason, audit.requestId],
    );
    const row = result.rows[0];
    return row === undefined ? null : taskGroup(row);
  }

  async listDrift(limit: number): Promise<TaskGroupDrift[]> {
    validateLimit(limit, MAX_TASK_GROUP_DRIFT_LIMIT);
    const result = await this.context.database.query<{
      group_id: string;
      state: TaskGroupState;
      recorded_total: number;
      recorded_succeeded: number;
      recorded_failed: number;
      recorded_canceled: number;
      total: number;
      succeeded: number;
      failed: number;
      canceled: number;
      pending: number;
      action: TaskGroupRepairAction;
    }>(SQL_STATEMENTS["list_task_group_drift_v1"], [limit]);
    return result.rows.map((row) => ({
      groupId: row.group_id,
      state: row.state,
      recorded: {
        total: row.recorded_total,
        succeeded: row.recorded_succeeded,
        failed: row.recorded_failed,
        canceled: row.recorded_canceled,
      },
      counted: {
        total: row.total,
        succeeded: row.succeeded,
        failed: row.failed,
        canceled: row.canceled,
        pending: row.pending,
      },
      action: row.action,
    }));
  }

  async repairDrift(
    audit: { actor: string; reason: string; requestId: string },
    limit: number,
  ): Promise<TaskGroupRepair[]> {
    validateLimit(limit, MAX_TASK_GROUP_DRIFT_LIMIT);
    const result = await this.context.database.query<{
      group_id: string;
      recorded_pending: number;
      pending: number;
      action: TaskGroupRepairAction;
    }>(SQL_STATEMENTS["repair_task_group_drift_v1"], [
      limit,
      audit.actor,
      audit.reason,
      audit.requestId,
    ]);
    return result.rows.map((row) => ({
      groupId: row.group_id,
      recordedPending: row.recorded_pending,
      pending: row.pending,
      action: row.action,
    }));
  }
}
