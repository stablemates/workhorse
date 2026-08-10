import type { Queue, RetryPolicy } from "@workhorse/core";
import {
  DashboardActivityBucket,
  DashboardActivityGroupBy,
  DashboardActivityPage,
  DashboardActivityPeriod,
  DashboardCancellationRequest,
  DashboardCronPage,
  DashboardEventDetail,
  DashboardEventKind,
  DashboardEventsPage,
  DashboardEventsWindow,
  DashboardJobDetail,
  DashboardQueuesPage,
  DashboardRetentionCategory,
  DashboardRetentionCategoryRow,
  DashboardScheduleRow,
  DashboardSnapshot,
  DashboardStorageRelation,
  DashboardSystemPage,
  DashboardSystemRetention,
  DashboardSystemRetryBucket,
  DashboardSystemStorage,
  DashboardSystemWindow,
  DashboardTaskCounts,
  DashboardTaskFacets,
  DashboardTaskFilter,
  DashboardTasksPage,
  DashboardWorkerRow,
  DashboardWorkersPage,
  MaintenanceLoopCadences,
  readIdempotencyEvidence,
} from "../model.js";
import {
  statAttemptErrors,
  statAttempts,
  statCompleted,
  statWindow,
  statWindowStart,
} from "./rolling-stats.js";
import { sql, type DashboardDatabase, type DashboardSql } from "./sql.js";
import type { DashboardDurabilityProjector, DashboardOperator } from "./types.js";

function toIso(value: Date | string): string {
  return new Date(value).toISOString();
}

function toIsoOrNull(value: Date | string | null): string | null {
  return value ? toIso(value) : null;
}

/**
 * Cooperative cancellation stored beside one live runtime row, or null when none was requested.
 *
 * The three columns move together in SQL, so an incomplete record is treated as absent rather than
 * partially rendered: a half-populated cancellation claim would be worse than saying nothing.
 */
function cancellationRequest(
  requestedAt: Date | string | null,
  requestedBy: string | null,
  reason: string | null,
): DashboardCancellationRequest | null {
  if (requestedAt === null) return null;
  return {
    requestedAt: toIso(requestedAt),
    requestedBy: requestedBy && requestedBy.length > 0 ? requestedBy : null,
    reason: reason && reason.length > 0 ? reason : null,
  };
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
    supportedMutations: [
      "enqueueTest",
      "setScheduleEnabled",
      "setQueuePaused",
      "purgeQueue",
      "setWorkerPaused",
      "cancelTask",
    ],
    requiredAuditContext: ["actor", "reason", "requestId", "occurredAt"],
  };
}

function workerValues(workers: readonly string[]) {
  return sql.join(
    workers.map((worker) => sql`(${worker})`),
    sql`, `,
  );
}

/**
 * Declared worker identities as a relation, or an empty relation when none are declared.
 *
 * Declaring workers is optional now that live workers register themselves durably. It remains
 * useful for showing an expected fleet member that has never started.
 */
function declaredWorkerRows(workers: readonly string[]) {
  return workers.length === 0
    ? sql`SELECT NULL::text AS id WHERE false`
    : sql`SELECT id FROM (VALUES ${workerValues(workers)}) declared(id)`;
}

function textArrayExpression(values: readonly string[]) {
  return sql`ARRAY[${sql.join(
    values.map((value) => sql`${value}`),
    sql`, `,
  )}]::text[]`;
}

function taskFilterCondition(filter: DashboardTaskFilter) {
  if (filter === "scheduled") return sql`state = 'scheduled'`;
  if (filter === "retried") return sql`attempt > 1`;
  if (filter === "queued") return sql`state = 'ready'`;
  if (filter === "running") return sql`state = 'active'`;
  if (filter === "completed") return sql`state = 'succeeded'`;
  // Discarded means the handler exhausted its attempts. An operator-canceled task never lands
  // here: cancellation is its own terminal state and is never folded into failure.
  if (filter === "discarded") return sql`state = 'failed'`;
  if (filter === "canceled") return sql`state = 'canceled'`;
  return sql`true`;
}

function taskSearchPattern(search: string | null): string | null {
  if (!search) return null;
  // ILIKE is case-insensitive. User * is the only wildcard; literal !, %, and _ are escaped.
  return `%${search.replaceAll("!", "!!").replaceAll("%", "!%").replaceAll("_", "!_").replaceAll("*", "%")}%`;
}

function taskQueryCondition(options: {
  queue: string | null;
  worker: string | null;
  jobType: string | null;
  tags: readonly string[];
  searchPattern: string | null;
}) {
  const { queue, worker, jobType, tags, searchPattern } = options;
  const tagArray = textArrayExpression(tags);
  return sql`
    (${queue}::text IS NULL OR queue = ${queue})
    AND (${worker}::text IS NULL OR worker_id = ${worker})
    AND (${jobType}::text IS NULL OR type = ${jobType})
    -- Multiple selected tags use OR semantics through PostgreSQL array overlap.
    AND (cardinality(${tagArray}) = 0 OR tags && ${tagArray})
    AND (
      ${searchPattern}::text IS NULL
      OR type ILIKE ${searchPattern} ESCAPE '!'
      OR queue ILIKE ${searchPattern} ESCAPE '!'
      OR id::text ILIKE ${searchPattern} ESCAPE '!'
    )`;
}

/**
 * Above this size, sidebar counts switch from exact scans to planner estimates.
 * job_runtime stays small by design (live jobs only), so it is always counted
 * exactly; job and job_outcome grow without bound.
 */
const approximateCountThreshold = 50_000;

/** Planner row estimate for a query (PostgreSQL wiki "count estimate" technique). */
async function estimateRows(database: DashboardDatabase, query: ReturnType<typeof sql>) {
  const plan = await database.execute<Record<string, unknown>>(sql`EXPLAIN (FORMAT JSON) ${query}`);
  const cell = Object.values(plan.rows[0] ?? {})[0];
  const parsed: unknown = typeof cell === "string" ? JSON.parse(cell) : cell;
  const rows = (parsed as Array<{ Plan?: { "Plan Rows"?: number } }>)[0]?.Plan?.["Plan Rows"];
  return typeof rows === "number" ? Math.max(0, Math.round(rows)) : 0;
}

