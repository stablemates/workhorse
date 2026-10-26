import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { publishedPackages, repositoryRoot } from "./packages.js";

/**
 * The release check that every release tag runs before anything publishes.
 *
 * One release puts one version on npm, PyPI, the Go module proxy, crates.io, RubyGems, Maven
 * Central, and nuget.org from one commit. The crate, gem, Maven Central, and nuget.org jobs of
 * `.github/workflows/release.yml` skip publication when their version disagrees with the tag, and
 * the job still succeeds. So this check, not the publish jobs, has to refuse a candidate that
 * leaves one line behind. It reads every file that carries the release version and reports every
 * disagreement at once, whichever tag runs it.
 */

const releaseVersionPattern = "[0-9]+\\.[0-9]+\\.[0-9]+(?:[ab][0-9]+|rc[0-9]+|-[-0-9A-Za-z.]+)?";

type ReleaseTarget = "go" | "npm" | "python";

/** One release, spelled the way each ecosystem requires. */
interface TrainVersion {
  /** SemVer: npm, Go, crates.io, Maven Central, nuget.org, and the Ruby `VERSION` constant. */
  readonly semver: string;
  /** PEP 440: the Python distribution. */
  readonly pep440: string;
  /** The normalized form Bundler writes into a lockfile, for example `0.9.0.pre.rc.1`. */
  readonly gem: string;
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
}

const pep440Kinds: Readonly<Record<string, string>> = {
  alpha: "a",
  a: "a",
  beta: "b",
  b: "b",
  rc: "rc",
};
const semverKinds: Readonly<Record<string, string>> = { a: "alpha", b: "beta", rc: "rc" };

function tagVersion(target: ReleaseTarget, tag: string): string {
  const prefix = target === "npm" ? "" : `${target}/`;
  const match = new RegExp(`^${prefix}v(${releaseVersionPattern})$`).exec(tag);
  if (!match) throw new Error(`Expected a ${prefix}vX.Y.Z release tag, received ${tag}`);
  return match[1]!;
}

/**
 * Both spellings of the tag's version. A prerelease maps between SemVer `-alpha.N`, `-beta.N`, and
 * `-rc.N` and PEP 440 `aN`, `bN`, and `rcN`. A Python tag must use the PEP 440 spelling and the
 * other tags the SemVer one, because each publication step compares its tag literally.
 */
