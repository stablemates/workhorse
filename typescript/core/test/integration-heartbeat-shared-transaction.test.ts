import { setTimeout as sleep } from "node:timers/promises";
import { Pool } from "pg";
import { afterEach, describe, expect, it } from "vitest";
import { Queue, Worker } from "../src/index.js";
import { startDelayProxy } from "./support/delay-proxy.js";
import { createIntegrationTestContext } from "./support/integration.js";

// Every worker on a pool renews its leases through the one heartbeat connection of that pool. If
// each worker sent its own transaction, the round trips of a round grew with the number of workers,
// and on a slow network the rounds could not renew every lease in time (SM-1633). The rounds that
// wait for the connection now share one transaction and one heartbeat statement.

const { admin, databaseUrl, queue } = createIntegrationTestContext(import.meta.url);

const WORKERS = 8;
const CONCURRENCY = 2;
const TASKS = 2 * WORKERS * CONCURRENCY;
const ROUND_TRIP_DELAY_MS = 80;
const HANDLER_MS = 4_000;

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

describe("heartbeat transaction shared by the workers of a pool", () => {
  it("manyWorkersOnASmallPoolKeepEveryLeaseWhenEachRoundTripTakes80Ms", async () => {
    const proxy = await startDelayProxy(databaseUrl, ROUND_TRIP_DELAY_MS);
    cleanups.push(() => proxy.close());
    // The pool holds the notification listener, the heartbeat connection, and the claims and
    // completions of every worker. The test measures round trips, not the disk: other test
    // databases on the same server can make a WAL flush wait for seconds, so a COMMIT of the
    // workers does not wait for its flush.
    const pool = new Pool({
      connectionString: proxy.url,
      max: 6,
      options: "-c synchronous_commit=off",
    });
    pool.on("error", () => undefined);
    cleanups.push(() => pool.end());
    const slowQueue = new Queue(pool);

    const ids = await queue.enqueueMany(
      Array.from({ length: TASKS }, (_, index) => ({
        type: "slow-handler",
        payload: { index },
        options: { queue: "heartbeat-shared-transaction" },
      })),
    );
    const handled = new Map<string, number>();
    const workers = Array.from({ length: WORKERS }, (_, index) =>
      new Worker(slowQueue, {
        workerId: `shared-transaction-worker-${index}`,
        queue: "heartbeat-shared-transaction",
        concurrency: CONCURRENCY,
        leaseMs: 3_000,
        heartbeatMs: 1_000,
        registryIntervalMs: 0,
      }).handle("slow-handler", async (_payload, context) => {
        handled.set(context.task.id, (handled.get(context.task.id) ?? 0) + 1);
        // Longer than the lease, so only heartbeats keep the lease.
        await sleep(HANDLER_MS);
        return null;
      }),
    );
    const runs = workers.map((worker) => worker.run());
    cleanups.push(async () => {
      for (const worker of workers) worker.stop();
      await Promise.allSettled(runs);
    });

    const deadline = Date.now() + 60_000;
    let snapshots = await Promise.all(ids.map((id) => admin.getTask(id)));
    while (
      snapshots.some((task) => task?.state !== "succeeded" && task?.state !== "failed") &&
      Date.now() < deadline
    ) {
      await sleep(250);
      snapshots = await Promise.all(ids.map((id) => admin.getTask(id)));
    }
    for (const worker of workers) worker.stop();
    await Promise.all(runs);

    expect(snapshots.map((task) => [task?.state, task?.currentAttempt])).toEqual(
      ids.map(() => ["succeeded", 1]),
    );
    // A lost lease aborts the handler and lets another claim run it again.
    expect([...handled.values()]).toEqual(ids.map(() => 1));
  }, 90_000);
});
