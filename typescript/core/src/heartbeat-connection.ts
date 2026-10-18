import { connectionPoolOf, type ConnectionPool } from "./connection-pool.js";
import type { QueryResult, QueryResultRow } from "pg";
import { monotonicNow } from "./timers.js";
import type { Queryable } from "./types.js";

/**
 * The smallest pool a worker reserves a heartbeat connection from. The pool must also hold the
 * notification listener and at least one claim, or the reservation would starve dispatch.
 */
const MINIMUM_RESERVING_CAPACITY = 3;

interface ReservedClient extends Queryable {
  release(error?: Error | boolean): void;
  on?(event: "error", listener: (error: Error) => void): unknown;
  removeListener?(event: "error", listener: (error: Error) => void): unknown;
}

/**
 * Why a worker cannot hold one pooled connection for its heartbeats, or undefined when it can.
 *
 * The capacity must be known: a single node-postgres `Client` also has `connect()`, but it cannot
 * lend out a second session.
 */
export function heartbeatReservationProblem(database: Queryable): string | undefined {
  const pool = connectionPoolOf(database);
  if (pool === undefined) return "the queue's database has no connect() and no attached pool";
  const capacity = pool.options?.max;
  if (capacity === undefined) return "the pool's size is unknown";
  if (capacity < MINIMUM_RESERVING_CAPACITY) {
    return `the pool allows ${capacity} connection${capacity === 1 ? "" : "s"} and needs at least ${MINIMUM_RESERVING_CAPACITY}`;
  }
  return undefined;
}

/** Whether a worker can hold one pooled connection for its heartbeats. */
export function canReserveHeartbeatConnection(database: Queryable): boolean {
  return heartbeatReservationProblem(database) === undefined;
}

async function connectClient(pool: ConnectionPool): Promise<ReservedClient> {
  const client = await pool.connect();
  if (
    typeof client !== "object" ||
    client === null ||
    !("query" in client) ||
    !("release" in client)
  ) {
    throw new TypeError("Database connect() did not return a releasable client");
  }
  return client as ReservedClient;
}

/**
 * Sets both server timeouts for the current transaction only. `SET LOCAL` cannot take a bind
 * parameter, and `set_config(..., true)` has the same scope.
 */
const ROUND_TIMEOUTS =
  "SELECT set_config('statement_timeout', $1, true), " +
  "set_config('idle_in_transaction_session_timeout', $2, true)";

/**
 * A round with less time than this left fails before it sends its heartbeat. At this size every
 * budget of `roundTimeouts` is at least 1 ms, and the budgets still fit in the time left.
 */
const MINIMUM_REMAINING_MS = 8;

function roundExpired(): Error {
  return new Error("Heartbeat round reached its deadline");
}

/**
 * The server budgets for the rest of a round that has `remainingMs` left, in whole milliseconds.
 *
 * PostgreSQL measures `statement_timeout` for each statement and
 * `idle_in_transaction_session_timeout` for each idle gap, and restarts both every time. While the
 * round can hold a row lock, it has one idle gap before the heartbeat, the heartbeat, and one idle
 * gap before `COMMIT`. So the heartbeat gets one half, each gap one eighth, and the last quarter is
 * kept for `COMMIT`. No setting bounds `COMMIT` itself.
 */
function roundTimeouts(remainingMs: number): [statement: string, idle: string] {
  return [
    String(Math.max(1, Math.floor(remainingMs / 2))),
    String(Math.max(1, Math.floor(remainingMs / 8))),
  ];
}

/**
 * A view of `client` that sends each statement in its own transaction, with server timeouts that
 * fit in the time left before `deadline`, a `monotonicNow()` value. `expired` reports that the
 * round's client timer has fired.
 *
 * Destroying a connection does not stop its statement: PostgreSQL notices a closed client only
 * when it next writes to it. So the server must end a round that the client stopped waiting for.
 * The timeouts (`roundTimeouts`) end the heartbeat, and a transaction whose client stopped before
 * `COMMIT`, by the deadline. A `COMMIT` that PostgreSQL has already started can still finish later.
 * Both settings end with the transaction, so the connection keeps no session state.
 *
 * The view sends no command after the deadline. It rolls back a failed statement only while time is
 * left; otherwise the caller discards the connection.
 */
