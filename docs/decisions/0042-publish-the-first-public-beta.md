# ADR 0042: Publish the first public beta with prerelease versions

- **Status:** Accepted
- **Date:** 2026-08-25
- **Related:** [WH-435](https://app.plane.so/techprogress/browse/WH-435/)

## Context

Nothing has been published. Calling the release a beta only in prose would let registry metadata
present it as stable. Keeping Python's alpha suffix would contradict the agreed release status.

Workhorse remains on the 0.x line so its schema can change before 1.0.0. A beta label must not imply
compatibility or an upgrade path that the release process cannot provide.

## Decision

The first npm and Go releases are `0.1.0-beta.1`. The first Python release is `0.1.0b1`.
Every package line shares the `0.1.0` base and encodes beta status in its ecosystem's syntax.

“Public beta” is the only stability label. It means Workhorse is usable for evaluation and early
production adoption, but 0.x minor releases may break compatibility, including the schema.
There is no upgrade path between 0.x releases. Ordered migrations begin at 1.0.0.

The label and compatibility boundary appear before installation on repository, package, site,
documentation, demo, registry, module-documentation, and changelog surfaces. `support.json` remains
the public support contract.

## Consequences

npm peer ranges start at `0.1.0-beta.1` so the packages can resolve one another before `0.1.0`.
The Python classifier moves from Alpha to Beta. Public build images must match `support.json`.
