import { describe, expect, it } from "vitest";
import { dashboardConcurrencyPolicySummary } from "./wire.js";
import { healthCheckMessages } from "./server/read-model.js";

describe("dashboard concurrency policy read model", () => {
  const policy = {
    namespace: "checkout",
    queue: "payments",
    maxActive: 4,
    active: 4,
    available: 0,
    blockedReady: 3,
    maxActivePerKey: 2,
    saturatedKeys: 1,
    highestKeyActive: 2,
  };

  it("projects bounded aggregate facts without queue or raw key labels", () => {
    expect(dashboardConcurrencyPolicySummary(policy)).toEqual({
      namespace: "checkout",
      maxActive: 4,
      utilizationKnown: true,
      active: 4,
      available: 0,
      blockedReady: 3,
      maxActivePerKey: 2,
      saturatedKeys: 1,
      highestKeyActive: 2,
    });
    expect(dashboardConcurrencyPolicySummary(policy)).not.toHaveProperty("queue");
    expect(dashboardConcurrencyPolicySummary(policy)).not.toHaveProperty("concurrencyKey");
  });

  it("words core health reasons for operators, splitting critical from degraded", () => {
    expect(
      healthCheckMessages({
        status: {
          level: "critical",
          reasons: [
            { code: "expired-leases", severity: "critical", observed: 1, budget: 0 },
            {
              code: "concurrency-blocked",
              severity: "degraded",
              observed: 3,
              budget: 0,
              queue: "payments",
            },
            {
              code: "rate-limit-throttled",
              severity: "degraded",
              observed: 2,
              budget: 0,
              queue: "emails",
            },
            {
              code: "retention-lag",
              severity: "degraded",
              observed: 90_000_000,
              budget: 21_600_000,
              category: "jobEvents",
            },
            {
              code: "retention-lag",
              severity: "degraded",
              observed: 90_000_000,
              budget: 21_600_000,
              category: "statistics",
            },
          ],
        },
      }),
    ).toEqual({
      criticalChecks: ["Expired leases"],
      degradedChecks: [
        "Concurrency policy blocks ready tasks on payments",
        "Queue emails has 2+ ready tasks waiting for rate-limit tokens",
        "Retention cleanup is late for task events, rolled-up statistics",
      ],
    });
    expect(healthCheckMessages({ status: { level: "healthy", reasons: [] } })).toEqual({
      criticalChecks: [],
      degradedChecks: [],
    });
  });
});
