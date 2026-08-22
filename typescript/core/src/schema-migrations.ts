import { databaseErrorCode } from "./errors.js";
import type { Queryable } from "./types.js";

export interface SchemaMigrationStep {
  fromVersion: number;
  toVersion: number;
  file: string;
  description: string;
}

export interface SchemaMigrationPlan {
  baselineVersion: number;
  currentVersion: number;
  steps: readonly SchemaMigrationStep[];
  readStep(file: string): Promise<string>;
}

/** Advisory lock name serializing concurrent schema migrations, hashed with hashtext. */
export const SCHEMA_MIGRATION_LOCK = "workhorse:schema-migration";

/** Whether PostgreSQL reports a missing schema or a missing relation within that schema. */
export function isMissingDatabaseRelationError(error: unknown): boolean {
  const code = databaseErrorCode(error);
  return code === "3F000" || code === "42P01";
}

const transactionControl = /^\s*(?:BEGIN|COMMIT|ROLLBACK|START\s+TRANSACTION)\b/im;

export async function readSchemaVersion(database: Queryable): Promise<number | null> {
  const result = await database.query<{ version: number }>(
    "SELECT version FROM workhorse.schema_version ORDER BY version",
  );
  return result.rows.length === 1 ? (result.rows[0]?.version ?? null) : null;
}

/** SQL protocol versions the installed schema serves, or null when the relation is absent. */
export async function readProtocolVersions(database: Queryable): Promise<number[] | null> {
  try {
    const result = await database.query<{ version: number }>(
      "SELECT version FROM workhorse.protocol_version ORDER BY version",
    );
    return result.rows.map((row) => row.version);
  } catch (error) {
    if (isMissingDatabaseRelationError(error)) return null;
    throw error;
  }
}

function quoteLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/**
 * One transactional script per step: take the advisory lock, revalidate the starting version
 * behind it, run the migration body, and record the version step, atomically. The body itself
 * must not manage transactions.
 */
function migrationScript(step: SchemaMigrationStep, body: string): string {
  // Dollar-quoted bodies are data, not statements: a migration that redefines a plpgsql
  // function legitimately contains BEGIN lines inside $$…$$, and only statements outside
  // those quotes can manage the transaction.
  const statements = body.replace(/\$([A-Za-z_]\w*)?\$[\s\S]*?\$\1\$/g, "''");
  if (transactionControl.test(statements)) {
    throw new Error(
      `Workhorse migration ${step.file} must not contain transaction control statements`,
    );
  }
  return `BEGIN;
SELECT pg_advisory_xact_lock(hashtext(${quoteLiteral(SCHEMA_MIGRATION_LOCK)}));
DO $workhorse_migration$
BEGIN
  IF (SELECT count(*) FROM workhorse.schema_version) <> 1
     OR NOT EXISTS (SELECT 1 FROM workhorse.schema_version WHERE version = ${step.fromVersion}) THEN
    RAISE EXCEPTION 'workhorse schema migration to version ${step.toVersion} requires exactly version ${step.fromVersion}';
  END IF;
END
$workhorse_migration$;
${body}
UPDATE workhorse.schema_version SET version = ${step.toVersion}, installed_at = clock_timestamp() WHERE version = ${step.fromVersion};
INSERT INTO workhorse.schema_migration(version, description) VALUES (${step.toVersion}, ${quoteLiteral(step.description)});
COMMIT;`;
}

/** Run a complete, contiguous forward-only migration plan. */
export async function applySchemaMigrationPlan(
  database: Queryable,
  plan: SchemaMigrationPlan,
  installedVersion?: number | null,
): Promise<void> {
  let version =
    installedVersion === undefined ? await readSchemaVersion(database) : installedVersion;

  if (version === null) {
    throw new Error("Workhorse schema_version must contain exactly one version before migration");
  }
  if (version < plan.baselineVersion) {
    throw new Error(
      `Workhorse schema version ${version} predates the supported migration baseline ${plan.baselineVersion}`,
    );
  }
  if (version > plan.currentVersion) {
    throw new Error(
      `Workhorse schema version ${version} is newer than runtime version ${plan.currentVersion}`,
    );
  }

  while (version < plan.currentVersion) {
    const migration = plan.steps.find((candidate) => candidate.fromVersion === version);
    if (!migration) {
      throw new Error(`No Workhorse schema migration starts at version ${version}`);
    }
    const script = migrationScript(migration, await plan.readStep(migration.file));
    try {
      await database.query(script);
    } catch (error) {
      // A concurrent migrator that held the advisory lock first may have committed this exact
      // step; its result is indistinguishable from ours, so only that outcome is accepted.
      const concurrent = await readSchemaVersion(database).catch(() => null);
      if (concurrent === null || concurrent < migration.toVersion) {
        throw new Error(`Workhorse migration ${migration.file} failed and was rolled back`, {
          cause: error,
        });
      }
    }
    const migratedVersion = await readSchemaVersion(database);
    if (migratedVersion === null || migratedVersion < migration.toVersion) {
      throw new Error(
        `Workhorse migration ${migration.file} finished at version ${String(migratedVersion)} instead of ${migration.toVersion}`,
      );
    }
    version = migratedVersion;
  }
}
