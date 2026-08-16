import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { publishedPackages, workspacePackages } from "../../../scripts/packages.js";
import { WORKHORSE_SCHEMA_VERSION } from "../src/schema.js";

const exec = promisify(execFile);
const repository = path.resolve(import.meta.dirname, "../../..");
const scratchRoot = process.env.JCODE_SCRATCH_DIR ?? tmpdir();
const scratch = await mkdtemp(path.join(scratchRoot, "workhorse-packed-"));

async function run(command: string, args: string[], cwd = repository): Promise<string> {
  const { stdout, stderr } = await exec(command, args, {
    cwd,
    env: { ...process.env, CI: "1" },
    maxBuffer: 20 * 1024 * 1024,
  });
  if (stderr.trim()) process.stderr.write(stderr);
  return stdout;
}

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

async function waitForContainer(port: number, containerId: string): Promise<Response> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/login`);
      if (response.status === 200) return response;
    } catch {
      // The listener is not ready yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const logs = await run("docker", ["logs", containerId]);
  throw new Error(`Packed dashboard container did not start: ${logs}`);
}

async function filesBelow(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const target = path.join(directory, entry.name);
      return entry.isDirectory() ? filesBelow(target) : [target];
    }),
  );
  return nested.flat();
}

try {
  await run("pnpm", ["build"]);
  const tarballs = path.join(scratch, "tarballs");
  await mkdir(tarballs);
  await run("pnpm", [
    "--silent",
    "--dir",
    "typescript/core",
    "pack",
    "--pack-destination",
    tarballs,
  ]);
  // Which packages get packed, and what each tarball is called, are read from the workspace rather
  // than listed here, so a new package is covered by this check the day it is added.
  const published = await publishedPackages();
  for (const entry of await workspacePackages()) {
    await run("pnpm", [
      "--silent",
      "--dir",
      entry.location,
      "pack",
      "--pack-destination",
      tarballs,
    ]);
  }

  const tarballFor = (name: string): string => {
    const entry = published.find((candidate) => candidate.name === name);
    if (!entry) throw new Error(`${name} is not a published package`);
    return path.join(tarballs, entry.tarball);
  };
  const coreTarball = tarballFor("@workhorse/core");
  const dashboardTarball = tarballFor("@workhorse/dashboard");
  const dashboardServerTarball = tarballFor("@workhorse/dashboard-server");
  const dashboardContainer = await readFile(path.join(repository, "Dockerfile.dashboard"), "utf8");
  for (const artifact of [
    "workhorse-core.tgz",
    "workhorse-dashboard.tgz",
    "workhorse-dashboard-contract.tgz",
    "workhorse-dashboard-server.tgz",
  ]) {
    if (!dashboardContainer.includes(`/artifacts/${artifact}`)) {
      throw new Error(`Dashboard container does not install packed artifact ${artifact}`);
    }
  }
  const extracted = path.join(scratch, "core");
  await mkdir(extracted);
  await run("tar", ["-xzf", coreTarball, "-C", extracted]);

  const corePackage = JSON.parse(
    await readFile(path.join(extracted, "package", "package.json"), "utf8"),
  ) as Record<string, unknown>;
  const coreManifest = JSON.stringify(corePackage);
  if (
    coreManifest.includes('"drizzle-orm"') ||
    coreManifest.includes('"@prisma/client"') ||
    coreManifest.includes('"typeorm"') ||
    coreManifest.includes('"kysely"') ||
    coreManifest.includes('"hono"') ||
    coreManifest.includes('"@hono/node-server"')
  ) {
    throw new Error("The packed core package manifest must not reference an ORM or Hono");
  }
  for (const file of await filesBelow(path.join(extracted, "package", "dist"))) {
    if (!file.endsWith(".js")) continue;
    const source = await readFile(file, "utf8");
    if (
      /^\s*(?:import|export)\s.+\sfrom\s+["'](?:drizzle-orm(?:\/|["'])|@prisma\/client(?:\/|["'])|typeorm(?:\/|["'])|kysely(?:\/|["'])|hono(?:\/|["']))/m.test(
        source,
      )
    ) {
      throw new Error(`The packed core package contains an ecosystem import in ${file}`);
    }
  }

  const dashboardExtracted = path.join(scratch, "dashboard");
  await mkdir(dashboardExtracted);
  await run("tar", ["-xzf", dashboardTarball, "-C", dashboardExtracted]);
  for (const required of [
    "dist/index.js",
    "dist/index.d.ts",
    "dist/wire.js",
    "dist/wire.d.ts",
    "dist/presentation.js",
    "dist/presentation.d.ts",
    "dist/server.js",
    "dist/standalone.js",
    "dist/styles.css",
    "dist/assets/workhorse-mark.svg",
    "dist/assets/workhorse-wordmark.svg",
  ]) {
    await readFile(path.join(dashboardExtracted, "package", required));
  }

  const dashboardServerExtracted = path.join(scratch, "dashboard-server");
  await mkdir(dashboardServerExtracted);
  await run("tar", ["-xzf", dashboardServerTarball, "-C", dashboardServerExtracted]);
  for (const required of [
    "dist/index.js",
    "dist/index.d.ts",
    "dist/wire.js",
    "dist/wire.d.ts",
    "dist/rpc-client.js",
    "dist/rpc-client.d.ts",
    "dist/server/index.js",
    "dist/server/index.d.ts",
    "dist/server/standalone.js",
    "dist/server/standalone.d.ts",
    "dist/app/index.html",
  ]) {
    await readFile(path.join(dashboardServerExtracted, "package", required));
  }

  const consumer = path.join(scratch, "consumer");
  await mkdir(consumer);
  await writeFile(
    path.join(consumer, "package.json"),
    JSON.stringify(
      {
        name: "workhorse-packed-consumer",
        private: true,
        type: "module",
        dependencies: {
          ...Object.fromEntries(
            published.map((entry) => [entry.name, `file:${path.join(tarballs, entry.tarball)}`]),
          ),
          "drizzle-orm": "0.45.2",
          "@prisma/client": "6.19.3",
          prisma: "6.19.3",
          typeorm: "0.3.31",
          kysely: "0.29.5",
          pg: "8.16.3",
          typescript: "5.8.3",
          "@types/node": "24.1.0",
          "@types/pg": "8.15.5",
          react: "19.1.1",
          "react-dom": "19.1.1",
          "@types/react": "19.1.10",
          "@types/react-dom": "19.1.7",
        },
        pnpm: {
          // Published packages can depend on another package from the same unreleased lockstep set.
          // Force those nested edges through the tarballs under test instead of the public registry.
          overrides: Object.fromEntries(
            published.map((entry) => [entry.name, `file:${path.join(tarballs, entry.tarball)}`]),
          ),
        },
      },
      null,
      2,
    ),
  );
  await writeFile(
    path.join(consumer, "tsconfig.json"),
    JSON.stringify(
      {
        compilerOptions: {
          target: "ES2022",
          module: "NodeNext",
          moduleResolution: "NodeNext",
          strict: true,
          noEmit: true,
          skipLibCheck: true,
        },
        include: ["type-smoke.ts"],
      },
      null,
      2,
    ),
  );
  await writeFile(
    path.join(consumer, "type-smoke.ts"),
    `import { createDrizzleAdapter } from "@workhorse/drizzle";
