import { sql } from "drizzle-orm";
import type { Queue } from "@workhorse/core";
import type { DashboardOperator, DemoDatabase } from "./app.js";

export interface DashboardQueueRow {
  queue: string;
  state: string;
  count: number;
  oldestMs: number | null;
}

export interface DashboardJobRow extends Record<string, unknown> {
  id: string;
  queue: string;
  type: string;
  state: string;
  attempt: number;
  maxAttempts: number;
  payload: unknown;
  runAt: string | null;
  workerId: string | null;
  finishedAt: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DashboardScheduleRow {
  kind: "user" | "system";
  identity: {
    kind: "user" | "system";
    namespace: string;
    name: string;
  };
  namespace: string;
  name: string;
  description: string | null;
  cron: string;
  queue: string | null;
  type: string;
  enabled: boolean;
  active: boolean;
  revision: string;
  updatedAt: string;
  occurrenceCount: number;
  lastFiredAt: string | null;
  lastRun?: {
    status: string;
    startedAt: string | null;
    endedAt: string | null;
    message: string | null;
  } | null;
  maintenance?: {
    intervalMs: number;
    phases: string[];
  } | null;
}

export interface MaintenanceLoopCadences {
  tickIntervalMs: number;
  housekeepingIntervalMs: number;
}

export interface DashboardWorkerRow {
  id: string;
  activeJobs: number;
  completedAttempts: number;
  failedAttempts: number;
  averageExecutionMs: number | null;
  lastSeenAt: string | null;
  paused: boolean;
  status: "active" | "idle" | "recent" | "offline";
}

export interface DashboardFailureRow {
  id: string;
  queue: string;
  type: string;
  attempt: number;
  finishedAt: string;
  error: unknown;
}

export type DashboardTaskFilter =
  | "all"
  | "scheduled"
  | "retried"
  | "queued"
  | "running"
  | "completed"
  | "discarded";

export type DashboardTaskCounts = Record<DashboardTaskFilter, number>;

export type DashboardActivityPeriod = "15m" | "1h" | "6h" | "24h" | "7d";

export type DashboardActivityGroupBy = "queue" | "worker" | "task";

export interface DashboardActivityBucket {
  bucketStart: string;
  counts: Record<string, number>;
}

export interface DashboardActivityPage {
  capturedAt: string;
  filter: DashboardTaskFilter;
  period: DashboardActivityPeriod;
  groupBy: DashboardActivityGroupBy;
  bucketSeconds: number;
  groups: string[];
  buckets: DashboardActivityBucket[];
}

export interface DashboardTasksPage {
  capturedAt: string;
  filter: DashboardTaskFilter;
  page: number;
  pageSize: number;
  total: number;
  counts: DashboardTaskCounts;
  jobs: DashboardJobRow[];
}

export interface DashboardCronPage {
  capturedAt: string;
  schedules: DashboardScheduleRow[];
}

export interface DashboardSystemPage {
  capturedAt: string;
  queues: DashboardQueueRow[];
  failures: DashboardFailureRow[];
  health: Awaited<ReturnType<Queue["health"]>>;
}

export interface DashboardWorkersPage {
  capturedAt: string;
  canManageWorkers: boolean;
  workers: DashboardWorkerRow[];
}

export interface DashboardMetricBucket {
  bucketStart: string;
  enqueued: number;
  succeeded: number;
  failed: number;
  retried: number;
  active: number;
  averageDurationMs: number | null;
}

export interface DashboardJobDetail {
  identity: {
    id: string;
    queue: string;
    type: string;
    state: string;
    createdAt: string;
  };
  payload: unknown;
  current: {
    runtime: {
      state: string;
      attempt: number;
      runAt: string;
      readyAt: string | null;
      workerId: string | null;
      heartbeatAt: string | null;
      error: unknown;
    } | null;
    outcome: {
      state: string;
      attempt: number;
      finishedAt: string;
      result: unknown;
      error: unknown;
    } | null;
    result: unknown;
    error: unknown;
  };
  attempts: Array<{
    attempt: number;
    workerId: string;
    outcome: string;
    startedAt: string;
    finishedAt: string;
    durationMs: number;
    error: unknown;
  }>;
  events: Array<{
    id: string;
    attempt: number | null;
    type: string;
    details: unknown;
    occurredAt: string;
  }>;
}

export interface DashboardSnapshot {
  capturedAt: string;
  operatorPolicy: {
    mode: "read-only" | "local";
    supportedMutations: Array<"enqueueTest" | "setScheduleEnabled" | "setWorkerPaused">;
    requiredAuditContext: readonly ["actor", "reason", "requestId", "occurredAt"];
  };
  queues: DashboardQueueRow[];
  jobs: DashboardJobRow[];
  schedules: DashboardScheduleRow[];
  workers: DashboardWorkerRow[];
  failures: DashboardFailureRow[];
  metrics: {
    windowSeconds: 7200;
    bucketSeconds: 30;
    buckets: DashboardMetricBucket[];
  };
  health: Awaited<ReturnType<Queue["health"]>>;
}

function toIso(value: Date | string): string {
  return new Date(value).toISOString();
}

function toIsoOrNull(value: Date | string | null): string | null {
  return value ? toIso(value) : null;
}

/** Extract the human-readable message from a stored error envelope without shipping stacks. */
function errorMessageOrNull(error: unknown): string | null {
  if (error && typeof error === "object" && "message" in error) {
    const message = (error as { message: unknown }).message;
    if (typeof message === "string" && message.length > 0) return message;
  }
  return null;
}

function operatorPolicy(
  operator: DashboardOperator | undefined,
): DashboardSnapshot["operatorPolicy"] {
  if (operator?.mode !== "local") {
    return {
      mode: "read-only",
      supportedMutations: [],
      requiredAuditContext: ["actor", "reason", "requestId", "occurredAt"],
    };
  }
  return {
    mode: "local",
    supportedMutations: ["enqueueTest", "setScheduleEnabled", "setWorkerPaused"],
    requiredAuditContext: ["actor", "reason", "requestId", "occurredAt"],
  };
}

function workerValues(workers: readonly string[]) {
  return sql.join(
    workers.map((worker) => sql`(${worker})`),
    sql`, `,
  );
}

function taskFilterCondition(filter: DashboardTaskFilter) {
  if (filter === "scheduled") return sql`state = 'scheduled'`;
  if (filter === "retried") return sql`attempt > 1`;
  if (filter === "queued") return sql`state = 'ready'`;
  if (filter === "running") return sql`state = 'active'`;
  if (filter === "completed") return sql`state = 'succeeded'`;
  if (filter === "discarded") return sql`state = 'failed'`;
  return sql`true`;
}

/**
 * Above this size, sidebar counts switch from exact scans to planner estimates.
 * job_runtime stays small by design (live jobs only), so it is always counted
 * exactly; job and job_outcome grow without bound.
 */
const approximateCountThreshold = 50_000;

/** Planner row estimate for a query (PostgreSQL wiki "count estimate" technique). */
async function estimateRows(database: DemoDatabase, query: ReturnType<typeof sql>) {
  const plan = await database.execute<Record<string, unknown>>(sql`EXPLAIN (FORMAT JSON) ${query}`);
  const cell = Object.values(plan.rows[0] ?? {})[0];
  const parsed: unknown = typeof cell === "string" ? JSON.parse(cell) : cell;
  const rows = (parsed as Array<{ Plan?: { "Plan Rows"?: number } }>)[0]?.Plan?.["Plan Rows"];
  return typeof rows === "number" ? Math.max(0, Math.round(rows)) : 0;
}

export async function readDashboardTaskCounts(
  database: DemoDatabase,
): Promise<DashboardTaskCounts> {
  const relRows = await database.execute<{ estimate: string | number }>(sql`
    SELECT reltuples::bigint AS estimate FROM pg_class WHERE oid = 'workhorse.job'::regclass
  `);
  const jobEstimate = Number(relRows.rows[0]?.estimate ?? -1);
  // reltuples is -1 until the first vacuum/analyze; treat unknown as small.
  if (jobEstimate < approximateCountThreshold) {
    return readDashboardTaskCountsExact(database);
  }

  const runtimeRows = await database.execute<{
    scheduled_count: number;
    queued_count: number;
    running_count: number;
    retried_live_count: number;
  }>(sql`
    SELECT count(*) FILTER (WHERE state = 'scheduled')::integer AS scheduled_count,
           count(*) FILTER (WHERE state = 'ready')::integer AS queued_count,
           count(*) FILTER (WHERE state = 'active')::integer AS running_count,
           count(*) FILTER (WHERE current_attempt > 1)::integer AS retried_live_count
      FROM workhorse.job_runtime
  `);
  const live = runtimeRows.rows[0]!;
  const [completed, discarded, retriedTerminal] = await Promise.all([
    estimateRows(database, sql`SELECT 1 FROM workhorse.job_outcome WHERE state = 'succeeded'`),
    estimateRows(database, sql`SELECT 1 FROM workhorse.job_outcome WHERE state = 'failed'`),
    estimateRows(database, sql`SELECT 1 FROM workhorse.job_outcome WHERE current_attempt > 1`),
  ]);

  return {
    all: jobEstimate,
    scheduled: live.scheduled_count,
    retried: live.retried_live_count + retriedTerminal,
    queued: live.queued_count,
    running: live.running_count,
    completed,
    discarded,
  };
}

async function readDashboardTaskCountsExact(database: DemoDatabase): Promise<DashboardTaskCounts> {
  const countRows = await database.execute<{
    all_count: number;
    scheduled_count: number;
    retried_count: number;
    queued_count: number;
    running_count: number;
    completed_count: number;
    discarded_count: number;
  }>(sql`
    WITH tasks AS (
      SELECT COALESCE(r.state, o.state) AS state,
             COALESCE(r.current_attempt, o.current_attempt) AS attempt
        FROM workhorse.job j
        LEFT JOIN workhorse.job_runtime r ON r.job_id = j.id
        LEFT JOIN workhorse.job_outcome o ON o.job_id = j.id
    )
    SELECT count(*)::integer AS all_count,
           count(*) FILTER (WHERE state = 'scheduled')::integer AS scheduled_count,
           count(*) FILTER (WHERE attempt > 1)::integer AS retried_count,
           count(*) FILTER (WHERE state = 'ready')::integer AS queued_count,
           count(*) FILTER (WHERE state = 'active')::integer AS running_count,
           count(*) FILTER (WHERE state = 'succeeded')::integer AS completed_count,
           count(*) FILTER (WHERE state = 'failed')::integer AS discarded_count
      FROM tasks
  `);
  const counts = countRows.rows[0]!;

  return {
    all: counts.all_count,
    scheduled: counts.scheduled_count,
    retried: counts.retried_count,
    queued: counts.queued_count,
    running: counts.running_count,
    completed: counts.completed_count,
    discarded: counts.discarded_count,
  };
}

/** Legend cap for the activity chart; overflow groups are folded into "other". */
const maxActivityGroups = 10;
const otherActivityGroup = "other";

export const activityPeriods: Record<
  DashboardActivityPeriod,
  { windowSeconds: number; bucketSeconds: number }
> = {
  "15m": { windowSeconds: 15 * 60, bucketSeconds: 30 },
  "1h": { windowSeconds: 60 * 60, bucketSeconds: 2 * 60 },
  "6h": { windowSeconds: 6 * 60 * 60, bucketSeconds: 10 * 60 },
  "24h": { windowSeconds: 24 * 60 * 60, bucketSeconds: 60 * 60 },
  "7d": { windowSeconds: 7 * 24 * 60 * 60, bucketSeconds: 6 * 60 * 60 },
};

/** Bucketed task activity over a trailing window, grouped by queue, worker, or task type. */
export async function readDashboardActivity(
  database: DemoDatabase,
  filter: DashboardTaskFilter,
  period: DashboardActivityPeriod,
  groupBy: DashboardActivityGroupBy = "queue",
): Promise<DashboardActivityPage> {
  const { windowSeconds, bucketSeconds } = activityPeriods[period];
  const groupExpression =
    groupBy === "queue"
      ? sql`j.queue_name`
      : groupBy === "task"
        ? sql`j.job_type`
        : sql`COALESCE(r.worker_id, attempt_worker.worker_id, 'unassigned')`;
  const rows = await database.execute<{
    bucket_start: Date | string;
    group_key: string | null;
    count: number;
  }>(sql`
    WITH tasks AS (
      SELECT ${groupExpression} AS group_key,
             COALESCE(r.state, o.state) AS state,
             COALESCE(r.current_attempt, o.current_attempt) AS attempt,
             COALESCE(r.updated_at, o.updated_at, j.created_at) AS updated_at
        FROM workhorse.job j
        LEFT JOIN workhorse.job_runtime r ON r.job_id = j.id
        LEFT JOIN workhorse.job_outcome o ON o.job_id = j.id
        LEFT JOIN LATERAL (
          SELECT ah.worker_id
            FROM workhorse.attempt_history ah
           WHERE ah.job_id = j.id
           ORDER BY ah.attempt DESC
           LIMIT 1
        ) attempt_worker ON ${groupBy === "worker" ? sql`true` : sql`false`}
    ), buckets AS (
      SELECT generate_series(
        date_bin(
          make_interval(secs => ${bucketSeconds}),
          clock_timestamp() - make_interval(secs => ${windowSeconds}),
          timestamp with time zone '2000-01-01'
        ) + make_interval(secs => ${bucketSeconds}),
        date_bin(
          make_interval(secs => ${bucketSeconds}),
          clock_timestamp(),
          timestamp with time zone '2000-01-01'
        ),
        make_interval(secs => ${bucketSeconds})
      ) AS bucket_start
    )
    SELECT b.bucket_start, t.group_key, count(t.updated_at)::integer AS count
      FROM buckets b
      LEFT JOIN tasks t
        ON t.updated_at >= b.bucket_start
       AND t.updated_at < b.bucket_start + make_interval(secs => ${bucketSeconds})
       AND ${taskFilterCondition(filter)}
     GROUP BY b.bucket_start, t.group_key
     ORDER BY b.bucket_start
  `);
  const totals = new Map<string, number>();
  for (const row of rows.rows) {
    if (row.group_key === null) continue;
    totals.set(row.group_key, (totals.get(row.group_key) ?? 0) + row.count);
  }
  // Cap the legend at 10 entries: keep the 9 busiest groups and fold the rest into "other".
  const ranked = [...totals.entries()]
    // oxlint-disable-next-line unicorn/no-array-sort -- ES2022 lacks Array.prototype.toSorted.
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([group]) => group);
  const kept = ranked.length > maxActivityGroups ? ranked.slice(0, maxActivityGroups - 1) : ranked;
  const keptSet = new Set(kept);
  const hasOther = ranked.length > keptSet.size;
  // oxlint-disable-next-line unicorn/no-array-sort -- ES2022 lacks Array.prototype.toSorted.
  const groups = [...kept].sort();
  if (hasOther) groups.push(otherActivityGroup);
  const byBucket = new Map<string, DashboardActivityBucket>();
  for (const row of rows.rows) {
    const bucketStart = toIso(row.bucket_start);
    let bucket = byBucket.get(bucketStart);
    if (!bucket) {
      bucket = { bucketStart, counts: {} };
      byBucket.set(bucketStart, bucket);
    }
    if (row.group_key === null) continue;
    const key = keptSet.has(row.group_key) ? row.group_key : otherActivityGroup;
    bucket.counts[key] = (bucket.counts[key] ?? 0) + row.count;
  }
  return {
    capturedAt: new Date().toISOString(),
    filter,
    period,
    groupBy,
    bucketSeconds,
    groups,
    buckets: [...byBucket.values()],
  };
}

