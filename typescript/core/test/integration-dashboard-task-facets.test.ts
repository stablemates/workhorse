import type { QueryResultRow } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DashboardTaskFacets } from "../../dashboard-server/src/wire.js";
import { createDatabaseTestHarness } from "./support/db.js";

// dashboard_task_facets_v1 found the workers of the attempt history with one index seek for each
// worker through dashboard_attempt_history_v1, which derives the fast-tier attempts from
// fast_task_outcome and fast_task_runtime. Each seek read each fast-tier row, so the read grew with
// the number of workers times the number of fast-tier rows, and the dashboard host ended it. Each
// filter menu of the Tasks page now also names its own list.
const database = createDatabaseTestHarness(import.meta.url, { max: 2 });

const workerCount = 40;
// More outcomes than the 10,000 that a sample of the newest rows would read.
const outcomeCount = 10_050;
const runtimeCount = 3;

async function facets(input: object): Promise<DashboardTaskFacets> {
  const result = await database.pool.query<{ result: DashboardTaskFacets } & QueryResultRow>(
    "SELECT workhorse.dashboard_task_facets_v1($1::jsonb) AS result",
    [JSON.stringify(input)],
  );
  return result.rows[0]!.result;
}

const fastTables = ["fast_task_outcome", "fast_task_runtime"] as const;

/**
 * The rows of each fast-tier table that one read of the procedure reads. The counters of
 * pg_stat_xact_user_tables also hold reads of earlier transactions that the backend has not
 * reported yet, so the read is the difference around the call.
 */
async function fastRowsRead(input: object): Promise<Record<string, number>> {
  const client = await database.pool.connect();
  const counters = async () => {
    const measured = await client.query<{ relname: string; read: number }>(
      `SELECT relname, (seq_tup_read + COALESCE(idx_tup_fetch, 0))::integer AS read
         FROM pg_stat_xact_user_tables
        WHERE schemaname = 'workhorse' AND relname = ANY($1::text[])`,
      [fastTables],
    );
    return Object.fromEntries(
      fastTables.map((name) => [
        name,
        measured.rows.find((row) => row.relname === name)?.read ?? 0,
      ]),
    );
  };
  try {
    await client.query("BEGIN");
    const before = await counters();
    await client.query("SELECT workhorse.dashboard_task_facets_v1($1::jsonb)", [
      JSON.stringify(input),
    ]);
    const after = await counters();
    await client.query("ROLLBACK");
    return Object.fromEntries(fastTables.map((name) => [name, after[name]! - before[name]!]));
  } finally {
    client.release();
  }
}

