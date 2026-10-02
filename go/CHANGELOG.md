# Go changelog

`github.com/stablemates/workhorse/go` versions and release notes live here because the Go module
builds and publishes from its own tag. It carries the version the TypeScript packages, the Python
distribution, and the Rust crate carry, because every release tag names one commit.

Workhorse is a public beta. Any 0.x minor release may change behaviour. From `0.1.0` the schema
upgrades in place: every release ships ordered migrations, and inside a major line a migration only
adds. Migration 0025 is the one exception: a database from before 0.5.0 crosses it offline, with the
[0.5.0 upgrade steps](https://github.com/stablemates/workhorse/blob/main/CHANGELOG.md#050--2026-09-28). The upgrade from 0.5 to 0.6 only adds.

## 0.6.1 — 2026-10-02

The npm packages, Python distribution, Go module, Rust crate, and Ruby gem release from one source commit.

Requires **schema v43** and Go **1.25** or newer.

The Go module has no changes in 0.6.1. It releases at 0.6.1 to keep one version across the
registries ([ADR 0050](https://github.com/stablemates/workhorse/blob/main/docs/decisions/0050-release-0-1-0-without-a-prerelease-suffix.md)).
The release exists for the Python distribution, whose 0.6.0 files on PyPI have no PEP 740
attestations.

**A 0.6.0 database needs no migration.** 0.6.1 adds no migration, so the final schema version is
**52** and the SDK compatibility floor stays at schema version **43**. An installation on 0.5
follows the [0.6.0 upgrade steps](https://github.com/stablemates/workhorse/blob/main/CHANGELOG.md#060--2026-10-02).

## 0.6.0 — 2026-10-02

The npm packages, Python distribution, Go module, Rust crate, and Ruby gem release from one source commit.

Requires **schema v43** and Go **1.25** or newer.

**Upgrade: migrate the schema before any 0.6 process starts.** The final schema version is **52**.
The SDK compatibility floor stays at schema version **43**, so a 0.5.0 process keeps working on
version 52. The migrations only add, so the upgrade is a rolling deployment. The
[root changelog](https://github.com/stablemates/workhorse/blob/main/CHANGELOG.md) lists the SQL fixes. Each takes effect when its
migration commits, and version 52 includes them all.

**An installation that runs cold export stops its exporters across migration 0052.** That migration
repairs the export ledger, but it cannot stop an upload already in flight. Upgrade in this order:

1. Stop every cold exporter, and let each finish its object and manifest uploads.
2. Keep cold export enabled, so retention keeps waiting for the export.
3. Run `workhorse schema migrate`.
4. Restart the exporters after the migration commits.

An installation that never enabled cold export needs no extra step. The
[cold export guide](https://github.com/stablemates/workhorse/blob/main/docs/guides/335-cold-export.md#a-day-is-a-utc-day) explains the repair.

**A handler result PostgreSQL cannot store now fails only its task.** jsonb refuses a NUL character
and an unpaired surrogate. Such a result used to reach the completion statement, whose refusal
ended `Worker.Run` and left the task leased. The worker now fails the attempt under the task's retry
policy with an error named `Error` and the message `<task type> result contains a NUL character or
an unpaired surrogate, which PostgreSQL jsonb cannot store`. On the fast tier the other members of
a completion batch still complete. A database error during completion still ends `Worker.Run`.

**Breaking: contract schemas can no longer use `pattern` or `patternProperties`.** The SDKs' regular
expression engines accept different syntax and match differently, so one contract could validate
differently in each language.
[ADR 0039](../docs/decisions/0039-use-a-restricted-json-schema-contract-profile.md) now leaves both
keywords out of the contract profile. Compiling or synchronizing the contract returns an error with
`<path> is outside the Workhorse contract profile` when either keyword appears at any depth. A
property named `pattern` stays valid. Check a string's shape in handler code instead; `format` stays
an annotation. A `$ref` must also point at a subschema, so it cannot reach a schema hidden in
`default` or `examples`; every SDK rejects any other reference with
`<path>.$ref must point at a subschema of the contract`. That includes a pointer that encodes
`/` as `%2F`. Upgrade in this order:

1. Find each contract version that uses `pattern` or `patternProperties`, or a `$ref` that points
   outside a subschema. A version synced before the upgrade stops compiling once the SDK is
   upgraded.
2. Publish a new version without either keyword, and move `currentVersion` to it.
3. Let tasks that hold the old version finish before you upgrade workers. A worker checks a task's
   result against the version the task holds. If that version's result schema uses either keyword,
   completing the task fails the attempt with the profile error, and the task's retry policy
   applies. Each payload was checked at enqueue, so a keyword in the payload schema does not affect
   tasks already queued.

**Breaking: a contract `$ref` must be `#` or `#/$defs/<name>`, and `$anchor` is no longer
accepted.** The SDKs' JSON Schema libraries disagreed on how to decode and resolve other reference
forms, so a reference could reach a schema the profile check never saw.
[ADR 0039](../docs/decisions/0039-use-a-restricted-json-schema-contract-profile.md) now names two reference forms: `#`, the root schema, and `#/$defs/<name>`, where
`<name>` is a key of the root `$defs`. Compiling or synchronizing the contract returns an error for any other reference, with
`<path>.$ref must point at a subschema of the contract`; for `$defs` below the root; for a `$defs`
name that does not match `^[A-Za-z_][-A-Za-z0-9._]*$`; and for `$anchor` at any depth. A property
named `$anchor` stays valid. Upgrade in this order:

1. Find each contract version that references anything other than `#` or a root definition, nests
   `$defs`, uses `$anchor`, or names a definition outside that pattern. A version synced before the
   upgrade stops compiling once the SDK is upgraded.
2. Move each referenced or anchored subschema into the root `$defs` and reference it as
   `#/$defs/<name>`. Rename each definition outside the pattern and update the references to it.
   Declare a new contract version, because contract rows are immutable, and move `currentVersion` to
   it.
3. Let tasks that hold the old version finish before you upgrade workers. A worker checks a task's
   result against the version the task holds, so a removed form in that result schema fails the
   attempt with the profile error, and the task's retry policy applies.

Fixes:

- A handler result over the task's result size limit fails the attempt with
  `TaskValueSizeLimitError` under the task's retry policy. It used to end `Worker.Run`. On the fast
  tier, an oversized result never joins a completion batch.
- The worker keeps renewing a task's lease until the final fenced transition is written. A slow
  completion could let a peer recover and rerun the task.
- `ShutdownGracePeriod` starts when `Run` observes its context end, and it bounds the in-flight
  claim and the draining registration refresh. `Run` could wait forever on a saturated pool.
- `Queue.SyncSchedules` applies each task type's current contract. A payload the schema rejects
  returns `TaskContractValidationError` and writes nothing.
- `RunChild`, `RunChildren`, and `RunChildrenAll` validate each child payload and stamp the child
  type's current contract on the request.
- A checkpoint operation that panics releases the duplicates waiting on it with an error. A
  duplicate also returns once the handler context ends.
- A `RunOnce` canceled while it waits behind an active invocation no longer releases that
  invocation's heartbeat connection.
- Workers on one pool share one notification listener connection.
- An enqueue whose cached contract rejects the payload reloads the definition once and validates
  again. Later requests of that type in the same enqueue use the definition it read.
- The dashboard shows stored payloads, results, and checkpoints as stored. It used to rewrite any
  timestamp-like string to UTC.
- Under `NewSQLExecutor`, `signalTask` and `completeHumanWait` return the retained JSON as JSON
  rather than base64.
- The transactional enqueue example rolls back when any step fails.

## 0.5.0 — 2026-09-28

The npm packages, Python distribution, Go module, and Rust crate release from one source commit.

Requires **schema v43** and Go **1.25** or newer.

**Breaking: a 0.4.x database upgrades offline, across one contract step.** Migration 0025 adds the
fast tier and SQL protocol version 5. It is a contract step shipped in a minor release, which
[ADR 0077](../docs/decisions/0077-add-a-fast-task-tier-that-records-one-outcome-row-per-task.md) §6
allows once. It narrows the protocol to exactly 5 and drops `fire_due_schedules_v1` and
`sync_schedule_definitions_v1` without a shim, so a 0.4.x process fails its compatibility check
against the new schema. `workhorse schema migrate` stops before a contract step. Upgrade in this
order:

1. Stop every worker and every producer.
2. Run `workhorse schema migrate`. It applies nothing past schema version 24 and reports the pending
   contract step.
3. Run `workhorse schema contract --yes`, which applies migration 0025 and leaves schema version 25.
4. Run `workhorse schema migrate` again. It applies migrations 0026 through 0044 and leaves schema
   version 43.
5. Start the processes from this release.

Every queue starts full-tier, so live tasks stay where they are and no history needs a backfill.

**Breaking: a process from this release refuses a schema below version 43.** The compatibility
floor moves from schema version 18 to 43 and the protocol floor from 1 to 5, because the SDK now
calls functions that migrations up to 0044 add.

**Add a fast task tier.** A fast-tier queue records one `fast_task_outcome` row per task instead of
the attempt and event history, and completes a batch and claims its refill in one statement. It
refuses dependencies, child tasks, concurrency keys, budgets, debounce, throttle, and concurrency or
rate-limit policies with SQLSTATE `P1007`. A queue moves tiers only while it is empty
([ADR 0077](../docs/decisions/0077-add-a-fast-task-tier-that-records-one-outcome-row-per-task.md)).

- Add `Admin.SetQueueTier` and `Admin.SetQueueHistory`, with the `QueueTier` and `QueueHistory`
  types. `SetQueueHistory` opts a fast-tier queue into attempt or claim history.
- Return `FastTierUnsupportedError` for a `P1007` refusal, naming the queue, the feature, and the
  batch ordinal. It matches `ErrFastTierUnsupported` under `errors.Is`.
- Batch fast-tier completions with a fused refill claim. `WorkerOptions.Cohorts` splits the slots
  into fixed shares that each complete and claim together. The default is 1 below a concurrency of 8
  and otherwise one cohort per eight slots, between 2 and 8, capped by the pool's spare connections.
- Keep the worker running when a task's payload is a JSON string. The payload used to be decoded
  twice, and the error ended `Run` and stranded the lease.
- Keep overlapping batched claims in flight, so a worker fills free slots while a claim is still
  running
  ([ADR 0076](../docs/decisions/0076-keep-overlapping-batched-claims-in-flight-to-fill-worker-slots.md)).
- Skip the notification claim delay while claims keep finding work.
- Resend a fenced write and the concurrency policy sync when PostgreSQL chooses them as a deadlock
  victim, up to three attempts. Inside a caller's transaction the original deadlock error is raised.
- Claim policy- and rate-limited tasks as a set, and shard the admission counters so claims on a
  governed queue no longer serialize
  ([ADR 0082](../docs/decisions/0082-shard-the-admission-counters.md)). A plain full-tier claim
  also costs less.
- Release dependents through a pending-prerequisite counter, and settle a parent whose child is
  already terminal when it is created. Migration 0032 repairs parents an earlier release left
  waiting. A full-tier enqueue batch with several invalid members can report a different member's
  error than before.
- Release a fused claim's row locks before they can deadlock
  ([ADR 0081](../docs/decisions/0081-release-a-fused-claim-lock-before-it-can-deadlock.md)).
- Add a Tier column to the embedded dashboard Queues page, and link a schedule's tasks to that
  schedule's queue on the Schedules page.

## 0.4.0 — 2026-09-23

The npm packages, Python distribution, Go module, and Rust crate release from one source commit.

Requires **schema v18** and Go **1.25** or newer.

**A 0.3.x database upgrades in place.** Run `workhorse schema migrate` from a deployment step before
any process from this release starts. It applies migration 0024 and leaves the installation at
schema version 24. The step is additive: it replaces one read function. No table changes, no
database is dropped, and no data is lost. The compatibility floor stays at version 18.

- Measure row retention lag against the history gate the prune applies. `prune_terminal_tasks_v1`
  keeps a terminal task until daily history retention passes its `history_through_at`, but queue
  health counted a row held only by that gate as lag. The measured lag climbed toward a day between
  history passes, so health read Degraded for most of every day. Migration 0024 replaces
  `queue_health_v1` so both eligible boundaries apply the prune's predicate. A history pass that
  stops advancing still shows as task event and attempt history lag.
- Fit the embedded dashboard Workers table on a laptop viewport without horizontal scrolling. Schedules
  become a calendar icon with a hover card, the Paused badge moves to the placement line, queues
  stack one per line, and a long worker name is truncated in the middle with the full name on hover.

## 0.3.0 — 2026-09-21

The npm packages, Python distribution, and Go module release from one source commit.

Requires **schema v18** and Go **1.25** or newer.

**A Go worker behaves differently after this upgrade even when it configures nothing.** Four runtime
defaults move to the values the TypeScript and Python workers publish, and the shutdown path gains
an outcome it did not have
([ADR 0072](../docs/decisions/0072-converge-the-worker-runtime-defaults.md)). Read this list before
upgrading a deployment that relies on the current numbers.

- **Idle claim polling drops from a flat 1000 ms.** A worker whose `LISTEN` subscription is live now
  waits the 5000 ms ceiling between empty claims, and a worker that cannot subscribe starts at
  250 ms and backs off exponentially toward that same ceiling. In the subscribed shape most
  installations run, a worker sends about a fifth of the idle claim traffic it used to.
- **Shutdown grace tightens from 30 s to 25 s.** The old value equalled the default
  `terminationGracePeriodSeconds` of a Kubernetes pod, so it was the value most likely to be cut off
  mid-drain. A caller that needs the old window sets `WorkerOptions.ShutdownGracePeriod`.
- **`Run` returns `ErrShutdownIncomplete` where it previously hung forever.** A handler that ignored
  its context used to block `Run` until the platform sent `SIGKILL`. `Run` now cancels the handlers
  that outlive the grace period, gives them one bounded window to unwind, stops renewing their
  leases, and returns. PostgreSQL recovers those tasks when the leases expire. The abandoned
  goroutines may still use the pool, so a caller that receives this error should end the process
  rather than close the pool and carry on.
- **The slow maintenance routines are offered once a minute, not on every one-second tick.** That
  restores the cadence [ADR 0011](../docs/decisions/0011-daily-retention-and-split-maintenance.md)
  decided: PostgreSQL owns the global due decision, so a worker was sending sixty times the intended
  rate of `run_maintenance` calls. `WorkerOptions.MaintenanceRoutineInterval` gates it.

**A 0.2.x database upgrades in place.** Run `workhorse schema migrate` from a deployment step before
any process from this release starts. It applies migrations 0010 through 0023 and leaves the
installation at schema version 23. Every step is additive: it replaces read and transition functions
or adds one, and 0023 also releases the dependency edges a cancellation abandoned. No table changes,
no database is dropped, and no data is lost.

**A process from this release refuses a schema below version 18.** The compatibility gate's floor is
now derived from the newest function the SDKs call, rather than held at 1 by hand. A lagging
installation is refused at startup instead of failing on its first dashboard read, after the process
has taken work.

**0.1.x support is dropped.** The migration chain now starts at the 0.2.0 baseline, schema version 6
([ADR 0073](../docs/decisions/0073-prune-the-migration-chain-to-the-0-2-0-baseline.md)). Workhorse
0.2.1 is the last release that migrates a database below the baseline: reach the baseline with
0.2.1, then upgrade to this release. The refusal names it.

- Refuse to start a worker whose pool cannot lend a dedicated heartbeat connection. `NewWorker`
  needs a known capacity of at least 3, for the listener, the heartbeat connection, and one
  statement. It names the capacity it found, the capacity it needs, and the opt-out.
  `WorkerOptions.SharedHeartbeats` takes heartbeat rounds back to the shared pool
  ([ADR 0071](../docs/decisions/0071-give-every-worker-a-pool-and-a-dedicated-heartbeat-connection.md)).
- Add `WorkerOptions.RetryDelay`, so a caller can shape one failed attempt's delay without
  persisting a retry policy.
- Name a failure the way the other two SDKs name it. A worker reads a name through `ErrorNamer`,
  falls back to an exported concrete type, and defaults to `Error`; it reads an optional stack
  through `ErrorStacker` and records null when the error supplies none. `errors.As` walks the chain,
  and a recovered panic becomes a `HandlerPanicError` carrying the stack captured at recovery.
  Every `errors.New` value used to file under `*errors.errorString`, so one failure mode split
  across dashboard buckets that mean nothing.
- Release a task whose type the worker has no handler for, instead of failing it.
  `release_owned_v1` returns the claim to its queue with the attempt intact and appends a `released`
  event. During a rolling deployment the old release no longer spends the retry budget of a type
  only the new release runs.
- Report a pass that only released a claim as unprocessed. `RunOnce` used to report it as progress,
  so a caller looping it claimed and released the same task without waiting.
- Keep a worker running through a lease loss and a maintenance phase error, and log by default. A
  slow expiry no longer stalls the heartbeats of the other tasks claimed in the same pass.
- Stop a worker whose claim fails without returning a task, and run the tasks claimed before it.
- Cache the compatibility check and the contract definitions in the producer.
- Never skip a busy schedule occurrence, and read the evaluation instant from the database clock.
- Release a canceled dependent's incoming dependency edges, which used to hold a prerequisite's
  identity against retention.
- Lock only the row a claim takes, and skip the enqueue dependency block for a request that declares
  no prerequisite.
- Require pgx 5.11.0, raised from 5.9.2, and OpenTelemetry Go 1.46.0, raised from 1.45.0.

## 0.2.1 — 2026-09-18

The npm packages, Python distribution, and Go module release from one source commit.

Requires **schema v1** and Go **1.25** or newer.

**A 0.2.0 database upgrades in place.** Run `workhorse schema migrate` from a deployment step before
any process from this release starts. It applies migrations 0007 through 0009 and leaves the
installation at schema version 9. The migrations change read functions and no table. No database is
dropped and no data is lost.

- Prune the dashboard task lists on the task table's indexes. A list filtered by a tag, a queue, or
  a task type seeks that index before it reads the runtime and outcome projections, and an
  unfiltered list no longer joins every task back to itself.
- Stop compiling the queue health snapshot with JIT on every call. Past a few thousand ready tasks,
  compilation cost about two seconds for a statement that executes in tens of milliseconds.
- Release a pinned task page in the dashboard. While a pager click holds the list on an older
  page, auto refresh pauses and says why, and a first-page control returns to the live list with
  every filter kept.
- Require OpenTelemetry Go 1.45.0, raised from 1.43.0.

## 0.2.0 — 2026-09-17

The npm packages, Python distribution, and Go module release from one source commit.

Requires **schema v1** and Go **1.25** or newer.

**A 0.1.5 database upgrades in place.** This is the first release that ships migrations. Run
`workhorse schema migrate` from a deployment step before any process from this release starts. It
applies migrations 0002 through 0006 and leaves the installation at schema version 6. No database is
dropped and no data is lost.

- Add named budgets that span queues. `Queue.SyncBudgets` declares a namespace of budgets,
  `Queue.ListBudgets` reads them, and an enqueue names one through `Budget`. A budget caps the
  unexpired active tasks that name it, refills one shared token bucket, or does both.
- Skip missed schedule occurrences by default. A schedule definition carries a `CatchupPolicy` of
  `ScheduleCatchupSkip`, `ScheduleCatchupLatest`, or `ScheduleCatchupAll`. A schedule that a paused
  deployment left behind no longer enqueues every occurrence it missed. Existing schedules take
  `ScheduleCatchupSkip`.
- Look each contracted task type up once per enqueue batch instead of once per row, trim the
  heartbeat fan-out, the child-set decode, and the hostname lookup, and build worker log attributes
  only when a logger is enabled.
- Leave promotion to the maintenance tick on the claim path, so a claim no longer pays for promotion
  work on every call.
- Bound every dashboard read procedure to the page it returns. `DashboardTaskRow` drops `DeadlineAt`
  and `ExecutionTimeoutMs`, a task detail's `Current` drops its duplicate `Result`, and each
  checkpoint carries `ValueBytes` and `ValueOmitted`.
- Document two tenancy tiers. One database per tenant is the boundary Workhorse enforces; a shared
  database carries the tenant on the concurrency key, a budget, and a tag.

## 0.1.5 — 2026-09-14

The npm packages, Python distribution, and Go module release from one source commit.

Requires **schema v1** and Go **1.25** or newer.

**A 0.1.4 database must be dropped and reinstalled.** This release re-cuts schema v1 to separate
deployment-owned schedule activation from durable operator pauses and to retain maintenance-run
history; no migration exists between 0.1.4 and 0.1.5.

- Preserve operator schedule pauses across deployment synchronization, removal, and re-addition,
  and expose the configured, paused, and effective states through the dashboard bindings.
- Record recent maintenance executions with phase timings, errors, and affected-row counts. The
  shared dashboard shows those runs and supports exact event time ranges.
- Use opaque, versioned task cursor URLs while continuing to accept old JSON cursors, and link task
  menus directly to scoped event history.
- Report the Go module version from the dashboard host instead of baking a version into the shared
  browser bundle.
- Update the OpenTelemetry dependencies to their current supported releases.

## 0.1.4 — 2026-09-11

The npm packages, Python distribution, and Go module release from one source commit.

Requires **schema v1** and Go **1.25** or newer.

**A 0.1.x database must be dropped and reinstalled.** This release renames the unit of work from
"job" to "task" on every surface and re-cuts the schema baseline in place; no migration exists
between 0.1.3 and 0.1.4 ([ADR 0064](../docs/decisions/0064-rename-the-unit-noun-from-job-to-task.md)).

- Rename every `Job*` identifier to its `Task` spelling: `ClaimedJob` is `ClaimedTask`,
  `HandlerContext.Job` is `HandlerContext.Task`, `ChildJobRequest` is `ChildTaskRequest`,
  `PrerequisiteJobIDs` is `PrerequisiteTaskIDs`, and `GetJob`, `ListJobs`, and `GetJobTimeline`
  are `GetTask`, `ListTasks`, and `GetTaskTimeline`. `api/go.txt` lists every removed name.
- Remove the pre-rename aliases `AssertCompatible`, `CreateChild`, `CreateChildren`, and
  `CreateChildrenAll` that `go/deprecated.go` carried.
- Rename the schema, the `workhorse_jobs` notification channel (now `workhorse_tasks`), and the
  substituted error name `RedactedJobError` (now `RedactedTaskError`).
- Rename the OpenTelemetry names from `workhorse.jobs.*` and `workhorse.job.*` to
  `workhorse.tasks.*` and `workhorse.task.*`, with the `{task}` unit.
- Rename the `dashboard/v1` bindings: `JobDetail` becomes `TaskDetail` and every `Job*` field
  becomes `Task*`; `MaintenanceTaskPollMs` becomes `MaintenanceRoutinePollMs` and the cron page
  lists `Maintenance.Routines`.

## 0.1.3 — 2026-09-10

The npm packages, Python distribution, and Go module release from one source commit.

Requires **schema v1** and Go **1.25** or newer.

- Improve task and event tables with readable status labels, compact columns, full hover text,
  and task ID copy controls.
- Add worker and search filters to Events, and show task tags and accepted enqueue modes in details.
- Share task actions between listings and details, with cancellation confirmation and an optional reason.
- Keep task menus responsive on long pages and reset pagination when selecting a task view in the sidebar.
- Remember chart visibility and task drawer width, and clarify rate-limit labels on Queues.

## 0.1.2 — 2026-09-10

Published to the Go module proxy from one source commit shared with the npm packages and the Python
distribution, tagged `go/v0.1.2`. Workhorse stays a public beta on the `0.x` line.

Requires **schema v1** and Go **1.25** or newer.

**Upgrading from `0.1.0` means you recreate the database.** The clean-install baseline was re-cut
so that schema version 1 installs the corrected statistics functions. A `0.1.0` database still
reports version 1 and passes `assertSchemaCompatible`, yet holds the uncorrected ones, and no
migration carries it forward. Recreate the database, or keep running `0.1.0`.

**`0.1.1` was a stopped train and its number is spent.** Its npm stage failed before it wrote
anything: `npm publish --provenance` is rejected from a runner npm reads as `self-hosted`, which is
how it classifies the Depot runners every job used. Nothing reached npm and the Go tag was never
pushed, so `0.1.1` exists only on PyPI, where the distribution is complete and not defective.
`0.1.2` carries the identical content to all three registries and supersedes it. Nothing on npm
needs deprecating, because nothing was published there.

- Add cursor task browsing through `tasksCursor`, with optional exact totals and backward navigation.
- Read system statistics once per response, sharing the live history tail across dashboard panels.
- Coalesce dashboard refreshes and reuse validated full builds across repository smoke checks.
- Anchor every statistics bucket on UTC, so day and hour boundaries no longer follow the
  database's timezone setting.
- Publish npm packages from a GitHub-hosted runner, which is the only environment npm accepts a
  provenance attestation from.

## 0.1.0 — 2026-09-04

Published through the Go module proxy from one source commit shared with the npm packages and the
Python distribution, tagged `go/v0.1.0`. This is the first version without a prerelease suffix
([ADR 0050](../docs/decisions/0050-release-0-1-0-without-a-prerelease-suffix.md)). The module stays
a public beta on the `0.x` line.

Requires **schema v1** and Go **1.25** or newer.

### Removed

- `AdminJobProgress` is gone. It was field-identical to `JobProgress`, which the worker's
  `HandlerContext` already returns, so `Admin.GetProgress` and `JobSnapshot.Progress` now return
  `*JobProgress`. A caller that named the type replaces the name; the fields are unchanged.
- `dashboard.HandlerOptions.SkipCompatibilityCheck` is gone. It existed for this repository's
  transport tests, whose executor cannot reach PostgreSQL, and those tests now use an unexported
  constructor. Every `dashboard.NewHandler` caller runs the schema compatibility check.
- `dashboard.DashboardJSON`, which this release had already renamed from `dashboard.JSON`, is gone
  entirely. `type DashboardJSON any` named nothing that `any` does not, so the generated bindings
  now spell an arbitrary JSON value `any` in `DashboardCompleteHumanWaitResult.Result`,
  `DashboardSignalTaskResult.Payload`, `SignalTaskInput.Payload`, and
  `CompleteHumanWaitInput.Result`. The field types are identical; only the spelling changed.
  Python keeps its `DashboardJSON`, which is a recursive union Go does not need.
- `dashboard.NormalizePath` is unexported. It had one caller, inside the package.

### Changed

- **`CheckCompatibility` takes the protocol versions the schema declares it serves.** Its signature
  is now `func(*int, int, []int) error`. The check refused any schema newer than the version this
  build was compiled against, which would have turned the first in-place migration into an outage
  for the length of a rolling deployment. A build cannot know which later release stops serving it,
  so the ceiling comes from the database: `workhorse.protocol_version` records the SQL protocol
  versions the installed schema still serves, and a client whose protocol is absent from that list
  refuses with `SchemaTooNew` below the oldest served version and `SchemaTooOld` above the newest.
  An empty declaration enforces nothing. `AssertSchemaCompatible` reads both facts in one statement,
  so its per-call check stays one round trip.
- **Shared names for three parts of the public API.** Go was the odd language out on each one, so
  each moved to the spelling TypeScript and Python already share. `AssertCompatible` is now
  `AssertSchemaCompatible`. `HandlerContext.CreateChild`, `CreateChildren`, and `CreateChildrenAll`
  are now `RunChild`, `RunChildren`, and `RunChildrenAll`. The three `EnqueueNonReplaceableReason`
  constants now carry the enum prefix every other constant group in the package carries:
  `IncompatibleKeyMode`, `NotPending`, and `WindowElapsedPending` are now
  `NonReplaceableIncompatibleKeyMode`, `NonReplaceableNotPending`, and
  `NonReplaceableWindowElapsed`. Every old name stays in the module as a deprecated alias with the
  same behaviour and the same value, so no caller changes on this release. The aliases are removed
  in `1.0.0`.
- **`dashboard` package type names.** Every type generated from a shared `dashboard/v1` wire type
  now carries the `Dashboard` prefix, so the package no longer declares a second `CancelStatus`,
  `SignalDeliveryStatus`, and `HumanWaitCompletionStatus` beside the ones the root package already
  exports. `CancelStatus`, `SendSignalStatus`, `CompleteHumanWaitStatus`, `JSON`,
  `QueueHealthReason`, `QueueHealthReasonCode`, `RetentionPolicyImpact`, and
  `MaintenanceLoopCadences` become `DashboardCancelStatus`, `DashboardSignalDeliveryStatus`,
  `DashboardHumanWaitCompletionStatus`, `DashboardJSON`, `DashboardQueueHealthReason`,
  `DashboardQueueHealthReasonCode`, `DashboardRetentionPolicyImpact`, and
  `DashboardMaintenanceLoopCadences`. The file is generated, so it carries no aliases: a caller
  that names one of the eight updates the name. No request or response payload changes.
- The three entries above and the removals are the exported API changes since `0.1.0-beta.1`. The
  README states the unpinned install command and the schema install step, which the TypeScript CLI
  owns.
- The dashboard backend's run-now action calls the audited `workhorse.run_task_now_v1` instead of
  `workhorse.dashboard_run_task_now_v1`, which is removed from the schema. The action now records
  the authenticated actor, the reason, and the request identity in its `promoted` event, matching
  the TypeScript dashboard server.
- **Dashboard timestamps.** Every timestamp a dashboard mutation returns is now UTC with exactly
  three fractional digits, matching the TypeScript and Python backends. It was `time.RFC3339Nano`,
  which dropped a trailing zero and passed through PostgreSQL's microseconds, so this module
  answered `2026-09-02T14:30:00Z` and `...:00.123456Z` where the other two answer
  `2026-09-02T14:30:00.000Z` and `...:00.123Z`. A client that compares or displays the string sees
  a different value; one that parses it does not.

### Added

- The `dashboard` package serves `redriveTask` and `redriveDeadLetters`, which the shared
  `dashboard/v1` contract added this release. Both reach `Admin.Redrive` and `Admin.RedriveMany`: a
  source the queue does not hold answers 404, and a bulk page reports every result plus the
  continuation cursor the next page resumes from. The host lists both as mutations, so a
  cross-origin or read-only request is refused before dispatch.

### Upgrade notes

- **`CheckCompatibility` callers.** The function takes a third argument, the protocol versions the
  installed schema declares it serves. `AssertSchemaCompatible` reads them for you; a caller that
  invokes `CheckCompatibility` directly passes the list it read, or `nil` to enforce no ceiling,
  which is what an empty declaration means.
- **Schema version.** `0.1.0` stays at schema version 1, but its baseline is not the one the last
  beta installed: `workhorse.valid_tags` was renamed `workhorse.valid_tags_v1` and
  `workhorse.dashboard_run_task_now_v1` was removed. A database installed by any beta reports
  version 1 and passes the compatibility check, yet holds the old function names. You must recreate the database and
  install the new baseline with
  `npx --package @stablemates/workhorse@0.1.0 workhorse schema install`.
  This is the last release that asks for a recreation: from `0.1.0` the schema is frozen as the
  migration baseline, and later releases upgrade a database in place.

## 0.1.0-beta.1 — 2026-09-01

Published through the Go module proxy from commit `dbd5437362930f712157ffcc72c3296e971e4f5a`,
tagged `go/v0.1.0-beta.1`.

### Changed

- The module uses the Apache License, Version 2.0 from the repository root.
  Contributions require the repository `CLA.md`.

### Added

- **The Go worker records what it is.** The schema baseline carries `client_protocol_version`,
  `sdk_language`, and `sdk_version` to `workhorse.worker_registry`, and every registration refresh
  reports `go` with the new exported `workhorse.Version` and the SQL protocol version it speaks.
  The dashboard shows them per worker, and `workhorse schema status --json` counts the live workers
  by protocol so an operator can see whether a protocol is still in use before retiring it. The
  columns are nullable and the older call is retained, so a worker running an earlier release keeps
  registering during a rolling deploy.
- `workhorse.Version` names this module's published version, which the module could not report
  before because it carries no manifest of its own.
- Queue, worker, and administrative APIs implement the Workhorse SQL protocol through pgx,
  `database/sql`, caller-owned transactions, and connection pools.
- The worker supports durable batches, timers, signals, human decisions, child jobs, progress,
  checkpoints, graceful drain, and recovery after a process crash.
- Individual handler panics become recorded attempt failures without stopping the worker. Compiled
  process and external-module coverage verifies graceful signal drain, crash recovery, and the
  public worker API under the race detector.
