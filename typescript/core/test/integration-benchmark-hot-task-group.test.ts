import { describe, expect, it } from "vitest";
import { hotGroupLockSampleSql, runOperationalScenarios } from "../benchmarks/scenarios.js";
import { createIntegrationTestContext } from "./support/integration.js";

const { pool, queue, waitForDatabaseCondition } = createIntegrationTestContext(import.meta.url);

async function sampleRowWaiters(): Promise<{
  group_row_waiters: number;
  shard_row_waiters: number;
}> {
  const result = await pool.query<{ group_row_waiters: number; shard_row_waiters: number }>(
    hotGroupLockSampleSql,
  );
  return result.rows[0]!;
}

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
        "workers3WithoutGroup round 1 never waits on a shard row",
      ]),
    );
    expect(scenario!.metrics).toMatchObject({
      hotGroupTasks: 1_250,
      hotGroupWorkers: "1,3",
      workers1WithoutGroupGroupRowWaitersPeakMax: 0,
      workers3WithoutGroupGroupRowWaitersPeakMax: 0,
      workers1WithoutGroupShardRowWaitersPeakMax: 0,
      workers3WithoutGroupShardRowWaitersPeakMax: 0,
    });
    expect(scenario!.metrics).toMatchObject({
      workers3WithGroupTasksPerSecondMedian: expect.any(Number),
      workers3WithGroupTasksPerSecondMin: expect.any(Number),
      workers3WithGroupTasksPerSecondMax: expect.any(Number),
      workers3WithoutGroupDrainMedianMs: expect.any(Number),
    });
    // Three workers of four slots are fewer slots than the 32 counter shards, so a waiter is not
    // required. The test below proves that the sampler sees each kind of waiter.
    const metrics = scenario!.metrics as Record<string, number>;
    expect(metrics.hotGroupShards).toBe(32);
    expect(metrics.workers3WithGroupGroupRowWaitersPeakMax).toEqual(expect.any(Number));
    expect(metrics.workers3WithGroupShardRowContendedShareMedian).toEqual(expect.any(Number));
    expect(scenario!.metrics.workers3GroupThroughputShareMedian).toEqual(expect.any(Number));
  });

  it("counts a waiter on a shard row apart from a waiter on the group row", async () => {
    const group = await queue.createTaskGroup();
    for (const [table, condition] of [
      ["workhorse.task_group_shard", "group_id = $1 AND shard = 3"],
      ["workhorse.task_group", "id = $1"],
    ] as const) {
      const holder = await pool.connect();
      const waiter = await pool.connect();
      try {
        await holder.query("BEGIN");
        await holder.query(`SELECT 1 FROM ${table} WHERE ${condition} FOR UPDATE`, [group.id]);
        await waiter.query("BEGIN");
        const waiting = waiter.query(`SELECT 1 FROM ${table} WHERE ${condition} FOR UPDATE`, [
          group.id,
        ]);
        await waitForDatabaseCondition(async () => {
          const row = await sampleRowWaiters();
          return row.group_row_waiters + row.shard_row_waiters > 0;
        });
        expect(await sampleRowWaiters()).toMatchObject(
          table === "workhorse.task_group"
            ? { group_row_waiters: 1, shard_row_waiters: 0 }
            : { group_row_waiters: 0, shard_row_waiters: 1 },
        );
        await holder.query("ROLLBACK");
        await waiting;
        await waiter.query("ROLLBACK");
      } finally {
        holder.release();
        waiter.release();
      }
    }
  });
});
