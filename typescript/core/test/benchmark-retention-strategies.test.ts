import { describe, expect, it } from "vitest";
import { resolveRetentionStrategiesOptions } from "../benchmarks/retention-strategies.js";

describe("retention strategy benchmark options", () => {
  it("keeps the threshold ladder and sustained scales in the default profile", () => {
    expect(resolveRetentionStrategiesOptions().rowsPerCycle).toEqual([
      10, 50, 100, 250, 500, 1_000, 10_000, 50_000,
    ]);
  });

  it("rejects a profile with no cleanup cycles", () => {
    expect(() => resolveRetentionStrategiesOptions({ cycles: 2, retainedCycles: 2 })).toThrow(
      "cycles must exceed retainedCycles",
    );
  });

  it("rejects empty or non-positive scales", () => {
    expect(() => resolveRetentionStrategiesOptions({ rowsPerCycle: [] })).toThrow(
      "rowsPerCycle must contain at least one scale",
    );
    expect(() => resolveRetentionStrategiesOptions({ rowsPerCycle: [0] })).toThrow(
      "rowsPerCycle[0] must be a positive safe integer",
    );
  });
});
