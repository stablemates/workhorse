import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { repositoryRoot } from "./packages.js";

// The release and RubyGems jobs install the locked bundle and load it beside a publishing identity.
// A frozen bundle pins each version, but only a `CHECKSUMS` section pins the bytes of that version:
// Bundler compares every downloaded gem with it and refuses a mismatch. A lockfile regenerated
// without checksums, or a gem added without one, would silently drop that comparison.

const execFileAsync = promisify(execFile);

async function committedLockfiles(): Promise<string[]> {
  const { stdout } = await execFileAsync("git", ["ls-files", "ruby/*.lock", "ruby/**/*.lock"], {
    cwd: repositoryRoot,
  });
  return stdout.split("\n").filter(Boolean);
}

/** `name (version[-platform])` of every gem the lockfile resolves from a registry. */
function registrySpecs(lockfile: string): string[] {
  const specs: string[] = [];
  for (const section of lockfile.split(/\n\n+/)) {
    if (!section.startsWith("GEM\n")) continue;
    for (const line of section.split("\n")) {
      const spec = /^ {4}(\S+ \([^)]+\))$/.exec(line);
      if (spec) specs.push(spec[1]!);
    }
  }
  return specs;
}

/** `name (version[-platform])` of every gem the `CHECKSUMS` section pins to a SHA-256 digest. */
function checksummedSpecs(lockfile: string): Set<string> {
  const section = lockfile.split(/\n\n+/).find((block) => block.startsWith("CHECKSUMS\n")) ?? "";
  return new Set(
    section
      .split("\n")
      .map((line) => /^ {2}(\S+ \([^)]+\)) sha256=[0-9a-f]{64}$/.exec(line)?.[1])
      .filter((spec): spec is string => spec !== undefined),
  );
}

describe("Ruby lockfile checksums", () => {
  it("pins every registry gem and platform variant in each committed lockfile", async () => {
    const lockfiles = await committedLockfiles();
    expect(lockfiles).toEqual(
      expect.arrayContaining(["ruby/Gemfile.lock", "ruby/gemfiles/rails_8_0.gemfile.lock"]),
    );

    for (const relativePath of lockfiles) {
      const lockfile = await readFile(path.join(repositoryRoot, relativePath), "utf8");
      const specs = registrySpecs(lockfile);
      const checksummed = checksummedSpecs(lockfile);
      expect({ relativePath, resolved: specs.length > 0 }).toEqual({
        relativePath,
        resolved: true,
      });
      expect({ relativePath, unpinned: specs.filter((spec) => !checksummed.has(spec)) }).toEqual({
        relativePath,
        unpinned: [],
      });
    }
  });

  it("never disables checksum validation where a bundle is installed", async () => {
    const surfaces = [
      ".github/workflows/ci.yml",
      ".github/workflows/release.yml",
      "package.json",
      "lefthook.yml",
    ];
    for (const relativePath of surfaces) {
      const contents = await readFile(path.join(repositoryRoot, relativePath), "utf8");
      expect({ relativePath, disabled: /disable_checksum_validation/i.test(contents) }).toEqual({
        relativePath,
        disabled: false,
      });
    }
  });
});
