import type { QueryResult, QueryResultRow } from "pg";
import { describe, expect, it } from "vitest";
import {
  createHistoryDayV1Sql,
  mean,
  operationalScenarioContracts,
  operationalScenarioNames,
  percentile,
  pollingClaimUpperBound,
  recordInvariant,
  resetWorkhorseStateSql,
  retireHistoryDayV1Sql,
  resolveOperationalScenarioOptions,
  runOperationalScenarios,
} from "../benchmarks/scenarios.js";
import type {
  OperationalScenarioName,
  OperationalScenarioRunner,
  ScenarioAssertion,
} from "../benchmarks/scenarios.js";
import type { Queryable } from "../src/index.js";

const unusedPool: Queryable = {
  query<R extends QueryResultRow>(): Promise<QueryResult<R>> {
    throw new Error("mocked scenario runners must not query PostgreSQL");
  },
};

function passingRunner(name: OperationalScenarioName, calls: string[]): OperationalScenarioRunner {
  return async (context) => {
    calls.push(`${name}:${context.queueName}:${context.options.jobCount}`);
    return {
      name,
      durationMs: 0,
      metrics: { mocked: true },
      assertions: [{ name: "mock invariant", passed: true, expected: true, actual: true }],
    };
  };
}

describe("operational scenario contracts", () => {
  it("defines one stable, unique contract for every scenario", () => {
    expect(operationalScenarioContracts.map((contract) => contract.name)).toEqual(
      operationalScenarioNames,
    );
    expect(new Set(operationalScenarioContracts.map((contract) => contract.name)).size).toBe(
      operationalScenarioNames.length,
    );
    for (const contract of operationalScenarioContracts) {
      expect(contract.purpose.length).toBeGreaterThan(20);
      expect(contract.invariants.length).toBeGreaterThan(0);
      expect(contract.metrics.length).toBeGreaterThan(0);
    }
  });

  it("uses explicit reset and versioned partition-retirement SQL contracts", () => {
    expect(resetWorkhorseStateSql).toContain("TRUNCATE workhorse.job_event");
    expect(resetWorkhorseStateSql).toContain("workhorse.job_redrive");
    expect(resetWorkhorseStateSql).toContain("ALTER SEQUENCE workhorse.fence_token_seq");
    expect(createHistoryDayV1Sql).toContain("workhorse.create_history_day_v1");
    expect(retireHistoryDayV1Sql).toContain("workhorse.retire_history_day_v1");
    expect(retireHistoryDayV1Sql).toContain("$1::date");
  });

  it("defines complete schema v11 cancellation lifecycle evidence without a performance claim", () => {
    const contract = operationalScenarioContracts.find(
      (candidate) => candidate.name === "cancellation-lifecycle",
    );

    expect(contract).toBeDefined();
    expect(contract!.invariants.join("\n")).toMatch(/ready and scheduled jobs cancel immediately/);
    expect(contract!.invariants.join("\n")).toMatch(/waiting job cancels immediately/);
    expect(contract!.invariants.join("\n")).toMatch(/heartbeat status and AbortSignal/);
    expect(contract!.invariants.join("\n")).toMatch(/lease expiry instead of retrying/);
    expect(contract!.invariants.join("\n")).toMatch(/wrong-fence acknowledgement/);
    expect(contract!.invariants.join("\n")).toMatch(/no duplicate terminal outcome/);
    expect(contract!.invariants.join("\n")).toMatch(/first-committer-wins/);
    expect(contract!.invariants.join("\n")).toMatch(/next occurrence independent/);
    expect(contract!.metrics).toEqual(
      expect.arrayContaining([
        "readyCancelMs",
        "scheduledCancelMs",
        "waitingCancelMs",
        "activeRequestMs",
        "activeAcknowledgeMs",
        "expiryMaterializationMs",
        "stateQueryMs",
        "eventQueryMs",
        "recurringNextOccurrenceMs",
      ]),
    );
    expect(contract!.purpose.toLowerCase()).not.toMatch(/faster|throughput|latency target|sla/);
  });

  it("defines complete dead-letter redrive evidence without a performance claim", () => {
    const contract = operationalScenarioContracts.find(
      (candidate) => candidate.name === "dead-letter-redrive-lifecycle",
    );

    expect(contract).toBeDefined();
    expect(contract!.invariants.join("\n")).toMatch(/cold outcome relation/);
    expect(contract!.invariants.join("\n")).toMatch(/dry-run/);
    expect(contract!.invariants.join("\n")).toMatch(/source outcome remains unchanged/);
    expect(contract!.invariants.join("\n")).toMatch(/exact repeated request/);
    expect(contract!.invariants.join("\n")).toMatch(/audited lineage/);
    expect(contract!.metrics).toEqual(
      expect.arrayContaining([
        "deadLetters",
        "listMs",
        "dryRunMs",
        "singleRedriveMs",
        "replayMs",
        "bulkRedriveMs",
        "lineageEdges",
      ]),
    );
    expect(contract!.purpose.toLowerCase()).not.toMatch(/faster|throughput|latency target|sla/);
  });

  it("defines complete query listing evidence without a performance claim", () => {
    const contract = operationalScenarioContracts.find(
      (candidate) => candidate.name === "query-listing-lifecycle",
    );

    expect(contract).toBeDefined();
    expect(contract!.invariants.join("\n")).toMatch(/immutable cursor/);
    expect(contract!.invariants.join("\n")).toMatch(/omitted by default/);
    expect(contract!.invariants.join("\n")).toMatch(/heartbeats do not churn/);
    expect(contract!.invariants.join("\n")).toMatch(/events and closed attempts/);
    expect(contract!.invariants.join("\n")).toMatch(/separate from every claim-critical index/);
    expect(contract!.metrics).toEqual(
      expect.arrayContaining([
        "listedJobs",
        "listMs",
        "payloadProjectionMs",
        "timelineMs",
        "timelineEntries",
        "projectionRows",
        "operatorIndexBytes",
      ]),
    );
    expect(contract!.purpose.toLowerCase()).not.toMatch(/faster|throughput|latency target|sla/);
  });

  it("defines comparative trace-context overhead evidence without a performance claim", () => {
    const contract = operationalScenarioContracts.find(
      (candidate) => candidate.name === "telemetry-context",
    );

    expect(contract).toBeDefined();
    expect(contract!.invariants.join("\n")).toMatch(
      /separate from an unchanged application payload/,
    );
    expect(contract!.invariants.join("\n")).toMatch(/adds no dispatch index/);
    expect(contract!.metrics).toEqual(
      expect.arrayContaining([
        "baselineEnqueueMs",
        "instrumentedEnqueueMs",
        "baselineClaimMs",
        "instrumentedClaimMs",
        "exportedSpans",
        "exportedMetrics",
      ]),
    );
    expect(contract!.purpose.toLowerCase()).not.toMatch(/faster|latency target|sla/);
  });

  it("defines notification dispatch evidence without a production performance claim", () => {
    const contract = operationalScenarioContracts.find(
      (candidate) => candidate.name === "notification-dispatch",
    );

    expect(contract).toBeDefined();
    expect(contract!.invariants.join("\n")).toMatch(/both dispatch modes execute/);
    expect(contract!.invariants.join("\n")).toMatch(/fewer empty claims/);
    expect(contract!.invariants.join("\n")).toMatch(/bounded polling fallback/);
    expect(contract!.metrics).toEqual(
      expect.arrayContaining([
        "pollingIdleClaimCalls",
        "notificationIdleClaimCalls",
        "pollingEnqueueToClaimMs",
        "notificationEnqueueToClaimMs",
      ]),
    );
    expect(contract!.purpose.toLowerCase()).not.toMatch(/faster|latency target|sla/);
  });

  it("defines loaded recurring-schedule cadence evidence", () => {
    const contract = operationalScenarioContracts.find(
      (candidate) => candidate.name === "schedule-cadence-jitter",
    );

    expect(contract).toBeDefined();
    expect(contract!.invariants.join("\n")).toMatch(/while the worker remains loaded/);
    expect(contract!.invariants.join("\n")).toMatch(/one durable occurrence and job/);
    expect(contract!.metrics).toEqual(
      expect.arrayContaining([
        "scheduleSamples",
        "loadJobsStarted",
        "maintenanceIntervalMs",
        "fireDelayP50Ms",
        "fireDelayP95Ms",
        "fireDelayMaxMs",
      ]),
    );
  });
});

