import {
  createProviderAdapter,
  createProviderQueryable,
  QueryError,
  type AdapterConnectionPool,
  type AdapterConnectionPoolSource,
  type ProviderAdapterOptions,
  type Queryable,
  type WorkhorseAdapter,
} from "@stablemates/workhorse";
import type { SQL } from "drizzle-orm";
import { executeDrizzle } from "./query.js";

export interface DrizzleExecutor {
  execute(query: SQL): PromiseLike<unknown>;
  readonly $client?: AdapterConnectionPool;
}

export interface DrizzleAdapterOptions extends Omit<ProviderAdapterOptions, "pool"> {}

export class DrizzleQueryError extends QueryError {
  constructor(statement: string, cause: unknown) {
    super("Drizzle", statement, cause);
    this.name = "DrizzleQueryError";
  }
}

export function drizzleQueryable(
  executor: DrizzleExecutor,
  connectionPool?: AdapterConnectionPoolSource,
): Queryable {
  return createProviderQueryable({
    execute: (statement, values) => executeDrizzle(executor, statement, values),
    wrapError: (statement, cause) => new DrizzleQueryError(statement, cause),
    connectionPool,
  });
}

export function createDrizzleAdapter<TTransaction extends DrizzleExecutor = DrizzleExecutor>(
  database: DrizzleExecutor,
  options: DrizzleAdapterOptions = {},
): WorkhorseAdapter<TTransaction> {
  return createProviderAdapter<DrizzleExecutor, TTransaction>({
    database,
    toQueryable: drizzleQueryable,
    ...options,
    // The node-postgres pool Drizzle runs on lends the worker its dedicated connections.
    connectionPool: database.$client,
  });
}
