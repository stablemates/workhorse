import { setTimeout as sleep } from "node:timers/promises";
import { databaseErrorCode } from "./errors.js";

const databaseObjectInUseCode = "55006";

/** The one method repository tooling needs from a `pg` pool or client connected to `postgres`. */
export interface DatabaseDropAdmin {
  query(text: string, values?: unknown[]): Promise<{ rows: unknown[] }>;
}

export interface DropLocalDatabaseOptions {
  /**
   * Drop attempts before giving up. PostgreSQL itself waits a few seconds inside each attempt for
   * other sessions to exit, so the bound is a count rather than a deadline: a deadline could expire
   * inside the first attempt, before this role's own sessions were ever terminated.
   */
  attempts?: number;
  /** Pause between drop attempts, which lets terminated and foreign sessions exit. */
  retryMs?: number;
}

/**
 * Drop a repository-owned database without `WITH (FORCE)`.
 *
 * FORCE makes PostgreSQL signal every session on the database, and a role that is not a superuser
 * may not signal a session owned by another role. Autovacuum workers are such sessions, so a FORCE
 * drop fails whenever one happens to be vacuuming the target. A plain drop asks autovacuum to exit
 * without that permission check. This helper terminates only the sessions the caller's own role
 * owns, then retries the plain drop until foreign sessions finish or the attempts run out.
 */
export async function dropLocalDatabase(
  admin: DatabaseDropAdmin,
  name: string,
  options: DropLocalDatabaseOptions = {},
): Promise<void> {
  const attempts = options.attempts ?? 10;
  const retryMs = options.retryMs ?? 100;
  for (let attempt = 1; ; attempt++) {
    try {
      await admin.query(`DROP DATABASE IF EXISTS ${identifier(name)}`);
      return;
    } catch (error) {
      if (databaseErrorCode(error) !== databaseObjectInUseCode) throw error;
      if (attempt >= attempts) throw await sessionsStillAttached(admin, name, attempts, error);
    }

    await admin.query(
      `SELECT pg_terminate_backend(pid)
         FROM pg_stat_activity
        WHERE datname = $1
          AND usename = current_user
          AND pid <> pg_backend_pid()`,
      [name],
    );
    await sleep(retryMs);
  }
}

async function sessionsStillAttached(
  admin: DatabaseDropAdmin,
  name: string,
  attempts: number,
  cause: unknown,
): Promise<Error> {
  const sessions = await admin.query(
    `SELECT pid, usename, backend_type, application_name
       FROM pg_stat_activity
      WHERE datname = $1
        AND pid <> pg_backend_pid()
      ORDER BY pid`,
    [name],
  );
  const described = (sessions.rows as SessionRow[])
    .map(
      (row) =>
        `pid ${row.pid} (${row.backend_type ?? "unknown backend"}, role ${row.usename ?? "none"}` +
        `${row.application_name ? `, application ${row.application_name}` : ""})`,
    )
    .join("; ");
  return new Error(
    `Could not drop ${name}: other sessions kept it in use through ${attempts} attempts` +
      (described ? `: ${described}` : ""),
    { cause },
  );
}

interface SessionRow {
  pid: number;
  usename: string | null;
  backend_type: string | null;
  application_name: string | null;
}

function identifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}
