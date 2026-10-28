import { setTimeout as sleep } from "node:timers/promises";
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { QueryResult } from "pg";
import {
  canReserveHeartbeatConnection,
  holdHeartbeatConnection,
  MINIMUM_REMAINING_MS,
  ReservedConnection,
} from "../src/heartbeat-connection.js";
import { attachConnectionPool } from "../src/index.js";
import { SQL_STATEMENTS } from "../src/queue/sql-catalogue.generated.js";
import type { Queryable } from "../src/types.js";

const emptyResult: QueryResult = { command: "", rowCount: 0, oid: 0, fields: [], rows: [] };

type Respond = (text: string, values?: readonly unknown[]) => Promise<QueryResult>;

/** How the fake clients of a test answer. A test replaces `current` to change every answer. */
function responder() {
  const answer: { current: Respond } = { current: async () => emptyResult };
  return answer;
}

function fakeClient(answer = responder()) {
  return {
    query: vi.fn<Queryable["query"]>((async (text: string, values?: readonly unknown[]) =>
      answer.current(text, values)) as Queryable["query"]),
    release: vi.fn<(error?: Error | boolean) => void>(),
  };
}

function fakePool(max = 10, answer = responder()) {
  const clients: ReturnType<typeof fakeClient>[] = [];
  const pool = {
    options: { max },
    query: vi.fn<Queryable["query"]>(async () => emptyResult),
    connect: vi.fn<() => Promise<ReturnType<typeof fakeClient>>>(async () => {
      const client = fakeClient(answer);
      clients.push(client);
      return client;
    }),
  };
  return { pool, clients, answer };
}

// The mocks record calls with concrete rows, while Queryable is generic over its row type.
function asDatabase(
  database: object,
): Queryable & ConstructorParameters<typeof ReservedConnection>[0] {
  return database as Queryable & ConstructorParameters<typeof ReservedConnection>[0];
}

const HEARTBEAT = SQL_STATEMENTS["heartbeat_pool_v1"];

/** The statements a client received, in order, with each heartbeat as `HEARTBEAT`. */
function sent(client: ReturnType<typeof fakeClient>): string[] {
  return client.query.mock.calls.map(([text]) => text);
}

/** The worker IDs of the batches in each heartbeat statement that a client received. */
function heartbeats(client: ReturnType<typeof fakeClient>): string[][] {
  return client.query.mock.calls
    .filter(([text]) => text === HEARTBEAT)
    .map(([, values]) =>
      (JSON.parse((values as string[])[0]!) as Array<{ workerId: string }>).map(
        (item) => item.workerId,
      ),
    );
}

const ROUND_TIMEOUTS =
  "SELECT set_config('statement_timeout', $1, true), " +
  "set_config('idle_in_transaction_session_timeout', $2, true)";

/** One heartbeat transaction, as the server bounds it. */
const bounded = ["BEGIN", ROUND_TIMEOUTS, HEARTBEAT, "COMMIT"];

/** One batch of one lease for `workerId`. */
function batch(workerId: string, taskId = `${workerId}-task`) {
  return { workerId, leases: [{ taskId, fenceToken: "1", leaseMs: 30_000 }] };
}

/** Renew one batch of `workerId` on `connection`. */
function renew(
  connection: Pick<ReservedConnection, "renew">,
  timeoutMs: number,
  workerId = "worker-a",
) {
  return connection.renew(timeoutMs, () => [batch(workerId)]);
}

