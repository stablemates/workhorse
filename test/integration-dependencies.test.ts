import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { readDashboardJobDetail } from "../packages/dashboard/src/server/read-model.js";
import { dashboardDatabase } from "../packages/dashboard/src/server/sql.js";
import { createIntegrationTestContext } from "./support/integration.js";

const { pool, queue } = createIntegrationTestContext(import.meta.url);

describe("job dependencies", () => {
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
