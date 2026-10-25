import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import type { MaintenancePhaseResult } from "../src/queue/retention-maintenance.js";
import { registerTelemetryProvider, type WorkhorseTelemetryProvider } from "../src/telemetry.js";
import { Worker, type WorkerOptions, type WorkerQueueApi } from "../src/worker.js";

// SM-1655: onRegistrationError, onNotificationError and onMaintenance observe the worker. A throw
// or a rejected promise from one of them must not stop the run, and the report of such a failure
// is bounded. SM-1726: the report is the catalogued workhorse.worker.reporter_failed record.

const tickPhase: MaintenancePhaseResult = {
  phase: "promote",
  rowsAffected: 0,
  durationMs: 1,
  skippedLock: false,
  error: null,
};

interface ReporterQueueOptions {
  // Answers of registerWorker in order. After the list ends, every registration fails.
  registrations?: Array<{ paused: boolean }>;
}

function reporterQueue(behavior: ReporterQueueOptions = {}) {
  const counts = { claims: 0, registrations: 0, ticks: 0, schedulePasses: 0 };
  const registrations = [...(behavior.registrations ?? [])];
  const notificationErrors: Array<(error: unknown) => void> = [];
  const queue = {
    defaultQueue: "reporter",
    claim: async () => null,
    claimMany: async () => {
      counts.claims += 1;
      return [];
    },
    complete: async () => true,
    fail: async () => "failed",
    heartbeatStatus: async () => "accepted",
    tick: async () => {
      counts.ticks += 1;
      return [tickPhase];
    },
    runMaintenance: async () => [],
    fireDueSchedules: async () => {
      counts.schedulePasses += 1;
      return [];
    },
    registerWorker: async () => {
      counts.registrations += 1;
      const answer = registrations.shift();
      if (answer !== undefined) return answer;
      throw new Error("registry offline");
    },
    deregisterWorker: async () => undefined,
    subscribeToTaskNotifications: async (
      _queueName: string,
      _wake: () => void,
      onError: (error: unknown) => void,
    ) => {
      notificationErrors.push(onError);
      return { close: async () => undefined };
    },
  } as unknown as WorkerQueueApi;
  return { queue, counts, notificationErrors };
}

const workerId = "reporter-worker";

const options: WorkerOptions = {
  workerId,
  queue: "reporter",
  pollMs: 5,
  maintenanceIntervalMs: 100,
  registryIntervalMs: 100,
  scheduleNamespaces: ["reporter"],
};

type Reporter = (value: unknown) => unknown;

const failures: Record<string, () => Reporter> = {
  "a synchronous throw": () => () => {
    throw new Error("alert client offline");
  },
  "a rejected promise": () => () => Promise.reject(new Error("alert client offline")),
  "a rejected thenable": () => () => ({
    // oxlint-disable-next-line unicorn/no-thenable -- the test needs a thenable that is no promise.
    then(_resolve: unknown, reject: (reason: unknown) => void) {
      reject(new Error("alert client offline"));
    },
  }),
};

type LogRecord = Parameters<WorkhorseTelemetryProvider["emitLog"]>[0];

// A telemetry provider that keeps each workhorse.worker.reporter_failed record.
function recordReporterFailures(): { records: LogRecord[]; unregister: () => void } {
  const records: LogRecord[] = [];
  const unregister = registerTelemetryProvider({
    emitLog(record) {
      if (record.eventName === "workhorse.worker.reporter_failed") records.push(record);
    },
    createCounter: () => ({ add() {} }),
    createHistogram: () => ({ record() {} }),
    createGauge: () => ({ record() {} }),
    registerObservations: () => () => {},
    activeContext: () => undefined,
    injectTraceContext: () => null,
    extractTraceContext: () => undefined,
    withSpan: async (_name, _attributes, operation) =>
      operation({
        setAttribute() {
          return this;
        },
        setAttributes() {
          return this;
        },
        setStatus() {
          return this;
        },
        recordException() {},
      }),
  });
  return { records, unregister };
}

