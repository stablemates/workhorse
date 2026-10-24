import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabaseTestHarness } from "./support/db.js";

// The reset's TRUNCATE locks the tables in alphabetical order. These tests hold a lock on a late
// table, then ask for an early one, which is the lock order of a worker statement (SM-1436).
const database = createDatabaseTestHarness(import.meta.url, { max: 4, resetLockWaitMs: 2_000 });
const { pool } = database;

beforeAll(async () => {
  await database.setup();
});

afterAll(async () => {
  await database.teardown();
});

async function waitForResetLockWait(): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const waiting = await pool.query(
      `SELECT 1 FROM pg_stat_activity
        WHERE datname = current_database() AND query LIKE 'TRUNCATE %' AND wait_event_type = 'Lock'`,
    );
    if (waiting.rowCount !== 0) return;
    await sleep(5);
  }
  throw new Error("The reset did not wait for a table lock");
}

describe("database reset with a session from an earlier test", () => {
  it("lets the session finish instead of a deadlock", async () => {
    const holder = await pool.connect();
    try {
      await holder.query("BEGIN");
      await holder.query("LOCK TABLE workhorse.task_runtime IN ROW EXCLUSIVE MODE");
      const reset = database.reset();
      await waitForResetLockWait();

      // Before SM-1436, the reset waited here for task_runtime and held admission_shard. Thus this
      // statement and the reset waited for each other, until PostgreSQL ended one of them.
      await holder.query("SELECT count(*) FROM workhorse.admission_shard");
      await holder.query("COMMIT");
      await expect(reset).resolves.toBeUndefined();
    } finally {
      await holder.query("ROLLBACK").catch(() => undefined);
      holder.release();
    }
  });

  it("stops when the hook gives up and leaves no transaction open", async () => {
    const holder = await pool.connect();
    try {
      await holder.query("BEGIN");
      await holder.query("LOCK TABLE workhorse.task_runtime IN ROW EXCLUSIVE MODE");
      const hook = new AbortController();
      const started = Date.now();
      const reset = database.reset({ signal: hook.signal }).then(
        () => undefined,
        (error: unknown) => error as Error,
      );
      await waitForResetLockWait();

      // Vitest aborts the signal of a hook that times out (SM-1679).
      hook.abort();
      const failure = await reset;
      expect(failure?.name).toBe("AbortError");
      expect(Date.now() - started).toBeLessThan(2_000);

      const open = await pool.query(
        `SELECT pid FROM pg_stat_activity
          WHERE datname = current_database() AND pid <> pg_backend_pid()
            AND state LIKE 'idle in transaction%' AND query NOT LIKE 'LOCK TABLE %'`,
      );
      expect(open.rows).toEqual([]);
    } finally {
      await holder.query("ROLLBACK");
      holder.release();
    }
    await expect(database.reset()).resolves.toBeUndefined();
  });

  it("names the session that keeps its locks", async () => {
    const holder = await pool.connect();
    try {
      const { rows } = await holder.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
      await holder.query("BEGIN");
      await holder.query("LOCK TABLE workhorse.task_runtime IN ROW EXCLUSIVE MODE");

      const failure = await database.reset().then(
        () => undefined,
        (error: unknown) => error as Error,
      );
      expect(failure?.message).toContain("The reset could not lock the tables within 2000 ms.");
      expect(failure?.message).toContain(
        `pid ${rows[0]!.pid} (idle in transaction): LOCK TABLE workhorse.task_runtime IN ROW EXCLUSIVE MODE`,
      );
      expect(failure?.cause).toMatchObject({ code: "55P03" });
    } finally {
      await holder.query("ROLLBACK");
      holder.release();
    }
    await expect(database.reset()).resolves.toBeUndefined();
  });
});