function trainVersion(target: ReleaseTarget, version: string): TrainVersion {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:(a|b|rc)(\d+)|-(.+))?$/.exec(version);
  if (!match) throw new Error(`${version} is not a release version`);
  const [, major, minor, patch, pepKind, pepNumber, semverSuffix] = match;
  const base = `${major}.${minor}.${patch}`;
  let semver = base;
  let pep440: string | undefined = base;
  if (pepKind) {
    semver = `${base}-${semverKinds[pepKind]}.${pepNumber}`;
    pep440 = version;
  } else if (semverSuffix) {
    semver = version;
    const prerelease = /^(alpha|a|beta|b|rc)\.?(\d+)$/.exec(semverSuffix);
    pep440 = prerelease ? `${base}${pep440Kinds[prerelease[1]!]}${prerelease[2]}` : undefined;
  }
  if (!pep440) throw new Error(`${version} has no PEP 440 spelling for the Python distribution`);
  const expected = target === "python" ? pep440 : semver;
  if (version !== expected) {
    const line = target === "python" ? "Python" : target === "go" ? "Go" : "npm";
    throw new Error(`Expected the ${line} tag to spell ${version} as ${expected}`);
  }
  return {
    semver,
    pep440,
    gem: semver.replace("-", ".pre."),
    major: Number(major),
    minor: Number(minor),
    patch: Number(patch),
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

class ReleaseFiles {
  readonly problems: string[] = [];

  constructor(readonly root: string) {}

  /** The file's contents, or `undefined` after recording that it is missing. */
  async read(relativePath: string): Promise<string | undefined> {
    try {
      return await readFile(path.join(this.root, relativePath), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      this.problems.push(`${relativePath} is missing`);
      return undefined;
    }
  }

  async exists(relativePath: string): Promise<boolean> {
    try {
      await stat(path.join(this.root, relativePath));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }

  /** Records a disagreement unless `pattern`'s first group in the file is `expected`. */
  async requireVersion(
    relativePath: string,
    pattern: RegExp,
    expected: string,
    subject = "a version",
  ): Promise<void> {
    const contents = await this.read(relativePath);
    if (contents === undefined) return;
    const declared = pattern.exec(contents)?.[1];
    if (declared === undefined) this.problems.push(`${relativePath} declares no ${subject}`);
    else if (declared !== expected) {
      this.problems.push(`${relativePath} is ${declared} but the tag is ${expected}`);
    }
  }

  async requireChangelogEntry(relativePath: string, version: string): Promise<void> {
    const changelog = await this.read(relativePath);
    if (changelog === undefined) return;
    if (!new RegExp(`^## ${escapeRegExp(version)}(?:\\s|$)`, "m").test(changelog)) {
      this.problems.push(`${relativePath} has no ${version} release entry`);
    }
  }
}

/** The npm manifests, the core version constant, the peer ranges, and `support.json`. */
async function checkNpmLine(files: ReleaseFiles, version: TrainVersion): Promise<void> {
  const packages = await publishedPackages(files.root);
  const names = new Set(packages.map((entry) => entry.name));
  for (const entry of packages) {
    if (entry.version !== version.semver) {
      files.problems.push(`${entry.manifest} is ${entry.version} but the tag is ${version.semver}`);
    }
  }
  await files.requireVersion(
    "typescript/core/src/version.ts",
    /WORKHORSE_VERSION = "([^"]+)"/,
    version.semver,
  );

  // A 0.x minor may break, so a peer covers one minor line. From 1.0.0 it covers the major line.
  const range =
    version.major === 0
      ? `>=0.${version.minor}.0 <0.${version.minor + 1}.0`
      : `>=${version.major}.0.0 <${version.major + 1}.0.0`;
  for (const manifest of [
    ...packages.map((entry) => entry.manifest),
    "dashboard/app/package.json",
  ]) {
    const contents = await files.read(manifest);
    if (contents === undefined) continue;
    const peers = (JSON.parse(contents) as { peerDependencies?: Record<string, string> })
      .peerDependencies;
    for (const [name, declared] of Object.entries(peers ?? {})) {
      if (names.has(name) && declared !== range) {
        files.problems.push(
          `${manifest} requires ${name} ${declared} but the release needs ${range}`,
        );
      }
    }
  }

  const support = await files.read("support.json");
  if (support !== undefined) {
    const install = (JSON.parse(support) as { install?: Record<string, string> }).install ?? {};
    for (const [key, command] of Object.entries(install)) {
      // The schema download and pinned schema tool, a Gradle coordinate, and a Maven `<version>`.
      for (const match of command.matchAll(
        /(?:\/download\/v|@stablemates\/workhorse@|run\.workhorse:[\w-]+:)([^/\s"')]+)|<version>([^<]+)<\/version>/g,
      )) {
        const declared = match[1] ?? match[2];
        if (declared !== version.semver) {
          files.problems.push(
            `support.json install.${key} is ${declared} but the tag is ${version.semver}`,
          );
        }
      }
    }
  }
}

/** Every Ruby lockfile that resolves the gem from its path. */
async function rubyLockfiles(root: string): Promise<string[]> {
  let entries: string[] = [];
  try {
    entries = await readdir(path.join(root, "ruby/gemfiles"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return [
    "ruby/Gemfile.lock",
    ...entries
      .filter((entry) => entry.endsWith(".lock"))
      .toSorted()
      .map((entry) => `ruby/gemfiles/${entry}`),
  ];
}

/**
 * The four .NET packages share one version. The `nuget` job reads every `<Version>` element of the
 * file with `sed` and publishes only when the result equals the tag, so the file must hold one.
 */
async function checkDotnetVersion(files: ReleaseFiles, version: TrainVersion): Promise<void> {
  const relativePath = "dotnet/Directory.Build.props";
  const contents = await files.read(relativePath);
  if (contents === undefined) return;
  const declared = [...contents.matchAll(/<Version>([^<]*)<\/Version>/g)].map((match) => match[1]);
  if (declared.length === 0) files.problems.push(`${relativePath} declares no Version`);
  else if (declared.length > 1) {
    files.problems.push(`${relativePath} declares ${declared.length} Version elements, not one`);
  } else if (declared[0] !== version.semver) {
    files.problems.push(`${relativePath} is ${declared[0]} but the tag is ${version.semver}`);
  }
}

async function checkOtherLines(files: ReleaseFiles, version: TrainVersion): Promise<void> {
  await files.requireVersion(
    "python/pyproject.toml",
    /^version = "([^"]+)"$/m,
    version.pep440,
    "project version",
  );
  await files.requireVersion(
    "python/src/workhorse/_version.py",
    /^WORKHORSE_VERSION = "([^"]+)"$/m,
    version.pep440,
  );
  await files.requireVersion(
    "python/uv.lock",
    /^name = "stablemates-workhorse"\nversion = "([^"]+)"$/m,
    version.pep440,
    "stablemates-workhorse version",
  );
  await files.requireVersion("go/version.go", /^const Version = "([^"]+)"$/m, version.semver);
  for (const manifest of ["rust/Cargo.toml", "Cargo.lock"]) {
    await files.requireVersion(
      manifest,
      /^name = "workhorse"\nversion = "([^"]+)"$/m,
      version.semver,
      "workhorse version",
    );
  }
  // The three JVM artifacts share one version (ADR 0103).
  await files.requireVersion("jvm/gradle.properties", /^version=(\S+)$/m, version.semver);
  await checkDotnetVersion(files, version);
  await files.requireVersion(
    "ruby/lib/stablemates/workhorse/version.rb",
    /^\s*VERSION = "([^"]+)"$/m,
    version.semver,
  );
  for (const lockfile of await rubyLockfiles(files.root)) {
    const contents = await files.read(lockfile);
    if (contents === undefined) continue;
    const resolved = [...contents.matchAll(/^\s+stablemates-workhorse \(([^)]+)\)$/gm)].map(
      (match) => match[1],
    );
    if (resolved.length === 0)
      files.problems.push(`${lockfile} declares no stablemates-workhorse version`);
    for (const declared of new Set(resolved)) {
      if (declared !== version.gem) {
        files.problems.push(`${lockfile} is ${declared} but the tag is ${version.gem}`);
      }
    }
  }
}

