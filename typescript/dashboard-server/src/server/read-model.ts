import { expectOneRow, queueHealthFromDocument } from "@stablemates/workhorse";
import type { Admin, QueueHealth, QueueHealthDocument } from "@stablemates/workhorse";
import {
  DashboardActivityGroupBy,
  DashboardActivityPage,
  DashboardActivityPeriod,
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
} from "../wire.js";
import {
  statAttemptErrors,
  statAttempts,
  statCompleted,
  statWindow,
  statWindowStart,
} from "./rolling-stats.js";
import { sql, type DashboardDatabase } from "./sql.js";
import type { DashboardDurabilityProjector } from "./types.js";

function toIso(value: Date | string): string {
  return new Date(value).toISOString();
}

function toIsoOrNull(value: Date | string | null): string | null {
  return value ? toIso(value) : null;
}

export type DashboardQueueHealthReader = () => Promise<QueueHealth>;

/** Share the expensive canonical health snapshot across nearby reads for one dashboard context. */
export function createDashboardQueueHealthReader(
  database: DashboardDatabase,
  ttlMs = 3_000,
): DashboardQueueHealthReader {
  let cached: { expiresAt: number; value: QueueHealth } | null = null;
  let pending: Promise<QueueHealth> | null = null;
  return async () => {
    const now = Date.now();
    if (cached && cached.expiresAt > now) return cached.value;
    if (pending) return pending;
    pending = database
      .execute<{ snapshot: QueueHealthDocument }>(sql`
        SELECT workhorse.queue_health_v1() AS snapshot
      `)
      .then((result) => {
        const value = queueHealthFromDocument(
          expectOneRow(result, "the queue health snapshot").snapshot,
        );
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
  _readQueueHealth: DashboardQueueHealthReader = createDashboardQueueHealthReader(database),
): Promise<DashboardHumanWaitPage> {
  const input = JSON.stringify({ canComplete, canSignal });
  const result = await database.execute<{ result: DashboardHumanWaitPage }>(sql`
    SELECT workhorse.dashboard_human_waits_v1(${input}::jsonb) AS result
  `);
  return expectOneRow(result, "the dashboard human waits procedure").result;
}

export async function readDashboardSettings(
  database: DashboardDatabase,
  admin: Admin,
  editable: boolean,
  readQueueHealth: DashboardQueueHealthReader = createDashboardQueueHealthReader(database),
): Promise<DashboardSettingsPage> {
  const [maintenance, retention, health, enqueued, workers] = await Promise.all([
    admin.getMaintenancePolicy(),
    admin.getRetentionPolicy(),
    readQueueHealth(),
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
): Promise<DashboardQueuesPage> {
  const result = await database.execute<{ result: DashboardQueuesPage }>(sql`
    SELECT workhorse.dashboard_queues_v1('{}'::jsonb) AS result
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
  jobType: string | null;
  priority: number | null;
  sort: DashboardTaskSort;
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
  if (projectDurability === noDashboardDurability || page.jobs.length === 0) return page;

  const durabilityRows = await database.execute<{
    id: string;
    type: string;
    payload: unknown;
    checkpoint_names: string[];
  }>(sql`
    SELECT job.id::text AS id, job.job_type AS type, job.payload,
           ARRAY(SELECT checkpoint.checkpoint_name
                   FROM workhorse.dashboard_job_checkpoint_v1 checkpoint
                  WHERE checkpoint.job_id = job.id
                  ORDER BY checkpoint.checkpoint_name) AS checkpoint_names
      FROM workhorse.dashboard_job_v1 job
     WHERE job.id = ANY(${page.jobs.map((job) => job.id)}::uuid[])
  `);
  const durabilityByJob = new Map(
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
    jobs: page.jobs.map((job) =>
      Object.assign(job, { durability: durabilityByJob.get(job.id) ?? null }),
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
  maintenanceLoops: MaintenanceLoopCadences,
): Promise<DashboardCronPage> {
  const input = JSON.stringify({ maintenanceLoops });
  const rows = await database.execute<{ result: DashboardCronPage }>(sql`
    SELECT workhorse.dashboard_cron_v1(${input}::jsonb) AS result
  `);
  return expectOneRow(rows, "the dashboard cron procedure").result;
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
  readQueueHealth: DashboardQueueHealthReader = createDashboardQueueHealthReader(database),
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
    readQueueHealth(),
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
  const input = JSON.stringify({ configuredWorkers, canManageWorkers });
  const rows = await database.execute<{ result: DashboardWorkersPage }>(sql`
    SELECT workhorse.dashboard_workers_v1(${input}::jsonb) AS result
  `);
  return expectOneRow(rows, "the dashboard workers procedure").result;
}

export async function readDashboardJobDetail(
  database: DashboardDatabase,
  id: string,
  projectDurability: DashboardDurabilityProjector = () => null,
  _admin?: Admin,
  canSignal = false,
  _readQueueHealth: DashboardQueueHealthReader = createDashboardQueueHealthReader(database),
): Promise<DashboardJobDetail | null> {
  const input = JSON.stringify({ id, canSignal });
  const result = await database.execute<{ result: DashboardJobDetail | null }>(sql`
    SELECT workhorse.dashboard_job_detail_v1(${input}::jsonb) AS result
  `);
  const detail = expectOneRow(result, "the dashboard job detail procedure").result;
  if (!detail) return null;
  return {
    ...detail,
    durability: projectDurability(detail.identity.type, detail.payload),
  };
}

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
  const input = JSON.stringify(query);
  const rows = await database.execute<{ result: DashboardEventsPage }>(sql`
    SELECT workhorse.dashboard_events_v1(${input}::jsonb) AS result
  `);
  return expectOneRow(rows, "the dashboard events procedure").result;
}

/** Read one history record by the stable identity used in Events URLs. */
export async function readDashboardEventDetail(
  database: DashboardDatabase,
  id: string,
): Promise<DashboardEventDetail | null> {
  const input = JSON.stringify({ id });
  const rows = await database.execute<{ result: DashboardEventDetail | null }>(sql`
    SELECT workhorse.dashboard_event_detail_v1(${input}::jsonb) AS result
  `);
  return expectOneRow(rows, "the dashboard event detail procedure").result;
}
