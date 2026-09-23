/**
 * Refuse to run a repository check on a tool that is not the tool this repository pinned.
 *
 * A check that runs on a substituted tool reports a pass without doing the work, and a false pass
 * is worse than a failure because a failure stops the work. Substituted tools that sent `ruff` and
 * `gofmt` to `/bin/cat` did exactly that: `cat` exits 0, so `pnpm python:lint` and
 * `pnpm go:fmt:check` reported clean without running. See SM-832.
 *
 * Two properties are checked, because they hold in different places:
 *
 * - Identity. The tool that answers is the tool the command named: `uv --version` prints `uv` and
 *   a version, not `Python 3.12.3` and not nothing. That holds wherever a repository command runs,
 *   so `with-env.ts` asserts it ahead of every command it starts.
 * - Pin agreement. The version also satisfies the `mise.toml` pin. That holds on a contributor's
 *   machine, so `pnpm check` and the `pre-push` hook assert it. CI deliberately runs the support
 *   matrix, whose Node, Python and Go versions differ from the pins, so asserting pin agreement
 *   ahead of every command would refuse CI's own supported combinations.
 *
 * Versions are compared, never installation paths, so a container, a nix profile and a mise shim
 * all pass when the version agrees. `gofmt` is the exception: it reports no version, so it is
 * checked against the directory `go env GOROOT` names.
 *
 * No environment variable skips any of this. A contributor who cannot continue would set it, and
 * that would restore the failure this guard removes. The refusal names the repair instead.
 *
 * Usage: tsx scripts/verify-toolchain.ts [tool...]
 */
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { basename, delimiter, join, resolve as resolvePath, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse as parseToml } from "smol-toml";

/** How much of the toolchain contract a call asserts. */
export type VerificationMode = "identity" | "pinned";

interface ToolProbe {
  /** Arguments that make the tool report its version. */
  arguments: string[];
  /**
   * The output shape only this tool produces, capturing the version. A tool that answers in
   * another tool's shape, or answers nothing, is not the tool the command named.
   */
  identity: RegExp;
}

const version = String.raw`(\d+(?:\.\d+)*)`;

/** Every tool `mise.toml` can pin, and the question that makes it name itself. */
const probes: Record<string, ToolProbe> = {
  "cargo-deny": {
    arguments: ["--version"],
    identity: new RegExp(String.raw`^cargo-deny ${version}`),
  },
  go: { arguments: ["version"], identity: new RegExp(String.raw`^go version go${version}`) },
  lefthook: { arguments: ["version"], identity: new RegExp(String.raw`^${version}`) },
  node: { arguments: ["--version"], identity: new RegExp(String.raw`^v${version}`) },
  pnpm: { arguments: ["--version"], identity: new RegExp(String.raw`^${version}`) },
  python: { arguments: ["--version"], identity: new RegExp(String.raw`^Python ${version}`) },
  rust: { arguments: ["--version"], identity: new RegExp(String.raw`^rustc ${version}`) },
  uv: { arguments: ["--version"], identity: new RegExp(String.raw`^uv ${version}`) },
};

/**
 * Commands of the pinned Rust toolchain that repository scripts start directly. Each names itself,
 * so a substitute is refused; `rustc` answers for the `mise.toml` pin.
 */
const rustCommands: Record<string, ToolProbe> = {
  cargo: { arguments: ["--version"], identity: new RegExp(String.raw`^cargo ${version}`) },
  rustfmt: { arguments: ["--version"], identity: new RegExp(String.raw`^rustfmt ${version}`) },
};

/** Part of the Go toolchain rather than a `mise.toml` entry, and checked by a rule of its own. */
export const gofmtTool = "gofmt";

/** A tool to check, and the executable that answers for it. */
export interface ToolRequest {
  tool: string;
  /** What to spawn: the command as written, so an absolute path is checked rather than a namesake. */
  executable: string;
}

export interface VerifyOptions {
  mode: VerificationMode;
  pins: Map<string, string | undefined>;
  checkoutRoot: string;
}

const checkoutRoot = resolvePath(fileURLToPath(new URL("..", import.meta.url)));

/**
 * The `[tools]` pins of a checkout's `mise.toml`, by tool name. A tool whose pin is not a plain
 * dotted version — a range, `latest`, a table without a version — maps to undefined, and only its
 * identity can be checked.
 */
