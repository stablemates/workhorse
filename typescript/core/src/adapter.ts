import type { QueryResult, QueryResultRow } from "pg";
import { Admin } from "./admin.js";
import { databaseErrorCode, WorkhorseError } from "./errors.js";
import { Queue } from "./queue.js";
import type { Queryable, QueueOptions } from "./types.js";
import { Worker } from "./worker.js";
import type { WorkerOptions } from "./worker.js";

/**
 * Stable runtime surface consumed by database providers and dedicated worker processes.
 *
 * Database providers own the conversion from their native database and transaction objects to the
 * core {@link Queryable} protocol. A worker process uses the default queue, worker construction,
 * and idempotent resource shutdown hook without depending on the provider's native types.
 */
export interface WorkhorseAdapter<TTransaction = Queryable> {
  readonly database: Queryable;
  readonly queue: Queue;
  readonly admin: Admin;
  forTransaction(transaction: TTransaction): Queue;
  adminForTransaction(transaction: TTransaction): Admin;
  createWorker(options?: WorkerOptions): Worker;
  close(): Promise<void>;
}

export interface WorkhorseAdapterOptions<TTransaction> {
  database: Queryable;
  adaptTransaction: (transaction: TTransaction) => Queryable;
  defaultQueue?: string;
  queueOptions?: QueueOptions;
  close?: () => void | Promise<void>;
}

/** Build one provider-neutral Workhorse runtime around a database adapter. */
export function createWorkhorseAdapter<TTransaction = Queryable>(
  options: WorkhorseAdapterOptions<TTransaction>,
): WorkhorseAdapter<TTransaction> {
  const queue = new Queue(options.database, options.defaultQueue, options.queueOptions);
  const admin = new Admin(options.database, options.defaultQueue, options.queueOptions);
  let closePromise: Promise<void> | undefined;

  return {
    database: options.database,
    queue,
    admin,
    forTransaction(transaction) {
      return queue.forDatabase(options.adaptTransaction(transaction));
    },
    adminForTransaction(transaction) {
      return new Admin(
        options.adaptTransaction(transaction),
        queue.defaultQueue,
        options.queueOptions,
      );
    },
    createWorker(workerOptions) {
      return new Worker(queue, workerOptions);
    },
    close() {
      closePromise ??= Promise.resolve().then(options.close ?? (() => undefined));
      return closePromise;
    },
  };
}

/**
 * A node-postgres pool an ORM adapter hands over for LISTEN connections only.
 *
 * Most ORMs cannot lend out a dedicated session, and a wake hint needs one that stays open. The
 * pool is never used for queries; it exists so notification-assisted dispatch has somewhere to
 * take a connection from, and its identity is what lets Workhorse share one listener per pool.
 */
export interface AdapterNotificationPool extends Queryable {
  connect(): Promise<unknown>;
  options?: { max?: number };
}

/** The options every ORM adapter accepts, whatever the ORM. */
export interface ProviderAdapterOptions {
  defaultQueue?: string;
  queueOptions?: QueueOptions;
  /** Optional node-postgres pool used only for dedicated LISTEN connections. */
  notificationPool?: AdapterNotificationPool;
  /**
   * Optional provider cleanup. A caller-owned database stays open by default, because an adapter
   * that closes a connection it did not create takes the application's database with it.
   */
  close?: () => void | Promise<void>;
}

/**
 * One database operation failed, named by the provider that was executing it.
 *
 * Every ORM wraps driver failures in its own error type, so the SQLSTATE Workhorse needs to
 * recognize a typed conflict arrives buried at some depth. Reading it here means each provider's
 * error answers `error.code` with the code PostgreSQL actually reported, and the whole chain is
 * still reachable through `cause` for anyone who wants the driver's own diagnostics.
 */
export class QueryError extends WorkhorseError {
  /** The SQLSTATE PostgreSQL reported, or undefined when the failure carried none. */
  readonly code: string | undefined;

  constructor(
    provider: string,
    readonly statement: string,
    cause: unknown,
  ) {
    super(`${provider} failed to execute a Workhorse database operation`, { cause });
    this.name = "QueryError";
    this.code = databaseErrorCode(cause);
  }
}

