import { connectionPoolOf, type ConnectionPool } from "./connection-pool.js";
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
 * One pooled connection kept for heartbeats, with every round bounded in time.
 *
 * Handlers that hold every other pooled connection cannot delay a heartbeat queued behind them,
 * because the heartbeat never waits for the shared pool. A round that outlives its bound destroys
 * the connection, which is the client-side cancel: no session setting is involved, so the
 * connection stays safe behind a transaction-mode pooler. The next round reconnects.
 *
 * A connection that fails between rounds, as when PostgreSQL terminates its backend, is discarded
 * the same way. The failure changes no lease: each attempt's watchdog alone decides when one lapses.
 */
export class ReservedConnection {
  private client: Promise<ReservedClient> | undefined;
  private readonly rounds = new Set<Promise<unknown>>();
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

  /** Stop reserving and return the client to its pool once every round in flight settles. */
  async close(): Promise<void> {
    this.closed = true;
    await Promise.allSettled(this.rounds);
    const pending = this.client;
    this.client = undefined;
    const client = await pending?.catch(() => undefined);
    client?.release();
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
    const pending = this.acquire();
    let expired = false;
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        expired = true;
        reject(new Error(`Heartbeat did not finish within ${timeoutMs} ms`));
      }, timeoutMs);
      timer.unref();
    });
    // A client lent after the bound passed is only destroyed; its renewal would arrive too late.
    const renewal = pending.then((client) => (expired ? timedOut : operation(client)));
    try {
      return await Promise.race([renewal, timedOut]);
    } catch (error) {
      this.discard(pending, error);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  private discard(pending: Promise<ReservedClient>, error: unknown): void {
    if (this.client !== pending) return;
    this.client = undefined;
    // Releasing with an error destroys the connection instead of returning it to the pool, which
    // also ends a statement still running on it. A connect that lands later is destroyed as well.
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