export async function readPins(root = checkoutRoot): Promise<Map<string, string | undefined>> {
  const contents = await readFile(join(root, "mise.toml"), "utf8");
  const tools = (parseToml(contents) as { tools?: Record<string, unknown> }).tools ?? {};
  const pins = new Map<string, string | undefined>();
  for (const [tool, value] of Object.entries(tools)) pins.set(tool, exactPin(value));
  return pins;
}

function exactPin(value: unknown): string | undefined {
  const candidate =
    typeof value === "string"
      ? value
      : typeof value === "object" &&
          value !== null &&
          "version" in value &&
          typeof value.version === "string"
        ? value.version
        : undefined;
  return candidate !== undefined && /^\d+(?:\.\d+)*$/.test(candidate) ? candidate : undefined;
}

/**
 * Whether a reported version satisfies a pin the way mise reads it: a pin matches a version that
 * extends it on a dot boundary, so `24` accepts any 24.x and `0.8.9` accepts only 0.8.9.
 */
export function satisfiesPin(pin: string, reported: string): boolean {
  return reported === pin || reported.startsWith(`${pin}.`);
}

/** The tools a repository command will start, including those a `sh -c` script names. */
export function toolsNamedBy(
  command: string,
  commandArguments: readonly string[],
  checkable: ReadonlySet<string>,
): ToolRequest[] {
  const requests: ToolRequest[] = [];
  const seen = new Set<string>();
  const add = (tool: string, executable: string) => {
    if (seen.has(tool)) return;
    seen.add(tool);
    requests.push({ tool, executable });
  };

  const name = executableName(command);
  if (checkable.has(name) || (checkable.has("rust") && name in rustCommands)) add(name, command);
  // `go:fmt:check` and `health` reach their real tool through a shell, because they need a pipe or
  // a variable. Without this the wrapper would check `sh` and let a substituted `gofmt` through.
  if (name === "sh" || name === "bash") {
    for (const argument of commandArguments) {
      for (const token of argument.split(/\s+/)) if (checkable.has(token)) add(token, token);
    }
  }
  return requests;
}

/** Strip the directory, and on Windows the extension, from a command as written. */
export function executableName(command: string): string {
  const name = basename(command);
  return process.platform === "win32" ? name.replace(/\.(?:exe|cmd|bat)$/i, "") : name;
}

/** Refusals for the named tools, empty when every one of them checks out. */
export async function verifyTools(
  requests: readonly ToolRequest[],
  options: VerifyOptions,
): Promise<string[]> {
  const refusals = await Promise.all(
    requests.map(async (request) =>
      request.tool === gofmtTool
        ? await verifyGofmt(request.executable, options)
        : await verifyVersioned(request, options),
    ),
  );
  return refusals.filter((refusal) => refusal !== undefined);
}

/** Refusals for every pinned tool plus `gofmt`, or for a named subset of them. */
export async function verifyToolchain(options: {
  mode: VerificationMode;
  tools?: readonly string[];
  checkoutRoot?: string;
}): Promise<string[]> {
  const root = options.checkoutRoot ?? checkoutRoot;
  const pins = await readPins(root);
  const known = [...pins.keys(), gofmtTool];
  const tools = options.tools ?? known;
  const unknown = tools.filter((tool) => !known.includes(tool));
  if (unknown.length > 0) {
    return [
      `No version probe is known for ${unknown.join(", ")}. Known tools: ${known.join(", ")}.`,
    ];
  }
  return await verifyTools(
    tools.map((tool) => ({ tool, executable: tool === "rust" ? "rustc" : tool })),
    { mode: options.mode, pins, checkoutRoot: root },
  );
}

async function verifyVersioned(
  { tool, executable }: ToolRequest,
  { mode, pins }: VerifyOptions,
): Promise<string | undefined> {
  const probe = probes[tool] ?? rustCommands[tool];
  if (!probe) return undefined;
  const pin = pins.get(tool);

  const result = await runProbe(executable, probe.arguments);
  if (result.spawnFailed) {
    return describe(
      `${tool} is not on the PATH, so \`${executable} ${probe.arguments.join(" ")}\` could not run.`,
      tool,
      pin,
    );
  }

  const reported = probe.identity.exec(result.output)?.[1];
  if (reported === undefined) {
    const printed = result.output === "" ? "nothing" : JSON.stringify(firstLine(result.output));
    return describe(
      `${tool} did not identify itself: \`${executable} ${probe.arguments.join(" ")}\` printed ${printed}.`,
      tool,
      pin,
    );
  }

  if (mode === "pinned" && pin !== undefined && !satisfiesPin(pin, reported)) {
    return describe(`${tool} ${reported} does not match the mise.toml pin ${pin}.`, tool, pin);
  }
  return undefined;
}

