import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { Queue } from "../src/index.js";
import { createIntegrationTestContext } from "./support/integration.js";

// completion-deadlock-retry.test.ts drives the resend with scripted errors. These tests make
// PostgreSQL itself abort the fused completion after it has deleted the runtime row and written the
// outcome, so they show the abort rolls those writes back and the resend settles the task once.

const { pool, queue, admin, adminAudit } = createIntegrationTestContext(import.meta.url);

/** Enqueue one task on a new fast-tier queue and claim it. */
async function claimedFastTask(prefix: string) {
  const queueName = `${prefix}-${randomUUID()}`;
  await admin.setQueueTier(queueName, "fast", adminAudit("move to the fast tier"));
  await admin.setQueueHistory(queueName, { recordAttempts: true });
  const id = await queue.enqueue("settle", {}, { queue: queueName });
  const [task] = await queue.claimFast("deadlock-worker", 1, { queue: queueName });
  expect(task?.id).toBe(id);
  return { queueName, task: task! };
}

/**
 * Make the next `count` outcome inserts for `queueName` fail with SQLSTATE 40P01. A sequence counts
 * the failures because a sequence advance survives the rollback the failure causes. The returned
 * function removes the injection and returns how many outcome inserts it saw.
 */
async function injectDeadlocks(queueName: string, count: number): Promise<() => Promise<number>> {
  const suffix = randomUUID().replaceAll("-", "");
  const sequence = `public.injected_deadlock_${suffix}`;
  const fn = `public.inject_deadlock_${suffix}`;
  const trigger = `inject_deadlock_${suffix}`;
  await pool.query(`CREATE SEQUENCE ${sequence}`);
  await pool.query(`
    CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF nextval('${sequence}') <= ${count} THEN
        RAISE EXCEPTION USING ERRCODE = '40P01', MESSAGE = 'deadlock detected (injected)';
      END IF;
      RETURN NEW;
    END;
    $$`);
  await pool.query(
    `CREATE TRIGGER ${trigger} AFTER INSERT ON workhorse.fast_task_outcome
       FOR EACH ROW WHEN (NEW.queue_name = '${queueName}') EXECUTE FUNCTION ${fn}()`,
  );
  return async () => {
    const seen = await pool.query<{ inserts: string }>(
      `SELECT CASE WHEN is_called THEN last_value ELSE 0 END::text AS inserts FROM ${sequence}`,
    );
    await pool.query(`DROP TRIGGER ${trigger} ON workhorse.fast_task_outcome`);
    await pool.query(`DROP FUNCTION ${fn}()`);
    await pool.query(`DROP SEQUENCE ${sequence}`);
    return Number(seen.rows[0]!.inserts);
  };
}

async function persisted(id: string) {
  const [runtime, outcomes, attempts] = await Promise.all([
    pool.query<{ state: string; fence_token: string }>(
      "SELECT state, fence_token::text FROM workhorse.fast_task_runtime WHERE task_id = $1",
      [id],
    ),
    pool.query<{ state: string; attempt: number }>(
      "SELECT state, attempt FROM workhorse.fast_task_outcome WHERE task_id = $1",
      [id],
    ),
    pool.query<{ attempt: number; outcome: string }>(
      "SELECT attempt, outcome FROM workhorse.attempt_history WHERE task_id = $1",
      [id],
    ),
  ]);
  return { runtime: runtime.rows, outcomes: outcomes.rows, attempts: attempts.rows };
}

describe("fused completion against a real deadlock abort", () => {
  it("rolls back the aborted statements and settles the task once on the resend", async () => {
    const { queueName, task } = await claimedFastTask("deadlock-resend");
    let inserts = -1;
    const restore = await injectDeadlocks(queueName, 2);
    try {
      await expect(
        queue.completeAndClaim(
          task,
          "deadlock-worker",
          { ok: true },
          { queue: queueName, limit: 0 },
        ),
      ).resolves.toEqual({ accepted: true, claimed: [] });
    } finally {
      inserts = await restore();
    }
    // Each insert the trigger saw is one statement PostgreSQL ran.
    expect(inserts).toBe(3);

    await expect(persisted(task.id)).resolves.toEqual({
      runtime: [],
      outcomes: [{ state: "succeeded", attempt: 1 }],
      attempts: [{ attempt: 1, outcome: "succeeded" }],
    });
  });

  it("leaves the attempt active after the last resend is aborted", async () => {
    const { queueName, task } = await claimedFastTask("deadlock-exhausted");
    let inserts = -1;
    const restore = await injectDeadlocks(queueName, 3);
    try {
      await expect(
        queue.completeAndClaim(
          task,
          "deadlock-worker",
          { ok: true },
          { queue: queueName, limit: 0 },
        ),
      ).rejects.toMatchObject({ code: "40P01" });
    } finally {
      inserts = await restore();
    }
    // Each insert the trigger saw is one statement PostgreSQL ran.
    expect(inserts).toBe(3);

    await expect(persisted(task.id)).resolves.toEqual({
      runtime: [{ state: "active", fence_token: task.fenceToken.toString() }],
      outcomes: [],
      attempts: [],
    });
    await expect(
      queue.completeAndClaim(task, "deadlock-worker", { ok: true }, { queue: queueName, limit: 0 }),
    ).resolves.toEqual({ accepted: true, claimed: [] });
    await expect(persisted(task.id)).resolves.toMatchObject({
      runtime: [],
      outcomes: [{ state: "succeeded", attempt: 1 }],
    });
  });

  it("reports the deadlock and keeps nothing when the caller owns the transaction", async () => {
    const { queueName, task } = await claimedFastTask("deadlock-caller");
    let inserts = -1;
    const restore = await injectDeadlocks(queueName, 1);
    const client = await pool.connect();
    let callerTaskId: string | undefined;
    try {
      await client.query("BEGIN");
      const transactional = new Queue(client);
      callerTaskId = await transactional.enqueue(
        "caller-write",
        {},
        { queue: `${queueName}-full` },
      );
      await expect(
        client.query("SELECT 1 FROM workhorse.task WHERE id = $1", [callerTaskId]),
      ).resolves.toMatchObject({ rowCount: 1 });
      // The abort dooms the caller's transaction, so the resend fails with 25P02 and the caller
      // sees the original deadlock instead.
      await expect(
        transactional.completeAndClaim(
          task,
          "deadlock-worker",
          { ok: true },
          { queue: queueName, limit: 0 },
        ),
      ).rejects.toMatchObject({ code: "40P01" });
      await client.query("ROLLBACK");
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
      inserts = await restore();
    }
    // Each insert the trigger saw is one statement PostgreSQL ran.
    expect(inserts).toBe(1);

    await expect(admin.getTask(callerTaskId!)).resolves.toBeNull();
    await expect(persisted(task.id)).resolves.toEqual({
      runtime: [{ state: "active", fence_token: task.fenceToken.toString() }],
      outcomes: [],
      attempts: [],
    });
  });
});