export async function readDashboardTasks(
  database: DemoDatabase,
  filter: DashboardTaskFilter,
  page: number,
  pageSize: number,
): Promise<DashboardTasksPage> {
  const offset = (page - 1) * pageSize;
  const [counts, jobRows] = await Promise.all([
    readDashboardTaskCounts(database),
    database.execute<{
      id: string;
      queue: string;
      type: string;
      state: string;
      attempt: number;
      max_attempts: number;
      payload: unknown;
      run_at: Date | string | null;
      worker_id: string | null;
      finished_at: Date | string | null;
      error: unknown;
      created_at: Date | string;
      updated_at: Date | string;
    }>(sql`
      WITH tasks AS (
        SELECT j.id, j.queue_name AS queue, j.job_type AS type,
               COALESCE(r.state, o.state) AS state,
               COALESCE(r.current_attempt, o.current_attempt) AS attempt,
               j.max_attempts, j.payload,
               COALESCE(r.run_at, o.run_at) AS run_at,
               r.worker_id, o.finished_at,
               COALESCE(o.error, r.error) AS error,
               j.created_at,
               COALESCE(r.updated_at, o.updated_at, j.created_at) AS updated_at
          FROM workhorse.job j
          LEFT JOIN workhorse.job_runtime r ON r.job_id = j.id
          LEFT JOIN workhorse.job_outcome o ON o.job_id = j.id
      )
      SELECT *
        FROM tasks
       WHERE ${taskFilterCondition(filter)}
       ORDER BY updated_at DESC, id DESC
       LIMIT ${pageSize}
      OFFSET ${offset}
    `),
  ]);
  return {
    capturedAt: new Date().toISOString(),
    filter,
    page,
    pageSize,
    total: counts[filter],
    counts,
    jobs: jobRows.rows.map((row) => ({
      id: row.id,
      queue: row.queue,
      type: row.type,
      state: row.state,
      attempt: row.attempt,
      maxAttempts: row.max_attempts,
      payload: row.payload,
      runAt: toIsoOrNull(row.run_at),
      workerId: row.worker_id,
      finishedAt: toIsoOrNull(row.finished_at),
      errorMessage: errorMessageOrNull(row.error),
      createdAt: toIso(row.created_at),
      updatedAt: toIso(row.updated_at),
    })),
  };
}

