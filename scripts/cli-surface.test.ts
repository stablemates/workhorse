import { describe, expect, it } from "vitest";

import {
  checkPlainWriters,
  refusePlainBigints,
  renderAdminFlags,
  renderJsonEncoding,
} from "./cli-surface.js";

/**
 * The two parts of `api/cli.txt` that the generator reads by running code (SM-2047): the flags that
 * each admin subcommand accepts, and what the `--json` writer turns each value kind into. Each test
 * changes the code that the generator runs and reads the lines that change.
 */

class CliUsageError extends Error {
  override name = "CliUsageError";
}

const commands = [
  { name: "tasks", mutates: false, positionals: [] },
  { name: "set-tier", mutates: true, positionals: ["queue"] },
] as const;

const options = {
  cursor: { type: "string" },
  json: { type: "boolean" },
  "request-id": { type: "string" },
} as const;

/**
 * An admin runner that refuses each flag outside its scope table the way `admin.ts` does, and
 * otherwise fails as a connection to the unreachable database fails.
 */
function adminWith(scopes: Readonly<Record<string, readonly string[]>>) {
  return {
    async runAdminCommand(args: readonly string[]): Promise<void> {
      const command = args[0] ?? "";
      for (const [flag, allowed] of Object.entries(scopes)) {
        if (args.includes(`--${flag}`) && !allowed.includes(command)) {
          throw new CliUsageError(`admin ${command} does not support --${flag}`);
        }
      }
      throw new Error("connect ENOENT");
    },
  };
}

const scopes = { cursor: ["tasks"], "request-id": ["tasks"] };

describe("the flags of each admin subcommand", () => {
  it("lists each accepted pair and leaves out each refused one", async () => {
    expect((await renderAdminFlags(adminWith(scopes), commands, options)).split("\n")).toEqual([
      "admin tasks --cursor",
      "admin tasks --json",
      "admin tasks --request-id",
      "admin set-tier --json",
    ]);
  });

  it("loses a line when a subcommand stops accepting a flag", async () => {
    const before = (await renderAdminFlags(adminWith(scopes), commands, options)).split("\n");
    const after = (
      await renderAdminFlags(adminWith({ ...scopes, cursor: [] }), commands, options)
    ).split("\n");
    expect(before.filter((line) => !after.includes(line))).toEqual(["admin tasks --cursor"]);
  });

  it("only gains a line when a subcommand starts to accept a flag", async () => {
    const before = (await renderAdminFlags(adminWith(scopes), commands, options)).split("\n");
    const after = (
      await renderAdminFlags(
        adminWith({ ...scopes, "request-id": ["tasks", "set-tier"] }),
        commands,
        options,
      )
    ).split("\n");
    expect(before.every((line) => after.includes(line))).toBe(true);
    expect(after.filter((line) => !before.includes(line))).toEqual(["admin set-tier --request-id"]);
  });

  it("stops when a subcommand refuses the probe baseline", async () => {
    const strict = {
      async runAdminCommand(): Promise<void> {
        throw new CliUsageError("admin tasks requires --queue <name>");
      },
    };
    await expect(renderAdminFlags(strict, commands, options)).rejects.toThrow(
      "admin tasks refuses the probe baseline",
    );
  });
});

/** A writer that turns a bigint into a string, as `toAdminJson` does. */
function writer(_command: string, payload: unknown): string {
  return JSON.stringify(payload, (_key, value: unknown) =>
    typeof value === "bigint" ? value.toString() : value,
  );
}

/** A writer that turns a bigint into a number, which changes the JSON type that a script reads. */
function numbers(_command: string, payload: unknown): string {
  return JSON.stringify(payload, (_key, value: unknown) =>
    typeof value === "bigint" ? Number(value) : value,
  );
}

/** A writer that pads each bigint, which keeps the JSON type of the field. */
function padded(_command: string, payload: unknown): string {
  return JSON.stringify(payload, (_key, value: unknown) =>
    typeof value === "bigint" ? `0${value.toString()}` : value,
  );
}

/** A writer that turns one field into a number and leaves the rest to the kind rule. */
function oneField(_command: string, payload: unknown): string {
  return JSON.stringify(payload, (key, value: unknown) =>
    typeof value === "bigint" ? (key === "fenceToken" ? Number(value) : value.toString()) : value,
  );
}

/** A writer that writes the length of each array under `createdAt` in place of the array. */
function countsItems(_command: string, payload: unknown): string {
  return JSON.stringify(payload, (key, value: unknown) => {
    if (typeof value === "bigint") return value.toString();
    return key === "createdAt" && Array.isArray(value) ? value.length : value;
  });
}

/** A writer that turns a bigint into a number inside an array, and into a string elsewhere. */
function numberItems(_command: string, payload: unknown): string {
  return JSON.stringify(payload, function (this: unknown, _key, value: unknown) {
    if (typeof value !== "bigint") return value;
    return Array.isArray(this) ? Number(value) : value.toString();
  });
}

/** A writer that writes each string in upper case, which keeps its JSON type. */
function upperCase(_command: string, payload: unknown): string {
  return JSON.stringify(payload, (_key, value: unknown) => {
    if (typeof value === "bigint") return value.toString();
    return typeof value === "string" ? value.toUpperCase() : value;
  });
}

/** A writer that turns a bigint into a number for one command only. */
function oneCommand(command: string, payload: unknown): string {
  return command === "admin waits" ? numbers(command, payload) : writer(command, payload);
}

const payloadTypes = "interface TaskWait {\n  readonly fenceToken: bigint;\n  createdAt: Date;\n}";
const jsonCommands = ["admin task", "admin waits"];

