import { SQL_STATEMENTS } from "./queue/sql-catalogue.generated.js";
import { lazyGauge } from "./telemetry.js";
import { MAX_TIMER_DELAY_MS } from "./timers.js";
import { EXTERNAL_WAIT_REJECTION_WINDOW_MS, type Queryable } from "./types.js";

// Every instrument here uses the lazy lifecycle selected by ADR 0024. A module-scope instrument
// created eagerly binds to whichever meter provider exists at import, so an application that
// installs its SDK after importing Workhorse would receive nothing.
const taskCount = lazyGauge("workhorse.tasks.count", {
  description: "Current live tasks by queue and runtime state",
  unit: "{task}",
});
const oldestReadyAge = lazyGauge("workhorse.queue.oldest_ready.age", {
  description: "Age of the oldest ready task",
  unit: "s",
});
const expiredLeases = lazyGauge("workhorse.lease.expired", {
  description: "Current active leases past their expiry time",
  unit: "{lease}",
});
const overdueDeadlines = lazyGauge("workhorse.deadline.overdue", {
  description: "Current live tasks past their absolute deadline",
  unit: "{task}",
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

type Gauge = ReturnType<typeof lazyGauge>;
type GaugeAttributes = Record<string, string>;
type GaugeSeries = Map<Gauge, Map<string, GaugeAttributes>>;

function reporterFailed(failure: unknown): void {
  console.error("Workhorse metrics error reporter failed", failure);
}

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
  // Series the last collection recorded. A synchronous gauge exports its last value until something
  // records again, so a series PostgreSQL stops returning is recorded once more as zero.
  private recorded: GaugeSeries = new Map();

  constructor(
    private readonly database: Queryable,
    options: { intervalMs?: number; onError?: (error: unknown) => void } = {},
  ) {
    this.intervalMs = options.intervalMs ?? 10_000;
    this.onError =
      options.onError ?? ((error) => console.error("Workhorse metrics collection failed", error));
    // Node runs a setInterval delay above the timer maximum every millisecond.
    if (
      !Number.isSafeInteger(this.intervalMs) ||
      this.intervalMs < 1_000 ||
      this.intervalMs > MAX_TIMER_DELAY_MS
    ) {
      throw new RangeError(
        `metrics intervalMs must be a safe integer between 1000 and ${MAX_TIMER_DELAY_MS}`,
      );
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
    const collect = () => void this.collect().catch((error: unknown) => this.report(error));
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

  // The timer calls the reporter without awaiting it. A reporter that throws or rejects would
  // otherwise become an unhandled rejection, which ends a Node process under default settings.
  private report(error: unknown): void {
    try {
      // Promise.resolve also adopts a thenable or a promise from another realm.
      Promise.resolve(this.onError(error) as unknown).catch(reporterFailed);
    } catch (failure) {
      reporterFailed(failure);
    }
  }

  private async collectOnce(): Promise<void> {
    const rejectedSince = new Date(Date.now() - EXTERNAL_WAIT_REJECTION_WINDOW_MS);
    const [queues, workers] = await Promise.all([
      this.database.query<QueueObservationRow>(SQL_STATEMENTS["metrics_observer"], [rejectedSince]),
      this.database.query<WorkerObservationRow>(SQL_STATEMENTS["worker_registry"]),
    ]);
    const current: GaugeSeries = new Map();
    const record = (gauge: Gauge, value: number, attributes: GaugeAttributes) => {
      gauge.record(value, attributes);
      let series = current.get(gauge);
      if (!series) current.set(gauge, (series = new Map()));
      series.set(JSON.stringify(attributes), attributes);
    };

    for (const row of queues.rows) {
      for (const state of ["scheduled", "ready", "active"] as const) {
        record(taskCount, Number(row[state]), {
          "workhorse.queue.name": row.queue_name,
          "workhorse.task.state": state,
        });
      }
      const attributes = { "workhorse.queue.name": row.queue_name };
      // A queue with no ready task has no oldest ready age, so its alarm reads zero.
      record(
        oldestReadyAge,
        row.oldest_ready_age_ms === null ? 0 : Number(row.oldest_ready_age_ms) / 1_000,
        attributes,
      );
      record(expiredLeases, Number(row.expired), attributes);
      record(overdueDeadlines, Number(row.overdue_deadlines), attributes);
      record(overdueExecutionTimeouts, Number(row.overdue_execution_timeouts), attributes);
      for (const kind of ["signal", "human"] as const) {
        const waitAttributes = { ...attributes, "workhorse.wait.kind": kind };
        record(
          pendingExternalWaits,
          Number(kind === "signal" ? row.pending_signal_waits : row.pending_human_waits),
          waitAttributes,
        );
        record(
          overdueExternalWaits,
          Number(kind === "signal" ? row.overdue_signal_waits : row.overdue_human_waits),
          waitAttributes,
        );
        record(
          rejectedWaitDeliveries,
          Number(kind === "signal" ? row.rejected_signals : row.rejected_human_waits),
          waitAttributes,
        );
      }
      record(queuePaused, row.paused ? 1 : 0, attributes);
    }

    for (const row of workers.rows) {
      const attributes = {
        "workhorse.queue.name": row.queue_name,
        "workhorse.worker.state": row.state,
      };
      record(workerCount, Number(row.workers), attributes);
      record(workerCapacity, Number(row.capacity), attributes);
      record(workerActive, Number(row.active_slots), attributes);
    }

    for (const [gauge, series] of this.recorded) {
      const kept = current.get(gauge);
      for (const [key, attributes] of series) {
        if (!kept?.has(key)) gauge.record(0, attributes);
      }
    }
    this.recorded = current;
  }
}
