import { describe, expect, it, vi } from "vitest";
import {
  attachNotificationPool,
  createProviderAdapter,
  createProviderQueryable,
  QueryError,
  rowsToQueryResult,
  WorkhorseError,
  type AdapterNotificationPool,
} from "../src/index.js";
import type { Queryable } from "../src/types.js";

// The four ORM packages each held their own copy of this behavior, and the copies had drifted —
// most visibly in how deeply each one looked for a SQLSTATE. This file is the contract they are
// being moved onto: it states what the shared core does with each driver's real error shape, so a
// provider package can be thin without any of them re-deciding these questions.

/** A node-postgres error, which is what every wrapper below eventually contains. */
function driverError(code: string, detail?: string): Error {
  return Object.assign(new Error("duplicate key value violates unique constraint"), {
    code,
    ...(detail === undefined ? {} : { detail }),
  });
}

function notificationPool(max?: number): AdapterNotificationPool {
  return {
    query: vi.fn<() => Promise<never>>(),
    connect: vi.fn<() => Promise<unknown>>().mockResolvedValue({}),
    ...(max === undefined ? {} : { options: { max } }),
  } as unknown as AdapterNotificationPool;
}

describe("QueryError", () => {
  it("names the provider and keeps the driver failure reachable", () => {
    const cause = driverError("23505");
    const error = new QueryError("Kysely", "SELECT 1", cause);
    expect(error.message).toBe("Kysely failed to execute a Workhorse database operation");
    expect(error.statement).toBe("SELECT 1");
    expect(error.cause).toBe(cause);
    expect(error).toBeInstanceOf(WorkhorseError);
  });

  it.each([
    ["node-postgres, unwrapped", (cause: Error) => cause],
    [
      "a cause chain, as Drizzle and Kysely wrap",
      (cause: Error) => new Error("Failed query", { cause: new Error("driver", { cause }) }),
    ],
    [
      "driverError, as TypeORM wraps",
      (cause: Error) => Object.assign(new Error("QueryFailedError"), { driverError: cause }),
    ],
    [
      "meta, as Prisma wraps a raw failure in P2010",
      (cause: Error) =>
        Object.assign(new Error("Raw query failed"), { code: "P2010", meta: cause }),
    ],
  ])("reads the SQLSTATE through %s", (_shape, wrap) => {
    expect(new QueryError("Provider", "SELECT 1", wrap(driverError("P1001"))).code).toBe("P1001");
  });

  it("has no code when the failure carried none", () => {
    expect(new QueryError("Provider", "SELECT 1", new Error("connection refused")).code).toBe(
      undefined,
    );
  });
});

describe("rowsToQueryResult", () => {
  it("states every field of the node-postgres result shape", () => {
    expect(rowsToQueryResult([{ id: 1 }])).toEqual({
      command: "",
      rowCount: 1,
      oid: 0,
      fields: [],
      rows: [{ id: 1 }],
    });
  });

  it("does not alias the caller's array", () => {
    const rows = [{ id: 1 }];
    const result = rowsToQueryResult(rows);
    rows.push({ id: 2 });
    expect(result.rows).toEqual([{ id: 1 }]);
    expect(rowsToQueryResult([]).rowCount).toBe(0);
  });
});

describe("attachNotificationPool", () => {
  it("lends the pool's connection, capacity, and identity", async () => {
    const pool = notificationPool(7);
    const queryable: Queryable = { query: vi.fn<() => Promise<never>>() };
    attachNotificationPool(queryable, pool);

    const attached = queryable as Queryable & {
      connect: () => Promise<unknown>;
      notificationConnectionCapacity?: number;
      notificationConnectionIdentity?: object;
    };
    await attached.connect();
    expect(pool.connect).toHaveBeenCalledOnce();
    expect(attached.notificationConnectionCapacity).toBe(7);
    expect(attached.notificationConnectionIdentity).toBe(pool);
  });

  it("reports unknown capacity when the pool states no maximum", () => {
    const queryable: Queryable = { query: vi.fn<() => Promise<never>>() };
    attachNotificationPool(queryable, notificationPool());
    expect(
      (queryable as { notificationConnectionCapacity?: number }).notificationConnectionCapacity,
    ).toBe(undefined);
  });
});

