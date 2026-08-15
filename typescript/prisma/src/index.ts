import {
  createProviderAdapter,
  createProviderQueryable,
  QueryError,
  type AdapterNotificationPool,
  type ProviderAdapterOptions,
  type Queryable,
  type WorkhorseAdapter,
} from "@workhorse/core";
import type { QueryResultRow } from "pg";

/** Public subset shared by PrismaClient and Prisma.TransactionClient. */
export interface PrismaExecutor {
  $queryRawUnsafe<T = unknown>(statement: string, ...values: unknown[]): Promise<T>;
}

export interface PrismaAdapterOptions extends ProviderAdapterOptions {}

export class PrismaQueryError extends QueryError {
  constructor(statement: string, cause: unknown) {
    super("Prisma", statement, cause);
    this.name = "PrismaQueryError";
  }
}

/** Convert a Prisma client or transaction into Workhorse's minimal database protocol. */
export function prismaQueryable(
  executor: PrismaExecutor,
  notificationPool?: AdapterNotificationPool,
): Queryable {
  return createProviderQueryable({
    execute: (statement, values) =>
      executor.$queryRawUnsafe<QueryResultRow[]>(statement, ...values),
    wrapError: (statement, cause) => new PrismaQueryError(statement, cause),
    notificationPool,
  });
}

/** Create a Workhorse adapter around a Prisma client. */
export function createPrismaAdapter<TTransaction extends PrismaExecutor = PrismaExecutor>(
  database: PrismaExecutor,
  options: PrismaAdapterOptions = {},
): WorkhorseAdapter<TTransaction> {
  return createProviderAdapter<PrismaExecutor, TTransaction>({
    database,
    toQueryable: prismaQueryable,
    ...options,
  });
}
