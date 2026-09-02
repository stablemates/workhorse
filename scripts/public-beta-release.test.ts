import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { publishedPackages, repositoryRoot } from "./packages.js";

const npmVersion = "0.1.0-beta.2";
const pythonVersion = "0.1.0b3";
const goVersion = "0.1.0-beta.1";
const publicationDate = "2026-09-01";
const npmSourceCommit = "856cdcf354aa83a3acf8ee67043145adb9c99e09";
const pythonSourceCommit = "663c526805746786f12b3be3e151e8ce06c80057";
const goSourceCommit = "dbd5437362930f712157ffcc72c3296e971e4f5a";
const betaLabel = "public beta";
const compatibilityNotice = "There is no upgrade path between 0.x releases";

async function read(relativePath: string): Promise<string> {
  return readFile(path.join(repositoryRoot, relativePath), "utf8");
}

function prose(contents: string): string {
  return contents.replace(/^>\s?/gm, "").replace(/\s+/g, " ");
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
      expect(prose(contents)).toContain(compatibilityNotice);
    }
  });

  it("labels public surfaces and keeps the compatibility boundary in durable documentation", async () => {
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
    const compatibilitySurfaces = [
      "README.md",
      "site/content/docs/index.mdx",
      "CHANGELOG.md",
      "python/CHANGELOG.md",
      "go/CHANGELOG.md",
    ];
    for (const relativePath of compatibilitySurfaces) {
      expect(prose(await read(relativePath))).toContain(compatibilityNotice);
    }
  });

  it("dates and attributes the published beta versions in each changelog", async () => {
    const entries = [
      ["CHANGELOG.md", npmVersion, npmSourceCommit],
      ["python/CHANGELOG.md", pythonVersion, pythonSourceCommit],
      ["go/CHANGELOG.md", goVersion, goSourceCommit],
    ] as const;

    for (const [relativePath, version, sourceCommit] of entries) {
      const changelog = await read(relativePath);
      expect(changelog).toContain(`## ${version} — ${publicationDate}`);
      expect(changelog).toContain(sourceCommit);
      expect(changelog).not.toMatch(/^## .* — unreleased$/m);
    }
  });

  it("builds the site with the supported Go toolchain line", async () => {
    expect(await read("Dockerfile.site")).toMatch(
      /^FROM golang:1\.25(?:\.[0-9]+)?-alpine@sha256:[0-9a-f]{64} AS go$/m,
    );
  });

  it("records the staged release train and its stop conditions", async () => {
    const compatibility = await read("docs/compatibility.md");
    const pythonPosition = compatibility.indexOf("Publish Python first");
    const npmPosition = compatibility.indexOf("Publish npm second");
    const goPosition = compatibility.indexOf("Publish Go last");

    expect(pythonPosition).toBeGreaterThan(-1);
    expect(npmPosition).toBeGreaterThan(pythonPosition);
    expect(goPosition).toBeGreaterThan(npmPosition);
    expect(compatibility).toContain("Any failure stops the release train");
    expect(compatibility).toContain("A published version is never reused");
    expect(compatibility).toContain("Test registries are not part of the rehearsal");

    const trainSection = compatibility.slice(
      compatibility.indexOf("### First public beta release train"),
      compatibility.indexOf("### npm packages"),
    );
    expect(trainSection).toContain("three source commits");
    for (const sourceCommit of [pythonSourceCommit, npmSourceCommit, goSourceCommit]) {
      expect(trainSection).toContain(sourceCommit);
    }
  });
});
