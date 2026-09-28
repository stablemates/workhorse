import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { createIntegrationTestContext } from "./support/integration.js";

const { pool, queue } = createIntegrationTestContext(import.meta.url);

// A full-tier queue with no concurrency policy, rate limit, budget or dependency claims through
// the set path and skips the capacity and dependency trigger work (SM-948).
describe("policy-free full-tier queues", () => {
  it("claims a batch as one set in claim order with one claimed event per task", async () => {
    const queueName = `plain-set-${randomUUID()}`;
    await queue.enqueueMany(
      [1, 2, 3, 4, 5].map((ordinal) => ({
        type: "plain",
        payload: { ordinal },
        options: { queue: queueName, priority: ordinal === 4 ? 10 : 0 },
      })),
    );

    const first = await queue.claimMany("plain-worker", 3, { queue: queueName });
    expect(first.map((task) => task.payload)).toEqual([
      { ordinal: 4 },
      { ordinal: 1 },
      { ordinal: 2 },
    ]);
    const fences = first.map((task) => BigInt(task.fenceToken));
    expect(fences).toEqual(fences.toSorted((left, right) => (left < right ? -1 : 1)));

    const rest = await queue.claimMany("plain-worker", 5, { queue: queueName });
    expect(rest.map((task) => task.payload)).toEqual([{ ordinal: 3 }, { ordinal: 5 }]);

    const events = await pool.query<{ claimed: number }>(
      `SELECT count(*)::integer AS claimed
         FROM workhorse.task_event event
         JOIN workhorse.task task ON task.id = event.task_id
        WHERE task.queue_name = $1 AND event.event_type = 'claimed'`,
      [queueName],
    );
    expect(events.rows[0]?.claimed).toBe(5);
  });

  it("admits budgeted rows on a queue without a policy as a single claim would", async () => {
    const budget = `plain-budget-${randomUUID()}`;
    const queueName = `plain-budget-queue-${randomUUID()}`;
    await queue.syncBudgets("plain-test", [{ name: budget, maxActive: 1 }]);
    await queue.enqueueMany(
      [1, 2, 3, 4].map((ordinal) => ({
        type: "plain",
        payload: { ordinal },
        options: { queue: queueName, ...(ordinal === 2 || ordinal === 3 ? { budget } : {}) },
      })),
    );

    const claimed = await queue.claimMany("plain-worker", 4, { queue: queueName });
    expect(claimed.map((task) => task.payload)).toEqual([
      { ordinal: 1 },
      { ordinal: 2 },
      { ordinal: 4 },
    ]);
    await expect(queue.claimMany("plain-worker", 4, { queue: queueName })).resolves.toEqual([]);
  });

  it("notifies a concurrency policy created while a lease is held when that lease ends", async () => {
    const queueName = `plain-late-policy-${randomUUID()}`;
    await queue.enqueue("plain", null, { queue: queueName });
    const leased = await queue.claim("plain-worker", { queue: queueName });
    expect(leased).not.toBeNull();
    await queue.syncConcurrencyPolicies("plain-test", [{ queue: queueName, maxActive: 1 }]);

    const listener = await pool.connect();
    const notifications: string[] = [];
    listener.on("notification", (message) => notifications.push(message.payload ?? ""));
    try {
      await listener.query("LISTEN workhorse_tasks");
      await expect(queue.complete(leased!, "plain-worker", null)).resolves.toBe(true);
      await sleep(100);
      expect(notifications.filter((payload) => payload === queueName)).toHaveLength(1);
    } finally {
      await listener.query("UNLISTEN workhorse_tasks");
      listener.release();
      await queue.syncConcurrencyPolicies("plain-test", []);
    }
  });

  it("calls the capacity triggers only for a row that leaves the active state", async () => {
    const triggers = await pool.query<{ name: string; definition: string }>(
      `SELECT trigger.tgname AS name, pg_get_triggerdef(trigger.oid) AS definition
         FROM pg_trigger trigger
        WHERE trigger.tgrelid = 'workhorse.task_runtime'::regclass
          AND trigger.tgname LIKE 'task_runtime_%_capacity_%'
        ORDER BY trigger.tgname`,
    );
    expect(
      Object.fromEntries(
        triggers.rows.map((row) => [row.name, /WHEN \((.*)\) EXECUTE/.exec(row.definition)?.[1]]),
      ),
    ).toEqual({
      task_runtime_budget_capacity_delete:
        "((old.state = 'active'::text) AND (old.budget_name IS NOT NULL))",
      task_runtime_budget_capacity_update:
        "((old.state = 'active'::text) AND (old.budget_name IS NOT NULL) AND (new.state <> 'active'::text))",
      task_runtime_concurrency_capacity_delete: "(old.state = 'active'::text)",
      task_runtime_concurrency_capacity_update:
        "((old.state = 'active'::text) AND (new.state <> 'active'::text))",
    });
  });

  it("still releases the incoming edges of a blocked task that is canceled", async () => {
    const prerequisiteId = await queue.enqueue("plain-prerequisite", null, {
      queue: `plain-dependency-${randomUUID()}`,
    });
    const dependentId = await queue.enqueue("plain-dependent", null, {
      prerequisiteTaskId: prerequisiteId,
    });
    await queue.cancel(dependentId);

    const edges = await pool.query<{ resolution: string | null; released: boolean }>(
      `SELECT resolution, released_at IS NOT NULL AS released
         FROM workhorse.task_dependency
        WHERE dependent_task_id = $1`,
      [dependentId],
    );
    expect(edges.rows).toEqual([{ resolution: "release", released: true }]);
  });
});
