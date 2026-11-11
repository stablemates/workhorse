# What SemVer governs

Semantic Versioning (SemVer) describes compatibility through version numbers. Before 1.0.0, a
minor release can break caller code. This page states which Workhorse artifacts the version number
governs, what a breaking change is for each one, and which check enforces it.

[Compatibility and support boundary](compatibility.md) states the supported runtimes and the
package lines, and [Release process](releasing.md) states how a version is published.

## Governed surfaces

SemVer says a major release may break the public API. It does not say which artifact is the public
API, and Workhorse ships twelve of them. Each surface below is governed, and each states in one
sentence what a breaking change is for it. Anything not on this list is internal and may change in
any release. [ADR 0054](decisions/0054-define-what-1-0-0-promises.md) records the decision, and
[ADR 0079](decisions/0079-govern-the-rust-api-as-an-eighth-surface.md),
[ADR 0084](decisions/0084-govern-the-ruby-api-as-a-ninth-surface.md),
[ADR 0103](decisions/0103-shape-the-jvm-sdk-as-a-java-core-with-kotlin-and-spring-boot-modules.md),
and
[ADR 0107](decisions/0107-shape-the-dotnet-sdk-as-a-csharp-core-with-hosting-ef-core-and-asp-net-core-packages.md)
add the Rust, Ruby, Java, Kotlin, and C# APIs.

| Governed surface                                    | A breaking change is                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Enforced by                                                 |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| SQL protocol and schema                             | A narrowing of `workhorse.protocol_version`, which is how a superseded `_vN` function is removed. A schema-version bump is not one, because inside a major line a migration only adds.                                                                                                                                                                                                                                                                                                                                | `sql-catalogues:check`, which classifies the change         |
| TypeScript API                                      | A change that makes caller code stop compiling or behave differently, across the names and types reachable through a package's `exports` map and shipped `.d.ts`.                                                                                                                                                                                                                                                                                                                                                     | `typescript-api:check`, against `api/typescript.txt`        |
| Python API                                          | The same, across the names in a public module's `__all__`. Underscore-prefixed modules such as `workhorse._protocol` are private.                                                                                                                                                                                                                                                                                                                                                                                     | `python-api:check`, against `api/python.txt`                |
| Go API                                              | The same, across the exported identifiers of the module's non-`internal` packages. Go's own standard applies: what `apidiff` calls an incompatible change.                                                                                                                                                                                                                                                                                                                                                            | `go-api:check`, `apidiff` against the tag `api/go.txt` pins |
| Rust API                                            | The same, across the public items reachable from the `workhorse` crate root under any published feature, auto and derived traits included. Removing or renaming a feature, or moving an item behind one, is also breaking.                                                                                                                                                                                                                                                                                            | `rust-api:check`, against `api/rust.txt`                    |
| Ruby API                                            | The same for code that runs rather than compiles, across the public constants under `Stablemates::Workhorse` and the Active Job adapter, with their `Data` members and method signatures. A `:nodoc:` constant is private.                                                                                                                                                                                                                                                                                            | `ruby-api:check`, against `api/ruby.txt`                    |
| Java API                                            | The same, across every public and protected declaration in an exported package of `workhorse` and `workhorse-spring-boot-starter`, with its signature and nullness. It also covers every `workhorse.*` property with its type and default. `run.workhorse.internal` is not exported. A new last component of a public record is not breaking, because the record keeps its earlier canonical constructor; a record pattern that names all components of a public Workhorse record is outside this promise (ADR 0103). | `java-api:check`, against `api/java.txt`                    |
| Kotlin API                                          | The same, across every public declaration of `workhorse-kotlin`, with its default arguments, `suspend` modifiers, and reified type parameters.                                                                                                                                                                                                                                                                                                                                                                        | `kotlin-api:check`, against `api/kotlin.txt`                |
| C# API                                              | The same, across every public and protected type and member of `Workhorse`, `Workhorse.Hosting`, `Workhorse.EntityFrameworkCore`, and `Workhorse.AspNetCore`, with its signature, nullability, and default values. It also covers every `Workhorse:*` configuration key with its type and default. A new `required` property and a new abstract member of an interface that callers implement are breaking (ADR 0107).                                                                                                | `dotnet-api:check`, against `api/dotnet.txt`                |
| `workhorse` CLI                                     | Removing or renaming a command or flag, changing what an exit code means, or removing or retyping a field in `--json` output.                                                                                                                                                                                                                                                                                                                                                                                         | `cli-surface:check`, against `api/cli.txt`                  |
| `dashboard/v1` wire contract                        | Removing a procedure, removing or retyping a response field, or tightening request validation.                                                                                                                                                                                                                                                                                                                                                                                                                        | `dashboard-spec:check`, which classifies the change         |
| OpenTelemetry instrument, span, and attribute names | Renaming or removing an instrument, span, or attribute, or changing an instrument's unit or kind.                                                                                                                                                                                                                                                                                                                                                                                                                     | `telemetry-surface:check`, against `api/telemetry.txt`      |