beforeAll(async () => {
  await database.setup();
  await database.pool.query(
    `INSERT INTO workhorse.queue_control(queue_name) VALUES ('facet-idle') ON CONFLICT DO NOTHING`,
  );
  // Fast-tier outcomes of many workers. The first outcome records one earlier attempt in its errors.
  // The oldest outcome names a worker that no other row names.
  await database.pool.query(
    `WITH tasks AS (
       INSERT INTO workhorse.task(queue_name, task_type, payload, max_attempts, tags)
       SELECT 'facet-fast', 'facet.fast', '{}'::jsonb, 2, ARRAY['fast-tag']
         FROM generate_series(1, $1)
       RETURNING id
     ), numbered AS (
       SELECT id, row_number() OVER (ORDER BY id) AS n FROM tasks
     )
     INSERT INTO workhorse.fast_task_outcome(
       task_id, queue_name, task_type, state, attempt, result, fence_token, worker_id,
       claimed_at, enqueued_at, errors, finished_at
     )
     SELECT id, 'facet-fast', 'facet.fast', 'succeeded', 2, '{}'::jsonb, 2,
            CASE WHEN n = $1 THEN 'oldest-worker'
                 ELSE 'fast-worker-' || lpad((n % $2)::text, 2, '0') END,
            clock_timestamp(), clock_timestamp(),
            CASE WHEN n = 1 THEN jsonb_build_array(jsonb_build_object(
              'attempt', 1, 'fence_token', '1', 'worker_id', 'earlier-worker',
              'claimed_at', clock_timestamp(), 'finished_at', clock_timestamp(),
              'outcome', 'retry', 'error', jsonb_build_object('message', 'boom')))
            ELSE '[]'::jsonb END,
            clock_timestamp() - make_interval(secs => n)
       FROM numbered`,
    [outcomeCount, workerCount],
  );
  // Fast-tier runtime rows: two active rows, one with an earlier attempt in its errors, and one
  // ready row with no worker.
  await database.pool.query(
    `WITH tasks AS (
       INSERT INTO workhorse.task(queue_name, task_type, payload, max_attempts)
       SELECT 'facet-fast', 'facet.fast', '{}'::jsonb, 3 FROM generate_series(1, $1)
       RETURNING id
     ), numbered AS (
       SELECT id, row_number() OVER (ORDER BY id) AS n FROM tasks
     )
     INSERT INTO workhorse.fast_task_runtime(
       task_id, queue_name, task_type, state, run_at, sequence, payload, result_max_bytes, redact,
       max_attempts, attempt, fence_token, worker_id, claimed_at, expires_at, errors, enqueued_at
     )
     SELECT id, 'facet-fast', 'facet.fast', CASE WHEN n = 3 THEN 'ready' ELSE 'active' END,
            clock_timestamp(), n, '{}'::jsonb, 1024, false, 3, 2,
            CASE WHEN n = 3 THEN 0 ELSE 2 END,
            CASE WHEN n = 3 THEN NULL ELSE 'runtime-worker' END,
            CASE WHEN n = 3 THEN NULL ELSE clock_timestamp() END,
            CASE WHEN n = 3 THEN NULL ELSE clock_timestamp() + interval '1 minute' END,
            CASE WHEN n = 1 THEN jsonb_build_array(jsonb_build_object(
              'attempt', 1, 'fence_token', '1', 'worker_id', 'runtime-earlier-worker',
              'claimed_at', clock_timestamp(), 'finished_at', clock_timestamp(),
              'outcome', 'retry', 'error', jsonb_build_object('message', 'boom')))
            ELSE '[]'::jsonb END,
            clock_timestamp()
       FROM numbered`,
    [runtimeCount],
  );
  // One full-tier task with a recorded attempt of a worker that no fast-tier row names.
  await database.pool.query(
    `WITH task AS (
       INSERT INTO workhorse.task(queue_name, task_type, payload, max_attempts, tags)
       VALUES ('facet-full', 'facet.full', '{}'::jsonb, 1, ARRAY['full-tag'])
       RETURNING id
     )
     INSERT INTO workhorse.attempt_history(
       task_id, attempt, fence_token, worker_id, outcome, started_at, claimed_at
     )
     SELECT id, 1, 1, 'history-worker', 'succeeded', clock_timestamp(), clock_timestamp()
       FROM task`,
  );
  await database.pool.query(
    "VACUUM (ANALYZE) workhorse.task, workhorse.fast_task_outcome, workhorse.fast_task_runtime",
  );
});

afterAll(async () => database.teardown());

describe("dashboard task facets", () => {
  it("returns all four lists without a facet", async () => {
    const all = await facets({ configuredWorkers: ["configured-worker"] });

    expect(all.queues).toEqual(expect.arrayContaining(["facet-fast", "facet-full", "facet-idle"]));
    expect(all.taskTypes).toEqual(expect.arrayContaining(["facet.fast", "facet.full"]));
    expect(all.tags).toEqual(["fast-tag", "full-tag"]);
    expect(all.workers).toEqual(
      expect.arrayContaining([
        "configured-worker",
        "earlier-worker",
        "fast-worker-00",
        `fast-worker-${String(workerCount - 1)}`,
        "history-worker",
        "oldest-worker",
        "runtime-earlier-worker",
        "runtime-worker",
      ]),
    );
    expect(all.workers).toHaveLength(workerCount + 6);
    expect(all.workers).toEqual(all.workers.toSorted());
  });

  it.each(["queues", "workers", "taskTypes", "tags"] as const)(
    "reads only the %s list when the input names it",
    async (facet) => {
      const all = await facets({ configuredWorkers: ["configured-worker"] });
      const one = await facets({ configuredWorkers: ["configured-worker"], facet });

      for (const name of ["queues", "workers", "taskTypes", "tags"] as const) {
        expect(one[name]).toEqual(name === facet ? all[name] : []);
      }
    },
  );

  it("reads each fast-tier row once for the workers", async () => {
    expect(await fastRowsRead({ facet: "workers" })).toEqual({
      fast_task_outcome: outcomeCount,
      fast_task_runtime: runtimeCount,
    });
  });

  it("reads no fast-tier row for the queues, the task types, or the tags", async () => {
    for (const facet of ["queues", "taskTypes", "tags"]) {
      expect(await fastRowsRead({ facet })).toEqual({ fast_task_outcome: 0, fast_task_runtime: 0 });
    }
  });
});
