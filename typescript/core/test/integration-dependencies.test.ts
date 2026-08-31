import { setTimeout as sleep } from "node:timers/promises";
import type { PoolClient } from "pg";
import { describe, expect, it } from "vitest";
import { readDashboardJobDetail } from "../../dashboard-server/src/server/read-model.js";
import { dashboardDatabase } from "../../dashboard-server/src/server/sql.js";
import {
  DependencyCycleError,
  DependencyLimitExceededError,
  MAX_JOB_DEPENDENTS,
  type Queryable,
} from "../src/index.js";
import { createIntegrationTestContext } from "./support/integration.js";

const { defaultRetentionPolicy, pool, queue, admin } = createIntegrationTestContext(
  import.meta.url,
);

const insertDependency = (client: PoolClient, dependentJobId: string, prerequisiteJobId: string) =>
  client.query(
    `INSERT INTO workhorse.job_dependency(
       dependent_job_id, prerequisite_job_id, on_success, on_failure, on_cancellation
     ) VALUES ($1, $2, 'release', 'fail', 'cancel')`,
    [dependentJobId, prerequisiteJobId],
  );

describe("job dependencies", () => {
  it("maps dependency cycle diagnostics through the public enqueue API", async () => {
    const details = {
      dependentJobId: "123e4567-e89b-42d3-a456-426614174000",
      prerequisiteJobId: "123e4567-e89b-42d3-a456-426614174001",
      cycleJobIds: ["123e4567-e89b-42d3-a456-426614174000", "123e4567-e89b-42d3-a456-426614174001"],
      truncated: false,
    };
    const transaction: Queryable = {
      async query() {
        throw { code: "P1003", detail: JSON.stringify(details) };
      },
    };

    const error = await queue
      .enqueue("cycle-mapping", null, {}, transaction)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(DependencyCycleError);
    expect(error).toMatchObject({ details, ...details });
  });

  it("does not invent a dependency bound for malformed diagnostics", async () => {
    const transaction: Queryable = {
      async query() {
        throw { code: "P1005", detail: JSON.stringify({ jobId: "partial" }) };
      },
    };

    const error = await queue
      .enqueue("limit-mapping", null, {}, transaction)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(DependencyLimitExceededError);
    expect(error).toMatchObject({ jobId: "unknown", limit: "unknown", max: MAX_JOB_DEPENDENTS });
  });

  it("reports bounded prerequisite and dependent lineage with release evidence", async () => {
    const firstId = await queue.enqueue("lineage-first", null);
    const secondId = await queue.enqueue("lineage-second", null);
    const dependentId = await queue.enqueue("lineage-dependent", null, {
      dependencies: {
        prerequisiteJobIds: [firstId, secondId],
        onSuccess: "release",
        onFailure: "fail",
        onCancellation: "cancel",
      },
    });

    await expect(admin.getDependencyLineage(firstId)).resolves.toEqual({
      records: [
        {
          dependentJobId: dependentId,
          prerequisiteJobId: firstId,
          onSuccess: "release",
          onFailure: "fail",
          onCancellation: "cancel",
          createdAt: expect.any(Date),
          releasedAt: null,
          resolution: null,
        },
      ],
      truncated: false,
    });
    await expect(readDashboardJobDetail(dashboardDatabase(pool), firstId)).resolves.toMatchObject({
      dependencyLineage: {
        records: [
          expect.objectContaining({
            dependentJobId: dependentId,
            prerequisiteJobId: firstId,
            onFailure: "fail",
            releasedAt: null,
          }),
        ],
        truncated: false,
      },
    });

    const first = await queue.claim("lineage-first-worker");
    expect(first?.id).toBe(firstId);
    expect(await queue.complete(first!, "lineage-first-worker", null)).toBe(true);

    const dependentLineage = await admin.getDependencyLineage(dependentId);
    expect(dependentLineage.records).toContainEqual(
      expect.objectContaining({
        dependentJobId: dependentId,
        prerequisiteJobId: firstId,
        releasedAt: expect.any(Date),
        resolution: "release",
      }),
    );
    await expect(admin.getDependencyLineage(dependentId, 1)).resolves.toMatchObject({
      records: [expect.any(Object)],
      truncated: true,
    });
  });

  it("exposes blocked depth, pending edges, and policy failures through health", async () => {
    const blockedPrerequisiteId = await queue.enqueue("health-blocked-prerequisite", null);
    await queue.enqueue("health-blocked-dependent", null, {
      prerequisiteJobId: blockedPrerequisiteId,
    });
    const failingPrerequisiteId = await queue.enqueue("health-failing-prerequisite", null, {
      maxAttempts: 1,
    });
    await queue.enqueue("health-failed-dependent", null, {
      dependencies: {
        prerequisiteJobIds: [failingPrerequisiteId],
        onSuccess: "release",
        onFailure: "fail",
        onCancellation: "cancel",
      },
    });
    const first = await queue.claim("health-dependency-worker-1");
    const second = await queue.claim("health-dependency-worker-2");
    expect(first?.id).toBe(blockedPrerequisiteId);
    expect(second?.id).toBe(failingPrerequisiteId);
    expect(
      await queue.fail(second!, "health-dependency-worker-2", new Error("expected failure")),
    ).toBe("failed");

    const health = await queue.health();
    expect(health.dependencies).toEqual({
      blockedJobs: 1,
      pendingEdges: 1,
      failedResolutions: 1,
      retentionPruneStarved: false,
      capped: false,
    });
  });

  it("uses diagnostic partial indexes for dependency health counts", async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL enable_seqscan = off");
      const blockedPlan = (
        await client.query<{ "QUERY PLAN": string }>(`EXPLAIN (COSTS OFF)
          SELECT 1 FROM workhorse.job_runtime runtime
           WHERE runtime.queue_name = 'dependency-health'
             AND runtime.state = 'blocked'
           LIMIT 10001`)
      ).rows
        .map((row) => row["QUERY PLAN"])
        .join("\n");
      const pendingPlan = (
        await client.query<{ "QUERY PLAN": string }>(`EXPLAIN (COSTS OFF)
          SELECT 1 FROM workhorse.job_runtime runtime
          JOIN workhorse.job_dependency edge ON edge.dependent_job_id = runtime.job_id
           WHERE runtime.queue_name = 'dependency-health'
             AND runtime.state = 'blocked'
             AND edge.released_at IS NULL
           LIMIT 10001`)
      ).rows
        .map((row) => row["QUERY PLAN"])
        .join("\n");

      expect(blockedPlan).toContain("job_runtime_blocked_queue_idx");
      expect(pendingPlan).toContain("job_runtime_blocked_queue_idx");
      expect(pendingPlan).toContain("job_dependency_dependent_pending_idx");
      await client.query("ROLLBACK");
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
    }
  });

  it("releases fan-in only after every prerequisite succeeds", async () => {
    const firstId = await queue.enqueue("fan-in-first", null);
    const secondId = await queue.enqueue("fan-in-second", null);
    const dependentId = await queue.enqueue("fan-in-dependent", null, {
      dependencies: {
        prerequisiteJobIds: [firstId, secondId],
        onSuccess: "release",
        onFailure: "fail",
        onCancellation: "cancel",
      },
    });
    const expectedPrerequisiteIds = [firstId, secondId];
    // oxlint-disable-next-line unicorn/no-array-sort -- ES2022 lacks Array.prototype.toSorted.
    expectedPrerequisiteIds.sort();

    await expect(admin.getJob(dependentId)).resolves.toMatchObject({
      state: "blocked",
      prerequisiteJobIds: expectedPrerequisiteIds,
    });
    const first = await queue.claim("fan-in-first-worker");
    expect(first?.id).toBe(firstId);
    expect(await queue.complete(first!, "fan-in-first-worker", null)).toBe(true);
    await expect(admin.getJob(dependentId)).resolves.toMatchObject({ state: "blocked" });

    const second = await queue.claim("fan-in-second-worker");
    expect(second?.id).toBe(secondId);
    expect(await queue.complete(second!, "fan-in-second-worker", null)).toBe(true);
    await expect(admin.getJob(dependentId)).resolves.toMatchObject({ state: "ready" });
  });

  it("bounds each prerequisite to 100 dependent jobs", async () => {
    const prerequisiteId = await queue.enqueue("fan-out-prerequisite", null);
    const dependentIds = await queue.enqueueMany(
      Array.from({ length: MAX_JOB_DEPENDENTS }, (_unused, index) => ({
        type: "fan-out-dependent",
        payload: { index },
        options: { prerequisiteJobId: prerequisiteId },
      })),
    );

    expect(dependentIds).toHaveLength(MAX_JOB_DEPENDENTS);
    const overflow = await queue
      .enqueue("fan-out-overflow", null, { prerequisiteJobId: prerequisiteId })
      .catch((error: unknown) => error);
    expect(overflow).toBeInstanceOf(DependencyLimitExceededError);
    expect(overflow).toMatchObject({
      jobId: prerequisiteId,
      limit: "dependents",
      max: MAX_JOB_DEPENDENTS,
    });
    const lineage = await admin.getDependencyLineage(prerequisiteId);
    expect(lineage.records).toHaveLength(MAX_JOB_DEPENDENTS);
    expect(lineage.truncated).toBe(false);
  });

  it("bounds one settlement cascade to 100 unresolved descendants", async () => {
    const rootId = await queue.enqueue("cascade-root", null);
    let prerequisiteId = rootId;
    for (let index = 0; index < MAX_JOB_DEPENDENTS; index += 1) {
      prerequisiteId = await queue.enqueue(
        "cascade-dependent",
        { index },
        {
          prerequisiteJobId: prerequisiteId,
        },
      );
    }

    const overflow = await queue
      .enqueue("cascade-overflow", null, { prerequisiteJobId: prerequisiteId })
      .catch((error: unknown) => error);
    expect(overflow).toBeInstanceOf(DependencyLimitExceededError);
    expect(overflow).toMatchObject({
      jobId: rootId,
      limit: "unresolved_dependents",
      max: MAX_JOB_DEPENDENTS,
    });
    await expect(
      queue.cancel(rootId, { requestedBy: "cascade-bound-test" }),
    ).resolves.toMatchObject({ status: "canceled" });
    await expect(admin.getJob(prerequisiteId)).resolves.toMatchObject({ state: "canceled" });
  });

  it("fails a dependent when a prerequisite failure selects the fail policy", async () => {
    const prerequisiteId = await queue.enqueue("failing-prerequisite", null, { maxAttempts: 1 });
    const dependentId = await queue.enqueue("failed-dependent", null, {
      dependencies: {
        prerequisiteJobIds: [prerequisiteId],
        onSuccess: "release",
        onFailure: "fail",
        onCancellation: "cancel",
      },
    });
    const prerequisite = await queue.claim("failing-prerequisite-worker");
    expect(prerequisite?.id).toBe(prerequisiteId);

    expect(await queue.fail(prerequisite!, "failing-prerequisite-worker", new Error("nope"))).toBe(
      "failed",
    );
    await expect(admin.getJob(dependentId)).resolves.toMatchObject({
      state: "failed",
      error: expect.objectContaining({
        name: "DependencyFailed",
        prerequisite_job_id: prerequisiteId,
      }),
    });
  });

  it("applies the declared policy to prerequisite success", async () => {
    const prerequisiteId = await queue.enqueue("successful-prerequisite", null);
    const dependentId = await queue.enqueue("success-policy-dependent", null, {
      dependencies: {
        prerequisiteJobIds: [prerequisiteId],
        onSuccess: "cancel",
        onFailure: "fail",
        onCancellation: "cancel",
      },
    });
    const prerequisite = await queue.claim("successful-prerequisite-worker");
    expect(prerequisite?.id).toBe(prerequisiteId);
    expect(await queue.complete(prerequisite!, "successful-prerequisite-worker", null)).toBe(true);
    await expect(admin.getJob(dependentId)).resolves.toMatchObject({ state: "canceled" });
  });

  it("cancels a dependent when a prerequisite cancellation selects the cancel policy", async () => {
    const prerequisiteId = await queue.enqueue("canceled-prerequisite", null);
    const dependentId = await queue.enqueue("canceled-dependent", null, {
      dependencies: {
        prerequisiteJobIds: [prerequisiteId],
        onSuccess: "release",
        onFailure: "fail",
        onCancellation: "cancel",
      },
    });

    await expect(
      queue.cancel(prerequisiteId, { requestedBy: "dependency-test" }),
    ).resolves.toMatchObject({
      status: "canceled",
    });
    await expect(admin.getJob(dependentId)).resolves.toMatchObject({
      state: "canceled",
      error: expect.objectContaining({
        name: "DependencyCanceled",
        prerequisite_job_id: prerequisiteId,
      }),
    });
  });

  it("accepts mixed terminal outcomes when both policies release", async () => {
    const succeededId = await queue.enqueue("accepted-success", null);
    const failedId = await queue.enqueue("accepted-failure", null, { maxAttempts: 1 });
    const canceledId = await queue.enqueue("accepted-cancellation", null);
    const dependentId = await queue.enqueue("mixed-dependent", null, {
      dependencies: {
        prerequisiteJobIds: [succeededId, failedId, canceledId],
        onSuccess: "release",
        onFailure: "release",
        onCancellation: "release",
      },
    });

    const succeeded = await queue.claim("accepted-success-worker");
    expect(succeeded?.id).toBe(succeededId);
    expect(await queue.complete(succeeded!, "accepted-success-worker", null)).toBe(true);
    const failed = await queue.claim("accepted-failure-worker");
    expect(failed?.id).toBe(failedId);
    expect(await queue.fail(failed!, "accepted-failure-worker", new Error("accepted"))).toBe(
      "failed",
    );
    await expect(admin.getJob(dependentId)).resolves.toMatchObject({ state: "blocked" });

    await expect(queue.cancel(canceledId)).resolves.toMatchObject({ status: "canceled" });
    await expect(admin.getJob(dependentId)).resolves.toMatchObject({ state: "ready" });
  });

  it("records why each terminal prerequisite policy released a dependent", async () => {
    const releaseReason = async (dependentId: string): Promise<string | undefined> => {
      const evidence = await pool.query<{ reason: string }>(
        `SELECT details->>'reason' AS reason
           FROM workhorse.job_event
          WHERE job_id = $1 AND event_type = 'dependency_released'`,
        [dependentId],
      );
      return evidence.rows[0]?.reason;
    };

    const succeededId = await queue.enqueue("release-reason-success", null);
    const succeededDependentId = await queue.enqueue("release-reason-success-dependent", null, {
      dependencies: {
        prerequisiteJobIds: [succeededId],
        onSuccess: "release",
        onFailure: "fail",
        onCancellation: "cancel",
      },
    });
    const succeeded = await queue.claim("release-reason-success-worker");
    expect(succeeded?.id).toBe(succeededId);
    expect(await queue.complete(succeeded!, "release-reason-success-worker", null)).toBe(true);
    await expect(releaseReason(succeededDependentId)).resolves.toBe("prerequisite_succeeded");
    await expect(queue.cancel(succeededDependentId)).resolves.toMatchObject({ status: "canceled" });

    const failedId = await queue.enqueue("release-reason-failure", null, { maxAttempts: 1 });
    const failedDependentId = await queue.enqueue("release-reason-failure-dependent", null, {
      dependencies: {
        prerequisiteJobIds: [failedId],
        onSuccess: "release",
        onFailure: "release",
        onCancellation: "cancel",
      },
    });
    const failed = await queue.claim("release-reason-failure-worker");
    expect(failed?.id).toBe(failedId);
    expect(await queue.fail(failed!, "release-reason-failure-worker", new Error("expected"))).toBe(
      "failed",
    );
    await expect(releaseReason(failedDependentId)).resolves.toBe("prerequisite_failed_policy");
    await expect(queue.cancel(failedDependentId)).resolves.toMatchObject({ status: "canceled" });

    const canceledId = await queue.enqueue("release-reason-cancellation", null);
    const canceledDependentId = await queue.enqueue("release-reason-cancellation-dependent", null, {
      dependencies: {
        prerequisiteJobIds: [canceledId],
        onSuccess: "release",
        onFailure: "fail",
        onCancellation: "release",
      },
    });
    await expect(queue.cancel(canceledId)).resolves.toMatchObject({ status: "canceled" });
    await expect(releaseReason(canceledDependentId)).resolves.toBe("prerequisite_canceled_policy");
  });

  it("applies policy to prerequisites which are terminal before enqueue", async () => {
    const prerequisiteId = await queue.enqueue("already-failed-prerequisite", null, {
      maxAttempts: 1,
    });
    const prerequisite = await queue.claim("already-failed-worker");
    expect(prerequisite?.id).toBe(prerequisiteId);
    expect(await queue.fail(prerequisite!, "already-failed-worker", new Error("done"))).toBe(
      "failed",
    );

    const releasedId = await queue.enqueue("released-after-failure", null, {
      dependencies: {
        prerequisiteJobIds: [prerequisiteId],
        onSuccess: "release",
        onFailure: "release",
        onCancellation: "cancel",
      },
    });
    await expect(admin.getJob(releasedId)).resolves.toMatchObject({ state: "ready" });

    const failedId = await queue.enqueue("failed-after-failure", null, {
      dependencies: {
        prerequisiteJobIds: [prerequisiteId],
        onSuccess: "release",
        onFailure: "fail",
        onCancellation: "cancel",
      },
    });
    await expect(admin.getJob(failedId)).resolves.toMatchObject({
      state: "failed",
      error: expect.objectContaining({ name: "DependencyFailed" }),
    });
  });

  it("rejects direct and transitive dependency cycles with bounded details", async () => {
    const firstId = await queue.enqueue("cycle-first", null);
    const secondId = await queue.enqueue("cycle-second", null);
    const thirdId = await queue.enqueue("cycle-third", null);
    const fourthId = await queue.enqueue("cycle-fourth", null);
    await pool.query(
      `INSERT INTO workhorse.job_dependency(
         dependent_job_id, prerequisite_job_id, on_success, on_failure, on_cancellation
       ) VALUES ($1, $2, 'release', 'fail', 'cancel'),
                ($2, $3, 'release', 'fail', 'cancel')`,
      [firstId, secondId, thirdId],
    );

    let cycleError: unknown;
    try {
      await pool.query(
        `INSERT INTO workhorse.job_dependency(
         dependent_job_id, prerequisite_job_id, on_success, on_failure, on_cancellation
         ) VALUES ($1, $2, 'release', 'fail', 'cancel'),
                  ($2, $3, 'release', 'fail', 'cancel')`,
        [fourthId, thirdId, firstId],
      );
    } catch (error) {
      cycleError = error;
    }
    expect(cycleError).toMatchObject({
      code: "P1003",
      detail: expect.stringContaining('"cycleJobIds"'),
    });
    const cycleDetails = JSON.parse((cycleError as { detail: string }).detail) as {
      cycleJobIds: string[];
      truncated: boolean;
    };
    expect(cycleDetails.cycleJobIds.length).toBeLessThanOrEqual(101);
    expect(cycleDetails.truncated).toBe(false);
    await expect(
      pool.query<{ count: number }>(
        `SELECT count(*)::integer AS count
           FROM workhorse.job_dependency
          WHERE dependent_job_id = $1 AND prerequisite_job_id = $2`,
        [fourthId, thirdId],
      ),
    ).resolves.toMatchObject({ rows: [{ count: 0 }] });
    await expect(
      pool.query(
        `INSERT INTO workhorse.job_dependency(
           dependent_job_id, prerequisite_job_id, on_success, on_failure, on_cancellation
         ) VALUES ($1, $1, 'release', 'fail', 'cancel')`,
        [firstId],
      ),
    ).rejects.toMatchObject({ code: "P1003" });
  });

  it("does not serialize dependency inserts across disconnected graph components", async () => {
    const [firstDependentId, firstPrerequisiteId, secondDependentId, secondPrerequisiteId] =
      await queue.enqueueMany([
        { type: "component-lock-first-dependent", payload: null },
        { type: "component-lock-first-prerequisite", payload: null },
        { type: "component-lock-second-dependent", payload: null },
        { type: "component-lock-second-prerequisite", payload: null },
      ]);
    if (!firstDependentId || !firstPrerequisiteId || !secondDependentId || !secondPrerequisiteId) {
      throw new Error("component lock setup did not enqueue every job");
    }
    const first = await pool.connect();
    const second = await pool.connect();
    try {
      await first.query("BEGIN");
      await insertDependency(first, firstDependentId, firstPrerequisiteId);

      await second.query("BEGIN");
      await second.query("SET LOCAL lock_timeout = '100ms'");
      await expect(
        insertDependency(second, secondDependentId, secondPrerequisiteId),
      ).resolves.toMatchObject({ rowCount: 1 });
    } finally {
      await Promise.allSettled([first.query("ROLLBACK"), second.query("ROLLBACK")]);
      first.release();
      second.release();
    }
  });

  it("serializes opposite dependency inserts and rejects the resulting cycle", async () => {
    const [firstId, secondId] = await queue.enqueueMany([
      { type: "component-cycle-first", payload: null },
      { type: "component-cycle-second", payload: null },
    ]);
    if (!firstId || !secondId) throw new Error("component cycle setup did not enqueue every job");
    const first = await pool.connect();
    const second = await pool.connect();
    let secondSettled = false;
    try {
      await first.query("BEGIN");
      await insertDependency(first, firstId, secondId);

      await second.query("BEGIN");
      const oppositeInsert = insertDependency(second, secondId, firstId)
        .then(
          (result) => ({ result }),
          (error: unknown) => ({ error }),
        )
        .finally(() => {
          secondSettled = true;
        });
      await sleep(50);
      expect(secondSettled).toBe(false);

      await first.query("COMMIT");
      await expect(oppositeInsert).resolves.toMatchObject({ error: { code: "P1003" } });
    } finally {
      await Promise.allSettled([first.query("ROLLBACK"), second.query("ROLLBACK")]);
      first.release();
      second.release();
    }
  });

  it("keeps a waiting component mutation serialized after another transaction merges its component", async () => {
    const ids = await queue.enqueueMany(
      Array.from({ length: 4 }, (_unused, index) => ({
        type: "component-merge-lock",
        payload: { index },
      })),
    );
    // oxlint-disable-next-line unicorn/no-array-sort -- this package targets ES2022 without Array.toSorted.
    const [lowerId, upperId, thirdId, fourthId] = [...ids].sort();
    if (!lowerId || !upperId || !thirdId || !fourthId) {
      throw new Error("component merge setup did not enqueue every job");
    }
    const merger = await pool.connect();
    const waiter = await pool.connect();
    const follower = await pool.connect();
    let waiterSettled = false;
    try {
      await merger.query("BEGIN");
      await insertDependency(merger, lowerId, upperId);

      await waiter.query("BEGIN");
      const waitingInsert = insertDependency(waiter, upperId, thirdId).finally(() => {
        waiterSettled = true;
      });
      await sleep(50);
      expect(waiterSettled).toBe(false);

      await merger.query("COMMIT");
      await expect(waitingInsert).resolves.toMatchObject({ rowCount: 1 });

      await follower.query("BEGIN");
      await follower.query("SET LOCAL lock_timeout = '100ms'");
      await expect(insertDependency(follower, lowerId, fourthId)).rejects.toMatchObject({
        code: "55P03",
      });
    } finally {
      await Promise.allSettled([
        merger.query("ROLLBACK"),
        waiter.query("ROLLBACK"),
        follower.query("ROLLBACK"),
      ]);
      merger.release();
      waiter.release();
      follower.release();
    }
  });

  it("chooses fail deterministically when failure and cancellation complete concurrently", async () => {
    const failedId = await queue.enqueue("mixed-race-failure", null, { maxAttempts: 1 });
    const canceledId = await queue.enqueue("mixed-race-cancellation", null);
    const dependentId = await queue.enqueue("mixed-race-dependent", null, {
      dependencies: {
        prerequisiteJobIds: [failedId, canceledId],
        onSuccess: "release",
        onFailure: "fail",
        onCancellation: "cancel",
      },
    });
    const failed = await queue.claim("mixed-race-worker");
    expect(failed?.id).toBe(failedId);

    await Promise.all([
      queue.fail(failed!, "mixed-race-worker", new Error("failed")),
      queue.cancel(canceledId),
    ]);
    await expect(admin.getJob(dependentId)).resolves.toMatchObject({
      state: "failed",
      error: expect.objectContaining({ name: "DependencyFailed" }),
    });
  });

  it("releases fan-in once under concurrent prerequisite completion", async () => {
    const [firstId, secondId] = await queue.enqueueMany([
      { type: "concurrent-first", payload: null },
      { type: "concurrent-second", payload: null },
    ]);
    const dependentId = await queue.enqueue("concurrent-dependent", null, {
      dependencies: {
        prerequisiteJobIds: [firstId!, secondId!],
        onSuccess: "release",
        onFailure: "fail",
        onCancellation: "cancel",
      },
    });
    const first = await queue.claim("concurrent-worker-1");
    const second = await queue.claim("concurrent-worker-2");
    const actualIds = [first?.id, second?.id];
    const expectedIds = [firstId, secondId];
    // oxlint-disable-next-line unicorn/no-array-sort -- ES2022 lacks Array.prototype.toSorted.
    actualIds.sort();
    // oxlint-disable-next-line unicorn/no-array-sort -- ES2022 lacks Array.prototype.toSorted.
    expectedIds.sort();
    expect(actualIds).toEqual(expectedIds);

    await expect(
      Promise.all([
        queue.complete(first!, "concurrent-worker-1", null),
        queue.complete(second!, "concurrent-worker-2", null),
      ]),
    ).resolves.toEqual([true, true]);
    await expect(admin.getJob(dependentId)).resolves.toMatchObject({ state: "ready" });
    await expect(
      pool.query<{ count: number }>(
        `SELECT count(*)::integer AS count FROM workhorse.job_event
          WHERE job_id = $1 AND event_type = 'dependency_released'`,
        [dependentId],
      ),
    ).resolves.toMatchObject({ rows: [{ count: 1 }] });
  });

  it("settles a dependent deterministically when cancellation races completion", async () => {
    const prerequisiteId = await queue.enqueue("racing-cancel-prerequisite", null);
    const dependentId = await queue.enqueue("racing-cancel-dependent", null, {
      dependencies: {
        prerequisiteJobIds: [prerequisiteId],
        onSuccess: "release",
        onFailure: "fail",
        onCancellation: "cancel",
      },
    });
    const prerequisite = await queue.claim("racing-cancel-worker");
    expect(prerequisite?.id).toBe(prerequisiteId);

    const [cancellation, completed] = await Promise.all([
      queue.cancel(prerequisiteId, { requestedBy: "race-test" }),
      queue.complete(prerequisite!, "racing-cancel-worker", null),
    ]);
    const acknowledged = completed
      ? null
      : await queue.acknowledgeCancel(prerequisite!, "racing-cancel-worker");
    const dependent = await admin.getJob(dependentId);
    expect({
      completed,
      cancellation: cancellation.status,
      acknowledged,
      state: dependent?.state,
    }).toEqual(
      completed
        ? {
            completed: true,
            cancellation: "already_terminal",
            acknowledged: null,
            state: "ready",
          }
        : {
            completed: false,
            cancellation: "cancel_requested",
            acknowledged: true,
            state: "canceled",
          },
    );
  });

  it("enforces unique prerequisite identities and the fan-in bound", async () => {
    const prerequisiteIds = await queue.enqueueMany(
      Array.from({ length: 101 }, (_, index) => ({
        type: `bounded-prerequisite-${index}`,
        payload: null,
      })),
    );
    await expect(
      queue.enqueue("duplicate-dependent", null, {
        dependencies: {
          prerequisiteJobIds: [prerequisiteIds[0]!, prerequisiteIds[0]!],
          onSuccess: "release",
          onFailure: "fail",
          onCancellation: "cancel",
        },
      }),
    ).rejects.toThrow(/must be unique/);
    await expect(
      queue.enqueue("oversized-dependent", null, {
        dependencies: {
          prerequisiteJobIds: prerequisiteIds,
          onSuccess: "release",
          onFailure: "fail",
          onCancellation: "cancel",
        },
      }),
    ).rejects.toThrow(/between 1 and 100/);
    const boundedDependentId = await queue.enqueue("bounded-dependent", null, {
      dependencies: {
        prerequisiteJobIds: prerequisiteIds.slice(0, 100),
        onSuccess: "release",
        onFailure: "fail",
        onCancellation: "cancel",
      },
    });
    expect(boundedDependentId).toEqual(expect.any(String));
    const claims = [];
    for (let index = 0; index < 100; index += 1) {
      claims.push(await queue.claim(`bounded-worker-${index}`));
    }
    await Promise.all(
      claims.map((claim, index) => queue.complete(claim!, `bounded-worker-${index}`, null)),
    );
    await expect(admin.getJob(boundedDependentId)).resolves.toMatchObject({ state: "ready" });
  });

  it("keeps a dependent outside dispatch until its prerequisite succeeds", async () => {
    const prerequisiteId = await queue.enqueue("prerequisite", { step: 1 });
    const dependentId = await queue.enqueue(
      "dependent",
      { step: 2 },
      { prerequisiteJobId: prerequisiteId },
    );

    await expect(admin.getJob(dependentId)).resolves.toMatchObject({
      state: "blocked",
      prerequisiteJobId: prerequisiteId,
      blockedReason: "prerequisite_pending",
    });
    await expect(admin.listJobs({ states: ["blocked"] })).resolves.toMatchObject({
      items: [expect.objectContaining({ id: dependentId, prerequisiteJobId: prerequisiteId })],
    });
    await expect(
      readDashboardJobDetail(dashboardDatabase(pool), dependentId),
    ).resolves.toMatchObject({
      identity: {
        prerequisiteJobId: prerequisiteId,
        dependencyReleasedAt: null,
        blockedReason: "prerequisite_pending",
      },
    });

    const firstClaim = await queue.claim("dependency-worker");
    expect(firstClaim?.id).toBe(prerequisiteId);
    await expect(queue.claim("dependency-competitor")).resolves.toBeNull();

    const completions = await Promise.all([
      queue.complete(firstClaim!, "dependency-worker", { ok: true }),
      queue.complete(firstClaim!, "dependency-worker", { ok: true }),
    ]);
    expect(completions).toEqual(expect.arrayContaining([false, true]));

    await expect(admin.getJob(dependentId)).resolves.toMatchObject({
      state: "ready",
      prerequisiteJobId: prerequisiteId,
      blockedReason: null,
    });
    await expect(
      readDashboardJobDetail(dashboardDatabase(pool), dependentId),
    ).resolves.toMatchObject({
      identity: {
        prerequisiteJobId: prerequisiteId,
        dependencyReleasedAt: expect.any(String),
        blockedReason: null,
      },
    });
    const released = await queue.claim("dependency-successor");
    expect(released?.id).toBe(dependentId);

    const evidence = await pool.query<{ event_type: string; prerequisite_job_id: string }>(
      `SELECT event.event_type, event.details->>'prerequisite_job_id' AS prerequisite_job_id
         FROM workhorse.job_event event
        WHERE event.job_id = $1 AND event.event_type IN ('dependency_blocked', 'dependency_released')
        ORDER BY event.occurred_at, event.event_id`,
      [dependentId],
    );
    expect(evidence.rows).toEqual([
      { event_type: "dependency_blocked", prerequisite_job_id: prerequisiteId },
      { event_type: "dependency_released", prerequisite_job_id: prerequisiteId },
    ]);
  });

  it("dispatches a released dependent by its stored priority", async () => {
    const prerequisiteQueue = "dependency-priority-prerequisite";
    const workQueue = "dependency-priority-work";
    const prerequisiteId = await queue.enqueue("dependency-priority-prerequisite", null, {
      queue: prerequisiteQueue,
    });
    const ordinaryId = await queue.enqueue(
      "dependency-priority-work",
      { class: "ordinary" },
      {
        queue: workQueue,
        priority: 50,
      },
    );
    const urgentId = await queue.enqueue(
      "dependency-priority-work",
      { class: "urgent" },
      {
        queue: workQueue,
        priority: 90,
        prerequisiteJobId: prerequisiteId,
      },
    );

    const prerequisite = await queue.claim("dependency-priority-prerequisite-worker", {
      queue: prerequisiteQueue,
    });
    expect(prerequisite?.id).toBe(prerequisiteId);
    await expect(
      queue.complete(prerequisite!, "dependency-priority-prerequisite-worker", null),
    ).resolves.toBe(true);

    const first = await queue.claim("dependency-priority-work-worker", { queue: workQueue });
    expect(first).toMatchObject({ id: urgentId, priority: 90 });
    await expect(queue.complete(first!, "dependency-priority-work-worker", null)).resolves.toBe(
      true,
    );
    await expect(
      queue.claim("dependency-priority-work-worker", { queue: workQueue }),
    ).resolves.toMatchObject({ id: ordinaryId, priority: 50 });
  });

  it("redrives a failed dependent without copying its dependency edges", async () => {
    const prerequisiteQueue = "dependency-redrive-prerequisite";
    const workQueue = "dependency-redrive-work";
    const prerequisiteId = await queue.enqueue("dependency-redrive-prerequisite", null, {
      queue: prerequisiteQueue,
    });
    const dependentId = await queue.enqueue("dependency-redrive-work", null, {
      queue: workQueue,
      maxAttempts: 1,
      prerequisiteJobId: prerequisiteId,
    });
    const prerequisite = await queue.claim("dependency-redrive-prerequisite-worker", {
      queue: prerequisiteQueue,
    });
    await queue.complete(prerequisite!, "dependency-redrive-prerequisite-worker", null);
    const dependent = await queue.claim("dependency-redrive-work-worker", { queue: workQueue });
    await expect(
      queue.fail(dependent!, "dependency-redrive-work-worker", new Error("dependency work failed")),
    ).resolves.toBe("failed");

    const redrive = await admin.redrive(dependentId, {
      actor: "dependency-test",
      reason: "retry with repaired input",
      requestId: `dependency-redrive-${dependentId}`,
    });
    expect(redrive.status).toBe("redriven");
    const targetId = redrive.targetJobId!;
    await expect(admin.getJob(targetId)).resolves.toMatchObject({
      state: "ready",
      prerequisiteJobId: null,
      prerequisiteJobIds: [],
    });
    await expect(admin.getDependencyLineage(targetId)).resolves.toEqual({
      records: [],
      truncated: false,
    });
    await expect(admin.getDependencyLineage(dependentId)).resolves.toMatchObject({
      records: [
        expect.objectContaining({
          dependentJobId: dependentId,
          prerequisiteJobId: prerequisiteId,
        }),
      ],
      truncated: false,
    });
    await expect(
      queue.claim("dependency-redrive-target-worker", { queue: workQueue }),
    ).resolves.toMatchObject({ id: targetId });
  });

  it("preserves a dependent schedule when success releases it", async () => {
    const prerequisiteId = await queue.enqueue("delayed-prerequisite", null);
    const runAt = new Date(Date.now() + 40);
    const dependentId = await queue.enqueue("delayed-dependent", null, {
      prerequisiteJobId: prerequisiteId,
      runAt,
    });
    const claimed = await queue.claim("delayed-dependency-worker");
    expect(claimed?.id).toBe(prerequisiteId);
    expect(await queue.complete(claimed!, "delayed-dependency-worker", null)).toBe(true);
    await expect(admin.getJob(dependentId)).resolves.toMatchObject({ state: "scheduled", runAt });
    await sleep(50);
    expect(await queue.promote()).toBe(1);
    await expect(admin.getJob(dependentId)).resolves.toMatchObject({ state: "ready" });
  });

  it("serializes dependency creation with prerequisite completion", async () => {
    const prerequisiteId = await queue.enqueue("racing-prerequisite", null);
    const claimed = await queue.claim("racing-dependency-worker");
    expect(claimed?.id).toBe(prerequisiteId);

    const transaction = await pool.connect();
    await transaction.query("BEGIN");
    await transaction.query("SELECT id FROM workhorse.job WHERE id = $1 FOR UPDATE", [
      prerequisiteId,
    ]);
    const completion = queue.complete(claimed!, "racing-dependency-worker", null);
    const dependentId = await queue.enqueue(
      "racing-dependent",
      null,
      { prerequisiteJobId: prerequisiteId },
      transaction,
    );
    await transaction.query("COMMIT");
    transaction.release();

    await expect(completion).resolves.toBe(true);
    await expect(admin.getJob(dependentId)).resolves.toMatchObject({
      state: "ready",
      prerequisiteJobId: prerequisiteId,
      blockedReason: null,
    });
  });

  it("validates dependency identity and keeps enqueue transactional and idempotent", async () => {
    await expect(
      queue.enqueue("missing-dependent", null, {
        prerequisiteJobId: "00000000-0000-4000-8000-000000000001",
      }),
    ).rejects.toThrow(/prerequisite job does not exist/);
    await expect(
      pool.query("SELECT count(*)::integer AS count FROM workhorse.job"),
    ).resolves.toMatchObject({
      rows: [{ count: 0 }],
    });

    const prerequisiteId = await queue.enqueue("transaction-prerequisite", null);
    const transaction = await pool.connect();
    await transaction.query("BEGIN");
    const rolledBackId = await queue.enqueue(
      "rolled-back-dependent",
      null,
      { prerequisiteJobId: prerequisiteId },
      transaction,
    );
    await transaction.query("ROLLBACK");
    transaction.release();
    await expect(admin.getJob(rolledBackId)).resolves.toBeNull();

    const idempotency = { key: "dependency-replay", scope: "dependencies" };
    const acceptedId = await queue.enqueue("idempotent-dependent", null, {
      prerequisiteJobId: prerequisiteId,
      idempotency,
    });
    await expect(
      queue.enqueue("idempotent-dependent", null, {
        prerequisiteJobId: prerequisiteId,
        idempotency,
      }),
    ).resolves.toBe(acceptedId);

    const otherPrerequisiteId = await queue.enqueue("other-prerequisite", null);
    await expect(
      queue.enqueue("idempotent-dependent", null, {
        prerequisiteJobId: otherPrerequisiteId,
        idempotency,
      }),
    ).rejects.toMatchObject({
      details: { conflictingFields: ["prerequisiteJobId"] },
    });

    await expect(
      pool.query("DELETE FROM workhorse.job WHERE id = $1", [prerequisiteId]),
    ).rejects.toThrow(/job_dependency_prerequisite_job_id_fkey/);
    await expect(admin.getJob(acceptedId)).resolves.toMatchObject({ state: "blocked" });
  });

  it("compacts released edges before pruning an older prerequisite", async () => {
    const prerequisiteId = await queue.enqueue("retained-prerequisite", null);
    const dependentId = await queue.enqueue("retained-dependent", null, {
      prerequisiteJobId: prerequisiteId,
    });
    const prerequisite = await queue.claim("retention-prerequisite-worker");
    expect(prerequisite?.id).toBe(prerequisiteId);
    expect(await queue.complete(prerequisite!, "retention-prerequisite-worker", null)).toBe(true);
    const dependent = await queue.claim("retention-dependent-worker");
    expect(dependent?.id).toBe(dependentId);
    expect(await queue.complete(dependent!, "retention-dependent-worker", null)).toBe(true);

    await pool.query("DELETE FROM workhorse.job_event WHERE job_id = ANY($1::uuid[])", [
      [prerequisiteId, dependentId],
    ]);
    await pool.query("DELETE FROM workhorse.attempt_history WHERE job_id = ANY($1::uuid[])", [
      [prerequisiteId, dependentId],
    ]);
    await pool.query(
      `UPDATE workhorse.job SET created_at = clock_timestamp() - interval '40 days'
        WHERE id = $1`,
      [prerequisiteId],
    );
    await pool.query(
      `UPDATE workhorse.job_outcome
          SET finished_at = clock_timestamp() - interval '40 days',
              history_through_at = clock_timestamp() - interval '40 days'
        WHERE job_id = $1`,
      [prerequisiteId],
    );
    await queue.syncRetentionPolicy({
      ...defaultRetentionPolicy,
      jobIdentityRetentionDays: 30,
      terminalOutcomeRetentionDays: 30,
      jobEventRetentionDays: 30,
      attemptHistoryRetentionDays: 30,
      scheduleOccurrenceRetentionDays: 30,
    });
    await queue.retainHistory({ force: true });

    const phases = await queue.pruneTerminalStorage({ force: true });
    expect(phases).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          phase: "released_dependencies",
          rowsAffected: 1,
          error: null,
        }),
        expect.objectContaining({ phase: "terminal_jobs", rowsAffected: 1, error: null }),
      ]),
    );
    await expect(admin.getJob(prerequisiteId)).resolves.toBeNull();
    await expect(admin.getJob(dependentId)).resolves.not.toBeNull();
    await expect(admin.getDependencyLineage(dependentId)).resolves.toEqual({
      records: [],
      truncated: false,
    });
    await expect(queue.health()).resolves.toMatchObject({
      dependencies: { retentionPruneStarved: false },
    });
  });

  it("reports a zero-deletion terminal prune starved by dependency pins", async () => {
    const prerequisiteId = await queue.enqueue("starved-prerequisite", null);
    const dependentIds = [
      await queue.enqueue("starved-dependent-a", null, { prerequisiteJobId: prerequisiteId }),
      await queue.enqueue("starved-dependent-b", null, { prerequisiteJobId: prerequisiteId }),
    ];
    const prerequisite = await queue.claim("starved-prerequisite-worker");
    expect(prerequisite?.id).toBe(prerequisiteId);
    expect(await queue.complete(prerequisite!, "starved-prerequisite-worker", null)).toBe(true);
    const claimedDependentIds: string[] = [];
    for (const index of dependentIds.keys()) {
      const workerId = `starved-dependent-worker-${String(index)}`;
      const dependent = await queue.claim(workerId);
      expect(dependentIds).toContain(dependent?.id);
      claimedDependentIds.push(dependent!.id);
      expect(await queue.complete(dependent!, workerId, null)).toBe(true);
    }
    expect(new Set(claimedDependentIds)).toEqual(new Set(dependentIds));
    const jobIds = [prerequisiteId, ...dependentIds];
    await pool.query("DELETE FROM workhorse.job_event WHERE job_id = ANY($1::uuid[])", [jobIds]);
    await pool.query("DELETE FROM workhorse.attempt_history WHERE job_id = ANY($1::uuid[])", [
      jobIds,
    ]);
    await pool.query(
      `UPDATE workhorse.job SET created_at = clock_timestamp() - interval '40 days'
        WHERE id = $1`,
      [prerequisiteId],
    );
    await pool.query(
      `UPDATE workhorse.job_outcome
          SET finished_at = clock_timestamp() - interval '40 days',
              history_through_at = clock_timestamp() - interval '40 days'
        WHERE job_id = $1`,
      [prerequisiteId],
    );
    await queue.syncRetentionPolicy({
      ...defaultRetentionPolicy,
      jobIdentityRetentionDays: 30,
      terminalOutcomeRetentionDays: 30,
      jobEventRetentionDays: 30,
      attemptHistoryRetentionDays: 30,
      scheduleOccurrenceRetentionDays: 30,
      terminalJobPruneLimit: 1,
    });
    await queue.retainHistory({ force: true });

    const starved = await queue.pruneTerminalStorage({ force: true });
    expect(starved.find(({ phase }) => phase === "released_dependencies")).toMatchObject({
      rowsAffected: 1,
    });
    expect(starved.find(({ phase }) => phase === "terminal_jobs")).toMatchObject({
      rowsAffected: 0,
    });
    await expect(queue.health()).resolves.toMatchObject({
      dependencies: { retentionPruneStarved: true },
    });

    const recovered = await queue.pruneTerminalStorage({ force: true });
    expect(recovered.find(({ phase }) => phase === "released_dependencies")).toMatchObject({
      rowsAffected: 1,
    });
    expect(recovered.find(({ phase }) => phase === "terminal_jobs")).toMatchObject({
      rowsAffected: 1,
    });
    await expect(queue.health()).resolves.toMatchObject({
      dependencies: { retentionPruneStarved: false },
    });
  });

  it("does not report a dependency pin skipped by the terminal prune lock window", async () => {
    const prerequisiteId = await queue.enqueue("locked-retention-prerequisite", null);
    const prerequisite = await queue.claim("locked-retention-worker");
    expect(prerequisite?.id).toBe(prerequisiteId);
    expect(await queue.complete(prerequisite!, "locked-retention-worker", null)).toBe(true);
    const blockerId = await queue.enqueue("locked-retention-blocker", null);
    await queue.enqueue("locked-retention-dependent", null, {
      dependencies: {
        prerequisiteJobIds: [prerequisiteId, blockerId],
        onSuccess: "release",
        onFailure: "fail",
        onCancellation: "cancel",
      },
    });
    await pool.query("DELETE FROM workhorse.job_event WHERE job_id = $1", [prerequisiteId]);
    await pool.query("DELETE FROM workhorse.attempt_history WHERE job_id = $1", [prerequisiteId]);
    await pool.query(
      `UPDATE workhorse.job SET created_at = clock_timestamp() - interval '40 days'
        WHERE id = $1`,
      [prerequisiteId],
    );
    await pool.query(
      `UPDATE workhorse.job_outcome
          SET finished_at = clock_timestamp() - interval '40 days',
              history_through_at = clock_timestamp() - interval '40 days'
        WHERE job_id = $1`,
      [prerequisiteId],
    );
    await queue.syncRetentionPolicy({
      ...defaultRetentionPolicy,
      jobIdentityRetentionDays: 30,
      terminalOutcomeRetentionDays: 30,
      jobEventRetentionDays: 30,
      attemptHistoryRetentionDays: 30,
      scheduleOccurrenceRetentionDays: 30,
      terminalJobPruneLimit: 1,
    });
    await queue.retainHistory({ force: true });

    const locker = await pool.connect();
    try {
      await locker.query("BEGIN");
      await locker.query("SELECT 1 FROM workhorse.job WHERE id = $1 FOR UPDATE", [prerequisiteId]);
      const pruning = queue.pruneTerminalStorage({ force: true });
      await sleep(50);
      await locker.query("COMMIT");
      expect((await pruning).find(({ phase }) => phase === "terminal_jobs")).toMatchObject({
        rowsAffected: 0,
      });
    } finally {
      await locker.query("ROLLBACK").catch(() => undefined);
      locker.release();
    }
    await expect(queue.health()).resolves.toMatchObject({
      dependencies: { retentionPruneStarved: false },
    });
  });
});
