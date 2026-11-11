import { Admin, Queue, type Queryable } from "../../../core/src/index.js";
import { createDashboardHost } from "../../src/server/host.js";
import { createDashboardOperatorControllers } from "../../src/server/operator-controllers.js";
import type {
  DashboardScheduleController,
  DashboardSettingsController,
} from "../../src/server/types.js";
import type {
  DashboardConformanceHarness,
  DashboardConformanceTransport,
} from "../../../../scripts/verify-dashboard-conformance.js";

/**
 * Bind the reference TypeScript dashboard server to the conformance fixtures' harness contract.
 *
 * The fixtures pin server-assigned values, so every backend under test must present the same
 * harness: answer only to the host of `harness.origin`, authorize every request as
 * `harness.authenticatedActor`, report `harness.environment`, and expose a writable deployment
 * whose controllers execute through the shared versioned SQL surface — plus a second, read-only deployment of the same backend. The `enqueueTest` operator
 * and `setSchedulePaused` controller have no shared SQL function; the harness supplies the
 * minimal implementations the fixtures assume (enqueue one `conformance.demo-{kind}` task on the
 * `conformance-demo` queue; set `workhorse.schedule_definition.paused`).
 */
/** The column name of a policy setting, as the embedded hosts derive it. */
function snake(name: string): string {
  return name.replaceAll(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

export function createDashboardConformanceTransport(
  database: Queryable,
  harness: DashboardConformanceHarness,
): DashboardConformanceTransport {
  const queue = new Queue(database);
  const admin = new Admin(database);
  const controllers = createDashboardOperatorControllers({
    run: (_action, operation) => operation({ admin, queue }),
  });
  // The embedded hosts call the audited SQL functions, so the reference controller does too. The
  // router puts the authenticated actor into the audit.
  const settingsController: DashboardSettingsController = {
    async overrideMaintenancePolicy(definition, audit) {
      await database.query(
        `SELECT (policy).* FROM workhorse.override_maintenance_policy_v2(
           $1::text, $2::integer, $3::integer, $4::time, $5::integer, $6::integer, $7::integer,
           $8::text, $9::text, $10::text) policy`,
        [
          definition.timezone ?? null,
          definition.partitionPreparationIntervalMs ?? null,
          definition.terminalCleanupIntervalMs ?? null,
          definition.historyRetentionLocalTime ?? null,
          definition.statisticsRollupIntervalMs ?? null,
          definition.statisticsGroupLimit ?? null,
          definition.statisticsRecomputeBuckets ?? null,
          audit.actor,
          audit.reason,
          audit.requestId,
        ],
      );
    },
    async revertMaintenancePolicy(settings, audit) {
      await database.query(
        "SELECT (policy).* FROM workhorse.revert_maintenance_policy_v2($1::text[], $2, $3, $4) policy",
        [settings.map(snake), audit.actor, audit.reason, audit.requestId],
      );
    },
    async overrideRetentionPolicy(definition, audit) {
      await database.query(
        "SELECT (policy).* FROM workhorse.override_retention_policy_v2($1::jsonb, $2, $3, $4) policy",
        [
          JSON.stringify(
            Object.fromEntries(
              Object.entries(definition).map(([key, value]) => [snake(key), value]),
            ),
          ),
          audit.actor,
          audit.reason,
          audit.requestId,
        ],
      );
    },
    async revertRetentionPolicy(settings, audit) {
      await database.query(
        "SELECT (policy).* FROM workhorse.revert_retention_policy_v2($1::text[], $2, $3, $4) policy",
        [settings.map(snake), audit.actor, audit.reason, audit.requestId],
      );
    },
  };
  const scheduleController: DashboardScheduleController = {
    async setSchedulePaused(namespace, name, paused, audit) {
      const result = await database.query<{ paused: boolean }>(
        `SELECT workhorse.set_schedule_paused_v1(
           $1::text, $2::text, $3::boolean, $4::text, $5::text, $6::timestamptz
         ) AS paused`,
        [namespace, name, paused, audit.actor, audit.reason, audit.occurredAt],
      );
      const updated = result.rows[0];
      if (!updated) throw new Error(`Schedule ${namespace}/${name} not found`);
      return { paused: updated.paused };
    },
  };

  const shared = {
    database,
    path: harness.basePath,
    environment: harness.environment,
    configuredWorkers: harness.configuredWorkers,
    maintenanceLoops: harness.maintenanceLoops,
    statementTimeoutMs: harness.statementTimeoutMs,
    authorize: () => ({ actor: harness.authenticatedActor }),
    allowedHosts: [new URL(harness.origin).host],
  };
  const writable = createDashboardHost({
    ...shared,
    ...controllers,
    operator: {
      mode: "writable",
      enqueueTest: async (kind) => ({
        taskId: await queue.enqueue(`conformance.demo-${kind}`, {}, { queue: "conformance-demo" }),
      }),
    },
    scheduleController,
    settingsController,
  });
  const readOnly = createDashboardHost({ ...shared, operator: { mode: "read-only" } });
  const redacting = createDashboardHost({
    ...shared,
    ...controllers,
    operator: { mode: "writable" },
    redactErrorStacks: true,
  });
  const hosts = { writable, "read-only": readOnly, "redact-error-stacks": redacting };

  return { handle: (mode, request) => hosts[mode].handle(request) };
}
