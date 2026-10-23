import { createHash } from "node:crypto";

/** Shared with `scripts/test-database-sweep.ts`, which retires every template no worktree needs. */
export const schemaTemplatePrefix = "workhorse_test_template_";

/** A builder installs the schema under this suffix and renames the complete database. */
const schemaTemplateStagingSuffix = "_building";

export function schemaTemplateName(schema: Buffer, now = new Date()): string {
  const schemaDigest = createHash("sha256").update(schema).digest("hex").slice(0, 16);
  const utcDay = now.toISOString().slice(0, 10).replaceAll("-", "");
  return `${schemaTemplatePrefix}${schemaDigest}_${utcDay}`;
}

/**
 * The name whose advisory lock guards a template database. A staging database shares the lock of
 * the template it becomes, so the sweep cannot drop a build that is still in progress.
 */
export function schemaTemplateLockName(name: string): string {
  return name.endsWith(schemaTemplateStagingSuffix)
    ? name.slice(0, -schemaTemplateStagingSuffix.length)
    : name;
}

/** One session on the `postgres` database. Session advisory locks need the same session throughout. */
export interface SchemaTemplateSession {
  query(text: string, values?: unknown[]): Promise<{ rowCount: number | null }>;
}

export interface SchemaTemplateCopy {
  templateName: string;
  targetName: string;
  /** Drop a database by name, as the harness drops its scratch databases. */
  dropDatabase(name: string): Promise<void>;
  /** Install the schema into the empty staging database. */
  install(stagingName: string): Promise<void>;
}

/**
 * Copy the schema template into `targetName`, and build the template first if it is missing.
 *
 * The session holds a shared advisory lock on the template from the existence check until the copy
 * ends. `pnpm db:sweep` takes the exclusive lock with no wait before it drops a template, so it
 * skips a template that a copy uses. If the sweep holds the lock first, the copy waits, finds no
 * template, and builds it again. `python/tests/conftest.py` follows the same steps.
 */
export async function copySchemaTemplate(
  session: SchemaTemplateSession,
  copy: SchemaTemplateCopy,
): Promise<void> {
  const lockName = schemaTemplateLockName(copy.templateName);
  await session.query("SELECT pg_advisory_lock_shared(hashtextextended($1, 0))", [lockName]);
  try {
    if (!(await databaseExists(session, copy.templateName))) {
      await buildSchemaTemplate(session, copy, lockName);
    }
    await copy.dropDatabase(copy.targetName);
    await session.query(
      `CREATE DATABASE ${identifier(copy.targetName)} TEMPLATE ${identifier(copy.templateName)}`,
    );
  } finally {
    await session.query("SELECT pg_advisory_unlock_shared(hashtextextended($1, 0))", [lockName]);
  }
}

/**
 * Build the template under the exclusive lock. The session gives up its shared lock first, because
 * two sessions that both hold the shared lock and wait for the exclusive lock wait for each other.
 * It takes the shared lock again before it releases the exclusive lock, so no sweep can drop the
 * new template before the copy.
 */
async function buildSchemaTemplate(
  session: SchemaTemplateSession,
  copy: SchemaTemplateCopy,
  lockName: string,
): Promise<void> {
  await session.query("SELECT pg_advisory_unlock_shared(hashtextextended($1, 0))", [lockName]);
  await session.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", [lockName]);
  try {
    if (await databaseExists(session, copy.templateName)) return;
    const stagingName = `${copy.templateName}${schemaTemplateStagingSuffix}`;
    await copy.dropDatabase(stagingName);
    await session.query(`CREATE DATABASE ${identifier(stagingName)}`);
    try {
      await copy.install(stagingName);
    } catch (error) {
      await copy.dropDatabase(stagingName);
      throw error;
    }
    await session.query(
      `ALTER DATABASE ${identifier(stagingName)} RENAME TO ${identifier(copy.templateName)}`,
    );
  } finally {
    await session.query("SELECT pg_advisory_lock_shared(hashtextextended($1, 0))", [lockName]);
    await session.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [lockName]);
  }
}

async function databaseExists(session: SchemaTemplateSession, name: string): Promise<boolean> {
  const result = await session.query("SELECT 1 FROM pg_database WHERE datname = $1", [name]);
  return result.rowCount !== 0;
}

function identifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}
