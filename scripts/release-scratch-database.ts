import { readFile } from "node:fs/promises";
import path from "node:path";
import { Client } from "pg";
import { dropLocalDatabase } from "../typescript/core/src/drop-local-database.js";
import { scratchLeaseStatement } from "../typescript/core/test/support/schema-template.js";

const root = path.resolve(import.meta.dirname, "..");

/**
 * Create the scratch database `scratch` with the current schema, give `use` its URL and a client
 * on it, and drop it after `use` ends.
 *
 * A release check has no session on its scratch database while its consumer starts, so one
 * session on `postgres` holds the lease of the name from before the creation until after the drop.
 * `pnpm db:sweep` skips a scratch database under that lease. The same session creates and drops
 * the database. If the check stops or crashes, PostgreSQL ends the session and its lease, and the
 * sweep can drop the database again (SM-1702, SM-1813).
 */
export async function withReleaseScratchDatabase(
  sourceUrl: string,
  scratch: string,
  use: (scratchUrl: string, database: Client) => Promise<void>,
): Promise<void> {
  const source = decodeURIComponent(new URL(sourceUrl).pathname.slice(1));
  if (!source.includes("test")) throw new Error(`${source} is not a test database`);
  const scratchUrl = withDatabase(sourceUrl, scratch);

  const lease = new Client({ connectionString: withDatabase(sourceUrl, "postgres") });
  await lease.connect();
  try {
    await lease.query(scratchLeaseStatement, [scratch]);
    await dropLocalDatabase(lease, scratch);
    await lease.query(`CREATE DATABASE "${scratch.replaceAll('"', '""')}"`);
    try {
      const database = new Client({ connectionString: scratchUrl });
      await database.connect();
      try {
        await database.query(
          await readFile(path.join(root, "sql", "schema", "current.sql"), "utf8"),
        );
        await use(scratchUrl, database);
      } finally {
        await database.end();
      }
    } finally {
      await dropLocalDatabase(lease, scratch);
    }
  } finally {
    await lease.end();
  }
}

function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}