describe("resolveOperationalScenarioOptions", () => {
  it("provides smoke-safe defaults and canonical scenario ordering", () => {
    const resolved = resolveOperationalScenarioOptions();

    expect(resolved.jobCount).toBeGreaterThan(0);
    expect(resolved.jobCount).toBeLessThanOrEqual(20);
    expect(resolved.heartbeatCount).toBeLessThanOrEqual(resolved.jobCount);
    expect(resolved.scheduleDelayMs).toBeLessThanOrEqual(100);
    expect(resolved.leaseMs).toBeLessThanOrEqual(100);
    expect(resolved.scheduleSamples).toBeGreaterThanOrEqual(3);
    expect(resolved.scenarios).toEqual(operationalScenarioNames);
  });

  it("normalizes custom counts and preserves contract order for a subset", () => {
    expect(
      resolveOperationalScenarioOptions({
        jobCount: 3,
        heartbeatCount: 2,
        batchSize: 2,
        scheduleDelayMs: 5,
        leaseMs: 6,
        retryDelayMs: 7,
        pruneLimit: 8,
        scheduleSamples: 3,
        queuePrefix: " smoke ",
        scenarios: ["health-snapshot", "heartbeat-fencing"],
      }),
    ).toEqual({
      jobCount: 3,
      heartbeatCount: 2,
      batchSize: 2,
      scheduleDelayMs: 5,
      leaseMs: 6,
      retryDelayMs: 7,
      pruneLimit: 8,
      scheduleSamples: 3,
      queuePrefix: "smoke",
      scenarios: ["heartbeat-fencing", "health-snapshot"],
    });
  });

  it("rejects unsafe numeric values, blank prefixes, and duplicate scenarios", () => {
    expect(() => resolveOperationalScenarioOptions({ jobCount: 0 })).toThrow(RangeError);
    expect(() => resolveOperationalScenarioOptions({ leaseMs: 1.5 })).toThrow(RangeError);
    expect(() => resolveOperationalScenarioOptions({ queuePrefix: "  " })).toThrow(RangeError);
    expect(() =>
      resolveOperationalScenarioOptions({
        scenarios: ["retry-paths", "retry-paths"],
      }),
    ).toThrow("must not contain duplicates");
  });
});

