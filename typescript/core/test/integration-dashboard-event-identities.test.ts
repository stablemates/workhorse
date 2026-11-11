import type { QueryResultRow } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type {
  DashboardEventDetail,
  DashboardEventsPage,
  DashboardTaskDetail,
} from "../../dashboard-server/src/wire.js";
import { createDatabaseTestHarness } from "./support/db.js";

// The event detail of a derived fast-tier record (SM-1999), and the error-stack redaction of the
// three dashboard reads (SM-1968).
const database = createDatabaseTestHarness(import.meta.url, { max: 2 });

const stack = "Error: boom\n    at handler (/srv/app/worker.js:12:7)";
const storedError = { name: "Error", message: "boom", stack };

async function value<T>(sql: string, input: object): Promise<T> {
  const result = await database.pool.query<{ result: T } & QueryResultRow>(sql, [
    JSON.stringify(input),
  ]);
  return result.rows[0]!.result;
}

const events = (input: object) =>
  value<DashboardEventsPage>("SELECT workhorse.dashboard_events_v1($1::jsonb) AS result", input);
const eventDetail = (input: object) =>
  value<DashboardEventDetail | null>(
    "SELECT workhorse.dashboard_event_detail_v1($1::jsonb) AS result",
    input,
  );
const taskDetail = (input: object) =>
  value<DashboardTaskDetail | null>(
    "SELECT workhorse.dashboard_task_detail_v1($1::jsonb) AS result",
    input,
  );

let fullTask: string;
let fastTask: string;

beforeAll(async () => {
  await database.setup();
  const pool = database.pool;
  // A fast-tier queue that records no attempts and no claims, so each history record of its
  // tasks is derived.
  await pool.query("SELECT workhorse.set_queue_tier_v1('derived', 'fast', 'test', 'seed')");
  await pool.query(
    `SELECT workhorse.enqueue_many_v1('[{"queue":"derived","type":"derived.ok","payload":{}},
       {"queue":"derived","type":"derived.ok","payload":{}},
       {"queue":"derived","type":"derived.fail","payload":{},"maxAttempts":2}]'::jsonb)`,
  );
  const claims = await pool.query<{ task_id: string; fence_token: string }>(
    "SELECT task_id, fence_token FROM workhorse.fast_claim_v1('derived', 'w', 3, 30000, false)",
  );
  for (const claim of claims.rows) {
    const type = await pool.query<{ task_type: string }>(
      "SELECT task_type FROM workhorse.task WHERE id = $1",
      [claim.task_id],
    );
    if (type.rows[0]!.task_type === "derived.fail") {
      fastTask = claim.task_id;
      await pool.query("SELECT workhorse.fast_fail_v1($1, 'w', $2, $3::jsonb, 0)", [
        claim.task_id,
        claim.fence_token,
        JSON.stringify(storedError),
      ]);
    } else {
      await pool.query("SELECT workhorse.fast_complete_v1($1, 'w', $2, '{}'::jsonb)", [
        claim.task_id,
        claim.fence_token,
      ]);
    }
  }
  const retry = await pool.query<{ task_id: string; fence_token: string }>(
    "SELECT task_id, fence_token FROM workhorse.fast_claim_v1('derived', 'w', 1, 30000, false)",
  );
  await pool.query("SELECT workhorse.fast_fail_v1($1, 'w', $2, $3::jsonb, 0)", [
    retry.rows[0]!.task_id,
    retry.rows[0]!.fence_token,
    JSON.stringify(storedError),
  ]);

  // A full-tier task that fails one time and then fails for good, so it has a retry_scheduled
  // event, a failed event, two attempt rows, and an outcome error.
  const enqueued = await pool.query<{ task_id: string }>(
    `SELECT task_id FROM workhorse.enqueue_many_v1(
       '[{"queue":"full","type":"full.fail","payload":{},"maxAttempts":2}]'::jsonb)`,
  );
  fullTask = enqueued.rows[0]!.task_id;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const claim = await pool.query<{ fence_token: string }>(
      "SELECT fence_token FROM workhorse.claim_v1('full', 'w', 30000)",
    );
    await pool.query("SELECT workhorse.fail_v1($1, 'w', $2, $3::jsonb, 0)", [
      fullTask,
      claim.rows[0]!.fence_token,
      JSON.stringify(storedError),
    ]);
  }
});
afterAll(async () => database.teardown());

