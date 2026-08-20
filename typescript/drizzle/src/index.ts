import {
  createProviderAdapter,
  createProviderQueryable,
  QueryError,
  type AdapterNotificationPool,
  type ProviderAdapterOptions,
  type Queryable,
  type WorkhorseAdapter,
} from "@workhorse-js/core";
import type { SQL } from "drizzle-orm";
import { executeDrizzle } from "./query.js";

export interface DrizzleExecutor {
  execute(query: SQL): PromiseLike<unknown>;
  readonly $client?: AdapterNotificationPool;
}

export interface DrizzleAdapterOptions extends Omit<ProviderAdapterOptions, "notificationPool"> {}

export class DrizzleQueryError extends QueryError {
  constructor(statement: string, cause: unknown) {
    super("Drizzle", statement, cause);
    this.name = "DrizzleQueryError";
  }
}

export function drizzleQueryable(
  executor: DrizzleExecutor,
  notificationPool?: AdapterNotificationPool,
): Queryable {
  return createProviderQueryable({
    execute: (statement, values) => executeDrizzle(executor, statement, values),
    wrapError: (statement, cause) => new DrizzleQueryError(statement, cause),
    notificationPool,
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
    notificationPool: database.$client,
  });
}
