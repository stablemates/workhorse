import { SQL_STATEMENTS } from "../../src/queue/sql-catalogue.generated.js";

/**
 * Answers the tier read that a worker sends before it probes a queue of unknown tier. A fake
 * database returns this answer, so the worker under test claims through `claim_many_v1`, as it
 * would against a full-tier queue of a real installation. It returns `undefined` for every other
 * statement.
 */
export function fullTierRead(sql: string): { rows: Array<{ tier: "full" }> } | undefined {
  return sql === SQL_STATEMENTS.queue_tier ? { rows: [{ tier: "full" }] } : undefined;
}
