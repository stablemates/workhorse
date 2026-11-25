# ADR 0127: Remove the stability notice from the READMEs

- **Status:** Accepted
- **Date:** 2026-11-25
- **Amends:** item 2 of the published package README contract in
  [ADR 0046](0046-make-readmes-entry-points.md)
- **Related:** [ADR 0054](0054-define-what-1-0-0-promises.md)

## Context

ADR 0046 put a notice near the top of each README, before installation or API claims. Until 1.0.0
the notice told a reader that Workhorse was a public beta. At 1.0.0 it became a stability notice. It
says that Workhorse follows Semantic Versioning and that inside a major line a migration only adds.
It also says that a database from before 0.5.0 crosses migration 0025 offline.

The notice was in the root README and in 16 package READMEs. Each copy is six to eight lines above
the install command. The only known deployment is the project demo, which the maintainers operate.
Thus, the notice speaks to no known reader.

The same promise is in other places. `docs/versioning.md` and the compatibility page tell what 1.0.0
promises. The introductions of the root, Python, Go, Rust, JVM, and .NET changelogs state the
SemVer promise. `SECURITY.md`, `docs/compatibility.md`, and the installation page tell how to cross
migration 0025 offline.

## Decision

The READMEs do not carry the stability notice. In a package README, the install command now comes
after the package name and what the package provides. The root README keeps the shape that
[ADR 0100](0100-make-the-root-readme-a-product-overview.md) gives it. No README states the SemVer
promise or the compatibility boundary, and no README carries the retired "public beta" label.

The promise stays in `docs/versioning.md`, those changelog introductions, the site, and `go/doc.go`.
The migration 0025 steps stay in the reference documents.

`scripts/public-beta-release.test.ts` and `typescript/core/test/packed-packages.ts` fail when a
README, or the README inside an npm archive, carries either part of the notice again. The migration 0025 check of
each README stays. If a later README states the compatibility boundary again, it must also name the
exception and link the offline steps.

## Consequences

A registry page no longer tells the reader the SemVer promise. A reader who wants it follows the
changelog or the documentation links of the README.

A change to the promise now has fewer copies to update. The changelogs and the site keep it, so a
release still states it.
