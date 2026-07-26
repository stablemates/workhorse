import { sql } from "drizzle-orm";
import type { Queue } from "ironshift";
import type { DashboardOperator, DemoDatabase, SchedulerStatusProvider } from "./app.js";

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
    batchSize: number;
    occurrenceRetentionDays: number;
    occurrencePruneLimit: number;
  } | null;
}

export interface DashboardWorkerRow {
  id: string;
  activeJobs: number;
  completedAttempts: number;
  lastSeenAt: string;
  status: "busy" | "idle" | "recent";
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
    supportedMutations: Array<"enqueueTest" | "setScheduleEnabled">;
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
    supportedMutations: ["enqueueTest", "setScheduleEnabled"],
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

export async function readDashboardTaskCounts(
  database: DemoDatabase,
): Promise<DashboardTaskCounts> {
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
        FROM ironshift.job j
        LEFT JOIN ironshift.job_runtime r ON r.job_id = j.id
        LEFT JOIN ironshift.job_outcome o ON o.job_id = j.id
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
      created_at: Date | string;
      updated_at: Date | string;
    }>(sql`
      WITH tasks AS (
        SELECT j.id, j.queue_name AS queue, j.job_type AS type,
               COALESCE(r.state, o.state) AS state,
               COALESCE(r.current_attempt, o.current_attempt) AS attempt,
               j.max_attempts, j.payload, j.created_at,
               COALESCE(r.updated_at, o.updated_at, j.created_at) AS updated_at
          FROM ironshift.job j
          LEFT JOIN ironshift.job_runtime r ON r.job_id = j.id
          LEFT JOIN ironshift.job_outcome o ON o.job_id = j.id
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
      createdAt: toIso(row.created_at),
      updatedAt: toIso(row.updated_at),
    })),
  };
}

export async function readDashboardCron(
  database: DemoDatabase,
  schedulerStatusProvider?: SchedulerStatusProvider,
): Promise<DashboardCronPage> {
  const now = new Date();
  const [scheduleRows, schedulerStatus] = await Promise.all([
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
        FROM ironshift.schedule_definition d
        LEFT JOIN ironshift.schedule_occurrence o
          ON o.namespace = d.namespace AND o.schedule_name = d.schedule_name
       GROUP BY d.namespace, d.schedule_name
       ORDER BY d.namespace, d.schedule_name
       LIMIT 50
    `),
    schedulerStatusProvider?.().catch(() => null) ?? Promise.resolve(null),
  ]);
  const statusByName = new Map(
    (schedulerStatus?.schedules ?? []).map((schedule) => [schedule.name, schedule] as const),
  );
  const systemSchedules: DashboardScheduleRow[] = schedulerStatus?.maintenance
    ? [
        {
          kind: "system",
          identity: {
            kind: "system",
            namespace: schedulerStatus.namespace,
            name: "maintenance",
          },
          namespace: schedulerStatus.namespace,
          name: "maintenance",
          cron: schedulerStatus.maintenance.schedule,
          queue: null,
          type: "ironshift.maintain_v1",
          enabled: schedulerStatus.maintenance.active,
          active: schedulerStatus.maintenance.active,
          revision: schedulerStatus.maintenance.cronJobId,
          updatedAt: now.toISOString(),
          occurrenceCount: 0,
          lastFiredAt: toIsoOrNull(schedulerStatus.maintenance.lastRun?.endedAt ?? null),
          lastRun: schedulerStatus.maintenance.lastRun
            ? {
                status: schedulerStatus.maintenance.lastRun.status,
                startedAt: toIsoOrNull(schedulerStatus.maintenance.lastRun.startedAt),
                endedAt: toIsoOrNull(schedulerStatus.maintenance.lastRun.endedAt),
                message: schedulerStatus.maintenance.lastRun.message,
              }
            : null,
          maintenance: {
            batchSize: schedulerStatus.maintenance.batchSize,
            occurrenceRetentionDays: schedulerStatus.maintenance.occurrenceRetentionDays,
            occurrencePruneLimit: schedulerStatus.maintenance.occurrencePruneLimit,
          },
        },
      ]
    : [];

  return {
    capturedAt: now.toISOString(),
    schedules: [
      ...systemSchedules,
      ...scheduleRows.rows.map((row) => {
        const status = statusByName.get(row.name);
        return {
          kind: "user" as const,
          identity: { kind: "user" as const, namespace: row.namespace, name: row.name },
          namespace: row.namespace,
          name: row.name,
          cron: status?.schedule ?? row.cron,
          queue: row.queue,
          type: row.type,
          enabled: status?.enabled ?? row.enabled,
          active: status?.cronActive ?? row.enabled,
          revision: status?.revision ?? row.revision,
          updatedAt: toIso(row.updated_at),
          occurrenceCount: row.occurrence_count,
          lastFiredAt: toIsoOrNull(status?.lastOccurrenceAt ?? row.last_fired_at),
          lastRun: status?.lastRun
            ? {
                status: status.lastRun.status,
                startedAt: toIsoOrNull(status.lastRun.startedAt),
                endedAt: toIsoOrNull(status.lastRun.endedAt),
                message: status.lastRun.message,
              }
            : null,
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
        FROM ironshift.job_runtime
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
        FROM ironshift.job_outcome o
        JOIN ironshift.job j ON j.id = o.job_id
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
): Promise<DashboardWorkersPage> {
  const now = new Date();
  const workerRows = await database.execute<{
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
        FROM ironshift.job_runtime
       WHERE state = 'active' AND worker_id IN (SELECT id FROM configured)
       GROUP BY worker_id
      UNION ALL
      SELECT worker_id AS id, 0::integer AS active_jobs,
             count(*)::integer AS completed_attempts, max(finished_at) AS last_seen_at
        FROM ironshift.attempt_history
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
  `);

  return {
    capturedAt: now.toISOString(),
    workers: workerRows.rows.map((row) => ({
      id: row.id,
      activeJobs: row.active_jobs,
      completedAttempts: row.completed_attempts,
      lastSeenAt: toIsoOrNull(row.last_seen_at) ?? now.toISOString(),
      status:
        row.active_jobs > 0
          ? "busy"
          : row.last_seen_at && new Date(row.last_seen_at).getTime() >= now.getTime() - 5 * 60_000
            ? "recent"
            : "idle",
    })),
  };
}

export async function readDashboardSnapshot(
  database: DemoDatabase,
  queue: Queue,
  configuredWorkers: readonly string[],
  operator?: DashboardOperator,
  schedulerStatusProvider?: SchedulerStatusProvider,
): Promise<DashboardSnapshot> {
  const now = new Date();
  const [
    queueRows,
    jobRows,
    scheduleRows,
    workerRows,
    failureRows,
    metricRows,
    health,
    schedulerStatus,
  ] = await Promise.all([
    database.execute<{
      queue: string;
      state: string;
      count: number;
      oldest_ms: number | null;
    }>(sql`
        SELECT queue_name AS queue, state, count(*)::integer AS count,
               extract(epoch FROM clock_timestamp() - min(COALESCE(ready_at, run_at))) * 1000
                 AS oldest_ms
          FROM ironshift.job_runtime
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
      created_at: Date | string;
      updated_at: Date | string;
    }>(sql`
        SELECT j.id, j.queue_name AS queue, j.job_type AS type,
               COALESCE(r.state, o.state) AS state,
               COALESCE(r.current_attempt, o.current_attempt) AS attempt,
               j.max_attempts, j.payload, j.created_at,
               COALESCE(r.updated_at, o.updated_at, j.created_at) AS updated_at
          FROM ironshift.job j
          LEFT JOIN ironshift.job_runtime r ON r.job_id = j.id
          LEFT JOIN ironshift.job_outcome o ON o.job_id = j.id
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
          FROM ironshift.schedule_definition d
          LEFT JOIN ironshift.schedule_occurrence o
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
            FROM ironshift.job_runtime
           WHERE state = 'active' AND worker_id IN (SELECT id FROM configured)
           GROUP BY worker_id
          UNION ALL
          SELECT worker_id AS id, 0::integer AS active_jobs,
                 count(*)::integer AS completed_attempts, max(finished_at) AS last_seen_at
            FROM ironshift.attempt_history
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
          FROM ironshift.job_outcome o
          JOIN ironshift.job j ON j.id = o.job_id
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
            FROM ironshift.job_event
           WHERE occurred_at >= clock_timestamp() - interval '2 hours'
           GROUP BY 1
        ), attempts AS (
          SELECT date_bin('30 seconds', finished_at, timestamp with time zone '2000-01-01') AS bucket_start,
                 count(*) FILTER (WHERE outcome = 'succeeded')::integer AS succeeded,
                 count(*) FILTER (WHERE outcome = 'failed')::integer AS failed,
                 count(*) FILTER (WHERE outcome = 'retry')::integer AS retried,
                 avg(extract(epoch FROM finished_at - started_at) * 1000)::double precision AS average_duration_ms
            FROM ironshift.attempt_history
           WHERE finished_at >= clock_timestamp() - interval '2 hours'
           GROUP BY 1
        ), active AS (
          SELECT date_bin('30 seconds', acquired_at, timestamp with time zone '2000-01-01') AS bucket_start,
                 count(*)::integer AS active
            FROM ironshift.job_runtime
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
    schedulerStatusProvider?.().catch(() => null) ?? Promise.resolve(null),
  ]);

  const statusByName = new Map(
    (schedulerStatus?.schedules ?? []).map((schedule) => [schedule.name, schedule] as const),
  );
  const systemScheduleRows: DashboardScheduleRow[] = schedulerStatus?.maintenance
    ? [
        {
          kind: "system",
          identity: {
            kind: "system",
            namespace: schedulerStatus.namespace,
            name: "maintenance",
          },
          namespace: schedulerStatus.namespace,
          name: "maintenance",
          cron: schedulerStatus.maintenance.schedule,
          queue: null,
          type: "ironshift.maintain_v1",
          enabled: schedulerStatus.maintenance.active,
          active: schedulerStatus.maintenance.active,
          revision: schedulerStatus.maintenance.cronJobId,
          updatedAt: now.toISOString(),
          occurrenceCount: 0,
          lastFiredAt: schedulerStatus.maintenance.lastRun?.endedAt
            ? toIso(schedulerStatus.maintenance.lastRun.endedAt)
            : null,
          lastRun: schedulerStatus.maintenance.lastRun
            ? {
                status: schedulerStatus.maintenance.lastRun.status,
                startedAt: toIsoOrNull(schedulerStatus.maintenance.lastRun.startedAt),
                endedAt: toIsoOrNull(schedulerStatus.maintenance.lastRun.endedAt),
                message: schedulerStatus.maintenance.lastRun.message,
              }
            : null,
          maintenance: {
            batchSize: schedulerStatus.maintenance.batchSize,
            occurrenceRetentionDays: schedulerStatus.maintenance.occurrenceRetentionDays,
            occurrencePruneLimit: schedulerStatus.maintenance.occurrencePruneLimit,
          },
        },
      ]
    : [];

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
      createdAt: toIso(row.created_at),
      updatedAt: toIso(row.updated_at),
    })),
    schedules: [
      ...systemScheduleRows,
      ...scheduleRows.rows.map((row) => {
        const status = statusByName.get(row.name);
        return {
          kind: "user" as const,
          identity: { kind: "user" as const, namespace: row.namespace, name: row.name },
          namespace: row.namespace,
          name: row.name,
          cron: status?.schedule ?? row.cron,
          queue: row.queue,
          type: row.type,
          enabled: status?.enabled ?? row.enabled,
          active: status?.cronActive ?? row.enabled,
          revision: status?.revision ?? row.revision,
          updatedAt: toIso(row.updated_at),
          occurrenceCount: row.occurrence_count,
          lastFiredAt: toIsoOrNull(status?.lastOccurrenceAt ?? row.last_fired_at),
          lastRun: status?.lastRun
            ? {
                status: status.lastRun.status,
                startedAt: toIsoOrNull(status.lastRun.startedAt),
                endedAt: toIsoOrNull(status.lastRun.endedAt),
                message: status.lastRun.message,
              }
            : null,
          maintenance: null,
        };
      }),
    ],
    workers: workerRows.rows.map((row) => ({
      id: row.id,
      activeJobs: row.active_jobs,
      completedAttempts: row.completed_attempts,
      lastSeenAt: toIsoOrNull(row.last_seen_at) ?? now.toISOString(),
      status:
        row.active_jobs > 0
          ? "busy"
          : row.last_seen_at && new Date(row.last_seen_at).getTime() >= now.getTime() - 5 * 60_000
            ? "recent"
            : "idle",
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
        FROM ironshift.job j
        LEFT JOIN ironshift.job_runtime r ON r.job_id = j.id
        LEFT JOIN ironshift.job_outcome o ON o.job_id = j.id
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
        FROM ironshift.attempt_history
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
        FROM ironshift.job_event
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
