import { createHash } from "node:crypto";
import { cpus, platform, release } from "node:os";
import { performance } from "node:perf_hooks";
import type { Pool, QueryResultRow } from "pg";
import { installSchema } from "../src/schema.js";
import {
  summarizeLatencies,
  summarizeNumbers,
  type LatencySummary,
  type NumericSummary,
} from "./statistics.js";

type DashboardReadStrategy = "direct-sql" | "views" | "functions";

export interface DashboardReadSurfaceOptions {
  jobs?: number;
  liveJobs?: number;
  repetitions?: number;
  warmupRepetitions?: number;
}

interface ResolvedDashboardReadSurfaceOptions {
  jobs: number;
  liveJobs: number;
  repetitions: number;
  warmupRepetitions: number;
}

interface QuerySpec {
  text: string;
  values: readonly unknown[];
}

interface QueryFamily {
  name: string;
  queries: Record<DashboardReadStrategy, QuerySpec>;
}

interface PlanSummary {
  totalCost: number;
  planningTimeMs: number;
  executionTimeMs: number;
  sharedHitBlocks: number;
  sharedReadBlocks: number;
  signature: string[];
}

interface DashboardReadVariantMeasurement {
  strategy: DashboardReadStrategy;
  resultRows: number;
  resultHash: string;
  executionMs: NumericSummary;
  plan: PlanSummary;
  rawPlan: unknown;
}

interface DashboardReadCaseMeasurement {
  name: string;
  variants: DashboardReadVariantMeasurement[];
  equivalentResults: boolean;
  viewPlanMatchesDirect: boolean;
  functionPlanMatchesDirect: boolean;
}

interface DashboardRequestVariantMeasurement {
  name: "baseline" | "current";
  statementsPerCall: number;
  latencyMs: LatencySummary;
}

interface DashboardRequestComparison {
  name: "tasks" | "queues";
  repetitions: number;
  variants: [DashboardRequestVariantMeasurement, DashboardRequestVariantMeasurement];
  fewerStatements: boolean;
  lowerP95: boolean;
}

export interface DashboardReadSurfaceReport {
  generatedAt: string;
  environment: {
    node: string;
    platform: string;
    platformRelease: string;
    cpu: string;
    postgres: string;
  };
  options: ResolvedDashboardReadSurfaceOptions;
  dataset: {
    jobs: number;
    liveJobs: number;
    terminalJobs: number;
    events: number;
    attempts: number;
    waits: number;
    checkpoints: number;
  };
  executionOrder: DashboardReadStrategy[][];
  cases: DashboardReadCaseMeasurement[];
  requests: DashboardRequestComparison[];
  verdict: {
    selected: DashboardReadStrategy;
    rationale: string;
  };
}

const strategies: DashboardReadStrategy[] = ["direct-sql", "views", "functions"];

function resolveDashboardReadSurfaceOptions(
  options: DashboardReadSurfaceOptions = {},
): ResolvedDashboardReadSurfaceOptions {
  const resolved = {
    jobs: options.jobs ?? 100_000,
    liveJobs: options.liveJobs ?? 20_000,
    repetitions: options.repetitions ?? 7,
    warmupRepetitions: options.warmupRepetitions ?? 2,
  };
  for (const [name, value] of Object.entries(resolved)) {
    if (!Number.isSafeInteger(value) || value < (name === "warmupRepetitions" ? 0 : 1)) {
      throw new RangeError(
        `${name} must be a ${name === "warmupRepetitions" ? "non-negative" : "positive"} safe integer`,
      );
    }
  }
  if (resolved.liveJobs >= resolved.jobs) {
    throw new RangeError(
      "liveJobs must be smaller than jobs so both live and terminal reads are loaded",
    );
  }
  return resolved;
}

async function resetAndInstall(pool: Pool): Promise<void> {
  await pool.query("DROP SCHEMA IF EXISTS dashboard_read_bench CASCADE");
  await pool.query("DROP SCHEMA IF EXISTS workhorse CASCADE");
  await installSchema(pool);
}

