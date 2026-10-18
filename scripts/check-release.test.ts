import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkRelease } from "./check-release.js";
import { corePackage } from "./packages.js";

const current = (await corePackage()).version;

describe("checkRelease against this repository", () => {
  it("accepts the lockstep npm package versions when the root changelog documents them", async () => {
    await expect(checkRelease("npm", `v${current}`)).resolves.toBeUndefined();
  });

  it("rejects an npm tag that disagrees with the package manifests", async () => {
    // The first package in publication order is reported, whichever package that is.
    await expect(checkRelease("npm", "v9.9.9")).rejects.toThrow(
      new RegExp(
        `^typescript/[\\w-]+/package\\.json is ${current.replaceAll(".", "\\.")} but the tag is 9\\.9\\.9$`,
        "m",
      ),
    );
  });

  it("accepts the Python manifest version when its changelog documents the release", async () => {
    await expect(checkRelease("python", `python/v${current}`)).resolves.toBeUndefined();
  });

  it("rejects a Python tag that disagrees with the package manifest", async () => {
    await expect(checkRelease("python", "python/v9.9.9")).rejects.toThrow(
      `python/pyproject.toml is ${current} but the tag is 9.9.9`,
    );
  });

  it("accepts a Go module tag when its changelog documents the release", async () => {
    await expect(checkRelease("go", `go/v${current}`)).resolves.toBeUndefined();
  });

  it("rejects malformed and undocumented Go module tags", async () => {
    await expect(checkRelease("go", "v0.1.0")).rejects.toThrow("Expected a go/vX.Y.Z release tag");
    await expect(checkRelease("go", "go/v9.9.9")).rejects.toThrow(
      "go/CHANGELOG.md has no 9.9.9 release entry",
    );
  });
});

/**
 * A minimal repository that carries one release on every line. Each test breaks one file and
 * expects the check to name it, so a line that the check forgets fails here.
 */
async function writeFixture(root: string, version: string, pep440 = version): Promise<void> {
  const [major, minor] = version.split(".").map(Number) as [number, number];
  // A 0.x minor may break, so a peer covers one minor line. From 1.0.0 it covers the major line.
  const peer =
    major === 0 ? `>=0.${minor}.0 <0.${minor + 1}.0` : `>=${major}.0.0 <${major + 1}.0.0`;
  const files: Record<string, string> = {
    "typescript/core/package.json": JSON.stringify({
      name: "@stablemates/workhorse",
      version,
      peerDependencies: { "@stablemates/workhorse-dashboard": peer },
      peerDependenciesMeta: { "@stablemates/workhorse-dashboard": { optional: true } },
    }),
    "typescript/dashboard/package.json": JSON.stringify({
      name: "@stablemates/workhorse-dashboard",
      version,
      peerDependencies: { "@stablemates/workhorse": peer, react: "^19" },
    }),
    "typescript/otel/package.json": JSON.stringify({
      name: "@stablemates/workhorse-otel",
      version,
      peerDependencies: { "@stablemates/workhorse": peer },
    }),
    "typescript/otel/CHANGELOG.md": `# Changelog\n\n## ${version} — 2026-10-20\n`,
    "typescript/private/package.json": JSON.stringify({ name: "private", private: true }),
    "dashboard/app/package.json": JSON.stringify({
      name: "app",
      private: true,
      peerDependencies: { "@stablemates/workhorse": peer },
    }),
    "typescript/core/src/version.ts": `export const WORKHORSE_VERSION = "${version}";\n`,
    "typescript/core/src/queue/sql-catalogue.generated.ts":
      "export const WORKHORSE_SCHEMA_VERSION = 72;\n",
    "sql/releases/0072.sql": "-- frozen\n",
    "python/pyproject.toml": `[project]\nname = "stablemates-workhorse"\nversion = "${pep440}"\n`,
    "python/src/workhorse/_version.py": `WORKHORSE_VERSION = "${pep440}"\n`,
    "python/uv.lock": `[[package]]\nname = "stablemates-workhorse"\nversion = "${pep440}"\n`,
    "go/version.go": `package workhorse\n\nconst Version = "${version}"\n`,
    "rust/Cargo.toml": `[package]\nname = "workhorse"\nversion = "${version}"\n`,
    "Cargo.lock": `[[package]]\nname = "workhorse"\nversion = "${version}"\n`,
    "ruby/lib/stablemates/workhorse/version.rb": `module Stablemates\n  module Workhorse\n    VERSION = "${version}"\n  end\nend\n`,
    "ruby/Gemfile.lock": `PATH\n  specs:\n    stablemates-workhorse (${version.replace("-", ".pre.")})\n`,
    "jvm/gradle.properties": `# The train version.\nversion=${version}\norg.gradle.daemon=false\n`,
    "ruby/gemfiles/rails_8_0.gemfile.lock": `PATH\n  specs:\n    stablemates-workhorse (${version.replace("-", ".pre.")})\n`,
    "support.json": JSON.stringify({
      install: {
        node: "npm install @stablemates/workhorse",
        schemaDownload: `curl -fLO https://github.com/stablemates/workhorse/releases/download/v${version}/schema.sql`,
        schemaPinned: `npx --package @stablemates/workhorse@${version} workhorse schema install`,
        gradle: `implementation("dev.stablemates:workhorse:${version}")`,
        maven: `<dependency><groupId>dev.stablemates</groupId><artifactId>workhorse</artifactId><version>${version}</version></dependency>`,
      },
    }),
    "CHANGELOG.md": `# Changelog\n\n## Unreleased\n\n## ${version} — 2026-10-20\n`,
    "go/CHANGELOG.md": `# Changelog\n\n## ${version} — 2026-10-20\n`,
    "python/CHANGELOG.md": `# Changelog\n\n## ${pep440} — 2026-10-20\n`,
    "rust/CHANGELOG.md": `# Changelog\n\n## ${version} — 2026-10-20\n`,
    "ruby/CHANGELOG.md": `# Changelog\n\n## ${version} — 2026-10-20\n`,
  };
  for (const [relativePath, contents] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, relativePath)), { recursive: true });
    await writeFile(path.join(root, relativePath), contents);
  }
}

