import { performance } from "node:perf_hooks";
import type { Pool } from "pg";
import { installSchema } from "../src/schema.js";
import { summarizeNumbers, type NumericSummary } from "./statistics.js";

export interface StatisticsTiersOptions {
  jobs?: number;
  days?: number;
  payloadBytes?: number;
  repetitions?: number;
  warmupRepetitions?: number;
}

interface ResolvedStatisticsTiersOptions {
  jobs: number;
  days: number;
  payloadBytes: number;
  repetitions: number;
  warmupRepetitions: number;
}

const defaults: ResolvedStatisticsTiersOptions = {
  jobs: 200_000,
  days: 120,
  payloadBytes: 2_048,
  repetitions: 5,
  warmupRepetitions: 1,
};

export function resolveStatisticsTiersOptions(
  options: StatisticsTiersOptions = {},
): ResolvedStatisticsTiersOptions {
  const resolved = { ...defaults, ...options };
  for (const [name, value] of Object.entries(resolved)) {
    if (!Number.isSafeInteger(value) || value < (name === "warmupRepetitions" ? 0 : 1)) {
      throw new RangeError(`${name} must be a positive safe integer`);
    }
  }
  return resolved;
}

async function elapsed(pool: Pool, statement: string, parameters: unknown[] = []): Promise<number> {
  const started = performance.now();
  await pool.query(statement, parameters);
  return performance.now() - started;
}

async function samples(
  pool: Pool,
  statement: string,
  parameters: unknown[],
  repetitions: number,
  warmupRepetitions: number,
): Promise<NumericSummary> {
  for (let index = 0; index < warmupRepetitions; index += 1) {
    await pool.query(statement, parameters);
  }
  const values: number[] = [];
  for (let index = 0; index < repetitions; index += 1) {
    values.push(await elapsed(pool, statement, parameters));
  }
  return summarizeNumbers(values);
}

