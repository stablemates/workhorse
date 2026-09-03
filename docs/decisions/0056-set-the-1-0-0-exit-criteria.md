# ADR 0056: Set the exit criteria that gate the 1.0.0 tag

- **Status:** Accepted
- **Date:** 2026-09-03
- **Assembled by:** [ADR 0059](0059-assemble-the-1-0-0-specification.md)
- **Related:** [ADR 0054](0054-define-what-1-0-0-promises.md),
  [ADR 0055](0055-the-1-0-0-schema-boundary-adds-no-migration.md),
  [ADR 0053](0053-start-migrations-at-0-1-0-and-keep-them-additive.md),
  [ADR 0043](0043-public-ci-and-release-policy.md),
  [WH-579](https://ontrack.sh/projects/WH/issues/WH-579),
  [WH-565](https://ontrack.sh/projects/WH/issues/WH-565),
  [WH-581](https://ontrack.sh/projects/WH/issues/WH-581),
  [WH-584](https://ontrack.sh/projects/WH/issues/WH-584)

## Context

ADR 0054 says what 1.0.0 promises. It does not say what must be true before the tag is created.
Without that, 1.0.0 becomes a date somebody picks, and the promise rests on the author's confidence
rather than on evidence a reader can check.

Three facts constrain the answer.

The promises are unenforced. ADR 0054 governs seven surfaces and defines a breaking change on each.
Its own correction records that no CI gate enforces any of the seven definitions. A promise that
nothing checks is broken by accident, and the first person to notice is a user whose build stopped.

The safety-critical path is only now getting exercised. ADR 0053 started the migration chain at
0.1.0, so every 0.x user has a database this project carries forward. ADR 0055 put the rehearsal in
two homes — the demo's deployment pipeline and a seeded released-artifact test — and both are new.
The failure path is in neither: the recovery procedure in `docs/schema-lifecycle.md` has never been
executed.

There are no outside users yet. WH-553 records the baseline: zero outside accounts have opened an
issue, discussion, or pull request, and its target for the launch window is five. One maintainer
working about one day a week cannot manufacture adoption on a schedule.

That last fact is what makes the exit criteria hard to state honestly. The evidence that would most
validate a stability promise — other people running the thing and upgrading it — is the evidence
this project cannot produce on demand.

## Decision

Six gates hold the 1.0.0 tag. Each has a measurable bar and a named home for its evidence. A gate is
either met or waived in writing; nothing passes by assertion.

### Gate 1. Every governed surface has a mechanical check

Seven checks run in the CI `required` job, one per surface in ADR 0054:

| Surface                      | The check                                                                                                                                                                                              |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| SQL protocol and schema      | `sql-catalogues:check`, extended to fail on a removed or retyped function, view, or column that a supported release reads. Today it detects drift from the generated catalogue and classifies nothing. |
| TypeScript API               | A committed public-API snapshot per package `exports`, generated from the shipped `.d.ts`, failing on a removal or a narrowing.                                                                        |
| Python API                   | A committed snapshot of each public module's `__all__` and its signatures.                                                                                                                             |
| Go API                       | `apidiff` against the previous published tag, failing on an incompatible change.                                                                                                                       |
| `workhorse` CLI              | A committed snapshot of the command and flag set, what each exit code means, and the field types of `--json` output.                                                                                   |
| `dashboard/v1` wire contract | `dashboard-spec:check`, extended to classify a change as additive or breaking rather than only detecting drift.                                                                                        |
| Telemetry names              | A committed snapshot of instrument, span, and attribute names, with each instrument's unit and kind.                                                                                                   |

Evidence lives in the snapshot files in this repository and in the `required` job on the 1.0.0
candidate commit.

### Gate 2. The shape has stopped moving

At least six weeks and at least two published 0.x minors separate the last non-additive change to a
governed surface from the 1.0.0 tag. A non-additive change is a rename, a removal, a retype, or a
supersession. Any such landing restarts both clocks.

At the tag, no outside-filed defect against a governed surface is open and unaccepted. Each is fixed,
or its Issue carries a written reason for accepting it.

The clock starts where ADR 0055 opens the train: at the commit where the last Issue tagged
`0.x-only` lands. Evidence lives in that merge commit, the two release tags, and the outside-filed
Issue list.

Two minors rather than one, because the additive rule has to survive contact with real change before
it is promised. Six weeks rather than a longer floor, because a quiet period measures the absence of
events, and a solo project can produce that absence simply by not working.

### Gate 3. The upgrade works on a real database

ADR 0055 already placed the happy path in two homes: the demo migrates from its deployment pipeline
against a database it writes to continuously, and WH-614 seeds the released-artifact test so a
populated database is proved to survive. This gate is those two having actually run, plus the two
things neither of them covers.

**The recurring rehearsal has run.** WH-614 is landed and green in `required`, and the demo has
migrated from its pipeline across at least two releases without a pre-deploy hook failing.

**The failure path has been rehearsed on purpose.** A restored copy of the demo's populated database
is migrated with a deliberate mid-migration failure, and the recovery procedure in
[`docs/schema-lifecycle.md`](../schema-lifecycle.md) is followed exactly as written. A recovery
procedure nobody has executed is a draft.

**A cold install has been performed.** A fresh host with no checkout of this repository installs the
candidate from the published registries in all three languages, following only the site's
installation page, and runs a job end to end.

Evidence lives in the `required` run for WH-614, in the demo's deployment record, and in two
rehearsal reports in the private `stablemates/workhorse-operations` repository.

The cold install is the stand-in for outside validation. It is not as good as another team's
deployment, and it is the closest thing this project can produce on its own schedule.

### Gate 4. It survives time under load

One database runs 30 consecutive days with continuous work. It is never reinstalled, and it is
carried across at least two releases by migration. Inside that window it records at least 30 daily
partition rollovers, at least one retention pass that dropped a partition, and at least one
ungraceful kill of a worker under load followed by recovery with no lost or duplicated job.

The public demo host is the soak site. It already runs TypeScript, Python, and Go workers against one
database. Redeploying its containers does not restart the clock; reinstalling its database does.

Evidence lives in a soak report in the operations repository, with a queue-health snapshot at each
end of the window.

### Gate 5. The dashboard server is reviewed

A written review covers `@stablemates/workhorse-dashboard-server` against a checklist: authorization
on every `dashboard/v1` procedure, payload redaction ([ADR 0035](0035-redact-dashboard-payloads-in-the-read-surface.md)),
the parameterization of every statement, error and stack-trace leakage, the mount's CSRF and CORS
behaviour, and dependency advisories. Every High finding is resolved. Every Medium is resolved or
accepted in writing. `SECURITY.md` states that no third-party audit has taken place.

A paid third-party audit is not a gate. This project cannot buy one, and a gate nobody can clear is
a way of never shipping.

Evidence lives in the review record in the operations repository, the findings as Issues, and the
sentence in `SECURITY.md`.

### Gate 6. The product is the same in three languages

`pnpm parity:check` passes and the product operator table carries no Planned cell. WH-581 set that
bar and named the four: CLI queue purge (WH-615), Dashboard redrive (WH-616), CLI checkpoint and
wait reads (WH-617), and CLI durable worker pause (WH-618). Any Absent cell that appears later
records why it is absent. `site/content/docs/limitations.mdx` states the TypeScript-only boundary
for schema tooling as a decision rather than a gap.

None of the four is a compatibility requirement — adding a command breaks nothing under ADR 0054 —
so this gate is about an operator not changing tools mid-incident, and it is the one gate a waiver
would cost least.

Evidence lives in the generated tables in [`docs/parity.md`](../parity.md) and in the `required` job.

## The time floor is derived, not a date

The tag lands no earlier than the latest of three moments: six weeks after the last non-additive
change to a governed surface, the last day of the soak window, and 2026-11-02, which is four weeks
after the beta read-out on 2026-10-05.

The floor is derived so that slipping work moves it. Announcing a date instead would create pressure
to meet the date by lowering a bar, which is the failure this ADR exists to prevent.

Against the work in flight — the pre-freeze renames, the parity closures, and Gate 1's seven checks —
the realistic earliest tag is the first quarter of 2027. That is an estimate and not a commitment.

## Who signs off

The maintainer signs off once, by Comment on the closing release Issue, after every gate row carries
a link to its evidence. No agent creates the 1.0.0 tag.

A gate is waived only by the maintainer, in a Comment that names the gate and the reason. The waiver
is recorded in the release Issue, and in `docs/compatibility.md` when it changes what the release
promises. Waivers are visible or they are not waivers.

## Recorded at the tag, but gating nothing

**The outside-engagement count.** WH-553's primary metric — five distinct outside accounts opening
an issue, discussion, or pull request — is read out and recorded. It does not hold the tag. A gate
the maintainer cannot influence is a wish rather than a gate, and the useful half of that metric is
already in Gate 2: what matters is that outside-filed defects are resolved, not how many arrived.

**Documentation coverage of every exported identifier.** WH-577 counted roughly 600 undocumented
public identifiers across the three lines. ADR 0054 already decoupled the two questions: undocumented
does not mean experimental, and the Experimental table is the only authority. Documenting 600
identifiers is months of solo work that would not change a single promise.

**Benchmark numbers.** 1.0.0 promises compatibility, not throughput.
`docs/compatibility.md` already states that benchmark validation is not the support boundary.

**An outside team in production.** Not observable from public sources, and one conversation cannot
be targeted. Recorded as a qualitative note if it happens.

## Consequences

The tag is now blocked on work that does not exist yet. Gate 1 is seven checks, Gate 3 adds a
failure-path rehearsal and a cold install to the work ADR 0055 already placed, Gate 4 is an evidence
collector and an operational rule for the demo host, and Gate 5 is a review. Each is filed as an
Issue tagged `release-1.0`, and together they are the critical path to 1.0.0 alongside WH-581's
parity closures.

The demo host acquires an operational constraint. Its database is the soak subject, so reinstalling
it restarts a 30-day clock. Reinstall stops being a routine act during the soak window.

The exit criteria have two homes and one owner each. This ADR states the bars; it changes only by
amendment. WH-565's Notes track whether each bar is met and link the evidence; that list moves
weekly. When the two disagree, this ADR is the bar and the Board is wrong about the state.

Nothing here gates the 0.1.0 train or the launch window. Both run to their own schedule, and the
first gate clock cannot start until the pre-freeze work lands.
