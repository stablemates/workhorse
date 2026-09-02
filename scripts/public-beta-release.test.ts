import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { publishedPackages, repositoryRoot } from "./packages.js";
import { compatibilityNotice, prose, publicBetaLabel } from "./public-beta-notice.js";

/** The release this repository cuts next: one version on npm, PyPI, and Go from one commit. */
const releaseVersion = "0.1.0";
const releaseDate = "2026-09-14";
const corePeerRange = ">=0.1.0 <0.2.0";

/** The published beta. Its entries stay in the changelogs as history and must keep their facts. */
const betaNpmVersion = "0.1.0-beta.2";
const betaPythonVersion = "0.1.0b3";
const betaGoVersion = "0.1.0-beta.1";
const betaPublicationDate = "2026-09-01";
const npmSourceCommit = "856cdcf354aa83a3acf8ee67043145adb9c99e09";
const pythonSourceCommit = "663c526805746786f12b3be3e151e8ce06c80057";
const goSourceCommit = "dbd5437362930f712157ffcc72c3296e971e4f5a";

interface SupportManifest {
  readonly support: {
    readonly go: { readonly minimum: string };
    readonly node: { readonly minimum: number };
    readonly postgres: { readonly minimum: number };
    readonly python: { readonly minimum: string };
  };
}

async function read(relativePath: string): Promise<string> {
  return readFile(path.join(repositoryRoot, relativePath), "utf8");
}

