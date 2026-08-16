import { spawnSync } from "node:child_process";
import path from "node:path";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { WORKHORSE_SCHEMA_VERSION } from "../src/schema.js";
import { createIntegrationTestContext } from "./support/integration.js";

const repository = path.resolve(import.meta.dirname, "../../..");
const cli = path.join(repository, "typescript/core/src/cli/workhorse.ts");
const tsxCli = createRequire(import.meta.url).resolve("tsx/cli");
const { databaseUrl, pool } = createIntegrationTestContext(import.meta.url);

function runCli(args: readonly string[]) {
  const result = spawnSync(process.execPath, [tsxCli, cli, ...args], {
    cwd: repository,
    env: process.env,
    encoding: "utf8",
  });
  if (result.error) throw result.error;
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe("database CLI output", () => {
  it("emits separate current-schema and PostgreSQL support fields", () => {
    const result = runCli([
      "schema",
      "status",
      `--database-url=${databaseUrl}`,
      "--database",
      "bench",
      "--json",
    ]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      schema: {
        installedVersion: WORKHORSE_SCHEMA_VERSION,
        expectedVersion: WORKHORSE_SCHEMA_VERSION,
        state: "current",
      },
      postgres: {
        supported: true,
        tested: true,
        level: "supported-tested",
      },
    });
  });

  it("emits schema drift independently and exits with a runtime failure", async () => {
    await pool.query("UPDATE workhorse.schema_version SET version = $1", [
      WORKHORSE_SCHEMA_VERSION - 1,
    ]);
    try {
      const result = runCli(["schema", "status", "--database-url", databaseUrl, "--json"]);
      expect(result.code).toBe(1);
      expect(JSON.parse(result.stdout)).toMatchObject({
        schema: {
          installedVersion: WORKHORSE_SCHEMA_VERSION - 1,
          expectedVersion: WORKHORSE_SCHEMA_VERSION,
          state: "drift",
        },
        postgres: { supported: true },
      });
    } finally {
      await pool.query("UPDATE workhorse.schema_version SET version = $1", [
        WORKHORSE_SCHEMA_VERSION,
      ]);
    }
  });

  it("emits the QueueHealth shape with --json", () => {
    const result = runCli(["health", "--database-url", databaseUrl, "--json"]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: { level: "healthy", reasons: [] },
      observations: expect.any(Object),
    });
  });
});
