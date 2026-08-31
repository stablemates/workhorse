import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabaseTestHarness } from "./support/db.js";

const database = createDatabaseTestHarness(import.meta.url);
const seededJobs = 500;

describe("dashboard procedure plans", () => {
  beforeAll(async () => {
    await database.setup();
    await database.pool.query(
      `INSERT INTO workhorse.job(queue_name, job_type, payload, max_attempts)
       SELECT 'dashboard-plan', 'dashboard.plan', '{}'::jsonb, 1
         FROM generate_series(1, $1)`,
      [seededJobs],
    );
    await database.pool.query(
      `INSERT INTO workhorse.job_outcome(
         job_id, state, current_attempt, fence_token, run_at, result,
         finished_at, history_through_at, updated_at
       )
       SELECT id, 'succeeded', 1, 1, created_at, '{}'::jsonb,
              created_at, created_at, created_at
         FROM workhorse.job
        WHERE queue_name = 'dashboard-plan'`,
    );
    await database.pool.query(
      `INSERT INTO workhorse.job_event(job_id, attempt, event_type, details, occurred_at)
       SELECT id, NULL, 'enqueued', '{}'::jsonb, created_at
         FROM workhorse.job
        WHERE queue_name = 'dashboard-plan'`,
    );
    await database.pool.query(
      `INSERT INTO workhorse.attempt_history(
         job_id, attempt, fence_token, worker_id, outcome,
         started_at, claimed_at, finished_at, occurred_at
       )
       SELECT id, 1, 1, 'dashboard-plan-worker', 'succeeded',
              created_at, created_at, created_at, created_at
         FROM workhorse.job
        WHERE queue_name = 'dashboard-plan'`,
    );
    await database.pool.query(
      `ANALYZE workhorse.job;
       ANALYZE workhorse.job_outcome;
       ANALYZE workhorse.job_event;
       ANALYZE workhorse.attempt_history;`,
    );
  });

  afterAll(async () => database.teardown());

  it("disables JIT for generic high-cost dashboard plans", async () => {
    // PostgreSQL applies proconfig before planning the function body, so this covers every
    // input-specific events branch without relying on a wall-clock assertion.
    const result = await database.pool.query<{ proname: string; proconfig: string[] | null }>(
      `SELECT routine.proname, routine.proconfig
         FROM pg_proc routine
         JOIN pg_namespace namespace ON namespace.oid = routine.pronamespace
        WHERE namespace.nspname = 'workhorse'
          AND routine.proname IN ('dashboard_activity_v1', 'dashboard_events_v1')
        ORDER BY routine.proname`,
    );

    expect(result.rows).toEqual([
      { proname: "dashboard_activity_v1", proconfig: ["jit=off"] },
      { proname: "dashboard_events_v1", proconfig: ["jit=off"] },
    ]);
  });

  it("enriches only the requested task page", async () => {
    const result = await database.pool.query<{ "QUERY PLAN": unknown }>(
      `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
       SELECT workhorse.dashboard_tasks_v1(
         '{"filter":"all","sort":"updated","tags":[],"page":1,"pageSize":25}'::jsonb
       )`,
    );
    const explain = result.rows[0]?.["QUERY PLAN"] as
      | Array<{ Plan?: { "Shared Hit Blocks"?: number } }>
      | undefined;
    const sharedHits = explain?.[0]?.Plan?.["Shared Hit Blocks"];

    expect(sharedHits).toBeTypeOf("number");
    // Enriching all seeded rows probes every event and attempt partition and exceeds this bound.
    expect(sharedHits).toBeLessThan(seededJobs * 10);
  });
});
