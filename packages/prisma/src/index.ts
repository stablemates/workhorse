import type { Queryable, QueueOptions, WorkhorseAdapter } from "@workhorse/core";
import { createWorkhorseAdapter } from "@workhorse/core";
import type { QueryResult, QueryResultRow } from "pg";

/** Public subset shared by PrismaClient and Prisma.TransactionClient. */
export interface PrismaExecutor {
  $queryRawUnsafe<T = unknown>(statement: string, ...values: unknown[]): Promise<T>;
}

export interface PrismaAdapterOptions {
  defaultQueue?: string;
  queueOptions?: QueueOptions;
  /** Optional node-postgres pool used only for dedicated LISTEN connections. */
  notificationPool?: Queryable & {
    connect(): Promise<unknown>;
    options?: { max?: number };
  };
  /** Optional provider cleanup. Caller-owned Prisma clients remain open by default. */
  close?: () => void | Promise<void>;
}

export class PrismaQueryError extends Error {
  readonly code: string | undefined;

  constructor(
    readonly statement: string,
    cause: unknown,
  ) {
    super("Prisma failed to execute a Workhorse database operation", { cause });
    this.name = "PrismaQueryError";
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
  let prismaCode: string | undefined;

  for (let depth = 0; pending.length > 0 && depth < 16; depth += 1) {
    const current = pending.shift();
    if (typeof current !== "object" || current === null || seen.has(current)) continue;
    seen.add(current);
    const code = nestedObject(current, "code");
    const meta = nestedObject(current, "meta");
    if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) {
      // Prisma wraps raw driver failures in P2010. Its metadata retains the SQLSTATE that core
      // needs to recognize Workhorse's typed conflicts, so prefer a nested code when one exists.
      if (/^P\d{4}$/.test(code) && meta !== undefined) prismaCode ??= code;
      else return code;
    }
    pending.push(meta, nestedObject(current, "cause"));
  }
  return prismaCode;
}

/** Convert a Prisma client or transaction into Workhorse's minimal database protocol. */
export function prismaQueryable(
  executor: PrismaExecutor,
  notificationPool?: PrismaAdapterOptions["notificationPool"],
): Queryable {
  const queryable: Queryable & {
    connect?: () => Promise<unknown>;
    notificationConnectionCapacity?: number;
    notificationConnectionIdentity?: object;
  } = {
    async query<R extends QueryResultRow = QueryResultRow>(statement: string, values = []) {
      try {
        const rows = await executor.$queryRawUnsafe<R[]>(statement, ...values);
        if (!Array.isArray(rows)) {
          throw new TypeError("Prisma $queryRawUnsafe() did not return a row array");
        }
        return {
          command: "",
          rowCount: rows.length,
          oid: 0,
          fields: [],
          rows,
        } satisfies QueryResult<R>;
      } catch (error) {
        throw new PrismaQueryError(statement, error);
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

/** Create a Workhorse adapter around a Prisma client. */
export function createPrismaAdapter<TTransaction extends PrismaExecutor = PrismaExecutor>(
  database: PrismaExecutor,
  options: PrismaAdapterOptions = {},
): WorkhorseAdapter<TTransaction> {
  return createWorkhorseAdapter<TTransaction>({
    database: prismaQueryable(database, options.notificationPool),
    adaptTransaction: prismaQueryable,
    defaultQueue: options.defaultQueue,
    queueOptions: options.queueOptions,
    close: options.close,
  });
}