The right-hand column is Gate 1 of
[ADR 0056](decisions/0056-set-the-1-0-0-exit-criteria.md): every governed surface holds a mechanical
check in the CI `required` task, so no promise rests on review alone. Ten of them read the committed
snapshots in [`api/`](../api/README.md), which that directory's own README explains. Each has a
generator, so a legitimate addition costs one command: `pnpm typescript-api:generate`,
`pnpm python-api:generate`, `pnpm go-api:generate`, `pnpm rust-api:generate`,
`pnpm ruby-api:generate`, `pnpm java-api:generate`, `pnpm kotlin-api:generate`,
`pnpm dotnet-api:generate`, `pnpm cli-surface:generate`, or `pnpm telemetry-surface:generate`.

A snapshot is only as good as where it reads from, so neither `api/cli.txt` nor `api/telemetry.txt`
reads a table kept beside the code. `api/cli.txt` reads `typescript/core/src/cli/surface.ts`, which the CLI itself
dispatches, parses, and serializes through, so renaming a command or dropping a flag stops the CLI
from accepting it. `api/telemetry.txt` reads the emitting source directly, so renaming an instrument
or an attribute changes the snapshot on the same commit.

A type-level break counts even when no runtime behaviour moved: a narrowed parameter or a widened
return that an existing caller cannot hold is a break.

Adding is not breaking. A new `--json` field, a new instrument, and a new export are all minor
changes, so a `--json` consumer must ignore fields it does not know. The CLI's human-readable stdout
prose is not governed; scripts read `--json`.

`dashboard/v1` carries its version in its committed artifacts, not its HTTP path. Each SDK release
binds its backend to the matching dashboard contract and browser bundle. A break creates
`dashboard/v2` rather than moving any package major, and the release ships its backend and bundle
together. Existing installations keep serving their bound `dashboard/v1` pair until their operator
upgrades them.

The release notes announce a `dashboard/v2` transition and give its upgrade steps. An installed
backend serves one bound contract rather than negotiating concurrent versions, so `Deprecation`
and `Sunset` response headers do not apply.

Each language line has its own governed surfaces, but the seven lines share one version. From 1.0.0,
if a change needs a major release on one line, the next release is a major for every line. A line
with no break publishes the major as a version-only release. For the Go module, each major N from 2
also changes the module path to end in `/vN`, for example `github.com/stablemates/workhorse/go/v2`.
[ADR 0106](decisions/0106-keep-the-release-lines-in-lockstep-after-1-0-0.md) records the decision.

