import { describe, expect, it } from "vitest";
import {
  normalizeComparativeOptions,
  stringifyComparativeResult,
  summarizeComparativeRuns,
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
    enqueueDurationMs: repetition * 2,
    processingDurationMs: repetition * 4,
    totalDurationMs: repetition * 6,
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
  it("merges caller defaults, trims names, and canonicalizes the concurrency sweep", () => {
    const defaults: ComparativeBenchmarkOptions = {
      jobsPerRun: 8,
      repetitions: 2,
      workerConcurrency: [4],
      queueName: "default-name",
      leaseMs: 5_000,
      churn: { durationMs: 100, batchSize: 3, sampleIntervalMs: 20, workerConcurrency: 1 },
    };

    expect(
      normalizeComparativeOptions(
        {
          jobsPerRun: 12,
          workerConcurrency: [4, 1, 4, 2],
          queueName: "  benchmark  ",
          churn: { batchSize: 5 },
        },
        defaults,
      ),
    ).toEqual({
      jobsPerRun: 12,
      repetitions: 2,
      workerConcurrency: [1, 2, 4],
      queueName: "benchmark",
      leaseMs: 5_000,
      churn: { durationMs: 100, batchSize: 5, sampleIntervalMs: 20, workerConcurrency: 1 },
    });
  });

  it("does not mutate caller arrays", () => {
    const workerConcurrency = [3, 1, 3];
    normalizeComparativeOptions({ workerConcurrency });
    expect(workerConcurrency).toEqual([3, 1, 3]);
  });

  it("rejects unsafe, empty, and non-positive options", () => {
    expect(() => normalizeComparativeOptions({ jobsPerRun: 0 })).toThrow(/jobsPerRun/);
    expect(() => normalizeComparativeOptions({ repetitions: 1.5 })).toThrow(/repetitions/);
    expect(() => normalizeComparativeOptions({ workerConcurrency: [] })).toThrow(
      /workerConcurrency/,
    );
    expect(() => normalizeComparativeOptions({ workerConcurrency: [1, -1] })).toThrow(
      /workerConcurrency/,
    );
    expect(() => normalizeComparativeOptions({ queueName: "   " })).toThrow(/queueName/);
    expect(() => normalizeComparativeOptions({ churn: { durationMs: -1 } })).toThrow(/durationMs/);
  });
});

describe("summarizeComparativeRuns", () => {
  it("groups by design and concurrency and uses 95% CI number summaries", () => {
    const summaries = summarizeComparativeRuns([
      run("hybrid", 2, 1, 100, [1, 2], 1_000),
      run("conventional", 1, 1, 50, [5], 500),
      run("hybrid", 2, 2, 200, [3, 4], 3_000),
    ]);

    expect(summaries.map(({ design, workerConcurrency }) => [design, workerConcurrency])).toEqual([
      ["conventional", 1],
      ["hybrid", 2],
    ]);
    const hybrid = summaries[1]!;
    expect(hybrid.repetitions).toBe(2);
    expect(hybrid.throughputPerSecond.mean).toBe(150);
    expect(hybrid.throughputPerSecond.confidenceInterval95.confidenceLevel).toBe(0.95);
    expect(hybrid.throughputPerSecond.confidenceInterval95.marginOfError).toBeCloseTo(635.3, 8);
    expect(hybrid.walBytes.mean).toBe(2_000);
    expect(hybrid.claimLatencyMs).toMatchObject({ p50: 2, p95: 4, p99: 4 });
    expect(hybrid.claimLatencyMs.samples.mean).toBe(2.5);
    expect(hybrid.claimLatencyMs.perRunP95.mean).toBe(3);
  });

  it("returns an empty deterministic summary for no runs", () => {
    expect(summarizeComparativeRuns([])).toEqual([]);
  });
});

describe("deterministic JSON conversion", () => {
  it("removes bigint and Date ambiguity and sorts object keys", () => {
    const converted = toJsonSafe({ z: 2n, a: new Date("2026-01-02T03:04:05.000Z") });
    expect(converted).toEqual({ a: "2026-01-02T03:04:05.000Z", z: "2" });
    expect(Object.keys(converted as object)).toEqual(["a", "z"]);
  });

  it("stringifies a benchmark result without unsupported JSON values", () => {
    const result: ComparativeBenchmarkResult = {
      version: 2,
      options: normalizeComparativeOptions({ churn: { durationMs: 0 } }),
      runs: [],
      summaries: [],
      churn: [],
    };
    expect(() => JSON.parse(stringifyComparativeResult(result))).not.toThrow();
  });
});