async function loadDataset(
  pool: Pool,
  options: ResolvedDashboardReadSurfaceOptions,
): Promise<void> {
  const { jobs, liveJobs } = options;
  await pool.query(
    `INSERT INTO workhorse.job(
       id, queue_name, job_type, payload, tags, max_attempts, created_at
     )
     SELECT md5(i::text)::uuid,
            'queue-' || (i % 8)::text,
            'task-' || (i % 32)::text,
            jsonb_build_object('sequence', i),
            ARRAY['tag-' || (i % 12)::text],
            3,
            clock_timestamp() - (i % 604800) * interval '1 second'
       FROM generate_series(1, $1) AS series(i)`,
    [jobs],
  );
  await pool.query(
    `INSERT INTO workhorse.job_runtime(
       job_id, queue_name, state, run_at, ready_at, sequence,
       wait_name, attempt_started_at, updated_at
     )
     SELECT md5(i::text)::uuid,
            'queue-' || (i % 8)::text,
            CASE WHEN i % 10 = 0 THEN 'scheduled' ELSE 'ready' END,
            CASE WHEN i % 10 = 0
              THEN clock_timestamp() + interval '1 hour'
              ELSE clock_timestamp() - (i % 3600) * interval '1 second'
            END,
            CASE WHEN i % 10 = 0
              THEN NULL
              ELSE clock_timestamp() - (i % 3600) * interval '1 second'
            END,
            CASE WHEN i % 10 = 0 THEN NULL ELSE i END,
            CASE WHEN i % 10 = 0 THEN 'benchmark-wait' ELSE NULL END,
            CASE WHEN i % 10 = 0 THEN clock_timestamp() - interval '1 second' ELSE NULL END,
            clock_timestamp() - (i % 3600) * interval '1 second'
       FROM generate_series(1, $1) AS series(i)`,
    [liveJobs],
  );
  await pool.query(
    `INSERT INTO workhorse.job_wait(
       job_id, wait_name, mode, duration_ms, wake_at, attempt,
       fence_token, worker_id, claimed_at
     )
     SELECT md5(i::text)::uuid, 'benchmark-wait', 'relative', 3600000,
            clock_timestamp() + interval '1 hour', 1, 1,
            'worker-' || (i % 16)::text, clock_timestamp() - interval '1 second'
       FROM generate_series(10, $1, 10) AS series(i)`,
    [liveJobs],
  );
  await pool.query(
    `INSERT INTO workhorse.job_outcome(
       job_id, state, current_attempt, fence_token, run_at, result,
       finished_at, history_through_at, updated_at
     )
     SELECT md5(i::text)::uuid,
            'succeeded',
            1,
            1,
            clock_timestamp() - (i % 604800) * interval '1 second',
            jsonb_build_object('sequence', i),
            clock_timestamp() - (i % 604800) * interval '1 second',
            clock_timestamp(),
            clock_timestamp() - (i % 604800) * interval '1 second'
       FROM generate_series($1 + 1, $2) AS series(i)`,
    [liveJobs, jobs],
  );
  await pool.query(
    `INSERT INTO workhorse.job_event(job_id, attempt, event_type, details, occurred_at)
     SELECT md5(i::text)::uuid,
            CASE event.ordinal WHEN 1 THEN NULL ELSE 1 END,
            CASE event.ordinal WHEN 1 THEN 'enqueued' ELSE 'claimed' END,
            jsonb_build_object('sequence', i),
            clock_timestamp() - (i % 604800) * interval '1 second'
              + event.ordinal * interval '1 millisecond'
       FROM generate_series(1, $1) AS series(i)
       CROSS JOIN (VALUES (1), (2)) AS event(ordinal)`,
    [jobs],
  );
  await pool.query(
    `INSERT INTO workhorse.attempt_history(
       job_id, attempt, fence_token, worker_id, outcome,
       started_at, claimed_at, finished_at, occurred_at
     )
     SELECT md5(i::text)::uuid,
            1,
            1,
            'worker-' || (i % 16)::text,
            'succeeded',
            clock_timestamp() - (i % 604800) * interval '1 second',
            clock_timestamp() - (i % 604800) * interval '1 second',
            clock_timestamp() - (i % 604800) * interval '1 second' + interval '2 milliseconds',
            clock_timestamp() - (i % 604800) * interval '1 second' + interval '2 milliseconds'
       FROM generate_series($1 + 1, $2) AS series(i)`,
    [liveJobs, jobs],
  );
  await pool.query(
    `INSERT INTO workhorse.job_checkpoint(
       job_id, checkpoint_name, checkpoint_value, attempt, fence_token, worker_id
     )
     SELECT md5(i::text)::uuid, 'benchmark-step', jsonb_build_object('sequence', i),
            1, 1, 'worker-' || (i % 16)::text
       FROM generate_series(1, $1, 10) AS series(i)`,
    [jobs],
  );
  await pool.query(`
    ANALYZE workhorse.job;
    ANALYZE workhorse.job_runtime;
    ANALYZE workhorse.job_outcome;
    ANALYZE workhorse.job_event;
    ANALYZE workhorse.attempt_history;
    ANALYZE workhorse.job_wait;
    ANALYZE workhorse.job_checkpoint;
  `);
}

type DashboardReadSurface = "tables" | "views";
type DashboardRelation =
  | "job"
  | "runtime"
  | "outcome"
  | "wait"
  | "checkpoint"
  | "event"
  | "attempt";

const dashboardRelations: Record<DashboardReadSurface, Record<DashboardRelation, string>> = {
  tables: {
    job: "job",
    runtime: "job_runtime",
    outcome: "job_outcome",
    wait: "job_wait",
    checkpoint: "job_checkpoint",
    event: "job_event",
    attempt: "attempt_history",
  },
  views: {
    job: "dashboard_job_v1",
    runtime: "dashboard_job_runtime_v1",
    outcome: "dashboard_job_outcome_v1",
    wait: "dashboard_job_wait_v1",
    checkpoint: "dashboard_job_checkpoint_v1",
    event: "dashboard_job_event_v1",
    attempt: "dashboard_attempt_history_v1",
  },
};

function relation(surface: DashboardReadSurface, name: DashboardRelation): string {
  return `workhorse.${dashboardRelations[surface][name]}`;
}

function jsonRows(innerSql: string): string {
  return `SELECT to_jsonb(result) AS result_row FROM (${innerSql}) result`;
}

