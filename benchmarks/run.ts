import { performance } from "node:perf_hooks";
import type { Pool } from "pg";
import { Queue } from "../src/index.js";

export interface BenchmarkOptions {
  jobs: number;
  rounds: number;
  queue?: string;
}

export interface RoundResult {
  design: "conventional" | "hybrid";
  round: number;
  jobs: number;
  throughputPerSecond: number;
  claimLatencyMs: { p50: number; p95: number; p99: number };
  relationBytes: number;
  deadTuples: number;
  walBytes: number;
  claimPlan: unknown;
}

const conventionalSetup = `
CREATE SCHEMA IF NOT EXISTS ironshift_benchmark_conventional;
CREATE TABLE IF NOT EXISTS ironshift_benchmark_conventional.job (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  queue_name text NOT NULL,
  payload jsonb NOT NULL,
  status text NOT NULL,
  attempt integer NOT NULL DEFAULT 1,
  fence_token bigint NOT NULL DEFAULT 0,
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS conventional_claim_idx
  ON ironshift_benchmark_conventional.job (queue_name, id) WHERE status = 'ready';
ALTER TABLE ironshift_benchmark_conventional.job RESET (autovacuum_enabled);
`;

function percentile(sorted: number[], value: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.ceil(value * sorted.length) - 1);
  return sorted[index] ?? 0;
}

async function walPosition(pool: Pool): Promise<string> {
  const result = await pool.query<{ lsn: string }>("SELECT pg_current_wal_lsn() AS lsn");
  return result.rows[0]!.lsn;
}

async function walDifference(pool: Pool, start: string): Promise<number> {
  const result = await pool.query<{ bytes: string }>(
    "SELECT pg_wal_lsn_diff(pg_current_wal_lsn(), $1)::text AS bytes",
    [start],
  );
  return Number(result.rows[0]!.bytes);
}

async function stats(
  pool: Pool,
  schema: string,
): Promise<{ relationBytes: number; deadTuples: number }> {
  await pool.query("SELECT pg_stat_force_next_flush()");
  const result = await pool.query<{ bytes: string; dead: string }>(
    `
    SELECT COALESCE(sum(pg_total_relation_size(c.oid)), 0)::text AS bytes,
           COALESCE(sum(s.n_dead_tup), 0)::text AS dead
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      LEFT JOIN pg_stat_user_tables s ON s.relid = c.oid
     WHERE n.nspname = $1 AND c.relkind IN ('r', 'p')`,
    [schema],
  );
  return { relationBytes: Number(result.rows[0]!.bytes), deadTuples: Number(result.rows[0]!.dead) };
}

async function plan(pool: Pool, sql: string, values: unknown[]): Promise<unknown> {
  const result = await pool.query<{ "QUERY PLAN": unknown }>(
    `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`,
    values,
  );
  return result.rows[0]?.["QUERY PLAN"] ?? null;
}

function summarize(
  design: RoundResult["design"],
  round: number,
  jobs: number,
  elapsedMs: number,
  latencies: number[],
  relation: { relationBytes: number; deadTuples: number },
  walBytes: number,
  claimPlan: unknown,
): RoundResult {
  latencies.sort((a, b) => a - b);
  return {
    design,
    round,
    jobs,
    throughputPerSecond: (jobs / elapsedMs) * 1000,
    claimLatencyMs: {
      p50: percentile(latencies, 0.5),
      p95: percentile(latencies, 0.95),
      p99: percentile(latencies, 0.99),
    },
    ...relation,
    walBytes,
    claimPlan,
  };
}

