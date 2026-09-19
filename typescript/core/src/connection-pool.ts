import type { Queryable } from "./types.js";

/** A pool a worker takes its dedicated listener and heartbeat connections from. */
export interface ConnectionPool {
  connect(): Promise<unknown>;
  options?: { max?: number };
}

/**
 * A pool, or a function that finds one when a worker first needs it. An adapter whose ORM creates
 * its pool on initialization resolves it lazily, so the adapter can exist before the ORM connects.
 * Whatever the function returns counts as a pool only if it has `connect()`.
 */
export type ConnectionPoolSource = ConnectionPool | (() => unknown);

const attachedPool = Symbol("workhorse.connection-pool");

type PoolCarrier = Queryable & { [attachedPool]?: ConnectionPoolSource };

function asPool(value: unknown): ConnectionPool | undefined {
  return typeof (value as Partial<ConnectionPool> | null | undefined)?.connect === "function"
    ? (value as ConnectionPool)
    : undefined;
}

/** Give a queryable that cannot lend connections itself a pool to lend them from. */
export function attachPool(queryable: Queryable, source: ConnectionPoolSource): void {
  (queryable as PoolCarrier)[attachedPool] = source;
}

/**
 * The pool a database lends dedicated connections from: an attached pool, else the database itself
 * when it has `connect()`, as a node-postgres `Pool` does. The pool object is also the identity
 * that workers share one listener and one heartbeat connection by.
 */
export function connectionPoolOf(database: Queryable): ConnectionPool | undefined {
  const source = (database as PoolCarrier)[attachedPool];
  if (source !== undefined) return asPool(typeof source === "function" ? source() : source);
  return asPool(database);
}
