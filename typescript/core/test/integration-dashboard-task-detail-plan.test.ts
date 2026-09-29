import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabaseTestHarness } from "./support/db.js";

const database = createDatabaseTestHarness(import.meta.url);

describe("dashboard task detail plan", () => {
  beforeAll(async () => database.setup());
  afterAll(async () => database.teardown());

  it("plans the task detail body below the JIT threshold on unanalyzed tables", async () => {
    // The body cross joins every section with the task row. The harness truncates between files,
    // so the planner sees tables without statistics, as a young demo database does. It estimated
    // several task rows there, and the joins multiplied that into a cost that compiled the
    // statement with JIT on every call (SM-965). Plan the body with the JIT settings at their
    // defaults and require a cost below the compilation threshold.
    const task = await database.pool.query<{ id: string }>(
      `INSERT INTO workhorse.task(queue_name, task_type, payload, max_attempts)
       VALUES ('dashboard-detail-plan', 'dashboard.detail', '{}'::jsonb, 1)
       RETURNING id`,
    );
    const source = await database.pool.query<{ prosrc: string }>(
      `SELECT routine.prosrc
         FROM pg_proc routine
         JOIN pg_namespace namespace ON namespace.oid = routine.pronamespace
        WHERE namespace.nspname = 'workhorse' AND routine.proname = 'dashboard_task_detail_v1'`,
    );
    const input = JSON.stringify({ id: task.rows[0]!.id });
    const body = source.rows[0]!.prosrc.replaceAll(/\bp_input\b/g, `'${input}'::jsonb`);
    const plan = await database.pool.query<{
      "QUERY PLAN": Array<{ Plan: { "Total Cost": number } }>;
    }>(`EXPLAIN (FORMAT JSON) ${body}`);
    const threshold = await database.pool.query<{ jit_above_cost: string }>(
      "SELECT current_setting('jit_above_cost') AS jit_above_cost",
    );

    expect(plan.rows[0]!["QUERY PLAN"][0]!.Plan["Total Cost"]).toBeLessThan(
      Number(threshold.rows[0]!.jit_above_cost),
    );
  });
});
