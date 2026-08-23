import { expectOneRow, queueHealthFromDocument } from "@workhorse-js/core";
import type { Admin, QueueHealthDocument, RetryPolicy } from "@workhorse-js/core";
import {
  DashboardActivityBucket,
  DashboardActivityGroupBy,
  DashboardActivityPage,
  DashboardActivityPeriod,
  DashboardCancellationRequest,
  DashboardConcurrencyPolicySummary,
  DashboardCronPage,
  DashboardEventDetail,
  DashboardEventKind,
  DashboardEventsPage,
  DashboardEventsWindow,
  DashboardJobDetail,
  DashboardHumanWaitPage,
  DashboardQueuesPage,
  DashboardRateLimitPolicySummary,
  DashboardRetentionCategory,
  DashboardRetentionCategoryRow,
  DashboardSystemPage,
  DashboardSystemRetention,
  DashboardSystemStorage,
  DashboardSystemWindow,
  DashboardTaskCounts,
  DashboardTaskFacets,
  DashboardTaskFilter,
  DashboardTaskSort,
  DashboardTasksPage,
  DashboardWorkersPage,
  DashboardSettingsPage,
  MaintenanceLoopCadences,
  dashboardConcurrencyPolicySummary,
  dashboardRateLimitPolicySummary,
  readIdempotencyEvidence,
} from "../wire.js";
import {
  statAttemptErrors,
  statAttempts,
  statCompleted,
  statWindow,
  statWindowStart,
} from "./rolling-stats.js";
import { sql, type DashboardDatabase, type DashboardSql } from "./sql.js";
import type { DashboardDurabilityProjector } from "./types.js";

function toIso(value: Date | string): string {
  return new Date(value).toISOString();
}

function toIsoOrNull(value: Date | string | null): string | null {
  return value ? toIso(value) : null;
}

async function readQueueHealth(database: DashboardDatabase) {
  const result = await database.execute<{ snapshot: QueueHealthDocument }>(sql`
    SELECT workhorse.queue_health_v1() AS snapshot
  `);
  return queueHealthFromDocument(expectOneRow(result, "the queue health snapshot").snapshot);
}

const currentSignalWaitColumn = sql`
  signal_wait.deadline_at AS signal_wait_deadline_at
`;
const currentSignalWaitJoin = sql`
  LEFT JOIN workhorse.dashboard_signal_wait_v1 signal_wait
    ON signal_wait.job_id = j.id AND signal_wait.signal_name = r.wait_name
`;
const currentHumanWaitColumns = sql`
  human_wait.token_name AS human_wait_name,
  human_wait.context AS human_wait_context,
  human_wait.deadline_at AS human_wait_deadline_at
`;
const currentHumanWaitJoin = sql`
  LEFT JOIN workhorse.dashboard_human_wait_v1 human_wait
    ON human_wait.job_id = j.id AND human_wait.token_name = r.wait_name
`;

function signalWaitSummary(
  name: string | null,
  deadlineAt: Date | string | null,
): { name: string; deadlineAt: string } | null {
  return name && deadlineAt ? { name, deadlineAt: toIso(deadlineAt) } : null;
}

export async function readDashboardHumanWaits(
  database: DashboardDatabase,
  admin: Admin,
  canComplete: boolean,
  canSignal: boolean,
): Promise<DashboardHumanWaitPage> {
  const [waitPage, signalWaitPage, health] = await Promise.all([
    admin.listHumanWaits(),
    admin.listSignalWaits(),
    readQueueHealth(database),
  ]);
  return {
    capturedAt: new Date().toISOString(),
    canComplete,
    canSignal,
    diagnostics: health.externalWaits,
    waits: waitPage.items.map((wait) => ({
      jobId: wait.jobId,
      queue: wait.queue,
      jobType: wait.jobType,
      name: wait.name,
      context: wait.context,
      attempt: wait.attempt,
      createdAt: wait.createdAt.toISOString(),
      deadlineAt: wait.deadlineAt.toISOString(),
    })),
    signalWaits: signalWaitPage.items.map((wait) => ({
      jobId: wait.jobId,
      queue: wait.queue,
      jobType: wait.jobType,
      name: wait.name,
      attempt: wait.attempt,
      createdAt: wait.createdAt.toISOString(),
      deadlineAt: wait.deadlineAt.toISOString(),
    })),
  };
}

