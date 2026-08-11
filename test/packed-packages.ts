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
  await run("pnpm", [
    "--silent",
    "--dir",
    "packages/prisma",
    "pack",
    "--pack-destination",
    tarballs,
  ]);
  await run("pnpm", [
    "--silent",
    "--dir",
    "packages/typeorm",
    "pack",
    "--pack-destination",
    tarballs,
  ]);
  await run("pnpm", [
    "--silent",
    "--dir",
    "packages/kysely",
    "pack",
    "--pack-destination",
    tarballs,
  ]);
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
  const prismaTarball = path.join(tarballs, "workhorse-prisma-0.1.0.tgz");
  const typeormTarball = path.join(tarballs, "workhorse-typeorm-0.1.0.tgz");
  const kyselyTarball = path.join(tarballs, "workhorse-kysely-0.1.0.tgz");
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
          "@workhorse/prisma": `file:${prismaTarball}`,
          "@workhorse/typeorm": `file:${typeormTarball}`,
          "@workhorse/kysely": `file:${kyselyTarball}`,
          "@workhorse/dashboard": `file:${dashboardTarball}`,
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
import type { DashboardClient, DashboardProps } from "@workhorse/dashboard";\nimport { createDashboardHost, dashboardNodeMiddleware } from "@workhorse/dashboard/server";\nimport type { DashboardNodeMiddleware } from "@workhorse/dashboard/server";
import type { DashboardTaskCounts } from "@workhorse/dashboard/model";
import { drizzle } from "drizzle-orm/node-postgres";
import type { PrismaClient, Prisma } from "@prisma/client";
import type { DataSource, EntityManager } from "typeorm";
import type { Kysely, Transaction } from "kysely";
import { Pool } from "pg";

const pool = new Pool();
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
void nodeMiddleware;
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
    await readFile(path.join(repository, "test", "fixtures", "packed-consumer.mjs"), "utf8"),
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
  process.stdout.write("Packed core, ORM providers, and dashboard consumer tests passed.\n");
} finally {
  await rm(scratch, { recursive: true, force: true });
}
