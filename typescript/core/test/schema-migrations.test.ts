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
import {
  createHistoryFixtureDay,
  readSeededRows,
  seedReleasedSchema,
} from "./support/populated-schema.js";

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
const lockDatabase = createDatabaseTestHarness(new URL("?lock", import.meta.url).href, {
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
      lockDatabase.setup(),
    ]);
    await Promise.all([
      fixtureDatabase.pool.query("DROP SCHEMA workhorse CASCADE"),
      fixtureCleanDatabase.pool.query("DROP SCHEMA workhorse CASCADE"),
    ]);
    // The released-artifact loop seeds history rows into a fixed history day, and a partition is a
    // schema object. The clean installation the loop compares dumps against creates the same day so
    // the comparison stays byte-for-byte on everything else.
    await createHistoryFixtureDay(cleanDatabase.pool);
  });

  afterAll(async () => {
    await Promise.all([
      cleanDatabase.teardown(),
      fixtureDatabase.teardown(),
      fixtureCleanDatabase.teardown(),
      releaseDatabase.teardown(),
      lockDatabase.teardown(),
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

  it("gives up a migration that waits too long for a table lock, and rolls it back", async () => {
    // An ALTER TABLE takes ACCESS EXCLUSIVE, and PostgreSQL queues every later statement on that
    // table behind the waiting acquisition. A worker holds long transactions by design, so an
    // unbounded wait would stall the queue instead of failing the deployment.
    const blocker = await lockDatabase.pool.connect();
    try {
      await blocker.query("BEGIN");
      await blocker.query("SELECT version FROM workhorse.protocol_version");

      await expect(
        applySchemaMigrationPlan(
          lockDatabase.pool,
          {
            baselineVersion: 1,
            currentVersion: 2,
            steps: [{ fromVersion: 1, toVersion: 2, file: "0002.sql", description: "blocked" }],
            readStep: () =>
              Promise.resolve("ALTER TABLE workhorse.protocol_version ADD COLUMN probe integer;"),
            lockTimeoutMs: 250,
          },
          1,
        ),
      ).rejects.toThrow("waited longer than 250ms for a lock");
    } finally {
      await blocker.query("ROLLBACK");
      blocker.release();
    }

    const state = await lockDatabase.pool.query<{ version: number; probe: string | null }>(
      `SELECT version,
              (SELECT attname::text
                 FROM pg_attribute
                WHERE attrelid = 'workhorse.protocol_version'::regclass AND attname = 'probe') AS probe
         FROM workhorse.schema_version`,
    );
    expect(state.rows).toEqual([{ version: 1, probe: null }]);
  });

  it("waits without a deadline for a peer migrator that holds the advisory lock", async () => {
    // lock_timeout is disabled while the advisory lock is acquired: another migrator finishing its
    // step is expected, and its result is indistinguishable from this one's success.
    const peer = await lockDatabase.pool.connect();
    try {
      await peer.query("BEGIN");
      await peer.query("SELECT pg_advisory_xact_lock(hashtext('workhorse:schema-migration'))");
      const migration = applySchemaMigrationPlan(
        lockDatabase.pool,
        {
          baselineVersion: 1,
          currentVersion: 2,
          steps: [{ fromVersion: 1, toVersion: 2, file: "0002.sql", description: "queued" }],
          readStep: () => Promise.resolve("SELECT 1;"),
          lockTimeoutMs: 250,
        },
        1,
      );
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 750);
      });
      await peer.query("ROLLBACK");
      await migration;
    } finally {
      peer.release();
    }

    const version = await lockDatabase.pool.query<{ version: number }>(
      "SELECT version FROM workhorse.schema_version",
    );
    expect(version.rows).toEqual([{ version: 2 }]);
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

  it("ships no migration that removes or renames a released object", async () => {
    // ADR 0053: inside a major line a migration only adds, which is what lets a client accept a
    // schema newer than the one it was built against. A removal belongs to a major release, so it
    // must not reach `sql/migrations/`. The loop starts enforcing itself with the first step.
    const migrations = (await readdir(path.join(repository, "sql", "migrations")))
      .filter((file) => file.endsWith(".sql"))
      // oxlint-disable-next-line unicorn/no-array-sort -- ES2022 lacks Array.prototype.toSorted.
      .sort();
    const subtractive =
      /^\s*(?:DROP\s+(?:TABLE|VIEW|FUNCTION|PROCEDURE|TYPE|DOMAIN|SEQUENCE|SCHEMA)\b|ALTER\s+\w+\s+[\s\S]*?\b(?:DROP\s+(?:COLUMN|CONSTRAINT|DEFAULT|NOT\s+NULL)|RENAME)\b)/im;

    const offenders: string[] = [];
    for (const file of migrations) {
      const body = await readFile(path.join(repository, "sql", "migrations", file), "utf8");
      // A dollar-quoted body is data, not statements: a plpgsql function may legitimately contain
      // DROP inside the code it defines, and only statements outside those quotes change the shape.
      const statements = body.replaceAll(/\$([A-Za-z_]\w*)?\$[\s\S]*?\$\1\$/g, "''");
      for (const statement of statements.split(";")) {
        if (subtractive.test(statement))
          offenders.push(`${file}: ${statement.trim().slice(0, 80)}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("migrates every released schema version to a clean-installation schema and keeps its rows", async () => {
    // The first frozen artifact is `0001.sql`, the 0.1.0 clean install. Each later release freezes
    // its own, and this loop proves every one of them migrates to a schema byte-identical to a
    // clean installation of the current artifact, on a database populated first.
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

      // A dump speaks for shape, so the artifact is populated first and every seeded row is
      // compared by value afterwards. A count would pass a migration that rewrote a column.
      await seedReleasedSchema(releaseDatabase.pool);
      const states = await releaseDatabase.pool.query<{ state: string }>(
        `SELECT state FROM workhorse.job_runtime
         UNION SELECT state FROM workhorse.job_outcome ORDER BY state`,
      );
      expect(states.rows.map((row) => row.state)).toEqual([
        "active",
        "blocked",
        "canceled",
        "failed",
        "ready",
        "scheduled",
        "succeeded",
      ]);
      const partitions = await releaseDatabase.pool.query<{ partitions: string }>(
        "SELECT count(DISTINCT tableoid)::text AS partitions FROM workhorse.job_event",
      );
      expect(Number(partitions.rows[0]?.partitions)).toBeGreaterThan(1);
      const seeded = await readSeededRows(releaseDatabase.pool);
      const populated = new Set(
        seeded.filter((table) => table.rows.length > 0).map((table) => table.table),
      );
      // Naming the tables keeps an empty snapshot from passing the comparison below by holding
      // nothing to compare.
      for (const table of [
        "attempt_history",
        "concurrency_policy",
        "job",
        "job_checkpoint",
        "job_child",
        "job_dependency",
        "job_event",
        "job_outcome",
        "job_progress",
        "job_runtime",
        "job_wait",
        "queue_control",
        "queue_purge_request",
        "rate_limit_policy",
        "schedule_definition",
        "schedule_occurrence",
        "worker_registry",
      ])
        expect(populated).toContain(table);

      await migrateSchema(releaseDatabase.pool);

      expect(await readSeededRows(releaseDatabase.pool, seeded)).toEqual(seeded);

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
