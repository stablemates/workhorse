import type { Queryable } from "./types.js";

/**
 * The smallest pool a worker reserves a heartbeat connection from. The pool must also hold the
 * notification listener and at least one claim, or the reservation would starve dispatch.
 */
const MINIMUM_RESERVING_CAPACITY = 3;

type ReservableDatabase = Queryable & {
  connect: () => Promise<unknown>;
  notificationConnectionCapacity?: number;
  notificationConnectionIdentity?: object;
  options?: { max?: number };
};

interface ReservedClient extends Queryable {
  release(error?: Error | boolean): void;
}

/**
 * Whether a worker can hold one pooled connection for its heartbeats.
 *
 * The capacity must be known: a single node-postgres `Client` also has `connect()`, but it cannot
 * lend out a second session.
 */
export function canReserveHeartbeatConnection(database: Queryable): database is ReservableDatabase {
  const candidate = database as Partial<ReservableDatabase>;
  const capacity = candidate.notificationConnectionCapacity ?? candidate.options?.max;
  return (
    typeof candidate.connect === "function" &&
    capacity !== undefined &&
    capacity >= MINIMUM_RESERVING_CAPACITY
  );
}

async function connectClient(database: ReservableDatabase): Promise<ReservedClient> {
  const client = await database.connect();
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
 */
export class ReservedConnection {
  private client: Promise<ReservedClient> | undefined;
  private readonly rounds = new Set<Promise<unknown>>();
  private closed = false;

  constructor(private readonly database: ReservableDatabase) {}

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
      const pending = connectClient(this.database);
      this.client = pending;
      pending.catch(() => {
        if (this.client === pending) this.client = undefined;
      });
    }
    return this.client;
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
  if (!canReserveHeartbeatConnection(database)) return undefined;
  const identity = database.notificationConnectionIdentity ?? database;
  let shared = sharedConnections.get(identity);
  if (shared === undefined) {
    shared = { connection: new ReservedConnection(database), holders: 0 };
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
