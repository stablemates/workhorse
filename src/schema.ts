import { readFile } from "node:fs/promises";
import { expectOneRow } from "./errors.js";
import { assertSupportedPostgres } from "./support.js";
import type { Queryable } from "./types.js";

/** Oldest schema version covered by the forward-only migration chain. */
export const WORKHORSE_SCHEMA_BASELINE_VERSION = 23;

/** Canonical schema version for the current pre-release line. */
export const WORKHORSE_SCHEMA_VERSION = 24;

const SCHEMA_MIGRATIONS = [
  {
    fromVersion: 23,
    toVersion: 24,
    file: "0024-add-schema-migration-ledger.sql",
  },
] as const;

export async function readSchemaVersion(database: Queryable): Promise<number | null> {
  const result = await database.query<{ version: number }>(
    "SELECT version FROM workhorse.schema_version ORDER BY version",
  );
  return result.rows.length === 1 ? (result.rows[0]?.version ?? null) : null;
}

/** Check compatibility without creating or changing database objects. */
export async function assertSchemaCompatible(database: Queryable): Promise<void> {
  let version: number | null;
  try {
    version = await readSchemaVersion(database);
  } catch (error) {
    const code =
      error && typeof error === "object" && "code" in error ? String(error.code) : undefined;
    throw new Error(
      code === "42P01" || code === "3F000"
        ? "Workhorse schema is not installed. Run the application's explicit Workhorse schema installation step before mounting the dashboard."
        : "Unable to verify Workhorse schema compatibility because the database query failed.",
      { cause: error },
    );
  }
  if (version !== WORKHORSE_SCHEMA_VERSION) {
    throw new Error(
      `Workhorse schema version ${String(version)} is incompatible with runtime version ${WORKHORSE_SCHEMA_VERSION}`,
    );
  }
}

/** Apply the immutable forward-only steps from the supported baseline to the current schema. */
export async function migrateSchema(database: Queryable): Promise<void> {
  await assertSupportedPostgres(database);

  let version: number | null;
  try {
    version = await readSchemaVersion(database);
  } catch (error) {
    const code =
      error && typeof error === "object" && "code" in error ? String(error.code) : undefined;
    throw new Error(
      code === "42P01" || code === "3F000"
        ? "Workhorse schema is not installed. Run installSchema for a fresh database."
        : "Unable to read the Workhorse schema version before migration.",
      { cause: error },
    );
  }

  if (version === null) {
    throw new Error("Workhorse schema_version must contain exactly one version before migration");
  }
  if (version < WORKHORSE_SCHEMA_BASELINE_VERSION) {
    throw new Error(
      `Workhorse schema version ${version} predates the supported migration baseline ${WORKHORSE_SCHEMA_BASELINE_VERSION}`,
    );
  }
  if (version > WORKHORSE_SCHEMA_VERSION) {
    throw new Error(
      `Workhorse schema version ${version} is newer than runtime version ${WORKHORSE_SCHEMA_VERSION}`,
    );
  }

  while (version < WORKHORSE_SCHEMA_VERSION) {
    const migration = SCHEMA_MIGRATIONS.find((candidate) => candidate.fromVersion === version);
    if (!migration) {
      throw new Error(`No Workhorse schema migration starts at version ${version}`);
    }
    const sql = await readFile(
      new URL(`../sql/migrations/${migration.file}`, import.meta.url),
      "utf8",
    );
    await database.query(sql);
    const migratedVersion = await readSchemaVersion(database);
    if (migratedVersion !== migration.toVersion) {
      throw new Error(
        `Workhorse migration ${migration.file} finished at version ${String(migratedVersion)} instead of ${migration.toVersion}`,
      );
    }
    version = migratedVersion;
  }
}

export async function installSchema(database: Queryable): Promise<void> {
  // An unsupported server must fail here, with its own version in the message, rather than part
  // way through executing schema.sql.
  await assertSupportedPostgres(database);
  // Validation uses a canonical clean-database schema rather than incremental migrations.
  // Production callers must not treat this as a safe upgrade mechanism for an existing schema.
  const existing = await database.query<{
    schema_exists: boolean;
    version_table_exists: boolean;
    legacy_relation_exists: boolean;
  }>(`
    SELECT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'workhorse') AS schema_exists,
           to_regclass('workhorse.schema_version') IS NOT NULL AS version_table_exists,
           EXISTS (
             SELECT 1
               FROM unnest(ARRAY['job_current', 'ready_job', 'scheduled_job', 'lease'])
                 AS legacy(relation_name)
              WHERE to_regclass(format('workhorse.%I', relation_name)) IS NOT NULL
           ) AS legacy_relation_exists`);
  const state = expectOneRow(existing, "the schema installation probe");
  if (state.schema_exists) {
    if (!state.version_table_exists)
      throw new Error("refusing to install into an unversioned existing workhorse schema");
    const versions = await database.query<{ version: number }>(
      "SELECT version FROM workhorse.schema_version ORDER BY version",
    );
    if (
      versions.rows.length !== 1 ||
      versions.rows[0]?.version !== WORKHORSE_SCHEMA_VERSION ||
      state.legacy_relation_exists
    )
      throw new Error(
        `refusing to treat an existing non-v${WORKHORSE_SCHEMA_VERSION} or mixed workhorse schema as a clean installation`,
      );
  }
  const schemaUrl = new URL("../sql/schema.sql", import.meta.url);
  const sql = await readFile(schemaUrl, "utf8");
  await database.query(sql);
}
