import type { Queryable, QueueOptions, WorkhorseAdapter } from "@workhorse/core";
import { createWorkhorseAdapter } from "@workhorse/core";
import type { QueryResult, QueryResultRow } from "pg";

/** Public subset shared by TypeORM DataSource and transactional EntityManager objects. */
export interface TypeOrmExecutor {
  query<T = unknown>(statement: string, values?: unknown[]): Promise<T>;
}

export interface TypeOrmAdapterOptions {
  defaultQueue?: string;
  queueOptions?: QueueOptions;
  /** Optional node-postgres pool used only for dedicated LISTEN connections. */
  notificationPool?: Queryable & {
    connect(): Promise<unknown>;
    options?: { max?: number };
  };
  /** Optional provider cleanup. Caller-owned data sources remain open by default. */
  close?: () => void | Promise<void>;
}

export class TypeOrmQueryError extends Error {
  readonly code: string | undefined;

  constructor(
    readonly statement: string,
    cause: unknown,
  ) {
    super("TypeORM failed to execute a Workhorse database operation", { cause });
    this.name = "TypeOrmQueryError";
    this.code = databaseErrorCode(cause);
  }
}

function nestedObject(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null && key in value
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

function databaseErrorCode(error: unknown): string | undefined {
  const pending = [error];
  const seen = new Set<object>();

  for (let depth = 0; pending.length > 0 && depth < 16; depth += 1) {
    const current = pending.shift();
    if (typeof current !== "object" || current === null || seen.has(current)) continue;
    seen.add(current);
    const code = nestedObject(current, "code");
    if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) return code;
    pending.push(nestedObject(current, "driverError"), nestedObject(current, "cause"));
  }
  return undefined;
}

/** Convert a TypeORM data source or entity manager into Workhorse's database protocol. */
export function typeOrmQueryable(
  executor: TypeOrmExecutor,
  notificationPool?: TypeOrmAdapterOptions["notificationPool"],
): Queryable {
  const queryable: Queryable & {
    connect?: () => Promise<unknown>;
    notificationConnectionCapacity?: number;
    notificationConnectionIdentity?: object;
  } = {
    async query<R extends QueryResultRow = QueryResultRow>(statement: string, values = []) {
      try {
        const rows = await executor.query<R[]>(statement, [...values]);
        if (!Array.isArray(rows)) {
          throw new TypeError("TypeORM query() did not return a row array");
        }
        return {
          command: "",
          rowCount: rows.length,
          oid: 0,
          fields: [],
          rows,
        } satisfies QueryResult<R>;
      } catch (error) {
        throw new TypeOrmQueryError(statement, error);
      }
    },
  };

  if (notificationPool) {
    queryable.connect = () => notificationPool.connect();
    queryable.notificationConnectionCapacity = notificationPool.options?.max;
    queryable.notificationConnectionIdentity = notificationPool;
  }
  return queryable;
}

/** Create a Workhorse adapter around a TypeORM data source. */
export function createTypeOrmAdapter<TTransaction extends TypeOrmExecutor = TypeOrmExecutor>(
  database: TypeOrmExecutor,
  options: TypeOrmAdapterOptions = {},
): WorkhorseAdapter<TTransaction> {
  return createWorkhorseAdapter<TTransaction>({
    database: typeOrmQueryable(database, options.notificationPool),
    adaptTransaction: typeOrmQueryable,
    defaultQueue: options.defaultQueue,
    queueOptions: options.queueOptions,
    close: options.close,
  });
}