describe("derived history records", () => {
  it("returns a detail for each identity that the event feed lists for a fast-tier queue", async () => {
    const page = await events({ queue: "derived", pageSize: 100 });
    const kinds = new Set(page.events.map((row) => `${row.kind}:${row.type}`));
    expect(kinds).toEqual(
      new Set([
        "event:enqueued",
        "event:claimed",
        "event:succeeded",
        "event:failed",
        "attempt:succeeded",
        "attempt:failed",
        "attempt:retry",
      ]),
    );
    // Before this change the version 7 check refused almost every derived identity.
    expect(page.events.some((row) => !/-7[0-9a-f]{3}-[89ab]/.test(row.recordId))).toBe(true);
    for (const row of page.events) {
      const detail = await eventDetail({ id: row.id });
      expect(detail).toMatchObject({
        id: row.id,
        kind: row.kind,
        recordId: row.recordId,
        taskId: row.taskId,
        type: row.type,
      });
    }
  });

  it("finds a derived identity in upper case and refuses a value that is not a UUID", async () => {
    const page = await events({ queue: "derived", kind: "attempt", pageSize: 1 });
    const row = page.events[0]!;
    expect(await eventDetail({ id: `${row.kind}:${row.recordId.toUpperCase()}` })).toMatchObject({
      recordId: row.recordId,
    });
    expect(await eventDetail({ id: "event:not-a-uuid" })).toBeNull();
    expect(await eventDetail({ id: `task:${row.recordId}` })).toBeNull();
    expect(await eventDetail({ id: "event:00000000-0000-0000-0000-000000000000" })).toBeNull();
  });
});

describe("error-stack redaction", () => {
  it("keeps each stack when the input has no redactErrorStacks key", async () => {
    expect(JSON.stringify(await taskDetail({ id: fullTask }))).toContain("/srv/app/worker.js");
    const page = await events({ taskId: fullTask, pageSize: 100 });
    const failed = page.events.find((row) => row.type === "failed")!;
    expect(failed.details).toMatchObject({ error: storedError });
    expect(await eventDetail({ id: failed.id })).toMatchObject({ details: { error: storedError } });
  });

  it("removes stack from each error of task detail", async () => {
    for (const id of [fullTask, fastTask]) {
      const detail = await taskDetail({ id, redactErrorStacks: true });
      const text = JSON.stringify(detail);
      expect(text).not.toContain('"stack"');
      expect(text).toContain('"message":"boom"');
    }
    const detail = (await taskDetail({ id: fullTask, redactErrorStacks: true }))!;
    expect(detail.current.error).toEqual({ name: "Error", message: "boom" });
    expect(detail.attempts.map((attempt) => attempt.error)).toEqual([
      { name: "Error", message: "boom" },
      { name: "Error", message: "boom" },
    ]);
    const retry = detail.events.find((event) => event.type === "retry_scheduled")!;
    expect(retry.details).toMatchObject({ error: { name: "Error", message: "boom" } });
    expect(retry.details).toHaveProperty("next_attempt", 2);
  });

  it("removes stack from details.error of the event feed and from each event detail", async () => {
    for (const taskId of [fullTask, fastTask]) {
      const page = await events({ taskId, pageSize: 100, redactErrorStacks: true });
      expect(JSON.stringify(page)).not.toContain('"stack"');
      for (const row of page.events) {
        const detail = await eventDetail({ id: row.id, redactErrorStacks: true });
        expect(JSON.stringify(detail)).not.toContain('"stack"');
      }
    }
    const page = await events({ taskId: fullTask, kind: "attempt", pageSize: 100 });
    const detail = await eventDetail({ id: page.events[0]!.id, redactErrorStacks: true });
    expect(detail!.error).toEqual({ name: "Error", message: "boom" });
    expect(detail!.errorMessage).toBe("boom");
  });

  it("does not match a withheld stack in the event search", async () => {
    const search = { taskId: fullTask, search: "srv/app/worker", count: "exact", pageSize: 100 };
    expect((await events(search)).total).toBeGreaterThan(0);
    expect(await events({ ...search, redactErrorStacks: true })).toMatchObject({
      total: 0,
      events: [],
    });
  });

  it("keeps a details object without an error as stored", async () => {
    const page = await events({ taskId: fullTask, types: ["enqueued"], redactErrorStacks: true });
    const [plain] = (await events({ taskId: fullTask, types: ["enqueued"] })).events;
    expect(page.events[0]!.details).toEqual(plain!.details);
  });
});
