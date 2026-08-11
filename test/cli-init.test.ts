import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
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
  });

  it("falls back to a plain pg project when nothing is recognized", () => {
    expect(detectProject(null)).toEqual({
      orm: "pg",
      framework: "none",
      typescript: false,
      packageManager: "pnpm",
    });
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
