import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  Queue,
  registerTelemetryProvider,
  Worker,
  type Queryable,
  type WorkhorseTelemetryProvider,
} from "../src/index.js";
import { createIntegrationTestContext } from "./support/integration.js";

// SM-1585: under the shared heartbeat opt-out, the listener starts only on a pool that reports a
// maximum size of at least 2. The listener holds one pooled connection, so on a pool of 1 it would
// hold the only one. A pool that hides its size could be that pool, so the worker polls on it.

const { databaseUrl, pool: observer, admin } = createIntegrationTestContext(import.meta.url);

const TASK_TYPE = "small-pool";
// Every wait ends well before the 30 s connection timeout of the pool. A worker whose listener
// holds the only connection fails a wait, not with a pool timeout.
const WAIT_MS = 10_000;
const POOL_TIMEOUT_MS = 30_000;

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

/** Settles with `promise`, or rejects with `message` once `WAIT_MS` passed. */
async function within<T>(promise: Promise<T>, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), WAIT_MS);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** The backends of the pool named `applicationName` whose latest statement is LISTEN. */
async function listenerBackends(applicationName: string): Promise<number> {
  const result = await observer.query<{ count: string }>(
    `SELECT count(*) FROM pg_stat_activity
      WHERE datname = current_database() AND application_name = $1 AND query LIKE 'LISTEN %'`,
    [applicationName],
  );
  return Number(result.rows[0]!.count);
}

function recordWarnings(): { warnings: Record<string, unknown>[]; unregister: () => void } {
  const emitLog = vi.fn<WorkhorseTelemetryProvider["emitLog"]>();
  const unregister = registerTelemetryProvider({
    emitLog,
    createCounter: () => ({ add() {} }),
    createHistogram: () => ({ record() {} }),
    createGauge: () => ({ record() {} }),
    registerObservations: () => () => {},
    activeContext: () => undefined,
    injectTraceContext: () => null,
    extractTraceContext: () => undefined,
    withSpan: async (_name, _attributes, operation) =>
      operation({
        setAttribute() {
          return this;
        },
        setAttributes() {
          return this;
        },
        setStatus() {
          return this;
        },
        recordException() {},
      }),
  });
  const warnings: Record<string, unknown>[] = [];
  emitLog.mockImplementation((log) => {
    if (log.eventName === "workhorse.worker.polling_only") {
      warnings.push({ severity: log.severity, body: log.body, ...log.attributes });
    }
  });
  return { warnings, unregister };
}

interface Result {
  // The listener backends that each handler saw while it ran.
  seen: number[];
  // The listener backends once the worker reported its listener, or null when it never listened.
  listening: number | null;
}

/**
 * Run one worker with the opt-out on a fresh pool of `max` connections. Two tasks exist before the
 * start. A third arrives once both ran, so it needs a later claim. When `hidden` is true, the
 * queue sees only `query()` and `connect()`, so the pool reports no maximum size.
 */
async function completeThreeTasks(max: number, hidden: boolean): Promise<Result> {
  const name = `small-pool-${hidden ? "hidden" : "known"}-${max}-${randomUUID().slice(0, 8)}`;
  const source = new Pool({
    connectionString: databaseUrl,
    max,
    application_name: name,
    connectionTimeoutMillis: POOL_TIMEOUT_MS,
  });
  try {
    const database: Queryable = hidden
      ? ({
          query: source.query.bind(source),
          connect: source.connect.bind(source),
        } as unknown as Queryable)
      : source;
    const queue = new Queue(database);
    const listened = deferred();
    const subscribe = queue.subscribeToTaskNotifications.bind(queue);
    // The listener wakes the worker once its LISTEN has returned.
    vi.spyOn(queue, "subscribeToTaskNotifications").mockImplementation((queueName, wake, error) =>
      subscribe(
        queueName,
        () => {
          listened.resolve();
          wake();
        },
        error,
      ),
    );
    const handled = [deferred(), deferred(), deferred()];
    const seen: number[] = [];
    const worker = new Worker(queue, {
      queue: name,
      workerId: name,
      sharedHeartbeats: true,
      pollMs: 50,
      heartbeatMs: 200,
      leaseMs: 5_000,
    }).handle(TASK_TYPE, async () => {
      await source.query("SELECT 1");
      seen.push(await listenerBackends(name));
      handled[seen.length - 1]?.resolve();
      return null;
    });
    const enqueue = () =>
      new Queue(observer).enqueue(TASK_TYPE, {}, { queue: name, maxAttempts: 1 });
    const tasks = [await enqueue(), await enqueue()];
    let listening: number | null = null;
    const running = worker.run();
    try {
      if (!hidden && max >= 2) {
        await within(listened.promise, "the worker never listened");
        listening = await listenerBackends(name);
      }
      await within(handled[1]!.promise, "the first two tasks did not run");
      tasks.push(await enqueue());
      await within(handled[2]!.promise, "the third task did not run");
    } finally {
      worker.stop();
    }
    await within(running, "the worker did not stop");
    for (const id of tasks) expect((await admin.getTask(id))?.state).toBe("succeeded");
    // After the stop, the pool lends every connection at once.
    const clients: PoolClient[] = await within(
      Promise.all(Array.from({ length: max }, () => source.connect())),
      "the pool did not lend its connections after the stop",
    );
    for (const client of clients) client.release();
    return { seen, listening };
  } finally {
    await source.end();
  }
}

describe("worker listener on a small pool with the opt-out", () => {
  let unregister: (() => void) | undefined;
  afterEach(() => unregister?.());

  it("polls on a known pool of 1, keeps one listener on a known pool of 2, and warns once", async () => {
    const recorded = recordWarnings();
    unregister = recorded.unregister;

    expect(await completeThreeTasks(1, false)).toEqual({ seen: [0, 0, 0], listening: null });
    expect(recorded.warnings).toEqual([
      expect.objectContaining({
        severity: "warn",
        body: "Worker has no notification listener and dispatches by polling",
        "workhorse.worker.pool_max_size": 1,
      }),
    ]);

    const pair = await completeThreeTasks(2, false);
    expect(pair.listening).toBe(1);
    expect(recorded.warnings).toHaveLength(1);
  });

  it("polls on a pool that hides its size of 1 or 2, and warns once for each run", async () => {
    const recorded = recordWarnings();
    unregister = recorded.unregister;

    // No listener ever holds a connection of a pool whose size the worker does not know.
    expect(await completeThreeTasks(1, true)).toEqual({ seen: [0, 0, 0], listening: null });
    expect(await completeThreeTasks(2, true)).toEqual({ seen: [0, 0, 0], listening: null });
    expect(recorded.warnings).toEqual([
      expect.objectContaining({ "workhorse.worker.pool_max_size": "unknown" }),
      expect.objectContaining({ "workhorse.worker.pool_max_size": "unknown" }),
    ]);
  });
});
