import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  ADMIN_COMMANDS,
  CLI_COMMANDS,
  CLI_OPTIONS,
  type AdminCommandName,
  type CliCommandName,
  type CliJsonPayloads,
} from "../src/cli/surface.js";

/**
 * `typescript/core/src/cli/surface.ts` against the CLI it describes.
 *
 * The declaration is what `api/cli.txt` is generated from, so a snapshot that cannot notice a
 * rename is not a check. Most of that is held by construction: dispatch admits the names the table
 * holds, each `parseCommandArgs` call takes its options from it, and each `--json` writer states
 * its payload as the type it declares, so a rename stops the CLI compiling or running. Two things
 * construction cannot hold are checked here. Every declared command and flag is actually reachable
 * through the real binary, and every `--json` key names a real command.
 *
 * Each run passes `--help`, which every command prints after parsing and before touching a
 * database, so the flags are exercised without one.
 */

const repository = path.resolve(import.meta.dirname, "../../..");
const cli = path.join(repository, "typescript/core/src/cli/workhorse.ts");
const tsxCli = createRequire(import.meta.url).resolve("tsx/cli");

/** Stands in for any positional or option value. `--help` returns before one is validated. */
const sample = "sample";

function runCli(args: readonly string[]) {
  const result = spawnSync(process.execPath, [tsxCli, cli, ...args], {
    cwd: repository,
    env: { ...process.env, DATABASE_URL: undefined, WORKHORSE_DATABASE_URL: undefined },
    encoding: "utf8",
  });
  if (result.error) throw result.error;
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** Every declared flag of one option set, with a value for each that takes one. */
function flagsOf(set: keyof typeof CLI_OPTIONS): string[] {
  return Object.entries(CLI_OPTIONS[set]).flatMap(([name, definition]) =>
    definition.type === "boolean" ? [`--${name}`] : [`--${name}`, sample],
  );
}

/**
 * Whether every `--json` key names a command.
 *
 * The keys are strings the compiler cannot check on its own, so a typo would put a command in
 * `api/cli.txt` that no operator can run. This assignment is the check: it fails to compile when a
 * key is neither a declared command nor `admin` and a declared subcommand.
 */
type JsonKeysNameCommands = keyof CliJsonPayloads extends
  | CliCommandName
  | `admin ${AdminCommandName}`
  ? true
  : never;
const jsonKeysNameCommands: JsonKeysNameCommands = true;

describe("the declared CLI surface", () => {
  it("declares the nine commands ADR 0054 governs", () => {
    expect(CLI_COMMANDS.map((command) => command.name)).toEqual([
      "init",
      "schema install",
      "schema migrate",
      "schema status",
      "worker",
      "dashboard",
      "admin",
      "tui",
      "health",
    ]);
  });

  it.each(CLI_COMMANDS.map((command) => command.name))("accepts every %s flag", (name) => {
    // `admin` parses nothing until it has a subcommand, so it is exercised through one.
    const words = name === "admin" ? ["admin", "jobs"] : name.split(" ");
    const result = runCli([...words, ...flagsOf(name), "--help"]);
    expect({ name, code: result.code, stderr: result.stderr }).toEqual({
      name,
      code: 0,
      stderr: "",
    });
    expect(result.stdout).not.toBe("");
  });

  it.each(ADMIN_COMMANDS.map((command) => [command.name, command.positionals] as const))(
    "reaches admin %s",
    (name, positionals) => {
      const result = runCli(["admin", name, ...positionals.map(() => sample), "--help"]);
      expect({ name, code: result.code, stderr: result.stderr }).toEqual({
        name,
        code: 0,
        stderr: "",
      });
    },
  );

  it("names only declared commands in the --json table", () => {
    expect(jsonKeysNameCommands).toBe(true);
  });

  it("refuses a name the table does not declare", () => {
    const result = runCli(["notacommand"]);
    expect(result.code).toBe(64);
    expect(result.stderr).toContain("Unknown command: notacommand");
  });
});
