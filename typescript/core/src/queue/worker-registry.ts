import { PROTOCOL_VERSION, SQL_STATEMENTS } from "./sql-catalogue.generated.js";
import { expectOneRow } from "../errors.js";
import { logDebug, logInfo } from "../telemetry.js";
import { WORKHORSE_VERSION } from "../version.js";
import type { WorkerPauseResult, WorkerRegistration, WorkerRegistryEntry } from "../types.js";
import { QueueModule } from "./module-context.js";

/** What this client library is, reported to the registry on every registration refresh. */
const SDK_LANGUAGE = "typescript";

/** Owns worker registration, operator pause, fleet reads, and pruning behind the Queue facade. */
export class WorkerRegistryModule extends QueueModule {
  /**
   * Announce this worker and read back the operator pause flag.
   *
   * The client protocol version and SDK identity are this library's own facts rather than
   * registration input, so they are stamped here and no caller can misreport them. An operator
   * reads them to decide whether any worker still speaks a protocol they are about to retire, and
   * a wrong answer there stops a fleet.
   */
  async registerWorker(registration: WorkerRegistration): Promise<{ paused: boolean }> {
    const result = await this.context.database.query<{ paused: boolean }>(
      SQL_STATEMENTS["register_worker_v1"],
      [
        registration.workerId,
        registration.instanceId,
        registration.hostname,
        registration.pid,
        registration.queues ?? [registration.queue ?? this.context.defaultQueue],
        registration.scheduleNamespaces ?? [],
        registration.concurrency,
        registration.leaseMs ?? 30_000,
        registration.heartbeatMs ?? 10_000,
        registration.pollMs ?? 250,
        registration.maintenanceIntervalMs ?? 1_000,
        registration.maintenanceTaskPollMs ?? 60_000,
        registration.registryIntervalMs ?? 5_000,
        registration.activeSlots,
        registration.draining,
        PROTOCOL_VERSION,
        SDK_LANGUAGE,
        WORKHORSE_VERSION,
      ],
    );
    const paused = expectOneRow(result, "workhorse.register_worker_v1").paused;
    return { paused };
  }

  async deregisterWorker(workerId: string): Promise<boolean> {
    const result = await this.context.database.query<{ deregistered: boolean }>(
      SQL_STATEMENTS["deregister_worker_v1"],
      [workerId],
    );
    const deregistered = expectOneRow(result, "workhorse.deregister_worker_v1").deregistered;
    logDebug("workhorse.worker.deregistered", "Worker deregistered", {
      "workhorse.worker.id": workerId,
      "workhorse.worker.deregistered": deregistered,
    });
    return deregistered;
  }

  async setWorkerPaused(
    workerId: string,
    paused: boolean,
    options: { requestedBy: string; reason: string; requestId: string },
  ): Promise<WorkerPauseResult | null> {
    const result = await this.context.database.query<{
      worker_id: string;
      paused: boolean;
      paused_by: string | null;
      paused_reason: string | null;
      paused_at: Date | null;
      last_heartbeat_at: Date;
    }>(SQL_STATEMENTS["set_worker_paused_v1"], [
      workerId,
      paused,
      options.requestedBy,
      options.reason,
      options.requestId,
    ]);
    const row = result.rows[0];
    if (!row) return null;
    logInfo(
      paused ? "workhorse.worker.paused" : "workhorse.worker.resumed",
      paused ? "Worker paused" : "Worker resumed",
      { "workhorse.worker.id": workerId },
    );
    return {
      workerId: row.worker_id,
      paused: row.paused,
      pausedBy: row.paused_by,
      reason: row.paused_reason,
      pausedAt: row.paused_at,
      lastHeartbeatAt: row.last_heartbeat_at,
    };
  }

  async listWorkers(): Promise<WorkerRegistryEntry[]> {
    const result = await this.context.database.query<{
      worker_id: string;
      instance_id: string;
      hostname: string;
      pid: number;
      queue_names: string[];
      schedule_namespaces: string[];
      queue_name: string;
      concurrency: number;
      active_slots: number;
      draining: boolean;
      paused: boolean;
      paused_by: string | null;
      paused_reason: string | null;
      paused_at: Date | null;
      started_at: Date;
      last_heartbeat_at: Date;
    }>(SQL_STATEMENTS["worker_registry__worker_registry"]);
    return result.rows.map((row) => ({
      workerId: row.worker_id,
      instanceId: row.instance_id,
      hostname: row.hostname,
      pid: row.pid,
      queues: row.queue_names,
      scheduleNamespaces: row.schedule_namespaces,
      queue: row.queue_name,
      concurrency: row.concurrency,
      activeSlots: row.active_slots,
      draining: row.draining,
      paused: row.paused,
      pausedBy: row.paused_by,
      reason: row.paused_reason,
      pausedAt: row.paused_at,
      startedAt: row.started_at,
      lastHeartbeatAt: row.last_heartbeat_at,
    }));
  }

  async pruneWorkerRegistry(maxAgeMs: number): Promise<number> {
    const result = await this.context.database.query<{ count: number }>(
      SQL_STATEMENTS["prune_worker_registry_v1"],
      [maxAgeMs / 1_000],
    );
    const count = expectOneRow(result, "workhorse.prune_worker_registry_v1").count;
    const attributes = { "workhorse.worker.count": count };
    if (count > 0) {
      logInfo("workhorse.worker_registry.pruned", "Stale worker registrations pruned", attributes);
    } else {
      logDebug(
        "workhorse.worker_registry.pruned",
        "No stale worker registrations found",
        attributes,
      );
    }
    return count;
  }
}
