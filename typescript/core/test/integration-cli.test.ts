import { spawnSync } from "node:child_process";
import path from "node:path";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { MINIMUM_SCHEMA_VERSION, WORKHORSE_SCHEMA_VERSION } from "../src/schema.js";
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
  it("leaves an already-current schema unchanged through schema migrate", () => {
    const result = runCli(["schema", "migrate", `--database-url=${databaseUrl}`]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(
      `Workhorse schema v${WORKHORSE_SCHEMA_VERSION} is already current.`,
    );
  });

  it("emits separate current-schema and PostgreSQL support fields", () => {
    const result = runCli(["schema", "status", `--database-url=${databaseUrl}`, "--json"]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      schema: {
        installedVersion: WORKHORSE_SCHEMA_VERSION,
        expectedVersion: WORKHORSE_SCHEMA_VERSION,
        state: "current",
        installedProtocolVersions: [1],
      },
      postgres: {
        supported: true,
        tested: true,
        level: "supported-tested",
      },
    });
  });

  async function withInstalledVersion(
    version: number,
    assertions: (result: ReturnType<typeof runCli>) => void,
  ): Promise<void> {
    await pool.query("UPDATE workhorse.schema_version SET version = $1", [version]);
    try {
      assertions(runCli(["schema", "status", "--database-url", databaseUrl, "--json"]));
    } finally {
      await pool.query("UPDATE workhorse.schema_version SET version = $1", [
        WORKHORSE_SCHEMA_VERSION,
      ]);
    }
  }

  it("refuses a schema below this runtime's floor and exits with a runtime failure", async () => {
    await withInstalledVersion(MINIMUM_SCHEMA_VERSION - 1, (result) => {
      expect(result.code).toBe(1);
      expect(JSON.parse(result.stdout)).toMatchObject({
        schema: {
          installedVersion: MINIMUM_SCHEMA_VERSION - 1,
          expectedVersion: WORKHORSE_SCHEMA_VERSION,
          state: "behind",
          compatible: false,
        },
        postgres: { supported: true },
      });
    });
  });

  // A deployment gate that failed here would fail every rolling upgrade: the migration runs first,
  // so processes from the previous release meet a schema ahead of them until the rollout finishes.
  it("accepts a schema ahead of this build and exits successfully", async () => {
    await withInstalledVersion(WORKHORSE_SCHEMA_VERSION + 1, (result) => {
      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        schema: {
          installedVersion: WORKHORSE_SCHEMA_VERSION + 1,
          state: "ahead",
          compatible: true,
          refusal: null,
        },
      });
    });
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
