# ADR 0106: Keep the release lines in lockstep after 1.0.0

- **Status:** Accepted
- **Date:** 2026-10-22
- **Amends:** [ADR 0028](0028-flat-per-language-repository-layout.md) (package versions do not
  float per language),
  [ADR 0054](0054-define-what-1-0-0-promises.md) (the lines do not float again after
  1.0.0),
  [ADR 0058](0058-fix-the-current-line-and-gate-floors-on-upstream-end-of-life.md) (a fix in one SDK
  releases every line),
  [ADR 0059](0059-assemble-the-1-0-0-specification.md),
  [ADR 0079](0079-govern-the-rust-api-as-an-eighth-surface.md),
  [ADR 0084](0084-govern-the-ruby-api-as-a-ninth-surface.md),
  [ADR 0103](0103-shape-the-jvm-sdk-as-a-java-core-with-kotlin-and-spring-boot-modules.md)
- **Related:** [ADR 0050](0050-release-0-1-0-without-a-prerelease-suffix.md),
  [ADR 0102](0102-keep-main-open-during-a-release-by-tagging-the-candidate-commit.md)
- **Issue:** SM-1281. SM-1275 made `pnpm release:check` check every release path.

## Context

Workhorse publishes six release lines. They are the ten npm packages, the Python distribution, the
Go module, the Rust crate, the Ruby gem, and the three JVM artifacts. A release line is the sequence
of versions that one of these publishes.

The documentation gave two rules for the lines after 1.0.0:

1. `docs/compatibility.md`, "Release train": every release publishes the same version from one
   source commit.
2. ADR 0028 said that package versions float independently per language. ADR 0054 said that the
   lines synchronize once at 1.0.0. After 1.0.0, each line floats independently. ADRs 0059, 0079,
   0084, and 0103 repeated that rule.

ADR 0058 also said that a defect in one SDK ships on that line alone, and that the other lines do
not move. `SECURITY.md`, the site page `releases.mdx`, and its diagram repeated that rule.

The release tooling follows the first rule only:

1. `scripts/check-release.ts` reads every file that carries the release version, and it refuses a
   candidate if one line has a different version, for every tag.
2. The crate, gem, and Maven Central jobs of `.github/workflows/release.yml` have no tag of their
   own. They publish from the npm `vX.Y.Z` tag and compare their version with it.
3. `scripts/release-go.sh` refuses to tag unless `vX.Y.Z` and `python/vX.Y.Z` point to the same
   commit (ADR 0102).

Under the second rule, a `go/v1.1.0` tag fails the release check unless every line is at 1.1.0.

The releases so far also follow the first rule. 0.6.1 exists only to publish the Python
distribution with PEP 740 attestations. 0.7.1 exists only because the npm publish of 0.7.0 stopped
partway. In both releases, every other line published the same version with no change. The
changelog of each such line says so, for example "The crate has no changes in 0.6.1. It releases at
0.6.1 to keep one version across the registries."

## Decision

The six release lines stay in lockstep before and after 1.0.0. Every release publishes every line
at one version, from one source commit, as one release train. 1.0.0 is not a special
synchronization. It is one more release of the train.

### A fix in one line releases every line

If the defect is in one SDK, the fix ships in a release train like any other release. Each other
line publishes the same version with no change, a version-only release. The changelog of that line
states that it has no changes, as the 0.6.1 and 0.7.1 changelogs do.

The fix still ships only on the highest published minor of the current major (ADR 0058). This ADR
changes which lines publish, not which versions receive a fix.

### A major in one line is a major for every line

This rule starts at 1.0.0. Before 1.0.0, a minor release can make a breaking change. From 1.0.0, if
a change needs a major release on one line, the next release is a major release. Every line
publishes that major. A line with no break publishes the major as a version-only release. Its
changelog states that it has no breaking change.

A break of `dashboard/v1` does not need a major release. It creates `dashboard/v2`, as
`docs/compatibility.md` states.

For the Go module, each major N from 2 also changes the module path to end in `/vN`. For example,
2.0.0 uses `github.com/stablemates/workhorse/go/v2`. A Go caller must then change its import paths,
also when the Go API has no break. 1.0.0 keeps the current module path.

### `pnpm release:check` keeps its scope

`scripts/check-release.ts` already checks one version for every line on every tag. It does not
change. The crate, gem, and Maven Central steps of `release.yml` continue to publish from the npm
tag.

### Earlier records keep their text

ADRs 0028, 0054, 0058, 0059, 0079, 0084, and 0103 keep their decision text. Their status block
names this ADR as an amendment. `docs/compatibility.md`, `SECURITY.md`, and the site state the lockstep rule.

## Why

1. One version tells a reader which artifacts belong together. The SQL protocol, the schema floor,
   and the dashboard bundle are the same in each line of one release.
2. The release tooling, the release check, and the release procedure already assume one version on
   one candidate commit. Floating lines need a separate tag and a separate check for the crate, the
   gem, and the JVM artifacts. The project has no use for them now.
3. A version-only release costs one changelog entry and one publish job. The 0.6.1 and 0.7.1
   releases show that the cost is small.

## Revisit this decision

The maintainer revisits this decision if one of these occurs:

1. A major release of one line forces a major for the other lines. The Go module path change
   costs Go callers more than the shared version gives them.
2. One line needs releases much more often than the others. The version-only releases of the other
   lines become frequent.
3. A registry needs a release that the other registries cannot publish in the same window. Thus one
   train cannot publish all six lines.

A change to floating lines must give each line its own tag. `scripts/check-release.ts` must then
check each line against its own tag. The crate, gem, and Maven Central steps of `release.yml` must
do the same. Tests must cover each check.

## Consequences

- Every release changes the version of every line, also of a line with no change.
- A defect in one SDK cannot ship faster than one release train.
- The Go module moves to a new module path at each major of the train from 2.0.0.
- `docs/compatibility.md`, `SECURITY.md`, `site/content/docs/releases.mdx`, and its diagram state
  one rule.

## Rejected alternatives

### Let the lines float after 1.0.0

ADR 0054 chose this. Each line would follow SemVer on its own surfaces. Thus a break in one SDK
would not move the others. It is rejected for now. The release tooling would need a tag and a check
for each line, and no line has asked for an independent release yet.

### Keep one minor version, and let each line take its own patch

This keeps the lines close and lets a fix in one SDK skip the version-only releases. It is
rejected. The crate, the gem, and the JVM artifacts publish from the npm tag. A patch on one of them
would need a tag of its own.