describe("the --json encoding", () => {
  it("states the JSON type that each value kind becomes", () => {
    expect(renderJsonEncoding(writer, jsonCommands, payloadTypes)).toBe(
      [
        "bigint          string of decimal digits",
        "Date            string in ISO 8601 UTC form",
        "undefined       left out",
        "undefined item  null",
        "bigint item     string of decimal digits",
        "Date item       string in ISO 8601 UTC form",
      ].join("\n"),
    );
  });

  it("changes a line when the writer changes the type of a value kind", () => {
    const before = renderJsonEncoding(writer, jsonCommands, payloadTypes).split("\n");
    const after = renderJsonEncoding(numbers, jsonCommands, payloadTypes).split("\n");
    expect(before.filter((line) => !after.includes(line))).toEqual([
      "bigint          string of decimal digits",
      "bigint item     string of decimal digits",
    ]);
  });

  it("keeps each line when the writer keeps the JSON type", () => {
    expect(renderJsonEncoding(padded, jsonCommands, payloadTypes)).toBe(
      renderJsonEncoding(writer, jsonCommands, payloadTypes),
    );
  });

  it("keeps each line when a payload gains a field", () => {
    const added = payloadTypes.replace("}", "  attempts: bigint;\n}");
    expect(renderJsonEncoding(writer, jsonCommands, added)).toBe(
      renderJsonEncoding(writer, jsonCommands, payloadTypes),
    );
  });

  it("stops when the writer treats one field or one command in another way", () => {
    expect(() => renderJsonEncoding(oneField, jsonCommands, payloadTypes)).toThrow(
      "admin task --json writes the bigint sample in fenceToken as number",
    );
    expect(() => renderJsonEncoding(oneCommand, jsonCommands, payloadTypes)).toThrow(
      "admin waits --json writes the bigint sample in createdAt as number",
    );
  });

  it("keeps each line when the writer changes a value but not its JSON type", () => {
    expect(renderJsonEncoding(upperCase, jsonCommands, payloadTypes)).toBe(
      renderJsonEncoding(writer, jsonCommands, payloadTypes),
    );
  });

  it("changes a line when the writer changes a bigint inside an array", () => {
    const before = renderJsonEncoding(writer, jsonCommands, payloadTypes).split("\n");
    const after = renderJsonEncoding(numberItems, jsonCommands, payloadTypes).split("\n");
    expect(before.filter((line) => !after.includes(line))).toEqual([
      "bigint item     string of decimal digits",
    ]);
  });

  it("stops when the writer changes an array or an object of one field", () => {
    expect(() => renderJsonEncoding(countsItems, jsonCommands, payloadTypes)).toThrow(
      "in createdAt as number",
    );
  });

  it("reads a property named for a kind as a property", () => {
    const named = "interface A {\n  symbol?: string;\n  bigint: string;\n}";
    expect(() => renderJsonEncoding(writer, jsonCommands, named)).not.toThrow();
    expect(() => refusePlainBigints("health", named)).not.toThrow();
    expect(() => refusePlainBigints("health", "interface A {\n  total: bigint;\n}")).toThrow(
      "The health --json payload uses the word bigint outside a property name",
    );
  });

  it("says that a kind word in a literal is a limit of the reader, and where to read next", () => {
    // Known limit H: the reader cannot tell a string literal or a quoted property name from a type.
    expect(() =>
      renderJsonEncoding(writer, jsonCommands, 'interface A {\n  kind?: "symbol";\n}'),
    ).toThrow(
      /uses the word symbol outside a property name.*string literal or a quoted property name.*not a judged break of the CLI API.*"Known limits" in api\/README\.md/s,
    );
  });

  it("stops when a payload holds a value kind that has no sample", () => {
    expect(() =>
      renderJsonEncoding(writer, jsonCommands, "interface A { tags: Set<string> }"),
    ).toThrow("A --json payload type uses the word Set outside a property name");
  });

  it("stops when a payload written without a replacer holds a bigint", () => {
    expect(() => refusePlainBigints("health", "interface QueueHealth { total: bigint }")).toThrow(
      "The health --json payload uses the word bigint outside a property name",
    );
    expect(() => refusePlainBigints("health", "interface QueueHealth { at: Date }")).not.toThrow();
  });
});

/** One source file whose `health` writer makes the given call. */
function healthSource(call: string): { filename: string; text: string }[] {
  return [
    {
      filename: "health.ts",
      text: `const health: CliJsonPayloads["health"] = read();\nprocess.stdout.write(${call});`,
    },
  ];
}

describe("the writers of schema status and health", () => {
  it("accepts JSON.stringify with no replacer", () => {
    expect(() =>
      checkPlainWriters(["health"], healthSource("JSON.stringify(health, null, 2)")),
    ).not.toThrow();
  });

  it("reads the payload type and an empty replacer in any spelling", () => {
    const spelled = [
      {
        filename: "health.ts",
        text: `const health: CliJsonPayloads[ 'health' ] = read();\nprocess.stdout.write(JSON.stringify(health, undefined, 2));`,
      },
    ];
    expect(() => checkPlainWriters(["health"], spelled)).not.toThrow();
  });

  it("reads void 0 as no replacer", () => {
    expect(() =>
      checkPlainWriters(["health"], healthSource("JSON.stringify(health, void 0, 2)")),
    ).not.toThrow();
  });

  it("stops when the writer gains a replacer", () => {
    expect(() =>
      checkPlainWriters(
        ["health"],
        healthSource("JSON.stringify(health, (key, value) => value, 2)"),
      ),
    ).toThrow("The health --json writer in health.ts passes a replacer");
  });

  it("stops when no call writes the payload", () => {
    expect(() => checkPlainWriters(["health"], healthSource("String(health)"))).toThrow(
      "No JSON.stringify call",
    );
  });
});
