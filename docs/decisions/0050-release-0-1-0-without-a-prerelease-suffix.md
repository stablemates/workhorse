# ADR 0050: Release 0.1.0 without a prerelease suffix

- **Status:** Accepted
- **Date:** 2026-09-02
- **Amends:** [ADR 0042](0042-publish-the-first-public-beta.md)
- **Related:** [WH-567](https://ontrack.sh/projects/WH/issues/WH-567), [WH-566](https://ontrack.sh/projects/WH/issues/WH-566), [ADR 0045](0045-stage-the-first-public-beta-release.md)

## Context

ADR 0042 chose prerelease suffixes so registry metadata would not present the beta as stable. The
beta train then published `0.1.0-beta.2` on npm, `0.1.0b3` on PyPI, and `v0.1.0-beta.1` on Go, each
from a different commit. The launch post needs one version and one commit to cite.

The suffix never changed what a default install resolved. With only prereleases published, npm's
`latest` tag points at `0.1.0-beta.2`, pip falls back to `0.1.0b3`, and Go's `@latest` resolves
`v0.1.0-beta.1`. The compatibility statement a reader can act on is the `0.x` major, which SemVer
defines as unstable, and the "public beta" label that every surface already carries in prose.

## Decision

The launch release is the plain `0.1.0` on every line: `0.1.0` on npm from tag `v0.1.0`, `0.1.0`
on PyPI from tag `python/v0.1.0`, and `v0.1.0` on Go from tag `go/v0.1.0`. Every tag names the
same source commit, as ADR 0045 requires. npm peer ranges become `>=0.1.0 <0.2.0`.

The `0.x` major is the compatibility statement. The Python classifier stays
`Development Status :: 4 - Beta`, and "public beta" remains the only stability label on every
surface ADR 0042 lists. This amends the first paragraph of ADR 0042's decision; the rest stands.

## Consequences

Once `0.1.0` is final, a later prerelease of the same version sorts below it under SemVer and
PEP 440, so `npm install`, `pip install`, and `go get @latest` never select it. Any further
prerelease must therefore belong to the next minor: `0.2.0-beta.N` on npm, `0.2.0bN` on PyPI, and
`v0.2.0-beta.N` on Go.

`.github/workflows/release.yml` publishes without `--tag`, so a later `0.2.0-beta.N` would move
npm's `latest` onto that prerelease. Before the next npm prerelease, the workflow must publish
prereleases under a `beta` dist-tag so `latest` stays on the newest final version.

The `0.1.0` line still promises nothing between 0.x minors. Ordered migrations and the upgrade
window begin at 1.0.0, as `docs/schema-lifecycle.md` states.
