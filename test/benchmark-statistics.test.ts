import { describe, expect, it } from "vitest";
import {
  nearestRankPercentile,
  summarizeLatencies,
  summarizeNumbers,
} from "../benchmarks/statistics.js";

describe("nearestRankPercentile", () => {
  it("uses nearest-rank percentiles on a sorted copy", () => {
    const samples = [40, 10, 30, 20];

    expect(nearestRankPercentile(samples, 0)).toBe(10);
    expect(nearestRankPercentile(samples, 0.5)).toBe(20);
    expect(nearestRankPercentile(samples, 0.95)).toBe(40);
    expect(nearestRankPercentile(samples, 1)).toBe(40);
    expect(samples).toEqual([40, 10, 30, 20]);
  });

  it("returns null for empty or non-finite-only samples", () => {
    expect(nearestRankPercentile([], 0.5)).toBeNull();
    expect(nearestRankPercentile([Number.NaN, Infinity], 0.5)).toBeNull();
  });

  it("rejects percentiles outside the 0 to 1 range", () => {
    expect(() => nearestRankPercentile([1], -0.01)).toThrow(RangeError);
    expect(() => nearestRankPercentile([1], 1.01)).toThrow(RangeError);
    expect(() => nearestRankPercentile([1], Number.NaN)).toThrow(RangeError);
  });
});

describe("summarizeNumbers", () => {
  it("summarizes count, range, mean, sample standard deviation, and 95% Student-t CI", () => {
    const summary = summarizeNumbers([1, 2, 3, 4, 5]);

    expect(summary.count).toBe(5);
    expect(summary.min).toBe(1);
    expect(summary.max).toBe(5);
    expect(summary.mean).toBe(3);
    expect(summary.sampleStandardDeviation).toBeCloseTo(Math.sqrt(2.5), 12);
    expect(summary.confidenceInterval95.marginOfError).toBeCloseTo(1.962928, 6);
    expect(summary.confidenceInterval95.lower).toBeCloseTo(1.037072, 6);
    expect(summary.confidenceInterval95.upper).toBeCloseTo(4.962928, 6);
  });

  it("handles singleton and empty samples deterministically", () => {
    expect(summarizeNumbers([42])).toEqual({
      count: 1,
      min: 42,
      max: 42,
      mean: 42,
      sampleStandardDeviation: 0,
      confidenceInterval95: { confidenceLevel: 0.95, lower: 42, upper: 42, marginOfError: 0 },
    });

    expect(summarizeNumbers([])).toEqual({
      count: 0,
      min: null,
      max: null,
      mean: null,
      sampleStandardDeviation: null,
      confidenceInterval95: {
        confidenceLevel: 0.95,
        lower: null,
        upper: null,
        marginOfError: null,
      },
    });
  });

  it("ignores non-finite samples", () => {
    expect(summarizeNumbers([1, Number.NaN, 3, Infinity, -Infinity]).mean).toBe(2);
  });
});

describe("summarizeLatencies", () => {
  it("returns p50, p95, and p99 latency nearest-rank percentiles", () => {
    expect(summarizeLatencies([5, 1, 3, 2, 4])).toEqual({ p50: 3, p95: 5, p99: 5 });
  });

  it("returns null latency percentiles for no finite samples", () => {
    expect(summarizeLatencies([])).toEqual({ p50: null, p95: null, p99: null });
  });
});
