import { randomBytes } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { Client, Pool } from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { dropLocalDatabase } from "../typescript/core/src/drop-local-database.js";
import { databaseName, localDatabaseUrl } from "../typescript/core/src/local-database.js";
import {
  assertSweepTarget,
  checkoutDatabaseNames,
  dropRetiredDatabases,
  planTestDatabaseSweep,
  readDatabaseInventory,
  type SweepContext,
  testFamilyRoots,
} from "./test-database-sweep.js";
import {
  copySchemaTemplate,
  schemaTemplatePrefix,
} from "../typescript/core/test/support/schema-template.js";

// Two databases shaped exactly like the scratch databases `test/support/db.ts` creates. One is
// abandoned, as a timed-out teardown leaves it; the other stands in for a suite still running.
const sourceUrl = localDatabaseUrl("test");
const sourceName = databaseName(sourceUrl);
const leakedName = `${sourceName.slice(0, 52)}_5b0eafed01`;
const liveName = `${sourceName.slice(0, 52)}_5b0eafed02`;

// A retired template of this process only, so the test never touches a template a checkout uses.
const templateName = `${schemaTemplatePrefix}${randomBytes(8).toString("hex")}_00000000`;
const copyName = `${sourceName.slice(0, 52)}_5b0eafed03`;

// The JVM harness names its per-process template with the scratch shape `<source>_jvm_<digest>`.
const jvmTemplateName = `${sourceName.slice(0, 43)}_jvm_5b0eafed04`;

const protectedNames = new Set([...checkoutDatabaseNames(process.env), sourceName]);
const context: SweepContext = {
  protectedNames,
  familyRoots: testFamilyRoots(protectedNames),
  liveTemplates: new Set(),
};

// The sweep drops a database in the test body. A drop waits for a checkpoint, and under load that
// wait can pass the default test timeout. The test gets the timeout of the database hooks, which
// wait for the same checkpoints.
const dropWait = { timeout: inject("databaseHookTimeout") };

let admin: Pool;
let liveSession: Client;

beforeAll(async () => {
  assertSweepTarget(sourceUrl);
  admin = new Pool({ connectionString: adminUrl(sourceUrl), max: 1 });
  for (const name of [leakedName, liveName]) {
    await dropLocalDatabase(admin, name);
    await admin.query(`CREATE DATABASE ${identifier(name)}`);
  }
  liveSession = new Client({ connectionString: databaseUrl(sourceUrl, liveName) });
  await liveSession.connect();
});

afterAll(async () => {
  if (liveSession) await liveSession.end();
  for (const name of [
    leakedName,
    liveName,
    templateName,
    `${templateName}_building`,
    copyName,
    jvmTemplateName,
  ]) {
    await dropLocalDatabase(admin, name);
  }
  await admin.end();
});

describe("sweeping leaked scratch databases", () => {
  it("drops the abandoned database and leaves the one a session holds", dropWait, async () => {
    // Plan over this test's own databases only: the sweep command is what reclaims the server,
    // and a test run must not drop another checkout's leftovers behind its back.
    const inventory = (await readDatabaseInventory(admin)).filter((entry) =>
      [leakedName, liveName, sourceName].includes(entry.name),
    );
    const plan = planTestDatabaseSweep(inventory, context);

    expect(plan.drop.map((entry) => entry.name)).toEqual([leakedName]);
    expect(plan.held.map((entry) => entry.name)).toEqual([liveName]);

    const outcome = await dropRetiredDatabases(admin, plan, context);

    expect(outcome.dropped.map((entry) => entry.name)).toEqual([leakedName]);
    expect(outcome.skipped).toEqual([]);
    expect(await databaseExists(admin, leakedName)).toBe(false);
    expect(await databaseExists(admin, liveName)).toBe(true);
    expect(await databaseExists(admin, sourceName)).toBe(true);
  });

  it("refuses a plan naming a database the guards do not classify as retired", async () => {
    const plan = {
      drop: [{ name: sourceName, sizeBytes: 0, inUse: false, kind: "scratch" as const }],
      held: [],
    };

    await expect(dropRetiredDatabases(admin, plan, context)).rejects.toThrow(
      /no longer classified as a retired database/,
    );
    expect(await databaseExists(admin, sourceName)).toBe(true);
  });
});

