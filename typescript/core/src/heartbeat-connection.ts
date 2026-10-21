import { AsyncLocalStorage } from "node:async_hooks";
import { connectionPoolOf, type ConnectionPool } from "./connection-pool.js";
import type { QueryResult, QueryResultRow } from "pg";
import { SQL_STATEMENTS } from "./queue/sql-catalogue.generated.js";
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
  once?(event: "end", listener: () => void): unknown;
  listeners?(event: "error"): Function[];
  removeListener?(event: "error", listener: Function): unknown;
}

/**
 * The time a worker waits at startup for its heartbeat connection and for its readiness check:
 * `max(heartbeatMs, 5 s)`. Startup owns no lease, so the interval alone is too short at small
 * intervals. The 5 s floor is a design choice (ADR 0071).
 */
export function heartbeatStartupBudgetMs(heartbeatMs: number): number {
  return Math.max(heartbeatMs, STARTUP_BUDGET_FLOOR_MS);
}

const STARTUP_BUDGET_FLOOR_MS = 5_000;

/** The first delay before a failed connect of the reservation is tried again. */
const REPLACEMENT_RETRY_BASE_MS = 100;

/** The pool and its size, as a refusal names them. */
export function describePool(database: Queryable): string {
  const capacity = connectionPoolOf(database)?.options?.max;
  return capacity === undefined
    ? "the queue's pool"
    : `the queue's pool of ${capacity} connection${capacity === 1 ? "" : "s"}`;
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
 * Keep `onError` on `client` until the client no longer needs it, and return a release that
 * removes it.
 *
 * A client that goes back to the pool hands its error events to the pool's idle listener, so the
 * listener goes with the release. A client released with an error is being destroyed, but its
 * socket can still deliver one more message. A heartbeat round that ended inside its transaction
 * leaves PostgreSQL to end that transaction, so the message is often a FATAL error such as 25P03
 * (idle-in-transaction timeout). pg-pool attaches its idle listener on every release, and on a
 * removed client that listener emits the error on the pool, where an application without a pool
 * error listener crashes. So a destroyed client drops the listeners its release added and keeps
 * `onError` until the client ends.
 */
function ownErrors(
  client: ReservedClient,
  onError: (error: Error) => void,
): (...error: [] | [Error | boolean | undefined]) => void {
  const release = client.release.bind(client);
  client.on?.("error", onError);
  return (...error) => {
    const destroyed = error[0] !== undefined && error[0] !== false;
    const before = destroyed ? new Set(client.listeners?.("error") ?? []) : undefined;
    release(...error);
    if (before === undefined) {
      client.removeListener?.("error", onError);
      return;
    }
    for (const listener of client.listeners?.("error") ?? []) {
      if (!before.has(listener)) client.removeListener?.("error", listener);
    }
    client.once?.("end", () => client.removeListener?.("error", onError));
  };
}

/** The borrow that waits for a connect, and how the connect reaches it. */
interface BorrowWaiter {
  deliver(client: ReservedClient): void;
  fail(error: unknown): void;
}

/**
 * One connect of an ordinary borrow, from its start until a borrow uses it or it goes back to the
 * pool. Each connect has its own record, and one handler decides its outcome when it settles: the
 * borrow that waits at that moment receives it, and with no such borrow the connection goes back
 * to the pool. A borrow that stops waiting either owns a connection it already received, or parks
 * a connect that has not settled. So nothing parks a settled connect, and each connect has exactly
 * one owner.
 */
interface BorrowAcquisition {
  waiter: BorrowWaiter | undefined;
  settled: boolean;
}

// The connects of the borrows on each pool whose wait ended before the connect settled. The next
// borrow takes the oldest one instead of a new connect, so repeated timeouts add no connect.
const parkedBorrows = new WeakMap<object, BorrowAcquisition[]>();

function unpark(pool: ConnectionPool, acquisition: BorrowAcquisition): void {
  const parked = parkedBorrows.get(pool);
  const index = parked?.indexOf(acquisition) ?? -1;
  if (index >= 0) parked!.splice(index, 1);
}

/** The connect for a new borrow: the oldest parked one, or a new one. */
function borrowAcquisition(pool: ConnectionPool): BorrowAcquisition {
  const taken = parkedBorrows.get(pool)?.shift();
  if (taken !== undefined) return taken;
  const acquisition: BorrowAcquisition = { waiter: undefined, settled: false };
  void connectClient(pool).then(
    (client) => {
      acquisition.settled = true;
      unpark(pool, acquisition);
      const waiter = acquisition.waiter;
      acquisition.waiter = undefined;
      if (waiter !== undefined) waiter.deliver(client);
      else ownErrors(client, () => undefined)();
    },
    (error: unknown) => {
      acquisition.settled = true;
      unpark(pool, acquisition);
      const waiter = acquisition.waiter;
      acquisition.waiter = undefined;
      waiter?.fail(error);
    },
  );
  return acquisition;
}

function parkBorrow(pool: ConnectionPool, acquisition: BorrowAcquisition): void {
  const parked = parkedBorrows.get(pool);
  if (parked === undefined) parkedBorrows.set(pool, [acquisition]);
  else parked.push(acquisition);
}

/**
 * Borrow one connection from `pool`, run `operation` on it, and return the connection at once, all
 * within `timeoutMs` and until `signal` aborts.
 *
 * A connect that arrives after the wait ended keeps one owner: the next borrow on the pool takes
 * it, or it goes back to the pool when it arrives. An operation that is still running at the
 * deadline destroys its connection, because its session state is unknown.
 *
 * Resolves with "timeout" or "aborted" when the borrow did not finish in time.
 */
async function borrowConnectionWithin<T>(
  pool: ConnectionPool,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  operation: (client: Queryable) => Promise<T>,
): Promise<{ value: T } | "timeout" | "aborted"> {
  const acquisition = borrowAcquisition(pool);
  // Set when the connect has reached this borrow. From then on, this borrow owns the connection.
  let received: ReservedClient | undefined;
  const delivered = new Promise<ReservedClient>((resolve, reject) => {
    acquisition.waiter = {
      deliver(client) {
        received = client;
        resolve(client);
      },
      fail: reject,
    };
  });
  // A failed connect after this borrow stopped waiting is not its error.
  void delivered.catch(() => undefined);
  let timer: NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;
  const stopped = new Promise<"timeout" | "aborted">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), Math.max(0, timeoutMs));
    timer.unref();
    if (signal?.aborted) resolve("aborted");
    onAbort = () => resolve("aborted");
    signal?.addEventListener("abort", onAbort, { once: true });
  });
  try {
    const arrived = await Promise.race([delivered, stopped]);
    if (typeof arrived === "string") {
      if (received !== undefined) {
        // The connect reached this borrow before its wait resumed, so this borrow returns it.
        ownErrors(received, () => undefined)();
      } else if (acquisition.waiter !== undefined) {
        acquisition.waiter = undefined;
        if (!acquisition.settled) parkBorrow(pool, acquisition);
      }
      return arrived;
    }
    const release = ownErrors(arrived, () => undefined);
    const work = operation(arrived).then((value) => ({ value }));
    let outcome: { value: T } | "timeout" | "aborted";
    try {
      outcome = await Promise.race([work, stopped]);
    } catch (error) {
      // A failed query leaves the session in an unknown state, so the connection is destroyed.
      release(error instanceof Error ? error : true);
      throw error;
    }
    if (typeof outcome === "string") {
      void work.catch(() => undefined);
      release(new Error("The borrow ended before its statement finished"));
      return outcome;
    }
    release();
    return outcome;
  } finally {
    clearTimeout(timer);
    if (onAbort !== undefined) signal?.removeEventListener("abort", onAbort);
  }
}