/** Display-only schedule descriptions; the core schema deliberately has no description column. */
const scheduleDescriptions: Record<string, string> = {
  "workhorse:tick": "Promotes due jobs to ready and recovers expired leases.",
  "workhorse:housekeeping": "Prunes old schedule occurrences and replenishes history partitions.",
  "workhorse-demo:heartbeat":
    "Enqueues a recurring heartbeat job every minute to keep the demo lively.",
  "workhorse-demo:demo.report": "Generates a queue-health report every five minutes.",
};

function scheduleDescription(namespace: string, name: string): string | null {
  return scheduleDescriptions[`${namespace}:${name}`] ?? null;
}

function systemMaintenanceSchedules(
  now: Date,
  cadences: MaintenanceLoopCadences,
): DashboardScheduleRow[] {
  const updatedAt = now.toISOString();
  return [
    {
      kind: "system",
      identity: { kind: "system", namespace: "workhorse", name: "tick" },
      namespace: "workhorse",
      name: "tick",
      description: scheduleDescription("workhorse", "tick"),
      cron: `every ${cadences.tickIntervalMs}ms`,
      queue: null,
      type: "workhorse.tick_v1",
      enabled: true,
      active: true,
      revision: "1",
      updatedAt,
      occurrenceCount: 0,
      lastFiredAt: null,
      lastRun: null,
      maintenance: {
        intervalMs: cadences.tickIntervalMs,
        phases: ["promote", "recover"],
      },
    },
    {
      kind: "system",
      identity: { kind: "system", namespace: "workhorse", name: "housekeeping" },
      namespace: "workhorse",
      name: "housekeeping",
      description: scheduleDescription("workhorse", "housekeeping"),
      cron: `every ${cadences.housekeepingIntervalMs}ms`,
      queue: null,
      type: "workhorse.housekeep_v1",
      enabled: true,
      active: true,
      revision: "1",
      updatedAt,
      occurrenceCount: 0,
      lastFiredAt: null,
      lastRun: null,
      maintenance: {
        intervalMs: cadences.housekeepingIntervalMs,
        phases: ["history_partitions", "schedule_occurrences"],
      },
    },
  ];
}

