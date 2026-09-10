import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DashboardTasksCursorPage } from "../../dashboard-server/src/wire.js";
import { createDatabaseTestHarness } from "./support/db.js";

const database = createDatabaseTestHarness(import.meta.url);

describe("dashboard cursor pages", () => {
  beforeAll(async () => {
    await database.setup();
    await database.pool.query(`
      INSERT INTO workhorse.job(queue_name, job_type, payload, max_attempts, priority)
      SELECT 'cursor', 'cursor.test', '{}', 1, n % 3 FROM generate_series(1, 80) n;
      INSERT INTO workhorse.job_outcome(job_id, state, current_attempt, fence_token, run_at,
        result, finished_at, history_through_at, updated_at)
      SELECT id, 'succeeded', 1, 1, created_at, '{}', created_at, created_at,
        date_trunc('milliseconds', created_at) + interval '123 microseconds'
      FROM workhorse.job WHERE queue_name = 'cursor';
    `);
  });
  afterAll(async () => database.teardown());

  async function page(input: object = {}): Promise<DashboardTasksCursorPage> {
    const result = await database.pool.query<{ result: DashboardTasksCursorPage }>(
      "SELECT workhorse.dashboard_tasks_cursor_v1($1::jsonb) AS result",
      [JSON.stringify({ queue: "cursor", pageSize: 25, ...input })],
    );
    return result.rows[0]!.result;
  }

  for (const sort of ["updated", "priority"]) {
    it(`walks every row without duplicates in ${sort} order and can return to the previous page`, async () => {
      const first = await page({ sort });
      expect(first.total).toBeNull();
      expect(first.previousCursor).toBeNull();
      expect(first.nextCursor?.updatedAt).toMatch(/\.\d{6}Z$/);
      const second = await page({ sort, cursor: first.nextCursor });
      const back = await page({ sort, cursor: second.previousCursor, direction: "previous" });
      expect(back.jobs.map((job) => job.id)).toEqual(first.jobs.map((job) => job.id));
      expect(back.previousCursor).toBeNull();
      const ids = first.jobs.map((job) => job.id);
      let next = first.nextCursor;
      while (next) {
        const current = await page({ sort, cursor: next });
        ids.push(...current.jobs.map((job) => job.id));
        next = current.nextCursor;
        expect(ids.length).toBeLessThanOrEqual(80);
      }
      expect(ids).toHaveLength(80);
      expect(new Set(ids).size).toBe(80);
    });
  }

  it("counts the entire selection only when requested, including on later pages", async () => {
    const first = await page();
    const second = await page({ cursor: first.nextCursor, count: "exact" });
    expect(second.total).toBe(80);
    expect(second.jobs).toHaveLength(25);
    const empty = await page({ jobType: "absent", count: "exact" });
    expect(empty).toMatchObject({ total: 0, jobs: [], nextCursor: null, previousCursor: null });
  });

  it("preserves legacy task responses", async () => {
    const result = await database.pool.query<{ result: { total: number; page: number } }>(
      `SELECT workhorse.dashboard_tasks_v1('{"queue":"cursor","page":2,"pageSize":25}') AS result`,
    );
    expect(result.rows[0]!.result).toMatchObject({ total: 80, page: 2 });
  });

  it("seeks retained history without counting or scanning earlier pages", async () => {
    await database.pool.query(`
      INSERT INTO workhorse.job(queue_name, job_type, payload, max_attempts)
      SELECT 'history', 'history.test', '{}', 1 FROM generate_series(1, 5000);
      INSERT INTO workhorse.job_outcome(job_id, state, current_attempt, fence_token, run_at,
        result, finished_at, history_through_at, updated_at)
      SELECT id, 'succeeded', 1, 1, created_at, '{}', created_at, created_at, created_at
      FROM workhorse.job WHERE queue_name = 'history';
      ANALYZE workhorse.job; ANALYZE workhorse.job_outcome;
    `);
    const cursor = await database.pool.query<{ cursor: object }>(`
      SELECT jsonb_build_object('id', job_id, 'priority', 0,
        'updatedAt', to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')) AS cursor
      FROM workhorse.job_outcome ORDER BY updated_at DESC, job_id DESC OFFSET 4500 LIMIT 1
    `);
    const definition = await database.pool.query<{ prosrc: string }>(`
      SELECT prosrc FROM pg_proc WHERE oid = 'workhorse.dashboard_tasks_cursor_v1(jsonb)'::regprocedure
    `);
    // Explain the exact bound query from the procedure, so the nested plan is visible.
    const query = definition.rows[0]!.prosrc.split("$query$")[1]!
      .replace(
        "__cursor__",
        "(updated_at, id) < (($1->'cursor'->>'updatedAt')::timestamptz, ($1->'cursor'->>'id')::uuid)",
      )
      .replaceAll("__order__", "updated_at DESC, id DESC")
      .replaceAll("$1", "$1::jsonb");
    const plan = await database.pool.query<{
      "QUERY PLAN": Array<{ Plan: { "Shared Hit Blocks": number } }>;
    }>(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${query}`, [
      JSON.stringify({ pageSize: 25, cursor: cursor.rows[0]!.cursor }),
    ]);
    const tree = JSON.stringify(plan.rows[0]!["QUERY PLAN"]);
    expect(tree).toContain("job_outcome_updated_idx");
    expect(plan.rows[0]!["QUERY PLAN"][0]!.Plan["Shared Hit Blocks"]).toBeLessThan(1500);
  });

  it("answers the system page through the new shared-statistics implementation", async () => {
    for (const window of ["15m", "1h", "24h"]) {
      const result = await database.pool.query<{
        result: { window: string; outcomes: unknown[]; kpis: unknown };
      }>("SELECT workhorse.dashboard_system_v1($1::jsonb) AS result", [JSON.stringify({ window })]);
      expect(result.rows[0]!.result.window).toBe(window);
      expect(result.rows[0]!.result.outcomes.length).toBeGreaterThan(0);
      expect(result.rows[0]!.result.kpis).toHaveProperty("queueWait");
    }
  });
});
