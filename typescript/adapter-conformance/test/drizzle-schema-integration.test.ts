import { createDrizzleAdapter } from "@stablemates/workhorse-drizzle";
import { installSchema, readSchemaVersion, WORKHORSE_SCHEMA_VERSION } from "@stablemates/workhorse";
import { drizzle } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabaseTestHarness } from "../../core/test/support/db.js";

// SM-997: the schema script carries $N inside function bodies and holds many statements, so
// installing it through Drizzle exercises both the lexical scanner and the multi-result shape.

const database = createDatabaseTestHarness(import.meta.url, { max: 2 });
const adapter = createDrizzleAdapter(drizzle({ client: database.pool }));

beforeAll(async () => {
  await database.setup();
});

afterAll(async () => {
  await database.teardown();
});

describe("Drizzle adapter over node-postgres", () => {
  it("returns the last statement's rows from a parameter-free script", async () => {
    await expect(
      adapter.database.query("SELECT 1 AS first; SELECT 2 AS second"),
    ).resolves.toMatchObject({ rows: [{ second: 2 }] });
  });

  it("installs the schema", async () => {
    await database.pool.query("DROP SCHEMA workhorse CASCADE");

    await installSchema(adapter.database);

    expect(await readSchemaVersion(database.pool)).toBe(WORKHORSE_SCHEMA_VERSION);
  });
});
