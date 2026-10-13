import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { EnqueueIdempotencyConflictError, PurgeIdempotencyConflictError } from "../src/index.js";
import { createIntegrationTestContext } from "./support/integration.js";

const { pool, queue, admin, adminAudit, waitForDatabaseCondition } = createIntegrationTestContext(
  import.meta.url,
);

const blockedBy = async (pid: number) => {
  const blocked = await pool.query<{ count: number }>(
    "SELECT count(*)::integer AS count FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))",
    [pid],
  );
  return blocked.rows[0]!.count > 0;
};

// Task IDs are random. Enqueue two tasks under new queue names until the identities come in the
// given order. A purge that locks in scan order then takes the higher task first in one of the two
// orders, whichever plan PostgreSQL uses.
const enqueueOrders = ["higher first", "lower first"] as const;

async function enqueueInOrder(
  prefix: string,
  order: (typeof enqueueOrders)[number],
  tier?: "fast",
) {
  for (let attempt = 0; ; attempt += 1) {
    const queueName = `${prefix}-${order.replace(" ", "-")}-${attempt}`;
    if (tier) await admin.setQueueTier(queueName, tier, adminAudit("lock order"));
    const first = await queue.enqueue("purge-lock-order", {}, { queue: queueName });
    const second = await queue.enqueue("purge-lock-order", {}, { queue: queueName });
    if (first > second === (order === "higher first")) {
      return first > second
        ? { queueName, lower: second, higher: first }
        : { queueName, lower: first, higher: second };
    }
  }
}