describe("worker reporter failures", () => {
  const unhandled: unknown[] = [];
  const recordUnhandled = (reason: unknown) => unhandled.push(reason);
  let consoleError: MockInstance<typeof console.error>;
  let telemetry: ReturnType<typeof recordReporterFailures>;

  beforeEach(() => {
    unhandled.length = 0;
    process.on("unhandledRejection", recordUnhandled);
    consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    telemetry = recordReporterFailures();
  });

  afterEach(() => {
    telemetry.unregister();
    process.off("unhandledRejection", recordUnhandled);
    vi.restoreAllMocks();
  });

  for (const [kind, reporter] of Object.entries(failures)) {
    it(`keeps the run alive after ${kind} from onRegistrationError and onMaintenance`, async () => {
      const fake = reporterQueue();
      const registrationReporter = vi.fn<Reporter>(reporter());
      const maintenanceReporter = vi.fn<Reporter>(reporter());
      const worker = new Worker(fake.queue, {
        ...options,
        onRegistrationError: registrationReporter,
        onMaintenance: maintenanceReporter,
      });
      const run = worker.run();
      try {
        // Each reporter fails more than once, and claims and maintenance passes continue.
        await vi.waitFor(
          () => {
            expect(registrationReporter.mock.calls.length).toBeGreaterThan(2);
            expect(maintenanceReporter.mock.calls.length).toBeGreaterThan(2);
            expect(fake.counts.ticks).toBeGreaterThan(2);
            expect(fake.counts.schedulePasses).toBeGreaterThan(2);
          },
          { timeout: 5_000 },
        );
        const claims = fake.counts.claims;
        await vi.waitFor(() => expect(fake.counts.claims).toBeGreaterThan(claims));
        // The worker keeps the telemetry that it recorded before the failed call.
        expect(worker.maintenanceTelemetry()).toEqual([
          expect.objectContaining({ loop: "tick", phase: "promote" }),
        ]);
      } finally {
        worker.stop();
      }
      await expect(run).resolves.toBeUndefined();
      // A failed reporter is never called for its own failure.
      for (const call of registrationReporter.mock.calls) {
        expect((call[0] as Error).message).toBe("registry offline");
      }
      // Within one interval, the worker reports each reporter once, with the catalogued name, the
      // callback, and the error type. The report never carries the error message.
      expect(consoleError.mock.calls.map((call) => call[0])).toEqual([
        "Workhorse worker onRegistrationError reporter failed",
        "Workhorse worker onMaintenance reporter failed",
      ]);
      expect(consoleError.mock.calls[0]![1]).toEqual({
        "event.name": "workhorse.worker.reporter_failed",
        "workhorse.worker.id": workerId,
        "workhorse.worker.reporter": "registration_error",
        "error.type": "Error",
      });
      expect(telemetry.records).toEqual([
        {
          severity: "warn",
          eventName: "workhorse.worker.reporter_failed",
          body: "Workhorse worker onRegistrationError reporter failed",
          attributes: {
            "workhorse.worker.id": workerId,
            "workhorse.worker.reporter": "registration_error",
            "error.type": "Error",
          },
        },
        {
          severity: "warn",
          eventName: "workhorse.worker.reporter_failed",
          body: "Workhorse worker onMaintenance reporter failed",
          attributes: {
            "workhorse.worker.id": workerId,
            "workhorse.worker.reporter": "maintenance",
            "error.type": "Error",
          },
        },
      ]);
      expect(JSON.stringify(telemetry.records)).not.toContain("alert client offline");
      expect(JSON.stringify(consoleError.mock.calls)).not.toContain("alert client offline");
      // Let rejection tracking run before the check.
      await sleep(10);
      expect(unhandled).toEqual([]);
    });
  }

  it("isolates each failure of onNotificationError from the notification path", async () => {
    const fake = reporterQueue();
    const kinds = Object.values(failures);
    let next = 0;
    const notificationReporter = vi.fn<Reporter>((error) => kinds[next++ % kinds.length]!()(error));
    const worker = new Worker(fake.queue, {
      ...options,
      registryIntervalMs: 0,
      onNotificationError: notificationReporter,
    });
    const run = worker.run();
    try {
      await vi.waitFor(() => expect(fake.notificationErrors).toHaveLength(1));
      for (let index = 0; index < kinds.length; index += 1) {
        expect(() => fake.notificationErrors[0]!(new Error("listen failed"))).not.toThrow();
      }
      expect(notificationReporter).toHaveBeenCalledTimes(kinds.length);
      const claims = fake.counts.claims;
      await vi.waitFor(() => expect(fake.counts.claims).toBeGreaterThan(claims));
    } finally {
      worker.stop();
    }
    await expect(run).resolves.toBeUndefined();
    await sleep(10);
    expect(consoleError.mock.calls.map((call) => call[0])).toEqual([
      "Workhorse worker onNotificationError reporter failed",
    ]);
    expect(telemetry.records.map((record) => record.attributes)).toEqual([
      {
        "workhorse.worker.id": workerId,
        "workhorse.worker.reporter": "notification_error",
        "error.type": "Error",
      },
    ]);
    expect(unhandled).toEqual([]);
  });

  for (const [kind, reporter] of Object.entries(failures)) {
    it(`does not let a console failure escape after ${kind} from a reporter`, async () => {
      consoleError.mockImplementation(() => {
        throw new Error("console inspection failed");
      });
      const fake = reporterQueue();
      const worker = new Worker(fake.queue, {
        ...options,
        onRegistrationError: reporter(),
        onMaintenance: reporter(),
      });
      const run = worker.run();
      try {
        await vi.waitFor(() => {
          expect(consoleError).toHaveBeenCalledTimes(2);
          expect(fake.counts.claims).toBeGreaterThan(2);
        });
      } finally {
        worker.stop();
      }
      await expect(run).resolves.toBeUndefined();
      await sleep(10);
      expect(unhandled).toEqual([]);
    });
  }

  it("writes to the console when the telemetry provider throws", async () => {
    telemetry.unregister();
    const unregister = registerTelemetryProvider({
      emitLog(record) {
        if (record.eventName === "workhorse.worker.reporter_failed") {
          throw new Error("log exporter offline");
        }
      },
      createCounter: () => ({ add() {} }),
      createHistogram: () => ({ record() {} }),
      createGauge: () => ({ record() {} }),
      registerObservations: () => () => {},
      activeContext: () => undefined,
      injectTraceContext: () => null,
      extractTraceContext: () => undefined,
      withSpan: async (_name, _attributes, operation) =>
        operation({
          setAttribute() {
            return this;
          },
          setAttributes() {
            return this;
          },
          setStatus() {
            return this;
          },
          recordException() {},
        }),
    });
    telemetry = { records: [], unregister };
    const fake = reporterQueue();
    const worker = new Worker(fake.queue, {
      ...options,
      onRegistrationError: failures["a synchronous throw"]!(),
    });
    const run = worker.run();
    try {
      await vi.waitFor(() => {
        expect(consoleError).toHaveBeenCalledTimes(1);
        expect(fake.counts.claims).toBeGreaterThan(2);
      });
    } finally {
      worker.stop();
    }
    await expect(run).resolves.toBeUndefined();
    expect(consoleError.mock.calls[0]![0]).toBe(
      "Workhorse worker onRegistrationError reporter failed",
    );
  });

  it("keeps the last known pause after a registration failure and a reporter failure", async () => {
    const fake = reporterQueue({ registrations: [{ paused: true }] });
    const registrationReporter = vi.fn<Reporter>(failures["a synchronous throw"]!());
    const worker = new Worker(fake.queue, {
      ...options,
      onRegistrationError: registrationReporter,
    });
    const run = worker.run();
    try {
      await vi.waitFor(() => expect(registrationReporter.mock.calls.length).toBeGreaterThan(2));
      expect(worker.isPaused()).toBe(true);
      expect(fake.counts.claims).toBe(0);
    } finally {
      worker.stop();
    }
    await expect(run).resolves.toBeUndefined();
  });

  it("reports a reporter that always fails again after the interval, with the unreported count", async () => {
    const realNow = performance.now.bind(performance);
    let offsetMs = 0;
    vi.spyOn(performance, "now").mockImplementation(() => realNow() + offsetMs);
    const fake = reporterQueue();
    const registrationReporter = vi.fn<Reporter>(failures["a synchronous throw"]!());
    const worker = new Worker(fake.queue, {
      ...options,
      onRegistrationError: registrationReporter,
    });
    const run = worker.run();
    try {
      await vi.waitFor(() => expect(registrationReporter.mock.calls.length).toBeGreaterThan(2));
      expect(consoleError).toHaveBeenCalledTimes(1);
      const before = registrationReporter.mock.calls.length;
      offsetMs = 61_000;
      await vi.waitFor(() =>
        expect(registrationReporter.mock.calls.length).toBeGreaterThan(before),
      );
    } finally {
      worker.stop();
    }
    await run;
    expect(consoleError).toHaveBeenCalledTimes(2);
    expect(consoleError.mock.calls[1]![0]).toMatch(
      /^Workhorse worker onRegistrationError reporter failed after \d+ unreported failures$/,
    );
    expect(telemetry.records).toHaveLength(2);
    expect(telemetry.records[1]!.body).toBe(consoleError.mock.calls[1]![0]);
  });
});
