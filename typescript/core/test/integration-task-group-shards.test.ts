import type { PoolClient } from "pg";
import { describe, expect, it } from "vitest";
import type { ClaimedTask, EnqueueRequest } from "../src/index.js";
import { createIntegrationTestContext } from "./support/integration.js";

// Counter shards of task groups (ADR 0096). The statement trigger on task_outcome records a member
// outcome on its membership row and lists the member for the transaction. A deferred constraint
// trigger applies the list to the shard rows at commit.

const { admin, adminAudit, pool, queue } = createIntegrationTestContext(import.meta.url);

const member = (queueName: string, payload: number): EnqueueRequest => ({
  type: "member",
  payload,
  options: { queue: queueName, maxAttempts: 1 },
});

const members = (queueName: string, count: number): EnqueueRequest[] =>
  Array.from({ length: count }, (_, index) => member(queueName, index + 1));

interface ShardRow {
  shard: number;
  total: number;
  succeeded: number;
  failed: number;
  canceled: number;
}

async function shardRows(groupId: string): Promise<ShardRow[]> {
  const result = await pool.query<ShardRow>(
    `SELECT shard, total_count AS total, succeeded_count AS succeeded, failed_count AS failed,
            canceled_count AS canceled
       FROM workhorse.task_group_shard WHERE group_id = $1 ORDER BY shard`,
    [groupId],
  );
  return result.rows;
}

async function shard(groupId: string, index: number): Promise<ShardRow> {
  return (await shardRows(groupId))[index]!;
}

async function groupRow(groupId: string) {
  const result = await pool.query<{
    state: string;
    shard_count: number;
    pending_shard_count: number;
    total_count: number;
    succeeded_count: number;
    canceled_count: number;
  }>(
    `SELECT state, shard_count, pending_shard_count, total_count, succeeded_count, canceled_count
       FROM workhorse.task_group WHERE id = $1`,
    [groupId],
  );
  return result.rows[0]!;
}

/** The member tasks of a group, claimed, in position order. */
async function claimMembers(groupId: string, queueName: string): Promise<ClaimedTask[]> {
  const claimed = await queue.claimMany("shard-worker", 100, { queue: queueName });
  const page = await admin.listTaskGroupMembers(groupId, { limit: 1_000 });
  const byId = new Map(claimed.map((task) => [task.id, task]));
  return page.members.map((item) => byId.get(item.taskId)!);
}

async function listed(client: PoolClient): Promise<string[]> {
  const result = await client.query<{ listed: string[] }>(
    "SELECT workhorse.listed_task_group_outcomes_internal_v1()::text[] AS listed",
  );
  return result.rows[0]!.listed;
}

async function memberOutcome(client: PoolClient | typeof pool, taskId: string) {
  const result = await client.query<{ outcome: string | null }>(
    "SELECT outcome FROM workhorse.task_group_member WHERE task_id = $1",
    [taskId],
  );
  return result.rows[0]!.outcome;
}

async function callbackCount(groupId: string): Promise<number> {
  const result = await pool.query<{ count: number }>(
    "SELECT count(*)::integer AS count FROM workhorse.task_group_callback WHERE group_id = $1",
    [groupId],
  );
  return result.rows[0]!.count;
}

/** Whether another session can lock a row at once, without waiting for its holder. */
async function lockable(sql: string, values: unknown[]): Promise<boolean> {
  const observer = await pool.connect();
  try {
    await observer.query("BEGIN");
    await observer.query(`${sql} FOR UPDATE NOWAIT`, values);
    return true;
  } catch (error) {
    if ((error as { code?: string }).code === "55P03") return false;
    throw error;
  } finally {
    await observer.query("ROLLBACK");
    observer.release();
  }
}

async function inTransaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function groupPage(input: Record<string, unknown>): Promise<Record<string, unknown>> {
  const result = await pool.query<{ page: Record<string, unknown> }>(
    "SELECT workhorse.dashboard_task_groups_v1($1) AS page",
    [JSON.stringify(input)],
  );
  return result.rows[0]!.page;
}

