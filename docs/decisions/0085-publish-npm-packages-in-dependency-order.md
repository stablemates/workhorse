# ADR 0085: Publish npm packages in dependency order

- **Status:** Accepted
- **Date:** 2026-09-30
- **Amends:** [ADR 0045](0045-stage-the-first-public-beta-release.md)
- **Related:** [SM-996](https://linear.app/stablemates/issue/SM-996)

## Context

ADR 0045 publishes `@stablemates/workhorse` before its eight peer dependents. Core then had no
published dependency, so publishing it first meant every package found what it required on npm.

Core now depends on `@stablemates/workhorse-dashboard-contract`. Publishing core first would put a
version on npm that cannot install until the contract follows. The dashboard facade likewise
requires the dashboard server. A failure between those two publications would leave an
uninstallable version on the registry, and npm never lets a version be reused.

## Decision

Publish each npm package after every published package it requires. A package requires its
`dependencies` and every peer it does not mark optional. Among packages whose requirements are
already placed, choose the next package in package-name order.

The release scripts derive this order from the manifests. No script assumes that core comes first;
a step that needs core selects it by name.

The rest of ADR 0045 stands: Python publishes first, npm second, Go last.

## Consequences

A failed npm publication leaves only versions whose requirements are already on npm, so each one
installs. The publisher does not resume the train from the same commit: it refuses any package
version that already exists. Recovery re-cuts the whole train at a higher patch version, as
[Recovering a partially published release](../compatibility.md#recovering-a-partially-published-release)
describes.

The order changes whenever a manifest gains or loses a published dependency. The release scripts
follow it without an edit, and a test pins the order the current manifests produce.
