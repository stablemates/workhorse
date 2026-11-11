import { randomUUID } from "node:crypto";
import {
  Admin,
  FastTierUnsupportedError,
  Queue,
  type MaintenancePolicySetting,
  type QueueHistorySettings,
  type QueueTier,
  type RetentionPolicySetting,
} from "@stablemates/workhorse";
import type { Pool } from "pg";
import {
  DEMO_DOTNET_FAST_TIER_QUEUE,
  DEMO_FAST_TIER_QUEUES,
  DEMO_JVM_FAST_TIER_QUEUE,
  DEMO_QUEUE,
  DEMO_RUBY_FAST_TIER_QUEUE,
  DEMO_RUST_FAST_TIER_QUEUE,
} from "./constants.js";

/**
 * How long a public operator mutation stays in effect before the demo restores its default.
 *
 * The demo's operator surface is unauthenticated, so any visitor can pause a worker, pause a
 * queue, pause a schedule, or widen retention, and every later visitor would otherwise arrive at
 * a dashboard someone else stopped. The interval is long enough that an operator action is worth
 * performing and observing, and short enough that an unattended demo repairs itself.
 */
export const DEMO_OPERATOR_RECONCILE_INTERVAL_MS = 15 * 60_000;

const RECONCILE_ACTOR = "demo-reconciler";
const RECONCILE_REASON = "Restoring the public demo's default operator state";

/** What one reconciliation pass restored, named so the log says which default drifted. */
export interface DemoOperatorReconciliation {
  resumedWorkers: string[];
  resumedQueues: string[];
  resumedSchedules: string[];
  revertedRetentionSettings: RetentionPolicySetting[];
  revertedMaintenanceSettings: MaintenancePolicySetting[];
  /** Queues whose history settings the pass set back to the seeded values. */
  restoredQueueHistory: string[];
  /** Queues whose tier the pass set back to the seeded tier. */
  restoredQueueTiers: string[];
  /** Queues whose tier change Workhorse refused, for example for an active task. The next pass tries again. */
  deferredQueueTiers: string[];
}

interface DemoQueueIntent extends QueueHistorySettings {
  tier: QueueTier;
}

/** The seed steps put these queues on the fast tier, each with its own history settings. */
const DEMO_FAST_TIER_INTENTS: ReadonlyMap<string, DemoQueueIntent> = new Map(
  [
    ...DEMO_FAST_TIER_QUEUES,
    DEMO_RUST_FAST_TIER_QUEUE,
    DEMO_RUBY_FAST_TIER_QUEUE,
    DEMO_JVM_FAST_TIER_QUEUE,
    DEMO_DOTNET_FAST_TIER_QUEUE,
  ].map(({ queue, history }) => [queue, { tier: "fast", ...history }]),
);

/** Every other demo queue stays on the full tier with the default history settings. */
const DEMO_FULL_TIER_INTENT: DemoQueueIntent = {
  tier: "full",
  recordAttempts: false,
  recordClaims: false,
};

function audit(requestId: string) {
  return { actor: RECONCILE_ACTOR, reason: RECONCILE_REASON, requestId };
}

/**
 * Restore every default a public operator mutation can move away from, and report what moved.
 *
 * The pass reads current state and acts only on drift, so a demo nobody touched writes nothing.
 * Each correction goes through the same Admin and Queue calls the dashboard uses, which keeps the
 * restoration in the audit trail and the telemetry alongside the mutation it undoes.
 *
 * Retention and maintenance values carry provenance, so the pass reverts exactly the settings an
 * operator overrode and leaves the application's own values alone.
 */
export async function reconcileDemoOperatorDefaults(
  pool: Pool,
): Promise<DemoOperatorReconciliation> {
  const admin = new Admin(pool, DEMO_QUEUE);
  const queue = new Queue(pool, DEMO_QUEUE);

  const workers = await admin.listWorkers();
  const resumedWorkers: string[] = [];
  for (const worker of workers) {
    if (!worker.paused) continue;
    await admin.setWorkerPaused(
      worker.workerId,
      false,
      audit(`reconcile-worker-${worker.workerId}`),
    );
    resumedWorkers.push(worker.workerId);
  }

  const pausedQueues = await pool.query<{ queue_name: string }>(
    "SELECT queue_name FROM workhorse.queue_control WHERE paused ORDER BY queue_name",
  );
  const resumedQueues: string[] = [];
  for (const row of pausedQueues.rows) {
    await admin.resumeQueue(row.queue_name, audit(`reconcile-queue-${row.queue_name}`));
    resumedQueues.push(row.queue_name);
  }

  // A schedule pause lives beside the definition rather than inside it, so synchronizing the
  // demo's schedules does not clear it. The pass resumes every paused schedule in the database
  // because the demo owns all of them.
  const pausedSchedules = await pool.query<{ namespace: string; schedule_name: string }>(
    `SELECT namespace, schedule_name
       FROM workhorse.schedule_definition
      WHERE paused
      ORDER BY namespace, schedule_name`,
  );
  const resumedSchedules: string[] = [];
  for (const row of pausedSchedules.rows) {
    await pool.query(
      "SELECT workhorse.set_schedule_paused_v1($1::text, $2::text, false, $3::text, $4::text)",
      [row.namespace, row.schedule_name, RECONCILE_ACTOR, RECONCILE_REASON],
    );
    resumedSchedules.push(`${row.namespace}/${row.schedule_name}`);
  }

  const retention = await queue.getRetentionPolicy();
  const revertedRetentionSettings = (
    Object.keys(retention.provenance) as RetentionPolicySetting[]
  ).filter((setting) => retention.provenance[setting].source === "operator");
  if (revertedRetentionSettings.length > 0) {
    await queue.revertRetentionPolicy(revertedRetentionSettings);
  }

  const queueSettings = await restoreDemoQueueSettings(pool, admin);

  const maintenance = await queue.getMaintenancePolicy();
  const revertedMaintenanceSettings = (
    Object.keys(maintenance.provenance) as MaintenancePolicySetting[]
  ).filter((setting) => maintenance.provenance[setting].source === "operator");
  if (revertedMaintenanceSettings.length > 0) {
    await queue.revertMaintenancePolicy(revertedMaintenanceSettings);
  }

  return {
    resumedWorkers,
    resumedQueues,
    resumedSchedules,
    revertedRetentionSettings,
    revertedMaintenanceSettings,
    ...queueSettings,
  };
}

