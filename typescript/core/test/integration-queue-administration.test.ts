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
      const inserted = await inserter.query<{ pid: number }>(
        `INSERT INTO workhorse.task_event(task_id, event_type) VALUES ($1, 'concurrent-purge')
         RETURNING pg_backend_pid() AS pid`,
        [id],
      );
      const pid = inserted.rows[0]!.pid;
      let settled = false;
      const purge = admin.purgeQueue(queueName, adminAudit("serialize purge")).finally(() => {
        settled = true;
      });
      // A pending purge alone does not show that it waits for the insert. PostgreSQL must report
      // the wait before the insert commits.
      await waitForDatabaseCondition(() => blockedBy(pid));
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
        // So the enqueue takes all of its locks while the purge waits. It rolls back, so the purge
        // deletes both tasks and cancels neither (SM-1284).
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

type CancellationPolicy = "release" | "cancel" | "fail";

const dependentOf = (
  prerequisiteTaskIds: string[],
  queueName: string,
  onCancellation: CancellationPolicy = "cancel",
) =>
  queue.enqueue(
    "purge-dependent",
    {},
    {
      queue: queueName,
      dependencies: {
        prerequisiteTaskIds,
        onSuccess: "release",
        onFailure: "fail",
        onCancellation,
      },
    },
  );

const outcomeOf = async (taskId: string) => {
  const task = await admin.getTask(taskId);
  const evidence = await pool.query<{ reason: string | null }>(
    `SELECT details->>'reason' AS reason FROM workhorse.task_event
      WHERE task_id = $1 AND event_type = 'dependency_released'`,
    [taskId],
  );
  return {
    state: task?.state,
    error: (task?.error as { name?: string } | null | undefined)?.name ?? null,
    releaseReason: evidence.rows[0]?.reason ?? null,
  };
};

const edgesFrom = async (prerequisiteTaskId: string) =>
  (
    await pool.query<{ count: number }>(
      `SELECT count(*)::integer AS count FROM workhorse.task_dependency
        WHERE prerequisite_task_id = $1`,
      [prerequisiteTaskId],
    )
  ).rows[0]!.count;

// Enqueue a prerequisite in a new queue and its dependent in another queue until the identity of the
// prerequisite comes in the given order relative to the dependent.
async function arrangeDependent(
  prefix: string,
  order: (typeof enqueueOrders)[number],
  onCancellation: CancellationPolicy = "cancel",
) {
  for (let attempt = 0; ; attempt += 1) {
    const queueName = `${prefix}-${order.replace(" ", "-")}-${attempt}`;
    const prerequisiteId = await queue.enqueue("purge-prerequisite", {}, { queue: queueName });
    const dependentId = await dependentOf(
      [prerequisiteId],
      `${queueName}-elsewhere`,
      onCancellation,
    );
    if (prerequisiteId > dependentId === (order === "higher first")) {
      return { queueName, prerequisiteId, dependentId };
    }
  }
}