/** A claim statement that did not run because the heartbeat gate was closed (ADR 0071, rule 6). */
export class HeartbeatGateClosedError extends Error {
  constructor() {
    super("The claim did not run: the worker has no usable heartbeat connection");
    this.name = "HeartbeatGateClosedError";
  }
}

// The parameter that holds the claim limit of complete_many_and_claim_v1, and the one that holds
// the IDs of the tasks it completes.
const FUSED_LIMIT_PARAMETER = 5;
const FUSED_TASKS_PARAMETER = 1;

/**
 * The parameters to send for one attempt of `text`, read from the gate at that moment. A pure claim
 * does not run while the gate is closed. A fused completion that completes tasks still runs, with a
 * claim limit of zero, so it settles its tasks and claims nothing.
 */
function admitClaim(
  text: string,
  values: readonly unknown[] | undefined,
  gateOpen: () => boolean,
): readonly unknown[] | undefined {
  if (gateOpen()) return values;
  if (text !== SQL_STATEMENTS["complete_many_and_claim_v1"]) throw new HeartbeatGateClosedError();
  const completing = values?.[FUSED_TASKS_PARAMETER];
  if (!Array.isArray(completing) || completing.length === 0) throw new HeartbeatGateClosedError();
  const admitted = [...values!];
  admitted[FUSED_LIMIT_PARAMETER] = 0;
  return admitted;
}

