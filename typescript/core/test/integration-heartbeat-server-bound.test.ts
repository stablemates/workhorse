import { setTimeout as sleep } from "node:timers/promises";
import type { PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";
import { ReservedConnection } from "../src/heartbeat-connection.js";
import { Worker } from "../src/index.js";
import { workerHeartbeatReservation } from "../src/worker-internal.js";
import { createIntegrationTestContext } from "./support/integration.js";

// A heartbeat round on the reserved connection has a bound of heartbeatMs. Destroying the
// connection at the bound does not stop the statement on the server, so each round that times out
// used to leave one more backend waiting on the same lock. PostgreSQL now ends the statement at
// the same bound (SM-1442).

const { pool, queue } = createIntegrationTestContext(import.meta.url);

const HEARTBEAT_MS = 200;

/**
 * Make every heartbeat statement wait, and return the function that commits. heartbeat_many_v2
 * skips a locked row and reports it busy, so a row lock no longer slows it. It always locks its
 * fast-tier rows first, so an EXCLUSIVE lock on fast_task_runtime makes it wait on that table.
 * Enqueue and claim of full-tier tasks do not need that lock.
 */
async function blockHeartbeats(): Promise<() => Promise<void>> {
  const blocker = await pool.connect();
  try {
    await blocker.query("BEGIN");
    await blocker.query("LOCK TABLE workhorse.fast_task_runtime IN EXCLUSIVE MODE");
  } catch (error) {
    blocker.release(true);
    throw error;
  }
  return async () => {
    try {
      await blocker.query("COMMIT");
    } finally {
      blocker.release();
    }
  };
}

/** The active heartbeat statements in this test's database, with their age in milliseconds. */
async function activeHeartbeats(): Promise<number[]> {
  const result = await pool.query<{ age_ms: number }>(
    `SELECT extract(epoch FROM clock_timestamp() - query_start) * 1000 AS age_ms
       FROM pg_stat_activity
      WHERE datname = current_database() AND pid <> pg_backend_pid() AND state = 'active'
        AND query LIKE '%workhorse.heartbeat_many_v2%'`,
  );
  return result.rows.map((row) => Number(row.age_ms));
}

async function expiresAt(taskId: string): Promise<Date> {
  const result = await pool.query<{ expires_at: Date }>(
    "SELECT expires_at FROM workhorse.task_runtime WHERE task_id = $1",
    [taskId],
  );
  return result.rows[0]!.expires_at;
}

/**
 * A pool that lends clients of the test pool and records each statement they receive. While
 * `delay` returns a positive number for a statement, the client waits that long before it sends it.
 */
function recordingPool(delay: (text: string) => number) {
  const statements: string[] = [];
  const recording = {
    statements,
    connects: 0,
    pool: {
      options: { max: 10 },
      async connect(): Promise<PoolClient> {
        recording.connects += 1;
        const client = await pool.connect();
        const query = client.query.bind(client) as (...args: unknown[]) => Promise<unknown>;
        const release = client.release.bind(client);
        Object.assign(client, {
          async query(text: string, values?: unknown[]) {
            statements.push(text);
            const ms = delay(text);
            if (ms > 0) await sleep(ms);
            return query(text, values);
          },
          release(error?: Error | boolean) {
            // The pool lends this client again, so it gets its own query method back.
            delete (client as Partial<PoolClient>).query;
            client.release = release;
            release(error);
          },
        });
        return client;
      },
    },
  };
  return recording;
}

describe("heartbeat server bound", () => {
  it("keeps the connection when a round expires after BEGIN and before its heartbeat", async () => {
    let slowSettings = false;
    const recording = recordingPool((text) =>
      slowSettings && text.includes("set_config") ? 400 : 0,
    );
    const connection = new ReservedConnection(recording.pool);
    // A transaction with no batch sends the whole round and renews nothing.
    const round = () => connection.renew(1_000, () => []);
    try {
      await round();
      const sentBefore = recording.statements.length;
      // The settings statement uses more than the quarter of the round kept for COMMIT, but the
      // round still has time to roll back.
      slowSettings = true;
      await expect(round()).rejects.toThrow(/before its heartbeat/);
      slowSettings = false;
      expect(recording.statements.slice(sentBefore)).toEqual([
        "BEGIN",
        expect.stringContaining("set_config"),
        "ROLLBACK",
      ]);
      // The next round uses the same connection, so the worker kept it.
      await round();
      expect(recording.connects).toBe(1);
    } finally {
      await connection.close();
    }
  });

  it("ends a timed-out round on the server, so it holds no lock and renews no lease", async () => {
    const id = await queue.enqueue("bounded", {}, { queue: "heartbeat-bound-round" });
    const task = await queue.claim("bound-round-worker", { queue: "heartbeat-bound-round" });
    expect(task?.id).toBe(id);
    const channel = queue[workerHeartbeatReservation](1_000)!;
    try {
      const claimedUntil = await expiresAt(id);
      const commit = await blockHeartbeats();
      try {
        // PostgreSQL ends the statement first, at a quarter of the round's time.
        const started = performance.now();
        await expect(
          channel.heartbeatMany([task!], "bound-round-worker", 30_000, HEARTBEAT_MS),
        ).rejects.toThrow(/statement timeout|within 200 ms/);
        expect(performance.now() - started).toBeLessThan(2 * HEARTBEAT_MS);
        // The lock is still held, so only the server-side timeout can end the waiting statement.
        await vi.waitFor(async () => expect(await activeHeartbeats()).toEqual([]), {
          timeout: 5_000,
          interval: 20,
        });
      } finally {
        await commit();
      }
      // The timed-out round rolled back, so it did not renew the lease after the lock was gone.
      expect(await expiresAt(id)).toEqual(claimedUntil);

      const statuses = await channel.heartbeatMany(
        [task!],
        "bound-round-worker",
        30_000,
        HEARTBEAT_MS,
      );
      expect(statuses.get(id)).toBe("accepted");
      expect((await expiresAt(id)).getTime()).toBeGreaterThan(claimedUntil.getTime());
    } finally {
      await channel.close();
    }
  });

  it("keeps at most one heartbeat statement on the server while rounds time out", async () => {
    const id = await queue.enqueue("bounded", {}, { queue: "heartbeat-bound-worker" });
    let started!: () => void;
    const handlerStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    let finish!: () => void;
    const handlerFinished = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const worker = new Worker(queue, {
      workerId: "bound-worker",
      queue: "heartbeat-bound-worker",
      leaseMs: 30_000,
      heartbeatMs: HEARTBEAT_MS,
      registryIntervalMs: 0,
    }).handle("bounded", async () => {
      started();
      await handlerFinished;
      return null;
    });
    const run = worker.runOnce();
    try {
      await handlerStarted;
      const commit = await blockHeartbeats();
      const samples: number[][] = [];
      try {
        // Several rounds fall due while the lock is held. Without the server bound, each one left a
        // statement that waited until the commit, so the count and the age grew with every round.
        const until = Date.now() + 8 * HEARTBEAT_MS;
        while (Date.now() < until) {
          samples.push(await activeHeartbeats());
          await sleep(20);
        }
      } finally {
        await commit();
      }
      expect(samples.some((sample) => sample.length > 0)).toBe(true);
      expect(Math.max(...samples.map((sample) => sample.length))).toBeLessThanOrEqual(1);
      // A statement ends at its bound. The slack allows for a slow host, and stays far below the
      // 1.6 s that the lock was held.
      expect(Math.max(0, ...samples.flat())).toBeLessThan(5 * HEARTBEAT_MS);
    } finally {
      finish();
      expect(await run).toBe(true);
    }
    const outcome = await pool.query<{ state: string }>(
      "SELECT state FROM workhorse.task_outcome WHERE task_id = $1",
      [id],
    );
    expect(outcome.rows[0]?.state).toBe("succeeded");
  });
});
