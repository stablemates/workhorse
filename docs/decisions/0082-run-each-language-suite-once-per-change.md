# ADR 0082: Run each language suite once per change and every variation weekly

- **Status:** Accepted
- **Date:** 2026-09-28
- **Related:** [ADR 0043](0043-public-ci-and-release-policy.md),
  [ADR 0079](0079-govern-the-rust-api-as-an-eighth-surface.md),
  [SM-970](https://linear.app/stablemates/issue/SM-970)

## Context

ADR 0043 gives pull requests the newest supported combination and leaves the full matrix to a
weekly schedule. The language lanes applied that rule unevenly.

The Go lane ran its suite twice on every change: plainly and under the race detector. The Rust lane
ran its database suite twice, once with default features and once with `opentelemetry` and
`dashboard`. It also built and verified the crate package on every change. The Rust lane had no
PostgreSQL matrix, so the weekly run never tested it against older servers.

A change waits for its slowest lane. Each repeated run added minutes to that wait without testing
different product code on the newest combination.

## Decision

Pull requests and pushes run each language suite exactly once. That run uses the newest supported
language version, the newest PostgreSQL, and every optional feature the SDK offers. Format, lint,
type, API snapshot and generated-file checks still run on every change.

Every variation of a suite runs on the weekly compatibility schedule:

- the full language and PostgreSQL matrix for TypeScript, Python, Go and Rust;
- Go's suite under the race detector, through `pnpm go:test:race`;
- Rust's suite without optional features, through `pnpm rust:test:no-features`;
- the Rust crate package check, through `pnpm rust:package-check`.

`pnpm rust:test` runs the whole Rust workspace once with `--all-features`. It replaces the pair of
runs that `rust:test` and `rust:integration` made in CI. `pnpm rust:integration` stays as a focused
local command and as the list of targets that parity evidence may cite. Every target it names also
runs under `rust:test`.

`pnpm check` still runs the race detector, and the release workflows still run their full release
checks. Neither gates pull request feedback.

The daily packed-install run is unchanged. It does not delay a change.

## Consequences

A change gets one result per language, and the Rust and Go lanes stop setting the wait for every
pull request.

A regression that only a variation exposes surfaces up to a week later. Examples are a data race or
Rust code that compiles only with a feature on. The scheduled-failure issue from ADR 0043 reports
it. A contributor who touches concurrent Go code or feature-gated Rust code should run
`pnpm go:test:race` or `pnpm rust:test:no-features` before asking for review.
