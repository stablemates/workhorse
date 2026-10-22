import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  detectPackageManager,
  detectProject,
  initializeProject,
  renderMountSnippet,
  renderWorkerConfig,
} from "../src/cli/init.js";

const created: string[] = [];

async function project(packageJson: Record<string, unknown> | null): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "workhorse-init-"));
  created.push(directory);
  if (packageJson) {
    await writeFile(path.join(directory, "package.json"), JSON.stringify(packageJson), "utf8");
  }
  return directory;
}

/** Install a stub package manifest, as a package manager leaves it in `node_modules`. */
async function install(directory: string, name: string, version: string): Promise<void> {
  const packageDirectory = path.join(directory, "node_modules", ...name.split("/"));
  await mkdir(packageDirectory, { recursive: true });
  await writeFile(path.join(packageDirectory, "package.json"), JSON.stringify({ name, version }));
}

const prismaProject = {
  dependencies: { "@prisma/client": "^7.0.0" },
  devDependencies: { typescript: "^5.0.0" },
  packageManager: "npm@11.0.0",
};

afterEach(async () => {
  await Promise.all(
    created.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("workhorse init", () => {
  it("detects the ORM, framework, and package manager from existing dependencies", () => {
    expect(
      detectProject({
        dependencies: { "drizzle-orm": "^0.45.0", hono: "^4.0.0" },
        devDependencies: { typescript: "^5.0.0" },
        packageManager: "pnpm@9.0.0",
      }),
    ).toEqual({ orm: "drizzle", framework: "hono", typescript: true, packageManager: "pnpm" });

    expect(
      detectProject({ dependencies: { express: "^4.0.0" }, packageManager: "yarn@4.0.0" }),
    ).toEqual({ orm: "pg", framework: "express", typescript: false, packageManager: "yarn" });

    expect(detectProject({ dependencies: { "@prisma/client": "^6.0.0" } }).orm).toBe("prisma");
    expect(detectProject({ dependencies: { typeorm: "^0.3.0" } }).orm).toBe("typeorm");
    expect(detectProject({ dependencies: { kysely: "^0.29.0" } }).orm).toBe("kysely");
  });

  it("falls back to a plain pg project when nothing is recognized", () => {
    expect(detectProject(null)).toEqual({
      orm: "pg",
      framework: "none",
      typescript: false,
      packageManager: "pnpm",
    });
  });

  it("prefers the declared package manager, then the lockfile", () => {
    expect(detectPackageManager("npm@11.0.0", "pnpm")).toBe("npm");
    expect(detectPackageManager(undefined, "npm")).toBe("npm");
    expect(detectPackageManager(undefined, "yarn")).toBe("yarn");
    expect(detectPackageManager(undefined, "bun")).toBe("bun");
    expect(detectPackageManager(undefined, null)).toBe("pnpm");
  });

  it("names npm in the next steps of a project installed with npm", async () => {
    const directory = await project({ dependencies: { express: "^4.0.0" } });
    await writeFile(path.join(directory, "package-lock.json"), "{}", "utf8");

    const result = await initializeProject(directory);

    expect(result.project.packageManager).toBe("npm");
    expect(result.nextSteps).toContain(
      "Install the schema:  npm exec --no -- workhorse schema install",
    );
  });

  it("reads the lockfile only when package.json declares no package manager", async () => {
    const directory = await project({
      dependencies: { express: "^4.0.0" },
      packageManager: "pnpm@9.0.0",
    });
    await writeFile(path.join(directory, "package-lock.json"), "{}", "utf8");

    const result = await initializeProject(directory);

    expect(result.project.packageManager).toBe("pnpm");
  });

  it("writes exactly one file and leaves package.json untouched", async () => {
    const directory = await project({
      dependencies: { "drizzle-orm": "^0.45.0", hono: "^4.0.0" },
      devDependencies: { typescript: "^5.0.0" },
      scripts: { build: "tsc" },
    });
    const before = await readFile(path.join(directory, "package.json"), "utf8");

    const result = await initializeProject(directory);

    expect(result.written).toBe(true);
    expect(result.configPath).toBe(path.join(directory, "workhorse.config.ts"));
    expect(await readFile(path.join(directory, "package.json"), "utf8")).toBe(before);
    const config = await readFile(result.configPath, "utf8");
    expect(config).toContain("defineWorkerProcess");
    expect(config).toContain("createDrizzleAdapter");
  });

  it("refuses to overwrite an existing configuration unless forced", async () => {
    const directory = await project({ devDependencies: { typescript: "^5.0.0" } });
    await initializeProject(directory);
    await writeFile(path.join(directory, "workhorse.config.ts"), "// edited by hand", "utf8");

    const second = await initializeProject(directory);
    expect(second.written).toBe(false);
    expect(await readFile(second.configPath, "utf8")).toBe("// edited by hand");

    const forced = await initializeProject(directory, { force: true });
    expect(forced.written).toBe(true);
    expect(await readFile(forced.configPath, "utf8")).toContain("defineWorkerProcess");
  });

  it("generates a JavaScript configuration for a project without TypeScript", async () => {
    const directory = await project({ dependencies: { express: "^4.0.0" } });
    const result = await initializeProject(directory);
    expect(result.configPath.endsWith("workhorse.config.js")).toBe(true);
  });

  it("scaffolds a worker without live-refresh activity notifications", () => {
    const config = renderWorkerConfig({
      orm: "pg",
      framework: "none",
      typescript: true,
      packageManager: "pnpm",
    });
    expect(config).not.toContain("activityNotifications");
    expect(config).toContain("createWorkhorseAdapter");
    expect(config).toContain('Pool } from "@stablemates/workhorse"');
    expect(config).not.toContain('from "pg"');
  });

  it("scaffolds ORM workers with the pool their dedicated connections come from", () => {
    const base = {
      framework: "none",
      typescript: true,
      packageManager: "pnpm",
    } as const;
    const prisma = renderWorkerConfig({ ...base, orm: "prisma" });
    const typeorm = renderWorkerConfig({ ...base, orm: "typeorm" });
    const kysely = renderWorkerConfig({ ...base, orm: "kysely" });

    expect(prisma).toContain("createPrismaAdapter");
    expect(prisma).toMatch(/createPrismaAdapter\(database, \{[^}]*\n\s+pool,\n/);
    expect(typeorm).toContain("createTypeOrmAdapter");
    expect(typeorm).toContain("await database.initialize()");
    // TypeORM's own pool lends the worker its connections, so the template creates no second pool.
    expect(typeorm).not.toContain("new Pool(");
    expect(typeorm).not.toMatch(/\bPool\b.*from "@stablemates\/workhorse"/);
    expect(kysely).toContain("createKyselyAdapter");
    expect(kysely).toContain("new PostgresDialect({ pool })");
    expect(kysely).toMatch(/createKyselyAdapter\(database, \{[^}]*\n\s+pool,\n/);
    for (const config of [prisma, typeorm, kysely])
      expect(config).not.toContain("notificationPool");
  });

  it("keeps the Prisma 6 template and writes the Prisma 7 template with a driver adapter", () => {
    const base = {
      orm: "prisma",
      framework: "none",
      typescript: true,
      packageManager: "pnpm",
    } as const;
    const unread = renderWorkerConfig(base);
    const prisma6 = renderWorkerConfig({ ...base, prismaMajor: 6 });
    const prisma7 = renderWorkerConfig({ ...base, prismaMajor: 7 });

    expect(prisma6).toBe(unread);
    expect(prisma6).toContain(
      'import { PrismaClient } from "@prisma/client";\nimport { createPrismaAdapter } from "@stablemates/workhorse-prisma";\n',
    );
    expect(prisma6).toContain(
      "const database = new PrismaClient({ datasources: { db: { url: databaseUrl } } });",
    );
    expect(prisma6).not.toContain("adapter-pg");

    expect(prisma7).toContain('import { PrismaPg } from "@prisma/adapter-pg";\n');
    expect(prisma7).toContain(
      "const database = new PrismaClient({\n      adapter: new PrismaPg({ connectionString: databaseUrl }),\n    });",
    );
    expect(prisma7).not.toContain("datasources");
    // Both majors give the worker the same dedicated pool and close the client, then the pool.
    for (const config of [prisma6, prisma7]) {
      expect(config).toContain("const pool = new Pool({ connectionString: databaseUrl });");
      expect(config).toMatch(/createPrismaAdapter\(database, \{[^}]*\n\s+pool,\n/);
      expect(config).toContain(
        "close: async () => {\n        await database.$disconnect();\n        await pool.end();\n      },",
      );
    }
  });

  it("reads the installed Prisma major and names a missing driver adapter", async () => {
    const directory = await project(prismaProject);
    await install(directory, "@prisma/client", "7.10.1");

    const result = await initializeProject(directory);

    expect(result.project.prismaMajor).toBe(7);
    expect(await readFile(result.configPath, "utf8")).toContain("new PrismaPg(");
    expect(result.nextSteps[0]).toBe("Install the driver adapter:  npm install @prisma/adapter-pg");

    await install(directory, "@prisma/adapter-pg", "7.10.1");
    const installed = await initializeProject(directory, { force: true });
    expect(installed.nextSteps.join("\n")).not.toContain("@prisma/adapter-pg");
  });

  it("finds Prisma hoisted into a parent node_modules", async () => {
    const root = await project(null);
    await install(root, "@prisma/client", "7.0.0");
    await install(root, "@prisma/adapter-pg", "7.0.0");
    const directory = path.join(root, "packages", "app");
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "package.json"), JSON.stringify(prismaProject));

    const result = await initializeProject(directory);

    expect(result.project.prismaMajor).toBe(7);
    expect(result.nextSteps[0]).toMatch(/^Install the schema:/);
  });

  it("writes the Prisma 6 template for an installed Prisma 6", async () => {
    const directory = await project(prismaProject);
    await install(directory, "@prisma/client", "6.19.3");

    const result = await initializeProject(directory);

    expect(result.project.prismaMajor).toBe(6);
    expect(await readFile(result.configPath, "utf8")).toBe(
      renderWorkerConfig({ ...result.project, prismaMajor: undefined }),
    );
    expect(result.nextSteps[0]).toMatch(/^Install the schema:/);
  });

  it("writes the Prisma 6 template with a note when the Prisma major cannot be read", async () => {
    const directory = await project(prismaProject);

    const result = await initializeProject(directory);

    expect(result.project.prismaMajor).toBeUndefined();
    expect(await readFile(result.configPath, "utf8")).toContain("datasources: { db: { url");
    expect(result.nextSteps[0]).toBe(
      "Check the Prisma client: init could not read the installed @prisma/client version.",
    );
    expect(result.nextSteps.join("\n")).toContain("docs/prisma#create-the-adapter");
  });

  it("prints a framework-appropriate dashboard mount", () => {
    const base = {
      orm: "pg",
      framework: "hono",
      typescript: true,
      packageManager: "pnpm",
    } as const;
    expect(renderMountSnippet(base)).toContain("host.handle(context.req.raw)");
    expect(renderMountSnippet({ ...base, framework: "express" })).toContain(
      "dashboardNodeMiddleware",
    );
    expect(renderMountSnippet({ ...base, framework: "next" })).toContain("host.handle(request)");
    expect(renderMountSnippet({ ...base, framework: "none" })).toContain("createDashboardHost");
  });
});
