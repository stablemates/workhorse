import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { EnqueueIdempotencyConflictError, PurgeIdempotencyConflictError } from "../src/index.js";
import { createIntegrationTestContext } from "./support/integration.js";

const { pool, queue, admin, adminAudit } = createIntegrationTestContext(import.meta.url);

describe("queue administration", () => {
  it("replays a purge request without deleting jobs that arrived afterward", async () => {
    const queueName = "idempotent-purge";
    await queue.enqueue("first", {}, { queue: queueName });
    await queue.enqueue("second", {}, { queue: queueName });
    const audit = adminAudit("clear the abandoned backlog");

    await expect(admin.purgeQueue(queueName, audit)).resolves.toBe(2);
    const laterId = await queue.enqueue("later", {}, { queue: queueName });
    await expect(admin.purgeQueue(queueName, audit)).resolves.toBe(2);
    await expect(admin.getJob(laterId)).resolves.toMatchObject({ state: "ready" });

    await expect(
      admin.purgeQueue(queueName, { ...audit, reason: "a different destructive request" }),
    ).rejects.toBeInstanceOf(PurgeIdempotencyConflictError);
  });

  it("pauses claims, resumes dispatch, and purges only non-active jobs from one queue", async () => {
    const queueName = "managed";
    const activeId = await queue.enqueue("active", {}, { queue: queueName });
    const active = await queue.claim("worker-active", { queue: queueName });
    expect(active?.id).toBe(activeId);

    const readyId = await queue.enqueue("ready", {}, { queue: queueName });
    const scheduledId = await queue.enqueue(
      "scheduled",
      {},
      {
        queue: queueName,
        runAt: new Date(Date.now() + 60_000),
      },
    );
    await pool.query(
      `INSERT INTO workhorse.attempt_history(
           job_id, attempt, fence_token, worker_id, outcome, started_at, claimed_at
         ) VALUES ($1, 1, 1, 'purge-history-worker', 'succeeded', clock_timestamp(), clock_timestamp())`,
      [scheduledId],
    );
    const otherId = await queue.enqueue("other", {}, { queue: "other" });

    await admin.pauseQueue(queueName, adminAudit("pause managed queue"));
    expect(await queue.claim("worker-paused", { queue: queueName })).toBeNull();
    expect(
      await pool.query("SELECT paused FROM workhorse.queue_control WHERE queue_name = $1", [
        queueName,
      ]),
    ).toMatchObject({ rows: [{ paused: true }] });

    await admin.resumeQueue(queueName, adminAudit("resume managed queue"));
    expect((await queue.claim("worker-resumed", { queue: queueName }))?.id).toBe(readyId);

    await queue.enqueue("ready-after-resume", {}, { queue: queueName });
    expect(await admin.purgeQueue(queueName, adminAudit("purge managed queue"))).toBe(2);
    expect(await admin.getJob(activeId)).toMatchObject({ state: "active" });
    expect(await admin.getJob(readyId)).toMatchObject({ state: "active" });
    expect(await admin.getJob(scheduledId)).toBeNull();
    expect(await admin.getJob(otherId)).toMatchObject({ state: "ready" });
    expect(
      (
        await pool.query(
          `SELECT
               (SELECT count(*)::integer FROM workhorse.job_event WHERE job_id = $1) AS events,
               (SELECT count(*)::integer FROM workhorse.attempt_history WHERE job_id = $1) AS attempts`,
          [scheduledId],
        )
      ).rows[0],
    ).toEqual({ events: 0, attempts: 0 });
    expect(await admin.purgeQueue(queueName, adminAudit("purge empty queue"))).toBe(0);
  });

  it("purges ready and scheduled keyed bindings immediately while retaining active bindings", async () => {
    const queueName = "keyed-purge";
    const activeId = await queue.enqueue(
      "purge-active",
      {},
      {
        queue: queueName,
        idempotency: { key: "active-binding" },
      },
    );
    expect((await queue.claim("purge-worker", { queue: queueName }))?.id).toBe(activeId);
    const readyId = await queue.enqueue(
      "purge-ready",
      {},
      {
        queue: queueName,
        idempotency: { key: "ready-binding" },
      },
    );
    const scheduledId = await queue.enqueue(
      "purge-scheduled",
      {},
      {
        queue: queueName,
        runAt: new Date(Date.now() + 60_000),
        idempotency: { key: "scheduled-binding" },
      },
    );

    expect(await admin.purgeQueue(queueName, adminAudit("purge keyed jobs"))).toBe(2);
    expect(await admin.getJob(activeId)).toMatchObject({ state: "active" });
    expect(await admin.getJob(readyId)).toBeNull();
    expect(await admin.getJob(scheduledId)).toBeNull();
    expect(
      (await pool.query("SELECT job_id FROM workhorse.enqueue_idempotency ORDER BY job_id")).rows,
    ).toEqual([{ job_id: activeId }]);

    const reusedReady = await queue.enqueue(
      "purge-ready-reused",
      { version: 2 },
      {
        queue: queueName,
        idempotency: { key: "ready-binding" },
      },
    );
    const reusedScheduled = await queue.enqueue(
      "purge-scheduled-reused",
      { version: 2 },
      {
        queue: queueName,
        idempotency: { key: "scheduled-binding" },
      },
    );
    expect(reusedReady).not.toBe(readyId);
    expect(reusedScheduled).not.toBe(scheduledId);
    await expect(
      queue.enqueue(
        "purge-active-changed",
        {},
        {
          queue: queueName,
          idempotency: { key: "active-binding" },
        },
      ),
    ).rejects.toBeInstanceOf(EnqueueIdempotencyConflictError);
  });

  it("serializes queue purge with a concurrent history insert", async () => {
    const queueName = "purge-history-race";
    const id = await queue.enqueue("purge-history-race", {}, { queue: queueName });
    const inserter = await pool.connect();
    try {
      await inserter.query("BEGIN");
      await inserter.query(
        `INSERT INTO workhorse.job_event(job_id, event_type) VALUES ($1, 'concurrent-purge')`,
        [id],
      );
      let settled = false;
      const purge = admin.purgeQueue(queueName, adminAudit("serialize purge")).finally(() => {
        settled = true;
      });
      await sleep(25);
      expect(settled).toBe(false);
      await inserter.query("COMMIT");

      expect(await purge).toBe(1);
      expect(await admin.getJob(id)).toBeNull();
      expect(
        (
          await pool.query(
            "SELECT count(*)::integer AS count FROM workhorse.job_event WHERE job_id = $1",
            [id],
          )
        ).rows[0]?.count,
      ).toBe(0);
    } finally {
      await inserter.query("ROLLBACK").catch(() => undefined);
      inserter.release();
    }
  });
});