// Before SM-1284, a purge deleted a prerequisite whose dependent stayed, and PostgreSQL refused the
// delete with 23001. Now a purge deletes a dependent in the same purge with its prerequisite, and
// cancels a prerequisite whose dependent stays, so the dependent's own policy decides its outcome.
describe("queue purge with dependents", () => {
  it("deletes a dependent in the same queue with its prerequisite", async () => {
    const queueName = "purge-dependent-same-queue";
    const prerequisiteId = await queue.enqueue("purge-prerequisite", {}, { queue: queueName });
    const dependentId = await dependentOf([prerequisiteId], queueName);

    expect(await admin.purgeQueue(queueName, adminAudit("purge both"))).toBe(2);
    await expect(admin.getTask(prerequisiteId)).resolves.toBeNull();
    await expect(admin.getTask(dependentId)).resolves.toBeNull();
    expect(await edgesFrom(prerequisiteId)).toBe(0);
  });

  it.each(["release", "cancel", "fail"] as const)(
    "cancels a prerequisite whose dependent is in another queue, as a cancel does (%s)",
    async (onCancellation) => {
      const queueName = `purge-dependent-elsewhere-${onCancellation}`;
      const otherQueue = `${queueName}-dependents`;
      const canceledId = await queue.enqueue("purge-prerequisite", {}, { queue: otherQueue });
      const canceledDependentId = await dependentOf([canceledId], otherQueue, onCancellation);
      await expect(queue.cancel(canceledId)).resolves.toMatchObject({ status: "canceled" });

      const purgedId = await queue.enqueue("purge-prerequisite", {}, { queue: queueName });
      const purgedDependentId = await dependentOf([purgedId], otherQueue, onCancellation);
      expect(await admin.purgeQueue(queueName, adminAudit("purge a prerequisite"))).toBe(1);

      await expect(admin.getTask(purgedId)).resolves.toMatchObject({ state: "canceled" });
      const expected = {
        release: { state: "ready", error: null, releaseReason: "prerequisite_canceled_policy" },
        cancel: { state: "canceled", error: "DependencyCanceled", releaseReason: null },
        fail: { state: "failed", error: "DependencyFailed", releaseReason: null },
      }[onCancellation];
      expect(await outcomeOf(canceledDependentId)).toEqual(expected);
      expect(await outcomeOf(purgedDependentId)).toEqual(expected);
      // A rejected dependent names the purged task as the prerequisite that decided its outcome.
      const purgedDependent = await admin.getTask(purgedDependentId);
      expect(
        (purgedDependent?.error as { prerequisite_task_id?: string } | null | undefined)
          ?.prerequisite_task_id ?? null,
      ).toBe(onCancellation === "release" ? null : purgedId);
    },
  );

  it("keeps the rejection of a dependent that waits for another prerequisite", async () => {
    const queueName = "purge-dependent-waits";
    const otherQueue = `${queueName}-elsewhere`;
    const purgedId = await queue.enqueue("purge-prerequisite", {}, { queue: queueName });
    const pendingId = await queue.enqueue("pending-prerequisite", {}, { queue: otherQueue });
    const dependentId = await dependentOf([purgedId, pendingId], otherQueue, "cancel");

    expect(await admin.purgeQueue(queueName, adminAudit("purge one prerequisite"))).toBe(1);
    await expect(admin.getTask(dependentId)).resolves.toMatchObject({ state: "blocked" });

    const pending = await queue.claim("purge-pending-worker", { queue: otherQueue });
    expect(pending?.id).toBe(pendingId);
    expect(await queue.complete(pending!, "purge-pending-worker", null)).toBe(true);
    await expect(admin.getTask(dependentId)).resolves.toMatchObject({
      state: "canceled",
      error: expect.objectContaining({
        name: "DependencyCanceled",
        prerequisite_task_id: purgedId,
      }),
    });
  });

  it("cancels every purged task above a dependent that stays", async () => {
    const queueName = "purge-dependent-chain";
    const otherQueue = `${queueName}-elsewhere`;
    const rootId = await queue.enqueue("purge-root", {}, { queue: queueName });
    const middleId = await dependentOf([rootId], queueName);
    const deletedId = await queue.enqueue("purge-unrelated", {}, { queue: queueName });
    const dependentId = await dependentOf([middleId], otherQueue);

    expect(await admin.purgeQueue(queueName, adminAudit("purge a chain"))).toBe(3);
    await expect(admin.getTask(deletedId)).resolves.toBeNull();
    // The middle task is canceled by the purge, not by the cancellation of its prerequisite.
    await expect(admin.getTask(middleId)).resolves.toMatchObject({
      state: "canceled",
      error: expect.not.objectContaining({ name: "DependencyCanceled" }),
    });
    await expect(admin.getTask(rootId)).resolves.toMatchObject({ state: "canceled" });
    await expect(admin.getTask(dependentId)).resolves.toMatchObject({
      state: "canceled",
      error: expect.objectContaining({
        name: "DependencyCanceled",
        prerequisite_task_id: middleId,
      }),
    });
  });

  it("deletes a prerequisite whose dependent is already terminal", async () => {
    const queueName = "purge-dependent-terminal";
    const otherQueue = `${queueName}-elsewhere`;
    const prerequisiteId = await queue.enqueue("purge-prerequisite", {}, { queue: queueName });
    const dependentId = await dependentOf([prerequisiteId], otherQueue);
    await expect(queue.cancel(dependentId)).resolves.toMatchObject({ status: "canceled" });

    expect(await admin.purgeQueue(queueName, adminAudit("purge a released edge"))).toBe(1);
    await expect(admin.getTask(prerequisiteId)).resolves.toBeNull();
    await expect(admin.getTask(dependentId)).resolves.toMatchObject({ state: "canceled" });
    expect(await edgesFrom(prerequisiteId)).toBe(0);
  });

  it.each(enqueueOrders)(
    "does not deadlock with a cancel of the purged task (%s)",
    async (order) => {
      // The purged task comes first or second in identity order relative to its dependent.
      const { queueName, prerequisiteId, dependentId } = await arrangeDependent(
        "purge-cancel-race",
        order,
      );
      // A second prerequisite in the purged queue makes the purge cancel a task of its own.
      const otherId = await queue.enqueue("purge-prerequisite", {}, { queue: queueName });
      const otherDependentId = await dependentOf([otherId], `${queueName}-elsewhere`);
      const canceler = await pool.connect();
      try {
        // A cancel locks the purged task first. Its outcome trigger then locks the dependent.
        await canceler.query("BEGIN");
        await canceler.query("SELECT 1 FROM workhorse.task_runtime WHERE task_id = $1 FOR UPDATE", [
          prerequisiteId,
        ]);
        const pid = (await canceler.query<{ pid: number }>("SELECT pg_backend_pid() AS pid"))
          .rows[0]!.pid;
        const purge = admin
          .purgeQueue(queueName, adminAudit("purge during a cancel"))
          .catch((error: unknown) => error);
        await waitForDatabaseCondition(() => blockedBy(pid));
        // The purge waits for the purged task and holds no lock on its dependent, so the cancel
        // settles the dependent while the purge waits.
        await expect(queue.forDatabase(canceler).cancel(prerequisiteId)).resolves.toMatchObject({
          status: "canceled",
        });
        await canceler.query("COMMIT");
        expect(await purge).toBe(1);
        await expect(admin.getTask(dependentId)).resolves.toMatchObject({ state: "canceled" });
        await expect(admin.getTask(otherId)).resolves.toMatchObject({ state: "canceled" });
        await expect(admin.getTask(otherDependentId)).resolves.toMatchObject({
          state: "canceled",
        });
      } finally {
        await canceler.query("ROLLBACK").catch(() => undefined);
        canceler.release();
      }
    },
  );

  // An enqueue that names a purged task and its dependent locks the lower one first. The purge
  // locks the dependent FOR NO KEY UPDATE, which an enqueue's key-share lock does not block. A
  // dependent that its policy releases thus never makes the two wait for each other.
  it("does not deadlock with an enqueue that locks the purged task first", async () => {
    const { queueName, prerequisiteId, dependentId } = await arrangeDependent(
      "purge-enqueue-prerequisite-first",
      "lower first",
      "release",
    );
    const holder = await pool.connect();
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT 1 FROM workhorse.task_runtime WHERE task_id = $1 FOR KEY SHARE", [
        prerequisiteId,
      ]);
      const pid = (await holder.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!
        .pid;
      const purge = admin
        .purgeQueue(queueName, adminAudit("purge during an enqueue"))
        .catch((error: unknown) => error);
      await waitForDatabaseCondition(() => blockedBy(pid));
      // The purge waits for the purged task and holds no lock that the enqueue needs.
      await expect(
        queue.forDatabase(holder).enqueue(
          "purge-enqueue-dependent",
          {},
          {
            queue: `${queueName}-elsewhere`,
            dependencies: {
              prerequisiteTaskIds: [dependentId, prerequisiteId],
              onSuccess: "release",
              onFailure: "fail",
              onCancellation: "cancel",
            },
          },
        ),
      ).resolves.toEqual(expect.any(String));
      await holder.query("ROLLBACK");
      expect(await purge).toBe(1);
      await expect(admin.getTask(prerequisiteId)).resolves.toMatchObject({ state: "canceled" });
      await expect(admin.getTask(dependentId)).resolves.toMatchObject({ state: "ready" });
    } finally {
      await holder.query("ROLLBACK").catch(() => undefined);
      holder.release();
    }
  });

  it("does not deadlock with an enqueue that locks the dependent first", async () => {
    const { queueName, prerequisiteId, dependentId } = await arrangeDependent(
      "purge-enqueue-dependent-first",
      "higher first",
      "release",
    );
    const holder = await pool.connect();
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT 1 FROM workhorse.task_runtime WHERE task_id = $1 FOR KEY SHARE", [
        dependentId,
      ]);
      // The purge does not wait for the enqueue's key-share lock on the dependent.
      expect(await admin.purgeQueue(queueName, adminAudit("purge during an enqueue"))).toBe(1);
      await expect(admin.getTask(dependentId)).resolves.toMatchObject({ state: "ready" });
      // The enqueue then takes its next lock and sees the canceled prerequisite.
      await expect(
        queue.forDatabase(holder).enqueue(
          "purge-enqueue-dependent",
          {},
          {
            queue: `${queueName}-elsewhere`,
            dependencies: {
              prerequisiteTaskIds: [dependentId, prerequisiteId],
              onSuccess: "release",
              onFailure: "fail",
              onCancellation: "cancel",
            },
          },
        ),
      ).resolves.toEqual(expect.any(String));
      await holder.query("ROLLBACK");
      await expect(admin.getTask(prerequisiteId)).resolves.toMatchObject({ state: "canceled" });
    } finally {
      await holder.query("ROLLBACK").catch(() => undefined);
      holder.release();
    }
  });

  // Queue q1 holds A and C, queue q2 holds B. B depends on A, and C depends on B. Without a purge
  // lock, a purge of q1 holds C and waits for its outside dependent B, while a purge of q2 holds B
  // and waits for its outside dependent C. A key-share lock on a task row stops the first purge
  // after it holds its runtime rows, so the second purge reaches its wait first.
  it.each([
    { first: "q1", counts: { q1: 2, q2: 0 } },
    { first: "q2", counts: { q1: 1, q2: 1 } },
  ] as const)(
    "serializes two purges across a dependency chain ($first first)",
    async (scenario) => {
      const q1 = `purge-chain-${scenario.first}-first`;
      const q2 = `${q1}-other`;
      const aId = await queue.enqueue("purge-prerequisite", {}, { queue: q1 });
      const bId = await dependentOf([aId], q2);
      const cId = await dependentOf([bId], q1);
      const queues = { q1, q2 };
      const second = scenario.first === "q1" ? "q2" : "q1";
      const holder = await pool.connect();
      try {
        await holder.query("BEGIN");
        await holder.query("SELECT 1 FROM workhorse.task WHERE id = $1 FOR KEY SHARE", [
          scenario.first === "q1" ? cId : bId,
        ]);
        const waiting = async (count: number) =>
          (
            await pool.query<{ count: number }>(
              `SELECT count(*)::integer AS count FROM pg_stat_activity
              WHERE datname = current_database() AND cardinality(pg_blocking_pids(pid)) > 0`,
            )
          ).rows[0]!.count >= count;
        const firstPurge = admin
          .purgeQueue(queues[scenario.first], adminAudit("purge the first queue"))
          .catch((error: unknown) => error);
        await waitForDatabaseCondition(() => waiting(1));
        const secondPurge = admin
          .purgeQueue(queues[second], adminAudit("purge the second queue"))
          .catch((error: unknown) => error);
        await waitForDatabaseCondition(() => waiting(2));
        await holder.query("ROLLBACK");
        expect({
          [scenario.first]: await firstPurge,
          [second]: await secondPurge,
        }).toEqual(scenario.counts);
        await expect(admin.getTask(cId)).resolves.not.toMatchObject({ state: "blocked" });
      } finally {
        await holder.query("ROLLBACK").catch(() => undefined);
        holder.release();
      }
    },
  );
});