describe("sweeping the per-process template of a running JVM test process", () => {
  it(
    "skips the template under the process's shared lock and drops it after the process ends",
    dropWait,
    async () => {
      await dropLocalDatabase(admin, jvmTemplateName);
      await admin.query(`CREATE DATABASE ${identifier(jvmTemplateName)}`);
      // `ScratchDatabase.template` holds this lock on a `postgres` session until the process drops
      // the template. No session connects to the template itself, so the session check sees none.
      const jvmProcess = new Client({ connectionString: adminUrl(sourceUrl) });
      await jvmProcess.connect();
      try {
        await jvmProcess.query("SELECT pg_advisory_lock_shared(hashtextextended($1, 0))", [
          jvmTemplateName,
        ]);
        const inventory = (await readDatabaseInventory(admin)).filter(
          (entry) => entry.name === jvmTemplateName,
        );
        const plan = planTestDatabaseSweep(inventory, context);
        expect(plan.drop.map((entry) => ({ name: entry.name, kind: entry.kind }))).toEqual([
          { name: jvmTemplateName, kind: "scratch" },
        ]);

        const running = await dropRetiredDatabases(admin, plan, context);

        expect(running.dropped).toEqual([]);
        expect(running.skipped.map((entry) => entry.name)).toEqual([jvmTemplateName]);
        expect(await databaseExists(admin, jvmTemplateName)).toBe(true);

        // A process that stops or crashes ends its session, and PostgreSQL releases the lock.
        await jvmProcess.end();
        const stopped = await dropRetiredDatabases(admin, plan, context);

        expect(stopped.dropped.map((entry) => entry.name)).toEqual([jvmTemplateName]);
        expect(await databaseExists(admin, jvmTemplateName)).toBe(false);
      } finally {
        await jvmProcess.end().catch(() => {});
      }
    },
  );
});

describe("sweeping a schema template that a harness copies", () => {
  it(
    "skips a template under a held shared lock and drops it after the copy",
    dropWait,
    async () => {
      await createEmptyTemplate();
      const harness = new Client({ connectionString: adminUrl(sourceUrl) });
      await harness.connect();
      try {
        // The harness holds this lock from its existence check until its copy ends.
        await harness.query("SELECT pg_advisory_lock_shared(hashtextextended($1, 0))", [
          templateName,
        ]);
        const plan = planTestDatabaseSweep(await templateInventory(), context);
        expect(plan.drop.map((entry) => entry.name)).toEqual([templateName]);

        const held = await dropRetiredDatabases(admin, plan, context);

        expect(held.dropped).toEqual([]);
        expect(held.skipped.map((entry) => entry.name)).toEqual([templateName]);
        expect(await databaseExists(admin, templateName)).toBe(true);

        await harness.query("SELECT pg_advisory_unlock_shared(hashtextextended($1, 0))", [
          templateName,
        ]);
        const released = await dropRetiredDatabases(admin, plan, context);

        expect(released.dropped.map((entry) => entry.name)).toEqual([templateName]);
        expect(await databaseExists(admin, templateName)).toBe(false);
      } finally {
        await harness.end();
      }
    },
  );

  it(
    "makes a copy wait for a sweep that holds the lock, then builds the template again",
    dropWait,
    async () => {
      await createEmptyTemplate();
      const sweep = new Client({ connectionString: adminUrl(sourceUrl) });
      const harness = new Client({ connectionString: adminUrl(sourceUrl) });
      await sweep.connect();
      await harness.connect();
      try {
        // The sweep holds the exclusive lock, as `dropRetiredDatabases` does around its drop.
        await sweep.query("SELECT pg_try_advisory_lock(hashtextextended($1, 0))", [templateName]);
        const installs: string[] = [];
        const copy = copySchemaTemplate(harness, {
          templateName,
          targetName: copyName,
          dropDatabase: (name) => dropLocalDatabase(harness, name),
          async install(stagingName) {
            installs.push(stagingName);
            const staging = new Client({ connectionString: databaseUrl(sourceUrl, stagingName) });
            await staging.connect();
            try {
              await staging.query("CREATE TABLE template_marker (id integer)");
            } finally {
              await staging.end();
            }
          },
        });
        await waitForAdvisoryLockWaiter(harness);

        await sweep.query(`DROP DATABASE ${identifier(templateName)}`);
        await sweep.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [templateName]);
        await copy;

        expect(installs).toEqual([`${templateName}_building`]);
        expect(await databaseExists(admin, templateName)).toBe(true);
        expect(await databaseExists(admin, copyName)).toBe(true);
        const copied = new Client({ connectionString: databaseUrl(sourceUrl, copyName) });
        await copied.connect();
        try {
          const marker = await copied.query("SELECT to_regclass('template_marker') AS marker");
          expect(marker.rows[0].marker).toBe("template_marker");
        } finally {
          await copied.end();
        }
      } finally {
        await sweep.end();
        await harness.end();
      }
    },
  );
});

