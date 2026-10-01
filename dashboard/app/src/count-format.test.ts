import { describe, expect, it } from "vitest";
import { formatCount } from "./count-format.js";
import { describeRateThrottle } from "./rate-limit.js";

describe("count formatting", () => {
  it("groups the digits of an exact count", () => {
    expect(formatCount(0)).toBe("0");
    expect(formatCount(999)).toBe("999");
    expect(formatCount(1_000)).toBe("1,000");
    expect(formatCount(1_234_567)).toBe("1,234,567");
    expect(formatCount(-12_500)).toBe("-12,500");
  });

  it("rounds a fractional count to a whole number", () => {
    expect(formatCount(1_234.6)).toBe("1,235");
  });

  it("groups counts inside dashboard copy", () => {
    const throttle = describeRateThrottle({
      namespace: "demo",
      rate: { limit: 10_000, intervalMs: 60_000, burst: 2_000 },
      perKey: null,
      availableTokens: 0,
      throttledReady: 25_000,
      throttledKeys: 0,
      nextEligibleAt: null,
    });
    expect(throttle.label).toBe("25,000");
    expect(throttle.title).toContain("25,000 sampled ready tasks");
  });
});
