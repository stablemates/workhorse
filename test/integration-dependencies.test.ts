import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { readDashboardJobDetail } from "../packages/dashboard/src/server/read-model.js";
import { dashboardDatabase } from "../packages/dashboard/src/server/sql.js";
import { createIntegrationTestContext } from "./support/integration.js";

const { pool, queue } = createIntegrationTestContext(import.meta.url);

describe("job dependencies", () => {
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

    await expect(queue.getDependencyLineage(firstId)).resolves.toEqual({
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

    const dependentLineage = await queue.getDependencyLineage(dependentId);
    expect(dependentLineage.records).toContainEqual(
      expect.objectContaining({
        dependentJobId: dependentId,
        prerequisiteJobId: firstId,
        releasedAt: expect.any(Date),
        resolution: "release",
      }),
    );
    await expect(queue.getDependencyLineage(dependentId, 1)).resolves.toMatchObject({
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
      capped: false,
    });
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

    await expect(queue.getJob(dependentId)).resolves.toMatchObject({
      state: "blocked",
      prerequisiteJobIds: expectedPrerequisiteIds,
    });
    const first = await queue.claim("fan-in-first-worker");
    expect(first?.id).toBe(firstId);
    expect(await queue.complete(first!, "fan-in-first-worker", null)).toBe(true);
    await expect(queue.getJob(dependentId)).resolves.toMatchObject({ state: "blocked" });

    const second = await queue.claim("fan-in-second-worker");
    expect(second?.id).toBe(secondId);
    expect(await queue.complete(second!, "fan-in-second-worker", null)).toBe(true);
    await expect(queue.getJob(dependentId)).resolves.toMatchObject({ state: "ready" });
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
    await expect(queue.getJob(dependentId)).resolves.toMatchObject({
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
    await expect(queue.getJob(dependentId)).resolves.toMatchObject({ state: "canceled" });
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
    await expect(queue.getJob(dependentId)).resolves.toMatchObject({
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
    await expect(queue.getJob(dependentId)).resolves.toMatchObject({ state: "blocked" });

    await expect(queue.cancel(canceledId)).resolves.toMatchObject({ status: "canceled" });
    await expect(queue.getJob(dependentId)).resolves.toMatchObject({ state: "ready" });
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
    await expect(queue.getJob(releasedId)).resolves.toMatchObject({ state: "ready" });

    const failedId = await queue.enqueue("failed-after-failure", null, {
      dependencies: {
        prerequisiteJobIds: [prerequisiteId],
        onSuccess: "release",
        onFailure: "fail",
        onCancellation: "cancel",
      },
    });
    await expect(queue.getJob(failedId)).resolves.toMatchObject({
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
      code: "P1002",
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
    ).rejects.toMatchObject({ code: "P1002" });
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
    await expect(queue.getJob(dependentId)).resolves.toMatchObject({
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
    await expect(queue.getJob(dependentId)).resolves.toMatchObject({ state: "ready" });
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
    const dependent = await queue.getJob(dependentId);
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
    await expect(queue.getJob(boundedDependentId)).resolves.toMatchObject({ state: "ready" });
  });

  it("keeps a dependent outside dispatch until its prerequisite succeeds", async () => {
    const prerequisiteId = await queue.enqueue("prerequisite", { step: 1 });
    const dependentId = await queue.enqueue(
      "dependent",
      { step: 2 },
      { prerequisiteJobId: prerequisiteId },
    );

    await expect(queue.getJob(dependentId)).resolves.toMatchObject({
      state: "blocked",
      prerequisiteJobId: prerequisiteId,
      blockedReason: "prerequisite_pending",
    });
    await expect(queue.listJobs({ states: ["blocked"] })).resolves.toMatchObject({
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

    await expect(queue.getJob(dependentId)).resolves.toMatchObject({
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
        ORDER BY event.event_id`,
      [dependentId],
    );
    expect(evidence.rows).toEqual([
      { event_type: "dependency_blocked", prerequisite_job_id: prerequisiteId },
      { event_type: "dependency_released", prerequisite_job_id: prerequisiteId },
    ]);
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
    await expect(queue.getJob(dependentId)).resolves.toMatchObject({ state: "scheduled", runAt });
    await sleep(50);
    expect(await queue.promote()).toBe(1);
    await expect(queue.getJob(dependentId)).resolves.toMatchObject({ state: "ready" });
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
    await expect(queue.getJob(dependentId)).resolves.toMatchObject({
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
    await expect(queue.getJob(rolledBackId)).resolves.toBeNull();

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
    await expect(queue.getJob(acceptedId)).resolves.toMatchObject({ state: "blocked" });
  });

  it("prunes a released dependent before its retained prerequisite", async () => {
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
        WHERE id = ANY($1::uuid[])`,
      [[prerequisiteId, dependentId]],
    );
    await pool.query(
      `UPDATE workhorse.job_outcome
          SET finished_at = clock_timestamp() - interval '40 days',
              history_through_at = clock_timestamp() - interval '40 days'
        WHERE job_id = ANY($1::uuid[])`,
      [[prerequisiteId, dependentId]],
    );

    const prune = () =>
      pool.query<{ pruned: number }>(
        `SELECT workhorse.prune_terminal_jobs_v1(
           clock_timestamp() - interval '30 days',
           clock_timestamp() - interval '30 days',
           date_trunc('day', clock_timestamp() - interval '30 days'), 10
         ) AS pruned`,
      );
    await expect(prune()).resolves.toMatchObject({ rows: [{ pruned: 1 }] });
    await expect(queue.getJob(prerequisiteId)).resolves.not.toBeNull();
    await expect(queue.getJob(dependentId)).resolves.toBeNull();
    await expect(prune()).resolves.toMatchObject({ rows: [{ pruned: 1 }] });
    await expect(queue.getJob(prerequisiteId)).resolves.toBeNull();
  });
});
