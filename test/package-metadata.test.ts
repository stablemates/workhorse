import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { benchmarkTargetVersions } from "../benchmarks/targets/versions.js";
import { packedPackages, runtimePackages } from "../scripts/package-metadata.js";

const repository = path.resolve(import.meta.dirname, "..");

async function manifest(directory: string): Promise<{
  name: string;
  version: string;
  private?: boolean;
  devDependencies?: Record<string, string>;
}> {
  return JSON.parse(await readFile(path.join(repository, directory, "package.json"), "utf8")) as {
    name: string;
    version: string;
    private?: boolean;
    devDependencies?: Record<string, string>;
  };
}

describe("repository package metadata", () => {
  it("selects every publishable runtime package exactly once", async () => {
    const packageDirectories = await readdir(path.join(repository, "packages"));
    const publishable = (
      await Promise.all(
        packageDirectories.map(async (directory) => ({
          directory: `packages/${directory}`,
          manifest: await manifest(`packages/${directory}`),
        })),
      )
    )
      .filter(({ manifest: packageManifest }) => packageManifest.private !== true)
      .map(({ directory, manifest: packageManifest }) => ({
        directory,
        name: packageManifest.name,
      }))
      // oxlint-disable-next-line unicorn/no-array-sort -- ES2022 target lacks Array#toSorted().
      .sort((left, right) => left.name.localeCompare(right.name));

    expect(runtimePackages).toEqual(publishable);
    expect(new Set(runtimePackages.map(({ name }) => name)).size).toBe(runtimePackages.length);
  });

  it("packs the core and every selected runtime package", () => {
    expect(packedPackages).toEqual([
      { directory: ".", name: "@workhorse/core" },
      ...runtimePackages,
    ]);
  });

  it("uses the packed package selection for release packing and publishing", async () => {
    const [workflow, releaseScript] = await Promise.all([
      readFile(path.join(repository, ".github/workflows/release.yml"), "utf8"),
      readFile(path.join(repository, "scripts/release-packages.ts"), "utf8"),
    ]);
    expect(workflow).toContain("scripts/release-packages.ts pack");
    expect(workflow).toContain("scripts/release-packages.ts publish");
    expect(releaseScript).toContain('from "./package-metadata.js"');
    expect(releaseScript).not.toMatch(/dashboard drizzle|drizzle prisma|prisma typeorm/);
  });

  it("keeps benchmark target versions equal to their package pins", async () => {
    const root = await manifest(".");
    expect(root.devDependencies).toHaveProperty("pg-boss");
    expect(root.devDependencies).toHaveProperty("graphile-worker");
    expect(benchmarkTargetVersions).toEqual({
      workhorse: root.version,
      "pg-boss": root.devDependencies?.["pg-boss"],
      "graphile-worker": root.devDependencies?.["graphile-worker"],
    });
  });
});
