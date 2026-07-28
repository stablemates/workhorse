import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type { WorkhorseAdapter, Queryable } from "@workhorse/core";
import { createWorkhorseAdapter } from "@workhorse/core";
import type { QueryResult, QueryResultRow } from "pg";

/** Public subset shared by a node-postgres Drizzle database and its transaction object. */
export interface DrizzleExecutor {
  execute(query: SQL): PromiseLike<unknown>;
}

export interface DrizzleAdapterOptions {
  defaultQueue?: string;
  /**
   * Optional provider resource cleanup. The adapter does not close caller-owned pools by default.
   * Pass `() => db.$client.end()` only when this adapter owns that pool.
   */
  close?: () => void | Promise<void>;
}

export class DrizzleQueryError extends Error {
  readonly code: string | undefined;

  constructor(
    readonly statement: string,
    cause: unknown,
  ) {
    super("Drizzle failed to execute an Workhorse database operation", { cause });
    this.name = "DrizzleQueryError";
    this.code = databaseErrorCode(cause);
  }
}

function databaseErrorCode(error: unknown): string | undefined {
  let current = error;
  for (let depth = 0; depth < 5; depth += 1) {
    if (typeof current !== "object" || current === null) return undefined;
    if ("code" in current && typeof current.code === "string") return current.code;
    if (!("cause" in current)) return undefined;
    current = current.cause;
  }
  return undefined;
}

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

/** Convert a Drizzle database or transaction into Workhorse's minimal database protocol. */
export function drizzleQueryable(executor: DrizzleExecutor): Queryable {
  return {
    async query<R extends QueryResultRow = QueryResultRow>(text: string, values = []) {
      try {
        const result = await executor.execute(drizzleSql(text, values));
        if (typeof result !== "object" || result === null || !("rows" in result)) {
          throw new TypeError("Drizzle node-postgres execute() did not return a query result");
        }
        return result as QueryResult<R>;
      } catch (error) {
        if (error instanceof RangeError) throw error;
        throw new DrizzleQueryError(text, error);
      }
    },
  };
}

/**
 * Create an Workhorse adapter around a node-postgres Drizzle database.
 *
 * Call `adapter.forTransaction(tx)` inside `db.transaction(...)` so enqueue operations commit or
 * roll back with the caller's application writes.
 */
export function createDrizzleAdapter<TTransaction extends DrizzleExecutor = DrizzleExecutor>(
  database: DrizzleExecutor,
  options: DrizzleAdapterOptions = {},
): WorkhorseAdapter<TTransaction> {
  return createWorkhorseAdapter<TTransaction>({
    database: drizzleQueryable(database),
    adaptTransaction: drizzleQueryable,
    defaultQueue: options.defaultQueue,
    close: options.close,
  });
}
