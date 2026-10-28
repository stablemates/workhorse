import { describe, expect, it } from "vitest";
import {
  FastTierUnsupportedError,
  MAX_TASK_GROUP_MEMBERS,
  Queue,
  TaskGroupClosedError,
  TaskGroupLimitExceededError,
  TaskGroupMembershipConflictError,
  Worker,
  type ClaimedTask,
  type EnqueueRequest,
  type Queryable,
  type TaskGroupLink,
} from "../src/index.js";
import { createIntegrationTestContext } from "./support/integration.js";

const { admin, adminAudit, pool, queue, waitForDatabaseCondition } = createIntegrationTestContext(
  import.meta.url,
);

const member = (queueName: string, payload: number, options = {}): EnqueueRequest => ({
  type: "member",
  payload,
  options: { queue: queueName, maxAttempts: 1, ...options },
});

const callbacks = (queueName: string) => ({
  onFinish: { type: "finished", payload: { kind: "finish" }, options: { queue: queueName } },
  onSuccess: { type: "succeeded", payload: { kind: "success" }, options: { queue: queueName } },
  onFailure: { type: "failed", payload: { kind: "failure" }, options: { queue: queueName } },
});

async function claimAll(queueName: string, workerId = "group-worker"): Promise<ClaimedTask[]> {
  return queue.claimMany(workerId, 100, { queue: queueName });
}

async function completeAll(queueName: string, workerId = "group-worker"): Promise<void> {
  for (const task of await claimAll(queueName, workerId)) {
    expect(await queue.complete(task, workerId, null)).toBe(true);
  }
}

async function callbackTypes(queueName: string): Promise<string[]> {
  const result = await pool.query<{ task_type: string }>(
    "SELECT task_type FROM workhorse.task WHERE queue_name = $1 ORDER BY task_type",
    [queueName],
  );
  return result.rows.map((row) => row.task_type);
}

async function eventTypes(groupId: string): Promise<string[]> {
  return (await admin.listTaskGroupEvents(groupId)).map((event) => event.type);
}

