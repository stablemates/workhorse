import { randomUUID } from "node:crypto";
import { MAX_ENQUEUE_BATCH_SIZE } from "@stablemates/workhorse";
import { describe, expect, it } from "vitest";
import { DEMO_SHARED_QUEUE, DEMO_TRAFFIC_TIERS, SHARED_WORKER_TASK_TYPE } from "./constants.js";
import { trafficBurstRequests } from "./handlers.js";

describe("demo traffic tiers", () => {
  it("adds a trickle, hourly spikes, and daily surges within one enqueue batch", () => {
    expect(DEMO_TRAFFIC_TIERS.map((tier) => [tier.tier, tier.schedule])).toEqual([
      ["trickle", "* * * * *"],
      ["spike", "7,26,48 * * * *"],
      ["surge", "38 1-23/4 * * *"],
    ]);
    for (const tier of DEMO_TRAFFIC_TIERS) {
      expect(tier.minSize).toBeGreaterThan(0);
      expect(tier.maxSize).toBeGreaterThanOrEqual(tier.minSize);
      expect(tier.maxSize).toBeLessThanOrEqual(MAX_ENQUEUE_BATCH_SIZE);
    }
  });

  it("fans one driver out to a stable, bounded burst on the shared queue", () => {
    const tier = DEMO_TRAFFIC_TIERS[1];
    const payload = { tier: tier.tier, minSize: tier.minSize, maxSize: tier.maxSize };
    const sizes = new Set<number>();
    for (let index = 0; index < 50; index += 1) {
      const driverTaskId = randomUUID();
      const requests = trafficBurstRequests(driverTaskId, payload);
      expect(trafficBurstRequests(driverTaskId, payload)).toEqual(requests);
      expect(requests.length).toBeGreaterThanOrEqual(tier.minSize);
      expect(requests.length).toBeLessThanOrEqual(tier.maxSize);
      sizes.add(requests.length);
      expect(requests[0]).toEqual({
        type: SHARED_WORKER_TASK_TYPE,
        payload: { source: "traffic-burst", tier: "spike", member: 0 },
        options: { queue: DEMO_SHARED_QUEUE, maxAttempts: 1 },
        tags: ["traffic", "spike"],
      });
    }
    expect(sizes.size).toBeGreaterThan(1);
  });
});
