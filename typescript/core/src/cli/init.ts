import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Project shape detected from an existing application's dependencies.
 *
 * Detection is a convenience for scaffolding only. Nothing at runtime branches on it, and a wrong
 * guess costs the user one edit to a generated file rather than a broken installation.
 */
export interface DetectedProject {
  orm: "drizzle" | "prisma" | "typeorm" | "kysely" | "pg";
  framework: "hono" | "express" | "fastify" | "next" | "none";
  typescript: boolean;
  packageManager: PackageManager;
  /**
   * The major version of the installed `@prisma/client`. `initializeProject` reads it only for a
   * Prisma project. When it is absent or below 7, the Prisma template uses the Prisma 6
   * constructor.
   */
  prismaMajor?: number;
}

/** A package manager whose `workhorse` invocation the next steps can print. */
export type PackageManager = "pnpm" | "npm" | "yarn" | "bun";

interface PackageJson {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  packageManager?: string;
  scripts?: Record<string, string>;
}

async function readPackageJson(directory: string): Promise<PackageJson | null> {
  try {
    return JSON.parse(await readFile(path.join(directory, "package.json"), "utf8")) as PackageJson;
  } catch {
    return null;
  }
}

/**
 * Every lockfile that identifies its installer, most specific first. Bun and Yarn share
 * `yarn.lock`, so Bun's own lockfile is checked before it.
 */
const LOCKFILES: readonly (readonly [string, PackageManager])[] = [
  ["pnpm-lock.yaml", "pnpm"],
  ["bun.lock", "bun"],
  ["bun.lockb", "bun"],
  ["yarn.lock", "yarn"],
  ["package-lock.json", "npm"],
  ["npm-shrinkwrap.json", "npm"],
];

/** The installer that wrote this directory's lockfile, or `null` when it holds none. */
async function readLockfileManager(directory: string): Promise<PackageManager | null> {
  for (const [fileName, packageManager] of LOCKFILES) {
    const present = await stat(path.join(directory, fileName)).then(
      () => true,
      () => false,
    );
    if (present) return packageManager;
  }
  return null;
}

/**
 * Read the `package.json` of an installed package, as Node.js resolution finds it from `directory`:
 * in `node_modules` of the directory or of a parent directory. Returns `null` when no directory
 * holds the package, or when its manifest cannot be read.
 */
async function readInstalledPackage(
  directory: string,
  name: string,
): Promise<{ version?: unknown } | null> {
  let current = path.resolve(directory);
  for (;;) {
    try {
      return JSON.parse(
        await readFile(path.join(current, "node_modules", name, "package.json"), "utf8"),
      ) as { version?: unknown };
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return null;
      current = parent;
    }
  }
}

/** The major of a semantic version such as `7.10.1`, or `null` when the text is not one. */
function parseMajor(version: unknown): number | null {
  if (typeof version !== "string") return null;
  const match = /^(\d+)\./.exec(version.trim());
  return match ? Number(match[1]) : null;
}

/** The command that adds one dependency with this package manager. */
function addCommand(packageManager: PackageManager, name: string): string {
  return packageManager === "npm" ? `npm install ${name}` : `${packageManager} add ${name}`;
}

/**
 * Name the package manager a project already uses.
 *
 * The `packageManager` field is a declaration, so it decides on its own. Most projects omit it,
 * and for those the lockfile the installer wrote is the next-best evidence: printing `pnpm` next
 * steps to a reader who ran `npm install` hands them a command that does not exist.
 */
export function detectPackageManager(
  declared: string | undefined,
  lockfile: PackageManager | null,
): PackageManager {
  const field = declared ?? "";
  if (field.startsWith("yarn")) return "yarn";
  if (field.startsWith("bun")) return "bun";
  if (field.startsWith("npm")) return "npm";
  if (field.startsWith("pnpm")) return "pnpm";
  return lockfile ?? "pnpm";
}

export function detectProject(
  packageJson: PackageJson | null,
  lockfile: PackageManager | null = null,
): DetectedProject {
  const dependencies = { ...packageJson?.dependencies, ...packageJson?.devDependencies };
  const has = (name: string): boolean => name in dependencies;

  const packageManager = detectPackageManager(packageJson?.packageManager, lockfile);

  return {
    orm: has("drizzle-orm")
      ? "drizzle"
      : has("@prisma/client")
        ? "prisma"
        : has("typeorm")
          ? "typeorm"
          : has("kysely")
            ? "kysely"
            : "pg",
    framework: has("hono")
      ? "hono"
      : has("next")
        ? "next"
        : has("express")
          ? "express"
          : has("fastify")
            ? "fastify"
            : "none",
    typescript: has("typescript"),
    packageManager,
  };
}

