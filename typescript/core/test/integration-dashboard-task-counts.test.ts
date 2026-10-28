import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabaseTestHarness } from "./support/db.js";

const database = createDatabaseTestHarness(import.meta.url);
const readyTasks = 2000;
// The ready rows fill a few dozen heap pages. Probing both wait views once per ready row costs
// several index blocks each and exceeds this bound many times over.
const blockBound = 1000;

// Counts the blocks that one statement fetches from workhorse tables and indexes. EXPLAIN also
// counts catalog blocks. After DDL in another database resets the caches of a backend, the backend
// reads its catalogs again. In one CI run, this added over 2,000 blocks to a read with an unchanged
// plan (SM-1896). The per-relation counters exclude the catalogs. They count fetches, not only
// hits, so a block that shared buffers evicted still counts. Pending counters cannot flush between
// these reads, so the difference measures this statement.
async function workhorseBlocks(sql: string): Promise<number> {
  const blocks = `SELECT COALESCE(sum(pg_stat_get_xact_blocks_fetched(oid)), 0)::bigint AS blocks
                    FROM pg_class WHERE relnamespace = 'workhorse'::regnamespace`;
  const client = await database.pool.connect();
  try {
    await client.query("BEGIN");
    const before = await client.query<{ blocks: string }>(blocks);
    await client.query(sql);
    const after = await client.query<{ blocks: string }>(blocks);
    await client.query("COMMIT");
    return Number(after.rows[0]!.blocks) - Number(before.rows[0]!.blocks);
  } finally {
    client.release();
  }
}

async function waitingCount(): Promise<number> {
  const result = await database.pool.query<{ counts: { waiting: number } }>(
    "SELECT workhorse.dashboard_task_counts_v1('{}'::jsonb) AS counts",
  );
  return result.rows[0]!.counts.waiting;
}

describe("dashboard task counts", () => {
  beforeAll(async () => {
    await database.setup();
    await database.pool.query(
      `INSERT INTO workhorse.task(id, queue_name, task_type, payload, max_attempts)
       SELECT md5('counts-' || i)::uuid, 'dashboard-counts', 'dashboard.counts', '{}'::jsonb, 1
         FROM generate_series(1, $1 + 6) AS series(i)`,
      [readyTasks],
    );
    // Rows 1..N are ready. Rows N+1..N+3 wait for a signal, N+4..N+5 wait for a person, and
    // N+6 names a wait whose signal was already delivered, so it is scheduled but not waiting.
    await database.pool.query(
      `INSERT INTO workhorse.task_runtime(
         task_id, queue_name, state, run_at, ready_at, sequence, wait_name, attempt_started_at
       )
       SELECT md5('counts-' || i)::uuid, 'dashboard-counts',
              CASE WHEN i <= $1 THEN 'ready' ELSE 'scheduled' END,
              CASE WHEN i <= $1 THEN clock_timestamp()
                   ELSE clock_timestamp() + interval '1 hour' END,
              CASE WHEN i <= $1 THEN clock_timestamp() END,
              CASE WHEN i <= $1 THEN i END,
              CASE WHEN i > $1 THEN 'counts-wait' END,
              CASE WHEN i > $1 THEN clock_timestamp() END
         FROM generate_series(1, $1 + 6) AS series(i)`,
      [readyTasks],
    );
    await database.pool.query(
      `INSERT INTO workhorse.task_signal_wait(
         task_id, signal_name, attempt, fence_token, worker_id, claimed_at, timeout_at
       )
       SELECT md5('counts-' || i)::uuid, 'counts-wait', 1, 1, 'counts-worker',
              clock_timestamp(), clock_timestamp() + interval '1 day'
         FROM generate_series($1 + 1, $1 + 3) AS series(i)`,
      [readyTasks],
    );
    await database.pool.query(
      `INSERT INTO workhorse.task_signal_wait(
         task_id, signal_name, attempt, fence_token, worker_id, claimed_at, timeout_at,
         payload, idempotency_key_hash, request_fingerprint, delivered_by, delivered_at
       )
       VALUES (md5('counts-' || ($1 + 6))::uuid, 'counts-wait', 1, 1, 'counts-worker',
               clock_timestamp(), clock_timestamp() + interval '1 day',
               '{}'::jsonb, sha256('delivered'::bytea), '{}'::jsonb, 'counts-test',
               clock_timestamp())`,
      [readyTasks],
    );
    await database.pool.query(
      `INSERT INTO workhorse.task_human_wait(
         task_id, token_name, context, attempt, fence_token, worker_id, claimed_at, timeout_at
       )
       SELECT md5('counts-' || i)::uuid, 'counts-wait', '{}'::jsonb, 1, 1, 'counts-worker',
              clock_timestamp(), clock_timestamp() + interval '1 day'
         FROM generate_series($1 + 4, $1 + 5) AS series(i)`,
      [readyTasks],
    );
    await database.pool.query(
      `ANALYZE workhorse.task;
       ANALYZE workhorse.task_runtime;
       ANALYZE workhorse.task_signal_wait;
       ANALYZE workhorse.task_human_wait;`,
    );
  });

  afterAll(async () => database.teardown());

  it("disables JIT for the counts read", async () => {
    const result = await database.pool.query<{ proconfig: string[] | null }>(
      `SELECT routine.proconfig
         FROM pg_proc routine
         JOIN pg_namespace namespace ON namespace.oid = routine.pronamespace
        WHERE namespace.nspname = 'workhorse' AND routine.proname = 'dashboard_task_counts_v1'`,
    );

    expect(result.rows).toEqual([{ proconfig: ["jit=off"] }]);
  });

  it("probes the wait views only for scheduled rows that name a wait", async () => {
    expect(await waitingCount()).toBe(5);
    expect(
      await workhorseBlocks("SELECT workhorse.dashboard_task_counts_v1('{}'::jsonb)"),
    ).toBeLessThan(blockBound);
    // Activity evaluates the wait probe only for the waiting filter, so the difference between
    // the two filters is what the probe costs.
    const activityAll = await workhorseBlocks(
      "SELECT workhorse.dashboard_activity_v1('{}'::jsonb)",
    );
    const activityWaiting = await workhorseBlocks(
      `SELECT workhorse.dashboard_activity_v1('{"filter":"waiting"}'::jsonb)`,
    );
    expect(activityWaiting - activityAll).toBeLessThan(blockBound);

    // Past the estimate threshold, the read counts live rows from task_runtime alone.
    await database.pool.query(
      `INSERT INTO workhorse.task(queue_name, task_type, payload, max_attempts)
       SELECT 'dashboard-counts-bulk', 'dashboard.counts', '{}'::jsonb, 1
         FROM generate_series(1, 50000)`,
    );
    await database.pool.query("ANALYZE workhorse.task");

    expect(await waitingCount()).toBe(5);
    expect(
      await workhorseBlocks("SELECT workhorse.dashboard_task_counts_v1('{}'::jsonb)"),
    ).toBeLessThan(blockBound);
  });
});
