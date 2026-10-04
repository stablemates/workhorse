import { setTimeout as sleep } from "node:timers/promises";
import type { PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";
import { readDashboardTaskDetail } from "../../dashboard-server/src/server/read-model.js";
import { dashboardDatabase } from "../../dashboard-server/src/server/sql.js";
import {
  DependencyCycleError,
  DependencyLimitExceededError,
  MAX_TASK_DEPENDENTS,
  type ClaimedTask,
  type Queryable,
} from "../src/index.js";
import { SQL_STATEMENTS } from "../src/queue/sql-catalogue.generated.js";
import { readDependencyCounterDrift } from "./support/dependency-counter.js";
import { createIntegrationTestContext } from "./support/integration.js";

const { defaultRetentionPolicy, pool, queue, admin } = createIntegrationTestContext(
  import.meta.url,
);

const insertDependency = (
  client: PoolClient,
  dependentTaskId: string,
  prerequisiteTaskId: string,
) =>
  client.query(
    `INSERT INTO workhorse.task_dependency(
       dependent_task_id, prerequisite_task_id, on_success, on_failure, on_cancellation
     ) VALUES ($1, $2, 'release', 'fail', 'cancel')`,
    [dependentTaskId, prerequisiteTaskId],
  );

const within = <T>(work: Promise<T>) =>
  Promise.race([
    work,
    sleep(2_000).then(() => {
      throw new Error("blocked behind the open dependent enqueue");
    }),
  ]);

const byTaskId = (left: { task_id: string }, right: { task_id: string }) =>
  left.task_id < right.task_id ? -1 : 1;

const driftRow = (
  taskId: string,
  queueName: string,
  counter: [number, number],
  rejected: [boolean, boolean],
  counterDrifted: boolean,
) => ({
  task_id: taskId,
  queue_name: queueName,
  pending_prerequisites: counter[0],
  pending_edges: counter[1],
  dependency_rejected: rejected[0],
  rejected_edges: rejected[1],
  counter_drifted: counterDrifted,
  edges_resolved: counter[1] === 0,
});

const releaseReason = async (dependentId: string): Promise<string | undefined> => {
  const evidence = await pool.query<{ reason: string }>(
    `SELECT details->>'reason' AS reason
       FROM workhorse.task_event
      WHERE task_id = $1 AND event_type = 'dependency_released'`,
    [dependentId],
  );
  return evidence.rows[0]?.reason;
};

// A resolver locks one cascade level at a time, and each level's rejected dependents settle before
// the trigger locks the next level. Two cascades that meet at different levels therefore lock the
// same rows in opposite orders. The first failure holds the upper dependent at its first level and
// needs the lower dependent at its second. The second failure holds the lower dependent at its
// first level and needs the upper one. A third transaction holds the first cascade at its first
// level until the second one has taken the lower dependent.
async function arrangeTwoLevelCascade(prefix: string) {
  const policy = { onSuccess: "release", onFailure: "fail", onCancellation: "cancel" } as const;
  // Task IDs are random, so an arrangement whose dependents come out in the other order is left
  // behind and built again under new queue names.
  for (let arrangement = 0; arrangement < 20; arrangement++) {
    const name = `${prefix}-${arrangement}`;
    const [firstRootId, secondRootId] = await queue.enqueueMany(
      ["first", "second"].map((root) => ({
        type: `${prefix}-root`,
        payload: null,
        options: { queue: `${name}-${root}-root`, maxAttempts: 1 },
      })),
    );
    const firstRoot = await queue.claim(`${prefix}-worker`, { queue: `${name}-first-root` });
    const secondRoot = await queue.claim(`${prefix}-worker`, { queue: `${name}-second-root` });
    expect([firstRoot?.id, secondRoot?.id]).toEqual([firstRootId, secondRootId]);
    const levelOneId = await queue.enqueue(`${prefix}-level-one`, null, {
      dependencies: { prerequisiteTaskIds: [firstRootId!], ...policy },
    });
    const [lowerId, upperId] = await queue.enqueueMany([
      {
        type: `${prefix}-lower`,
        payload: null,
        options: {
          dependencies: { prerequisiteTaskIds: [levelOneId, secondRootId!], ...policy },
        },
      },
      {
        type: `${prefix}-upper`,
        payload: null,
        options: {
          dependencies: { prerequisiteTaskIds: [firstRootId!, secondRootId!], ...policy },
        },
      },
    ]);
    if (lowerId! < upperId!) {
      return {
        firstRoot: firstRoot!,
        secondRoot: secondRoot!,
        dependentIds: [levelOneId, lowerId!, upperId!],
      };
    }
  }
  throw new Error("no arrangement put the lower dependent's ID first");
}

const waitingSessions = async (count: number) =>
  vi.waitFor(
    async () => {
      const waiting = await pool.query<{ count: number }>(
        `SELECT count(*)::integer AS count FROM pg_stat_activity
          WHERE datname = current_database() AND cardinality(pg_blocking_pids(pid)) > 0`,
      );
      expect(waiting.rows[0]!.count).toBe(count);
    },
    { timeout: 10_000, interval: 20 },
  );

// Runs two failures against the arranged cascade and returns once the third transaction ends.
async function crossTwoLevelCascades(
  levelOneId: string,
  firstFailure: () => Promise<unknown>,
  secondFailure: () => Promise<unknown>,
) {
  const blocker = await pool.connect();
  let failures: Array<Promise<unknown>> = [];
  try {
    await blocker.query("BEGIN");
    // A key-share lock lets the first cascade lock its first level but not delete it.
    await blocker.query("SELECT FROM workhorse.task_runtime WHERE task_id = $1 FOR KEY SHARE", [
      levelOneId,
    ]);
    failures = [firstFailure()];
    await waitingSessions(1);
    failures.push(secondFailure());
    await waitingSessions(2);
    await blocker.query("ROLLBACK");
    return await Promise.race([
      Promise.allSettled(failures),
      sleep(10_000).then(() => {
        throw new Error("the crossed cascades did not finish");
      }),
    ]);
  } finally {
    await blocker.query("ROLLBACK");
    await Promise.allSettled(failures);
    blocker.release();
  }
}

describe("task dependencies", () => {
  it("maps dependency cycle diagnostics through the public enqueue API", async () => {
    const details = {
      dependentTaskId: "123e4567-e89b-42d3-a456-426614174000",
      prerequisiteTaskId: "123e4567-e89b-42d3-a456-426614174001",
      cycleTaskIds: [
        "123e4567-e89b-42d3-a456-426614174000",
        "123e4567-e89b-42d3-a456-426614174001",
      ],
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
        throw { code: "P1005", detail: JSON.stringify({ taskId: "partial" }) };
      },
    };

    const error = await queue
      .enqueue("limit-mapping", null, {}, transaction)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(DependencyLimitExceededError);
    expect(error).toMatchObject({ taskId: "unknown", limit: "unknown", max: MAX_TASK_DEPENDENTS });
  });

  it("reports bounded prerequisite and dependent lineage with release evidence", async () => {
    const firstId = await queue.enqueue("lineage-first", null);
    const secondId = await queue.enqueue("lineage-second", null);
    const dependentId = await queue.enqueue("lineage-dependent", null, {
      dependencies: {
        prerequisiteTaskIds: [firstId, secondId],
        onSuccess: "release",
        onFailure: "fail",
        onCancellation: "cancel",
      },
    });

    await expect(admin.getDependencyLineage(firstId)).resolves.toEqual({
      records: [
        {
          dependentTaskId: dependentId,
          prerequisiteTaskId: firstId,
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
    await expect(readDashboardTaskDetail(dashboardDatabase(pool), firstId)).resolves.toMatchObject({
      dependencyLineage: {
        records: [
          expect.objectContaining({
            dependentTaskId: dependentId,
            prerequisiteTaskId: firstId,
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
        dependentTaskId: dependentId,
        prerequisiteTaskId: firstId,
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
      prerequisiteTaskId: blockedPrerequisiteId,
    });
    const failingPrerequisiteId = await queue.enqueue("health-failing-prerequisite", null, {
      maxAttempts: 1,
    });
    await queue.enqueue("health-failed-dependent", null, {
      dependencies: {
        prerequisiteTaskIds: [failingPrerequisiteId],
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
      blockedTasks: 1,
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
          SELECT 1 FROM workhorse.task_runtime runtime
           WHERE runtime.queue_name = 'dependency-health'
             AND runtime.state = 'blocked'
           LIMIT 10001`)
      ).rows
        .map((row) => row["QUERY PLAN"])
        .join("\n");
      const pendingPlan = (
        await client.query<{ "QUERY PLAN": string }>(`EXPLAIN (COSTS OFF)
          SELECT 1 FROM workhorse.task_runtime runtime
          JOIN workhorse.task_dependency edge ON edge.dependent_task_id = runtime.task_id
           WHERE runtime.queue_name = 'dependency-health'
             AND runtime.state = 'blocked'
             AND edge.released_at IS NULL
           LIMIT 10001`)
      ).rows
        .map((row) => row["QUERY PLAN"])
        .join("\n");

      expect(blockedPlan).toContain("task_runtime_blocked_queue_idx");
      expect(pendingPlan).toContain("task_runtime_blocked_queue_idx");
      expect(pendingPlan).toContain("task_dependency_dependent_pending_idx");
      await client.query("ROLLBACK");
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
    }
  });

  it("keeps one plan per session for dependency release", async () => {
    // A custom plan sees one-element arrays and always looks cheaper than the generic plan, so
    // PL/pgSQL replanned every release statement on every completion.
    // settle_dependents_v1 runs the resolver's release and rejection statements.
    const result = await pool.query<{ proname: string; proconfig: string[] | null }>(
      `SELECT routine.proname, routine.proconfig
         FROM pg_proc routine
         JOIN pg_namespace namespace ON namespace.oid = routine.pronamespace
        WHERE namespace.nspname = 'workhorse'
          AND routine.proname IN ('resolve_dependents_many_v1', 'settle_dependents_v1')
        ORDER BY routine.proname`,
    );

    expect(result.rows).toEqual([
      { proname: "resolve_dependents_many_v1", proconfig: ["plan_cache_mode=force_generic_plan"] },
      { proname: "settle_dependents_v1", proconfig: ["plan_cache_mode=force_generic_plan"] },
    ]);
  });

  it("runs no dependency statement when a request declares no prerequisites", async () => {
    // An AFTER INSERT statement trigger fires even for an insert which writes no row, so it
    // observes exactly what the guard removes: the statement itself, and with it the recursive
    // validator the shipped statement trigger runs.
    const client = await pool.connect();
    const firedStatements = async () =>
      Number(
        (await client.query<{ fired: string }>("SELECT count(*)::text AS fired FROM pg_temp.probe"))
          .rows[0]!.fired,
      );
    try {
      await client.query("BEGIN");
      await client.query("CREATE TEMP TABLE probe(observed_at timestamptz)");
      await client.query(
        `CREATE FUNCTION pg_temp.record_dependency_statement() RETURNS trigger
         LANGUAGE plpgsql AS $probe$
         BEGIN INSERT INTO pg_temp.probe VALUES (clock_timestamp()); RETURN NULL; END
         $probe$`,
      );
      await client.query(
        `CREATE TRIGGER probe_dependency_statement AFTER INSERT ON workhorse.task_dependency
         FOR EACH STATEMENT EXECUTE FUNCTION pg_temp.record_dependency_statement()`,
      );

      const independentId = await queue.enqueue("dependency-free", null, {}, client);
      expect(await firedStatements()).toBe(0);
      const written = await client.query<{ edges: string; events: string }>(
        `SELECT (SELECT count(*)::text FROM workhorse.task_dependency
                  WHERE dependent_task_id = $1) AS edges,
                (SELECT count(*)::text FROM workhorse.task_event
                  WHERE task_id = $1
                    AND event_type IN ('dependency_blocked', 'dependency_released')) AS events`,
        [independentId],
      );
      expect(written.rows[0]).toEqual({ edges: "0", events: "0" });

      // The same trigger proves the guard is a cardinality check rather than a removal: a request
      // which declares a prerequisite still runs the statement.
      await queue.enqueue(
        "dependency-bearing",
        null,
        {
          dependencies: {
            prerequisiteTaskIds: [independentId],
            onSuccess: "release",
            onFailure: "fail",
            onCancellation: "cancel",
          },
        },
        client,
      );
      expect(await firedStatements()).toBe(1);
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
        prerequisiteTaskIds: [firstId, secondId],
        onSuccess: "release",
        onFailure: "fail",
        onCancellation: "cancel",
      },
    });
    const expectedPrerequisiteIds = [firstId, secondId];
    // oxlint-disable-next-line unicorn/no-array-sort -- ES2022 lacks Array.prototype.toSorted.
    expectedPrerequisiteIds.sort();

    await expect(admin.getTask(dependentId)).resolves.toMatchObject({
      state: "blocked",
      prerequisiteTaskIds: expectedPrerequisiteIds,
    });
    const first = await queue.claim("fan-in-first-worker");
    expect(first?.id).toBe(firstId);
    expect(await queue.complete(first!, "fan-in-first-worker", null)).toBe(true);
    await expect(admin.getTask(dependentId)).resolves.toMatchObject({ state: "blocked" });

    const second = await queue.claim("fan-in-second-worker");
    expect(second?.id).toBe(secondId);
    expect(await queue.complete(second!, "fan-in-second-worker", null)).toBe(true);
    await expect(admin.getTask(dependentId)).resolves.toMatchObject({ state: "ready" });
  });

  it("bounds each prerequisite to 100 dependent tasks", async () => {
    const prerequisiteId = await queue.enqueue("fan-out-prerequisite", null);
    const dependentIds = await queue.enqueueMany(
      Array.from({ length: MAX_TASK_DEPENDENTS }, (_unused, index) => ({
        type: "fan-out-dependent",
        payload: { index },
        options: { prerequisiteTaskId: prerequisiteId },
      })),
    );

    expect(dependentIds).toHaveLength(MAX_TASK_DEPENDENTS);
    const overflow = await queue
      .enqueue("fan-out-overflow", null, { prerequisiteTaskId: prerequisiteId })
      .catch((error: unknown) => error);
    expect(overflow).toBeInstanceOf(DependencyLimitExceededError);
    expect(overflow).toMatchObject({
      taskId: prerequisiteId,
      limit: "dependents",
      max: MAX_TASK_DEPENDENTS,
    });
    const lineage = await admin.getDependencyLineage(prerequisiteId);
    expect(lineage.records).toHaveLength(MAX_TASK_DEPENDENTS);
    expect(lineage.truncated).toBe(false);
  });

  it("bounds one settlement cascade to 100 unresolved descendants", async () => {
    const rootId = await queue.enqueue("cascade-root", null);
    let prerequisiteId = rootId;
    for (let index = 0; index < MAX_TASK_DEPENDENTS; index += 1) {
      prerequisiteId = await queue.enqueue(
        "cascade-dependent",
        { index },
        {
          prerequisiteTaskId: prerequisiteId,
        },
      );
    }

    const overflow = await queue
      .enqueue("cascade-overflow", null, { prerequisiteTaskId: prerequisiteId })
      .catch((error: unknown) => error);
    expect(overflow).toBeInstanceOf(DependencyLimitExceededError);
    expect(overflow).toMatchObject({
      taskId: rootId,
      limit: "unresolved_dependents",
      max: MAX_TASK_DEPENDENTS,
    });
    await expect(
      queue.cancel(rootId, { requestedBy: "cascade-bound-test" }),
    ).resolves.toMatchObject({ status: "canceled" });
    await expect(admin.getTask(prerequisiteId)).resolves.toMatchObject({ state: "canceled" });
  });

  it("fails a dependent when a prerequisite failure selects the fail policy", async () => {
    const prerequisiteId = await queue.enqueue("failing-prerequisite", null, { maxAttempts: 1 });
    const dependentId = await queue.enqueue("failed-dependent", null, {
      dependencies: {
        prerequisiteTaskIds: [prerequisiteId],
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
    await expect(admin.getTask(dependentId)).resolves.toMatchObject({
      state: "failed",
      error: expect.objectContaining({
        name: "DependencyFailed",
        prerequisite_task_id: prerequisiteId,
      }),
    });
  });

  it("applies the declared policy to prerequisite success", async () => {
    const prerequisiteId = await queue.enqueue("successful-prerequisite", null);
    const dependentId = await queue.enqueue("success-policy-dependent", null, {
      dependencies: {
        prerequisiteTaskIds: [prerequisiteId],
        onSuccess: "cancel",
        onFailure: "fail",
        onCancellation: "cancel",
      },
    });
    const prerequisite = await queue.claim("successful-prerequisite-worker");
    expect(prerequisite?.id).toBe(prerequisiteId);
    expect(await queue.complete(prerequisite!, "successful-prerequisite-worker", null)).toBe(true);
    await expect(admin.getTask(dependentId)).resolves.toMatchObject({ state: "canceled" });
  });

  it("cancels a dependent when a prerequisite cancellation selects the cancel policy", async () => {
    const prerequisiteId = await queue.enqueue("canceled-prerequisite", null);
    const dependentId = await queue.enqueue("canceled-dependent", null, {
      dependencies: {
        prerequisiteTaskIds: [prerequisiteId],
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
    await expect(admin.getTask(dependentId)).resolves.toMatchObject({
      state: "canceled",
      error: expect.objectContaining({
        name: "DependencyCanceled",
        prerequisite_task_id: prerequisiteId,
      }),
    });
  });

  it("accepts mixed terminal outcomes when both policies release", async () => {
    const succeededId = await queue.enqueue("accepted-success", null);
    const failedId = await queue.enqueue("accepted-failure", null, { maxAttempts: 1 });
    const canceledId = await queue.enqueue("accepted-cancellation", null);
    const dependentId = await queue.enqueue("mixed-dependent", null, {
      dependencies: {
        prerequisiteTaskIds: [succeededId, failedId, canceledId],
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
    await expect(admin.getTask(dependentId)).resolves.toMatchObject({ state: "blocked" });

    await expect(queue.cancel(canceledId)).resolves.toMatchObject({ status: "canceled" });
    await expect(admin.getTask(dependentId)).resolves.toMatchObject({ state: "ready" });
  });

  it("records why each terminal prerequisite policy released a dependent", async () => {
    const succeededId = await queue.enqueue("release-reason-success", null);
    const succeededDependentId = await queue.enqueue("release-reason-success-dependent", null, {
      dependencies: {
        prerequisiteTaskIds: [succeededId],
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
        prerequisiteTaskIds: [failedId],
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
        prerequisiteTaskIds: [canceledId],
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
        prerequisiteTaskIds: [prerequisiteId],
        onSuccess: "release",
        onFailure: "release",
        onCancellation: "cancel",
      },
    });
    await expect(admin.getTask(releasedId)).resolves.toMatchObject({ state: "ready" });

    const failedId = await queue.enqueue("failed-after-failure", null, {
      dependencies: {
        prerequisiteTaskIds: [prerequisiteId],
        onSuccess: "release",
        onFailure: "fail",
        onCancellation: "cancel",
      },
    });
    await expect(admin.getTask(failedId)).resolves.toMatchObject({
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
      `INSERT INTO workhorse.task_dependency(
         dependent_task_id, prerequisite_task_id, on_success, on_failure, on_cancellation
       ) VALUES ($1, $2, 'release', 'fail', 'cancel'),
                ($2, $3, 'release', 'fail', 'cancel')`,
      [firstId, secondId, thirdId],
    );

    let cycleError: unknown;
    try {
      await pool.query(
        `INSERT INTO workhorse.task_dependency(
         dependent_task_id, prerequisite_task_id, on_success, on_failure, on_cancellation
         ) VALUES ($1, $2, 'release', 'fail', 'cancel'),
                  ($2, $3, 'release', 'fail', 'cancel')`,
        [fourthId, thirdId, firstId],
      );
    } catch (error) {
      cycleError = error;
    }
    expect(cycleError).toMatchObject({
      code: "P1003",
      detail: expect.stringContaining('"cycleTaskIds"'),
    });
    const cycleDetails = JSON.parse((cycleError as { detail: string }).detail) as {
      cycleTaskIds: string[];
      truncated: boolean;
    };
    expect(cycleDetails.cycleTaskIds.length).toBeLessThanOrEqual(101);
    expect(cycleDetails.truncated).toBe(false);
    await expect(
      pool.query<{ count: number }>(
        `SELECT count(*)::integer AS count
           FROM workhorse.task_dependency
          WHERE dependent_task_id = $1 AND prerequisite_task_id = $2`,
        [fourthId, thirdId],
      ),
    ).resolves.toMatchObject({ rows: [{ count: 0 }] });
    await expect(
      pool.query(
        `INSERT INTO workhorse.task_dependency(
           dependent_task_id, prerequisite_task_id, on_success, on_failure, on_cancellation
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
      throw new Error("component lock setup did not enqueue every task");
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
    if (!firstId || !secondId) throw new Error("component cycle setup did not enqueue every task");
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
      throw new Error("component merge setup did not enqueue every task");
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
      // A new sink below the merged component walks its upstream cone, which the waiter holds.
      await expect(insertDependency(follower, fourthId, lowerId)).rejects.toMatchObject({
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
        prerequisiteTaskIds: [failedId, canceledId],
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
    await expect(admin.getTask(dependentId)).resolves.toMatchObject({
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
        prerequisiteTaskIds: [firstId!, secondId!],
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
    await expect(admin.getTask(dependentId)).resolves.toMatchObject({ state: "ready" });
    await expect(
      pool.query<{ count: number }>(
        `SELECT count(*)::integer AS count FROM workhorse.task_event
          WHERE task_id = $1 AND event_type = 'dependency_released'`,
        [dependentId],
      ),
    ).resolves.toMatchObject({ rows: [{ count: 1 }] });
  });

  it("settles one dependency level per statement and records each cause before its effects", async () => {
    const rootId = await queue.enqueue("level-root", null);
    const policies = { onSuccess: "release", onFailure: "fail", onCancellation: "cancel" } as const;
    const middleIds = await queue.enqueueMany(
      Array.from({ length: 3 }, (_unused, index) => ({
        type: "level-middle",
        payload: { index },
        options: { dependencies: { prerequisiteTaskIds: [rootId], ...policies } },
      })),
    );
    const leafIds = await queue.enqueueMany(
      middleIds.map((middleId, index) => ({
        type: "level-leaf",
        payload: { index },
        options: { dependencies: { prerequisiteTaskIds: [middleId], ...policies } },
      })),
    );

    await expect(queue.cancel(rootId)).resolves.toMatchObject({ status: "canceled" });

    // No column records the write order within a level: occurred_at can repeat, and before
    // PostgreSQL 18 event_id is random below the millisecond. Compare each level's membership.
    const events = await pool.query<{ task_id: string; prerequisite_task_id: string }>(
      `SELECT task_id, details->>'prerequisite_task_id' AS prerequisite_task_id
         FROM workhorse.task_event
        WHERE task_id = ANY($1::uuid[]) AND event_type = 'dependency_canceled'
        ORDER BY task_id`,
      [[...middleIds, ...leafIds]],
    );
    expect(events.rows).toEqual(
      [
        ...middleIds.map((taskId) => ({ task_id: taskId, prerequisite_task_id: rootId })),
        ...leafIds.map((taskId, index) => ({
          task_id: taskId,
          prerequisite_task_id: middleIds[index],
        })),
      ].toSorted(byTaskId),
    );
    // The leaf level settles in a later statement, so no leaf event is older than a middle event.
    await expect(
      pool.query<{ ordered: boolean }>(
        `SELECT max(occurred_at) FILTER (WHERE task_id = ANY($1::uuid[]))
                  <= min(occurred_at) FILTER (WHERE task_id = ANY($2::uuid[])) AS ordered
           FROM workhorse.task_event
          WHERE task_id = ANY($1::uuid[] || $2::uuid[]) AND event_type = 'dependency_canceled'`,
        [middleIds, leafIds],
      ),
    ).resolves.toMatchObject({ rows: [{ ordered: true }] });
  });

  it("resolves overlapping fan-in without deadlock while dependents are canceled and extended", async () => {
    // Every round races two completions, a failure or a cancellation, two dependent cancellations,
    // and two dependent enqueues over one shared fan-in, within the ten pooled connections.
    const rounds = 12;
    const dependentIds: string[] = [];
    for (let round = 0; round < rounds; round += 1) {
      const claimedIds = await queue.enqueueMany(
        Array.from({ length: 3 }, (_unused, index) => ({
          type: "overlap-prerequisite",
          payload: { round, index },
          options: { queue: "overlap-prerequisites", maxAttempts: 1 },
        })),
      );
      const claimed = await queue.claimMany("overlap-worker", 3, {
        queue: "overlap-prerequisites",
      });
      expect(new Set(claimed.map(({ id }) => id))).toEqual(new Set(claimedIds));
      const canceledId = await queue.enqueue("overlap-canceled-prerequisite", null, {
        queue: "overlap-canceled-prerequisites",
      });
      const prerequisiteTaskIds = [...claimedIds, canceledId];
      const dependents = await queue.enqueueMany(
        Array.from({ length: 8 }, (_unused, index) => ({
          type: "overlap-dependent",
          payload: { round, index },
          options: {
            queue: "overlap-dependents",
            dependencies: {
              // Each dependent waits on a different subset, so the resolvers' sets overlap.
              prerequisiteTaskIds: prerequisiteTaskIds.filter(
                (_prerequisiteId, position) => position !== index % 4,
              ),
              onSuccess: "release",
              onFailure: round % 2 === 0 ? "release" : "fail",
              onCancellation: "release",
            },
          },
        })),
      );
      dependentIds.push(...dependents);
      const [first, second, third] = claimed;
      const settled = await Promise.allSettled([
        queue.complete(first!, "overlap-worker", null),
        queue.complete(second!, "overlap-worker", null),
        queue.fail(third!, "overlap-worker", new Error("overlap")),
        queue.cancel(canceledId),
        queue.cancel(dependents[0]!),
        queue.cancel(dependents[5]!),
        queue.enqueue("overlap-grandchild", null, {
          queue: "overlap-grandchildren",
          prerequisiteTaskId: dependents[2]!,
        }),
        queue.enqueue("overlap-grandchild", null, {
          queue: "overlap-grandchildren",
          prerequisiteTaskId: dependents[7]!,
        }),
      ]);
      expect(settled.filter(({ status }) => status === "rejected")).toEqual([]);
    }

    const unsettled = await pool.query<{ task_id: string }>(
      `SELECT runtime.task_id FROM workhorse.task_runtime runtime
        WHERE runtime.task_id = ANY($1::uuid[]) AND runtime.state = 'blocked'`,
      [dependentIds],
    );
    expect(unsettled.rows).toEqual([]);
    await expect(
      pool.query<{ count: number }>(
        `SELECT count(*)::integer AS count FROM workhorse.task_event
          WHERE task_id = ANY($1::uuid[])
            AND event_type IN ('dependency_released', 'dependency_failed')
          GROUP BY task_id HAVING count(*) > 1`,
        [dependentIds],
      ),
    ).resolves.toMatchObject({ rows: [] });
  });

  it("bounds the unresolved cascade when an edge extends an existing dependent", async () => {
    const rootId = await queue.enqueue("extended-root", null);
    let bottomId = rootId;
    for (let index = 1; index < MAX_TASK_DEPENDENTS; index += 1) {
      bottomId = await queue.enqueue("extended-chain", { index }, { prerequisiteTaskId: bottomId });
    }
    const headId = await queue.enqueue("extended-head", null);
    await queue.enqueue("extended-tail", null, { prerequisiteTaskId: headId });

    // The head already has a dependent, so this edge takes the full component check.
    const client = await pool.connect();
    try {
      const error = (await insertDependency(client, headId, bottomId).catch(
        (caught: unknown) => caught,
      )) as { code?: string; detail?: string };
      expect(error.code).toBe("P1005");
      expect(JSON.parse(error.detail ?? "null")).toEqual({
        max: 100,
        limit: "unresolved_dependents",
        taskId: rootId,
      });
    } finally {
      client.release();
    }
  });

  it("accepts a sink whose prerequisites together exceed the cascade bound", async () => {
    const chains = await Promise.all(
      [0, 1].map(async (chain) => {
        const rootId = await queue.enqueue("union-root", { chain });
        let bottomId = rootId;
        for (let index = 1; index < 60; index += 1) {
          bottomId = await queue.enqueue(
            "union-chain",
            { chain, index },
            { prerequisiteTaskId: bottomId },
          );
        }
        return bottomId;
      }),
    );

    const sinkId = await queue.enqueue("union-sink", null, {
      dependencies: {
        prerequisiteTaskIds: chains,
        onSuccess: "release",
        onFailure: "fail",
        onCancellation: "cancel",
      },
    });
    await expect(admin.getTask(sinkId)).resolves.toMatchObject({ state: "blocked" });
  });

  it("settles a dependent deterministically when cancellation races completion", async () => {
    const prerequisiteId = await queue.enqueue("racing-cancel-prerequisite", null);
    const dependentId = await queue.enqueue("racing-cancel-dependent", null, {
      dependencies: {
        prerequisiteTaskIds: [prerequisiteId],
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
    const dependent = await admin.getTask(dependentId);
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
          prerequisiteTaskIds: [prerequisiteIds[0]!, prerequisiteIds[0]!],
          onSuccess: "release",
          onFailure: "fail",
          onCancellation: "cancel",
        },
      }),
    ).rejects.toThrow(/must be unique/);
    await expect(
      queue.enqueue("oversized-dependent", null, {
        dependencies: {
          prerequisiteTaskIds: prerequisiteIds,
          onSuccess: "release",
          onFailure: "fail",
          onCancellation: "cancel",
        },
      }),
    ).rejects.toThrow(/between 1 and 100/);
    const boundedDependentId = await queue.enqueue("bounded-dependent", null, {
      dependencies: {
        prerequisiteTaskIds: prerequisiteIds.slice(0, 100),
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
    await expect(admin.getTask(boundedDependentId)).resolves.toMatchObject({ state: "ready" });
  });

  it("keeps a dependent outside dispatch until its prerequisite succeeds", async () => {
    const prerequisiteId = await queue.enqueue("prerequisite", { step: 1 });
    const dependentId = await queue.enqueue(
      "dependent",
      { step: 2 },
      { prerequisiteTaskId: prerequisiteId },
    );

    await expect(admin.getTask(dependentId)).resolves.toMatchObject({
      state: "blocked",
      prerequisiteTaskId: prerequisiteId,
      blockedReason: "prerequisite_pending",
    });
    await expect(admin.listTasks({ states: ["blocked"] })).resolves.toMatchObject({
      items: [expect.objectContaining({ id: dependentId, prerequisiteTaskId: prerequisiteId })],
    });
    await expect(
      readDashboardTaskDetail(dashboardDatabase(pool), dependentId),
    ).resolves.toMatchObject({
      identity: {
        prerequisiteTaskId: prerequisiteId,
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

    await expect(admin.getTask(dependentId)).resolves.toMatchObject({
      state: "ready",
      prerequisiteTaskId: prerequisiteId,
      blockedReason: null,
    });
    await expect(
      readDashboardTaskDetail(dashboardDatabase(pool), dependentId),
    ).resolves.toMatchObject({
      identity: {
        prerequisiteTaskId: prerequisiteId,
        dependencyReleasedAt: expect.any(String),
        blockedReason: null,
      },
    });
    const released = await queue.claim("dependency-successor");
    expect(released?.id).toBe(dependentId);

    const evidence = await pool.query<{ event_type: string; prerequisite_task_id: string }>(
      `SELECT event.event_type, event.details->>'prerequisite_task_id' AS prerequisite_task_id
         FROM workhorse.task_event event
        WHERE event.task_id = $1 AND event.event_type IN ('dependency_blocked', 'dependency_released')
        ORDER BY event.occurred_at, event.event_id`,
      [dependentId],
    );
    expect(evidence.rows).toEqual([
      { event_type: "dependency_blocked", prerequisite_task_id: prerequisiteId },
      { event_type: "dependency_released", prerequisite_task_id: prerequisiteId },
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
        prerequisiteTaskId: prerequisiteId,
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
      prerequisiteTaskId: prerequisiteId,
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
    const targetId = redrive.targetTaskId!;
    await expect(admin.getTask(targetId)).resolves.toMatchObject({
      state: "ready",
      prerequisiteTaskId: null,
      prerequisiteTaskIds: [],
    });
    await expect(admin.getDependencyLineage(targetId)).resolves.toEqual({
      records: [],
      truncated: false,
    });
    await expect(admin.getDependencyLineage(dependentId)).resolves.toMatchObject({
      records: [
        expect.objectContaining({
          dependentTaskId: dependentId,
          prerequisiteTaskId: prerequisiteId,
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
    const runAt = new Date(Date.now() + 60_000);
    const dependentId = await queue.enqueue("delayed-dependent", null, {
      prerequisiteTaskId: prerequisiteId,
      runAt,
    });
    const claimed = await queue.claim("delayed-dependency-worker");
    expect(claimed?.id).toBe(prerequisiteId);
    expect(await queue.complete(claimed!, "delayed-dependency-worker", null)).toBe(true);
    await expect(admin.getTask(dependentId)).resolves.toMatchObject({ state: "scheduled", runAt });
    await pool.query(
      "UPDATE workhorse.task_runtime SET run_at = clock_timestamp() - interval '1 millisecond' WHERE task_id = $1",
      [dependentId],
    );
    expect(await queue.promote()).toBe(1);
    await expect(admin.getTask(dependentId)).resolves.toMatchObject({ state: "ready" });
  });

  it("serializes dependency creation with prerequisite completion", async () => {
    const prerequisiteId = await queue.enqueue("racing-prerequisite", null);
    const claimed = await queue.claim("racing-dependency-worker");
    expect(claimed?.id).toBe(prerequisiteId);

    const transaction = await pool.connect();
    await transaction.query("BEGIN");
    // Take the enqueue's first prerequisite lock before the completion starts, then wait until the
    // completion queues behind it. A lock the enqueue does not take would order the two
    // transactions differently from production and can deadlock with the completion.
    const locked = await transaction.query<{ pid: number }>(
      `SELECT pg_backend_pid() AS pid FROM workhorse.task_runtime
        WHERE task_id = $1 FOR KEY SHARE`,
      [prerequisiteId],
    );
    expect(locked.rows).toHaveLength(1);
    const pid = locked.rows[0]!.pid;
    const completion = queue.complete(claimed!, "racing-dependency-worker", null);
    for (;;) {
      const waiting = await pool.query(
        "SELECT 1 FROM pg_stat_activity WHERE $1::integer = ANY(pg_blocking_pids(pid))",
        [pid],
      );
      if (waiting.rowCount) break;
      await sleep(5);
    }
    const dependentId = await queue.enqueue(
      "racing-dependent",
      null,
      { prerequisiteTaskId: prerequisiteId },
      transaction,
    );
    await transaction.query("COMMIT");
    transaction.release();

    await expect(completion).resolves.toBe(true);
    await expect(admin.getTask(dependentId)).resolves.toMatchObject({
      state: "ready",
      prerequisiteTaskId: prerequisiteId,
      blockedReason: null,
    });
  });

  it("releases every dependent whose prerequisite finishes while its enqueue is in flight", async () => {
    // Each race holds two pooled connections, and the test pool has ten.
    const rounds = 20;
    const width = 2;
    const dependentIds: string[] = [];
    for (let round = 0; round < rounds; round += 1) {
      await queue.enqueueMany(
        Array.from({ length: width }, () => ({
          type: "in-flight-prerequisite",
          payload: null,
          options: { queue: "in-flight-prerequisites", maxAttempts: 1 },
        })),
      );
      const claimed = await queue.claimMany("in-flight-worker", width, {
        queue: "in-flight-prerequisites",
      });
      expect(claimed).toHaveLength(width);
      const unclaimedIds = await queue.enqueueMany(
        Array.from({ length: width }, () => ({
          type: "in-flight-unclaimed-prerequisite",
          payload: null,
          options: { queue: "in-flight-unclaimed-prerequisites" },
        })),
      );
      // Every terminal transition takes a turn: completion, final failure, and cancellation.
      const finishers = [
        ...claimed.map((task, index) =>
          index % 2 === 0
            ? {
                prerequisiteId: task.id,
                expected: "completed",
                finish: async () =>
                  (await queue.complete(task, "in-flight-worker", null)) ? "completed" : "stale",
              }
            : {
                prerequisiteId: task.id,
                expected: "failed",
                finish: () => queue.fail(task, "in-flight-worker", new Error("done")),
              },
        ),
        ...unclaimedIds.map((prerequisiteId) => ({
          prerequisiteId,
          expected: "canceled",
          finish: async () => (await queue.cancel(prerequisiteId)).status,
        })),
      ];
      // Each dependent enqueue holds its transaction open for a moment after it writes the edge,
      // so a finish that does not wait for it resolves dependents on a snapshot without it.
      const results = await Promise.all(
        finishers.map(async ({ prerequisiteId, finish }, index) => {
          const transaction = await pool.connect();
          try {
            await transaction.query("BEGIN");
            const enqueue = async () => {
              const dependentId = await queue.enqueue(
                "in-flight-dependent",
                null,
                { queue: "in-flight-dependents", prerequisiteTaskId: prerequisiteId },
                transaction,
              );
              await sleep(5);
              await transaction.query("COMMIT");
              return dependentId;
            };
            const [dependentId, finished] = await Promise.all([
              enqueue(),
              sleep(index % 2 === 0 ? 0 : 2).then(finish),
            ]);
            return { dependentId, finished };
          } catch (error) {
            await transaction.query("ROLLBACK").catch(() => undefined);
            throw error;
          } finally {
            transaction.release();
          }
        }),
      );
      expect(results.map(({ finished }) => finished)).toEqual(
        finishers.map(({ expected }) => expected),
      );
      dependentIds.push(...results.map(({ dependentId }) => dependentId));
    }

    const stranded = await pool.query<{ task_id: string }>(
      `SELECT runtime.task_id FROM workhorse.task_runtime runtime
        WHERE runtime.task_id = ANY($1::uuid[]) AND runtime.state = 'blocked'
          AND NOT EXISTS (
            SELECT 1 FROM workhorse.task_dependency dependency
              LEFT JOIN workhorse.task_outcome outcome
                ON outcome.task_id = dependency.prerequisite_task_id
             WHERE dependency.dependent_task_id = runtime.task_id AND outcome.task_id IS NULL
          )`,
      [dependentIds],
    );
    expect(stranded.rows).toEqual([]);
    expect(await readDependencyCounterDrift(pool)).toEqual([]);
  });

  it("counts the prerequisites still pending when one finishes while a fan-in enqueue is in flight", async () => {
    // Each race holds two pooled connections, and the test pool has ten.
    const rounds = 10;
    const races: { dependentId: string; pendingId: string; expected: string }[] = [];
    for (let round = 0; round < rounds; round += 1) {
      await queue.enqueueMany(
        Array.from({ length: 2 }, () => ({
          type: "fan-in-race-prerequisite",
          payload: null,
          options: { queue: "fan-in-race-prerequisites", maxAttempts: 1 },
        })),
      );
      const claimed = await queue.claimMany("fan-in-race-worker", 2, {
        queue: "fan-in-race-prerequisites",
      });
      expect(claimed).toHaveLength(2);
      const [unclaimedId, ...pendingIds] = await queue.enqueueMany(
        Array.from({ length: 4 }, (_unused, index) => ({
          type: "fan-in-race-other",
          payload: null,
          options: {
            queue: index === 0 ? "fan-in-race-unclaimed" : "fan-in-race-pending",
            maxAttempts: 1,
          },
        })),
      );
      // One prerequisite of each dependent finishes during its enqueue, through every terminal
      // transition, and the other stays pending. The finished one either commits first or waits.
      const finishers = [
        {
          prerequisiteId: claimed[0]!.id,
          finished: "completed",
          settled: "ready",
          finish: async () =>
            (await queue.complete(claimed[0]!, "fan-in-race-worker", null)) ? "completed" : "stale",
        },
        {
          prerequisiteId: claimed[1]!.id,
          finished: "failed",
          settled: "failed",
          finish: () => queue.fail(claimed[1]!, "fan-in-race-worker", new Error("done")),
        },
        {
          prerequisiteId: unclaimedId!,
          finished: "canceled",
          settled: "canceled",
          finish: async () => (await queue.cancel(unclaimedId!)).status,
        },
      ];
      const results = await Promise.all(
        finishers.map(async ({ prerequisiteId, finish }, index) => {
          const transaction = await pool.connect();
          try {
            await transaction.query("BEGIN");
            const enqueue = async () => {
              const dependentId = await queue.enqueue(
                "fan-in-race-dependent",
                null,
                {
                  queue: "fan-in-race-dependents",
                  dependencies: {
                    prerequisiteTaskIds: [prerequisiteId, pendingIds[index]!],
                    onSuccess: "release",
                    onFailure: "fail",
                    onCancellation: "cancel",
                  },
                },
                transaction,
              );
              await sleep(5);
              await transaction.query("COMMIT");
              return dependentId;
            };
            const [dependentId, finished] = await Promise.all([
              enqueue(),
              sleep((index + round) % 2 === 0 ? 0 : 2).then(finish),
            ]);
            return { dependentId, finished };
          } catch (error) {
            await transaction.query("ROLLBACK").catch(() => undefined);
            throw error;
          } finally {
            transaction.release();
          }
        }),
      );
      expect(results.map(({ finished }) => finished)).toEqual(
        finishers.map(({ finished }) => finished),
      );
      const counters = await pool.query<{
        pending_prerequisites: number;
        dependency_rejected: boolean;
      }>(
        `SELECT runtime.pending_prerequisites, runtime.dependency_rejected
           FROM unnest($1::uuid[]) WITH ORDINALITY dependent(task_id, position)
           JOIN workhorse.task_runtime runtime ON runtime.task_id = dependent.task_id
          WHERE runtime.state = 'blocked'
          ORDER BY dependent.position`,
        [results.map(({ dependentId }) => dependentId)],
      );
      expect(counters.rows).toEqual([
        { pending_prerequisites: 1, dependency_rejected: false },
        { pending_prerequisites: 1, dependency_rejected: true },
        { pending_prerequisites: 1, dependency_rejected: true },
      ]);
      races.push(
        ...results.map(({ dependentId }, index) => ({
          dependentId,
          pendingId: pendingIds[index]!,
          expected: finishers[index]!.settled,
        })),
      );
    }
    expect(await readDependencyCounterDrift(pool)).toEqual([]);

    // The last pending prerequisite brings each counter to zero, and the recorded verdict settles it.
    const pending = await queue.claimMany("fan-in-race-worker", races.length, {
      queue: "fan-in-race-pending",
    });
    expect(pending).toHaveLength(races.length);
    for (const task of pending)
      expect(await queue.complete(task, "fan-in-race-worker", null)).toBe(true);
    const settled = await pool.query<{ state: string }>(
      `SELECT coalesce(runtime.state, outcome.state) AS state
         FROM unnest($1::uuid[]) WITH ORDINALITY dependent(task_id, position)
         LEFT JOIN workhorse.task_runtime runtime ON runtime.task_id = dependent.task_id
         LEFT JOIN workhorse.task_outcome outcome ON outcome.task_id = dependent.task_id
        ORDER BY dependent.position`,
      [races.map(({ dependentId }) => dependentId)],
    );
    expect(settled.rows.map(({ state }) => state)).toEqual(races.map(({ expected }) => expected));
  });

  // A batch and a resolver can both need the same two prerequisites: the batch to hold them against
  // completion, and the resolver to delete them as rejected dependents. Each must lock them in task
  // ID order, or each can hold one row while it waits for the other. While a third transaction
  // holds the lowest ID, both must wait for it before they lock the highest.
  it("does not deadlock a two-request batch with a resolver rejecting both prerequisites", async () => {
    const rootId = await queue.enqueue("rejecting-root", null, {
      queue: "rejecting-roots",
      maxAttempts: 1,
    });
    const root = await queue.claim("rejecting-root-worker", { queue: "rejecting-roots" });
    expect(root?.id).toBe(rootId);
    const dependencies = {
      prerequisiteTaskIds: [rootId],
      onSuccess: "release",
      onFailure: "fail",
      onCancellation: "cancel",
    } as const;
    const prerequisiteIds = await queue.enqueueMany(
      Array.from({ length: 2 }, () => ({
        type: "rejected-prerequisite",
        payload: null,
        options: { queue: "rejected-prerequisites", dependencies },
      })),
    );
    const [lowest, highest] = prerequisiteIds.toSorted() as [string, string];

    const blocker = await pool.connect();
    const enqueuer = await pool.connect();
    let batch: Promise<string[]> | undefined;
    let failure: Promise<unknown> | undefined;
    try {
      await blocker.query("BEGIN");
      await blocker.query("SELECT FROM workhorse.task_runtime WHERE task_id = $1 FOR UPDATE", [
        lowest,
      ]);
      const blockerPid = (await blocker.query<{ pid: number }>("SELECT pg_backend_pid() AS pid"))
        .rows[0]!.pid;
      const waitingBehindBlocker = async (count: number) =>
        vi.waitFor(
          async () => {
            const waiting = await pool.query<{ count: number }>(
              `SELECT count(*)::integer AS count FROM pg_stat_activity
                WHERE datname = current_database() AND $1::integer = ANY(pg_blocking_pids(pid))`,
              [blockerPid],
            );
            expect(waiting.rows[0]!.count).toBe(count);
          },
          { timeout: 10_000, interval: 20 },
        );

      // The first request names the highest prerequisite, so a batch that locks request by
      // request would hold it while it waits for the lowest.
      batch = queue.enqueueMany(
        [highest, lowest].map((prerequisiteTaskId) => ({
          type: "rejected-dependent",
          payload: null,
          options: {
            queue: "rejected-dependents",
            dependencies: { ...dependencies, prerequisiteTaskIds: [prerequisiteTaskId] },
          },
        })),
        enqueuer,
      );
      await waitingBehindBlocker(1);
      const unlocked = await pool.query(
        "SELECT FROM workhorse.task_runtime WHERE task_id = $1 FOR UPDATE SKIP LOCKED",
        [highest],
      );
      expect(unlocked.rowCount).toBe(1);

      // The root's failure rejects both prerequisites. A resolver that deletes them in any order
      // could lock the highest before it waits for the lowest.
      failure = queue.fail(root!, "rejecting-root-worker", new Error("reject both"));
      await waitingBehindBlocker(2);
      const shared = await pool.query(
        "SELECT FROM workhorse.task_runtime WHERE task_id = $1 FOR KEY SHARE SKIP LOCKED",
        [highest],
      );
      expect(shared.rowCount).toBe(1);

      await blocker.query("ROLLBACK");
      const [dependentIds, failed] = await within(Promise.all([batch, failure]));
      expect(failed).toBe("failed");
      for (const taskId of [...prerequisiteIds, ...dependentIds]) {
        await expect(admin.getTask(taskId)).resolves.toMatchObject({
          state: "failed",
          error: expect.objectContaining({ name: "DependencyFailed" }),
        });
      }
    } finally {
      await blocker.query("ROLLBACK");
      await Promise.allSettled([batch, failure]);
      blocker.release();
      enqueuer.release();
    }
    expect(await readDependencyCounterDrift(pool)).toEqual([]);
  });

  it("deadlocks two fenced failures whose cascades meet at different levels", async () => {
    const { firstRoot, secondRoot, dependentIds } = await arrangeTwoLevelCascade("crossed-raw");
    const failRaw = (task: ClaimedTask) =>
      pool.query(SQL_STATEMENTS["fail_v1"], [
        task.id,
        "crossed-raw-worker",
        task.fenceToken.toString(),
        JSON.stringify({ name: "Error", message: "crossed" }),
        null,
      ]);

    const settled = await crossTwoLevelCascades(
      dependentIds[0]!,
      () => failRaw(firstRoot),
      () => failRaw(secondRoot),
    );

    const rejected = settled.filter((result) => result.status === "rejected");
    expect(rejected).toEqual([
      { status: "rejected", reason: expect.objectContaining({ code: "40P01" }) },
    ]);
    // PostgreSQL rolled the whole victim statement back, so sending it again finishes the cascade.
    const victim = settled[0]!.status === "rejected" ? firstRoot : secondRoot;
    await expect(failRaw(victim)).resolves.toMatchObject({ rows: [{ state: "failed" }] });
    for (const taskId of dependentIds) {
      await expect(admin.getTask(taskId)).resolves.toMatchObject({
        state: "failed",
        error: expect.objectContaining({ name: "DependencyFailed" }),
      });
    }
    expect(await readDependencyCounterDrift(pool)).toEqual([]);
  });

  it("retries a fenced failure that PostgreSQL chose as a crossed cascade's deadlock victim", async () => {
    const { firstRoot, secondRoot, dependentIds } = await arrangeTwoLevelCascade("crossed-sdk");
    const codes: Array<string | undefined> = [];
    const observed = queue.forDatabase({
      query: (text, values) =>
        pool.query(text, values as unknown[]).catch((error: unknown) => {
          codes.push((error as { code?: string }).code);
          throw error;
        }),
    });

    const settled = await crossTwoLevelCascades(
      dependentIds[0]!,
      () => observed.fail(firstRoot, "crossed-sdk-worker", new Error("crossed")),
      () => observed.fail(secondRoot, "crossed-sdk-worker", new Error("crossed")),
    );

    // A resend can start before the other cascade finishes and cross it again, so PostgreSQL may
    // choose more than one victim. Every abort is a deadlock, and both failures still settle.
    expect(new Set(codes)).toEqual(new Set(["40P01"]));
    expect(settled).toEqual([
      { status: "fulfilled", value: "failed" },
      { status: "fulfilled", value: "failed" },
    ]);
    for (const taskId of dependentIds) {
      await expect(admin.getTask(taskId)).resolves.toMatchObject({
        state: "failed",
        error: expect.objectContaining({ name: "DependencyFailed" }),
      });
    }
    expect(await readDependencyCounterDrift(pool)).toEqual([]);
  });

  // The resolver deletes rejected dependents through a join, and a hash join visits them in heap
  // order. The resolver must lock them in task ID order first, the order an enqueue batch uses. The
  // resolver's session forbids the other join methods, and the higher dependent is moved in front
  // of the lower one in the heap. While a third transaction holds the lower dependent, the higher
  // one must still be free of the resolver's delete lock.
  it("locks rejected dependents in task ID order before a hash join deletes them", async () => {
    const rootId = await queue.enqueue("heap-order-root", null, {
      queue: "heap-order-roots",
      maxAttempts: 1,
    });
    const root = await queue.claim("heap-order-worker", { queue: "heap-order-roots" });
    expect(root?.id).toBe(rootId);
    const dependentIds = await queue.enqueueMany(
      Array.from({ length: 2 }, () => ({
        type: "heap-order-dependent",
        payload: null,
        options: {
          dependencies: {
            prerequisiteTaskIds: [rootId],
            onSuccess: "release",
            onFailure: "fail",
            onCancellation: "cancel",
          },
        },
      })),
    );
    const [lowest, highest] = dependentIds.toSorted() as [string, string];
    const heapOrdered = async () =>
      (
        await pool.query<{ ordered: boolean }>(
          `SELECT (SELECT ctid FROM workhorse.task_runtime WHERE task_id = $1)
                < (SELECT ctid FROM workhorse.task_runtime WHERE task_id = $2) AS ordered`,
          [highest, lowest],
        )
      ).rows[0]!.ordered;
    for (let moves = 0; !(await heapOrdered()); moves++) {
      if (moves === 10) throw new Error("could not move the lowest dependent behind the highest");
      await pool.query(
        "UPDATE workhorse.task_runtime SET updated_at = updated_at WHERE task_id = $1",
        [lowest],
      );
    }

    const blocker = await pool.connect();
    const resolver = await pool.connect();
    let failure: Promise<unknown> | undefined;
    try {
      await resolver.query(
        `SET enable_nestloop = off; SET enable_mergejoin = off;
         SET enable_indexscan = off; SET enable_bitmapscan = off`,
      );
      await blocker.query("BEGIN");
      await blocker.query("SELECT FROM workhorse.task_runtime WHERE task_id = $1 FOR KEY SHARE", [
        lowest,
      ]);

      failure = queue.forDatabase(resolver).fail(root!, "heap-order-worker", new Error("reject"));
      await waitingSessions(1);
      const unlocked = await pool.query(
        "SELECT FROM workhorse.task_runtime WHERE task_id = $1 FOR KEY SHARE SKIP LOCKED",
        [highest],
      );
      expect(unlocked.rowCount).toBe(1);

      await blocker.query("ROLLBACK");
      await expect(within(failure)).resolves.toBe("failed");
      for (const taskId of dependentIds) {
        await expect(admin.getTask(taskId)).resolves.toMatchObject({
          state: "failed",
          error: expect.objectContaining({ name: "DependencyFailed" }),
        });
      }
    } finally {
      await blocker.query("ROLLBACK");
      await Promise.allSettled([failure]);
      await resolver.query("RESET ALL");
      blocker.release();
      resolver.release();
    }
    expect(await readDependencyCounterDrift(pool)).toEqual([]);
  });

  it("settles every terminal prerequisite of an enqueue in one pass", async () => {
    const [succeededId, failedId, pendingId] = await queue.enqueueMany(
      ["one-pass-succeeded", "one-pass-failed", "one-pass-pending"].map((type) => ({
        type,
        payload: null,
        options: { queue: type, maxAttempts: 1 },
      })),
    );
    const succeeded = await queue.claim("one-pass-worker", { queue: "one-pass-succeeded" });
    expect(await queue.complete(succeeded!, "one-pass-worker", null)).toBe(true);
    const failed = await queue.claim("one-pass-worker", { queue: "one-pass-failed" });
    expect(await queue.fail(failed!, "one-pass-worker", new Error("done"))).toBe("failed");

    const policies = {
      onSuccess: "release",
      onFailure: "release",
      onCancellation: "cancel",
    } as const;
    const releasedId = await queue.enqueue("one-pass-released", null, {
      dependencies: { prerequisiteTaskIds: [succeededId!, failedId!], ...policies },
    });
    const blockedId = await queue.enqueue("one-pass-blocked", null, {
      dependencies: { prerequisiteTaskIds: [succeededId!, failedId!, pendingId!], ...policies },
    });

    await expect(admin.getTask(releasedId)).resolves.toMatchObject({ state: "ready" });
    await expect(
      pool.query(
        `SELECT state, pending_prerequisites, dependency_rejected
           FROM workhorse.task_runtime WHERE task_id = $1`,
        [blockedId],
      ),
    ).resolves.toMatchObject({
      rows: [{ state: "blocked", pending_prerequisites: 1, dependency_rejected: false }],
    });
    expect(await readDependencyCounterDrift(pool)).toEqual([]);

    const pending = await queue.claim("one-pass-worker", { queue: "one-pass-pending" });
    expect(await queue.complete(pending!, "one-pass-worker", null)).toBe(true);
    await expect(admin.getTask(blockedId)).resolves.toMatchObject({ state: "ready" });
    const released = await pool.query<{ details: unknown }>(
      `SELECT details FROM workhorse.task_event
        WHERE task_id = $1 AND event_type = 'dependency_released' AND details->>'state' = 'ready'`,
      [blockedId],
    );
    expect(released.rows).toEqual([
      {
        details: {
          prerequisite_task_id: pendingId,
          state: "ready",
          reason: "prerequisite_succeeded",
        },
      },
    ]);
  });

  it("holds a rejection until the last edge resolves and cascades it downstream", async () => {
    const [failingId, pendingId] = await queue.enqueueMany(
      ["held-rejection-failing", "held-rejection-pending"].map((type) => ({
        type,
        payload: null,
        options: { queue: type, maxAttempts: 1 },
      })),
    );
    const policies = { onSuccess: "release", onFailure: "fail", onCancellation: "cancel" } as const;
    const dependentId = await queue.enqueue("held-rejection-dependent", null, {
      dependencies: { prerequisiteTaskIds: [failingId!, pendingId!], ...policies },
    });
    const downstreamId = await queue.enqueue("held-rejection-downstream", null, {
      dependencies: { prerequisiteTaskIds: [dependentId], ...policies },
    });

    const failing = await queue.claim("held-rejection-worker", { queue: "held-rejection-failing" });
    expect(await queue.fail(failing!, "held-rejection-worker", new Error("nope"))).toBe("failed");
    await expect(
      pool.query(
        `SELECT state, pending_prerequisites, dependency_rejected
           FROM workhorse.task_runtime WHERE task_id = $1`,
        [dependentId],
      ),
    ).resolves.toMatchObject({
      rows: [{ state: "blocked", pending_prerequisites: 1, dependency_rejected: true }],
    });
    expect(await readDependencyCounterDrift(pool)).toEqual([]);

    const pending = await queue.claim("held-rejection-worker", { queue: "held-rejection-pending" });
    expect(await queue.complete(pending!, "held-rejection-worker", null)).toBe(true);
    await expect(admin.getTask(dependentId)).resolves.toMatchObject({
      state: "failed",
      error: expect.objectContaining({ name: "DependencyFailed", prerequisite_task_id: failingId }),
    });
    await expect(admin.getTask(downstreamId)).resolves.toMatchObject({
      state: "failed",
      error: expect.objectContaining({
        name: "DependencyFailed",
        prerequisite_task_id: dependentId,
      }),
    });
    expect(await readDependencyCounterDrift(pool)).toEqual([]);
  });

  it("recounts a pending-prerequisite counter that would fall below zero", async () => {
    const [firstId, secondId, loneId] = await queue.enqueueMany(
      ["underflow-first", "underflow-second", "underflow-lone"].map((type) => ({
        type,
        payload: null,
        options: { queue: type },
      })),
    );
    const heldId = await queue.enqueue("underflow-held", null, {
      dependencies: {
        prerequisiteTaskIds: [firstId!, secondId!],
        onSuccess: "release",
        onFailure: "fail",
        onCancellation: "cancel",
      },
    });
    const releasedId = await queue.enqueue("underflow-released", null, {
      prerequisiteTaskId: loneId!,
    });
    await pool.query(
      `UPDATE workhorse.task_runtime SET pending_prerequisites = 0
        WHERE task_id = ANY($1::uuid[])`,
      [[heldId, releasedId]],
    );

    const first = await queue.claim("underflow-worker", { queue: "underflow-first" });
    expect(await queue.complete(first!, "underflow-worker", null)).toBe(true);
    await expect(
      pool.query(
        `SELECT state, pending_prerequisites, dependency_rejected
           FROM workhorse.task_runtime WHERE task_id = $1`,
        [heldId],
      ),
    ).resolves.toMatchObject({
      rows: [{ state: "blocked", pending_prerequisites: 1, dependency_rejected: false }],
    });
    expect(await readDependencyCounterDrift(pool)).toEqual([
      expect.objectContaining({ task_id: releasedId, pending_prerequisites: 0, pending_edges: 1 }),
    ]);

    const lone = await queue.claim("underflow-worker", { queue: "underflow-lone" });
    expect(await queue.complete(lone!, "underflow-worker", null)).toBe(true);
    await expect(admin.getTask(releasedId)).resolves.toMatchObject({ state: "ready" });

    const events = await pool.query<{ task_id: string; event_type: string; details: unknown }>(
      `SELECT task_id, event_type, details FROM workhorse.task_event
        WHERE task_id = ANY($1::uuid[])
          AND event_type IN ('dependency_counter_repaired', 'dependency_released')
        ORDER BY occurred_at, event_id`,
      [[heldId, releasedId]],
    );
    expect(events.rows).toEqual([
      {
        task_id: heldId,
        event_type: "dependency_counter_repaired",
        details: {
          source: "resolver",
          prerequisite_task_id: firstId,
          recorded_pending_prerequisites: 0,
          resolved_edges: 1,
          pending_edges: 1,
          dependency_rejected: false,
        },
      },
      {
        task_id: releasedId,
        event_type: "dependency_counter_repaired",
        details: {
          source: "resolver",
          prerequisite_task_id: loneId,
          recorded_pending_prerequisites: 0,
          resolved_edges: 1,
          pending_edges: 0,
          dependency_rejected: false,
        },
      },
      {
        task_id: releasedId,
        event_type: "dependency_released",
        details: { prerequisite_task_id: loneId, state: "ready", reason: "prerequisite_succeeded" },
      },
    ]);

    const second = await queue.claim("underflow-worker", { queue: "underflow-second" });
    expect(await queue.complete(second!, "underflow-worker", null)).toBe(true);
    await expect(admin.getTask(heldId)).resolves.toMatchObject({ state: "ready" });
    expect(await readDependencyCounterDrift(pool)).toEqual([]);
  });

  it("holds a dependent whose low counter reaches zero while an edge is pending", async () => {
    const [firstId, secondId] = await queue.enqueueMany(
      ["early-first", "early-second"].map((type) => ({
        type,
        payload: null,
        options: { queue: type },
      })),
    );
    const heldId = await queue.enqueue("early-held", null, {
      dependencies: {
        prerequisiteTaskIds: [firstId!, secondId!],
        onSuccess: "release",
        onFailure: "fail",
        onCancellation: "cancel",
      },
    });
    await pool.query(
      "UPDATE workhorse.task_runtime SET pending_prerequisites = 1 WHERE task_id = $1",
      [heldId],
    );

    const first = await queue.claim("early-worker", { queue: "early-first" });
    expect(await queue.complete(first!, "early-worker", null)).toBe(true);
    await expect(
      pool.query(
        `SELECT state, pending_prerequisites, dependency_rejected
           FROM workhorse.task_runtime WHERE task_id = $1`,
        [heldId],
      ),
    ).resolves.toMatchObject({
      rows: [{ state: "blocked", pending_prerequisites: 1, dependency_rejected: false }],
    });
    expect(await readDependencyCounterDrift(pool)).toEqual([]);

    const second = await queue.claim("early-worker", { queue: "early-second" });
    expect(await queue.complete(second!, "early-worker", null)).toBe(true);
    await expect(admin.getTask(heldId)).resolves.toMatchObject({ state: "ready" });

    const events = await pool.query<{ event_type: string; details: unknown }>(
      `SELECT event_type, details FROM workhorse.task_event
        WHERE task_id = $1
          AND event_type IN ('dependency_counter_repaired', 'dependency_released')
        ORDER BY occurred_at, event_id`,
      [heldId],
    );
    expect(events.rows).toEqual([
      {
        event_type: "dependency_counter_repaired",
        details: {
          source: "resolver",
          prerequisite_task_id: firstId,
          recorded_pending_prerequisites: 1,
          resolved_edges: 1,
          pending_edges: 1,
          dependency_rejected: false,
        },
      },
      {
        event_type: "dependency_released",
        details: {
          prerequisite_task_id: secondId,
          state: "ready",
          reason: "prerequisite_succeeded",
        },
      },
    ]);
  });

  it("recounts a rejected dependent that has no rejecting edge", async () => {
    const [firstId, secondId, loneId] = await queue.enqueueMany(
      ["flagged-first", "flagged-second", "flagged-lone"].map((type) => ({
        type,
        payload: null,
        options: { queue: type },
      })),
    );
    const policies = { onSuccess: "release", onFailure: "fail", onCancellation: "cancel" } as const;
    const releasedId = await queue.enqueue("flagged-released", null, {
      dependencies: { prerequisiteTaskIds: [firstId!, secondId!], ...policies },
    });
    const heldId = await queue.enqueue("flagged-held", null, {
      dependencies: { prerequisiteTaskIds: [loneId!], ...policies },
    });
    await pool.query(
      `UPDATE workhorse.task_runtime SET dependency_rejected = true
        WHERE task_id = ANY($1::uuid[])`,
      [[releasedId, heldId]],
    );

    for (const type of ["flagged-first", "flagged-second"]) {
      const claimed = await queue.claim("flagged-worker", { queue: type });
      expect(await queue.complete(claimed!, "flagged-worker", null)).toBe(true);
    }
    await expect(admin.getTask(releasedId)).resolves.toMatchObject({ state: "ready" });

    // Every caller reaches the settlement with no pending edge, so the blocked branch is reached
    // only by handing the settlement a dependent directly.
    await expect(
      pool.query<{ settled: number }>(
        `SELECT workhorse.settle_dependents_v1(clock_timestamp(), ARRAY[$1::uuid], NULL, NULL, NULL)
           AS settled`,
        [heldId],
      ),
    ).resolves.toMatchObject({ rows: [{ settled: 0 }] });
    await expect(
      pool.query(
        `SELECT state, pending_prerequisites, dependency_rejected
           FROM workhorse.task_runtime WHERE task_id = $1`,
        [heldId],
      ),
    ).resolves.toMatchObject({
      rows: [{ state: "blocked", pending_prerequisites: 1, dependency_rejected: false }],
    });
    expect(await readDependencyCounterDrift(pool)).toEqual([]);

    const events = await pool.query<{ task_id: string; event_type: string; details: unknown }>(
      `SELECT task_id, event_type, details FROM workhorse.task_event
        WHERE task_id = ANY($1::uuid[])
          AND event_type IN ('dependency_counter_repaired', 'dependency_released')
        ORDER BY occurred_at, event_id`,
      [[releasedId, heldId]],
    );
    expect(events.rows).toEqual([
      {
        task_id: releasedId,
        event_type: "dependency_counter_repaired",
        details: {
          source: "settlement",
          pending_edges: 0,
          dependency_rejected: false,
        },
      },
      {
        task_id: releasedId,
        event_type: "dependency_released",
        details: {
          prerequisite_task_id: null,
          state: "ready",
          reason: "dependency_counter_repaired",
        },
      },
      {
        task_id: heldId,
        event_type: "dependency_counter_repaired",
        details: {
          source: "settlement",
          pending_edges: 1,
          dependency_rejected: false,
        },
      },
    ]);
  });

  it("reports and repairs blocked tasks whose counters disagree with their edges", async () => {
    const [pendingId, resolvedId] = await queue.enqueueMany(
      ["drift-pending", "drift-resolved"].map((type) => ({
        type,
        payload: null,
        options: { queue: type },
      })),
    );
    const enqueueDependent = (type: string, prerequisiteTaskId: string) =>
      queue.enqueue(type, null, { queue: type, prerequisiteTaskId });
    const highId = await enqueueDependent("drift-high", pendingId!);
    const flaggedId = await enqueueDependent("drift-flagged", pendingId!);
    const healthyId = await enqueueDependent("drift-healthy", pendingId!);
    const strandedId = await enqueueDependent("drift-stranded", resolvedId!);
    const settledId = await enqueueDependent("drift-settled", resolvedId!);
    const rejectedId = await enqueueDependent("drift-rejected", resolvedId!);
    await pool.query(
      `UPDATE workhorse.task_runtime SET pending_prerequisites = 2 WHERE task_id = $1`,
      [highId],
    );
    await pool.query(
      `UPDATE workhorse.task_runtime SET dependency_rejected = true WHERE task_id = $1`,
      [flaggedId],
    );
    // Resolve edges without the resolver, as a lost counter update would leave them.
    await pool.query(
      `UPDATE workhorse.task_dependency
          SET released_at = clock_timestamp(),
              resolution = CASE dependent_task_id WHEN $3::uuid THEN 'fail' ELSE 'release' END
        WHERE dependent_task_id = ANY($1::uuid[]) AND prerequisite_task_id = $2`,
      [[strandedId, settledId, rejectedId], resolvedId, rejectedId],
    );
    await pool.query(
      `UPDATE workhorse.task_runtime
          SET pending_prerequisites = 0, dependency_rejected = task_id = $2::uuid
        WHERE task_id = ANY($1::uuid[])`,
      [[settledId, rejectedId], rejectedId],
    );

    const drift = await pool.query(
      `SELECT task_id, queue_name, pending_prerequisites, pending_edges, dependency_rejected,
              rejected_edges, counter_drifted, edges_resolved
         FROM workhorse.dependency_counter_drift_v1()`,
    );
    expect(drift.rows).toEqual(
      [
        driftRow(highId, "drift-high", [2, 1], [false, false], true),
        driftRow(flaggedId, "drift-flagged", [1, 1], [true, false], true),
        driftRow(strandedId, "drift-stranded", [1, 0], [false, false], true),
        driftRow(settledId, "drift-settled", [0, 0], [false, false], false),
        driftRow(rejectedId, "drift-rejected", [0, 0], [true, true], false),
      ].toSorted(byTaskId),
    );
    expect(drift.rows.map((entry) => entry.task_id)).not.toContain(healthyId);
    const limited = await pool.query(
      `SELECT task_id FROM workhorse.dependency_counter_drift_v1(2)`,
    );
    expect(limited.rows).toEqual(drift.rows.slice(0, 2).map(({ task_id }) => ({ task_id })));
    await expect(
      pool.query(`SELECT * FROM workhorse.dependency_counter_drift_v1(0)`),
    ).rejects.toThrow(/between 1 and 100000/);

    const repaired = await pool.query(
      `SELECT task_id, recorded_pending_prerequisites, pending_edges, action
         FROM workhorse.repair_dependency_counters_v1()`,
    );
    expect(repaired.rows).toEqual(
      [
        {
          task_id: highId,
          recorded_pending_prerequisites: 2,
          pending_edges: 1,
          action: "recounted",
        },
        {
          task_id: flaggedId,
          recorded_pending_prerequisites: 1,
          pending_edges: 1,
          action: "recounted",
        },
        {
          task_id: strandedId,
          recorded_pending_prerequisites: 1,
          pending_edges: 0,
          action: "released",
        },
        {
          task_id: settledId,
          recorded_pending_prerequisites: 0,
          pending_edges: 0,
          action: "released",
        },
        {
          task_id: rejectedId,
          recorded_pending_prerequisites: 0,
          pending_edges: 0,
          action: "rejected",
        },
      ].toSorted(byTaskId),
    );
    expect(await readDependencyCounterDrift(pool)).toEqual([]);
    await expect(
      pool.query(`SELECT * FROM workhorse.dependency_counter_drift_v1()`),
    ).resolves.toMatchObject({ rows: [] });
    await expect(
      pool.query(`SELECT * FROM workhorse.repair_dependency_counters_v1()`),
    ).resolves.toMatchObject({ rows: [] });

    await expect(
      pool.query(
        `SELECT task_id, state, pending_prerequisites, dependency_rejected
           FROM workhorse.task_runtime WHERE task_id = ANY($1::uuid[]) ORDER BY task_id`,
        [[highId, flaggedId, strandedId, settledId]],
      ),
    ).resolves.toMatchObject({
      rows: [
        { task_id: highId, state: "blocked", pending_prerequisites: 1, dependency_rejected: false },
        {
          task_id: flaggedId,
          state: "blocked",
          pending_prerequisites: 1,
          dependency_rejected: false,
        },
        {
          task_id: strandedId,
          state: "ready",
          pending_prerequisites: 0,
          dependency_rejected: false,
        },
        {
          task_id: settledId,
          state: "ready",
          pending_prerequisites: 0,
          dependency_rejected: false,
        },
      ].toSorted(byTaskId),
    });
    await expect(admin.getTask(rejectedId)).resolves.toMatchObject({
      state: "failed",
      error: expect.objectContaining({
        name: "DependencyFailed",
        prerequisite_task_id: resolvedId,
        policy_action: "fail",
      }),
    });

    const events = await pool.query<{ event_type: string; details: unknown }>(
      `SELECT event_type, details FROM workhorse.task_event
        WHERE task_id = $1
          AND event_type IN ('dependency_counter_repaired', 'dependency_released')
        ORDER BY occurred_at, event_id`,
      [strandedId],
    );
    expect(events.rows).toEqual([
      {
        event_type: "dependency_counter_repaired",
        details: {
          source: "repair",
          prerequisite_task_id: resolvedId,
          recorded_pending_prerequisites: 1,
          pending_edges: 0,
          dependency_rejected: false,
        },
      },
      {
        event_type: "dependency_released",
        details: {
          prerequisite_task_id: resolvedId,
          state: "ready",
          reason: "dependency_counter_repaired",
        },
      },
    ]);

    const pending = await queue.claim("drift-worker", { queue: "drift-pending" });
    expect(await queue.complete(pending!, "drift-worker", null)).toBe(true);
    for (const taskId of [highId, flaggedId, healthyId]) {
      await expect(admin.getTask(taskId)).resolves.toMatchObject({ state: "ready" });
    }
  });

  it("previews and repairs dependency drift through Admin with an audited event", async () => {
    const [pendingId, resolvedId] = await queue.enqueueMany(
      ["governed-pending", "governed-resolved"].map((type) => ({
        type,
        payload: null,
        options: { queue: type },
      })),
    );
    const enqueueDependent = (type: string, prerequisiteTaskId: string) =>
      queue.enqueue(type, null, { queue: type, prerequisiteTaskId });
    const highId = await enqueueDependent("governed-high", pendingId!);
    const healthyId = await enqueueDependent("governed-healthy", pendingId!);
    const strandedId = await enqueueDependent("governed-stranded", resolvedId!);
    const rejectedId = await enqueueDependent("governed-rejected", resolvedId!);
    await pool.query(
      `UPDATE workhorse.task_runtime SET pending_prerequisites = 3 WHERE task_id = $1`,
      [highId],
    );
    await pool.query(
      `UPDATE workhorse.task_dependency
          SET released_at = clock_timestamp(),
              resolution = CASE dependent_task_id WHEN $3::uuid THEN 'fail' ELSE 'release' END
        WHERE dependent_task_id = ANY($1::uuid[]) AND prerequisite_task_id = $2`,
      [[strandedId, rejectedId], resolvedId, rejectedId],
    );
    const readRuntime = () =>
      pool.query(
        `SELECT task_id, state, pending_prerequisites, dependency_rejected
           FROM workhorse.task_runtime WHERE task_id = ANY($1::uuid[]) ORDER BY task_id`,
        [[highId, healthyId, strandedId, rejectedId]],
      );
    const readRepairEvents = () =>
      pool.query<{ task_id: string; details: Record<string, unknown> }>(
        `SELECT task_id, details FROM workhorse.task_event
          WHERE task_id = ANY($1::uuid[]) AND event_type = 'dependency_counter_repaired'
          ORDER BY task_id`,
        [[highId, healthyId, strandedId, rejectedId]],
      );
    const before = await readRuntime();

    const expected = [
      {
        taskId: highId,
        queueName: "governed-high",
        pendingPrerequisites: 3,
        pendingEdges: 1,
        dependencyRejected: false,
        rejectedEdges: false,
        action: "recounted",
      },
      {
        taskId: strandedId,
        queueName: "governed-stranded",
        pendingPrerequisites: 1,
        pendingEdges: 0,
        dependencyRejected: false,
        rejectedEdges: false,
        action: "released",
      },
      {
        taskId: rejectedId,
        queueName: "governed-rejected",
        pendingPrerequisites: 1,
        pendingEdges: 0,
        dependencyRejected: false,
        rejectedEdges: true,
        action: "rejected",
      },
    ].toSorted((left, right) => (left.taskId < right.taskId ? -1 : 1));
    await expect(admin.listDependencyDrift()).resolves.toEqual(expected);
    await expect(admin.listDependencyDrift(2)).resolves.toEqual(expected.slice(0, 2));
    // The dry run writes nothing: no counter changes and no repair event.
    expect((await readRuntime()).rows).toEqual(before.rows);
    expect((await readRepairEvents()).rows).toEqual([]);

    for (const limit of [0, 100_001, 1.5]) {
      await expect(admin.listDependencyDrift(limit)).rejects.toThrow(
        "limit must be an integer from 1 to 100000",
      );
    }
    const audit = {
      actor: "operator@example.test",
      reason: "recount drifted dependents",
      requestId: "repair-request-0001",
    };
    await expect(admin.repairDependencyDrift({ ...audit, reason: "" })).rejects.toThrow(
      "reason must contain between 1 and 2000 characters",
    );
    await expect(admin.repairDependencyDrift(audit, 0)).rejects.toThrow(
      "limit must be an integer from 1 to 100000",
    );
    await expect(
      pool.query(`SELECT * FROM workhorse.repair_dependency_drift_v1(10, '', 'reason', 'id')`),
    ).rejects.toThrow("requested_by must contain between 1 and 200 characters");
    expect((await readRepairEvents()).rows).toEqual([]);

    await expect(admin.repairDependencyDrift(audit)).resolves.toEqual(
      expected.map(({ taskId, pendingPrerequisites, pendingEdges, action }) => ({
        taskId,
        recordedPendingPrerequisites: pendingPrerequisites,
        pendingEdges,
        action,
      })),
    );
    await expect(admin.listDependencyDrift()).resolves.toEqual([]);
    await expect(admin.repairDependencyDrift(audit)).resolves.toEqual([]);

    const events = await readRepairEvents();
    expect(events.rows.map((row) => row.task_id)).toEqual(expected.map((row) => row.taskId));
    for (const event of events.rows) {
      expect(event.details).toMatchObject({
        source: "repair",
        requested_by: audit.actor,
        request_reason: audit.reason,
        request_id_preview: "repair-r…0001",
        request_id_digest: expect.stringMatching(/^[0-9a-f]{12}$/),
        request_id_length: audit.requestId.length,
      });
      expect(JSON.stringify(event.details)).not.toContain(audit.requestId);
    }
    await expect(admin.getTask(highId)).resolves.toMatchObject({ state: "blocked" });
    await expect(admin.getTask(strandedId)).resolves.toMatchObject({ state: "ready" });
    await expect(admin.getTask(rejectedId)).resolves.toMatchObject({ state: "failed" });
    await expect(admin.getTask(healthyId)).resolves.toMatchObject({ state: "blocked" });
  });

  it("lets a prerequisite be claimed and heartbeated while a dependent enqueue is in flight", async () => {
    const prerequisiteId = await queue.enqueue("unblocked-prerequisite", null, {
      queue: "unblocked-prerequisites",
    });
    const transaction = await pool.connect();
    try {
      await transaction.query("BEGIN");
      await queue.enqueue(
        "unblocked-dependent",
        null,
        { queue: "unblocked-dependents", prerequisiteTaskId: prerequisiteId },
        transaction,
      );
      // The enqueue transaction stays open, so any lock it holds on the prerequisite is still held.
      const claimed = await within(
        queue.claim("unblocked-worker", { queue: "unblocked-prerequisites" }),
      );
      expect(claimed?.id).toBe(prerequisiteId);
      await expect(within(queue.heartbeat(claimed!, "unblocked-worker"))).resolves.toBe(true);
      await transaction.query("COMMIT");
    } catch (error) {
      await transaction.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      transaction.release();
    }
  });

  it("validates dependency identity and keeps enqueue transactional and idempotent", async () => {
    await expect(
      queue.enqueue("missing-dependent", null, {
        prerequisiteTaskId: "00000000-0000-4000-8000-000000000001",
      }),
    ).rejects.toThrow(/prerequisite task does not exist/);
    await expect(
      pool.query("SELECT count(*)::integer AS count FROM workhorse.task"),
    ).resolves.toMatchObject({
      rows: [{ count: 0 }],
    });

    const prerequisiteId = await queue.enqueue("transaction-prerequisite", null);
    const transaction = await pool.connect();
    await transaction.query("BEGIN");
    const rolledBackId = await queue.enqueue(
      "rolled-back-dependent",
      null,
      { prerequisiteTaskId: prerequisiteId },
      transaction,
    );
    await transaction.query("ROLLBACK");
    transaction.release();
    await expect(admin.getTask(rolledBackId)).resolves.toBeNull();

    const idempotency = { key: "dependency-replay", scope: "dependencies" };
    const acceptedId = await queue.enqueue("idempotent-dependent", null, {
      prerequisiteTaskId: prerequisiteId,
      idempotency,
    });
    await expect(
      queue.enqueue("idempotent-dependent", null, {
        prerequisiteTaskId: prerequisiteId,
        idempotency,
      }),
    ).resolves.toBe(acceptedId);

    const otherPrerequisiteId = await queue.enqueue("other-prerequisite", null);
    await expect(
      queue.enqueue("idempotent-dependent", null, {
        prerequisiteTaskId: otherPrerequisiteId,
        idempotency,
      }),
    ).rejects.toMatchObject({
      details: { conflictingFields: ["prerequisiteTaskId"] },
    });

    await expect(
      pool.query("DELETE FROM workhorse.task WHERE id = $1", [prerequisiteId]),
    ).rejects.toThrow(/task_dependency_prerequisite_task_id_fkey/);
    await expect(admin.getTask(acceptedId)).resolves.toMatchObject({ state: "blocked" });
  });

  it("releases a blocked dependent's own edges when cancellation settles it", async () => {
    const prerequisiteId = await queue.enqueue("abandoned-prerequisite", null);
    const dependentId = await queue.enqueue("abandoned-dependent", null, {
      dependencies: {
        prerequisiteTaskIds: [prerequisiteId],
        onSuccess: "release",
        onFailure: "fail",
        onCancellation: "cancel",
      },
    });
    await expect(admin.getTask(dependentId)).resolves.toMatchObject({ state: "blocked" });

    await expect(queue.cancel(dependentId)).resolves.toMatchObject({ status: "canceled" });

    await expect(admin.getDependencyLineage(dependentId)).resolves.toEqual({
      records: [
        expect.objectContaining({
          dependentTaskId: dependentId,
          prerequisiteTaskId: prerequisiteId,
          releasedAt: expect.any(Date),
          resolution: "release",
        }),
      ],
      truncated: false,
    });
    await expect(admin.getTask(prerequisiteId)).resolves.toMatchObject({ state: "ready" });
    await expect(queue.health()).resolves.toMatchObject({
      dependencies: { pendingEdges: 0 },
    });
  });

  it("stops a canceled dependent from pinning its prerequisite against retention", async () => {
    const prerequisiteId = await queue.enqueue("unpinned-prerequisite", null);
    const dependentId = await queue.enqueue("unpinned-dependent", null, {
      prerequisiteTaskId: prerequisiteId,
    });
    await expect(queue.cancel(dependentId)).resolves.toMatchObject({ status: "canceled" });
    const prerequisite = await queue.claim("unpinned-prerequisite-worker");
    expect(prerequisite?.id).toBe(prerequisiteId);
    expect(await queue.complete(prerequisite!, "unpinned-prerequisite-worker", null)).toBe(true);

    await pool.query("DELETE FROM workhorse.task_event WHERE task_id = ANY($1::uuid[])", [
      [prerequisiteId, dependentId],
    ]);
    await pool.query("DELETE FROM workhorse.attempt_history WHERE task_id = ANY($1::uuid[])", [
      [prerequisiteId, dependentId],
    ]);
    await pool.query(
      `UPDATE workhorse.task SET created_at = clock_timestamp() - interval '40 days'
        WHERE id = $1`,
      [prerequisiteId],
    );
    await pool.query(
      `UPDATE workhorse.task_outcome
          SET finished_at = clock_timestamp() - interval '40 days',
              history_through_at = clock_timestamp() - interval '40 days'
        WHERE task_id = $1`,
      [prerequisiteId],
    );
    await queue.syncRetentionPolicy({
      ...defaultRetentionPolicy,
      taskIdentityRetentionDays: 30,
      terminalOutcomeRetentionDays: 30,
      taskEventRetentionDays: 30,
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
        expect.objectContaining({ phase: "terminal_tasks", rowsAffected: 1, error: null }),
      ]),
    );
    await expect(admin.getTask(prerequisiteId)).resolves.toBeNull();
    await expect(queue.health()).resolves.toMatchObject({
      dependencies: { retentionPruneStarved: false },
    });
  });

  it("compacts released edges before pruning an older prerequisite", async () => {
    const prerequisiteId = await queue.enqueue("retained-prerequisite", null);
    const dependentId = await queue.enqueue("retained-dependent", null, {
      prerequisiteTaskId: prerequisiteId,
    });
    const prerequisite = await queue.claim("retention-prerequisite-worker");
    expect(prerequisite?.id).toBe(prerequisiteId);
    expect(await queue.complete(prerequisite!, "retention-prerequisite-worker", null)).toBe(true);
    const dependent = await queue.claim("retention-dependent-worker");
    expect(dependent?.id).toBe(dependentId);
    expect(await queue.complete(dependent!, "retention-dependent-worker", null)).toBe(true);

    await pool.query("DELETE FROM workhorse.task_event WHERE task_id = ANY($1::uuid[])", [
      [prerequisiteId, dependentId],
    ]);
    await pool.query("DELETE FROM workhorse.attempt_history WHERE task_id = ANY($1::uuid[])", [
      [prerequisiteId, dependentId],
    ]);
    await pool.query(
      `UPDATE workhorse.task SET created_at = clock_timestamp() - interval '40 days'
        WHERE id = $1`,
      [prerequisiteId],
    );
    await pool.query(
      `UPDATE workhorse.task_outcome
          SET finished_at = clock_timestamp() - interval '40 days',
              history_through_at = clock_timestamp() - interval '40 days'
        WHERE task_id = $1`,
      [prerequisiteId],
    );
    await queue.syncRetentionPolicy({
      ...defaultRetentionPolicy,
      taskIdentityRetentionDays: 30,
      terminalOutcomeRetentionDays: 30,
      taskEventRetentionDays: 30,
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
        expect.objectContaining({ phase: "terminal_tasks", rowsAffected: 1, error: null }),
      ]),
    );
    await expect(admin.getTask(prerequisiteId)).resolves.toBeNull();
    await expect(admin.getTask(dependentId)).resolves.not.toBeNull();
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
      await queue.enqueue("starved-dependent-a", null, { prerequisiteTaskId: prerequisiteId }),
      await queue.enqueue("starved-dependent-b", null, { prerequisiteTaskId: prerequisiteId }),
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
    const taskIds = [prerequisiteId, ...dependentIds];
    await pool.query("DELETE FROM workhorse.task_event WHERE task_id = ANY($1::uuid[])", [taskIds]);
    await pool.query("DELETE FROM workhorse.attempt_history WHERE task_id = ANY($1::uuid[])", [
      taskIds,
    ]);
    await pool.query(
      `UPDATE workhorse.task SET created_at = clock_timestamp() - interval '40 days'
        WHERE id = $1`,
      [prerequisiteId],
    );
    await pool.query(
      `UPDATE workhorse.task_outcome
          SET finished_at = clock_timestamp() - interval '40 days',
              history_through_at = clock_timestamp() - interval '40 days'
        WHERE task_id = $1`,
      [prerequisiteId],
    );
    await queue.syncRetentionPolicy({
      ...defaultRetentionPolicy,
      taskIdentityRetentionDays: 30,
      terminalOutcomeRetentionDays: 30,
      taskEventRetentionDays: 30,
      attemptHistoryRetentionDays: 30,
      scheduleOccurrenceRetentionDays: 30,
      terminalTaskPruneLimit: 1,
    });
    await queue.retainHistory({ force: true });

    const starved = await queue.pruneTerminalStorage({ force: true });
    expect(starved.find(({ phase }) => phase === "released_dependencies")).toMatchObject({
      rowsAffected: 1,
    });
    expect(starved.find(({ phase }) => phase === "terminal_tasks")).toMatchObject({
      rowsAffected: 0,
    });
    await expect(queue.health()).resolves.toMatchObject({
      dependencies: { retentionPruneStarved: true },
    });

    const recovered = await queue.pruneTerminalStorage({ force: true });
    expect(recovered.find(({ phase }) => phase === "released_dependencies")).toMatchObject({
      rowsAffected: 1,
    });
    expect(recovered.find(({ phase }) => phase === "terminal_tasks")).toMatchObject({
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
        prerequisiteTaskIds: [prerequisiteId, blockerId],
        onSuccess: "release",
        onFailure: "fail",
        onCancellation: "cancel",
      },
    });
    await pool.query("DELETE FROM workhorse.task_event WHERE task_id = $1", [prerequisiteId]);
    await pool.query("DELETE FROM workhorse.attempt_history WHERE task_id = $1", [prerequisiteId]);
    await pool.query(
      `UPDATE workhorse.task SET created_at = clock_timestamp() - interval '40 days'
        WHERE id = $1`,
      [prerequisiteId],
    );
    await pool.query(
      `UPDATE workhorse.task_outcome
          SET finished_at = clock_timestamp() - interval '40 days',
              history_through_at = clock_timestamp() - interval '40 days'
        WHERE task_id = $1`,
      [prerequisiteId],
    );
    await queue.syncRetentionPolicy({
      ...defaultRetentionPolicy,
      taskIdentityRetentionDays: 30,
      terminalOutcomeRetentionDays: 30,
      taskEventRetentionDays: 30,
      attemptHistoryRetentionDays: 30,
      scheduleOccurrenceRetentionDays: 30,
      terminalTaskPruneLimit: 1,
    });
    await queue.retainHistory({ force: true });

    const locker = await pool.connect();
    try {
      await locker.query("BEGIN");
      await locker.query("SELECT 1 FROM workhorse.task WHERE id = $1 FOR UPDATE", [prerequisiteId]);
      const pruning = queue.pruneTerminalStorage({ force: true });
      expect((await pruning).find(({ phase }) => phase === "terminal_tasks")).toMatchObject({
        rowsAffected: 0,
      });
      await locker.query("COMMIT");
    } finally {
      await locker.query("ROLLBACK").catch(() => undefined);
      locker.release();
    }
    await expect(queue.health()).resolves.toMatchObject({
      dependencies: { retentionPruneStarved: false },
    });
  });
});