/** The worker process configuration. This is the only file `init` writes. */
export function renderWorkerConfig(project: DetectedProject): string {
  let adapterImport: string;
  let adapterBody: string;
  switch (project.orm) {
    case "drizzle": {
      adapterImport =
        'import { createDrizzleAdapter } from "@stablemates/workhorse-drizzle";\nimport { drizzle as createDrizzle } from "drizzle-orm/node-postgres";';
      adapterBody = `    const pool = new Pool({ connectionString: databaseUrl });
    return createDrizzleAdapter(createDrizzle({ client: pool }), {
      defaultQueue: QUEUE,
      close: () => pool.end(),
    });`;
      break;
    }
    case "prisma": {
      // Prisma 7 removes the `datasources` option and requires a driver adapter.
      const prisma7 = (project.prismaMajor ?? 6) >= 7;
      adapterImport = prisma7
        ? 'import { PrismaPg } from "@prisma/adapter-pg";\nimport { PrismaClient } from "@prisma/client";\nimport { createPrismaAdapter } from "@stablemates/workhorse-prisma";'
        : 'import { PrismaClient } from "@prisma/client";\nimport { createPrismaAdapter } from "@stablemates/workhorse-prisma";';
      const constructor = prisma7
        ? `new PrismaClient({
      adapter: new PrismaPg({ connectionString: databaseUrl }),
    })`
        : "new PrismaClient({ datasources: { db: { url: databaseUrl } } })";
      adapterBody = `    const pool = new Pool({ connectionString: databaseUrl });
    const database = ${constructor};
    return createPrismaAdapter(database, {
      defaultQueue: QUEUE,
      pool,
      close: async () => {
        await database.$disconnect();
        await pool.end();
      },
    });`;
      break;
    }
    case "typeorm": {
      adapterImport =
        'import { createTypeOrmAdapter } from "@stablemates/workhorse-typeorm";\nimport { DataSource } from "typeorm";';
      adapterBody = `    const database = new DataSource({ type: "postgres", url: databaseUrl });
    await database.initialize();
    return createTypeOrmAdapter(database, {
      defaultQueue: QUEUE,
      close: () => database.destroy(),
    });`;
      break;
    }
    case "kysely": {
      adapterImport =
        'import { createKyselyAdapter } from "@stablemates/workhorse-kysely";\nimport { Kysely, PostgresDialect } from "kysely";';
      adapterBody = `    const pool = new Pool({ connectionString: databaseUrl });
    const database = new Kysely({ dialect: new PostgresDialect({ pool }) });
    return createKyselyAdapter(database, {
      defaultQueue: QUEUE,
      pool,
      close: () => database.destroy(),
    });`;
      break;
    }
    case "pg": {
      adapterImport = "";
      adapterBody = `    const pool = new Pool({ connectionString: databaseUrl });
    return createWorkhorseAdapter({
      database: pool,
      defaultQueue: QUEUE,
      adaptTransaction: (transaction) => transaction,
      close: () => pool.end(),
    });`;
      break;
    }
  }

  const coreImports =
    project.orm === "pg"
      ? "createWorkhorseAdapter, defineWorkerProcess, Pool"
      : project.orm === "typeorm"
        ? "defineWorkerProcess"
        : "defineWorkerProcess, Pool";
  return `import { ${coreImports} } from "@stablemates/workhorse";
${adapterImport}

/**
 * Workhorse worker process.
 *
 * Workers run as their own process and share nothing with your web tier except PostgreSQL. Start
 * them with:
 *
 *   workhorse worker --config <compiled path to this file>
 *
 * Your dashboard mount does not need to know these workers exist: they register themselves in
 * PostgreSQL, and the dashboard reads the fleet from there.
 */
const QUEUE = "default";
const databaseUrl = process.env.WORKHORSE_DATABASE_URL ?? process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("Set DATABASE_URL or WORKHORSE_DATABASE_URL");

export default defineWorkerProcess({
  async adapter() {
${adapterBody}
  },
  workers: [
    {
      options: {
        queue: QUEUE,
        concurrency: 1,
      },
      configure(worker) {
        worker.handle("example.task", async (payload) => {
          console.log("handling", payload);
          return { ok: true };
        });
      },
    },
  ],
});
`;
}

