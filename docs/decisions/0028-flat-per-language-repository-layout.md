# ADR 0028: Flat per-language repository layout

- **Status:** Accepted
- **Date:** 2026-08-15
- **Related:** [ADR 0023](0023-language-sdks-and-http-boundaries.md), [ADR 0027](0027-keep-versioned-dashboard-views.md)

## Context

ADR 0023 committed Workhorse to native Python and Go SDKs whose correctness-sensitive lifecycle
stays in versioned PostgreSQL functions. Those SDKs need a home. The choice is one repository or
one repository per language, and, inside one repository, a directory layout.

The protocol conformance fixtures under `protocol/v1/` are the cross-language contract. If SDKs
live in separate repositories, every protocol change must be published as a versioned artifact,
pinned per repository, and advanced by synchronization tooling. That recreates, between
repositories, the drift the fixtures exist to prevent. The database test harness
(`scripts/setup-worktree.ts`, `scripts/with-env.ts`) is the expensive part of any SDK test suite,
and it already exists here.

The TypeScript package also occupied the repository root, where its `package.json` served three
roles at once: pnpm workspace root, script catalogue, and npm publish manifest for
`@workhorse-js/core`.

## Decision

Workhorse keeps one repository. Language SDKs are full implementations of a shared brain: every
correctness-critical lifecycle transition stays in the versioned SQL functions, and each language
implements only orchestration around them.

The repository adopts one top-level directory per language beside language-neutral roots:

- `typescript/` — all JavaScript/TypeScript code: `typescript/core` (published as
  `@workhorse-js/core`; the npm name does not change), the dashboard server, the ORM adapter
  packages, the demo, and the examples. The directory is named for the language, not `node/`,
  because the runtime support matrix (Node, Bun, Deno) is wider than one runtime.
- `python/`, `go/`, and later `rust/` — one directory per SDK, each self-contained with its own
  toolchain and manifest.
- `protocol/`, `sql/`, `docs/` — the language-neutral contract and reference.
- `dashboard/` — the shared operator SPA and, later, its versioned wire specification.
- `site/` — the workhorse.run site, promoted from the former application grouping.

The placement rule: shared product artifacts live at the repository root; a language directory
holds only that language's SDK and runtime code. The repository root becomes a private pnpm
workspace with no publish metadata. TypeScript remains the reference implementation; this ADR
records that status because the layout no longer implies it.

Supporting decisions:

- The Go module path is `github.com/stablemates/workhorse/go`, released with `go/vX.Y.Z` tags.
  The module is not fetchable until the repository is public, so publication precedes any Go
  release.
- Package versions float independently per language. The protocol version in
  `protocol/v1/compatibility.json` is the only cross-language compatibility contract.
- Worker-runtime semantics that live outside SQL — suspension arbitration, batch assembly and
  ordering, heartbeat cadence, drain — must be pinned in `protocol/v1/runtime.json` before a
  second language implements them.
- Each language's test lane must run the shared `protocol/v1/scenarios.json` fixtures against a
  provisioned database.

Extraction into per-language repositories is not a goal. If community ownership ever demands it,
each top-level directory extracts with history intact, and the remainder becomes the specification
repository.

## Consequences

- A protocol change and every affected implementation land in one commit, gated by one
  conformance run at one schema version.
- New SDKs reuse the existing database provisioning instead of rebuilding it per repository.
- The most-edited code gains a path prefix, and documentation that names `typescript/core/src/` paths needs a
  one-time mechanical sweep.
- Contributors clone every toolchain, and continuous integration must filter lanes by path.
- npm consumers see no change; `@workhorse-js/core` keeps its name and contents.
