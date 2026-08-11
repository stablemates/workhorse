import { describe, expect, it } from "vitest";
import type { DashboardRateLimitPolicySummary } from "./model.js";
import { describeRateLimit, describeRateThrottle } from "./rate-limit.js";

const policy: DashboardRateLimitPolicySummary = {
  namespace: "demo",
  rate: { limit: 12, intervalMs: 60_000, burst: 3 },
  perKey: { limit: 2, intervalMs: 1_000, burst: 1 },
  availableTokens: 0.25,
  throttledReady: 4,
  throttledKeys: 2,
  nextEligibleAt: "2026-08-11T12:00:00.000Z",
};

describe("rate-limit presentation", () => {
  it("states the sustained rate, burst, keyed policy, and current throttle separately", () => {
    expect(describeRateLimit(policy)).toEqual({
      label: "12/1m · burst 3",
      keyedLabel: "2/1s · burst 1 per key",
      title: "PostgreSQL admits 12 starts every 1m, retaining up to 3 tokens after idle time.",
    });
    expect(describeRateThrottle(policy)).toEqual({
      label: "4 · 2 keys",
      title:
        "4 sampled ready tasks are waiting for tokens. The earliest can start at 2026-08-11T12:00:00.000Z.",
      throttling: true,
    });
  });

  it("does not present an unconfigured queue as throttled", () => {
    expect(describeRateLimit(null).label).toBe("Unlimited");
    expect(describeRateThrottle(null).throttling).toBe(false);
  });
});
