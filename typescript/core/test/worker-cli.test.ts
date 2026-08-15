import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it } from "vitest";

const repository = path.resolve(import.meta.dirname, "../../..");
const tsxCli = createRequire(import.meta.url).resolve("tsx/cli");
const scratchRoots: string[] = [];
const children = new Set<ReturnType<typeof spawn>>();

async function scratch(): Promise<string> {
  const root = await mkdtemp(
    path.join(process.env.JCODE_SCRATCH_DIR ?? tmpdir(), "workhorse-cli-"),
  );
  scratchRoots.push(root);
  return root;
}

async function waitForText(file: string, expected: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      if ((await readFile(file, "utf8")).includes(expected)) return;
    } catch {
      // The child has not created its marker file yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${expected} in ${file}`);
}

function runCli(args: string[], cwd: string) {
  const child = spawn(
    process.execPath,
    [tsxCli, path.join(repository, "typescript/core/src/cli/workhorse.ts"), ...args],
    { cwd, env: process.env, stdio: ["ignore", "pipe", "pipe"] },
  );
  children.add(child);
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("exit", (code, signal) => {
      children.delete(child);
      resolve({ code, signal });
    });
  });
  return { child, exited, output: () => ({ stdout, stderr }) };
}

afterEach(async () => {
  for (const child of children) child.kill("SIGKILL");
  children.clear();
  await Promise.all(
    scratchRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("workhorse worker CLI", () => {
  it("loads a configuration module and drains exactly once on SIGTERM", async () => {
    const cwd = await scratch();
    const marker = path.join(cwd, "lifecycle.log");
    await writeFile(
      path.join(cwd, "worker.mjs"),
      `import { appendFile } from "node:fs/promises";
const marker = ${JSON.stringify(marker)};
const keepalive = setInterval(() => {}, 1000);
let finish;
const worker = {
  run() {
    void appendFile(marker, "started\\n");
    return new Promise((resolve) => { finish = resolve; });
  },
  stop() {
    void appendFile(marker, "stopped\\n").then(() => setTimeout(finish, 30));
  },
};
export default {
  adapter: () => ({
    createWorker: () => worker,
    close: () => { clearInterval(keepalive); return appendFile(marker, "closed\\n"); },
  }),
  workers: [{ configure() {} }],
  shutdownTimeoutMs: 1000,
};
`,
    );

    const running = runCli(["worker", "--config", "./worker.mjs"], cwd);
    await waitForText(marker, "started");
    running.child.kill("SIGTERM");
    await expect(running.exited).resolves.toEqual({ code: 0, signal: null });
    expect(await readFile(marker, "utf8")).toBe("started\nstopped\nclosed\n");
    expect(running.output().stderr).toBe("");
  });

  it("hard exits when the graceful drain exceeds the CLI deadline", async () => {
    const cwd = await scratch();
    const marker = path.join(cwd, "lifecycle.log");
    await writeFile(
      path.join(cwd, "worker.mjs"),
      `import { appendFile } from "node:fs/promises";
const marker = ${JSON.stringify(marker)};
const keepalive = setInterval(() => {}, 1000);
let finish;
const worker = {
  run() {
    void appendFile(marker, "started\\n");
    return new Promise((resolve) => { finish = resolve; });
  },
  stop() {
    clearInterval(keepalive);
    void appendFile(marker, "stopped\\n").then(finish);
  },
};
export default {
  adapter: () => ({ createWorker: () => worker, close: () => new Promise(() => {}) }),
  workers: [{ configure() {} }],
};
`,
    );

    const running = runCli(
      ["worker", "--config", "./worker.mjs", "--shutdown-timeout-ms", "50"],
      cwd,
    );
    await waitForText(marker, "started");
    running.child.kill("SIGTERM");
    await expect(running.exited).resolves.toEqual({ code: 1, signal: null });
    expect(await readFile(marker, "utf8")).toContain("stopped\n");
    expect(running.output().stderr).toContain("Graceful shutdown exceeded 50ms");
  });

  it("reports import and configuration failures with a nonzero exit", async () => {
    const cwd = await scratch();
    await writeFile(path.join(cwd, "invalid.mjs"), "export default {};\n");
    const running = runCli(["worker", "--config", "./invalid.mjs"], cwd);

    await expect(running.exited).resolves.toEqual({ code: 1, signal: null });
    expect(running.output().stderr).toContain("must default-export defineWorkerProcess");
  });
});