function taskPageSql(
  surface: DashboardReadSurface,
  parameters: { queue: string; tag: string; search: string; limit: string; offset: string },
): string {
  return jsonRows(`
    WITH tasks AS (
      SELECT j.id, j.queue_name AS queue, j.job_type AS type,
             COALESCE(r.state, o.state) AS state,
             COALESCE(r.current_attempt, o.current_attempt) AS attempt,
             j.max_attempts, j.retry_policy, j.deadline_at, j.execution_timeout_ms,
             j.tags,
             COALESCE(r.run_at, o.run_at) AS run_at,
             r.worker_id AS current_worker_id,
             COALESCE(r.worker_id, durable_wait.worker_id) AS worker_id,
             o.finished_at, COALESCE(o.error, r.error) AS error, j.created_at,
             COALESCE(r.updated_at, o.updated_at, j.created_at) AS updated_at,
             r.wait_name, durable_wait.wake_at, durable_wait.mode AS wait_mode,
             enqueued_event.details AS enqueued_details
        FROM ${relation(surface, "job")} j
        LEFT JOIN ${relation(surface, "runtime")} r ON r.job_id = j.id
        LEFT JOIN ${relation(surface, "outcome")} o ON o.job_id = j.id
        LEFT JOIN ${relation(surface, "wait")} durable_wait
          ON durable_wait.job_id = j.id AND durable_wait.wait_name = r.wait_name
        LEFT JOIN LATERAL (
          SELECT event.details FROM ${relation(surface, "event")} event
           WHERE event.job_id = j.id AND event.event_type = 'enqueued'
           ORDER BY event.occurred_at, event.event_id LIMIT 1
        ) enqueued_event ON true
    )
    SELECT * FROM tasks
     WHERE queue = ${parameters.queue}
       AND tags && ARRAY[${parameters.tag}]::text[]
       AND (
         type ILIKE ${parameters.search} ESCAPE '!'
         OR queue ILIKE ${parameters.search} ESCAPE '!'
         OR id::text ILIKE ${parameters.search} ESCAPE '!'
       )
     ORDER BY updated_at DESC, id DESC
     LIMIT ${parameters.limit} OFFSET ${parameters.offset}
  `);
}

function baselineTaskPageSql(parameters: {
  queue: string;
  tag: string;
  search: string;
  limit: string;
  offset: string;
}): string {
  return jsonRows(`
    WITH tasks AS (
      SELECT j.id, j.queue_name AS queue, j.job_type AS type,
             COALESCE(r.state, o.state) AS state,
             COALESCE(r.current_attempt, o.current_attempt) AS attempt,
             j.max_attempts, j.retry_policy, j.deadline_at, j.execution_timeout_ms,
             j.payload, j.tags, COALESCE(r.run_at, o.run_at) AS run_at,
             r.worker_id AS current_worker_id,
             COALESCE(r.worker_id, durable_wait.worker_id, attempt_worker.worker_id) AS worker_id,
             o.finished_at, COALESCE(o.error, r.error) AS error, j.created_at,
             COALESCE(r.updated_at, o.updated_at, j.created_at) AS updated_at,
             r.wait_name, durable_wait.wake_at, durable_wait.mode AS wait_mode,
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
        LEFT JOIN LATERAL (
          SELECT event.details FROM workhorse.dashboard_job_event_v1 event
           WHERE event.job_id = j.id AND event.event_type = 'enqueued'
           ORDER BY event.occurred_at, event.event_id LIMIT 1
        ) enqueued_event ON true
        LEFT JOIN LATERAL (
          SELECT history.worker_id FROM workhorse.dashboard_attempt_history_v1 history
           WHERE history.job_id = j.id ORDER BY history.attempt DESC LIMIT 1
        ) attempt_worker ON true
    )
    SELECT * FROM tasks
     WHERE queue = ${parameters.queue}
       AND tags && ARRAY[${parameters.tag}]::text[]
       AND (
         type ILIKE ${parameters.search} ESCAPE '!'
         OR queue ILIKE ${parameters.search} ESCAPE '!'
         OR id::text ILIKE ${parameters.search} ESCAPE '!'
       )
     ORDER BY updated_at DESC, id DESC
     LIMIT ${parameters.limit} OFFSET ${parameters.offset}
  `);
}

function activityBucketsSql(
  surface: DashboardReadSurface,
  parameters: { cutoff: string; end: string; queue: string; tag: string; worker: string },
): string {
  return jsonRows(`
    WITH candidate AS (
      SELECT job_id FROM ${relation(surface, "runtime")} WHERE updated_at >= ${parameters.cutoff}
      UNION
      SELECT job_id FROM ${relation(surface, "outcome")} WHERE updated_at >= ${parameters.cutoff}
    ), tasks AS (
      SELECT COALESCE(r.worker_id, attempt_worker.worker_id, 'unassigned') AS group_key,
             COALESCE(r.state, o.state) AS state,
             COALESCE(r.current_attempt, o.current_attempt) AS attempt,
             COALESCE(r.updated_at, o.updated_at) AS updated_at,
             j.tags, j.queue_name AS queue,
             COALESCE(r.worker_id, attempt_worker.worker_id, 'unassigned') AS worker_id
        FROM candidate
        JOIN ${relation(surface, "job")} j ON j.id = candidate.job_id
        LEFT JOIN ${relation(surface, "runtime")} r ON r.job_id = candidate.job_id
        LEFT JOIN ${relation(surface, "outcome")} o ON o.job_id = candidate.job_id
        LEFT JOIN LATERAL (
          SELECT history.worker_id FROM ${relation(surface, "attempt")} history
           WHERE history.job_id = candidate.job_id
           ORDER BY history.attempt DESC LIMIT 1
        ) attempt_worker ON true
    ), buckets AS (
      SELECT generate_series(${parameters.cutoff}::timestamptz + interval '2 minutes',
                             ${parameters.end}::timestamptz,
                             interval '2 minutes') AS bucket_start
    )
    SELECT buckets.bucket_start, tasks.group_key, count(tasks.updated_at)::integer AS count
      FROM buckets
      LEFT JOIN tasks
        ON tasks.updated_at >= buckets.bucket_start
       AND tasks.updated_at < buckets.bucket_start + interval '2 minutes'
       AND tasks.tags && ARRAY[${parameters.tag}]::text[]
       AND tasks.queue = ${parameters.queue}
       AND tasks.worker_id = ${parameters.worker}
     GROUP BY buckets.bucket_start, tasks.group_key
     ORDER BY buckets.bucket_start
  `);
}

