import { expectOneRow } from "@stablemates/workhorse";
import type { Admin } from "@stablemates/workhorse";
import {
  DashboardCheckpointValue,
  DashboardListingCount,
  DashboardActivityGroupBy,
  DashboardActivityPage,
  DashboardActivityPeriod,
  DashboardCronPage,
  DashboardEventDetail,
  DashboardEventKind,
  DashboardEventsPage,
  DashboardEventsWindow,
  DashboardTaskDetail,
  DashboardTaskValue,
  DashboardTaskValueKind,
  DashboardHumanWaitPage,
  DashboardQueuesPage,
  DashboardSystemPage,
  DashboardSystemWindow,
  DashboardTaskCounts,
  DashboardTaskFacets,
  DashboardTaskFilter,
  DashboardTaskSort,
  DashboardTasksPage,
  DashboardTasksCursorPage,
  DashboardTaskCursor,
  DashboardWorkersPage,
  DashboardSettingsPage,
  DashboardMaintenanceLoopCadences,
} from "../wire.js";
import { sql, type DashboardDatabase } from "./sql.js";
import type { DashboardDurabilityProjector } from "./types.js";

/**
 * The document `workhorse.queue_health_v1()` returns.
 *
 * It is not the converted `QueueHealth` an operator reads, because its one consumer hands it
 * straight back to PostgreSQL as procedure input, and a converted copy would need converting back.
 */
type DashboardQueueHealthDocument = { readonly [key: string]: unknown };

/** Read the health document every dashboard procedure that needs one is given. */
export type DashboardQueueHealthReader = () => Promise<DashboardQueueHealthDocument>;

/**
 * Share the expensive canonical health snapshot across nearby reads for one dashboard context.
 *
 * Composing the snapshot is a pass over live queue state, and one dashboard page reads it from
 * several procedures. Each procedure accepts the document as an input, so the page pays for one.
 */
export function createDashboardQueueHealthReader(
  database: DashboardDatabase,
  ttlMs = 3_000,
): DashboardQueueHealthReader {
  let cached: { expiresAt: number; value: DashboardQueueHealthDocument } | null = null;
  let pending: Promise<DashboardQueueHealthDocument> | null = null;
  return async () => {
    const now = Date.now();
    if (cached && cached.expiresAt > now) return cached.value;
    if (pending) return pending;
    pending = database
      .execute<{ document: DashboardQueueHealthDocument }>(
        sql`SELECT workhorse.queue_health_v1() AS document`,
      )
      .then((rows) => {
        const value = expectOneRow(rows, "the queue health document").document;
        cached = { expiresAt: Date.now() + ttlMs, value };
        return value;
      })
      .finally(() => {
        pending = null;
      });
    return pending;
  };
}

export async function readDashboardHumanWaits(
  database: DashboardDatabase,
  _admin: Admin,
  canComplete: boolean,
  canSignal: boolean,
  readQueueHealth?: DashboardQueueHealthReader,
): Promise<DashboardHumanWaitPage> {
  const health = await readQueueHealth?.();
  const input = JSON.stringify({ canComplete, canSignal, health });
  const result = await database.execute<{ result: DashboardHumanWaitPage }>(sql`
    SELECT workhorse.dashboard_human_waits_v1(${input}::jsonb) AS result
  `);
  return expectOneRow(result, "the dashboard human waits procedure").result;
}

export async function readDashboardSettings(
  database: DashboardDatabase,
  writable: boolean,
  settingsController: boolean,
  readQueueHealth?: DashboardQueueHealthReader,
): Promise<DashboardSettingsPage> {
  const health = await readQueueHealth?.();
  const input = JSON.stringify({ writable, settingsController, health });
  const rows = await database.execute<{ result: DashboardSettingsPage }>(sql`
    SELECT workhorse.dashboard_settings_v1(${input}::jsonb) AS result
  `);
  return expectOneRow(rows, "the dashboard settings procedure").result;
}

export async function readDashboardTaskCounts(
  database: DashboardDatabase,
): Promise<DashboardTaskCounts> {
  const rows = await database.execute<{ result: DashboardTaskCounts }>(sql`
    SELECT workhorse.dashboard_task_counts_v1('{}'::jsonb) AS result
  `);
  return expectOneRow(rows, "the dashboard task counts procedure").result;
}

/** Queue management rows keep hot live-state counts exact and estimate cold outcomes at scale. */
export async function readDashboardQueues(
  database: DashboardDatabase,
  readQueueHealth?: DashboardQueueHealthReader,
): Promise<DashboardQueuesPage> {
  const health = await readQueueHealth?.();
  const input = JSON.stringify({ health });
  const result = await database.execute<{ result: DashboardQueuesPage }>(sql`
    SELECT workhorse.dashboard_queues_v1(${input}::jsonb) AS result
  `);
  return expectOneRow(result, "the dashboard queues procedure").result;
}

