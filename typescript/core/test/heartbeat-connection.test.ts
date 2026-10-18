import { setTimeout as sleep } from "node:timers/promises";
import { EventEmitter } from "node:events";
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

/** The statements a client received, in order. */
function sent(client: ReturnType<typeof fakeClient>): string[] {
  return client.query.mock.calls.map(([text]) => text);
}

const ROUND_TIMEOUTS =
  "SELECT set_config('statement_timeout', $1, true), " +
  "set_config('idle_in_transaction_session_timeout', $2, true)";

/** One statement of a round, in the transaction that bounds it on the server. */
function bounded(statement: string): string[] {
  return ["BEGIN", ROUND_TIMEOUTS, statement, "COMMIT"];
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
    expect(sent(clients[0]!)).toEqual([...bounded("SELECT 1"), ...bounded("SELECT 2")]);
    expect(clients[0]!.release).toHaveBeenCalledExactlyOnceWith();
  });

  it("rolls back a statement that fails, so the session is clean for a resend", async () => {
    const { pool, clients } = fakePool();
    const connection = new ReservedConnection(asDatabase(pool));
    const deadlock = Object.assign(new Error("deadlock detected"), { code: "40P01" });

    await expect(
      connection.run(async (client) => {
        clients[0]!.query.mockImplementation(async (text) => {
          if (text === "SELECT 1") throw deadlock;
          return emptyResult;
        });
        return client.query("SELECT 1");
      }, 250),
    ).rejects.toBe(deadlock);

    expect(sent(clients[0]!)).toEqual(["BEGIN", ROUND_TIMEOUTS, "SELECT 1", "ROLLBACK"]);
    await connection.close();
  });

  it("sets server budgets that fit in the time left, with a quarter kept for the commit", async () => {
    const { pool, clients } = fakePool();
    const connection = new ReservedConnection(asDatabase(pool));

    await connection.run((client) => client.query("SELECT 1"), 1_000);
    await connection.close();

    const [statementMs, idleMs] = (clients[0]!.query.mock.calls[1]![1] as string[]).map(Number);
    // The heartbeat and the idle gaps on each side of it, at their longest, end within 3/4 of the
    // round, which was at most 1,000 ms when the budgets were set.
    expect(statementMs! + 2 * idleMs!).toBeLessThanOrEqual(750);
    expect(statementMs).toBeGreaterThan(450);
    expect(idleMs).toBeGreaterThan(110);
  });

  it("never sets a positive budget to zero on a short round", async () => {
    const { pool, clients } = fakePool();
    const connection = new ReservedConnection(asDatabase(pool));

    await connection.run((client) => client.query("SELECT 1"), 12);
    await connection.close();

    const budgets = (clients[0]!.query.mock.calls[1]![1] as string[]).map(Number);
    expect(Math.min(...budgets)).toBeGreaterThanOrEqual(1);
  });

  it("fails before the heartbeat when the settings take longer than the commit quarter", async () => {
    const { pool, clients } = fakePool();
    const connection = new ReservedConnection(asDatabase(pool));

    const round = connection.run(async (client) => {
      clients[0]!.query.mockImplementation(async (text) => {
        if (text === ROUND_TIMEOUTS) await sleep(60);
        return emptyResult;
      });
      return client.query("SELECT 1");
    }, 200);
    await expect(round).rejects.toThrow(/deadline/);
    await connection.close();

    expect(sent(clients[0]!)).toEqual(["BEGIN", ROUND_TIMEOUTS, "ROLLBACK"]);
  });

  it("sends no command after the deadline, even when an answer arrives late", async () => {
    const { pool, clients } = fakePool();
    const connection = new ReservedConnection(asDatabase(pool));
    let answer!: () => void;
    const late = new Promise<void>((resolve) => {
      answer = resolve;
    });

    const round = connection.run(async (client) => {
      clients[0]!.query.mockImplementation(async (text) => {
        if (text === "BEGIN") await late;
        return emptyResult;
      });
      return client.query("SELECT 1");
    }, 20);
    await expect(round).rejects.toThrow(/within 20 ms/);
    answer();
    await sleep(10);
    await connection.close();

    expect(sent(clients[0]!)).toEqual(["BEGIN"]);
  });

  it("runs one round at a time, so transactions of two workers never mix", async () => {
    const { pool, clients } = fakePool();
    const database = asDatabase(pool);
    const first = holdHeartbeatConnection(database)!;
    const second = holdHeartbeatConnection(database)!;
    let answer!: () => void;
    const answered = new Promise<void>((resolve) => {
      answer = resolve;
    });

    const slow = first.run(async (client) => {
      await client.query("SELECT 1");
      await answered;
    }, 1_000);
    const next = second.run((client) => client.query("SELECT 2"), 1_000);
    await vi.waitFor(() => expect(sent(clients[0]!)).toContain("SELECT 1"));
    expect(sent(clients[0]!)).not.toContain("SELECT 2");
    answer();
    await Promise.all([slow, next]);
    await first.close();
    await second.close();

    expect(sent(clients[0]!)).toEqual([...bounded("SELECT 1"), ...bounded("SELECT 2")]);
  });

  it("counts the wait for the round before it against the deadline", async () => {
    const { pool, clients } = fakePool();
    const connection = new ReservedConnection(asDatabase(pool));

    const stuck = connection.run(() => never(), 100);
    await expect(connection.run((client) => client.query("SELECT 2"), 20)).rejects.toThrow(
      /within 20 ms/,
    );
    await expect(stuck).rejects.toThrow(/within 100 ms/);
    await connection.close();

    expect(clients.flatMap((client) => sent(client))).not.toContain("SELECT 2");
  });

  it("keeps the connection of the round ahead when a waiting round expires", async () => {
    const { pool, clients } = fakePool();
    const connection = new ReservedConnection(asDatabase(pool));
    let answer!: () => void;
    const answered = new Promise<void>((resolve) => {
      answer = resolve;
    });

    const ahead = connection.run(async (client) => {
      await client.query("SELECT 1");
      await answered;
    }, 1_000);
    await vi.waitFor(() => expect(sent(clients[0]!)).toContain("SELECT 1"));
    await expect(connection.run((client) => client.query("SELECT 2"), 20)).rejects.toThrow(
      /within 20 ms/,
    );
    // The round after the expired one still waits for the round ahead.
    const after = connection.run((client) => client.query("SELECT 3"), 1_000);
    await sleep(10);
    expect(sent(clients[0]!)).not.toContain("SELECT 3");
    answer();
    await Promise.all([ahead, after]);
    await connection.close();

    expect(clients[0]!.release).toHaveBeenCalledExactlyOnceWith();
    expect(sent(clients[0]!)).toEqual([...bounded("SELECT 1"), ...bounded("SELECT 3")]);
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
    expect(sent(clients[1]!)).toEqual(bounded("SELECT 1"));
    expect(clients[1]!.release).toHaveBeenCalledExactlyOnceWith();
  });

  it("bounds a connect that waits behind an exhausted pool and keeps the late client for the next round", async () => {
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
    // The round sent nothing on the late client, so the client stays clean. The connect continues
    // outside the deadline, and the next round takes it instead of asking the pool again.
    lend(late);
    await connection.run((client) => client.query("SELECT 1"), 1_000);

    expect(pool.connect).toHaveBeenCalledOnce();
    expect(late.release).not.toHaveBeenCalled();
    expect(late.query).toHaveBeenCalled();
    await connection.close();
  });

  it("opens the replacement when a failed round ends, before the next round", async () => {
    const first = fakeClient();
    const second = fakeClient();
    first.query.mockRejectedValue(new Error("the heartbeat failed"));
    const clients = [first, second];
    const pool = {
      options: { max: 10 },
      query: vi.fn<Queryable["query"]>(async () => emptyResult),
      connect: vi.fn<() => Promise<ReturnType<typeof fakeClient>>>(async () => clients.shift()!),
    };
    const connection = new ReservedConnection(asDatabase(pool));

    await expect(connection.run((client) => client.query("SELECT 1"), 1_000)).rejects.toThrow(
      /the heartbeat failed/,
    );
    // The failed round destroyed its client and asked for the replacement as it ended.
    expect(first.release).toHaveBeenCalledOnce();
    expect(pool.connect).toHaveBeenCalledTimes(2);
    await connection.run((client) => client.query("SELECT 1"), 1_000);
    expect(pool.connect).toHaveBeenCalledTimes(2);
    expect(second.query).toHaveBeenCalled();
    await connection.close();
  });

  it("closes without waiting for a reservation stuck behind an exhausted pool", async () => {
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
    connection.reserve();

    await connection.close();
    expect(late.release).not.toHaveBeenCalled();
    lend(late);

    await vi.waitFor(() => expect(late.release).toHaveBeenCalledExactlyOnceWith());
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

  it("destroys a client that fails between rounds and reconnects for the next round", async () => {
    const emitters: EventEmitter[] = [];
    const releases: ReturnType<typeof vi.fn<(error?: Error | boolean) => void>>[] = [];
    const pool = {
      options: { max: 10 },
      query: vi.fn<Queryable["query"]>(async () => emptyResult),
      connect: vi.fn<() => Promise<EventEmitter & ReturnType<typeof fakeClient>>>(async () => {
        const release = vi.fn<(error?: Error | boolean) => void>();
        const client = Object.assign(new EventEmitter(), { ...fakeClient(), release });
        emitters.push(client);
        releases.push(release);
        return client;
      }),
    };
    const connection = new ReservedConnection(asDatabase(pool));

    await connection.run((client) => client.query("SELECT 1"), 1_000);
    const terminated = new Error("terminating connection due to administrator command");
    // Without a listener, EventEmitter throws an unobserved error event.
    emitters[0]!.emit("error", terminated);

    await vi.waitFor(() => expect(releases[0]).toHaveBeenCalledExactlyOnceWith(terminated));
    expect(emitters[0]!.listenerCount("error")).toBe(0);
    await connection.run((client) => client.query("SELECT 2"), 1_000);
    expect(pool.connect).toHaveBeenCalledTimes(2);
    expect(emitters[1]!.listenerCount("error")).toBe(1);

    await connection.close();
    expect(releases[1]).toHaveBeenCalledExactlyOnceWith();
    expect(emitters[1]!.listenerCount("error")).toBe(0);
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
    expect(sent(clients[0]!)).toEqual([...bounded("SELECT 1"), ...bounded("SELECT 2")]);
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
