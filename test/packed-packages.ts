import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const repository = path.resolve(import.meta.dirname, "..");
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
  await run("pnpm", ["--silent", "pack", "--pack-destination", tarballs]);
  await run("pnpm", [
    "--silent",
    "--dir",
    "packages/drizzle",
    "pack",
    "--pack-destination",
    tarballs,
  ]);
  await run("pnpm", ["--silent", "--dir", "packages/hono", "pack", "--pack-destination", tarballs]);
  await run("pnpm", [
    "--silent",
    "--dir",
    "packages/dashboard",
    "pack",
    "--pack-destination",
    tarballs,
  ]);

  const coreTarball = path.join(tarballs, "workhorse-core-0.1.0.tgz");
  const drizzleTarball = path.join(tarballs, "workhorse-drizzle-0.1.0.tgz");
  const honoTarball = path.join(tarballs, "workhorse-hono-0.1.0.tgz");
  const dashboardTarball = path.join(tarballs, "workhorse-dashboard-0.1.0.tgz");
  const extracted = path.join(scratch, "core");
  await mkdir(extracted);
  await run("tar", ["-xzf", coreTarball, "-C", extracted]);

  const corePackage = JSON.parse(
    await readFile(path.join(extracted, "package", "package.json"), "utf8"),
  ) as Record<string, unknown>;
  const coreManifest = JSON.stringify(corePackage);
  if (
    coreManifest.includes('"drizzle-orm"') ||
    coreManifest.includes('"hono"') ||
    coreManifest.includes('"@hono/node-server"')
  ) {
    throw new Error("The packed core package manifest must not reference Drizzle or Hono");
  }
  for (const file of await filesBelow(path.join(extracted, "package", "dist"))) {
    if (!file.endsWith(".js")) continue;
    const source = await readFile(file, "utf8");
    if (source.includes('from "drizzle-orm"') || source.includes('from "hono')) {
      throw new Error(`The packed core package contains an ecosystem import in ${file}`);
    }
  }

  const dashboardExtracted = path.join(scratch, "dashboard");
  await mkdir(dashboardExtracted);
  await run("tar", ["-xzf", dashboardTarball, "-C", dashboardExtracted]);
  for (const required of [
    "dist/index.js",
    "dist/index.d.ts",
    "dist/model.js",
    "dist/model.d.ts",
    "dist/rpc-client.js",
    "dist/rpc-client.d.ts",
    "dist/server/index.js",
    "dist/server/index.d.ts",
    "dist/app/index.html",
    "dist/styles.css",
    "dist/assets/workhorse-mark.png",
    "dist/assets/workhorse-wordmark.png",
  ]) {
    await readFile(path.join(dashboardExtracted, "package", required));
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
          "@workhorse/core": `file:${coreTarball}`,
          "@workhorse/drizzle": `file:${drizzleTarball}`,
          "@workhorse/hono": `file:${honoTarball}`,
          "@workhorse/dashboard": `file:${dashboardTarball}`,
          "@hono/node-server": "2.0.11",
          "drizzle-orm": "0.45.2",
          hono: "4.12.31",
          pg: "8.16.3",
          typescript: "5.8.3",
          "@types/node": "24.1.0",
          "@types/pg": "8.15.5",
          react: "19.1.1",
          "react-dom": "19.1.1",
          "@types/react": "19.1.10",
          "@types/react-dom": "19.1.7",
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
import { defineWorkerProcess } from "@workhorse/core";
import { HonoWorkhorse, mountWorkhorseDashboard } from "@workhorse/hono";
import type { DashboardClient, DashboardProps } from "@workhorse/dashboard";\nimport { createDashboardHost, dashboardNodeMiddleware } from "@workhorse/dashboard/server";\nimport type { DashboardNodeMiddleware } from "@workhorse/dashboard/server";
import type { DashboardTaskCounts } from "@workhorse/dashboard/model";
import { drizzle } from "drizzle-orm/node-postgres";
import { Hono } from "hono";
import { Pool } from "pg";

const pool = new Pool();
const db = drizzle({ client: pool });
const adapter = createDrizzleAdapter(db);
const workerProcess = defineWorkerProcess({
  adapter: () => adapter,
  workers: [{ configure: (worker) => void worker.handle("typed", async () => ({ ok: true })) }],
  probes: { port: 9090 },
});
const integration = new HonoWorkhorse(adapter);
const app = new Hono();
// Mounting takes a database and a Queue, never a worker runtime, so a packed consumer can host the
// dashboard in a process that runs no workers at all.
mountWorkhorseDashboard(app, { database: pool, authorize: () => true });
const dashboardHost = createDashboardHost({ database: pool, authorize: () => true });
const nodeMiddleware: DashboardNodeMiddleware = dashboardNodeMiddleware(dashboardHost);
void nodeMiddleware;
void integration.context.queue;
void db.transaction(async (tx) => adapter.forTransaction(tx).enqueue("typed", { ok: true }));
declare const dashboardClient: DashboardClient;
const dashboardProps: DashboardProps = { client: dashboardClient, eventsUrl: null };
const dashboardCountsPromise: Promise<DashboardTaskCounts> = dashboardClient.taskCounts();
void dashboardProps;
void dashboardCountsPromise;
void workerProcess;
`,
  );
  await writeFile(
    path.join(consumer, "integration.mjs"),
    await readFile(path.join(repository, "test", "fixtures", "packed-consumer.mjs"), "utf8"),
  );

  await run("pnpm", ["install", "--ignore-scripts", "--frozen-lockfile=false"], consumer);
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
  process.stdout.write("Packed core, Drizzle, Hono, and dashboard consumer tests passed.\n");
} finally {
  await rm(scratch, { recursive: true, force: true });
}
