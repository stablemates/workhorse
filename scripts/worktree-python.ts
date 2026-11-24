/**
 * Create the Python environment of a worktree with the Python version that `mise.toml` pins.
 *
 * Without a version request, uv selects the newest interpreter that satisfies `requires-python`,
 * so a host with CPython 3.13 or 3.14 gets that version in `python/.venv`. The Python API snapshot
 * changes between minor versions, so `pnpm python-api:check` then fails on an unchanged
 * `api/python.txt` (SM-2083). Thus the sync requests the pin, and the setup then asks the
 * interpreter in `python/.venv` for its version.
 */
import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { readPins, satisfiesPin } from "./verify-toolchain.js";
import { run } from "./worktree-resources.js";

type RunCommand = (
  command: string,
  arguments_: string[],
  options: { cwd: string },
) => Promise<void>;

/** Print the version of the interpreter in the `python/.venv` of a worktree. */
type ReportVersion = (worktreeRoot: string) => Promise<string>;

async function environmentPythonVersion(worktreeRoot: string): Promise<string> {
  const interpreter =
    process.platform === "win32"
      ? join(worktreeRoot, "python", ".venv", "Scripts", "python.exe")
      : join(worktreeRoot, "python", ".venv", "bin", "python");
  const { stdout } = await promisify(execFile)(interpreter, [
    "-c",
    "import platform; print(platform.python_version())",
  ]);
  return stdout.trim();
}

export async function syncPythonEnvironment(
  worktreeRoot: string,
  runCommand: RunCommand = run,
  reportVersion: ReportVersion = environmentPythonVersion,
): Promise<void> {
  const pin = (await readPins(worktreeRoot)).get("python");
  if (pin === undefined) {
    throw new Error("mise.toml does not pin python to a version, so uv cannot select it.");
  }
  // An explicit request also replaces a `python/.venv` that another version created.
  await runCommand("uv", ["sync", "--project", "python", "--frozen", "--python", pin], {
    cwd: worktreeRoot,
  });
  const reported = await reportVersion(worktreeRoot);
  if (!satisfiesPin(pin, reported)) {
    throw new Error(
      `python/.venv uses Python ${reported}, but mise.toml pins python ${pin}. ` +
        `Remove python/.venv and run pnpm worktree:setup again.`,
    );
  }
}
