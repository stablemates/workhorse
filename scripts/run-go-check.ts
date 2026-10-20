import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { retryStep, runCommand } from "./command-retry.js";
import { repositoryRoot } from "./packages.js";
import { readPins, verifyTools } from "./verify-toolchain.js";

/**
 * Run a Go check with its downloads separated from its analysis or tests (SM-1558).
 *
 * `go run <tool>@<version>` and `go test` reach the module proxy and the checksum database, and
 * each one also does the work of the check. A short stream reset fails the check, and a plain rerun
 * also repeats a real finding. Thus this script runs each download through `retryStep` first, and
 * then runs the check once. The exit status of the check is the exit status of this script, so a
 * staticcheck finding, a govulncheck finding (exit 3), and a test failure fail the step at once.
 *
 *   tsx scripts/run-go-check.ts tool <package>@<version> [arguments...]
 *   tsx scripts/run-go-check.ts test [arguments...]
 *
 * The `tool` form installs the tool into a temporary `GOBIN` and runs the installed binary in `go/`.
 * The `test` form runs `go test` in `go/`. Both forms download the modules of `go/go.sum` first.
 *
 * The vulnerability database read of govulncheck is part of its analysis, so it runs once with no
 * retry, as before.
 *
 * `with-env.ts` sees `tsx` as the command, not `go`, so this script verifies the identity of `go`
 * before it starts. A substituted `go` that exits 0 would otherwise report a pass.
 */

/** A command that this script runs, in `cwd`, with the environment of this process and `env`. */
interface GoCommand {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
}

/** A download, and the step name of its retry reports. */
interface GoDownload extends GoCommand {
  readonly label: string;
}

type RetryOverrides = Omit<Parameters<typeof retryStep>[1], "label">;

/** Run a command once with the standard streams of this process, and return its exit status. */
async function runOnce(check: GoCommand): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const child = spawn(check.command, [...check.args], {
      cwd: check.cwd,
      env: { ...process.env, ...check.env },
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 1));
  });
}

/**
 * Run each download through `retryStep`, then run the check once and return its exit status.
 * If a download fails on every attempt, the check does not run and the last error is thrown.
 */
export async function downloadThenCheck(
  downloads: readonly GoDownload[],
  check: GoCommand,
  retry: RetryOverrides = {},
): Promise<number> {
  for (const download of downloads) {
    const env = { ...process.env, ...download.env };
    await retryStep(() => runCommand(download.command, download.args, download.cwd, env), {
      ...retry,
      label: download.label,
    });
  }
  return await runOnce(check);
}

const goDirectory = path.join(repositoryRoot, "go");

const moduleDownload: GoDownload = {
  label: "go mod download",
  command: "go",
  args: ["mod", "download"],
  cwd: goDirectory,
};

/** The file name of the binary that `go install <package>@<version>` writes. */
export function toolBinary(tool: string): string {
  const packagePath = tool.split("@")[0] ?? "";
  const name = packagePath.split("/").at(-1) ?? "";
  if (!tool.includes("@") || name === "") {
    throw new Error(`expected <package>@<version>, got ${JSON.stringify(tool)}`);
  }
  return process.platform === "win32" ? `${name}.exe` : name;
}

async function runTool(tool: string, args: readonly string[]): Promise<number> {
  const binary = toolBinary(tool);
  const gobin = await mkdtemp(path.join(tmpdir(), "workhorse-go-tool-"));
  try {
    return await downloadThenCheck(
      [
        moduleDownload,
        {
          label: `go install ${tool}`,
          command: "go",
          args: ["install", tool],
          cwd: goDirectory,
          env: { GOBIN: gobin },
        },
      ],
      { command: path.join(gobin, binary), args, cwd: goDirectory },
    );
  } finally {
    await rm(gobin, { recursive: true, force: true });
  }
}

async function main(argv: readonly string[]): Promise<number> {
  const refusals = await verifyTools([{ tool: "go", executable: "go" }], {
    mode: "identity",
    pins: await readPins(repositoryRoot),
    checkoutRoot: repositoryRoot,
  });
  if (refusals.length > 0) {
    console.error(refusals.join("\n\n"));
    return 2;
  }
  const [form, ...rest] = argv;
  if (form === "tool") {
    const [tool, ...args] = rest;
    if (tool === undefined) throw new Error("run-go-check tool needs <package>@<version>");
    return await runTool(tool, args);
  }
  if (form === "test") {
    return await downloadThenCheck([moduleDownload], {
      command: "go",
      args: ["test", ...rest],
      cwd: goDirectory,
    });
  }
  throw new Error(`run-go-check: expected "tool" or "test", got ${JSON.stringify(form)}`);
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  process.exitCode = await main(process.argv.slice(2));
}