/**
 * `gofmt` reports no version, so it is checked against the Go toolchain instead: either it
 * resolves inside the directory `go env GOROOT` names, or it formats a probe exactly as that
 * directory's `gofmt` does. The second rule is what lets a mise shim through — a shim lives on the
 * PATH rather than in GOROOT — while `/bin/cat` under the name `gofmt`, which returns its input
 * unchanged, is refused.
 */
async function verifyGofmt(
  executable: string,
  { pins }: VerifyOptions,
): Promise<string | undefined> {
  const goPin = pins.get("go");
  const goroot = (await runProbe("go", ["env", "GOROOT"])).output.trim();
  if (goroot === "") {
    return describe("go could not report GOROOT, so gofmt cannot be checked.", "go", goPin);
  }

  const resolved = await resolveOnPath(executable);
  if (resolved === undefined) {
    return describe(`${gofmtTool} is not on the PATH.`, "go", goPin);
  }
  if (resolved === goroot || resolved.startsWith(`${goroot}${sep}`)) return undefined;

  const source = "package main\nfunc  main( ){ }\n";
  const reference = join(goroot, "bin", process.platform === "win32" ? "gofmt.exe" : "gofmt");
  const [candidate, expected] = await Promise.all([
    formatProbe(resolved, source),
    formatProbe(reference, source),
  ]);
  if (expected === undefined) {
    return describe(`The Go toolchain at ${goroot} has no gofmt at ${reference}.`, "go", goPin);
  }
  if (candidate !== expected) {
    return describe(
      `${gofmtTool} at ${resolved} does not format as the Go toolchain at ${goroot} does.`,
      "go",
      goPin,
    );
  }
  return undefined;
}

/** Say what was found, why it stops the command, and the exact repair. */
function describe(finding: string, tool: string, pin: string | undefined): string {
  const install = pin === undefined ? "mise install" : `mise install ${tool}@${pin}`;
  return [
    finding,
    "A check that runs on a substituted tool reports a pass without doing the work.",
    `Run \`${install}\`, then run the command through \`mise exec -- <command>\`.`,
  ].join("\n");
}

interface ProbeResult {
  output: string;
  spawnFailed: boolean;
}

/**
 * Ask a tool to name itself. Standard error joins standard output because tools disagree about
 * where a version belongs, and standard input is closed so a tool that is really `cat` reaches end
 * of file instead of waiting for one.
 */
async function runProbe(executable: string, probeArguments: string[]): Promise<ProbeResult> {
  return await new Promise<ProbeResult>((resolve) => {
    const child = spawn(executable, probeArguments, {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 15_000,
    });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.once("error", () => resolve({ output: "", spawnFailed: true }));
    child.once("close", () => resolve({ output: output.trim(), spawnFailed: false }));
  });
}

/** What a formatter makes of a probe, or undefined when it cannot run or rejects the probe. */
async function formatProbe(executable: string, source: string): Promise<string | undefined> {
  return await new Promise<string | undefined>((resolve) => {
    const child = spawn(executable, [], { stdio: ["pipe", "pipe", "ignore"], timeout: 15_000 });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.once("error", () => resolve(undefined));
    child.once("close", (code) => resolve(code === 0 ? output : undefined));
    child.stdin.on("error", () => {});
    child.stdin.end(source);
  });
}

/** The executable a bare command name resolves to, following the PATH the way a shell would. */
async function resolveOnPath(command: string): Promise<string | undefined> {
  if (command.includes(sep) || command.includes("/")) return command;
  const extensions =
    process.platform === "win32"
      ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";").filter(Boolean)
      : [""];
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (directory === "") continue;
    for (const extension of extensions) {
      const candidate = join(directory, `${command}${extension}`);
      try {
        await access(candidate, constants.X_OK);
        return candidate;
      } catch {
        continue;
      }
    }
  }
  return undefined;
}

function firstLine(output: string): string {
  return output.split(/\r?\n/, 1)[0] ?? "";
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const requested = process.argv.slice(2);
  const refusals = await verifyToolchain({
    mode: "pinned",
    tools: requested.length > 0 ? requested : undefined,
  });
  if (refusals.length > 0) {
    console.error(refusals.join("\n\n"));
    process.exit(2);
  }
}