export async function readDashboardCron(
  database: DemoDatabase,
  maintenanceLoops: MaintenanceLoopCadences,
): Promise<DashboardCronPage> {
  const now = new Date();
  const scheduleRows = await database.execute<{
    namespace: string;
    name: string;
    cron: string;
    queue: string;
    type: string;
    enabled: boolean;
    revision: string;
    updated_at: Date | string;
    occurrence_count: number;
    last_fired_at: Date | string | null;
  }>(sql`
      SELECT d.namespace, d.schedule_name AS name, d.cron_expression AS cron,
             d.queue_name AS queue, d.job_type AS type, d.enabled,
             d.revision::text AS revision, d.updated_at,
             count(o.occurrence_at)::integer AS occurrence_count,
             max(o.fired_at) AS last_fired_at
        FROM workhorse.schedule_definition d
        LEFT JOIN workhorse.schedule_occurrence o
          ON o.namespace = d.namespace AND o.schedule_name = d.schedule_name
       GROUP BY d.namespace, d.schedule_name
       ORDER BY d.namespace, d.schedule_name
       LIMIT 50
    `);

  return {
    capturedAt: now.toISOString(),
    schedules: [
      ...systemMaintenanceSchedules(now, maintenanceLoops),
      ...scheduleRows.rows.map((row) => {
        return {
          kind: "user" as const,
          identity: { kind: "user" as const, namespace: row.namespace, name: row.name },
          namespace: row.namespace,
          name: row.name,
          description: scheduleDescription(row.namespace, row.name),
          cron: row.cron,
          queue: row.queue,
          type: row.type,
          enabled: row.enabled,
          active: row.enabled,
          revision: row.revision,
          updatedAt: toIso(row.updated_at),
          occurrenceCount: row.occurrence_count,
          lastFiredAt: toIsoOrNull(row.last_fired_at),
          lastRun: null,
          maintenance: null,
        };
      }),
    ],
  };
}

