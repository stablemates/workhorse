import { readFile } from "node:fs/promises";
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
const adminModule = "typescript/core/dist/src/cli/admin.js";
const formatModule = "typescript/core/dist/src/cli/admin-format.js";
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

/** What `admin.ts` exports for the probe: the command runner, called with silent output. */
interface AdminModule {
  runAdminCommand(
    args: readonly string[],
    io: {
      out(text: string): void;
      error(text: string): void;
      confirm(question: string): Promise<string | null>;
    },
  ): Promise<void>;
}

/** What `admin-format.ts` exports for the encoding table: the writer of every admin payload. */
interface FormatModule {
  toAdminJson(command: string, payload: unknown): string;
}

/** One `--json` command and the type its payload is declared as. */
interface JsonPayload {
  /** The command an operator types, for example `admin tasks`. */
  readonly command: string;
  /** The declared type, as `surface.ts` writes it, for example `readonly TaskWait[] | TaskWait`. */
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

/** What the section of admin flags says before its lines. */
const adminFlagsNote = [
  "# One line for each admin subcommand and each flag that it accepts. The admin set above lists",
  "# the flags that admin parses. A subcommand refuses each flag that has no line here for it.",
].join("\n");

/** What the encoding section says before its lines. */
const encodingNote = [
  "# The payload types below are TypeScript types. The --json writer of each admin subcommand",
  "# writes each value kind that JSON lacks as this line states, in every field, so a script reads",
  "# that JSON type. schema status and health write with JSON.stringify, which writes a Date the",
  "# same way and has no bigint to write.",
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
function readPayloads(
  collector: DeclarationCollector,
  source: ts.SourceFile,
  record: (command: string, type: ts.TypeNode) => void,
): JsonPayload[] {
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
    const command = ts.isStringLiteralLike(member.name) ? member.name.text : member.name.getText();
    record(command, member.type);
    return [{ command, type: member.type.getText() }];
  });
}

function renderPayloads(payloads: readonly JsonPayload[]): string {
  const width = Math.max(...payloads.map((payload) => payload.command.length));
  return payloads.map((payload) => `${payload.command.padEnd(width)}  ${payload.type}`).join("\n");
}

/**
 * A database URL that no server answers. The socket directory does not exist, so a connection
 * fails at once with `ENOENT` and no network traffic.
 */
const unreachableDatabase = "postgresql://probe@/probe?host=/nonexistent-workhorse-cli-probe";

/** A value that each positional accepts, because some positionals must be a UUID. */
const positionalValue = "00000000-0000-4000-8000-000000000000";

/**
 * The flags that a subcommand requires before it opens a connection. They are inputs of the probe,
 * not part of the snapshot: the probe stops if a subcommand still refuses its baseline, so a stale
 * entry fails the generator rather than the snapshot.
 */
const confirmFlags = ["--env", "probe", "--yes"];
const mutationFlags = [...confirmFlags, "--reason", "probe", "--request-id", "probe"];
const requiredFlags: Readonly<Record<string, readonly string[]>> = {
  signal: [...mutationFlags, "--name", "probe", "--payload-json", "{}"],
  "complete-human": [...mutationFlags, "--name", "probe", "--payload-json", "{}"],
  // The tier change records no request id, and the history change records no audit.
  "set-tier": [...confirmFlags, "--reason", "probe", "--tier", "full"],
  "set-history": [...confirmFlags, "--record-attempts", "on"],
};

/** Whether one admin invocation passes argument validation, which is all the probe asks. */
async function passesValidation(
  admin: AdminModule,
  args: readonly string[],
): Promise<{ readonly passes: true } | { readonly passes: false; readonly message: string }> {
  const silent = { out() {}, error() {}, confirm: async () => null };
  const exitCode = process.exitCode;
  try {
    await admin.runAdminCommand(args, silent);
    return { passes: true };
  } catch (error) {
    if (error instanceof Error && error.name === "CliUsageError") {
      return { passes: false, message: error.message };
    }
    return { passes: true };
  } finally {
    process.exitCode = exitCode;
  }
}

/**
 * The flags that each admin subcommand accepts, one line for each pair.
 *
 * Every admin subcommand parses with the one admin option set, and then refuses each flag that does
 * not apply to it. That refusal is in `admin.ts`, not in `surface.ts`. So the probe runs each pair
 * through the built CLI with a database that no server answers. A pair passes when the CLI refuses
 * it for any reason other than `does not support --<flag>`, because then the subcommand accepted the
 * flag and failed later. One line for each pair makes a new flag one arrived line, and a flag that a
 * subcommand stops accepting one gone line.
 */
