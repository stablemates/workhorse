# ADR 0043: Prepare repository history before publication

- **Status:** Accepted
- **Date:** 2026-08-25
- **Related:** [WH-437](https://app.plane.so/techprogress/browse/WH-437/)

## Context

The repository is still private, so rewriting history remains practical. Publication would expose
private deployment topology, internal planning, and strategy documents in old commits even after
their removal from the working tree.

The exposure audit found no production credential. It did find missing licence notices, misleading
documentation, and private operational material that must not ship in the first public beta.

## Decision

Before publication, rewrite every remote branch and tag that will remain at publication. Remove
`TODO.md` and every tracked file under `docs/research/`. Plane becomes the sole backlog. Keep the
benchmark reports and raw results public with their existing version, workload, and uncertainty
limits.

Keep a public `AGENTS.md` and its `CLAUDE.md` symlink after removing private operations and personal
workflow details. Extract the concrete Kamal configuration, host-specific scripts, production
topology, and deployment runbook into a versioned private operations repository before removing
them. Keep parameterized examples and generic deployment guidance in this repository.

Resolve every blocker and high-severity audit finding before publication. Resolve the duplicate ADR
number and integration-brand provenance in the same cleanup.

Complete remediation privately and verify it from a fresh clone. Inspect every release archive and
run a final exposure scan. Force-update or delete every remote branch and tag, then verify every
surviving ref from a fresh clone. Only then make the repository public. Enable the scheduled full CI
next and require a green public run before publishing an npm, PyPI, or Go release.

If public CI fails, keep the repository public, stop package publishing, and fix forward. If a
credential or sensitive exposure appears, immediately make the repository private and rotate or
revoke the exposed material. Treat prior public access as irreversible.

## Consequences

Every rewritten commit gets a new identifier. Active branches and existing private clones must
rebase or restart from the rewritten repository. The private operations repository becomes a
required deployment dependency, so the extraction must preserve a tested operational source of
truth rather than merely deleting public files.
