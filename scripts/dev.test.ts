import { spawn } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";

const spawnedProcessIds = new Set<number>();

function isRunning(processId: number): boolean {
  try {
    process.kill(processId, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForProcessIds(path: string, count: number): Promise<number[]> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const contents = await readFile(path, "utf8").catch(() => "");
    const processIds = contents.trim().split("\n").filter(Boolean).map(Number);
    if (processIds.length >= count) return processIds;
    await delay(20);
  }
  throw new Error(`Timed out waiting for ${count} descendant processes`);
}

async function waitForExit(child: ReturnType<typeof spawn>): Promise<void> {
  await new Promise<void>((resolveExit, reject) => {
    child.once("error", reject);
    child.once("exit", () => resolveExit());
  });
}

afterEach(() => {
  for (const processId of spawnedProcessIds) {
    if (isRunning(processId)) process.kill(processId, "SIGKILL");
  }
  spawnedProcessIds.clear();
});

describe("demo development supervisor", () => {
  it.skipIf(process.platform === "win32")(
    "stops nested command processes when the supervisor receives SIGINT",
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "workhorse-dev-supervisor-"));
      const processIdLog = join(directory, "descendants.txt");
      const fakePnpm = join(directory, "pnpm");
      await writeFile(
        fakePnpm,
        `#!/usr/bin/env node\n` +
          `const { appendFileSync } = require("node:fs");\n` +
          `const { spawn } = require("node:child_process");\n` +
          `const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });\n` +
          `appendFileSync(process.env.PROCESS_ID_LOG, child.pid + "\\n");\n` +
          `setInterval(() => {}, 1000);\n`,
      );
      await chmod(fakePnpm, 0o755);

      const supervisor = spawn(process.execPath, ["--import", "tsx", resolve("scripts/dev.ts")], {
        env: {
          ...process.env,
          PATH: `${directory}:${process.env.PATH ?? ""}`,
          PROCESS_ID_LOG: processIdLog,
        },
        stdio: "ignore",
      });

      try {
        const processIds = await waitForProcessIds(processIdLog, 4);
        for (const processId of processIds) spawnedProcessIds.add(processId);

        supervisor.kill("SIGINT");
        await waitForExit(supervisor);
        await delay(100);

        expect(processIds.filter(isRunning)).toEqual([]);
      } finally {
        if (supervisor.exitCode === null) supervisor.kill("SIGKILL");
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
});
