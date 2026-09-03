# ADR 0054: Define what 1.0.0 promises on each governed surface

- **Status:** Accepted
- **Date:** 2026-09-02
- **Amends:** [ADR 0042](0042-publish-the-first-public-beta.md)
- **Related:** [ADR 0053](0053-start-migrations-at-0-1-0-and-keep-them-additive.md),
  [WH-578](https://ontrack.sh/projects/WH/issues/WH-578),
  [WH-576](https://ontrack.sh/projects/WH/issues/WH-576),
  [WH-580](https://ontrack.sh/projects/WH/issues/WH-580),
  [WH-581](https://ontrack.sh/projects/WH/issues/WH-581),
  [WH-582](https://ontrack.sh/projects/WH/issues/WH-582)

## Context

ADR 0042 says "public beta" and leaves the rest to prose: 0.x minors may break compatibility, and
SemVer starts mattering at some point that nobody named. ADR 0053 then took the schema out of that
sentence — the migration chain runs from 0.1.0, so the database already has a promise. What is left
undefined is everything else. A reader who asks "what does 1.0.0 mean for the Python API, or for the
`workhorse` CLI, or for a Grafana alert written against `workhorse.jobs.count`" has no answer.

"SemVer" alone is not that answer. SemVer says a major release may break the public API; it does not
say which of this project's artifacts is a public API. Workhorse ships seven distinguishable
surfaces across three language lines, one SQL protocol, one CLI, one wire contract, and a set of
telemetry names. Each fails differently. A renamed TypeScript export breaks a build. A renamed
OpenTelemetry instrument breaks an alert silently, months later, and looks like a quiet system.

WH-576 surveyed seven peers. Two findings shaped this decision. First, the projects that never
declared 1.0 did not thereby avoid the question: River publishes 47 minors while stating its core
APIs "have been stable since release," which is a stability promise wearing a 0.x number. Declining
to number the promise does not decline to make it. Second, breakage clusters at the boundary. Every
painful upgrade in the survey — pg-boss v10 to v11, Graphile Worker 0.14.0 — was a release that
removed or rebuilt something while users were mid-fleet. The boundary is where the cost lands, so
the boundary is what a 1.0 decision has to be about.

The 0.x line is where renames are free. That freedom ends at the freeze, and this ADR fixes what
replaces it.

## Decision

### SemVer governs seven surfaces, and nothing else

An artifact is either on this list or it is internal, and internal things change without notice in
any release. Each surface below states, in one sentence, what a breaking change is for it.

**1. The SQL protocol and schema.** A breaking change is a narrowing of
`workhorse.protocol_version`: the installed schema stops answering a client protocol version, which
is how a superseded `_vN` function is finally removed. A schema-version bump is not a breaking
change, because inside a major line a migration only adds ([ADR 0053](0053-start-migrations-at-0-1-0-and-keep-them-additive.md)).

**2, 3, 4. The TypeScript, Python, and Go APIs.** A breaking change is one that makes caller code
that compiled or ran correctly against the previous release stop compiling or behave differently.
The public surface is what each ecosystem already treats as public: for TypeScript, the names and
types reachable through a package's `exports` map and shipped `.d.ts`; for Python, the names in a
public module's `__all__`, excluding every underscore-prefixed module such as `workhorse._protocol`;
for Go, the exported identifiers of the module's non-`internal` packages, where the standard is
Go's own: what `apidiff` calls an incompatible change. No CI gate enforces these definitions yet;
WH-584 files that work. A type-level break is a break: a narrowed parameter or a widened
return that an existing caller cannot hold counts, even when no runtime behaviour moved.

**5. The `workhorse` CLI.** A breaking change is removing or renaming a command or flag, changing
what an exit code means, or removing or retyping a field in `--json` output. Adding a `--json`
field is not breaking, because a consumer is required to tolerate fields it does not know.
Human-readable stdout prose is not governed; scripts read `--json`.

**6. The `dashboard/v1` wire contract.** A breaking change is removing a procedure, removing or
retyping a response field, or tightening request validation. The contract carries its own version in
its path, so a break creates `dashboard/v2` rather than moving any package major. The obligation
runs the other way: `dashboard/v1` is served for the whole major line it shipped in.

**7. The OpenTelemetry instrument, span, and attribute names.** A breaking change is renaming or
removing an instrument, span, or attribute, or changing an instrument's unit or kind. Adding one is
not breaking. These names are governed because a dashboard or an alert is caller code that no
compiler checks; a silent rename presents as a system that went quiet.

### An API is stable unless `docs/compatibility.md` lists it as experimental

Nothing is experimental by default, and no marker makes it so on its own. The **Experimental
surface** list in `docs/compatibility.md` is the authority. An entry on that list is excluded from
every promise above and may change or disappear in any release. Doc comments mirror the list —
`@experimental` in a TypeScript JSDoc tag or a Python docstring's first line, an `Experimental:`
prefix on a Go doc comment — so a reader at the call site sees it too. A marker without a list entry
is a defect in the list, not an exclusion.

### The three lines reach 1.0.0 together, then float again

1.0.0 is one release train: the nine npm packages, the Python distribution, and the Go module
publish 1.0.0 from one source commit, in the established Python, npm, Go order. A line that cannot
clear the parity bar ([WH-581](https://ontrack.sh/projects/WH/issues/WH-581)) slips the train rather
than being left behind, because "Workhorse 1.0" naming a promise that holds in one language and not
another is not a promise a reader can use.

This is a one-time synchronisation, not permanent lockstep. After 1.0.0 the three version lines
float independently again, exactly as they do today, and each is governed by SemVer on its own
surfaces. The nine npm packages stay in lockstep with each other, as they are now.

### 1.0.0 removes nothing and narrows nothing

1.0.0 is a promise change, not a shape change. It does not remove a superseded `_vN` function, does
not narrow `workhorse.protocol_version`, and does not remove a TypeScript export, a Python name, a
Go identifier, a CLI flag, or a telemetry name. Everything the API audit wants renamed lands in a
0.x minor before the freeze, by supersession, with the old name retained. Accumulated removals wait
for 2.0.0.

So the upgrade from the last 0.x to 1.0.0 is an ordinary rolling deployment: migrate from the
pipeline, then roll the fleet. It is not the one upgrade in the product's life that requires
stopping every process. Making the last step of the beta the only unsafe one would punish exactly
the readers who accepted the invitation to run 0.x in early production.

### "Public beta" ends at 1.0.0 and is replaced by "stable"

The label retires when the release it qualifies is superseded. "Stable" replaces it: not a new
marketing word, just the ordinary word for a line whose promises are the ones stated above.
"GA" was considered and rejected — it borrows an enterprise register and implies a support
organisation this project does not have.

### What beta users are told, and where

Three statements, in the 1.0.0 entry of each changelog and on the site's compatibility page:

1. The upgrade is `workhorse schema migrate` and a package bump, the same two steps as every 0.x
   minor since 0.1.0.
2. Nothing was removed at the boundary, and the names that changed during 0.x are listed in the last
   0.x minor's changelog entry, which ships one release earlier so the list arrives before the
   upgrade does.
3. Which schema versions and client protocol versions 1.0.0 accepts.

No separate migration guide is written. A guide whose content is "run the command you already run"
would imply a difficulty that this decision exists to remove.

## Consequences

The schema carries 0.x-era `_v1` functions through the whole 1.x line. That is the price of an
uneventful boundary, and it is the same price ADR 0053 already accepted inside a major line, paid
once more.

A 1.0.0 that removes nothing constrains the freeze:
[WH-580](https://ontrack.sh/projects/WH/issues/WH-580) now decides _when_ the last 0.x minor becomes
schema-identical to 1.0.0, not _whether_ it does. Any rename the API audit wants is 0.x work with a
deadline, not 1.0 work.

Governing the OpenTelemetry names moves them out of `typescript/core/src/metrics-observer.ts` and
into the compatibility contract. Renaming an instrument becomes a major-release act in three
languages at once, so a name is now worth arguing about before it ships.

Governing `--json` and not prose gives the CLI room to improve its human output freely, and obliges
every `--json` consumer to ignore unknown fields. A consumer that fails on an added field is
depending on something never promised.

One train means the slowest line sets the date. `docs/parity.md` records the Absent cells that would
hold it, so the parity bar is now on the critical path to 1.0.0 rather than beside it.

Nothing here changes what 0.1.0 promises today. The public beta label, its compatibility boundary,
and the additive migration chain stand unchanged until 1.0.0 ships.
