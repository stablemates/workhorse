import { execFile } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
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
const cleanDatabase = createDatabaseTestHarness(new URL("?clean-install", import.meta.url).href);
const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const executeFile = promisify(execFile);
let cleanInstallSchema: string;

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
    await Promise.all([database.setup(), cleanDatabase.setup()]);
    cleanInstallSchema = await dumpNormalizedSchema(cleanDatabase.databaseUrl);

    const baseline = await readFile(
      path.join(repository, "sql", "schema", "versions", "0023.sql"),
      "utf8",
    );
    await database.pool.query("DROP SCHEMA workhorse CASCADE");
    await database.pool.query(baseline);
    await migrateSchema(database.pool);
  });

  afterAll(async () => {
    await Promise.all([database.teardown(), cleanDatabase.teardown()]);
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
    expect(await readSchemaVersion(database.pool)).toBe(WORKHORSE_SCHEMA_VERSION);
    const migrations = await database.pool.query<{ version: number; description: string }>(
      "SELECT version, description FROM workhorse.schema_migration ORDER BY version",
    );
    expect(migrations.rows).toEqual([
      { version: 23, description: "forward migration baseline" },
      { version: 24, description: "add schema migration ledger" },
      { version: 25, description: "make schedule occurrence replay a no-op" },
      { version: 26, description: "add versioned dashboard read surface" },
      { version: 27, description: "add strict-priority job dispatch" },
      { version: 28, description: "add keyed debounce enqueue" },
      { version: 29, description: "add keyed throttle enqueue" },
      { version: 30, description: "add one-prerequisite job dependencies" },
      { version: 31, description: "add fan-in dependency policies" },
      { version: 32, description: "index dependency failure operations" },
    ]);
  });

  it("produces the same schema through clean installation and forward migration", async () => {
    expect(await dumpNormalizedSchema(database.databaseUrl)).toBe(cleanInstallSchema);
  });

  it("leaves an already-current schema unchanged", async () => {
    const before = await database.pool.query<{ applied_at: Date }>(
      "SELECT applied_at FROM workhorse.schema_migration WHERE version = 32",
    );

    await migrateSchema(database.pool);

    const after = await database.pool.query<{ applied_at: Date }>(
      "SELECT applied_at FROM workhorse.schema_migration WHERE version = 32",
    );
    expect(after.rows).toEqual(before.rows);
  });

  it("safely replays the latest migration after its target version commits", async () => {
    const migration = await readFile(
      path.join(repository, "sql", "migrations", "0032-index-dependency-failures.sql"),
      "utf8",
    );

    await database.pool.query(migration);

    expect(await readSchemaVersion(database.pool)).toBe(WORKHORSE_SCHEMA_VERSION);
    expect(await dumpNormalizedSchema(database.databaseUrl)).toBe(cleanInstallSchema);
  });
});
