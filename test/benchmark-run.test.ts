import { describe, expect, it } from "vitest";
import { benchmarkProfiles, resolveBenchmarkRunOptions } from "../benchmarks/run.js";

describe("benchmark v2 profiles", () => {
  it("resolves the default full-suite profile", () => {
    const resolved = resolveBenchmarkRunOptions();
    expect(resolved.suite).toBe("all");
    expect(resolved.profile).toBe("default");
    expect(resolved.comparative.repetitions).toBe(3);
    expect(resolved.comparative.workerConcurrency).toEqual([1, 4, 8]);
    expect(resolved.operational.jobCount).toBe(24);
  });

  it("provides a bounded smoke profile with independent repetitions", () => {
    const smoke = resolveBenchmarkRunOptions({ profile: "smoke" });
    expect(smoke.comparative.jobsPerRun).toBe(12);
    expect(smoke.comparative.repetitions).toBe(2);
    expect(smoke.comparative.churn?.durationMs).toBe(500);
    expect(smoke.operational.leaseMs).toBe(100);
  });

  it("merges nested comparative and operational overrides", () => {
    const resolved = resolveBenchmarkRunOptions({
      profile: "smoke",
      suite: "comparative",
      comparative: { jobsPerRun: 7, churn: { durationMs: 25 } },
      operational: { jobCount: 2 },
    });
    expect(resolved.suite).toBe("comparative");
    expect(resolved.comparative.jobsPerRun).toBe(7);
    expect(resolved.comparative.churn).toEqual({
      ...benchmarkProfiles.smoke.comparative.churn,
      durationMs: 25,
    });
    expect(resolved.operational.jobCount).toBe(2);
    expect(resolved.operational.batchSize).toBe(3);
  });

  it("does not mutate profile arrays when callers modify resolved options", () => {
    const first = resolveBenchmarkRunOptions({ profile: "full" });
    first.comparative.workerConcurrency?.push(99);
    const second = resolveBenchmarkRunOptions({ profile: "full" });
    expect(second.comparative.workerConcurrency).toEqual([1, 4, 16, 32]);
  });
});