async function conventionalRound(
  pool: Pool,
  round: number,
  jobs: number,
  queueName: string,
): Promise<RoundResult> {
  const walStart = await walPosition(pool);
  const started = performance.now();
  await pool.query(
    `INSERT INTO ironshift_benchmark_conventional.job(queue_name, payload, status)
    SELECT $1, jsonb_build_object('n', n), 'ready'
      FROM generate_series(1, $2::integer) AS n`,
    [queueName, jobs],
  );
  const claimPlan = await plan(
    pool,
    `SELECT id FROM ironshift_benchmark_conventional.job
    WHERE queue_name = $1 AND status = 'ready' ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 1`,
    [queueName],
  );
  const latencies: number[] = [];
  for (let index = 0; index < jobs; index += 1) {
    const claimStarted = performance.now();
    const claimed = await pool.query<{ id: string }>(
      `WITH selected AS (
      SELECT id FROM ironshift_benchmark_conventional.job
       WHERE queue_name = $1 AND status = 'ready' ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 1
    ) UPDATE ironshift_benchmark_conventional.job j
         SET status = 'active', fence_token = fence_token + 1, updated_at = clock_timestamp()
        FROM selected s WHERE j.id = s.id RETURNING j.id`,
      [queueName],
    );
    latencies.push(performance.now() - claimStarted);
    await pool.query(
      `UPDATE ironshift_benchmark_conventional.job
      SET status = 'succeeded', result = '{"ok":true}'::jsonb, updated_at = clock_timestamp()
      WHERE id = $1`,
      [claimed.rows[0]!.id],
    );
  }
  const elapsed = performance.now() - started;
  return summarize(
    "conventional",
    round,
    jobs,
    elapsed,
    latencies,
    await stats(pool, "ironshift_benchmark_conventional"),
    await walDifference(pool, walStart),
    claimPlan,
  );
}

async function hybridRound(
  pool: Pool,
  round: number,
  jobs: number,
  queueName: string,
): Promise<RoundResult> {
  const queue = new Queue(pool, queueName);
  const walStart = await walPosition(pool);
  const started = performance.now();
  await pool.query(
    `SELECT ironshift.enqueue_v1($1, 'benchmark', jsonb_build_object('n', n), clock_timestamp(), 1)
    FROM generate_series(1, $2::integer) AS n`,
    [queueName, jobs],
  );
  const claimPlan = await plan(
    pool,
    `SELECT job_id FROM ironshift.ready_job
    WHERE queue_name = $1 ORDER BY sequence, job_id FOR UPDATE SKIP LOCKED LIMIT 1`,
    [queueName],
  );
  const latencies: number[] = [];
  for (let index = 0; index < jobs; index += 1) {
    const claimStarted = performance.now();
    const claimed = await queue.claim("benchmark-worker", { queue: queueName });
    latencies.push(performance.now() - claimStarted);
    if (!claimed) throw new Error(`Hybrid claim returned no job at index ${index}`);
    await queue.complete(claimed, "benchmark-worker", { ok: true });
  }
  const elapsed = performance.now() - started;
  return summarize(
    "hybrid",
    round,
    jobs,
    elapsed,
    latencies,
    await stats(pool, "ironshift"),
    await walDifference(pool, walStart),
    claimPlan,
  );
}

export async function runBenchmark(pool: Pool, options: BenchmarkOptions): Promise<RoundResult[]> {
  if (!Number.isInteger(options.jobs) || options.jobs < 1)
    throw new Error("jobs must be a positive integer");
  if (!Number.isInteger(options.rounds) || options.rounds < 1)
    throw new Error("rounds must be a positive integer");
  await pool.query(conventionalSetup);
  await pool.query("TRUNCATE ironshift_benchmark_conventional.job RESTART IDENTITY");
  await pool.query(`TRUNCATE ironshift.job_event, ironshift.attempt_history, ironshift.lease,
    ironshift.ready_job, ironshift.scheduled_job, ironshift.job_current, ironshift.job RESTART IDENTITY CASCADE`);
  await pool.query("ALTER SEQUENCE ironshift.fence_token_seq RESTART WITH 1");

  const results: RoundResult[] = [];
  const queueName = options.queue ?? "benchmark";
  for (let round = 1; round <= options.rounds; round += 1) {
    results.push(await conventionalRound(pool, round, options.jobs, queueName));
    results.push(await hybridRound(pool, round, options.jobs, queueName));
  }
  return results;
}
