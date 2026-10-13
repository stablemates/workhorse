import { createHash, randomUUID } from "node:crypto";
import { SQL_STATEMENTS } from "../queue/sql-catalogue.generated.js";
import type { Pool } from "pg";
import { expectOneRow } from "../errors.js";
import { Admin, Queue } from "../index.js";
import type {
  DependencyDrift,
  DependencyRepair,
  QueueHistorySettings,
  QueueTier,
} from "../index.js";
import type {
  BulkRedriveOptions,
  BulkRedrivePage,
  DeadLetterFilter,
  Json,
  CancelResult,
  DeadLetterPage,
  DeadLetterQuery,
  TaskCheckpoint,
  TaskListPage,
  TaskListQuery,
  TaskSnapshot,
  TaskTimelinePage,
  TaskTimelineQuery,
  TaskWait,
  MaintenancePolicy,
  QueueHealth,
  RedriveResult,
  RetentionPolicy,
  WorkerPauseResult,
  WorkerRegistryEntry,
} from "../types.js";
import type { StoredSchedule } from "../queue/cron-schedules.js";
import { rowTimestamp, nullableRowTimestamp } from "../queue/row-mapping.js";
import type {
  TaskGroup,
  TaskGroupCallbackKind,
  TaskGroupCounts,
  TaskGroupEvent,
  TaskGroupEventType,
  TaskGroupMember,
  TaskGroupResult,
  TaskGroupState,
} from "../queue/task-groups.js";
import type { ExternalWaitDeliveryRequest, ExternalWaitCursor } from "../queue/external-waits.js";
import type { HumanWaitCompletionResult, HumanWaitPage } from "../queue/human-waits.js";
import type { SignalDeliveryResult, SignalWaitPage } from "../queue/signals.js";

/**
 * A refused administrative operation. The refusal is a safety outcome, not malformed usage, so
 * callers report it and exit 1 rather than the usage exit code.
 */
export class AdminSafetyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AdminSafetyError";
  }
}

/**
 * Proof that the operator named the connected database explicitly.
 *
 * Only {@link WorkhorseAdminClient.confirmEnvironment} constructs one, so every mutation method can
 * demand the check at compile time. The CLI and the TUI both go through this same gate.
 */
export interface ConfirmedEnvironment {
  readonly database: string;
}

/**
 * Compact per-queue status for operators: dispatch pressure plus the durable queue controls.
 *
 * The tier and the two history settings come from `queue_control`. A queue without a control row
 * reports the defaults: full tier, which records all history itself, and both opt-ins off.
 */
export interface AdminQueueStatus {
  queue: string;
  paused: boolean;
  tier: QueueTier;
  recordAttempts: boolean;
  recordClaims: boolean;
  readyDepth: number;
  scheduledDepth: number;
  activeLeases: number;
  blockedReadyDepth: number;
  oldestReadyAgeMs: number | null;
  concurrencyLimit: number | null;
  concurrencyActive: number;
  rateLimitPerSecond: number | null;
  rateLimitThrottledReadyDepth: number;
}

/**
 * One page of every boundary the fleet is waiting on an outside party to answer.
 *
 * The two kinds page independently because each carries the dashboard's own
 * {@link ExternalWaitCursor}, which is scoped to one list.
 */
export interface AdminExternalWaits {
  human: HumanWaitPage;
  signal: SignalWaitPage;
}

/** Continuation state for one {@link WorkhorseAdminClient.externalWaits} call. */
export interface AdminExternalWaitQuery {
  limit?: number;
  humanCursor?: ExternalWaitCursor;
  signalCursor?: ExternalWaitCursor;
}

export interface AdminMaintenanceState {
  maintenancePolicy: MaintenancePolicy;
  retentionPolicy: RetentionPolicy;
}

export interface AdminCancelRequest {
  requestedBy: string;
  reason?: string;
}

export interface AdminRedriveRequest {
  requestedBy: string;
  reason: string;
  requestId: string;
}

export type AdminControlRequest = AdminRedriveRequest;

/** Attribution for a tier change. The database records the actor and reason, not a request id. */
export interface AdminTierRequest {
  requestedBy: string;
  reason: string;
}

