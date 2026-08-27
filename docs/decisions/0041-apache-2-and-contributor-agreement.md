# ADR 0041: Apache-2.0 outbound licence and a contributor agreement

- **Status:** Accepted
- **Date:** 2026-08-25
- **Related:** [WH-434](https://app.plane.so/techprogress/browse/WH-434/)

## Context

Nothing has been published. Every package was MIT, with no commercial language and no
inbound agreement. The first public beta has to pick an outbound licence while a later
paid product is still possible. OpenTelemetry emission stays in the open-source packages.
A later paid surface is retained history, a hosted or authorised observability product,
or other new Pro files — not a mute OSS worker, and not a paid waiver to use the library.

Copyleft does not bind model training or a semantic reimplementation. AGPL on a library
that applications import is the 2015 “pay to avoid opening your app” recipe, which this
product rejected. Agent-written pull requests may carry little or no copyright, so a
later relicense of core needs inbound terms before the first outside patch.

## Decision

Published Workhorse packages use the Apache License, Version 2.0. `NOTICE` carries the
attribution Apache redistribution requires. Contributions require `CLA.md`, which assigns
copyrightable Contributions to Stablemates and licenses them back under Apache-2.0.

The beta withholds nothing. A later Pro package is new files under a commercial licence,
not a second licence of the same Apache tree.

## Consequences

Enterprise review gets an express patent grant. Apache section 5 inbound-licenses unmarked
patches as Apache-2.0; the CLA is the separate agreement that keeps core ownable. Changing
this outbound licence after outside copyrightable Contributions is the expensive move this
decision avoids.
