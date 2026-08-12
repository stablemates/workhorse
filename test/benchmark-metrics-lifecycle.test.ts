import { metrics } from "@opentelemetry/api";
import { afterEach, describe, expect, it } from "vitest";
import {
  resolveMetricsLifecycleOptions,
  runMetricsLifecycleBenchmark,
} from "../benchmarks/metrics-lifecycle.js";

afterEach(() => {
  metrics.disable();
});

describe("resolveMetricsLifecycleOptions", () => {
  it("fills defaults and keeps explicit values", () => {
    expect(resolveMetricsLifecycleOptions()).toEqual({
      emissionsPerRepetition: 1_000_000,
      repetitions: 12,
      warmupRepetitions: 3,
    });
    expect(resolveMetricsLifecycleOptions({ repetitions: 2, warmupRepetitions: 0 })).toEqual({
      emissionsPerRepetition: 1_000_000,
      repetitions: 2,
      warmupRepetitions: 0,
    });
  });

  it("rejects values that cannot produce a sample", () => {
    expect(() => resolveMetricsLifecycleOptions({ repetitions: 0 })).toThrow(RangeError);
    expect(() => resolveMetricsLifecycleOptions({ emissionsPerRepetition: 0 })).toThrow(RangeError);
    expect(() => resolveMetricsLifecycleOptions({ warmupRepetitions: -1 })).toThrow(RangeError);
  });
});

describe("runMetricsLifecycleBenchmark", () => {
  it("measures both lifecycles under both provider states", async () => {
    const report = await runMetricsLifecycleBenchmark({
      emissionsPerRepetition: 1_000,
      repetitions: 2,
      warmupRepetitions: 0,
    });

    expect(
      report.measurements.map((measurement) => [measurement.lifecycle, measurement.provider]),
    ).toEqual([
      ["eager", "off"],
      ["lazy", "off"],
      ["eager", "on"],
      ["lazy", "on"],
    ]);
    for (const measurement of report.measurements) {
      expect(measurement.nanosecondsPerEmission.count).toBe(2);
      expect(measurement.nanosecondsPerEmission.mean).toBeGreaterThan(0);
    }
  });

  /** This asymmetry, not emission cost, is why ADR 0024 selects the lazy lifecycle. */
  it("records that only the lazy lifecycle reaches a provider registered after construction", async () => {
    const report = await runMetricsLifecycleBenchmark({
      emissionsPerRepetition: 1,
      repetitions: 1,
      warmupRepetitions: 0,
    });

    const eager = report.registration.find((check) => check.lifecycle === "eager");
    const lazy = report.registration.find((check) => check.lifecycle === "lazy");

    expect(eager?.reachesLateProvider).toBe(false);
    expect(eager?.collectedAfterRegistration).toBeNull();
    expect(lazy?.reachesLateProvider).toBe(true);
    expect(lazy?.collectedAfterRegistration).toBe(lazy?.emissionsAfterRegistration);
  });
});
