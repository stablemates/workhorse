import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { afterAll, describe, expect, it } from "vitest";
import { WORKHORSE_SCHEMA_VERSION } from "../src/schema.js";
import { createSchemaStatusReport } from "../src/cli/schema-status.js";

const repository = path.resolve(import.meta.dirname, "../../..");
const cli = path.join(repository, "typescript/core/src/cli/workhorse.ts");
const tsxCli = createRequire(import.meta.url).resolve("tsx/cli");
const scratchRoots: string[] = [];

function runCli(args: readonly string[]) {
  const result = spawnSync(process.execPath, [tsxCli, cli, ...args], {
    cwd: repository,
    env: {
      ...process.env,
      DATABASE_URL: "postgres://unused:unused@127.0.0.1:1/unused",
      WORKHORSE_DATABASE_URL: undefined,
    },
    encoding: "utf8",
  });
  if (result.error) throw result.error;
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

afterAll(async () => {
  await Promise.all(
    scratchRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("workhorse CLI parser", () => {
  it.each([
    [["--unknown"], "--unknown"],
    [["init", "--unknown"], "--unknown"],
    [["schema", "--unknown"], "--unknown"],
    [["schema", "install", "--unknown"], "--unknown"],
    [["schema", "status", "--unknown"], "--unknown"],
    [["worker", "--unknown"], "--unknown"],
    [["dashboard", "--unknown"], "--unknown"],
    [["health", "--unknown"], "--unknown"],
    [["bench", "--unknown"], "--unknown"],
    [["bench", "competitors", "--unknown"], "--unknown"],
  ])("rejects an unknown option in %j", (args, flag) => {
    const result = runCli(args);
    expect(result.code).toBe(64);
    expect(result.stderr).toContain(flag);
  });

  it("uses the usage exit code for a missing option value", () => {
    const result = runCli(["dashboard", "--port"]);
    expect(result.code).toBe(64);
    expect(result.stderr).toContain("--port requires a value");
  });

  it.each([
    [[], "Commands:"],
    [["--help"], "Commands:"],
    [["init", "--help"], "Usage: workhorse init"],
    [["schema", "--help"], "workhorse schema install"],
    [["schema", "install", "--help"], "Usage: workhorse schema install"],
    [["schema", "status", "--help"], "Usage: workhorse schema status"],
    [["worker", "--help"], "Usage: workhorse worker"],
    [["dashboard", "--help"], "Usage: workhorse dashboard"],
    [["health", "--help"], "Usage: workhorse health"],
    [["bench", "--help"], "workhorse bench competitors"],
    [["bench", "competitors", "--help"], "Usage: workhorse bench competitors"],
  ])("prints help without connecting for %j", (args, expected) => {
    const result = runCli(args);
    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(result.stdout).toContain(expected);
  });

  it("accepts separated and equals-form option values", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "workhorse-args-"));
    scratchRoots.push(root);
    const separated = path.join(root, "separated");
    const equals = path.join(root, "equals");
    await Promise.all([mkdir(separated), mkdir(equals)]);

    expect(runCli(["init", "--dir", separated]).code).toBe(0);
    expect(runCli(["init", `--dir=${equals}`]).code).toBe(0);

    await expect(readFile(path.join(separated, "workhorse.config.js"), "utf8")).resolves.toBe(
      await readFile(path.join(equals, "workhorse.config.js"), "utf8"),
    );
  });

  it("prints the package version", async () => {
    const manifest = JSON.parse(
      await readFile(path.join(repository, "typescript/core/package.json"), "utf8"),
    ) as { version: string };
    expect(runCli(["--version"])).toEqual({
      code: 0,
      stdout: `${manifest.version}\n`,
      stderr: "",
    });
  });

  it("ignores an argument terminator forwarded by a package manager", () => {
    const result = runCli(["schema", "status", "--", "--help"]);
    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(result.stdout).toContain("Usage: workhorse schema status");
  });

  it("uses the usage exit code when no database source is available", () => {
    const result = spawnSync(process.execPath, [tsxCli, cli, "schema", "status"], {
      cwd: repository,
      env: { PATH: process.env.PATH ?? "" },
      encoding: "utf8",
    });
    expect(result.status).toBe(64);
    expect(result.stderr).toContain("No database URL");
  });
});

describe("schema status JSON", () => {
  it("represents schema drift separately from supported PostgreSQL", () => {
    expect(
      createSchemaStatusReport(WORKHORSE_SCHEMA_VERSION - 1, {
        major: 17,
        version: "17.2",
        supported: true,
        tested: true,
      }),
    ).toEqual({
      schema: {
        installedVersion: WORKHORSE_SCHEMA_VERSION - 1,
        expectedVersion: WORKHORSE_SCHEMA_VERSION,
        state: "drift",
      },
      postgres: {
        major: 17,
        version: "17.2",
        supported: true,
        tested: true,
        minimumMajor: 15,
        level: "supported-tested",
      },
    });
  });

  it("represents unsupported PostgreSQL separately from a current schema", () => {
    expect(
      createSchemaStatusReport(WORKHORSE_SCHEMA_VERSION, {
        major: 14,
        version: "14.12",
        supported: false,
        tested: false,
      }),
    ).toMatchObject({
      schema: { state: "current" },
      postgres: { supported: false, level: "unsupported" },
    });
  });
});
