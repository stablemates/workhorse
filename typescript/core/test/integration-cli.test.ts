import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  MINIMUM_SCHEMA_VERSION,
  PROTOCOL_VERSION,
  WORKHORSE_SCHEMA_VERSION,
} from "../src/schema.js";
import { createIntegrationTestContext } from "./support/integration.js";
import { runCliScript } from "./support/cli-process.js";

const repository = path.resolve(import.meta.dirname, "../../..");
const cli = path.join(repository, "typescript/core/src/cli/workhorse.ts");
const { databaseUrl, pool } = createIntegrationTestContext(import.meta.url);

function runCli(args: readonly string[]) {
  return runCliScript(cli, args, { cwd: repository, env: process.env });
}

async function withInstalledVersion(
  version: number,
  assertions: (result: Awaited<ReturnType<typeof runCli>>) => void,
): Promise<void> {
  await pool.query("UPDATE workhorse.schema_version SET version = $1", [version]);
  try {
    assertions(await runCli(["schema", "status", "--database-url", databaseUrl, "--json"]));
  } finally {
    await pool.query("UPDATE workhorse.schema_version SET version = $1", [
      WORKHORSE_SCHEMA_VERSION,
    ]);
  }
}

describe("database CLI output", () => {
  it("leaves an already-current schema unchanged through schema migrate", async () => {
    const result = await runCli(["schema", "migrate", `--database-url=${databaseUrl}`]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(
      `Workhorse schema v${WORKHORSE_SCHEMA_VERSION} is already current.`,
    );
  });

  it("emits separate current-schema and PostgreSQL support fields", async () => {
    const result = await runCli(["schema", "status", `--database-url=${databaseUrl}`, "--json"]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      schema: {
        installedVersion: WORKHORSE_SCHEMA_VERSION,
        expectedVersion: WORKHORSE_SCHEMA_VERSION,
        state: "current",
        installedProtocolVersions: [PROTOCOL_VERSION],
        pendingContractSteps: [],
      },
      postgres: {
        supported: true,
        tested: true,
        level: "supported-tested",
      },
    });
  });

  it("refuses a schema below this runtime's floor and exits with a runtime failure", async () => {
    await withInstalledVersion(MINIMUM_SCHEMA_VERSION - 1, (result) => {
      expect(result.code).toBe(1);
      expect(JSON.parse(result.stdout)).toMatchObject({
        schema: {
          installedVersion: MINIMUM_SCHEMA_VERSION - 1,
          expectedVersion: WORKHORSE_SCHEMA_VERSION,
          state: "behind",
          compatible: false,
        },
        postgres: { supported: true },
      });
    });
  });

  // A deployment gate that failed here would fail every rolling upgrade: the migration runs first,
  // so processes from the previous release meet a schema ahead of them until the rollout finishes.
  it("accepts a schema ahead of this build and exits successfully", async () => {
    await withInstalledVersion(WORKHORSE_SCHEMA_VERSION + 1, (result) => {
      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        schema: {
          installedVersion: WORKHORSE_SCHEMA_VERSION + 1,
          state: "ahead",
          compatible: true,
          refusal: null,
          refusalCode: null,
        },
      });
    });
  });

  it("reports no pending contract step on a current schema", async () => {
    const result = await runCli(["schema", "contract", `--database-url=${databaseUrl}`]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("no contract step is pending");
  });

  it("emits the QueueHealth shape with --json", async () => {
    const result = await runCli(["health", "--database-url", databaseUrl, "--json"]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: { level: "healthy", reasons: [] },
      observations: expect.any(Object),
    });
  });

  it("reports no invalid index and keeps the text output on a healthy database", async () => {
    const json = await runCli(["schema", "status", `--database-url=${databaseUrl}`, "--json"]);
    expect(json.code).toBe(0);
    expect(JSON.parse(json.stdout)).toMatchObject({ schema: { invalidIndexes: [] } });

    const text = await runCli(["schema", "status", `--database-url=${databaseUrl}`]);
    expect(text.code).toBe(0);
    expect(text.stdout).not.toMatch(/index/i);
  });
});

/**
 * Leave an invalid index named `task_runtime_active_queue_shard_idx`, as a failed concurrent build
 * of migration 0102 does. A unique concurrent build on duplicate rows fails and keeps its index.
 */
