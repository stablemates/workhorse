import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { describe, expect, it } from "vitest";
import { createIntegrationTestContext } from "./support/integration.js";

// Each enqueue call takes its key locks, then its tier locks, then its row locks (SM-2006). Outside
// read committed, a tier lock creates the queue_control row of a new queue, and a second
// transaction that creates the same row waits for the first. Each test uses its own connections and
// reads pg_locks to prove that a session waits before the next step starts.

const { pool, queue, databaseUrl, waitForDatabaseCondition } = createIntegrationTestContext(
  import.meta.url,
);

interface Session {
  client: Client;
  pid: number;
}

async function openSession(): Promise<Session> {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  const result = await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
  return { client, pid: result.rows[0]!.pid };
}

async function closeSessions(sessions: readonly Session[]): Promise<void> {
  for (const session of sessions) {
    await session.client.query("ROLLBACK").catch(() => undefined);
    await session.client.end().catch(() => undefined);
  }
}

/** Waits until the backend waits for a lock of the given pg_locks type. */
async function waitForLock(pid: number, lockType: "advisory" | "transactionid"): Promise<void> {
  await waitForDatabaseCondition(async () => {
    const result = await pool.query<{ waiting: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM pg_locks WHERE pid = $1 AND NOT granted AND locktype = $2
       ) AS waiting`,
      [pid, lockType],
    );
    return result.rows[0]!.waiting;
  });
}

type Settled = { ok: true; rows: unknown[] } | { ok: false; code: string | undefined };

/** The rows of a statement, or the SQLSTATE that ended it. */
function settle(promise: Promise<{ rows: unknown[] }>): Promise<Settled> {
  return promise.then(
    (result) => ({ ok: true as const, rows: result.rows }),
    (error: { code?: string }) => ({ ok: false as const, code: error.code }),
  );
}

async function hasQueueControlRow(queueName: string): Promise<boolean> {
  const result = await pool.query<{ found: boolean }>(
    "SELECT EXISTS (SELECT 1 FROM workhorse.queue_control WHERE queue_name = $1) AS found",
    [queueName],
  );
  return result.rows[0]!.found;
}

function enqueueMany(session: Session, requests: readonly Record<string, unknown>[]) {
  return session.client.query(
    "SELECT ordinal, task_id, outcome FROM workhorse.enqueue_many_v1($1::jsonb) ORDER BY ordinal",
    [JSON.stringify(requests)],
  );
}

// A known case that stays open (ADR 0124, case 3). The completion of the last member of a group
// holds the member row, and its commit enqueues the callback of the group. A repeatable read
// cancel_task_group_v1 holds the new queue_control row of the callback queue and waits for the
// member. Each test commits the completion after the cancel waits, so the order is fixed.
async function cancelDuringLastCompletion(completionIsolation: string): Promise<{
  groupId: string;
  memberId: string;
  callbackQueue: string;
  completion: Settled;
  cancel: Settled;
}> {
  const callbackQueue = `lock-order-last-callback-${randomUUID()}`;
  const memberQueue = `lock-order-last-member-${randomUUID()}`;
  const group = await queue.createTaskGroup({
    onFinish: { type: "report", payload: {}, options: { queue: callbackQueue } },
  });
  await queue.addToTaskGroup(group.id, [
    { type: "member", payload: {}, options: { queue: memberQueue } },
  ]);
  await queue.sealTaskGroup(group.id);
  const claimed = await pool.query<{ task_id: string; fence_token: string }>(
    "SELECT task_id, fence_token FROM workhorse.claim_v1($1, 'last-member-worker', 600000)",
    [memberQueue],
  );
  const member = claimed.rows[0]!;
  expect(await hasQueueControlRow(callbackQueue)).toBe(false);

  const completer = await openSession();
  const canceler = await openSession();
  try {
    // complete_v1 locks the member row. The group outcome and the callback enqueue run in a
    // deferred trigger at commit.
    await completer.client.query(`BEGIN ISOLATION LEVEL ${completionIsolation}`);
    const completed = await completer.client.query<{ accepted: boolean }>(
      "SELECT workhorse.complete_v1($1, 'last-member-worker', $2, 'null'::jsonb) AS accepted",
      [member.task_id, member.fence_token],
    );
    expect(completed.rows).toEqual([{ accepted: true }]);
    // The cancel creates the queue_control row of the callback queue, and then it waits for the
    // member row of the completion.
    await canceler.client.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
    const cancel = settle(
      canceler.client.query(
        "SELECT state FROM workhorse.cancel_task_group_v1($1, 'operator', 'stop', 'cancel-last')",
        [group.id],
      ),
    );
    await waitForLock(canceler.pid, "transactionid");
    const completion = await settle(completer.client.query("COMMIT"));
    const cancelResult = await cancel;
    await canceler.client.query(cancelResult.ok ? "COMMIT" : "ROLLBACK");
    return {
      groupId: group.id,
      memberId: member.task_id,
      callbackQueue,
      completion,
      cancel: cancelResult,
    };
  } finally {
    await closeSessions([completer, canceler]);
  }
}

async function groupState(groupId: string, memberId: string, callbackQueue: string) {
  const result = await pool.query<{
    state: string;
    canceled: boolean;
    member: string | null;
    callbacks: number;
  }>(
    `SELECT task_group.state, task_group.canceled_at IS NOT NULL AS canceled,
            (SELECT outcome.state FROM workhorse.task_outcome outcome
              WHERE outcome.task_id = $2) AS member,
            (SELECT count(*)::integer FROM workhorse.task task
              WHERE task.queue_name = $3) AS callbacks
       FROM workhorse.task_group task_group WHERE task_group.id = $1`,
    [groupId, memberId, callbackQueue],
  );
  return result.rows[0];
}

describe("enqueue lock order outside read committed", () => {
  it("lets a repeatable read group cancel and a purge of its callback queue finish", async () => {
    const queueName = `lock-order-callback-${randomUUID()}`;
    const group = await queue.createTaskGroup({
      onFinish: { type: "report", payload: {}, options: { queue: queueName } },
    });
    const [member] = await queue.addToTaskGroup(group.id, [
      { type: "member", payload: {}, options: { queue: queueName } },
    ]);
    await queue.sealTaskGroup(group.id);
    expect(await hasQueueControlRow(queueName)).toBe(false);

    const holder = await openSession();
    const canceler = await openSession();
    const purger = await openSession();
    try {
      // The holder keeps the group row, so the cancel waits after its first locks. The issue
      // first named a lock on the member. Then the cancel waits behind the purge for the member,
      // and no deadlock occurs.
      await holder.client.query("BEGIN");
      await holder.client.query("SELECT 1 FROM workhorse.task_group WHERE id = $1 FOR KEY SHARE", [
        group.id,
      ]);
      await canceler.client.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
      const cancel = settle(
        canceler.client.query(
          "SELECT state FROM workhorse.cancel_task_group_v1($1, 'operator', 'stop', 'cancel-1')",
          [group.id],
        ),
      );
      await waitForLock(canceler.pid, "transactionid");
      // The purge creates the queue_control row of the callback queue, and then it locks the tasks
      // of that queue. Before the fix, the cancel held the member here and the purge waited for
      // it. Now the cancel holds the new row, and the purge waits for that row.
      const purge = settle(
        purger.client.query(
          "SELECT deleted_count FROM workhorse.purge_queue_v1($1, 'operator', 'purge', 'purge-1')",
          [queueName],
        ),
      );
      await waitForLock(purger.pid, "transactionid");
      await holder.client.query("ROLLBACK");

      await expect(cancel).resolves.toEqual({ ok: true, rows: [{ state: "finished" }] });
      await canceler.client.query("COMMIT");
      // The callback task of the cancel is ready in the purged queue, so the purge deletes it.
      await expect(purge).resolves.toEqual({ ok: true, rows: [{ deleted_count: 1 }] });
    } finally {
      await closeSessions([holder, canceler, purger]);
    }
    const outcome = await pool.query<{ state: string }>(
      "SELECT state FROM workhorse.task_outcome WHERE task_id = $1",
      [member!.taskId],
    );
    expect(outcome.rows).toEqual([{ state: "canceled" }]);
  });

  it("lets a repeatable read keyed group add wait for an enqueue that holds the key", async () => {
    const queueName = `lock-order-key-${randomUUID()}`;
    const key = `lock-order-${randomUUID()}`;
    const group = await queue.createTaskGroup();
    const enqueuer = await openSession();
    const adder = await openSession();
    try {
      // An earlier call of the enqueue transaction takes the key lock of K.
      await enqueuer.client.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
      await enqueueMany(enqueuer, [
        { queue: `${queueName}-other`, type: "keyed", payload: {}, idempotency: { key } },
      ]);
      await adder.client.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
      const add = settle(
        adder.client.query(
          "SELECT outcome FROM workhorse.add_task_group_members_v1($1, $2::jsonb)",
          [
            group.id,
            JSON.stringify([
              { queue: queueName, type: "keyed", payload: {}, idempotency: { key } },
            ]),
          ],
        ),
      );
      // The add waits for the key before it creates the queue_control row of the queue.
      await waitForLock(adder.pid, "advisory");
      const enqueued = await settle(
        enqueueMany(enqueuer, [{ queue: queueName, type: "plain", payload: {} }]),
      );
      expect(enqueued).toMatchObject({ ok: true, rows: [{ outcome: "accepted" }] });
      await enqueuer.client.query("COMMIT");

      // The add read its snapshot before the enqueue committed the new row, so it fails with a
      // serialization error. A new transaction runs it again and gets the usual answer: key K names
      // a task with another queue.
      await expect(add).resolves.toEqual({ ok: false, code: "40001" });
      await adder.client.query("ROLLBACK");
      await adder.client.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
      await expect(
        settle(
          adder.client.query(
            "SELECT outcome FROM workhorse.add_task_group_members_v1($1, $2::jsonb)",
            [
              group.id,
              JSON.stringify([
                { queue: queueName, type: "keyed", payload: {}, idempotency: { key } },
              ]),
            ],
          ),
        ),
      ).resolves.toMatchObject({ ok: false, code: "P1001" });
    } finally {
      await closeSessions([enqueuer, adder]);
    }
  });

  it("lets one keyed batch and a keyed group add on a new queue finish", async () => {
    const suffix = randomUUID();
    const firstQueue = `a-lock-order-${suffix}`;
    const queueName = `b-lock-order-${suffix}`;
    const key = `lock-order-${suffix}`;
    const group = await queue.createTaskGroup();
    const blocker = await openSession();
    const enqueuer = await openSession();
    const adder = await openSession();
    try {
      // The blocker holds the uncommitted queue_control row of the first queue in name order.
      await blocker.client.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
      await enqueueMany(blocker, [{ queue: firstQueue, type: "plain", payload: {} }]);
      // The batch takes key K and the two tier locks, and then waits to create the first row.
      await enqueuer.client.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
      const enqueue = settle(
        enqueueMany(enqueuer, [
          { queue: firstQueue, type: "plain", payload: {} },
          { queue: queueName, type: "keyed", payload: {}, idempotency: { key } },
        ]),
      );
      await waitForLock(enqueuer.pid, "transactionid");
      // The add waits for key K before it creates the row of the second queue. Before the fix, it
      // created that row first, and the batch then waited for the add.
      await adder.client.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
      const add = settle(
        adder.client.query(
          "SELECT outcome FROM workhorse.add_task_group_members_v1($1, $2::jsonb)",
          [
            group.id,
            JSON.stringify([
              { queue: queueName, type: "keyed", payload: {}, idempotency: { key } },
            ]),
          ],
        ),
      );
      await waitForLock(adder.pid, "advisory");
      await blocker.client.query("ROLLBACK");

      await expect(enqueue).resolves.toMatchObject({
        ok: true,
        rows: [{ outcome: "accepted" }, { outcome: "accepted" }],
      });
      await enqueuer.client.query("COMMIT");
      await expect(add).resolves.toEqual({ ok: false, code: "40001" });
    } finally {
      await closeSessions([blocker, enqueuer, adder]);
    }
  });

  it("locks the tier of a plain member before the prerequisites of a batch with a debounce member", async () => {
    const queueName = `lock-order-member-${randomUUID()}`;
    const prerequisiteId = await queue.enqueue("prerequisite", {}, { queue: queueName });
    const debounce = {
      queue: "lock-order-debounce",
      type: "sync",
      payload: {},
      debounce: { key: `lock-order-${randomUUID()}`, windowMs: 60_000, schedule: "reset" },
    };
    await pool.query("SELECT * FROM workhorse.enqueue_many_v1($1::jsonb)", [
      JSON.stringify([debounce]),
    ]);
    expect(await hasQueueControlRow(queueName)).toBe(false);

    const holder = await openSession();
    const batch = await openSession();
    const purger = await openSession();
    try {
      // The holder keeps the key row of the debounce member, so the batch waits in that member,
      // after its prerequisite lock.
      await holder.client.query("BEGIN");
      await holder.client.query(
        `SELECT 1 FROM workhorse.enqueue_idempotency
          WHERE idempotency_scope = 'default'
            AND idempotency_key_hash = workhorse.idempotency_key_hash_v1('default', $1)
          FOR KEY SHARE`,
        [debounce.debounce.key],
      );
      await batch.client.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
      const enqueue = settle(
        enqueueMany(batch, [
          debounce,
          { queue: queueName, type: "after", payload: {}, prerequisiteTaskId: prerequisiteId },
        ]),
      );
      await waitForLock(batch.pid, "transactionid");
      // Before the fix, the purge created the row of the queue and waited for the prerequisite,
      // and the plain member then waited for that row. Now the batch holds the row, and the purge
      // waits for it before it locks a task.
      const purge = settle(
        purger.client.query(
          "SELECT deleted_count FROM workhorse.purge_queue_v1($1, 'operator', 'purge', 'purge-2')",
          [queueName],
        ),
      );
      await waitForLock(purger.pid, "transactionid");
      await holder.client.query("ROLLBACK");

      await expect(enqueue).resolves.toMatchObject({
        ok: true,
        rows: [{ outcome: "replaced" }, { outcome: "accepted" }],
      });
      await batch.client.query("COMMIT");
      await expect(purge).resolves.toEqual({ ok: true, rows: [{ deleted_count: 2 }] });
    } finally {
      await closeSessions([holder, batch, purger]);
    }
  });

  // A known case that stays open (ADR 0124, case 2). A transaction that creates a queue_control row in one call and
  // takes a key in a later call holds the row before the key. One call cannot change that order.
  // The architecture page states it (docs/architecture/lifecycle.md, "Isolation requirement").
  it("ends one transaction with a deadlock when two calls of one transaction take the row before the key", async () => {
    const queueName = `lock-order-mirror-${randomUUID()}`;
    const key = `lock-order-${randomUUID()}`;
    const group = await queue.createTaskGroup();
    const enqueuer = await openSession();
    const adder = await openSession();
    try {
      await enqueuer.client.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
      await enqueueMany(enqueuer, [{ queue: queueName, type: "plain", payload: {} }]);
      await adder.client.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
      const add = settle(
        adder.client.query(
          "SELECT outcome FROM workhorse.add_task_group_members_v1($1, $2::jsonb)",
          [
            group.id,
            JSON.stringify([
              { queue: queueName, type: "keyed", payload: {}, idempotency: { key } },
            ]),
          ],
        ),
      );
      // The add holds key K and waits for the uncommitted row of the enqueue.
      await waitForLock(adder.pid, "transactionid");
      const keyed = settle(
        enqueueMany(enqueuer, [
          { queue: `${queueName}-other`, type: "keyed", payload: {}, idempotency: { key } },
        ]),
      );
      // PostgreSQL usually ends the add, which waited first and so finds the cycle first. The
      // enqueue then rolls back, so the add never waits for a transaction that stays open.
      const keyedResult = await keyed;
      await enqueuer.client.query("ROLLBACK");
      const results = [keyedResult, await add];
      expect(results.filter((result) => !result.ok)).toEqual([{ ok: false, code: "40P01" }]);
    } finally {
      await closeSessions([enqueuer, adder]);
    }
    // PostgreSQL rolled one transaction back and the test rolled back the other, so no task stays.
    // The caller can run the transaction that ended with 40P01 again.
    const tasks = await pool.query<{ count: number }>(
      "SELECT count(*)::integer AS count FROM workhorse.task WHERE queue_name LIKE $1",
      [`${queueName}%`],
    );
    expect(tasks.rows[0]).toEqual({ count: 0 });
  });

  it("ends one transaction with a deadlock when a repeatable read group cancel meets a repeatable read completion of the last member", async () => {
    const run = await cancelDuringLastCompletion("REPEATABLE READ");
    const results = [run.completion, run.cancel];
    expect(results.filter((result) => !result.ok)).toEqual([{ ok: false, code: "40P01" }]);
    // PostgreSQL rolled back the transaction that ended with 40P01. It usually ends the cancel,
    // which waited first. If it ends the completion instead, the member has no outcome, the group
    // cannot finish, and no callback task exists.
    const state = await groupState(run.groupId, run.memberId, run.callbackQueue);
    expect({ member: state?.member, callbacks: state?.callbacks }).toEqual(
      run.completion.ok ? { member: "succeeded", callbacks: 1 } : { member: null, callbacks: 0 },
    );
  });

  it("ends a repeatable read group cancel with a serialization failure and no deadlock when the completion of the last member runs at read committed", async () => {
    const run = await cancelDuringLastCompletion("READ COMMITTED");
    // At read committed the callback enqueue takes no row lock on queue_control, so the
    // completion does not wait for the cancel. The cancel then finds a member that changed after
    // its snapshot.
    expect(run.completion).toEqual({ ok: true, rows: [] });
    expect(run.cancel).toEqual({ ok: false, code: "40001" });
    expect(await groupState(run.groupId, run.memberId, run.callbackQueue)).toEqual({
      state: "finished",
      canceled: false,
      member: "succeeded",
      callbacks: 1,
    });
  });

  // A known case that stays open (ADR 0124, case 5). The completion of the last member locks the
  // member and, in its resolver, a dependent in the callback queue. A purge of that queue inserts
  // the queue_control row and waits for the dependent. At commit, the callback enqueue of the
  // completion waits for that row.
  it("ends one transaction with a deadlock when a repeatable read completion of the last member meets a purge of the callback queue", async () => {
    const callbackQueue = `lock-order-purged-callback-${randomUUID()}`;
    const memberQueue = `lock-order-purged-member-${randomUUID()}`;
    const group = await queue.createTaskGroup({
      onFinish: { type: "report", payload: {}, options: { queue: callbackQueue } },
    });
    const [member] = await queue.addToTaskGroup(group.id, [
      { type: "member", payload: {}, options: { queue: memberQueue } },
    ]);
    await queue.sealTaskGroup(group.id);
    await queue.enqueue(
      "after-member",
      {},
      {
        queue: callbackQueue,
        dependencies: {
          prerequisiteTaskIds: [member!.taskId],
          onSuccess: "release",
          onFailure: "cancel",
          onCancellation: "cancel",
        },
      },
    );
    const claimed = await pool.query<{ task_id: string; fence_token: string }>(
      "SELECT task_id, fence_token FROM workhorse.claim_v1($1, 'purged-callback-worker', 600000)",
      [memberQueue],
    );
    const lease = claimed.rows[0]!;
    expect(await hasQueueControlRow(callbackQueue)).toBe(false);

    const completer = await openSession();
    const purger = await openSession();
    try {
      await completer.client.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
      await completer.client.query(
        "SELECT workhorse.complete_v1($1, 'purged-callback-worker', $2, 'null'::jsonb)",
        [lease.task_id, lease.fence_token],
      );
      const purge = settle(
        purger.client.query(
          "SELECT deleted_count FROM workhorse.purge_queue_v1($1, 'operator', 'purge', 'purge-callback')",
          [callbackQueue],
        ),
      );
      await waitForLock(purger.pid, "transactionid");
      const completion = await settle(completer.client.query("COMMIT"));
      const results = [completion, await purge];
      expect(results.filter((result) => !result.ok)).toEqual([{ ok: false, code: "40P01" }]);
      // PostgreSQL rolled back the transaction that ended with 40P01. The member has an outcome
      // only if the completion committed.
      const outcome = await pool.query<{ state: string }>(
        "SELECT state FROM workhorse.task_outcome WHERE task_id = $1",
        [lease.task_id],
      );
      expect(outcome.rows).toEqual(completion.ok ? [{ state: "succeeded" }] : []);
    } finally {
      await closeSessions([completer, purger]);
    }
  });

  // A known case that stays open (ADR 0124, case 6). A child create locks the parent row and then
  // takes the tier lock of the child queue. An enqueue to the child queue that names the parent as a
  // prerequisite takes that tier lock first and then waits for the parent. A holder keeps a second
  // prerequisite X, which sorts below the parent, so the enqueue holds the tier lock and waits for X
  // before the child create starts.
  it("ends one transaction with a deadlock when a repeatable read child create meets a repeatable read enqueue that names the parent", async () => {
    const parentQueue = `lock-order-parent-${randomUUID()}`;
    const childQueue = `lock-order-child-${randomUUID()}`;
    // Each attempt claims a new parent and enqueues candidates for X until one sorts below it.
    let parent: { task_id: string; fence_token: string } | undefined;
    let below: string | undefined;
    for (let attempt = 0; attempt < 16 && below === undefined; attempt += 1) {
      await queue.enqueue("parent", {}, { queue: parentQueue });
      const claimed = await pool.query<{ task_id: string; fence_token: string }>(
        "SELECT task_id, fence_token FROM workhorse.claim_v1($1, 'child-create-worker', 600000)",
        [parentQueue],
      );
      parent = claimed.rows[0]!;
      for (let candidate = 0; candidate < 16 && below === undefined; candidate += 1) {
        const task = await queue.enqueue("below", {}, { queue: `${parentQueue}-other` });
        if (task < parent.task_id) below = task;
      }
    }
    if (parent === undefined || below === undefined) {
      throw new Error("No pair of random identities sorted in the requested order");
    }
    expect(await hasQueueControlRow(childQueue)).toBe(false);

    const holder = await openSession();
    const enqueuer = await openSession();
    const creator = await openSession();
    try {
      await holder.client.query("BEGIN");
      await holder.client.query(
        "SELECT 1 FROM workhorse.task_runtime WHERE task_id = $1 FOR UPDATE",
        [below],
      );
      // The enqueue inserts the queue_control row of the child queue and waits for X.
      await enqueuer.client.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
      const enqueue = settle(
        enqueueMany(enqueuer, [
          {
            queue: childQueue,
            type: "after-parent",
            payload: {},
            dependencies: {
              prerequisiteTaskIds: [below, parent.task_id],
              onSuccess: "release",
              onFailure: "release",
              onCancellation: "release",
            },
          },
        ]),
      );
      await waitForLock(enqueuer.pid, "transactionid");
      // The child create locks the parent and waits for the row of the enqueue.
      await creator.client.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
      const create = settle(
        creator.client.query(
          "SELECT status FROM workhorse.create_single_child_v2($1, 'child-create-worker', $2, 'child', $3::jsonb)",
          [
            parent.task_id,
            parent.fence_token,
            JSON.stringify({ queue: childQueue, type: "child", payload: {} }),
          ],
        ),
      );
      await waitForLock(creator.pid, "transactionid");
      // The enqueue locks X and then waits for the parent.
      await holder.client.query("ROLLBACK");
      const enqueued = await enqueue;
      const created = await create;
      await enqueuer.client.query("ROLLBACK");
      await creator.client.query("ROLLBACK");
      expect([enqueued, created].filter((result) => !result.ok)).toEqual([
        { ok: false, code: "40P01" },
      ]);
    } finally {
      await closeSessions([holder, enqueuer, creator]);
    }
    // The test rolled back both transactions, so the child queue holds no task.
    const tasks = await pool.query<{ count: number }>(
      "SELECT count(*)::integer AS count FROM workhorse.task WHERE queue_name = $1",
      [childQueue],
    );
    expect(tasks.rows[0]).toEqual({ count: 0 });
  });
});

// A known case that stays open (ADR 0124, case 9). A purge and a group cancel lock their tasks in
// identity order. A cancel of a prerequisite locks the prerequisite and then, in its resolver, the
// dependent. If the dependent sorts below its prerequisite and both are in the set, each waits for
// the other. A holder keeps a task X between them, so the set call holds the dependent and waits
// before the cancel starts.
describe("identity order against a resolver at read committed", () => {
  type SetCall = "purge" | "group cancel";

  interface Arranged {
    prerequisite: string;
    between: string;
    run: (session: Session) => Promise<{ rows: unknown[] }>;
  }

  async function arrange(call: SetCall): Promise<Arranged> {
    for (let attempt = 0; attempt < 64; attempt += 1) {
      const queueName = `lock-order-resolver-${randomUUID()}`;
      const groupId = call === "group cancel" ? (await queue.createTaskGroup()).id : undefined;
      const add = async (type: string, prerequisite?: string): Promise<string> => {
        const options = {
          queue: queueName,
          ...(prerequisite === undefined
            ? {}
            : {
                dependencies: {
                  prerequisiteTaskIds: [prerequisite],
                  onSuccess: "release" as const,
                  onFailure: "cancel" as const,
                  onCancellation: "cancel" as const,
                },
              }),
        };
        if (groupId === undefined) return queue.enqueue(type, {}, options);
        const [result] = await queue.addToTaskGroup(groupId, [{ type, payload: {}, options }]);
        return result!.taskId;
      };
      const prerequisite = await add("prerequisite");
      const dependent = await add("dependent", prerequisite);
      if (!(dependent < prerequisite)) continue;
      for (let candidate = 0; candidate < 32; candidate += 1) {
        const between = await add("between");
        if (dependent < between && between < prerequisite) {
          return {
            prerequisite,
            between,
            run: (session) =>
              groupId === undefined
                ? session.client.query(
                    "SELECT deleted_count FROM workhorse.purge_queue_v1($1, 'operator', 'purge', 'purge-resolver')",
                    [queueName],
                  )
                : session.client.query(
                    "SELECT state FROM workhorse.cancel_task_group_v1($1, 'operator', 'stop', 'cancel-resolver')",
                    [groupId],
                  ),
          };
        }
      }
    }
    throw new Error("No set of random identities sorted in the requested order");
  }

  it.each<SetCall>(["purge", "group cancel"])(
    "ends one transaction with a deadlock when a %s holds the dependent below its prerequisite",
    async (call) => {
      const arranged = await arrange(call);
      const holder = await openSession();
      const setCaller = await openSession();
      const canceler = await openSession();
      try {
        await holder.client.query("BEGIN");
        await holder.client.query(
          "SELECT 1 FROM workhorse.task_runtime WHERE task_id = $1 FOR SHARE",
          [arranged.between],
        );
        // The set call locks the dependent and waits for X.
        const setResult = settle(arranged.run(setCaller));
        await waitForLock(setCaller.pid, "transactionid");
        // The cancel locks the prerequisite. Its resolver then waits for the dependent.
        const cancel = settle(
          canceler.client.query("SELECT workhorse.cancel_v1($1, 'operator', 'stop') AS canceled", [
            arranged.prerequisite,
          ]),
        );
        await waitForLock(canceler.pid, "transactionid");
        // The set call locks X and then waits for the prerequisite.
        await holder.client.query("ROLLBACK");
        const results = [await setResult, await cancel];
        expect(results.filter((result) => !result.ok)).toEqual([{ ok: false, code: "40P01" }]);
        // PostgreSQL rolled back the transaction that ended with 40P01. If the cancel won, X is
        // still ready. If the set call won, it removed or canceled X.
        const between = await pool.query<{ state: string }>(
          "SELECT state FROM workhorse.task_runtime WHERE task_id = $1",
          [arranged.between],
        );
        expect(between.rows).toEqual(results[1]!.ok ? [{ state: "ready" }] : []);
      } finally {
        await closeSessions([holder, setCaller, canceler]);
      }
    },
  );
});

describe("enqueue lock order at read committed", () => {
  const debounce = {
    queue: "read-committed-debounce",
    type: "sync",
    payload: {},
    debounce: { key: "read-committed-debounce", windowMs: 60_000, schedule: "reset" },
  };
  const replacedDebounce = {
    queue: "read-committed-replaced",
    type: "sync",
    debounce: { key: "read-committed-replaced", windowMs: 60_000, schedule: "reset" },
  };
  // The table reads and writes of each enqueue in its own transaction. Schema version 101 gives the
  // same numbers: migration 0103 adds no statement to these paths.
  it.each([
    {
      name: "a plain enqueue",
      requests: [{ queue: "read-committed-plain", type: "plain", payload: {} }],
      work: {
        queue_control: [1, 0],
        task: [3, 1],
        task_query: [1, 1],
        task_runtime: [0, 1],
      },
    },
    {
      name: "a keyed enqueue",
      requests: [
        {
          queue: "read-committed-keyed",
          type: "keyed",
          payload: {},
          idempotency: { key: "read-committed-key" },
        },
      ],
      work: {
        enqueue_idempotency: [3, 1],
        queue_control: [1, 0],
        task: [3, 1],
        task_query: [1, 1],
        task_runtime: [0, 1],
      },
    },
    {
      name: "a batch with a debounce member and a plain member",
      requests: [debounce, { queue: "read-committed-member", type: "plain", payload: {} }],
      work: {
        enqueue_idempotency: [5, 1],
        queue_control: [4, 0],
        task: [7, 2],
        task_query: [2, 2],
        task_runtime: [0, 2],
      },
    },
    {
      name: "a debounce replacement that also names its task as a prerequisite",
      before: [{ ...replacedDebounce, payload: { revision: 1 } }],
      requests: [{ ...replacedDebounce, payload: { revision: 2 } }],
      prerequisiteOfKey: true,
      // The keyed task reads no state for its order, also when the batch names it as a prerequisite.
      work: {
        enqueue_idempotency: [6, 0],
        fast_task_outcome: [1, 0],
        fast_task_runtime: [1, 0],
        queue_control: [4, 0],
        task: [12, 1],
        task_dependency: [9, 1],
        task_outcome: [4, 0],
        task_query: [2, 1],
        task_runtime: [5, 1],
      },
    },
    {
      name: "a debounce replacement",
      before: [{ ...replacedDebounce, payload: { revision: 1 } }],
      requests: [{ ...replacedDebounce, payload: { revision: 2 } }],
      // The debounce member reads no runtime state for its order, as before.
      work: {
        enqueue_idempotency: [6, 0],
        queue_control: [3, 0],
        task: [2, 0],
        task_query: [1, 0],
        task_runtime: [3, 0],
      },
    },
  ])(
    "takes no row lock on queue_control and adds no statement for $name",
    async ({ before, requests, prerequisiteOfKey, work }) => {
      const earlier =
        before === undefined
          ? []
          : (
              await pool.query<{ task_id: string }>(
                "SELECT task_id FROM workhorse.enqueue_many_v1($1::jsonb)",
                [JSON.stringify(before)],
              )
            ).rows;
      // The plain member names the keyed task of the debounce member as its prerequisite.
      const batch = prerequisiteOfKey
        ? [
            ...requests,
            {
              queue: "read-committed-after",
              type: "after",
              payload: {},
              prerequisiteTaskId: earlier[0]!.task_id,
            },
          ]
        : requests;
      const session = await openSession();
      try {
        await session.client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
        await enqueueMany(session, batch);
        const locks = await session.client.query<{ mode: string }>(
          `SELECT mode FROM pg_locks
          WHERE pid = pg_backend_pid() AND locktype = 'relation'
            AND relation = 'workhorse.queue_control'::regclass
          ORDER BY mode`,
        );
        // Index scans and inserts of each table, the partitions of task_event left out.
        const measured = await session.client.query<{
          relname: string;
          scans: number;
          inserts: number;
        }>(
          `SELECT relname, (seq_scan + COALESCE(idx_scan, 0))::integer AS scans,
                n_tup_ins::integer AS inserts
           FROM pg_stat_xact_user_tables
          WHERE schemaname = 'workhorse' AND relname NOT LIKE 'task_event%'
            AND seq_scan + COALESCE(idx_scan, 0) + n_tup_ins + n_tup_upd + n_tup_del > 0
          ORDER BY relname`,
        );
        await session.client.query("COMMIT");
        // AccessShareLock is the plain tier read. A row lock or an insert would add RowShareLock
        // or RowExclusiveLock.
        expect(locks.rows).toEqual([{ mode: "AccessShareLock" }]);
        expect(
          Object.fromEntries(measured.rows.map((row) => [row.relname, [row.scans, row.inserts]])),
        ).toEqual(work);
      } finally {
        await closeSessions([session]);
      }
    },
  );

  // The advisory lock calls of each enqueue: the key locks and the shared tier locks. The test
  // replaces each call in the enqueue functions with a call that counts it, and it puts the
  // functions back after. Schema version 101 gives the same numbers.
  it.each([
    {
      name: "a plain enqueue",
      requests: [{ queue: "read-committed-plain", type: "plain", payload: {} }],
      calls: { key: 0, tier: 1 },
    },
    {
      name: "a keyed enqueue",
      requests: [
        {
          queue: "read-committed-keyed",
          type: "keyed",
          payload: {},
          idempotency: { key: "read-committed-key" },
        },
      ],
      calls: { key: 2, tier: 1 },
    },
    {
      name: "a batch with a debounce member and a plain member",
      requests: [debounce, { queue: "read-committed-member", type: "plain", payload: {} }],
      calls: { key: 3, tier: 4 },
    },
    {
      name: "a group add with an enqueue key",
      requests: [
        {
          queue: "read-committed-group",
          type: "keyed",
          payload: {},
          idempotency: { key: "read-committed-group-key" },
        },
      ],
      calls: { key: 2, tier: 3 },
      group: true,
    },
  ])(
    "calls the advisory lock functions as before for $name",
    async ({ requests, calls, group }) => {
      const groupId = group ? (await queue.createTaskGroup()).id : undefined;
      const functions = await pool.query<{ definition: string }>(
        `SELECT pg_get_functiondef(proc.oid) AS definition
         FROM pg_proc proc JOIN pg_namespace namespace ON namespace.oid = proc.pronamespace
        WHERE namespace.nspname = 'workhorse'
          AND proc.proname = ANY(ARRAY[
            'lock_queue_tiers_v1', 'enqueue_batch_v1', 'enqueue_many_v1', 'enqueue_debounce_v1',
            'enqueue_throttle_v1', 'lock_enqueue_prerequisites_internal_v1',
            'add_task_group_members_v1'
          ])`,
      );
      await pool.query("CREATE TABLE workhorse.test_lock_call (kind text NOT NULL)");
      await pool.query(`CREATE FUNCTION workhorse.test_count_key_lock(p_key bigint) RETURNS void
      LANGUAGE plpgsql AS $$ BEGIN
        INSERT INTO workhorse.test_lock_call VALUES ('key'); PERFORM pg_advisory_xact_lock(p_key);
      END; $$`);
      await pool.query(`CREATE FUNCTION workhorse.test_count_tier_lock(p_key bigint) RETURNS void
      LANGUAGE plpgsql AS $$ BEGIN
        INSERT INTO workhorse.test_lock_call VALUES ('tier');
        PERFORM pg_advisory_xact_lock_shared(p_key);
      END; $$`);
      try {
        for (const { definition } of functions.rows) {
          await pool.query(
            definition
              .replaceAll("pg_advisory_xact_lock_shared(", "workhorse.test_count_tier_lock(")
              .replaceAll("pg_advisory_xact_lock(", "workhorse.test_count_key_lock("),
          );
        }
        const session = await openSession();
        try {
          await session.client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
          await (groupId === undefined
            ? enqueueMany(session, requests)
            : session.client.query(
                "SELECT outcome FROM workhorse.add_task_group_members_v1($1, $2::jsonb)",
                [groupId, JSON.stringify(requests)],
              ));
          const counted = await session.client.query<{ kind: string; calls: number }>(
            "SELECT kind, count(*)::integer AS calls FROM workhorse.test_lock_call GROUP BY kind",
          );
          await session.client.query("ROLLBACK");
          const byKind = Object.fromEntries(counted.rows.map((row) => [row.kind, row.calls]));
          expect({ key: byKind.key ?? 0, tier: byKind.tier ?? 0 }).toEqual(calls);
        } finally {
          await closeSessions([session]);
        }
      } finally {
        for (const { definition } of functions.rows) await pool.query(definition);
        await pool.query("DROP FUNCTION workhorse.test_count_key_lock(bigint)");
        await pool.query("DROP FUNCTION workhorse.test_count_tier_lock(bigint)");
        await pool.query("DROP TABLE workhorse.test_lock_call");
      }
    },
  );
});
