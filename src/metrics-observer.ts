import { diag } from "@opentelemetry/api";
import { lazyGauge } from "./telemetry.js";
import type { Queryable } from "./types.js";

// Every instrument here uses the lazy lifecycle selected by ADR 0024. A module-scope instrument
// created eagerly binds to whichever meter provider exists at import, so an application that
// installs its SDK after importing Workhorse would receive nothing.
const jobCount = lazyGauge("workhorse.jobs.count", {
  description: "Current live jobs by queue and runtime state",
  unit: "{job}",
});
const oldestReadyAge = lazyGauge("workhorse.queue.oldest_ready.age", {
  description: "Age of the oldest ready job",
  unit: "s",
});
const expiredLeases = lazyGauge("workhorse.lease.expired", {
  description: "Current active leases past their expiry time",
  unit: "{lease}",
});
const overdueDeadlines = lazyGauge("workhorse.deadline.overdue", {
  description: "Current live jobs past their absolute deadline",
  unit: "{job}",
});
const overdueExecutionTimeouts = lazyGauge("workhorse.execution_timeout.overdue", {
  description: "Current active attempts past their execution timeout",
  unit: "{attempt}",
});
const queuePaused = lazyGauge("workhorse.queue.paused", {
  description: "Whether dispatch is paused for a queue",
  unit: "1",
});
const workerCount = lazyGauge("workhorse.worker.count", {
  description: "Registered workers by queue and runtime state",
  unit: "{worker}",
});
const workerCapacity = lazyGauge("workhorse.worker.capacity", {
  description: "Declared worker execution slots",
  unit: "{slot}",
});
const workerActive = lazyGauge("workhorse.worker.active", {
  description: "Occupied worker execution slots",
  unit: "{slot}",
});

type QueueObservationRow = {
  queue_name: string;
  scheduled: string;
  ready: string;
  active: string;
  oldest_ready_age_ms: number | string | null;
  expired_leases: string;
  overdue_deadlines: string;
  overdue_execution_timeouts: string;
  paused: boolean;
};

type WorkerObservationRow = {
  queue_name: string;
  state: "draining" | "offline" | "paused" | "running";
  workers: string;
  capacity: string;
  active_slots: string;
};

/**
 * Explicit PostgreSQL observer for queue-wide state that cannot be counted safely by every worker.
 * Run one observer per database so multiple service instances do not duplicate the same gauges.
 */
export class WorkhorseMetricsObserver {
  private readonly intervalMs: number;
  private readonly onError: (error: unknown) => void;
  private timer: NodeJS.Timeout | undefined;
  private pending: Promise<void> | undefined;

  constructor(
    private readonly database: Queryable,
    options: { intervalMs?: number; onError?: (error: unknown) => void } = {},
  ) {
    this.intervalMs = options.intervalMs ?? 10_000;
    this.onError =
      options.onError ?? ((error) => diag.error("Workhorse metrics collection failed", error));
    if (!Number.isSafeInteger(this.intervalMs) || this.intervalMs < 1_000) {
      throw new RangeError("metrics intervalMs must be a safe integer of at least 1000");
    }
  }

  collect(): Promise<void> {
    if (this.pending) return this.pending;
    const pending = this.collectOnce().finally(() => {
      if (this.pending === pending) this.pending = undefined;
    });
    this.pending = pending;
    return pending;
  }

  start(): this {
    if (this.timer) return this;
    const collect = () => void this.collect().catch(this.onError);
    collect();
    this.timer = setInterval(collect, this.intervalMs);
    this.timer.unref();
    return this;
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  private async collectOnce(): Promise<void> {
    const [queues, workers] = await Promise.all([
      this.database.query<QueueObservationRow>(`
        WITH queue_names AS (
          SELECT queue_name FROM workhorse.job_runtime
          UNION
          SELECT queue_name FROM workhorse.queue_control
        ), runtime AS (
          SELECT queue_name,
                 count(*) FILTER (WHERE state = 'scheduled')::text AS scheduled,
                 count(*) FILTER (WHERE state = 'ready')::text AS ready,
                 count(*) FILTER (WHERE state = 'active')::text AS active,
                 extract(epoch FROM clock_timestamp() - min(ready_at)
                   FILTER (WHERE state = 'ready')) * 1000 AS oldest_ready_age_ms,
                 count(*) FILTER (
                   WHERE state = 'active' AND expires_at <= clock_timestamp()
                 )::text AS expired_leases,
                 count(*) FILTER (
                   WHERE deadline_at IS NOT NULL AND deadline_at <= clock_timestamp()
                 )::text AS overdue_deadlines,
                 count(*) FILTER (
                   WHERE state = 'active' AND attempt_timeout_at <= clock_timestamp()
                 )::text AS overdue_execution_timeouts
            FROM workhorse.job_runtime
           GROUP BY queue_name
        )
        SELECT queue_names.queue_name,
               coalesce(runtime.scheduled, '0') AS scheduled,
               coalesce(runtime.ready, '0') AS ready,
               coalesce(runtime.active, '0') AS active,
               runtime.oldest_ready_age_ms,
               coalesce(runtime.expired_leases, '0') AS expired_leases,
               coalesce(runtime.overdue_deadlines, '0') AS overdue_deadlines,
               coalesce(runtime.overdue_execution_timeouts, '0') AS overdue_execution_timeouts,
               coalesce(control.paused, false) AS paused
          FROM queue_names
          LEFT JOIN runtime USING (queue_name)
          LEFT JOIN workhorse.queue_control control USING (queue_name)
         ORDER BY queue_names.queue_name`),
      this.database.query<WorkerObservationRow>(`
        SELECT queue_name,
               CASE WHEN last_heartbeat_at < clock_timestamp() - interval '30 seconds'
                      THEN 'offline'
                    WHEN draining THEN 'draining'
                    WHEN paused THEN 'paused'
                    ELSE 'running' END AS state,
               count(*)::text AS workers,
               sum(concurrency)::text AS capacity,
               sum(active_slots)::text AS active_slots
          FROM workhorse.worker_registry
         GROUP BY queue_name, state
         ORDER BY queue_name, state`),
    ]);

    for (const row of queues.rows) {
      for (const state of ["scheduled", "ready", "active"] as const) {
        jobCount.record(Number(row[state]), {
          "workhorse.queue.name": row.queue_name,
          "workhorse.job.state": state,
        });
      }
      const attributes = { "workhorse.queue.name": row.queue_name };
      if (row.oldest_ready_age_ms !== null) {
        oldestReadyAge.record(Number(row.oldest_ready_age_ms) / 1_000, attributes);
      }
      expiredLeases.record(Number(row.expired_leases), attributes);
      overdueDeadlines.record(Number(row.overdue_deadlines), attributes);
      overdueExecutionTimeouts.record(Number(row.overdue_execution_timeouts), attributes);
      queuePaused.record(row.paused ? 1 : 0, attributes);
    }

    for (const row of workers.rows) {
      const attributes = {
        "workhorse.queue.name": row.queue_name,
        "workhorse.worker.state": row.state,
      };
      workerCount.record(Number(row.workers), attributes);
      workerCapacity.record(Number(row.capacity), attributes);
      workerActive.record(Number(row.active_slots), attributes);
    }
  }
}