function eventFeedSql(
  surface: DashboardReadSurface,
  parameters: { cutoff: string; queue: string; reach: string; limit: string; offset: string },
): string {
  const jobMatches = (column: string) => `EXISTS (
    SELECT 1 FROM ${relation(surface, "job")} job
     WHERE job.id = ${column} AND job.queue_name = ${parameters.queue}
  )`;
  const eventCondition = `event.occurred_at >= ${parameters.cutoff}
    AND ${jobMatches("event.job_id")}`;
  const attemptCondition = `history.occurred_at >= ${parameters.cutoff}
    AND ${jobMatches("history.job_id")}`;
  return jsonRows(`
    WITH merged AS MATERIALIZED (
      (SELECT 'event'::text AS kind, event.event_id AS record_id, event.job_id,
              event.occurred_at, event.attempt, event.event_type AS type, event.details,
              NULL::text AS worker_id, NULL::bigint AS fence_token,
              NULL::timestamptz AS started_at, NULL::timestamptz AS finished_at,
              NULL::jsonb AS error, 1 AS kind_rank
         FROM ${relation(surface, "event")} event
        WHERE ${eventCondition}
        ORDER BY event.occurred_at DESC, event.event_id DESC LIMIT ${parameters.reach})
      UNION ALL
      (SELECT 'attempt'::text AS kind, history.attempt_id AS record_id, history.job_id,
              history.occurred_at, history.attempt, history.outcome AS type,
              NULL::jsonb AS details, history.worker_id, history.fence_token,
              history.started_at, history.finished_at, history.error, 0 AS kind_rank
         FROM ${relation(surface, "attempt")} history
        WHERE ${attemptCondition}
        ORDER BY history.occurred_at DESC, history.attempt_id DESC LIMIT ${parameters.reach})
    ), page AS MATERIALIZED (
      SELECT merged.* FROM merged
       ORDER BY merged.occurred_at DESC, merged.kind_rank DESC, merged.record_id DESC
       LIMIT ${parameters.limit} OFFSET ${parameters.offset}
    )
    SELECT page.kind, page.record_id::text, page.job_id::text, job.queue_name, job.job_type,
           page.occurred_at, page.attempt, page.type, page.details, page.worker_id,
           page.fence_token::text,
           CASE WHEN page.started_at IS NULL OR page.finished_at IS NULL THEN NULL
                ELSE round(extract(epoch FROM page.finished_at - page.started_at) * 1000)::text
           END AS duration_ms,
           page.error
      FROM page
      LEFT JOIN ${relation(surface, "job")} job ON job.id = page.job_id
     ORDER BY page.occurred_at DESC, page.kind_rank DESC, page.record_id DESC
  `);
}

function eventCountSql(
  surface: DashboardReadSurface,
  parameters: { cutoff: string; queue: string },
): string {
  return jsonRows(`
    SELECT (
      (SELECT count(*) FROM ${relation(surface, "event")} event
        WHERE event.occurred_at >= ${parameters.cutoff}
          AND EXISTS (SELECT 1 FROM ${relation(surface, "job")} job
                       WHERE job.id = event.job_id AND job.queue_name = ${parameters.queue}))
      +
      (SELECT count(*) FROM ${relation(surface, "attempt")} history
        WHERE history.occurred_at >= ${parameters.cutoff}
          AND EXISTS (SELECT 1 FROM ${relation(surface, "job")} job
                       WHERE job.id = history.job_id AND job.queue_name = ${parameters.queue}))
    )::text AS count
  `);
}

