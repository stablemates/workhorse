/**
 * The five release lines and what a published version of one looks like.
 *
 * Workhorse publishes to npm, PyPI, the Go module proxy, crates.io, and RubyGems
 * from one source commit, and each line keeps its own changelog because each line
 * carries its own version. A line may exist before its first release; the table
 * then says so rather than printing a version nobody can install. This file names the lines; it states no version, because the
 * versions are read from the changelogs at build time by
 * `scripts/release-changelogs.ts`.
 *
 * `SECURITY.md` says a fix ships on the highest published minor of the current
 * major of each affected line and nowhere else. A reader cannot apply that rule
 * without the current version of every line, so `/docs/releases` prints them
 * ([ADR 0058](https://github.com/stablemates/workhorse/blob/main/docs/decisions/0058-fix-the-current-line-and-gate-floors-on-upstream-end-of-life.md)).
 */

/** One published version of one line, as its changelog records it. */
export interface Release {
  readonly version: string;
  /** ISO calendar date, `YYYY-MM-DD`. */
  readonly date: string;
}

export interface ReleaseLine {
  /** Stable key, used for React keys and for the smoke test's lookups. */
  readonly id: string;
  /** The language a reader picks the line by. */
  readonly name: string;
  /** What the reader installs, spelled the way their package manager spells it. */
  readonly artifact: string;
  readonly registry: string;
  readonly registryUrl: string;
  /** Repository-relative changelog that owns this line's versions. */
  readonly changelog: string;
  /**
   * The line has no release yet, so its changelog holds only `## Unreleased`.
   * The build fails once that changelog records a release, so the flag cannot
   * outlive the first one.
   */
  readonly unpublished?: true;
}

/** A line with its published versions read out of its changelog, newest first. */
export interface ResolvedReleaseLine extends ReleaseLine {
  /** The newest published version, the only one that receives fixes. `null` before the first. */
  readonly current: Release | null;
  /** Every earlier published version, newest first. None receives a fix. */
  readonly earlier: readonly Release[];
}

/**
 * The lines, in the order the site names them everywhere else: TypeScript,
 * Python, Go, Rust, Ruby.
 *
 * The npm line is nine packages released in lockstep from one changelog, so it
 * appears once and names the package a reader installs first.
 */
export const releaseLines: readonly ReleaseLine[] = [
  {
    id: "typescript",
    name: "TypeScript",
    artifact: "@stablemates/workhorse",
    registry: "npm",
    registryUrl: "https://www.npmjs.com/package/@stablemates/workhorse",
    changelog: "CHANGELOG.md",
  },
  {
    id: "python",
    name: "Python",
    artifact: "stablemates-workhorse",
    registry: "PyPI",
    registryUrl: "https://pypi.org/project/stablemates-workhorse/",
    changelog: "python/CHANGELOG.md",
  },
  {
    id: "go",
    name: "Go",
    artifact: "github.com/stablemates/workhorse/go",
    registry: "Go module proxy",
    registryUrl: "https://pkg.go.dev/github.com/stablemates/workhorse/go",
    changelog: "go/CHANGELOG.md",
  },
  {
    id: "rust",
    name: "Rust",
    artifact: "workhorse",
    registry: "crates.io",
    registryUrl: "https://crates.io/crates/workhorse",
    changelog: "rust/CHANGELOG.md",
  },
  {
    id: "ruby",
    name: "Ruby",
    artifact: "stablemates-workhorse",
    registry: "RubyGems",
    registryUrl: "https://rubygems.org/gems/stablemates-workhorse",
    changelog: "ruby/CHANGELOG.md",
    unpublished: true,
  },
];