export async function readDashboardSettings(
  database: DashboardDatabase,
  admin: Admin,
  editable: boolean,
): Promise<DashboardSettingsPage> {
  const [maintenance, retention, health, enqueued, workers] = await Promise.all([
    admin.getMaintenancePolicy(),
    admin.getRetentionPolicy(),
    readQueueHealth(database),
    // Measured arrival rate for the recommendation engine, over one stitched statistics hour so
    // the reading works whether or not the rollup has materialized the window yet.
    database.execute<{ jobs: string | number }>(sql`
      SELECT COALESCE(sum(stat.enqueued), 0)::bigint AS jobs FROM ${statWindow(3_600)}
    `),
    database.execute<{
      worker_id: string;
      queue_names: string[];
      concurrency: number;
      lease_ms: number;
      heartbeat_ms: number;
      poll_ms: number;
      maintenance_interval_ms: number;
      maintenance_task_poll_ms: number;
      registry_interval_ms: number;
      last_heartbeat_at: Date | string;
    }>(sql`
      SELECT worker_id, queue_names, concurrency, lease_ms, heartbeat_ms, poll_ms,
             maintenance_interval_ms, maintenance_task_poll_ms, registry_interval_ms,
             last_heartbeat_at
        FROM workhorse.dashboard_worker_registry_v1
       WHERE last_heartbeat_at >= clock_timestamp() - GREATEST(
         interval '30 seconds', registry_interval_ms * 3 * interval '1 millisecond'
       )
       ORDER BY worker_id
    `),
  ]);
  return {
    capturedAt: new Date().toISOString(),
    editable,
    maintenance: { ...maintenance, updatedAt: toIso(maintenance.updatedAt) },
    retention: { ...retention, updatedAt: toIso(retention.updatedAt) },
    recommendationInputs: {
      reasons: health.status.reasons.map((reason) => ({ ...reason })),
      statistics: {
        rolledUpThrough: health.statistics.rolledUpThrough.toISOString(),
        lagMs: Number(health.statistics.lagMs),
        lastRunAt: toIsoOrNull(health.statistics.lastRunAt),
      },
      defaultHistoryRows: {
        jobEvents: Number(health.defaultHistoryRows.jobEvents),
        attemptHistory: Number(health.defaultHistoryRows.attemptHistory),
      },
      defaultHistoryRowsCapped: { ...health.defaultHistoryRowsCapped },
      enqueueRate: { jobs: Number(enqueued.rows[0]?.jobs ?? 0), windowMs: 3_600_000 },
    },
    workers: workers.rows.map((worker) => ({
      id: worker.worker_id,
      queue: worker.queue_names[0]!,
      queues: worker.queue_names,
      concurrency: Number(worker.concurrency),
      leaseMs: Number(worker.lease_ms),
      heartbeatMs: Number(worker.heartbeat_ms),
      pollMs: Number(worker.poll_ms),
      maintenanceIntervalMs: Number(worker.maintenance_interval_ms),
      maintenanceTaskPollMs: Number(worker.maintenance_task_poll_ms),
      registryIntervalMs: Number(worker.registry_interval_ms),
      lastSeenAt: toIso(worker.last_heartbeat_at),
    })),
  };
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
  if (filter === "blocked") return sql`state = 'blocked'`;
  if (filter === "waiting") return sql`external_wait`;
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

function externalWaitExists(jobId: DashboardSql) {
  return sql`
    EXISTS (SELECT 1 FROM workhorse.dashboard_signal_wait_v1 signal_wait
             WHERE signal_wait.job_id = ${jobId})
    OR EXISTS (SELECT 1 FROM workhorse.dashboard_human_wait_v1 human_wait
                WHERE human_wait.job_id = ${jobId})
  `;
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
  priority: number | null;
}) {
  const { queue, worker, jobType, tags, searchPattern, priority } = options;
  const tagArray = textArrayExpression(tags);
  return sql`
    (${queue}::text IS NULL OR queue = ${queue})
    AND (${worker}::text IS NULL OR worker_id = ${worker})
    AND (${jobType}::text IS NULL OR type = ${jobType})
    AND (${priority}::integer IS NULL OR priority = ${priority})
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
    SELECT estimate FROM workhorse.dashboard_job_estimate_v1()
  `);
  const jobEstimate = Number(relRows.rows[0]?.estimate ?? -1);
  // reltuples is -1 until the first vacuum/analyze; treat unknown as small.
  if (jobEstimate < approximateCountThreshold) {
    return readDashboardTaskCountsExact(database);
  }

  const runtimeRows = await database.execute<{
    blocked_count: number;
    waiting_count: number;
    scheduled_count: number;
    queued_count: number;
    running_count: number;
    retried_live_count: number;
  }>(sql`
    SELECT count(*) FILTER (WHERE state = 'blocked')::integer AS blocked_count,
           count(*) FILTER (WHERE ${externalWaitExists(sql`runtime.job_id`)})::integer
             AS waiting_count,
           count(*) FILTER (WHERE state = 'scheduled')::integer AS scheduled_count,
           count(*) FILTER (WHERE state = 'ready')::integer AS queued_count,
           count(*) FILTER (WHERE state = 'active')::integer AS running_count,
           count(*) FILTER (WHERE current_attempt > 1)::integer AS retried_live_count
      FROM workhorse.dashboard_job_runtime_v1 runtime
  `);
  const live = expectOneRow(runtimeRows, "the live job runtime counts");
  const [completed, discarded, canceled, retriedTerminal] = await Promise.all([
    estimateRows(
      database,
      sql`SELECT 1 FROM workhorse.dashboard_job_outcome_v1 WHERE state = 'succeeded'`,
    ),
    estimateRows(
      database,
      sql`SELECT 1 FROM workhorse.dashboard_job_outcome_v1 WHERE state = 'failed'`,
    ),
    estimateRows(
      database,
      sql`SELECT 1 FROM workhorse.dashboard_job_outcome_v1 WHERE state = 'canceled'`,
    ),
    estimateRows(
      database,
      sql`SELECT 1 FROM workhorse.dashboard_job_outcome_v1 WHERE current_attempt > 1`,
    ),
  ]);

  return {
    all: jobEstimate,
    blocked: live.blocked_count,
    waiting: live.waiting_count,
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
    blocked_count: number;
    waiting_count: number;
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
             ${externalWaitExists(sql`j.id`)} AS external_wait,
             COALESCE(r.current_attempt, o.current_attempt) AS attempt
        FROM workhorse.dashboard_job_v1 j
        LEFT JOIN workhorse.dashboard_job_runtime_v1 r ON r.job_id = j.id
        LEFT JOIN workhorse.dashboard_job_outcome_v1 o ON o.job_id = j.id
    )
    SELECT count(*)::integer AS all_count,
           count(*) FILTER (WHERE state = 'blocked')::integer AS blocked_count,
           count(*) FILTER (WHERE external_wait)::integer AS waiting_count,
           count(*) FILTER (WHERE state = 'scheduled')::integer AS scheduled_count,
           count(*) FILTER (WHERE attempt > 1)::integer AS retried_count,
           count(*) FILTER (WHERE state = 'ready')::integer AS queued_count,
           count(*) FILTER (WHERE state = 'active')::integer AS running_count,
           count(*) FILTER (WHERE state = 'succeeded')::integer AS completed_count,
           count(*) FILTER (WHERE state = 'failed')::integer AS discarded_count,
           count(*) FILTER (WHERE state = 'canceled')::integer AS canceled_count
      FROM tasks
  `);
  const counts = expectOneRow(countRows, "the task attempt counts");

  return {
    all: counts.all_count,
    blocked: counts.blocked_count,
    waiting: counts.waiting_count,
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
  const [queueRows, relationRows, health] = await Promise.all([
    database.execute<{
      queue: string;
      paused: boolean;
      scheduled: number;
      ready: number;
      active: number;
    }>(sql`
      WITH known_queues AS (
        SELECT queue_name FROM workhorse.dashboard_job_v1
        UNION
        SELECT queue_name FROM workhorse.dashboard_queue_control_v1
        UNION
        SELECT queue_name FROM workhorse.dashboard_concurrency_policy_v1
        UNION
        SELECT queue_name FROM workhorse.dashboard_rate_limit_policy_v1
      ), live_counts AS (
        SELECT queue_name,
               count(*) FILTER (WHERE state = 'scheduled')::integer AS scheduled,
               count(*) FILTER (WHERE state = 'ready')::integer AS ready,
               count(*) FILTER (WHERE state = 'active')::integer AS active
          FROM workhorse.dashboard_job_runtime_v1
         GROUP BY queue_name
      )
      SELECT known.queue_name AS queue, COALESCE(control.paused, false) AS paused,
             COALESCE(live.scheduled, 0)::integer AS scheduled,
             COALESCE(live.ready, 0)::integer AS ready,
             COALESCE(live.active, 0)::integer AS active
        FROM known_queues known
        LEFT JOIN workhorse.dashboard_queue_control_v1 control USING (queue_name)
        LEFT JOIN live_counts live USING (queue_name)
       ORDER BY known.queue_name
    `),
    database.execute<{ estimate: string | number }>(sql`
      SELECT estimate FROM workhorse.dashboard_job_estimate_v1()
    `),
    readQueueHealth(database),
  ]);
  const approximate = Number(relationRows.rows[0]?.estimate ?? -1) >= approximateCountThreshold;

  let terminalCounts: Map<string, { succeeded: number; failed: number; canceled: number }>;
  if (approximate) {
    const estimates = await Promise.all(
      queueRows.rows.map(async (row) => {
        const [succeeded, failed, canceled] = await Promise.all([
          estimateRows(
            database,
            sql`SELECT 1 FROM workhorse.dashboard_job_outcome_v1 outcome
                  JOIN workhorse.dashboard_job_v1 job ON job.id = outcome.job_id
                 WHERE job.queue_name = ${row.queue} AND outcome.state = 'succeeded'`,
          ),
          estimateRows(
            database,
            sql`SELECT 1 FROM workhorse.dashboard_job_outcome_v1 outcome
                  JOIN workhorse.dashboard_job_v1 job ON job.id = outcome.job_id
                 WHERE job.queue_name = ${row.queue} AND outcome.state = 'failed'`,
          ),
          estimateRows(
            database,
            sql`SELECT 1 FROM workhorse.dashboard_job_outcome_v1 outcome
                  JOIN workhorse.dashboard_job_v1 job ON job.id = outcome.job_id
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
        FROM workhorse.dashboard_job_outcome_v1 outcome
        JOIN workhorse.dashboard_job_v1 job ON job.id = outcome.job_id
       GROUP BY job.queue_name
    `);
    terminalCounts = new Map(
      exactRows.rows.map((row) => [
        row.queue,
        { succeeded: row.succeeded, failed: row.failed, canceled: row.canceled },
      ]),
    );
  }

  const admissionPolicies = dashboardAdmissionPolicies(health);

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
      concurrencyPolicy: admissionPolicies.concurrency.get(row.queue) ?? null,
      rateLimitPolicy: admissionPolicies.rateLimits.get(row.queue) ?? null,
    })),
    concurrencyPoliciesCapped: health.concurrencyPolicies.capped,
    rateLimitPoliciesCapped: health.rateLimitPolicies.capped,
  };
}

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
            FROM workhorse.dashboard_attempt_history_v1 ah
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
      SELECT r.job_id FROM workhorse.dashboard_job_runtime_v1 r
       WHERE r.updated_at >= clock_timestamp() - make_interval(secs => ${windowSeconds})
      UNION
      SELECT o.job_id FROM workhorse.dashboard_job_outcome_v1 o
       WHERE o.updated_at >= clock_timestamp() - make_interval(secs => ${windowSeconds})
    ), tasks AS (
      SELECT ${groupExpression} AS group_key,
             COALESCE(r.state, o.state) AS state,
             ${externalWaitExists(sql`candidate.job_id`)} AS external_wait,
             COALESCE(r.current_attempt, o.current_attempt) AS attempt,
             COALESCE(r.updated_at, o.updated_at) AS updated_at,
             j.tags, j.queue_name AS queue,
             ${workerExpression} AS worker_id
        FROM candidate
        JOIN workhorse.dashboard_job_v1 j ON j.id = candidate.job_id
        LEFT JOIN workhorse.dashboard_job_runtime_v1 r ON r.job_id = candidate.job_id
        LEFT JOIN workhorse.dashboard_job_outcome_v1 o ON o.job_id = candidate.job_id${attemptWorkerJoin}
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
  // oxlint-disable-next-line unicorn/no-array-sort -- ES2022 lacks Array.prototype.toSorted.
  const groups = [...totals.keys()].sort();
  const byBucket = new Map<string, DashboardActivityBucket>();
  for (const row of rows.rows) {
    const bucketStart = toIso(row.bucket_start);
    let bucket = byBucket.get(bucketStart);
    if (!bucket) {
      bucket = { bucketStart, counts: {} };
      byBucket.set(bucketStart, bucket);
    }
    if (row.group_key === null) continue;
    bucket.counts[row.group_key] = row.count;
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

export interface DashboardTasksQuery {
  filter: DashboardTaskFilter;
  page: number;
  pageSize: number;
  queue: string | null;
  tags: readonly string[];
  search: string | null;
  worker: string | null;
  jobType: string | null;
  priority: number | null;
  sort: DashboardTaskSort;
}

export async function readDashboardTasks(
  database: DashboardDatabase,
  query: DashboardTasksQuery,
  projectDurability: DashboardDurabilityProjector = () => null,
  canCompleteHumanWait = false,
): Promise<DashboardTasksPage> {
  const { filter, page, pageSize, queue, tags, search, worker, jobType, priority, sort } = query;
  const offset = (page - 1) * pageSize;
  const searchPattern = taskSearchPattern(search);
  const queryCondition = taskQueryCondition({
    queue,
    worker,
    jobType,
    tags,
    searchPattern,
    priority,
  });
  const taskOrder =
    sort === "priority"
      ? sql`priority DESC, updated_at DESC, id DESC`
      : sql`updated_at DESC, id DESC`;
  const [counts, totalRows, jobRows] = await Promise.all([
    readDashboardTaskCounts(database),
    database.execute<{ count: number }>(sql`
      WITH tasks AS (
        SELECT j.id, j.queue_name AS queue, j.job_type AS type, j.tags, j.priority,
               COALESCE(r.state, o.state) AS state,
               ${externalWaitExists(sql`j.id`)} AS external_wait,
               COALESCE(r.current_attempt, o.current_attempt) AS attempt,
               COALESCE(r.worker_id, current_wait.worker_id, attempt_worker.worker_id,
                        'unassigned') AS worker_id
          FROM workhorse.dashboard_job_v1 j
          LEFT JOIN workhorse.dashboard_job_runtime_v1 r ON r.job_id = j.id
          LEFT JOIN workhorse.dashboard_job_outcome_v1 o ON o.job_id = j.id
          LEFT JOIN workhorse.dashboard_job_wait_v1 current_wait
            ON current_wait.job_id = j.id AND current_wait.wait_name = r.wait_name
          LEFT JOIN LATERAL (
            SELECT ah.worker_id FROM workhorse.dashboard_attempt_history_v1 ah
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
      priority: number;
      state: string;
      blocked_reason: "prerequisite_pending" | null;
      prerequisite_job_ids: string[];
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
      signal_wait_deadline_at: Date | string | null;
      human_wait_name: string | null;
      human_wait_context: unknown;
      human_wait_deadline_at: Date | string | null;
      cancel_requested_at: Date | string | null;
      cancel_requested_by: string | null;
      cancel_reason: string | null;
      enqueued_details: unknown;
    }>(sql`
      WITH tasks AS (
        SELECT j.id, j.queue_name AS queue, j.job_type AS type, j.priority,
               COALESCE(r.state, o.state) AS state,
               ${externalWaitExists(sql`j.id`)} AS external_wait,
               CASE WHEN r.state = 'blocked' THEN 'prerequisite_pending' END AS blocked_reason,
               ARRAY(
                 SELECT dependency.prerequisite_job_id
                   FROM workhorse.dashboard_job_dependency_v1 dependency
                  WHERE dependency.dependent_job_id = j.id
                    AND dependency.released_at IS NULL
                  ORDER BY dependency.prerequisite_job_id
               ) AS prerequisite_job_ids,
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
               ${currentSignalWaitColumn},
               ${currentHumanWaitColumns},
               enqueued_event.details AS enqueued_details,
               ARRAY(SELECT checkpoint.checkpoint_name
                       FROM workhorse.dashboard_job_checkpoint_v1 checkpoint
                      WHERE checkpoint.job_id = j.id
                      ORDER BY checkpoint.checkpoint_name) AS checkpoint_names
          FROM workhorse.dashboard_job_v1 j
          LEFT JOIN workhorse.dashboard_job_runtime_v1 r ON r.job_id = j.id
          LEFT JOIN workhorse.dashboard_job_outcome_v1 o ON o.job_id = j.id
          LEFT JOIN workhorse.dashboard_job_wait_v1 durable_wait
            ON durable_wait.job_id = j.id AND durable_wait.wait_name = r.wait_name
          ${currentSignalWaitJoin}
          ${currentHumanWaitJoin}
          LEFT JOIN LATERAL (
            SELECT event.details FROM workhorse.dashboard_job_event_v1 event
             WHERE event.job_id = j.id AND event.event_type = 'enqueued'
             ORDER BY event.occurred_at, event.event_id LIMIT 1
          ) enqueued_event ON true
          LEFT JOIN LATERAL (
            SELECT ah.worker_id FROM workhorse.dashboard_attempt_history_v1 ah
             WHERE ah.job_id = j.id ORDER BY ah.attempt DESC LIMIT 1
          ) attempt_worker ON true
      )
      SELECT *
        FROM tasks
       WHERE ${taskFilterCondition(filter)} AND ${queryCondition}
       ORDER BY ${taskOrder}
       LIMIT ${pageSize}
      OFFSET ${offset}
    `),
  ]);
  return {
    capturedAt: new Date().toISOString(),
    canCompleteHumanWait,
    filter,
    queue,
    worker,
    jobType,
    priority,
    sort,
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
        priority: row.priority,
        state: row.state,
        blockedReason: row.blocked_reason,
        prerequisiteJobIds: row.prerequisite_job_ids,
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
        signalWait: signalWaitSummary(row.wait_name, row.signal_wait_deadline_at),
        humanWait:
          row.human_wait_name && row.human_wait_deadline_at
            ? {
                name: row.human_wait_name,
                context: row.human_wait_context,
                deadlineAt: toIso(row.human_wait_deadline_at),
              }
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
      SELECT queue_name AS value FROM workhorse.dashboard_job_v1
      UNION SELECT queue_name FROM workhorse.dashboard_queue_control_v1
    ), worker_values AS (
      SELECT worker AS value FROM configured_workers
      UNION SELECT worker_id FROM workhorse.dashboard_job_runtime_v1 WHERE worker_id IS NOT NULL
      UNION SELECT worker_id FROM workhorse.dashboard_attempt_history_v1 WHERE worker_id IS NOT NULL
    ), type_values AS (
      SELECT DISTINCT job_type AS value FROM workhorse.dashboard_job_v1
    ), tag_values AS (
      SELECT DISTINCT unnest(tags) AS value FROM workhorse.dashboard_job_v1
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
      priority: number;
      enabled: boolean;
      revision: string;
      updated_at: Date | string;
      occurrence_count: number;
      last_fired_at: Date | string | null;
    }>(sql`
      SELECT d.namespace, d.schedule_name AS name, d.cron_expression AS cron,
             d.queue_name AS queue, d.job_type AS type, d.priority, d.enabled,
             d.revision::text AS revision, d.updated_at,
             count(o.occurrence_at)::integer AS occurrence_count,
             max(o.fired_at) AS last_fired_at
        FROM workhorse.dashboard_schedule_definition_v1 d
        LEFT JOIN workhorse.dashboard_schedule_occurrence_v1 o
          ON o.namespace = d.namespace AND o.schedule_name = d.schedule_name
       GROUP BY d.namespace, d.schedule_name, d.cron_expression, d.queue_name, d.job_type, d.priority,
                d.enabled, d.revision, d.updated_at
       ORDER BY d.namespace, d.schedule_name
       LIMIT 50
    `),
    database.execute<{
      timezone: string;
      partition_preparation_interval_ms: number;
      terminal_cleanup_interval_ms: number;
      history_retention_local_time: string;
      updated_at: Date | string;
    }>(sql`
      SELECT timezone, partition_preparation_interval_ms, terminal_cleanup_interval_ms,
             history_retention_local_time::text, updated_at
        FROM workhorse.dashboard_maintenance_policy_v1 WHERE singleton
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
                   >= policy.history_retention_local_time
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
        FROM workhorse.dashboard_maintenance_state_v1 state
        CROSS JOIN workhorse.dashboard_maintenance_policy_v1 policy
       WHERE policy.singleton
       ORDER BY state.task_name
    `),
  ]);
  const policy = expectOneRow(policyRows, "the maintenance policy read");
  const maintenanceTasks = stateRows.rows.flatMap((row) => {
    const task = row.task_name;
    if (
      task !== "history_partitions" &&
      task !== "history_retention" &&
      task !== "terminal_storage"
    ) {
      return [];
    }
    const taskName: "history_partitions" | "history_retention" | "terminal_storage" = task;
    return [
      {
        task: taskName,
        lastStartedAt: toIsoOrNull(row.last_started_at),
        lastCompletedAt: toIsoOrNull(row.last_completed_at),
        due: row.due,
        incomplete: row.incomplete,
      },
    ];
  });

  return {
    capturedAt: now.toISOString(),
    schedules: scheduleRows.rows.map((row) => {
      return {
        kind: "user" as const,
        identity: { kind: "user" as const, namespace: row.namespace, name: row.name },
        namespace: row.namespace,
        name: row.name,
        cron: row.cron,
        queue: row.queue,
        type: row.type,
        priority: row.priority,
        enabled: row.enabled,
        active: row.enabled,
        revision: row.revision,
        updatedAt: toIso(row.updated_at),
        occurrenceCount: row.occurrence_count,
        lastFiredAt: toIsoOrNull(row.last_fired_at),
      };
    }),
    maintenance: {
      cadences: maintenanceLoops,
      policy: {
        timezone: policy.timezone,
        partitionPreparationIntervalMs: Number(policy.partition_preparation_interval_ms),
        terminalCleanupIntervalMs: Number(policy.terminal_cleanup_interval_ms),
        historyRetentionLocalTime: policy.history_retention_local_time.slice(0, 5),
        updatedAt: toIso(policy.updated_at),
      },
      tasks: maintenanceTasks,
    },
  };
}
const dashboardSystemWindowSeconds: Record<DashboardSystemWindow, number> = {
  "15m": 15 * 60,
  "1h": 60 * 60,
  "24h": 24 * 60 * 60,
};