export async function readDashboardSystem(
  database: DemoDatabase,
  queue: Queue,
): Promise<DashboardSystemPage> {
  const [queueRows, failureRows, health] = await Promise.all([
    database.execute<{
      queue: string;
      state: string;
      count: number;
      oldest_ms: number | null;
    }>(sql`
      SELECT queue_name AS queue, state, count(*)::integer AS count,
             extract(epoch FROM clock_timestamp() - min(COALESCE(ready_at, run_at))) * 1000
               AS oldest_ms
        FROM workhorse.job_runtime
       GROUP BY queue_name, state
       ORDER BY queue_name, state
    `),
    database.execute<{
      id: string;
      queue: string;
      type: string;
      attempt: number;
      finished_at: Date | string;
      error: unknown;
    }>(sql`
      SELECT j.id, j.queue_name AS queue, j.job_type AS type,
             o.current_attempt AS attempt, o.finished_at, o.error
        FROM workhorse.job_outcome o
        JOIN workhorse.job j ON j.id = o.job_id
       WHERE o.state = 'failed'
       ORDER BY o.finished_at DESC, j.id DESC
       LIMIT 50
    `),
    queue.health(),
  ]);

  return {
    capturedAt: new Date().toISOString(),
    queues: queueRows.rows.map((row) => ({
      queue: row.queue,
      state: row.state,
      count: row.count,
      oldestMs: row.oldest_ms,
    })),
    failures: failureRows.rows.map((row) => ({
      id: row.id,
      queue: row.queue,
      type: row.type,
      attempt: row.attempt,
      finishedAt: toIso(row.finished_at),
      error: row.error,
    })),
    health,
  };
}

