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
  SCHEMA_MIGRATION_LOCK_TIMEOUT_MS,
  isMissingDatabaseRelationError,
  readCompatibilityState,
  readProtocolVersions,
  readSchemaVersion,
  type CompatibilityState,
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

export {
  isMissingDatabaseRelationError,
  readProtocolVersions,
  readSchemaVersion,
  SCHEMA_MIGRATION_LOCK_TIMEOUT_MS,
};

/**
 * Check compatibility without creating or changing database objects.
 *
 * The runtime declares a floor and no ceiling. Inside a major line a migration only adds
 * ([ADR 0053](../../../docs/decisions/0053-start-migrations-at-0-1-0-and-keep-them-additive.md)),
 * so a schema newer than the one this build was compiled against still carries every function it
 * calls, and refusing it would turn every rolling deployment into an outage. The ceiling comes
 * from the database instead: `workhorse.protocol_version` lists the client protocols the installed
 * schema still answers, and a major release drops the ones it stops serving.
 */
export async function assertSchemaCompatible(database: Queryable): Promise<void> {
  let state: CompatibilityState;
  try {
    state = await readCompatibilityState(database);
  } catch (error) {
    throw new Error(
      isMissingDatabaseRelationError(error)
        ? "Workhorse schema is not installed. Run the application's explicit Workhorse schema installation step before mounting the dashboard."
        : "Unable to verify Workhorse schema compatibility because the database query failed.",
      { cause: error },
    );
  }
  if (state.schemaVersion === null) {
    throw new Error(
      "Workhorse schema version is missing or ambiguous. Reinstall the schema before starting.",
    );
  }
  if (state.schemaVersion < MINIMUM_SCHEMA_VERSION) {
    throw new Error(
      `Workhorse schema version ${state.schemaVersion} is below the minimum ${MINIMUM_SCHEMA_VERSION} this runtime requires. Migrate the database before starting this release.`,
    );
  }
  const served = state.servedProtocolVersions;
  if (served.length > 0 && !served.includes(PROTOCOL_VERSION)) {
    const oldest = Math.min(...served);
    throw new Error(
      PROTOCOL_VERSION < oldest
        ? `Workhorse schema serves SQL protocol ${served.join(", ")} and no longer serves protocol ${PROTOCOL_VERSION} this runtime speaks. Upgrade this release.`
        : `Workhorse schema serves SQL protocol ${served.join(", ")} and does not yet serve protocol ${PROTOCOL_VERSION} this runtime speaks. Migrate the database before starting this release.`,
    );
  }
}

export interface MigrateSchemaOptions {
  /**
   * Milliseconds a migration body waits for a table lock before it gives up. Defaults to
   * `SCHEMA_MIGRATION_LOCK_TIMEOUT_MS`. Waiting for another migrator is separate and unbounded.
   */
  lockTimeoutMs?: number;
}

/** Apply the immutable forward-only steps from the supported baseline to the current schema. */
export async function migrateSchema(
  database: Queryable,
  options: MigrateSchemaOptions = {},
): Promise<void> {
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
      lockTimeoutMs: options.lockTimeoutMs,
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