/**
 * Present rows as the node-postgres result shape the {@link Queryable} protocol is written in.
 *
 * Workhorse reads `rows` and occasionally `rowCount`, and nothing else. The remaining fields are
 * stated rather than omitted so an adapter's result is a `QueryResult` in full, instead of a
 * partial object that happens to satisfy the reads made today.
 */
export function rowsToQueryResult<TRow extends QueryResultRow>(
  rows: readonly TRow[],
): QueryResult<TRow> {
  return { command: "", rowCount: rows.length, oid: 0, fields: [], rows: [...rows] };
}

/**
 * Lend a notification pool to a queryable, so dispatch can wait on a wake hint.
 *
 * Attaching is what makes notification-assisted dispatch available; without it a worker falls
 * back to jittered polling, which is slower but equally correct. The pool object itself is the
 * sharing identity, so two queryables built from one pool share a single listener.
 */
export function attachNotificationPool(queryable: Queryable, pool: AdapterNotificationPool): void {
  const target = queryable as Queryable & {
    connect?: () => Promise<unknown>;
    notificationConnectionCapacity?: number;
    notificationConnectionIdentity?: object;
  };
  target.connect = () => pool.connect();
  target.notificationConnectionCapacity = pool.options?.max;
  target.notificationConnectionIdentity = pool;
}

export interface ProviderQueryableOptions<TRow extends QueryResultRow> {
  /** Run one statement on the provider's executor and return the rows it produced. */
  execute: (statement: string, values: readonly unknown[]) => Promise<readonly TRow[]>;
  /** Wrap a failure in the provider's own error type, which should extend {@link QueryError}. */
  wrapError: (statement: string, cause: unknown) => Error;
  notificationPool?: AdapterNotificationPool;
}

/**
 * Build the {@link Queryable} an ORM adapter exposes, given only how that ORM runs a statement.
 *
 * Two failures are deliberately not wrapped. A {@link QueryError} is already a translated database
 * failure, and wrapping it again would bury the SQLSTATE one level deeper on every retry. A
 * `RangeError` means the statement itself was malformed — a placeholder with no matching value, for
 * instance — which is the caller's mistake rather than something the database rejected, and it
 * would be misleading to report it as a database error.
 */
export function createProviderQueryable<TRow extends QueryResultRow = QueryResultRow>(
  options: ProviderQueryableOptions<TRow>,
): Queryable {
  const queryable: Queryable = {
    async query<R extends QueryResultRow = QueryResultRow>(
      statement: string,
      values: readonly unknown[] = [],
    ) {
      try {
        const rows = await options.execute(statement, values);
        if (!Array.isArray(rows)) {
          throw new TypeError(`${statement} did not return a row array`);
        }
        return rowsToQueryResult(rows) as unknown as QueryResult<R>;
      } catch (error) {
        if (error instanceof QueryError || error instanceof RangeError) throw error;
        throw options.wrapError(statement, error);
      }
    },
  };

  if (options.notificationPool) attachNotificationPool(queryable, options.notificationPool);
  return queryable;
}

export interface ProviderAdapterDefinition<TExecutor> extends ProviderAdapterOptions {
  /** The database, client, or data source the application owns. */
  database: TExecutor;
  /**
   * Convert one executor into a queryable. It is called for the database with the notification
   * pool, and again per transaction without one: a transaction is a borrowed session that ends,
   * and a listener taken from it would end with it.
   */
  toQueryable: (executor: TExecutor, notificationPool?: AdapterNotificationPool) => Queryable;
}

/**
 * Assemble the adapter an ORM package exports.
 *
 * Every provider package repeated this same wiring, differing only in which `toQueryable` it
 * passed. Owning it here means a change to how transactions or notifications are wired reaches
 * all providers at once, instead of four copies that agree until one of them is edited.
 */
export function createProviderAdapter<TExecutor, TTransaction extends TExecutor = TExecutor>(
  definition: ProviderAdapterDefinition<TExecutor>,
): WorkhorseAdapter<TTransaction> {
  const { database, toQueryable, notificationPool, ...adapterOptions } = definition;
  return createWorkhorseAdapter<TTransaction>({
    ...adapterOptions,
    database: toQueryable(database, notificationPool),
    adaptTransaction: (transaction) => toQueryable(transaction),
  });
}
