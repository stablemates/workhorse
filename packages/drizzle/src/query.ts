import { sql, type SQL } from "drizzle-orm";
import type { QueryResultRow } from "pg";
import type { DrizzleExecutor } from "./index.js";

function drizzleSql(text: string, values: readonly unknown[]): SQL {
  const chunks: Parameters<typeof sql.join>[0] = [];
  let previousIndex = 0;

  for (const match of text.matchAll(/\$(\d+)/g)) {
    const placeholder = Number(match[1]);
    if (!Number.isSafeInteger(placeholder) || placeholder < 1 || placeholder > values.length) {
      throw new RangeError(`SQL placeholder $${match[1]} has no matching value`);
    }
    chunks.push(
      sql.raw(text.slice(previousIndex, match.index)),
      sql.param(values[placeholder - 1]),
    );
    previousIndex = match.index + match[0].length;
  }

  chunks.push(sql.raw(text.slice(previousIndex)));
  return sql.join(chunks);
}

export async function executeDrizzle(
  executor: DrizzleExecutor,
  statement: string,
  values: readonly unknown[],
): Promise<readonly QueryResultRow[]> {
  const result = await executor.execute(drizzleSql(statement, values));
  if (
    typeof result !== "object" ||
    result === null ||
    !("rows" in result) ||
    !Array.isArray(result.rows)
  ) {
    throw new TypeError("Drizzle node-postgres execute() did not return a query result");
  }
  return result.rows;
}
