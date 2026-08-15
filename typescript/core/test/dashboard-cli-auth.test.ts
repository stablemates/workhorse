import { spawn } from "node:child_process";
import { scryptSync } from "node:crypto";
import { createServer } from "node:net";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it } from "vitest";

const repository = path.resolve(import.meta.dirname, "../../..");
const tsxCli = createRequire(import.meta.url).resolve("tsx/cli");
const children = new Set<ReturnType<typeof spawn>>();
const scratchRoots: string[] = [];

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
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
  for (const child of children) child.kill("SIGKILL");
  children.clear();
  await Promise.all(
    scratchRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("workhorse dashboard authentication", () => {
  it("refuses an unauthenticated remote listener", async () => {
    const child = spawn(
      process.execPath,
      [
        tsxCli,
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
    children.add(child);
    let output = "";
    child.stdout?.setEncoding("utf8").on("data", (chunk: string) => (output += chunk));
    child.stderr?.setEncoding("utf8").on("data", (chunk: string) => (output += chunk));
    const code = await new Promise<number | null>((resolve) => child.once("exit", resolve));

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

    const child = spawn(
      process.execPath,
      [
        tsxCli,
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
    children.add(child);
    await waitForDashboard(child);

    const protectedResponse = await fetch(`http://127.0.0.1:${port}/tasks`, {
      redirect: "manual",
    });
    const loginResponse = await fetch(`http://127.0.0.1:${port}/login`);

    expect(protectedResponse.status).toBe(302);
    expect(protectedResponse.headers.get("location")).toBe("/login");
    expect(loginResponse.status).toBe(200);
    expect(await loginResponse.text()).toContain("Sign in");

    child.kill("SIGTERM");
  });
});
