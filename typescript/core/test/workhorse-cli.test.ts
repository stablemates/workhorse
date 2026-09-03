import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { afterAll, describe, expect, it } from "vitest";
import {
  MINIMUM_SCHEMA_VERSION,
  PROTOCOL_VERSION,
  schemaCompatibilityRefusal,
  WORKHORSE_SCHEMA_VERSION,
} from "../src/schema.js";
import { createSchemaStatusReport, FLEET_EVIDENCE_NOTE } from "../src/cli/schema-status.js";

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
    [["schema", "migrate", "--unknown"], "--unknown"],
    [["schema", "status", "--unknown"], "--unknown"],
    [["worker", "--unknown"], "--unknown"],
    [["dashboard", "--unknown"], "--unknown"],
    [["admin", "jobs", "--unknown"], "--unknown"],
    [["tui", "--unknown"], "--unknown"],
    [["health", "--unknown"], "--unknown"],
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
    [["schema", "migrate", "--help"], "Usage: workhorse schema migrate"],
    [["schema", "status", "--help"], "Usage: workhorse schema status"],
    [["worker", "--help"], "Usage: workhorse worker"],
    [["dashboard", "--help"], "Usage: workhorse dashboard"],
    [["admin", "--help"], "Usage: workhorse admin"],
    [["admin"], "Usage: workhorse admin"],
    [["admin", "jobs", "--help"], "Usage: workhorse admin"],
    [["tui", "--help"], "Usage: workhorse tui"],
    [["health", "--help"], "Usage: workhorse health"],
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

  it("rejects options after an argument terminator as positionals", () => {
    const result = runCli(["schema", "status", "--", "--help"]);
    expect(result.code).toBe(64);
    expect(result.stderr).toContain("Unexpected schema status argument: --help");
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

  it("rejects an empty explicit database URL instead of falling back to the environment", () => {
    const result = runCli(["schema", "status", "--database-url="]);
    expect(result.code).toBe(64);
    expect(result.stderr).toContain("--database-url requires a value");
  });
});

const supportedPostgres = {
  major: 17,
  version: "17.2",
  supported: true,
  tested: true,
} as const;

describe("schema status JSON", () => {
  it("reports a schema below the runtime's floor as incompatible", () => {
    expect(
      createSchemaStatusReport(
        MINIMUM_SCHEMA_VERSION - 1,
        [PROTOCOL_VERSION],
        supportedPostgres,
        [],
      ),
    ).toEqual({
      schema: {
        installedVersion: MINIMUM_SCHEMA_VERSION - 1,
        expectedVersion: WORKHORSE_SCHEMA_VERSION,
        minimumVersion: MINIMUM_SCHEMA_VERSION,
        clientProtocolVersion: PROTOCOL_VERSION,
        installedProtocolVersions: [PROTOCOL_VERSION],
        state: "behind",
        compatible: false,
        refusal: expect.stringContaining("below the minimum"),
        refusalCode: "schema-too-old",
      },
      fleet: { clientProtocolVersions: [], note: FLEET_EVIDENCE_NOTE },
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

  // The whole point of the additive rule: a node still running the old release meets a schema the
  // new release migrated past, and keeps working.
  it("accepts a schema ahead of this build inside the same major line", () => {
    expect(
      createSchemaStatusReport(
        WORKHORSE_SCHEMA_VERSION + 1,
        [PROTOCOL_VERSION],
        supportedPostgres,
        [],
      ),
    ).toMatchObject({
      schema: { state: "ahead", compatible: true, refusal: null, refusalCode: null },
    });
  });

  it("refuses a schema that no longer serves this runtime's protocol", () => {
    expect(
      createSchemaStatusReport(
        WORKHORSE_SCHEMA_VERSION + 4,
        [PROTOCOL_VERSION + 1],
        supportedPostgres,
        [],
      ),
    ).toMatchObject({
      schema: {
        state: "ahead",
        compatible: false,
        refusal: expect.stringContaining("no longer serves protocol"),
        refusalCode: "schema-too-new",
      },
    });
  });

  it("reports a missing schema without calling it drift", () => {
    expect(createSchemaStatusReport(null, null, supportedPostgres, null)).toMatchObject({
      schema: {
        installedVersion: null,
        state: "not-installed",
        compatible: false,
        refusal: expect.stringContaining("No Workhorse schema is installed"),
        refusalCode: "schema-not-installed",
      },
      // A database with no registry cannot be asked what its fleet speaks, and reporting an empty
      // fleet would read as "nothing is running" rather than "nothing was asked". A schema too old
      // to hold the columns reaches the same field the same way.
      fleet: null,
    });
  });

  // The counts gate a step that stops every process speaking the removed protocol, so the caveat
  // travels in the payload instead of relying on the operator having read the manual.
  it("carries the reason the worker counts are not an inventory", () => {
    const report = createSchemaStatusReport(
      WORKHORSE_SCHEMA_VERSION,
      [PROTOCOL_VERSION],
      supportedPostgres,
      [
        { version: PROTOCOL_VERSION, workers: 3 },
        { version: null, workers: 1 },
      ],
    );

    expect(report.fleet).toEqual({
      clientProtocolVersions: [
        { version: PROTOCOL_VERSION, workers: 3 },
        { version: null, workers: 1 },
      ],
      note: FLEET_EVIDENCE_NOTE,
    });
    expect(report.fleet?.note).toContain("Producers do not");
  });

  it("represents unsupported PostgreSQL separately from a current schema", () => {
    expect(
      createSchemaStatusReport(
        WORKHORSE_SCHEMA_VERSION,
        [PROTOCOL_VERSION],
        { major: 14, version: "14.12", supported: false, tested: false },
        [],
      ),
    ).toMatchObject({
      schema: { state: "current", compatible: true, installedProtocolVersions: [PROTOCOL_VERSION] },
      postgres: { supported: false, level: "unsupported" },
    });
  });

  // One sentence, two readers: the deployment gate that runs "schema status" and the process that
  // starts after it must not disagree about the same database.
  it("prints the sentence the runtime itself would throw", () => {
    const report = createSchemaStatusReport(
      MINIMUM_SCHEMA_VERSION - 1,
      [PROTOCOL_VERSION],
      supportedPostgres,
      [],
    );

    const refusal = schemaCompatibilityRefusal({
      schemaVersion: MINIMUM_SCHEMA_VERSION - 1,
      servedProtocolVersions: [PROTOCOL_VERSION],
    });

    expect(report.schema.refusal).toBe(refusal?.message);
    expect(report.schema.refusalCode).toBe(refusal?.code);
  });
});