async function installCandidateFunctions(pool: Pool): Promise<void> {
  const taskSql = taskPageSql("tables", {
    queue: "p_queue",
    tag: "p_tag",
    search: "p_search",
    limit: "p_limit",
    offset: "p_offset",
  });
  const activitySql = activityBucketsSql("tables", {
    cutoff: "p_cutoff",
    end: "p_end",
    queue: "p_queue",
    tag: "p_tag",
    worker: "p_worker",
  });
  const feedSql = eventFeedSql("tables", {
    cutoff: "p_cutoff",
    queue: "p_queue",
    reach: "p_reach",
    limit: "p_limit",
    offset: "p_offset",
  });
  const countSql = eventCountSql("tables", { cutoff: "p_cutoff", queue: "p_queue" });
  await pool.query(`
    CREATE SCHEMA dashboard_read_bench;
    CREATE FUNCTION dashboard_read_bench.task_page_v1(
      p_queue text, p_tag text, p_search text, p_limit integer, p_offset integer
    ) RETURNS TABLE (result_row jsonb) LANGUAGE sql STABLE PARALLEL SAFE AS $$${taskSql}$$;
    CREATE FUNCTION dashboard_read_bench.activity_buckets_v1(
      p_cutoff timestamptz, p_end timestamptz, p_queue text, p_tag text, p_worker text
    ) RETURNS TABLE (result_row jsonb) LANGUAGE sql STABLE PARALLEL SAFE AS $$${activitySql}$$;
    CREATE FUNCTION dashboard_read_bench.event_feed_v1(
      p_cutoff timestamptz, p_queue text, p_reach integer, p_limit integer, p_offset integer
    ) RETURNS TABLE (result_row jsonb) LANGUAGE sql STABLE PARALLEL SAFE AS $$${feedSql}$$;
    CREATE FUNCTION dashboard_read_bench.event_count_v1(p_cutoff timestamptz, p_queue text)
    RETURNS TABLE (result_row jsonb) LANGUAGE sql STABLE PARALLEL SAFE AS $$${countSql}$$;
  `);
}

function queryFamilies(activityCutoff: string, activityEnd: string): QueryFamily[] {
  const taskValues = ["queue-3", "tag-3", "%task-3%", 50, 0];
  const activityValues = [activityCutoff, activityEnd, "queue-3", "tag-3", "worker-3"];
  const eventValues = [activityCutoff, "queue-3", 50, 50, 0];
  const countValues = [activityCutoff, "queue-3"];
  const taskParameters = {
    queue: "$1",
    tag: "$2",
    search: "$3",
    limit: "$4",
    offset: "$5",
  };
  const activityParameters = {
    cutoff: "$1",
    end: "$2",
    queue: "$3",
    tag: "$4",
    worker: "$5",
  };
  const eventParameters = {
    cutoff: "$1",
    queue: "$2",
    reach: "$3",
    limit: "$4",
    offset: "$5",
  };
  const countParameters = { cutoff: "$1", queue: "$2" };
  return [
    {
      name: "task-page",
      queries: {
        "direct-sql": {
          text: taskPageSql("tables", taskParameters),
          values: taskValues,
        },
        views: {
          text: taskPageSql("views", taskParameters),
          values: taskValues,
        },
        functions: {
          text: "SELECT * FROM dashboard_read_bench.task_page_v1($1, $2, $3, $4, $5)",
          values: taskValues,
        },
      },
    },
    {
      name: "activity-buckets",
      queries: {
        "direct-sql": {
          text: activityBucketsSql("tables", activityParameters),
          values: activityValues,
        },
        views: {
          text: activityBucketsSql("views", activityParameters),
          values: activityValues,
        },
        functions: {
          text: "SELECT * FROM dashboard_read_bench.activity_buckets_v1($1, $2, $3, $4, $5)",
          values: activityValues,
        },
      },
    },
    {
      name: "event-feed-page",
      queries: {
        "direct-sql": {
          text: eventFeedSql("tables", eventParameters),
          values: eventValues,
        },
        views: {
          text: eventFeedSql("views", eventParameters),
          values: eventValues,
        },
        functions: {
          text: "SELECT * FROM dashboard_read_bench.event_feed_v1($1, $2, $3, $4, $5)",
          values: eventValues,
        },
      },
    },
    {
      name: "event-window-count",
      queries: {
        "direct-sql": {
          text: eventCountSql("tables", countParameters),
          values: countValues,
        },
        views: {
          text: eventCountSql("views", countParameters),
          values: countValues,
        },
        functions: {
          text: "SELECT * FROM dashboard_read_bench.event_count_v1($1, $2)",
          values: countValues,
        },
      },
    },
  ];
}

function planRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("EXPLAIN returned an invalid plan object");
  }
  return value as Record<string, unknown>;
}

function planSignature(plan: Record<string, unknown>): string[] {
  const current = [
    String(plan["Node Type"] ?? "unknown"),
    String(plan["Join Type"] ?? ""),
    String(plan["Relation Name"] ?? ""),
    String(plan["Index Name"] ?? ""),
  ].join("|");
  const children = Array.isArray(plan.Plans) ? plan.Plans : [];
  return [current, ...children.flatMap((child) => planSignature(planRecord(child)))];
}

function parsePlan(raw: unknown): { summary: PlanSummary; raw: unknown } {
  const document = Array.isArray(raw) ? planRecord(raw[0]) : planRecord(raw);
  const plan = planRecord(document.Plan);
  return {
    summary: {
      totalCost: Number(plan["Total Cost"]),
      planningTimeMs: Number(document["Planning Time"]),
      executionTimeMs: Number(document["Execution Time"]),
      sharedHitBlocks: Number(plan["Shared Hit Blocks"] ?? 0),
      sharedReadBlocks: Number(plan["Shared Read Blocks"] ?? 0),
      signature: planSignature(plan),
    },
    raw,
  };
}

async function explain(
  pool: Pool,
  query: QuerySpec,
): Promise<{ summary: PlanSummary; raw: unknown }> {
  const result = await pool.query<{ "QUERY PLAN": unknown }>(
    `EXPLAIN (ANALYZE, BUFFERS, WAL, FORMAT JSON) ${query.text}`,
    [...query.values],
  );
  return parsePlan(result.rows[0]?.["QUERY PLAN"]);
}

