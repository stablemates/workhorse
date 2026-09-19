import { describe, expect, it, vi } from "vitest";
import type { QueryResult } from "pg";
import {
  canReserveHeartbeatConnection,
  holdHeartbeatConnection,
  ReservedConnection,
} from "../src/heartbeat-connection.js";
import { attachConnectionPool } from "../src/index.js";
import type { Queryable } from "../src/types.js";

const emptyResult: QueryResult = { command: "", rowCount: 0, oid: 0, fields: [], rows: [] };

function fakeClient() {
  return {
    query: vi.fn<Queryable["query"]>(async () => emptyResult),
    release: vi.fn<(error?: Error | boolean) => void>(),
  };
}

function fakePool(max = 10) {
  const clients: ReturnType<typeof fakeClient>[] = [];
  const pool = {
    options: { max },
    query: vi.fn<Queryable["query"]>(async () => emptyResult),
    connect: vi.fn<() => Promise<ReturnType<typeof fakeClient>>>(async () => {
      const client = fakeClient();
      clients.push(client);
      return client;
    }),
  };
  return { pool, clients };
}

// The mocks record calls with concrete rows, while Queryable is generic over its row type.
function asDatabase(
  database: object,
): Queryable & ConstructorParameters<typeof ReservedConnection>[0] {
  return database as Queryable & ConstructorParameters<typeof ReservedConnection>[0];
}

function never(): Promise<never> {
  return new Promise<never>(() => {
    // A statement stuck behind a lock never answers.
  });
}

describe("reserved heartbeat connection", () => {
  it("reserves only from a pool with room for a listener, the heartbeat, and a claim", () => {
    expect(canReserveHeartbeatConnection(asDatabase(fakePool(10).pool))).toBe(true);
    expect(canReserveHeartbeatConnection(asDatabase(fakePool(3).pool))).toBe(true);
    expect(canReserveHeartbeatConnection(asDatabase(fakePool(2).pool))).toBe(false);
    // A single pg Client can connect() but cannot lend a second session.
    const { pool } = fakePool();
    expect(
      canReserveHeartbeatConnection(asDatabase({ query: pool.query, connect: pool.connect })),
    ).toBe(false);
    expect(canReserveHeartbeatConnection(asDatabase({ query: pool.query }))).toBe(false);
  });

  it("runs every round on one reserved client and returns it on close", async () => {
    const { pool, clients } = fakePool();
    const connection = new ReservedConnection(asDatabase(pool));

    await connection.run((client) => client.query("SELECT 1"), 1_000);
    await connection.run((client) => client.query("SELECT 2"), 1_000);
    await connection.close();

    expect(pool.connect).toHaveBeenCalledTimes(1);
    expect(pool.query).not.toHaveBeenCalled();
    expect(clients[0]!.query).toHaveBeenCalledTimes(2);
    expect(clients[0]!.release).toHaveBeenCalledExactlyOnceWith();
  });

  it("destroys a client whose round outlives the timeout and reconnects for the next round", async () => {
    const { pool, clients } = fakePool();
    const connection = new ReservedConnection(asDatabase(pool));

    await expect(connection.run(() => never(), 20)).rejects.toThrow(/within 20 ms/);
    await vi.waitFor(() => expect(clients[0]!.release).toHaveBeenCalledOnce());
    expect(clients[0]!.release.mock.calls[0]![0]).toBeInstanceOf(Error);

    await connection.run((client) => client.query("SELECT 1"), 1_000);
    await connection.close();

    expect(pool.connect).toHaveBeenCalledTimes(2);
    expect(clients[1]!.query).toHaveBeenCalledOnce();
    expect(clients[1]!.release).toHaveBeenCalledExactlyOnceWith();
  });

  it("bounds a connect that waits behind an exhausted pool and releases the late client", async () => {
    let lend!: (client: ReturnType<typeof fakeClient>) => void;
    const late = fakeClient();
    const pool = {
      options: { max: 10 },
      query: vi.fn<Queryable["query"]>(async () => emptyResult),
      connect: vi.fn<() => Promise<ReturnType<typeof fakeClient>>>(
        () =>
          new Promise<ReturnType<typeof fakeClient>>((resolve) => {
            lend = resolve;
          }),
      ),
    };
    const connection = new ReservedConnection(asDatabase(pool));

    await expect(connection.run((client) => client.query("SELECT 1"), 20)).rejects.toThrow(
      /within 20 ms/,
    );
    lend(late);

    await vi.waitFor(() => expect(late.release).toHaveBeenCalledOnce());
    expect(late.query).not.toHaveBeenCalled();
  });

  it("destroys a client whose statement failed", async () => {
    const { pool, clients } = fakePool();
    const connection = new ReservedConnection(asDatabase(pool));
    const failure = new Error("connection reset");

    await expect(
      connection.run(async () => {
        throw failure;
      }, 1_000),
    ).rejects.toBe(failure);
    await vi.waitFor(() => expect(clients[0]!.release).toHaveBeenCalledExactlyOnceWith(failure));

    await connection.run((client) => client.query("SELECT 1"), 1_000);
    expect(pool.connect).toHaveBeenCalledTimes(2);
    await connection.close();
  });

  it("waits for a round in flight before returning the client on close", async () => {
    const { pool, clients } = fakePool();
    const connection = new ReservedConnection(asDatabase(pool));
    let finish!: () => void;
    const round = connection.run(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
      1_000,
    );
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));

    const closing = connection.close();
    await Promise.resolve();
    expect(clients[0]!.release).not.toHaveBeenCalled();
    finish();
    await round;
    await closing;

    expect(clients[0]!.release).toHaveBeenCalledExactlyOnceWith();
    await expect(connection.run((client) => client.query("SELECT 1"), 1_000)).rejects.toThrow(
      /closed/,
    );
  });
});

describe("shared heartbeat connection", () => {
  it("lends one connection to every worker on a pool and returns it with the last holder", async () => {
    const { pool, clients } = fakePool();
    const database = asDatabase(pool);
    const first = holdHeartbeatConnection(database)!;
    const second = holdHeartbeatConnection(database)!;

    await first.run((client) => client.query("SELECT 1"), 1_000);
    await second.run((client) => client.query("SELECT 2"), 1_000);
    await first.close();
    await first.close();
    expect(clients[0]!.release).not.toHaveBeenCalled();
    await second.close();

    expect(pool.connect).toHaveBeenCalledOnce();
    expect(clients[0]!.query).toHaveBeenCalledTimes(2);
    expect(clients[0]!.release).toHaveBeenCalledExactlyOnceWith();

    const next = holdHeartbeatConnection(database)!;
    await next.run((client) => client.query("SELECT 3"), 1_000);
    await next.close();
    expect(pool.connect).toHaveBeenCalledTimes(2);
  });

  it("shares by pool, so two adapter queryables on one pool hold one connection", async () => {
    const { pool } = fakePool();
    const adapterQueryable = (): Queryable => {
      const queryable = asDatabase({ query: pool.query });
      attachConnectionPool(queryable, asDatabase(pool));
      return queryable;
    };
    const first = holdHeartbeatConnection(adapterQueryable())!;
    const second = holdHeartbeatConnection(adapterQueryable())!;

    await first.run((client) => client.query("SELECT 1"), 1_000);
    await second.run((client) => client.query("SELECT 2"), 1_000);
    await Promise.all([first.close(), second.close()]);

    expect(pool.connect).toHaveBeenCalledOnce();
  });

  it("lends nothing from a pool that cannot reserve", () => {
    expect(holdHeartbeatConnection(asDatabase(fakePool(2).pool))).toBeUndefined();
  });
});
