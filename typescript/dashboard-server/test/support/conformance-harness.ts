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
 * harness: authorize every request as `harness.authenticatedActor`, report `harness.environment`,
 * and expose a writable deployment whose controllers execute through the shared versioned SQL
 * surface — plus a second, read-only deployment of the same backend. The `enqueueTest` operator
 * and `setSchedulePaused` controller have no shared SQL function; the harness supplies the
 * minimal implementations the fixtures assume (enqueue one `conformance.demo-{kind}` task on the
 * `conformance-demo` queue; set `workhorse.schedule_definition.paused`).
 */
export function createDashboardConformanceTransport(
  database: Queryable,
  harness: DashboardConformanceHarness,
): DashboardConformanceTransport {
  const queue = new Queue(database);
  const admin = new Admin(database);
  const controllers = createDashboardOperatorControllers({
    run: (_action, operation) => operation({ admin, queue }),
  });
  const settingsController: DashboardSettingsController = {
    async overrideMaintenancePolicy(definition) {
      await queue.overrideMaintenancePolicy(definition);
    },
    async revertMaintenancePolicy(settings) {
      await queue.revertMaintenancePolicy(settings);
    },
    async overrideRetentionPolicy(definition) {
      await queue.overrideRetentionPolicy(definition);
    },
    async revertRetentionPolicy(settings) {
      await queue.revertRetentionPolicy(settings);
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
    authorize: () => ({ actor: harness.authenticatedActor }),
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

  return {
    handle: (mode, request) => (mode === "writable" ? writable : readOnly).handle(request),
  };
}
