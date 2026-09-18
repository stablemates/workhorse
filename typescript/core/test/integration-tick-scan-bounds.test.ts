import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabaseTestHarness } from "./support/db.js";

const database = createDatabaseTestHarness(import.meta.url);
const futureTasks = 10000;
// Nothing is due, so a scan that seeks its partial index to the current time stops after a few
// index pages. Filtering every future row visits each one's heap tuple and exceeds this bound.
const sharedHitBound = 100;

async function sharedHits(sql: string): Promise<number> {
  // A first call on a connection compiles the function and fills its catalog caches, which costs
  // more buffer hits than the scan. Measure the second call on the same connection.
  const client = await database.pool.connect();
  try {
    await client.query(sql);
    const result = await client.query<{ "QUERY PLAN": unknown }>(
      `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`,
    );
    const explain = result.rows[0]?.["QUERY PLAN"] as
      | Array<{ Plan?: { "Shared Hit Blocks"?: number } }>
      | undefined;
    const hits = explain?.[0]?.Plan?.["Shared Hit Blocks"];
    expect(hits).toBeTypeOf("number");
    return hits as number;
  } finally {
    client.release();
  }
}

describe("tick scan bounds", () => {
  beforeAll(async () => {
    await database.setup();
    await database.pool.query(
      `INSERT INTO workhorse.task(id, queue_name, task_type, payload, max_attempts)
       SELECT md5('tick-' || i)::uuid, 'tick-bounds', 'tick.bounds', '{}'::jsonb, 3
         FROM generate_series(1, $1 + 20) AS series(i)`,
      [futureTasks],
    );
    // Rows 1..N are delayed with a later deadline. The last 20 are active attempts whose lease,
    // timeout, and deadline all lie in the future, so the lease scan stays small.
    await database.pool.query(
      `INSERT INTO workhorse.task_runtime(
         task_id, queue_name, state, run_at, deadline_at, current_attempt, fence_token,
         worker_id, acquired_at, heartbeat_at, expires_at, attempt_started_at, attempt_timeout_at
       )
       SELECT md5('tick-' || i)::uuid, 'tick-bounds',
              CASE WHEN i <= $1 THEN 'scheduled' ELSE 'active' END,
              clock_timestamp() + interval '1 hour' + i * interval '1 second',
              clock_timestamp() + interval '2 hours' + i * interval '1 second',
              1,
              CASE WHEN i <= $1 THEN 0 ELSE 1 END,
              CASE WHEN i > $1 THEN 'tick-worker' END,
              CASE WHEN i > $1 THEN clock_timestamp() END,
              CASE WHEN i > $1 THEN clock_timestamp() END,
              CASE WHEN i > $1 THEN clock_timestamp() + interval '1 hour' END,
              CASE WHEN i > $1 THEN clock_timestamp() END,
              CASE WHEN i > $1 THEN clock_timestamp() + interval '1 hour' END
         FROM generate_series(1, $1 + 20) AS series(i)`,
      [futureTasks],
    );
    await database.pool.query("ANALYZE workhorse.task_runtime");
  });

  afterAll(async () => database.teardown());

  it("promotes without visiting rows that are not yet due", async () => {
    expect(await sharedHits("SELECT workhorse.promote_v1(100)")).toBeLessThan(sharedHitBound);
  });

  it("recovers without visiting deadlines that have not passed", async () => {
    expect(await sharedHits("SELECT workhorse.recover_expired_v1(100)")).toBeLessThan(
      sharedHitBound,
    );
  });

  it("still promotes and terminalizes rows that are due", async () => {
    await database.pool.query(
      `UPDATE workhorse.task_runtime
          SET run_at = clock_timestamp() - interval '1 second'
        WHERE task_id = md5('tick-1')::uuid`,
    );
    await database.pool.query(
      `UPDATE workhorse.task_runtime
          SET deadline_at = clock_timestamp() - interval '1 second'
        WHERE task_id = md5('tick-2')::uuid`,
    );

    const promoted = await database.pool.query<{ count: number }>(
      "SELECT workhorse.promote_v1(100) AS count",
    );
    const recovered = await database.pool.query<{ count: number }>(
      "SELECT workhorse.recover_expired_v1(100) AS count",
    );
    const states = await database.pool.query<{ task: string; state: string }>(
      `SELECT 'tick-1' AS task, state FROM workhorse.task_runtime
        WHERE task_id = md5('tick-1')::uuid
       UNION ALL
       SELECT 'tick-2', state FROM workhorse.task_outcome WHERE task_id = md5('tick-2')::uuid`,
    );

    expect(promoted.rows[0]!.count).toBe(1);
    expect(recovered.rows[0]!.count).toBe(1);
    expect(states.rows).toEqual([
      { task: "tick-1", state: "ready" },
      { task: "tick-2", state: "failed" },
    ]);
  });
});
