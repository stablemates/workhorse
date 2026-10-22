import type { PoolClient } from "pg";
import { describe, expect, it } from "vitest";
import type { Dependencies } from "../src/index.js";
import { createIntegrationTestContext } from "./support/integration.js";

// A cancel locks its prerequisite before its outcome trigger locks the dependents that its policy
// rejects. An enqueue locks the tasks that it names as prerequisites in identity order. If such a
// dependent sorts below its prerequisite, the two lock the same rows in opposite orders. Task
// identities are random, so this happens for about half of all pairs. Workhorse keeps this
// documented limit (SM-1286). The first test shows the cycle, and the second shows the safe order.

const { pool, queue, waitForDatabaseCondition } = createIntegrationTestContext(import.meta.url);

async function backendPid(client: PoolClient): Promise<number> {
  return (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
}

async function blockedBy(waiter: number, holder: number): Promise<boolean> {
  const result = await pool.query<{ blocked: boolean }>(
    "SELECT $2::integer = ANY(pg_blocking_pids($1)) AS blocked",
    [waiter, holder],
  );
  return result.rows[0]!.blocked;
}

type Settled = { ok: true; value: unknown } | { ok: false; error: unknown };

const settle = (promise: Promise<unknown>): Promise<Settled> =>
  promise.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );

const cancelWith = (prerequisiteTaskId: string): Dependencies => ({
  prerequisiteTaskIds: [prerequisiteTaskId],
  onSuccess: "release",
  onFailure: "cancel",
  onCancellation: "cancel",
});

// B depends on A, and the cancel of A rejects B. Enqueue pairs until B sorts as the test needs.
async function enqueuePair(dependentSortsBelow: boolean): Promise<[string, string]> {
  for (let attempt = 0; attempt < 64; attempt += 1) {
    const taskA = await queue.enqueue("cancel-deadlock", {});
    const taskB = await queue.enqueue("cancel-deadlock", {}, { dependencies: cancelWith(taskA) });
    if (taskB < taskA === dependentSortsBelow) return [taskA, taskB];
  }
  throw new Error("No pair of random identities sorted in the requested order");
}

const releaseAfter = (prerequisiteTaskIds: string[]): Dependencies => ({
  prerequisiteTaskIds,
  onSuccess: "release",
  onFailure: "release",
  onCancellation: "release",
});

/**
 * Starts a cancel of A, pauses it before it locks B, and then starts an enqueue that names A and B.
 * The pause comes from T0, which holds B with a lock that does not conflict with the key-share lock
 * of an enqueue. The callback receives both pending results after T0 lets the cancel continue.
 */
async function crossCancelAndEnqueue<T>(
  taskA: string,
  taskB: string,
  observe: (
    cancel: Promise<Settled>,
    enqueue: Promise<Settled>,
    cancelClient: PoolClient,
  ) => Promise<T>,
): Promise<T> {
  const t0 = await pool.connect();
  const cancelClient = await pool.connect();
  const enqueueClient = await pool.connect();
  try {
    const [t0Pid, cancelPid, enqueuePid] = [
      await backendPid(t0),
      await backendPid(cancelClient),
      await backendPid(enqueueClient),
    ];
    for (const client of [cancelClient, enqueueClient]) {
      await client.query("BEGIN");
      // If PostgreSQL does not find a cycle, the lock timeout ends the test with 55P03.
      await client.query("SET LOCAL lock_timeout = '10s'");
    }
    await t0.query("BEGIN");
    await t0.query("SELECT 1 FROM workhorse.task_runtime WHERE task_id = $1 FOR NO KEY UPDATE", [
      taskB,
    ]);

    // 1. The cancel of A locks A and deletes its runtime row. Its outcome trigger then waits for B.
    const cancel = settle(queue.forDatabase(cancelClient).cancel(taskA));
    await waitForDatabaseCondition(() => blockedBy(cancelPid, t0Pid));

    // 2. An enqueue names A and B. It locks them in identity order and waits for A.
    const enqueue = settle(
      queue
        .forDatabase(enqueueClient)
        .enqueue("cancel-deadlock", {}, { dependencies: releaseAfter([taskA, taskB]) }),
    );
    await waitForDatabaseCondition(() => blockedBy(enqueuePid, cancelPid));

    // 3. T0 lets the cancel continue. The cancel locks B for deletion.
    await t0.query("ROLLBACK");
    return await observe(cancel, enqueue, cancelClient);
  } finally {
    await t0.query("ROLLBACK").catch(() => undefined);
    await cancelClient.query("ROLLBACK").catch(() => undefined);
    await enqueueClient.query("ROLLBACK").catch(() => undefined);
    t0.release();
    cancelClient.release();
    enqueueClient.release();
  }
}

describe("cancel that rejects a dependent and an enqueue that names both", () => {
  it("can deadlock when the dependent sorts first, and PostgreSQL aborts one with 40P01", async () => {
    const [taskA, taskB] = await enqueuePair(true);

    const outcomes = await crossCancelAndEnqueue(taskA, taskB, (cancel, enqueue) =>
      // 4. The enqueue holds B and waits for A. The cancel holds A and waits for B. PostgreSQL
      //    aborts one of them and releases its locks, so the other continues. Either one can
      //    return first.
      Promise.all([cancel, enqueue]),
    );

    const failures = outcomes.filter((outcome) => !outcome.ok);
    expect(failures).toHaveLength(1);
    expect(failures[0]!.error).toMatchObject({
      code: "40P01",
      // The cycle runs through the row locks of the two transactions, not through an advisory lock.
      detail: expect.stringMatching(/^(?![\s\S]*advisory lock)[\s\S]*ShareLock on transaction/),
    });
    // The cancel returns the canceled task, or the enqueue returns the identity of its new task.
    const summary = outcomes.map((outcome) =>
      !outcome.ok
        ? (outcome.error as { code?: string }).code
        : typeof outcome.value === "string"
          ? "enqueued"
          : (outcome.value as { status?: string }).status,
    );
    expect([
      ["canceled", "40P01"],
      ["40P01", "enqueued"],
    ]).toContainEqual(summary);
  });

  it("waits without a deadlock when the prerequisite sorts first", async () => {
    const [taskA, taskB] = await enqueuePair(false);

    const [cancelOutcome, enqueueOutcome] = await crossCancelAndEnqueue(
      taskA,
      taskB,
      async (cancel, enqueue, cancelClient) => {
        // 4. The enqueue waits for A and holds nothing on B, so the cancel finishes. The enqueue
        //    continues when the transaction of the cancel commits.
        const cancelSettled = await cancel;
        await cancelClient.query("COMMIT");
        return [cancelSettled, await enqueue] as const;
      },
    );

    expect(cancelOutcome).toEqual({
      ok: true,
      value: expect.objectContaining({ status: "canceled" }),
    });
    expect(enqueueOutcome).toEqual({ ok: true, value: expect.any(String) });
  });
});