export async function readDashboardWorkers(
  database: DemoDatabase,
  configuredWorkers: readonly string[],
  workerStates: ReadonlyMap<string, { paused: boolean }> = new Map(),
  canManageWorkers = false,
): Promise<DashboardWorkersPage> {
  const now = new Date();
  const workerRows = await database.execute<{
    id: string;
    active_jobs: number;
    completed_attempts: number;
    failed_attempts: number;
    average_execution_ms: number | null;
    last_seen_at: Date | string | null;
  }>(sql`
    WITH configured(id) AS (
      VALUES ${workerValues(configuredWorkers)}
    ), active AS (
      SELECT worker_id AS id, count(*)::integer AS active_jobs, max(acquired_at) AS last_seen_at
        FROM workhorse.job_runtime
       WHERE state = 'active' AND worker_id IN (SELECT id FROM configured)
       GROUP BY worker_id
    ), recent_history AS (
      -- Exact counts are cheap here because both time predicates keep partition scans to one hour.
      SELECT worker_id AS id, count(*)::integer AS completed_attempts,
             count(*) FILTER (WHERE outcome = 'failed')::integer AS failed_attempts,
             avg(extract(epoch FROM finished_at - started_at) * 1000)::double precision
               AS average_execution_ms,
             max(finished_at) AS last_seen_at
        FROM workhorse.attempt_history
       WHERE occurred_at >= clock_timestamp() - interval '1 hour'
         AND finished_at >= clock_timestamp() - interval '1 hour'
         AND worker_id IN (SELECT id FROM configured)
       GROUP BY worker_id
    )
    SELECT c.id, COALESCE(a.active_jobs, 0)::integer AS active_jobs,
           COALESCE(h.completed_attempts, 0)::integer AS completed_attempts,
           COALESCE(h.failed_attempts, 0)::integer AS failed_attempts,
           h.average_execution_ms,
           GREATEST(a.last_seen_at, h.last_seen_at) AS last_seen_at
      FROM configured c
      LEFT JOIN active a ON a.id = c.id
      LEFT JOIN recent_history h ON h.id = c.id
     ORDER BY c.id
  `);

  return {
    capturedAt: now.toISOString(),
    canManageWorkers,
    workers: workerRows.rows.map((row) => {
      const state = workerStates.get(row.id);
      return {
        id: row.id,
        activeJobs: row.active_jobs,
        completedAttempts: row.completed_attempts,
        failedAttempts: row.failed_attempts,
        averageExecutionMs: row.average_execution_ms,
        lastSeenAt: toIsoOrNull(row.last_seen_at),
        paused: state?.paused ?? false,
        status:
          row.active_jobs > 0
            ? "active"
            : state
              ? "idle"
              : row.last_seen_at &&
                  new Date(row.last_seen_at).getTime() >= now.getTime() - 5 * 60_000
                ? "recent"
                : "offline",
      };
    }),
  };
}