/** Bucketed task activity over a trailing window, grouped by queue, worker, task type, or status. */
export async function readDashboardActivity(
  database: DashboardDatabase,
  filter: DashboardTaskFilter,
  period: DashboardActivityPeriod,
  groupBy: DashboardActivityGroupBy = "task",
  tags: readonly string[] = [],
  queue: string | null = null,
  worker: string | null = null,
): Promise<DashboardActivityPage> {
  const input = JSON.stringify({ filter, period, groupBy, tags, queue, worker });
  const rows = await database.execute<{ result: DashboardActivityPage }>(sql`
    SELECT workhorse.dashboard_activity_v1(${input}::jsonb) AS result
  `);
  return expectOneRow(rows, "the dashboard activity procedure").result;
}

export interface DashboardTasksQuery {
  filter: DashboardTaskFilter;
  page: number;
  pageSize: number;
  queue: string | null;
  tags: readonly string[];
  search: string | null;
  worker: string | null;
  taskType: string | null;
  priority: number | null;
  sort: DashboardTaskSort;
  count: DashboardListingCount;
}

const noDashboardDurability: DashboardDurabilityProjector = () => null;

export async function readDashboardTasks(
  database: DashboardDatabase,
  query: DashboardTasksQuery,
  projectDurability: DashboardDurabilityProjector = noDashboardDurability,
  canCompleteHumanWait = false,
): Promise<DashboardTasksPage> {
  const input = JSON.stringify({ ...query, canCompleteHumanWait });
  const rows = await database.execute<{ result: DashboardTasksPage }>(sql`
    SELECT workhorse.dashboard_tasks_v1(${input}::jsonb) AS result
  `);
  const page = expectOneRow(rows, "the dashboard tasks procedure").result;
  return projectTaskDurability(database, page, projectDurability);
}

export async function readDashboardTasksCursor(
  database: DashboardDatabase,
  query: Omit<DashboardTasksQuery, "page"> & {
    cursor: DashboardTaskCursor | null;
    direction: "next" | "previous";
  },
  projectDurability: DashboardDurabilityProjector = noDashboardDurability,
  canCompleteHumanWait = false,
): Promise<DashboardTasksCursorPage> {
  const input = JSON.stringify({ ...query, canCompleteHumanWait });
  const rows = await database.execute<{ result: DashboardTasksCursorPage }>(sql`
    SELECT workhorse.dashboard_tasks_cursor_v1(${input}::jsonb) AS result
  `);
  return projectTaskDurability(
    database,
    expectOneRow(rows, "the dashboard cursor tasks procedure").result,
    projectDurability,
  );
}

/**
 * Attach each listed task's durability plan, reading only what the host's projector declared.
 *
 * A projector reads a few top-level payload keys to recognize a plan, so a projector that names
 * them receives those keys instead of every task's whole redacted payload. One that names none
 * still receives the payload, because a plan it cannot recognize is a listing without progress.
 */
async function projectTaskDurability<T extends { tasks: DashboardTasksPage["tasks"] }>(
  database: DashboardDatabase,
  page: T,
  projectDurability: DashboardDurabilityProjector,
): Promise<T> {
  if (projectDurability === noDashboardDurability || page.tasks.length === 0) return page;

  const payloadKeys = projectDurability.payloadKeys;
  const payload =
    payloadKeys === undefined
      ? sql`task.payload`
      : sql`CASE WHEN jsonb_typeof(task.payload) <> 'object' THEN task.payload
                 ELSE COALESCE((SELECT jsonb_object_agg(entry.key, entry.value)
                                  FROM jsonb_each(task.payload) entry
                                 WHERE entry.key = ANY(${[...payloadKeys]}::text[])),
                               '{}'::jsonb) END`;
  const durabilityRows = await database.execute<{
    id: string;
    type: string;
    payload: unknown;
    checkpoint_names: string[];
  }>(sql`
    SELECT task.id::text AS id, task.task_type AS type, ${payload} AS payload,
           ARRAY(SELECT checkpoint.checkpoint_name
                   FROM workhorse.dashboard_task_checkpoint_v1 checkpoint
                  WHERE checkpoint.task_id = task.id
                  ORDER BY checkpoint.checkpoint_name) AS checkpoint_names
      FROM workhorse.dashboard_task_v1 task
     WHERE task.id = ANY(${page.tasks.map((task) => task.id)}::uuid[])
  `);
  const durabilityByTask = new Map(
    durabilityRows.rows.map((row) => {
      const plan = projectDurability(row.type, row.payload);
      const checkpointNames = new Set(row.checkpoint_names);
      return [
        row.id,
        plan
          ? {
              completedSteps: plan.steps.filter((step) => checkpointNames.has(step.name)).length,
              totalSteps: plan.steps.length,
            }
          : null,
      ] as const;
    }),
  );
  return {
    ...page,
    tasks: page.tasks.map((task) =>
      Object.assign(task, { durability: durabilityByTask.get(task.id) ?? null }),
    ),
  };
}

