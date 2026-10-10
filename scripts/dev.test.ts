import { spawn } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";

// Every command the supervisor starts, so no test reaches a real toolchain on the PATH.
const supervisedCommands = ["pnpm", "uv", "go", "cargo", "bundle"];
// The supervisor starts `pnpm` twice: once for the server and once for the TypeScript worker.
const supervisedProcessCount = 6;
// Longer than the supervisor's own force-kill delay and the wait that follows it.
const supervisorStopTimeoutMs = 8_000;

// Everything a test started, registered as soon as it is known, so `afterEach` can clean up after a
// test that failed or timed out part way through.
const spawnedProcessIds = new Set<number>();
const temporaryDirectories = new Set<string>();

function isRunning(processId: number): boolean {
  try {
    process.kill(processId, 0);
    return true;
  } catch {
    return false;
  }
}

async function readProcessIds(path: string): Promise<number[]> {
  const contents = await readFile(path, "utf8").catch(() => "");
  const processIds = contents.trim().split("\n").filter(Boolean).map(Number);
  for (const processId of processIds) spawnedProcessIds.add(processId);
  return processIds;
}

/** Wait until both logs hold `count` process IDs, registering each one for cleanup as it appears. */
async function waitForProcessIds(
  nestedLog: string,
  commandLog: string,
  count: number,
): Promise<number[]> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const [processIds, commandProcessIds] = await Promise.all([
      readProcessIds(nestedLog),
      readProcessIds(commandLog),
    ]);
    if (processIds.length >= count && commandProcessIds.length >= count) return processIds;
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

/**
 * Start the supervisor with fake commands that each start one nested process, send it SIGINT, and
 * return the nested processes still running when the supervisor exits.
 *
 * The check runs as soon as the supervisor exits, with no delay, because the supervisor must not
 * report a stop while a nested process is still running.
 */
async function interruptSupervisor(nestedScript: string): Promise<number[]> {
  const directory = await mkdtemp(join(tmpdir(), "workhorse-dev-supervisor-"));
  temporaryDirectories.add(directory);
  const processIdLog = join(directory, "descendants.txt");
  const commandProcessIdLog = join(directory, "commands.txt");
  const fakeCommand =
    `#!/usr/bin/env node\n` +
    `const { appendFileSync } = require("node:fs");\n` +
    `const { spawn } = require("node:child_process");\n` +
    `const child = spawn(process.execPath, ["-e", ${JSON.stringify(nestedScript)}], { stdio: "ignore" });\n` +
    `appendFileSync(process.env.COMMAND_PROCESS_ID_LOG, process.pid + "\\n");\n` +
    `appendFileSync(process.env.PROCESS_ID_LOG, child.pid + "\\n");\n` +
    `setInterval(() => {}, 1000);\n`;
  const fakeCommands = supervisedCommands.map((name) => join(directory, name));
  await Promise.all(fakeCommands.map((command) => writeFile(command, fakeCommand)));
  await Promise.all(fakeCommands.map((command) => chmod(command, 0o755)));

  const supervisor = spawn(process.execPath, ["--import", "tsx", resolve("scripts/dev.ts")], {
    env: {
      ...process.env,
      DATABASE_URL_SECONDARY: "",
      PATH: `${directory}:${process.env.PATH ?? ""}`,
      COMMAND_PROCESS_ID_LOG: commandProcessIdLog,
      PROCESS_ID_LOG: processIdLog,
      WORKHORSE_DEMO_DASHBOARD_DEV: "false",
    },
    stdio: "ignore",
  });
  if (supervisor.pid) spawnedProcessIds.add(supervisor.pid);

  try {
    const processIds = await waitForProcessIds(
      processIdLog,
      commandProcessIdLog,
      supervisedProcessCount,
    );
    await delay(100);
    expect((await readFile(processIdLog, "utf8")).trim().split("\n")).toHaveLength(
      supervisedProcessCount,
    );

    supervisor.kill("SIGINT");
    await waitForExit(supervisor);

    return processIds.filter(isRunning);
  } finally {
    if (supervisor.exitCode === null && supervisor.signalCode === null) {
      // A failed setup may leave commands this test has not seen yet. The supervisor knows every
      // group it started, so let it stop them before it is killed.
      supervisor.kill("SIGTERM");
      await Promise.race([waitForExit(supervisor), delay(supervisorStopTimeoutMs)]);
      if (supervisor.exitCode === null && supervisor.signalCode === null) {
        supervisor.kill("SIGKILL");
      }
    }
    await Promise.all([readProcessIds(processIdLog), readProcessIds(commandProcessIdLog)]);
  }
}

afterEach(async () => {
  // The supervisor was registered first, so it is killed before it can start anything else.
  for (const processId of spawnedProcessIds) {
    if (isRunning(processId)) process.kill(processId, "SIGKILL");
  }
  spawnedProcessIds.clear();
  for (const directory of temporaryDirectories) {
    await rm(directory, { recursive: true, force: true });
  }
  temporaryDirectories.clear();
});

describe("demo development supervisor", () => {
  it.skipIf(process.platform === "win32")(
    "waits for nested processes to exit after the supervisor receives SIGINT",
    async () => {
      // Each nested process outlives the command that started it, as a dev server does while it
      // shuts down gracefully.
      const leftover = await interruptSupervisor(
        `process.on("SIGINT", () => setTimeout(() => process.exit(0), 200)); setInterval(() => {}, 1000);`,
      );

      expect(leftover).toEqual([]);
    },
  );

  it.skipIf(process.platform === "win32")(
    "kills nested processes that ignore SIGINT after the force-kill delay",
    async () => {
      const leftover = await interruptSupervisor(
        `process.on("SIGINT", () => {}); setInterval(() => {}, 1000);`,
      );

      expect(leftover).toEqual([]);
    },
  );
});