const CLAIM_STATEMENTS = new Set<string>([
  SQL_STATEMENTS["claim_v1"],
  SQL_STATEMENTS["claim_many_v1"],
  SQL_STATEMENTS["complete_many_and_claim_v1"],
]);

// The heartbeat gate of the worker whose claim or completion runs in the current async context.
const claimGate = new AsyncLocalStorage<() => boolean>();

/**
 * Run `operation` with the heartbeat gate `gateOpen`. Each claim statement that `operation` sends,
 * also from a fused completion batch it starts, reads that gate (`claimDatabase`).
 */
export function withClaimGate<T>(gateOpen: () => boolean, operation: () => Promise<T>): Promise<T> {
  return claimGate.run(gateOpen, operation);
}

/**
 * The database a claim statement uses: `database` itself, or a gated view of it inside
 * `withClaimGate`. The queue calls this for each statement, so the methods of the queue that a
 * caller wraps or spies on still run.
 */
export function claimDatabase(database: Queryable): Queryable {
  const gateOpen = claimGate.getStore();
  return gateOpen === undefined ? database : gatedClaimDatabase(database, gateOpen);
}

/**
 * A view of `database` that reads the heartbeat gate immediately before each attempt of a claim
 * statement, a deadlock resend included. Other statements pass through unchanged.
 *
 * The gate can close while a claim waits for its connection. A node-postgres `Pool` borrows inside
 * `query()`, and an ORM adapter borrows inside its own executor, so neither lets Workhorse read the
 * gate after the borrow. So the view borrows the connection itself, from the pool the reservation
 * comes from (`connectionPoolOf`), and reads the gate after the borrow. On an adapter, the claim
 * statements of a worker with the reserved connection thus run on the adapter's attached pool.
 */
