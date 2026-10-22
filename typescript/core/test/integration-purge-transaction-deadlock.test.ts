import type { PoolClient } from "pg";
import { describe, expect, it } from "vitest";
import { Admin } from "../src/index.js";
import { createIntegrationTestContext } from "./support/integration.js";

// A purge takes the purge lock before any row lock (ADR 0101). A transaction that already holds a
// task row lock and then calls a purge takes the two locks in the other order. It can thus deadlock
// with another purge. Workhorse keeps this documented limit (SM-1289), and this test shows the cycle.

const { pool, queue, adminAudit, waitForDatabaseCondition } = createIntegrationTestContext(
  import.meta.url,
);

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

const settle = (promise: Promise<unknown>) =>
  promise.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );

describe("purge in a transaction that holds task row locks", () => {
  it("can deadlock with another purge, and PostgreSQL aborts one with 40P01", async () => {
    const taskX = await queue.enqueue("purge-deadlock", {}, { queue: "purge-deadlock-a" });
    await queue.enqueue("purge-deadlock", {}, { queue: "purge-deadlock-b" });
    const t1 = await pool.connect();
    const t2 = await pool.connect();
    try {
      const [t1Pid, t2Pid] = [await backendPid(t1), await backendPid(t2)];
      for (const client of [t1, t2]) {
        await client.query("BEGIN");
        // If PostgreSQL does not find the cycle, the lock timeout ends the test with 55P03.
        await client.query("SET LOCAL lock_timeout = '10s'");
      }

      // 1. T1 cancels the task X, so T1 holds a lock on X.
      await expect(queue.forDatabase(t1).cancel(taskX)).resolves.toMatchObject({
        status: "canceled",
      });

      // 2. A purge in T2 takes the purge lock and waits for X, which is in the purged queue.
      const t2Purge = settle(
        new Admin(t2).purgeQueue("purge-deadlock-a", adminAudit("purge queue a")),
      );
      await waitForDatabaseCondition(() => blockedBy(t2Pid, t1Pid));

      // 3. T1 then purges another queue and waits for the purge lock.
      const t1Purge = settle(
        new Admin(t1).purgeQueue("purge-deadlock-b", adminAudit("purge queue b")),
      );

      // 4. Each waits for the other. PostgreSQL aborts one of them and releases its locks, so the
      //    other purge continues. Either purge can return first.
      const outcomes = await Promise.all([t1Purge, t2Purge]);

      const failures = outcomes.filter((outcome) => !outcome.ok);
      expect(failures).toHaveLength(1);
      expect(failures[0]!.error).toMatchObject({
        code: "40P01",
        // The cycle runs through the purge lock, not only through task rows.
        detail: expect.stringMatching(/advisory lock/),
      });
      expect(outcomes.filter((outcome) => outcome.ok).map((outcome) => outcome.value)).toEqual([1]);
    } finally {
      await t1.query("ROLLBACK").catch(() => undefined);
      await t2.query("ROLLBACK").catch(() => undefined);
      t1.release();
      t2.release();
    }
  });
});