describe("task groups", () => {
  it("creates, adds, and seals in one transaction, then enqueues onFinish and onSuccess", async () => {
    const { group, tasks } = await queue.taskGroup(callbacks("block-callbacks"), (builder) => {
      builder.add([member("block-members", 1), member("block-members", 2)]);
      builder.add([member("block-members", 3)]);
    });
    expect(group).toMatchObject({
      state: "sealed",
      result: null,
      counts: { total: 3, succeeded: 0, failed: 0, canceled: 0, pending: 3 },
    });
    expect(tasks.map((task) => task.outcome)).toEqual(["accepted", "accepted", "accepted"]);

    await completeAll("block-members");
    const finished = await queue.getTaskGroup(group.id);
    expect(finished).toMatchObject({
      state: "finished",
      result: "succeeded",
      counts: { total: 3, succeeded: 3, pending: 0 },
    });
    // PostgreSQL stores the callbacks as jsonb, which orders keys by length. The SDK keeps the
    // documented order.
    expect(finished!.callbacks.map((callback) => callback.kind)).toEqual([
      "onFinish",
      "onSuccess",
      "onFailure",
    ]);
    expect(finished!.callbacks.find((callback) => callback.kind === "onFailure")!.taskId).toBe(
      null,
    );
    await expect(callbackTypes("block-callbacks")).resolves.toEqual(["finished", "succeeded"]);
    await expect(eventTypes(group.id)).resolves.toEqual([
      "created",
      "sealed",
      "finished",
      "callback_enqueued",
      "callback_enqueued",
    ]);

    const page = await queue.listTaskGroupMembers(group.id, { limit: 2 });
    expect(page.members.map((item) => [item.position, item.outcome, item.state])).toEqual([
      [1, "succeeded", "succeeded"],
      [2, "succeeded", "succeeded"],
    ]);
    expect(page.nextAfter).toBe(2);
    const rest = await admin.listTaskGroupMembers(group.id, { after: page.nextAfter! });
    expect(rest).toMatchObject({ members: [{ position: 3 }], nextAfter: null });
    // When the member count is a multiple of the limit, the last full page has no next position.
    const exact = await queue.listTaskGroupMembers(group.id, { limit: 3 });
    expect(exact.members.map((item) => item.position)).toEqual([1, 2, 3]);
    expect(exact.nextAfter).toBeNull();
    const last = await admin.listTaskGroupMembers(group.id, { after: 2, limit: 1 });
    expect(last).toMatchObject({ members: [{ position: 3 }], nextAfter: null });
  });

  it("lets a callback handler read the group and its counts through ctx.taskGroup", async () => {
    const { group } = await queue.taskGroup(
      { onFinish: { type: "report", payload: { report: true }, options: { queue: "ctx-cb" } } },
      (builder) => builder.add([member("ctx-members", 1)]),
    );
    const failed = (await claimAll("ctx-members"))[0]!;
    expect(await queue.fail(failed, "group-worker", new Error("boom"))).toBe("failed");

    let seen: TaskGroupLink | null = null;
    let payload: unknown;
    const worker = new Worker(queue, { queue: "ctx-cb", workerId: "ctx-worker" });
    worker.handle("report", async (value, context) => {
      payload = value;
      seen = await context.taskGroup.get();
      return null;
    });
    expect(await worker.runOnce()).toBe(true);
    expect(payload).toEqual({ report: true });
    expect(seen).toMatchObject({
      role: "callback",
      callback: "onFinish",
      group: { id: group.id, result: "failed", counts: { total: 1, failed: 1 } },
    });
  });

  it("runs onFinish and onFailure when a member fails, and counts a canceled member as not succeeded", async () => {
    const { group } = await queue.taskGroup(callbacks("fail-callbacks"), (builder) =>
      builder.add([member("fail-members", 1), member("fail-members", 2)]),
    );
    const [first, second] = await claimAll("fail-members");
    expect(await queue.fail(first!, "group-worker", new Error("boom"))).toBe("failed");
    await queue.cancel(second!.id, { requestedBy: "test", reason: "stop" });
    expect(await queue.acknowledgeCancel(second!, "group-worker")).toBe(true);
    await expect(queue.getTaskGroup(group.id)).resolves.toMatchObject({
      state: "finished",
      result: "failed",
      counts: { failed: 1, canceled: 1, pending: 0 },
    });
    await expect(callbackTypes("fail-callbacks")).resolves.toEqual(["failed", "finished"]);
  });

  it("finishes an empty group at the seal and rejects an add to it", async () => {
    const group = await queue.createTaskGroup(callbacks("empty-callbacks"));
    expect(group).toMatchObject({ state: "open", counts: { total: 0 } });
    await expect(queue.sealTaskGroup(group.id)).resolves.toMatchObject({
      state: "finished",
      result: "succeeded",
    });
    await expect(callbackTypes("empty-callbacks")).resolves.toEqual(["finished", "succeeded"]);
    const refusal = queue.addToTaskGroup(group.id, [member("empty-members", 1)]);
    await expect(refusal).rejects.toBeInstanceOf(TaskGroupClosedError);
    await expect(refusal).rejects.toMatchObject({
      details: { groupId: group.id, state: "finished", reason: "finished" },
    });
    await expect(queue.sealTaskGroup(group.id)).resolves.toMatchObject({ state: "finished" });
  });

  it("accepts adds after the seal only from a running member task", async () => {
    const { group } = await queue.taskGroup(callbacks("member-add-cb"), (builder) =>
      builder.add([member("member-add", 1)]),
    );
    await expect(queue.addToTaskGroup(group.id, [member("member-add", 2)])).rejects.toMatchObject({
      details: { reason: "sealed" },
    });

    const worker = new Worker(queue, { queue: "member-add", workerId: "member-add-worker" });
    worker.handle("member", async (payload: number, context) => {
      if (payload === 1) await context.taskGroup.add([member("member-add", 10)]);
      return null;
    });
    expect(await worker.runOnce()).toBe(true);
    await expect(queue.getTaskGroup(group.id)).resolves.toMatchObject({
      state: "sealed",
      counts: { total: 2, succeeded: 1, pending: 1 },
    });
    expect(await worker.runOnce()).toBe(true);
    await expect(queue.getTaskGroup(group.id)).resolves.toMatchObject({
      state: "finished",
      counts: { total: 2, succeeded: 2 },
    });

    // A stale member lease cannot add.
    const { group: other } = await queue.taskGroup({}, (builder) =>
      builder.add([member("stale-add", 1)]),
    );
    const claimed = (await claimAll("stale-add"))[0]!;
    await expect(
      queue.addToTaskGroupAsMember(
        { ...claimed, fenceToken: claimed.fenceToken + 1n },
        "group-worker",
        [member("stale-add", 2)],
      ),
    ).rejects.toMatchObject({ details: { groupId: other.id, reason: "not_running_member" } });
  });

  it("puts a member add without a queue on the queue of the member task", async () => {
    const { group } = await queue.taskGroup({}, (builder) =>
      builder.add([member("default-add", 1)]),
    );
    const worker = new Worker(queue, { queue: "default-add", workerId: "default-add-worker" });
    worker.handle("member", async (_payload: number, context) => {
      // The request names no queue, so the added member goes to the queue of its member task.
      await context.taskGroup.add([{ type: "member", payload: 2, options: { maxAttempts: 1 } }]);
      return null;
    });
    expect(await worker.runOnce()).toBe(true);

    const page = await queue.listTaskGroupMembers(group.id);
    expect(page.members).toHaveLength(2);
    await expect(admin.getTask(page.members[0]!.taskId)).resolves.toMatchObject({
      queue: "default-add",
    });
    await expect(admin.getTask(page.members[1]!.taskId)).resolves.toMatchObject({
      queue: "default-add",
    });
  });

  it.each(["seal", "outcome"] as const)(
    "enqueues each callback one time when the %s comes first and the other change waits",
    async (first) => {
      const queueName = `race-${first}`;
      const group = await queue.createTaskGroup(callbacks(`${queueName}-cb`));
      await queue.addToTaskGroup(group.id, [member(queueName, 1)]);
      const task = (await claimAll(queueName))[0]!;
      const seal = (database: Queryable) => queue.forDatabase(database).sealTaskGroup(group.id);
      const complete = (database: Queryable) =>
        queue.forDatabase(database).complete(task, "group-worker", null);
      const holder = await pool.connect();
      const waiter = await pool.connect();
      try {
        await holder.query("BEGIN");
        await (first === "seal" ? seal(holder) : complete(holder));
        // An outcome changes the shard rows at commit (ADR 0096). Run that step now, so the
        // holder takes the group row lock when its shard reaches 0.
        if (first === "outcome") await holder.query("SET CONSTRAINTS ALL IMMEDIATE");
        const waiterPid = (await waiter.query<{ pid: number }>("SELECT pg_backend_pid() AS pid"))
          .rows[0]!.pid;
        const waiting = first === "seal" ? complete(waiter) : seal(waiter);
        // The second change waits for the group row lock that the first one holds.
        await waitForDatabaseCondition(async () => {
          const activity = await pool.query<{ waiting: boolean }>(
            "SELECT wait_event_type = 'Lock' AS waiting FROM pg_stat_activity WHERE pid = $1",
            [waiterPid],
          );
          return activity.rows[0]?.waiting === true;
        });
        await holder.query("COMMIT");
        await waiting;
      } finally {
        holder.release();
        waiter.release();
      }
      await expect(queue.getTaskGroup(group.id)).resolves.toMatchObject({ state: "finished" });
      await expect(callbackTypes(`${queueName}-cb`)).resolves.toEqual(["finished", "succeeded"]);
    },
  );

  it("locks the prerequisites of an add before the group row", async () => {
    const { group } = await queue.taskGroup({}, (builder) =>
      builder.add([member("lock-order", 1)]),
    );
    const running = (await claimAll("lock-order"))[0]!;
    const completion = await pool.connect();
    const observer = await pool.connect();
    try {
      // The first step of a completion: it holds the member's runtime row.
      await completion.query("BEGIN");
      await completion.query("SELECT 1 FROM workhorse.task_runtime WHERE task_id = $1 FOR UPDATE", [
        running.id,
      ]);
      const pid = (await completion.query<{ pid: number }>("SELECT pg_backend_pid() AS pid"))
        .rows[0]!.pid;
      const add = queue.addToTaskGroupAsMember(running, "group-worker", [
        member("lock-order", 2, { prerequisiteTaskId: running.id }),
      ]);
      await waitForDatabaseCondition(async () => {
        const blocked = await pool.query<{ count: number }>(
          "SELECT count(*)::integer AS count FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))",
          [pid],
        );
        return blocked.rows[0]!.count > 0;
      });
      // The add waits for the runtime row and does not hold the group row, so the completion can
      // take the group row next.
      await observer.query("BEGIN");
      await expect(
        observer.query("SELECT 1 FROM workhorse.task_group WHERE id = $1 FOR UPDATE NOWAIT", [
          group.id,
        ]),
      ).resolves.toMatchObject({ rowCount: 1 });
      await observer.query("ROLLBACK");
      await completion.query("ROLLBACK");
      await expect(add).resolves.toEqual([expect.objectContaining({ outcome: "accepted" })]);
    } finally {
      completion.release();
      observer.release();
    }
  });

  it("locks the member and the prerequisites of a member add in identity order", async () => {
    // cancel_task_group_v1 locks the runtime rows of live members in identity order. A member add
    // that names a lower member as a prerequisite must not hold the higher member while it waits.
    const { group } = await queue.taskGroup({}, (builder) =>
      builder.add([member("identity-order", 1), member("identity-order", 2)]),
    );
    const [lower, higher] = (await claimAll("identity-order")).toSorted((left, right) =>
      left.id < right.id ? -1 : 1,
    );
    const holder = await pool.connect();
    const observer = await pool.connect();
    try {
      // The first step of cancel_task_group_v1: it holds the lower member's runtime row.
      await holder.query("BEGIN");
      await holder.query("SELECT 1 FROM workhorse.task_runtime WHERE task_id = $1 FOR UPDATE", [
        lower!.id,
      ]);
      const pid = (await holder.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!
        .pid;
      const add = queue.addToTaskGroupAsMember(higher!, "group-worker", [
        member("identity-order", 3, { prerequisiteTaskId: lower!.id }),
      ]);
      await waitForDatabaseCondition(async () => {
        const blocked = await pool.query<{ count: number }>(
          "SELECT count(*)::integer AS count FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))",
          [pid],
        );
        return blocked.rows[0]!.count > 0;
      });
      // The waiting add does not hold the higher member, so the cancel could lock it next.
      await observer.query("BEGIN");
      await expect(
        observer.query(
          "SELECT 1 FROM workhorse.task_runtime WHERE task_id = $1 FOR UPDATE NOWAIT",
          [higher!.id],
        ),
      ).resolves.toMatchObject({ rowCount: 1 });
      await observer.query("ROLLBACK");
      await holder.query("ROLLBACK");
      await expect(add).resolves.toEqual([expect.objectContaining({ outcome: "accepted" })]);
    } finally {
      holder.release();
      observer.release();
    }
    await expect(queue.getTaskGroup(group.id)).resolves.toMatchObject({ counts: { total: 3 } });
  });

  it.each([
    ["an expired lease", "expires_at = clock_timestamp() - interval '1 second'"],
    ["a passed deadline", "deadline_at = clock_timestamp() - interval '1 second'"],
    ["a passed attempt timeout", "attempt_timeout_at = clock_timestamp() - interval '1 second'"],
  ])("refuses a member add after %s", async (_label, change) => {
    const queueName = `fenced-add-${change.slice(0, change.indexOf(" "))}`;
    const { group } = await queue.taskGroup({}, (builder) => builder.add([member(queueName, 1)]));
    const running = (await claimAll(queueName))[0]!;
    await pool.query(`UPDATE workhorse.task_runtime SET ${change} WHERE task_id = $1`, [
      running.id,
    ]);

    await expect(
      queue.addToTaskGroupAsMember(running, "group-worker", [member(queueName, 2)]),
    ).rejects.toMatchObject({ details: { groupId: group.id, reason: "not_running_member" } });
    await expect(queue.getTaskGroup(group.id)).resolves.toMatchObject({ counts: { total: 1 } });
  });

  it("refuses a member add after a cancel request for the member", async () => {
    const { group } = await queue.taskGroup({}, (builder) =>
      builder.add([member("fenced-add-cancel", 1)]),
    );
    const running = (await claimAll("fenced-add-cancel"))[0]!;
    await expect(queue.cancel(running.id)).resolves.toMatchObject({ status: "cancel_requested" });

    await expect(
      queue.addToTaskGroupAsMember(running, "group-worker", [member("fenced-add-cancel", 2)]),
    ).rejects.toMatchObject({ details: { groupId: group.id, reason: "not_running_member" } });
    await expect(queue.getTaskGroup(group.id)).resolves.toMatchObject({ counts: { total: 1 } });
  });

  it("refuses a member add from the old lease after a reclaim", async () => {
    const { group } = await queue.taskGroup({}, (builder) =>
      builder.add([member("fenced-add-reclaim", 1, { maxAttempts: 2 })]),
    );
    const stale = (await claimAll("fenced-add-reclaim", "old-worker"))[0]!;
    await pool.query(
      "UPDATE workhorse.task_runtime SET expires_at = clock_timestamp() - interval '1 second' WHERE task_id = $1",
      [stale.id],
    );
    expect(await queue.recoverExpired(100, 0)).toBe(1);
    const current = (await claimAll("fenced-add-reclaim", "new-worker"))[0]!;
    expect(current).toMatchObject({ id: stale.id });
    expect(current.fenceToken).toBeGreaterThan(stale.fenceToken);

    await expect(
      queue.addToTaskGroupAsMember(stale, "old-worker", [member("fenced-add-reclaim", 2)]),
    ).rejects.toMatchObject({ details: { groupId: group.id, reason: "not_running_member" } });
    await expect(
      queue.addToTaskGroupAsMember(current, "new-worker", [member("fenced-add-reclaim", 3)]),
    ).resolves.toEqual([expect.objectContaining({ outcome: "accepted" })]);
    await expect(queue.getTaskGroup(group.id)).resolves.toMatchObject({ counts: { total: 2 } });
  });

  it("makes a completion wait for a member add that holds the member, without a deadlock", async () => {
    const { group } = await queue.taskGroup({}, (builder) =>
      builder.add([member("add-then-complete", 1)]),
    );
    const running = (await claimAll("add-then-complete"))[0]!;
    const adder = await pool.connect();
    const completer = await pool.connect();
    try {
      await adder.query("BEGIN");
      await queue
        .forDatabase(adder)
        .addToTaskGroupAsMember(running, "group-worker", [member("add-then-complete", 2)]);
      const adderPid = (await adder.query<{ pid: number }>("SELECT pg_backend_pid() AS pid"))
        .rows[0]!.pid;
      const completion = queue.forDatabase(completer).complete(running, "group-worker", null);
      // The completion waits for the member's runtime row, the first lock that the add took.
      await waitForDatabaseCondition(async () => {
        const blocked = await pool.query<{ count: number }>(
          "SELECT count(*)::integer AS count FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))",
          [adderPid],
        );
        return blocked.rows[0]!.count > 0;
      });
      await adder.query("COMMIT");
      await expect(completion).resolves.toBe(true);
    } finally {
      adder.release();
      completer.release();
    }
    await expect(queue.getTaskGroup(group.id)).resolves.toMatchObject({
      counts: { total: 2, succeeded: 1, pending: 1 },
    });
  });

  it("makes a member add wait for the completion of the member before any group lock", async () => {
    // A second member keeps the group from finishing at the completion.
    const { group } = await queue.taskGroup({}, (builder) =>
      builder.add([member("complete-then-add", 1), member("complete-then-add", 2)]),
    );
    const running = (await claimAll("complete-then-add"))[0]!;
    const completer = await pool.connect();
    const observer = await pool.connect();
    try {
      await completer.query("BEGIN");
      expect(await queue.forDatabase(completer).complete(running, "group-worker", null)).toBe(true);
      const completerPid = (
        await completer.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")
      ).rows[0]!.pid;
      // Catch the refusal now, because it can arrive before the reply to COMMIT.
      const add = queue
        .addToTaskGroupAsMember(running, "group-worker", [member("complete-then-add", 3)])
        .catch((error: unknown) => error);
      await waitForDatabaseCondition(async () => {
        const blocked = await pool.query<{ count: number }>(
          "SELECT count(*)::integer AS count FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))",
          [completerPid],
        );
        return blocked.rows[0]!.count > 0;
      });
      // The waiting add holds no shard row and no group row, so the completion can count its
      // outcome at commit.
      await observer.query("BEGIN");
      await expect(
        observer.query(
          "SELECT 1 FROM workhorse.task_group_shard WHERE group_id = $1 FOR UPDATE NOWAIT",
          [group.id],
        ),
      ).resolves.toMatchObject({ rowCount: expect.any(Number) });
      await expect(
        observer.query("SELECT 1 FROM workhorse.task_group WHERE id = $1 FOR UPDATE NOWAIT", [
          group.id,
        ]),
      ).resolves.toMatchObject({ rowCount: 1 });
      await observer.query("ROLLBACK");
      await completer.query("COMMIT");
      expect(await add).toBeInstanceOf(TaskGroupClosedError);
      expect(await add).toMatchObject({
        details: { groupId: group.id, reason: "not_running_member" },
      });
    } finally {
      completer.release();
      observer.release();
    }
    await expect(queue.getTaskGroup(group.id)).resolves.toMatchObject({
      state: "sealed",
      counts: { total: 2, succeeded: 1, pending: 1 },
    });
  });

  it("stores a callback under the current contract version after a mismatch", async () => {
    const versions = { one: { payloadSchema: {} }, two: { payloadSchema: {} } };
    const synced = new Queue(pool, "default", {
      contracts: { "contracted.callback": { currentVersion: "one", versions } },
    });
    await synced.syncContracts();
    await pool.query("SELECT workhorse.override_contract_version_v1('contracted.callback', 'two')");
    const group = await synced.createTaskGroup({
      onFinish: { type: "contracted.callback", payload: {}, options: { queue: "contract-cb" } },
    });
    const stored = await pool.query<{ version: string }>(
      "SELECT on_finish->>'contractVersion' AS version FROM workhorse.task_group WHERE id = $1",
      [group.id],
    );
    expect(stored.rows).toEqual([{ version: "two" }]);
    await expect(
      pool.query("SELECT count(*)::integer AS count FROM workhorse.task_group"),
    ).resolves.toMatchObject({ rows: [{ count: 1 }] });
  });

  it("does not count a retry, and counts the outcome that ends the member", async () => {
    const { group } = await queue.taskGroup({}, (builder) =>
      builder.add([
        {
          type: "member",
          payload: 1,
          options: {
            queue: "retry-members",
            maxAttempts: 2,
            retryPolicy: { type: "fixed", delayMs: 1 },
          },
        },
      ]),
    );
    const firstAttempt = (await claimAll("retry-members"))[0]!;
    expect(await queue.fail(firstAttempt, "group-worker", new Error("again"), 0)).toBe("ready");
    await expect(queue.getTaskGroup(group.id)).resolves.toMatchObject({
      counts: { pending: 1, failed: 0 },
    });
    const secondAttempt = (await claimAll("retry-members"))[0]!;
    expect(await queue.fail(secondAttempt, "group-worker", new Error("final"), 0)).toBe("failed");
    await expect(queue.getTaskGroup(group.id)).resolves.toMatchObject({
      state: "finished",
      counts: { pending: 0, failed: 1 },
    });
  });

  it("counts a member whose enqueue writes its outcome at once", async () => {
    const { group } = await queue.taskGroup({}, (builder) =>
      builder.add([member("late-members", 1, { deadline: new Date(Date.now() - 60_000) })]),
    );
    await expect(queue.getTaskGroup(group.id)).resolves.toMatchObject({
      state: "finished",
      result: "failed",
      counts: { total: 1, failed: 1 },
    });
  });

  it("enforces the membership rules", async () => {
    const group = await queue.createTaskGroup();
    await admin.setQueueTier("fast-members", "fast", adminAudit("fast tier"));
    const fast = queue.addToTaskGroup(group.id, [member("fast-members", 1)]);
    await expect(fast).rejects.toBeInstanceOf(FastTierUnsupportedError);
    await expect(fast).rejects.toMatchObject({ feature: "task groups" });

    await expect(
      queue.addToTaskGroup(group.id, [
        member("rules", 1, { debounce: { key: "k", windowMs: 1_000 } }),
      ]),
    ).rejects.toThrow("cannot use debounce or throttle");
    await expect(
      pool.query("SELECT * FROM workhorse.add_task_group_members_v1($1, $2)", [
        group.id,
        JSON.stringify([{ queue: "rules", type: "member", payload: 1, throttle: { key: "k" } }]),
      ]),
    ).rejects.toThrow("cannot use debounce or throttle");

    // A task enqueued outside the group cannot join it through an idempotency hit.
    const [outside] = await queue.enqueueMany([
      member("rules", 1, { idempotency: { key: "outside" } }),
    ]);
    const conflict = queue.addToTaskGroup(group.id, [
      member("rules", 1, { idempotency: { key: "outside" } }),
    ]);
    await expect(conflict).rejects.toBeInstanceOf(TaskGroupMembershipConflictError);
    await expect(conflict).rejects.toMatchObject({
      details: { groupId: group.id, taskId: outside, ordinal: 1, memberOf: null },
    });

    // An idempotent retry of the same add returns the existing member.
    const [added] = await queue.addToTaskGroup(group.id, [
      member("rules", 2, { idempotency: { key: "inside" } }),
    ]);
    const [replayed] = await queue.addToTaskGroup(group.id, [
      member("rules", 2, { idempotency: { key: "inside" } }),
    ]);
    expect(replayed).toEqual({ taskId: added!.taskId, outcome: "replayed" });
    await expect(queue.getTaskGroup(group.id)).resolves.toMatchObject({ counts: { total: 1 } });

    // The same task cannot join a second group.
    const other = await queue.createTaskGroup();
    await expect(
      queue.addToTaskGroup(other.id, [member("rules", 2, { idempotency: { key: "inside" } })]),
    ).rejects.toMatchObject({ details: { memberOf: group.id } });

    await expect(
      queue.addToTaskGroup(
        group.id,
        Array.from({ length: 1_001 }, (_, index) => member("rules", index)),
      ),
    ).rejects.toThrow("at most 1000 tasks");
  });

  it("does not make a redriven member a member", async () => {
    const { group } = await queue.taskGroup({}, (builder) =>
      builder.add([member("redrive-members", 1)]),
    );
    const task = (await claimAll("redrive-members"))[0]!;
    expect(await queue.fail(task, "group-worker", new Error("boom"))).toBe("failed");
    const redrive = await admin.redrive(task.id, adminAudit("redrive"));
    await expect(queue.findTaskGroup(redrive.targetTaskId!)).resolves.toBeNull();
    await expect(queue.findTaskGroup(task.id)).resolves.toMatchObject({
      role: "member",
      group: { id: group.id },
    });
  });

  it("validates callbacks, and enqueues a callback on a fast-tier queue", async () => {
    await expect(
      queue.createTaskGroup({
        onFinish: { type: "cb", payload: null, options: { idempotency: { key: "k" } } },
      }),
    ).rejects.toThrow("cannot use enqueue idempotency, debounce, or throttle");
    await expect(
      pool.query("SELECT * FROM workhorse.create_task_group_v1($1)", [
        JSON.stringify({ onFinish: { queue: "q", type: "cb", throttle: { key: "k" } } }),
      ]),
    ).rejects.toThrow("cannot use enqueue idempotency, debounce, or throttle");
    await expect(
      pool.query("SELECT * FROM workhorse.create_task_group_v1($1)", [
        JSON.stringify({ onFinish: { queue: "", type: "cb" } }),
      ]),
    ).rejects.toThrow(/queue/);
    await expect(
      pool.query("SELECT count(*)::integer AS count FROM workhorse.task_group"),
    ).resolves.toMatchObject({ rows: [{ count: 0 }] });

    await admin.setQueueTier("fast-callbacks", "fast", adminAudit("fast tier"));
    const { group } = await queue.taskGroup(
      { onFinish: { type: "cb", payload: null, options: { queue: "fast-callbacks" } } },
      (builder) => builder.add([member("fast-cb-members", 1)]),
    );
    await completeAll("fast-cb-members");
    const callback = (await queue.getTaskGroup(group.id))!.callbacks[0]!;
    expect(callback.taskId).not.toBeNull();
    const fast = await queue.claimFast("fast-worker", 1, { queue: "fast-callbacks" });
    expect(fast.map((task) => task.id)).toEqual([callback.taskId]);
    await expect(queue.findTaskGroup(callback.taskId!)).resolves.toMatchObject({
      role: "callback",
      callback: "onFinish",
    });
  });

  it("checks every request option of a create and an add before any statement", async () => {
    const group = await queue.createTaskGroup({});
    const { group: sealed } = await queue.taskGroup({}, (builder) =>
      builder.add([member("checked-add-member", 1)]),
    );
    const running = (await claimAll("checked-add-member"))[0]!;
    let queryCount = 0;
    const countedDatabase: Queryable = {
      query(statement, values) {
        queryCount += 1;
        return pool.query(statement, values as unknown[]);
      },
    };
    // A new queue has no compatibility answer and no cached contract, so each read is a statement.
    const countedQueue = new Queue(countedDatabase, "default");
    const valid = member("checked-add", 1);
    const invalid = member("checked-add", 2, { maxAttempts: 101 });
    const message = "maxAttempts must be an integer between 1 and 100, or 0 for the default";

    await expect(
      countedQueue.createTaskGroup({
        onFinish: { type: "cb", payload: null },
        onSuccess: { type: "cb", payload: null, options: { priority: 101 } },
      }),
    ).rejects.toThrow("priority must be an integer between 0 and 100");
    let built = false;
    await expect(
      countedQueue.taskGroup({}, (builder) => {
        builder.add([valid, invalid]);
        built = true;
      }),
    ).rejects.toThrow(message);
    // The build runs to its end, as before. The options are checked after it.
    expect(built).toBe(true);
    await expect(
      countedQueue.taskGroup(
        { onFinish: { type: "cb", payload: null, options: { maxAttempts: 101 } } },
        (builder) => builder.add([valid]),
      ),
    ).rejects.toThrow(message);
    await expect(countedQueue.addToTaskGroup(group.id, [valid, invalid])).rejects.toThrow(message);
    await expect(
      countedQueue.addToTaskGroupAsMember(running, "group-worker", [valid, invalid]),
    ).rejects.toThrow(message);
    await expect(countedQueue.enqueueMany([valid, invalid])).rejects.toThrow(message);
    // A JavaScript caller can pass null for a coalescing option.
    for (const mode of ["idempotency", "debounce", "throttle"]) {
      const nullMode = member("checked-add", 3, { [mode]: null });
      await expect(countedQueue.enqueueMany([valid, nullMode])).rejects.toThrow(TypeError);
    }
    const nullKey = member("checked-add", 4, { idempotency: null });
    await expect(countedQueue.addToTaskGroup(group.id, [valid, nullKey])).rejects.toThrow(
      TypeError,
    );
    expect(queryCount).toBe(0);
    await expect(queue.getTaskGroup(sealed.id)).resolves.toMatchObject({ counts: { total: 1 } });
  });

  it("cancels a group: it seals, cancels live members, and finishes through onFailure", async () => {
    const group = await queue.createTaskGroup(callbacks("cancel-cb"));
    await queue.addToTaskGroup(group.id, [
      member("cancel-members", 1),
      member("cancel-members", 2),
      member("cancel-members", 3),
    ]);
    const [running] = await queue.claimMany("group-worker", 1, { queue: "cancel-members" });
    const audit = adminAudit("stop the import");
    const canceled = await admin.cancelTaskGroup(group.id, audit);
    expect(canceled).toMatchObject({
      state: "sealed",
      canceledBy: audit.actor,
      cancelReason: audit.reason,
      counts: { canceled: 2, pending: 1 },
    });
    await expect(
      queue.addToTaskGroupAsMember(running!, "group-worker", [member("cancel-members", 4)]),
    ).rejects.toMatchObject({ details: { reason: "canceled" } });
    expect(await queue.acknowledgeCancel(running!, "group-worker")).toBe(true);
    await expect(queue.getTaskGroup(group.id)).resolves.toMatchObject({
      state: "finished",
      result: "failed",
      counts: { canceled: 3 },
    });
    await expect(callbackTypes("cancel-cb")).resolves.toEqual(["failed", "finished"]);
    await expect(eventTypes(group.id)).resolves.toEqual([
      "created",
      "sealed",
      "canceled",
      "finished",
      "callback_enqueued",
      "callback_enqueued",
    ]);
    const finished = await queue.getTaskGroup(group.id);
    await expect(admin.cancelTaskGroup(group.id, adminAudit("again"))).resolves.toEqual(finished);
    await expect(admin.cancelTaskGroup(crypto.randomUUID(), adminAudit("unknown"))).resolves.toBe(
      null,
    );
  });

  it("counts a purged member as canceled, so the group can finish", async () => {
    const { group } = await queue.taskGroup(callbacks("purge-members"), (builder) =>
      builder.add([member("purge-members", 1), member("purge-other", 2)]),
    );
    await completeAll("purge-other");
    await expect(admin.purgeQueue("purge-members", adminAudit("purge"))).resolves.toBe(1);
    await expect(queue.getTaskGroup(group.id)).resolves.toMatchObject({
      state: "finished",
      result: "failed",
      counts: { succeeded: 1, canceled: 1 },
    });
    // The callbacks the purge enqueued on the purged queue survive it.
    await expect(callbackTypes("purge-members")).resolves.toEqual(["failed", "finished"]);
    await expect(admin.listTaskGroupMembers(group.id)).resolves.toMatchObject({
      members: [
        { position: 1, outcome: "canceled", state: null, queue: null },
        { position: 2, outcome: "succeeded", state: "succeeded" },
      ],
    });
  });

  it("counts a member that a purge cancels for a waiting dependent once", async () => {
    const { group } = await queue.taskGroup(callbacks("purge-kept-members"), (builder) =>
      builder.add([
        member("purge-kept-members", 1),
        member("purge-kept-members", 2),
        member("purge-kept-other", 3),
      ]),
    );
    const { members } = await admin.listTaskGroupMembers(group.id);
    const keptId = members[0]!.taskId;
    // A dependent outside the purge waits for the first member, so the purge cancels it.
    const dependentId = await queue.enqueue("purge-kept-dependent", null, {
      queue: "purge-kept-dependents",
      dependencies: {
        prerequisiteTaskIds: [keptId],
        onSuccess: "release",
        onFailure: "fail",
        onCancellation: "cancel",
      },
    });
    await completeAll("purge-kept-other");
    await expect(admin.purgeQueue("purge-kept-members", adminAudit("purge"))).resolves.toBe(2);
    await expect(queue.getTaskGroup(group.id)).resolves.toMatchObject({
      state: "finished",
      result: "failed",
      counts: { succeeded: 1, canceled: 2 },
    });
    await expect(admin.getTask(dependentId)).resolves.toMatchObject({ state: "canceled" });
    // The canceled member and the callbacks stay in the purged queue.
    await expect(callbackTypes("purge-kept-members")).resolves.toEqual([
      "failed",
      "finished",
      "member",
    ]);
    await expect(admin.listTaskGroupMembers(group.id)).resolves.toMatchObject({
      members: [
        { position: 1, outcome: "canceled", state: "canceled", queue: "purge-kept-members" },
        { position: 2, outcome: "canceled", state: null, queue: null },
        { position: 3, outcome: "succeeded", state: "succeeded" },
      ],
    });
  });

  it("finds and repairs a counter that disagrees with the member outcomes", async () => {
    const { group } = await queue.taskGroup(callbacks("drift-cb"), (builder) =>
      builder.add([member("drift-members", 1), member("drift-members", 2)]),
    );
    await completeAll("drift-members");
    // Simulate a lost count: the members are finished, but the group still counts them pending.
    // The two members are in shards 0 and 1, so two shards are pending.
    await pool.query(
      `UPDATE workhorse.task_group_member SET outcome = NULL, counted_at = NULL WHERE group_id = $1`,
      [group.id],
    );
    await pool.query(
      "UPDATE workhorse.task_group_shard SET succeeded_count = 0 WHERE group_id = $1",
      [group.id],
    );
    await pool.query(
      `UPDATE workhorse.task_group SET state = 'sealed', result = NULL, finished_at = NULL,
         total_count = 0, succeeded_count = 0, pending_shard_count = 2 WHERE id = $1`,
      [group.id],
    );
    await pool.query("DELETE FROM workhorse.task_group_callback WHERE group_id = $1", [group.id]);
    await pool.query("DELETE FROM workhorse.task WHERE queue_name = 'drift-cb'");

    await expect(admin.listTaskGroupDrift()).resolves.toEqual([
      {
        groupId: group.id,
        state: "sealed",
        recorded: { total: 2, succeeded: 0, failed: 0, canceled: 0 },
        counted: { total: 2, succeeded: 2, failed: 0, canceled: 0, pending: 0 },
        action: "finished",
      },
    ]);
    const audit = adminAudit("repair the counter");
    await expect(admin.repairTaskGroupDrift(audit)).resolves.toEqual([
      { groupId: group.id, recordedPending: 2, pending: 0, action: "finished" },
    ]);
    await expect(queue.getTaskGroup(group.id)).resolves.toMatchObject({
      state: "finished",
      result: "succeeded",
    });
    await expect(callbackTypes("drift-cb")).resolves.toEqual(["finished", "succeeded"]);
    const repaired = (await admin.listTaskGroupEvents(group.id)).find(
      (event) => event.type === "counter_repaired",
    );
    expect(repaired?.details).toMatchObject({
      requested_by: audit.actor,
      request_reason: audit.reason,
      recorded: { succeeded: 0 },
      counted: { succeeded: 2 },
    });
    await expect(admin.listTaskGroupDrift()).resolves.toEqual([]);
  });

  it("reads the newest events first, and keeps the oldest-first read unchanged", async () => {
    const group = await queue.createTaskGroup();
    // 1,200 repairs after the created event. The newest event has the ordinal 1200.
    await pool.query(
      `INSERT INTO workhorse.task_group_event(group_id, event_type, details, occurred_at)
       SELECT $1, 'counter_repaired', jsonb_build_object('ordinal', ordinal),
              clock_timestamp() + ordinal * interval '1 millisecond'
         FROM generate_series(1, 1200) AS ordinal`,
      [group.id],
    );

    const newest = await pool.query<{ event_type: string; ordinal: number | null }>(
      `SELECT event_type, (details ->> 'ordinal')::integer AS ordinal
         FROM workhorse.list_newest_task_group_events_v1($1, 101)`,
      [group.id],
    );
    expect(newest.rows.map((row) => row.ordinal)).toEqual(
      Array.from({ length: 101 }, (_, index) => 1200 - index),
    );
    const all = await pool.query<{ event_type: string }>(
      "SELECT event_type FROM workhorse.list_newest_task_group_events_v1($1, 1000)",
      [group.id],
    );
    expect(all.rows).toHaveLength(1000);
    expect(all.rows.every((row) => row.event_type === "counter_repaired")).toBe(true);

    const oldest = await admin.listTaskGroupEvents(group.id);
    expect(oldest).toHaveLength(1000);
    expect(oldest[0]?.type).toBe("created");
    expect(oldest.at(-1)?.details).toEqual({ ordinal: 999 });

    for (const limit of [0, 1001, null]) {
      await expect(
        pool.query("SELECT * FROM workhorse.list_newest_task_group_events_v1($1, $2)", [
          group.id,
          limit,
        ]),
      ).rejects.toThrow("task group event limit must be between 1 and 1000");
    }
    await expect(
      pool.query("SELECT * FROM workhorse.list_newest_task_group_events_v1(NULL, 10)"),
    ).rejects.toThrow("task group identity is required");
  });

  it("finishes a stalled sealed group in the terminal storage routine", async () => {
    const { group } = await queue.taskGroup(callbacks("stall-cb"), (builder) =>
      builder.add([member("stall-members", 1)]),
    );
    const task = (await claimAll("stall-members"))[0]!;
    // Lose the count of the last outcome.
    await pool.query(
      "ALTER TABLE workhorse.task_outcome DISABLE TRIGGER task_outcome_settle_task_groups_insert",
    );
    try {
      expect(await queue.complete(task, "group-worker", null)).toBe(true);
    } finally {
      await pool.query(
        "ALTER TABLE workhorse.task_outcome ENABLE TRIGGER task_outcome_settle_task_groups_insert",
      );
    }
    await expect(queue.getTaskGroup(group.id)).resolves.toMatchObject({ state: "sealed" });
    const phases = await queue.pruneTerminalStorage({ force: true });
    expect(phases.map((phase) => phase.phase)).toEqual([
      "enqueue_idempotency",
      "released_dependencies",
      "terminal_tasks",
      "task_groups",
    ]);
    expect(phases.at(-1)).toMatchObject({ rowsAffected: 1, error: null });
    await expect(queue.getTaskGroup(group.id)).resolves.toMatchObject({
      state: "finished",
      counts: { succeeded: 1 },
    });
    await expect(callbackTypes("stall-cb")).resolves.toEqual(["finished", "succeeded"]);
  });

  it("keeps members of an unfinished group and deletes a finished group after its callbacks", async () => {
    const age = async (sql: string, ids: readonly string[]) =>
      pool.query(sql.replaceAll("$ago", "clock_timestamp() - interval '30 days'"), [ids]);
    const ageTasks = (ids: readonly string[]) =>
      Promise.all([
        age("UPDATE workhorse.task SET created_at = $ago WHERE id = ANY($1::uuid[])", ids),
        age(
          "UPDATE workhorse.task_outcome SET finished_at = $ago, history_through_at = $ago WHERE task_id = ANY($1::uuid[])",
          ids,
        ),
        pool.query("DELETE FROM workhorse.task_event WHERE task_id = ANY($1::uuid[])", [ids]),
        pool.query("DELETE FROM workhorse.attempt_history WHERE task_id = ANY($1::uuid[])", [ids]),
      ]);

    const open = await queue.createTaskGroup();
    const [kept] = await queue.addToTaskGroup(open.id, [
      member("retention-members", 1),
      member("retention-members", 2),
    ]);
    await completeAll("retention-members");
    await ageTasks([kept!.taskId]);

    const { group: finished } = await queue.taskGroup(
      { onFinish: { type: "cb", payload: null, options: { queue: "retention-cb" } } },
      (builder) => builder.add([member("retention-finished", 1)]),
    );
    await completeAll("retention-finished");
    await age("UPDATE workhorse.task_group SET finished_at = $ago WHERE id = ANY($1::uuid[])", [
      finished.id,
    ]);

    // The callback task is live, so the finished group stays.
    await queue.pruneTerminalStorage({ force: true });
    await expect(queue.getTaskGroup(finished.id)).resolves.not.toBeNull();
    await expect(admin.getTask(kept!.taskId)).resolves.not.toBeNull();

    await completeAll("retention-cb");
    await queue.pruneTerminalStorage({ force: true });
    await expect(queue.getTaskGroup(finished.id)).resolves.toBeNull();
    await expect(
      pool.query(
        "SELECT count(*)::integer AS count FROM workhorse.task_group_member WHERE group_id = $1",
        [finished.id],
      ),
    ).resolves.toMatchObject({ rows: [{ count: 0 }] });
    // The open group never expires, and its finished member stays.
    await expect(queue.getTaskGroup(open.id)).resolves.toMatchObject({ state: "open" });
    await expect(admin.getTask(kept!.taskId)).resolves.not.toBeNull();
  });

  it("checks the member limit under the group lock", async () => {
    const group = await queue.createTaskGroup();
    await queue.addToTaskGroup(group.id, [member("limit-members", 1)]);
    // The member count of a group is the sum of its shard totals. Member 1 is in shard 0.
    await pool.query(
      "UPDATE workhorse.task_group_shard SET total_count = total_count + $2 WHERE group_id = $1 AND shard = 1",
      [group.id, MAX_TASK_GROUP_MEMBERS - 2],
    );
    const refusal = queue.addToTaskGroup(group.id, [
      member("limit-members", 2),
      member("limit-members", 3),
    ]);
    await expect(refusal).rejects.toBeInstanceOf(TaskGroupLimitExceededError);
    await expect(refusal).rejects.toMatchObject({
      details: { groupId: group.id, limit: MAX_TASK_GROUP_MEMBERS, total: 99_999, requested: 2 },
    });
    await expect(
      pool.query(
        "SELECT count(*)::integer AS count FROM workhorse.task WHERE queue_name = 'limit-members'",
      ),
    ).resolves.toMatchObject({ rows: [{ count: 1 }] });
  });
});