/** An answer for each heartbeat: one accepted row for each lease of each batch. */
function acceptEveryLease(values?: readonly unknown[]): QueryResult {
  const batches = JSON.parse((values as string[])[0]!) as Array<{
    leases: Array<{ taskId: string }>;
  }>;
  const rows = batches.flatMap((item, index) =>
    item.leases.map((lease) => ({ batch: index + 1, task_id: lease.taskId, status: "accepted" })),
  );
  return { ...emptyResult, rows, rowCount: rows.length };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/**
 * A monotonic clock that a test moves forward. `deadline` is the test's own estimate of the
 * round's deadline, and `shiftTo` moves the clock so that it reads `at` now.
 */
function shiftedClock() {
  const now = performance.now.bind(performance);
  let offset = 0;
  const spy = vi.spyOn(performance, "now").mockImplementation(() => now() + offset);
  return {
    deadline: Number.POSITIVE_INFINITY,
    shiftTo(at: number): void {
      offset = at - now();
    },
    restore(): void {
      spy.mockRestore();
    },
  };
}

function never(): Promise<never> {
  return new Promise<never>(() => {
    // A statement stuck behind a lock never answers.
  });
}

const deadlock = () => Object.assign(new Error("deadlock detected"), { code: "40P01" });

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

    await renew(connection, 1_000, "worker-a");
    await renew(connection, 1_000, "worker-b");
    await connection.close();

    expect(pool.connect).toHaveBeenCalledTimes(1);
    expect(pool.query).not.toHaveBeenCalled();
    expect(sent(clients[0]!)).toEqual([...bounded, ...bounded]);
    expect(heartbeats(clients[0]!)).toEqual([["worker-a"], ["worker-b"]]);
    expect(clients[0]!.release).toHaveBeenCalledExactlyOnceWith();
  });

  it("resends the whole transaction after a deadlock, with the time that remains", async () => {
    const { pool, clients, answer } = fakePool();
    const connection = new ReservedConnection(asDatabase(pool));
    let deadlocks = 1;
    answer.current = async (text, values) => {
      if (text === HEARTBEAT && deadlocks-- > 0) throw deadlock();
      return text === HEARTBEAT ? acceptEveryLease(values) : emptyResult;
    };

    await expect(renew(connection, 1_000)).resolves.toEqual([
      { batch: 1, task_id: "worker-a-task", status: "accepted" },
    ]);

    expect(sent(clients[0]!)).toEqual(["BEGIN", ROUND_TIMEOUTS, HEARTBEAT, "ROLLBACK", ...bounded]);
    // The resend succeeded on a clean session, so the connection stays.
    expect(clients[0]!.release).not.toHaveBeenCalled();
    await connection.close();
  });

  it("fails after three deadlocks and destroys the client", async () => {
    const { pool, clients, answer } = fakePool();
    const connection = new ReservedConnection(asDatabase(pool));
    answer.current = async (text) => {
      if (text === HEARTBEAT) throw deadlock();
      return emptyResult;
    };

    await expect(renew(connection, 1_000)).rejects.toMatchObject({ code: "40P01" });

    const attempt = ["BEGIN", ROUND_TIMEOUTS, HEARTBEAT, "ROLLBACK"];
    expect(sent(clients[0]!)).toEqual([...attempt, ...attempt, ...attempt]);
    expect(clients[0]!.release).toHaveBeenCalledOnce();
    expect(clients[0]!.release.mock.calls[0]![0]).toBeInstanceOf(Error);
    await connection.close();
  });

  it("sets server budgets of one quarter each, with a quarter kept for the commit", async () => {
    const { pool, clients } = fakePool();
    const connection = new ReservedConnection(asDatabase(pool));

    await renew(connection, 1_000);
    await connection.close();

    const [statementMs, idleMs] = (clients[0]!.query.mock.calls[1]![1] as string[]).map(Number);
    // The heartbeat and the idle gaps on each side of it, at their longest, end within 3/4 of the
    // round, which was at most 1,000 ms when the budgets were set.
    expect(statementMs! + 2 * idleMs!).toBeLessThanOrEqual(750);
    expect(statementMs).toBe(idleMs);
    expect(statementMs).toBeGreaterThan(200);
  });

  it("never sets a positive budget to zero on a short round", async () => {
    const { pool, clients } = fakePool();
    const connect = pool.connect.getMockImplementation()!;
    // The connect takes real time, because vitest does not fake node:timers/promises. Only the fake
    // clock and round timer count, so a stall on a loaded host does not shorten the round.
    pool.connect.mockImplementation(async () => {
      await sleep(20);
      return connect();
    });
    const connection = new ReservedConnection(asDatabase(pool));
    vi.useFakeTimers({ toFake: ["performance", "setTimeout", "clearTimeout"] });
    try {
      // The shortest round that sends its heartbeat.
      await renew(connection, MINIMUM_REMAINING_MS);
    } finally {
      vi.useRealTimers();
    }
    await connection.close();

    expect(sent(clients[0]!)).toEqual(bounded);
    const budgets = (clients[0]!.query.mock.calls[1]![1] as string[]).map(Number);
    const quarter = Math.floor(MINIMUM_REMAINING_MS / 4);
    expect(budgets).toEqual([quarter, quarter]);
    expect(Math.min(...budgets)).toBeGreaterThanOrEqual(1);
  });

  it("fails before the heartbeat when the settings take longer than the commit quarter", async () => {
    const { pool, clients, answer } = fakePool();
    const connection = new ReservedConnection(asDatabase(pool));
    answer.current = async (text) => {
      if (text === ROUND_TIMEOUTS) await sleep(60);
      return emptyResult;
    };

    await expect(renew(connection, 200)).rejects.toThrow(/deadline/);
    expect(sent(clients[0]!)).toEqual(["BEGIN", ROUND_TIMEOUTS, "ROLLBACK"]);
    // The heartbeat never went out and the ROLLBACK returned, so the next round uses the client.
    expect(clients[0]!.release).not.toHaveBeenCalled();
    answer.current = async () => emptyResult;
    await renew(connection, 1_000);
    await connection.close();

    expect(pool.connect).toHaveBeenCalledOnce();
    expect(sent(clients[0]!).slice(3)).toEqual(bounded);
    expect(clients[0]!.release).toHaveBeenCalledExactlyOnceWith();
  });

  it("keeps the connection when less than the round minimum is left after BEGIN", async () => {
    const { pool, clients, answer } = fakePool();
    const connection = new ReservedConnection(asDatabase(pool));
    const clock = shiftedClock();
    try {
      answer.current = async (text) => {
        // BEGIN answers with 5 ms of the round left.
        if (text === "BEGIN") clock.shiftTo(clock.deadline - 5);
        return emptyResult;
      };
      const round = renew(connection, 1_000);
      clock.deadline = performance.now() + 1_000;
      await expect(round).rejects.toThrow(/before its heartbeat/);
    } finally {
      clock.restore();
    }
    expect(sent(clients[0]!)).toEqual(["BEGIN", "ROLLBACK"]);
    expect(clients[0]!.release).not.toHaveBeenCalled();
    answer.current = async () => emptyResult;
    await renew(connection, 1_000);
    await connection.close();

    expect(pool.connect).toHaveBeenCalledOnce();
    expect(sent(clients[0]!).slice(2)).toEqual(bounded);
  });

  it("sends nothing and keeps the connection when less than the round minimum is left", async () => {
    const { pool, clients } = fakePool();
    const connection = new ReservedConnection(asDatabase(pool));
    await renew(connection, 1_000);
    const clock = shiftedClock();
    try {
      clock.deadline = performance.now() + 1_000;
      const round = connection.renew(1_000, () => {
        // The payload takes all but 5 ms of the round before the first statement.
        clock.shiftTo(clock.deadline - 5);
        return [batch("worker-a")];
      });
      await expect(round).rejects.toThrow(/before its heartbeat/);
    } finally {
      clock.restore();
    }
    expect(sent(clients[0]!)).toEqual(bounded);
    expect(clients[0]!.release).not.toHaveBeenCalled();
    await renew(connection, 1_000);
    await connection.close();

    expect(pool.connect).toHaveBeenCalledOnce();
    expect(sent(clients[0]!)).toEqual([...bounded, ...bounded]);
  });

  it("destroys a client whose ROLLBACK fails after the round expired before its heartbeat", async () => {
    const { pool, clients, answer } = fakePool();
    const connection = new ReservedConnection(asDatabase(pool));
    const reset = new Error("connection reset");
    answer.current = async (text) => {
      if (text === ROUND_TIMEOUTS) await sleep(60);
      if (text === "ROLLBACK") throw reset;
      return emptyResult;
    };

    await expect(renew(connection, 200)).rejects.toThrow(/reached its deadline$/);
    await connection.close();

    expect(sent(clients[0]!)).toEqual(["BEGIN", ROUND_TIMEOUTS, "ROLLBACK"]);
    expect(clients[0]!.release).toHaveBeenCalledOnce();
    expect(clients[0]!.release.mock.calls[0]![0]).toBeInstanceOf(Error);
  });

  it("destroys a client whose ROLLBACK ends after the deadline of a round that expired before its heartbeat", async () => {
    const { pool, clients, answer } = fakePool();
    const connection = new ReservedConnection(asDatabase(pool));
    const clock = shiftedClock();
    try {
      answer.current = async (text) => {
        // BEGIN answers with 5 ms of the round left, and ROLLBACK answers after the deadline.
        if (text === "BEGIN") clock.shiftTo(clock.deadline - 5);
        if (text === "ROLLBACK") clock.shiftTo(clock.deadline + 1);
        return emptyResult;
      };
      const round = renew(connection, 1_000);
      clock.deadline = performance.now() + 1_000;
      await expect(round).rejects.toThrow(/reached its deadline$/);
    } finally {
      clock.restore();
    }
    await connection.close();

    expect(sent(clients[0]!)).toEqual(["BEGIN", "ROLLBACK"]);
    expect(clients[0]!.release).toHaveBeenCalledOnce();
    expect(clients[0]!.release.mock.calls[0]![0]).toBeInstanceOf(Error);
  });

  it("destroys a client whose transaction resends after a deadlock, even before the next heartbeat", async () => {
    const { pool, clients, answer } = fakePool();
    const connection = new ReservedConnection(asDatabase(pool));
    vi.useFakeTimers({ toFake: ["performance", "setTimeout", "clearTimeout"] });
    try {
      // The fake clock moves only when the test moves it, so this is the round's own deadline.
      const deadline = performance.now() + 1_000;
      answer.current = async (text) => {
        if (text === HEARTBEAT) {
          // The resend has too little time left, but the first heartbeat statement already ran.
          vi.advanceTimersByTime(deadline - 5 - performance.now());
          throw deadlock();
        }
        return emptyResult;
      };
      await expect(renew(connection, 1_000)).rejects.toThrow(/reached its deadline$/);
    } finally {
      vi.useRealTimers();
    }
    await connection.close();

    expect(sent(clients[0]!)).toEqual(["BEGIN", ROUND_TIMEOUTS, HEARTBEAT, "ROLLBACK"]);
    expect(clients[0]!.release).toHaveBeenCalledOnce();
    expect(clients[0]!.release.mock.calls[0]![0]).toBeInstanceOf(Error);
  });

  it("sends no command after the deadline, even when an answer arrives late", async () => {
    const { pool, clients, answer } = fakePool();
    const connection = new ReservedConnection(asDatabase(pool));
    const late = deferred();
    answer.current = async (text) => {
      if (text === "BEGIN") await late.promise;
      return emptyResult;
    };

    await expect(renew(connection, 20)).rejects.toThrow(/within 20 ms/);
    late.resolve();
    await sleep(10);
    await connection.close();

    expect(sent(clients[0]!)).toEqual(["BEGIN"]);
    // BEGIN was in flight at the deadline, so the client is destroyed.
    expect(clients[0]!.release).toHaveBeenCalledOnce();
    expect(clients[0]!.release.mock.calls[0]![0]).toBeInstanceOf(Error);
  });

  it("counts the wait for the transaction before it against the deadline", async () => {
    const { pool, clients, answer } = fakePool();
    const connection = new ReservedConnection(asDatabase(pool));
    answer.current = async (text) => (text === "BEGIN" ? never() : emptyResult);

    const stuck = renew(connection, 100, "worker-a");
    await expect(renew(connection, 20, "worker-b")).rejects.toThrow(/within 20 ms/);
    await expect(stuck).rejects.toThrow(/within 100 ms/);
    await connection.close();

    expect(clients.flatMap((client) => heartbeats(client))).toEqual([]);
  });

  it("keeps the connection of the transaction ahead when a waiting round expires", async () => {
    const { pool, clients, answer } = fakePool();
    const connection = new ReservedConnection(asDatabase(pool));
    const answered = deferred();
    answer.current = async (text) => {
      if (text === HEARTBEAT && heartbeats(clients[0]!).length === 1) await answered.promise;
      return emptyResult;
    };

    const ahead = renew(connection, 1_000, "worker-a");
    await vi.waitFor(() => expect(sent(clients[0]!)).toContain(HEARTBEAT));
    await expect(renew(connection, 20, "worker-b")).rejects.toThrow(/within 20 ms/);
    // The round after the expired one still waits for the transaction ahead.
    const after = renew(connection, 1_000, "worker-c");
    await sleep(10);
    expect(heartbeats(clients[0]!)).toEqual([["worker-a"]]);
    answered.resolve();
    await Promise.all([ahead, after]);
    await connection.close();

    expect(clients[0]!.release).toHaveBeenCalledExactlyOnceWith();
    expect(sent(clients[0]!)).toEqual([...bounded, ...bounded]);
    expect(heartbeats(clients[0]!)).toEqual([["worker-a"], ["worker-c"]]);
  });

  it("destroys a client whose round outlives the timeout and reconnects for the next round", async () => {
    const { pool, clients, answer } = fakePool();
    const connection = new ReservedConnection(asDatabase(pool));
    answer.current = async (text) => (text === HEARTBEAT ? never() : emptyResult);

    await expect(renew(connection, 20)).rejects.toThrow(/within 20 ms/);
    await vi.waitFor(() => expect(clients[0]!.release).toHaveBeenCalledOnce());
    expect(clients[0]!.release.mock.calls[0]![0]).toBeInstanceOf(Error);

    answer.current = async () => emptyResult;
    await renew(connection, 1_000);
    await connection.close();

    expect(pool.connect).toHaveBeenCalledTimes(2);
    expect(sent(clients[1]!)).toEqual(bounded);
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

    await expect(renew(connection, 20)).rejects.toThrow(/within 20 ms/);
    // The round sent nothing on the late client, so the client stays clean. The connect continues
    // outside the deadline, and the next round takes it instead of asking the pool again.
    lend(late);
    await renew(connection, 1_000);

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

    await expect(renew(connection, 1_000)).rejects.toThrow(/the heartbeat failed/);
    // The failed round destroyed its client and asked for the replacement as it ended.
    expect(first.release).toHaveBeenCalledOnce();
    expect(pool.connect).toHaveBeenCalledTimes(2);
    await renew(connection, 1_000);
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

  it("destroys a client whose heartbeat failed", async () => {
    const { pool, clients, answer } = fakePool();
    const connection = new ReservedConnection(asDatabase(pool));
    const failure = new Error("connection reset");
    answer.current = async (text) => {
      if (text === HEARTBEAT) throw failure;
      return emptyResult;
    };

    await expect(renew(connection, 1_000)).rejects.toBe(failure);
    await vi.waitFor(() => expect(clients[0]!.release).toHaveBeenCalledExactlyOnceWith(failure));

    answer.current = async () => emptyResult;
    await renew(connection, 1_000);
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

    await renew(connection, 1_000);
    const terminated = new Error("terminating connection due to administrator command");
    // Without a listener, EventEmitter throws an unobserved error event.
    emitters[0]!.emit("error", terminated);

    await vi.waitFor(() => expect(releases[0]).toHaveBeenCalledExactlyOnceWith(terminated));
    // A destroyed client can still deliver an error before it ends, so the listener stays.
    expect(() => emitters[0]!.emit("error", new Error("late FATAL"))).not.toThrow();
    emitters[0]!.emit("end");
    expect(emitters[0]!.listenerCount("error")).toBe(0);
    await renew(connection, 1_000);
    expect(pool.connect).toHaveBeenCalledTimes(2);
    expect(emitters[1]!.listenerCount("error")).toBe(1);

    await connection.close();
    expect(releases[1]).toHaveBeenCalledExactlyOnceWith();
    expect(emitters[1]!.listenerCount("error")).toBe(0);
  });

  it("waits for a round in flight before returning the client on close", async () => {
    const { pool, clients, answer } = fakePool();
    const connection = new ReservedConnection(asDatabase(pool));
    const finish = deferred();
    answer.current = async (text) => {
      if (text === HEARTBEAT) await finish.promise;
      return emptyResult;
    };
    const round = renew(connection, 1_000);
    await vi.waitFor(() => expect(sent(clients[0]!)).toContain(HEARTBEAT));

    const closing = connection.close();
    await Promise.resolve();
    expect(clients[0]!.release).not.toHaveBeenCalled();
    finish.resolve();
    await round;
    await closing;

    expect(clients[0]!.release).toHaveBeenCalledExactlyOnceWith();
    await expect(renew(connection, 1_000)).rejects.toThrow(/closed/);
  });
});

