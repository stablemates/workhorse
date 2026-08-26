import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { publishedPackages, repositoryRoot } from "./packages.js";

const npmVersion = "0.1.0-beta.1";
const pythonVersion = "0.1.0b1";
const betaLabel = "public beta";
const compatibilityNotice = "There is no upgrade path between 0.x releases";

async function read(relativePath: string): Promise<string> {
  return readFile(path.join(repositoryRoot, relativePath), "utf8");
}

describe("the first public beta release", () => {
  it("encodes beta status in every published version and registry description", async () => {
    for (const entry of await publishedPackages()) {
      const manifest = JSON.parse(await read(entry.manifest)) as {
        description?: string;
        peerDependencies?: Record<string, string>;
        version?: string;
      };
      expect(manifest.version).toBe(npmVersion);
      expect(manifest.description?.toLowerCase()).toContain(betaLabel);
      const workhorsePeer = manifest.peerDependencies?.["@stablemates/workhorse"];
      expect([undefined, ">=0.1.0-beta.1 <0.2.0"]).toContain(workhorsePeer);
    }

    const pythonManifest = await read("python/pyproject.toml");
    expect(pythonManifest).toContain(`version = "${pythonVersion}"`);
    expect(pythonManifest).toContain("Development Status :: 4 - Beta");
    expect(pythonManifest.toLowerCase()).toContain(betaLabel);
  });

  it("puts the label and compatibility boundary on every package README", async () => {
    const readmes = [
      ...(await publishedPackages()).map((entry) => `${entry.location}/README.md`),
      "python/README.md",
      "go/README.md",
    ];

    for (const relativePath of readmes) {
      const contents = await read(relativePath);
      expect(contents.toLowerCase()).toContain(betaLabel);
      expect(contents.replace(/\s+/g, " ")).toContain(compatibilityNotice);
    }
  });

  it("labels the repository, site, demo, changelogs, and Go package documentation", async () => {
    const surfaces = [
      "README.md",
      "site/src/routes/index.tsx",
      "site/content/docs/index.mdx",
      "dashboard/app/src/brand.tsx",
      "CHANGELOG.md",
      "python/CHANGELOG.md",
      "go/CHANGELOG.md",
      "go/doc.go",
    ];

    for (const relativePath of surfaces) {
      const contents = await read(relativePath);
      expect(contents.toLowerCase()).toContain(betaLabel);
    }
    for (const relativePath of surfaces.slice(0, 7)) {
      expect((await read(relativePath)).replace(/\s+/g, " ")).toContain(compatibilityNotice);
    }
  });

  it("documents the beta versions in each changelog", async () => {
    expect(await read("CHANGELOG.md")).toContain(`## ${npmVersion} — unreleased`);
    expect(await read("python/CHANGELOG.md")).toContain(`## ${pythonVersion} — unreleased`);
    expect(await read("go/CHANGELOG.md")).toContain(`## ${npmVersion} — unreleased`);
  });

  it("builds the site with the supported Go toolchain line", async () => {
    expect(await read("Dockerfile.site")).toMatch(/^FROM golang:1\.25(?:\.[0-9]+)?-alpine AS go$/m);
  });
});