export async function readDashboardSnapshot(
  database: DemoDatabase,
  queue: Queue,
  configuredWorkers: readonly string[],
  operator?: DashboardOperator,
): Promise<DashboardSnapshot> {
  const now = new Date();
  const [queueRows, jobRows, scheduleRows, workerRows, failureRows, metricRows, health] =
    await Promise.all([
      database.execute<{
        queue: string;
        state: string;
        count: number;
        oldest_ms: number | null;
      }>(sql`
        SELECT queue_name AS queue, state, count(*)::integer AS count,
               extract(epoch FROM clock_timestamp() - min(COALESCE(ready_at, run_at))) * 1000
                 AS oldest_ms
          FROM workhorse.job_runtime
         GROUP BY queue_name, state
         ORDER BY queue_name, state
      `),
      database.execute<{
        id: string;
        queue: string;
        type: string;
        state: string;
        attempt: number;
        max_attempts: number;
        payload: unknown;
        run_at: Date | string | null;
        worker_id: string | null;
        finished_at: Date | string | null;
        error: unknown;
        created_at: Date | string;
        updated_at: Date | string;
      }>(sql`
        SELECT j.id, j.queue_name AS queue, j.job_type AS type,
               COALESCE(r.state, o.state) AS state,
               COALESCE(r.current_attempt, o.current_attempt) AS attempt,
               j.max_attempts, j.payload,
               COALESCE(r.run_at, o.run_at) AS run_at,
               r.worker_id, o.finished_at,
               COALESCE(o.error, r.error) AS error,
               j.created_at,
               COALESCE(r.updated_at, o.updated_at, j.created_at) AS updated_at
          FROM workhorse.job j
          LEFT JOIN workhorse.job_runtime r ON r.job_id = j.id
          LEFT JOIN workhorse.job_outcome o ON o.job_id = j.id
         ORDER BY COALESCE(r.updated_at, o.updated_at, j.created_at) DESC, j.id DESC
         LIMIT 50
      `),
      database.execute<{
        namespace: string;
        name: string;
        cron: string;
        queue: string;
        type: string;
        enabled: boolean;
        revision: string;
        updated_at: Date | string;
        occurrence_count: number;
        last_fired_at: Date | string | null;
      }>(sql`
        SELECT d.namespace, d.schedule_name AS name, d.cron_expression AS cron,
               d.queue_name AS queue, d.job_type AS type, d.enabled,
               d.revision::text AS revision, d.updated_at,
               count(o.occurrence_at)::integer AS occurrence_count,
               max(o.fired_at) AS last_fired_at
          FROM workhorse.schedule_definition d
          LEFT JOIN workhorse.schedule_occurrence o
            ON o.namespace = d.namespace AND o.schedule_name = d.schedule_name
         GROUP BY d.namespace, d.schedule_name
         ORDER BY d.namespace, d.schedule_name
         LIMIT 50
      `),
      database.execute<{
        id: string;
        active_jobs: number;
        completed_attempts: number;
        last_seen_at: Date | string | null;
      }>(sql`
        WITH configured(id) AS (
          VALUES ${workerValues(configuredWorkers)}
        ), observed AS (
          SELECT worker_id AS id, count(*)::integer AS active_jobs, 0::integer AS completed_attempts,
                 max(heartbeat_at) AS last_seen_at
            FROM workhorse.job_runtime
           WHERE state = 'active' AND worker_id IN (SELECT id FROM configured)
           GROUP BY worker_id
          UNION ALL
          SELECT worker_id AS id, 0::integer AS active_jobs,
                 count(*)::integer AS completed_attempts, max(finished_at) AS last_seen_at
            FROM workhorse.attempt_history
           WHERE occurred_at >= clock_timestamp() - interval '5 minutes'
             AND worker_id IN (SELECT id FROM configured)
           GROUP BY worker_id
        )
        SELECT c.id, COALESCE(sum(o.active_jobs), 0)::integer AS active_jobs,
               COALESCE(sum(o.completed_attempts), 0)::integer AS completed_attempts,
               max(o.last_seen_at) AS last_seen_at
          FROM configured c
          LEFT JOIN observed o ON o.id = c.id
         GROUP BY c.id
         ORDER BY c.id
      `),
      database.execute<{
        id: string;
        queue: string;
        type: string;
        attempt: number;
        finished_at: Date | string;
        error: unknown;
      }>(sql`
        SELECT j.id, j.queue_name AS queue, j.job_type AS type,
               o.current_attempt AS attempt, o.finished_at, o.error
          FROM workhorse.job_outcome o
          JOIN workhorse.job j ON j.id = o.job_id
         WHERE o.state = 'failed'
         ORDER BY o.finished_at DESC, j.id DESC
         LIMIT 50
      `),
      database.execute<{
        bucket_start: Date | string;
        enqueued: number;
        succeeded: number;
        failed: number;
        retried: number;
        active: number;
        average_duration_ms: number | null;
      }>(sql`
        WITH buckets AS (
          SELECT generate_series(
            date_bin('30 seconds', clock_timestamp() - interval '2 hours', timestamp with time zone '2000-01-01'),
            date_bin('30 seconds', clock_timestamp(), timestamp with time zone '2000-01-01'),
            interval '30 seconds'
          ) AS bucket_start
        ), events AS (
          SELECT date_bin('30 seconds', occurred_at, timestamp with time zone '2000-01-01') AS bucket_start,
                 count(*) FILTER (WHERE event_type = 'enqueued')::integer AS enqueued
            FROM workhorse.job_event
           WHERE occurred_at >= clock_timestamp() - interval '2 hours'
           GROUP BY 1
        ), attempts AS (
          SELECT date_bin('30 seconds', finished_at, timestamp with time zone '2000-01-01') AS bucket_start,
                 count(*) FILTER (WHERE outcome = 'succeeded')::integer AS succeeded,
                 count(*) FILTER (WHERE outcome = 'failed')::integer AS failed,
                 count(*) FILTER (WHERE outcome = 'retry')::integer AS retried,
                 avg(extract(epoch FROM finished_at - started_at) * 1000)::double precision AS average_duration_ms
            FROM workhorse.attempt_history
           WHERE finished_at >= clock_timestamp() - interval '2 hours'
           GROUP BY 1
        ), active AS (
          SELECT date_bin('30 seconds', acquired_at, timestamp with time zone '2000-01-01') AS bucket_start,
                 count(*)::integer AS active
            FROM workhorse.job_runtime
           WHERE state = 'active' AND acquired_at >= clock_timestamp() - interval '2 hours'
           GROUP BY 1
        )
        SELECT b.bucket_start,
               COALESCE(e.enqueued, 0)::integer AS enqueued,
               COALESCE(a.succeeded, 0)::integer AS succeeded,
               COALESCE(a.failed, 0)::integer AS failed,
               COALESCE(a.retried, 0)::integer AS retried,
               COALESCE(ac.active, 0)::integer AS active,
               a.average_duration_ms
          FROM buckets b
          LEFT JOIN events e USING (bucket_start)
          LEFT JOIN attempts a USING (bucket_start)
          LEFT JOIN active ac USING (bucket_start)
         ORDER BY b.bucket_start
      `),
      queue.health(),
    ]);

  return {
    capturedAt: now.toISOString(),
    operatorPolicy: operatorPolicy(operator),
    queues: queueRows.rows.map((row) => ({
      queue: row.queue,
      state: row.state,
      count: row.count,
      oldestMs: row.oldest_ms,
    })),
    jobs: jobRows.rows.map((row) => ({
      id: row.id,
      queue: row.queue,
      type: row.type,
      state: row.state,
      attempt: row.attempt,
      maxAttempts: row.max_attempts,
      payload: row.payload,
      runAt: toIsoOrNull(row.run_at),
      workerId: row.worker_id,
      finishedAt: toIsoOrNull(row.finished_at),
      errorMessage: errorMessageOrNull(row.error),
      createdAt: toIso(row.created_at),
      updatedAt: toIso(row.updated_at),
    })),
    schedules: scheduleRows.rows.map((row) => {
      return {
        kind: "user" as const,
        identity: { kind: "user" as const, namespace: row.namespace, name: row.name },
        namespace: row.namespace,
        name: row.name,
        description: scheduleDescription(row.namespace, row.name),
        cron: row.cron,
        queue: row.queue,
        type: row.type,
        enabled: row.enabled,
        active: row.enabled,
        revision: row.revision,
        updatedAt: toIso(row.updated_at),
        occurrenceCount: row.occurrence_count,
        lastFiredAt: toIsoOrNull(row.last_fired_at),
        lastRun: null,
        maintenance: null,
      };
    }),
    workers: workerRows.rows.map((row) => ({
      id: row.id,
      activeJobs: row.active_jobs,
      completedAttempts: row.completed_attempts,
      failedAttempts: 0,
      averageExecutionMs: null,
      lastSeenAt: toIsoOrNull(row.last_seen_at),
      paused: false,
      status:
        row.active_jobs > 0
          ? "active"
          : row.last_seen_at && new Date(row.last_seen_at).getTime() >= now.getTime() - 5 * 60_000
            ? "recent"
            : "offline",
    })),
    failures: failureRows.rows.map((row) => ({
      id: row.id,
      queue: row.queue,
      type: row.type,
      attempt: row.attempt,
      finishedAt: toIso(row.finished_at),
      error: row.error,
    })),
    metrics: {
      windowSeconds: 7200,
      bucketSeconds: 30,
      buckets: metricRows.rows.map((row) => ({
        bucketStart: toIso(row.bucket_start),
        enqueued: row.enqueued,
        succeeded: row.succeeded,
        failed: row.failed,
        retried: row.retried,
        active: row.active,
        averageDurationMs: row.average_duration_ms,
      })),
    },
    health,
  };
}

