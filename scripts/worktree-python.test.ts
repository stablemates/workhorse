import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readPins } from "./verify-toolchain.js";
import { syncPythonEnvironment } from "./worktree-python.js";

const repositoryRoot = resolve(import.meta.dirname, "..");

interface Call {
  command: string;
  arguments_: string[];
  cwd: string;
}

function recorder(calls: Call[]) {
  return async (command: string, arguments_: string[], options: { cwd: string }) => {
    calls.push({ command, arguments_, cwd: options.cwd });
  };
}

describe("syncPythonEnvironment", () => {
  const scratch: string[] = [];
  afterEach(async () => {
    for (const directory of scratch.splice(0)) {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("asks uv for the Python version that mise.toml pins", async () => {
    const pin = (await readPins(repositoryRoot)).get("python");
    expect(pin).toMatch(/^\d+\.\d+/);
    const calls: Call[] = [];

    await syncPythonEnvironment(repositoryRoot, recorder(calls), async () => `${pin}.14`);

    expect(calls).toEqual([
      {
        command: "uv",
        arguments_: ["sync", "--project", "python", "--frozen", "--python", pin],
        cwd: repositoryRoot,
      },
    ]);
  });

  it("fails when python/.venv uses another Python version", async () => {
    const root = await mkdtemp(join(tmpdir(), "workhorse-worktree-python-"));
    scratch.push(root);
    await writeFile(join(root, "mise.toml"), '[tools]\npython = "3.12"\n');

    await expect(syncPythonEnvironment(root, recorder([]), async () => "3.13.18")).rejects.toThrow(
      "python/.venv uses Python 3.13.18, but mise.toml pins python 3.12.",
    );
    // 3.120 does not extend 3.12 on a dot boundary.
    await expect(syncPythonEnvironment(root, recorder([]), async () => "3.120.0")).rejects.toThrow(
      "python/.venv uses Python 3.120.0",
    );
    await expect(
      syncPythonEnvironment(root, recorder([]), async () => "3.12.14"),
    ).resolves.toBeUndefined();
  });

  it("refuses a mise.toml without an exact python pin", async () => {
    const root = await mkdtemp(join(tmpdir(), "workhorse-worktree-python-"));
    scratch.push(root);
    await writeFile(join(root, "mise.toml"), '[tools]\npython = "latest"\n');
    const calls: Call[] = [];

    await expect(
      syncPythonEnvironment(root, recorder(calls), async () => "3.12.14"),
    ).rejects.toThrow("mise.toml does not pin python to a version");
    expect(calls).toEqual([]);
  });
});