describe("heartbeat transactions shared by rounds", () => {
  it("renews the rounds of every worker that waits in one transaction, and routes each row back", async () => {
    const { pool, clients, answer } = fakePool();
    const database = asDatabase(pool);
    const first = holdHeartbeatConnection(database, 1_000)!;
    const second = holdHeartbeatConnection(database, 1_000)!;
    const begun = deferred();
    answer.current = async (text, values) => {
      if (text === "BEGIN") await begun.promise;
      return text === HEARTBEAT ? acceptEveryLease(values) : emptyResult;
    };

    const leading = first.renew(1_000, () => [batch("worker-a", "a-1"), batch("worker-a", "a-2")]);
    // This round arrives after the leader started its transaction, and joins it.
    await vi.waitFor(() => expect(sent(clients[0]!)).toContain("BEGIN"));
    const joining = second.renew(2_000, () => [batch("worker-b", "b-1")]);
    begun.resolve();

    await expect(leading).resolves.toEqual([
      { batch: 1, task_id: "a-1", status: "accepted" },
      { batch: 2, task_id: "a-2", status: "accepted" },
    ]);
    await expect(joining).resolves.toEqual([{ batch: 1, task_id: "b-1", status: "accepted" }]);
    await first.close();
    await second.close();

    expect(sent(clients[0]!)).toEqual(bounded);
    expect(heartbeats(clients[0]!)).toEqual([["worker-a", "worker-a", "worker-b"]]);
  });

  it("lets a round that arrives after the heartbeat went out lead the next transaction", async () => {
    const { pool, clients, answer } = fakePool();
    const connection = new ReservedConnection(asDatabase(pool));
    const answered = deferred();
    answer.current = async (text) => {
      if (text === HEARTBEAT && heartbeats(clients[0]!).length === 1) await answered.promise;
      return emptyResult;
    };

    const ahead = renew(connection, 1_000, "worker-a");
    await vi.waitFor(() => expect(sent(clients[0]!)).toContain(HEARTBEAT));
    const next = renew(connection, 1_000, "worker-b");
    await sleep(10);
    expect(heartbeats(clients[0]!)).toEqual([["worker-a"]]);
    answered.resolve();
    await Promise.all([ahead, next]);
    await connection.close();

    expect(sent(clients[0]!)).toEqual([...bounded, ...bounded]);
    expect(heartbeats(clients[0]!)).toEqual([["worker-a"], ["worker-b"]]);
  });

  it("does not take a round whose deadline is earlier than the leader's, and lets it lead next", async () => {
    const { pool, clients, answer } = fakePool();
    const connection = new ReservedConnection(asDatabase(pool));
    const begun = deferred();
    answer.current = async (text) => {
      if (text === "BEGIN" && heartbeats(clients[0]!).length === 0) await begun.promise;
      return emptyResult;
    };

    const leader = renew(connection, 1_000, "worker-a");
    await vi.waitFor(() => expect(sent(clients[0]!)).toContain("BEGIN"));
    const earlier = renew(connection, 500, "worker-b");
    const later = renew(connection, 2_000, "worker-c");
    const laterStill = renew(connection, 3_000, "worker-d");
    begun.resolve();
    await Promise.all([leader, earlier, later, laterStill]);
    await connection.close();

    expect(heartbeats(clients[0]!)).toEqual([["worker-a", "worker-c", "worker-d"], ["worker-b"]]);
  });

  it("gives the leader's failure to every round of the transaction", async () => {
    const { pool, clients, answer } = fakePool();
    const connection = new ReservedConnection(asDatabase(pool));
    const settings = deferred();
    const failure = new Error("connection reset");
    answer.current = async (text) => {
      if (text === "BEGIN") await settings.promise;
      if (text === HEARTBEAT) throw failure;
      return emptyResult;
    };

    const leader = renew(connection, 1_000, "worker-a");
    await vi.waitFor(() => expect(sent(clients[0]!)).toContain("BEGIN"));
    const member = renew(connection, 2_000, "worker-b");
    settings.resolve();

    await expect(leader).rejects.toBe(failure);
    await expect(member).rejects.toBe(failure);
    expect(heartbeats(clients[0]!)).toEqual([["worker-a", "worker-b"]]);
    expect(clients[0]!.release).toHaveBeenCalledExactlyOnceWith(failure);
    await connection.close();
  });

  it("ends every round of the transaction at the leader's deadline", async () => {
    const { pool, clients, answer } = fakePool();
    const connection = new ReservedConnection(asDatabase(pool));
    const settings = deferred();
    answer.current = async (text) => {
      if (text === "BEGIN") await settings.promise;
      return text === HEARTBEAT ? never() : emptyResult;
    };

    const leader = renew(connection, 300, "worker-a");
    await vi.waitFor(() => expect(sent(clients[0]!)).toContain("BEGIN"));
    const member = renew(connection, 2_000, "worker-b");
    settings.resolve();

    await expect(leader).rejects.toThrow(/within 300 ms/);
    await expect(member).rejects.toThrow(/within 300 ms/);
    expect(heartbeats(clients[0]!)).toEqual([["worker-a", "worker-b"]]);
    await vi.waitFor(() => expect(clients[0]!.release).toHaveBeenCalledOnce());
    expect(clients[0]!.release.mock.calls[0]![0]).toBeInstanceOf(Error);
    await connection.close();
  });

  it("resends a deadlocked transaction for every round that joined it", async () => {
    const { pool, clients, answer } = fakePool();
    const connection = new ReservedConnection(asDatabase(pool));
    const settings = deferred();
    let deadlocks = 1;
    answer.current = async (text, values) => {
      if (text === "BEGIN") await settings.promise;
      if (text === HEARTBEAT && deadlocks-- > 0) throw deadlock();
      return text === HEARTBEAT ? acceptEveryLease(values) : emptyResult;
    };

    const leader = renew(connection, 1_000, "worker-a");
    await vi.waitFor(() => expect(sent(clients[0]!)).toContain("BEGIN"));
    const member = renew(connection, 2_000, "worker-b");
    settings.resolve();

    await expect(leader).resolves.toHaveLength(1);
    await expect(member).resolves.toEqual([
      { batch: 1, task_id: "worker-b-task", status: "accepted" },
    ]);
    expect(heartbeats(clients[0]!)).toEqual([
      ["worker-a", "worker-b"],
      ["worker-a", "worker-b"],
    ]);
    await connection.close();
  });
});