interface QueueControlRow {
  queue_name: string;
  paused: boolean;
  tier: QueueTier;
  record_attempts: boolean;
  record_claims: boolean;
}

/**
 * A history change and the context an operator needs to read it.
 *
 * `tier` is the queue's tier, which the history change leaves alone. `knownBefore` is false when
 * the queue had neither a control row nor a live task, which usually means a misspelled name.
 */
export interface AdminHistoryChange extends QueueHistorySettings {
  tier: QueueTier;
  knownBefore: boolean;
}

/** The states `admin task-groups` selects. `all` selects every group. */
type AdminTaskGroupStateFilter = "all" | TaskGroupState;

/** One `admin task-groups` read: a page number from 1 and a page size from 1 through 100. */
export interface AdminTaskGroupQuery {
  state?: TaskGroupState;
  page?: number;
  pageSize?: number;
}

/**
 * One page of task groups, newest first, as `dashboard_task_groups_v1` returns it.
 *
 * The function pages by number, not by cursor, so `hasMore` tells the caller to read `page + 1`.
 */
export interface AdminTaskGroupPage {
  state: AdminTaskGroupStateFilter;
  page: number;
  pageSize: number;
  hasMore: boolean;
  groups: TaskGroup[];
}

/** One member page after a position. `limit` is from 1 through 1,000. */
export interface AdminTaskGroupDetailQuery {
  after?: number;
  limit?: number;
}

/**
 * One task group, one page of its member tasks, and its newest events.
 *
 * The parts come from separate statements, so they are not one snapshot. `events` is newest
 * first, and `eventsTruncated` is true when the group has older events that the detail omits.
 */
export interface AdminTaskGroupDetail {
  group: TaskGroup;
  members: TaskGroupMember[];
  nextAfter: number | null;
  events: TaskGroupEvent[];
  eventsTruncated: boolean;
}

/**
 * What `admin cancel-task-group` did.
 *
 * `already_finished` means the group was finished before the cancel, so nothing changed. The group
 * is null only for `not_found`.
 */
export interface AdminTaskGroupCancelResult {
  status: "canceled" | "already_finished" | "not_found";
  group: TaskGroup | null;
}

/** The number of newest events the detail carries, the same number as the dashboard detail. */
const TASK_GROUP_DETAIL_EVENT_LIMIT = 100;

/**
 * The number of newest events a cancel reads to find its own `canceled` event: the largest limit of
 * `list_newest_task_group_events_v1`. Its own event drops out only if more events follow it first.
 */
const TASK_GROUP_CANCEL_EVENT_WINDOW = 1_000;

/** One group as `dashboard_task_groups_v1` writes it: the snapshot fields with ISO times. */
interface TaskGroupDocument {
  id: string;
  state: TaskGroupState;
  result: TaskGroupResult | null;
  counts: TaskGroupCounts;
  createdAt: string;
  sealedAt: string | null;
  finishedAt: string | null;
  canceledAt: string | null;
  canceledBy: string | null;
  cancelReason: string | null;
  callbacks: { kind: TaskGroupCallbackKind; taskId: string | null }[];
}

function taskGroupFromDocument(document: TaskGroupDocument): TaskGroup {
  return {
    id: document.id,
    state: document.state,
    result: document.result,
    counts: document.counts,
    createdAt: rowTimestamp(document.createdAt, "createdAt"),
    sealedAt: nullableRowTimestamp(document.sealedAt, "sealedAt"),
    finishedAt: nullableRowTimestamp(document.finishedAt, "finishedAt"),
    canceledAt: nullableRowTimestamp(document.canceledAt, "canceledAt"),
    canceledBy: document.canceledBy,
    cancelReason: document.cancelReason,
    callbacks: document.callbacks.map((callback) => ({
      kind: callback.kind,
      taskId: callback.taskId,
    })),
  };
}

function isDefaultControl(row: QueueControlRow): boolean {
  return !row.paused && row.tier === "full" && !row.record_attempts && !row.record_claims;
}

/**
 * The administrative surface shared by `workhorse admin` and `workhorse tui`.
 *
 * The client composes the public {@link Admin} operator API with {@link Queue} application
 * controls, two reads of existing operator tables, and the two task group reads of the dashboard
 * that no `Admin` call makes. Every mutation
 * requires a {@link ConfirmedEnvironment}, so no front end can reach a destructive operation
 * without the explicit-target check.
 */
