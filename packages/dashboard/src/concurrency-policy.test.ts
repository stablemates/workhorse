import { describe, expect, it } from "vitest";
import { dashboardConcurrencyPolicySummary } from "./model.js";
import { concurrencyPolicyDegradedChecks } from "./server/read-model.js";

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

  it("degrades whenever a queue-wide or per-key budget blocks ready work", () => {
    expect(
      concurrencyPolicyDegradedChecks({
        concurrencyPolicies: { policies: [policy], capped: false },
      }),
    ).toEqual(["Concurrency policy blocks ready tasks on payments"]);
    expect(
      concurrencyPolicyDegradedChecks({
        concurrencyPolicies: {
          policies: [{ ...policy, available: 1 }],
          capped: false,
        },
      }),
    ).toEqual(["Concurrency policy blocks ready tasks on payments"]);
    expect(
      concurrencyPolicyDegradedChecks({
        concurrencyPolicies: {
          policies: [{ ...policy, blockedReady: 0 }],
          capped: false,
        },
      }),
    ).toEqual([]);
  });
});
