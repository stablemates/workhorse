import { setTimeout as sleep } from "node:timers/promises";
import type { PoolClient } from "pg";
import { describe, expect, it } from "vitest";
import { createIntegrationTestContext } from "./support/integration.js";

// heartbeat_many_v2 does not wait for a row lock that another transaction holds. It reports the
// lease as busy: no renewal and no ownership verdict. So a heartbeat no longer keeps the row of a
// settled task locked, and a claim takes that task at once (SM-1443, ADR 0105).

const { pool, queue, admin, adminAudit } = createIntegrationTestContext(import.meta.url);

const WORKER = "busy-heartbeat-worker";
const ERROR = JSON.stringify({ name: "Error", message: "retry at once", stack: null });

interface Lease {
  taskId: string;
  fenceToken: string;
  leaseMs: number;
}

async function heartbeat(
  leases: readonly Lease[],
  database: Pick<PoolClient, "query"> = pool,
): Promise<{ task_id: string; status: string }[]> {
  const result = await database.query<{ task_id: string; status: string }>(
    `SELECT task_id::text AS task_id, status
       FROM workhorse.heartbeat_many_v2($1, $2::jsonb) ORDER BY ordinal`,
    [WORKER, JSON.stringify(leases)],
  );
  return result.rows;
}

async function claimed(queueName: string): Promise<Lease> {
  await queue.enqueue("busy", {}, { queue: queueName });
  const task = await queue.claim(WORKER, { queue: queueName, leaseMs: 30_000 });
  expect(task).not.toBeNull();
  return { taskId: task!.id, fenceToken: task!.fenceToken.toString(), leaseMs: 30_000 };
}

async function expiresAt(taskId: string): Promise<number> {
  const result = await pool.query<{ expires_at: Date }>(
    `SELECT expires_at FROM workhorse.task_runtime WHERE task_id = $1
     UNION ALL
     SELECT expires_at FROM workhorse.fast_task_runtime WHERE task_id = $1`,
    [taskId],
  );
  return result.rows[0]!.expires_at.getTime();
}

/** Open a transaction on its own connection, run `statements` in it, and return the client. */
async function openTransaction(
  statements: readonly { sql: string; parameters?: unknown[] }[],
): Promise<PoolClient> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const statement of statements) await client.query(statement.sql, statement.parameters);
    return client;
  } catch (error) {
    client.release(true);
    throw error;
  }
}

async function finish(client: PoolClient, command: "COMMIT" | "ROLLBACK"): Promise<void> {
  try {
    await client.query(command);
  } finally {
    client.release();
  }
}

function failNow(lease: Lease) {
  return {
    sql: "SELECT workhorse.fail_v1($1::uuid, $2::text, $3::bigint, $4::jsonb, 0)",
    parameters: [lease.taskId, WORKER, lease.fenceToken, ERROR],
  };
}