export class WorkhorseAdminClient {
  readonly admin: Admin;
  readonly queue: Queue;

  constructor(private readonly pool: Pool) {
    this.admin = new Admin(pool);
    this.queue = new Queue(pool);
  }

  /** The connected database's own name, which the environment confirmation must match. */
  async targetDatabase(): Promise<string> {
    const result = await this.pool.query<{ database: string }>(SQL_STATEMENTS["current_database"]);
    return expectOneRow(result, "current_database").database;
  }

  /**
   * Verify that the operator-supplied environment names the connected database.
   *
   * The returned token is the only key that unlocks mutation methods. A mismatch is an
   * {@link AdminSafetyError}: the likely cause is an ambient database URL pointing somewhere the
   * operator did not intend.
   */
  async confirmEnvironment(environment: string): Promise<ConfirmedEnvironment> {
    const database = await this.targetDatabase();
    if (environment !== database) {
      throw new AdminSafetyError(
        `--env "${environment}" does not match the connected database "${database}". ` +
          "Refusing to mutate a database the command did not name.",
      );
    }
    return { database };
  }

  listTasks(query: TaskListQuery = {}): Promise<TaskListPage> {
    return this.admin.listTasks(query);
  }

  getTask(taskId: string): Promise<TaskSnapshot | null> {
    return this.admin.getTask(taskId);
  }

  getTaskTimeline(taskId: string, query: TaskTimelineQuery = {}): Promise<TaskTimelinePage> {
    return this.admin.getTaskTimeline(taskId, query);
  }

  listDeadLetters(query: DeadLetterQuery = {}): Promise<DeadLetterPage> {
    return this.admin.listDeadLetters(query);
  }

  listCheckpoints(taskId: string): Promise<TaskCheckpoint[]> {
    return this.admin.listCheckpoints(taskId);
  }

  getCheckpoint(taskId: string, name: string): Promise<TaskCheckpoint | null> {
    return this.admin.getCheckpoint(taskId, name);
  }

  listWaits(taskId: string): Promise<TaskWait[]> {
    return this.admin.listWaits(taskId);
  }

  getWait(taskId: string, name: string): Promise<TaskWait | null> {
    return this.admin.getWait(taskId, name);
  }

  /**
   * Both external-wait lists, fleet-wide, in one round trip.
   *
   * A stalled durable handler is waiting either on a person or on a signal, and an operator
   * asking "what is the fleet waiting on" wants both answers at once.
   */
  async externalWaits(query: AdminExternalWaitQuery = {}): Promise<AdminExternalWaits> {
    const [human, signal] = await Promise.all([
      this.admin.listHumanWaits({ limit: query.limit, cursor: query.humanCursor }),
      this.admin.listSignalWaits({ limit: query.limit, cursor: query.signalCursor }),
    ]);
    return { human, signal };
  }

  /**
   * Per-queue dispatch pressure merged with the durable queue controls.
   *
   * A queue with no live tasks still appears while any control differs from the default, so an
   * operator can always see and release an old pause or find an idle fast-tier queue.
   */
  async queues(): Promise<AdminQueueStatus[]> {
    const [snapshots, control] = await Promise.all([
      this.admin.queueMetricSnapshot(),
      this.pool.query<QueueControlRow>(SQL_STATEMENTS["queue_control"]),
    ]);
    const controlByQueue = new Map(control.rows.map((row) => [row.queue_name, row]));
    const controls = (queueName: string) => {
      const row = controlByQueue.get(queueName);
      return {
        paused: row?.paused ?? false,
        tier: row?.tier ?? "full",
        recordAttempts: row?.record_attempts ?? false,
        recordClaims: row?.record_claims ?? false,
      };
    };
    const statuses = new Map<string, AdminQueueStatus>();
    for (const snapshot of snapshots) {
      statuses.set(snapshot.queue, {
        queue: snapshot.queue,
        ...controls(snapshot.queue),
        readyDepth: snapshot.readyDepth,
        scheduledDepth: snapshot.scheduledDepth,
        activeLeases: snapshot.activeLeases,
        blockedReadyDepth: snapshot.blockedReadyDepth,
        oldestReadyAgeMs: snapshot.oldestReadyAgeMs,
        concurrencyLimit: snapshot.concurrencyLimit,
        concurrencyActive: snapshot.concurrencyActive,
        rateLimitPerSecond: snapshot.rateLimitPerSecond,
        rateLimitThrottledReadyDepth: snapshot.rateLimitThrottledReadyDepth,
      });
    }
    for (const row of control.rows) {
      if (isDefaultControl(row) || statuses.has(row.queue_name)) continue;
      statuses.set(row.queue_name, {
        queue: row.queue_name,
        ...controls(row.queue_name),
        readyDepth: 0,
        scheduledDepth: 0,
        activeLeases: 0,
        blockedReadyDepth: 0,
        oldestReadyAgeMs: null,
        concurrencyLimit: null,
        concurrencyActive: 0,
        rateLimitPerSecond: null,
        rateLimitThrottledReadyDepth: 0,
      });
    }
    return [...statuses.values()].toSorted((left, right) => left.queue.localeCompare(right.queue));
  }

