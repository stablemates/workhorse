import { describe, expect, it } from "vitest";
import {
  benchmarkProfiles,
  captureBenchmarkProvenance,
  resolveBenchmarkRunOptions,
} from "../benchmarks/run.js";

describe("benchmark v3 profiles", () => {
  it("resolves the bounded default full-suite profile", () => {
    const resolved = resolveBenchmarkRunOptions();
    expect(resolved.suite).toBe("all");
    expect(resolved.profile).toBe("default");
    expect(resolved.comparative).toMatchObject({
      seed: 1,
      enqueueBatchSize: 25,
      repetitions: 3,
      workerConcurrency: [1, 4, 8],
      churn: { targetJobs: 500, targetRatePerSecond: 100 },
    });
    expect(resolved.operational.jobCount).toBe(24);
  });

  it("provides bounded smoke and full profiles", () => {
    const smoke = resolveBenchmarkRunOptions({ profile: "smoke" });
    const full = resolveBenchmarkRunOptions({ profile: "full" });
    expect(smoke.comparative).toMatchObject({
      jobsPerRun: 12,
      enqueueBatchSize: 4,
      repetitions: 2,
      churn: { targetJobs: 20, targetRatePerSecond: 40 },
    });
    expect(full.comparative).toMatchObject({
      jobsPerRun: 1_000,
      enqueueBatchSize: 100,
      churn: { targetJobs: 6_000, targetRatePerSecond: 100 },
    });
    expect(smoke.operational.leaseMs).toBe(100);
  });

  it("merges v3 comparative overrides without mutating profiles", () => {
    const resolved = resolveBenchmarkRunOptions({
      profile: "smoke",
      suite: "comparative",
      comparative: {
        seed: 99,
        enqueueBatchSize: 7,
        churn: { targetJobs: 25, targetRatePerSecond: 50 },
      },
    });
    expect(resolved.comparative.churn).toEqual({
      ...benchmarkProfiles.smoke.comparative.churn,
      targetJobs: 25,
      targetRatePerSecond: 50,
    });
    expect(resolved.comparative.seed).toBe(99);
    expect(resolved.comparative.enqueueBatchSize).toBe(7);

    resolved.comparative.workerConcurrency?.push(99);
    expect(resolveBenchmarkRunOptions({ profile: "smoke" }).comparative.workerConcurrency).toEqual([
      1, 2,
    ]);
  });

  it("captures reproducibility provenance without exposing environment variables", () => {
    const provenance = captureBenchmarkProvenance();
    expect(provenance.command).toEqual(process.argv);
    expect(provenance.runtime.nodeVersion).toBe(process.version);
    expect(provenance.runtime.logicalCpuCount).toBeGreaterThan(0);
    expect(provenance.runtime.totalMemoryBytes).toBeGreaterThan(0);
    expect(provenance).not.toHaveProperty("environment");
  });
});
