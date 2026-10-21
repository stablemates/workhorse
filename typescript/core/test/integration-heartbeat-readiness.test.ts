import { Pool, type PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";
import { holdHeartbeatConnection } from "../src/heartbeat-connection.js";
import { workerHeartbeatReservation, type WorkerHeartbeatChannel } from "../src/worker-internal.js";
import { Queue, Worker } from "../src/index.js";
import { createIntegrationTestContext } from "./support/integration.js";

// ADR 0071 rules 3 to 7 for the TypeScript worker (SM-1575). A worker with the dedicated heartbeat
// connection waits for it at startup, checks that the pool can lend one more connection, and
// claims nothing while the heartbeat connection is lost.

const { databaseUrl, pool, admin, adminAudit } = createIntegrationTestContext(import.meta.url);

const ROUND_TIMEOUTS =
  "SELECT set_config('statement_timeout', $1, true), " +
  "set_config('idle_in_transaction_session_timeout', $2, true)";

/** A pool of `max` connections on the test database, closed by the caller. */
function smallPool(max: number): Pool {
  return new Pool({ connectionString: databaseUrl, max });
}

/** Take `count` connections from `source` and keep them until the returned function runs. */
async function occupy(source: Pool, count: number): Promise<() => void> {
  const clients: PoolClient[] = [];
  for (let index = 0; index < count; index += 1) clients.push(await source.connect());
  return () => {
    for (const client of clients) client.release();
  };
}

/**
 * A view of `source` whose connect() a test controls. Statements still go to `source.query`, so
 * claims work while connect() fails. Only the dedicated connections (listener, heartbeat, and the
 * readiness check) come from connect().
 */
function controlledPool(source: Pool, max: number, options: { stallListen?: boolean } = {}) {
  const control = {
    failing: false,
    // The connects that failed because `failing` was set.
    refused: 0,
    clients: [] as PoolClient[],
    pool: {
      options: { max },
      query: source.query.bind(source) as Pool["query"],
      async connect(): Promise<PoolClient> {
        if (control.failing) {
          control.refused += 1;
          throw new Error("connect() is blocked by the test");
        }
        const client = await source.connect();
        control.clients.push(client);
        if (options.stallListen === true) {
          const query = client.query.bind(client) as (...args: unknown[]) => unknown;
          Object.assign(client, {
            // The client goes back to the pool, and pg-pool's own query() passes a callback, so
            // every argument passes through unchanged.
            query(...args: unknown[]) {
              // A LISTEN that never answers, as behind a pooler that drops it.
              if (typeof args[0] === "string" && args[0].startsWith("LISTEN")) {
                return new Promise(() => {
                  // Never answers.
                });
              }
              return query(...args);
            },
          });
        }
        return client;
      },
    },
  };
  return control;
}

async function taskState(id: string): Promise<string | undefined> {
  return (await admin.getTask(id))?.state;
}

/**
 * Record the heartbeat channel that a worker on `queue` takes, and count each time the worker reads
 * its gate as closed. A test waits on these reads instead of a fixed time.
 */
function watchGate(queue: Queue) {
  const gate = { channel: undefined as WorkerHeartbeatChannel | undefined, closedReads: 0 };
  const reserve = queue[workerHeartbeatReservation].bind(queue);
  vi.spyOn(queue, workerHeartbeatReservation).mockImplementation((intervalMs) => {
    const channel = reserve(intervalMs);
    if (channel !== undefined) {
      const usable = channel.usable.bind(channel);
      channel.usable = () => {
        const open = usable();
        if (!open) gate.closedReads += 1;
        return open;
      };
      gate.channel = channel;
    }
    return channel;
  });
  return gate;
}

/** Count the calls of a claim method of `queue` that have not settled. */
function trackClaims(queue: Queue, method: "claimMany" | "claimFast") {
  const claims = { started: 0, inFlight: 0, last: undefined as Promise<unknown> | undefined };
  const original = queue[method].bind(queue) as (...args: unknown[]) => Promise<unknown>;
  vi.spyOn(queue, method).mockImplementation(((...args: unknown[]) => {
    claims.started += 1;
    claims.inFlight += 1;
    const call = original(...args).finally(() => {
      claims.inFlight -= 1;
    });
    claims.last = call;
    return call;
  }) as never);
  return claims;
}

/** The state of a fast-tier task: its outcome once settled, otherwise its runtime state. */
async function fastState(id: string): Promise<string | undefined> {
  const result = await pool.query<{ state: string }>(
    `SELECT state FROM workhorse.fast_task_outcome WHERE task_id = $1::uuid
      UNION ALL
     SELECT state FROM workhorse.fast_task_runtime WHERE task_id = $1::uuid`,
    [id],
  );
  return result.rows[0]?.state;
}

describe("worker heartbeat readiness", () => {
  it("refuses to start when the pool cannot lend the heartbeat connection", async () => {
    const full = smallPool(3);
    const release = await occupy(full, 3);
    try {
      const worker = new Worker(new Queue(full), { heartbeatMs: 100, registryIntervalMs: 0 });
      const started = performance.now();
      const run = worker.run();
      await expect(run).rejects.toThrow(
        /Worker refused to start: the queue's pool of 3 connections did not lend the dedicated heartbeat connection within the startup budget of 5000 ms .*sharedHeartbeats: true/,
      );
      // The budget is max(heartbeatMs, 5 s), not the interval of 100 ms.
      expect(performance.now() - started).toBeGreaterThanOrEqual(4_900);
    } finally {
      release();
      await full.end();
    }
  }, 20_000);

  it("refuses to start when the pool lends the heartbeat connection but no other", async () => {
    const tight = smallPool(3);
    const release = await occupy(tight, 2);
    try {
      const worker = new Worker(new Queue(tight), { heartbeatMs: 100, registryIntervalMs: 0 });
      await expect(worker.run()).rejects.toThrow(
        /did not lend one more connection and answer the compatibility query on it within the startup budget of 5000 ms/,
      );
    } finally {
      release();
      await tight.end();
    }
  }, 20_000);

  it("refuses to start when the compatibility query does not finish within the budget", async () => {
    // A migration holds the version table, so the compatibility query waits for its lock.
    const blocker = await pool.connect();
    await blocker.query("BEGIN");
    await blocker.query("LOCK TABLE workhorse.schema_version IN ACCESS EXCLUSIVE MODE");
    const source = smallPool(10);
    try {
      const worker = new Worker(new Queue(source), { heartbeatMs: 100, registryIntervalMs: 0 });
      const started = performance.now();
      await expect(worker.run()).rejects.toThrow(
        /did not lend one more connection and answer the compatibility query on it/,
      );
      expect(performance.now() - started).toBeLessThan(5_000 + 2_000);
    } finally {
      await blocker.query("ROLLBACK");
      blocker.release();
      await source.end();
    }
  }, 20_000);

  it("starts on a pool that is still warming up at a 100 ms interval", async () => {
    const source = smallPool(10);
    const control = controlledPool(source, 10);
    const id = await new Queue(source).enqueue("warmup.task", {}, { queue: "warmup" });
    // The pool lends nothing until the worker has failed to connect and tried again.
    control.failing = true;
    const handled: string[] = [];
    const worker = new Worker(new Queue(control.pool), {
      queue: "warmup",
      heartbeatMs: 100,
      leaseMs: 5_000,
      pollMs: 20,
      registryIntervalMs: 0,
    }).handle("warmup.task", async (_payload, context) => {
      handled.push(context.task.id);
      return null;
    });
    const run = worker.run();
    try {
      // 1. The startup reservation fails, and the replacement retries within the startup budget.
      await vi.waitFor(() => expect(control.refused).toBeGreaterThanOrEqual(2));
      expect(handled).toEqual([]);
      // 2. The pool recovers, and the worker starts instead of refusing.
      control.failing = false;
      await vi.waitFor(() => expect(handled).toEqual([id]), { timeout: 5_000 });
    } finally {
      control.failing = false;
      worker.stop();
      await run;
      await source.end();
    }
  }, 20_000);

  it("claims nothing while the heartbeat connection is lost, and claims at once after it returns", async () => {
    const source = smallPool(10);
    const control = controlledPool(source, 10);
    const producer = new Queue(source);
    const handled: string[] = [];
    const workerQueue = new Queue(control.pool);
    const gate = watchGate(workerQueue);
    const claims = trackClaims(workerQueue, "claimMany");
    const worker = new Worker(workerQueue, {
      queue: "gate",
      heartbeatMs: 200,
      leaseMs: 5_000,
      // Only a wake can start a claim soon after the recovery.
      pollMs: 60_000,
      registryIntervalMs: 0,
    }).handle("gate.task", async (_payload, context) => {
      handled.push(context.task.id);
      return null;
    });
    const run = worker.run();
    try {
      // The first connect() of run() is the heartbeat reservation.
      await vi.waitFor(() => expect(control.clients.length).toBeGreaterThanOrEqual(2));
      const heartbeat = control.clients[0]!;
      const first = await producer.enqueue("gate.task", {}, { queue: "gate" });
      await vi.waitFor(() => expect(handled).toEqual([first]), { timeout: 5_000 });

      // The heartbeat connection fails between rounds, and the pool lends no replacement.
      expect(control.clients[0]).toBe(heartbeat);
      await loseHeartbeat(control, gate);
      await vi.waitFor(() => expect(claims.inFlight).toBe(0));
      const claimsBefore = claims.started;
      const readsBefore = gate.closedReads;
      // The listener wakes dispatch for the new task. Dispatch reads the closed gate and claims
      // nothing. Nothing else wakes it before the poll interval of one minute.
      const second = await producer.enqueue("gate.task", {}, { queue: "gate" });
      await vi.waitFor(() => expect(gate.closedReads).toBeGreaterThan(readsBefore));
      expect(claims.started).toBe(claimsBefore);
      expect(await taskState(second)).toBe("ready");
      expect(handled).toEqual([first]);

      // The replacement wakes dispatch, long before the poll interval ends.
      control.failing = false;
      await vi.waitFor(() => expect(handled).toEqual([first, second]), { timeout: 5_000 });
    } finally {
      control.failing = false;
      worker.stop();
      await run;
      await source.end();
    }
  }, 30_000);
});

/** Lose the heartbeat connection of `control` and keep the pool from lending a replacement. */
async function loseHeartbeat(
  control: ReturnType<typeof controlledPool>,
  gate: ReturnType<typeof watchGate>,
): Promise<void> {
  control.failing = true;
  await pool.query("SELECT pg_terminate_backend($1)", [
    (control.clients[0] as unknown as { processID: number }).processID,
  ]);
  // The reservation sees the loss when its client reports the terminated backend.
  await vi.waitFor(() => expect(gate.channel?.usable()).toBe(false));
}

// Each test fills the worker's pool, so that a claim waits for a pooled connection. While it waits,
// the heartbeat connection is lost. Then the test frees the pool, and the claim gets a connection.
// The pool lends 4: the heartbeat connection, the listener, and the 2 that the test takes.
const GATE_POOL_SIZE = 4;

/** Take every free connection of `source` once the worker holds its heartbeat and listener. */
async function fillPool(source: Pool): Promise<() => void> {
  await vi.waitFor(() => expect(source.totalCount - source.idleCount).toBe(2));
  return occupy(source, GATE_POOL_SIZE - 2);
}

const gateWorkerOptions = {
  heartbeatMs: 200,
  leaseMs: 5_000,
  // Only a claim or a completion asks the pool for a connection while the test fills it.
  pollMs: 60_000,
  maintenanceIntervalMs: 60_000,
  maintenanceRoutinePollMs: 60_000,
  registryIntervalMs: 0,
};

describe("claim gate after the borrow", () => {
  it("runs no claim that waited for its connection while the heartbeat connection was lost", async () => {
    const source = smallPool(GATE_POOL_SIZE);
    const control = controlledPool(source, GATE_POOL_SIZE);
    const producer = new Queue(pool);
    const handled: string[] = [];
    const workerQueue = new Queue(control.pool);
    const gate = watchGate(workerQueue);
    const claims = trackClaims(workerQueue, "claimMany");
    const worker = new Worker(workerQueue, {
      ...gateWorkerOptions,
      queue: "gate-borrow",
    }).handle("gate.task", async (_payload, context) => {
      handled.push(context.task.id);
      return null;
    });
    const run = worker.run();
    let freePool: (() => void) | undefined;
    try {
      const first = await producer.enqueue("gate.task", {}, { queue: "gate-borrow" });
      await vi.waitFor(() => expect(handled).toEqual([first]), { timeout: 5_000 });

      // 1. The claim for the next task waits for a pooled connection.
      freePool = await fillPool(source);
      const second = await producer.enqueue("gate.task", {}, { queue: "gate-borrow" });
      await vi.waitFor(() => expect(source.waitingCount).toBe(1));
      expect(claims.inFlight).toBe(1);
      const waiting = claims.last!;
      // 2. The heartbeat connection is lost while the claim waits.
      await loseHeartbeat(control, gate);
      // 3. The claim gets its connection, reads the closed gate, and sends nothing.
      freePool();
      freePool = undefined;
      await expect(waiting).rejects.toThrow(/no usable heartbeat connection/);
      await vi.waitFor(() => expect(claims.inFlight).toBe(0));
      expect(await taskState(second)).toBe("ready");
      expect(handled).toEqual([first]);

      control.failing = false;
      await vi.waitFor(() => expect(handled).toEqual([first, second]), { timeout: 2_000 });
    } finally {
      freePool?.();
      control.failing = false;
      worker.stop();
      await run;
      await source.end();
    }
  }, 30_000);

  it("sends a queued fast-tier completion with a claim limit of zero after the heartbeat connection is lost", async () => {
    const source = smallPool(GATE_POOL_SIZE);
    const control = controlledPool(source, GATE_POOL_SIZE);
    const producer = new Queue(pool);
    await expect(
      admin.setQueueTier("gate-fused", "fast", adminAudit("move to the fast tier")),
    ).resolves.toBe("fast");
    let finishFirst!: () => void;
    const firstHeld = new Promise<void>((resolve) => {
      finishFirst = resolve;
    });
    const handled: string[] = [];
    const workerQueue = new Queue(control.pool);
    const gate = watchGate(workerQueue);
    const claims = trackClaims(workerQueue, "claimFast");
    const worker = new Worker(workerQueue, {
      ...gateWorkerOptions,
      queue: "gate-fused",
    }).handle("gate.task", async (_payload, context) => {
      handled.push(context.task.id);
      if (handled.length === 1) await firstHeld;
      return null;
    });
    const run = worker.run();
    let freePool: (() => void) | undefined;
    try {
      const first = await producer.enqueue("gate.task", {}, { queue: "gate-fused" });
      await vi.waitFor(() => expect(handled).toEqual([first]), { timeout: 5_000 });
      // The next task is ready, so the fused completion of the first task would claim it.
      const second = await producer.enqueue("gate.task", {}, { queue: "gate-fused" });

      // 1. The completion of the first task waits for a pooled connection.
      freePool = await fillPool(source);
      finishFirst();
      await vi.waitFor(() => expect(source.waitingCount).toBe(1));
      // 2. The heartbeat connection is lost while the completion waits.
      await loseHeartbeat(control, gate);
      // 3. The completion runs, settles the first task, and claims nothing.
      freePool();
      freePool = undefined;
      await vi.waitFor(() => expect(worker.runtimeState().activeSlots).toBe(0));
      await vi.waitFor(() => expect(claims.inFlight).toBe(0));
      expect(await fastState(first)).toBe("succeeded");
      expect(await fastState(second)).toBe("ready");
      expect(handled).toEqual([first]);

      control.failing = false;
      await vi.waitFor(() => expect(handled).toEqual([first, second]), { timeout: 2_000 });
    } finally {
      freePool?.();
      control.failing = false;
      finishFirst();
      worker.stop();
      await run;
      await source.end();
    }
  }, 30_000);
});

describe("best-effort listener", () => {
  it("starts and polls on a pool of 3 when LISTEN stalls", async () => {
    const source = smallPool(3);
    const control = controlledPool(source, 3, { stallListen: true });
    const handled: string[] = [];
    const worker = new Worker(new Queue(control.pool), {
      queue: "stalled-listen",
      heartbeatMs: 100,
      leaseMs: 5_000,
      pollMs: 20,
      registryIntervalMs: 0,
    }).handle("gate.task", async (_payload, context) => {
      handled.push(context.task.id);
      return null;
    });
    const id = await new Queue(source).enqueue("gate.task", {}, { queue: "stalled-listen" });
    const run = worker.run();
    try {
      // The heartbeat connection, the stalled listener, and one connection for claims.
      await vi.waitFor(() => expect(handled).toEqual([id]), { timeout: 5_000 });
    } finally {
      worker.stop();
      await run;
      await source.end();
    }
  }, 20_000);
});

describe("destroyed heartbeat connection", () => {
  it("keeps the server's late FATAL error from reaching the pool after the round ends", async () => {
    // CI run 39600710287: a round ended inside its transaction, the round destroyed the
    // connection, and PostgreSQL then ended the session with FATAL 25P03 (idle-in-transaction
    // timeout). pg-pool's idle listener emitted that error on a pool without an error listener.
    const poolErrors: unknown[] = [];
    pool.on("error", (error) => poolErrors.push(error));
    const clientErrors: string[] = [];
    let removed!: () => void;
    const clientRemoved = new Promise<void>((resolve) => {
      removed = resolve;
    });
    pool.once("remove", () => removed());
    const lender = {
      options: { max: 10 },
      query: pool.query.bind(pool) as Pool["query"],
      async connect(): Promise<PoolClient> {
        const client = await pool.connect();
        client.on("error", (error: Error & { code?: string }) =>
          clientErrors.push(error.code ?? ""),
        );
        const query = client.query.bind(client) as (...args: unknown[]) => Promise<unknown>;
        Object.assign(client, {
          async query(text: string, values?: unknown[]) {
            const result = await query(text, values);
            if (text === ROUND_TIMEOUTS) {
              // A loaded host: the event loop stops past the idle timeout and the deadline, so the
              // round fails and releases the connection before the FATAL error is read.
              const until = performance.now() + 150;
              while (performance.now() < until) {
                // Busy wait.
              }
            }
            return result;
          },
        });
        return client;
      },
    };
    const hold = holdHeartbeatConnection(lender as unknown as Pool, 1_000)!;
    try {
      await expect(hold.run((client) => client.query("SELECT 1"), 50)).rejects.toThrow(
        /deadline|did not finish/,
      );
      await clientRemoved;
      await vi.waitFor(() => expect(clientErrors).toContain("25P03"));
      // The pool's idle listener would get the error in the same emit as the test's listener.
      expect(poolErrors).toEqual([]);
    } finally {
      await hold.close();
      pool.removeAllListeners("error");
    }
  });
});