async function leaveInvalidShardIndex(): Promise<void> {
  await pool.query("DROP INDEX workhorse.task_runtime_active_queue_shard_idx");
  await pool.query("CREATE TABLE workhorse.invalid_index_probe (value integer)");
  await pool.query("INSERT INTO workhorse.invalid_index_probe VALUES (1), (1)");
  await expect(
    pool.query(
      "CREATE UNIQUE INDEX CONCURRENTLY task_runtime_active_queue_shard_idx ON workhorse.invalid_index_probe (value)",
    ),
  ).rejects.toMatchObject({ code: "23505" });
}

/** Remove the probe table and its invalid index, and build the real index again. */
async function repairShardIndex(): Promise<void> {
  await pool.query("DROP TABLE IF EXISTS workhorse.invalid_index_probe");
  await pool.query(
    "CREATE INDEX IF NOT EXISTS task_runtime_active_queue_shard_idx ON workhorse.task_runtime (queue_name, admission_shard) WHERE state = 'active'",
  );
}

describe("an invalid Workhorse index", () => {
  it("is reported by schema status with its drop statement and the step that builds it", async () => {
    await leaveInvalidShardIndex();
    try {
      const json = await runCli(["schema", "status", `--database-url=${databaseUrl}`, "--json"]);
      // An invalid index refuses nothing, so the exit code stays the one of a healthy database.
      expect(json.code).toBe(0);
      expect(JSON.parse(json.stdout).schema.invalidIndexes).toEqual([
        {
          name: "workhorse.task_runtime_active_queue_shard_idx",
          table: "workhorse.invalid_index_probe",
          valid: false,
          ready: false,
          dropStatement:
            "DROP INDEX CONCURRENTLY IF EXISTS workhorse.task_runtime_active_queue_shard_idx;",
          buildStep: {
            file: "0102-index-the-active-leases-of-each-admission-shard.sql",
            fromVersion: 100,
            toVersion: 101,
            applied: true,
          },
        },
      ]);

      const text = await runCli(["schema", "status", `--database-url=${databaseUrl}`]);
      expect(text.code).toBe(0);
      expect(text.stdout).toContain(
        "Index workhorse.task_runtime_active_queue_shard_idx on workhorse.invalid_index_probe is not valid. " +
          "Drop it with: DROP INDEX CONCURRENTLY IF EXISTS workhorse.task_runtime_active_queue_shard_idx;",
      );
      expect(text.stdout).toContain(
        "Then run the CREATE INDEX statement of migration 0102-index-the-active-leases-of-each-admission-shard.sql again",
      );
    } finally {
      await repairShardIndex();
    }
  });

  it("stops migration 0102 at its guard, and schema migrate prints the instruction of the guard", async () => {
    await leaveInvalidShardIndex();
    // Bring the schema back to the starting version of migration 0102, with its record removed.
    const recorded = await pool.query<{ description: string }>(
      "DELETE FROM workhorse.schema_migration WHERE version = 101 RETURNING description",
    );
    await pool.query("UPDATE workhorse.schema_version SET version = 100");
    try {
      const status = await runCli(["schema", "status", `--database-url=${databaseUrl}`]);
      expect(status.stdout).toContain(
        'Then run "workhorse schema migrate". Migration 0102-index-the-active-leases-of-each-admission-shard.sql builds the index again.',
      );

      const failed = await runCli(["schema", "migrate", `--database-url=${databaseUrl}`]);
      expect(failed.code).toBe(1);
      // A script can match the first line, so it stays as it was.
      expect(failed.stderr.split("\n")[0]).toBe(
        "Error: Workhorse migration 0102-index-the-active-leases-of-each-admission-shard.sql failed part-way and rolled nothing back; the schema is still at its starting version and the body reruns from the beginning",
      );
      expect(failed.stderr).toContain(
        "Cause: workhorse.task_runtime_active_queue_shard_idx is invalid after an earlier failed build. " +
          "Run DROP INDEX CONCURRENTLY IF EXISTS workhorse.task_runtime_active_queue_shard_idx, then run the migration again. " +
          "(SQLSTATE 55000)",
      );
      expect(failed.stderr).not.toContain(databaseUrl);

      // The instruction of the guard is the repair: drop the index, then migrate again.
      await pool.query("DROP TABLE workhorse.invalid_index_probe");
      const repaired = await runCli(["schema", "migrate", `--database-url=${databaseUrl}`]);
      expect(repaired.stderr).toBe("");
      expect(repaired.stdout).toContain(
        `Migrated Workhorse schema v100 to v${WORKHORSE_SCHEMA_VERSION}.`,
      );
    } finally {
      await repairShardIndex();
      await pool.query("UPDATE workhorse.schema_version SET version = $1", [
        WORKHORSE_SCHEMA_VERSION,
      ]);
      for (const row of recorded.rows) {
        await pool.query(
          "INSERT INTO workhorse.schema_migration (version, description) VALUES (101, $1) ON CONFLICT DO NOTHING",
          [row.description],
        );
      }
    }
  });

  // DETAIL of a constraint violation quotes the failing row, and a row can hold a credential.
  it("withholds a DETAIL that quotes a row when a step fails", async () => {
    const sentinel = "postgres://probe:REVIEW_SECRET_SENTINEL@db.invalid/example";
    const recorded = await pool.query<{ description: string }>(
      "DELETE FROM workhorse.schema_migration WHERE version = 101 RETURNING description",
    );
    await pool.query("UPDATE workhorse.schema_version SET version = 100");
    await pool.query("ALTER TABLE workhorse.schema_version ADD COLUMN probe_value text");
    await pool.query("UPDATE workhorse.schema_version SET probe_value = $1", [sentinel]);
    await pool.query(
      "ALTER TABLE workhorse.schema_version ADD CONSTRAINT probe_stop CHECK (version <= 100)",
    );
    try {
      const failed = await runCli(["schema", "migrate", `--database-url=${databaseUrl}`]);
      expect(failed.code).toBe(1);
      expect(failed.stderr).toContain('violates check constraint "probe_stop" (SQLSTATE 23514)');
      expect(failed.stderr).toContain(
        "Detail: withheld, because it can quote the values of a row or an input",
      );
      expect(failed.stderr).not.toContain("REVIEW_SECRET_SENTINEL");
    } finally {
      await pool.query("ALTER TABLE workhorse.schema_version DROP CONSTRAINT IF EXISTS probe_stop");
      await pool.query("ALTER TABLE workhorse.schema_version DROP COLUMN IF EXISTS probe_value");
      await pool.query("UPDATE workhorse.schema_version SET version = $1", [
        WORKHORSE_SCHEMA_VERSION,
      ]);
      for (const row of recorded.rows) {
        await pool.query(
          "INSERT INTO workhorse.schema_migration (version, description) VALUES (101, $1) ON CONFLICT DO NOTHING",
          [row.description],
        );
      }
    }
  });

  // A data exception quotes the input in its message, for example a stored value that a step casts.
  it("withholds the message of a data exception when a step fails", async () => {
    const sentinel = "postgres://probe:REVIEW_SECRET_SENTINEL@db.invalid/example";
    const recorded = await pool.query<{ description: string }>(
      "DELETE FROM workhorse.schema_migration WHERE version = 101 RETURNING description",
    );
    await pool.query("UPDATE workhorse.schema_version SET version = 100");
    await pool.query(`CREATE FUNCTION workhorse.probe_cast() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        PERFORM '${sentinel}'::integer;
        RETURN NEW;
      END
    $$`);
    await pool.query(
      "CREATE TRIGGER probe_cast BEFORE UPDATE ON workhorse.schema_version FOR EACH ROW EXECUTE FUNCTION workhorse.probe_cast()",
    );
    try {
      const failed = await runCli(["schema", "migrate", `--database-url=${databaseUrl}`]);
      expect(failed.code).toBe(1);
      expect(failed.stderr.split("\n")[0]).toBe(
        "Error: Workhorse migration 0102-index-the-active-leases-of-each-admission-shard.sql failed part-way and rolled nothing back; the schema is still at its starting version and the body reruns from the beginning",
      );
      expect(failed.stderr).toContain(
        "Cause: withheld, because it can quote the values of a row or an input (SQLSTATE 22P02)",
      );
      expect(failed.stderr).not.toContain("REVIEW_SECRET_SENTINEL");
    } finally {
      await pool.query("DROP TRIGGER IF EXISTS probe_cast ON workhorse.schema_version");
      await pool.query("DROP FUNCTION IF EXISTS workhorse.probe_cast()");
      await pool.query("UPDATE workhorse.schema_version SET version = $1", [
        WORKHORSE_SCHEMA_VERSION,
      ]);
      for (const row of recorded.rows) {
        await pool.query(
          "INSERT INTO workhorse.schema_migration (version, description) VALUES (101, $1) ON CONFLICT DO NOTHING",
          [row.description],
        );
      }
    }
  });
});
