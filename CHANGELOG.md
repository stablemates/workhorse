# Changelog

This changelog covers 10 published packages on npm. They are versioned in lockstep and released
from one tag:
`@stablemates/workhorse`, `@stablemates/workhorse-drizzle`, `@stablemates/workhorse-prisma`, `@stablemates/workhorse-typeorm`,
`@stablemates/workhorse-kysely`, `@stablemates/workhorse-knex`, `@stablemates/workhorse-otel`, `@stablemates/workhorse-dashboard`,
`@stablemates/workhorse-dashboard-server`, and `@stablemates/workhorse-dashboard-contract`. The Python distribution, Go module, Rust crate, and Ruby
gem release from that same commit, so their notes live in [`python/CHANGELOG.md`](python/CHANGELOG.md),
[`go/CHANGELOG.md`](go/CHANGELOG.md), [`rust/CHANGELOG.md`](rust/CHANGELOG.md), and
[`ruby/CHANGELOG.md`](ruby/CHANGELOG.md). Each entry states its required schema version and upgrade steps.

The supported Node.js and PostgreSQL versions, the schema compatibility guarantees, and the release
process are in [`docs/compatibility.md`](docs/compatibility.md).

Workhorse is a public beta. While the line is `0.x`, any minor release may change behaviour. From
`0.1.0` the schema upgrades in place: every release ships ordered, immutable migrations, and inside
a major line a migration only adds. Migration 0025 is the one exception: a database from before
0.5.0 crosses it offline, with the [0.5.0 upgrade steps](#050--2026-09-28). The upgrade from 0.5 to
0.6 only adds. Breaking changes are always listed with upgrade steps.

## Unreleased

The optional `@stablemates/workhorse-knex` adapter preserves native PostgreSQL statements and parameters on the pinned Knex route.
The tested Objection recipe shares the model-write transaction with enqueue. Callers retain transaction and resource ownership (SM-1118).

Requires **schema v54**. Migrate the schema before starting updated processes.
The final schema version is **54**, and the SDK compatibility floor is schema version **54**.
Migration 0054 adds versioned child functions and a nullable fence marker; older clients keep their v1 functions.

A renamed individual child on replay now raises a conflict with the stored and requested names.
A second child after joining the retained child in the same handler run still exceeds the child limit (SM-1106).

Migration 0055 (`0055-fail-durable-replay-conflicts-without-retrying.sql`) adds the terminal failure override.

Durable checkpoint, timer, child, child-set, and human-decision replay conflicts now fail the task
on their first occurrence, preserving its current attempt and recording the conflict class.
Redaction still hides error details. Transient failures, lease loss, child-limit errors, and
already-waiting signal errors retain their existing behavior. Conflict settlement bypasses the
worker's retry-delay callback.

**Pending release — fixed:** TypeScript `runChild`, `runChildren`, and `runChildrenAll` join existing
children after their task type's contract advances. Replay retries a contract conflict with the
stored versions and rebuilds under those versions when the current contract rejects the payload.
Changed payloads and child sets still raise `ChildConflictError`. This contract replay fix requires no additional migration.

## 0.6.1 — 2026-10-02

The npm packages, Python distribution, Go module, Rust crate, and Ruby gem release from one source commit.

Requires **schema v43**, Node.js **22** or newer, and PostgreSQL **15** or newer.

**0.6.1 exists to publish the Python distribution with provenance.** The 0.6.0 Python distributions
on PyPI have no PEP 740 attestations, and the 0.6.1 distributions have them. The
[Python changelog](python/CHANGELOG.md) describes the release workflow fix. No package changes its
code. The npm packages have no changes, and every package releases at 0.6.1 to keep one version
across the registries ([ADR 0050](docs/decisions/0050-release-0-1-0-without-a-prerelease-suffix.md)).

**A 0.6.0 database needs no migration.** 0.6.1 adds no migration, so the final schema version is
**52** and the SDK compatibility floor stays at schema version **43**. An installation on 0.5
follows the [0.6.0 upgrade steps](#060--2026-10-02).

## 0.6.0 — 2026-10-02

The npm packages, Python distribution, Go module, Rust crate, and Ruby gem release from one source commit.

Requires **schema v43**, Node.js **22** or newer, and PostgreSQL **15** or newer.

**Upgrade: migrate the schema before any 0.6 process starts.** Migrations 0045 through 0053 only
add, so the upgrade is a rolling deployment. Run `workhorse schema migrate`, then roll out the new
processes. The final schema version is **52**. The SDK compatibility floor stays at schema version
**43**, so a 0.5.0 process keeps working on version 52. Each migration commits on its own, so
each SQL fix below takes effect when its migration commits. Version 52 includes them all.

**An installation that runs cold export stops its exporters across migration 0052.** That migration
repairs the export ledger so each segment covers one UTC day. It cannot stop an upload already in
flight, and such an upload would overwrite a corrected day's object. Upgrade in this order:

1. Stop every cold exporter, and let each finish its object and manifest uploads.
2. Keep cold export enabled, so retention keeps waiting for the export.
3. Run `workhorse schema migrate`.
4. Restart the exporters after the migration commits.

An installation that never enabled cold export needs no extra step. The
[cold export guide](docs/guides/335-cold-export.md#a-day-is-a-utc-day) explains the repair and the
warnings it raises.

**A handler result PostgreSQL cannot store now fails only its task.** jsonb refuses a NUL character
and an unpaired surrogate. Such a result used to reach the completion statement, whose refusal
stopped the worker and left the task leased. The worker now fails the attempt under the task's
retry policy with a `TypeError` and the message `<task type> result contains a NUL character or an
unpaired surrogate, which PostgreSQL jsonb cannot store`. On the fast tier the other members of a
completion batch still complete. A database error during completion still stops the worker.

**Breaking: contract schemas can no longer use `pattern` or `patternProperties`.** The SDKs' regular
expression engines accept different syntax and match differently, so one contract could validate
differently in each language.
[ADR 0039](docs/decisions/0039-use-a-restricted-json-schema-contract-profile.md) now leaves both
keywords out of the contract profile. Every SDK rejects such a schema with
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
[ADR 0039](docs/decisions/0039-use-a-restricted-json-schema-contract-profile.md) now names two reference forms: `#`, the root schema, and `#/$defs/<name>`, where
`<name>` is a key of the root `$defs`. Every SDK rejects the schema for any other reference, with
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

**The demo deployment contract names schema version 52 as the final version.**
`typescript/demo/DEPLOYMENT.md` said the build ships version 51 and that migration finishes there.
Migration 0053 had already made the final version 52. The contract now says 52, and a test compares
it with the generated schema version. The cold-export outage stays at the step to version 51, which
migration 0052 takes.

SQL fixes, each in its own additive migration:

- Migrations 0045 and 0046: schedule-run retention health follows the daily history pass, and a pass
  that has not run yet is dated from the oldest expired run.
- Migration 0047: a NULL limit, lease, or bucket count is rejected before any lock. A NULL limit
  passed straight to `claim_many_v1` used to lease every claimable task.
- Migration 0048: `claim_many_v1`, `claim_one_v1`, `claim_policy_batch_v1`, and
  `complete_many_and_claim_v1` raise SQLSTATE `0A000` under repeatable read or serializable
  isolation. Under repeatable read, two claims could start more tasks than a budget's `maxActive`
  allows.
- Migration 0049: `prune_terminal_tasks_v1` no longer stalls on redrive sources that younger
  redrive targets pin. A bulk redrive used to stop terminal pruning for good.
- Migration 0050: `sync_budgets_v1` takes each `workhorse:budget:<name>` lock in name order. A
  concurrent claim could fail with SQLSTATE `23514` or leave a start uncharged.
- Migration 0051: `fast_complete_many_v1`, `fast_heartbeat_many_v1`, `heartbeat_v1`, and
  `heartbeat_many_v1` read the clock after taking the row lock. A fast completion could accept, and
  a heartbeat could renew, a lease that expired while the function waited for the lock.
- Migration 0052: the cold-export segment claim and `stat_buckets_v1` step a fixed UTC day whatever
  the session `TimeZone` is. The migration adds `cold_export_dataset_utc_midnight_check` and
  `cold_export_segment_utc_day_check` and repairs the ledger, as the upgrade steps above describe.
- Migration 0053: `sync_schedule_definitions_v2` takes the
  `workhorse:schedule-namespace:<namespace>` lock, so it no longer deadlocks with
  `fire_due_schedules_v2`.

`@stablemates/workhorse`:

- `Worker` rejects a non-finite, fractional, or out-of-range timing option at construction. This
  covers `leaseMs`, `heartbeatMs`, `pollMs`, `maintenanceIntervalMs`, `maintenanceRoutinePollMs`,
  `registryIntervalMs`, `scheduleCatchupLimit`, and a fixed `retryDelayMs`. `heartbeatMs` must be at
  least 1 and below `leaseMs`. `registryIntervalMs: 0`, `pollMs: 0`, and `retryDelayMs: 0` stay
  valid.
- Contract schemas compile with Ajv's `strict: false` and `strictNumbers: true`. A profile schema
  that another SDK accepts, such as a union `type`, now loads in TypeScript too.
- An enqueue whose cached contract rejects the payload reloads the definition once and validates
  again. An operator's new `currentVersion` or larger payload limit no longer fails locally.
- External wait names, the `requestedBy` actor, and the admin audit actor and reason are counted in
  code points, as PostgreSQL counts them.
- A durable handler call on a fast-tier task that a fallback full-tier claim returned resolves the
  queue tier, then rejects with `FastTierUnsupportedError`. It touches no durable state and runs no
  callback.
- The package exports `connectionPoolOf` and the `ConnectionPool` type, so the dashboard server
  resolves a database's pool the way a worker does.
- The documentation states that metrics need `registerOpenTelemetry()`.

`@stablemates/workhorse-drizzle`:

- The adapter binds only the parameters PostgreSQL would bind. It used to treat a `$N` inside a
  string literal, quoted identifier, comment, or function body as a parameter, which broke
  `installSchema` and `migrateSchema` through the adapter.

`@stablemates/workhorse-dashboard-server` and `@stablemates/workhorse-dashboard`:

- The host answers every non-POST request under `{basePath}/rpc` with 405 and `Allow: POST`.
- Every read is bounded, including reads through an ORM adapter and the retention preview. The
  Drizzle and TypeORM adapters always attach a pool. The Prisma and Kysely adapters attach one only
  when given their pool option. A database with no pool is still read unbounded.
- Under `redactErrorStacks`, the host also withholds worker stacks from the error copy in lifecycle
  event details.
- System health lists every check with its own state. Rate limits show as Throttling, and
  concurrency and shared budgets show as Limiting.
- Every count groups its digits.
- The dashboard uses Mantine 9.6.3.

Demo:

- An operator mutation holds its slot until its work settles, and the host bounds how long a request
  is handled.
- Operator redrives stay within the pending-work budget across both tiers.

## 0.5.0 — 2026-09-28

The npm packages, Python distribution, Go module, and Rust crate release from one source commit.

Requires **schema v43**, Node.js **22** or newer, and PostgreSQL **15** or newer.

**Breaking: a 0.4.x database upgrades offline, across one contract step.** Migration 0025 adds the
fast tier and SQL protocol version 5. It is a contract step shipped in a minor release, which
[ADR 0077](docs/decisions/0077-add-a-fast-task-tier-that-records-one-outcome-row-per-task.md) §6
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
floor moves from schema version 18 to 43 and the protocol floor from 1 to 5, because the SDKs now
call functions that migrations up to 0044 add.

**Add a fast task tier.** A fast-tier queue records one `fast_task_outcome` row per task instead of
the attempt and event history, and keeps its live state in `fast_task_runtime`. Tasks take
`uuidv7` identities, and `complete_many_and_claim_v1` completes a batch and claims the refill in
one statement. A fast-tier queue refuses dependencies, child tasks, concurrency keys, budgets,
debounce, throttle, and concurrency or rate-limit policies with SQLSTATE `P1007`. The client raises
that as `FastTierUnsupportedError`, naming the queue, the feature, and the batch ordinal. A queue
moves tiers only while it is empty
([ADR 0077](docs/decisions/0077-add-a-fast-task-tier-that-records-one-outcome-row-per-task.md)).

- Add `Admin.setQueueTier(queue, tier, audit)` and `Admin.setQueueHistory(queue, settings)`, with the
  `QueueTier` and `QueueHistorySettings` types. `setQueueHistory` opts a fast-tier queue into
  attempt or claim history. The CLI adds the guarded `workhorse admin set-tier` and
  `workhorse admin set-history`, and `workhorse admin queues` reports each queue's tier and history.
- Batch fast-tier completions with a fused refill claim. The worker's `cohorts` option splits its
  slots into fixed shares that each complete and claim together. The default is 1 below a
  concurrency of 8 and otherwise one cohort per eight slots, between 2 and 8, capped by the pool's
  spare connections. `Queue` adds `completeAndClaim` and `claimFast`, with the `CompletionClaim` and
  `CompletionClaimResult` types.
- Fail only the oversized row when a fast-tier batch carries a result past the size limit, instead
  of the whole batch. The client measures a result the way PostgreSQL does.
- Add `fast_task_outcome` to `ColdExportDataset`.
- Keep overlapping batched claims in flight, so a worker fills free slots while a claim is still
  running
  ([ADR 0076](docs/decisions/0076-keep-overlapping-batched-claims-in-flight-to-fill-worker-slots.md)).
- Claim policy- and rate-limited tasks as a set, and send a capacity notification only when a
  release frees a full cap. The notification is serialized with claims, so a worker cannot miss it.
- Shard the admission counters, so claims on a governed queue no longer serialize on one counter
  row ([ADR 0082](docs/decisions/0082-shard-the-admission-counters.md)). A plain full-tier claim
  also costs less.
- Skip the notification claim delay while claims keep finding work.
- Start a long-running worker's first claim beside its startup maintenance pass
  ([ADR 0078](docs/decisions/0078-start-a-long-running-workers-first-claim-beside-its-startup-maintenance-pass.md)).
- Release dependents through a pending-prerequisite counter, planned once per session and applied
  per statement. A dependent enqueue holds its prerequisites against completion, and an enqueue
  batch locks its prerequisites before its first request.
- Enqueue full-tier batches set-based. A batch with several invalid members can report a different
  member's error than before.
- Settle a parent whose child is already terminal when it is created. Migration 0032 repairs parents
  an earlier release left waiting.
- Detect and repair dependency counter drift. `Admin.listDependencyDrift(limit?)` lists it,
  `Admin.repairDependencyDrift(audit, limit?)` repairs it, and `MAX_DEPENDENCY_DRIFT_LIMIT` bounds
  both. `workhorse admin repair-dependencies` runs the same repair, with `--dry-run` to list it; a
  repair needs `--reason`, `--env`, and confirmation. Each repaired dependent records a
  `dependency_counter_repaired` event, which the dashboard's event filter offers.
- Lock fast-tier rows in task ID order, and release a fused claim's row locks before they can
  deadlock
  ([ADR 0081](docs/decisions/0081-release-a-fused-claim-lock-before-it-can-deadlock.md)).
- Resend a fenced write and the concurrency policy sync when PostgreSQL chooses them as a deadlock
  victim, up to three attempts. Inside a caller's transaction the original deadlock error is raised.
- Keep the worker running when its heartbeat connection's backend is terminated.
- Add a Tier column to the dashboard Queues page. `dashboard_queues_v1` returns `tier`,
  `recordAttempts`, and `recordClaims`.
- Keep JIT compilation out of the dashboard task detail read, and link a schedule's tasks to that
  schedule's queue on the Schedules page.
- Add the `workhorse.complete.batch_size` and `workhorse.queue.tier` metrics and the
  `workhorse.queue.tier_set` log event.
- Move every optional package's peer range on `@stablemates/workhorse` to `>=0.5.0 <0.6.0`.

## 0.4.0 — 2026-09-23

The npm packages, Python distribution, Go module, and Rust crate release from one source commit.

Requires **schema v18**, Node.js **22** or newer, and PostgreSQL **15** or newer.

**A 0.3.x database upgrades in place.** Run `workhorse schema migrate` from a deployment step before
any process from this release starts. It applies migration 0024 and leaves the installation at
schema version 24. The step is additive: it replaces one read function. No table changes, no
database is dropped, and no data is lost. The compatibility floor stays at version 18.

**The Rust crate joins the release train.** `workhorse` publishes to crates.io from the same `v*`
tag as the npm packages, and its notes live in [`rust/CHANGELOG.md`](rust/CHANGELOG.md).

- Measure row retention lag against the history gate the prune applies. `prune_terminal_tasks_v1`
  keeps a terminal task until daily history retention passes its `history_through_at`, but queue
  health counted a row held only by that gate as lag. The measured lag climbed toward a day between
  history passes, so health read Degraded for most of every day. Migration 0024 replaces
  `queue_health_v1` so both eligible boundaries apply the prune's predicate. A history pass that
  stops advancing still shows as task event and attempt history lag.
- Fit the dashboard Workers table on a laptop viewport without horizontal scrolling. Schedules
  become a calendar icon with a hover card, the Paused badge moves to the placement line, queues
  stack one per line, and a long worker name is truncated in the middle with the full name on hover.
- Bound the dashboard login body. A non-numeric or unsafe `Content-Length` returns 413, and a
  streamed body past `MAX_LOGIN_BODY_BYTES` returns 413 without being buffered.
- Enforce dashboard mutation authorization in the RPC middleware, so a read-only dashboard refuses a
  mutation with `FORBIDDEN` before any handler runs.
- Substitute the dashboard's runtime configuration and module URLs literally, so a `$` pattern in a
  value is no longer expanded.
- Document the dashboard's security boundaries in
  [`docs/dashboard-security-review.md`](docs/dashboard-security-review.md).
- Move every optional package's peer range on `@stablemates/workhorse` to `>=0.4.0 <0.5.0`.

## 0.3.0 — 2026-09-21

The npm packages, Python distribution, and Go module release from one source commit.

Requires **schema v18**, Node.js **22** or newer, and PostgreSQL **15** or newer.

**A 0.2.x database upgrades in place.** Run `workhorse schema migrate` from a deployment step before
any process from this release starts. It applies migrations 0010 through 0023 and leaves the
installation at schema version 23. Every step is additive: it replaces read and transition functions
or adds one, and 0023 also releases the dependency edges a cancellation abandoned. No table changes,
no database is dropped, and no data is lost.

**A process from this release refuses a schema below version 18.** The compatibility gate's floor is
now derived from the newest function the SDKs call, rather than held at 1 by hand. A lagging
installation is refused at startup instead of failing on its first dashboard read, after the process
has taken work. Migrating before any new process starts is what the deployment contract already
asks for, so a pipeline that follows it sees no change.

**0.1.x support is dropped.** The migration chain now starts at the 0.2.0 baseline, schema version 6
([ADR 0073](docs/decisions/0073-prune-the-migration-chain-to-the-0-2-0-baseline.md)). Workhorse
0.2.1 is the last release that migrates a database below the baseline: reach the baseline with
0.2.1, then upgrade to this release. The refusal names it. The 0.1.x line had no production
installation, which is what made the chain prunable.

- Give every worker a connection pool, and reserve one heartbeat connection from that pool. A worker
  whose pool cannot lend one refuses to start, naming the capacity it found, the capacity it needs,
  and the opt-out. `sharedHeartbeats` takes heartbeat rounds back to the shared pool, which is how a
  single connection or a small pool runs
  ([ADR 0071](docs/decisions/0071-give-every-worker-a-pool-and-a-dedicated-heartbeat-connection.md)).
- Remove `notificationPool` from the Prisma, TypeORM, and Kysely adapters. TypeORM finds its pool
  through `dataSource.driver.master`, and Prisma and Kysely take one through the adapter option
  `pool`. Drizzle keeps finding its pool through `$client`.
- Release a task whose type a worker has no handler for, instead of failing it. `release_owned_v1`
  returns the claim to its queue with the attempt intact, appends a `released` event the dashboard
  timeline labels, and charges the held lease to the execution-timeout budget. During a rolling
  deployment the old release no longer spends the retry budget of a type only the new release runs.
- Keep every task running through a heartbeat round that fails, and retry on the next beat. Each
  attempt keeps its own lease watchdog: once one lease passes with no accepted renewal, the attempt
  submits `lease_expired`, aborts its handler, and records `lease_lost` without failing the attempt.
- Warn once when a worker starts without a listener. Polling is the correctness mechanism, so a
  missing listener costs latency rather than correctness, but it is no longer silent.
- Release a canceled dependent's incoming dependency edges. A dependent canceled while it was still
  blocked used to hold its prerequisite's identity against retention, which queue health reported as
  `retentionPruneStarved`.
- Never skip a busy schedule occurrence. The firing pass takes each occurrence's advisory lock
  itself and ends evaluation for that definition when another transaction holds it, so a manual fire
  that rolled back no longer strands an occurrence. The pass also reads its evaluation instant from
  the database clock rather than the caller's.
- Keep expiration timers armed past 24.8 days.
- Refuse a debounce replacement once a task has started.
- Hold a per-budget lock during budget admission, so two claims cannot admit past one budget.
- Compare promotion and recovery scans against one stable time.
- Name `pg_temp` in every history-day staging reference. A caller's `search_path` can no longer
  redirect maintenance to a table of the same name in a writable schema.
- Lock only the row a claim takes. A claim on a queue whose keys are all saturated wrote a row lock
  for each of the 100 rows it sampled; it now writes none, and an admitting claim writes one.
- Skip the enqueue dependency block for a request that declares no prerequisite. Measured on 200
  dependency-free tasks in one call, the median fell from 70.599 ms to 44.287 ms.
- Give the three SDKs one failure envelope. An unredacted failure carries exactly name, message, and
  stack, and a redacted one carries the two fields `redact_error_details_v1` writes. A thrown
  non-Error now records a null stack rather than omitting the field.
- Render the dashboard only when a poll changed something. An unchanged poll writes no state, a
  changed one commits once rather than twice, each row compares the fields it draws, and the task
  drawer is fetched the first time an operator opens one.
- Bound every dashboard task read, serve the queue health snapshot from cache, bin activity once per
  poll, and compress RPC answers. A withheld task value is shown by size until an operator asks for
  it.
- Tell sunsetting workers from replacements on the Workers page. A Started column carries an exact
  timestamp on hover, and a draining or offline worker renders an inert Claims cell that says why
  instead of a switch that controls nothing.
- Refuse a dashboard request whose `Host` is not the dashboard's own address. Bound RPC bodies, hide
  stacks off loopback, and return to the mount after login.
- Order generated spec properties by declaration site. An unrelated declaration elsewhere in the
  repository can no longer reorder the `dashboard/v1` schemas or the Go and Python bindings.
- Document that a signal or human wait which omits its timeout expires after seven days, and that
  the expiry is terminal.
- Move the dashboard to Mantine 9 and pin zod 4.6.5. `taskFailures.rangeStart` and `rangeEnd` now
  require seconds in their ISO datetime, which RFC 3339 requires and which every first-party caller
  already sends.
- Move every optional package's peer range on `@stablemates/workhorse` to `>=0.3.0 <0.4.0`.

## 0.2.1 — 2026-09-18

The npm packages, Python distribution, and Go module release from one source commit.

Requires **schema v1**, Node.js **22** or newer, and PostgreSQL **15** or newer.

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

## 0.2.0 — 2026-09-17

The npm packages, Python distribution, and Go module release from one source commit.

Requires **schema v1**, Node.js **22** or newer, and PostgreSQL **15** or newer.

**A 0.1.5 database upgrades in place.** This is the first release that ships migrations. Run
`workhorse schema migrate` from a deployment step before any process from this release starts. It
applies migrations 0002 through 0006 and leaves the installation at schema version 6. No database is
dropped and no data is lost.

- Add named budgets that span queues. `Queue.syncBudgets()` declares a namespace of budgets,
  `Queue.listBudgets()` reads them, and an enqueue names one through `budget`. A budget caps the
  unexpired active tasks that name it, refills one shared token bucket, or does both
  ([ADR 0067](docs/decisions/0067-add-named-budgets-that-span-queues.md)).
- Skip missed schedule occurrences by default. Each schedule carries a `catchupPolicy` of `skip`,
  `latest`, or `all` and a durable evaluation position. A schedule that a paused deployment left
  behind no longer enqueues every occurrence it missed. Existing schedules take `skip`
  ([ADR 0066](docs/decisions/0066-skip-missed-schedule-occurrences-by-default.md)).
- Ship the cold history export ledger behind the rollup watermark. `Queue.setColdExportPolicy()` and
  `Queue.getColdExportStatus()` drive it, and retention holds a day until an exporter reports it
  copied. Export is off on a clean install and no exporter ships with this release
  ([ADR 0068](docs/decisions/0068-export-cold-history-behind-the-rollup-watermark.md)).
- Derive the history partition horizon from the preparation cadence, so a slower maintenance
  schedule still prepares each partition before a writer needs it.
- Bound every dashboard read procedure to the page it returns. `DashboardQueueHealthReader` resolves
  a `DashboardQueueHealthDocument` where it resolved `unknown`.
- Split the dashboard browser bundle into page chunks and serve its assets compressed and cached.
- Document two tenancy tiers. One database per tenant is the boundary Workhorse enforces; a shared
  database carries the tenant on the concurrency key, a budget, and a tag
  ([ADR 0069](docs/decisions/0069-isolate-tenants-by-database-and-carry-tenant-identity-as-task-metadata.md)).
- Move every optional package's peer range on `@stablemates/workhorse` to `>=0.2.0 <0.3.0`.

## 0.1.5 — 2026-09-14

The npm packages, Python distribution, and Go module release from one source commit.

Requires **schema v1**, Node.js **22** or newer, and PostgreSQL **15** or newer.

**A 0.1.4 database must be dropped and reinstalled.** This release re-cuts schema v1 to separate
deployment-owned schedule activation from durable operator pauses and to retain maintenance-run
history; no migration exists between 0.1.4 and 0.1.5.

- Preserve operator schedule pauses across deployment synchronization, removal, and re-addition.
  The dashboard distinguishes deployment configuration from the effective state and requires
  confirmation before Resume can enqueue bounded catch-up occurrences.
- Record recent maintenance executions with phase timings, errors, and affected-row counts. The
  Schedules page shows those runs and supports exact event time ranges.
- Use opaque, versioned task cursor URLs while continuing to accept old JSON cursors, link task
  menus directly to scoped event history, and keep event pagination beside its table.
- Report the version of the TypeScript, Python, or Go SDK serving the dashboard instead of baking a
  version into the shared browser bundle.
- Publish deployment guidance for Kubernetes, schema-first rollouts, worker draining, connection
  budgets, and host administration.

## 0.1.4 — 2026-09-11

The npm packages, Python distribution, and Go module release from one source commit.

Requires **schema v1**, Node.js **22** or newer, and PostgreSQL **15** or newer.

**A 0.1.x database must be dropped and reinstalled.** This release renames the unit of work from
"job" to "task" on every surface and re-cuts the schema baseline in place; no migration exists
between 0.1.3 and 0.1.4 ([ADR 0064](docs/decisions/0064-rename-the-unit-noun-from-job-to-task.md)).

- Rename every `Job*` type, `jobId` field, `HandlerContext.job`, and `Admin.getJob`, `listJobs`,
  and `getJobTimeline` to their `Task` spellings; `ChildJobRequest` becomes `ChildTaskRequest`.
- Rename the schema: `workhorse.job` and its companion tables, every `job_id` column and
  `p_job_id` parameter, `list_jobs_v1`, `dashboard_job_detail_v1`, and the `workhorse_jobs`
  notification channel, which is now `workhorse_tasks`. `RedactedJobError` becomes
  `RedactedTaskError`.
- Rename the OpenTelemetry names: `workhorse.jobs.*` instruments become `workhorse.tasks.*`,
  `workhorse.job.*` span events and attributes become `workhorse.task.*`, and the `{job}` unit
  becomes `{task}`. Saved dashboards and alerts on the old names stop matching.
- Rename the `workhorse` CLI subcommands `admin jobs` and `admin job` to `admin tasks` and
  `admin task`; positionals are `<task-id>` and the TUI view is `tasks`.
- Rename the `dashboard/v1` procedure `jobDetail` to `taskDetail` and every `job*` request and
  response field to its `task*` spelling; the contract is rewritten in place rather than
  versioned.
- Rename scheduled maintenance from "task" to "routine": `maintenanceTaskPollMs` becomes
  `maintenanceRoutinePollMs`, `maintenance_state.task_name` becomes `routine_name`, and the cron
  page lists `maintenance.routines`.
- Rename the documentation slugs `/docs/job-dependencies` and `/docs/child-jobs` to
  `/docs/task-dependencies` and `/docs/child-tasks`; the old URLs redirect.

## 0.1.3 — 2026-09-10

The npm packages, Python distribution, and Go module release from one source commit.

Requires **schema v1**, Node.js **22** or newer, and PostgreSQL **15** or newer.

- Improve task and event tables with readable status labels, compact columns, full hover text,
  and task ID copy controls.
- Add worker and search filters to Events, and show task tags and accepted enqueue modes in details.
- Share task actions between listings and details, with cancellation confirmation and an optional reason.
- Keep task menus responsive on long pages and reset pagination when selecting a task view in the sidebar.
- Remember chart visibility and task drawer width, and clarify rate-limit labels on Queues.

## 0.1.2 — 2026-09-10

Published to npm from one source commit shared with the Python distribution and the Go module,
tagged `v0.1.2`. Workhorse stays a public beta on the `0.x` line.

Requires **schema v1**, Node.js **22** or newer, PostgreSQL **15** or newer. CI exercises Node.js 22
and 24 and PostgreSQL 15 through 18.

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

Published to npm from one source commit shared with the Python distribution and the Go module,
tagged `v0.1.0`. This is the first version without a prerelease suffix
([ADR 0050](docs/decisions/0050-release-0-1-0-without-a-prerelease-suffix.md)). Workhorse stays a
public beta on the `0.x` line.

Requires **schema v1**, Node.js **22** or newer, PostgreSQL **15** or newer. CI exercises Node.js 22
and 24 and PostgreSQL 15 through 18.

### Changed

- **The TypeScript policy reads are renamed to match Python and Go.** `Queue.concurrencyPolicies`
  becomes `Queue.listConcurrencyPolicies`, `Queue.rateLimitPolicies` becomes
  `Queue.listRateLimitPolicies`, and `Admin.concurrencyPolicies` becomes
  `Admin.listConcurrencyPolicies`. Every language now names the read the same way as
  `list_concurrency_policies` and `ListConcurrencyPolicies` already did. The old names remain as
  `@deprecated` aliases that call the new methods for the rest of the `0.x` line, so no call site
  breaks now; they are removed in `1.0.0`.
- **TypeScript type names.** Ten exported types take the names the Python and Go SDKs already
  share: `EnqueueIdempotency` becomes `Idempotency`, `EnqueueDebounce` becomes `Debounce`,
  `EnqueueThrottle` becomes `Throttle`, `JobDependencies` becomes `Dependencies`,
  `ScheduleJobDefinition` becomes `ScheduledJob`, `SendSignalResult` becomes
  `SignalDeliveryResult`, `SendSignalStatus` becomes `SignalDeliveryStatus`,
  `CompleteHumanWaitResult` becomes `HumanWaitCompletionResult`, `CompleteHumanWaitStatus` becomes
  `HumanWaitCompletionStatus`, and `ExternalWaitListOptions` becomes `ExternalWaitQuery`. Every old
  name is still exported as a deprecated alias of its replacement, so no code has to change on this
  release. The aliases are removed in `1.0.0`.
- **Dashboard contract.** Every shared wire type in `dashboard/v1/procedures.json` now carries the
  `Dashboard` prefix. Eight `$defs` entries are renamed: `CancelStatus`, `SignalDeliveryStatus`,
  `HumanWaitCompletionStatus`, `Json`, `QueueHealthReason`, `QueueHealthReasonCode`,
  `RetentionPolicyImpact`, and `MaintenanceLoopCadences` gain the prefix, and the generated Go and
  Python bindings rename their types to match. Those types are core types that reach a dashboard
  response, so without the prefix `go/dashboard` declared a second `CancelStatus` beside `go`'s own
  and `workhorse.dashboard_v1` declared a second one beside `workhorse.types`. Generated bindings
  carry no aliases, so a Go or Python caller that names one of the eight updates the name.
  `@stablemates/workhorse-dashboard-server/wire` keeps `MaintenanceLoopCadences` as a deprecated
  alias of `DashboardMaintenanceLoopCadences` for the rest of the `0.x` line. No request or
  response payload changes, so an HTTP client of the dashboard is unaffected and
  `dashboard/v1/conformance.json` and `dashboard/v1/manifest.json` are unchanged.
- All nine packages move from `0.1.0-beta.2` to `0.1.0`, and every peer range on
  `@stablemates/workhorse` becomes `>=0.1.0 <0.2.0`. A later prerelease of this line is a
  `0.2.0-beta.N`; a published version is never reissued.
- Install commands name no version. `support.json` states each command once, every README and
  documentation page copies it, and a test fails any surface that disagrees.
- **The schema command is the one exception, and it now has two forms.** A TypeScript project runs
  `npm exec --no -- workhorse schema install`, which resolves the binary from its own
  `node_modules` and never installs anything, so the schema tool and the application match by
  construction. A Python or Go project has no `node_modules` and pins instead:
  `npx --package @stablemates/workhorse@0.1.0 workhorse schema install`, at the version of the SDK
  it depends on. A schema tool behind the application leaves a schema the application refuses to
  start against, so the pin is a deployment requirement rather than a preference. A test keeps the
  pinned literal equal to the published version.
- The installation page links to the compatibility matrix instead of restating the supported
  floors, and documents the verification step: run `workhorse schema status --json` after migrating
  and before the first process from the new release starts, and fail the deploy on a non-zero exit.
- Every GitHub release attaches `schema.sql`, so a Python or Go developer with no Node.js toolchain
  can create a development database with `psql -f schema.sql`. The installation page names the
  release that carries the file and the command that downloads it, pinned to the same version as
  the schema tool, because a reader on a host with no checkout has no `schema.sql` to apply
  otherwise. That path carries none of the CLI's guards and is documented for development only.
- The documentation site publishes one agent-facing layer. `/docs/for-ai-agents` is the entry point
  that every landing surface and `llms.txt` name, every documentation page has a Markdown twin at
  its URL plus `.md` served as `text/markdown`, and `llms-full.txt` carries the whole corpus.
- `SECURITY.md` names the private reporting channel and states that only the latest `0.x` minor of
  each package line receives fixes.
- **Ordered migrations start here.** The `0.1.0` clean-install artifact is frozen as
  `sql/releases/0001.sql`, and from `0.2.0` every schema change ships as an ordered, immutable step.
  Inside a major line a migration only adds, so a client accepts any installed schema at or above
  the version it was built against, and a deployment upgrades in place while its running processes
  keep working. Run `migrateSchema` from a deployment step before processes from the new release
  start; nothing migrates automatically.
  ([ADR 0053](docs/decisions/0053-start-migrations-at-0-1-0-and-keep-them-additive.md))
- `workhorse schema status` reports where the installed schema sits and whether this build accepts
  it as two separate fields. `schema.state` is now `not-installed`, `behind`, `current`, or `ahead`
  in place of `drift`; `schema.compatible` and `schema.refusal` carry the verdict, and the exit code
  follows `compatible`. A schema ahead of the running build is accepted, so a deployment gate no
  longer fails the normal middle of a rolling upgrade. The report prints the same sentence
  `assertSchemaCompatible` throws.
- **Schema.** `workhorse.valid_tags` is renamed `workhorse.valid_tags_v1`, so every function in the
  schema now carries a version suffix and can be superseded without breaking its callers.
  `workhorse.dashboard_run_task_now_v1` is removed: the Python and Go dashboard backends now call
  the audited four-argument `workhorse.run_task_now_v1`, which the TypeScript dashboard server
  already used. A dashboard run-now action is therefore audited in all three languages, and its
  `promoted` event records the actor, the reason, and the request identity.
- **Removed from `@stablemates/workhorse`.** Five identifiers left the package index because no
  application called them. `queueHealthFromDocument` and `QueueHealthDocument` existed so the
  dashboard server could convert a raw `queue_health_v1` row; the dashboard now calls
  `Admin.health()`, and the raw row shape, which leaked SQL column names and string-typed counts,
  is private to core. `Failpoint`, `InjectedCrashError`, and `WorkerOptions.failpoint` were a
  crash-injection hook for this repository's own worker tests and benchmarks; they are marked
  internal and no longer appear in the published type declarations. Nothing about worker behaviour
  changes.
- **`@stablemates/workhorse-dashboard` and `@stablemates/workhorse-dashboard-server` export each
  public name from one subpath.** Six names are removed. `TaskActivityGroup` and
  `TaskActivityPeriod` leave the dashboard's `.` subpath: they restated `DashboardActivityGroupBy`
  and `DashboardActivityPeriod` member for member, and those are the names Python and Go already
  carry. `./presentation` no longer re-exports `dashboardJobEventTypes` or
  `dashboardAttemptOutcomes`; import them from `./wire`, which owns them. `CompleteDashboardOptions`
  leaves `./wire`, `sql` and `DashboardSql` leave the dashboard-server `./server` subpath, and
  `DashboardWorkspaceLink` is now exported from `./server` alone rather than also from `.` and
  `./client`. The three were internal: the bare `sql` collided with the `drizzle` and `kysely`
  template tags in a consumer namespace, and `dashboardDatabase(database)` already returns the
  `DashboardDatabase` that `createDashboardHost` accepts, so no consumer builds a fragment.
- **`@stablemates/workhorse-dashboard-server/server` names every controller type and stops
  exporting its read model.** A host that implements `DashboardTaskController` can now name the
  types its methods return: `DashboardRunNowResult`, `DashboardSignalTaskResult`, and
  `DashboardCompleteHumanWaitResult` join the already-exported `DashboardCancelTaskResult`, and
  `DashboardCancellationAuditContext`, which `cancelTask` receives, is exported beside
  `DashboardAuditContext`. Python and Go already generated the first three. In the other direction,
  `readDashboardEvents`, `readDashboardEventDetail`, `readDashboardWorkers`, and
  `DashboardEventsQuery` are removed from the subpath. They were three of the read model's thirteen
  readers, exported for no stated reason; the read model is the implementation of `dashboardRouter`,
  which is where read-only mode, the worker-management decision, and error-stack redaction are
  applied. Read through the procedures the dashboard already mounts instead. The same subpath is
  re-exported by `@stablemates/workhorse-dashboard/server`, so both packages change together.
- **The idempotency wire family takes the `Dashboard` prefix every other wire name has.**
  `IdempotencyEvidence` becomes `DashboardIdempotencyEvidence`, `readIdempotencyEvidence` becomes
  `readDashboardIdempotencyEvidence`, `hasIdempotencyEvidence` becomes
  `hasDashboardIdempotencyEvidence`, and `idempotencyEventDetailKeys` becomes
  `dashboardIdempotencyEventDetailKeys`. Every old name stays as a `@deprecated` alias for the rest
  of the `0.x` line and is removed in `1.0.0`. `MaintenanceLoopCadences` is unchanged, because
  Python and Go share that name.

- **A client declares a schema floor and no ceiling, and the database declares which clients it
  still serves.** The startup check refused any schema newer than the version the build was
  compiled against, which would have turned the first in-place migration into an outage for the
  length of a rolling deployment. A build cannot know which later release stops serving it, so the
  ceiling comes from the database instead: `workhorse.protocol_version` records the SQL protocol
  versions the installed schema still serves, and a client whose protocol is absent from that list
  refuses. Below the oldest served version is `schema-too-new`; above the newest is
  `schema-too-old`. A schema that records nothing enforces nothing. `readProtocolVersions` reports
  the list, and the Python and Go checks read the same rows.
- **The standalone dashboard server sets browser protections, because it owns its whole origin.**
  Every response from `startDashboardServer` now carries `Content-Security-Policy`,
  `X-Content-Type-Options`, `Referrer-Policy`, `X-Frame-Options`, and `X-Robots-Tag`, and no
  response references a remote origin. `createDashboardHost` still sets none: an embedded host
  shares the application's origin, and two `Content-Security-Policy` headers on one response
  intersect rather than override, so a policy set here could quietly narrow an application that
  already has a stricter one. The dashboard-server README, the authentication guide, and the
  dashboard page on the site print the policy an embedder copies.

### Added

- `SchemaCompatibilityError` is exported from `@stablemates/workhorse`. `assertSchemaCompatible`
  throws it instead of a bare `Error`, so a TypeScript caller can catch a schema or protocol
  mismatch by type the way a Python caller catches `ProtocolCompatibilityError` and a Go caller
  matches `*CompatibilityError`. Its `code` is one of `schema-not-installed`, `schema-too-old`,
  `schema-too-new`, `client-protocol-too-old`, or `client-protocol-too-new` — the same five strings
  the other two SDKs use — and `installedVersion` and `expectedVersion` name the two versions that
  disagree. A database the check cannot read at all still throws a plain `Error`, because an
  unreachable database is not a verdict about versions.
- `workhorse schema status --json` adds `schema.refusalCode` beside `schema.refusal`, so a
  deployment gate can branch on the same code the process that starts after it would throw.
- **Every worker records what it is, not only where it runs.** The baseline carries three nullable
  columns on `workhorse.worker_registry` — `client_protocol_version`, `sdk_language`, and
  `sdk_version` — and the TypeScript, Python, and Go workers all report them at registration and on
  every heartbeat that refreshes the row. They answer two questions the registry could not. A
  rolling deploy runs more than one build at once, so the dashboard worker view now shows which SDK
  and version each worker runs. And `workhorse schema contract` may only retire a protocol once no
  worker still speaks it, which is evidence that had nowhere to live
  ([ADR 0057](docs/decisions/0057-retain-superseded-functions-and-contract-on-the-operators-schedule.md)).
- `workhorse schema status --json` adds a `fleet` block: one entry per distinct client protocol
  version, counting the workers that heartbeated inside their own lease, with a `note` stating that
  producers never register so the counts are worker evidence and not an inventory. A client that
  calls the SQL protocol directly without reporting the three is counted under a null version.
- **A wrong database URL gets a sentence, not a stack.** Every `workhorse` command that reaches
  PostgreSQL used to answer an unreachable or refused database with six frames of `node_modules`
  internals, and none of them said which of `--database-url`, `WORKHORSE_DATABASE_URL`, or
  `DATABASE_URL` supplied the value. It now prints one line naming the failure, the host and port
  when the driver reports them, and the source it resolved, and it never prints the URL itself
  because that routinely carries a password. Socket and DNS failures, PostgreSQL's `08` and `28`
  SQLSTATE classes, and `3D000` are recognised; anything else keeps its stack, and both still
  exit 1.
- The `workhorse init` options `--dir` and `--force` are documented in
  [`docs/architecture.md`](docs/architecture.md), which also lists the commands the published
  `workhorse` binary owns. Neither flag changed; they were previously visible only in
  `workhorse init --help`.

- **The `workhorse admin` CLI covers every operator action that previously needed a browser.**
  `admin purge <queue>` joins cancel, redrive, pause, and resume as a guarded command, and
  `admin pause-worker <worker-id>` and `admin resume-worker <worker-id>` take one worker out of
  rotation and put it back. All three demand `--env` naming the connected database, then `--yes` or
  an interactive retype of the target, and all three require `--reason`. `purge` prints the deleted
  row count and emits it as `deletedCount` under `--json`; the two worker commands emit the stored
  `WorkerPauseResult`.
- **Three read-only `admin` commands answer what a stalled durable handler is waiting on.**
  `admin checkpoints <job-id>` renders the restart boundaries a handler passed and
  `admin waits <job-id>` its durable timer waits, both narrowing to one record with `--name`.
  `admin external-waits` is the fleet-wide question: every pending human decision and signal wait,
  merged oldest first with a `KIND` column. Under `--json` it emits a `human` and a `signal` page
  that advance independently through `--human-cursor` and `--signal-cursor`.
- **The dashboard redrives a dead letter from the listing that shows it.** `dashboard/v1` gains
  `redriveTask` and `redriveDeadLetters` additively; no existing procedure or field changes. The
  discarded listing redrives one task from its row menu and a bounded page of the failures its
  filters select from a control above the table. Both reach `Admin.redrive` and `Admin.redriveMany`
  through `createDashboardOperatorControllers`, so the embedded, standalone, and demo hosts serve
  them from one factory, and both are attributed to the operator the server authenticated rather
  than to a name the browser supplied. `DashboardTaskController` gains `redriveTask` and
  `redriveDeadLetters`, and `DashboardRedriveResult`, `DashboardRedriveFilter`, and
  `DashboardRedriveBatch` are exported from `@stablemates/workhorse-dashboard-server/server` beside
  the other controller result types.
- `migrateSchema` accepts `lockTimeoutMs`, and `SCHEMA_MIGRATION_LOCK_TIMEOUT_MS` is its 5s
  default. An `ALTER TABLE` takes `ACCESS EXCLUSIVE`, and PostgreSQL queues every later statement on
  that table behind the waiting acquisition, so an unbounded wait turned one long worker
  transaction into a stalled queue. The timeout bounds the migration body alone: waiting for a peer
  migrator on the advisory lock stays unbounded, because that wait is expected. A step that gives
  up rolls back atomically, so the recovery is to end the blocking transaction and rerun.

### Fixed

- The published `@stablemates/workhorse` tarball no longer ships the benchmark suite.
  `dist/src/cli/benchmark.*` and the whole `dist/benchmarks/` tree were built and packed even
  though `benchmark` is not a `bin` entry and not a command of the `workhorse` dispatcher, adding
  roughly 620 kB of unreachable modules to every install. `tsconfig.build.json` now
  excludes the benchmark CLI the way it already excluded `reset-db`, and drops the benchmark
  harness from the build. Both stay repository scripts, run from source through `pnpm benchmark`
  and `pnpm db:reset:*`; no importable API is removed, because neither module was reachable from
  the package `exports`.
- The demo no longer replays the schema on startup against a database that already holds it.
- The poll-cadence conformance fixture in `protocol/v1/runtime.json` holds the worker at each empty
  poll, so every language runtime's cadence test observes the same schedule.

- The dashboard withholds a persisted attempt stack from the Events drawer too. `redactErrorStacks`
  was applied in `jobDetail` and nowhere else, so a host that withheld a stack from task detail
  handed the same stack to the same browser through `dashboard_event_detail_v1`, one click away.
  `readDashboardEventDetail` now takes the flag and defaults it to false, exactly as
  `readDashboardJobDetail` does.
- `workhorse init` reads the lockfile the installer actually wrote when a project declares no
  `packageManager`, instead of defaulting to pnpm, and the npm branch prints `npm exec --no --`
  rather than the unqualified `npx` form the installation page warns about, which resolves whatever
  package on the registry carries that name. It also states that `workhorse dashboard` needs
  `@stablemates/workhorse-dashboard`, which nothing said before.
- `ajv`'s `fast-uri` dependency moves off five High advisories inside the published closure. None is
  reachable through Workhorse, which constructs `ajv` with `validateFormats: false` and requires
  every `$ref` to be a local fragment, and which issues no request from a parsed URI at all. The
  bump costs a lockfile line and is taken anyway.

### Upgrade notes

- **Schema version.** `0.1.0` installs schema version 1, which is the permanent migration baseline.
  It ships no migration step: the worker client identity columns are part of the baseline rather
  than an upgrade on top of it, so `register_worker_v1` carries them and no `_v2` exists. The first
  entry in `sql/migrations/` arrives with the first schema change after this release.
- **Schema baseline.** `0.1.0`'s baseline is not the one
  `0.1.0-beta.2` installed: `workhorse.valid_tags` was renamed and
  `workhorse.dashboard_run_task_now_v1` was removed. A database installed by any beta reports
  version 1 and passes `assertSchemaCompatible`, yet holds the old function names. You must recreate the database and
  install the new baseline with `npm exec --no -- workhorse schema install`.
  This is the last release that asks for a recreation: from `0.1.0` the schema is frozen as the
  migration baseline, and later releases upgrade a database in place.
- **Dashboard bindings.** A Go or Python backend that names `dashboard.SendSignalStatus` or
  `dashboard.CompleteHumanWaitStatus` from the generated dashboard bindings renames those
  references to `SignalDeliveryStatus` and `HumanWaitCompletionStatus`. Generated code carries no
  deprecated alias. The TypeScript names all keep one, so a TypeScript project needs no edit.
- **Removed exports.** Code that imported `queueHealthFromDocument` or `QueueHealthDocument` should
  read the snapshot through `Admin.health()`, which returns the same `QueueHealth`. Code that
  imported `Failpoint` or `InjectedCrashError`, or that set `WorkerOptions.failpoint`, was using a
  test hook that was never part of the supported surface; there is no replacement.
- **Dashboard imports.** If a build breaks on a missing dashboard name, move the import to the
  subpath that now owns it: `dashboardJobEventTypes` and `dashboardAttemptOutcomes` to `./wire`,
  `DashboardWorkspaceLink` to `@stablemates/workhorse-dashboard-server/server`, and
  `TaskActivityGroup` and `TaskActivityPeriod` to `DashboardActivityGroupBy` and
  `DashboardActivityPeriod` on `./wire`. Nothing replaces `sql`, `DashboardSql`, or
  `CompleteDashboardOptions`, which were never meant to leave their package. The renamed
  idempotency names still resolve under their old spellings until `1.0.0`, so that rename needs no
  action in `0.x`.

## 0.1.0-beta.2 — 2026-09-01

Published to npm from commit `856cdcf354aa83a3acf8ee67043145adb9c99e09`, tagged
`v0.1.0-beta.2`.

First published line. Requires **schema v1**, Node.js **22 or 24**, PostgreSQL **15 through 18**.

### Changed

- The unpublished `0.1.0-beta.1` tag stopped before its first registry upload because npm parsed a
  relative tarball path as GitHub shorthand. Publication now uses an explicit local path.
- All nine npm packages, the Python distribution, and the Go module use the Apache
  License, Version 2.0. Contributions require the agreement in `CLA.md`.

### Added

- `@stablemates/workhorse`: the schema ships as a single baseline at version 1. Nothing has been
  published, so the pre-release migration history was squashed into `sql/schema/current.sql` rather
  than carried as steps no deployment could ever have applied. `workhorse.protocol_version` records
  the served SQL protocol versions independently of the `workhorse.schema_migration` history;
  `readProtocolVersions` and `workhorse schema status` report it. The migration framework —
  `migrateSchema`, `workhorse schema migrate`, the `workhorse:schema-migration` advisory lock, and
  atomic per-step rollback — remains and has nothing to apply until the first ordered step ships at
  1.0.0. Upgrade steps: recreate the database. Development worktrees run `pnpm worktree:setup`.

- `@stablemates/workhorse`: durable PostgreSQL job queue with at-least-once delivery, leases and fencing,
  cooperative cancellation, deadlines and execution timeouts, durable waits, progress and
  checkpoints, dead letters and redrive, enqueue idempotency keys, persisted retry policies,
  queue and per-key token-bucket rate limits,
  declarative recurring schedules, versioned payload and result contracts, durable JSON size
  limits, operator redaction, automated history retention, and a durable worker registry.
- `@stablemates/workhorse`: database-authoritative maintenance and retention settings with application
  defaults, operator overrides, per-setting provenance, revert operations, and bounded retention
  impact previews.
- `@stablemates/workhorse`: versioned dashboard read views and a planner-estimate function that isolate
  the dashboard server from private table changes.
- `@stablemates/workhorse`: strict job priority from 0 through 100 across direct, batched, delayed, and
  recurring enqueue, with FIFO order inside each priority and preservation through retries,
  promotion, and redrive.
- `@stablemates/workhorse`: PostgreSQL-owned keyed debounce and throttle windows with structured enqueue
  outcomes, atomic batch and transaction behavior, and shared safe key diagnostics.
- `@stablemates/workhorse`: durable dependency edges keep jobs blocked until every prerequisite satisfies
  its fan-in terminal policy. Bounded lineage and job queries expose those edges, while health
  snapshots and per-queue telemetry report dependency pressure.
- `@stablemates/workhorse`: bounded dependency fan-in with terminal policies, plus fenced child creation
  and result joining through `HandlerContext.runChild` and `HandlerContext.runChildren`.
- `@stablemates/workhorse`: child lineage survives retry and cancellation, redrive keeps the source tree
  immutable, retention avoids parent-child cleanup cycles, and health, metrics, and dashboard
  detail expose bounded orchestration evidence.
- `@stablemates/workhorse`: named signal waits release worker leases, and application or authenticated
  dashboard callers can deliver bounded payloads exactly once at the waiting-state transition.
  Callers can shorten the PostgreSQL-owned timeout; unanswered boundaries fail terminally.
- `@stablemates/workhorse`: named human waits retain bounded decision context, release worker leases, and
  resume once after an application or authenticated dashboard operator supplies a bounded result.
  They share the signal-wait timeout and terminal failure contract.
- `@stablemates/workhorse`: `Worker.handleBatch` for compatible full and linger-bounded partial batches,
  with explicit per-job success or failure outcomes, independent retries, leases, contexts, fencing,
  cancellation, timeout handling, policy accounting, priority order, and bounded batch telemetry.
- `@stablemates/workhorse`: transactionally consistent `Queue.health()` snapshots — one SQL statement
  for every correctness-sensitive value, size-capped history scans with explicit lower-bound
  flags, PostgreSQL estimates separated under `observations`, and caller-overridable health
  budgets producing machine-readable `status.reasons` shared by the `workhorse health --json`
  exit code, the benchmark invariants, and the dashboard verdict.
- `@stablemates/workhorse`: the `workhorse` CLI — `init`, `schema install`, `schema status`, `worker`,
  `dashboard`, `health`, `bench`, and `bench competitors`.
- `@stablemates/workhorse`: the `workhorse admin` command set — inspection of jobs, queues, schedules,
  failures, workers, and maintenance state with table and `--json` output, plus guarded `cancel`,
  `redrive`, `pause`, and `resume` that require an explicit verified `--env` target and
  confirmation — and the `workhorse tui` terminal application rendering the same views over the
  same administrative client and safety checks.
- `@stablemates/workhorse`: notification-assisted worker dispatch through one process-local
  `workhorse_jobs` listener per node-postgres pool, with queue routing, reconnect backoff, and
  jittered bounded polling as the durable fallback.
- `@stablemates/workhorse-drizzle`: Drizzle ORM provider with caller-owned transactions.
- `@stablemates/workhorse-prisma`: Prisma ORM provider with caller-owned interactive transactions and optional
  node-postgres notification connections.
- `@stablemates/workhorse-typeorm`: TypeORM provider with caller-owned `EntityManager` transactions and optional
  node-postgres notification connections.
- `@stablemates/workhorse-kysely`: Kysely provider with caller-owned transactions and optional node-postgres
  notification connections.
- `@stablemates/workhorse-otel`: explicit OpenTelemetry registration for the vendor-neutral core
  telemetry contract, with host-owned API peers and no import side effect.
- `@stablemates/workhorse-dashboard`: the operator dashboard, its framework-neutral `Request`/`Response` host,
  a settings page with audited policy changes, and a Connect-style Node bridge for Express,
  Connect, and Fastify.
- `@stablemates/workhorse-dashboard-server`: single-administrator sessions protect standalone dashboard reads
  and mutations, including credential rotation, login throttling, secure cookies, container secret
  files, and a supported container that requires an HTTPS public origin for remote listeners.
- `@stablemates/workhorse-dashboard-contract`: the type-only standalone server contract shared by the core CLI
  and dashboard package, so both compile against one optional embedding boundary.
- Language-neutral SQL protocol conformance fixtures under `protocol/v1`, covering compatibility,
  canonical enqueue requests, lifecycle scenarios, runtime behavior, and structured errors for
  TypeScript and future language clients.
- `typescript/examples/agentic-flow.mjs` and `pnpm example:agentic-flow`, demonstrating a durable
  agent loop built from checkpoints, child jobs, a durable timer, rate limits, and an approval
  signal.
- A supported-version contract: `MINIMUM_POSTGRES_MAJOR`, `SUPPORTED_POSTGRES_MAJORS`,
  `MINIMUM_NODE_MAJOR`, `SUPPORTED_NODE_MAJORS`, and `readPostgresSupport` are exported from
  `@stablemates/workhorse`, exercised by the CI matrix, and reported by `workhorse schema status`.
- `@stablemates/workhorse`: `WorkhorseError`, the base class every error Workhorse raises now extends, so
  one `instanceof` test recognizes a rejected call without enumerating seventeen class names.
- `@stablemates/workhorse`: `databaseErrorCode`, `expectOneRow`, and `MissingRowError`. `databaseErrorCode`
  reads a SQLSTATE through the wrappers an ORM adds around a driver error; `expectOneRow` takes the
  single row a statement is defined to return and throws `MissingRowError` naming that statement
  when the result is empty.
- `@stablemates/workhorse`: the shared adapter core an ORM provider is built from — `QueryError`,
  `rowsToQueryResult`, `attachNotificationPool`, `createProviderQueryable`, and
  `createProviderAdapter`, alongside the existing `createWorkhorseAdapter`. A provider now supplies
  only how its ORM runs a statement; error translation, the result shape, the notification
  capability, and the transaction wiring are owned once. What an adapter must guarantee is written
  down in [`docs/architecture.md`](docs/architecture.md).
- npm provenance on every published tarball.

### Changed

These changes precede the first publication, so no deployment upgrades through them. They are
recorded because the pre-release dashboards and ADRs in this repository name the retired
instruments.

- **Breaking:** `@stablemates/workhorse` now publishes only the `workhorse` binary. Replace
  `workhorse-health`, `workhorse-bench`, and `workhorse-bench-competitors` with `workhorse health`,
  `workhorse bench`, and `workhorse bench competitors`. The CLI rejects unknown options, supports
  both string-option spellings, provides help at each command depth, and uses exit 64 for usage
  errors. `schema status --json` separates schema drift from PostgreSQL support. `health --json`
  preserves the machine-readable health output; human output is now the default.

- `@stablemates/workhorse`: health snapshots and per-queue metrics now count rejected signal deliveries
  and human decisions over a trailing 24-hour window. A partial event index bounds these polling
  reads to recent rejection evidence instead of scanning all retained event history.

- **Breaking:** `@stablemates/workhorse`: every SQL function is at version 1. `claim_v3`,
  `heartbeat_v2`, `list_jobs_v2`, `list_job_timeline_v2`, `list_dead_letters_v2`, and
  `register_worker_v2` lost suffixes that recorded compatibility windows nobody could have been
  inside. `enqueue_many_v2` became `enqueue_many_v1`, and the internal batch function that held
  that name became `enqueue_batch_v1`. The single-queue `register_worker_v1` shim is gone; the
  multi-queue signature owns the name. Existing development worktrees must run
  `pnpm worktree:setup` once to recreate their dedicated databases.

- **Breaking:** `@stablemates/workhorse`: the rolling-statistics cadence is maintenance policy rather
  than a worker option. `WorkerOptions.statisticsRollupIntervalMs` is removed; set
  `statisticsRollupIntervalMs`, and the newly policy-owned `statisticsGroupLimit` and
  `statisticsRecomputeBuckets`, through `Queue.syncMaintenancePolicy` or an operator override.
  `rollup_stats_v1` now reads all three from `maintenance_policy`, gates itself on the interval
  (`Queue.rollupStatistics({ force: true })` bypasses the gate), and its signature is
  `(p_force, p_now, p_max_buckets)`. The baseline schema carries the three policy columns and their
  provenance. The dashboard
  settings page shows the new settings and derives recommendations from measured state — arrival rate against the terminal-cleanup ceiling, retention lag, a stalled or
  opted-out rollup, and default-partition spill — in `DashboardSettingsPage.recommendations`.

- `@stablemates/workhorse`: metric instruments are created on first emission and re-created when the
  global meter provider changes. An application may now install its OpenTelemetry SDK after
  importing `@stablemates/workhorse` and still receive metrics; previously every instrument bound to
  whichever provider existed at import, so a later SDK silently received nothing.
  [ADR 0024](docs/decisions/0024-metrics-instrument-lifecycle.md) records the measurement behind
  this.
- `@stablemates/workhorse`: two instrumentation modules emitted separately on the same lifecycle events.
  They are now one. `typescript/core/src/metrics.ts` is deleted; `typescript/core/src/telemetry.ts` owns every instrument, and
  `WorkhorseMetricsObserver` moves to `typescript/core/src/metrics-observer.ts`. The package export is unchanged —
  `WorkhorseMetricsObserver` is still exported from `@stablemates/workhorse` — and no other export from
  either module was public.
- `@stablemates/workhorse`: `JobValueSizeLimitError` extends `WorkhorseError` rather than `RangeError`.
  Code testing `instanceof RangeError` on it must test `instanceof JobValueSizeLimitError` or
  `instanceof WorkhorseError` instead. Its name, message, and fields are unchanged.
- `@stablemates/workhorse`: enqueue and redrive idempotency conflicts are now recognized through an ORM's
  error wrapper rather than only on the error object the driver threw. A conflict raised inside a
  Drizzle, Prisma, TypeORM, or Kysely transaction reaches the caller as
  `EnqueueIdempotencyConflictError` or `RedriveIdempotencyConflictError` instead of the adapter's
  own query error.
- `@stablemates/workhorse`: the duplicated instruments are retired in favor of one name per event.
  `workhorse.job.enqueued` becomes `workhorse.jobs.enqueued`, `workhorse.job.claimed` becomes
  `workhorse.jobs.claimed`, `workhorse.lease.recovered` becomes `workhorse.leases.expired`,
  `workhorse.job.cancellation` becomes `workhorse.jobs.cancellation`, `workhorse.job.redrive`
  becomes `workhorse.jobs.redrive`, and `workhorse.job.count` becomes `workhorse.jobs.count`.
- `@stablemates/workhorse`: `workhorse.job.execution` becomes `workhorse.handler.executions`, and its
  `workhorse.job.outcome` attribute becomes `workhorse.handler.outcome`. The
  `workhorse.job.execution.duration` histogram is removed; `workhorse.handler.duration` now carries
  the outcome attribute and times the same activation in **milliseconds rather than seconds**.
  Dashboards and alerts that read the retired histogram need both the new name and the new unit.

- `@stablemates/workhorse-dashboard`: `DashboardClient` is inferred from the router that serves it rather than
  written out a second time by hand. The method names and shapes are the ones the dashboard already
  spoke, so a host built against the packaged client needs no change; a host that answered a
  slightly different shape now hears about it from the type-checker. Filter arguments that were
  typed as `string` are now the vocabulary the router accepts — `events({ types })` takes event
  types and attempt outcomes, exported as `DashboardEventTypeFilter`. Adding a procedure is an edit
  to the router alone.
- `@stablemates/workhorse-dashboard`: the server read model uses core-owned versioned views and functions. Its
  core peer range now permits independent patch releases within the same minor line.

### Upgrade notes

There is no prior published release, so there is nothing to upgrade from. For the shape future
entries take:

- **Schema version.** `installSchema` is clean-database only and refuses to touch an existing
  versioned schema. A release that bumps the schema version is installed into a fresh schema, with
  the previous one drained rather than migrated in place.
- **Runtime and schema must match exactly.** Deploy so that no process runs against a schema version
  it was not built for; a mixed fleet mid-deploy is not supported.
- **PostgreSQL below the minimum is refused at installation.** `installSchema` fails with the
  server's reported version instead of failing part way through `sql/schema.sql`.