The runtime support matrix and the declared dependency ranges are not on this list. They move by
their own rule, in a minor and only on upstream end of life; see [Raising a floor](compatibility.md#raising-a-floor).

## Two surfaces classify their own changes

`sql-catalogues:check` and `dashboard-spec:check` regenerate an artifact and diff it. A diff alone
says only that something moved, because regenerating rewrites the artifact whether a procedure was
added or removed. Each check therefore compares against a separate promise file that accumulates:
the generator may add an entry and may never drop one. The eight language checks need no such file,
because their snapshots in [`api/`](../api/README.md) are not regenerated from the surface they
describe.

- `dashboard/v1/governed-surface.json` holds every procedure, request field, and response field
  `dashboard/v1` has served, each with its type and whether validation requires it.
- `protocol/v1/governed-surface.json` holds the governed SQL functions, views, and columns, each
  with its signature or type, and lists the internal helpers beside them.

A removal or a retype fails by name and says what changed about it. An addition passes once the
generator has recorded it, which needs no hand edit. Taking a break deliberately needs
`--accept-breaking`, which rewrites the promise from the current surface; for `dashboard/v1` that
means creating `dashboard/v2` instead, and for SQL it means narrowing
`workhorse.protocol_version`.

[ADR 0064](decisions/0064-rename-the-unit-noun-from-job-to-task.md) holds the exception for
`dashboard/v1`: while no consumer outside this repository speaks the contract, a break is taken in
place with `--accept-breaking` and recorded in the deciding issue. Check that condition before
taking one. The published `openapi.json` is what is most likely to end it.

## The governed SQL surface

The governed set is what a supported release reads, which is not what `protocol/v1/manifest.json`
declares. The manifest names the 26 protocol functions the SQL protocol pins; the audit behind
[ADR 0056](decisions/0056-set-the-1-0-0-exit-criteria.md) found the SDKs and dashboards reach 33
more functions and 25 tables beyond them. The two differ on purpose and are not reconciled into one
list: the manifest is the protocol's own contract, and the governed set is every relation and
function a release actually touches.

`scripts/generate-sql-catalogues.ts` derives the set from the readers rather than from a hand list,
so a new read governs its target on the next generate:

- The manifest's statement catalogue, which is the SQL all seven SDKs send. `assertNoInlineTypeScriptSql`
  and the Python binding check keep it the only source of SDK statements.
- The three dashboard backends, `typescript/dashboard-server/src/server`, `go/dashboard`, and
  `python/src/workhorse/dashboard`, each of which builds its own SQL.
- Every `dashboard_*_v1` view, plus `dashboard_task_result_v1`, whose exact columns
  [`architecture/dashboard.md`](architecture/dashboard.md#dashboard-package-boundary) publishes as core's relational read contract. They are
  governed whether or not this repository's own backends still read them.

A view is governed whole, because its projection is the contract. A table is governed one column at
a time, by the names the reader that touches it mentions; that over-approximates when two relations
in one statement share a column name, which over-governs an internal column rather than
under-governing a read one. Everything else the schema installs is an internal helper and may change
in any release. `protocol/v1/governed-surface.json` lists both sides, so which is which is a file
rather than a judgement.

## Experimental surface

Nothing is experimental by default. An API is stable unless it appears in the table below, and this
table is the authority — a doc comment marking something experimental without an entry here is a
defect in this table, not an exclusion. An entry is outside every promise above and may change or
disappear in any release.

| Experimental API | Line | Since |
| ---------------- | ---- | ----- |
| _None._          |      |       |

Doc comments mirror this table so a reader sees the exclusion at the call site: an `@experimental`
JSDoc tag in TypeScript, `@experimental` on the first line of a Python docstring, and an
`Experimental:` prefix on a Go doc comment.

## What 1.0.0 changes

1.0.0 is a promise change, not a shape change. It removes nothing: no superseded `_vN` function, no
narrowing of `workhorse.protocol_version`, no export, name, identifier, flag, or telemetry name.
Accumulated removals wait for the first contract step of the 2.x line, which 2.0.0 itself does not
apply; see [Retention and removal](#retention-and-removal). The upgrade from the last 0.x to 1.0.0 is
therefore an ordinary rolling deployment — `workhorse schema migrate` from the pipeline, then a
package bump — and not a release that requires stopping every process.

1.0.0 adds no migration step of its own, so that migrate command reports an already-current schema
and changes nothing. The last 0.x minor carries the final schema change before the boundary. Running
the command anyway is the point: the procedure is the same one every other release uses. See
`docs/schema-lifecycle.md`.

All seven lines publish 1.0.0 from one source commit as one release train
([ADR 0079](decisions/0079-govern-the-rust-api-as-an-eighth-surface.md), [ADR 0084](decisions/0084-govern-the-ruby-api-as-a-ninth-surface.md),
[ADR 0107](decisions/0107-shape-the-dotnet-sdk-as-a-csharp-core-with-hosting-ef-core-and-asp-net-core-packages.md)). A line that
cannot clear the parity bar slips the train rather than being left behind. After 1.0.0 the seven
lines stay in lockstep, as every release before it does; see [Release train](releasing.md#release-train) and
[ADR 0106](decisions/0106-keep-the-release-lines-in-lockstep-after-1-0-0.md).

At 1.0.0 the “public beta” label retires and “stable” replaces it.

## Retention and removal

A superseded `_vN` function is retained until a major release has shipped that supersedes it **and**
twelve months have passed since the release that shipped its successor, whichever is later.
Twelve months is chosen so that an operator upgrading on an annual cadence never finds a function
gone between two consecutive upgrades. [ADR 0057](decisions/0057-retain-superseded-functions-and-contract-on-the-operators-schedule.md)
records the decision.

Retention is not support. Keeping the old function beside the new one costs schema size and nothing
else — no backports and no second implementation to maintain — which is why it is promised on a date.
[`SECURITY.md`](../SECURITY.md) states which released versions receive fixes.

**A major release removes nothing.** Its migrations add, and it keeps serving every protocol its
predecessor served, so a major upgrade is an ordinary rolling deployment. Removal is a separate
**contract step** the new major line ships and the operator applies with `workhorse schema contract`
once their fleet is entirely on the new major. `workhorse schema migrate` stops before it and names
the step it stopped before. `workhorse schema contract` applies nothing without `--yes`: it names
every worker on a retiring protocol that heartbeated inside its lease in
`workhorse.worker_registry`; producers do not register, so that evidence is never proof that no
caller remains, and confirmation is required either way. Every worker reports its client protocol
version, SDK language, and SDK
version at registration, and `workhorse schema status --json` shows the resulting counts under
`fleet` and the pending step under `schema.pendingContractSteps`.

Two consequences are worth stating plainly. `workhorse.protocol_version` is operator state rather
than release state, so two databases at the same schema version may serve different protocol sets.
And a clean install of a major line installs the contracted shape while a database migrated into it
keeps the retained functions until it contracts.

`dashboard_*_v1` views are schema objects under the same rules: a migration may add a column to a
shipped view and may not remove, retype, or reinterpret one, so a core upgrade never requires a
dashboard release inside a major line.

## What must be true before 1.0.0

Six gates hold the tag, and each is met with evidence rather than with an assertion
([ADR 0056](decisions/0056-set-the-1-0-0-exit-criteria.md)). 1.0.0 ships when the JVM and .NET SDKs
land. The maintainer changed the gates on 2026-10-18, and the amendment of ADR 0056 records the
change.

1. Every governed surface has a mechanical check in the CI `required` task. Twelve checks, one per
   surface, as the table above lists. The twelfth is the C# API, with `dotnet-api:check` against
   `api/dotnet.txt` ([ADR 0107](decisions/0107-shape-the-dotnet-sdk-as-a-csharp-core-with-hosting-ef-core-and-asp-net-core-packages.md)).
2. Each governed surface has its API snapshot and one published 0.x minor that carries its
   artifacts. A second model has written a review of its API. No outside-filed defect against a
   governed surface is open and unaccepted. The six-week quiet period and the two-minor requirement
   do not apply.
3. The migration rehearsals ADR 0055 placed have run. The recovery procedure has run against a
   deliberate mid-migration failure. A fresh host has installed the candidate from the registries of
   all seven SDKs. These include Rust from crates.io, Ruby from RubyGems, the JVM artifacts from
   Maven Central, and the .NET packages from NuGet
   ([ADR 0079](decisions/0079-govern-the-rust-api-as-an-eighth-surface.md),
   [ADR 0084](decisions/0084-govern-the-ruby-api-as-a-ninth-surface.md),
   [ADR 0103](decisions/0103-shape-the-jvm-sdk-as-a-java-core-with-kotlin-and-spring-boot-modules.md)).
4. One database has run 30 consecutive days under continuous work without being reinstalled, across
   daily partition rollover, a retention pass that dropped a partition, and an ungraceful worker
   kill with clean recovery.
5. `@stablemates/workhorse-dashboard-server` has a written security review with every High finding
   resolved. No third-party audit has taken place, and `SECURITY.md` says so.
6. `pnpm parity:check` passes and the product operator table carries no Planned cell (WH-581
   named four), and any Absent cell records why it is absent. Every product cell in the JVM and
   .NET columns of [`docs/parity.md`](parity.md) reads Supported, including the embedded dashboard
   backend.

The tag date is derived from those gates rather than announced. The tag lands no earlier than the
latest of four moments:

1. 2026-11-02.
2. The last day of the soak.
3. The day the .NET SDK lands.
4. The day the first minor publishes the JVM and .NET artifacts.

Adoption counts, documentation coverage, and benchmark numbers are recorded at the tag and gate
nothing.
