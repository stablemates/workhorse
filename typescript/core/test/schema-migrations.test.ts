import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { verifySqlProtocolFixtures } from "../../../scripts/verify-sql-protocol.js";
import {
  migrateSchema,
  WORKHORSE_SCHEMA_BASELINE_VERSION,
  WORKHORSE_SCHEMA_VERSION,
} from "../src/index.js";
import { applySchemaMigrationPlan } from "../src/schema-migrations.js";
import { createDatabaseTestHarness } from "./support/db.js";

const cleanDatabase = createDatabaseTestHarness(new URL("?clean-install", import.meta.url).href, {
  schemaProvisioning: "install",
});
const fixtureDatabase = createDatabaseTestHarness(new URL("?fixture", import.meta.url).href, {
  schemaProvisioning: "install",
});
const fixtureCleanDatabase = createDatabaseTestHarness(
  new URL("?fixture-clean", import.meta.url).href,
  { schemaProvisioning: "install" },
);
const releaseDatabase = createDatabaseTestHarness(new URL("?release", import.meta.url).href, {
  schemaProvisioning: "install",
});
const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const executeFile = promisify(execFile);

async function dumpNormalizedSchema(databaseUrl: string): Promise<string> {
  const dumpArguments = [
    "--schema-only",
    "--schema=workhorse",
    "--no-owner",
    "--no-privileges",
    "--no-comments",
    "--no-security-labels",
    "--no-publications",
    "--no-subscriptions",
    databaseUrl,
  ];
  const postgresContainer = process.env.WORKHORSE_TEST_POSTGRES_CONTAINER;
  const { stdout } = postgresContainer
    ? await executeFile("docker", ["exec", postgresContainer, "pg_dump", ...dumpArguments], {
        maxBuffer: 10 * 1024 * 1024,
      })
    : await executeFile("pg_dump", dumpArguments, { maxBuffer: 10 * 1024 * 1024 });

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
      releaseDatabase.setup(),
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
      releaseDatabase.teardown(),
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
        { fromVersion: 1, toVersion: 2, file: "0002-add-name.sql", description: "add name" },
        {
          fromVersion: 2,
          toVersion: 3,
          file: "0003-add-created-at.sql",
          description: "add created_at",
        },
      ],
      readStep: (file) => readFile(path.join(directory, file), "utf8"),
    });

    expect(await dumpNormalizedSchema(fixtureDatabase.databaseUrl)).toBe(
      await dumpNormalizedSchema(fixtureCleanDatabase.databaseUrl),
    );

    const migrations = await fixtureDatabase.pool.query<{ version: number; description: string }>(
      "SELECT version, description FROM workhorse.schema_migration ORDER BY version",
    );
    expect(migrations.rows).toEqual([
      { version: 1, description: "fixture baseline" },
      { version: 2, description: "add name" },
      { version: 3, description: "add created_at" },
    ]);
  });

  it("rejects a gap in a synthetic forward migration plan", async () => {
    await fixtureDatabase.pool.query("UPDATE workhorse.schema_version SET version = 1");
    try {
      await expect(
        applySchemaMigrationPlan(fixtureDatabase.pool, {
          baselineVersion: 1,
          currentVersion: 3,
          steps: [{ fromVersion: 2, toVersion: 3, file: "unused.sql", description: "unused" }],
          readStep: () => Promise.reject(new Error("a missing step must fail before reading SQL")),
        }),
      ).rejects.toThrow("No Workhorse schema migration starts at version 1");
    } finally {
      await fixtureDatabase.pool.query("UPDATE workhorse.schema_version SET version = 3");
    }
  });

  it("rejects a migration body that manages its own transaction", async () => {
    await expect(
      applySchemaMigrationPlan(
        fixtureDatabase.pool,
        {
          baselineVersion: 1,
          currentVersion: 4,
          steps: [{ fromVersion: 3, toVersion: 4, file: "0004.sql", description: "self commit" }],
          readStep: () => Promise.resolve("COMMIT;\nALTER TABLE workhorse.example ADD y integer;"),
        },
        3,
      ),
    ).rejects.toThrow("must not contain transaction control statements");
  });

  it("rolls a failed migration back atomically", async () => {
    await expect(
      applySchemaMigrationPlan(
        fixtureDatabase.pool,
        {
          baselineVersion: 1,
          currentVersion: 4,
          steps: [{ fromVersion: 3, toVersion: 4, file: "0004.sql", description: "broken" }],
          readStep: () =>
            Promise.resolve("CREATE TABLE workhorse.should_not_exist (id integer);\nSELECT 1 / 0;"),
        },
        3,
      ),
    ).rejects.toThrow("Workhorse migration 0004.sql failed and was rolled back");

    const state = await fixtureDatabase.pool.query<{ version: number; leaked: string | null }>(
      `SELECT version, to_regclass('workhorse.should_not_exist')::text AS leaked
         FROM workhorse.schema_version`,
    );
    expect(state.rows).toEqual([{ version: 3, leaked: null }]);
  });

  it("rejects schema versions below the migration baseline", async () => {
    await fixtureDatabase.pool.query("UPDATE workhorse.schema_version SET version = 0");
    try {
      await expect(migrateSchema(fixtureDatabase.pool)).rejects.toThrow(
        `predates the supported migration baseline ${WORKHORSE_SCHEMA_BASELINE_VERSION}`,
      );
    } finally {
      await fixtureDatabase.pool.query("UPDATE workhorse.schema_version SET version = 3");
    }
  });

  it("migrates every released schema version to a schema identical to a clean installation", async () => {
    // `sql/releases/` is empty until the first public release: schema version 1 is a clean install
    // with no upgrade source, so there is nothing to migrate from yet. The first frozen artifact
    // lands there when a released version must survive an upgrade, and this loop starts running.
    const releases = (await readdir(path.join(repository, "sql", "releases")))
      .filter((file) => file.endsWith(".sql"))
      // oxlint-disable-next-line unicorn/no-array-sort -- ES2022 lacks Array.prototype.toSorted.
      .sort();

    for (const release of releases) {
      const releasedVersion = Number.parseInt(release, 10);
      await releaseDatabase.pool.query("DROP SCHEMA IF EXISTS workhorse CASCADE");
      await releaseDatabase.pool.query(
        await readFile(path.join(repository, "sql", "releases", release), "utf8"),
      );
      const installed = await releaseDatabase.pool.query<{ version: number }>(
        "SELECT version FROM workhorse.schema_version",
      );
      expect(installed.rows).toEqual([{ version: releasedVersion }]);

      await migrateSchema(releaseDatabase.pool);

      expect(await dumpNormalizedSchema(releaseDatabase.databaseUrl)).toBe(
        await dumpNormalizedSchema(cleanDatabase.databaseUrl),
      );
      const versions = await releaseDatabase.pool.query<{ version: number }>(
        "SELECT version FROM workhorse.schema_version",
      );
      expect(versions.rows).toEqual([{ version: WORKHORSE_SCHEMA_VERSION }]);
      const protocols = await releaseDatabase.pool.query<{ version: number }>(
        "SELECT version FROM workhorse.protocol_version ORDER BY version",
      );
      expect(protocols.rows).toEqual([{ version: 1 }]);
      const migrations = await releaseDatabase.pool.query<{ version: number }>(
        "SELECT version FROM workhorse.schema_migration ORDER BY version",
      );
      // A clean installation records the full lineage from the baseline, and each migration
      // appends its own row, so both paths agree on the complete baseline..current range.
      expect(migrations.rows.map((row) => row.version)).toEqual(
        Array.from(
          { length: WORKHORSE_SCHEMA_VERSION - WORKHORSE_SCHEMA_BASELINE_VERSION + 1 },
          (unused, index) => WORKHORSE_SCHEMA_BASELINE_VERSION + index,
        ),
      );
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
    const before = await cleanDatabase.pool.query<{ version: number; applied_at: Date }>(
      "SELECT version, applied_at FROM workhorse.schema_migration ORDER BY version",
    );
    expect(before.rows.map((row) => row.version)).toEqual(
      Array.from(
        { length: WORKHORSE_SCHEMA_VERSION - WORKHORSE_SCHEMA_BASELINE_VERSION + 1 },
        (unused, index) => WORKHORSE_SCHEMA_BASELINE_VERSION + index,
      ),
    );

    await migrateSchema(cleanDatabase.pool);

    const after = await cleanDatabase.pool.query<{ version: number; applied_at: Date }>(
      "SELECT version, applied_at FROM workhorse.schema_migration ORDER BY version",
    );
    expect(after.rows).toEqual(before.rows);
  });
});
