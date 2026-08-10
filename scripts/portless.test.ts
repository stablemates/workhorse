import { spawn } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("demo Portless launcher", () => {
  it.skipIf(process.platform === "win32")(
    "wraps the reset-and-start command in worktree-aware run mode",
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "workhorse-portless-launcher-"));
      temporaryDirectories.push(directory);
      const argumentLog = join(directory, "arguments.json");
      const fakePortless = join(directory, "portless");
      await writeFile(
        fakePortless,
        `#!/usr/bin/env node\n` +
          `require("node:fs").writeFileSync(process.env.ARGUMENT_LOG, JSON.stringify(process.argv.slice(2)));\n`,
      );
      await chmod(fakePortless, 0o755);

      const child = spawn(process.execPath, ["--import", "tsx", resolve("scripts/portless.ts")], {
        env: {
          ...process.env,
          ARGUMENT_LOG: argumentLog,
          PATH: `${directory}:${process.env.PATH ?? ""}`,
        },
        stdio: "ignore",
      });
      const exitCode = await new Promise<number | null>((resolveExit, reject) => {
        child.once("error", reject);
        child.once("exit", resolveExit);
      });

      expect(exitCode).toBe(0);
      expect(JSON.parse(await readFile(argumentLog, "utf8"))).toEqual([
        "run",
        "--name",
        "workhorse",
        "pnpm",
        "run",
        "demo:app",
      ]);
    },
  );
});