describe("checkRelease across the release train", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "workhorse-check-release-"));
    await writeFixture(root, "0.8.0");
  });

  afterEach(async () => {
    await rm(root, { force: true, recursive: true });
  });

  async function edit(relativePath: string, from: string | RegExp, to: string): Promise<void> {
    const file = path.join(root, relativePath);
    const before = await readFile(file, "utf8");
    const after = before.replace(from, to);
    expect(after).not.toBe(before);
    await writeFile(file, after);
  }

  it("accepts a minor release that every line carries, from each tag", async () => {
    await expect(checkRelease("npm", "v0.8.0", root)).resolves.toBeUndefined();
    await expect(checkRelease("python", "python/v0.8.0", root)).resolves.toBeUndefined();
    await expect(checkRelease("go", "go/v0.8.0", root)).resolves.toBeUndefined();
  });

  it.each([
    ["typescript/otel/package.json", '"version":"0.8.0"', '"version":"0.7.1"'],
    ["typescript/core/src/version.ts", '"0.8.0"', '"0.7.1"'],
    ["python/pyproject.toml", '"0.8.0"', '"0.7.1"'],
    ["python/src/workhorse/_version.py", '"0.8.0"', '"0.7.1"'],
    ["python/uv.lock", '"0.8.0"', '"0.7.1"'],
    ["go/version.go", '"0.8.0"', '"0.7.1"'],
    ["rust/Cargo.toml", '"0.8.0"', '"0.7.1"'],
    ["Cargo.lock", '"0.8.0"', '"0.7.1"'],
    ["ruby/lib/stablemates/workhorse/version.rb", '"0.8.0"', '"0.7.1"'],
    ["ruby/Gemfile.lock", "(0.8.0)", "(0.7.1)"],
    ["ruby/gemfiles/rails_8_0.gemfile.lock", "(0.8.0)", "(0.7.1)"],
    ["support.json", "download/v0.8.0/", "download/v0.7.1/"],
    ["support.json", "workhorse@0.8.0 ", "workhorse@0.7.1 "],
    ["jvm/gradle.properties", "version=0.8.0", "version=0.7.1"],
    ["support.json", "workhorse:0.8.0", "workhorse:0.7.1"],
    ["support.json", "<version>0.8.0<", "<version>0.7.1<"],
  ])("rejects %s when it carries another version", async (relativePath, from, to) => {
    await edit(relativePath, from, to);
    for (const tag of ["v0.8.0", "go/v0.8.0"] as const) {
      await expect(checkRelease(tag.startsWith("go/") ? "go" : "npm", tag, root)).rejects.toThrow(
        new RegExp(`^${relativePath.replaceAll(".", "\\.")} .*0\\.7\\.1`, "m"),
      );
    }
    await expect(checkRelease("python", "python/v0.8.0", root)).rejects.toThrow(relativePath);
  });

  it("rejects a file that no longer declares the version it must carry", async () => {
    await edit("rust/Cargo.toml", /version = .*\n/, "");
    await expect(checkRelease("npm", "v0.8.0", root)).rejects.toThrow(
      "rust/Cargo.toml declares no workhorse version",
    );
  });

  it("rejects a missing version file", async () => {
    await rm(path.join(root, "go/version.go"));
    await expect(checkRelease("npm", "v0.8.0", root)).rejects.toThrow("go/version.go is missing");
  });

  it.each([
    ["typescript/otel/package.json", "@stablemates/workhorse"],
    ["typescript/core/package.json", "@stablemates/workhorse-dashboard"],
    ["dashboard/app/package.json", "@stablemates/workhorse"],
  ])("rejects a peer range in %s that does not cover the release", async (relativePath, peer) => {
    await edit(relativePath, ">=0.8.0 <0.9.0", ">=0.7.0 <0.8.0");
    await expect(checkRelease("npm", "v0.8.0", root)).rejects.toThrow(
      `${relativePath} requires ${peer} >=0.7.0 <0.8.0 but the release needs >=0.8.0 <0.9.0`,
    );
  });

  it.each([
    "CHANGELOG.md",
    "go/CHANGELOG.md",
    "python/CHANGELOG.md",
    "rust/CHANGELOG.md",
    "ruby/CHANGELOG.md",
    "typescript/otel/CHANGELOG.md",
  ])("rejects %s without a release entry", async (relativePath) => {
    await edit(relativePath, "## 0.8.0 —", "## Unreleased —");
    await expect(checkRelease("npm", "v0.8.0", root)).rejects.toThrow(
      `${relativePath} has no 0.8.0 release entry`,
    );
  });

  it("rejects a minor release that does not freeze its schema", async () => {
    await rm(path.join(root, "sql/releases/0072.sql"));
    await expect(checkRelease("npm", "v0.8.0", root)).rejects.toThrow(
      "sql/releases/0072.sql is missing, but release 0.8.0 must freeze schema version 72",
    );
  });

  it("does not require a frozen schema for a patch release", async () => {
    await rm(root, { force: true, recursive: true });
    await writeFixture(root, "0.8.1");
    await rm(path.join(root, "sql/releases/0072.sql"));
    await expect(checkRelease("npm", "v0.8.1", root)).resolves.toBeUndefined();
  });

  it("accepts 1.0.0 on the schema version that the last 0.x minor froze", async () => {
    // 1.0.0 adds no migration (ADR 0055), so its schema artifact already exists.
    await rm(root, { force: true, recursive: true });
    await writeFixture(root, "1.0.0");
    await expect(checkRelease("npm", "v1.0.0", root)).resolves.toBeUndefined();
  });

  it("requires a major-line peer range from 1.0.0", async () => {
    await rm(root, { force: true, recursive: true });
    await writeFixture(root, "1.0.0");
    await edit("typescript/otel/package.json", ">=1.0.0 <2.0.0", ">=1.0.0 <1.1.0");
    await expect(checkRelease("npm", "v1.0.0", root)).rejects.toThrow(
      "typescript/otel/package.json requires @stablemates/workhorse >=1.0.0 <1.1.0 but the release needs >=1.0.0 <2.0.0",
    );
  });

  it("reports every mismatch at once", async () => {
    await edit("rust/Cargo.toml", '"0.8.0"', '"0.7.1"');
    await edit("ruby/lib/stablemates/workhorse/version.rb", '"0.8.0"', '"0.7.1"');
    const failure = checkRelease("npm", "v0.8.0", root);
    await expect(failure).rejects.toThrow("rust/Cargo.toml");
    await expect(failure).rejects.toThrow("ruby/lib/stablemates/workhorse/version.rb");
  });

  it("compares a prerelease in each ecosystem's own spelling", async () => {
    await rm(root, { force: true, recursive: true });
    await writeFixture(root, "0.9.0-rc.1", "0.9.0rc1");
    await expect(checkRelease("npm", "v0.9.0-rc.1", root)).resolves.toBeUndefined();
    await expect(checkRelease("python", "python/v0.9.0rc1", root)).resolves.toBeUndefined();
    await expect(checkRelease("python", "python/v0.9.0-rc.1", root)).rejects.toThrow(
      "Expected the Python tag to spell 0.9.0-rc.1 as 0.9.0rc1",
    );
  });
});
