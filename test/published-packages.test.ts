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
