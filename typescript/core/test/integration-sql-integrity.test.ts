import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { createIntegrationTestContext } from "./support/integration.js";

const { pool, queue, admin, adminAudit } = createIntegrationTestContext(import.meta.url);

const slowRate = { limit: 1, intervalMs: 3_600_000, burst: 3 };
const raisedRate = { limit: 1, intervalMs: 1_000, burst: 3 };

// At 0 s a burst of 3 at one token an hour is spent. At 1.2 s the rate becomes one token a second.
// The elapsed 1.2 s earned almost nothing at the old rate, so the next start must still wait. A
// refill at the new rate would have earned 1.2 tokens and started it.
async function startAfterRaise(
  queueName: string,
  options: { concurrencyKey?: string; budget?: string },
  raise: () => Promise<unknown>,
): Promise<number> {
  for (let index = 0; index < 4; index += 1) {
    await queue.enqueue("spend", null, { queue: queueName, ...options });
  }
  expect(await queue.claimMany("spender", 4, { queue: queueName })).toHaveLength(3);
  await sleep(1_200);
  await raise();
  return (await queue.claimMany("spender", 1, { queue: queueName })).length;
}

describe("rate synchronization", () => {
  it("refills the queue bucket at the old rate up to the synchronization", async () => {
    await queue.syncRateLimitPolicies("integrity", [{ queue: "rate-raised", rate: slowRate }]);
    const started = await startAfterRaise("rate-raised", {}, () =>
      queue.syncRateLimitPolicies("integrity", [{ queue: "rate-raised", rate: raisedRate }]),
    );
    expect(started).toBe(0);
  });

  it("refills a per-key bucket at the old rate up to the synchronization", async () => {
    const rate = { limit: 1_000, intervalMs: 1_000, burst: 1_000 };
    await queue.syncRateLimitPolicies("integrity", [
      { queue: "key-raised", rate, perKey: slowRate },
    ]);
    const started = await startAfterRaise("key-raised", { concurrencyKey: "customer" }, () =>
      queue.syncRateLimitPolicies("integrity", [{ queue: "key-raised", rate, perKey: raisedRate }]),
    );
    expect(started).toBe(0);
  });

  it("refills a budget bucket at the old rate up to the synchronization", async () => {
    await queue.syncBudgets("integrity", [{ name: "raised", rate: slowRate }]);
    const started = await startAfterRaise("budget-raised", { budget: "raised" }, () =>
      queue.syncBudgets("integrity", [{ name: "raised", rate: raisedRate }]),
    );
    expect(started).toBe(0);
  });

  it("starts a budget full when it regains a rate", async () => {
    await queue.syncBudgets("integrity", [{ name: "regained", rate: slowRate }]);
    for (let index = 0; index < 3; index += 1) {
      await queue.enqueue("spend", null, { queue: "budget-regained", budget: "regained" });
    }
    expect(await queue.claimMany("spender", 3, { queue: "budget-regained" })).toHaveLength(3);
    await queue.syncBudgets("integrity", [{ name: "regained", maxActive: 100 }]);
    await queue.syncBudgets("integrity", [{ name: "regained", maxActive: 100, rate: slowRate }]);

    const bucket = await pool.query(
      "SELECT 1 FROM workhorse.budget_bucket WHERE budget_name = 'regained'",
    );
    expect(bucket.rowCount).toBe(0);
  });
});

