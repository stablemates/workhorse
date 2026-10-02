import { execFileSync, spawn } from "node:child_process";
import assert from "node:assert/strict";
import { scryptSync } from "node:crypto";
import { createServer } from "node:net";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { cliNodeArgs } from "./support/cli-process.js";

const repository = path.resolve(import.meta.dirname, "../../..");
const children = new Map<ReturnType<typeof spawn>, Promise<void>>();
const scratchRoots: string[] = [];
const dashboardPorts = new Set<number>();

// Check the real CLI processes, rather than only the handles returned by spawn: tsx/cli
// can exit while the Node process hosting the dashboard is still listening. Scope the
// check to our listener ports because other files exercise dashboard --help in parallel.
afterAll(() => {
  const processes = execFileSync("ps", ["-A", "-o", "args="], { encoding: "utf8" });
  assert.deepEqual(
    processes
      .split("\n")
      .filter(
        (command) =>
          command.includes(path.join(repository, "typescript/core/src/cli/workhorse.ts")) &&
          /\bworkhorse\.ts dashboard\b/.test(command) &&
          [...dashboardPorts].some((port) => new RegExp(`--port ${port}(?:\\s|$)`).test(command)),
      ),
    [],
    "No dashboard process started by this file may survive teardown",
  );
});

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
  return port;
}

async function waitForDashboard(child: ReturnType<typeof spawn>): Promise<string> {
  return new Promise((resolve, reject) => {
    let output = "";
    const timeout = setTimeout(
      () => reject(new Error(`Dashboard did not start: ${output}`)),
      5_000,
    );
    child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
      output += chunk;
      if (!output.includes("Workhorse dashboard on")) return;
      clearTimeout(timeout);
      resolve(output);
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`Dashboard exited with ${String(code)}: ${output}`));
    });
  });
}

afterEach(async () => {
  await Promise.all(
    [...children].map(([child, closed]) => {
      child.kill("SIGKILL");
      return closed;
    }),
  );
  children.clear();
  await Promise.all(
    scratchRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe.skipIf(
  !existsSync(path.join(repository, "typescript/dashboard-server/dist/app/index.html")),
)("workhorse dashboard authentication (requires the built dashboard browser bundle)", () => {
  it("refuses an unauthenticated remote listener", async () => {
    const child = spawn(
      process.execPath,
      [
        ...cliNodeArgs,
        path.join(repository, "typescript/core/src/cli/workhorse.ts"),
        "dashboard",
        "--database-url",
        "postgres://unused:unused@127.0.0.1:1/unused",
        "--host",
        "0.0.0.0",
      ],
      {
        cwd: repository,
        env: {
          ...process.env,
          WORKHORSE_DASHBOARD_USERNAME: undefined,
          WORKHORSE_DASHBOARD_PASSWORD_HASH: undefined,
          WORKHORSE_DASHBOARD_USERNAME_FILE: undefined,
          WORKHORSE_DASHBOARD_PASSWORD_HASH_FILE: undefined,
          WORKHORSE_DASHBOARD_PUBLIC_ORIGIN: undefined,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    children.set(
      child,
      new Promise((resolve) => {
        child.once("close", () => resolve());
      }),
    );
    let output = "";
    child.stdout?.setEncoding("utf8").on("data", (chunk: string) => (output += chunk));
    child.stderr?.setEncoding("utf8").on("data", (chunk: string) => (output += chunk));
    const code = await new Promise<number | null>((resolve) => {
      child.once("exit", resolve);
    });

    expect(code).toBe(1);
    expect(output).toMatch(/unauthenticated.*loopback|loopback.*unauthenticated/i);
  });

  it("loads container secret files and protects the standalone listener", async () => {
    const scratch = await mkdtemp(path.join(tmpdir(), "workhorse-dashboard-auth-"));
    scratchRoots.push(scratch);
    const usernameFile = path.join(scratch, "username");
    const passwordHashFile = path.join(scratch, "password-hash");
    const salt = Buffer.from("workhorse-cli-auth-salt");
    const passwordHash = `scrypt-v1$${salt.toString("base64url")}$${scryptSync("correct horse", salt, 32).toString("base64url")}`;
    await writeFile(usernameFile, "operator\n");
    await writeFile(passwordHashFile, `${passwordHash}\n`);
    const port = await availablePort();
    dashboardPorts.add(port);

    const child = spawn(
      process.execPath,
      [
        ...cliNodeArgs,
        path.join(repository, "typescript/core/src/cli/workhorse.ts"),
        "dashboard",
        "--database-url",
        "postgres://unused:unused@127.0.0.1:1/unused",
        "--port",
        String(port),
      ],
      {
        cwd: repository,
        env: {
          ...process.env,
          WORKHORSE_DASHBOARD_USERNAME: undefined,
          WORKHORSE_DASHBOARD_PASSWORD_HASH: undefined,
          WORKHORSE_DASHBOARD_USERNAME_FILE: usernameFile,
          WORKHORSE_DASHBOARD_PASSWORD_HASH_FILE: passwordHashFile,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    children.set(
      child,
      new Promise((resolve) => {
        child.once("close", () => resolve());
      }),
    );
    await waitForDashboard(child);

    const protectedResponse = await fetch(`http://127.0.0.1:${port}/tasks`, {
      redirect: "manual",
    });
    const loginResponse = await fetch(`http://127.0.0.1:${port}/login`);

    expect(protectedResponse.status).toBe(302);
    expect(protectedResponse.headers.get("location")).toBe("/login");
    expect(loginResponse.status).toBe(200);
    expect(await loginResponse.text()).toContain("Sign in");

    // Leave the listener running so afterEach exercises forced cleanup too.
  });
});