  /**
   * Enabled recurring schedules. Without explicit namespaces, every persisted namespace is
   * listed.
   */
  async schedules(namespaces?: readonly string[]): Promise<StoredSchedule[]> {
    let targets = namespaces;
    if (targets === undefined || targets.length === 0) {
      const result = await this.pool.query<{ namespace: string }>(
        SQL_STATEMENTS["schedule_definition"],
      );
      targets = result.rows.map((row) => row.namespace);
    }
    return this.admin.schedules(targets);
  }

  workers(): Promise<WorkerRegistryEntry[]> {
    return this.admin.listWorkers();
  }

  health(): Promise<QueueHealth> {
    return this.admin.health();
  }

  async maintenance(): Promise<AdminMaintenanceState> {
    const [maintenancePolicy, retentionPolicy] = await Promise.all([
      this.admin.getMaintenancePolicy(),
      this.admin.getRetentionPolicy(),
    ]);
    return { maintenancePolicy, retentionPolicy };
  }

  cancel(
    environment: ConfirmedEnvironment,
    taskId: string,
    request: AdminCancelRequest,
  ): Promise<CancelResult> {
    void environment;
    return this.queue.cancel(taskId, request);
  }

  redrive(
    environment: ConfirmedEnvironment,
    taskId: string,
    request: AdminRedriveRequest,
  ): Promise<RedriveResult> {
    void environment;
    return this.admin.redrive(taskId, {
      actor: request.requestedBy,
      reason: request.reason,
      requestId: request.requestId,
    });
  }

  previewRedrive(
    filter: DeadLetterFilter,
    request: AdminRedriveRequest,
    options: Omit<BulkRedriveOptions, "dryRun"> = {},
  ): Promise<BulkRedrivePage> {
    return this.admin.redriveMany(
      filter,
      {
        actor: request.requestedBy,
        reason: request.reason,
        requestId: request.requestId,
      },
      { ...options, dryRun: true },
    );
  }

  redriveMany(
    environment: ConfirmedEnvironment,
    filter: DeadLetterFilter,
    request: AdminRedriveRequest,
    options: Omit<BulkRedriveOptions, "dryRun"> = {},
  ): Promise<BulkRedrivePage> {
    void environment;
    return this.admin.redriveMany(
      filter,
      {
        actor: request.requestedBy,
        reason: request.reason,
        requestId: request.requestId,
      },
      { ...options, dryRun: false },
    );
  }

  sendSignal(
    environment: ConfirmedEnvironment,
    taskId: string,
    name: string,
    payload: Json,
    request: ExternalWaitDeliveryRequest,
  ): Promise<SignalDeliveryResult> {
    void environment;
    return this.queue.sendSignal(taskId, name, payload, request);
  }

  completeHumanWait(
    environment: ConfirmedEnvironment,
    taskId: string,
    name: string,
    payload: Json,
    request: ExternalWaitDeliveryRequest,
  ): Promise<HumanWaitCompletionResult> {
    void environment;
    return this.queue.completeHumanWait(taskId, name, payload, request);
  }

