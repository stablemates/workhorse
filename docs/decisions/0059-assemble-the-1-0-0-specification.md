# ADR 0059: Assemble the 1.0.0 specification from the seven decisions

- **Status:** Accepted
- **Date:** 2026-09-03
- **Related:** [ADR 0054](0054-define-what-1-0-0-promises.md),
  [ADR 0055](0055-the-1-0-0-schema-boundary-adds-no-migration.md),
  [ADR 0056](0056-set-the-1-0-0-exit-criteria.md),
  [ADR 0057](0057-retain-superseded-functions-and-contract-on-the-operators-schedule.md),
  [ADR 0058](0058-fix-the-current-line-and-gate-floors-on-upstream-end-of-life.md),
  [ADR 0045](0045-stage-the-first-public-beta-release.md),
  [WH-565](https://ontrack.sh/projects/WH/issues/WH-565),
  [WH-584](https://ontrack.sh/projects/WH/issues/WH-584)

## Context

WH-565 opened seven decisions about 1.0.0 and closed all seven. Five produced an ADR. Two did not:
WH-577 was a research audit whose verdicts live in a private findings file, and WH-581 recorded its
answer as a Board Comment because ADR 0055 was concurrently taken.

So a reader asking "what is 1.0.0, and what is left before it" must read five ADRs, one Comment, and
one file in another repository. Nothing states which of the thirty-odd open Issues tagged
`release-1.0` actually hold the tag and which merely ship near it. That distinction is the one an
Agent picking up work needs first, and it exists nowhere.

This ADR is the entry point. It names each decision ticket and its answer, gives the two
ADR-less answers a durable home, and states the execution order. It decides nothing that ADR 0054
through ADR 0058 already decided; where this document and one of those disagree, the earlier ADR is
right and this one is stale.

## Decision

### The seven decisions and their answers

| Ticket                                                 | Question                                 | Answer lives in                                                                           |
| ------------------------------------------------------ | ---------------------------------------- | ----------------------------------------------------------------------------------------- |
| [WH-577](https://ontrack.sh/projects/WH/issues/WH-577) | What exactly would 1.0.0 freeze?         | This ADR, from `docs/research/api-surface-audit.md` in `stablemates/workhorse-operations` |
| [WH-578](https://ontrack.sh/projects/WH/issues/WH-578) | What does 1.0.0 promise on each line?    | [ADR 0054](0054-define-what-1-0-0-promises.md)                                            |
| [WH-579](https://ontrack.sh/projects/WH/issues/WH-579) | What must be true before the tag?        | [ADR 0056](0056-set-the-1-0-0-exit-criteria.md)                                           |
| [WH-580](https://ontrack.sh/projects/WH/issues/WH-580) | Where is the schema boundary?            | [ADR 0055](0055-the-1-0-0-schema-boundary-adds-no-migration.md)                           |
| [WH-581](https://ontrack.sh/projects/WH/issues/WH-581) | What is the parity bar?                  | This ADR, from the WH-581 Answers Comment                                                 |
| [WH-582](https://ontrack.sh/projects/WH/issues/WH-582) | What are the operational promises?       | [ADR 0057](0057-retain-superseded-functions-and-contract-on-the-operators-schedule.md)    |
| [WH-583](https://ontrack.sh/projects/WH/issues/WH-583) | What is the security and support policy? | [ADR 0058](0058-fix-the-current-line-and-gate-floors-on-upstream-end-of-life.md)          |

**WH-578 — what 1.0.0 promises.** SemVer governs seven surfaces: the SQL protocol and schema, the
TypeScript, Python, and Go APIs, the `workhorse` CLI, the `dashboard/v1` wire contract, and the
OpenTelemetry instrument, span, and attribute names. Everything else is internal, and adding is
never breaking. Experimental is a table in `docs/compatibility.md`, not a marker, and it is empty.
1.0.0 removes nothing and narrows nothing, so the last upgrade of the beta is an ordinary rolling
deployment. The three lines reach 1.0.0 in one train and float again afterwards.

**WH-579 — the exit criteria.** Six gates hold the tag, each with a measurable bar: a mechanical CI
check for each of the seven governed surfaces, a quiet period of six weeks and two published minors
after the last non-additive change, the migration rehearsals plus a failure path and a cold install,
a 30-day soak on a never-reinstalled database, a written dashboard-server security review, and a
parity matrix with no unexplained Absent cell. The time floor is derived from the gates rather than
announced. The Human signs off once; a waiver is a Comment naming the gate and the reason.

**WH-580 — the schema boundary.** There is no freeze. The schema keeps growing additively across
1.0.0 and through 1.x. The rule is that 1.0.0 adds no migration step: the same
`WORKHORSE_SCHEMA_VERSION` as the last 0.x minor, no new file under `sql/migrations/`, no new
artifact under `sql/releases/`. The cutoff is release-shaped rather than date-shaped, and a defect
found during the train is fixed by another 0.x minor.

**WH-582 — the operational promises.** A major release adds and removes nothing. Removal is a
contract step the operator applies with `workhorse schema contract` once their fleet has moved.
Retention is twelve months after the successor ships. The migration chain is never pruned, so no
database is ever stranded.

**WH-583 — security and support.** A fix ships on the highest published minor of the current major
of each affected line and nowhere else. Raising a Node.js, Python, Go, or PostgreSQL floor is a
minor, and only upstream end of life may raise it. Dependency ranges move by the same rule in either
direction. `SECURITY.md` runs to the end of the disclosure path.

### WH-577: what the audit found, and what it settles

The audit enumerated 1,329 public identifiers across the three languages, the SQL protocol, and the
CLI, each with a keep, rename, remove, or experimental verdict. Three findings change what 1.0.0
freezes, and they are recorded here because the findings file is private.

The freeze list is not the manifest. The SDKs call 33 functions and 25 tables beyond the 26 in
`protocol/v1/manifest.json`. The governed set is what a supported release reads, and WH-620 must
write that set down rather than inherit the manifest.

One third of the Go surface is generated. Of 447 exported Go identifiers, 150 are generated
dashboard bindings that the Go backend does not use. ADR 0054's rule classifies them: they are
reachable from the module's public packages, so SemVer governs them, and WH-619's snapshot covers
them like any other export.

TypeScript was the odd language out. On every disputed name, Python and Go already agreed and
TypeScript did not, so the renames fell on the line with the most users. Every one of those renames
is filed as `0.x-only` and lands before the freeze, which is why no 1.0.0 release note carries a
rename.

The audit's thirteen rename and removal Issues are WH-590 through WH-602. They are not 1.0 gate
work. They are 0.x work that must precede the freeze, and they already block the 0.1.0 candidate.

### WH-581: the parity bar

Two answers, both recorded on the Board and neither in an ADR until now.

The bar for 1.0.0 is that every cell of the product table in `docs/parity.md` reads Supported or
records why it does not, and that `pnpm parity:check` passes in `required`. Four cells were open at
charting time, and the audit corrected the map's belief about which four: they are CLI and Dashboard
cells rather than SDK cells. The Go and Python SDK operator surfaces are Supported and tested.

The four cells must close, and each is filed with the SQL function it wraps: WH-615 (queue purge,
`workhorse.purge_queue_v1`), WH-616 (dashboard redrive, `workhorse.redrive_v1` and
`workhorse.redrive_many_v1`), WH-617 (checkpoint, wait, and human-decision reads), and WH-618
(durable worker pause, `workhorse.set_worker_paused_v1`). They are additive, so they do not restart
the quiet period.

Schema and terminal tooling stay TypeScript-only at 1.0.0. That is a stated boundary rather than a
gap, and `site/content/docs/limitations.mdx` and `docs/features.md` say so.

### What gates the tag, and what does not

Two classes of work carry the `release-1.0` tag, and confusing them is how a release slips for a
reason nobody agreed to.

**Gate work** produces evidence for one of ADR 0056's six gates. It blocks the release train Issue.
There are twelve such Issues, and no thirteenth is added here.

**1.0-era work** is wanted around the tag and holds nothing. ADR 0058 said this of everything it
filed, and this ADR keeps that ruling. WH-630 (the site releases page), WH-631 (end-of-life dates in
`support.json`), WH-632 (npm advisory scanning), and WH-633 (repository security settings, a
maintainer action) are 1.0-era work.

WH-632 is the one to watch. WH-625's checklist has a line about npm advisories, and landing WH-632
first turns that line into a check instead of a manual sweep. That is a preference and stays a
`relates`. Promoting it to a blocker would make ADR 0058's "none is a 1.0 gate" false by relation.

The contract step is gate-adjacent and blocks the train. `docs/schema-lifecycle.md` describes
`workhorse schema contract` in the present tense, and the command does not exist. That is not a new
gate; it is a defect that would be published at the tag. WH-626 ships the mechanism and WH-627
supplies the `worker_registry` columns its refusal gate reads.

### What "the release candidate" means for a cold install

WH-623 installs the candidate from the registries, and the Human signs off before any 1.0.0 tag
exists. Those two facts look contradictory, and the resolution is ADR 0055 plus ADR 0054.

The last published 0.x minor is 1.0.0 in every respect except its version string. It carries the
same schema version, the same migration set, and — because 1.0.0 removes nothing and narrows nothing
— the same public surface. So the cold install rehearses that published minor. A cold install of
1.0.0 itself would prove nothing the rehearsal did not, and waiting for one would make gate 3
unsatisfiable before sign-off.

### The order the execution work runs in

Six stages. Each stage names its Issues; within a stage they run in parallel.

1. **Finish the 0.x shape changes.** The audit's thirteen Issues, WH-590 through WH-602. They block the
   0.1.0 candidate, and the last of them to land on `main` starts gate 2's six-week clock.
2. **Build the mechanical checks.** WH-619, WH-620, WH-621. Each is blocked by the shape changes to
   the surface it snapshots, because a snapshot regenerated by every rename hides the diff it exists
   to show.
3. **Close the parity cells.** WH-615 through WH-618. Additive, so they run beside the quiet period
   rather than inside it.
4. **Prove the upgrade.** WH-614 in the suite, WH-622 on a restored copy of the demo's database,
   WH-623 from the registries.
5. **Prove it survives.** WH-624 collects the 30-day soak. WH-625 reviews the dashboard server.
6. **Ship the mechanism the docs promise.** WH-627, then WH-626.

The release train Issue is blocked by every Issue in stages 2 through 6. Stage 1 blocks it through
the 0.1.0 train, which must publish first.

### The release train

One Issue coordinates it, mirroring WH-566: one candidate commit, then Python, then npm, then Go, in
ADR 0045 order, with evidence recorded per stage. No commit lands on `main` between the first tag
and the last. Every tag names the candidate commit and points at a green `CI / required` push run
for it. A failure at any stage stops the train, and the fix is a higher version rather than a re-tag.

The train Issue is where the Human's single sign-off Comment goes, after every gate row carries a
link to its evidence. No Agent creates a tag.

## Consequences

A reader who wants the 1.0.0 specification reads this ADR and follows seven links. Nobody has to
reconstruct it from the Board.

The two decisions that had no ADR now have one. If WH-577's private findings file or WH-581's
Comment becomes unreachable, the parts that bind 1.0.0 survive in the repository.

The `release-1.0` tag stops answering "does this hold the tag". The `blocks` relations into the
train Issue answer it instead, so the frontier is a query rather than a reading.

Adding a fourteenth gate Issue now requires saying so against ADR 0056, which still owns the gate
list. This ADR can order work and can name a published-documentation defect as a blocker; it cannot
quietly invent a seventh gate.

## Rejected alternatives

**Restate the five ADRs in full here.** A specification that duplicates its sources drifts from
them, and the duplicate is the copy people read. Naming each decision with a one-paragraph answer
and a link keeps one authority per decision.

**Write a `docs/release-1.0.md` guide instead of an ADR.** The map asked for a decision record, and
two of the seven answers had no other home. A guide states no numbers by this repository's own rule,
which would leave the parity cells and the audit counts unstatable.

**Make WH-630 through WH-633 gates so the release is complete.** ADR 0058 ruled on exactly this and
said no. Reopening it here would relitigate a decision by changing a relation rather than by
argument, which is the failure mode the map's "do not relitigate without saying so" note names.

**Give the 1.0.0 train children the way WH-566 has them.** The 0.1.0 train needed children because
its stages were unbuilt work. The 1.0.0 train's work is already filed as gate Issues; its own stages
are tagging and verification, which one Issue with per-stage evidence records without a second layer
of keys.