export async function readDashboardTaskFacets(
  database: DashboardDatabase,
  configuredWorkers: readonly string[] = [],
): Promise<DashboardTaskFacets> {
  const input = JSON.stringify({ configuredWorkers });
  const rows = await database.execute<{ result: DashboardTaskFacets }>(sql`
    SELECT workhorse.dashboard_task_facets_v1(${input}::jsonb) AS result
  `);
  return expectOneRow(rows, "the dashboard task facets procedure").result;
}

export async function readDashboardCron(
  database: DashboardDatabase,
  maintenanceLoops: DashboardMaintenanceLoopCadences,
): Promise<DashboardCronPage> {
  const input = JSON.stringify({ maintenanceLoops });
  const rows = await database.execute<{ result: DashboardCronPage }>(sql`
    SELECT workhorse.dashboard_cron_v1(${input}::jsonb) AS result
  `);
  return expectOneRow(rows, "the dashboard cron procedure").result;
}
export async function readDashboardSystem(
  database: DashboardDatabase,
  window: DashboardSystemWindow = "1h",
  readQueueHealth?: DashboardQueueHealthReader,
): Promise<DashboardSystemPage> {
  const health = await readQueueHealth?.();
  const input = JSON.stringify({ window, health });
  const rows = await database.execute<{ result: DashboardSystemPage }>(sql`
    SELECT workhorse.dashboard_system_v1(${input}::jsonb) AS result
  `);
  return expectOneRow(rows, "the dashboard system procedure").result;
}

export async function readDashboardWorkers(
  database: DashboardDatabase,
  configuredWorkers: readonly string[] = [],
  canManageWorkers = false,
): Promise<DashboardWorkersPage> {
  const input = JSON.stringify({ configuredWorkers, canManageWorkers });
  const rows = await database.execute<{ result: DashboardWorkersPage }>(sql`
    SELECT workhorse.dashboard_workers_v1(${input}::jsonb) AS result
  `);
  return expectOneRow(rows, "the dashboard workers procedure").result;
}

export async function readDashboardTaskDetail(
  database: DashboardDatabase,
  id: string,
  projectDurability: DashboardDurabilityProjector = () => null,
  _admin?: Admin,
  canSignal = false,
  readQueueHealth?: DashboardQueueHealthReader,
  redactErrorStacks = false,
  canCompleteHumanWait = false,
): Promise<DashboardTaskDetail | null> {
  const health = await readQueueHealth?.();
  const input = JSON.stringify({ id, canSignal, canCompleteHumanWait, health });
  const result = await database.execute<{ result: DashboardTaskDetail | null }>(sql`
    SELECT workhorse.dashboard_task_detail_v1(${input}::jsonb) AS result
  `);
  const detail = expectOneRow(result, "the dashboard task detail procedure").result;
  if (!detail) return null;
  const projected = {
    ...detail,
    durability: projectDurability(detail.identity.type, detail.payload),
  };
  return redactErrorStacks ? redactDashboardTaskDetailErrorStacks(projected) : projected;
}

/**
 * Read one saved checkpoint value.
 *
 * Task detail withholds a value larger than it carries inline and reports its size, so an operator
 * who opens that one value asks for it here instead of receiving every value on every open.
 */
export async function readDashboardCheckpointValue(
  database: DashboardDatabase,
  id: string,
  name: string,
): Promise<DashboardCheckpointValue | null> {
  const input = JSON.stringify({ id, name });
  const rows = await database.execute<{ result: DashboardCheckpointValue | null }>(sql`
    SELECT workhorse.dashboard_checkpoint_value_v1(${input}::jsonb) AS result
  `);
  return expectOneRow(rows, "the dashboard checkpoint value procedure").result;
}

/**
 * Read one task's whole stored payload or result.
 *
 * Task detail withholds either one when it is larger than it carries inline and reports its size,
 * so an operator who opens that one value asks for it here rather than receiving a megabyte on
 * every task they open.
 */
export async function readDashboardTaskValue(
  database: DashboardDatabase,
  id: string,
  kind: DashboardTaskValueKind,
): Promise<DashboardTaskValue | null> {
  const input = JSON.stringify({ id, kind });
  const rows = await database.execute<{ result: DashboardTaskValue | null }>(sql`
    SELECT workhorse.dashboard_task_value_v1(${input}::jsonb) AS result
  `);
  return expectOneRow(rows, "the dashboard task value procedure").result;
}

