import { expectOneRow } from "../errors.js";
import { logDebug, logInfo } from "../telemetry.js";
import type { WorkerPauseResult, WorkerRegistration, WorkerRegistryEntry } from "../types.js";
import { QueueModule } from "./module-context.js";

/** Owns worker registration, operator pause, fleet reads, and pruning behind the Queue facade. */
export class WorkerRegistryModule extends QueueModule {
  async registerWorker(registration: WorkerRegistration): Promise<{ paused: boolean }> {
    const result = await this.context.database.query<{ paused: boolean }>(
      `SELECT workhorse.register_worker_v1(
         $1::text, $2::uuid, $3::text, $4::integer, $5::text[], $6::integer,
         $7::integer, $8::integer, $9::integer, $10::integer, $11::integer,
         $12::integer, $13::integer, $14::boolean
       ) AS paused`,
      [
        registration.workerId,
        registration.instanceId,
        registration.hostname,
        registration.pid,
        registration.queues ?? [registration.queue ?? this.context.defaultQueue],
        registration.concurrency,
        registration.leaseMs ?? 30_000,
        registration.heartbeatMs ?? 10_000,
        registration.pollMs ?? 250,
        registration.maintenanceIntervalMs ?? 1_000,
        registration.maintenanceTaskPollMs ?? 60_000,
        registration.registryIntervalMs ?? 5_000,
        registration.activeSlots,
        registration.draining,
      ],
    );
    const paused = expectOneRow(result, "workhorse.register_worker_v1").paused;
    return { paused };
  }

  async deregisterWorker(workerId: string): Promise<boolean> {
    const result = await this.context.database.query<{ deregistered: boolean }>(
      "SELECT workhorse.deregister_worker_v1($1::text) AS deregistered",
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
    options: { requestedBy?: string; reason?: string } = {},
  ): Promise<WorkerPauseResult | null> {
    const result = await this.context.database.query<{
      worker_id: string;
      paused: boolean;
      paused_by: string | null;
      paused_reason: string | null;
      paused_at: Date | null;
      last_heartbeat_at: Date;
    }>("SELECT * FROM workhorse.set_worker_paused_v1($1::text, $2::boolean, $3::text, $4::text)", [
      workerId,
      paused,
      options.requestedBy ?? null,
      options.reason ?? null,
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
    }>(
      `SELECT worker_id, instance_id, hostname, pid, queue_names, queue_name, concurrency, active_slots, draining, paused, paused_by,
              paused_reason, paused_at, started_at, last_heartbeat_at
         FROM workhorse.worker_registry
        ORDER BY last_heartbeat_at DESC, worker_id`,
    );
    return result.rows.map((row) => ({
      workerId: row.worker_id,
      instanceId: row.instance_id,
      hostname: row.hostname,
      pid: row.pid,
      queues: row.queue_names,
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
      "SELECT workhorse.prune_worker_registry_v1(make_interval(secs => $1::double precision)) AS count",
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