export async function renderAdminFlags(
  admin: AdminModule,
  commands: SurfaceModule["ADMIN_COMMANDS"],
  options: Readonly<Record<string, OptionDefinition>>,
): Promise<string> {
  const lines: string[] = [];
  for (const command of commands) {
    const baseline = [
      command.name,
      ...command.positionals.map(() => positionalValue),
      "--database-url",
      unreachableDatabase,
      ...(requiredFlags[command.name] ?? (command.mutates ? mutationFlags : [])),
    ];
    const ready = await passesValidation(admin, baseline);
    if (!ready.passes) {
      throw new Error(
        `admin ${command.name} refuses the probe baseline (${ready.message}). Add the flags it ` +
          "requires to requiredFlags in scripts/cli-surface.ts.",
      );
    }
    const accepted: string[] = [];
    for (const [name, definition] of Object.entries(options)) {
      const flag = definition.type === "boolean" ? [`--${name}`] : [`--${name}`, "1"];
      const result = await passesValidation(admin, [...baseline, ...flag]);
      if (result.passes || result.message !== `admin ${command.name} does not support --${name}`) {
        accepted.push(`admin ${command.name} --${name}`);
      }
    }
    lines.push(...accepted.toSorted(compare));
  }
  return lines.join("\n");
}

/**
 * One sample of each value kind that a payload field can hold. The table states what the `--json`
 * writer turns each kind that JSON lacks into. The kinds that JSON has must stay as they are.
 */
interface EncodingSample {
  readonly kind: string;
  readonly value: unknown;
  /** Whether JSON has the kind, so the writer must leave the value as it is. */
  readonly native: boolean;
  /** Whether the sample is an array whose one item the table describes. */
  readonly item?: true;
}

const encodingSamples: readonly EncodingSample[] = [
  { kind: "bigint", value: 7n, native: false },
  { kind: "Date", value: new Date(0), native: false },
  { kind: "undefined", value: undefined, native: false },
  { kind: "undefined item", value: [undefined], native: false, item: true },
  { kind: "bigint item", value: [7n], native: false, item: true },
  { kind: "Date item", value: [new Date(0)], native: false, item: true },
  { kind: "string", value: "text", native: true },
  { kind: "number", value: 7, native: true },
  { kind: "boolean", value: true, native: true },
  { kind: "null", value: null, native: true },
  { kind: "array", value: [7, "text"], native: true },
  { kind: "object", value: { nested: 7 }, native: true },
];

/** A value kind that JSON lacks and that has no sample. A payload that holds one stops the generator. */
const unsampledKinds = ["Map", "Set", "Uint8Array", "Buffer", "RegExp", "symbol"];

/** The JSON type of a written value, and its format when a script depends on the format. */
function describeWritten(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "string") {
    if (/^-?\d+$/.test(value)) return "string of decimal digits";
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value)) {
      return "string in ISO 8601 UTC form";
    }
  }
  return typeof value;
}

/** The JSON type of a value and of each part of it, such as `array<number,string>`. */
function typeShape(value: unknown): string {
  if (Array.isArray(value)) return `array<${value.map(typeShape).join(",")}>`;
  if (value !== null && typeof value === "object") {
    const fields = Object.entries(value).map(([key, part]) => `${key}:${typeShape(part)}`);
    return `object<${fields.join(",")}>`;
  }
  return value === null ? "null" : typeof value;
}

/** What one write of `{ [name]: value }` gives for the field: a description, or `left out`. */
function writtenAs(
  write: (command: string, payload: unknown) => string,
  command: string,
  name: string,
  sample: EncodingSample,
): string {
  const written = JSON.parse(write(command, { [name]: sample.value })) as Record<string, unknown>;
  if (!Object.hasOwn(written, name)) return "left out";
  const field = written[name];
  // ADR 0054 governs the JSON type of a field, not its value. So a value that JSON has must keep
  // the type of itself and of each part, and the writer can change the value.
  if (sample.native && typeShape(field) === typeShape(sample.value)) return "unchanged";
  if (sample.item === true && Array.isArray(field)) {
    return field.length === 0 ? "left out" : describeWritten(field[0]);
  }
  return describeWritten(field);
}

/** Each property name that a rendered payload declaration gives a field. */
function fieldNames(declarations: string): string[] {
  const names = new Set<string>();
  for (const match of declarations.matchAll(/^\s+(?:readonly\s+)?([A-Za-z_$][\w$]*)\??:/gm)) {
    if (match[1] !== undefined) names.add(match[1]);
  }
  return [...names].toSorted(compare);
}