/** A pool whose connects wait until the test resolves them. */
function stalledPool() {
  const arrivals: Array<(client: ReturnType<typeof fakeClient>) => void> = [];
  const pool = {
    options: { max: 10 },
    query: vi.fn<Queryable["query"]>(async () => emptyResult),
    connect: vi.fn<() => Promise<ReturnType<typeof fakeClient>>>(
      () =>
        new Promise((resolve) => {
          arrivals.push(resolve);
        }),
    ),
  };
  return { pool, arrivals };
}

describe("late heartbeat connects", () => {
  it("adopts a replacement that arrives while the last holder closes and a new holder reopens", async () => {
    const { pool, arrivals } = stalledPool();
    const connection = new ReservedConnection(asDatabase(pool), () => 100);
    const ready = connection.ready(1_000);
    const answer = responder();
    const heartbeat = deferred();
    answer.current = async (text) => {
      if (text === HEARTBEAT) await heartbeat.promise;
      return emptyResult;
    };
    const first = Object.assign(new EventEmitter(), fakeClient(answer));
    arrivals[0]!(first);
    await expect(ready).resolves.toBe(true);
    // A round is in flight, then the connection fails between statements.
    const finishRound = heartbeat.resolve;
    const round = renew(connection, 1_000);
    await vi.waitFor(() => expect(sent(first)).toContain(HEARTBEAT));
    first.emit("error", new Error("terminating connection due to administrator command"));
    await vi.waitFor(() => expect(arrivals).toHaveLength(2));

    const closing = connection.close();
    arrivals[1]!(fakeClient());
    // The replacement arrives while close() waits for the round.
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(connection.usable()).toBe(false);
    connection.reopen();
    finishRound();
    await round;

    await expect(closing).resolves.toBe(true);
    expect(connection.usable()).toBe(true);
    await expect(connection.ready(10)).resolves.toBe(true);
    expect(pool.connect).toHaveBeenCalledTimes(2);
    await connection.close();
  });

  it("queues one connect however often a hold waits, times out, and closes", async () => {
    const { pool, arrivals } = stalledPool();
    const database = asDatabase(pool);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const hold = holdHeartbeatConnection(database, 100)!;
      await expect(hold.ready(10)).resolves.toBe(false);
      await hold.close();
    }
    expect(pool.connect).toHaveBeenCalledTimes(1);

    // The parked connect goes back to the pool when it arrives without a holder.
    const client = fakeClient();
    arrivals[0]!(client);
    await vi.waitFor(() => expect(client.release).toHaveBeenCalledExactlyOnceWith());
  });

  it("lets the next hold adopt a parked connect", async () => {
    const { pool, arrivals } = stalledPool();
    const database = asDatabase(pool);
    const first = holdHeartbeatConnection(database, 100)!;
    await expect(first.ready(10)).resolves.toBe(false);
    await first.close();
    const second = holdHeartbeatConnection(database, 100)!;
    const ready = second.ready(1_000);
    const client = fakeClient();
    arrivals[0]!(client);

    await expect(ready).resolves.toBe(true);
    expect(pool.connect).toHaveBeenCalledTimes(1);
    expect(client.release).not.toHaveBeenCalled();
    await second.close();
    expect(client.release).toHaveBeenCalledExactlyOnceWith();
  });

  it("queues one ordinary connect however often a borrow times out", async () => {
    const { pool, arrivals } = stalledPool();
    const hold = holdHeartbeatConnection(asDatabase(pool), 100)!;
    pool.connect.mockClear();
    const operation = vi.fn<() => Promise<string>>(async () => "checked");
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expect(hold.borrow(10, undefined, operation)).resolves.toBe("timeout");
    }
    expect(pool.connect).toHaveBeenCalledTimes(1);

    const borrowing = hold.borrow(1_000, undefined, operation);
    const ordinary = fakeClient();
    arrivals.at(-1)!(ordinary);
    await expect(borrowing).resolves.toEqual({ value: "checked" });
    expect(ordinary.release).toHaveBeenCalledExactlyOnceWith();
    await hold.close();
  });

  it("destroys the borrowed connection when its statement outlives the budget", async () => {
    const { pool } = fakePool();
    const hold = holdHeartbeatConnection(asDatabase(pool), 100)!;
    const stalled = hold.borrow(20, undefined, () => never());

    await expect(stalled).resolves.toBe("timeout");
    const borrowed = pool.connect.mock.results.at(-1)!.value as Promise<
      ReturnType<typeof fakeClient>
    >;
    expect((await borrowed).release).toHaveBeenCalledExactlyOnceWith(expect.any(Error));
    await hold.close();
  });
});

