import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  corePackage,
  publishedPackages,
  repositoryRoot,
  workspacePackages,
} from "../scripts/packages.js";

// The published-package list used to be spelled out in the release workflow, the packed-package
// check, the support matrix test, and the development build script. scripts/packages.ts derives it
// from the workspace instead; this file is what stops a consumer from quietly writing its own copy
// again, and what makes a package that opts out of the shared build scripts a failure.

const packages = await workspacePackages();
const core = await corePackage();

async function read(relativePath: string): Promise<string> {
  return readFile(path.join(repositoryRoot, relativePath), "utf8");
}

describe("the derived package list", () => {
  it("finds every publishable workspace package", async () => {
    expect(packages.length).toBeGreaterThan(0);
    expect(packages.map((entry) => entry.directory)).toEqual([
      ...new Set(packages.map((entry) => entry.directory)),
    ]);
    // Core is published too, but from the repository root rather than from packages/.
    expect(core.name).toBe("@workhorse/core");
    expect((await publishedPackages())[0]).toEqual(core);
  });

  it("names each tarball the way pnpm pack does", () => {
    for (const entry of [core, ...packages]) {
      expect(entry.tarball).toBe(
        `${entry.name.replace("@", "").replace("/", "-")}-${entry.version}.tgz`,
      );
    }
  });
});

describe("published package manifests", () => {
  it.each(packages.map((entry) => entry.directory))(
    "%s builds under both the full and the development build",
    async (directory) => {
      const manifest = JSON.parse(await read(`packages/${directory}/package.json`)) as {
        scripts?: Record<string, string>;
      };
      // `build:runtime` and `build:runtime:dev` both select packages with a `packages/*` filter.
      // pnpm skips a package that does not declare the script, so a missing one would silently
      // ship a stale dist instead of failing the build.
      expect(manifest.scripts?.build).toBeDefined();
      expect(manifest.scripts?.["build:dev"]).toBeDefined();
      expect(manifest.scripts?.typecheck).toBeDefined();
    },
  );

  it("declares the standalone dashboard boundary without a core-dashboard compile cycle", async () => {
    const coreManifest = JSON.parse(await read("package.json")) as {
      dependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
      peerDependenciesMeta?: Record<string, { optional?: boolean }>;
    };
    const contractManifest = JSON.parse(await read("packages/dashboard-contract/package.json")) as {
      private?: boolean;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const dashboardManifest = JSON.parse(await read("packages/dashboard/package.json")) as {
      exports?: Record<string, unknown>;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const coreDashboardSource = await read("src/cli/dashboard.ts");
    const standaloneSource = await read("packages/dashboard/src/server/standalone.ts");

    expect(contractManifest.private).not.toBe(true);
    expect(contractManifest.dependencies).toBeUndefined();
    expect(contractManifest.devDependencies).toEqual({ typescript: "^5.8.3" });
    expect(coreManifest.dependencies?.["@workhorse/dashboard-contract"]).toBe("workspace:*");
    expect(coreManifest.peerDependencies?.["@workhorse/dashboard"]).toBe("0.1.0");
    expect(coreManifest.peerDependenciesMeta?.["@workhorse/dashboard"]?.optional).toBe(true);
    expect(dashboardManifest.dependencies?.["@workhorse/dashboard-contract"]).toBe("workspace:*");
    expect(dashboardManifest.exports?.["./standalone"]).toEqual({
      types: "./dist/server/standalone.d.ts",
      import: "./dist/server/standalone.js",
    });
    expect(coreDashboardSource).toContain('from "@workhorse/dashboard-contract"');
    expect(coreDashboardSource).toContain('"@workhorse/dashboard/standalone"');
    expect(coreDashboardSource).not.toContain('.join("/")');
    expect(coreDashboardSource).not.toContain("interface DashboardServerModule");
    expect(standaloneSource).toContain("DashboardStandaloneModule<Queryable>");
  });

  it("pins the dashboard to the core release whose private schema it reads", async () => {
    const dashboardManifest = JSON.parse(await read("packages/dashboard/package.json")) as {
      version?: string;
      peerDependencies?: Record<string, string>;
    };

    expect(dashboardManifest.peerDependencies?.["@workhorse/core"]).toBe(core.version);
    expect(dashboardManifest.version).toBe(core.version);
  });
});

describe("ORM adapter entry points", () => {
  const adapters = ["drizzle", "prisma", "typeorm", "kysely"];

  it.each(adapters)("keeps %s as thin glue over the public core adapter API", async (adapter) => {
    const source = await read(`packages/${adapter}/src/index.ts`);
    expect(source.trimEnd().split("\n").length).toBeLessThanOrEqual(50);
    expect(source).not.toMatch(/from ["']@workhorse\/core\//);
    expect(source).not.toMatch(/from ["'](?:\.\.\/)+\.\.\/src\//);
  });
});

describe("consumers of the package list", () => {
  it("packs and publishes the derived list rather than a copy", async () => {
    const workflow = await read(".github/workflows/release.yml");
    const loops = [...workflow.matchAll(/^\s*for package in (.+); do$/gm)].map(
      (match) => match[1]!,
    );
    expect(loops.length).toBeGreaterThan(0);
    for (const loop of loops) expect(loop).toBe("$(pnpm --silent exec tsx scripts/packages.ts)");
  });

  it("keeps the development build script free of a hand-written package list", async () => {
    const manifest = JSON.parse(await read("package.json")) as {
      scripts: Record<string, string>;
    };
    for (const script of ["build:runtime", "build:runtime:dev"]) {
      for (const entry of packages) {
        expect(manifest.scripts[script]).not.toContain(entry.name);
      }
    }
  });

  it("lists every published package in the changelog preamble", async () => {
    const changelog = await read("CHANGELOG.md");
    const preamble = changelog.slice(0, changelog.indexOf("\n## "));
    const published = [core, ...packages];
    for (const entry of published) expect(preamble).toContain(`\`${entry.name}\``);
    // The preamble also counts them in words, which is the part most easily forgotten.
    const words = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"];
    expect(preamble.toLowerCase()).toContain(
      `${words[published.length] ?? String(published.length)} published packages`,
    );
  });
});