const repairSql =
  "SELECT * FROM workhorse.repair_task_group_drift_v1(100, 'test', 'repair', 'r-1')";

describe("task group counter shards", () => {
  it("gives a new group 32 shard rows, spreads members by position, and writes the sums at the finish", async () => {
    const group = await queue.createTaskGroup();
    await queue.addToTaskGroup(group.id, members("spread", 34));
    const rows = await shardRows(group.id);
    expect(rows).toHaveLength(32);
    expect(rows.map((row) => row.total)).toEqual([2, 2, ...Array.from({ length: 30 }, () => 1)]);
    await expect(groupRow(group.id)).resolves.toMatchObject({
      state: "open",
      shard_count: 32,
      pending_shard_count: 32,
      total_count: 0,
      succeeded_count: 0,
    });
    await expect(queue.getTaskGroup(group.id)).resolves.toMatchObject({
      counts: { total: 34, pending: 34 },
    });

    for (const task of await claimMembers(group.id, "spread")) {
      expect(await queue.complete(task, "shard-worker", null)).toBe(true);
    }
    await expect(groupRow(group.id)).resolves.toMatchObject({
      state: "open",
      pending_shard_count: 0,
      total_count: 0,
    });
    await expect(queue.sealTaskGroup(group.id)).resolves.toMatchObject({
      state: "finished",
      counts: { total: 34, succeeded: 34, pending: 0 },
    });
    await expect(groupRow(group.id)).resolves.toMatchObject({
      total_count: 34,
      succeeded_count: 34,
    });
  });

  it("records an outcome at once, changes the shard at commit, and locks the group row only when the shard empties", async () => {
    const group = await queue.createTaskGroup();
    await queue.addToTaskGroup(group.id, members("lock-scope", 33));
    // Positions 1 and 33 select shard 0.
    const tasks = await claimMembers(group.id, "lock-scope");
    const shardRowSql =
      "SELECT 1 FROM workhorse.task_group_shard WHERE group_id = $1 AND shard = 0";
    const groupRowSql = "SELECT 1 FROM workhorse.task_group WHERE id = $1";

    await inTransaction(async (client) => {
      expect(await queue.forDatabase(client).complete(tasks[0]!, "shard-worker", null)).toBe(true);
      expect(await memberOutcome(client, tasks[0]!.id)).toBe("succeeded");
      expect(await listed(client)).toEqual([tasks[0]!.id]);
      // The outcome statement locks no shard row and no group row.
      await expect(lockable(shardRowSql, [group.id])).resolves.toBe(true);
      await expect(lockable(groupRowSql, [group.id])).resolves.toBe(true);

      await client.query("SET CONSTRAINTS ALL IMMEDIATE");
      expect(await listed(client)).toEqual([]);
      // Shard 0 still has position 33 pending, so the group row stays free.
      await expect(lockable(shardRowSql, [group.id])).resolves.toBe(false);
      await expect(lockable(groupRowSql, [group.id])).resolves.toBe(true);
    });
    await expect(shard(group.id, 0)).resolves.toMatchObject({ total: 2, succeeded: 1 });

    await inTransaction(async (client) => {
      expect(await queue.forDatabase(client).complete(tasks[32]!, "shard-worker", null)).toBe(true);
      await client.query("SET CONSTRAINTS ALL IMMEDIATE");
      // Shard 0 is now empty, so the apply step decreased pending_shard_count on the group row.
      await expect(lockable(groupRowSql, [group.id])).resolves.toBe(false);
    });
    await expect(groupRow(group.id)).resolves.toMatchObject({ pending_shard_count: 31 });
  });

  it("lets a seal pass an uncommitted member outcome, and the outcome finishes the group at commit", async () => {
    const group = await queue.createTaskGroup({
      onFinish: { type: "done", payload: null, options: { queue: "seal-pass-cb" } },
    });
    await queue.addToTaskGroup(group.id, [member("seal-pass", 1)]);
    const [task] = await claimMembers(group.id, "seal-pass");
    await inTransaction(async (client) => {
      expect(await queue.forDatabase(client).complete(task!, "shard-worker", null)).toBe(true);
      await expect(queue.sealTaskGroup(group.id)).resolves.toMatchObject({
        state: "sealed",
        counts: { pending: 1 },
      });
    });
    await expect(queue.getTaskGroup(group.id)).resolves.toMatchObject({
      state: "finished",
      counts: { succeeded: 1 },
    });
    await expect(callbackCount(group.id)).resolves.toBe(1);
  });

  it("removes the outcome of a rolled-back savepoint from the membership row and from the list", async () => {
    const group = await queue.createTaskGroup();
    await queue.addToTaskGroup(group.id, members("savepoint", 2));
    const [first, second] = await claimMembers(group.id, "savepoint");
    await inTransaction(async (client) => {
      const scoped = queue.forDatabase(client);
      await client.query("SAVEPOINT discarded");
      expect(await scoped.complete(first!, "shard-worker", null)).toBe(true);
      expect(await listed(client)).toEqual([first!.id]);
      await client.query("ROLLBACK TO SAVEPOINT discarded");
      expect(await listed(client)).toEqual([]);
      expect(await memberOutcome(client, first!.id)).toBeNull();

      await client.query("SAVEPOINT kept");
      expect(await scoped.complete(second!, "shard-worker", null)).toBe(true);
      await client.query("RELEASE SAVEPOINT kept");
      expect(await listed(client)).toEqual([second!.id]);
    });
    await expect(memberOutcome(pool, first!.id)).resolves.toBeNull();
    await expect(shard(group.id, 0)).resolves.toMatchObject({ total: 1, succeeded: 0 });
    await expect(shard(group.id, 1)).resolves.toMatchObject({ total: 1, succeeded: 1 });

    // The first member is still running, and its outcome counts one time.
    expect(await queue.complete(first!, "shard-worker", null)).toBe(true);
    await expect(queue.getTaskGroup(group.id)).resolves.toMatchObject({
      counts: { total: 2, succeeded: 2, pending: 0 },
    });
  });

  it("starts each transaction of a session with an empty list", async () => {
    const group = await queue.createTaskGroup();
    await queue.addToTaskGroup(group.id, members("session", 2));
    const [first, second] = await claimMembers(group.id, "session");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      expect(await queue.forDatabase(client).complete(first!, "shard-worker", null)).toBe(true);
      expect(await listed(client)).toEqual([first!.id]);
      await client.query("ROLLBACK");
      expect(await listed(client)).toEqual([]);

      await client.query("BEGIN");
      expect(await queue.forDatabase(client).complete(second!, "shard-worker", null)).toBe(true);
      await client.query("COMMIT");
      expect(await listed(client)).toEqual([]);

      // A later transaction that records nothing changes no shard.
      await client.query("BEGIN");
      await client.query("UPDATE workhorse.task_group SET updated_at = updated_at WHERE id = $1", [
        group.id,
      ]);
      await client.query("COMMIT");
    } finally {
      client.release();
    }
    await expect(shard(group.id, 0)).resolves.toMatchObject({ succeeded: 0 });
    await expect(shard(group.id, 1)).resolves.toMatchObject({ succeeded: 1 });
  });

  describe("a drift repair in the transaction of a recorded outcome", () => {
    it("counts the outcome one time when the repair comes after it", async () => {
      const { group } = await queue.taskGroup({}, (builder) =>
        builder.add(members("repair-after", 2)),
      );
      const [first, second] = await claimMembers(group.id, "repair-after");
      await inTransaction(async (client) => {
        expect(await queue.forDatabase(client).complete(first!, "shard-worker", null)).toBe(true);
        // The shard does not have the recorded outcome yet, so the group drifts.
        const repaired = await client.query(repairSql);
        expect(repaired.rows).toEqual([
          { group_id: group.id, recorded_pending: 2, pending: 1, action: "recounted" },
        ]);
        expect(await listed(client)).toEqual([]);
      });
      await expect(shard(group.id, 0)).resolves.toMatchObject({ total: 1, succeeded: 1 });
      await expect(admin.listTaskGroupDrift()).resolves.toEqual([]);

      expect(await queue.complete(second!, "shard-worker", null)).toBe(true);
      await expect(queue.getTaskGroup(group.id)).resolves.toMatchObject({
        state: "finished",
        counts: { total: 2, succeeded: 2 },
      });
    });

    it("counts an outcome that comes after the repair one time", async () => {
      const { group } = await queue.taskGroup({}, (builder) =>
        builder.add(members("repair-between", 2)),
      );
      const [first, second] = await claimMembers(group.id, "repair-between");
      await inTransaction(async (client) => {
        const scoped = queue.forDatabase(client);
        expect(await scoped.complete(first!, "shard-worker", null)).toBe(true);
        await client.query(repairSql);
        expect(await scoped.complete(second!, "shard-worker", null)).toBe(true);
        expect(await listed(client)).toEqual([second!.id]);
      });
      await expect(queue.getTaskGroup(group.id)).resolves.toMatchObject({
        state: "finished",
        counts: { total: 2, succeeded: 2, pending: 0 },
      });
      expect((await shardRows(group.id)).slice(0, 2)).toMatchObject([
        { total: 1, succeeded: 1 },
        { total: 1, succeeded: 1 },
      ]);
    });

    it("finishes the group one time when the maintenance phase repairs it", async () => {
      const { group } = await queue.taskGroup(
        { onFinish: { type: "done", payload: null, options: { queue: "repair-maint-cb" } } },
        (builder) => builder.add([member("repair-maint", 1)]),
      );
      const [task] = await claimMembers(group.id, "repair-maint");
      await inTransaction(async (client) => {
        expect(await queue.forDatabase(client).complete(task!, "shard-worker", null)).toBe(true);
        // The member has no live runtime row in this transaction, so the phase repairs the group.
        const repaired = await client.query<{ count: number }>(
          "SELECT workhorse.maintain_task_groups_v1(NULL, 10) AS count",
        );
        expect(repaired.rows[0]!.count).toBe(1);
        expect(await listed(client)).toEqual([]);
      });
      await expect(queue.getTaskGroup(group.id)).resolves.toMatchObject({
        state: "finished",
        counts: { total: 1, succeeded: 1 },
      });
      await expect(callbackCount(group.id)).resolves.toBe(1);
      const finishes = (await admin.listTaskGroupEvents(group.id)).filter(
        (event) => event.type === "finished",
      );
      expect(finishes).toHaveLength(1);
    });
  });

  it("counts an outcome one time when another transaction repairs the group before its commit", async () => {
    const { group } = await queue.taskGroup({}, (builder) =>
      builder.add(members("repair-concurrent", 2)),
    );
    const [first, second] = await claimMembers(group.id, "repair-concurrent");
    // Make the group drift in a shard with no member, so the repair runs.
    await pool.query(
      "UPDATE workhorse.task_group_shard SET total_count = 1 WHERE group_id = $1 AND shard = 5",
      [group.id],
    );
    const outcome = await pool.connect();
    try {
      await outcome.query("BEGIN");
      expect(await queue.forDatabase(outcome).complete(first!, "shard-worker", null)).toBe(true);
      // The repair does not wait for the uncommitted outcome. It counts the member as pending.
      await expect(pool.query(repairSql)).resolves.toMatchObject({
        rows: [{ group_id: group.id, recorded_pending: 3, pending: 2, action: "recounted" }],
      });
      await outcome.query("COMMIT");
    } finally {
      outcome.release();
    }
    await expect(shard(group.id, 0)).resolves.toMatchObject({ total: 1, succeeded: 1 });
    await expect(shard(group.id, 5)).resolves.toMatchObject({ total: 0 });
    await expect(admin.listTaskGroupDrift()).resolves.toEqual([]);
    expect(await queue.complete(second!, "shard-worker", null)).toBe(true);
    await expect(queue.getTaskGroup(group.id)).resolves.toMatchObject({
      state: "finished",
      counts: { total: 2, succeeded: 2 },
    });
  });

  it("refuses the second of two REPEATABLE READ outcomes that empty the last two shards", async () => {
    const { group } = await queue.taskGroup(
      { onFinish: { type: "done", payload: null, options: { queue: "rr-last-cb" } } },
      (builder) => builder.add(members("rr-last", 2)),
    );
    const [first, second] = await claimMembers(group.id, "rr-last");
    const left = await pool.connect();
    const right = await pool.connect();
    try {
      for (const client of [left, right]) {
        await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
        await client.query("SELECT 1 FROM workhorse.task_group WHERE id = $1", [group.id]);
      }
      expect(await queue.forDatabase(left).complete(first!, "shard-worker", null)).toBe(true);
      expect(await queue.forDatabase(right).complete(second!, "shard-worker", null)).toBe(true);
      await left.query("COMMIT");
      // The left commit wrote the group row after the right snapshot, so the right apply fails.
      await expect(right.query("COMMIT")).rejects.toMatchObject({ code: "40001" });
    } finally {
      left.release();
      right.release();
    }
    await expect(queue.getTaskGroup(group.id)).resolves.toMatchObject({
      state: "sealed",
      counts: { succeeded: 1, pending: 1 },
    });
    expect(await queue.complete(second!, "shard-worker", null)).toBe(true);
    await expect(queue.getTaskGroup(group.id)).resolves.toMatchObject({
      state: "finished",
      counts: { succeeded: 2 },
    });
    await expect(callbackCount(group.id)).resolves.toBe(1);
  });

  it("applies 1,000 member outcomes of one transaction in one pass at commit", async () => {
    const { group } = await queue.taskGroup({}, (builder) =>
      builder.add(members("thousand", 1_000)),
    );
    const tasks: ClaimedTask[] = [];
    for (let batch = 0; batch < 10; batch += 1) {
      tasks.push(...(await queue.claimMany("shard-worker", 100, { queue: "thousand" })));
    }
    expect(tasks).toHaveLength(1_000);
    await inTransaction(async (client) => {
      const scoped = queue.forDatabase(client);
      for (const task of tasks)
        expect(await scoped.complete(task, "shard-worker", null)).toBe(true);
      expect(await listed(client)).toHaveLength(1_000);
    });
    await expect(queue.getTaskGroup(group.id)).resolves.toMatchObject({
      state: "finished",
      counts: { total: 1_000, succeeded: 1_000, pending: 0 },
    });
    const totals = (await shardRows(group.id)).map((row) => row.total);
    expect(totals.slice(0, 8)).toEqual(Array.from({ length: 8 }, () => 32));
    expect(totals.slice(8)).toEqual(Array.from({ length: 24 }, () => 31));
  });

  it("applies the outcomes of several groups, and a second pass after SET CONSTRAINTS, one time each", async () => {
    const left = await queue.createTaskGroup();
    const right = await queue.createTaskGroup();
    await queue.addToTaskGroup(left.id, members("two-left", 2));
    await queue.addToTaskGroup(right.id, members("two-right", 2));
    const leftTasks = await claimMembers(left.id, "two-left");
    const rightTasks = await claimMembers(right.id, "two-right");
    await inTransaction(async (client) => {
      const scoped = queue.forDatabase(client);
      expect(await scoped.complete(leftTasks[0]!, "shard-worker", null)).toBe(true);
      expect(await scoped.complete(rightTasks[0]!, "shard-worker", null)).toBe(true);
      await client.query("SET CONSTRAINTS ALL IMMEDIATE");
      expect(await scoped.complete(leftTasks[1]!, "shard-worker", null)).toBe(true);
      expect(await scoped.complete(rightTasks[1]!, "shard-worker", null)).toBe(true);
    });
    for (const group of [left, right]) {
      await expect(queue.getTaskGroup(group.id)).resolves.toMatchObject({
        counts: { total: 2, succeeded: 2, pending: 0 },
      });
      await expect(groupRow(group.id)).resolves.toMatchObject({ pending_shard_count: 0 });
    }
  });

  it("cancels more members than one apply batch holds", async () => {
    const group = await queue.createTaskGroup();
    await queue.addToTaskGroup(group.id, members("cancel-many", 250));
    await expect(admin.cancelTaskGroup(group.id, adminAudit("stop"))).resolves.toMatchObject({
      state: "finished",
      result: "failed",
      counts: { total: 250, canceled: 250, pending: 0 },
    });
    await expect(groupRow(group.id)).resolves.toMatchObject({
      pending_shard_count: 0,
      canceled_count: 250,
    });
  });

  it("reports and repairs a pending shard count that disagrees with the shard rows", async () => {
    const group = await queue.createTaskGroup();
    await queue.addToTaskGroup(group.id, [member("pending-drift", 1)]);
    await pool.query("UPDATE workhorse.task_group SET pending_shard_count = 0 WHERE id = $1", [
      group.id,
    ]);
    // The finish also checks the shard sums, so the seal does not finish the group.
    await expect(queue.sealTaskGroup(group.id)).resolves.toMatchObject({
      state: "sealed",
      counts: { pending: 1 },
    });
    await expect(admin.listTaskGroupDrift()).resolves.toEqual([
      {
        groupId: group.id,
        state: "sealed",
        recorded: { total: 1, succeeded: 0, failed: 0, canceled: 0 },
        counted: { total: 1, succeeded: 0, failed: 0, canceled: 0, pending: 1 },
        action: "recounted",
      },
    ]);
    await expect(admin.repairTaskGroupDrift(adminAudit("repair"))).resolves.toEqual([
      { groupId: group.id, recordedPending: 1, pending: 1, action: "recounted" },
    ]);
    await expect(groupRow(group.id)).resolves.toMatchObject({ pending_shard_count: 1 });
    const repaired = (await admin.listTaskGroupEvents(group.id)).find(
      (event) => event.type === "counter_repaired",
    );
    expect(repaired?.details).toMatchObject({ shards: [] });

    const [task] = await claimMembers(group.id, "pending-drift");
    expect(await queue.complete(task!, "shard-worker", null)).toBe(true);
    await expect(queue.getTaskGroup(group.id)).resolves.toMatchObject({ state: "finished" });
  });

  it("lets a member outcome succeed when its shard drifted and has no room for it", async () => {
    const group = await queue.createTaskGroup();
    await queue.addToTaskGroup(group.id, [member("full-shard", 1)]);
    await pool.query(
      "UPDATE workhorse.task_group_shard SET succeeded_count = 1 WHERE group_id = $1 AND shard = 0",
      [group.id],
    );
    const [task] = await claimMembers(group.id, "full-shard");
    expect(await queue.complete(task!, "shard-worker", null)).toBe(true);
    await expect(shard(group.id, 0)).resolves.toMatchObject({ total: 1, succeeded: 1 });
    await expect(memberOutcome(pool, task!.id)).resolves.toBe("succeeded");
    // The shard counts agree with the member now, and only pending_shard_count still drifts.
    await expect(admin.listTaskGroupDrift()).resolves.toEqual([
      expect.objectContaining({ groupId: group.id, action: "recounted" }),
    ]);
    await admin.repairTaskGroupDrift(adminAudit("repair"));
    await expect(groupRow(group.id)).resolves.toMatchObject({ pending_shard_count: 0 });
    await expect(queue.sealTaskGroup(group.id)).resolves.toMatchObject({
      state: "finished",
      counts: { total: 1, succeeded: 1 },
    });
  });

  it("reports a shard whose counts disagree, and names it in the repair event", async () => {
    const group = await queue.createTaskGroup();
    await queue.addToTaskGroup(group.id, members("shard-drift", 2));
    await pool.query(
      "UPDATE workhorse.task_group_shard SET total_count = 3 WHERE group_id = $1 AND shard = 1",
      [group.id],
    );
    await expect(admin.listTaskGroupDrift()).resolves.toEqual([
      expect.objectContaining({
        groupId: group.id,
        recorded: { total: 4, succeeded: 0, failed: 0, canceled: 0 },
        counted: expect.objectContaining({ total: 2, pending: 2 }),
        action: "recounted",
      }),
    ]);
    await admin.repairTaskGroupDrift(adminAudit("repair"));
    await expect(shard(group.id, 1)).resolves.toMatchObject({ total: 1 });
    const repaired = (await admin.listTaskGroupEvents(group.id)).find(
      (event) => event.type === "counter_repaired",
    );
    expect(repaired?.details).toMatchObject({
      shards: [
        {
          shard: 1,
          recorded: { total: 3, succeeded: 0, failed: 0, canceled: 0 },
          counted: { total: 1, succeeded: 0, failed: 0, canceled: 0 },
        },
      ],
    });
  });

  it("skips the delete of a finished group while another change holds one of its shard rows", async () => {
    const { group } = await queue.taskGroup({}, (builder) =>
      builder.add([member("delete-skip", 1)]),
    );
    const [task] = await claimMembers(group.id, "delete-skip");
    expect(await queue.complete(task!, "shard-worker", null)).toBe(true);
    await pool.query(
      "UPDATE workhorse.task_group SET finished_at = clock_timestamp() - interval '30 days' WHERE id = $1",
      [group.id],
    );
    const holder = await pool.connect();
    try {
      await holder.query("BEGIN");
      await holder.query(
        "SELECT 1 FROM workhorse.task_group_shard WHERE group_id = $1 AND shard = 5 FOR UPDATE",
        [group.id],
      );
      await queue.pruneTerminalStorage({ force: true });
      await expect(queue.getTaskGroup(group.id)).resolves.not.toBeNull();
      await holder.query("ROLLBACK");
    } finally {
      holder.release();
    }
    await queue.pruneTerminalStorage({ force: true });
    await expect(queue.getTaskGroup(group.id)).resolves.toBeNull();
    await expect(shardRows(group.id)).resolves.toEqual([]);
  });

  describe("dashboard_task_groups_v1", () => {
    it("lists task groups newest first, one page at a time, with the shard counts", async () => {
      await pool.query("DELETE FROM workhorse.task_group");
      const finished = await queue.createTaskGroup({
        onFinish: { type: "done", payload: null, options: { queue: "dash-cb" } },
      });
      await queue.sealTaskGroup(finished.id);
      const sealed = await queue.createTaskGroup();
      await queue.addToTaskGroup(sealed.id, members("dash-sealed", 3));
      await queue.sealTaskGroup(sealed.id);
      const [done] = await claimMembers(sealed.id, "dash-sealed");
      expect(await queue.complete(done!, "shard-worker", null)).toBe(true);
      const open = await queue.createTaskGroup();

      const first = await groupPage({ state: "all", page: 1, pageSize: 2 });
      expect(first).toMatchObject({ state: "all", page: 1, pageSize: 2, hasMore: true });
      expect(first.groups).toEqual([
        {
          id: open.id,
          state: "open",
          result: null,
          counts: { total: 0, succeeded: 0, failed: 0, canceled: 0, pending: 0 },
          createdAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/),
          sealedAt: null,
          finishedAt: null,
          canceledAt: null,
          canceledBy: null,
          cancelReason: null,
          callbacks: [],
        },
        expect.objectContaining({
          id: sealed.id,
          state: "sealed",
          counts: { total: 3, succeeded: 1, failed: 0, canceled: 0, pending: 2 },
        }),
      ]);
      const second = await groupPage({ page: 2, pageSize: 2 });
      expect(second).toMatchObject({ state: "all", hasMore: false });
      expect(second.groups).toEqual([
        expect.objectContaining({
          id: finished.id,
          state: "finished",
          result: "succeeded",
          finishedAt: expect.any(String),
          callbacks: [{ kind: "onFinish", taskId: expect.any(String) }],
        }),
      ]);
      await expect(groupPage({ state: "sealed" })).resolves.toMatchObject({
        pageSize: 50,
        hasMore: false,
        groups: [expect.objectContaining({ id: sealed.id })],
      });
    });

    it("rejects an unknown state filter and a page outside its bounds", async () => {
      await expect(groupPage({ state: "canceled" })).rejects.toThrow("task group state filter");
      await expect(groupPage({ page: 0 })).rejects.toThrow("task group page must be");
      await expect(groupPage({ pageSize: 101 })).rejects.toThrow("task group page size must be");
    });
  });
});
