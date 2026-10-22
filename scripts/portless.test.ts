import { spawn } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
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

  it.skipIf(process.platform === "win32")(
    "registers and removes the SigNoz static route",
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "workhorse-signoz-portless-"));
      temporaryDirectories.push(directory);
      const fakePortless = join(directory, "portless");
      await writeFile(
        fakePortless,
        `#!/usr/bin/env node\n` +
          `require("node:fs").writeFileSync(process.env.ARGUMENT_LOG, JSON.stringify(process.argv.slice(2)));\n`,
      );
      await chmod(fakePortless, 0o755);

      for (const [action, expectedArguments] of [
        ["add", ["alias", "signoz", "3301"]],
        ["remove", ["alias", "--remove", "signoz"]],
      ] as const) {
        const argumentLog = join(directory, `${action}.json`);
        const child = spawn(
          process.execPath,
          ["--import", "tsx", resolve("scripts/signoz-portless.ts"), action],
          {
            env: {
              ...process.env,
              ARGUMENT_LOG: argumentLog,
              PATH: `${directory}:${process.env.PATH ?? ""}`,
            },
            stdio: "ignore",
          },
        );
        const exitCode = await new Promise<number | null>((resolveExit, reject) => {
          child.once("error", reject);
          child.once("exit", resolveExit);
        });

        expect(exitCode).toBe(0);
        expect(JSON.parse(await readFile(argumentLog, "utf8"))).toEqual(expectedArguments);
      }
    },
  );

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    it.skipIf(process.platform === "win32")(`forwards ${signal} to Portless`, async () => {
      const directory = await mkdtemp(join(tmpdir(), "workhorse-portless-signal-"));
      temporaryDirectories.push(directory);
      const ready = join(directory, "ready");
      const received = join(directory, "received");
      const fakePortless = join(directory, "portless");
      await writeFile(
        fakePortless,
        `#!/usr/bin/env node\n` +
          `const { writeFileSync } = require("node:fs");\n` +
          `for (const signal of ["SIGINT", "SIGTERM"]) {\n` +
          `  process.on(signal, () => { writeFileSync(process.env.RECEIVED, signal); process.exit(0); });\n` +
          `}\n` +
          `writeFileSync(process.env.READY, "");\n` +
          `setInterval(() => {}, 1000);\n`,
      );
      await chmod(fakePortless, 0o755);

      // Only the launcher gets the signal, so Portless can get it only by the forward.
      const child = spawn(process.execPath, ["--import", "tsx", resolve("scripts/portless.ts")], {
        env: {
          ...process.env,
          READY: ready,
          RECEIVED: received,
          PATH: `${directory}:${process.env.PATH ?? ""}`,
        },
        stdio: "ignore",
      });
      const exited = new Promise<number | null>((resolveExit, reject) => {
        child.once("error", reject);
        child.once("exit", resolveExit);
      });
      try {
        for (let attempt = 0; attempt < 250; attempt += 1) {
          if (
            await readFile(ready).then(
              () => true,
              () => false,
            )
          )
            break;
          await delay(20);
        }
        child.kill(signal);

        expect(await exited).toBe(0);
        expect(await readFile(received, "utf8")).toBe(signal);
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }
    });
  }
});
