import { describe, expect, it, vi } from "vitest";
import { registerOpenTelemetry } from "@stablemates/workhorse-otel";
import {
  registerQueueMetrics,
  registerTelemetryProvider,
  type TelemetryObservation,
  type WorkhorseTelemetryProvider,
} from "../src/index.js";

function provider(overrides: Partial<WorkhorseTelemetryProvider> = {}): WorkhorseTelemetryProvider {
  return {
    emitLog() {},
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
    ...overrides,
  };
}

describe("WorkhorseTelemetryProvider", () => {
  it("activates queue observations registered before the provider", async () => {
    let collect: (() => Promise<readonly TelemetryObservation[]>) | undefined;
    const remove = vi.fn<() => void>();
    const unregisterQueue = registerQueueMetrics({
      queueMetricSnapshot: async () => [
        {
          queue: "mail",
          readyDepth: 2,
          scheduledDepth: 1,
          activeLeases: 0,
          dependencyBlockedDepth: 0,
          dependencyPendingEdges: 0,
          dependencyFailedResolutions: 0,
          dependencyCountsCapped: false,
          childWaitingParents: 0,
          childPendingChildren: 0,
          childUnjoinedResults: 0,
          childFailedParents: 0,
          childCanceledParents: 0,
          childCountsCapped: false,
          oldestReadyAgeMs: null,
          concurrencyLimit: null,
          concurrencyActive: 0,
          blockedReadyDepth: 0,
          rateLimitPerSecond: null,
          rateLimitAvailableTokens: 0,
          rateLimitThrottledReadyDepth: 0,
          rateLimitNextEligibleDelayMs: null,
        },
      ],
    });
    const unregisterProvider = registerTelemetryProvider(
      provider({
        registerObservations(_definitions, callback) {
          collect = callback;
          return remove;
        },
      }),
    );

    await expect(collect?.()).resolves.toEqual(
      expect.arrayContaining([
        {
          name: "workhorse.queue.depth",
          value: 2,
          attributes: { "workhorse.queue.name": "mail", "workhorse.job.state": "ready" },
        },
      ]),
    );
    unregisterProvider();
    expect(remove).toHaveBeenCalledOnce();
    unregisterQueue();
  });

  it("rejects a competing provider until cleanup", () => {
    expect(registerOpenTelemetry).toBeTypeOf("function");
    const first = registerTelemetryProvider(provider());
    expect(() => registerTelemetryProvider(provider())).toThrow(
      "A Workhorse telemetry provider is already registered",
    );
    first();
    const second = registerTelemetryProvider(provider());
    second();
  });
});
