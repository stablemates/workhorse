import type { QueryResult, QueryResultRow } from "pg";
import { databaseErrorCode } from "../errors.js";
import type { Queryable } from "../types.js";

/**
 * A fenced write is sent at most this many times when PostgreSQL chooses it as a deadlock victim.
 *
 * A write that settles a task fires the dependency resolver, which locks each cascade level only
 * when it reaches it. Two cascades that meet at different levels can lock the same rows in opposite
 * orders, and PostgreSQL then aborts one of them with SQLSTATE 40P01.
 *
 * The concurrency policy sync is sent through the same helper. Its prune can deadlock with a release
 * over several capped queues, and a resend writes the same complete desired set.
 */
const FENCED_WRITE_DEADLOCK_ATTEMPTS = 3;

/**
 * Send one fenced write, resending it when PostgreSQL aborts it as a deadlock victim.
 *
 * PostgreSQL rolls back the whole statement it aborts, and the fence decides the resent attempt
 * against the current row. Inside a caller-owned transaction the abort also dooms the transaction,
 * so a resend fails with 25P02. The original deadlock is the useful error then, and the caller must
 * retry the whole transaction.
 */
export async function queryFencedWrite<R extends QueryResultRow>(
  database: Queryable,
  text: string,
  values: readonly unknown[],
): Promise<QueryResult<R>> {
  let deadlock: unknown;
  for (let attempt = 1; ; attempt++) {
    try {
      return await database.query<R>(text, values);
    } catch (error) {
      const code = databaseErrorCode(error);
      if (deadlock !== undefined && code === "25P02") throw deadlock;
      if (code !== "40P01" || attempt >= FENCED_WRITE_DEADLOCK_ATTEMPTS) throw error;
      deadlock = error;
    }
  }
}
