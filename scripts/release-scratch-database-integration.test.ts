import { spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as sleep } from "node:timers/promises";
import { Client, Pool } from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { dropLocalDatabase } from "../typescript/core/src/drop-local-database.js";
import { databaseName, localDatabaseUrl } from "../typescript/core/src/local-database.js";
import { scratchDatabaseName as dotnetScratchName } from "./check-dotnet-release.js";
import { scratchDatabaseName as jvmScratchName } from "./check-jvm-release.js";
import { scratchDatabaseName as rubyScratchName } from "./check-ruby-release.js";
import { scratchDatabaseName as rustScratchName } from "./check-rust-release.js";
import { withReleaseScratchDatabase } from "./release-scratch-database.js";
import {
  assertSweepTarget,
  checkoutDatabaseNames,
  classifyTestDatabase,
  dropRetiredDatabases,
  planTestDatabaseSweep,
  readDatabaseInventory,
  type SweepContext,
  testFamilyRoots,
} from "./test-database-sweep.js";

const sourceUrl = localDatabaseUrl("test");
const sourceName = databaseName(sourceUrl);
const protectedNames = new Set([...checkoutDatabaseNames(process.env), sourceName]);
const context: SweepContext = {
  protectedNames,
  familyRoots: testFamilyRoots(protectedNames),
  liveTemplates: new Set(),
};

// Each release check names its scratch database from the process ID. A number above every process
// ID of the host, derived from this process ID, keeps the names apart from a running release check
// and from another run of this test.
const testPid = (check: number) => 1_000_000_000 + process.pid * 10 + check;
const checks = [
  { check: "dotnet", name: dotnetScratchName(sourceName, testPid(1)) },
  { check: "jvm", name: jvmScratchName(sourceName, testPid(2)) },
  { check: "ruby", name: rubyScratchName(sourceName, testPid(3)) },
  { check: "rust", name: rustScratchName(sourceName, testPid(4)) },
];
const crashedName = rubyScratchName(sourceName, testPid(5));

// A test creates, installs, and drops a database, and each drop waits for a checkpoint.
const dropWait = { timeout: inject("databaseHookTimeout") };

let admin: Pool;

beforeAll(() => {
  assertSweepTarget(sourceUrl);
  admin = new Pool({ connectionString: withDatabase(sourceUrl, "postgres"), max: 1 });
});

afterAll(async () => {
  for (const name of [...checks.map((entry) => entry.name), crashedName]) {
    await dropLocalDatabase(admin, name);
  }
  await admin.end();
});

describe("the scratch database of a release check", () => {
  it.each(checks)("holds the sweep lease of the $check check", dropWait, async ({ name }) => {
    expect(classifyTestDatabase(name, context)).toEqual({ kind: "scratch", retired: true });

    await withReleaseScratchDatabase(sourceUrl, name, async (scratchUrl) => {
      expect(databaseName(scratchUrl)).toBe(name);
      // The consumer of the check has no session on the database yet. The sweep takes the
      // exclusive lock of the name with no wait before it drops a scratch database.
      expect(await sweepCanLock(name)).toBe(false);
    });

    expect(await databaseExists(name)).toBe(false);
    expect(await sweepCanLock(name)).toBe(true);
  });

  it("stays removable by the sweep after the check crashes", dropWait, async () => {
    const helper = new URL("release-scratch-database.ts", import.meta.url);
    const child = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "--eval",
        `import { withReleaseScratchDatabase } from ${JSON.stringify(helper.href)};
         await withReleaseScratchDatabase(process.argv[1], process.argv[2], async () => {
           console.log("ready");
           await new Promise(() => {});
         });`,
        sourceUrl,
        crashedName,
      ],
      { stdio: ["ignore", "pipe", "inherit"] },
    );
    try {
      await once(child.stdout, "data");
      expect(await sweepCanLock(crashedName)).toBe(false);
    } finally {
      child.kill("SIGKILL");
      await once(child, "exit");
    }

    // PostgreSQL ends the sessions of the stopped process and its lease, so the sweep drops it.
    const plan = await waitForUnheldPlan(crashedName);
    const outcome = await dropRetiredDatabases(admin, plan, context);

    expect(outcome.dropped.map((entry) => entry.name)).toEqual([crashedName]);
    expect(await databaseExists(crashedName)).toBe(false);
  });
});

async function sweepCanLock(name: string): Promise<boolean> {
  const sweep = new Client({ connectionString: withDatabase(sourceUrl, "postgres") });
  await sweep.connect();
  try {
    const { rows } = await sweep.query<{ locked: boolean }>(
      "SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked",
      [name],
    );
    return rows[0]!.locked;
  } finally {
    await sweep.end();
  }
}

/** The sweep plan of `name`, after the backends of the stopped process exit. */
async function waitForUnheldPlan(name: string) {
  for (let attempt = 1; ; attempt++) {
    const inventory = (await readDatabaseInventory(admin)).filter((entry) => entry.name === name);
    const plan = planTestDatabaseSweep(inventory, context);
    if (plan.drop.length === 1 || attempt >= 100) return plan;
    await sleep(50);
  }
}

async function databaseExists(name: string): Promise<boolean> {
  const { rowCount } = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [name]);
  return rowCount === 1;
}

function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}