/**
 * What the `--json` writer turns each value kind into.
 *
 * The payload types are TypeScript types, so `fenceToken: bigint` is the type before the writer
 * runs. The table runs the built writer on one sample of each kind that JSON lacks and states the
 * JSON type that comes out, so a script can read the type that it receives. The generator then
 * runs the writer of each command on each field name that a payload declares, with each kind. If
 * one command or one field gets another type than the table states, the generator stops, because
 * one line for each kind could not then describe the writer.
 */
export function renderJsonEncoding(
  write: (command: string, payload: unknown) => string,
  commands: readonly string[],
  declarations: string,
): string {
  for (const kind of unsampledKinds) {
    if (usesKind(declarations, kind)) {
      throw new Error(
        `A --json payload type uses the word ${kind} outside a property name. ` +
          readerLimit(
            `The reader reads the word as the type ${kind}, also inside a string literal or a quoted property name`,
          ),
      );
    }
  }
  const [first] = commands;
  if (first === undefined) throw new Error("No --json command uses the admin writer");
  const table = new Map(
    encodingSamples.map((sample) => [sample.kind, writtenAs(write, first, "field", sample)]),
  );
  for (const { kind, native } of encodingSamples) {
    if (native && table.get(kind) !== "unchanged") {
      throw new Error(`The --json writer changes a ${kind}, which JSON writes as it is`);
    }
  }
  for (const command of commands) {
    for (const name of fieldNames(declarations)) {
      for (const sample of encodingSamples) {
        const { kind } = sample;
        const written = writtenAs(write, command, name, sample);
        if (written !== table.get(kind)) {
          throw new Error(
            `${command} --json writes the ${kind} sample in ${name} as ${written}, not as ${String(table.get(kind))}. ` +
              "Record that field in the encoding section of scripts/cli-surface.ts.",
          );
        }
      }
    }
  }
  const shown = encodingSamples.filter((sample) => !sample.native);
  const width = Math.max(...shown.map((sample) => sample.kind.length));
  return shown.map(({ kind }) => `${kind.padEnd(width)}  ${String(table.get(kind))}`).join("\n");
}

/** The source files that hold the `--json` writers that do not use `toAdminJson`. */
const plainWriterSources = [
  "typescript/core/src/cli/health.ts",
  "typescript/core/src/cli/workhorse.ts",
];

/** The command of a type written as `CliJsonPayloads["<command>"]`, in any spelling. */
function payloadCommand(type: ts.TypeNode): string | undefined {
  if (!ts.isIndexedAccessTypeNode(type)) return undefined;
  const { objectType, indexType } = type;
  if (!ts.isTypeReferenceNode(objectType) || objectType.typeName.getText() !== payloadInterface) {
    return undefined;
  }
  if (!ts.isLiteralTypeNode(indexType) || !ts.isStringLiteral(indexType.literal)) return undefined;
  return indexType.literal.text;
}

/**
 * The rest of a message that a construct the reader cannot read stops the generator with. It says
 * what the reader cannot read, that the stop is a limit of the reader, and where to read next.
 */
function readerLimit(construct: string): string {
  return (
    `${construct}. This is a limit of the snapshot reader, not a judged break of the CLI API. ` +
    'See "Known limits" in api/README.md: write the field with an unquoted property name and ' +
    "without the word as a literal, or add a sample of the kind to encodingSamples in " +
    "scripts/cli-surface.ts if the payload holds that kind."
  );
}

/** Whether a rendered declaration uses a kind as a type, not as the name of a property. */
function usesKind(declarations: string, kind: string): boolean {
  return new RegExp(`(?<![\\w$])${kind}(?![\\w$])(?!\\s*\\??\\s*:)`).test(declarations);
}

/**
 * Hold each `--json` writer that does not use `toAdminJson` to `JSON.stringify` with no replacer.
 *
 * `schema status` and `health` write their payloads directly, and running them needs a database.
 * So the generator reads their source: each variable that a file declares as the payload of one of
 * these commands must reach `JSON.stringify` at least once, and never with a replacer. A replacer
 * could change the JSON type of a field, and the encoding table would not show it.
 */
