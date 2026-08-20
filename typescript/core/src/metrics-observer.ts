import { diag } from "@opentelemetry/api";
import { perQueueDepthSelect } from "./queue-depth.js";
import { lazyGauge } from "./telemetry.js";
import { EXTERNAL_WAIT_REJECTION_WINDOW_MS, type Queryable } from "./types.js";

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
const pendingExternalWaits = lazyGauge("workhorse.wait.pending", {
  description: "Current signal and human waits that still own a live suspension boundary",
  unit: "{wait}",
});
const overdueExternalWaits = lazyGauge("workhorse.wait.overdue", {
  description: "Current signal and human waits past their effective PostgreSQL timeout",
  unit: "{wait}",
});
const rejectedWaitDeliveries = lazyGauge("workhorse.wait.delivery.rejected", {
  description: "Rejected signal deliveries and human-wait completions in the trailing 24 hours",
  unit: "{delivery}",
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
  expired: string;
  overdue_deadlines: string;
  overdue_execution_timeouts: string;
  paused: boolean;
  pending_signal_waits: string;
  pending_human_waits: string;
  overdue_signal_waits: string;
  overdue_human_waits: string;
  rejected_signals: string;
  rejected_human_waits: string;
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
    const rejectedSince = new Date(Date.now() - EXTERNAL_WAIT_REJECTION_WINDOW_MS);
    const [queues, workers] = await Promise.all([
      this.database.query<QueueObservationRow>(
        `
        WITH queue_names AS (
          SELECT queue_name FROM workhorse.job_runtime
          UNION
          SELECT queue_name FROM workhorse.queue_control
        ), depth AS (
          ${perQueueDepthSelect(
            [
              "scheduled",
              "ready",
              "active",
              "oldest_ready_age_ms",
              "expired",
              "overdue_deadlines",
              "overdue_execution_timeouts",
            ],
            "queue_names",
          )}
        )
        SELECT depth.*, coalesce(control.paused, false) AS paused,
               waits.pending_signal_waits, waits.pending_human_waits,
               waits.overdue_signal_waits, waits.overdue_human_waits,
               waits.rejected_signals, waits.rejected_human_waits
          FROM depth
          LEFT JOIN workhorse.queue_control control USING (queue_name)
          CROSS JOIN LATERAL (
            SELECT
              (SELECT count(*)::text FROM (
                SELECT 1 FROM workhorse.job_signal_wait signal
                 JOIN workhorse.job_runtime runtime ON runtime.job_id = signal.job_id
                WHERE runtime.queue_name = depth.queue_name
                  AND runtime.state = 'scheduled' AND runtime.wait_name = signal.signal_name
                  AND runtime.current_attempt = signal.attempt AND signal.delivered_at IS NULL
                LIMIT 10001
              ) sampled) AS pending_signal_waits,
              (SELECT count(*)::text FROM (
                SELECT 1 FROM workhorse.job_human_wait human_wait
                 JOIN workhorse.job_runtime runtime ON runtime.job_id = human_wait.job_id
                WHERE runtime.queue_name = depth.queue_name
                  AND runtime.state = 'scheduled' AND runtime.wait_name = human_wait.token_name
                  AND runtime.current_attempt = human_wait.attempt
                  AND human_wait.completed_at IS NULL
                LIMIT 10001
              ) sampled) AS pending_human_waits,
              (SELECT count(*)::text FROM (
                SELECT 1 FROM workhorse.job_signal_wait signal
                 JOIN workhorse.job_runtime runtime ON runtime.job_id = signal.job_id
                WHERE runtime.queue_name = depth.queue_name
                  AND runtime.state = 'scheduled' AND runtime.wait_name = signal.signal_name
                  AND runtime.current_attempt = signal.attempt AND signal.delivered_at IS NULL
                  AND runtime.deadline_at <= clock_timestamp()
                LIMIT 10001
              ) sampled) AS overdue_signal_waits,
              (SELECT count(*)::text FROM (
                SELECT 1 FROM workhorse.job_human_wait human_wait
                 JOIN workhorse.job_runtime runtime ON runtime.job_id = human_wait.job_id
                WHERE runtime.queue_name = depth.queue_name
                  AND runtime.state = 'scheduled' AND runtime.wait_name = human_wait.token_name
                  AND runtime.current_attempt = human_wait.attempt
                  AND human_wait.completed_at IS NULL
                  AND runtime.deadline_at <= clock_timestamp()
                LIMIT 10001
              ) sampled) AS overdue_human_waits,
              (SELECT count(*)::text FROM (
                SELECT 1 FROM workhorse.job_event event
                 JOIN workhorse.job job ON job.id = event.job_id
                WHERE job.queue_name = depth.queue_name AND event.event_type = 'signal_rejected'
                  AND event.occurred_at >= $1::timestamptz
                LIMIT 10001
              ) sampled) AS rejected_signals,
              (SELECT count(*)::text FROM (
                SELECT 1 FROM workhorse.job_event event
                 JOIN workhorse.job job ON job.id = event.job_id
                WHERE job.queue_name = depth.queue_name
                  AND event.event_type = 'human_wait_rejected'
                  AND event.occurred_at >= $1::timestamptz
                LIMIT 10001
              ) sampled) AS rejected_human_waits
          ) waits
         ORDER BY depth.queue_name`,
        [rejectedSince],
      ),
      this.database.query<WorkerObservationRow>(`
        SELECT served.queue_name,
               CASE WHEN last_heartbeat_at < clock_timestamp() - interval '30 seconds'
                      THEN 'offline'
                    WHEN draining THEN 'draining'
                    WHEN paused THEN 'paused'
                    ELSE 'running' END AS state,
               count(*)::text AS workers,
               sum(concurrency)::text AS capacity,
               sum(active_slots)::text AS active_slots
          FROM workhorse.worker_registry registry
          CROSS JOIN LATERAL unnest(registry.queue_names) served(queue_name)
         GROUP BY served.queue_name, state
         ORDER BY served.queue_name, state`),
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
      expiredLeases.record(Number(row.expired), attributes);
      overdueDeadlines.record(Number(row.overdue_deadlines), attributes);
      overdueExecutionTimeouts.record(Number(row.overdue_execution_timeouts), attributes);
      for (const kind of ["signal", "human"] as const) {
        const waitAttributes = { ...attributes, "workhorse.wait.kind": kind };
        pendingExternalWaits.record(
          Number(kind === "signal" ? row.pending_signal_waits : row.pending_human_waits),
          waitAttributes,
        );
        overdueExternalWaits.record(
          Number(kind === "signal" ? row.overdue_signal_waits : row.overdue_human_waits),
          waitAttributes,
        );
        rejectedWaitDeliveries.record(
          Number(kind === "signal" ? row.rejected_signals : row.rejected_human_waits),
          waitAttributes,
        );
      }
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