describe("busy heartbeat", () => {
  it("answers busy at once while a settlement holds the row, and a claim takes the task after the commit", async () => {
    const queueName = "busy-settlement-commit";
    const lease = await claimed(queueName);
    // A failure with no retry delay moves the row to ready in an open transaction.
    const settlement = await openTransaction([failNow(lease)]);
    try {
      const started = performance.now();
      expect(await heartbeat([lease])).toEqual([{ task_id: lease.taskId, status: "busy" }]);
      // The heartbeat did not wait for the settlement.
      expect(performance.now() - started).toBeLessThan(1_000);
    } finally {
      await finish(settlement, "COMMIT");
    }
    // No heartbeat holds the row, so the first claim takes the ready task. No retry.
    const next = await queue.claim("busy-next-worker", { queue: queueName });
    expect(next).toMatchObject({ id: lease.taskId, attempt: 2 });
    expect(await heartbeat([lease])).toEqual([{ task_id: lease.taskId, status: "stale" }]);
  });

  it("renews the lease after a settlement that holds the row rolls back", async () => {
    const lease = await claimed("busy-settlement-rollback");
    const before = await expiresAt(lease.taskId);
    const settlement = await openTransaction([failNow(lease)]);
    try {
      expect(await heartbeat([lease])).toEqual([{ task_id: lease.taskId, status: "busy" }]);
    } finally {
      await finish(settlement, "ROLLBACK");
    }
    // A busy answer changed nothing.
    expect(await expiresAt(lease.taskId)).toBe(before);
    expect(await heartbeat([lease])).toEqual([{ task_id: lease.taskId, status: "accepted" }]);
    expect(await expiresAt(lease.taskId)).toBeGreaterThan(before);
  });

  it("reports busy for a row that a progress update holds in an open transaction", async () => {
    const lease = await claimed("busy-progress");
    const progress = await openTransaction([
      {
        sql: "SELECT FROM workhorse.task_runtime WHERE task_id = $1 FOR UPDATE",
        parameters: [lease.taskId],
      },
    ]);
    try {
      expect(await heartbeat([lease])).toEqual([{ task_id: lease.taskId, status: "busy" }]);
    } finally {
      await finish(progress, "COMMIT");
    }
  });

  it("is not busy for a key-share lock, as a foreign-key check takes", async () => {
    const lease = await claimed("busy-key-share");
    const keyShare = await openTransaction([
      {
        sql: "SELECT FROM workhorse.task_runtime WHERE task_id = $1 FOR KEY SHARE",
        parameters: [lease.taskId],
      },
    ]);
    try {
      expect(await heartbeat([lease])).toEqual([{ task_id: lease.taskId, status: "accepted" }]);
    } finally {
      await finish(keyShare, "COMMIT");
    }
  });

  it("reports a replaced generation as stale, also while its row is locked", async () => {
    const queueName = "busy-replaced-generation";
    const lease = await claimed(queueName);
    await pool.query("SELECT workhorse.fail_v1($1::uuid, $2::text, $3::bigint, $4::jsonb, 0)", [
      lease.taskId,
      WORKER,
      lease.fenceToken,
      ERROR,
    ]);
    const next = await queue.claim(WORKER, { queue: queueName, leaseMs: 30_000 });
    expect(next?.id).toBe(lease.taskId);
    const holder = await openTransaction([
      {
        sql: "SELECT FROM workhorse.task_runtime WHERE task_id = $1 FOR UPDATE",
        parameters: [lease.taskId],
      },
    ]);
    try {
      // The same worker owns the row again, under a new fence. The old fence is not busy.
      expect(await heartbeat([lease])).toEqual([{ task_id: lease.taskId, status: "stale" }]);
    } finally {
      await finish(holder, "COMMIT");
    }
  });

  it("renews, skips, and refuses in one mixed batch in input order, and changes no busy row", async () => {
    const fastQueue = "busy-mixed-fast";
    await expect(
      admin.setQueueTier(fastQueue, "fast", adminAudit("move to the fast tier")),
    ).resolves.toBe("fast");
    const fast = await claimed(fastQueue);
    const fastBusy = await claimed(fastQueue);
    const free = await claimed("busy-mixed-full");
    const busy = await claimed("busy-mixed-full");
    const unknown: Lease = {
      taskId: "00000000-0000-4000-8000-000000000001",
      fenceToken: "1",
      leaseMs: 30_000,
    };
    const busyBefore = await expiresAt(busy.taskId);
    const fastBusyBefore = await expiresAt(fastBusy.taskId);
    const holder = await openTransaction([
      {
        sql: "SELECT FROM workhorse.task_runtime WHERE task_id = $1 FOR UPDATE",
        parameters: [busy.taskId],
      },
      {
        sql: "SELECT FROM workhorse.fast_task_runtime WHERE task_id = $1 FOR UPDATE",
        parameters: [fastBusy.taskId],
      },
    ]);
    try {
      const started = performance.now();
      expect(await heartbeat([busy, unknown, fast, fastBusy, free])).toEqual([
        { task_id: busy.taskId, status: "busy" },
        { task_id: unknown.taskId, status: "stale" },
        { task_id: fast.taskId, status: "accepted" },
        { task_id: fastBusy.taskId, status: "busy" },
        { task_id: free.taskId, status: "accepted" },
      ]);
      expect(performance.now() - started).toBeLessThan(1_000);
    } finally {
      await finish(holder, "COMMIT");
    }
    expect(await expiresAt(busy.taskId)).toBe(busyBefore);
    expect(await expiresAt(fastBusy.taskId)).toBe(fastBusyBefore);
  });

  it("gives each entry of a lease named twice the same result, on both tiers", async () => {
    const fastQueue = "busy-duplicate-fast";
    await expect(
      admin.setQueueTier(fastQueue, "fast", adminAudit("move to the fast tier")),
    ).resolves.toBe("fast");
    const fast = await claimed(fastQueue);
    const full = await claimed("busy-duplicate-full");
    const busy = await claimed("busy-duplicate-full");
    const holder = await openTransaction([
      {
        sql: "SELECT FROM workhorse.task_runtime WHERE task_id = $1 FOR UPDATE",
        parameters: [busy.taskId],
      },
    ]);
    try {
      // The full-tier lease is named twice, the second time with a longer lease.
      expect(await heartbeat([full, busy, { ...full, leaseMs: 60_000 }, fast, busy, fast])).toEqual(
        [
          { task_id: full.taskId, status: "accepted" },
          { task_id: busy.taskId, status: "busy" },
          { task_id: full.taskId, status: "accepted" },
          { task_id: fast.taskId, status: "accepted" },
          { task_id: busy.taskId, status: "busy" },
          { task_id: fast.taskId, status: "accepted" },
        ],
      );
    } finally {
      await finish(holder, "COMMIT");
    }
    // The renewal took the longer of the two durations.
    expect((await expiresAt(full.taskId)) - Date.now()).toBeGreaterThan(45_000);
  });

  it("keeps heartbeat_many_v1 unchanged: it waits for the row lock", async () => {
    const lease = await claimed("busy-v1-waits");
    const holder = await openTransaction([
      {
        sql: "SELECT FROM workhorse.task_runtime WHERE task_id = $1 FOR UPDATE",
        parameters: [lease.taskId],
      },
    ]);
    let answered = false;
    const call = pool
      .query<{ status: string }>(
        `SELECT status FROM workhorse.heartbeat_many_v1($1, $2::jsonb) ORDER BY ordinal`,
        [WORKER, JSON.stringify([lease])],
      )
      .then((result) => {
        answered = true;
        return result.rows.map((row) => row.status);
      });
    try {
      await sleep(300);
      expect(answered).toBe(false);
    } finally {
      await finish(holder, "COMMIT");
    }
    await expect(call).resolves.toEqual(["accepted"]);
  });

  // ADR 0081: SKIP LOCKED does not skip every wait. If a settlement commits between the snapshot
  // of the lock step and the lock, PostgreSQL follows the update chain to the new row version, and
  // that walk waits for a transaction that locks the new version. A pause in the lock step's filter
  // opens that gap here. On PostgreSQL 18 the statement waited until the claim committed. The
  // answer is never accepted, and the round's server timeouts bound such a wait.
  it("never renews a lease that a settlement committed during the lock step", async () => {
    const queueName = "busy-update-chain";
    const lease = await claimed(queueName);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `CREATE FUNCTION pg_temp.pause_once() RETURNS boolean LANGUAGE plpgsql AS $$
         BEGIN PERFORM pg_sleep(0.4); RETURN true; END $$`,
      );
      const source = (
        await client.query<{ source: string }>(
          "SELECT pg_get_functiondef('workhorse.heartbeat_many_v2(text,jsonb)'::regprocedure) AS source",
        )
      ).rows[0]!.source;
      const filter = "WHERE runtime.task_id = ANY (v_task_ids) AND runtime.worker_id = p_worker_id";
      expect(source).toContain(filter);
      // The paused copy lives in this transaction only. ROLLBACK restores the real function.
      await client.query(source.replace(filter, `${filter} AND pg_temp.pause_once()`));
      const started = performance.now();
      const call = heartbeat([lease], client);
      await sleep(100);
      // The settlement commits, and a claim locks the new row version, during the pause.
      await pool.query("SELECT workhorse.fail_v1($1::uuid, $2::text, $3::bigint, $4::jsonb, 0)", [
        lease.taskId,
        WORKER,
        lease.fenceToken,
        ERROR,
      ]);
      const claim = await openTransaction([
        {
          sql: "SELECT FROM workhorse.task_runtime WHERE task_id = $1 FOR UPDATE",
          parameters: [lease.taskId],
        },
      ]);
      try {
        await sleep(600);
      } finally {
        await finish(claim, "COMMIT");
      }
      const rows = await call;
      const elapsed = performance.now() - started;
      expect(rows).toHaveLength(1);
      expect(["stale", "busy"]).toContain(rows[0]!.status);
      // The statement ended, at the latest soon after the holder of the new version committed.
      expect(elapsed).toBeLessThan(5_000);
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
    }
  });
});
