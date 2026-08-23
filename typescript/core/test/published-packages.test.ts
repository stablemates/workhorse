import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  corePackage,
  publishedPackages,
  repositoryRoot,
  workspacePackages,
} from "../../../scripts/packages.js";

// The published-package list used to be spelled out in the release workflow, the packed-package
// check, the support matrix test, and the development build script. scripts/packages.ts derives it
// from the workspace instead; this file is what stops a consumer from quietly writing its own copy
// again, and what makes a package that opts out of the shared build scripts a failure.

const packages = await workspacePackages();
const core = await corePackage();
const npmScope = core.name.slice(1, core.name.indexOf("/"));

async function read(relativePath: string): Promise<string> {
  return readFile(path.join(repositoryRoot, relativePath), "utf8");
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

describe("the derived package list", () => {
  it("finds every publishable workspace package", async () => {
    expect(packages.length).toBeGreaterThan(0);
    expect(packages.map((entry) => entry.directory)).toEqual([
      ...new Set(packages.map((entry) => entry.directory)),
    ]);
    // Core is published too, but is kept first because the other packages consume it.
    expect(core.name).toBe("@workhorse-js/core");
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
  it("publishes operator methods only on Admin", async () => {
    const queueDeclaration = await read("typescript/core/dist/src/queue.d.ts");
    const adminDeclaration = await read("typescript/core/dist/src/admin.d.ts");
    const operatorMethods = [
      "getJob",
      "listJobs",
      "getJobTimeline",
      "listDeadLetters",
      "redrive",
      "redriveMany",
      "getRedriveLineage",
      "getDependencyLineage",
      "getChildLineage",
      "getCheckpoint",
      "listCheckpoints",
      "getProgress",
      "getWait",
      "listWaits",
      "listSignalWaits",
      "listHumanWaits",
      "listWorkers",
      "setWorkerPaused",
      "pauseQueue",
      "resumeQueue",
      "purgeQueue",
      "runTaskNow",
    ];

    expect(queueDeclaration).not.toMatch(/load(?:Checkpoints|Progress|Waits)/);
    expect(queueDeclaration).not.toContain("loadHandlerState");
    expect(queueDeclaration).toContain("[workerCheckpointsRead]");
    expect(queueDeclaration).toContain("[workerProgressRead]");
    expect(queueDeclaration).toContain("[workerWaitsRead]");
    for (const method of operatorMethods) {
      const declaration = new RegExp(`\\b${method}(?:<[^>]+>)?\\s*\\(`);
      expect(queueDeclaration, `Queue.${method}`).not.toMatch(declaration);
      expect(adminDeclaration, `Admin.${method}`).toMatch(declaration);
    }
  });

  it.each(packages.map((entry) => [entry.name, entry] as const))(
    "%s builds under both the full and the development build",
    async (_name, entry) => {
      const manifest = JSON.parse(await read(entry.manifest)) as {
        scripts?: Record<string, string>;
      };
      // `build:runtime` and `build:runtime:dev` both select packages under `typescript/`.
      // pnpm skips a package that does not declare the script, so a missing one would silently
      // ship a stale dist instead of failing the build.
      expect(manifest.scripts?.build).toBeDefined();
      expect(manifest.scripts?.["build:dev"]).toBeDefined();
      expect(manifest.scripts?.typecheck).toBeDefined();
    },
  );

  it("declares the standalone dashboard boundary without a core-dashboard compile cycle", async () => {
    const coreManifest = JSON.parse(await read("typescript/core/package.json")) as {
      dependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
      peerDependenciesMeta?: Record<string, { optional?: boolean }>;
    };
    const contractManifest = JSON.parse(
      await read("typescript/dashboard-contract/package.json"),
    ) as {
      private?: boolean;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const dashboardManifest = JSON.parse(
      await read("typescript/dashboard-server/package.json"),
    ) as {
      exports?: Record<string, unknown>;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const coreDashboardSource = await read("typescript/core/src/cli/dashboard.ts");
    const standaloneSource = await read("typescript/dashboard-server/src/server/standalone.ts");

    expect(contractManifest.private).not.toBe(true);
    expect(contractManifest.dependencies).toBeUndefined();
    expect(contractManifest.devDependencies).toEqual({ typescript: "^5.8.3" });
    expect(coreManifest.dependencies?.["@workhorse-js/dashboard-contract"]).toBe("workspace:*");
    expect(coreManifest.peerDependencies?.["@workhorse-js/dashboard"]).toBe(">=0.1.0 <0.2.0");
    expect(coreManifest.peerDependenciesMeta?.["@workhorse-js/dashboard"]?.optional).toBe(true);
    expect(dashboardManifest.dependencies?.["@workhorse-js/dashboard-contract"]).toBe(
      "workspace:*",
    );
    expect(dashboardManifest.exports?.["./standalone"]).toEqual({
      "workhorse-source": "./src/server/standalone.ts",
      types: "./dist/server/standalone.d.ts",
      import: "./dist/server/standalone.js",
    });
    expect(coreDashboardSource).toContain('from "@workhorse-js/dashboard-contract"');
    expect(coreDashboardSource).toContain('"@workhorse-js/dashboard/standalone"');
    expect(coreDashboardSource).not.toContain('.join("/")');
    expect(coreDashboardSource).not.toContain("interface DashboardServerModule");
    expect(standaloneSource).toContain("DashboardStandaloneModule<Queryable>");
  });

  it("keeps source exports ahead of the published dist exports", async () => {
    for (const entry of [core, ...packages]) {
      const manifest = JSON.parse(await read(entry.manifest)) as {
        exports?: Record<string, unknown>;
      };
      if (!manifest.exports) continue;

      for (const [subpath, target] of Object.entries(manifest.exports)) {
        if (!isRecord(target) || typeof target.import !== "string") continue;
        const types = target.types;
        const source = target["workhorse-source"];
        if (typeof types !== "string" || typeof source !== "string") {
          throw new Error(`${entry.name}${subpath} needs types and workhorse-source exports`);
        }
        expect(types, `${entry.name}${subpath} types export`).toMatch(/^\.\/dist\/.*\.d\.ts$/);
        expect(target.import, `${entry.name}${subpath} import export`).toMatch(
          /^\.\/dist\/.*\.js$/,
        );
        expect(source, `${entry.name}${subpath} workhorse-source export`).toMatch(
          /^\.\/src\/.*\.ts$/,
        );

        const conditions = Object.keys(target);
        expect(conditions.indexOf("workhorse-source")).toBeLessThan(conditions.indexOf("types"));
        expect(conditions.indexOf("workhorse-source")).toBeLessThan(conditions.indexOf("import"));
        await access(path.join(repositoryRoot, entry.location, source));
      }
    }
  });

  /**
   * A published package ships `dist`, not `src`. Vite resolves the conventional `development`
   * condition on its own, so naming a source path under it would send every consumer's development
   * server to a directory the tarball does not contain. `workhorse-source` is private to this
   * repository, and nothing outside it asks for that condition.
   */
  it("names no source condition a bundler applies by itself", async () => {
    const applied = new Set(["development", "production", "browser", "module", "node", "default"]);
    for (const entry of [core, ...packages]) {
      const manifest = JSON.parse(await read(entry.manifest)) as {
        exports?: Record<string, unknown>;
        files?: string[];
      };
      expect(manifest.files ?? [], `${entry.name} files`).not.toContain("src");

      for (const [subpath, target] of Object.entries(manifest.exports ?? {})) {
        if (!isRecord(target)) continue;
        for (const [condition, value] of Object.entries(target)) {
          if (typeof value !== "string" || !value.startsWith("./src/")) continue;
          expect(applied.has(condition), `${entry.name}${subpath} ${condition} export`).toBe(false);
        }
      }
    }
  });

  it("allows dashboard and core patch releases to move independently", async () => {
    const dashboardManifest = JSON.parse(
      await read("typescript/dashboard-server/package.json"),
    ) as {
      version?: string;
      peerDependencies?: Record<string, string>;
    };

    expect(dashboardManifest.peerDependencies?.["@workhorse-js/core"]).toBe(">=0.1.0 <0.2.0");
    expect(dashboardManifest.version).toBe(core.version);
  });

  it("keeps the dashboard read model on versioned core SQL surfaces", async () => {
    const source = await read("typescript/dashboard-server/src/server/read-model.ts");
    const references = [...source.matchAll(/workhorse\.([a-z0-9_]+)/g)].map((match) => match[1]);

    expect(references.length).toBeGreaterThan(0);
    expect(references.filter((reference) => !/_v\d+$/.test(reference ?? ""))).toEqual([]);
  });
});

describe("ORM adapter entry points", () => {
  const adapters = ["drizzle", "prisma", "typeorm", "kysely"];

  it.each(adapters)("keeps %s as thin glue over the public core adapter API", async (adapter) => {
    const source = await read(`typescript/${adapter}/src/index.ts`);
    expect(source.trimEnd().split("\n").length).toBeLessThanOrEqual(50);
    expect(source).not.toMatch(/from ["']@workhorse-js\/core\//);
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

    expect(workflow).toContain(`dist-tarballs/${npmScope}-core-$version.tgz`);
    expect(workflow).toContain(`dist-tarballs/${npmScope}-$package-$version.tgz`);
  });

  it("moves scoped dashboard tarballs to stable container artifact names", async () => {
    const dockerfile = await read("Dockerfile.dashboard");
    for (const directory of ["core", "dashboard-contract", "dashboard-server"]) {
      expect(dockerfile).toContain(`/artifacts/${npmScope}-${directory}-*.tgz`);
    }
    expect(dockerfile).toContain(`/artifacts/${npmScope}-dashboard-[0-9]*.tgz`);
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