/**
 * Set the tier and the history settings of each demo queue back to the values the seed steps set.
 *
 * Only a queue with a `queue_control` row can differ from its seeded values, because a visitor's
 * change writes that row. A fast-tier queue without a row is a queue whose seed step did not run
 * yet, so the pass leaves it to that step.
 *
 * Workhorse refuses a tier change while the queue holds a live task. The pass then purges the
 * blocked, ready, and scheduled tasks of the queue, which are demo data, and tries again. If an
 * active or waiting task still blocks the change, the queue is in `deferredQueueTiers` and the next
 * pass tries again.
 */
async function restoreDemoQueueSettings(
  pool: Pool,
  admin: Admin,
): Promise<
  Pick<
    DemoOperatorReconciliation,
    "restoredQueueHistory" | "restoredQueueTiers" | "deferredQueueTiers"
  >
> {
  const rows = await pool.query<{
    queue_name: string;
    tier: QueueTier;
    record_attempts: boolean;
    record_claims: boolean;
  }>(
    `SELECT queue_name, tier, record_attempts, record_claims
       FROM workhorse.queue_control
      ORDER BY queue_name`,
  );
  const restoredQueueHistory: string[] = [];
  const restoredQueueTiers: string[] = [];
  const deferredQueueTiers: string[] = [];
  for (const row of rows.rows) {
    const intent = DEMO_FAST_TIER_INTENTS.get(row.queue_name) ?? DEMO_FULL_TIER_INTENT;
    if (row.tier !== intent.tier) {
      const restored = await restoreQueueTier(admin, row.queue_name, intent.tier);
      (restored ? restoredQueueTiers : deferredQueueTiers).push(row.queue_name);
    }
    if (
      row.record_attempts !== intent.recordAttempts ||
      row.record_claims !== intent.recordClaims
    ) {
      await admin.setQueueHistory(row.queue_name, {
        recordAttempts: intent.recordAttempts,
        recordClaims: intent.recordClaims,
      });
      restoredQueueHistory.push(row.queue_name);
    }
  }
  return { restoredQueueHistory, restoredQueueTiers, deferredQueueTiers };
}

/** Move one queue to its seeded tier, and report whether Workhorse accepted the change. */
async function restoreQueueTier(
  admin: Admin,
  queueName: string,
  tier: QueueTier,
): Promise<boolean> {
  const tierAudit = audit(`reconcile-tier-${queueName}-${randomUUID()}`);
  try {
    await admin.setQueueTier(queueName, tier, tierAudit);
    return true;
  } catch (error) {
    if (!(error instanceof FastTierUnsupportedError)) throw error;
    // A concurrency or a rate-limit policy blocks a move to the fast tier, and a purge cannot help.
    if (error.feature !== "tier change") return false;
  }
  // Each purge has its own request ID, so Workhorse does not replay an earlier purge.
  await admin.purgeQueue(queueName, audit(`reconcile-purge-${queueName}-${randomUUID()}`));
  try {
    await admin.setQueueTier(queueName, tier, tierAudit);
    return true;
  } catch (error) {
    if (error instanceof FastTierUnsupportedError) return false;
    throw error;
  }
}

/**
 * Report whether a pass changed anything or left a tier to the next pass, so a quiet demo logs
 * nothing.
 */
export function reconciliationRestoredAnything(
  reconciliation: DemoOperatorReconciliation,
): boolean {
  return (
    reconciliation.resumedWorkers.length > 0 ||
    reconciliation.resumedQueues.length > 0 ||
    reconciliation.resumedSchedules.length > 0 ||
    reconciliation.revertedRetentionSettings.length > 0 ||
    reconciliation.revertedMaintenanceSettings.length > 0 ||
    reconciliation.restoredQueueHistory.length > 0 ||
    reconciliation.restoredQueueTiers.length > 0 ||
    reconciliation.deferredQueueTiers.length > 0
  );
}
