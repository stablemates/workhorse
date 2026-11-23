import { afterEach, describe, expect, it } from "vitest";
import { Worker } from "../src/index.js";
import { registerTelemetryProvider, type WorkhorseTelemetryProvider } from "../src/telemetry.js";
import { createIntegrationTestContext } from "./support/integration.js";

const { pool, queue, admin } = createIntegrationTestContext(import.meta.url);

interface Recorded {
  logs: string[];
  counters: string[];
  handlerOutcome: unknown;
  handlerErrors: number;
}

function recordTelemetry(): { recorded: Recorded; unregister: () => void } {
  const recorded: Recorded = {
    logs: [],
    counters: [],
    handlerOutcome: undefined,
    handlerErrors: 0,
  };
  const provider: WorkhorseTelemetryProvider = {
    emitLog: (log) => {
      recorded.logs.push(log.eventName);
    },
    createCounter: (name) => ({
      add() {
        recorded.counters.push(name);
      },
    }),
    createHistogram: () => ({ record() {} }),
    createGauge: () => ({ record() {} }),
    registerObservations: () => () => {},
    activeContext: () => undefined,
    injectTraceContext: () => null,
    extractTraceContext: () => undefined,
    withSpan: async (name, _attributes, operation) =>
      operation({
        setAttribute(key, value) {
          if (name === "workhorse.handler" && key === "workhorse.handler.outcome") {
            recorded.handlerOutcome = value;
          }
          return this;
        },
        setAttributes() {
          return this;
        },
        setStatus() {
          if (name === "workhorse.handler") recorded.handlerErrors += 1;
          return this;
        },
        recordException() {
          if (name === "workhorse.handler") recorded.handlerErrors += 1;
        },
      }),
  };
  return { recorded, unregister: registerTelemetryProvider(provider) };
}

// complete_v1 refuses the result. The worker reconciles the refusal through expire_owned_v1 and
// sends nothing to fail_v1, as the Python, Ruby, JVM, and .NET workers do.
describe("a refused completion", () => {
  let unregister: (() => void) | undefined;
  afterEach(() => unregister?.());

  it("retries an attempt whose attempt timeout is due, and counts the retry", async () => {
    const queueName = "refused-completion-timeout";
    const id = await queue.enqueue(
      "refused.completion",
      {},
      { queue: queueName, maxAttempts: 3, executionTimeoutMs: 3_600_000 },
    );
    const worker = new Worker(queue, {
      queue: queueName,
      registryIntervalMs: 0,
      maintenanceIntervalMs: 3_600_000,
      retryDelayMs: 60_000,
    }).handle("refused.completion", async (_payload, context) => {
      await pool.query(
        `UPDATE workhorse.task_runtime
            SET attempt_timeout_at = clock_timestamp() - interval '1 second'
          WHERE task_id = $1::uuid`,
        [context.task.id],
      );
      return { late: true };
    });
    const telemetry = recordTelemetry();
    unregister = telemetry.unregister;

    await expect(worker.runOnce()).resolves.toBe(true);

    await expect(admin.getTask(id)).resolves.toMatchObject({ currentAttempt: 2, result: null });
    expect(["ready", "scheduled"]).toContain((await admin.getTask(id))?.state);
    const history = await pool.query<{ outcome: string }>(
      "SELECT outcome FROM workhorse.attempt_history WHERE task_id = $1 ORDER BY attempt",
      [id],
    );
    expect(history.rows.map((row) => row.outcome)).toEqual(["timeout"]);
    expect(telemetry.recorded.logs).toContain("workhorse.task.completion_rejected");
    expect(telemetry.recorded.logs).toContain("workhorse.task.ownership_expired");
    expect(telemetry.recorded.logs).not.toContain("workhorse.task.failure_processed");
    expect(telemetry.recorded.logs).not.toContain("workhorse.task.cancellation_acknowledged");
    expect(telemetry.recorded.counters).toContain("workhorse.tasks.retried");
    expect(telemetry.recorded.counters).not.toContain("workhorse.tasks.failed");
    expect(telemetry.recorded.handlerOutcome).toBe("timeout_exceeded");
    expect(telemetry.recorded.handlerErrors).toBe(0);
  });

  it("leaves a lost lease to recovery and gives the span no error status", async () => {
    const queueName = "refused-completion-lost-lease";
    const id = await queue.enqueue("refused.completion", {}, { queue: queueName, maxAttempts: 3 });
    const worker = new Worker(queue, {
      queue: queueName,
      registryIntervalMs: 0,
      maintenanceIntervalMs: 3_600_000,
    }).handle("refused.completion", async (_payload, context) => {
      await pool.query(
        "UPDATE workhorse.task_runtime SET fence_token = fence_token + 1 WHERE task_id = $1::uuid",
        [context.task.id],
      );
      return { late: true };
    });
    const telemetry = recordTelemetry();
    unregister = telemetry.unregister;

    await expect(worker.runOnce()).resolves.toBe(true);

    await expect(admin.getTask(id)).resolves.toMatchObject({
      state: "active",
      currentAttempt: 1,
      result: null,
    });
    const history = await pool.query(
      "SELECT outcome FROM workhorse.attempt_history WHERE task_id = $1",
      [id],
    );
    expect(history.rows).toEqual([]);
    expect(telemetry.recorded.logs).toContain("workhorse.task.completion_rejected");
    expect(telemetry.recorded.logs).toContain("workhorse.task.ownership_expired");
    expect(telemetry.recorded.logs).not.toContain("workhorse.task.failure_processed");
    expect(telemetry.recorded.counters).not.toContain("workhorse.tasks.failed");
    expect(telemetry.recorded.handlerOutcome).toBe("stale");
    expect(telemetry.recorded.handlerErrors).toBe(0);
  });
});