import { createPrismaAdapter } from "@workhorse/prisma";
import { createTypeOrmAdapter } from "@workhorse/typeorm";
import { createKyselyAdapter } from "@workhorse/kysely";
import { defineWorkerProcess } from "@workhorse/core";
import type { DashboardClient, DashboardProps } from "@workhorse/dashboard";
import { createDashboardHost, dashboardNodeMiddleware } from "@workhorse/dashboard/server";
import type { DashboardNodeMiddleware } from "@workhorse/dashboard/server";
import { startDashboardServer as startStandaloneDashboard } from "@workhorse/dashboard/standalone";
import type { DashboardCommandOptions, DashboardStandaloneModule } from "@workhorse/dashboard-contract";
import type { DashboardTaskCounts } from "@workhorse/dashboard/wire";
import { describeRetryPolicy } from "@workhorse/dashboard/presentation";
import { drizzle } from "drizzle-orm/node-postgres";
import type { PrismaClient, Prisma } from "@prisma/client";
import type { DataSource, EntityManager } from "typeorm";
import type { Kysely, Transaction } from "kysely";
import { Pool } from "pg";

const pool = new Pool();
void describeRetryPolicy(null);
const db = drizzle({ client: pool });
const adapter = createDrizzleAdapter(db);
declare const prisma: PrismaClient;
declare const prismaTransaction: Prisma.TransactionClient;
const prismaAdapter = createPrismaAdapter(prisma);
declare const dataSource: DataSource;
declare const entityManager: EntityManager;
const typeOrmAdapter = createTypeOrmAdapter(dataSource);
declare const kysely: Kysely<Record<string, never>>;
declare const kyselyTransaction: Transaction<Record<string, never>>;
const kyselyAdapter = createKyselyAdapter(kysely);
const workerProcess = defineWorkerProcess({
  adapter: () => adapter,
  workers: [{ configure: (worker) => void worker.handle("typed", async () => ({ ok: true })) }],
  probes: { port: 9090 },
});
const dashboardHost = createDashboardHost({ database: pool, authorize: () => true });
const nodeMiddleware: DashboardNodeMiddleware = dashboardNodeMiddleware(dashboardHost);
const standaloneStart: DashboardStandaloneModule<Pool>["startDashboardServer"] = startStandaloneDashboard;
const standaloneOptions: DashboardCommandOptions = {
  port: 3000,
  hostname: "127.0.0.1",
  allowMutations: false,
  actor: "packed-test",
  authentication: {
    username: "operator",
    passwordHash: "scrypt-v1$c2FsdC1sb25nLWVub3VnaA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  },
};
void nodeMiddleware;
void standaloneStart;
void standaloneOptions;
void db.transaction(async (tx) => adapter.forTransaction(tx).enqueue("typed", { ok: true }));
void prismaAdapter.forTransaction(prismaTransaction).enqueue("typed", { ok: true });
void typeOrmAdapter.forTransaction(entityManager).enqueue("typed", { ok: true });
void kyselyAdapter.forTransaction(kyselyTransaction).enqueue("typed", { ok: true });
declare const dashboardClient: DashboardClient;
const dashboardProps: DashboardProps = { client: dashboardClient };
const dashboardCountsPromise: Promise<DashboardTaskCounts> = dashboardClient.taskCounts();
void dashboardProps;
void dashboardCountsPromise;
void workerProcess;
`,
  );
  const prismaDirectory = path.join(consumer, "prisma");
  await mkdir(prismaDirectory);
  await writeFile(
    path.join(prismaDirectory, "schema.prisma"),
    `generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}
