import {
  createProviderAdapter,
  createProviderQueryable,
  QueryError,
  type AdapterConnectionPoolSource,
  type ProviderAdapterOptions,
  type Queryable,
  type WorkhorseAdapter,
} from "@stablemates/workhorse";
import type { QueryResultRow } from "pg";

/** Public subset shared by TypeORM DataSource and transactional EntityManager objects. */
export interface TypeOrmExecutor {
  query<T = unknown>(statement: string, values?: unknown[]): Promise<T>;
}

export interface TypeOrmAdapterOptions extends Omit<ProviderAdapterOptions, "pool"> {}

export class TypeOrmQueryError extends QueryError {
  constructor(statement: string, cause: unknown) {
    super("TypeORM", statement, cause);
    this.name = "TypeOrmQueryError";
  }
}

/** Convert a TypeORM data source or entity manager into Workhorse's database protocol. */
export function typeOrmQueryable(
  executor: TypeOrmExecutor,
  connectionPool?: AdapterConnectionPoolSource,
): Queryable {
  return createProviderQueryable({
    execute: (statement, values) => executor.query<QueryResultRow[]>(statement, [...values]),
    wrapError: (statement, cause) => new TypeOrmQueryError(statement, cause),
    connectionPool,
  });
}

/** Create a Workhorse adapter around a TypeORM data source. */
export function createTypeOrmAdapter<TTransaction extends TypeOrmExecutor = TypeOrmExecutor>(
  database: TypeOrmExecutor,
  options: TypeOrmAdapterOptions = {},
): WorkhorseAdapter<TTransaction> {
  return createProviderAdapter<TypeOrmExecutor, TTransaction>({
    database,
    toQueryable: typeOrmQueryable,
    ...options,
    // PostgresDriver creates its node-postgres pool as driver.master when the data source initializes.
    connectionPool: () => (database as { driver?: { master?: unknown } }).driver?.master,
  });
}
