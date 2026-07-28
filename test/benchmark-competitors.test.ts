import { describe, expect, it } from "vitest";
import {
  competitorProfiles,
  createCompetitorExecutionPlan,
  normalizeCompetitorOptions,
  stringifyCompetitorReport,
  summarizeCompetitorRuns,
  type CompetitorRunResult,
} from "../benchmarks/competitor-baseline.js";

function result(target: CompetitorRunResult["target"], throughput: number): CompetitorRunResult {
  return {
    kind: "fixed-batch",
    target,
    workerConcurrency: 2,
    repetition: 1,
    position: 1,
    offeredJobs: 10,
    enqueuedJobs: 10,
    completedJobs: 10,
    exactCompletion: true,
    phases: {
      enqueueMs: 2,
      processingMs: 5,
      totalMs: 7,
      productionMs: null,
      drainMs: null,
    },
    rates: { enqueuePerSecond: 5000, processingPerSecond: throughput, totalPerSecond: 1000 },
    load: { batches: 2, maxBacklog: 10, samples: [] },
    telemetry: {
      walBytes: 100,
      schemaBefore: null,
      schemaAfter: null,
      schemaGrowthBytes: 50,
      relationsBefore: [],
      relationsAfter: [],
    },
  };
}

describe("competitor baseline options and plans", () => {
  it("normalizes profile overrides", () => {
    expect(normalizeCompetitorOptions({ profile: "smoke", workerConcurrency: [4, 1, 4] })).toEqual({
      ...competitorProfiles.smoke,
      profile: "smoke",
      workerConcurrency: [1, 4],
    });
  });

  it("uses deterministic shuffled blocks balanced across all three positions", () => {
    const first = createCompetitorExecutionPlan([1, 4], 6, 42);
    expect(first).toEqual(createCompetitorExecutionPlan([1, 4], 6, 42));
    expect(first).not.toEqual(createCompetitorExecutionPlan([1, 4], 6, 43));
    for (const workers of [1, 4]) {
      const steps = first.filter((step) => step.workerConcurrency === workers);
      for (const target of ["workhorse", "pg-boss", "graphile-worker"] as const) {
        expect(
          [0, 1, 2].map(
            (position) => steps.filter((s) => s.targetOrder[position] === target).length,
          ),
        ).toEqual([2, 2, 2]);
      }
    }
  });
});

describe("competitor summaries and JSON", () => {
  it("groups success-path metrics without cross-target equivalence claims", () => {
    const summaries = summarizeCompetitorRuns([result("workhorse", 2000), result("pg-boss", 1000)]);
    expect(summaries).toHaveLength(2);
    expect(
      summaries.find((summary) => summary.target === "workhorse")?.processingPerSecond.mean,
    ).toBe(2000);
  });

  it("serializes the versioned artifact contract", () => {
    const text = stringifyCompetitorReport({
      artifactVersion: 1,
      generatedAt: new Date("2026-07-22T00:00:00Z"),
      contract: "common-success-path-v1",
      semanticEquivalence: false,
      options: normalizeCompetitorOptions({ profile: "smoke" }),
      provenance: {
        command: "test",
        gitSha: null,
        sourceDirty: false,
        node: "test",
        platform: "test",
        database: {},
      },
      targets: [],
      measurementNotes: [],
      executionPlan: [],
      runs: [],
      summaries: [],
    });
    expect(JSON.parse(text)).toMatchObject({
      artifactVersion: 1,
      semanticEquivalence: false,
      generatedAt: "2026-07-22T00:00:00.000Z",
    });
  });
});