/** The mount snippet printed for the detected framework. Nothing is written into user routes. */
export function renderMountSnippet(project: DetectedProject): string {
  if (project.framework === "hono") {
    return `import { createDashboardHost } from "@stablemates/workhorse-dashboard/server";

const host = createDashboardHost({
  path: "/workhorse",
  database: pool,
  authorize: (request) => isOperator(request),
});
for (const route of ["/workhorse", "/workhorse/*"]) {
  app.all(route, async (context) =>
    (await host.handle(context.req.raw)) ?? context.notFound(),
  );
}`;
  }
  if (project.framework === "express" || project.framework === "fastify") {
    const mount =
      project.framework === "express"
        ? "app.use(dashboardNodeMiddleware(host));"
        : "await app.register(middie);\napp.use(dashboardNodeMiddleware(host));";
    return `import { createDashboardHost, dashboardNodeMiddleware } from "@stablemates/workhorse-dashboard/server";

const host = createDashboardHost({
  path: "/workhorse",
  database: pool,
  authorize: (request) => isOperator(request),
});
${mount}`;
  }
  if (project.framework === "next") {
    return `// app/workhorse/[[...path]]/route.ts
import { createDashboardHost } from "@stablemates/workhorse-dashboard/server";

const host = createDashboardHost({
  path: "/workhorse",
  database: pool,
  authorize: (request) => isOperator(request),
});

async function handler(request: Request) {
  return (await host.handle(request)) ?? new Response("Not found", { status: 404 });
}

export { handler as GET, handler as POST };`;
  }
  return `import { createDashboardHost } from "@stablemates/workhorse-dashboard/server";

// The host is framework-neutral: give it a Request, it returns a Response or null.
const host = createDashboardHost({
  path: "/workhorse",
  database: pool,
  authorize: (request) => isOperator(request),
});`;
}

export interface InitResult {
  configPath: string;
  written: boolean;
  project: DetectedProject;
  nextSteps: string[];
}

/**
 * Scaffold a Workhorse worker configuration in an existing project.
 *
 * This deliberately writes exactly one file and never edits `package.json`, application routes, or
 * anything else it does not own. Everything else is printed for the user to apply themselves.
 */
export async function initializeProject(
  directory: string,
  options: { force?: boolean; fileName?: string } = {},
): Promise<InitResult> {
  const packageJson = await readPackageJson(directory);
  const project = detectProject(packageJson, await readLockfileManager(directory));
  const prismaSteps: string[] = [];
  if (project.orm === "prisma") {
    const installed = await readInstalledPackage(directory, "@prisma/client");
    const major = parseMajor(installed?.version);
    if (major === null) {
      prismaSteps.push(
        "Check the Prisma client: init could not read the installed @prisma/client version.",
        "  The file uses the Prisma 6 constructor. On Prisma 7, use a driver adapter:",
        "  https://workhorse.run/docs/prisma#create-the-adapter",
      );
    } else {
      project.prismaMajor = major;
      if (major >= 7 && (await readInstalledPackage(directory, "@prisma/adapter-pg")) === null) {
        prismaSteps.push(
          `Install the driver adapter:  ${addCommand(project.packageManager, "@prisma/adapter-pg")}`,
        );
      }
    }
  }
  const fileName =
    options.fileName ?? (project.typescript ? "workhorse.config.ts" : "workhorse.config.js");
  const configPath = path.join(directory, fileName);

  let written = false;
  const exists = await readFile(configPath, "utf8").then(
    () => true,
    () => false,
  );
  if (!exists || options.force) {
    await writeFile(configPath, renderWorkerConfig(project), "utf8");
    written = true;
  }

  // `npm exec --no --` runs the binary in `node_modules` or fails. Bare `npx workhorse` would
  // fetch an unrelated package of that name from the registry when the local one is missing.
  const run = project.packageManager === "npm" ? "npm exec --no --" : project.packageManager;
  return {
    configPath,
    written,
    project,
    nextSteps: [
      ...prismaSteps,
      `Install the schema:  ${run} workhorse schema install`,
      `Run the workers:     ${run} workhorse worker --config ${fileName.replace(/\.ts$/, ".js")}`,
      "Mount the dashboard in your web tier:",
      "",
      renderMountSnippet(project),
    ],
  };
}
