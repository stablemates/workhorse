import type { Queryable, QueueOptions, WorkhorseAdapter } from "@workhorse/core";
import { createWorkhorseAdapter } from "@workhorse/core";
import { CompiledQuery } from "kysely";
import type {
  CompiledQuery as KyselyCompiledQuery,
  QueryResult as KyselyQueryResult,
} from "kysely";
import type { QueryResult, QueryResultRow } from "pg";

/** Public subset shared by Kysely databases and transaction objects. */
export interface KyselyExecutor {
  executeQuery<R>(query: KyselyCompiledQuery<R>): Promise<KyselyQueryResult<R>>;
}

export interface KyselyAdapterOptions {
  defaultQueue?: string;
  queueOptions?: QueueOptions;
  /** Optional node-postgres pool used only for dedicated LISTEN connections. */
  notificationPool?: Queryable & {
    connect(): Promise<unknown>;
    options?: { max?: number };
  };
  /** Optional provider cleanup. Caller-owned Kysely databases remain open by default. */
  close?: () => void | Promise<void>;
}

export class KyselyQueryError extends Error {
  readonly code: string | undefined;

  constructor(
    readonly statement: string,
    cause: unknown,
  ) {
    super("Kysely failed to execute a Workhorse database operation", { cause });
    this.name = "KyselyQueryError";
    this.code = databaseErrorCode(cause);
  }
}

function databaseErrorCode(error: unknown): string | undefined {
  let current = error;
  for (let depth = 0; depth < 16; depth += 1) {
    if (typeof current !== "object" || current === null) return undefined;
    if (
      "code" in current &&
      typeof current.code === "string" &&
      /^[0-9A-Z]{5}$/.test(current.code)
    ) {
      return current.code;
    }
    current = "cause" in current ? current.cause : undefined;
  }
  return undefined;
}

/** Convert a Kysely database or transaction into Workhorse's minimal database protocol. */
export function kyselyQueryable(
  executor: KyselyExecutor,
  notificationPool?: KyselyAdapterOptions["notificationPool"],
): Queryable {
  const queryable: Queryable & {
    connect?: () => Promise<unknown>;
    notificationConnectionCapacity?: number;
    notificationConnectionIdentity?: object;
  } = {
    async query<R extends QueryResultRow = QueryResultRow>(statement: string, values = []) {
      try {
        const compiled = CompiledQuery.raw(statement, [...values]) as KyselyCompiledQuery<R>;
        const result = await executor.executeQuery(compiled);
        return {
          command: "",
          rowCount: result.rows.length,
          oid: 0,
          fields: [],
          rows: result.rows,
        } satisfies QueryResult<R>;
      } catch (error) {
        throw new KyselyQueryError(statement, error);
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

/** Create a Workhorse adapter around a Kysely database. */
export function createKyselyAdapter<TTransaction extends KyselyExecutor = KyselyExecutor>(
  database: KyselyExecutor,
  options: KyselyAdapterOptions = {},
): WorkhorseAdapter<TTransaction> {
  return createWorkhorseAdapter<TTransaction>({
    database: kyselyQueryable(database, options.notificationPool),
    adaptTransaction: kyselyQueryable,
    defaultQueue: options.defaultQueue,
    queueOptions: options.queueOptions,
    close: options.close,
  });
}
