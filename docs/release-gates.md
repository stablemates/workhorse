# State of the 1.0.0 release gates

A release gate is a condition that must be true before the maintainer creates the 1.0.0 tag. Six
gates hold that tag. [ADR 0056](decisions/0056-set-the-1-0-0-exit-criteria.md), with its amendments,
is the bar for each gate. This page is the public summary of how far the project is from that bar.

Each gate has one of three states:

- **Met.** The evidence that the bar asks for exists.
- **Open.** Some of that evidence does not exist yet.
- **Waived.** The maintainer accepted the gate without its evidence, in writing, with a reason.

The date of each gate is the date of the last change of its state. If a gate has been open since ADR
0056 set it, the date is the date of the ADR. Some evidence is in a private record, because it
describes a host that the project operates or a path that someone can exploit. For that evidence,
this page states only that the record exists and its date.

## Gate 1. Every governed surface has a mechanical check

- **Bar:** Each of the twelve governed surfaces has a check that runs in CI and fails on a breaking
  change.
- **State:** Met
- **Last change:** 2026-10-23

Twelve checks, one for each of the [governed surfaces](versioning.md#governed-surfaces), must pass
before the `required` check of CI passes. CI runs the check of an SDK when a change can affect that
SDK. The twelfth check, `dotnet-api:check`, landed on 2026-10-23 in
[pull request 912](https://github.com/stablemates/workhorse/pull/912).

## Gate 2. The shape has stopped moving

- **Bar:** Each governed surface has its snapshot, a published 0.x minor, and a second-model review,
  and has no open, unaccepted outside-filed defect.
- **State:** Met
- **Last change:** 2026-11-12

Each surface has the committed [snapshot](../api/README.md) that its Gate 1 check reads, and
[release 0.12.0](https://github.com/stablemates/workhorse/releases/tag/v0.12.0) published the
artifacts of all seven SDK lines on 2026-11-07. On 2026-11-12, a second model reviewed each API in a
private record, and found eight items that need a change that is not an addition. Pull requests
[1248](https://github.com/stablemates/workhorse/pull/1248) and
[1249](https://github.com/stablemates/workhorse/pull/1249) put each change on `main`, and the next
release ships them. No outside account has filed a defect in the
[issue list](https://github.com/stablemates/workhorse/issues).

## Gate 3. The upgrade works on a real database

- **Bar:** The migration rehearsals run, the recovery from a failed migration works, and a fresh host
  installs all seven SDKs from their registries.
- **State:** Open
- **Last change:** 2026-09-03

Each deployment of the public demo migrates its database from the
[pipeline](../typescript/demo/DEPLOYMENT.md#the-schema-step-runs-from-the-pipeline), and
[`schema-migrations.test.ts`](../typescript/core/test/schema-migrations.test.ts) migrates a
populated copy of each released schema. On 2026-09-03, private records show a run of the
[recovery procedure](schema-lifecycle.md#backup-rollback-and-failed-migration-recovery) against a
deliberate failed migration, and a cold install of three SDKs. A cold install of all seven SDKs from
the registries must follow the next release.

## Gate 4. Verify one installation through retention

- **Bar:** One installation proves at least 14 consecutive complete UTC days of completed tasks,
  and the five other conditions of the amended gate.
- **State:** Open
- **Last change:** 2026-09-03

The observation of the public demo database started on 2026-09-21, with the collector that
[`DEPLOYMENT.md`](../typescript/demo/DEPLOYMENT.md#the-soak-window-forbids-a-database-reinstall)
describes. The
[five conditions](decisions/0056-set-the-1-0-0-exit-criteria.md#amendment-verify-processing-through-retention)
include at least 14 daily partition rollovers, completed tasks after a retention deletion, and
recovery from an ungraceful worker stop. A report must count that evidence for the installation,
and that report does not exist yet.

## Gate 5. The dashboard server is reviewed

- **Bar:** A written review walks the [checklist](dashboard-security-review.md), each High finding
  is resolved, and each Medium finding is resolved or accepted in writing.
- **State:** Met
- **Last change:** 2026-11-12

On 2026-11-12, a walk of all nine checklist rows on all seven dashboard hosts found no High finding.
It found one Medium finding, one Low finding in four hosts, and one finding with no security effect.
[Pull request 1250](https://github.com/stablemates/workhorse/pull/1250) resolves each of the three,
and the checklist now names the controls of all seven hosts. A finding that describes an exploitable
path stays in a private record, as [the checklist](dashboard-security-review.md#what-a-walk-produces)
requires.
Earlier private records are of 2026-09-03, 2026-09-18, and 2026-09-22, and
[`SECURITY.md`](../SECURITY.md) states that no third-party audit has taken place.

## Gate 6. The product is the same in each language

- **Bar:** `pnpm parity:check` passes, no capability table has a Planned cell, and each JVM and .NET
  cell reads Supported.
- **State:** Met
- **Last change:** 2026-10-23

`pnpm parity:check` must pass before the `required` check of CI passes, and it fails when a table
is stale or a cell has no evidence. The capability tables of [`parity.md`](parity.md) have no
Planned or Absent cell. The last column, for .NET, arrived on 2026-10-23 with each cell Supported,
in [pull request 915](https://github.com/stablemates/workhorse/pull/915).

## How this page changes

A pull request that moves the state of a gate changes this page in the same pull request. If the
evidence is not in this repository, the next pull request changes the page. ADR 0056 stays the bar:
if this page and the ADR do not agree, the ADR is correct and this page is out of date.
