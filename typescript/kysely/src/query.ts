import { CompiledQuery } from "kysely";
import type { CompiledQuery as KyselyCompiledQuery } from "kysely";
import type { QueryResultRow } from "pg";
import type { KyselyExecutor } from "./index.js";

type KyselyStatement = (
  statement: string,
  values: readonly unknown[],
) => Promise<readonly QueryResultRow[]>;

/**
 * Refuse a statement after the caller commits or rolls back a `ControlledTransaction`, with the
 * error that Kysely raises. Kysely 0.29.0 to 0.29.6 give the plugin-free copy of a
 * `ControlledTransaction` its own completion state, so the copy cannot refuse it.
 */
function assertTransactionOpen(executor: KyselyExecutor): void {
  if ("isCommitted" in executor && executor.isCommitted === true) {
    throw new Error("Transaction is already committed");
  }
  if ("isRolledBack" in executor && executor.isRolledBack === true) {
    throw new Error("Transaction is already rolled back");
  }
}

/**
 * Returns the function that runs each Workhorse statement on `executor`.
 *
 * A Kysely plugin can change each result row, for example `CamelCasePlugin` renames `task_id` to
 * `taskId` and renames the keys of a JSON payload. Workhorse reads rows by their column names and
 * returns payloads as the caller wrote them, so it runs each statement on `withoutPlugins()` of the
 * executor. That copy uses the same connection and transaction. The caller's executor keeps its
 * plugins for the caller's own queries.
 */
export function kyselyStatement(executor: KyselyExecutor): KyselyStatement {
  const unplugged = executor.withoutPlugins?.() ?? executor;
  return async (statement, values) => {
    assertTransactionOpen(executor);
    const query = CompiledQuery.raw(statement, [...values]) as KyselyCompiledQuery<QueryResultRow>;
    return (await unplugged.executeQuery(query)).rows;
  };
}
