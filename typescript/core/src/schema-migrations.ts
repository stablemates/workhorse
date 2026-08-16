import type { Queryable } from "./types.js";

export interface SchemaMigrationStep {
  fromVersion: number;
  toVersion: number;
  file: string;
}

export interface SchemaMigrationPlan {
  baselineVersion: number;
  currentVersion: number;
  steps: readonly SchemaMigrationStep[];
  readStep(file: string): Promise<string>;
}

export async function readSchemaVersion(database: Queryable): Promise<number | null> {
  const result = await database.query<{ version: number }>(
    "SELECT version FROM workhorse.schema_version ORDER BY version",
  );
  return result.rows.length === 1 ? (result.rows[0]?.version ?? null) : null;
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
    const sql = await plan.readStep(migration.file);
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
