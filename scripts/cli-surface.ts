import path from "node:path";
import { pathToFileURL } from "node:url";

import ts from "typescript";

import { repositoryRoot } from "./packages.js";
import {
  compare,
  declarationProgram,
  DeclarationCollector,
  renderBlocks,
  requireSourceFile,
} from "./typescript-declarations.js";

/**
 * The `workhorse` CLI surface, read from the declaration the CLI itself consumes.
 *
 * ADR 0054 governs the command set, the flag set, what each exit code means, and the fields of
 * every `--json` payload. The CLI's human-readable prose is not governed, so none of it is read
 * here: a script reads `--json`, and a person reads the help.
 *
 * `typescript/core/src/cli/surface.ts` declares all four, and the CLI dispatches, parses, and
 * serializes through that declaration. So this module reads the declaration twice, once for each
 * half of what it carries. The commands, options, and exit codes are values, so they are read by
 * importing the built module. The payload types are types, so they are read from the built
 * declarations with the TypeScript compiler, and each one's shape is printed through the same
 * renderer `api/typescript.txt` uses.
 *
 * `scripts/generate-cli-surface.ts` writes the rendering to `api/cli.txt`.
 */

const surfaceModule = "typescript/core/dist/src/cli/surface.js";
const surfaceDeclarations = "typescript/core/dist/src/cli/surface.d.ts";
const payloadInterface = "CliJsonPayloads";

/** One option, in the shape `node:util`'s `parseArgs` takes. */
interface OptionDefinition {
  readonly type: "string" | "boolean";
  readonly short?: string;
  readonly multiple?: boolean;
}

interface CliCommand {
  readonly name: string;
  readonly positionals: readonly string[];
}

interface AdminCommand {
  readonly name: string;
  readonly mutates: boolean;
  readonly positionals: readonly string[];
}

interface ExitCode {
  readonly code: number;
  readonly meaning: string;
}

interface SurfaceModule {
  readonly CLI_OPTIONS: Readonly<Record<string, Readonly<Record<string, OptionDefinition>>>>;
  readonly CLI_COMMANDS: readonly CliCommand[];
  readonly ADMIN_COMMANDS: readonly AdminCommand[];
  readonly CLI_EXIT_CODES: readonly ExitCode[];
}

/** One `--json` command and the type its payload is declared as. */
interface JsonPayload {
  /** The command an operator types, for example `admin jobs`. */
  readonly command: string;
  /** The declared type, as `surface.ts` writes it, for example `readonly JobWait[] | JobWait`. */
  readonly type: string;
}

/**
 * What the options section says before listing the sets.
 *
 * A set is named for the command that parses with it, and two of them belong to no command:
 * `workhorse` and `schema` are the bare forms that only print help.
 */
const optionsNote = [
  "# One set per command, named for it. Every admin subcommand parses through the admin set,",
  "# because admin parses before it knows which subcommand ran. The workhorse and schema sets",
  "# belong to the bare forms, which print help and run nothing.",
].join("\n");

/** A command with its positionals, as an operator types it. */
function usage(name: string, positionals: readonly string[]): string {
  return [name, ...positionals.map((positional) => `<${positional}>`)].join(" ");
}

/** One option as the snapshot states it: the long flag, its short form, and what it takes. */
function renderOption(name: string, definition: OptionDefinition): string {
  const flag = definition.short === undefined ? `--${name}` : `--${name}, -${definition.short}`;
  const value = definition.type === "boolean" ? "" : ` <${definition.type}>`;
  const repeatable = definition.multiple === true ? "  (repeatable)" : "";
  return `${flag}${value}${repeatable}`;
}

function renderOptionSets(options: SurfaceModule["CLI_OPTIONS"]): string {
  return Object.entries(options)
    .toSorted(([left], [right]) => compare(left, right))
    .map(([set, definitions]) => {
      const lines = Object.entries(definitions)
        .toSorted(([left], [right]) => compare(left, right))
        .map(([name, definition]) => renderOption(name, definition));
      return `### ${set}\n\n${lines.join("\n")}\n`;
    })
    .join("\n");
}

/**
 * The payload type of every `--json` command, in the order `CliJsonPayloads` declares them.
 *
 * Each type is recorded with the collector as it is read, so the closure prints its shape and the
 * shape of everything it reaches. The declared order is kept rather than sorted, because it groups
 * a command with its siblings and a reordering there is not a change to the surface.
 */
function readPayloads(collector: DeclarationCollector, source: ts.SourceFile): JsonPayload[] {
  const declaration = source.statements.find(
    (statement): statement is ts.InterfaceDeclaration =>
      ts.isInterfaceDeclaration(statement) && statement.name.text === payloadInterface,
  );
  if (!declaration) {
    throw new Error(`${surfaceDeclarations} no longer declares ${payloadInterface}`);
  }
  return declaration.members.flatMap((member) => {
    if (!ts.isPropertySignature(member) || member.type === undefined) return [];
    collector.recordReferences(member.type);
    return [
      {
        command: ts.isStringLiteralLike(member.name) ? member.name.text : member.name.getText(),
        type: member.type.getText(),
      },
    ];
  });
}

function renderPayloads(payloads: readonly JsonPayload[]): string {
  const width = Math.max(...payloads.map((payload) => payload.command.length));
  return payloads.map((payload) => `${payload.command.padEnd(width)}  ${payload.type}`).join("\n");
}

/** Read the whole surface and render it. */
export async function renderCliSurface(): Promise<string> {
  const module = (await import(
    pathToFileURL(path.join(repositoryRoot, surfaceModule)).href
  )) as SurfaceModule;
  const declarations = path.join(repositoryRoot, surfaceDeclarations);
  const program = declarationProgram([declarations]);
  const collector = new DeclarationCollector(program.getTypeChecker());
  const payloads = readPayloads(collector, requireSourceFile(program, declarations));
  collector.closeOver();

  const commands = module.CLI_COMMANDS.map((command) => usage(command.name, command.positionals));
  const admin = module.ADMIN_COMMANDS.map(
    (command) =>
      `${usage(command.name, command.positionals)}  ${command.mutates ? "mutates" : "read-only"}`,
  );
  const exitCodes = module.CLI_EXIT_CODES.map(
    (entry) => `${String(entry.code).padStart(2)}  ${entry.meaning}`,
  );

  return [
    `## Commands\n\n${commands.join("\n")}\n`,
    `## admin subcommands\n\n${admin.join("\n")}\n`,
    `## Options\n\n${optionsNote}\n\n${renderOptionSets(module.CLI_OPTIONS)}`,
    `## Exit codes\n\n${exitCodes.join("\n")}\n`,
    `## --json payloads\n\n${renderPayloads(payloads)}\n`,
    `## Payload types\n\n${renderBlocks(collector.declarations)}\n`,
  ].join("\n");
}