describe("shared heartbeat connection", () => {
  it("lends one connection to every worker on a pool and returns it with the last holder", async () => {
    const { pool, clients } = fakePool();
    const database = asDatabase(pool);
    const first = holdHeartbeatConnection(database, 1_000)!;
    const second = holdHeartbeatConnection(database, 1_000)!;

    await renew(first, 1_000, "worker-a");
    await renew(second, 1_000, "worker-b");
    await first.close();
    await first.close();
    expect(clients[0]!.release).not.toHaveBeenCalled();
    await second.close();

    expect(pool.connect).toHaveBeenCalledOnce();
    expect(sent(clients[0]!)).toEqual([...bounded, ...bounded]);
    expect(clients[0]!.release).toHaveBeenCalledExactlyOnceWith();

    const next = holdHeartbeatConnection(database, 1_000)!;
    await renew(next, 1_000);
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
    const first = holdHeartbeatConnection(adapterQueryable(), 1_000)!;
    const second = holdHeartbeatConnection(adapterQueryable(), 1_000)!;

    await renew(first, 1_000, "worker-a");
    await renew(second, 1_000, "worker-b");
    await Promise.all([first.close(), second.close()]);

    expect(pool.connect).toHaveBeenCalledOnce();
  });

  it("lends nothing from a pool that cannot reserve", () => {
    expect(holdHeartbeatConnection(asDatabase(fakePool(2).pool), 1_000)).toBeUndefined();
  });
});
