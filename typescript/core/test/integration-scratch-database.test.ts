import { createHash } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import { databaseName, localDatabaseUrl, namedTestDatabaseUrl } from "../src/local-database.js";
import { createDatabaseTestHarness, dropTestDatabase, ensureTestDatabase } from "./support/db.js";

// A host I/O stall can make a WAL flush take seconds, so a commit in a test does not wait for it
// (SM-1809). A new session of each kind of scratch database takes the setting.
const copied = createDatabaseTestHarness(import.meta.url);
const installed = createDatabaseTestHarness(import.meta.url, {
  schemaProvisioning: "install",
  nameSuffix: scratchSuffix("install"),
});
const ensuredUrl = namedTestDatabaseUrl(localDatabaseUrl("test"), scratchSuffix("ensure"));

beforeAll(async () => {
  await copied.setup();
  await installed.setup();
});
afterAll(async () => {
  await copied.teardown();
  await installed.teardown();
  await dropTestDatabase(ensuredUrl, databaseName(ensuredUrl));
});

it("commits without waiting for the WAL flush in a copy of the schema template", async () => {
  expect(await synchronousCommit(copied.pool)).toBe("off");
});

it("commits without waiting for the WAL flush in a database with an installed schema", async () => {
  expect(await synchronousCommit(installed.pool)).toBe("off");
});

it("commits without waiting for the WAL flush in a database that a pooler can carry", async () => {
  await ensureTestDatabase(localDatabaseUrl("test"), databaseName(ensuredUrl));
  const pool = new Pool({ connectionString: ensuredUrl, max: 1 });
  try {
    expect(await synchronousCommit(pool)).toBe("off");
  } finally {
    await pool.end();
  }
});

async function synchronousCommit(connection: Pool): Promise<string | undefined> {
  const result = await connection.query<{ synchronous_commit: string }>("SHOW synchronous_commit");
  return result.rows[0]?.synchronous_commit;
}

/** A per-process name suffix that ends in the digest `pnpm db:sweep` recognizes. */
function scratchSuffix(kind: string): string {
  const digest = createHash("sha256")
    .update(`${import.meta.url}\0${process.pid}\0${kind}`)
    .digest("hex")
    .slice(0, 10);
  return `${kind}_${digest}`;
}