function boundOnServer(client: Queryable, deadline: number, expired: () => boolean): Queryable {
  const send = <R extends QueryResultRow>(text: string, values?: readonly unknown[]) => {
    // The client timer can fire a little before the clock reaches the deadline, so both count.
    if (expired() || monotonicNow() >= deadline) throw roundExpired();
    return client.query<R>(text, values);
  };
  return {
    async query<R extends QueryResultRow = QueryResultRow>(
      text: string,
      values?: readonly unknown[],
    ): Promise<QueryResult<R>> {
      await send("BEGIN");
      try {
        const setAt = monotonicNow();
        const remaining = deadline - setAt;
        if (remaining < MINIMUM_REMAINING_MS) throw roundExpired();
        await send(ROUND_TIMEOUTS, roundTimeouts(remaining));
        // The budgets fit only if the settings statement used at most the quarter kept for COMMIT.
        if (monotonicNow() - setAt > remaining / 4) throw roundExpired();
        const result = await send<R>(text, values);
        await send("COMMIT");
        // A COMMIT that ends after the deadline does not count as a renewal.
        if (expired() || monotonicNow() >= deadline) throw roundExpired();
        return result;
      } catch (error) {
        // A deadlock resend needs a clean session.
        try {
          await send("ROLLBACK");
        } catch {
          // The round reports its own error below, and the caller discards the connection.
        }
        throw error;
      }
    },
  };
}

/**
 * One pooled connection kept for heartbeats, with every round bounded in time.
 *
 * Handlers that hold every other pooled connection cannot delay a heartbeat queued behind them,
 * because the heartbeat never waits for the shared pool. One deadline bounds a whole round: the wait
 * for the rounds before it, the connect, and the transaction. A round that passes the deadline
 * destroys the connection, and server timeouts end its heartbeat and its idle waits by the same
 * deadline (`boundOnServer`). The timeouts are transaction-scoped, so the connection stays safe
 * behind a transaction-mode pooler. A failed round opens the replacement when it ends, outside the
 * deadline of the next round.
 *
 * Rounds take turns, because every worker on the pool sends its rounds here and one session runs
 * one transaction at a time.
 *
 * A connection that fails between rounds, as when PostgreSQL terminates its backend, is discarded
 * the same way. The failure changes no lease: each attempt's watchdog alone decides when one lapses.
 */
export class ReservedConnection {
  private client: Promise<ReservedClient> | undefined;
  private readonly rounds = new Set<Promise<unknown>>();
  private turn: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(private readonly pool: ConnectionPool) {}

  /** Take the connection now, ahead of any handler that could exhaust the pool. */
  reserve(): void {
    if (this.closed) return;
    void this.acquire().catch(() => undefined);
  }

  run<T>(operation: (client: Queryable) => Promise<T>, timeoutMs: number): Promise<T> {
    const round = this.runBounded(operation, timeoutMs);
    this.rounds.add(round);
    void round.then(
      () => this.rounds.delete(round),
      () => this.rounds.delete(round),
    );
    return round;
  }

  /**
   * Stop reserving and return the client to its pool once every round in flight settles.
   *
   * Each round is bounded, but a reservation's connect is not: it can wait behind an exhausted pool
   * indefinitely. Close does not wait for it, and releases a client that arrives later.
   */
  async close(): Promise<void> {
    this.closed = true;
    await Promise.allSettled(this.rounds);
    const pending = this.client;
    this.client = undefined;
    void pending?.then(
      (client) => client.release(),
      () => undefined,
    );
  }

  private acquire(): Promise<ReservedClient> {
    if (this.closed) {
      return Promise.reject(new Error("The reserved heartbeat connection is closed"));
    }
    if (this.client === undefined) {
      const pending: Promise<ReservedClient> = connectClient(this.pool).then((client) =>
        this.watch(client, pending),
      );
      this.client = pending;
      pending.catch(() => {
        if (this.client === pending) this.client = undefined;
      });
    }
    return this.client;
  }