function gatedClaimDatabase(database: Queryable, gateOpen: () => boolean): Queryable {
  return {
    async query<R extends QueryResultRow = QueryResultRow>(
      text: string,
      values?: readonly unknown[],
    ): Promise<QueryResult<R>> {
      if (!CLAIM_STATEMENTS.has(text)) return database.query<R>(text, values);
      const pool = connectionPoolOf(database);
      // A worker with a gate always has a pool, because its reservation comes from that pool.
      if (pool === undefined) return database.query<R>(text, admitClaim(text, values, gateOpen));
      const client = await connectClient(pool);
      // A checked-out client has no error listener of its own, as in pg-pool's query().
      const release = ownErrors(client, () => undefined);
      let admitted: readonly unknown[] | undefined;
      try {
        admitted = admitClaim(text, values, gateOpen);
      } catch (error) {
        release();
        throw error;
      }
      try {
        const result = await client.query<R>(text, admitted);
        release();
        return result;
      } catch (error) {
        release(error instanceof Error ? error : true);
        throw error;
      }
    },
  };
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
export const MINIMUM_REMAINING_MS = 8;

function roundExpired(): Error {
  return new Error("Heartbeat round reached its deadline");
}

/**
 * A round that reached its deadline before it sent its heartbeat, with no statement in flight. It
 * sent nothing, or its ROLLBACK returned, so the connection is clean and the next round uses it.
 */
class HeartbeatRoundExpiredCleanly extends Error {
  constructor() {
    super("Heartbeat round reached its deadline before its heartbeat");
    this.name = "HeartbeatRoundExpiredCleanly";
  }
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
 * left; otherwise the caller discards the connection. If the round expires before it sends its
 * heartbeat, and nothing was sent or the ROLLBACK returns, the view rejects with
 * `HeartbeatRoundExpiredCleanly`, and the caller keeps the connection. A round that sent a
 * heartbeat statement, also one that failed before a deadlock resend, never expires cleanly.
 */
function boundOnServer(client: Queryable, deadline: number, expired: () => boolean): Queryable {
  let heartbeatSent = false;
  const expiry = (): Error => (heartbeatSent ? roundExpired() : new HeartbeatRoundExpiredCleanly());
  const send = <R extends QueryResultRow>(
    text: string,
    values?: readonly unknown[],
    heartbeat = false,
  ) => {
    // The client timer can fire a little before the clock reaches the deadline, so both count.
    if (expired() || monotonicNow() >= deadline) throw expiry();
    if (heartbeat) heartbeatSent = true;
    return client.query<R>(text, values);
  };
  return {
    async query<R extends QueryResultRow = QueryResultRow>(
      text: string,
      values?: readonly unknown[],
    ): Promise<QueryResult<R>> {
      // A round that cannot reach its heartbeat in the time left sends nothing.
      if (expired() || deadline - monotonicNow() < MINIMUM_REMAINING_MS) throw expiry();
      await send("BEGIN");
      try {
        const setAt = monotonicNow();
        const remaining = deadline - setAt;
        if (remaining < MINIMUM_REMAINING_MS) throw expiry();
        await send(ROUND_TIMEOUTS, roundTimeouts(remaining));
        // The budgets fit only if the settings statement used at most the quarter kept for COMMIT.
        if (monotonicNow() - setAt > remaining / 4) throw expiry();
        const result = await send<R>(text, values, true);
        await send("COMMIT");
        // A COMMIT that ends after the deadline does not count as a renewal.
        if (expired() || monotonicNow() >= deadline) throw roundExpired();
        return result;
      } catch (error) {
        // A deadlock resend needs a clean session.
        try {
          await send("ROLLBACK");
        } catch {
          // The round reports its own error below, and the caller discards the connection. A
          // clean expiry is clean only if its ROLLBACK returned.
          if (error instanceof HeartbeatRoundExpiredCleanly) throw roundExpired();
        }
        // A ROLLBACK that ends after the deadline did not end in the round's bound, so the caller
        // discards the connection, as every SDK does.
        if (
          error instanceof HeartbeatRoundExpiredCleanly &&
          (expired() || monotonicNow() >= deadline)
        ) {
          throw roundExpired();
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
 * deadline (`boundOnServer`). A round that expires before its heartbeat with no statement in flight
 * keeps the connection, because nothing of the round can still run on it. The timeouts are
 * transaction-scoped, so the connection stays safe behind a transaction-mode pooler. A failed round
 * opens the replacement when it ends, outside the deadline of the next round.
 *
 * Rounds take turns, because every worker on the pool sends its rounds here and one session runs
 * one transaction at a time.
 *
 * A connection that fails between rounds, as when PostgreSQL terminates its backend, is discarded
 * the same way. The failure changes no lease: each attempt's watchdog alone decides when one lapses.
 */
export class ReservedConnection {
  private client: Promise<ReservedClient> | undefined;
  // The client of `client` once it arrived, until it is discarded.
  private connected: ReservedClient | undefined;
  // True until the first connect succeeds, and again after a connect fails or the connection
  // fails between rounds. A failed round discards the connection but does not set it: a failed
  // renewal is not a loss of readiness (ADR 0071).
  private lost = true;
  private readonly readyListeners = new Set<() => void>();
  // The pending ready() waits, which close() ends with false.
  private readonly readyWaits = new Set<() => void>();
  private retryTimer: NodeJS.Timeout | undefined;
  private retryAttempt = 0;
  private readonly rounds = new Set<Promise<unknown>>();
  private turn: Promise<void> = Promise.resolve();
  private closed = false;

  /**
   * `retryCapMs` turns on readiness keeping: a lost connection is replaced at once and, after a
   * failed connect, again with a backoff capped at the returned interval, also while no round runs.
   */
  constructor(
    private readonly pool: ConnectionPool,
    private readonly retryCapMs?: () => number,
  ) {}

  /** Take the connection now, ahead of any handler that could exhaust the pool. */
  reserve(): void {
    if (this.closed) return;
    void this.acquire().catch(() => undefined);
  }

  /**
   * Whether claims can take leases that this connection renews: the connection is held, or a
   * replacement that a failed round started is still pending.
   */
  usable(): boolean {
    return (
      !this.closed && this.client !== undefined && (this.connected !== undefined || !this.lost)
    );
  }

  /** Call `listener` each time the connection becomes usable after a loss. */
  onReady(listener: () => void): () => void {
    this.readyListeners.add(listener);
    return () => this.readyListeners.delete(listener);
  }

  /**
   * Resolve true once the connection is usable, or false when `timeoutMs` passes, `signal` aborts,
   * or the reservation closes first. A connect that arrives later is still adopted.
   */
  ready(timeoutMs: number, signal?: AbortSignal): Promise<boolean> {
    if (this.usable()) return Promise.resolve(true);
    if (this.closed || signal?.aborted === true) return Promise.resolve(false);
    if (this.client === undefined) this.reserve();
    return new Promise<boolean>((resolve) => {
      const finish = (value: boolean): void => {
        clearTimeout(timer);
        this.readyListeners.delete(onReady);
        this.readyWaits.delete(onClose);
        signal?.removeEventListener("abort", onAbort);
        resolve(value);
      };
      const onReady = (): void => {
        if (this.usable()) finish(true);
      };
      const onAbort = (): void => finish(false);
      const onClose = (): void => finish(false);
      const timer = setTimeout(() => finish(this.usable()), Math.max(0, timeoutMs));
      timer.unref();
      this.readyListeners.add(onReady);
      this.readyWaits.add(onClose);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
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
   * indefinitely. Close does not wait for it. The connect stays parked: `reopen()` adopts it, and
   * otherwise the client goes back to the pool when it arrives. Thus repeated closes queue one
   * connect at most. Resolves true when nothing is parked.
   */
  async close(): Promise<boolean> {
    this.closed = true;
    clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    this.readyListeners.clear();
    for (const finish of this.readyWaits) finish();
    await Promise.allSettled(this.rounds);
    // A holder that reopened the reservation while its rounds settled keeps the connection.
    if (!this.closed) return true;
    const pending = this.client;
    if (pending === undefined) return true;
    if (this.connected !== undefined) {
      this.client = undefined;
      this.connected = undefined;
      this.lost = true;
      void pending.then(
        (client) => client.release(),
        () => undefined,
      );
      return true;
    }
    void pending.then(
      (client) => {
        if (!this.closed || this.client !== pending) return;
        this.client = undefined;
        this.connected = undefined;
        this.lost = true;
        client.release();
        this.drained?.();
      },
      () => {
        if (this.closed) this.drained?.();
      },
    );
    return false;
  }

  /** Called when a connect that close() parked settles while the reservation is still closed. */
  drained: (() => void) | undefined;

  /** Take the reservation back after close(). A parked connect becomes its connect again. */
  reopen(): void {
    this.closed = false;
    if (this.connected !== undefined) this.becameReady();
  }

  private becameReady(): void {
    const recovered = this.lost;
    this.lost = false;
    if (recovered) for (const listener of this.readyListeners) listener();
  }

  private acquire(): Promise<ReservedClient> {
    if (this.closed) {
      return Promise.reject(new Error("The reserved heartbeat connection is closed"));
    }
    if (this.client === undefined) {
      clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
      const pending: Promise<ReservedClient> = connectClient(this.pool).then((client) =>
        this.adopt(client, pending),
      );
      this.client = pending;
      pending.catch(() => {
        if (this.client !== pending) return;
        this.client = undefined;
        this.connected = undefined;
        this.lost = true;
        this.scheduleRetry();
      });
    }
    return this.client;
  }

  /**
   * Give an arrived client its one owner. While the reservation holds it, an error outside a round
   * discards it: a checked-out node-postgres client has no error listener of its own, and an
   * unobserved error event ends the process. Its release keeps the listener as `ownErrors` states.
   */
  private adopt(client: ReservedClient, pending: Promise<ReservedClient>): ReservedClient {
    if (client.on !== undefined) {
      client.release = ownErrors(client, (error) => this.discard(pending, error, true));
    }
    if (this.client !== pending) return client;
    // A connect that arrives while the reservation is closed is held for reopen() or released by
    // close(), so it is recorded either way.
    this.connected = client;
    this.retryAttempt = 0;
    if (!this.closed) this.becameReady();
    return client;
  }

  // A failed connect tries again after base × 2^n ms, capped at the interval that `retryCapMs`
  // returns. A round or `reserve()` can start the connect sooner.
  private scheduleRetry(): void {
    const capMs = this.retryCapMs?.();
    if (capMs === undefined || this.closed || this.retryTimer !== undefined) return;
    const delayMs = Math.min(capMs, REPLACEMENT_RETRY_BASE_MS * 2 ** this.retryAttempt);
    this.retryAttempt = Math.min(this.retryAttempt + 1, 30);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      if (this.client === undefined) this.reserve();
    }, delayMs);
    this.retryTimer.unref();
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
      // for is still clean, so the next round takes it. So is a client whose round expired cleanly
      // before the timer fired: no statement of the round is in flight. If the timer fires first,
      // the race rejects with its error, and the client is discarded.
      if (pending !== undefined && lent && !(error instanceof HeartbeatRoundExpiredCleanly)) {
        this.discard(pending, error);
      }
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

  /**
   * Destroy the connection of `pending`. `lost` marks a connection that failed between rounds. It
   * closes the claim gate until a replacement arrives, and with readiness keeping the replacement
   * starts at once. A failed round passes false, and opens its own replacement when it ends.
   */
  private discard(pending: Promise<ReservedClient>, error: unknown, lost = false): void {
    if (this.client !== pending) return;
    this.client = undefined;
    this.connected = undefined;
    // Releasing with an error destroys the connection instead of returning it to the pool. A
    // heartbeat or an idle wait still open on it ends by its server-side timeout. A connect that
    // lands later is destroyed as well.
    void pending.then(
      (client) => client.release(error instanceof Error ? error : true),
      () => undefined,
    );
    if (!lost) return;
    this.lost = true;
    if (this.retryCapMs !== undefined) this.reserve();
  }
}

/** One worker's hold on the heartbeat connection its pool shares. */
export interface HeartbeatConnectionLease {
  reserve(): void;
  usable(): boolean;
  ready(timeoutMs: number, signal?: AbortSignal): Promise<boolean>;
  onReady(listener: () => void): () => void;
  run<T>(operation: (client: Queryable) => Promise<T>, timeoutMs: number): Promise<T>;
  /** Borrow one ordinary connection from the same pool, as `borrowConnectionWithin` does. */
  borrow<T>(
    timeoutMs: number,
    signal: AbortSignal | undefined,
    operation: (client: Queryable) => Promise<T>,
  ): Promise<{ value: T } | "timeout" | "aborted">;
  close(): Promise<void>;
}

const sharedConnections = new WeakMap<
  object,
  { connection: ReservedConnection; holders: Map<object, number> }
>();

/**
 * Hold the heartbeat connection shared by every worker on one pool, or undefined when the pool
 * cannot lend one.
 *
 * Workers share it the way they share the notification listener, so a pool gives up one
 * connection for heartbeats however many workers run on it. The last holder to close returns it.
 * Each holder states its heartbeat interval, and the shortest interval caps the backoff of the
 * replacement connect.
 */
export function holdHeartbeatConnection(
  database: Queryable,
  heartbeatMs: number,
): HeartbeatConnectionLease | undefined {
  const pool = connectionPoolOf(database);
  if (pool === undefined || heartbeatReservationProblem(database) !== undefined) return undefined;
  const identity = pool;
  let shared = sharedConnections.get(identity);
  if (shared === undefined) {
    const holders = new Map<object, number>();
    shared = {
      connection: new ReservedConnection(pool, () => Math.min(...holders.values())),
      holders,
    };
    sharedConnections.set(identity, shared);
  }
  const held = shared;
  const holder = {};
  held.holders.set(holder, heartbeatMs);
  // The entry of a closed reservation stays while its connect is parked, so this hold adopts it.
  if (held.holders.size === 1) held.connection.reopen();
  held.connection.drained = () => {
    if (held.holders.size === 0 && sharedConnections.get(identity) === held) {
      sharedConnections.delete(identity);
    }
  };
  let closing: Promise<void> | undefined;
  return {
    reserve: () => held.connection.reserve(),
    usable: () => closing === undefined && held.connection.usable(),
    ready: (timeoutMs, signal) => held.connection.ready(timeoutMs, signal),
    onReady: (listener) => held.connection.onReady(listener),
    run: (operation, timeoutMs) => held.connection.run(operation, timeoutMs),
    borrow: (timeoutMs, signal, operation) =>
      borrowConnectionWithin(pool, timeoutMs, signal, operation),
    close() {
      closing ??= (async () => {
        held.holders.delete(holder);
        if (held.holders.size > 0) return;
        const settled = await held.connection.close();
        if (settled && held.holders.size === 0 && sharedConnections.get(identity) === held) {
          sharedConnections.delete(identity);
        }
      })();
      return closing;
    },
  };
}