describe("sweeping while the harness copies a template", () => {
  it("skips the template between the existence check and the copy", dropWait, async () => {
    await createEmptyTemplate();
    const harness = new Client({ connectionString: adminUrl(sourceUrl) });
    await harness.connect();
    try {
      let reachedCopy!: () => void;
      const copyReached = new Promise<void>((resolve) => {
        reachedCopy = resolve;
      });
      let resumeCopy!: () => void;
      const copyResumed = new Promise<void>((resolve) => {
        resumeCopy = resolve;
      });
      const copy = copySchemaTemplate(harness, {
        templateName,
        targetName: copyName,
        // The harness drops the target right before `CREATE DATABASE ... TEMPLATE`, after its
        // existence check, so this pause is the moment a concurrent drop breaks the copy.
        async dropDatabase(name) {
          await dropLocalDatabase(harness, name);
          if (name !== copyName) return;
          reachedCopy();
          await copyResumed;
        },
        install: () => Promise.reject(new Error("The template exists, so no build runs")),
      });
      await copyReached;

      const plan = planTestDatabaseSweep(await templateInventory(), context);
      const outcome = await dropRetiredDatabases(admin, plan, context);
      resumeCopy();
      await copy;

      expect(plan.drop.map((entry) => entry.name)).toEqual([templateName]);
      expect(outcome.skipped.map((entry) => entry.name)).toEqual([templateName]);
      expect(await databaseExists(admin, templateName)).toBe(true);
      expect(await databaseExists(admin, copyName)).toBe(true);
    } finally {
      await harness.end();
    }
  });
});

/** Start each template test from an empty template and no copy. */
async function createEmptyTemplate(): Promise<void> {
  for (const name of [copyName, `${templateName}_building`, templateName]) {
    await dropLocalDatabase(admin, name);
  }
  await admin.query(`CREATE DATABASE ${identifier(templateName)}`);
}

async function templateInventory() {
  return (await readDatabaseInventory(admin)).filter((entry) => entry.name === templateName);
}

/** Wait until the harness session waits for an advisory lock, so the order of the steps is fixed. */
async function waitForAdvisoryLockWaiter(harness: Client): Promise<void> {
  const pid = (harness as unknown as { processID: number }).processID;
  for (let attempt = 0; attempt < 500; attempt++) {
    const waiting = await admin.query(
      "SELECT 1 FROM pg_locks WHERE pid = $1 AND locktype = 'advisory' AND NOT granted",
      [pid],
    );
    if (waiting.rowCount === 1) return;
    await sleep(10);
  }
  throw new Error("The harness never waited for the template lock");
}

async function databaseExists(pool: Pool, name: string): Promise<boolean> {
  const result = await pool.query("SELECT 1 FROM pg_database WHERE datname = $1", [name]);
  return result.rowCount === 1;
}

function adminUrl(url: string): string {
  return databaseUrl(url, "postgres");
}

function databaseUrl(url: string, name: string): string {
  const target = new URL(url);
  target.pathname = `/${name}`;
  return target.toString();
}

function identifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}
