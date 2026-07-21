import { describe, expect, it } from "vitest";
import {
  createExecutionPlan,
  normalizeComparativeOptions,
  stringifyComparativeResult,
  summarizeComparativeRuns,
  summarizePairedRuns,
  toJsonSafe,
  type ComparativeBenchmarkOptions,
  type ComparativeBenchmarkResult,
  type ComparativeRunResult,
  type RunTelemetry,
} from "../benchmarks/comparative.js";

const emptyTelemetry: RunTelemetry = {
  wal: { bytes: 0 },
  relationsBefore: [],
  relationsAfter: [],
  schemaBefore: {},
  schemaAfter: {},
  pgStatIoDelta: null,
  activityBefore: {},
  activityAfter: {},
  claimExplain: null,
};

function run(
  design: ComparativeRunResult["design"],
  workerConcurrency: number,
  repetition: number,
  throughputPerSecond: number,
  claimLatencySamplesMs: number[],
  walBytes: number,
): ComparativeRunResult {
  return {
    design,
    workerConcurrency,
    repetition,
    jobs: 10,
    enqueueBatchSize: 4,
    enqueueRequests: 3,
    enqueueDurationMs: repetition * 2,
    processingDurationMs: repetition * 4,
    totalDurationMs: repetition * 6,
    enqueueJobsPerSecond: 5_000 / repetition,
    processingJobsPerSecond: 2_500 / repetition,
    totalJobsPerSecond: throughputPerSecond,
    throughputPerSecond,
    completedJobs: 10,
    claimLatencySamplesMs,
    claimLatencyMs: {
      p50: claimLatencySamplesMs[0] ?? null,
      p95: claimLatencySamplesMs.at(-1) ?? null,
      p99: claimLatencySamplesMs.at(-1) ?? null,
    },
    telemetry: { ...emptyTelemetry, wal: { bytes: walBytes } },
  };
}

describe("normalizeComparativeOptions", () => {
  it("merges defaults and canonicalizes v3 fixed-rate options", () => {
    const defaults: ComparativeBenchmarkOptions = {
      seed: 7,
      jobsPerRun: 8,
      enqueueBatchSize: 2,
      repetitions: 2,
      workerConcurrency: [4],
      queueName: "default-name",
      leaseMs: 5_000,
      churn: {
        targetJobs: 20,
        targetRatePerSecond: 10,
        batchSize: 3,
        sampleIntervalMs: 20,
        workerConcurrency: 1,
      },
    };

    expect(
      normalizeComparativeOptions(
        {
          seed: 42,
          jobsPerRun: 12,
          enqueueBatchSize: 5,
          workerConcurrency: [4, 1, 4, 2],
          queueName: "  benchmark  ",
          churn: { targetJobs: 30, targetRatePerSecond: 15 },
        },
        defaults,
      ),
    ).toEqual({
      seed: 42,
      jobsPerRun: 12,
      enqueueBatchSize: 5,
      repetitions: 2,
      workerConcurrency: [1, 2, 4],
      queueName: "benchmark",
      leaseMs: 5_000,
      churn: {
        targetJobs: 30,
        targetRatePerSecond: 15,
        batchSize: 3,
        sampleIntervalMs: 20,
        workerConcurrency: 1,
      },
    });
  });

  it("rejects invalid seed, batching, and fixed-rate options", () => {
    expect(() => normalizeComparativeOptions({ seed: -1 })).toThrow(/seed/);
    expect(() => normalizeComparativeOptions({ enqueueBatchSize: 0 })).toThrow(/enqueueBatchSize/);
    expect(() => normalizeComparativeOptions({ churn: { targetJobs: 0 } })).toThrow(/targetJobs/);
    expect(() => normalizeComparativeOptions({ churn: { targetRatePerSecond: 0 } })).toThrow(
      /targetRatePerSecond/,
    );
  });
});

describe("seeded execution plan", () => {
  it("is reproducible, shuffled, and alternates design order", () => {
    const first = createExecutionPlan([1, 4], 3, 123);
    const second = createExecutionPlan([1, 4], 3, 123);
    expect(first).toEqual(second);
    expect(first).not.toEqual(createExecutionPlan([1, 4], 3, 124));
    expect(first).toHaveLength(6);
    expect(first.map((step) => step.designOrder)).toEqual([
      ["hybrid", "conventional"],
      ["conventional", "hybrid"],
      ["hybrid", "conventional"],
      ["conventional", "hybrid"],
      ["hybrid", "conventional"],
      ["conventional", "hybrid"],
    ]);
    expect(new Set(first.map((step) => `${step.workerConcurrency}:${step.repetition}`)).size).toBe(
      6,
    );
  });
});

describe("summaries", () => {
  it("reports per-design and paired hybrid/conventional comparisons", () => {
    const runs = [
      run("hybrid", 2, 1, 100, [1, 2], 1_000),
      run("conventional", 2, 1, 50, [5], 500),
      run("hybrid", 2, 2, 200, [3, 4], 3_000),
      run("conventional", 2, 2, 100, [6], 1_000),
    ];
    expect(summarizeComparativeRuns(runs)[1]!.throughputPerSecond.mean).toBe(150);
    const paired = summarizePairedRuns(runs)[0]!;
    expect(paired.workerConcurrency).toBe(2);
    expect(paired.pairs).toBe(2);
    expect(paired.throughputPerSecond.ratio.mean).toBe(2);
    expect(paired.throughputPerSecond.difference.mean).toBe(75);
    expect(paired.totalDurationMs.ratio.mean).toBe(1);
    expect(paired.walBytes.difference.mean).toBe(1_250);
  });
});

describe("deterministic JSON conversion", () => {
  it("sorts keys and emits schema version 3 deterministically", () => {
    expect(toJsonSafe({ z: 2n, a: new Date("2026-01-02T03:04:05.000Z") })).toEqual({
      a: "2026-01-02T03:04:05.000Z",
      z: "2",
    });
    const result: ComparativeBenchmarkResult = {
      version: 3,
      options: normalizeComparativeOptions({ churn: { targetJobs: 1 } }),
      executionPlan: [],
      runs: [],
      summaries: [],
      pairedSummaries: [],
      churn: [],
    };
    expect(stringifyComparativeResult(result)).toBe(stringifyComparativeResult(result));
    expect(JSON.parse(stringifyComparativeResult(result)).version).toBe(3);
  });
});
