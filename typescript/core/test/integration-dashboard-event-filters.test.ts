import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DashboardEventsPage, DashboardTaskDetail } from "../../dashboard-server/src/wire.js";
import { createDatabaseTestHarness } from "./support/db.js";

const database = createDatabaseTestHarness(import.meta.url);

describe("dashboard event filters and detail metadata", () => {
  beforeAll(async () => {
    await database.setup();
    await database.pool.query(`
      INSERT INTO workhorse.task(queue_name, task_type, payload, max_attempts, tags)
      SELECT 'billing', CASE WHEN n <= 30 THEN 'invoice.match' ELSE 'invoice.other' END,
        '{}', 1, ARRAY['customer:42', 'weekly'] FROM generate_series(1, 60) n;
      INSERT INTO workhorse.task_outcome(task_id, state, current_attempt, fence_token, run_at,
        result, finished_at, history_through_at, updated_at)
      SELECT id, 'succeeded', 1, 1, created_at, '{}', created_at, created_at, created_at
      FROM workhorse.task;
      INSERT INTO workhorse.attempt_history(task_id, attempt, fence_token, worker_id, outcome,
        started_at, claimed_at, finished_at)
      SELECT id, 1, 1, CASE WHEN task_type = 'invoice.match' THEN 'worker-a' ELSE 'worker-b' END,
        'succeeded', created_at, created_at, created_at FROM workhorse.task;
      INSERT INTO workhorse.task_event(task_id, attempt, event_type, details)
      SELECT id, 1, 'succeeded', '{}' FROM workhorse.task;
    `);
  });
  afterAll(async () => database.teardown());

  async function events(input: object): Promise<DashboardEventsPage> {
    const result = await database.pool.query<{ result: DashboardEventsPage }>(
      "SELECT workhorse.dashboard_events_v1($1::jsonb) AS result",
      [JSON.stringify(input)],
    );
    return result.rows[0]!.result;
  }

  it("filters both sources before pagination and counts the entire matching result", async () => {
    const first = await events({ worker: "worker-a", search: "MATCH", pageSize: 25 });
    const second = await events({ worker: "worker-a", search: "MATCH", pageSize: 25, page: 2 });
    expect(first.total).toBe(60);
    expect(second.total).toBe(60);
    expect(first.events).toHaveLength(25);
    expect(second.events).toHaveLength(25);
    expect(new Set([...first.events, ...second.events].map((event) => event.id)).size).toBe(50);
    expect(
      [...first.events, ...second.events].every(
        (event) => event.workerId === "worker-a" && event.taskType === "invoice.match",
      ),
    ).toBe(true);
    const lifecycle = await events({ worker: "worker-a", kind: "event" });
    expect(lifecycle.total).toBe(30);
    const detail = await database.pool.query<{ result: { workerId: string } }>(
      "SELECT workhorse.dashboard_event_detail_v1($1::jsonb) AS result",
      [JSON.stringify({ id: lifecycle.events[0]!.id })],
    );
    expect(detail.rows[0]!.result.workerId).toBe("worker-a");
    expect((await events({ worker: "worker-a", kind: "attempt" })).total).toBe(30);
  });

  it("searches IDs and event names, treats SQL wildcards literally, and combines filters", async () => {
    const page = await events({ search: "succeeded", queue: "billing", worker: "worker-b" });
    expect(page.total).toBe(60);
    const id = page.events[0]!.taskId;
    expect((await events({ search: id })).total).toBe(2);
    expect((await events({ search: "%" })).total).toBe(0);
    expect((await events({ search: "invoice.match", worker: "worker-b" })).total).toBe(0);
  });

  it("returns tags and explicit action capability", async () => {
    const id = (await events({})).events[0]!.taskId;
    const result = await database.pool.query<{ detail: DashboardTaskDetail }>(
      "SELECT workhorse.dashboard_task_detail_v1($1::jsonb) AS detail",
      [JSON.stringify({ id, canCompleteHumanWait: true })],
    );
    expect(result.rows[0]!.detail).toMatchObject({
      tags: ["customer:42", "weekly"],
      humanWait: null,
      canCompleteHumanWait: true,
    });
    const missing = await database.pool.query<{ detail: unknown }>(
      "SELECT workhorse.dashboard_task_detail_v1(jsonb_build_object('id', workhorse.uuid_v7_v1())) AS detail",
    );
    expect(missing.rows[0]!.detail).toBeNull();
  });
});