export async function readDashboardTaskCounts(
  database: DashboardDatabase,
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
  const [completed, discarded, canceled, retriedTerminal] = await Promise.all([
    estimateRows(database, sql`SELECT 1 FROM workhorse.job_outcome WHERE state = 'succeeded'`),
    estimateRows(database, sql`SELECT 1 FROM workhorse.job_outcome WHERE state = 'failed'`),
    estimateRows(database, sql`SELECT 1 FROM workhorse.job_outcome WHERE state = 'canceled'`),
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
    canceled,
  };
}

async function readDashboardTaskCountsExact(
  database: DashboardDatabase,
): Promise<DashboardTaskCounts> {
  const countRows = await database.execute<{
    all_count: number;
    scheduled_count: number;
    retried_count: number;
    queued_count: number;
    running_count: number;
    completed_count: number;
    discarded_count: number;
    canceled_count: number;
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
           count(*) FILTER (WHERE state = 'failed')::integer AS discarded_count,
           count(*) FILTER (WHERE state = 'canceled')::integer AS canceled_count
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
    canceled: counts.canceled_count,
  };
}

/** Queue management rows keep hot live-state counts exact and estimate cold outcomes at scale. */
export async function readDashboardQueues(
  database: DashboardDatabase,
): Promise<DashboardQueuesPage> {
  const [queueRows, relationRows] = await Promise.all([
    database.execute<{
      queue: string;
      paused: boolean;
      scheduled: number;
      ready: number;
      active: number;
    }>(sql`
      WITH known_queues AS (
        SELECT queue_name FROM workhorse.job
        UNION
        SELECT queue_name FROM workhorse.queue_control
      ), live_counts AS (
        SELECT queue_name,
               count(*) FILTER (WHERE state = 'scheduled')::integer AS scheduled,
               count(*) FILTER (WHERE state = 'ready')::integer AS ready,
               count(*) FILTER (WHERE state = 'active')::integer AS active
          FROM workhorse.job_runtime
         GROUP BY queue_name
      )
      SELECT known.queue_name AS queue, COALESCE(control.paused, false) AS paused,
             COALESCE(live.scheduled, 0)::integer AS scheduled,
             COALESCE(live.ready, 0)::integer AS ready,
             COALESCE(live.active, 0)::integer AS active
        FROM known_queues known
        LEFT JOIN workhorse.queue_control control USING (queue_name)
        LEFT JOIN live_counts live USING (queue_name)
       ORDER BY known.queue_name
    `),
    database.execute<{ estimate: string | number }>(sql`
      SELECT reltuples::bigint AS estimate FROM pg_class WHERE oid = 'workhorse.job'::regclass
    `),
  ]);
  const approximate = Number(relationRows.rows[0]?.estimate ?? -1) >= approximateCountThreshold;

  let terminalCounts: Map<string, { succeeded: number; failed: number; canceled: number }>;
  if (approximate) {
    const estimates = await Promise.all(
      queueRows.rows.map(async (row) => {
        const [succeeded, failed, canceled] = await Promise.all([
          estimateRows(
            database,
            sql`SELECT 1 FROM workhorse.job_outcome outcome
                  JOIN workhorse.job job ON job.id = outcome.job_id
                 WHERE job.queue_name = ${row.queue} AND outcome.state = 'succeeded'`,
          ),
          estimateRows(
            database,
            sql`SELECT 1 FROM workhorse.job_outcome outcome
                  JOIN workhorse.job job ON job.id = outcome.job_id
                 WHERE job.queue_name = ${row.queue} AND outcome.state = 'failed'`,
          ),
          estimateRows(
            database,
            sql`SELECT 1 FROM workhorse.job_outcome outcome
                  JOIN workhorse.job job ON job.id = outcome.job_id
                 WHERE job.queue_name = ${row.queue} AND outcome.state = 'canceled'`,
          ),
        ]);
        return [row.queue, { succeeded, failed, canceled }] as const;
      }),
    );
    terminalCounts = new Map(estimates);
  } else {
    const exactRows = await database.execute<{
      queue: string;
      succeeded: number;
      failed: number;
      canceled: number;
    }>(sql`
      SELECT job.queue_name AS queue,
             count(*) FILTER (WHERE outcome.state = 'succeeded')::integer AS succeeded,
             count(*) FILTER (WHERE outcome.state = 'failed')::integer AS failed,
             count(*) FILTER (WHERE outcome.state = 'canceled')::integer AS canceled
        FROM workhorse.job_outcome outcome
        JOIN workhorse.job job ON job.id = outcome.job_id
       GROUP BY job.queue_name
    `);
    terminalCounts = new Map(
      exactRows.rows.map((row) => [
        row.queue,
        { succeeded: row.succeeded, failed: row.failed, canceled: row.canceled },
      ]),
    );
  }

  return {
    capturedAt: new Date().toISOString(),
    queues: queueRows.rows.map((row) => ({
      queue: row.queue,
      paused: row.paused,
      scheduled: row.scheduled,
      ready: row.ready,
      active: row.active,
      succeeded: terminalCounts.get(row.queue)?.succeeded ?? 0,
      failed: terminalCounts.get(row.queue)?.failed ?? 0,
      canceled: terminalCounts.get(row.queue)?.canceled ?? 0,
      terminalCountsApproximate: approximate,
    })),
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
  const { windowSeconds, bucketSeconds } = activityPeriods[period];
  const tagArray = textArrayExpression(tags);
  // Attributing a task to a worker means reading its latest attempt, which is one probe per task.
  // Only worker grouping and the worker filter need it, so it stays out of every other view.
  const needsAttemptWorker = groupBy === "worker" || worker !== null;
  const workerExpression = needsAttemptWorker
    ? sql`COALESCE(r.worker_id, attempt_worker.worker_id, 'unassigned')`
    : sql`COALESCE(r.worker_id, 'unassigned')`;
  const attemptWorkerJoin = needsAttemptWorker
    ? sql`
        LEFT JOIN LATERAL (
          SELECT ah.worker_id
            FROM workhorse.attempt_history ah
           WHERE ah.job_id = candidate.job_id
           ORDER BY ah.attempt DESC
           LIMIT 1
        ) attempt_worker ON true`
    : sql``;
  const groupExpression =
    groupBy === "queue"
      ? sql`j.queue_name`
      : groupBy === "task"
        ? sql`j.job_type`
        : groupBy === "status"
          ? sql`COALESCE(r.state, o.state)`
          : workerExpression;
  const rows = await database.execute<{
    bucket_start: Date | string;
    group_key: string | null;
    count: number;
  }>(sql`
    -- Start from the tasks that changed inside the window rather than from every task that ever
    -- existed. A live runtime row and a terminal outcome row can briefly coexist for one task, so
    -- the candidate set is a UNION and the projection keeps the runtime-wins precedence.
    WITH candidate AS (
      SELECT r.job_id FROM workhorse.job_runtime r
       WHERE r.updated_at >= clock_timestamp() - make_interval(secs => ${windowSeconds})
      UNION
      SELECT o.job_id FROM workhorse.job_outcome o
       WHERE o.updated_at >= clock_timestamp() - make_interval(secs => ${windowSeconds})
    ), tasks AS (
      SELECT ${groupExpression} AS group_key,
             COALESCE(r.state, o.state) AS state,
             COALESCE(r.current_attempt, o.current_attempt) AS attempt,
             COALESCE(r.updated_at, o.updated_at) AS updated_at,
             j.tags, j.queue_name AS queue,
             ${workerExpression} AS worker_id
        FROM candidate
        JOIN workhorse.job j ON j.id = candidate.job_id
        LEFT JOIN workhorse.job_runtime r ON r.job_id = candidate.job_id
        LEFT JOIN workhorse.job_outcome o ON o.job_id = candidate.job_id${attemptWorkerJoin}
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
       AND (cardinality(${tagArray}) = 0 OR t.tags && ${tagArray})
       AND (${queue}::text IS NULL OR t.queue = ${queue})
       AND (${worker}::text IS NULL OR t.worker_id = ${worker})
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
  database: DashboardDatabase,
  filter: DashboardTaskFilter,
  page: number,
  pageSize: number,
  queue: string | null = null,
  tags: readonly string[] = [],
  search: string | null = null,
  worker: string | null = null,
  jobType: string | null = null,
  projectDurability: DashboardDurabilityProjector = () => null,
): Promise<DashboardTasksPage> {
  const offset = (page - 1) * pageSize;
  const searchPattern = taskSearchPattern(search);
  const queryCondition = taskQueryCondition({ queue, worker, jobType, tags, searchPattern });
  const [counts, totalRows, jobRows] = await Promise.all([
    readDashboardTaskCounts(database),
    database.execute<{ count: number }>(sql`
      WITH tasks AS (
        SELECT j.id, j.queue_name AS queue, j.job_type AS type, j.tags,
               COALESCE(r.state, o.state) AS state,
               COALESCE(r.current_attempt, o.current_attempt) AS attempt,
               COALESCE(r.worker_id, current_wait.worker_id, attempt_worker.worker_id,
                        'unassigned') AS worker_id
          FROM workhorse.job j
          LEFT JOIN workhorse.job_runtime r ON r.job_id = j.id
          LEFT JOIN workhorse.job_outcome o ON o.job_id = j.id
          LEFT JOIN workhorse.job_wait current_wait
            ON current_wait.job_id = j.id AND current_wait.wait_name = r.wait_name
          LEFT JOIN LATERAL (
            SELECT ah.worker_id FROM workhorse.attempt_history ah
             WHERE ah.job_id = j.id ORDER BY ah.attempt DESC LIMIT 1
          ) attempt_worker ON true
      )
      SELECT count(*)::integer AS count FROM tasks
       WHERE ${taskFilterCondition(filter)} AND ${queryCondition}
    `),
    database.execute<{
      id: string;
      queue: string;
      type: string;
      state: string;
      attempt: number;
      max_attempts: number;
      retry_policy: RetryPolicy | null;
      deadline_at: Date | string | null;
      execution_timeout_ms: string | number | null;
      payload: unknown;
      tags: string[];
      run_at: Date | string | null;
      current_worker_id: string | null;
      worker_id: string | null;
      finished_at: Date | string | null;
      error: unknown;
      created_at: Date | string;
      updated_at: Date | string;
      checkpoint_names: string[];
      wait_name: string | null;
      wake_at: Date | string | null;
      wait_mode: "relative" | "absolute" | null;
      cancel_requested_at: Date | string | null;
      cancel_requested_by: string | null;
      cancel_reason: string | null;
      enqueued_details: unknown;
    }>(sql`
      WITH tasks AS (
        SELECT j.id, j.queue_name AS queue, j.job_type AS type,
               COALESCE(r.state, o.state) AS state,
               COALESCE(r.current_attempt, o.current_attempt) AS attempt,
               j.max_attempts, j.retry_policy, j.deadline_at, j.execution_timeout_ms, j.payload, j.tags,
               COALESCE(r.run_at, o.run_at) AS run_at,
               r.worker_id AS current_worker_id,
               COALESCE(r.worker_id, durable_wait.worker_id, attempt_worker.worker_id)
                 AS worker_id,
               o.finished_at,
               COALESCE(o.error, r.error) AS error,
               j.created_at,
               COALESCE(r.updated_at, o.updated_at, j.created_at) AS updated_at,
               r.wait_name,
               r.cancel_requested_at,
               r.cancel_requested_by,
               r.cancel_reason,
               durable_wait.wake_at,
               durable_wait.mode AS wait_mode,
               enqueued_event.details AS enqueued_details,
               ARRAY(SELECT checkpoint.checkpoint_name
                       FROM workhorse.job_checkpoint checkpoint
                      WHERE checkpoint.job_id = j.id
                      ORDER BY checkpoint.checkpoint_name) AS checkpoint_names
          FROM workhorse.job j
          LEFT JOIN workhorse.job_runtime r ON r.job_id = j.id
          LEFT JOIN workhorse.job_outcome o ON o.job_id = j.id
          LEFT JOIN workhorse.job_wait durable_wait
            ON durable_wait.job_id = j.id AND durable_wait.wait_name = r.wait_name
          LEFT JOIN LATERAL (
            SELECT event.details FROM workhorse.job_event event
             WHERE event.job_id = j.id AND event.event_type = 'enqueued'
             ORDER BY event.occurred_at, event.event_id LIMIT 1
          ) enqueued_event ON true
          LEFT JOIN LATERAL (
            SELECT ah.worker_id FROM workhorse.attempt_history ah
             WHERE ah.job_id = j.id ORDER BY ah.attempt DESC LIMIT 1
          ) attempt_worker ON true
      )
      SELECT *
        FROM tasks
       WHERE ${taskFilterCondition(filter)} AND ${queryCondition}
       ORDER BY updated_at DESC, id DESC
       LIMIT ${pageSize}
      OFFSET ${offset}
    `),
  ]);
  return {
    capturedAt: new Date().toISOString(),
    filter,
    queue,
    worker,
    jobType,
    tags: [...tags],
    search,
    page,
    pageSize,
    total: totalRows.rows[0]?.count ?? 0,
    counts,
    jobs: jobRows.rows.map((row) => {
      const plan = projectDurability(row.type, row.payload);
      const checkpointNames = new Set(row.checkpoint_names);
      return {
        id: row.id,
        queue: row.queue,
        type: row.type,
        state: row.state,
        attempt: row.attempt,
        maxAttempts: row.max_attempts,
        retryPolicy: row.retry_policy,
        deadlineAt: toIsoOrNull(row.deadline_at),
        executionTimeoutMs:
          row.execution_timeout_ms === null ? null : Number(row.execution_timeout_ms),
        payload: row.payload,
        tags: row.tags,
        keyed:
          readIdempotencyEvidence({ type: "enqueued", details: row.enqueued_details }) !== null,
        cancellation: cancellationRequest(
          row.cancel_requested_at,
          row.cancel_requested_by,
          row.cancel_reason,
        ),
        runAt: toIsoOrNull(row.run_at),
        workerId: row.current_worker_id,
        lastWorkerId: row.worker_id,
        finishedAt: toIsoOrNull(row.finished_at),
        errorMessage: errorMessageOrNull(row.error),
        createdAt: toIso(row.created_at),
        updatedAt: toIso(row.updated_at),
        durability: plan
          ? {
              completedSteps: plan.steps.filter((step) => checkpointNames.has(step.name)).length,
              totalSteps: plan.steps.length,
            }
          : null,
        waitName: row.wait_name,
        wakeAt: toIsoOrNull(row.wake_at),
        wait:
          row.wait_name && row.wake_at && row.wait_mode
            ? { name: row.wait_name, wakeAt: toIso(row.wake_at), mode: row.wait_mode }
            : null,
      };
    }),
  };
}

export async function readDashboardTaskFacets(
  database: DashboardDatabase,
  configuredWorkers: readonly string[] = [],
): Promise<DashboardTaskFacets> {
  const configuredWorkerRows =
    configuredWorkers.length === 0
      ? sql`SELECT NULL::text AS worker WHERE false`
      : sql`SELECT worker FROM (VALUES ${workerValues(configuredWorkers)}) configured(worker)`;
  const rows = await database.execute<{
    queues: string[];
    workers: string[];
    job_types: string[];
    tags: string[];
  }>(sql`
    WITH configured_workers AS (${configuredWorkerRows}),
    queue_values AS (
      SELECT queue_name AS value FROM workhorse.job
      UNION SELECT queue_name FROM workhorse.queue_control
    ), worker_values AS (
      SELECT worker AS value FROM configured_workers
      UNION SELECT worker_id FROM workhorse.job_runtime WHERE worker_id IS NOT NULL
      UNION SELECT worker_id FROM workhorse.attempt_history WHERE worker_id IS NOT NULL
    ), type_values AS (
      SELECT DISTINCT job_type AS value FROM workhorse.job
    ), tag_values AS (
      SELECT DISTINCT unnest(tags) AS value FROM workhorse.job
    )
    SELECT ARRAY(SELECT value FROM queue_values WHERE value IS NOT NULL ORDER BY value) AS queues,
           ARRAY(SELECT value FROM worker_values WHERE value IS NOT NULL ORDER BY value) AS workers,
           ARRAY(SELECT value FROM type_values ORDER BY value) AS job_types,
           ARRAY(SELECT value FROM tag_values ORDER BY value) AS tags
  `);
  return {
    queues: rows.rows[0]?.queues ?? [],
    workers: rows.rows[0]?.workers ?? [],
    jobTypes: rows.rows[0]?.job_types ?? [],
    tags: rows.rows[0]?.tags ?? [],
  };
}

/** Display-only schedule descriptions; the core schema deliberately has no description column. */
const scheduleDescriptions: Record<string, string> = {
  "workhorse:tick": "Promotes due jobs to ready and recovers expired leases.",
  "workhorse:history-partitions":
    "Maintains the current UTC day plus three future history partitions.",
  "workhorse:history-retention":
    "Retires expired history and schedule occurrences after the daily local boundary.",
  "workhorse:terminal-storage":
    "Prunes expired idempotency bindings and safely removable terminal jobs.",
};

function scheduleDescription(namespace: string, name: string): string | null {
  return scheduleDescriptions[`${namespace}:${name}`] ?? null;
}

function systemMaintenanceSchedules(
  cadences: MaintenanceLoopCadences,
  policy: {
    timezone: string;
    partitionPreparationIntervalMs: number;
    terminalCleanupIntervalMs: number;
    historyRetentionLocalHour: number;
    updatedAt: string;
  },
  state: Map<
    string,
    {
      lastStartedAt: string | null;
      lastCompletedAt: string | null;
      due: boolean;
      incomplete: boolean;
    }
  >,
): DashboardScheduleRow[] {
  const updatedAt = policy.updatedAt;
  const maintenance = (
    taskName: string,
    intervalMs: number,
    phases: string[],
  ): NonNullable<DashboardScheduleRow["maintenance"]> => {
    const task = state.get(taskName);
    return {
      intervalMs,
      phases,
      status: task?.incomplete ? "incomplete" : task?.due ? "due" : "scheduled",
      lastStartedAt: task?.lastStartedAt ?? null,
      lastCompletedAt: task?.lastCompletedAt ?? null,
    };
  };
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
      occurrenceCount: null,
      lastFiredAt: null,
      lastRun: null,
      maintenance: {
        intervalMs: cadences.tickIntervalMs,
        phases: ["promote", "recover"],
        status: "scheduled",
        lastStartedAt: null,
        lastCompletedAt: null,
      },
    },
    {
      kind: "system",
      identity: { kind: "system", namespace: "workhorse", name: "history-partitions" },
      namespace: "workhorse",
      name: "history-partitions",
      description: scheduleDescription("workhorse", "history-partitions"),
      cron: `every ${policy.partitionPreparationIntervalMs}ms`,
      queue: null,
      type: "workhorse.prepare_history_partitions_v1",
      enabled: true,
      active: true,
      revision: "1",
      updatedAt,
      occurrenceCount: null,
      lastFiredAt: state.get("history_partitions")?.lastCompletedAt ?? null,
      lastRun: null,
      maintenance: maintenance("history_partitions", policy.partitionPreparationIntervalMs, [
        "history_partitions",
      ]),
    },
    {
      kind: "system",
      identity: { kind: "system", namespace: "workhorse", name: "history-retention" },
      namespace: "workhorse",
      name: "history-retention",
      description: scheduleDescription("workhorse", "history-retention"),
      cron: `daily at ${String(policy.historyRetentionLocalHour).padStart(2, "0")}:00 ${policy.timezone}`,
      queue: null,
      type: "workhorse.retain_history_v1",
      enabled: true,
      active: true,
      revision: "1",
      updatedAt,
      occurrenceCount: null,
      lastFiredAt: state.get("history_retention")?.lastCompletedAt ?? null,
      lastRun: null,
      maintenance: maintenance("history_retention", 86_400_000, [
        "event_retention",
        "attempt_retention",
        "schedule_occurrences",
      ]),
    },
    {
      kind: "system",
      identity: { kind: "system", namespace: "workhorse", name: "terminal-storage" },
      namespace: "workhorse",
      name: "terminal-storage",
      description: scheduleDescription("workhorse", "terminal-storage"),
      cron: `every ${policy.terminalCleanupIntervalMs}ms`,
      queue: null,
      type: "workhorse.prune_terminal_storage_v1",
      enabled: true,
      active: true,
      revision: "1",
      updatedAt,
      occurrenceCount: null,
      lastFiredAt: state.get("terminal_storage")?.lastCompletedAt ?? null,
      lastRun: null,
      maintenance: maintenance("terminal_storage", policy.terminalCleanupIntervalMs, [
        "enqueue_idempotency",
        "terminal_jobs",
      ]),
    },
  ];
}

export async function readDashboardCron(
  database: DashboardDatabase,
  maintenanceLoops: MaintenanceLoopCadences,
): Promise<DashboardCronPage> {
  const now = new Date();
  const [scheduleRows, policyRows, stateRows] = await Promise.all([
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
      timezone: string;
      partition_preparation_interval_ms: number;
      terminal_cleanup_interval_ms: number;
      history_retention_local_hour: number;
      updated_at: Date | string;
    }>(sql`
      SELECT timezone, partition_preparation_interval_ms, terminal_cleanup_interval_ms,
             history_retention_local_hour, updated_at
        FROM workhorse.maintenance_policy WHERE singleton
    `),
    database.execute<{
      task_name: string;
      last_started_at: Date | string | null;
      last_completed_at: Date | string | null;
      due: boolean;
      incomplete: boolean;
    }>(sql`
      SELECT state.task_name, state.last_started_at, state.last_completed_at,
             CASE state.task_name
               WHEN 'history_partitions' THEN state.last_completed_at IS NULL
                 OR state.last_completed_at <= clock_timestamp()
                   - make_interval(secs => policy.partition_preparation_interval_ms / 1000.0)
               WHEN 'terminal_storage' THEN state.last_completed_at IS NULL
                 OR state.last_completed_at <= clock_timestamp()
                   - make_interval(secs => policy.terminal_cleanup_interval_ms / 1000.0)
               WHEN 'history_retention' THEN
                 (clock_timestamp() AT TIME ZONE policy.timezone)::time
                   >= make_time(policy.history_retention_local_hour, 0, 0)
                 AND (
                   state.last_completed_local_date IS NULL
                   OR state.last_completed_local_date
                     < (clock_timestamp() AT TIME ZONE policy.timezone)::date
                 )
               ELSE false
             END AS due,
             state.last_started_at IS NOT NULL
               AND (state.last_completed_at IS NULL OR state.last_started_at > state.last_completed_at)
               AS incomplete
        FROM workhorse.maintenance_state state
        CROSS JOIN workhorse.maintenance_policy policy
       WHERE policy.singleton
       ORDER BY state.task_name
    `),
  ]);
  const policy = policyRows.rows[0]!;
  const state = new Map(
    stateRows.rows.map((row) => [
      row.task_name,
      {
        lastStartedAt: toIsoOrNull(row.last_started_at),
        lastCompletedAt: toIsoOrNull(row.last_completed_at),
        due: row.due,
        incomplete: row.incomplete,
      },
    ]),
  );

  return {
    capturedAt: now.toISOString(),
    schedules: [
      ...systemMaintenanceSchedules(
        maintenanceLoops,
        {
          timezone: policy.timezone,
          partitionPreparationIntervalMs: Number(policy.partition_preparation_interval_ms),
          terminalCleanupIntervalMs: Number(policy.terminal_cleanup_interval_ms),
          historyRetentionLocalHour: Number(policy.history_retention_local_hour),
          updatedAt: toIso(policy.updated_at),
        },
        state,
      ),
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

const dashboardSystemWindowSeconds: Record<DashboardSystemWindow, number> = {
  "15m": 15 * 60,
  "1h": 60 * 60,
  "24h": 24 * 60 * 60,
};

// Promotion is expected to complete within a few maintenance ticks under normal operation.
const dashboardPromotionGraceSeconds = 10;

const dashboardRetryBucketLabels: DashboardSystemRetryBucket["label"][] = [
  "1m",
  "5m",
  "15m",
  "1h",
  "later",
];

type QueueHealthSnapshot = Awaited<ReturnType<Queue["health"]>>;

/** Only the day-window knobs of the policy; the per-pass limits are not operator-facing here. */
type RetentionDaysKey = {
  [Key in keyof QueueHealthSnapshot["retentionPolicy"]]: QueueHealthSnapshot["retentionPolicy"][Key] extends
    | number
    | null
    ? Key
    : never;
}[keyof QueueHealthSnapshot["retentionPolicy"]];

const dashboardRetentionCategories: ReadonlyArray<{
  category: DashboardRetentionCategory;
  label: string;
  policyKey: RetentionDaysKey;
  prunedByPartition: boolean;
}> = [
  {
    category: "jobIdentity",
    label: "Task records",
    policyKey: "jobIdentityRetentionDays",
    prunedByPartition: false,
  },
  {
    category: "terminalOutcome",
    label: "Finished results",
    policyKey: "terminalOutcomeRetentionDays",
    prunedByPartition: false,
  },
  {
    category: "jobEvents",
    label: "Task events",
    policyKey: "jobEventRetentionDays",
    prunedByPartition: true,
  },
  {
    category: "attemptHistory",
    label: "Attempt history",
    policyKey: "attemptHistoryRetentionDays",
    prunedByPartition: true,
  },
  {
    category: "scheduleOccurrences",
    label: "Schedule runs",
    policyKey: "scheduleOccurrenceRetentionDays",
    prunedByPartition: false,
  },
  {
    category: "statistics",
    label: "Rolled-up statistics",
    policyKey: "statisticsRetentionDays",
    prunedByPartition: false,
  },
];

/**
 * A rollup this far behind is treated as stalled.
 *
 * History retention refuses to delete past the watermark, so a stalled rollup turns into unbounded
 * history growth. The threshold is generous against the one-minute pass cadence: several missed
 * passes are a busy database, half an hour is something being wrong.
 */
const rollupStalledLagMs = 30 * 60 * 1_000;

/** Relations worth showing an operator, grouped by what they are for. */
const dashboardStorageRelations: ReadonlyArray<{
  relation: string;
  label: string;
  group: DashboardStorageRelation["group"];
}> = [
  { relation: "job", label: "Task records", group: "tasks" },
  { relation: "job_outcome", label: "Finished results", group: "tasks" },
  { relation: "job_runtime", label: "Live runtime", group: "tasks" },
  { relation: "job_query", label: "Operator projection", group: "tasks" },
  { relation: "job_event", label: "Task events", group: "history" },
  { relation: "attempt_history", label: "Attempt history", group: "history" },
  { relation: "schedule_occurrence", label: "Schedule runs", group: "history" },
  { relation: "job_stat_bucket", label: "Statistics buckets", group: "statistics" },
];

function dashboardStorage(health: QueueHealthSnapshot): DashboardSystemStorage {
  const byRelation = new Map(health.relations.map((row) => [row.relation, row]));
  const relations = dashboardStorageRelations
    .map((definition) => {
      const row = byRelation.get(definition.relation);
      return {
        relation: definition.relation,
        label: definition.label,
        group: definition.group,
        totalBytes: Number(row?.totalBytes ?? 0),
        tableBytes: Number(row?.tableBytes ?? 0),
        indexBytes: Number(row?.indexBytes ?? 0),
        rows: Number(row?.liveTuples ?? 0),
        deadRows: Number(row?.deadTuples ?? 0),
        partitions: Number(row?.partitions ?? 0),
        lastVacuumAt: toIsoOrNull(row?.lastAutovacuum ?? row?.lastVacuum ?? null),
      };
    })
    // oxlint-disable-next-line unicorn/no-array-sort -- ES2022 lacks Array.prototype.toSorted.
    .sort((left, right) => right.totalBytes - left.totalBytes);
  return {
    rollup: {
      rolledUpThrough: toIso(health.statistics.rolledUpThrough),
      lagMs: Number(health.statistics.lagMs),
      lastRunAt: toIsoOrNull(health.statistics.lastRunAt),
      buckets: Number(health.statistics.buckets),
      oldestBucketAt: toIsoOrNull(health.statistics.oldestBucketAt),
      newestBucketAt: toIsoOrNull(health.statistics.newestBucketAt),
      stalled: Number(health.statistics.lagMs) > rollupStalledLagMs,
    },
    relations,
    totalBytes: relations.reduce((total, row) => total + row.totalBytes, 0),
  };
}

// Row cleanup runs every five minutes, while daily partition cleanup is bounded per pass. Grace
// avoids turning normal maintenance cadence and a partial boundary day into an alert.
const rowRetentionLagGraceMs = 6 * 60 * 60 * 1_000;
const partitionRetentionLagGraceMs = 2 * 24 * 60 * 60 * 1_000;
const eligiblePartitionGrace = 2;

/**
 * Flatten `Queue.health()` retention fields into an operator-ready projection. Numeric policy
 * values are normalized because PostgreSQL bigint columns can arrive as strings.
 */
function dashboardRetention(health: QueueHealthSnapshot): DashboardSystemRetention {
  const categories = dashboardRetentionCategories.map((definition) => {
    const configured = health.retentionPolicy[definition.policyKey];
    const oldest = health.oldestRetainedAt[definition.category];
    const lag = health.retentionLagMs[definition.category];
    return {
      category: definition.category,
      label: definition.label,
      retentionDays: configured === null || configured === undefined ? null : Number(configured),
      lagMs: lag === null || lag === undefined ? null : Number(lag),
      oldestRetainedAt: oldest ? toIso(oldest) : null,
      prunedByPartition: definition.prunedByPartition,
    };
  });

  let maxLag: DashboardRetentionCategoryRow | null = null;
  let oldest: DashboardRetentionCategoryRow | null = null;
  for (const row of categories) {
    if (row.lagMs !== null && row.lagMs > 0 && (maxLag === null || row.lagMs > maxLag.lagMs!)) {
      maxLag = row;
    }
    if (
      row.oldestRetainedAt !== null &&
      (oldest === null ||
        Date.parse(row.oldestRetainedAt) < Date.parse(oldest.oldestRetainedAt ?? ""))
    ) {
      oldest = row;
    }
  }

  return {
    policyUpdatedAt: toIso(health.retentionPolicy.updatedAt),
    categories,
    maxLagMs: maxLag?.lagMs ?? null,
    maxLagCategory: maxLag?.category ?? null,
    oldestRetainedAt: oldest?.oldestRetainedAt ?? null,
    oldestRetainedCategory: oldest?.category ?? null,
    eligibleHistoryPartitions: {
      jobEvents: Number(health.eligibleHistoryPartitions.jobEvents),
      attemptHistory: Number(health.eligibleHistoryPartitions.attemptHistory),
    },
    defaultHistoryRows: {
      jobEvents: Number(health.defaultHistoryRows.jobEvents),
      attemptHistory: Number(health.defaultHistoryRows.attemptHistory),
    },
    defaultHistoryRowsCapped: {
      jobEvents: health.defaultHistoryRowsCapped.jobEvents,
      attemptHistory: health.defaultHistoryRowsCapped.attemptHistory,
    },
  };
}

/**
 * Retention problems degrade the page but never make it critical: history falling behind costs
 * storage, while expired leases, stalled promotion, and missing future partitions stop or lose
 * work outright.
 */
function retentionDegradedChecks(retention: DashboardSystemRetention): string[] {
  const checks: string[] = [];
  const behind = retention.categories.filter(
    (row) =>
      row.lagMs !== null &&
      row.lagMs > (row.prunedByPartition ? partitionRetentionLagGraceMs : rowRetentionLagGraceMs),
  );
  if (behind.length > 0) {
    checks.push(`Retention behind: ${behind.map((row) => row.label.toLowerCase()).join(", ")}`);
  }
  const eligible =
    retention.eligibleHistoryPartitions.jobEvents +
    retention.eligibleHistoryPartitions.attemptHistory;
  if (eligible > eligiblePartitionGrace) {
    checks.push(`Expired history days awaiting cleanup (${eligible})`);
  }
  const spill =
    retention.defaultHistoryRows.jobEvents + retention.defaultHistoryRows.attemptHistory;
  if (spill > 0) checks.push(`History rows outside daily partitions (${spill})`);
  return checks;
}

export async function readDashboardSystem(
  database: DashboardDatabase,
  queue: Queue,
  window: DashboardSystemWindow = "1h",
): Promise<DashboardSystemPage> {
  const windowSeconds = dashboardSystemWindowSeconds[window];
  const [
    outcomeRows,
    summaryRows,
    waitRows,
    runtimeRows,
    retryRows,
    queueRows,
    retryTypeRows,
    failingTypeRows,
    partitionRows,
    health,
  ] = await Promise.all([
    database.execute<{
      bucket_start: Date | string;
      enqueued: number;
      succeeded: number;
      failed: number;
      retry: number;
      lease_expired: number;
      canceled: number;
    }>(sql`
      WITH buckets AS (
        SELECT generate_series(
          ${statWindowStart(windowSeconds)},
          date_bin('1 minute', clock_timestamp(), timestamp with time zone '2000-01-01'),
          interval '1 minute'
        ) AS bucket_start
      ), rolled AS (
        SELECT stat.bucket_start,
               sum(stat.enqueued)::integer AS enqueued,
               sum(stat.attempt_succeeded)::integer AS succeeded,
               sum(stat.attempt_failed)::integer AS failed,
               sum(stat.attempt_retry)::integer AS retry,
               sum(stat.attempt_lease_expired)::integer AS lease_expired,
               sum(stat.attempt_canceled)::integer AS canceled
          FROM ${statWindow(windowSeconds)}
         GROUP BY 1
      )
      SELECT b.bucket_start, COALESCE(r.enqueued, 0)::integer AS enqueued,
             COALESCE(r.succeeded, 0)::integer AS succeeded,
             COALESCE(r.failed, 0)::integer AS failed,
             COALESCE(r.retry, 0)::integer AS retry,
             COALESCE(r.lease_expired, 0)::integer AS lease_expired,
             COALESCE(r.canceled, 0)::integer AS canceled
        FROM buckets b
        LEFT JOIN rolled r USING (bucket_start)
       ORDER BY b.bucket_start
    `),
    database.execute<{
      current_enqueued: number;
      current_completed: number;
      current_attempts: number;
      current_errors: number;
      previous_attempts: number;
      previous_errors: number;
      recovered: number;
    }>(sql`
      WITH current_window AS (
        SELECT COALESCE(sum(stat.enqueued), 0)::integer AS enqueued,
               COALESCE(sum(${statCompleted}), 0)::integer AS completed,
               COALESCE(sum(${statAttempts}), 0)::integer AS attempts,
               COALESCE(sum(${statAttemptErrors}), 0)::integer AS errors,
               COALESCE(sum(stat.attempt_lease_expired), 0)::integer AS recovered
          FROM ${statWindow(windowSeconds)}
      ), previous_window AS (
        SELECT COALESCE(sum(${statAttempts}), 0)::integer AS attempts,
               COALESCE(sum(${statAttemptErrors}), 0)::integer AS errors
          FROM ${statWindow(windowSeconds, 2)}
      )
      SELECT current_window.enqueued AS current_enqueued,
             current_window.completed AS current_completed,
             current_window.attempts AS current_attempts,
             current_window.errors AS current_errors,
             previous_window.attempts AS previous_attempts,
             previous_window.errors AS previous_errors,
             current_window.recovered
        FROM current_window CROSS JOIN previous_window
    `),
    // Exact percentiles are not mergeable across rolled-up buckets without keeping every sample, so
    // this one panel still reads the event log. It is the most expensive query on the page at high
    // throughput; a coarser aggregate tier is the intended answer, not an approximation here.
    database.execute<{ p50_ms: number | null; p95_ms: number | null; p99_ms: number | null }>(sql`
      SELECT percentile_cont(0.50) WITHIN GROUP (
               ORDER BY extract(epoch FROM claimed.occurred_at - enqueued.occurred_at) * 1000
             ) AS p50_ms,
             percentile_cont(0.95) WITHIN GROUP (
               ORDER BY extract(epoch FROM claimed.occurred_at - enqueued.occurred_at) * 1000
             ) AS p95_ms,
             percentile_cont(0.99) WITHIN GROUP (
               ORDER BY extract(epoch FROM claimed.occurred_at - enqueued.occurred_at) * 1000
             ) AS p99_ms
        FROM workhorse.job_event claimed
        JOIN workhorse.job_event enqueued ON enqueued.job_id = claimed.job_id
         AND enqueued.event_type = 'enqueued'
         AND enqueued.occurred_at <= claimed.occurred_at
       WHERE claimed.event_type = 'claimed' AND claimed.attempt = 1
         AND claimed.occurred_at >= clock_timestamp() - make_interval(secs => ${windowSeconds})
         AND enqueued.occurred_at >= clock_timestamp() - make_interval(secs => ${windowSeconds * 2})
    `),
    database.execute<{
      ready: number;
      oldest_ready_ms: number | null;
      backoff: number;
      due_soon: number;
      active: number;
      expired: number;
      expiring_soon: number;
      due_but_unpromoted: number;
    }>(sql`
      SELECT count(*) FILTER (WHERE state = 'ready')::integer AS ready,
             extract(epoch FROM clock_timestamp() - min(ready_at) FILTER (WHERE state = 'ready')) * 1000
               AS oldest_ready_ms,
             count(*) FILTER (WHERE state = 'scheduled' AND current_attempt > 1)::integer AS backoff,
             count(*) FILTER (WHERE state = 'scheduled' AND current_attempt > 1
               AND run_at <= clock_timestamp() + interval '5 minutes')::integer AS due_soon,
             count(*) FILTER (WHERE state = 'active')::integer AS active,
             count(*) FILTER (WHERE state = 'active' AND expires_at <= clock_timestamp())::integer AS expired,
             count(*) FILTER (WHERE state = 'active' AND expires_at > clock_timestamp()
               AND expires_at <= clock_timestamp() + interval '30 seconds')::integer AS expiring_soon,
             count(*) FILTER (WHERE state = 'scheduled'
               AND run_at < clock_timestamp() - make_interval(secs => ${dashboardPromotionGraceSeconds}))::integer
               AS due_but_unpromoted
        FROM workhorse.job_runtime
    `),
    database.execute<{ label: DashboardSystemRetryBucket["label"]; count: number }>(sql`
      SELECT CASE
               WHEN run_at <= clock_timestamp() + interval '1 minute' THEN '1m'
               WHEN run_at <= clock_timestamp() + interval '5 minutes' THEN '5m'
               WHEN run_at <= clock_timestamp() + interval '15 minutes' THEN '15m'
               WHEN run_at <= clock_timestamp() + interval '1 hour' THEN '1h'
               ELSE 'later'
             END AS label,
             count(*)::integer AS count
        FROM workhorse.job_runtime
       WHERE state = 'scheduled' AND current_attempt > 1
       GROUP BY 1
    `),
    database.execute<{
      queue: string;
      paused: boolean;
      ready: number;
      oldest_ready_ms: number | null;
      due_soon: number;
      active: number;
      retrying: number;
      enqueued: number;
      completed: number;
    }>(sql`
      WITH rolled AS (
        SELECT stat.queue_name,
               COALESCE(sum(stat.enqueued), 0)::integer AS enqueued,
               COALESCE(sum(${statCompleted}), 0)::integer AS completed
          FROM ${statWindow(windowSeconds)}
         GROUP BY 1
      ), queue_names AS (
        SELECT queue_name FROM workhorse.job_runtime
        UNION SELECT queue_name FROM workhorse.queue_control
        UNION SELECT queue_name FROM rolled
      ), runtime AS (
        SELECT queue_name,
               count(*) FILTER (WHERE state = 'ready')::integer AS ready,
               extract(epoch FROM clock_timestamp() - min(ready_at) FILTER (WHERE state = 'ready')) * 1000
                 AS oldest_ready_ms,
               count(*) FILTER (WHERE state = 'scheduled'
                 AND run_at <= clock_timestamp() + interval '5 minutes')::integer AS due_soon,
               count(*) FILTER (WHERE state = 'active')::integer AS active,
               count(*) FILTER (WHERE state = 'scheduled' AND current_attempt > 1)::integer AS retrying
          FROM workhorse.job_runtime GROUP BY queue_name
      )
      SELECT q.queue_name AS queue, COALESCE(c.paused, false) AS paused,
             COALESCE(r.ready, 0)::integer AS ready, r.oldest_ready_ms,
             COALESCE(r.due_soon, 0)::integer AS due_soon,
             COALESCE(r.active, 0)::integer AS active,
             COALESCE(r.retrying, 0)::integer AS retrying,
             COALESCE(s.enqueued, 0)::integer AS enqueued,
             COALESCE(s.completed, 0)::integer AS completed
        FROM queue_names q
        LEFT JOIN workhorse.queue_control c USING (queue_name)
        LEFT JOIN runtime r USING (queue_name)
        LEFT JOIN rolled s USING (queue_name)
    `),
    database.execute<{ queue: string; type: string; count: number }>(sql`
      SELECT j.queue_name AS queue, j.job_type AS type, count(*)::integer AS count
        FROM workhorse.job_runtime r JOIN workhorse.job j ON j.id = r.job_id
       WHERE r.state = 'scheduled' AND r.current_attempt > 1
       GROUP BY j.queue_name, j.job_type
       ORDER BY count DESC, j.queue_name, j.job_type
       LIMIT 3
    `),
    database.execute<{
      queue: string;
      type: string;
      attempts: number;
      errors: number;
      terminal_failures: number;
      last_error: string | null;
      last_seen_at: Date | string;
    }>(sql`
      SELECT stat.queue_name AS queue, stat.job_type AS type,
             sum(${statAttempts})::integer AS attempts,
             sum(${statAttemptErrors})::integer AS errors,
             sum(stat.attempt_failed)::integer AS terminal_failures,
             (array_agg(stat.last_error ORDER BY stat.last_error_at DESC NULLS LAST)
               FILTER (WHERE stat.last_error IS NOT NULL))[1] AS last_error,
             max(stat.last_attempt_at) AS last_seen_at
        FROM ${statWindow(windowSeconds)}
       GROUP BY 1, 2
      HAVING sum(${statAttemptErrors}) > 0
       ORDER BY errors DESC, last_seen_at DESC
       LIMIT 8
    `),
    database.execute<{
      day: string;
      starts_at: Date | string;
      event_exists: boolean;
      attempt_exists: boolean;
    }>(sql`
      SELECT to_char(day_start, 'YYYYMMDD') AS day, day_start AS starts_at,
             to_regclass(format('workhorse.%I', 'job_event_' || to_char(day_start, 'YYYYMMDD')))
               IS NOT NULL AS event_exists,
             to_regclass(format('workhorse.%I', 'attempt_history_' || to_char(day_start, 'YYYYMMDD')))
               IS NOT NULL AS attempt_exists
        FROM generate_series(
          date_trunc('day', clock_timestamp() AT TIME ZONE 'UTC'),
          date_trunc('day', clock_timestamp() AT TIME ZONE 'UTC') + interval '3 days',
          interval '1 day'
        ) day_start
       ORDER BY day_start
    `),
    // Retention facts come from the canonical queue read model rather than duplicated SQL here.
    queue.health(),
  ]);

  const summary = summaryRows.rows[0]!;
  const runtime = runtimeRows.rows[0]!;
  const wait = waitRows.rows[0]!;
  const retention = dashboardRetention(health);
  const storage = dashboardStorage(health);
  const minutes = windowSeconds / 60;
  const errorRate =
    summary.current_attempts === 0 ? 0 : summary.current_errors / summary.current_attempts;
  const previousErrorRate =
    summary.previous_attempts === 0 ? 0 : summary.previous_errors / summary.previous_attempts;
  const retryByLabel = new Map(retryRows.rows.map((row) => [row.label, row.count]));
  const retryBuckets = dashboardRetryBucketLabels.map((label) => ({
    label,
    count: retryByLabel.get(label) ?? 0,
  }));
  const partitions = partitionRows.rows.map((row) => ({
    day: row.day,
    startsAt: toIso(row.starts_at),
    eventExists: row.event_exists,
    attemptExists: row.attempt_exists,
  }));
  const criticalChecks = [
    runtime.expired > 0 ? "Expired leases" : null,
    health.deadlinePressure.overdue > 0 ? "Deadlines overdue" : null,
    health.overdueExecutionTimeouts > 0 ? "Execution timeouts overdue" : null,
    runtime.due_but_unpromoted > 0 ? "Promotion stalled" : null,
    partitions.some((partition) => !partition.eventExists || !partition.attemptExists)
      ? "History partitions missing"
      : null,
  ].filter((check): check is string => check !== null);
  // Critical means work is stopping or being lost. Retention only costs storage, so it degrades.
  const degradedChecks = retentionDegradedChecks(retention);
  // A stalled rollup is a storage problem rather than a dispatch one: history retention holds at
  // the watermark rather than deleting the input to windows nobody has computed yet.
  if (storage.rollup.stalled) degradedChecks.push("Statistics rollup behind");
  const level =
    criticalChecks.length > 0 ? "critical" : degradedChecks.length > 0 ? "degraded" : "healthy";
  const status = {
    level: level as DashboardSystemPage["status"]["level"],
    checks: [...criticalChecks, ...degradedChecks],
    criticalChecks,
    degradedChecks,
  };

  const queues = queueRows.rows
    .map((row) => ({
      queue: row.queue,
      paused: row.paused,
      ready: row.ready,
      oldestReadyMs: row.oldest_ready_ms,
      dueSoon: row.due_soon,
      active: row.active,
      retrying: row.retrying,
      enqueuedPerMinute: row.enqueued / minutes,
      completedPerMinute: row.completed / minutes,
    }))
    // oxlint-disable-next-line unicorn/no-array-sort -- ES2022 lacks Array.prototype.toSorted.
    .sort((left, right) => {
      const leftRisk = (left.oldestReadyMs ?? 0) + left.ready * 1_000 + left.dueSoon * 100;
      const rightRisk = (right.oldestReadyMs ?? 0) + right.ready * 1_000 + right.dueSoon * 100;
      return rightRisk - leftRisk || left.queue.localeCompare(right.queue);
    });
  const pausedQueues: string[] = [];
  for (const row of queues) {
    if (row.paused) pausedQueues.push(row.queue);
  }

  return {
    capturedAt: new Date().toISOString(),
    window,
    windowSeconds,
    status,
    pausedQueues,
    kpis: {
      drain: {
        enqueuedPerMinute: summary.current_enqueued / minutes,
        completedPerMinute: summary.current_completed / minutes,
        netPerMinute: (summary.current_completed - summary.current_enqueued) / minutes,
      },
      backlog: { ready: runtime.ready, oldestReadyMs: runtime.oldest_ready_ms },
      errorRate: {
        current: errorRate,
        previous: previousErrorRate,
        delta: errorRate - previousErrorRate,
      },
      queueWait: {
        p50Ms: wait.p50_ms,
        p95Ms: wait.p95_ms,
        p99Ms: wait.p99_ms,
      },
      retry: { backoff: runtime.backoff, dueSoon: runtime.due_soon, buckets: retryBuckets },
      lease: {
        active: runtime.active,
        expired: runtime.expired,
        expiringSoon: runtime.expiring_soon,
        recovered: summary.recovered,
      },
      deadline: {
        pending: health.deadlinePressure.pending,
        overdue: health.deadlinePressure.overdue,
        dueWithinMinute: health.deadlinePressure.dueWithinMinute,
        earliestAt: toIsoOrNull(health.deadlinePressure.earliestAt),
        activeTimeouts: health.activeExecutionTimeouts,
        overdueTimeouts: health.overdueExecutionTimeouts,
      },
    },
    outcomes: outcomeRows.rows.map((row) => ({
      bucketStart: toIso(row.bucket_start),
      enqueued: row.enqueued,
      succeeded: row.succeeded,
      failed: row.failed,
      retry: row.retry,
      leaseExpired: row.lease_expired,
      canceled: row.canceled,
    })),
    queues,
    retryStorm: { buckets: retryBuckets, topTypes: retryTypeRows.rows },
    failingTypes: failingTypeRows.rows.map((row) => ({
      queue: row.queue,
      type: row.type,
      attempts: row.attempts,
      errorRate: row.attempts === 0 ? 0 : row.errors / row.attempts,
      terminalFailures: row.terminal_failures,
      lastError: row.last_error,
      lastSeenAt: toIso(row.last_seen_at),
    })),
    integrity: {
      dueButUnpromoted: runtime.due_but_unpromoted,
      partitions,
      defaultEventRows: retention.defaultHistoryRows.jobEvents,
      defaultAttemptRows: retention.defaultHistoryRows.attemptHistory,
      retention,
      storage,
    },
  };
}

/**
 * A registration older than this is treated as a stopped process rather than a live worker.
 *
 * Workers refresh on a 5 second cadence by default, so this tolerates several consecutive missed
 * refreshes before a worker is reported offline.
 */
const WORKER_REGISTRATION_STALE_MS = 30_000;

export async function readDashboardWorkers(
  database: DashboardDatabase,
  configuredWorkers: readonly string[] = [],
  canManageWorkers = false,
): Promise<DashboardWorkersPage> {
  const now = new Date();
  const workerRows = await database.execute<{
    id: string;
    registered: boolean;
    hostname: string | null;
    pid: number | null;
    concurrency: number | null;
    active_slots: number | null;
    draining: boolean | null;
    paused: boolean | null;
    started_at: Date | string | null;
    last_heartbeat_at: Date | string | null;
    active_jobs: number;
    completed_attempts: number;
    failed_attempts: number;
    average_execution_ms: number | null;
    last_seen_at: Date | string | null;
  }>(sql`
    WITH declared AS (${declaredWorkerRows(configuredWorkers)}
    ), fleet(id) AS (
      -- Live workers register themselves, so the fleet is discovered rather than configured. Any
      -- explicitly declared worker is unioned in so an expected-but-never-started worker is visible.
      SELECT worker_id FROM workhorse.worker_registry
      UNION
      SELECT id FROM declared
    ), active AS (
      SELECT worker_id AS id, count(*)::integer AS active_jobs, max(acquired_at) AS last_seen_at
        FROM workhorse.job_runtime
       WHERE state = 'active' AND worker_id IN (SELECT id FROM fleet)
       GROUP BY worker_id
    ), recent_history AS (
      -- Exact counts are cheap here because both time predicates keep partition scans to one hour.
      SELECT worker_id AS id, count(*)::integer AS completed_attempts,
             count(*) FILTER (WHERE outcome = 'failed')::integer AS failed_attempts,
             avg(extract(epoch FROM finished_at - claimed_at) * 1000)::double precision
               AS average_execution_ms,
             max(finished_at) AS last_seen_at
        FROM workhorse.attempt_history
       WHERE occurred_at >= clock_timestamp() - interval '1 hour'
         AND finished_at >= clock_timestamp() - interval '1 hour'
         AND worker_id IN (SELECT id FROM fleet)
       GROUP BY worker_id
    )
    SELECT f.id,
           r.worker_id IS NOT NULL AS registered,
           r.hostname, r.pid,
           r.concurrency, r.active_slots, r.draining, r.paused, r.started_at, r.last_heartbeat_at,
           COALESCE(a.active_jobs, 0)::integer AS active_jobs,
           COALESCE(h.completed_attempts, 0)::integer AS completed_attempts,
           COALESCE(h.failed_attempts, 0)::integer AS failed_attempts,
           h.average_execution_ms,
           GREATEST(a.last_seen_at, h.last_seen_at, r.last_heartbeat_at) AS last_seen_at
      FROM fleet f
      LEFT JOIN workhorse.worker_registry r ON r.worker_id = f.id
      LEFT JOIN active a ON a.id = f.id
      LEFT JOIN recent_history h ON h.id = f.id
     ORDER BY f.id
  `);

  return {
    capturedAt: now.toISOString(),
    canManageWorkers,
    workers: workerRows.rows.map((row) => {
      const heartbeatAt = row.last_heartbeat_at ? new Date(row.last_heartbeat_at) : null;
      const live =
        row.registered &&
        heartbeatAt !== null &&
        heartbeatAt.getTime() >= now.getTime() - WORKER_REGISTRATION_STALE_MS;
      return {
        id: row.id,
        hostname: row.hostname,
        pid: row.pid,
        activeJobs: row.active_jobs,
        concurrency: row.concurrency,
        activeSlots: row.active_slots,
        draining: row.draining ?? false,
        completedAttempts: row.completed_attempts,
        failedAttempts: row.failed_attempts,
        averageExecutionMs: row.average_execution_ms,
        lastSeenAt: toIsoOrNull(row.last_seen_at),
        startedAt: toIsoOrNull(row.started_at),
        registered: row.registered,
        paused: row.paused ?? false,
        status:
          row.active_jobs > 0
            ? "active"
            : live
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
  database: DashboardDatabase,
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
        retry_policy: RetryPolicy | null;
        payload: unknown;
        run_at: Date | string | null;
        worker_id: string | null;
        finished_at: Date | string | null;
        error: unknown;
        created_at: Date | string;
        updated_at: Date | string;
        cancel_requested_at: Date | string | null;
        cancel_requested_by: string | null;
        cancel_reason: string | null;
        enqueued_details: unknown;
      }>(sql`
        SELECT j.id, j.queue_name AS queue, j.job_type AS type,
               COALESCE(r.state, o.state) AS state,
               COALESCE(r.current_attempt, o.current_attempt) AS attempt,
               j.max_attempts, j.retry_policy, j.payload,
               COALESCE(r.run_at, o.run_at) AS run_at,
               r.worker_id, o.finished_at,
               COALESCE(o.error, r.error) AS error,
               j.created_at,
               COALESCE(r.updated_at, o.updated_at, j.created_at) AS updated_at,
               r.cancel_requested_at, r.cancel_requested_by, r.cancel_reason,
               enqueued_event.details AS enqueued_details
          FROM workhorse.job j
          LEFT JOIN workhorse.job_runtime r ON r.job_id = j.id
          LEFT JOIN workhorse.job_outcome o ON o.job_id = j.id
          LEFT JOIN LATERAL (
            SELECT event.details FROM workhorse.job_event event
             WHERE event.job_id = j.id AND event.event_type = 'enqueued'
             ORDER BY event.occurred_at, event.event_id LIMIT 1
          ) enqueued_event ON true
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
        registered: boolean;
        hostname: string | null;
        pid: number | null;
        concurrency: number | null;
        active_slots: number | null;
        draining: boolean | null;
        paused: boolean | null;
        started_at: Date | string | null;
        last_heartbeat_at: Date | string | null;
        active_jobs: number;
        completed_attempts: number;
        last_seen_at: Date | string | null;
      }>(sql`
        WITH declared AS (${declaredWorkerRows(configuredWorkers)}
        ), fleet(id) AS (
          SELECT worker_id FROM workhorse.worker_registry
          UNION
          SELECT id FROM declared
        ), observed AS (
          SELECT worker_id AS id, count(*)::integer AS active_jobs, 0::integer AS completed_attempts,
                 max(heartbeat_at) AS last_seen_at
            FROM workhorse.job_runtime
           WHERE state = 'active' AND worker_id IN (SELECT id FROM fleet)
           GROUP BY worker_id
          UNION ALL
          SELECT worker_id AS id, 0::integer AS active_jobs,
                 count(*)::integer AS completed_attempts, max(finished_at) AS last_seen_at
            FROM workhorse.attempt_history
           WHERE occurred_at >= clock_timestamp() - interval '5 minutes'
             AND worker_id IN (SELECT id FROM fleet)
           GROUP BY worker_id
        )
        SELECT f.id,
               r.worker_id IS NOT NULL AS registered,
               r.hostname, r.pid,
               r.concurrency, r.active_slots, r.draining, r.paused, r.started_at,
               r.last_heartbeat_at,
               COALESCE(sum(o.active_jobs), 0)::integer AS active_jobs,
               COALESCE(sum(o.completed_attempts), 0)::integer AS completed_attempts,
               GREATEST(max(o.last_seen_at), r.last_heartbeat_at) AS last_seen_at
          FROM fleet f
          LEFT JOIN workhorse.worker_registry r ON r.worker_id = f.id
          LEFT JOIN observed o ON o.id = f.id
         GROUP BY f.id, r.worker_id, r.hostname, r.pid, r.concurrency, r.active_slots, r.draining,
                  r.paused, r.started_at, r.last_heartbeat_at
         ORDER BY f.id
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
                 avg(extract(epoch FROM finished_at - claimed_at) * 1000)::double precision AS average_duration_ms
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
      retryPolicy: row.retry_policy,
      payload: row.payload,
      tags: [],
      // Derived from the same initial `enqueued` event the task list reads, so a keyed task is
      // never reported as unkeyed just because it was observed through the snapshot instead.
      keyed: readIdempotencyEvidence({ type: "enqueued", details: row.enqueued_details }) !== null,
      // Read from the same runtime columns as the task list, so a pending cancellation is never
      // reported differently depending on which projection an operator happened to open.
      cancellation: cancellationRequest(
        row.cancel_requested_at,
        row.cancel_requested_by,
        row.cancel_reason,
      ),
      runAt: toIsoOrNull(row.run_at),
      workerId: row.worker_id,
      lastWorkerId: row.worker_id,
      finishedAt: toIsoOrNull(row.finished_at),
      errorMessage: errorMessageOrNull(row.error),
      createdAt: toIso(row.created_at),
      updatedAt: toIso(row.updated_at),
      durability: null,
      waitName: null,
      wakeAt: null,
      wait: null,
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
    // Declared capacity, slot use, and pause state come from the durable worker registry, so this
    // pure SQL projection reports the same fleet whether or not workers share the host process.
    workers: workerRows.rows.map((row) => {
      const heartbeatAt = row.last_heartbeat_at ? new Date(row.last_heartbeat_at) : null;
      const live =
        row.registered &&
        heartbeatAt !== null &&
        heartbeatAt.getTime() >= now.getTime() - WORKER_REGISTRATION_STALE_MS;
      return {
        id: row.id,
        hostname: row.hostname,
        pid: row.pid,
        activeJobs: row.active_jobs,
        concurrency: row.concurrency,
        activeSlots: row.active_slots,
        draining: row.draining ?? false,
        completedAttempts: row.completed_attempts,
        failedAttempts: 0,
        averageExecutionMs: null,
        lastSeenAt: toIsoOrNull(row.last_seen_at),
        startedAt: toIsoOrNull(row.started_at),
        registered: row.registered,
        paused: row.paused ?? false,
        status: (row.active_jobs > 0
          ? "active"
          : live
            ? "idle"
            : row.last_seen_at && new Date(row.last_seen_at).getTime() >= now.getTime() - 5 * 60_000
              ? "recent"
              : "offline") as DashboardWorkerRow["status"],
      };
    }),
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
  database: DashboardDatabase,
  id: string,
  projectDurability: DashboardDurabilityProjector = () => null,
): Promise<DashboardJobDetail | null> {
  const [jobRows, attemptRows, checkpointRows, waitRows, eventRows] = await Promise.all([
    database.execute<{
      id: string;
      queue: string;
      type: string;
      payload: unknown;
      max_attempts: number;
      retry_policy: RetryPolicy | null;
      deadline_at: Date | string | null;
      execution_timeout_ms: string | number | null;
      created_at: Date | string;
      runtime_state: string | null;
      runtime_attempt: number | null;
      run_at: Date | string | null;
      ready_at: Date | string | null;
      worker_id: string | null;
      heartbeat_at: Date | string | null;
      fence_token: string;
      acquired_at: Date | string | null;
      expires_at: Date | string | null;
      wait_name: string | null;
      attempt_started_at: Date | string | null;
      attempt_timeout_at: Date | string | null;
      cancel_requested_at: Date | string | null;
      cancel_requested_by: string | null;
      cancel_reason: string | null;
      runtime_error: unknown;
      outcome_state: string | null;
      outcome_attempt: number | null;
      finished_at: Date | string | null;
      result: unknown;
      outcome_error: unknown;
      progress_value: unknown;
      progress_revision: string | null;
      progress_attempt: number | null;
      progress_fence_token: string | null;
      progress_worker_id: string | null;
      progress_created_at: Date | string | null;
      progress_updated_at: Date | string | null;
    }>(sql`
      SELECT j.id, j.queue_name AS queue, j.job_type AS type, j.payload, j.max_attempts,
             j.retry_policy, j.deadline_at, j.execution_timeout_ms, j.created_at,
             r.state AS runtime_state, r.current_attempt AS runtime_attempt, r.run_at, r.ready_at,
             r.worker_id, r.fence_token::text, r.acquired_at, r.heartbeat_at, r.expires_at,
             r.wait_name, r.attempt_started_at, r.attempt_timeout_at,
             r.cancel_requested_at, r.cancel_requested_by, r.cancel_reason,
             r.error AS runtime_error,
             o.state AS outcome_state, o.current_attempt AS outcome_attempt, o.finished_at,
             o.result, o.error AS outcome_error,
             p.progress_value, p.revision::text AS progress_revision,
             p.attempt AS progress_attempt, p.fence_token::text AS progress_fence_token,
             p.worker_id AS progress_worker_id, p.created_at AS progress_created_at,
             p.updated_at AS progress_updated_at
        FROM workhorse.job j
        LEFT JOIN workhorse.job_runtime r ON r.job_id = j.id
        LEFT JOIN workhorse.job_outcome o ON o.job_id = j.id
        LEFT JOIN workhorse.job_progress p ON p.job_id = j.id
       WHERE j.id = ${id}
    `),
    database.execute<{
      attempt: number;
      worker_id: string;
      outcome: string;
      started_at: Date | string;
      claimed_at: Date | string;
      finished_at: Date | string;
      execution_ms: number;
      elapsed_ms: number;
      error: unknown;
    }>(sql`
      SELECT attempt, worker_id, outcome, started_at, claimed_at, finished_at,
             extract(epoch FROM finished_at - claimed_at) * 1000 AS execution_ms,
             extract(epoch FROM finished_at - started_at) * 1000 AS elapsed_ms, error
        FROM workhorse.attempt_history
       WHERE job_id = ${id}
       ORDER BY attempt, attempt_id
    `),
    database.execute<{
      checkpoint_name: string;
      checkpoint_value: unknown;
      attempt: number;
      fence_token: string;
      worker_id: string;
      created_at: Date | string;
    }>(sql`
      SELECT checkpoint_name, checkpoint_value, attempt, fence_token::text, worker_id, created_at
        FROM workhorse.job_checkpoint
       WHERE job_id = ${id}
      ORDER BY created_at, checkpoint_name
    `),
    database.execute<{
      wait_name: string;
      mode: "relative" | "absolute";
      duration_ms: string | null;
      requested_wake_at: Date | string | null;
      wake_at: Date | string;
      attempt: number;
      fence_token: string;
      worker_id: string;
      created_at: Date | string;
    }>(sql`
      SELECT wait_name, mode, duration_ms::text, requested_wake_at, wake_at, attempt,
             fence_token::text, worker_id, created_at
        FROM workhorse.job_wait
       WHERE job_id = ${id}
       ORDER BY created_at, wait_name
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
      retryPolicy: job.retry_policy,
      maxAttempts: job.max_attempts,
      deadlineAt: toIsoOrNull(job.deadline_at),
      executionTimeoutMs:
        job.execution_timeout_ms === null ? null : Number(job.execution_timeout_ms),
    },
    payload: job.payload,
    progress:
      job.progress_revision === null
        ? null
        : {
            value: job.progress_value,
            revision: job.progress_revision,
            attempt: job.progress_attempt!,
            fenceToken: job.progress_fence_token!,
            workerId: job.progress_worker_id!,
            createdAt: toIso(job.progress_created_at!),
            updatedAt: toIso(job.progress_updated_at!),
          },
    durability: projectDurability(job.type, job.payload),
    current: {
      runtime: job.runtime_state
        ? {
            state: job.runtime_state,
            attempt: job.runtime_attempt!,
            runAt: toIso(job.run_at!),
            readyAt: toIsoOrNull(job.ready_at),
            workerId: job.worker_id,
            fenceToken: job.fence_token,
            acquiredAt: toIsoOrNull(job.acquired_at),
            heartbeatAt: toIsoOrNull(job.heartbeat_at),
            expiresAt: toIsoOrNull(job.expires_at),
            waitName: job.wait_name,
            attemptStartedAt: toIsoOrNull(job.attempt_started_at),
            attemptTimeoutAt: toIsoOrNull(job.attempt_timeout_at),
            cancellation: cancellationRequest(
              job.cancel_requested_at,
              job.cancel_requested_by,
              job.cancel_reason,
            ),
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
      claimedAt: toIso(row.claimed_at),
      finishedAt: toIso(row.finished_at),
      durationMs: Number(row.execution_ms),
      executionMs: Number(row.execution_ms),
      elapsedMs: Number(row.elapsed_ms),
      error: row.error,
    })),
    checkpoints: checkpointRows.rows.map((row) => ({
      name: row.checkpoint_name,
      value: row.checkpoint_value,
      attempt: row.attempt,
      fenceToken: row.fence_token,
      workerId: row.worker_id,
      createdAt: toIso(row.created_at),
    })),
    waits: waitRows.rows.map((row) => ({
      name: row.wait_name,
      mode: row.mode,
      durationMs: row.duration_ms === null ? null : Number(row.duration_ms),
      requestedWakeAt: toIsoOrNull(row.requested_wake_at),
      wakeAt: toIso(row.wake_at),
      attempt: row.attempt,
      fenceToken: row.fence_token,
      workerId: row.worker_id,
      createdAt: toIso(row.created_at),
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

const eventsWindows: Record<DashboardEventsWindow, number> = {
  "15m": 900,
  "1h": 3_600,
  "6h": 21_600,
  "24h": 86_400,
};

export interface DashboardEventsQuery {
  window?: DashboardEventsWindow;
  /** 1-based page index. */
  page?: number;
  pageSize?: number;
  kind?: DashboardEventKind | "all";
  queue?: string | null;
  jobType?: string | null;
  /** Lifecycle event names and attempt outcomes to keep. Empty means every type. */
  types?: readonly string[];
  /** Restrict the feed to one job, for following a single task live. */
  jobId?: string | null;
}

/**
 * Read the fleet-wide event feed from the durable history tables.
 *
 * The feed is sourced from `job_event` and `attempt_history`, never from `LISTEN`/`NOTIFY`.
 * Notification payloads carry only a queue name, are coalesced by both the worker and the dashboard
 * listener, and are dropped entirely while no session is listening — a feed built from them would
 * be uninformative and silently incomplete. The notification channels keep their real job of
 * telling this page *when* to re-read; the rows below are what it shows.
 *
 * Every query is bounded by a time window so the descending scan stays on
 * `job_event (occurred_at, event_id)` and `attempt_history (occurred_at, attempt_id)` instead of
 * walking the whole retained history to fill a page that a narrow filter would otherwise starve.
 * The window is also what keeps the total count affordable: it is a count over one bounded slice of
 * two partitioned tables, not over everything retention still holds.
 */
export async function readDashboardEvents(
  database: DashboardDatabase,
  query: DashboardEventsQuery = {},
): Promise<DashboardEventsPage> {
  const window = query.window ?? "1h";
  const windowSeconds = eventsWindows[window];
  const pageSize = query.pageSize ?? 50;
  const page = Math.max(1, query.page ?? 1);
  const offset = (page - 1) * pageSize;
  // Either source can supply the whole page on its own, so each must be able to reach past the
  // offset by a full page before the merge picks between them.
  const reach = offset + pageSize;
  const kind = query.kind ?? "all";
  const queue = query.queue ?? null;
  const jobType = query.jobType ?? null;
  const jobId = query.jobId ?? null;
  const types = query.types ?? [];
  const typeArray = textArrayExpression([...types]);

  // Queue and task filters live on `job`, which history rows only reference. Testing them with a
  // primary-key EXISTS keeps the driving scan on the time-ordered history index; joining `job`
  // first would sort the whole window before the limit could apply.
  const jobMatches = (column: DashboardSql) => sql`(
    (${queue}::text IS NULL AND ${jobType}::text IS NULL)
    OR EXISTS (
      SELECT 1 FROM workhorse.job j
       WHERE j.id = ${column}
         AND (${queue}::text IS NULL OR j.queue_name = ${queue})
         AND (${jobType}::text IS NULL OR j.job_type = ${jobType})
    )
  )`;

  const eventCondition = sql`
    event.occurred_at >= clock_timestamp() - make_interval(secs => ${windowSeconds})
    AND (${jobId}::uuid IS NULL OR event.job_id = ${jobId}::uuid)
    AND (cardinality(${typeArray}) = 0 OR event.event_type = ANY (${typeArray}))
    AND ${jobMatches(sql`event.job_id`)}
  `;
  const attemptCondition = sql`
    history.occurred_at >= clock_timestamp() - make_interval(secs => ${windowSeconds})
    AND (${jobId}::uuid IS NULL OR history.job_id = ${jobId}::uuid)
    AND (cardinality(${typeArray}) = 0 OR history.outcome = ANY (${typeArray}))
    AND ${jobMatches(sql`history.job_id`)}
  `;

  const eventSource = sql`
    SELECT 'event'::text AS kind,
           event.event_id AS record_id,
           event.job_id,
           event.occurred_at,
           event.attempt,
           event.event_type AS type,
           event.details,
           NULL::text AS worker_id,
           NULL::bigint AS fence_token,
           NULL::timestamptz AS started_at,
           NULL::timestamptz AS finished_at,
           NULL::jsonb AS error,
           1 AS kind_rank
      FROM workhorse.job_event event
     WHERE ${eventCondition}
     ORDER BY event.occurred_at DESC, event.event_id DESC
     LIMIT ${reach}
  `;
  const attemptSource = sql`
    SELECT 'attempt'::text AS kind,
           history.attempt_id AS record_id,
           history.job_id,
           history.occurred_at,
           history.attempt,
           history.outcome AS type,
           NULL::jsonb AS details,
           history.worker_id,
           history.fence_token,
           history.started_at,
           history.finished_at,
           history.error,
           0 AS kind_rank
      FROM workhorse.attempt_history history
     WHERE ${attemptCondition}
     ORDER BY history.occurred_at DESC, history.attempt_id DESC
     LIMIT ${reach}
  `;
  const sources =
    kind === "event"
      ? eventSource
      : kind === "attempt"
        ? attemptSource
        : // Each branch carries its own ORDER BY and LIMIT so neither source can starve the other,
          // which is only legal inside parentheses.
          sql`
      (${eventSource})
      UNION ALL
      (${attemptSource})
    `;

  // Counted from the source tables rather than from `merged`, which stops at one page's reach.
  const countedEvents =
    kind === "attempt"
      ? sql`0::bigint`
      : sql`(SELECT count(*) FROM workhorse.job_event event WHERE ${eventCondition})`;
  const countedAttempts =
    kind === "event"
      ? sql`0::bigint`
      : sql`(SELECT count(*) FROM workhorse.attempt_history history WHERE ${attemptCondition})`;

  const [rows, totals, retention] = await Promise.all([
    database.execute<{
      kind: DashboardEventKind;
      record_id: string;
      job_id: string;
      queue_name: string | null;
      job_type: string | null;
      occurred_at: Date | string;
      attempt: number | null;
      type: string;
      details: unknown;
      worker_id: string | null;
      fence_token: string | null;
      duration_ms: string | null;
      error: unknown;
    }>(sql`
      WITH merged AS MATERIALIZED (
        ${sources}
      ), page AS MATERIALIZED (
        SELECT merged.* FROM merged
        ORDER BY merged.occurred_at DESC, merged.kind_rank DESC, merged.record_id DESC
        LIMIT ${pageSize}
       OFFSET ${offset}
      )
      SELECT page.kind,
             page.record_id::text,
             page.job_id::text,
             job.queue_name,
             job.job_type,
             page.occurred_at,
             page.attempt,
             page.type,
             page.details,
             page.worker_id,
             page.fence_token::text,
             CASE
               WHEN page.started_at IS NULL OR page.finished_at IS NULL THEN NULL
               ELSE round(extract(epoch FROM page.finished_at - page.started_at) * 1000)::text
             END AS duration_ms,
             page.error
        FROM page
        LEFT JOIN workhorse.job job ON job.id = page.job_id
       ORDER BY page.occurred_at DESC, page.kind_rank DESC, page.record_id DESC
    `),
    database.execute<{ count: string }>(sql`
      SELECT (${countedEvents} + ${countedAttempts})::text AS count
    `),
    database.execute<{
      job_event_retention_days: number | null;
      attempt_history_retention_days: number | null;
    }>(sql`
      SELECT job_event_retention_days, attempt_history_retention_days
        FROM workhorse.retention_policy
       WHERE singleton
    `),
  ]);

  const policy = retention.rows[0];
  return {
    capturedAt: new Date().toISOString(),
    window,
    windowSeconds,
    page,
    pageSize,
    total: Number(totals.rows[0]?.count ?? 0),
    retention: {
      jobEventDays: policy?.job_event_retention_days ?? null,
      attemptHistoryDays: policy?.attempt_history_retention_days ?? null,
    },
    events: rows.rows.map((row) => ({
      id: `${row.kind}:${row.record_id}`,
      kind: row.kind,
      recordId: row.record_id,
      jobId: row.job_id,
      queue: row.queue_name,
      jobType: row.job_type,
      occurredAt: toIso(row.occurred_at),
      attempt: row.attempt,
      type: row.type,
      details: row.details ?? null,
      workerId: row.worker_id,
      fenceToken: row.fence_token,
      durationMs: row.duration_ms === null ? null : Number(row.duration_ms),
      errorMessage: errorMessageOrNull(row.error),
    })),
  };
}

/** Read one history record by the stable identity used in Events URLs. */
export async function readDashboardEventDetail(
  database: DashboardDatabase,
  id: string,
): Promise<DashboardEventDetail | null> {
  const match = /^(event|attempt):(\d+)$/.exec(id);
  if (!match) return null;
  const kind = match[1] as DashboardEventKind;
  const recordId = match[2]!;
  const source =
    kind === "event"
      ? sql`
        SELECT 'event'::text AS kind,
               event.event_id::text AS record_id,
               event.job_id::text AS job_id,
               job.queue_name,
               job.job_type,
               event.occurred_at,
               event.attempt,
               event.event_type AS type,
               event.details,
               NULL::text AS worker_id,
               NULL::text AS fence_token,
               NULL::timestamptz AS started_at,
               NULL::timestamptz AS claimed_at,
               NULL::timestamptz AS finished_at,
               NULL::text AS duration_ms,
               NULL::jsonb AS error
          FROM workhorse.job_event event
          LEFT JOIN workhorse.job job ON job.id = event.job_id
         WHERE event.event_id = ${recordId}::bigint
      `
      : sql`
        SELECT 'attempt'::text AS kind,
               history.attempt_id::text AS record_id,
               history.job_id::text AS job_id,
               job.queue_name,
               job.job_type,
               history.occurred_at,
               history.attempt,
               history.outcome AS type,
               NULL::jsonb AS details,
               history.worker_id,
               history.fence_token::text,
               history.started_at,
               history.claimed_at,
               history.finished_at,
               round(extract(epoch FROM history.finished_at - history.started_at) * 1000)::text
                 AS duration_ms,
               history.error
          FROM workhorse.attempt_history history
          LEFT JOIN workhorse.job job ON job.id = history.job_id
         WHERE history.attempt_id = ${recordId}::bigint
      `;
  const result = await database.execute<{
    kind: DashboardEventKind;
    record_id: string;
    job_id: string;
    queue_name: string | null;
    job_type: string | null;
    occurred_at: Date | string;
    attempt: number | null;
    type: string;
    details: unknown;
    worker_id: string | null;
    fence_token: string | null;
    started_at: Date | string | null;
    claimed_at: Date | string | null;
    finished_at: Date | string | null;
    duration_ms: string | null;
    error: unknown;
  }>(source);
  const row = result.rows[0];
  if (!row) return null;
  return {
    id: `${row.kind}:${row.record_id}`,
    kind: row.kind,
    recordId: row.record_id,
    jobId: row.job_id,
    queue: row.queue_name,
    jobType: row.job_type,
    occurredAt: toIso(row.occurred_at),
    attempt: row.attempt,
    type: row.type,
    details: row.details ?? null,
    workerId: row.worker_id,
    fenceToken: row.fence_token,
    startedAt: row.started_at === null ? null : toIso(row.started_at),
    claimedAt: row.claimed_at === null ? null : toIso(row.claimed_at),
    finishedAt: row.finished_at === null ? null : toIso(row.finished_at),
    durationMs: row.duration_ms === null ? null : Number(row.duration_ms),
    error: row.error ?? null,
    errorMessage: errorMessageOrNull(row.error),
  };
}