describe("queue administration", () => {
  it("replays a purge request without deleting tasks that arrived afterward", async () => {
    const queueName = "idempotent-purge";
    await queue.enqueue("first", {}, { queue: queueName });
    await queue.enqueue("second", {}, { queue: queueName });
    const audit = adminAudit("clear the abandoned backlog");

    await expect(admin.purgeQueue(queueName, audit)).resolves.toBe(2);
    const laterId = await queue.enqueue("later", {}, { queue: queueName });
    await expect(admin.purgeQueue(queueName, audit)).resolves.toBe(2);
    await expect(admin.getTask(laterId)).resolves.toMatchObject({ state: "ready" });

    await expect(
      admin.purgeQueue(queueName, { ...audit, reason: "a different destructive request" }),
    ).rejects.toBeInstanceOf(PurgeIdempotencyConflictError);
  });

  it("pauses claims, resumes dispatch, and purges only non-active tasks from one queue", async () => {
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
           task_id, attempt, fence_token, worker_id, outcome, started_at, claimed_at
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
    expect(await admin.getTask(activeId)).toMatchObject({ state: "active" });
    expect(await admin.getTask(readyId)).toMatchObject({ state: "active" });
    expect(await admin.getTask(scheduledId)).toBeNull();
    expect(await admin.getTask(otherId)).toMatchObject({ state: "ready" });
    expect(
      (
        await pool.query(
          `SELECT
               (SELECT count(*)::integer FROM workhorse.task_event WHERE task_id = $1) AS events,
               (SELECT count(*)::integer FROM workhorse.attempt_history WHERE task_id = $1) AS attempts`,
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

    expect(await admin.purgeQueue(queueName, adminAudit("purge keyed tasks"))).toBe(2);
    expect(await admin.getTask(activeId)).toMatchObject({ state: "active" });
    expect(await admin.getTask(readyId)).toBeNull();
    expect(await admin.getTask(scheduledId)).toBeNull();
    expect(
      (await pool.query("SELECT task_id FROM workhorse.enqueue_idempotency ORDER BY task_id")).rows,
    ).toEqual([{ task_id: activeId }]);

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
        `INSERT INTO workhorse.task_event(task_id, event_type) VALUES ($1, 'concurrent-purge')`,
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
      expect(await admin.getTask(id)).toBeNull();
      expect(
        (
          await pool.query(
            "SELECT count(*)::integer AS count FROM workhorse.task_event WHERE task_id = $1",
            [id],
          )
        ).rows[0]?.count,
      ).toBe(0);
    } finally {
      await inserter.query("ROLLBACK").catch(() => undefined);
      inserter.release();
    }
  });

  it.each(enqueueOrders)(
    "locks purged tasks in identity order, as an enqueue locks two prerequisites (%s)",
    async (order) => {
      const { queueName, lower, higher } = await enqueueInOrder("purge-lock-order", order);
      const holder = await pool.connect();
      const observer = await pool.connect();
      try {
        // The first lock of an enqueue that names both tasks as prerequisites.
        await holder.query("BEGIN");
        await holder.query(
          "SELECT 1 FROM workhorse.task_runtime WHERE task_id = $1 FOR KEY SHARE",
          [lower],
        );
        const pid = (await holder.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!
          .pid;
        // Catch a failure now, because it can arrive before the reply to ROLLBACK.
        const purge = admin
          .purgeQueue(queueName, adminAudit("purge in lock order"))
          .catch((error: unknown) => error);
        await waitForDatabaseCondition(() => blockedBy(pid));
        // The purge waits for the lower runtime row and holds no other row of the two tasks.
        await observer.query("BEGIN");
        for (const statement of [
          "SELECT 1 FROM workhorse.task_runtime WHERE task_id = $1 FOR KEY SHARE NOWAIT",
          "SELECT 1 FROM workhorse.task WHERE id = $1 FOR KEY SHARE NOWAIT",
        ]) {
          for (const id of [lower, higher]) {
            await expect(observer.query(statement, [id])).resolves.toMatchObject({ rowCount: 1 });
          }
        }
        await observer.query("ROLLBACK");
        // So the enqueue takes all of its locks while the purge waits. It rolls back, because a
        // purge refuses to delete the prerequisite of a live dependent (SM-1284).
        await observer.query("BEGIN");
        await expect(
          queue.forDatabase(observer).enqueue(
            "purge-lock-order-dependent",
            {},
            {
              queue: queueName,
              dependencies: {
                prerequisiteTaskIds: [higher, lower],
                onSuccess: "release",
                onFailure: "fail",
                onCancellation: "cancel",
              },
            },
          ),
        ).resolves.toEqual(expect.any(String));
        await observer.query("ROLLBACK");
        await holder.query("ROLLBACK");
        expect(await purge).toBe(2);
        await expect(admin.getTask(lower)).resolves.toBeNull();
        await expect(admin.getTask(higher)).resolves.toBeNull();
      } finally {
        await holder.query("ROLLBACK").catch(() => undefined);
        await observer.query("ROLLBACK").catch(() => undefined);
        holder.release();
        observer.release();
      }
    },
  );

  it.each(enqueueOrders)("locks purged fast-tier tasks in identity order (%s)", async (order) => {
    const { queueName, lower, higher } = await enqueueInOrder(
      "purge-fast-lock-order",
      order,
      "fast",
    );
    const holder = await pool.connect();
    const observer = await pool.connect();
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT 1 FROM workhorse.task WHERE id = $1 FOR KEY SHARE", [lower]);
      const pid = (await holder.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!
        .pid;
      const purge = admin
        .purgeQueue(queueName, adminAudit("purge fast tasks in lock order"))
        .catch((error: unknown) => error);
      await waitForDatabaseCondition(() => blockedBy(pid));
      // The purge locked both runtime rows, then waits for the lower task row before the higher one.
      await observer.query("BEGIN");
      await expect(
        observer.query("SELECT 1 FROM workhorse.task WHERE id = $1 FOR KEY SHARE NOWAIT", [higher]),
      ).resolves.toMatchObject({ rowCount: 1 });
      await observer.query("ROLLBACK");
      await holder.query("ROLLBACK");
      expect(await purge).toBe(2);
    } finally {
      await holder.query("ROLLBACK").catch(() => undefined);
      await observer.query("ROLLBACK").catch(() => undefined);
      holder.release();
      observer.release();
    }
  });
});
