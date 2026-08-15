import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createCompetitorTargets } from "../benchmarks/targets/index.js";
import { installedVersion, repositoryVersion } from "../benchmarks/targets/versions.js";
import { repositoryRoot } from "../../../scripts/packages.js";

// A competitor version appears in the benchmark report, the README, and docs/benchmarking.md. The
// pin in the root manifest is what actually ran, so it is the source of truth and this file fails
// when a restatement drifts away from it. Nothing here touches a database: the targets are built
// only to read their metadata.

const competitors = [
  // Documentation writes the product name rather than the package name, so each competitor says
  // how it is spelled in prose as well as on npm.
  { packageName: "pg-boss", documented: /pg-boss[^\n]*?(\d+\.\d+\.\d+)/gi },
  { packageName: "graphile-worker", documented: /graphile[ -]worker[^\n]*?(\d+\.\d+\.\d+)/gi },
] as const;

async function read(relativePath: string): Promise<string> {
  return readFile(path.join(repositoryRoot, relativePath), "utf8");
}

describe("installed competitor versions", () => {
  it.each(competitors)("pins $packageName to an exact version", ({ packageName }) => {
    expect(installedVersion(packageName)).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("reports the repository's own version for Workhorse", async () => {
    const manifest = JSON.parse(await read("typescript/core/package.json")) as {
      version: string;
    };
    expect(repositoryVersion).toBe(manifest.version);
  });
});

describe("benchmark target metadata", () => {
  it("reports the version that is installed, for every target", async () => {
    // A Pool is constructed but never connected; metadata is available before setup().
    const { Pool } = await import("pg");
    const pool = new Pool({ max: 1 });
    try {
      for (const target of await createCompetitorTargets(pool)) {
        const { packageName, version } = target.metadata;
        expect(version).toBe(
          packageName === "@workhorse/core" ? repositoryVersion : installedVersion(packageName),
        );
      }
    } finally {
      await pool.end();
    }
  });
});

describe("documented competitor versions", () => {
  it.each(competitors)(
    "quotes the installed $packageName version in the documentation",
    async ({ packageName, documented }) => {
      const [benchmarking, readme] = await Promise.all([
        read("docs/benchmarking.md"),
        read("README.md"),
      ]);
      const version = installedVersion(packageName);
      for (const document of [benchmarking, readme]) {
        // Every version-shaped number written beside this competitor's name must be the pinned one.
        const mentions = [...document.matchAll(documented)];
        expect(mentions.length).toBeGreaterThan(0);
        for (const mention of mentions) expect(mention[1]).toBe(version);
      }
    },
  );
});