/** The changelog of every released line, including each npm package that keeps its own. */
async function checkChangelogs(files: ReleaseFiles, version: TrainVersion): Promise<void> {
  await files.requireChangelogEntry("CHANGELOG.md", version.semver);
  await files.requireChangelogEntry("python/CHANGELOG.md", version.pep440);
  for (const line of ["go", "rust", "ruby", "jvm", "dotnet"]) {
    await files.requireChangelogEntry(`${line}/CHANGELOG.md`, version.semver);
  }
  for (const entry of await publishedPackages(files.root)) {
    const changelog = `${entry.location}/CHANGELOG.md`;
    if (await files.exists(changelog)) await files.requireChangelogEntry(changelog, version.semver);
  }
}

/**
 * A minor or major release freezes the clean-install artifact of the schema version it ships
 * (`docs/schema-lifecycle.md`). A patch release ships no new schema version to freeze.
 */
async function checkFrozenSchema(files: ReleaseFiles, version: TrainVersion): Promise<void> {
  if (version.patch !== 0) return;
  const catalogue = await files.read("typescript/core/src/queue/sql-catalogue.generated.ts");
  if (catalogue === undefined) return;
  const schemaVersion = /WORKHORSE_SCHEMA_VERSION = (\d+);/.exec(catalogue)?.[1];
  if (!schemaVersion) {
    files.problems.push(
      "typescript/core/src/queue/sql-catalogue.generated.ts declares no schema version",
    );
    return;
  }
  const artifact = `sql/releases/${schemaVersion.padStart(4, "0")}.sql`;
  if (!(await files.exists(artifact))) {
    files.problems.push(
      `${artifact} is missing, but release ${version.semver} must freeze schema version ${schemaVersion}`,
    );
  }
}

export async function checkRelease(
  target: ReleaseTarget,
  tag: string,
  root = repositoryRoot,
): Promise<void> {
  const version = trainVersion(target, tagVersion(target, tag));
  const files = new ReleaseFiles(root);
  await checkNpmLine(files, version);
  await checkOtherLines(files, version);
  await checkChangelogs(files, version);
  await checkFrozenSchema(files, version);
  if (files.problems.length > 0) throw new Error(files.problems.join("\n"));
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  const [target, tag] = process.argv.slice(2);
  if ((target !== "go" && target !== "npm" && target !== "python") || !tag) {
    process.stderr.write(
      "Usage: pnpm release:check <go|npm|python> <go/vX.Y.Z|vX.Y.Z|python/vX.Y.Z>\n",
    );
    process.exitCode = 1;
  } else {
    try {
      await checkRelease(target, tag);
    } catch (error) {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    }
  }
}
