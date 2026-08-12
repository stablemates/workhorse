import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  migrateSchema,
  readSchemaVersion,
  WORKHORSE_SCHEMA_BASELINE_VERSION,
  WORKHORSE_SCHEMA_VERSION,
} from "../src/index.js";
import { createDatabaseTestHarness } from "./support/db.js";

const database = createDatabaseTestHarness(import.meta.url);
const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("schema migrations", () => {
  beforeAll(async () => {
    await database.setup();
  });

  afterAll(async () => {
    await database.teardown();
  });

  it("starts after the declared baseline and has no version gaps", async () => {
    const directory = path.join(repository, "sql", "migrations");
    const files = await readdir(directory);
    const versions = files.map((file) => Number.parseInt(file.slice(0, 4), 10));

    expect(Math.min(...versions)).toBe(WORKHORSE_SCHEMA_BASELINE_VERSION + 1);
    expect(Math.max(...versions)).toBe(WORKHORSE_SCHEMA_VERSION);
    expect(new Set(versions)).toEqual(
      new Set(
        Array.from(
          { length: WORKHORSE_SCHEMA_VERSION - WORKHORSE_SCHEMA_BASELINE_VERSION },
          (_, index) => WORKHORSE_SCHEMA_BASELINE_VERSION + index + 1,
        ),
      ),
    );

    for (const file of files) {
      const sql = await readFile(path.join(directory, file), "utf8");
      const functionNames = [
        ...sql.matchAll(/CREATE(?: OR REPLACE)? FUNCTION workhorse\.([a-z0-9_]+)/g),
      ].map((match) => match[1]);
      expect(functionNames.filter((name) => !/_v\d+$/.test(name ?? ""))).toEqual([]);
    }
  });

  it("migrates the supported v23 baseline to the current schema", async () => {
    await database.pool.query(`
      DROP TABLE workhorse.schema_migration;
      DELETE FROM workhorse.schema_version;
      INSERT INTO workhorse.schema_version(version) VALUES (23);
    `);

    await migrateSchema(database.pool);

    expect(await readSchemaVersion(database.pool)).toBe(24);
    const migrations = await database.pool.query<{ version: number; description: string }>(
      "SELECT version, description FROM workhorse.schema_migration ORDER BY version",
    );
    expect(migrations.rows).toEqual([
      { version: 23, description: "forward migration baseline" },
      { version: 24, description: "add schema migration ledger" },
    ]);
  });

  it("leaves an already-current schema unchanged", async () => {
    const before = await database.pool.query<{ applied_at: Date }>(
      "SELECT applied_at FROM workhorse.schema_migration WHERE version = 24",
    );

    await migrateSchema(database.pool);

    const after = await database.pool.query<{ applied_at: Date }>(
      "SELECT applied_at FROM workhorse.schema_migration WHERE version = 24",
    );
    expect(after.rows).toEqual(before.rows);
  });
});