// Promotion is expected to complete within a few maintenance ticks under normal operation.
const dashboardPromotionGraceSeconds = 10;

const dashboardRetryBucketUpperBounds: Array<number | null> = [
  60_000,
  300_000,
  900_000,
  3_600_000,
  null,
];

type QueueHealthSnapshot = Awaited<ReturnType<Admin["health"]>>;

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
  policyKey: RetentionDaysKey;
  prunedByPartition: boolean;
}> = [
  {
    category: "jobIdentity",
    policyKey: "jobIdentityRetentionDays",
    prunedByPartition: false,
  },
  {
    category: "terminalOutcome",
    policyKey: "terminalOutcomeRetentionDays",
    prunedByPartition: false,
  },
  {
    category: "jobEvents",
    policyKey: "jobEventRetentionDays",
    prunedByPartition: true,
  },
  {
    category: "attemptHistory",
    policyKey: "attemptHistoryRetentionDays",
    prunedByPartition: true,
  },
  {
    category: "scheduleOccurrences",
    policyKey: "scheduleOccurrenceRetentionDays",
    prunedByPartition: false,
  },
  {
    category: "statistics",
    policyKey: "statisticsRetentionDays",
    prunedByPartition: false,
  },
];

const dashboardStorageRelations = [
  "job",
  "job_outcome",
  "job_runtime",
  "job_query",
  "job_event",
  "attempt_history",
  "schedule_occurrence",
  "job_stat_bucket",
  "job_stat_bucket_hour",
  "job_stat_bucket_day",
] as const;