export async function runStatisticsTiersBenchmark(
  pool: Pool,
  options: StatisticsTiersOptions = {},
) {
  const resolved = resolveStatisticsTiersOptions(options);
  await pool.query("DROP SCHEMA IF EXISTS workhorse CASCADE");
  await installSchema(pool);
  await pool.query(
    "UPDATE workhorse.retention_policy SET statistics_retention_days = 365 WHERE singleton",
  );
  await pool.query(
    `SELECT workhorse.create_history_day_v1(day::date)
       FROM generate_series(
         current_date - $1::integer - 1, current_date, interval '1 day'
       ) day`,
    [resolved.days],
  );

  const loadStarted = performance.now();
  const source = `SELECT i, md5(i::text)::uuid AS id,
      clock_timestamp() - interval '1 day'
        - make_interval(secs => floor(
            (i - 1)::numeric * ($2::integer * 86400) / $1::integer
          )::double precision) AS enqueued_at
    FROM generate_series(1, $1::integer) series(i)`;
  const loadParameters = [resolved.jobs, resolved.days];
  await pool.query(
    `INSERT INTO workhorse.job(id, queue_name, job_type, payload, tags, max_attempts, created_at)
     SELECT id, 'queue-' || (i % 16), 'task-' || (i % 128),
            jsonb_build_object('sequence', i, 'body', repeat('x', $3::integer)),
            ARRAY[
              'tenant-' || ((i * 7919 + (i / 1000) * 17) % 1000),
              'region-' || ((i * 17 + (i / 8) * 3) % 8),
              'plan-' || ((i * 5 + (i / 4)) % 4)
            ],
            3, enqueued_at
       FROM (${source}) source`,
    [...loadParameters, resolved.payloadBytes],
  );
  await pool.query(
    `INSERT INTO workhorse.job_outcome(
       job_id, state, current_attempt, fence_token, run_at, result,
       finished_at, history_through_at, updated_at
     )
     SELECT id, 'succeeded', 1, 1, enqueued_at, jsonb_build_object('sequence', i),
            enqueued_at + make_interval(
              secs => (((i * 7919) % 600000) + 10)::double precision / 1000
            ),
            clock_timestamp(),
            enqueued_at + make_interval(
              secs => (((i * 7919) % 600000) + 10)::double precision / 1000
            )
       FROM (${source}) source`,
    loadParameters,
  );
  await pool.query(
    `INSERT INTO workhorse.job_event(job_id, attempt, event_type, details, occurred_at)
     SELECT id, NULL, 'enqueued', jsonb_build_object('source', 'statistics-benchmark'), enqueued_at
       FROM (${source}) source
     UNION ALL
     SELECT id, 1, 'claimed', jsonb_build_object(
              'worker', 'worker-' || ((i * 37 + (i / 128) * 17) % 64)
            ),
            enqueued_at + make_interval(
              secs => (((i * 7919) % 600000) + 10)::double precision / 1000
            )
       FROM (${source}) source`,
    loadParameters,
  );
  await pool.query(
    `INSERT INTO workhorse.attempt_history(
       job_id, attempt, fence_token, worker_id, outcome,
       started_at, claimed_at, finished_at, occurred_at
     )
     SELECT id, 1, 1,
            'worker-' || ((i * 37 + (i / 128) * 17) % 64), 'succeeded',
            enqueued_at + make_interval(
              secs => (((i * 7919) % 600000) + 10)::double precision / 1000
            ),
            enqueued_at + make_interval(
              secs => (((i * 7919) % 600000) + 10)::double precision / 1000
            ),
            enqueued_at + make_interval(
              secs => (((i * 7919) % 600000) + 20)::double precision / 1000
            ),
            enqueued_at + make_interval(
              secs => (((i * 7919) % 600000) + 20)::double precision / 1000
            )
       FROM (${source}) source`,
    loadParameters,
  );
  const loadMs = performance.now() - loadStarted;

  await pool.query(
    `UPDATE workhorse.job_stat_state
        SET rolled_up_through = date_bin('1 day', clock_timestamp(),
              timestamp with time zone '2000-01-01') - make_interval(days => $1),
            hourly_rolled_up_through = date_bin('1 day', clock_timestamp(),
              timestamp with time zone '2000-01-01') - make_interval(days => $1),
            daily_rolled_up_through = date_bin('1 day', clock_timestamp(),
              timestamp with time zone '2000-01-01') - make_interval(days => $1)`,
    [resolved.days + 1],
  );
  const rollupPasses: number[] = [];
  let rollupRowsWritten = 0;
  for (;;) {
    const state = await pool.query<{ caught_up: boolean }>(
      `SELECT rolled_up_through >= date_bin('1 minute', clock_timestamp(),
                timestamp with time zone '2000-01-01') AS caught_up
         FROM workhorse.job_stat_state WHERE singleton`,
    );
    if (state.rows[0]!.caught_up) break;
    const started = performance.now();
    const rollup = await pool.query<{ phase: string; rows_affected: number }>(
      "SELECT * FROM workhorse.rollup_stats_v1(clock_timestamp(), 100000, 0, 200)",
    );
    rollupPasses.push(performance.now() - started);
    rollupRowsWritten +=
      rollup.rows.find(({ phase }) => phase === "stat_rollup")?.rows_affected ?? 0;
  }
  const retentionDrainMs: number[] = [];
  for (;;) {
    const started = performance.now();
    const result = await pool.query<{ phase: string; rows_affected: number }>(
      "SELECT * FROM workhorse.rollup_stats_v1(clock_timestamp(), 100000, 0, 200)",
    );
    retentionDrainMs.push(performance.now() - started);
    if (result.rows.find(({ phase }) => phase === "stat_retention")?.rows_affected === 0) break;
  }
  await pool.query(`ANALYZE workhorse.job_stat_bucket;
                    ANALYZE workhorse.job_stat_bucket_hour;
                    ANALYZE workhorse.job_stat_bucket_day`);

  const windows = [1, 30, resolved.days].filter(
    (value, index, values) => value <= resolved.days && values.indexOf(value) === index,
  );
  const latency = [];
  for (const days of windows) {
    const from = `date_bin('1 day', clock_timestamp(), timestamp with time zone '2000-01-01')
      - make_interval(days => $1)`;
    const tieredSql = `SELECT workhorse.stat_sketch_percentile_v1(
      workhorse.stat_sketch_merge_v1(array_agg(wait_sketch)), 0.95
    ) AS p95 FROM workhorse.stat_buckets_v1(${from}, clock_timestamp())`;
    const rawSql = `SELECT percentile_cont(0.95) WITHIN GROUP (
      ORDER BY extract(epoch FROM claimed.occurred_at - enqueued.occurred_at) * 1000
    ) AS p95
      FROM workhorse.job_event claimed
      JOIN workhorse.job_event enqueued ON enqueued.job_id = claimed.job_id
       AND enqueued.event_type = 'enqueued'
     WHERE claimed.event_type = 'claimed' AND claimed.attempt = 1
       AND claimed.occurred_at >= ${from}
       AND enqueued.occurred_at >= ${from} - interval '1 day'`;
    const tieredValue = Number((await pool.query<{ p95: number }>(tieredSql, [days])).rows[0]!.p95);
    const rawValue = Number((await pool.query<{ p95: number }>(rawSql, [days])).rows[0]!.p95);
    latency.push({
      days,
      p95Ms: {
        tiered: tieredValue,
        raw: rawValue,
        relativeError: (tieredValue - rawValue) / rawValue,
      },
      tiered: await samples(
        pool,
        tieredSql,
        [days],
        resolved.repetitions,
        resolved.warmupRepetitions,
      ),
      raw: await samples(pool, rawSql, [days], resolved.repetitions, resolved.warmupRepetitions),
    });
  }

  const benchmarkTables = {
    baseline: "statistics_benchmark_baseline",
    worker: "statistics_benchmark_worker",
    tag: "statistics_benchmark_tag",
  } as const;
  for (const table of Object.values(benchmarkTables)) {
    await pool.query(`DROP TABLE IF EXISTS public.${table}`);
  }
  await pool.query(`CREATE UNLOGGED TABLE public.${benchmarkTables.baseline} AS
    SELECT 'minute'::text AS tier, bucket_start, queue_name, job_type,
           '__baseline__'::text AS dimension_value, enqueued, wait_sketch
      FROM workhorse.job_stat_bucket
    UNION ALL
    SELECT 'hour', bucket_start, queue_name, job_type, '__baseline__', enqueued, wait_sketch
      FROM workhorse.job_stat_bucket_hour
    UNION ALL
    SELECT 'day', bucket_start, queue_name, job_type, '__baseline__', enqueued, wait_sketch
      FROM workhorse.job_stat_bucket_day`);

  const dimensionSources = {
    worker: "CROSS JOIN LATERAL (SELECT claimed.details ->> 'worker' AS dimension_value) dimension",
    tag: "CROSS JOIN LATERAL unnest(job.tags) AS dimension(dimension_value)",
  } as const;
  for (const [dimensionName, sourceJoin] of Object.entries(dimensionSources)) {
    const table = benchmarkTables[dimensionName as keyof typeof dimensionSources];
    await pool.query(`CREATE UNLOGGED TABLE public.${table} AS
      WITH samples AS (
        SELECT grain.tier, grain.bucket_start,
               job.queue_name, job.job_type, dimension.dimension_value,
               workhorse.stat_sketch_index_v1(
                 extract(epoch FROM claimed.occurred_at - enqueued.occurred_at) * 1000
               ) AS bin
          FROM workhorse.job_event claimed
          JOIN workhorse.job_event enqueued ON enqueued.job_id = claimed.job_id
           AND enqueued.event_type = 'enqueued'
          JOIN workhorse.job ON job.id = claimed.job_id
          ${sourceJoin}
          CROSS JOIN LATERAL (
            VALUES
              ('minute'::text, date_bin(
                '1 minute', claimed.occurred_at, timestamp with time zone '2000-01-01'
              ), claimed.occurred_at >= date_bin(
                '1 day', clock_timestamp(), timestamp with time zone '2000-01-01'
              ) - interval '2 days'),
              ('hour', date_bin(
                '1 hour', claimed.occurred_at, timestamp with time zone '2000-01-01'
              ), claimed.occurred_at >= date_bin(
                '1 day', clock_timestamp(), timestamp with time zone '2000-01-01'
              ) - interval '90 days'),
              ('day', date_bin(
                '1 day', claimed.occurred_at, timestamp with time zone '2000-01-01'
              ), true)
          ) grain(tier, bucket_start, retained)
         WHERE claimed.event_type = 'claimed' AND claimed.attempt = 1
           AND grain.retained
      ), bins AS (
        SELECT tier, bucket_start, queue_name, job_type, dimension_value, bin, count(*) AS samples
          FROM samples
         GROUP BY tier, bucket_start, queue_name, job_type, dimension_value, bin
      )
      SELECT tier, bucket_start, queue_name, job_type, dimension_value,
             sum(samples)::bigint AS enqueued,
             jsonb_object_agg(bin::text, samples ORDER BY bin) AS wait_sketch
        FROM bins
       GROUP BY tier, bucket_start, queue_name, job_type, dimension_value`);
  }
  for (const table of Object.values(benchmarkTables)) {
    await pool.query(
      `CREATE INDEX ON public.${table}(bucket_start, queue_name, job_type, dimension_value);
       ANALYZE public.${table}`,
    );
  }

  const dimensions: Record<
    string,
    {
      rows: number;
      rowsPerJob: number;
      rowMultiplier: number;
      bytes: number;
      byteMultiplier: number;
      query: NumericSummary;
    }
  > = {};
  let baselineRows = 0;
  let baselineBytes = 0;
  const dimensionQueryTier = resolved.days >= 90 ? "day" : resolved.days >= 2 ? "hour" : "minute";
  for (const [dimensionName, table] of Object.entries(benchmarkTables)) {
    const measured = await pool.query<{ rows: string; bytes: string }>(
      `SELECT count(*) AS rows, pg_total_relation_size('public.${table}') AS bytes
         FROM public.${table}`,
    );
    const rows = Number(measured.rows[0]!.rows);
    const bytes = Number(measured.rows[0]!.bytes);
    if (dimensionName === "baseline") {
      baselineRows = rows;
      baselineBytes = bytes;
    }
    const querySql = `SELECT sum(enqueued), workhorse.stat_sketch_percentile_v1(
        workhorse.stat_sketch_merge_v1(array_agg(wait_sketch)), 0.95
      )
      FROM public.${table}
      WHERE tier = $2 AND bucket_start >= date_bin(
        '1 day', clock_timestamp(), timestamp with time zone '2000-01-01'
      ) - make_interval(days => $1)`;
    dimensions[dimensionName] = {
      rows,
      rowsPerJob: rows / resolved.jobs,
      rowMultiplier: rows / baselineRows,
      bytes,
      byteMultiplier: bytes / baselineBytes,
      query: await samples(
        pool,
        querySql,
        [resolved.days, dimensionQueryTier],
        resolved.repetitions,
        resolved.warmupRepetitions,
      ),
    };
  }

  const storage = await pool.query<{
    raw_rows: string;
    minute_rows: string;
    hour_rows: string;
    day_rows: string;
    raw_bytes: string;
    rollup_bytes: string;
  }>(`SELECT
        (SELECT count(*) FROM workhorse.job_event)
          + (SELECT count(*) FROM workhorse.attempt_history) AS raw_rows,
        (SELECT count(*) FROM workhorse.job_stat_bucket) AS minute_rows,
        (SELECT count(*) FROM workhorse.job_stat_bucket_hour) AS hour_rows,
        (SELECT count(*) FROM workhorse.job_stat_bucket_day) AS day_rows,
        (SELECT sum(pg_total_relation_size(relid))
           FROM pg_partition_tree('workhorse.job_event'))
          + (SELECT sum(pg_total_relation_size(relid))
               FROM pg_partition_tree('workhorse.attempt_history')) AS raw_bytes,
        pg_total_relation_size('workhorse.job_stat_bucket')
          + pg_total_relation_size('workhorse.job_stat_bucket_hour')
          + pg_total_relation_size('workhorse.job_stat_bucket_day') AS rollup_bytes`);
  const stored = storage.rows[0]!;
  const rollupRows =
    Number(stored.minute_rows) + Number(stored.hour_rows) + Number(stored.day_rows);

  return {
    generatedAt: new Date().toISOString(),
    options: resolved,
    loadMs,
    rollupMs: summarizeNumbers(rollupPasses),
    retentionDrainMs: summarizeNumbers(retentionDrainMs),
    latency,
    dimensions,
    storage: {
      rawRows: Number(stored.raw_rows),
      minuteRows: Number(stored.minute_rows),
      hourRows: Number(stored.hour_rows),
      dayRows: Number(stored.day_rows),
      rawBytes: Number(stored.raw_bytes),
      rollupBytes: Number(stored.rollup_bytes),
      retainedRowsPerJob: rollupRows / resolved.jobs,
      rowsWrittenPerJob: rollupRowsWritten / resolved.jobs,
      bytesPerRawHistoryByte: Number(stored.rollup_bytes) / Number(stored.raw_bytes),
    },
  };
}
