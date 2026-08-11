import { describe, expect, it } from "vitest";
import { dashboardRateLimitPolicySummary } from "./model.js";
import { rateLimitPolicyDegradedChecks } from "./server/read-model.js";

describe("dashboard rate-limit policy read model", () => {
  const policy = {
    namespace: "payments",
    queue: "payments.capture",
    scope: "key" as const,
    limit: 10,
    intervalMs: 1_000,
    burst: 20,
    throttledReady: 3,
    effectiveRatePerSecond: 10,
    nextEligibleAt: new Date("2026-08-11T12:00:01.000Z"),
  };

  it("retains bounded rate facts without leaking the queue join key", () => {
    expect(dashboardRateLimitPolicySummary(policy)).toEqual({
      namespace: "payments",
      scope: "key",
      limit: 10,
      intervalMs: 1_000,
      burst: 20,
      throttledReady: 3,
      effectiveRatePerSecond: 10,
      nextEligibleAt: "2026-08-11T12:00:01.000Z",
    });
    expect(dashboardRateLimitPolicySummary(policy)).not.toHaveProperty("queue");
  });

  it("degrades system health when ready work is throttled", () => {
    expect(
      rateLimitPolicyDegradedChecks({
        rateLimitPolicies: { policies: [policy], capped: false },
      }),
    ).toEqual(["Rate limit throttles ready tasks on payments.capture"]);
  });
});
