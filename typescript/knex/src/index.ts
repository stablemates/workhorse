import {
  createProviderAdapter,
  createProviderQueryable,
  QueryError,
  type AdapterConnectionPoolSource,
  type ProviderAdapterOptions,
  type Queryable,
  type WorkhorseAdapter,
} from "@stablemates/workhorse";
import type { Knex } from "knex";
import { assertKnexExecutor, executeKnex } from "./query.js";

export type KnexExecutor = Pick<Knex, "raw" | "client">;

export interface KnexAdapterOptions extends ProviderAdapterOptions {}

export class KnexQueryError extends QueryError {
  constructor(statement: string, cause: unknown) {
    super("Knex", statement, cause);
    this.name = "KnexQueryError";
  }
}

export function knexQueryable(
  executor: KnexExecutor,
  connectionPool?: AdapterConnectionPoolSource,
): Queryable {
  assertKnexExecutor(executor);
  return createProviderQueryable({
    execute: (statement, values) => executeKnex(executor, statement, values),
    wrapError: (statement, cause) => new KnexQueryError(statement, cause),
    connectionPool,
  });
}

export function createKnexAdapter<TTransaction extends KnexExecutor = Knex.Transaction>(
  database: KnexExecutor,
  options: KnexAdapterOptions = {},
): WorkhorseAdapter<TTransaction> {
  return createProviderAdapter<KnexExecutor, TTransaction>({
    database,
    toQueryable: knexQueryable,
    ...options,
  });
}
