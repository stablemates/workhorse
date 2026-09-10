import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Queue } from "../src/index.js";
import type { DashboardJobRow } from "../../dashboard-server/src/wire.js";
import { createDatabaseTestHarness } from "./support/db.js";

const database = createDatabaseTestHarness(import.meta.url);
const queue = new Queue(database.pool, "default");
const expected = new Map<string, DashboardJobRow["enqueueMode"]>();
let rejectedOutcome: string;

describe("dashboard accepted enqueue modes", () => {
  beforeAll(async () => {
    await database.setup();
    expected.set(await queue.enqueue("ordinary", {}), null);
    const idempotent = await queue.enqueue(
      "idempotent",
      {},
      {
        idempotency: { key: "same-key", ttlMs: 60_000 },
      },
    );
    expected.set(idempotent, "idempotency");
    expected.set(
      await queue.enqueue(
        "debounced",
        {},
        {
          debounce: { key: "debounce-key", windowMs: 60_000, schedule: "reset" },
        },
      ),
      "debounce",
    );
    expected.set(
      await queue.enqueue(
        "throttled",
        {},
        {
          throttle: { key: "throttle-key", windowMs: 60_000 },
        },
      ),
      "throttle",
    );
    const rejected = await queue.enqueueWithResult(
      "idempotent",
      {},
      {
        debounce: { key: "same-key", windowMs: 60_000, schedule: "reset" },
      },
    );
    rejectedOutcome = rejected.outcome;
    // Evidence belongs to the task even after the live ownership record is removed.
    await database.pool.query("DELETE FROM workhorse.enqueue_idempotency");
  });
  afterAll(async () => database.teardown());

  it.each(["dashboard_tasks_v1", "dashboard_tasks_cursor_v1"])(
    "%s exposes only the accepted mode",
    async (name) => {
      const result = await database.pool.query<{
        current: { jobs: DashboardJobRow[] };
      }>(`SELECT workhorse.${name}($1::jsonb) AS current`, [JSON.stringify({ pageSize: 100 })]);
      const { current } = result.rows[0]!;
      expect(rejectedOutcome).toBe("non_replaceable");
      expect(current.jobs).toHaveLength(4);
      for (const job of current.jobs) expect(job.enqueueMode).toBe(expected.get(job.id));
    },
  );

  it.each(["dashboard_tasks_v1", "dashboard_tasks_cursor_v1"])(
    "%s preserves empty pages",
    async (name) => {
      const result = await database.pool.query<{ page: { jobs: unknown[] } }>(
        `SELECT workhorse.${name}('{"queue":"missing"}'::jsonb) AS page`,
      );
      expect(result.rows[0]!.page.jobs).toEqual([]);
    },
  );
});
