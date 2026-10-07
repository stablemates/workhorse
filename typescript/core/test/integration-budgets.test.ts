import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { SQL_STATEMENTS } from "../src/queue/sql-catalogue.generated.js";
import {
  gateBudgetCharge,
  raceBudgetAdmission,
  waitForStatementOnAdvisoryLock,
} from "./support/budget-race.js";
import { createIntegrationTestContext } from "./support/integration.js";

const { pool, queue, admin } = createIntegrationTestContext(import.meta.url);

type BudgetDefinition = Parameters<typeof queue.syncBudgets>[1][number];

/**
 * Parks a three-task claim of one budget between its room and its charge, starts `change` against the
 * budget, and reports the budget, whether the change finished before the claim charged, the claim's
 * size, and the bucket.
 */
async function changeBudgetDuringCharge(
  initial: BudgetDefinition,
  change: (budget: string) => Promise<unknown>,
): Promise<{ budget: string; changedUnderClaim: boolean; claimed: number; tokens: number | null }> {
  const budget = `budget-sync-${randomUUID()}`;
  const queueName = `budget-sync-queue-${randomUUID()}`;
  await queue.syncBudgets("budget-sync", [{ ...initial, name: budget }]);
  await queue.enqueueMany(
    [1, 2, 3].map((ordinal) => ({
      type: "synced",
      payload: { ordinal },
      options: { queue: queueName, budget },
    })),
  );
  const gate = await gateBudgetCharge(pool, queueName);
  // Both operations outlive a failed assertion, so cleanup opens the gate and joins them before the
  // next test resets the database.
  let claim: Promise<unknown[]> | undefined;
  let changed: Promise<unknown> | undefined;
  try {
    claim = queue.claimMany("sync-worker", 3, { queue: queueName });
    claim.catch(() => undefined);
    await waitForStatementOnAdvisoryLock(pool, "claim_many_v1", () => false);

    const state = { settled: false };
    changed = change(budget).finally(() => {
      state.settled = true;
    });
    changed.catch(() => undefined);
    await waitForStatementOnAdvisoryLock(pool, "sync_budgets_v1", () => state.settled);
    // A change that finished here rewrote the budget between the claim's room and its charge.
    const changedUnderClaim = state.settled;

    await gate.open();
    const claimed = await claim;
    await changed;
    const bucket = await pool.query<{ tokens: string }>(
      "SELECT tokens FROM workhorse.budget_bucket WHERE budget_name = $1",
      [budget],
    );
    return {
      budget,
      changedUnderClaim,
      claimed: claimed.length,
      tokens: bucket.rows[0] === undefined ? null : Number(bucket.rows[0].tokens),
    };
  } finally {
    await gate.open();
    await Promise.allSettled([claim, changed]);
    await gate.remove();
  }
}

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

  it("locks no ready row when the window's budget is saturated", async () => {
    const budget = `budget-locks-${randomUUID()}`;
    const queueName = `budget-locks-queue-${randomUUID()}`;
    await queue.syncBudgets("budget-test", [{ name: budget, maxActive: 1 }]);
    await queue.enqueue("budgeted", { ordinal: 1 }, { queue: queueName, budget });
    await queue.enqueue("budgeted", { ordinal: 2 }, { queue: queueName, budget });
    await expect(queue.claim("budget-lock-worker-a", { queue: queueName })).resolves.not.toBeNull();

    // The refused claim holds its transaction open, so a second session sees every lock it took.
    const claimer = await pool.connect();
    try {
      await claimer.query("BEGIN");
      const claimed = await claimer.query(SQL_STATEMENTS["claim_v1"], [
        queueName,
        "budget-lock-worker-b",
        30_000,
      ]);
      expect(claimed.rowCount).toBe(0);
      const locked = await pool.query<{ locked: number }>(
        `SELECT (
           SELECT count(*) FROM workhorse.task_runtime runtime
            WHERE runtime.queue_name = $1 AND runtime.state = 'ready'
         ) - (
           SELECT count(*) FROM (
             SELECT 1 FROM workhorse.task_runtime runtime
              WHERE runtime.queue_name = $1 AND runtime.state = 'ready'
              FOR UPDATE SKIP LOCKED
           ) lockable
         ) AS locked`,
        [queueName],
      );
      expect(Number(locked.rows[0]!.locked)).toBe(0);
    } finally {
      await claimer.query("ROLLBACK").catch(() => undefined);
      claimer.release();
    }
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

  it("refuses a claim below read committed instead of over-admitting a shared budget", async () => {
    // Under repeatable read, each claim counts active tasks in a snapshot taken before it waits for
    // the budget lock. Two queues share a concurrency-only budget, so no row write conflicts.
    const budget = `budget-isolation-${randomUUID()}`;
    const queueA = `budget-isolation-a-${randomUUID()}`;
    const queueB = `budget-isolation-b-${randomUUID()}`;
    await queue.syncBudgets("budget-test", [{ name: budget, maxActive: 1 }]);
    await queue.enqueue("budgeted", { queue: "a" }, { queue: queueA, budget });
    await queue.enqueue("budgeted", { queue: "b" }, { queue: queueB, budget });

    const early = await pool.connect();
    const late = await pool.connect();
    const refusal = {
      code: "0A000",
      message: "Workhorse claims require read committed isolation, not repeatable read",
    };
    try {
      for (const client of [early, late]) {
        await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
        await client.query("SELECT 1");
      }
      await expect(
        early.query(SQL_STATEMENTS["claim_v1"], [queueA, "isolation-worker-a", 30_000]),
      ).rejects.toMatchObject(refusal);
      await early.query("ROLLBACK");
      await expect(
        late.query(SQL_STATEMENTS["claim_v1"], [queueB, "isolation-worker-b", 30_000]),
      ).rejects.toMatchObject(refusal);
      await late.query("ROLLBACK");
    } finally {
      for (const client of [early, late]) {
        await client.query("ROLLBACK").catch(() => undefined);
        client.release();
      }
    }
    expect(await queue.budgetStatuses([budget])).toMatchObject([{ name: budget, active: 0 }]);
  });

  describe("synchronization during a claim", () => {
    it("waits for the claim before lowering a burst the claim already admitted against", async () => {
      const outcome = await changeBudgetDuringCharge(
        { name: "", rate: { limit: 1, intervalMs: 60_000, burst: 5 } },
        (budget) =>
          queue.syncBudgets("budget-sync", [
            { name: budget, rate: { limit: 1, intervalMs: 60_000, burst: 1 } },
          ]),
      );
      // The claim charged the burst it read: five tokens less three starts, at the clock reading
      // it also stamps as acquired_at. The synchronization then refilled the bucket to its own
      // reading, stored as refilled_at, at the old rate of one token per 60,000 ms. The expected
      // balance repeats that arithmetic in PostgreSQL, so it matches exactly.
      expect(outcome).toMatchObject({ changedUnderClaim: false, claimed: 3 });
      const refill = await pool.query<{ tokens: string; expected: string; refilled: boolean }>(
        `SELECT bucket.tokens::text,
                LEAST(5::numeric, 2 + GREATEST(
                  0::numeric, extract(epoch FROM bucket.refilled_at - charge.acquired_at) * 1000
                ) * 1::numeric / 60000::numeric)::text AS expected,
                bucket.refilled_at > charge.acquired_at AS refilled
           FROM workhorse.budget_bucket bucket,
                (SELECT max(runtime.acquired_at) AS acquired_at,
                        count(DISTINCT runtime.acquired_at) AS readings
                   FROM workhorse.task_runtime runtime
                  WHERE runtime.budget_name = $1 AND runtime.state = 'active') charge
          WHERE bucket.budget_name = $1 AND charge.readings = 1`,
        [outcome.budget],
      );
      expect(refill.rows).toEqual([
        { tokens: refill.rows[0]?.expected, expected: expect.any(String), refilled: true },
      ]);
    });

    it("waits for the claim before adding a rate limit", async () => {
      const outcome = await changeBudgetDuringCharge({ name: "", maxActive: 10 }, (budget) =>
        queue.syncBudgets("budget-sync", [
          { name: budget, maxActive: 10, rate: { limit: 1, intervalMs: 60_000, burst: 1 } },
        ]),
      );
      // The claim admitted without a rate, so it charged no bucket.
      expect(outcome).toMatchObject({ changedUnderClaim: false, claimed: 3, tokens: null });
    });

    it("waits for the claim before removing a rate limit", async () => {
      const outcome = await changeBudgetDuringCharge(
        { name: "", rate: { limit: 1, intervalMs: 60_000, burst: 5 } },
        (budget) => queue.syncBudgets("budget-sync", [{ name: budget, maxActive: 10 }]),
      );
      // The claim admitted against the rate, so it charged the bucket before the rate went away.
      expect(outcome).toMatchObject({ changedUnderClaim: false, claimed: 3, tokens: 2 });
    });

    it("waits for the claim before pruning a budget, and a recreated budget starts fresh", async () => {
      // The empty synchronization names no budget, so only the lock on the pruned name can make it
      // wait for the claim.
      const { budget, ...outcome } = await changeBudgetDuringCharge(
        { name: "", rate: { limit: 1, intervalMs: 60_000, burst: 5 } },
        () => queue.syncBudgets("budget-sync", []),
      );
      // The claim charged its bucket, then pruning deleted the budget and the bucket with it.
      expect(outcome).toEqual({ changedUnderClaim: false, claimed: 3, tokens: null });
      expect(await queue.listBudgets([budget])).toEqual([]);

      await queue.syncBudgets("budget-sync", [
        { name: budget, rate: { limit: 1, intervalMs: 60_000, burst: 1 } },
      ]);
      expect(await queue.listBudgets([budget])).toMatchObject([
        { name: budget, rate: { limit: 1, intervalMs: 60_000, burst: 1 } },
      ]);
      const bucket = await pool.query(
        "SELECT tokens FROM workhorse.budget_bucket WHERE budget_name = $1",
        [budget],
      );
      expect(bucket.rows).toEqual([]);
    });

    it("never deadlocks overlapping multi-budget synchronizations and claims", async () => {
      const suffix = randomUUID();
      const budgets = ["a", "b", "c"].map((letter) => `budget-overlap-${letter}-${suffix}`);
      const queues = [1, 2].map((ordinal) => `budget-overlap-queue-${ordinal}-${suffix}`);
      const define = (order: readonly number[], burst: number) =>
        order.map((index) => ({
          name: budgets[index]!,
          maxActive: 100,
          rate: { limit: 1_000, intervalMs: 1_000, burst },
        }));
      await queue.syncBudgets(`budget-overlap-${suffix}`, define([0, 1, 2], 100));
      await queue.syncRateLimitPolicies(
        `budget-overlap-${suffix}`,
        queues.map((name) => ({
          queue: name,
          rate: { limit: 1_000, intervalMs: 1_000, burst: 1_000 },
        })),
      );

      for (let round = 0; round < 12; round += 1) {
        await queue.enqueueMany(
          queues.flatMap((queueName) =>
            [0, 1, 2, 2, 1, 0].map((index) => ({
              type: "overlap",
              payload: { round },
              options: { queue: queueName, budget: budgets[index]! },
            })),
          ),
        );
        const settled = await Promise.allSettled([
          queue.claimMany("overlap-worker", 6, { queue: queues[0]! }),
          queue.syncBudgets(`budget-overlap-${suffix}`, define([2, 0, 1], 50 + round)),
          queue.claimMany("overlap-worker", 6, { queue: queues[1]! }),
          queue.syncBudgets(`budget-overlap-${suffix}`, define([1, 2, 0], 80 + round)),
        ]);
        expect(settled.filter((outcome) => outcome.status === "rejected")).toEqual([]);
      }
    });
  });
});
