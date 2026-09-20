import {
  Admin,
  Queue,
  type MaintenancePolicySetting,
  type RetentionPolicySetting,
} from "@stablemates/workhorse";
import type { Pool } from "pg";
import { DEMO_QUEUE } from "./constants.js";

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
}

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
  };
}

/** Report whether a pass changed anything, so a quiet demo logs nothing. */
export function reconciliationRestoredAnything(
  reconciliation: DemoOperatorReconciliation,
): boolean {
  return (
    reconciliation.resumedWorkers.length > 0 ||
    reconciliation.resumedQueues.length > 0 ||
    reconciliation.resumedSchedules.length > 0 ||
    reconciliation.revertedRetentionSettings.length > 0 ||
    reconciliation.revertedMaintenanceSettings.length > 0
  );
}
