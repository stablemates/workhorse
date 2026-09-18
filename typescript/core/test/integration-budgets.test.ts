import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { raceBudgetAdmission } from "./support/budget-race.js";
import { createIntegrationTestContext } from "./support/integration.js";

const { pool, queue, admin } = createIntegrationTestContext(import.meta.url);

describe("named budgets", () => {
  it("synchronizes, lists, prunes, and validates budgets per namespace", async () => {
    const vendor = `budget-vendor-${randomUUID()}`;
    const slow = `budget-slow-${randomUUID()}`;
    const synced = await queue.syncBudgets("budget-test", [
      { name: vendor, maxActive: 3 },
      { name: slow, rate: { limit: 1, intervalMs: 60_000, burst: 1 } },
    ]);
    // Rows come back ordered by name; "budget-slow" sorts before "budget-vendor".
    expect(synced).toMatchObject([
      {
        namespace: "budget-test",
        name: slow,
        maxActive: null,
        rate: { limit: 1, intervalMs: 60_000, burst: 1 },
      },
      { namespace: "budget-test", name: vendor, maxActive: 3, rate: null },
    ]);
    expect(await queue.listBudgets([vendor, slow])).toMatchObject([
      { name: slow, updatedAt: expect.any(Date) },
      { name: vendor },
    ]);
    expect(await admin.listBudgets([vendor])).toMatchObject([{ name: vendor }]);

    const preserved = await queue.syncBudgets("budget-test", [{ name: vendor, maxActive: 4 }], {
      prune: false,
    });
    expect(preserved.map((budget) => budget.name)).toEqual([slow, vendor]);
    const pruned = await queue.syncBudgets("budget-test", [{ name: vendor, maxActive: 4 }]);
    expect(pruned.map((budget) => budget.name)).toEqual([vendor]);

    await expect(
      queue.syncBudgets("other-namespace", [{ name: vendor, maxActive: 1 }]),
    ).rejects.toThrow(/owned by another namespace/);
    await expect(queue.syncBudgets("budget-test", [{ name: vendor }])).rejects.toThrow(
      /requires maxActive, rate, or both/,
    );
    await expect(
      queue.syncBudgets("budget-test", [
        { name: vendor, rate: { limit: 0, intervalMs: 1_000, burst: 1 } },
      ]),
    ).rejects.toThrow(/bounded positive integers/);
    await expect(
      queue.syncBudgets("budget-test", [{ name: vendor, maxActive: 1.5 }]),
    ).rejects.toThrow(/integer between 1 and 1000000/);
  });

  it("caps active work across queues and returns capacity when a lease expires", async () => {
    const budget = `budget-cross-${randomUUID()}`;
    const queueA = `budget-a-${randomUUID()}`;
    const queueB = `budget-b-${randomUUID()}`;
    await queue.syncBudgets("budget-test", [{ name: budget, maxActive: 1 }]);
    await queue.enqueue("budgeted", { queue: "a" }, { queue: queueA, budget });
    const secondId = await queue.enqueue("budgeted", { queue: "b" }, { queue: queueB, budget });

    const first = await queue.claim("budget-worker-a", { queue: queueA, leaseMs: 100 });
    expect(first).toMatchObject({ payload: { queue: "a" } });
    await expect(queue.claim("budget-worker-b", { queue: queueB })).resolves.toBeNull();

    const status = await queue.budgetStatuses([budget]);
    expect(status).toMatchObject([
      { name: budget, active: 1, saturated: true, blockedReady: 1, availableTokens: null },
    ]);

    await sleep(120);
    await expect(queue.claim("budget-worker-b", { queue: queueB })).resolves.toMatchObject({
      id: secondId,
    });
  });

  it("holds maxActive when a budgeted task commits while another queue's claim is in flight", async () => {
    // The late queue's claim samples its ready rows before the budgeted task commits, then admits
    // from a window that contains it while the other queue's claim of the same budget is still open.
    const outcome = await raceBudgetAdmission(pool, queue, {
      name: `budget-race-${randomUUID()}`,
      taskType: "budget-race",
      maxActive: 1,
      queueRate: { limit: 1_000, intervalMs: 1_000, burst: 1_000 },
      leaseMs: 30_000,
    });
    expect(outcome).toEqual({ holderClaims: 1, lateClaims: 0, active: 1 });
  });

  it("admits freely when a task names a budget nobody synchronized", async () => {
    const queueName = `budget-missing-${randomUUID()}`;
    await queue.enqueue("unbudgeted", null, {
      queue: queueName,
      budget: `never-synced-${randomUUID()}`,
    });
    await expect(queue.claim("budget-worker", { queue: queueName })).resolves.not.toBeNull();
  });

  it("applies the queue policy and the budget together", async () => {
    const budget = `budget-both-${randomUUID()}`;
    const queueName = `budget-both-queue-${randomUUID()}`;
    await queue.syncBudgets("budget-test", [{ name: budget, maxActive: 2 }]);
    await queue.syncConcurrencyPolicies("budget-test", [{ queue: queueName, maxActive: 1 }]);
    await queue.enqueue("both", { ordinal: 1 }, { queue: queueName, budget });
    await queue.enqueue("both", { ordinal: 2 }, { queue: queueName, budget });

    const first = await queue.claim("both-worker", { queue: queueName });
    expect(first).toMatchObject({ payload: { ordinal: 1 } });
    // The budget still has room; the queue policy is what refuses the second start.
    await expect(queue.claim("both-worker", { queue: queueName })).resolves.toBeNull();
    expect(await queue.complete(first!, "both-worker", null)).toBe(true);
    await expect(queue.claim("both-worker", { queue: queueName })).resolves.toMatchObject({
      payload: { ordinal: 2 },
    });
  });

  it("passes over a saturated budget inside the bounded window", async () => {
    const budget = `budget-window-${randomUUID()}`;
    const queueName = `budget-window-queue-${randomUUID()}`;
    await queue.syncBudgets("budget-test", [{ name: budget, maxActive: 1 }]);
    await queue.enqueue("window", { ordinal: 1 }, { queue: queueName, budget });
    await queue.enqueue("window", { ordinal: 2 }, { queue: queueName, budget });
    const freeId = await queue.enqueue("window", { ordinal: 3 }, { queue: queueName });

    await expect(queue.claim("window-worker", { queue: queueName })).resolves.toMatchObject({
      payload: { ordinal: 1 },
    });
    // The budget-named head is refused, so the later unbudgeted row is admitted instead.
    await expect(queue.claim("window-worker", { queue: queueName })).resolves.toMatchObject({
      id: freeId,
    });
    await expect(queue.claim("window-worker", { queue: queueName })).resolves.toBeNull();
  });

  it("stops claimMany at the budget and counts its own admissions", async () => {
    const budget = `budget-many-${randomUUID()}`;
    const queueName = `budget-many-queue-${randomUUID()}`;
    await queue.syncBudgets("budget-test", [{ name: budget, maxActive: 2 }]);
    await queue.enqueueMany(
      [1, 2, 3].map((ordinal) => ({
        type: "many",
        payload: { ordinal },
        options: { queue: queueName, budget },
      })),
    );
    const claimed = await queue.claimMany("many-worker", 3, { queue: queueName });
    expect(claimed.map((task) => task.payload)).toEqual([{ ordinal: 1 }, { ordinal: 2 }]);
  });

  it("shares one token bucket across queues and refills it from PostgreSQL time", async () => {
    const budget = `budget-rate-${randomUUID()}`;
    const queueA = `budget-rate-a-${randomUUID()}`;
    const queueB = `budget-rate-b-${randomUUID()}`;
    await queue.syncBudgets("budget-test", [
      { name: budget, rate: { limit: 1, intervalMs: 60_000, burst: 1 } },
    ]);
    await queue.enqueue("rated", null, { queue: queueA, budget });
    await queue.enqueue("rated", null, { queue: queueB, budget });

    const first = await queue.claim("rate-worker", { queue: queueA });
    expect(first).not.toBeNull();
    await expect(queue.claim("rate-worker", { queue: queueB })).resolves.toBeNull();
    expect(await queue.complete(first!, "rate-worker", null)).toBe(true);
    // Completion never refunds a token: the budget measures starts.
    await expect(queue.claim("rate-worker", { queue: queueB })).resolves.toBeNull();

    const [status] = await queue.budgetStatuses([budget]);
    expect(status).toMatchObject({ saturated: true, blockedReady: 1 });
    expect(status!.availableTokens).toBeLessThan(1);
    expect(status!.nextEligibleAt).toBeInstanceOf(Date);

    // Move the persisted refill clock back instead of sleeping through the interval.
    await pool.query(
      `UPDATE workhorse.budget_bucket SET refilled_at = refilled_at - interval '61 seconds'
        WHERE budget_name = $1`,
      [budget],
    );
    await expect(queue.claim("rate-worker", { queue: queueB })).resolves.not.toBeNull();
  });

  it("reports bounded budget summaries through health and telemetry snapshots", async () => {
    const budget = `budget-health-${randomUUID()}`;
    const queueName = `budget-health-queue-${randomUUID()}`;
    await queue.syncBudgets("budget-test", [
      { name: budget, maxActive: 1, rate: { limit: 10, intervalMs: 1_000, burst: 10 } },
    ]);
    await queue.enqueue("health", null, { queue: queueName, budget });
    await queue.enqueue("health", null, { queue: queueName, budget });
    await queue.claim("health-worker", { queue: queueName });

    const health = await queue.health();
    expect(health.budgetPolicies).toMatchObject({
      capped: false,
      budgets: [
        {
          namespace: "budget-test",
          name: budget,
          maxActive: 1,
          active: 1,
          saturated: true,
          blockedReady: 1,
          rate: { limit: 10, intervalMs: 1_000, burst: 10 },
        },
      ],
    });
    expect(health.status.reasons).toContainEqual(
      expect.objectContaining({ code: "budget-blocked", budgetName: budget, observed: 1 }),
    );
    await expect(queue.budgetStatuses()).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ name: budget, active: 1 })]),
    );
  });

  it("keeps the budget in the idempotency fingerprint and copies it on redrive", async () => {
    const queueName = `budget-fingerprint-${randomUUID()}`;
    const idempotency = { scope: "budget-test", key: randomUUID(), ttlMs: 60_000 };
    const id = await queue.enqueue("fingerprint", null, {
      queue: queueName,
      budget: "vendor",
      idempotency,
    });
    await expect(
      queue.enqueue("fingerprint", null, { queue: queueName, budget: "vendor", idempotency }),
    ).resolves.toBe(id);
    await expect(
      queue.enqueue("fingerprint", null, { queue: queueName, budget: "other", idempotency }),
    ).rejects.toMatchObject({ conflictingFields: ["budget"] });
    const stored = await pool.query<{ budget_name: string }>(
      "SELECT budget_name FROM workhorse.task WHERE id = $1",
      [id],
    );
    expect(stored.rows).toEqual([{ budget_name: "vendor" }]);
  });

  it("uses the partial budget indexes for admission and wake-up lookups", async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL enable_seqscan = off");
      const activePlan = (
        await client.query<{ "QUERY PLAN": string }>(`EXPLAIN (COSTS OFF)
          SELECT count(*) FROM workhorse.task_runtime active
           WHERE active.state = 'active' AND active.budget_name = 'budget-plan'
             AND active.expires_at > clock_timestamp()`)
      ).rows
        .map((row) => row["QUERY PLAN"])
        .join("\n");
      expect(activePlan).toContain("task_runtime_active_budget_expiry_idx");
      const readyPlan = (
        await client.query<{ "QUERY PLAN": string }>(`EXPLAIN (COSTS OFF)
          SELECT 1 FROM workhorse.task_runtime waiting
           WHERE waiting.state = 'ready' AND waiting.queue_name = 'budget-plan'
             AND waiting.budget_name IS NOT NULL`)
      ).rows
        .map((row) => row["QUERY PLAN"])
        .join("\n");
      // Both partial budget indexes cover the lookup; the planner picks by statistics.
      expect(readyPlan).toMatch(/task_runtime_ready_budget(_queue)?_idx/);
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
    }
  });
});