function hashRows(rows: QueryResultRow[]): string {
  return createHash("sha256").update(JSON.stringify(rows)).digest("hex");
}

async function measureFamily(
  pool: Pool,
  family: QueryFamily,
  options: ResolvedDashboardReadSurfaceOptions,
  familyIndex: number,
  executionOrder: DashboardReadStrategy[][],
): Promise<DashboardReadCaseMeasurement> {
  const results = new Map<DashboardReadStrategy, { rows: number; hash: string }>();
  for (const strategy of strategies) {
    const result = await pool.query(family.queries[strategy].text, [
      ...family.queries[strategy].values,
    ]);
    results.set(strategy, {
      rows: result.rowCount ?? result.rows.length,
      hash: hashRows(result.rows),
    });
  }
  for (let repetition = 0; repetition < options.warmupRepetitions; repetition += 1) {
    const order = strategies.map(
      (_, index) => strategies[(index + repetition + familyIndex) % strategies.length]!,
    );
    for (const strategy of order) await explain(pool, family.queries[strategy]);
  }

  const samples = new Map<DashboardReadStrategy, number[]>(
    strategies.map((strategy) => [strategy, []]),
  );
  const plans = new Map<DashboardReadStrategy, { summary: PlanSummary; raw: unknown }>();
  for (let repetition = 0; repetition < options.repetitions; repetition += 1) {
    const order = strategies.map(
      (_, index) => strategies[(index + repetition + familyIndex) % strategies.length]!,
    );
    executionOrder.push(order);
    for (const strategy of order) {
      const measured = await explain(pool, family.queries[strategy]);
      plans.set(strategy, plans.get(strategy) ?? measured);
      samples.get(strategy)!.push(measured.summary.executionTimeMs);
    }
  }

  const variants = strategies.map((strategy): DashboardReadVariantMeasurement => {
    const result = results.get(strategy)!;
    const measured = plans.get(strategy)!;
    return {
      strategy,
      resultRows: result.rows,
      resultHash: result.hash,
      executionMs: summarizeNumbers(samples.get(strategy)!),
      plan: measured.summary,
      rawPlan: measured.raw,
    };
  });
  const direct = variants[0]!;
  const views = variants[1]!;
  const functions = variants[2]!;
  const samePlan = (candidate: DashboardReadVariantMeasurement) =>
    candidate.plan.totalCost === direct.plan.totalCost &&
    JSON.stringify(candidate.plan.signature) === JSON.stringify(direct.plan.signature);
  return {
    name: family.name,
    variants,
    equivalentResults: variants.every(
      (variant) =>
        variant.resultRows === direct.resultRows && variant.resultHash === direct.resultHash,
    ),
    viewPlanMatchesDirect: samePlan(views),
    functionPlanMatchesDirect: samePlan(functions),
  };
}

interface CountedQueryRunner {
  query<Row extends QueryResultRow = QueryResultRow>(query: QuerySpec): Promise<Row[]>;
  statementCount(): number;
}

function countedQueryRunner(pool: Pool): CountedQueryRunner {
  let statements = 0;
  return {
    async query<Row extends QueryResultRow = QueryResultRow>(query: QuerySpec) {
      statements += 1;
      return (await pool.query<Row>(query.text, [...query.values])).rows;
    },
    statementCount: () => statements,
  };
}

const taskRequestValues = ["queue-3", "tag-3", "%task-3%", 50, 0];
const taskRequestParameters = {
  queue: "$1",
  tag: "$2",
  search: "$3",
  limit: "$4",
  offset: "$5",
};

function taskTotalSql(includeAttemptHistory: boolean): string {
  const attemptJoin = includeAttemptHistory
    ? `LEFT JOIN LATERAL (
         SELECT history.worker_id FROM workhorse.dashboard_attempt_history_v1 history
          WHERE history.job_id=j.id ORDER BY history.attempt DESC LIMIT 1
       ) attempt_worker ON true`
    : "";
  const attemptWorker = includeAttemptHistory ? "attempt_worker.worker_id" : "NULL::text";
  return `WITH tasks AS (
            SELECT j.id,j.queue_name AS queue,j.job_type AS type,j.tags,
                   COALESCE(r.worker_id,current_wait.worker_id,${attemptWorker},'unassigned') worker_id
              FROM workhorse.dashboard_job_v1 j
              LEFT JOIN workhorse.dashboard_job_runtime_v1 r ON r.job_id=j.id
              LEFT JOIN workhorse.dashboard_job_outcome_v1 o ON o.job_id=j.id
              LEFT JOIN workhorse.dashboard_job_wait_v1 current_wait
                ON current_wait.job_id=j.id AND current_wait.wait_name=r.wait_name
              ${attemptJoin}
          )
          SELECT count(*)::integer FROM tasks
           WHERE queue=$1 AND tags&&ARRAY[$2]::text[]
             AND (type ILIKE $3 ESCAPE '!' OR queue ILIKE $3 ESCAPE '!'
                  OR id::text ILIKE $3 ESCAPE '!')`;
}

