import {
  MAXIMUM_PROTOCOL_VERSION,
  MAXIMUM_SCHEMA_VERSION,
  MINIMUM_PROTOCOL_VERSION,
  MINIMUM_SCHEMA_VERSION,
  PROTOCOL_VERSION,
  SQL_STATEMENTS,
  WORKHORSE_SCHEMA_BASELINE_VERSION,
  WORKHORSE_SCHEMA_VERSION,
} from "./queue/sql-catalogue.generated.js";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { expectOneRow } from "./errors.js";
import {
  applySchemaMigrationPlan,
  isMissingDatabaseRelationError,
  readProtocolVersions,
  readSchemaVersion,
  type SchemaMigrationStep,
} from "./schema-migrations.js";
import { assertSupportedPostgres } from "./support.js";
import type { Queryable } from "./types.js";

export {
  MAXIMUM_PROTOCOL_VERSION,
  MAXIMUM_SCHEMA_VERSION,
  MINIMUM_PROTOCOL_VERSION,
  MINIMUM_SCHEMA_VERSION,
  PROTOCOL_VERSION,
  WORKHORSE_SCHEMA_BASELINE_VERSION,
  WORKHORSE_SCHEMA_VERSION,
};

// Empty until the first public release. Version 1 is the permanent baseline, installed whole
// from sql/schema.sql; every later version arrives as one ordered, immutable step here.
const SCHEMA_MIGRATIONS: readonly SchemaMigrationStep[] = [];

function sqlAsset(relativePath: string): URL {
  const packaged = new URL(`../sql/${relativePath}`, import.meta.url);
  if (existsSync(fileURLToPath(packaged))) return packaged;
  const repositoryPath = relativePath === "schema.sql" ? "schema/current.sql" : relativePath;
  return new URL(`../../../sql/${repositoryPath}`, import.meta.url);
}

export { isMissingDatabaseRelationError, readProtocolVersions, readSchemaVersion };

/** Check compatibility without creating or changing database objects. */
export async function assertSchemaCompatible(database: Queryable): Promise<void> {
  let version: number | null;
  try {
    version = await readSchemaVersion(database);
  } catch (error) {
    throw new Error(
      isMissingDatabaseRelationError(error)
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
    throw new Error(
      isMissingDatabaseRelationError(error)
        ? "Workhorse schema is not installed. Run installSchema for a fresh database."
        : "Unable to read the Workhorse schema version before migration.",
      { cause: error },
    );
  }

  await applySchemaMigrationPlan(
    database,
    {
      baselineVersion: WORKHORSE_SCHEMA_BASELINE_VERSION,
      currentVersion: WORKHORSE_SCHEMA_VERSION,
      steps: SCHEMA_MIGRATIONS,
      readStep: async (file) => readFile(sqlAsset(`migrations/${file}`), "utf8"),
    },
    version,
  );
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
  }>(SQL_STATEMENTS["schema_installation_probe"]);
  const state = expectOneRow(existing, "the schema installation probe");
  if (state.schema_exists) {
    if (!state.version_table_exists)
      throw new Error("refusing to install into an unversioned existing workhorse schema");
    const versions = await database.query<{ version: number }>(SQL_STATEMENTS["schema_version"]);
    if (
      versions.rows.length !== 1 ||
      versions.rows[0]?.version !== WORKHORSE_SCHEMA_VERSION ||
      state.legacy_relation_exists
    )
      throw new Error(
        `refusing to treat an existing non-v${WORKHORSE_SCHEMA_VERSION} or mixed workhorse schema as a clean installation`,
      );
  }
  const schemaUrl = sqlAsset("schema.sql");
  const sql = await readFile(schemaUrl, "utf8");
  await database.query(sql);
}
