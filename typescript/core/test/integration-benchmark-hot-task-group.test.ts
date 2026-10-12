import { describe, expect, it } from "vitest";
import { runOperationalScenarios } from "../benchmarks/scenarios.js";
import { createIntegrationTestContext } from "./support/integration.js";

const { pool } = createIntegrationTestContext(import.meta.url);

describe("hot task group benchmark scenario", () => {
  it("drains the same tasks with and without a group against PostgreSQL", async () => {
    const report = await runOperationalScenarios(pool, {
      scenarios: ["hot-task-group"],
      hotGroupTasks: 1_250,
      hotGroupWorkers: [1, 3],
      hotGroupConcurrency: 4,
      hotGroupRounds: 1,
    });

    const [scenario] = report.scenarios;
    expect(scenario?.name).toBe("hot-task-group");
    expect(
      scenario!.assertions.filter((assertion) => !assertion.passed),
      "failed assertions",
    ).toEqual([]);
    expect(scenario!.assertions.map((assertion) => assertion.name)).toEqual(
      expect.arrayContaining([
        "workers3WithGroup round 1 finishes the group",
        "workers3WithGroup round 1 counts every member task once",
        "workers3WithGroup round 1 enqueues the onFinish callback once",
        "workers3WithoutGroup round 1 never waits on a group row",
        "workers3WithGroup round 1 samples a waiter on the group row",
      ]),
    );
    expect(scenario!.metrics).toMatchObject({
      hotGroupTasks: 1_250,
      hotGroupWorkers: "1,3",
      workers1WithoutGroupGroupRowWaitersMax: 0,
      workers3WithoutGroupGroupRowWaitersMax: 0,
    });
    expect(scenario!.metrics.workers3WithGroupTasksPerSecondP50).toEqual(expect.any(Number));
    expect(scenario!.metrics.workers3WithGroupGroupRowWaitersMax).toBeGreaterThanOrEqual(1);
    expect(scenario!.metrics.workers3WithGroupGroupRowWaitP50Ms).toBeGreaterThan(0);
    expect(scenario!.metrics.workers3GroupThroughputShareP50).toEqual(expect.any(Number));
  });
});