function redactErrorStack(error: unknown): unknown {
  if (error === null || typeof error !== "object" || Array.isArray(error)) return error;
  const redacted = { ...(error as Record<string, unknown>) };
  delete redacted.stack;
  return redacted;
}

/** Remove persisted worker stacks while leaving user payloads, results, and event details intact. */
export function redactDashboardTaskDetailErrorStacks(
  detail: DashboardTaskDetail,
): DashboardTaskDetail {
  return {
    ...detail,
    childLineage: {
      ...detail.childLineage,
      records: detail.childLineage.records.map((record) => ({
        ...record,
        error: redactErrorStack(record.error),
      })),
    },
    current: {
      ...detail.current,
      runtime: detail.current.runtime
        ? { ...detail.current.runtime, error: redactErrorStack(detail.current.runtime.error) }
        : null,
      outcome: detail.current.outcome
        ? { ...detail.current.outcome, error: redactErrorStack(detail.current.outcome.error) }
        : null,
      error: redactErrorStack(detail.current.error),
    },
    batchExecutions: detail.batchExecutions.map((execution) => ({
      ...execution,
      members: execution.members.map((member) => ({
        ...member,
        error: redactErrorStack(member.error),
      })),
    })),
    attempts: detail.attempts.map((attempt) => ({
      ...attempt,
      error: redactErrorStack(attempt.error),
    })),
  };
}

/**
 * @internal Package-internal. `readDashboardEvents` names it in its signature, so declaration emit
 * needs the export; no subpath re-exports it.
 */
export interface DashboardEventsQuery {
  worker?: string | null;
  search?: string | null;
  window?: DashboardEventsWindow;
  /** Inclusive ISO-8601 lower bound. Must be supplied with `rangeEnd`. */
  rangeStart?: string | null;
  /** Exclusive ISO-8601 upper bound. Must be supplied with `rangeStart`. */
  rangeEnd?: string | null;
  /** 1-based page index. */
  page?: number;
  pageSize?: number;
  /** Whether to count every matching record. Defaults to the page's own proven total. */
  count?: DashboardListingCount;
  kind?: DashboardEventKind | "all";
  queue?: string | null;
  taskType?: string | null;
  /** Lifecycle event names and attempt outcomes to keep. Empty means every type. */
  types?: readonly string[];
  /** Restrict the feed to one task, for following a single task live. */
  taskId?: string | null;
}

/**
 * Read the fleet-wide event feed from the durable history tables.
 *
 * The feed is sourced from `task_event` and `attempt_history`, never from `LISTEN`/`NOTIFY`.
 * Notification payloads carry only a queue name, are coalesced by both the worker and the dashboard
 * listener, and are dropped entirely while no session is listening — a feed built from them would
 * be uninformative and silently incomplete. The notification channels keep their real task of
 * telling this page *when* to re-read; the rows below are what it shows.
 *
 * Every query is bounded by a time window so the descending scan stays on
 * `task_event (occurred_at, event_id)` and `attempt_history (occurred_at, attempt_id)` instead of
 * walking the whole retained history to fill a page that a narrow filter would otherwise starve.
 * The window is also what keeps the total count affordable: it is a count over one bounded slice of
 * two partitioned tables, not over everything retention still holds.
 */
export async function readDashboardEvents(
  database: DashboardDatabase,
  query: DashboardEventsQuery = {},
): Promise<DashboardEventsPage> {
  const input = JSON.stringify(query);
  const rows = await database.execute<{ result: DashboardEventsPage }>(sql`
    SELECT workhorse.dashboard_events_v1(${input}::jsonb) AS result
  `);
  return expectOneRow(rows, "the dashboard events procedure").result;
}

/**
 * Read one history record by the stable identity used in Events URLs.
 *
 * An attempt record carries the whole persisted error, so this honours `redactErrorStacks` exactly
 * as task detail does. Both surfaces project the same `attempt_history.error`, and a host that
 * withholds container paths from one door has to withhold them from the other.
 */
export async function readDashboardEventDetail(
  database: DashboardDatabase,
  id: string,
  redactErrorStacks = false,
): Promise<DashboardEventDetail | null> {
  const input = JSON.stringify({ id });
  const rows = await database.execute<{ result: DashboardEventDetail | null }>(sql`
    SELECT workhorse.dashboard_event_detail_v1(${input}::jsonb) AS result
  `);
  const detail = expectOneRow(rows, "the dashboard event detail procedure").result;
  if (!detail || !redactErrorStacks) return detail;
  return { ...detail, error: redactErrorStack(detail.error) };
}