/** One `## version — date` entry of a changelog, up to the next `##` heading. */
function changelogEntry(changelog: string, version: string, date: string): string {
  const heading = `## ${version} — ${date}`;
  const start = changelog.indexOf(heading);
  expect(start).toBeGreaterThan(-1);
  const body = changelog.slice(start + heading.length);
  const next = body.search(/^## /m);
  return next === -1 ? body : body.slice(0, next);
}

describe("the 0.1.0 release", () => {
  it("carries the plain version and peer range in every published manifest", async () => {
    for (const entry of await publishedPackages()) {
      const manifest = JSON.parse(await read(entry.manifest)) as {
        description?: string;
        peerDependencies?: Record<string, string>;
        version?: string;
      };
      expect(manifest.version).toBe(releaseVersion);
      expect(manifest.description?.toLowerCase()).toContain(publicBetaLabel);
      const workhorsePeer = manifest.peerDependencies?.["@stablemates/workhorse"];
      expect([undefined, corePeerRange]).toContain(workhorsePeer);
    }

    const appManifest = JSON.parse(await read("dashboard/app/package.json")) as {
      peerDependencies?: Record<string, string>;
    };
    expect(appManifest.peerDependencies?.["@stablemates/workhorse"]).toBe(corePeerRange);
    expect(await read("typescript/core/src/version.ts")).toContain(
      `WORKHORSE_VERSION = "${releaseVersion}"`,
    );

    const pythonManifest = await read("python/pyproject.toml");
    expect(pythonManifest).toContain(`version = "${releaseVersion}"`);
    expect(pythonManifest).toContain("Development Status :: 4 - Beta");
    expect(pythonManifest.toLowerCase()).toContain(publicBetaLabel);
    expect(await read("python/uv.lock")).toContain(
      `name = "stablemates-workhorse"\nversion = "${releaseVersion}"`,
    );
  });

  it("dates the release entry in each changelog with the schema version and the upgrade step", async () => {
    const manifest = JSON.parse(await read("support.json")) as SupportManifest;
    const floors = [
      [
        "CHANGELOG.md",
        [
          `Node.js **${manifest.support.node.minimum}** or newer`,
          `PostgreSQL **${manifest.support.postgres.minimum}** or newer`,
        ],
      ],
      ["python/CHANGELOG.md", [`Python **${manifest.support.python.minimum}** or newer`]],
      ["go/CHANGELOG.md", [`Go **${manifest.support.go.minimum.replace(/\.0$/, "")}** or newer`]],
    ] as const;

    for (const [relativePath, requirements] of floors) {
      const changelog = await read(relativePath);
      const entry = prose(changelogEntry(changelog, releaseVersion, releaseDate));
      expect(entry).toContain("**schema v1**");
      expect(entry).toContain("from one source commit");
      expect(entry).toContain("recreate the database");
      for (const requirement of requirements) {
        expect(entry).toContain(requirement);
      }
      expect(changelog).not.toMatch(/^## .* — unreleased$/m);
    }
  });

  it("names the released version on the site from the package and its commands from support.json", async () => {
    const landing = await read("site/src/routes/index.tsx");
    expect(landing).toContain('import { WORKHORSE_VERSION } from "@stablemates/workhorse/version"');
    expect(landing).toContain('import support from "../../../support.json"');
    expect(landing).toContain("npm v{WORKHORSE_VERSION}");
    expect(landing).not.toMatch(/\d+\.\d+\.\d+/);

    expect(await read("docs/compatibility.md")).toContain(
      `The current release is \`${releaseVersion}\`.`,
    );
    expect(await read("site/content/docs/compatibility.mdx")).toContain(
      `The current release is \`${releaseVersion}\`.`,
    );
  });
});

describe("the public beta line", () => {
  it("puts the label and compatibility boundary on every package README", async () => {
    const readmes = [
      ...(await publishedPackages()).map((entry) => `${entry.location}/README.md`),
      "python/README.md",
      "go/README.md",
    ];

    for (const relativePath of readmes) {
      const contents = await read(relativePath);
      expect(contents.toLowerCase()).toContain(publicBetaLabel);
      expect(prose(contents)).toContain(compatibilityNotice);
    }
  });

  /**
   * The packed smoke checks the notice inside each tarball, so it needs the same definition these
   * tests use. It used to restate the sentence, and the two drifted the moment the wording changed:
   * the packed job runs on the daily cron rather than on a pull request, so five green pull requests
   * shipped a notice it still rejected. This keeps it a reader of the notice, not a second author.
   */
  it("keeps the packed smoke a reader of the notice rather than a second author of it", async () => {
    const packedSmoke = await read("typescript/core/test/packed-packages.ts");
    expect(packedSmoke).toContain('from "../../../scripts/public-beta-notice.js"');
    expect(packedSmoke).not.toContain("**Public beta:**");
    expect(prose(packedSmoke)).not.toContain(compatibilityNotice);
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
      expect(contents.toLowerCase()).toContain(publicBetaLabel);
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

  it("keeps the published beta versions dated and attributed in each changelog", async () => {
    const entries = [
      ["CHANGELOG.md", betaNpmVersion, npmSourceCommit],
      ["python/CHANGELOG.md", betaPythonVersion, pythonSourceCommit],
      ["go/CHANGELOG.md", betaGoVersion, goSourceCommit],
    ] as const;

    for (const [relativePath, version, sourceCommit] of entries) {
      const entry = changelogEntry(await read(relativePath), version, betaPublicationDate);
      expect(entry).toContain(sourceCommit);
    }
  });

  it("builds the site with the supported Go toolchain line", async () => {
    expect(await read("Dockerfile.site")).toMatch(
      /^FROM golang:1\.25(?:\.[0-9]+)?-alpine@sha256:[0-9a-f]{64} AS go$/m,
    );
  });

  it("records the standing release train and its stop conditions", async () => {
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

    // The train is the standing process, so it names no version and no commit. The beta's three
    // source commits live in the changelog entries that date them.
    const trainSection = prose(
      compatibility.slice(
        compatibility.indexOf("### Release train"),
        compatibility.indexOf("### npm packages"),
      ),
    );
    expect(trainSection).toContain("from one source commit");
    expect(trainSection).toContain("every tag names the candidate commit");
    expect(trainSection).not.toMatch(/\d+\.\d+\.\d+/);
    expect(trainSection).not.toMatch(/\b[0-9a-f]{40}\b/);
  });

  it("publishes a security policy that names the reporting channel and the supported line", async () => {
    const policy = prose(await read("SECURITY.md"));
    expect(policy).toContain("https://github.com/stablemates/workhorse/security/advisories/new");
    expect(policy).toContain("acknowledge a report within five business days");
    expect(policy).toContain(
      "Only the latest `0.x` minor release of each package line receives security fixes",
    );
    expect(policy).toContain("A published version is never re-tagged or replaced");
    expect(policy).toContain(
      "deprecate the npm release, yank the PyPI release, or retract the Go version",
    );

    expect(await read("README.md")).toContain("[Security policy](SECURITY.md)");
    expect(await read("docs/compatibility.md")).toContain("[`SECURITY.md`](../SECURITY.md)");
  });
});
