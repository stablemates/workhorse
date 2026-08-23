import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { EnqueueIdempotencyConflictError, PurgeIdempotencyConflictError } from "../src/index.js";
import { createIntegrationTestContext } from "./support/integration.js";

const { admin, pool, queue } = createIntegrationTestContext(import.meta.url);

describe("queue administration", () => {
  it("replays a purge count without deleting work that arrived after the first request", async () => {
    const queueName = `purge-replay-${randomUUID()}`;
    const audit = {
      actor: "queue-administration-test",
      reason: "discard invalid imports",
      requestId: randomUUID(),
    };
    await queue.enqueue("purge-before", null, { queue: queueName });
    await expect(admin.purgeQueue(queueName, audit)).resolves.toBe(1);

    const after = await queue.enqueue("purge-after", null, { queue: queueName });
    await expect(admin.purgeQueue(queueName, audit)).resolves.toBe(1);
    await expect(admin.getJob(after)).resolves.toMatchObject({ state: "ready" });
    await expect(
      admin.purgeQueue(queueName, { ...audit, reason: "different operation" }),
    ).rejects.toBeInstanceOf(PurgeIdempotencyConflictError);

    await pool.query(
      "UPDATE workhorse.queue_purge_request SET requested_at = clock_timestamp() - interval '15 days' WHERE queue_name = $1",
      [queueName],
    );
    await queue.pruneTerminalStorage({ force: true, now: new Date() });
    await expect(
      pool.query("SELECT 1 FROM workhorse.queue_purge_request WHERE queue_name = $1", [queueName]),
    ).resolves.toMatchObject({ rowCount: 0 });
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

    await queue.pauseQueue(queueName);
    expect(await queue.claim("worker-paused", { queue: queueName })).toBeNull();
    expect(
      await pool.query("SELECT paused FROM workhorse.queue_control WHERE queue_name = $1", [
        queueName,
      ]),
    ).toMatchObject({ rows: [{ paused: true }] });

    await queue.resumeQueue(queueName);
    expect((await queue.claim("worker-resumed", { queue: queueName }))?.id).toBe(readyId);

    await queue.enqueue("ready-after-resume", {}, { queue: queueName });
    expect(await queue.purgeQueue(queueName)).toBe(2);
    expect(await queue.getJob(activeId)).toMatchObject({ state: "active" });
    expect(await queue.getJob(readyId)).toMatchObject({ state: "active" });
    expect(await queue.getJob(scheduledId)).toBeNull();
    expect(await queue.getJob(otherId)).toMatchObject({ state: "ready" });
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
    expect(await queue.purgeQueue(queueName)).toBe(0);
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

    expect(await queue.purgeQueue(queueName)).toBe(2);
    expect(await queue.getJob(activeId)).toMatchObject({ state: "active" });
    expect(await queue.getJob(readyId)).toBeNull();
    expect(await queue.getJob(scheduledId)).toBeNull();
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
      const purge = queue.purgeQueue(queueName).finally(() => {
        settled = true;
      });
      await sleep(25);
      expect(settled).toBe(false);
      await inserter.query("COMMIT");

      expect(await purge).toBe(1);
      expect(await queue.getJob(id)).toBeNull();
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
