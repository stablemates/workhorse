import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { verifySqlProtocolFixtures } from "../../../scripts/verify-sql-protocol.js";
import { randomUUID } from "node:crypto";
import {
  migrateSchema,
  readWorkerClientProtocols,
  SCHEMA_MIGRATIONS,
  WORKHORSE_SCHEMA_BASELINE_VERSION,
  WORKHORSE_SCHEMA_VERSION,
} from "../src/schema.js";
import {
  applySchemaMigrationPlan,
  parseSchemaMigrationMetadata,
  planSchemaContract,
} from "../src/schema-migrations.js";
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
const contractDatabase = createDatabaseTestHarness(new URL("?contract", import.meta.url).href, {
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
      contractDatabase.setup(),
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
      contractDatabase.teardown(),
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
        {
          fromVersion: 1,
          toVersion: 2,
          file: "0002-add-name.sql",
          description: "add name",
          kind: "additive",
        },
        {
          fromVersion: 2,
          toVersion: 3,
          file: "0003-add-created-at.sql",
          description: "add created_at",
          kind: "additive",
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
          steps: [
            {
              fromVersion: 2,
              toVersion: 3,
              file: "unused.sql",
              description: "unused",
              kind: "additive",
            },
          ],
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
          steps: [
            {
              fromVersion: 3,
              toVersion: 4,
              file: "0004.sql",
              description: "self commit",
              kind: "additive",
            },
          ],
          readStep: () =>
            Promise.resolve(
              '-- workhorse-migration: {"kind":"additive"}\nCOMMIT;\nALTER TABLE workhorse.example ADD y integer;',
            ),
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
          steps: [
            {
              fromVersion: 3,
              toVersion: 4,
              file: "0004.sql",
              description: "broken",
              kind: "additive",
            },
          ],
          readStep: () =>
            Promise.resolve(
              '-- workhorse-migration: {"kind":"additive"}\nCREATE TABLE workhorse.should_not_exist (id integer);\nSELECT 1 / 0;',
            ),
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
            baselineVersion: WORKHORSE_SCHEMA_BASELINE_VERSION,
            currentVersion: WORKHORSE_SCHEMA_VERSION + 1,
            steps: [
              {
                fromVersion: WORKHORSE_SCHEMA_VERSION,
                toVersion: WORKHORSE_SCHEMA_VERSION + 1,
                file: "blocked.sql",
                description: "blocked",
                kind: "additive",
              },
            ],
            readStep: () =>
              Promise.resolve(
                '-- workhorse-migration: {"kind":"additive"}\nALTER TABLE workhorse.protocol_version ADD COLUMN probe integer;',
              ),
            lockTimeoutMs: 250,
          },
          WORKHORSE_SCHEMA_VERSION,
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
    expect(state.rows).toEqual([{ version: WORKHORSE_SCHEMA_VERSION, probe: null }]);
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
          baselineVersion: WORKHORSE_SCHEMA_BASELINE_VERSION,
          currentVersion: WORKHORSE_SCHEMA_VERSION + 1,
          steps: [
            {
              fromVersion: WORKHORSE_SCHEMA_VERSION,
              toVersion: WORKHORSE_SCHEMA_VERSION + 1,
              file: "queued.sql",
              description: "queued",
              kind: "additive",
            },
          ],
          readStep: () => Promise.resolve('-- workhorse-migration: {"kind":"additive"}\nSELECT 1;'),
          lockTimeoutMs: 250,
        },
        WORKHORSE_SCHEMA_VERSION,
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
    expect(version.rows).toEqual([{ version: WORKHORSE_SCHEMA_VERSION + 1 }]);
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
    // schema newer than the one it was built against. A removal belongs to a contract step, which
    // the file's first line declares and SCHEMA_MIGRATIONS repeats — the two must agree for the
    // released record to mean anything, so this checks the declaration before it checks the body.
    const migrations = (await readdir(path.join(repository, "sql", "migrations")))
      .filter((file) => file.endsWith(".sql"))
      // oxlint-disable-next-line unicorn/no-array-sort -- ES2022 lacks Array.prototype.toSorted.
      .sort();
    const subtractive =
      /^\s*(?:DROP\s+(?:TABLE|VIEW|FUNCTION|PROCEDURE|TYPE|DOMAIN|SEQUENCE|SCHEMA)\b|ALTER\s+\w+\s+[\s\S]*?\b(?:DROP\s+(?:COLUMN|CONSTRAINT|DEFAULT|NOT\s+NULL)|RENAME)\b)/im;

    const offenders: string[] = [];
    for (const file of migrations) {
      const body = await readFile(path.join(repository, "sql", "migrations", file), "utf8");
      const step = SCHEMA_MIGRATIONS.find((candidate) => candidate.file === file);
      let declared;
      try {
        declared = parseSchemaMigrationMetadata(file, body);
      } catch {
        offenders.push(`${file}: missing or malformed -- workhorse-migration declaration`);
        continue;
      }
      if (step === undefined) {
        offenders.push(`${file}: has no SCHEMA_MIGRATIONS entry`);
        continue;
      }
      if (declared.kind !== step.kind) {
        offenders.push(
          `${file}: declares "${declared.kind}" but SCHEMA_MIGRATIONS says "${step.kind}"`,
        );
        continue;
      }
      if (declared.kind === "contract") continue;
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
        `SELECT state FROM workhorse.task_runtime
         UNION SELECT state FROM workhorse.task_outcome ORDER BY state`,
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
        "SELECT count(DISTINCT tableoid)::text AS partitions FROM workhorse.task_event",
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
        "task",
        "task_checkpoint",
        "task_child",
        "task_dependency",
        "task_event",
        "task_outcome",
        "task_progress",
        "task_runtime",
        "task_wait",
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

  // The fleet read is the evidence `workhorse schema contract` gates on, and the columns behind it
  // belong to the frozen baseline rather than to a step on top of it. Reintroducing them as a
  // migration would put a schema the minimum accepts back into the "cannot answer" branch, so the
  // baseline is asserted to answer directly.
  it("answers the fleet read on the frozen baseline, with no migration applied", async () => {
    await releaseDatabase.pool.query("DROP SCHEMA IF EXISTS workhorse CASCADE");
    await releaseDatabase.pool.query(
      await readFile(path.join(repository, "sql", "releases", "0001.sql"), "utf8"),
    );

    await expect(readWorkerClientProtocols(releaseDatabase.pool)).resolves.toEqual([]);

    await migrateSchema(releaseDatabase.pool);

    await expect(readWorkerClientProtocols(releaseDatabase.pool)).resolves.toEqual([]);
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

  // The contract-step machinery is exercised against the installed schema itself: the refusal
  // gate reads workhorse.worker_registry, which only the real baseline carries. Every test leaves
  // schema_version at 1 and an empty registry behind for the next one.
  describe("contract steps", () => {
    async function registerContractWorker(
      workerId: string,
      clientProtocolVersion: number | null,
    ): Promise<void> {
      await contractDatabase.pool.query(
        `SELECT workhorse.register_worker_v1(
           $1::text, $2::uuid, 'contract-host', 4242, ARRAY['contract']::text[], ARRAY[]::text[],
           1, 30000, 10000, 250, 1000, 60000, 5000, 0, false, $3::integer, 'fixture', '9.9.9')`,
        [workerId, randomUUID(), clientProtocolVersion],
      );
    }

    async function deregisterContractWorker(workerId: string): Promise<void> {
      await contractDatabase.pool.query(`SELECT workhorse.deregister_worker_v1($1)`, [workerId]);
    }

    async function setSchemaVersion(version: number): Promise<void> {
      await contractDatabase.pool.query("UPDATE workhorse.schema_version SET version = $1", [
        version,
      ]);
    }

    // A two-step chain whose second step is a contract step, so one forward run can stop before
    // it and one contract run can apply it.
    const stopPlan = {
      baselineVersion: 1,
      currentVersion: 3,
      steps: [
        {
          fromVersion: 1,
          toVersion: 2,
          file: "0002-add-probe.sql",
          description: "add probe table",
          kind: "additive" as const,
        },
        {
          fromVersion: 2,
          toVersion: 3,
          file: "0003-retire-probe.sql",
          description: "drop the probe table",
          kind: "contract" as const,
          retiresProtocolVersions: [1],
        },
      ],
      readStep: (file: string) =>
        Promise.resolve(
          file === "0002-add-probe.sql"
            ? '-- workhorse-migration: {"kind":"additive"}\nCREATE TABLE workhorse.contract_probe (id integer);'
            : '-- workhorse-migration: {"kind":"contract","retiresProtocolVersions":[1]}\nDROP TABLE workhorse.contract_probe;',
        ),
    };

    it("stops a forward migration before a contract step and reports it", async () => {
      try {
        const result = await applySchemaMigrationPlan(contractDatabase.pool, stopPlan);

        expect(result.finishedVersion).toBe(2);
        expect(result.contractStop?.file).toBe("0003-retire-probe.sql");
        const state = await contractDatabase.pool.query<{ version: number; probe: string | null }>(
          `SELECT version, to_regclass('workhorse.contract_probe')::text AS probe
             FROM workhorse.schema_version`,
        );
        // The additive step committed and the contract step never ran.
        expect(state.rows).toEqual([{ version: 2, probe: "contract_probe" }]);
      } finally {
        await contractDatabase.pool.query("DROP TABLE IF EXISTS workhorse.contract_probe");
        await contractDatabase.pool.query(
          "DELETE FROM workhorse.schema_migration WHERE version > 1",
        );
        await setSchemaVersion(1);
      }
    });

    it("applies exactly one pending contract step once confirmed", async () => {
      try {
        await applySchemaMigrationPlan(contractDatabase.pool, stopPlan);

        const outcome = await planSchemaContract(contractDatabase.pool, stopPlan, {
          confirmed: true,
        });

        expect(outcome.kind).toBe("applied");
        if (outcome.kind !== "applied") throw new Error("expected the contract step to be applied");
        expect(outcome.step.file).toBe("0003-retire-probe.sql");
        const state = await contractDatabase.pool.query<{
          version: number;
          probe: string | null;
          recorded: string | null;
        }>(
          `SELECT version, to_regclass('workhorse.contract_probe')::text AS probe,
                  (SELECT description FROM workhorse.schema_migration WHERE version = 3) AS recorded
             FROM workhorse.schema_version`,
        );
        expect(state.rows).toEqual([{ version: 3, probe: null, recorded: "drop the probe table" }]);
      } finally {
        await contractDatabase.pool.query("DROP TABLE IF EXISTS workhorse.contract_probe");
        await contractDatabase.pool.query(
          "DELETE FROM workhorse.schema_migration WHERE version > 1",
        );
        await setSchemaVersion(1);
      }
    });

    it("refuses an unconfirmed contract step, naming the workers it would stop", async () => {
      const retiring = `contract-live-${randomUUID()}`;
      const surviving = `contract-surviving-${randomUUID()}`;
      const lapsed = `contract-lapsed-${randomUUID()}`;
      const plan = {
        baselineVersion: 1,
        currentVersion: 2,
        steps: [
          {
            fromVersion: 1,
            toVersion: 2,
            file: "0002-retire-v1.sql",
            description: "retire protocol v1",
            kind: "contract" as const,
            retiresProtocolVersions: [1],
          },
        ],
        readStep: () =>
          Promise.resolve(
            '-- workhorse-migration: {"kind":"contract","retiresProtocolVersions":[1]}\nDELETE FROM workhorse.protocol_version WHERE version = 1;',
          ),
      };
      try {
        await registerContractWorker(retiring, 1);
        await registerContractWorker(surviving, 2);
        await registerContractWorker(lapsed, 1);
        await contractDatabase.pool.query(
          `UPDATE workhorse.worker_registry
              SET last_heartbeat_at = clock_timestamp() - interval '1 hour'
            WHERE worker_id = $1`,
          [lapsed],
        );

        const outcome = await planSchemaContract(contractDatabase.pool, plan);

        expect(outcome.kind).toBe("unconfirmed");
        if (outcome.kind !== "unconfirmed") {
          throw new Error("expected the contract step to be refused");
        }
        // The live worker on the retiring protocol is named; the one outside its lease and the
        // one on a surviving protocol are not.
        expect(outcome.workers.map((worker) => worker.workerId)).toEqual([retiring]);
        expect(
          await contractDatabase.pool
            .query<{ version: number }>("SELECT version FROM workhorse.schema_version")
            .then((result) => result.rows[0]?.version),
        ).toBe(1);
      } finally {
        for (const workerId of [retiring, surviving, lapsed]) {
          await deregisterContractWorker(workerId);
        }
      }
    });

    it("applies a contract step past live workers once confirmed", async () => {
      const retiring = `contract-live-${randomUUID()}`;
      const plan = {
        baselineVersion: 1,
        currentVersion: 2,
        steps: [
          {
            fromVersion: 1,
            toVersion: 2,
            file: "0002-retire-v1.sql",
            description: "retire protocol v1",
            kind: "contract" as const,
            retiresProtocolVersions: [1],
          },
        ],
        readStep: () =>
          Promise.resolve(
            '-- workhorse-migration: {"kind":"contract","retiresProtocolVersions":[1]}\nDELETE FROM workhorse.protocol_version WHERE version = 1;',
          ),
      };
      try {
        await registerContractWorker(retiring, 1);

        const outcome = await planSchemaContract(contractDatabase.pool, plan, {
          confirmed: true,
        });

        expect(outcome.kind).toBe("applied");
        if (outcome.kind !== "applied") {
          throw new Error("expected the contract step to be applied");
        }
        // The workers the step was applied past are still reported, not silently ignored.
        expect(outcome.workers.map((worker) => worker.workerId)).toEqual([retiring]);
      } finally {
        await deregisterContractWorker(retiring);
        await contractDatabase.pool.query(
          "INSERT INTO workhorse.protocol_version (version) VALUES (1) ON CONFLICT DO NOTHING",
        );
        await contractDatabase.pool.query(
          "DELETE FROM workhorse.schema_migration WHERE version > 1",
        );
        await setSchemaVersion(1);
      }
    });

    it("rolls a failed contract step back atomically", async () => {
      const plan = {
        baselineVersion: 1,
        currentVersion: 2,
        steps: [
          {
            fromVersion: 1,
            toVersion: 2,
            file: "0002-broken.sql",
            description: "broken contract step",
            kind: "contract" as const,
            retiresProtocolVersions: [1],
          },
        ],
        readStep: () =>
          Promise.resolve(
            '-- workhorse-migration: {"kind":"contract","retiresProtocolVersions":[1]}\nCREATE TABLE workhorse.contract_leak (id integer);\nSELECT 1 / 0;',
          ),
      };

      await expect(
        planSchemaContract(contractDatabase.pool, plan, { confirmed: true }),
      ).rejects.toThrow("Workhorse migration 0002-broken.sql failed and was rolled back");

      const state = await contractDatabase.pool.query<{ version: number; leaked: string | null }>(
        `SELECT version, to_regclass('workhorse.contract_leak')::text AS leaked
           FROM workhorse.schema_version`,
      );
      expect(state.rows).toEqual([{ version: 1, leaked: null }]);
    });

    it("requires a migration file's own declaration to match its SCHEMA_MIGRATIONS entry", async () => {
      const undeclared = {
        baselineVersion: 1,
        currentVersion: 2,
        steps: [
          {
            fromVersion: 1,
            toVersion: 2,
            file: "0002-undeclared.sql",
            description: "undeclared",
            kind: "additive" as const,
          },
        ],
        readStep: () => Promise.resolve("SELECT 1;"),
      };
      await expect(applySchemaMigrationPlan(contractDatabase.pool, undeclared)).rejects.toThrow(
        "must open with a '-- workhorse-migration:",
      );

      const mislabeled = {
        baselineVersion: 1,
        currentVersion: 2,
        steps: [
          {
            fromVersion: 1,
            toVersion: 2,
            file: "0002-mislabeled.sql",
            description: "mislabeled",
            kind: "additive" as const,
          },
        ],
        readStep: () =>
          Promise.resolve(
            '-- workhorse-migration: {"kind":"contract","retiresProtocolVersions":[1]}\nSELECT 1;',
          ),
      };
      await expect(applySchemaMigrationPlan(contractDatabase.pool, mislabeled)).rejects.toThrow(
        'declares "contract" but SCHEMA_MIGRATIONS says "additive"',
      );
    });
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