export function checkPlainWriters(
  commands: readonly string[],
  sources: readonly { readonly filename: string; readonly text: string }[],
): void {
  const written = new Set<string>();
  for (const { filename, text } of sources) {
    const file = ts.createSourceFile(filename, text, ts.ScriptTarget.Latest, true);
    const payloads = new Map<string, string>();
    const visit = (node: ts.Node): void => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.type) {
        const command = payloadCommand(node.type);
        if (command !== undefined) payloads.set(node.name.text, command);
      }
      if (
        ts.isCallExpression(node) &&
        node.expression.getText(file) === "JSON.stringify" &&
        node.arguments[0] !== undefined &&
        ts.isIdentifier(node.arguments[0])
      ) {
        const command = payloads.get(node.arguments[0].text);
        if (command !== undefined) {
          const replacer = node.arguments[1];
          const none =
            replacer === undefined ||
            replacer.kind === ts.SyntaxKind.NullKeyword ||
            (ts.isIdentifier(replacer) && replacer.text === "undefined") ||
            (ts.isVoidExpression(replacer) && ts.isNumericLiteral(replacer.expression));
          if (!none) {
            throw new Error(
              `The ${command} --json writer in ${filename} passes a replacer to JSON.stringify. ` +
                "Run its payload through toAdminJson, or record its encoding in scripts/cli-surface.ts.",
            );
          }
          written.add(command);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
  }
  for (const command of commands) {
    if (!written.has(command)) {
      throw new Error(
        `No JSON.stringify call in ${plainWriterSources.join(" or ")} writes the ${command} payload. ` +
          "Update plainWriterSources in scripts/cli-surface.ts.",
      );
    }
  }
}

/**
 * Refuse a `bigint` in the payload of a command that writes with `JSON.stringify` and no replacer,
 * because that call throws on a `bigint`.
 */
export function refusePlainBigints(command: string, declarations: string): void {
  if (usesKind(declarations, "bigint")) {
    throw new Error(
      `The ${command} --json payload uses the word bigint outside a property name, and its ` +
        "writer has no replacer for a bigint. " +
        readerLimit(
          "The reader reads the word as the type bigint, also inside a string literal or a quoted property name",
        ),
    );
  }
}

/** Read the whole surface and render it. */
export async function renderCliSurface(): Promise<string> {
  const module = (await import(
    pathToFileURL(path.join(repositoryRoot, surfaceModule)).href
  )) as SurfaceModule;
  const admin = (await import(
    pathToFileURL(path.join(repositoryRoot, adminModule)).href
  )) as AdminModule;
  const format = (await import(
    pathToFileURL(path.join(repositoryRoot, formatModule)).href
  )) as FormatModule;
  const declarations = path.join(repositoryRoot, surfaceDeclarations);
  const program = declarationProgram([declarations]);
  const collector = new DeclarationCollector(program.getTypeChecker());
  // `schema status` and `health` write with `JSON.stringify` and no replacer, so each gets its own
  // closure to check for a bigint. Every admin subcommand writes through `toAdminJson`.
  const plainPayloads = new Map<string, DeclarationCollector>();
  const payloads = readPayloads(
    collector,
    requireSourceFile(program, declarations),
    (command, type) => {
      if (command.startsWith("admin ")) return;
      const own = new DeclarationCollector(program.getTypeChecker());
      own.recordReferences(type);
      plainPayloads.set(command, own);
    },
  );
  collector.closeOver();
  for (const [command, own] of plainPayloads) {
    own.closeOver();
    refusePlainBigints(command, renderBlocks(own.declarations));
  }
  checkPlainWriters(
    [...plainPayloads.keys()],
    await Promise.all(
      plainWriterSources.map(async (filename) => ({
        filename,
        text: await readFile(path.join(repositoryRoot, filename), "utf8"),
      })),
    ),
  );

  const commands = module.CLI_COMMANDS.map((command) => usage(command.name, command.positionals));
  const adminCommands = module.ADMIN_COMMANDS.map(
    (command) =>
      `${usage(command.name, command.positionals)}  ${command.mutates ? "mutates" : "read-only"}`,
  );
  const exitCodes = module.CLI_EXIT_CODES.map(
    (entry) => `${String(entry.code).padStart(2)}  ${entry.meaning}`,
  );

  const payloadTypes = renderBlocks(collector.declarations);
  const adminOptions = module.CLI_OPTIONS.admin;
  if (adminOptions === undefined) throw new Error(`${surfaceModule} declares no admin option set`);
  const adminFlags = await renderAdminFlags(admin, module.ADMIN_COMMANDS, adminOptions);
  const encoding = renderJsonEncoding(
    (command, payload) => format.toAdminJson(command, payload),
    payloads.map((payload) => payload.command).filter((command) => command.startsWith("admin ")),
    payloadTypes,
  );

  return [
    `## Commands\n\n${commands.join("\n")}\n`,
    `## admin subcommands\n\n${adminCommands.join("\n")}\n`,
    `## Options\n\n${optionsNote}\n\n${renderOptionSets(module.CLI_OPTIONS)}`,
    `## Flags of each admin subcommand\n\n${adminFlagsNote}\n\n${adminFlags}\n`,
    `## Exit codes\n\n${exitCodes.join("\n")}\n`,
    `## --json payloads\n\n${renderPayloads(payloads)}\n`,
    `## --json encoding\n\n${encodingNote}\n\n${encoding}\n`,
    `## Payload types\n\n${payloadTypes}\n`,
  ].join("\n");
}