async function readBaselineTasks(query: CountedQueryRunner): Promise<void> {
  await Promise.all([
    query
      .query({
        text: "SELECT estimate FROM workhorse.dashboard_job_estimate_v1()",
        values: [],
      })
      .then(async () => {
        await query.query({
          text: `SELECT count(*) FILTER(WHERE state='blocked')::integer,
                        count(*) FILTER(WHERE state='scheduled')::integer,
                        count(*) FILTER(WHERE state='ready')::integer,
                        count(*) FILTER(WHERE state='active')::integer
                   FROM workhorse.dashboard_job_runtime_v1`,
          values: [],
        });
        for (const condition of [
          "state='succeeded'",
          "state='failed'",
          "state='canceled'",
          "current_attempt>1",
        ]) {
          await query.query({
            text: `EXPLAIN (FORMAT JSON) SELECT 1
                     FROM workhorse.dashboard_job_outcome_v1 WHERE ${condition}`,
            values: [],
          });
        }
      }),
    query.query({
      text: taskTotalSql(true),
      values: taskRequestValues.slice(0, 3),
    }),
    query.query({
      text: baselineTaskPageSql(taskRequestParameters),
      values: taskRequestValues,
    }),
  ]);
}

async function readCurrentTasks(query: CountedQueryRunner): Promise<void> {
  await Promise.all([
    query.query({
      text: taskTotalSql(false),
      values: taskRequestValues.slice(0, 3),
    }),
    query.query({ text: taskPageSql("views", taskRequestParameters), values: taskRequestValues }),
  ]);
}

const queuePageQuery: QuerySpec = {
  text: `WITH known_queues AS (
           SELECT queue_name FROM workhorse.dashboard_job_v1
           UNION SELECT queue_name FROM workhorse.dashboard_queue_control_v1
           UNION SELECT queue_name FROM workhorse.dashboard_concurrency_policy_v1
           UNION SELECT queue_name FROM workhorse.dashboard_rate_limit_policy_v1
         ), live_counts AS (
           SELECT queue_name,
                  count(*) FILTER (WHERE state='scheduled')::integer AS scheduled,
                  count(*) FILTER (WHERE state='ready')::integer AS ready,
                  count(*) FILTER (WHERE state='active')::integer AS active
             FROM workhorse.dashboard_job_runtime_v1 GROUP BY queue_name
         )
         SELECT known.queue_name AS queue, COALESCE(control.paused,false) AS paused,
                COALESCE(live.scheduled,0)::integer AS scheduled,
                COALESCE(live.ready,0)::integer AS ready,
                COALESCE(live.active,0)::integer AS active
           FROM known_queues known
           LEFT JOIN workhorse.dashboard_queue_control_v1 control USING(queue_name)
           LEFT JOIN live_counts live USING(queue_name)
          ORDER BY known.queue_name`,
  values: [],
};

async function readBaselineQueues(query: CountedQueryRunner): Promise<void> {
  const [queueRows] = await Promise.all([
    query.query<{ queue: string }>(queuePageQuery),
    query.query({
      text: "SELECT estimate FROM workhorse.dashboard_job_estimate_v1()",
      values: [],
    }),
    query.query({
      text: "SELECT workhorse.queue_health_v1() AS snapshot",
      values: [],
    }),
  ]);
  await Promise.all(
    queueRows.flatMap((row) =>
      (["succeeded", "failed", "canceled"] as const).map((state) =>
        query.query({
          text: `EXPLAIN (FORMAT JSON)
                 SELECT 1 FROM workhorse.dashboard_job_outcome_v1 outcome
                 JOIN workhorse.dashboard_job_v1 job ON job.id=outcome.job_id
                WHERE job.queue_name=$1 AND outcome.state=$2`,
          values: [row.queue, state],
        }),
      ),
    ),
  );
}

let benchmarkQueueHealthExpiresAt = 0;

async function readCurrentQueues(query: CountedQueryRunner): Promise<void> {
  const readHealth = performance.now() >= benchmarkQueueHealthExpiresAt;
  const queueReads = [
    query.query<{ queue: string }>(queuePageQuery),
    query.query({
      text: "SELECT estimate FROM workhorse.dashboard_job_estimate_v1()",
      values: [],
    }),
    ...(readHealth
      ? [
          query.query({
            text: "SELECT workhorse.queue_health_v1() AS snapshot",
            values: [],
          }),
        ]
      : []),
  ] as const;
  const [queueRows] = await Promise.all(queueReads);
  if (readHealth) benchmarkQueueHealthExpiresAt = performance.now() + 3_000;
  const values: unknown[] = [];
  const branches: string[] = [];
  for (const row of queueRows) {
    for (const state of ["succeeded", "failed", "canceled"] as const) {
      const start = values.length + 1;
      branches.push(`SELECT $${start}::text queue,$${start + 1}::text state
                       FROM workhorse.dashboard_job_outcome_v1 outcome
                       JOIN workhorse.dashboard_job_v1 job ON job.id=outcome.job_id
                      WHERE job.queue_name=$${start + 2} AND outcome.state=$${start + 3}`);
      values.push(row.queue, state, row.queue, state);
    }
  }
  await query.query({
    text: `EXPLAIN (FORMAT JSON) ${branches.join(" UNION ALL ")}`,
    values,
  });
}

type DashboardRequestAction = (query: CountedQueryRunner) => Promise<void>;

async function measureDashboardRequest(
  pool: Pool,
  action: DashboardRequestAction,
): Promise<{ latencyMs: number; statements: number }> {
  const counted = countedQueryRunner(pool);
  const startedAt = performance.now();
  await action(counted);
  return { latencyMs: performance.now() - startedAt, statements: counted.statementCount() };
}