export async function readDashboardJobDetail(
  database: DemoDatabase,
  id: string,
): Promise<DashboardJobDetail | null> {
  const [jobRows, attemptRows, eventRows] = await Promise.all([
    database.execute<{
      id: string;
      queue: string;
      type: string;
      payload: unknown;
      created_at: Date | string;
      runtime_state: string | null;
      runtime_attempt: number | null;
      run_at: Date | string | null;
      ready_at: Date | string | null;
      worker_id: string | null;
      heartbeat_at: Date | string | null;
      runtime_error: unknown;
      outcome_state: string | null;
      outcome_attempt: number | null;
      finished_at: Date | string | null;
      result: unknown;
      outcome_error: unknown;
    }>(sql`
      SELECT j.id, j.queue_name AS queue, j.job_type AS type, j.payload, j.created_at,
             r.state AS runtime_state, r.current_attempt AS runtime_attempt, r.run_at, r.ready_at,
             r.worker_id, r.heartbeat_at, r.error AS runtime_error,
             o.state AS outcome_state, o.current_attempt AS outcome_attempt, o.finished_at,
             o.result, o.error AS outcome_error
        FROM workhorse.job j
        LEFT JOIN workhorse.job_runtime r ON r.job_id = j.id
        LEFT JOIN workhorse.job_outcome o ON o.job_id = j.id
       WHERE j.id = ${id}
    `),
    database.execute<{
      attempt: number;
      worker_id: string;
      outcome: string;
      started_at: Date | string;
      finished_at: Date | string;
      duration_ms: number;
      error: unknown;
    }>(sql`
      SELECT attempt, worker_id, outcome, started_at, finished_at,
             extract(epoch FROM finished_at - started_at) * 1000 AS duration_ms, error
        FROM workhorse.attempt_history
       WHERE job_id = ${id}
       ORDER BY attempt, attempt_id
    `),
    database.execute<{
      event_id: string;
      attempt: number | null;
      event_type: string;
      details: unknown;
      occurred_at: Date | string;
    }>(sql`
      SELECT event_id::text, attempt, event_type, details, occurred_at
        FROM workhorse.job_event
       WHERE job_id = ${id}
       ORDER BY occurred_at, event_id
    `),
  ]);

  const job = jobRows.rows[0];
  if (!job) return null;
  const state = job.outcome_state ?? job.runtime_state ?? "unknown";
  return {
    identity: {
      id: job.id,
      queue: job.queue,
      type: job.type,
      state,
      createdAt: toIso(job.created_at),
    },
    payload: job.payload,
    current: {
      runtime: job.runtime_state
        ? {
            state: job.runtime_state,
            attempt: job.runtime_attempt!,
            runAt: toIso(job.run_at!),
            readyAt: toIsoOrNull(job.ready_at),
            workerId: job.worker_id,
            heartbeatAt: toIsoOrNull(job.heartbeat_at),
            error: job.runtime_error,
          }
        : null,
      outcome: job.outcome_state
        ? {
            state: job.outcome_state,
            attempt: job.outcome_attempt!,
            finishedAt: toIso(job.finished_at!),
            result: job.result,
            error: job.outcome_error,
          }
        : null,
      result: job.result,
      error: job.outcome_error ?? job.runtime_error,
    },
    attempts: attemptRows.rows.map((row) => ({
      attempt: row.attempt,
      workerId: row.worker_id,
      outcome: row.outcome,
      startedAt: toIso(row.started_at),
      finishedAt: toIso(row.finished_at),
      durationMs: Number(row.duration_ms),
      error: row.error,
    })),
    events: eventRows.rows.map((row) => ({
      id: row.event_id,
      attempt: row.attempt,
      type: row.event_type,
      details: row.details,
      occurredAt: toIso(row.occurred_at),
    })),
  };
}
