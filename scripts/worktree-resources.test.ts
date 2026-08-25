import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { resourceEnvironment, type WorktreeResources } from "./worktree-resources.js";

const repositoryRoot = resolve(import.meta.dirname, "..");
const worktreeCommandModules = [
  "scripts/with-env.ts",
  "scripts/setup-worktree.ts",
  "scripts/cleanup-worktree.ts",
  "scripts/remove-worktree.ts",
  "scripts/prune-worktrees.ts",
  "scripts/worktree-resources.ts",
  "scripts/environment-file.ts",
];

describe("worktree resource commands", () => {
  it("owns only the five purpose-specific database variables", () => {
    const resources: WorktreeResources = {
      version: 1,
      worktreeId: "feature",
      worktreeRoot: "/checkout",
      gitDirectory: "/git/worktrees/feature",
      databaseUrls: {
        dev_primary: "postgres://localhost/workhorse_dev_primary_feature",
        dev_secondary: "postgres://localhost/workhorse_dev_secondary_feature",
        test: "postgres://localhost/workhorse_test_feature",
        bench: "postgres://localhost/workhorse_bench_feature",
        test_packed: "postgres://localhost/workhorse_test_packed_feature",
      },
    };

    expect(resourceEnvironment(resources)).toEqual({
      DATABASE_URL_DEV_PRIMARY: resources.databaseUrls.dev_primary,
      DATABASE_URL_DEV_SECONDARY: resources.databaseUrls.dev_secondary,
      DATABASE_URL_TEST: resources.databaseUrls.test,
      DATABASE_URL_BENCH: resources.databaseUrls.bench,
      DATABASE_URL_TEST_PACKED: resources.databaseUrls.test_packed,
    });
  });

  it("declares every external module imported by their root package", async () => {
    const manifest = JSON.parse(
      await readFile(resolve(repositoryRoot, "package.json"), "utf8"),
    ) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const declaredDependencies = new Set([
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.devDependencies ?? {}),
    ]);
    const importedPackages = new Set<string>();

    for (const modulePath of worktreeCommandModules) {
      const source = await readFile(resolve(repositoryRoot, modulePath), "utf8");
      for (const match of source.matchAll(/from\s+["']([^"']+)["']/g)) {
        const specifier = match[1]!;
        if (specifier.startsWith(".") || specifier.startsWith("node:")) continue;
        importedPackages.add(
          specifier.startsWith("@")
            ? specifier.split("/", 2).join("/")
            : specifier.split("/", 1)[0]!,
        );
      }
    }

    expect([...importedPackages].filter((name) => !declaredDependencies.has(name))).toEqual([]);
  });
});
