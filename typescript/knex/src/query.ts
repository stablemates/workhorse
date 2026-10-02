import type { Knex } from "knex";
import type { QueryResultRow } from "pg";
import type { KnexExecutor } from "./index.js";

export function assertKnexExecutor(executor: KnexExecutor): void {
  const config = executor.client.config as Knex.Config;
  if (config.client !== "pg" || config.postProcessResponse !== undefined) {
    throw new TypeError("Workhorse Knex requires client: pg without postProcessResponse");
  }
}

export async function executeKnex(
  executor: KnexExecutor,
  statement: string,
  values: readonly unknown[],
): Promise<readonly QueryResultRow[]> {
  assertKnexExecutor(executor);
  const result: unknown = await executor
    .raw(statement)
    .options({ text: statement, values: [...values] });
  if (
    result === null ||
    typeof result !== "object" ||
    !("rows" in result) ||
    !Array.isArray(result.rows) ||
    result.rows.some(
      (row: unknown) => row === null || typeof row !== "object" || Array.isArray(row),
    )
  ) {
    throw new TypeError("Workhorse Knex requires one node-postgres result with object rows");
  }
  return result.rows as QueryResultRow[];
}