  /**
   * Discard the client when it reports an error outside a round. A checked-out node-postgres
   * client has no error listener of its own, and an unobserved error event ends the process.
   */
  private watch(client: ReservedClient, pending: Promise<ReservedClient>): ReservedClient {
    if (client.on === undefined) return client;
    const onError = (error: Error): void => this.discard(pending, error);
    client.on("error", onError);
    const release = client.release.bind(client);
    // The listener stays until release, because the connection can still fail before then.
    client.release = (...error) => {
      release(...error);
      client.removeListener?.("error", onError);
    };
    return client;
  }

  private async runBounded<T>(
    operation: (client: Queryable) => Promise<T>,
    timeoutMs: number,
  ): Promise<T> {
    const deadline = monotonicNow() + timeoutMs;
    // The next round waits for this one and for every round before it. A round that expires while
    // it waits thus ends only its own wait: the round ahead of it keeps the connection to itself.
    const previous = this.turn;
    let finished!: () => void;
    const own = new Promise<void>((resolve) => {
      finished = resolve;
    });
    this.turn = Promise.all([previous, own]).then(() => undefined);
    let pending: Promise<ReservedClient> | undefined;
    // True once the round sends a statement on the client.
    let lent = false;
    let expired = false;
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        expired = true;
        reject(new Error(`Heartbeat did not finish within ${timeoutMs} ms`));
      }, timeoutMs);
      timer.unref();
    });
    const renewal = (async () => {
      await previous;
      // A round whose deadline passed while it waited for its turn sends nothing.
      if (expired) return timedOut;
      pending = this.acquire();
      const client = await pending;
      // A client that arrives after the deadline sends nothing; the next round takes it.
      if (expired) return timedOut;
      lent = true;
      return operation(boundOnServer(client, deadline, () => expired));
    })();
    try {
      return await Promise.race([renewal, timedOut]);
    } catch (error) {
      // A client that sent a statement has an unknown state. A connect that the round only waited
      // for is still clean, so the next round takes it.
      if (pending !== undefined && lent) this.discard(pending, error);
      // Rounds start on a fixed schedule, so the next round can start soon after this one. Opening
      // the replacement now starts the connect before that round, which waits for it only if it is
      // still pending. acquire() opens at most one connect at a time.
      this.reserve();
      throw error;
    } finally {
      clearTimeout(timer);
      // This round is done, or its connection is discarded.
      finished();
    }
  }

  private discard(pending: Promise<ReservedClient>, error: unknown): void {
    if (this.client !== pending) return;
    this.client = undefined;
    // Releasing with an error destroys the connection instead of returning it to the pool. A
    // heartbeat or an idle wait still open on it ends by its server-side timeout. A connect that
    // lands later is destroyed as well.
    void pending.then(
      (client) => client.release(error instanceof Error ? error : true),
      () => undefined,
    );
  }
}

/** One worker's hold on the heartbeat connection its pool shares. */
export interface HeartbeatConnectionLease {
  reserve(): void;
  run<T>(operation: (client: Queryable) => Promise<T>, timeoutMs: number): Promise<T>;
  close(): Promise<void>;
}

const sharedConnections = new WeakMap<
  object,
  { connection: ReservedConnection; holders: number }
>();

/**
 * Hold the heartbeat connection shared by every worker on one pool, or undefined when the pool
 * cannot lend one.
 *
 * Workers share it the way they share the notification listener, so a pool gives up one
 * connection for heartbeats however many workers run on it. The last holder to close returns it.
 */
export function holdHeartbeatConnection(database: Queryable): HeartbeatConnectionLease | undefined {
  const pool = connectionPoolOf(database);
  if (pool === undefined || heartbeatReservationProblem(database) !== undefined) return undefined;
  const identity = pool;
  let shared = sharedConnections.get(identity);
  if (shared === undefined) {
    shared = { connection: new ReservedConnection(pool), holders: 0 };
    sharedConnections.set(identity, shared);
  }
  const held = shared;
  held.holders += 1;
  let closing: Promise<void> | undefined;
  return {
    reserve: () => held.connection.reserve(),
    run: (operation, timeoutMs) => held.connection.run(operation, timeoutMs),
    close() {
      closing ??= (async () => {
        held.holders -= 1;
        if (held.holders > 0) return;
        if (sharedConnections.get(identity) === held) sharedConnections.delete(identity);
        await held.connection.close();
      })();
      return closing;
    },
  };
}