function wrapError(statement: string, cause: unknown): Error {
  return new QueryError("Provider", statement, cause);
}

describe("createProviderQueryable", () => {
  it("returns the rows the provider produced as a query result", async () => {
    const queryable = createProviderQueryable({
      execute: (statement, values) => Promise.resolve([{ statement, first: values[0] as number }]),
      wrapError,
    });
    await expect(queryable.query("SELECT $1", [42])).resolves.toEqual({
      command: "",
      rowCount: 1,
      oid: 0,
      fields: [],
      rows: [{ statement: "SELECT $1", first: 42 }],
    });
  });

  it("translates a driver failure into the provider's error, SQLSTATE and all", async () => {
    const queryable = createProviderQueryable({
      execute: () => Promise.reject(driverError("P1001")),
      wrapError,
    });
    await expect(queryable.query("INSERT")).rejects.toMatchObject({
      name: "QueryError",
      statement: "INSERT",
      code: "P1001",
    });
  });

  it("does not wrap an already-translated failure a second time", async () => {
    const translated = new QueryError("Provider", "SELECT 1", driverError("23505"));
    const queryable = createProviderQueryable({
      execute: () => Promise.reject(translated),
      wrapError,
    });
    await expect(queryable.query("SELECT 1")).rejects.toBe(translated);
  });

  it("lets a malformed statement stay the caller's error", async () => {
    const malformed = new RangeError("SQL placeholder $2 has no matching value");
    const queryable = createProviderQueryable({
      execute: () => Promise.reject(malformed),
      wrapError,
    });
    await expect(queryable.query("SELECT $2", [1])).rejects.toBe(malformed);
  });

  it("rejects a provider that answered with something other than rows", async () => {
    const queryable = createProviderQueryable({
      execute: () => Promise.resolve({ rows: [] } as unknown as never[]),
      wrapError,
    });
    await expect(queryable.query("SELECT 1")).rejects.toBeInstanceOf(QueryError);
  });

  it("attaches a notification pool when one is offered", () => {
    const pool = notificationPool(3);
    const queryable = createProviderQueryable({ execute: () => Promise.resolve([]), wrapError });
    const listening = createProviderQueryable({
      execute: () => Promise.resolve([]),
      wrapError,
      notificationPool: pool,
    });
    expect((queryable as { connect?: unknown }).connect).toBe(undefined);
    expect(
      (listening as { notificationConnectionIdentity?: object }).notificationConnectionIdentity,
    ).toBe(pool);
  });
});

describe("createProviderAdapter", () => {
  interface FakeExecutor {
    name: string;
  }

  function build(options: { close?: () => void } = {}) {
    const seen: { executor: FakeExecutor; pool: AdapterNotificationPool | undefined }[] = [];
    const pool = notificationPool(5);
    const adapter = createProviderAdapter<FakeExecutor>({
      database: { name: "database" },
      toQueryable: (executor, notification) => {
        seen.push({ executor, pool: notification });
        const queryable = createProviderQueryable({
          execute: () => Promise.resolve([]),
          wrapError: (statement, cause) => new QueryError("Fake", statement, cause),
          ...(notification ? { notificationPool: notification } : {}),
        });
        return queryable;
      },
      notificationPool: pool,
      defaultQueue: "reports",
      ...options,
    });
    return { adapter, seen, pool };
  }

  it("builds the database queryable with the notification pool and honors the default queue", () => {
    const { adapter, seen, pool } = build();
    expect(seen).toEqual([{ executor: { name: "database" }, pool }]);
    expect(adapter.queue.defaultQueue).toBe("reports");
  });

  it("builds a transaction queryable without the pool, because that session ends", () => {
    const { adapter, seen, pool } = build();
    const transactionQueue = adapter.forTransaction({ name: "transaction" });
    expect(seen[1]).toEqual({ executor: { name: "transaction" }, pool: undefined });
    expect(transactionQueue.defaultQueue).toBe("reports");
    expect(seen[0]?.pool).toBe(pool);
  });

  it("runs provider cleanup once, however many times close is called", async () => {
    const close = vi.fn<() => void>();
    const { adapter } = build({ close });
    await Promise.all([adapter.close(), adapter.close()]);
    await adapter.close();
    expect(close).toHaveBeenCalledOnce();
  });
});
