import type { QueryResult } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createProviderAdapter,
  createProviderQueryable,
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
    toQueryable: (_executor: object, pool) =>
      createProviderQueryable({
        execute: async () => [],
        wrapError: (_statement, cause) => cause as Error,
        connectionPool: pool,
      }),
    connectionPool,
  });
}

describe("worker heartbeat reservation", () => {
  it("refuses a queue whose database cannot lend a connection, and names the opt-out", () => {
    const error = thrownBy(() => new Worker(new Queue(plainQueryable())));

    expect(error.message).toMatch(/cannot reserve a dedicated heartbeat connection/);
    expect(error.message).toMatch(/no connect\(\)/);
    expect(error.message).toMatch(/sharedHeartbeats: true/);
  });

  it("refuses a pool too small to lend the heartbeat connection, and names its size", () => {
    const error = thrownBy(() => new Worker(new Queue(fakePool(2))));

    expect(error.message).toMatch(/allows 2 connections and needs at least 3/);
    expect(error.message).toMatch(/sharedHeartbeats: true/);
  });

  it("refuses a pool of unknown size", () => {
    expect(thrownBy(() => new Worker(new Queue(fakePool(undefined)))).message).toMatch(
      /size is unknown/,
    );
  });

  it("accepts a pool of three connections", () => {
    expect(() => new Worker(new Queue(fakePool(3)))).not.toThrow();
  });

  it("accepts any queue when heartbeats share the pool", () => {
    expect(() => new Worker(new Queue(plainQueryable()), { sharedHeartbeats: true })).not.toThrow();
    expect(() => new Worker(new Queue(fakePool(1)), { sharedHeartbeats: true })).not.toThrow();
  });

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

  it("refuses an adapter's worker when the adapter has no pool", () => {
    expect(thrownBy(() => providerAdapter().createWorker()).message).toMatch(
      /cannot reserve a dedicated heartbeat connection/,
    );
    expect(() => providerAdapter().createWorker({ sharedHeartbeats: true })).not.toThrow();
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
