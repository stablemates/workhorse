import { readFile } from "node:fs/promises";
import type { Queryable } from "./types.js";

export async function installSchema(database: Queryable): Promise<void> {
  // Validation uses a canonical clean-database schema rather than incremental migrations.
  // Production callers must not treat this as a safe upgrade mechanism for an existing schema.
  const existing = await database.query<{
    schema_exists: boolean;
    version_table_exists: boolean;
    legacy_relation_exists: boolean;
  }>(`
    SELECT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'ironshift') AS schema_exists,
           to_regclass('ironshift.schema_version') IS NOT NULL AS version_table_exists,
           EXISTS (
             SELECT 1
               FROM unnest(ARRAY['job_current', 'ready_job', 'scheduled_job', 'lease'])
                 AS legacy(relation_name)
              WHERE to_regclass(format('ironshift.%I', relation_name)) IS NOT NULL
           ) AS legacy_relation_exists`);
  const state = existing.rows[0]!;
  if (state.schema_exists) {
    if (!state.version_table_exists)
      throw new Error("refusing to install into an unversioned existing ironshift schema");
    const versions = await database.query<{ version: number }>(
      "SELECT version FROM ironshift.schema_version ORDER BY version",
    );
    if (
      versions.rows.length !== 1 ||
      versions.rows[0]?.version !== 3 ||
      state.legacy_relation_exists
    )
      throw new Error(
        "refusing to treat an existing non-v3 or mixed ironshift schema as a clean installation",
      );
  }
  const schemaUrl = new URL("../sql/schema.sql", import.meta.url);
  const sql = await readFile(schemaUrl, "utf8");
  await database.query(sql);
}