describe("rate CHECK constraints", () => {
  it("rejects a per-key rate setting with a missing field", async () => {
    await expect(
      pool.query(
        `INSERT INTO workhorse.rate_limit_policy(
           queue_name, namespace, rate_limit, rate_interval_ms, rate_burst,
           per_key_limit, per_key_interval_ms, per_key_burst
         ) VALUES ('incomplete', 'integrity', 1, 1000, 1, NULL, 1000, 1)`,
      ),
    ).rejects.toMatchObject({
      code: "23514",
      constraint: "rate_limit_policy_per_key_complete_check",
    });
  });

  it("rejects a budget rate setting with a missing field", async () => {
    await expect(
      pool.query(
        `INSERT INTO workhorse.budget(
           budget_name, namespace, max_active, rate_limit, rate_interval_ms, rate_burst
         ) VALUES ('incomplete', 'integrity', 1, 1, NULL, 1)`,
      ),
    ).rejects.toMatchObject({ code: "23514", constraint: "budget_rate_complete_check" });
  });
});

// The dependent waits on C. B is an unrelated task that an update could try to name.
async function arrangeEdge() {
  const [bId, cId] = await queue.enqueueMany(
    ["b", "c"].map((name) => ({
      type: `edge-${name}`,
      payload: null,
      options: { queue: "edges", runAt: new Date(Date.now() + 3_600_000) },
    })),
  );
  const dependentId = await queue.enqueue("edge-dependent", null, {
    queue: "edges",
    dependencies: {
      prerequisiteTaskIds: [cId!],
      onSuccess: "release",
      onFailure: "fail",
      onCancellation: "cancel",
    },
  });
  return { bId: bId!, cId: cId!, dependentId };
}

describe("dependency edges", () => {
  it("rejects a change to an edge's endpoints", async () => {
    const { bId, cId, dependentId } = await arrangeEdge();
    await expect(
      pool.query(
        `UPDATE workhorse.task_dependency SET prerequisite_task_id = $1
          WHERE dependent_task_id = $2 AND prerequisite_task_id = $3`,
        [bId, dependentId, cId],
      ),
    ).rejects.toMatchObject({ code: "55000" });
    await expect(
      pool.query(
        `UPDATE workhorse.task_dependency SET dependent_task_id = $1
          WHERE dependent_task_id = $2 AND prerequisite_task_id = $3`,
        [bId, dependentId, cId],
      ),
    ).rejects.toMatchObject({ code: "55000" });
  });

  it("rejects a change to an edge's outcome policies", async () => {
    const { cId, dependentId } = await arrangeEdge();
    const changes = { on_success: "fail", on_failure: "cancel", on_cancellation: "release" };
    for (const [column, value] of Object.entries(changes)) {
      await expect(
        pool.query(
          `UPDATE workhorse.task_dependency SET ${column} = $3
            WHERE dependent_task_id = $1 AND prerequisite_task_id = $2`,
          [dependentId, cId, value],
        ),
      ).rejects.toMatchObject({ code: "55000" });
    }
  });

  it("still releases an edge", async () => {
    const { cId, dependentId } = await arrangeEdge();
    const released = await pool.query(
      `UPDATE workhorse.task_dependency
          SET released_at = clock_timestamp(), resolution = 'release'
        WHERE dependent_task_id = $1 AND prerequisite_task_id = $2`,
      [dependentId, cId],
    );
    expect(released.rowCount).toBe(1);
  });
});

describe("run_task_now_v1", () => {
  it("reports a blocked task as not scheduled", async () => {
    const prerequisiteId = await queue.enqueue("blocking", null, {
      queue: "run-now",
      runAt: new Date(Date.now() + 3_600_000),
    });
    const blockedId = await queue.enqueue("blocked", null, {
      queue: "run-now",
      dependencies: {
        prerequisiteTaskIds: [prerequisiteId],
        onSuccess: "release",
        onFailure: "fail",
        onCancellation: "cancel",
      },
    });

    await expect(admin.runTaskNow(blockedId, adminAudit())).resolves.toEqual({
      status: "not_scheduled",
      taskId: blockedId,
      state: "blocked",
      runAt: expect.any(Date),
    });
    const events = await pool.query(
      "SELECT 1 FROM workhorse.task_event WHERE task_id = $1 AND event_type = 'promoted'",
      [blockedId],
    );
    expect(events.rowCount).toBe(0);
  });
});
