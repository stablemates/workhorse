import type { Pool } from "pg";

const DEMO_AUDIT_RETENTION_DAYS = 7;
export const DEMO_AUDIT_RETENTION_ROWS_PER_PASS = 1_000;
export const DEMO_AUDIT_RETENTION_INTERVAL_MS = 60_000;

type AuditDatabase = Pick<Pool, "query">;

/** Delete one bounded batch of expired demo audit rows, oldest first. */
export async function pruneDemoAudit(database: AuditDatabase): Promise<number> {
  const result = await database.query(
    `DELETE FROM public.workhorse_demo_audit
      WHERE id IN (
        SELECT id
          FROM public.workhorse_demo_audit
         WHERE occurred_at < clock_timestamp() - ($1 * interval '1 day')
         ORDER BY occurred_at, id
         LIMIT $2
      )`,
    [DEMO_AUDIT_RETENTION_DAYS, DEMO_AUDIT_RETENTION_ROWS_PER_PASS],
  );
  return result.rowCount ?? 0;
}
