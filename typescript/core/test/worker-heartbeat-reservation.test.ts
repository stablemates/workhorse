import type { QueryResult } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createProviderAdapter,
  createProviderQueryable,
  createWorkhorseAdapter,
  Queue,
  registerTelemetryProvider,
  Worker,
  type AdapterConnectionPool,
  type Queryable,
  type WorkerQueueApi,
  type WorkhorseTelemetryProvider,
} from "../src/index.js";

const emptyResult: QueryResult = { command: "", rowCount: 0, oid: 0, fields: [], rows: [] };

function plainQueryable(): Queryable {
  return { query: (async () => emptyResult) as Queryable["query"] };
}

function fakePool(max: number | undefined): AdapterConnectionPool {
  return {
    query: (async () => emptyResult) as Queryable["query"],
    connect: async () => ({ query: async () => emptyResult, release() {} }),
    ...(max === undefined ? {} : { options: { max } }),
  };
}

function thrownBy(operation: () => unknown): Error {
  try {
    operation();
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected the operation to throw");
}

function providerAdapter(connectionPool?: () => AdapterConnectionPool | undefined) {
  return createProviderAdapter({
    database: {},
    provider: "Example",
    toQueryable: (_executor: object, pool) =>
      createProviderQueryable({
        execute: async () => [],
        wrapError: (_statement, cause) => cause as Error,
        connectionPool: pool,
      }),
    connectionPool,
  });
}

const nextStep = /Give the queue a node-postgres pool with a maximum size \(max\) of at least 3/;

describe("worker heartbeat reservation", () => {
  it("refuses a queue whose database cannot lend a connection, and names the next step", () => {
    const error = thrownBy(() => new Worker(new Queue(plainQueryable())));

    expect(error.message).toMatch(/cannot reserve a dedicated heartbeat connection/);
    expect(error.message).toMatch(/no connect\(\)/);
    expect(error.message).toMatch(nextStep);
    expect(error.message).not.toMatch(/sharedHeartbeats/);
  });

  it.each([
    [1, /allows 1 connection and needs at least 3/],
    [2, /allows 2 connections and needs at least 3/],
  ])("refuses a pool of %i, and names the size it found and the size it needs", (max, size) => {
    const error = thrownBy(() => new Worker(new Queue(fakePool(max))));

    expect(error.message).toMatch(size);
    expect(error.message).toMatch(nextStep);
    expect(error.message).not.toMatch(/sharedHeartbeats/);
  });

  it("refuses a pool of unknown size, and names the size it needs", () => {
    const error = thrownBy(() => new Worker(new Queue(fakePool(undefined))));

    expect(error.message).toMatch(/reports no maximum size and needs a known size of at least 3/);
    expect(error.message).toMatch(nextStep);
    expect(error.message).not.toMatch(/sharedHeartbeats/);
  });

  it("accepts a pool of three connections", () => {
    expect(() => new Worker(new Queue(fakePool(3)))).not.toThrow();
  });

  it.each([true, false, undefined])(
    "names the removal when a caller still passes sharedHeartbeats: %s",
    (value) => {
      const options = { sharedHeartbeats: value };
      const error = thrownBy(
        // @ts-expect-error sharedHeartbeats is no longer a worker option.
        () => new Worker(new Queue(fakePool(3)), { sharedHeartbeats: value }),
      );
      expect(error.message).toMatch(/sharedHeartbeats option was removed/);
      expect(error.message).toMatch(/at least 3/);
      // A wider options object reaches the same check at run time.
      expect(() => new Worker(new Queue(fakePool(3)), options as never)).toThrow(
        /sharedHeartbeats option was removed/,
      );
      expect(() => providerAdapter(() => fakePool(3)).createWorker(options as never)).toThrow(
        /sharedHeartbeats option was removed/,
      );
    },
  );

  it("exempts a custom worker queue, which has no pool to check", () => {
    const custom = {
      defaultQueue: "default",
      claim: async () => null,
      complete: async () => true,
      fail: async () => "failed",
      heartbeatStatus: async () => "accepted",
      tick: async () => [],
      runMaintenance: async () => [],
    } as unknown as WorkerQueueApi;

    expect(() => new Worker(custom)).not.toThrow();
  });

  it("lets an adapter's worker reserve from the pool the adapter resolves", () => {
    const pool = fakePool(10);
    let resolved = 0;
    const adapter = providerAdapter(() => {
      resolved += 1;
      return pool;
    });

    expect(() => adapter.createWorker()).not.toThrow();
    expect(resolved).toBeGreaterThan(0);
  });

  it.each([
    ["no pool", undefined, /no connect\(\)/],
    ["a pool of 2", fakePool(2), /allows 2 connections and needs at least 3/],
    ["a pool of unknown size", fakePool(undefined), /reports no maximum size/],
  ])(
    "refuses an adapter's worker on %s, and names the adapter and its pool step",
    (_name, pool, size) => {
      const error = thrownBy(() => providerAdapter(() => pool).createWorker());

      expect(error.message).toMatch(/^Example adapter cannot create a worker: /);
      expect(error.message).toMatch(size);
      expect(error.message).toMatch(/as the adapter's pool option/);
      expect(error.message).not.toMatch(/sharedHeartbeats/);
    },
  );
});

describe("core adapter worker pool", () => {
  it.each([
    ["no pool", plainQueryable(), /no connect\(\)/],
    ["a pool of 2", fakePool(2), /allows 2 connections and needs at least 3/],
    ["a pool of unknown size", fakePool(undefined), /reports no maximum size/],
  ])(
    "refuses a worker on %s, and names the adapter and the database step",
    (_name, database, size) => {
      const adapter = createWorkhorseAdapter({
        database,
        adaptTransaction: (transaction: Queryable) => transaction,
      });
      const error = thrownBy(() => adapter.createWorker());

      expect(error.message).toMatch(/^Workhorse adapter cannot create a worker: /);
      expect(error.message).toMatch(size);
      expect(error.message).toMatch(/Give the adapter a database that is a node-postgres Pool/);
      expect(error.message).not.toMatch(/sharedHeartbeats/);
    },
  );

  it("names the removal before it checks the pool", () => {
    const adapter = createWorkhorseAdapter({
      database: plainQueryable(),
      adaptTransaction: (transaction: Queryable) => transaction,
    });

    expect(() => adapter.createWorker({ sharedHeartbeats: true } as never)).toThrow(
      /sharedHeartbeats option was removed/,
    );
  });
});

describe("worker default cohorts on a sized pool", () => {
  it("leaves one pooled connection per cohort after the listener and the heartbeat", () => {
    const cohorts = [3, 4, 6, 10, 32].map(
      (max) => new Worker(new Queue(fakePool(max)), { concurrency: 64 }).cohorts,
    );

    expect(cohorts).toEqual([1, 2, 4, 8, 8]);
  });

  it("keeps an explicit cohort count on a small pool", () => {
    expect(new Worker(new Queue(fakePool(3)), { concurrency: 64, cohorts: 8 }).cohorts).toBe(8);
  });

  it("leaves the default uncapped when the statement pool size is unknown", () => {
    expect(providerAdapter(() => fakePool(3)).createWorker({ concurrency: 64 }).cohorts).toBe(8);
  });
});

describe("worker listener warning", () => {
  let unregister: (() => void) | undefined;
  afterEach(() => unregister?.());

  it("logs one warning when run() starts without a notification listener", async () => {
    const emitLog = vi.fn<WorkhorseTelemetryProvider["emitLog"]>();
    unregister = registerTelemetryProvider({
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
    // This queue offers no notification subscription, so run() has to poll.
    const pollingOnly = {
      defaultQueue: "default",
      claim: async () => null,
      claimMany: async () => [],
      complete: async () => true,
      fail: async () => "failed",
      heartbeatStatus: async () => "accepted",
      tick: async () => [],
      runMaintenance: async () => [],
    } as unknown as WorkerQueueApi;
    const worker = new Worker(pollingOnly, { registryIntervalMs: 0, pollMs: 10 });
    const running = worker.run();
    await vi.waitFor(() =>
      expect(emitLog.mock.calls.some(([log]) => log.eventName === "workhorse.worker.started")).toBe(
        true,
      ),
    );
    worker.stop();
    await running.catch(() => undefined);

    const warnings = emitLog.mock.calls.filter(
      ([log]) => log.eventName === "workhorse.worker.polling_only",
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]![0].severity).toBe("warn");
  });
});
