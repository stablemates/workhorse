import {
  createProviderAdapter,
  createProviderQueryable,
  QueryError,
  type AdapterConnectionPoolSource,
  type ProviderAdapterOptions,
  type Queryable,
  type WorkhorseAdapter,
} from "@stablemates/workhorse";
import type { CompiledQuery, QueryResult } from "kysely";
import { executeKysely } from "./query.js";

export interface KyselyExecutor {
  executeQuery<R>(query: CompiledQuery<R>): Promise<QueryResult<R>>;
}

export interface KyselyAdapterOptions extends ProviderAdapterOptions {}

export class KyselyQueryError extends QueryError {
  constructor(statement: string, cause: unknown) {
    super("Kysely", statement, cause);
    this.name = "KyselyQueryError";
  }
}

export function kyselyQueryable(
  executor: KyselyExecutor,
  connectionPool?: AdapterConnectionPoolSource,
): Queryable {
  return createProviderQueryable({
    execute: (statement, values) => executeKysely(executor, statement, values),
    wrapError: (statement, cause) => new KyselyQueryError(statement, cause),
    connectionPool,
  });
}

export function createKyselyAdapter<TTransaction extends KyselyExecutor = KyselyExecutor>(
  database: KyselyExecutor,
  options: KyselyAdapterOptions = {},
): WorkhorseAdapter<TTransaction> {
  return createProviderAdapter<KyselyExecutor, TTransaction>({
    database,
    toQueryable: kyselyQueryable,
    ...options,
  });
}
