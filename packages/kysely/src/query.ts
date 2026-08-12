import { CompiledQuery } from "kysely";
import type { CompiledQuery as KyselyCompiledQuery } from "kysely";
import type { QueryResultRow } from "pg";
import type { KyselyExecutor } from "./index.js";

export async function executeKysely(
  executor: KyselyExecutor,
  statement: string,
  values: readonly unknown[],
): Promise<readonly QueryResultRow[]> {
  const query = CompiledQuery.raw(statement, [...values]) as KyselyCompiledQuery<QueryResultRow>;
  return (await executor.executeQuery(query)).rows;
}
