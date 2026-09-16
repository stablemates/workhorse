import { Client, Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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

// Two databases shaped exactly like the scratch databases `test/support/db.ts` creates. One is
// abandoned, as a timed-out teardown leaves it; the other stands in for a suite still running.
const sourceUrl = localDatabaseUrl("test");
const sourceName = databaseName(sourceUrl);
const leakedName = `${sourceName.slice(0, 52)}_5b0eafed01`;
const liveName = `${sourceName.slice(0, 52)}_5b0eafed02`;

const protectedNames = new Set([...checkoutDatabaseNames(process.env), sourceName]);
const context: SweepContext = {
  protectedNames,
  familyRoots: testFamilyRoots(protectedNames),
  currentTemplate: "workhorse_test_template_absent_00000000",
};

let admin: Pool;
let liveSession: Client;

beforeAll(async () => {
  assertSweepTarget(sourceUrl);
  admin = new Pool({ connectionString: adminUrl(sourceUrl), max: 1 });
  for (const name of [leakedName, liveName]) {
    await admin.query(`DROP DATABASE IF EXISTS ${identifier(name)} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${identifier(name)}`);
  }
  liveSession = new Client({ connectionString: databaseUrl(sourceUrl, liveName) });
  await liveSession.connect();
});

afterAll(async () => {
  if (liveSession) await liveSession.end();
  for (const name of [leakedName, liveName]) {
    await admin.query(`DROP DATABASE IF EXISTS ${identifier(name)} WITH (FORCE)`);
  }
  await admin.end();
});

describe("sweeping leaked scratch databases", () => {
  it("drops the abandoned database and leaves the one a session holds", async () => {
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
