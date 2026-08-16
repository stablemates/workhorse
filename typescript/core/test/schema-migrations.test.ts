import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { verifySqlProtocolFixtures } from "../../../scripts/verify-sql-protocol.js";
import { migrateSchema } from "../src/index.js";
import { applySchemaMigrationPlan } from "../src/schema-migrations.js";
import { createDatabaseTestHarness } from "./support/db.js";

const cleanDatabase = createDatabaseTestHarness(new URL("?clean-install", import.meta.url).href);
const fixtureDatabase = createDatabaseTestHarness(new URL("?fixture", import.meta.url).href);
const fixtureCleanDatabase = createDatabaseTestHarness(
  new URL("?fixture-clean", import.meta.url).href,
);
const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const executeFile = promisify(execFile);

async function dumpNormalizedSchema(databaseUrl: string): Promise<string> {
  const { stdout } = await executeFile(
    "pg_dump",
    [
      "--schema-only",
      "--schema=workhorse",
      "--no-owner",
      "--no-privileges",
      "--no-comments",
      "--no-security-labels",
      "--no-publications",
      "--no-subscriptions",
      databaseUrl,
    ],
    { maxBuffer: 10 * 1024 * 1024 },
  );

  return stdout
    .split("\n")
    .filter(
      (line) =>
        line !== "" &&
        !line.startsWith("--") &&
        !line.startsWith("\\restrict ") &&
        !line.startsWith("\\unrestrict "),
    )
    .join("\n");
}

describe("schema migrations", () => {
  beforeAll(async () => {
    await Promise.all([
      cleanDatabase.setup(),
      fixtureDatabase.setup(),
      fixtureCleanDatabase.setup(),
    ]);
    await Promise.all([
      fixtureDatabase.pool.query("DROP SCHEMA workhorse CASCADE"),
      fixtureCleanDatabase.pool.query("DROP SCHEMA workhorse CASCADE"),
    ]);
  });

  afterAll(async () => {
    await Promise.all([
      cleanDatabase.teardown(),
      fixtureDatabase.teardown(),
      fixtureCleanDatabase.teardown(),
    ]);
  });

  it("produces the same schema through a synthetic forward migration and clean installation", async () => {
    const directory = path.join(
      repository,
      "typescript",
      "core",
      "test",
      "fixtures",
      "schema-migrations",
    );
    await fixtureDatabase.pool.query(await readFile(path.join(directory, "0001.sql"), "utf8"));
    await fixtureCleanDatabase.pool.query(
      await readFile(path.join(directory, "current.sql"), "utf8"),
    );

    await applySchemaMigrationPlan(fixtureDatabase.pool, {
      baselineVersion: 1,
      currentVersion: 3,
      steps: [
        { fromVersion: 1, toVersion: 2, file: "0002-add-name.sql" },
        { fromVersion: 2, toVersion: 3, file: "0003-add-created-at.sql" },
      ],
      readStep: (file) => readFile(path.join(directory, file), "utf8"),
    });

    expect(await dumpNormalizedSchema(fixtureDatabase.databaseUrl)).toBe(
      await dumpNormalizedSchema(fixtureCleanDatabase.databaseUrl),
    );
  });

  it("rejects a gap in a synthetic forward migration plan", async () => {
    await fixtureDatabase.pool.query("UPDATE workhorse.schema_version SET version = 1");
    try {
      await expect(
        applySchemaMigrationPlan(fixtureDatabase.pool, {
          baselineVersion: 1,
          currentVersion: 3,
          steps: [{ fromVersion: 2, toVersion: 3, file: "unused.sql" }],
          readStep: () => Promise.reject(new Error("a missing step must fail before reading SQL")),
        }),
      ).rejects.toThrow("No Workhorse schema migration starts at version 1");
    } finally {
      await fixtureDatabase.pool.query("UPDATE workhorse.schema_version SET version = 3");
    }
  });

  it("rejects retired pre-release schema versions", async () => {
    await fixtureDatabase.pool.query("UPDATE workhorse.schema_version SET version = 42");
    try {
      await expect(migrateSchema(fixtureDatabase.pool)).rejects.toThrow(
        "Workhorse schema version 42 predates the supported migration baseline 43",
      );
    } finally {
      await fixtureDatabase.pool.query("UPDATE workhorse.schema_version SET version = 3");
    }
  });

  it("satisfies the SQL protocol fixtures on the pre-release baseline", async () => {
    const report = await verifySqlProtocolFixtures(cleanDatabase.pool, repository);
    expect(report.coverage).toEqual(
      new Set(
        report.manifest.coverage.filter(
          (capability) => !report.manifest.runtimeCoverage.includes(capability),
        ),
      ),
    );
  });

  it("leaves an already-current schema unchanged", async () => {
    const before = await cleanDatabase.pool.query<{ applied_at: Date }>(
      "SELECT applied_at FROM workhorse.schema_migration WHERE version = 43",
    );

    await migrateSchema(cleanDatabase.pool);

    const after = await cleanDatabase.pool.query<{ applied_at: Date }>(
      "SELECT applied_at FROM workhorse.schema_migration WHERE version = 43",
    );
    expect(after.rows).toEqual(before.rows);
  });
});