`,
  );
  await writeFile(
    path.join(consumer, "integration.mjs"),
    await readFile(
      path.join(repository, "typescript", "core", "test", "fixtures", "packed-consumer.mjs"),
      "utf8",
    ),
  );
  await writeFile(
    path.join(consumer, "agentic-flow.mjs"),
    await readFile(path.join(repository, "typescript", "examples", "agentic-flow.mjs"), "utf8"),
  );
  await writeFile(
    path.join(consumer, "dashboard-auth.mjs"),
    `import assert from "node:assert/strict";
import { scryptSync } from "node:crypto";
import { createDashboardClient } from "@workhorse/dashboard/client";
import { createDashboardHost } from "@workhorse/dashboard/server";

globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
const { Dashboard } = await import("@workhorse/dashboard");
assert.equal(typeof Dashboard, "function");
const salt = Buffer.from("packed-dashboard-auth-salt");
const passwordHash = \`scrypt-v1$\${salt.toString("base64url")}$\${scryptSync("correct horse", salt, 32).toString("base64url")}\`;
const database = { query: async () => ({ rows: [{ version: ${WORKHORSE_SCHEMA_VERSION} }] }) };
const audits = [];
const host = createDashboardHost({
  database,
  path: "/",
  singleAdmin: { username: "operator", passwordHash, sessionTtlSeconds: 60 },
  operator: { mode: "writable" },
  queueController: {
    setQueuePaused: async (_queue, paused, audit) => {
      audits.push(audit);
      return { paused };
    },
  },
});

const protectedResponse = await host.handle(new Request("https://dashboard.test/tasks"));
assert.equal(protectedResponse.status, 302);
assert.equal(protectedResponse.headers.get("location"), "/login");
const protectedAsset = await host.handle(new Request("https://dashboard.test/assets/index.js"));
assert.equal(protectedAsset.status, 401);
const protectedRpc = await host.handle(new Request("https://dashboard.test/rpc/dashboard/meta"));
assert.equal(protectedRpc.status, 401);

globalThis.window = { location: { origin: "https://dashboard.test" } };
const realFetch = globalThis.fetch;
const mutationInput = {
  queue: "payments",
  paused: true,
  audit: { actor: "forged-browser-actor", reason: "deploy", requestId: "request-1" },
};
const mutationClient = (headers) => {
  globalThis.fetch = async (request) => {
    const forwarded = new Request(request, { headers: new Headers(request.headers) });
    for (const [name, value] of Object.entries(headers)) forwarded.headers.set(name, value);
    return await host.handle(forwarded);
  };
  return createDashboardClient("/rpc");
};
await assert.rejects(
  () => mutationClient({ origin: "https://dashboard.test" }).setQueuePaused(mutationInput),
  /Unauthorized/,
);

const realNow = Date.now;
Date.now = () => 1_000_000;
const login = await host.handle(new Request("https://dashboard.test/login", {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ username: "operator", password: "correct horse" }),
}));
assert.equal(login.status, 303);
const setCookie = login.headers.get("set-cookie");
assert.match(setCookie, /HttpOnly; Secure; SameSite=Strict$/);
const cookie = setCookie.split(";", 1)[0];
const authenticated = await host.handle(new Request("https://dashboard.test/", {
  headers: { cookie },
}));
assert.equal(authenticated.status, 302);
assert.equal(authenticated.headers.get("location"), "/tasks");

await assert.rejects(() => mutationClient({ cookie }).setQueuePaused(mutationInput), /Forbidden/);
await assert.rejects(
  () => mutationClient({ cookie, origin: "https://attacker.test" }).setQueuePaused(mutationInput),
  /Forbidden/,
);
assert.equal(audits.length, 0);
const client = mutationClient({ cookie, origin: "https://dashboard.test" });
assert.deepEqual(await client.setQueuePaused(mutationInput), { paused: true });
assert.equal(audits[0].actor, "operator");
globalThis.fetch = realFetch;

Date.now = () => 1_060_001;
const expired = await host.handle(new Request("https://dashboard.test/tasks", { headers: { cookie } }));
assert.equal(expired.status, 302);

Date.now = realNow;
const secondLogin = await host.handle(new Request("https://dashboard.test/login", {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ username: "operator", password: "correct horse" }),
}));
const secondCookie = secondLogin.headers.get("set-cookie").split(";", 1)[0];
const logout = await host.handle(new Request("https://dashboard.test/logout", {
  method: "POST",
  headers: { cookie: secondCookie },
}));
assert.equal(logout.status, 303);
const loggedOut = await host.handle(new Request("https://dashboard.test/tasks", {
  headers: { cookie: secondCookie },
}));
assert.equal(loggedOut.status, 302);
`,
  );
  await writeFile(
    path.join(consumer, "dashboard-standalone.mjs"),
    `import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { scryptSync } from "node:crypto";
import { createServer } from "node:net";

const portServer = createServer();
await new Promise((resolve, reject) => {
  portServer.once("error", reject);
  portServer.listen(0, "127.0.0.1", resolve);
});
const address = portServer.address();
const port = typeof address === "object" && address ? address.port : 0;
await new Promise((resolve) => portServer.close(resolve));

const salt = Buffer.from("packed-standalone-auth-salt");
const passwordHash = \`scrypt-v1$\${salt.toString("base64url")}$\${scryptSync("correct horse", salt, 32).toString("base64url")}\`;
const child = spawn(process.execPath, [
  "node_modules/@workhorse/core/dist/src/cli/workhorse.js",
  "dashboard",
  "--database-url",
  "postgres://unused:unused@127.0.0.1:1/unused",
  "--host",
  "0.0.0.0",
  "--port",
  String(port),
], {
  env: {
    ...process.env,
    WORKHORSE_DASHBOARD_USERNAME: "operator",
    WORKHORSE_DASHBOARD_PASSWORD_HASH: passwordHash,
    WORKHORSE_DASHBOARD_PUBLIC_ORIGIN: "https://dashboard.example",
  },
  stdio: ["ignore", "pipe", "pipe"],
});

let output = "";
try {
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Packed dashboard did not start: " + output)), 5_000);
    child.stdout.setEncoding("utf8").on("data", (chunk) => {
      output += chunk;
      if (!output.includes("Workhorse dashboard on")) return;
      clearTimeout(timeout);
      resolve();
    });
    child.stderr.setEncoding("utf8").on("data", (chunk) => (output += chunk));
    child.once("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error("Packed dashboard exited with " + code + ": " + output));
    });
  });
  const protectedResponse = await fetch("http://127.0.0.1:" + port + "/tasks", { redirect: "manual" });
  assert.equal(protectedResponse.status, 302);
  assert.equal(protectedResponse.headers.get("location"), "/login");
  const loginResponse = await fetch("http://127.0.0.1:" + port + "/login");
  assert.equal(loginResponse.status, 200);
  assert.match(await loginResponse.text(), /Sign in/);
} finally {
  child.kill("SIGKILL");
}
`,
  );

  await run("pnpm", ["install", "--ignore-scripts", "--frozen-lockfile=false"], consumer);
  await run("pnpm", ["exec", "prisma", "generate", "--schema", "prisma/schema.prisma"], consumer);
  await run("pnpm", ["exec", "tsc", "-p", "tsconfig.json"], consumer);
  const cliHelp = await run(
    "node",
    ["node_modules/@workhorse/core/dist/src/cli/workhorse.js", "--help"],
    consumer,
  );
  if (!cliHelp.includes("workhorse worker --config")) {
    throw new Error("The packed Workhorse CLI did not expose worker command help");
  }
  await run("node", ["integration.mjs"], consumer);
  const agenticFlow = JSON.parse(await run("node", ["agentic-flow.mjs"], consumer)) as {
    result?: { status?: string };
    progress?: { stage?: string };
  };
  if (agenticFlow.result?.status !== "completed" || agenticFlow.progress?.stage !== "finalizing") {
    throw new Error("The packed agentic flow did not complete its durable lifecycle");
  }
  await run("node", ["dashboard-auth.mjs"], consumer);
  await run("node", ["dashboard-standalone.mjs"], consumer);

  const image = `workhorse-dashboard-packed-test:${process.pid}`;
  const containerName = `workhorse-dashboard-packed-${process.pid}`;
  let containerId: string | undefined;
  try {
    await run("docker", ["build", "-f", "Dockerfile.dashboard", "-t", image, "."]);
    const port = await availablePort();
    containerId = (
      await run("docker", [
        "run",
        "--rm",
        "-d",
        "--name",
        containerName,
        "-p",
        `127.0.0.1:${port}:3000`,
        "-e",
        "DATABASE_URL=postgres://unused:unused@127.0.0.1:1/unused",
        "-e",
        "WORKHORSE_DASHBOARD_USERNAME=operator",
        "-e",
        "WORKHORSE_DASHBOARD_PASSWORD_HASH=scrypt-v1$d29ya2hvcnNlLWF1dGgtc2FsdA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        "-e",
        "WORKHORSE_DASHBOARD_PUBLIC_ORIGIN=https://dashboard.example",
        image,
      ])
    ).trim();
    const loginResponse = await waitForContainer(port, containerId);
    if (!(await loginResponse.text()).includes("Sign in")) {
      throw new Error("Packed dashboard container did not serve the login page");
    }
    const protectedResponse = await fetch(`http://127.0.0.1:${port}/tasks`, {
      redirect: "manual",
    });
    if (
      protectedResponse.status !== 302 ||
      protectedResponse.headers.get("location") !== "/login"
    ) {
      throw new Error("Packed dashboard container did not protect the application route");
    }
    if ((await run("docker", ["exec", containerId, "id", "-u"])).trim() === "0") {
      throw new Error("Packed dashboard container must not run as root");
    }
  } finally {
    if (containerId) await exec("docker", ["stop", containerId]).catch(() => undefined);
    await exec("docker", ["image", "rm", image]).catch(() => undefined);
  }
  process.stdout.write("Packed core, ORM providers, and dashboard consumer tests passed.\n");
} finally {
  await rm(scratch, { recursive: true, force: true });
}