async function measureDashboardRequestComparison(
  pool: Pool,
  name: DashboardRequestComparison["name"],
  baseline: DashboardRequestAction,
  current: DashboardRequestAction,
  options: ResolvedDashboardReadSurfaceOptions,
  groupVariants = false,
): Promise<DashboardRequestComparison> {
  for (let repetition = 0; repetition < options.warmupRepetitions; repetition += 1) {
    await measureDashboardRequest(pool, baseline);
  }
  for (let repetition = 0; repetition < options.warmupRepetitions; repetition += 1) {
    await measureDashboardRequest(pool, current);
  }
  const samples = { baseline: [] as number[], current: [] as number[] };
  const statementCounts = { baseline: new Set<number>(), current: new Set<number>() };
  const repetitions = Math.max(options.repetitions, 20);
  const groupedOrder = [
    ...Array.from({ length: repetitions }, () => "current" as const),
    ...Array.from({ length: repetitions }, () => "baseline" as const),
  ];
  const alternatingOrder = Array.from({ length: repetitions }, (_, repetition) =>
    repetition % 2 === 0 ? (["baseline", "current"] as const) : (["current", "baseline"] as const),
  ).flat();
  for (const variant of groupVariants ? groupedOrder : alternatingOrder) {
    const measured = await measureDashboardRequest(
      pool,
      variant === "baseline" ? baseline : current,
    );
    samples[variant].push(measured.latencyMs);
    statementCounts[variant].add(measured.statements);
  }
  if (statementCounts.baseline.size !== 1 || statementCounts.current.size !== 1) {
    throw new Error(`${name} emitted a variable number of statements per call`);
  }
  const variants: DashboardRequestComparison["variants"] = [
    {
      name: "baseline",
      statementsPerCall: [...statementCounts.baseline][0]!,
      latencyMs: summarizeLatencies(samples.baseline),
    },
    {
      name: "current",
      statementsPerCall: [...statementCounts.current][0]!,
      latencyMs: summarizeLatencies(samples.current),
    },
  ];
  const [baselineMeasurement, currentMeasurement] = variants;
  return {
    name,
    repetitions,
    variants,
    fewerStatements: currentMeasurement.statementsPerCall < baselineMeasurement.statementsPerCall,
    lowerP95:
      currentMeasurement.latencyMs.p95 !== null &&
      baselineMeasurement.latencyMs.p95 !== null &&
      currentMeasurement.latencyMs.p95 < baselineMeasurement.latencyMs.p95,
  };
}

export async function runDashboardReadSurfaceBenchmark(
  pool: Pool,
  suppliedOptions: DashboardReadSurfaceOptions = {},
): Promise<DashboardReadSurfaceReport> {
  const options = resolveDashboardReadSurfaceOptions(suppliedOptions);
  benchmarkQueueHealthExpiresAt = 0;
  await resetAndInstall(pool);
  await loadDataset(pool, options);
  await installCandidateFunctions(pool);

  const postgres = await pool.query<{ version: string }>("SELECT version()");
  const activityEnd = new Date().toISOString();
  const activityCutoff = new Date(Date.parse(activityEnd) - 60 * 60 * 1000).toISOString();
  const executionOrder: DashboardReadStrategy[][] = [];
  const cases: DashboardReadCaseMeasurement[] = [];
  for (const [index, family] of queryFamilies(activityCutoff, activityEnd).entries()) {
    cases.push(await measureFamily(pool, family, options, index, executionOrder));
  }
  const requests = [
    await measureDashboardRequestComparison(
      pool,
      "tasks",
      readBaselineTasks,
      readCurrentTasks,
      options,
    ),
    await measureDashboardRequestComparison(
      pool,
      "queues",
      readBaselineQueues,
      readCurrentQueues,
      options,
      true,
    ),
  ];
  const viewsPass = cases.every(
    (measurement) => measurement.equivalentResults && measurement.viewPlanMatchesDirect,
  );
  const functionsPass = cases.every(
    (measurement) => measurement.equivalentResults && measurement.functionPlanMatchesDirect,
  );
  const selected: DashboardReadStrategy = viewsPass
    ? "views"
    : functionsPass
      ? "functions"
      : "direct-sql";
  const rationale = viewsPass
    ? "The shipped views preserve direct-SQL results, planner costs, node shapes, relations, and indexes in every loaded query family."
    : functionsPass
      ? "The views change at least one loaded plan, while SQL functions preserve every direct-SQL result and plan."
      : "Neither versioned candidate preserves every direct-SQL result and plan, so the dashboard must retain pinned direct SQL.";
  return {
    generatedAt: new Date().toISOString(),
    environment: {
      node: process.version,
      platform: platform(),
      platformRelease: release(),
      cpu: cpus()[0]?.model ?? "unknown",
      postgres: postgres.rows[0]?.version ?? "unknown",
    },
    options,
    dataset: {
      jobs: options.jobs,
      liveJobs: options.liveJobs,
      terminalJobs: options.jobs - options.liveJobs,
      events: options.jobs * 2,
      attempts: options.jobs - options.liveJobs,
      waits: Math.floor(options.liveJobs / 10),
      checkpoints: Math.ceil(options.jobs / 10),
    },
    executionOrder,
    cases,
    requests,
    verdict: { selected, rationale },
  };
}