function dashboardStorage(health: QueueHealthSnapshot): DashboardSystemStorage {
  const byRelation = new Map(health.observations.relations.map((row) => [row.relation, row]));
  const relations = dashboardStorageRelations
    .map((relation) => {
      const row = byRelation.get(relation);
      return {
        relation,
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
      // The stall budget lives in core with the other health budgets.
      stalled: health.status.reasons.some((reason) => reason.code === "rollup-stalled"),
    },
    relations,
    totalBytes: relations.reduce((total, row) => total + row.totalBytes, 0),
  };
}

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

function dashboardAdmissionPolicies(health: QueueHealthSnapshot) {
  return {
    concurrency: new Map<string, DashboardConcurrencyPolicySummary>(
      health.concurrencyPolicies.policies.map((policy) => [
        policy.queue,
        dashboardConcurrencyPolicySummary(policy),
      ]),
    ),
    rateLimits: new Map<string, DashboardRateLimitPolicySummary>(
      health.rateLimitPolicies.policies.map((policy) => [
        policy.queue,
        dashboardRateLimitPolicySummary(policy),
      ]),
    ),
  };
}

export async function readDashboardSystem(
  database: DashboardDatabase,
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
    priorityBacklogRows,
    retryTypeRows,
    failingTypeRows,
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
    database.execute<{ p50_ms: number | null; p95_ms: number | null; p99_ms: number | null }>(sql`
      WITH merged AS (
        SELECT workhorse.stat_sketch_merge_v1(array_agg(stat.wait_sketch)) AS wait_sketch
          FROM ${statWindow(windowSeconds)}
      )
      SELECT workhorse.stat_sketch_percentile_v1(wait_sketch, 0.50) AS p50_ms,
             workhorse.stat_sketch_percentile_v1(wait_sketch, 0.95) AS p95_ms,
             workhorse.stat_sketch_percentile_v1(wait_sketch, 0.99) AS p99_ms
        FROM merged
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
        FROM workhorse.dashboard_job_runtime_v1
    `),
    database.execute<{ upper_bound_ms: number | null; count: number }>(sql`
      SELECT CASE
               WHEN run_at <= clock_timestamp() + interval '1 minute' THEN 60000
               WHEN run_at <= clock_timestamp() + interval '5 minutes' THEN 300000
               WHEN run_at <= clock_timestamp() + interval '15 minutes' THEN 900000
               WHEN run_at <= clock_timestamp() + interval '1 hour' THEN 3600000
               ELSE NULL
             END AS upper_bound_ms,
             count(*)::integer AS count
        FROM workhorse.dashboard_job_runtime_v1
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
        SELECT queue_name FROM workhorse.dashboard_job_runtime_v1
        UNION SELECT queue_name FROM workhorse.dashboard_queue_control_v1
        UNION SELECT queue_name FROM workhorse.dashboard_concurrency_policy_v1
        UNION SELECT queue_name FROM workhorse.dashboard_rate_limit_policy_v1
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
          FROM workhorse.dashboard_job_runtime_v1 GROUP BY queue_name
      )
      SELECT q.queue_name AS queue, COALESCE(c.paused, false) AS paused,
             COALESCE(r.ready, 0)::integer AS ready, r.oldest_ready_ms,
             COALESCE(r.due_soon, 0)::integer AS due_soon,
             COALESCE(r.active, 0)::integer AS active,
             COALESCE(r.retrying, 0)::integer AS retrying,
             COALESCE(s.enqueued, 0)::integer AS enqueued,
             COALESCE(s.completed, 0)::integer AS completed
        FROM queue_names q
        LEFT JOIN workhorse.dashboard_queue_control_v1 c USING (queue_name)
        LEFT JOIN runtime r USING (queue_name)
        LEFT JOIN rolled s USING (queue_name)
       ORDER BY q.queue_name
    `),
    database.execute<{
      queue: string;
      priority: number;
      ready: number;
      oldest_ready_ms: number;
    }>(sql`
      SELECT runtime.queue_name AS queue, job.priority, count(*)::integer AS ready,
             extract(epoch FROM clock_timestamp() - min(runtime.ready_at)) * 1000
               AS oldest_ready_ms
        FROM workhorse.dashboard_job_runtime_v1 runtime
        JOIN workhorse.dashboard_job_v1 job ON job.id = runtime.job_id
       WHERE runtime.state = 'ready'
       GROUP BY runtime.queue_name, job.priority
       ORDER BY runtime.queue_name, job.priority DESC
    `),
    database.execute<{ queue: string; type: string; count: number }>(sql`
      SELECT j.queue_name AS queue, j.job_type AS type, count(*)::integer AS count
        FROM workhorse.dashboard_job_runtime_v1 r JOIN workhorse.dashboard_job_v1 j ON j.id = r.job_id
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
    // Retention facts, partition existence, and the status verdict come from the canonical queue
    // read model rather than duplicated SQL here.
    readQueueHealth(database),
  ]);

  const summary = expectOneRow(summaryRows, "the snapshot summary read");
  const runtime = expectOneRow(runtimeRows, "the snapshot runtime read");
  const wait = expectOneRow(waitRows, "the snapshot durable-wait read");
  const retention = dashboardRetention(health);
  const storage = dashboardStorage(health);
  const minutes = windowSeconds / 60;
  const errorRate =
    summary.current_attempts === 0 ? 0 : summary.current_errors / summary.current_attempts;
  const previousErrorRate =
    summary.previous_attempts === 0 ? 0 : summary.previous_errors / summary.previous_attempts;
  const retryByUpperBound = new Map(retryRows.rows.map((row) => [row.upper_bound_ms, row.count]));
  const retryBuckets = dashboardRetryBucketUpperBounds.map((upperBoundMs) => ({
    upperBoundMs,
    count: retryByUpperBound.get(upperBoundMs) ?? 0,
  }));
  const partitions = health.historyPartitionDays.map((row) => ({
    day: row.day,
    startsAt: toIso(row.startsAt),
    eventExists: row.hasJobEvents,
    attemptExists: row.hasAttemptHistory,
  }));
  const status = {
    level: health.status.level as DashboardSystemPage["status"]["level"],
    reasons: health.status.reasons.map((reason) => ({ ...reason })),
  };

  const admissionPolicies = dashboardAdmissionPolicies(health);
  const priorityBacklogByQueue = new Map<
    string,
    Array<{ priority: number; ready: number; oldestReadyMs: number }>
  >();
  for (const row of priorityBacklogRows.rows) {
    const lanes = priorityBacklogByQueue.get(row.queue) ?? [];
    lanes.push({
      priority: row.priority,
      ready: row.ready,
      oldestReadyMs: row.oldest_ready_ms,
    });
    priorityBacklogByQueue.set(row.queue, lanes);
  }
  const queues = queueRows.rows.map((row) => ({
    queue: row.queue,
    paused: row.paused,
    ready: row.ready,
    oldestReadyMs: row.oldest_ready_ms,
    priorityBacklog: priorityBacklogByQueue.get(row.queue) ?? [],
    dueSoon: row.due_soon,
    active: row.active,
    retrying: row.retrying,
    enqueuedPerMinute: row.enqueued / minutes,
    completedPerMinute: row.completed / minutes,
    concurrencyPolicy: admissionPolicies.concurrency.get(row.queue) ?? null,
    rateLimitPolicy: admissionPolicies.rateLimits.get(row.queue) ?? null,
  }));
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
      dependencies: { ...health.dependencies },
      children: { ...health.children },
      externalWaits: { ...health.externalWaits },
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
    concurrencyPoliciesCapped: health.concurrencyPolicies.capped,
    rateLimitPoliciesCapped: health.rateLimitPolicies.capped,
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
    queue_names: string[] | null;
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
      SELECT worker_id FROM workhorse.dashboard_worker_registry_v1
      UNION
      SELECT id FROM declared
    ), active AS (
      SELECT worker_id AS id, count(*)::integer AS active_jobs, max(acquired_at) AS last_seen_at
        FROM workhorse.dashboard_job_runtime_v1
       WHERE state = 'active' AND worker_id IN (SELECT id FROM fleet)
       GROUP BY worker_id
    ), recent_history AS (
      -- Exact counts are cheap here because both time predicates keep partition scans to one hour.
      SELECT worker_id AS id, count(*)::integer AS completed_attempts,
             count(*) FILTER (WHERE outcome = 'failed')::integer AS failed_attempts,
             avg(extract(epoch FROM finished_at - claimed_at) * 1000)::double precision
               AS average_execution_ms,
             max(finished_at) AS last_seen_at
        FROM workhorse.dashboard_attempt_history_v1
       WHERE occurred_at >= clock_timestamp() - interval '1 hour'
         AND finished_at >= clock_timestamp() - interval '1 hour'
         AND worker_id IN (SELECT id FROM fleet)
       GROUP BY worker_id
    )
    SELECT f.id,
           r.worker_id IS NOT NULL AS registered,
           r.hostname, r.pid, r.queue_names,
           r.concurrency, r.active_slots, r.draining, r.paused, r.started_at, r.last_heartbeat_at,
           COALESCE(a.active_jobs, 0)::integer AS active_jobs,
           COALESCE(h.completed_attempts, 0)::integer AS completed_attempts,
           COALESCE(h.failed_attempts, 0)::integer AS failed_attempts,
           h.average_execution_ms,
           GREATEST(a.last_seen_at, h.last_seen_at, r.last_heartbeat_at) AS last_seen_at
      FROM fleet f
      LEFT JOIN workhorse.dashboard_worker_registry_v1 r ON r.worker_id = f.id
      LEFT JOIN active a ON a.id = f.id
      LEFT JOIN recent_history h ON h.id = f.id
     ORDER BY f.id
  `);

  return {
    capturedAt: now.toISOString(),
    canManageWorkers,
    workers: workerRows.rows.map((row) => {
      return {
        id: row.id,
        queues: row.queue_names ?? [],
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
        lastHeartbeatAt: toIsoOrNull(row.last_heartbeat_at),
        paused: row.paused ?? false,
      };
    }),
  };
}

export async function readDashboardJobDetail(
  database: DashboardDatabase,
  id: string,
  projectDurability: DashboardDurabilityProjector = () => null,
  admin?: Admin,
  canSignal = false,
): Promise<DashboardJobDetail | null> {
  const [
    jobRows,
    attemptRows,
    checkpointRows,
    waitRows,
    eventRows,
    batchRows,
    dependencyRows,
    childRows,
    redriveRows,
  ] = await Promise.all([
    database.execute<{
      id: string;
      queue: string;
      type: string;
      priority: number;
      payload: unknown;
      max_attempts: number;
      retry_policy: RetryPolicy | null;
      deadline_at: Date | string | null;
      execution_timeout_ms: string | number | null;
      concurrency_key: string | null;
      prerequisite_job_id: string | null;
      prerequisite_job_ids: string[];
      dependency_on_success: "release" | "cancel" | "fail" | null;
      dependency_on_failure: "release" | "cancel" | "fail" | null;
      dependency_on_cancellation: "release" | "cancel" | "fail" | null;
      dependency_released_at: Date | string | null;
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
      signal_wait_deadline_at: Date | string | null;
    }>(sql`
      SELECT j.id, j.queue_name AS queue, j.job_type AS type, j.priority,
             j.payload, j.max_attempts,
             j.retry_policy, j.deadline_at, j.execution_timeout_ms, j.concurrency_key, j.created_at,
             dependency.prerequisite_job_id, dependency.prerequisite_job_ids,
             dependency.on_success AS dependency_on_success,
             dependency.on_failure AS dependency_on_failure,
             dependency.on_cancellation AS dependency_on_cancellation,
             dependency.released_at AS dependency_released_at,
             r.state AS runtime_state, r.current_attempt AS runtime_attempt, r.run_at, r.ready_at,
             r.worker_id, r.fence_token::text, r.acquired_at, r.heartbeat_at, r.expires_at,
             r.wait_name, r.attempt_started_at, r.attempt_timeout_at,
             r.cancel_requested_at, r.cancel_requested_by, r.cancel_reason,
             r.error AS runtime_error,
             o.state AS outcome_state, o.current_attempt AS outcome_attempt, o.finished_at,
             workhorse.dashboard_job_result_v1(j.id) AS result, o.error AS outcome_error,
             p.progress_value, p.revision::text AS progress_revision,
             p.attempt AS progress_attempt, p.fence_token::text AS progress_fence_token,
             p.worker_id AS progress_worker_id, p.created_at AS progress_created_at,
             p.updated_at AS progress_updated_at,
             ${currentSignalWaitColumn}
        FROM workhorse.dashboard_job_v1 j
        LEFT JOIN workhorse.dashboard_job_runtime_v1 r ON r.job_id = j.id
        LEFT JOIN workhorse.dashboard_job_outcome_v1 o ON o.job_id = j.id
        LEFT JOIN workhorse.dashboard_job_progress_v1 p ON p.job_id = j.id
        ${currentSignalWaitJoin}
        LEFT JOIN LATERAL (
          SELECT CASE WHEN count(*) = 1
                   THEN (array_agg(edge.prerequisite_job_id))[1] END AS prerequisite_job_id,
                 COALESCE(array_agg(edge.prerequisite_job_id ORDER BY edge.prerequisite_job_id)
                   FILTER (WHERE edge.prerequisite_job_id IS NOT NULL), '{}') AS prerequisite_job_ids,
                 min(edge.on_success) AS on_success,
                 min(edge.on_failure) AS on_failure,
                 min(edge.on_cancellation) AS on_cancellation,
                 CASE WHEN bool_and(edge.released_at IS NOT NULL)
                   THEN max(edge.released_at) END AS released_at
            FROM workhorse.dashboard_job_dependency_v1 edge
           WHERE edge.dependent_job_id = j.id
        ) dependency ON true
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
        FROM workhorse.dashboard_attempt_history_v1
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
        FROM workhorse.dashboard_job_checkpoint_v1
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
        FROM workhorse.dashboard_job_wait_v1
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
        FROM workhorse.dashboard_job_event_v1
       WHERE job_id = ${id}
      ORDER BY occurred_at, event_id
    `),
    database.execute<{
      batch_id: string;
      selected_attempt: number;
      dispatched_at: Date | string;
      batch_wide_failure: boolean;
      ordinal: string | number;
      job_id: string;
      job_type: string;
      attempt: number;
      outcome: string | null;
      error: unknown;
    }>(sql`
      SELECT dispatch.details->>'batch_id' AS batch_id,
             dispatch.attempt AS selected_attempt,
             dispatch.occurred_at AS dispatched_at,
             EXISTS (
               SELECT 1 FROM workhorse.dashboard_job_event_v1 failure
                WHERE failure.job_id = dispatch.job_id
                  AND failure.attempt = dispatch.attempt
                  AND failure.event_type = 'batch_failed'
                  AND failure.details->>'batch_id' = dispatch.details->>'batch_id'
             ) AS batch_wide_failure,
             member.ordinal, member.value->>'job_id' AS job_id,
             COALESCE(job.job_type, selected_job.job_type) AS job_type,
             (member.value->>'attempt')::integer AS attempt,
             history.outcome, history.error
        FROM workhorse.dashboard_job_event_v1 dispatch
        CROSS JOIN LATERAL jsonb_array_elements(dispatch.details->'members')
          WITH ORDINALITY AS member(value, ordinal)
        JOIN workhorse.dashboard_job_v1 selected_job ON selected_job.id = dispatch.job_id
        LEFT JOIN workhorse.dashboard_job_v1 job ON job.id = (member.value->>'job_id')::uuid
        LEFT JOIN workhorse.dashboard_attempt_history_v1 history
          ON history.job_id = (member.value->>'job_id')::uuid
         AND history.attempt = (member.value->>'attempt')::integer
       WHERE dispatch.job_id = ${id} AND dispatch.event_type = 'batch_dispatched'
       ORDER BY dispatch.occurred_at, dispatch.event_id, member.ordinal
    `),
    database.execute<{
      dependent_job_id: string;
      prerequisite_job_id: string;
      on_success: "release" | "cancel" | "fail";
      on_failure: "release" | "cancel" | "fail";
      on_cancellation: "release" | "cancel" | "fail";
      created_at: Date | string;
      released_at: Date | string | null;
      resolution: "release" | "cancel" | "fail" | null;
    }>(sql`
      SELECT dependent_job_id, prerequisite_job_id, on_success, on_failure, on_cancellation,
             created_at, released_at, resolution
        FROM workhorse.dashboard_job_dependency_v1
       WHERE dependent_job_id = ${id} OR prerequisite_job_id = ${id}
       ORDER BY dependent_job_id, prerequisite_job_id
       LIMIT 101
    `),
    database.execute<{
      parent_job_id: string;
      child_job_id: string;
      child_name: string;
      child_type: string;
      created_at: Date | string;
      joined_at: Date | string | null;
      outcome_state: "succeeded" | "failed" | "canceled" | null;
      outcome_error: unknown;
    }>(sql`
      SELECT edge.parent_job_id, edge.child_job_id, edge.child_name,
             child.job_type AS child_type, edge.created_at, edge.joined_at,
             outcome.state AS outcome_state, outcome.error AS outcome_error
        FROM workhorse.dashboard_job_child_v1 edge
        JOIN workhorse.dashboard_job_v1 child ON child.id = edge.child_job_id
        LEFT JOIN workhorse.dashboard_job_outcome_v1 outcome ON outcome.job_id = edge.child_job_id
       WHERE edge.parent_job_id = ${id} OR edge.child_job_id = ${id}
       ORDER BY edge.created_at, edge.parent_job_id, edge.child_job_id
       LIMIT 102
    `),
    database.execute<{
      source_job_id: string;
      target_job_id: string;
      request_id_preview: string;
      request_id_digest: string;
      request_id_length: number;
      requested_by: string;
      reason: string;
      source_state: "failed";
      target_initial_state: "ready";
      requested_at: Date | string;
    }>(sql`
      SELECT source_job_id, target_job_id, request_id_preview, request_id_digest,
             request_id_length, requested_by, reason, source_state, target_initial_state,
             requested_at
        FROM workhorse.redrive_lineage_v1(${id}, 101)
    `),
  ]);

  const job = jobRows.rows[0];
  if (!job) return null;
  const state = job.outcome_state ?? job.runtime_state ?? "unknown";
  const [currentPolicy, health] = admin
    ? await Promise.all([
        admin.concurrencyPolicies([job.queue]).then((policies) => policies[0] ?? null),
        // Terminal detail drops live utilization entirely, so only tasks that can still become
        // active need the bounded health aggregates beside their exact persisted policy.
        job.runtime_state === null ? null : readQueueHealth(database),
      ])
    : [null, null];
  const healthPolicy = health?.concurrencyPolicies.policies.find(
    (candidate) => candidate.queue === job.queue,
  );
  // The ceiling comes from `concurrencyPolicies([queue])`, which reads this queue's row exactly.
  // The counts beside it come from `health()`, which measures a bounded number of policies and
  // skips this queue once a deployment has more. The two therefore disagree about what is known,
  // and `utilizationKnown` records which half is trustworthy. When it is false the counts below
  // are placeholders, zeroed rather than defaulted to the ceiling so that no view can present an
  // unmeasured queue as an idle one with its whole budget free.
  const concurrencyPolicy: DashboardConcurrencyPolicySummary | null = currentPolicy
    ? {
        namespace: currentPolicy.namespace,
        maxActive: currentPolicy.maxActive,
        utilizationKnown: healthPolicy !== undefined,
        active: healthPolicy?.active ?? 0,
        available: healthPolicy?.available ?? 0,
        blockedReady: healthPolicy?.blockedReady ?? 0,
        maxActivePerKey: currentPolicy.maxActivePerKey,
        saturatedKeys: healthPolicy?.saturatedKeys ?? 0,
        highestKeyActive: healthPolicy?.highestKeyActive ?? 0,
      }
    : null;
  const batchExecutions: DashboardJobDetail["batchExecutions"] = [];
  const executionsById = new Map<string, DashboardJobDetail["batchExecutions"][number]>();
  for (const row of batchRows.rows) {
    let execution = executionsById.get(row.batch_id);
    if (!execution) {
      execution = {
        id: row.batch_id,
        attempt: row.selected_attempt,
        dispatchedAt: toIso(row.dispatched_at),
        batchWideFailure: row.batch_wide_failure,
        members: [],
      };
      executionsById.set(row.batch_id, execution);
      batchExecutions.push(execution);
    }
    execution.members.push({
      id: row.job_id,
      type: row.job_type,
      attempt: row.attempt,
      outcome: row.outcome,
      error: row.error,
    });
  }
  return {
    identity: {
      id: job.id,
      queue: job.queue,
      type: job.type,
      priority: job.priority,
      state,
      createdAt: toIso(job.created_at),
      retryPolicy: job.retry_policy,
      maxAttempts: job.max_attempts,
      deadlineAt: toIsoOrNull(job.deadline_at),
      executionTimeoutMs:
        job.execution_timeout_ms === null ? null : Number(job.execution_timeout_ms),
      concurrencyKey: job.concurrency_key,
      prerequisiteJobId: job.prerequisite_job_id,
      prerequisiteJobIds: job.prerequisite_job_ids,
      dependencyPolicy:
        job.dependency_on_failure === null
          ? null
          : {
              onSuccess: job.dependency_on_success!,
              onFailure: job.dependency_on_failure,
              onCancellation: job.dependency_on_cancellation!,
            },
      dependencyReleasedAt: toIsoOrNull(job.dependency_released_at),
      blockedReason:
        job.runtime_state === "blocked" && job.prerequisite_job_ids.length > 0
          ? "prerequisite_pending"
          : null,
    },
    dependencyLineage: {
      records: dependencyRows.rows.slice(0, 100).map((edge) => ({
        dependentJobId: edge.dependent_job_id,
        prerequisiteJobId: edge.prerequisite_job_id,
        onSuccess: edge.on_success,
        onFailure: edge.on_failure,
        onCancellation: edge.on_cancellation,
        createdAt: toIso(edge.created_at),
        releasedAt: toIsoOrNull(edge.released_at),
        resolution: edge.resolution,
      })),
      truncated: dependencyRows.rows.length > 100,
    },
    childLineage: {
      records: childRows.rows.slice(0, 101).map((edge) => ({
        parentJobId: edge.parent_job_id,
        childJobId: edge.child_job_id,
        name: edge.child_name,
        type: edge.child_type,
        createdAt: toIso(edge.created_at),
        joinedAt: toIsoOrNull(edge.joined_at),
        outcomeState: edge.outcome_state,
        error: edge.outcome_error,
      })),
      truncated: childRows.rows.length > 101,
    },
    redriveLineage: {
      records: redriveRows.rows.slice(0, 100).map((edge) => ({
        sourceJobId: edge.source_job_id,
        targetJobId: edge.target_job_id,
        requestedBy: edge.requested_by,
        reason: edge.reason,
        requestIdPreview: edge.request_id_preview,
        requestIdDigest: edge.request_id_digest,
        requestIdLength: edge.request_id_length,
        sourceState: edge.source_state,
        targetInitialState: edge.target_initial_state,
        requestedAt: toIso(edge.requested_at),
      })),
      truncated: redriveRows.rows.length > 100,
    },
    // The queue's policy as it stands now, sent for every task including finished ones. Workhorse
    // stores no per-task policy snapshot, so the drawer labels this as current rather than
    // historical; only `identity.concurrencyKey` is a fact about the run itself.
    concurrencyPolicy,
    signalWait: signalWaitSummary(job.wait_name, job.signal_wait_deadline_at),
    canSignal,
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
    batchExecutions,
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
      SELECT 1 FROM workhorse.dashboard_job_v1 j
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
      FROM workhorse.dashboard_job_event_v1 event
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
      FROM workhorse.dashboard_attempt_history_v1 history
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
      : sql`(SELECT count(*) FROM workhorse.dashboard_job_event_v1 event WHERE ${eventCondition})`;
  const countedAttempts =
    kind === "event"
      ? sql`0::bigint`
      : sql`(SELECT count(*) FROM workhorse.dashboard_attempt_history_v1 history WHERE ${attemptCondition})`;

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
        LEFT JOIN workhorse.dashboard_job_v1 job ON job.id = page.job_id
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
        FROM workhorse.dashboard_retention_policy_v1
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
          FROM workhorse.dashboard_job_event_v1 event
          LEFT JOIN workhorse.dashboard_job_v1 job ON job.id = event.job_id
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
          FROM workhorse.dashboard_attempt_history_v1 history
          LEFT JOIN workhorse.dashboard_job_v1 job ON job.id = history.job_id
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