  async pauseQueue(
    environment: ConfirmedEnvironment,
    queueName: string,
    request: AdminControlRequest,
  ): Promise<void> {
    void environment;
    await this.admin.pauseQueue(queueName, {
      actor: request.requestedBy,
      reason: request.reason,
      requestId: request.requestId,
    });
  }

  async resumeQueue(
    environment: ConfirmedEnvironment,
    queueName: string,
    request: AdminControlRequest,
  ): Promise<void> {
    void environment;
    await this.admin.resumeQueue(queueName, {
      actor: request.requestedBy,
      reason: request.reason,
      requestId: request.requestId,
    });
  }

  /**
   * Moves one queue to the fast or full tier and answers the tier it now holds.
   *
   * The {@link Admin.setQueueTier} guards apply unchanged: a queue with live tasks, or a queue with
   * a concurrency or rate-limit policy moving to fast, is refused with `FastTierUnsupportedError`.
   */
  setQueueTier(
    environment: ConfirmedEnvironment,
    queueName: string,
    tier: QueueTier,
    request: AdminTierRequest,
  ): Promise<QueueTier> {
    void environment;
    // The tier function records no request id, so a fresh one only satisfies audit validation.
    return this.admin.setQueueTier(queueName, tier, {
      actor: request.requestedBy,
      reason: request.reason,
      requestId: randomUUID(),
    });
  }

  /**
   * Changes a queue's history settings and answers both settings after the change.
   *
   * The database accepts any queue name and creates its control row, so the answer also carries the
   * queue's tier and whether the queue existed before. A full-tier queue records all history, and
   * its settings take effect only if it moves to the fast tier.
   */
  async setQueueHistory(
    environment: ConfirmedEnvironment,
    queueName: string,
    settings: Partial<QueueHistorySettings>,
  ): Promise<AdminHistoryChange> {
    void environment;
    const [snapshots, control] = await Promise.all([
      this.admin.queueMetricSnapshot(),
      this.pool.query<QueueControlRow>(SQL_STATEMENTS["queue_control"]),
    ]);
    const row = control.rows.find((candidate) => candidate.queue_name === queueName);
    const knownBefore =
      row !== undefined || snapshots.some((snapshot) => snapshot.queue === queueName);
    const changed = await this.admin.setQueueHistory(queueName, settings);
    return { ...changed, tier: row?.tier ?? "full", knownBefore };
  }

  /** Deletes one queue's non-active tasks and answers how many rows went. */
  purgeQueue(
    environment: ConfirmedEnvironment,
    queueName: string,
    request: AdminControlRequest,
  ): Promise<number> {
    void environment;
    return this.admin.purgeQueue(queueName, {
      actor: request.requestedBy,
      reason: request.reason,
      requestId: request.requestId,
    });
  }

  /**
   * One page of task groups, newest first, through `dashboard_task_groups_v1`.
   *
   * No `Admin` call lists task groups. The dashboard group list calls this function, so the CLI and
   * the dashboard select and order the same groups.
   */
  async listTaskGroups(query: AdminTaskGroupQuery = {}): Promise<AdminTaskGroupPage> {
    const result = await this.pool.query<{
      result: Omit<AdminTaskGroupPage, "groups"> & { groups: TaskGroupDocument[] };
    }>(SQL_STATEMENTS["dashboard_task_groups_v1"], [
      JSON.stringify({ state: query.state ?? "all", page: query.page, pageSize: query.pageSize }),
    ]);
    const page = expectOneRow(result, "workhorse.dashboard_task_groups_v1").result;
    return {
      state: page.state,
      page: page.page,
      pageSize: page.pageSize,
      hasMore: page.hasMore,
      groups: page.groups.map(taskGroupFromDocument),
    };
  }

  /** The newest events of a group, newest first, through `list_newest_task_group_events_v1`. */
  private async newestTaskGroupEvents(groupId: string, limit: number): Promise<TaskGroupEvent[]> {
    const result = await this.pool.query<{
      event_id: string;
      event_type: TaskGroupEventType;
      details: Json;
      occurred_at: Date | string;
    }>(SQL_STATEMENTS["list_newest_task_group_events_v1"], [groupId, limit]);
    return result.rows.map((row) => ({
      id: row.event_id,
      type: row.event_type,
      details: row.details,
      occurredAt: rowTimestamp(row.occurred_at, "occurred_at"),
    }));
  }

