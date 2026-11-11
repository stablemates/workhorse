/**
 * The reconciliation pass restores the tier and the history settings of each demo queue.
 *
 * One piece of the demo integration suite. A visitor changes a queue through the demo's own
 * controllers, as the dashboard does, and the pass must put back the values the seed steps set.
 */
import { randomUUID } from "node:crypto";
import { Admin, Queue } from "@stablemates/workhorse";
import { describe, expect, it } from "vitest";
import { createLocalOperatorControllers } from "../src/app.js";
import {
  DEMO_FAST_QUEUE,
  DEMO_FAST_TIER_QUEUES,
  DEMO_PYTHON_FAST_QUEUE,
  DEMO_PYTHON_QUEUE,
} from "../src/constants.js";
import {
  reconcileDemoOperatorDefaults,
  reconciliationRestoredAnything,
} from "../src/operator-reconciler.js";
import { createDemoIntegrationSuite } from "./support/demo-integration.js";

const { database, pool } = createDemoIntegrationSuite(import.meta.url);

const seedAudit = {
  actor: "workhorse-demo-seed",
  reason: "Show the fast tier on the demo dashboard",
  requestId: "queue-tier-reconcile-seed",
};
/** The demo audit table keeps one row for each request ID, so each visitor action has its own. */
function visitorAudit() {
  return { actor: "visitor", reason: "trying the queue controls", requestId: randomUUID() };
}

/** Put the first fast-tier queues on the fast tier with their history, as the seed step does. */
async function seedFastTierQueues(): Promise<void> {
  const admin = new Admin(pool);
  for (const entry of DEMO_FAST_TIER_QUEUES.slice(0, 2)) {
    await admin.setQueueTier(entry.queue, "fast", seedAudit);
    await admin.setQueueHistory(entry.queue, entry.history);
  }
}

async function queueSettings(queueName: string) {
  const result = await pool.query<{
    tier: string;
    record_attempts: boolean;
    record_claims: boolean;
  }>(
    `SELECT tier, record_attempts, record_claims FROM workhorse.queue_control
      WHERE queue_name = $1`,
    [queueName],
  );
  const row = result.rows[0];
  return row
    ? { tier: row.tier, recordAttempts: row.record_attempts, recordClaims: row.record_claims }
    : undefined;
}

async function liveTaskCount(queueName: string): Promise<number> {
  const result = await pool.query<{ live: number }>(
    `SELECT ((SELECT count(*) FROM workhorse.task_runtime WHERE queue_name = $1)
           + (SELECT count(*) FROM workhorse.fast_task_runtime WHERE queue_name = $1))::integer
           AS live`,
    [queueName],
  );
  return result.rows[0]?.live ?? 0;
}

describe("demo queue tier and history reconciliation", () => {
  it("restores the seeded history and tier that a visitor changed through the dashboard", async () => {
    await seedFastTierQueues();
    const { queueController } = createLocalOperatorControllers(database);

    await queueController.setQueueHistory(
      DEMO_FAST_QUEUE,
      { recordAttempts: false, recordClaims: false },
      visitorAudit(),
    );
    await expect(
      queueController.setQueueTier(DEMO_PYTHON_QUEUE, "fast", visitorAudit()),
    ).resolves.toEqual({ status: "set", tier: "fast" });
    await expect(
      queueController.setQueueTier(DEMO_PYTHON_FAST_QUEUE, "full", visitorAudit()),
    ).resolves.toEqual({ status: "set", tier: "full" });

    const reconciliation = await reconcileDemoOperatorDefaults(pool);

    expect(reconciliation.restoredQueueHistory).toEqual([DEMO_FAST_QUEUE]);
    expect(reconciliation.restoredQueueTiers).toEqual([DEMO_PYTHON_QUEUE, DEMO_PYTHON_FAST_QUEUE]);
    expect(reconciliation.deferredQueueTiers).toEqual([]);
    await expect(queueSettings(DEMO_FAST_QUEUE)).resolves.toEqual({
      tier: "fast",
      recordAttempts: true,
      recordClaims: true,
    });
    await expect(queueSettings(DEMO_PYTHON_FAST_QUEUE)).resolves.toEqual({
      tier: "fast",
      recordAttempts: false,
      recordClaims: true,
    });
    await expect(queueSettings(DEMO_PYTHON_QUEUE)).resolves.toMatchObject({ tier: "full" });

    const second = await reconcileDemoOperatorDefaults(pool);
    expect(reconciliationRestoredAnything(second)).toBe(false);
  });

  it("purges the ready and scheduled tasks of a demo queue to restore its tier", async () => {
    await seedFastTierQueues();
    const { queueController } = createLocalOperatorControllers(database);
    await queueController.setQueueTier(DEMO_FAST_QUEUE, "full", visitorAudit());
    const queue = new Queue(pool, DEMO_FAST_QUEUE);
    await queue.enqueue("demo.reconcile-ready", {});
    await queue.enqueue("demo.reconcile-scheduled", {}, { runAt: new Date(Date.now() + 60_000) });
    // Workhorse refuses the change while the queue holds these tasks.
    await expect(
      queueController.setQueueTier(DEMO_FAST_QUEUE, "fast", visitorAudit()),
    ).resolves.toEqual({ status: "live_tasks", tier: null });

    const reconciliation = await reconcileDemoOperatorDefaults(pool);

    expect(reconciliation.restoredQueueTiers).toEqual([DEMO_FAST_QUEUE]);
    expect(reconciliation.deferredQueueTiers).toEqual([]);
    await expect(liveTaskCount(DEMO_FAST_QUEUE)).resolves.toBe(0);
    await expect(queueSettings(DEMO_FAST_QUEUE)).resolves.toMatchObject({ tier: "fast" });
  });

  it("leaves a tier to the next pass while an active task blocks the change", async () => {
    await seedFastTierQueues();
    const { queueController } = createLocalOperatorControllers(database);
    await queueController.setQueueTier(DEMO_FAST_QUEUE, "full", visitorAudit());
    await queueController.setQueueHistory(
      DEMO_FAST_QUEUE,
      { recordAttempts: false, recordClaims: false },
      visitorAudit(),
    );
    const queue = new Queue(pool, DEMO_FAST_QUEUE);
    await queue.enqueue("demo.reconcile-active", {});
    const claimed = await queue.claim("reconcile-test-worker", { queue: DEMO_FAST_QUEUE });
    if (!claimed) throw new Error("Expected the test task to be claimable");

    const blocked = await reconcileDemoOperatorDefaults(pool);

    expect(blocked.restoredQueueTiers).toEqual([]);
    expect(blocked.restoredQueueHistory).toEqual([DEMO_FAST_QUEUE]);
    expect(blocked.deferredQueueTiers).toEqual([DEMO_FAST_QUEUE]);
    expect(reconciliationRestoredAnything(blocked)).toBe(true);
    await expect(queueSettings(DEMO_FAST_QUEUE)).resolves.toMatchObject({ tier: "full" });
    // The pass still restores the history of the same queue.
    await expect(queueSettings(DEMO_FAST_QUEUE)).resolves.toMatchObject({
      recordAttempts: true,
      recordClaims: true,
    });

    await queue.complete(claimed, "reconcile-test-worker", { done: true });
    const next = await reconcileDemoOperatorDefaults(pool);

    expect(next.restoredQueueTiers).toEqual([DEMO_FAST_QUEUE]);
    expect(next.deferredQueueTiers).toEqual([]);
    await expect(queueSettings(DEMO_FAST_QUEUE)).resolves.toMatchObject({ tier: "fast" });
  });
});
