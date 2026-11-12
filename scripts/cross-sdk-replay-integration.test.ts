import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { Client } from "pg";
import { afterEach, describe, expect, inject, it } from "vitest";
import { databaseName, localDatabaseUrl } from "../typescript/core/src/local-database.js";
import { repositoryRoot } from "./packages.js";

// A cancel of the cross-SDK harness must stop the phase that runs (SM-2018). The phase runs in a
// process group of its own, so Ctrl-C at a terminal reaches only the harness. Each test starts the
// real harness in a child process, with a phase command that starts a grandchild, and signals it.

// A non-interactive shell starts `sleep 617 &` with SIGINT ignored, so after SIGINT only SIGKILL
// stops the grandchild. The traps show that the harness sent the signal to the phase.
const phaseScript = [
  "trap 'echo phase-received-SIGINT; exit 3' INT",
  "trap 'echo phase-received-SIGTERM; exit 3' TERM",
  "sleep 617 &",
  'echo "phase-started $$ $! $WORKHORSE_CROSS_SDK_DATABASE_URL"',
  "wait",
].join("\n");

const harnessUrl = pathToFileURL(path.join(repositoryRoot, "scripts/cross-sdk-replay.ts")).href;

// The TypeScript phase of the pair never runs, because the cancel comes in the Go phase.
const driver = `
import { main } from ${JSON.stringify(harnessUrl)};
const phase = { tool: "sh", command: "sh", args: ["-c", ${JSON.stringify(phaseScript)}], cwd: "." };
process.exitCode = await main(["--pair", "go:typescript"], {
  phaseCommands: { go: phase, python: phase, rust: phase, ruby: phase, java: phase, csharp: phase },
  verifyTools: async () => [],
  cancelGraceMs: 1000,
});
`;

const groupExists = (groupId: number): boolean => {
  try {
    process.kill(-groupId, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") return false;
    throw error;
  }
};

let started: { group: number; grandchild: number } | undefined;

afterEach(() => {
  // A failed test must not leave `sleep 617` on the machine.
  if (started !== undefined && groupExists(started.group)) process.kill(-started.group, "SIGKILL");
  started = undefined;
});

/** Collects the output of the harness, and resolves when the phase prints its start line. */
function watchHarness(harness: ChildProcess) {
  const output = { stdout: "", stderr: "" };
  harness.stderr!.on("data", (chunk: Buffer) => (output.stderr += chunk.toString()));
  const phaseStarted = new Promise<string[]>((resolve, reject) => {
    harness.stdout!.on("data", (chunk: Buffer) => {
      output.stdout += chunk.toString();
      const line = /^phase-started (.*)\n/m.exec(output.stdout)?.[1];
      if (line !== undefined) resolve(line.split(" "));
    });
    harness.once("exit", (code) =>
      reject(new Error(`the harness exited with ${String(code)}:\n${output.stderr}`)),
    );
  });
  return { output, phaseStarted };
}

async function databaseExists(name: string): Promise<boolean> {
  const url = new URL(localDatabaseUrl("test"));
  url.pathname = "/postgres";
  const client = new Client({ connectionString: url.href });
  await client.connect();
  try {
    const result = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [name]);
    return result.rowCount === 1;
  } finally {
    await client.end();
  }
}

describe("cross-SDK harness cancel", () => {
  it.each([
    { signal: "SIGINT", status: 130 },
    { signal: "SIGTERM", status: 143 },
  ] as const)(
    "stops the phase group, drops its database, and exits $status on $signal",
    async ({ signal, status }) => {
      const harness = spawn(
        process.execPath,
        ["--import", "tsx", "--input-type=module", "--eval", driver],
        { cwd: repositoryRoot, env: process.env, stdio: ["ignore", "pipe", "pipe"] },
      );
      const { output, phaseStarted } = watchHarness(harness);
      const [group, grandchild, databaseUrl] = await phaseStarted;
      started = { group: Number(group), grandchild: Number(grandchild) };
      expect(groupExists(started.group)).toBe(true);

      const exit = once(harness, "exit");
      harness.kill(signal);
      const [code] = await exit;

      // The harness exits only after the whole group stopped, so no process of it is left.
      expect({ code, stderr: output.stderr }).toMatchObject({
        code: status,
        stderr: expect.stringContaining(`stopped the run and dropped its database after ${signal}`),
      });
      expect(output.stdout).toContain(`phase-received-${signal}`);
      expect(groupExists(started.group)).toBe(false);
      expect(() => process.kill(started!.grandchild, 0)).toThrow(/ESRCH/);
      expect(await databaseExists(databaseName(databaseUrl!))).toBe(false);
    },
    // The harness creates and drops a database, and each may wait for a checkpoint for as long
    // as a database hook may.
    2 * inject("databaseHookTimeout"),
  );
});