  /**
   * One task group with one page of its member tasks and its newest events, or null for an unknown
   * group. The reads are the ones the dashboard detail makes.
   */
  async getTaskGroupDetail(
    groupId: string,
    query: AdminTaskGroupDetailQuery = {},
  ): Promise<AdminTaskGroupDetail | null> {
    const group = await this.admin.getTaskGroup(groupId);
    if (group === null) return null;
    const [members, events] = await Promise.all([
      this.admin.listTaskGroupMembers(groupId, query),
      this.newestTaskGroupEvents(groupId, TASK_GROUP_DETAIL_EVENT_LIMIT + 1),
    ]);
    return {
      group,
      members: members.members,
      nextAfter: members.nextAfter,
      events: events.slice(0, TASK_GROUP_DETAIL_EVENT_LIMIT),
      eventsTruncated: events.length > TASK_GROUP_DETAIL_EVENT_LIMIT,
    };
  }

  /**
   * Cancels one task group through {@link Admin.cancelTaskGroup}.
   *
   * `cancel_task_group_v1` returns the unchanged snapshot of a finished group, and the snapshot
   * alone cannot tell this call from an earlier cancel. The function writes a `canceled` event only
   * when it does work, and the event records a digest of the request id. Thus the client lists the
   * `canceled` events before the call, and the call canceled the group only if a new `canceled`
   * event with its digest follows. A group that finishes during the call is `already_finished`.
   * Two calls with the same request id at the same time can both report `canceled`, because the
   * digest names the request, not the call.
   */
  async cancelTaskGroup(
    environment: ConfirmedEnvironment,
    groupId: string,
    request: AdminControlRequest,
  ): Promise<AdminTaskGroupCancelResult> {
    void environment;
    const canceledEvents = async () =>
      (await this.newestTaskGroupEvents(groupId, TASK_GROUP_CANCEL_EVENT_WINDOW)).filter(
        (event) => event.type === "canceled",
      );
    const earlier = new Set((await canceledEvents()).map((event) => event.id));
    const group = await this.admin.cancelTaskGroup(groupId, {
      actor: request.requestedBy,
      reason: request.reason,
      requestId: request.requestId,
    });
    if (group === null) return { status: "not_found", group: null };
    // The digest has the form that `cancel_task_group_v1` writes to `request_id_digest`.
    const digest = createHash("sha256")
      .update(request.requestId, "utf8")
      .digest("hex")
      .slice(0, 12);
    const canceled = (await canceledEvents()).some(
      (event) =>
        !earlier.has(event.id) &&
        typeof event.details === "object" &&
        event.details !== null &&
        !Array.isArray(event.details) &&
        event.details.request_id_digest === digest,
    );
    return { status: canceled ? "canceled" : "already_finished", group };
  }

  /** Lists drifted blocked dependents and the action a repair would take, without writing. */
  listDependencyDrift(limit: number | undefined): Promise<DependencyDrift[]> {
    return this.admin.listDependencyDrift(limit);
  }

  /** Repairs drifted blocked dependents and answers each one's action. */
  repairDependencyDrift(
    environment: ConfirmedEnvironment,
    limit: number | undefined,
    request: AdminControlRequest,
  ): Promise<DependencyRepair[]> {
    void environment;
    return this.admin.repairDependencyDrift(
      { actor: request.requestedBy, reason: request.reason, requestId: request.requestId },
      limit,
    );
  }

  /**
   * Writes one worker's durable registry pause and answers the stored row.
   *
   * A worker id with no registration answers null rather than throwing, because an operator
   * naming a worker that already aged out of the fleet is a wrong target, not a refusal.
   */
  setWorkerPaused(
    environment: ConfirmedEnvironment,
    workerId: string,
    paused: boolean,
    request: AdminControlRequest,
  ): Promise<WorkerPauseResult | null> {
    void environment;
    return this.admin.setWorkerPaused(workerId, paused, {
      actor: request.requestedBy,
      reason: request.reason,
      requestId: request.requestId,
    });
  }
}