describe("scenario metric helpers", () => {
  it("calculates nearest-rank percentiles without mutating samples", () => {
    const samples = [8, 2, Number.NaN, 4, 6];

    expect(percentile(samples, 0)).toBe(2);
    expect(percentile(samples, 0.5)).toBe(4);
    expect(percentile(samples, 0.95)).toBe(8);
    expect(percentile(samples, 1)).toBe(8);
    expect(samples).toEqual([8, 2, Number.NaN, 4, 6]);
  });

  it("handles empty samples and validates percentile bounds", () => {
    expect(percentile([], 0.5)).toBeNull();
    expect(percentile([Number.NaN], 0.5)).toBeNull();
    expect(() => percentile([1], -0.1)).toThrow(RangeError);
    expect(() => percentile([1], 1.1)).toThrow(RangeError);
  });

  it("calculates a finite-only arithmetic mean", () => {
    expect(mean([1, 2, 3, Number.NaN, Infinity])).toBe(2);
    expect(mean([])).toBeNull();
  });

  it("bounds successful claims plus one serial fallback per elapsed polling window", () => {
    expect(pollingClaimUpperBound(12, 181, 10)).toBe(33);
    expect(pollingClaimUpperBound(12, 180, 10)).toBe(32);
    expect(pollingClaimUpperBound(12, 180, 10, 3)).toBe(33);
  });

  it("records passing invariants and throws immediately on failure", () => {
    const assertions: ScenarioAssertion[] = [];
    recordInvariant(assertions, "equal", 2, 2);
    expect(assertions).toEqual([{ name: "equal", passed: true, expected: 2, actual: 2 }]);

    expect(() => recordInvariant(assertions, "broken", 1, 2)).toThrow(
      "Operational scenario invariant failed: broken",
    );
    expect(assertions.at(-1)?.passed).toBe(false);
  });
});

describe("runOperationalScenarios", () => {
  it("runs a selected subset in contract order with deterministic queue names and timings", async () => {
    const calls: string[] = [];
    const ticks = [100, 101, 104, 105, 111, 112];
    const now = () => ticks.shift() ?? 112;
    const report = await runOperationalScenarios(unusedPool, {
      jobCount: 3,
      queuePrefix: "test",
      scenarios: ["health-snapshot", "retry-paths"],
      now,
      scenarioImplementations: {
        "retry-paths": passingRunner("retry-paths", calls),
        "health-snapshot": passingRunner("health-snapshot", calls),
      },
    });

    expect(calls).toEqual([
      "retry-paths:test-retry-paths:3",
      "health-snapshot:test-health-snapshot:3",
    ]);
    expect(report.scenarios.map(({ name, durationMs }) => ({ name, durationMs }))).toEqual([
      { name: "retry-paths", durationMs: 3 },
      { name: "health-snapshot", durationMs: 6 },
    ]);
    expect(report.totalDurationMs).toBe(12);
  });

  it("throws if a runner returns the wrong contract or a failed invariant", async () => {
    await expect(
      runOperationalScenarios(unusedPool, {
        scenarios: ["retry-paths"],
        scenarioImplementations: {
          "retry-paths": passingRunner("health-snapshot", []),
        },
      }),
    ).rejects.toThrow("returned result for health-snapshot");

    await expect(
      runOperationalScenarios(unusedPool, {
        scenarios: ["retry-paths"],
        scenarioImplementations: {
          "retry-paths": async () => ({
            name: "retry-paths",
            durationMs: 0,
            metrics: {},
            assertions: [{ name: "failed", passed: false, expected: true, actual: false }],
          }),
        },
      }),
    ).rejects.toThrow("returned a failed invariant");
  });
});
