import { describe, expect, it } from "vitest";
import { resolveStatisticsTiersOptions } from "../benchmarks/statistics-tiers.js";

describe("statistics tiers benchmark options", () => {
  it("uses a long-horizon production-shaped default profile", () => {
    expect(resolveStatisticsTiersOptions()).toMatchObject({
      jobs: 200_000,
      days: 120,
      payloadBytes: 2_048,
    });
  });

  it("rejects empty datasets and negative warmups", () => {
    expect(() => resolveStatisticsTiersOptions({ jobs: 0 })).toThrow("jobs");
    expect(() => resolveStatisticsTiersOptions({ warmupRepetitions: -1 })).toThrow(
      "warmupRepetitions",
    );
  });
});
