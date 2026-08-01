import { readFile } from "node:fs/promises";
import type { Queryable } from "./types.js";

/** Canonical schema version for the current pre-release line. */
export const WORKHORSE_SCHEMA_VERSION = 11;

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

export async function installSchema(database: Queryable): Promise<void> {
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
  const state = existing.rows[0]!;
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
