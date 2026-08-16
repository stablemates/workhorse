# Design improvement roadmap

This roadmap is the structural complement to the feature roadmap in [`TODO.md`](../TODO.md).
It orders design and architecture improvements so that each step reduces risk for the next.
It adds no features. Where a decision is performance-sensitive, a benchmark gate decides it,
per the existing rule: benchmark evidence comes before performance claims.

Findings come from a full sweep of `typescript/core/src/`, `sql/`, `typescript/`,
`typescript/core/test/`, `scripts/`, and CI
on 2026-08-11, at schema version 23. Line references are to that snapshot; verify them before
editing, but the named identifiers stay greppable after drift.

Each open item below has four parts. **Today** states the verified current behavior with file
references. **Change** states the work. **Done when** states the acceptance criteria.
**Benchmark gate**, where present, names the evidence that decides or validates the change
and the existing benchmark asset to extend. Completed items retain a short status and the
source evidence that closed them.

## Roadmap rules

- Fix active bugs before refactoring anything they touch.
- Build safety nets — test structure, drift checks, benchmark trend lines — before cutting
  the large modules.
- If a change touches the enqueue, claim, or complete path, the read model, or telemetry,
  the pull request must attach a before/after self-run of `typescript/core/benchmarks/comparative.ts`.
- An evidence-gated item ends in a written verdict: an ADR in `docs/decisions/` that records
  the measured numbers and the decision, even when the decision is "keep the current design".
- No item may block or conflict with the open features in `TODO.md` (P0-08 dashboard auth,
  P1-05 priority queues, P2-07 migrations, P2-13/P2-14 SDKs). Several items below exist to
  make those features cheaper.
- Behavior-neutral refactors land as mechanical relocations, one concern per pull request,
  each green against the full suite.

## Phase 0: active bugs and safety nets

### 0.1 Consolidate the two metrics layers

**Scope:** S/M. **Depends on:** nothing. **Unblocks:** honest baselines for every gate below.

**Today.** Core has two instrumentation layers that both fire on the same code paths:

- `typescript/core/src/metrics.ts` (342 lines): eager module-scope instruments named `workhorse.job.*`,
  helpers `recordEnqueuedJobs`, `recordClaimedJob`, and the polling class
  `WorkhorseMetricsObserver` whose `collectOnce()` runs its own depth SQL at
  `metrics.ts:263-298`.
- `typescript/core/src/telemetry.ts` (373 lines): lazy, provider-change-aware instruments named
  `workhorse.jobs.*` under `telemetryMetrics`, plus `registerQueueMetrics` observable gauges
  fed by `Queue.queueMetricSnapshot()` (`queue.ts:3875-3961`).

Verified double-fire sites: enqueue calls `recordEnqueuedJobs(...)` at `queue.ts:1488` and
`telemetryMetrics.enqueued.add(1, ...)` at `queue.ts:1506` for the same accepted rows; claim
calls `recordClaimedJob(...)` at `queue.ts:2720` and `telemetryMetrics.claimed.add(1, ...)`
at `queue.ts:2721`. A consumer sees every event twice under two metric names. Queue depth is
computed three ways with near-duplicate SQL: `metrics.ts:263-298`, `queue.ts:3887-3934`, and
inside `Queue.health()`. The shape reads as an unfinished migration where neither side was
removed.

**Change.** Merge into one instrumentation module with one naming scheme. Audit every
`record*` and `telemetryMetrics.*` call site in `queue.ts` and `worker.ts`; each event must
be emitted exactly once. Collapse the three depth implementations into one query with one
owner. Delete the losing module and its exports from `typescript/core/src/index.ts`.

**Done when** a grep for the losing metric-name prefix returns nothing; each lifecycle event
increments exactly one instrument (assert via an in-memory MeterProvider in
`typescript/core/test/telemetry.test.ts` / `typescript/core/test/metrics.test.ts`, which already fabricate `QueryResult`
fixtures); the public export surface change is noted in `CHANGELOG.md`.

**Benchmark gate.** Run a throughput scenario with telemetry on and off, before and after,
capturing overhead through `typescript/core/benchmarks/telemetry.ts`. The eager pattern (`metrics.ts`) and
the lazy pattern (`telemetry.ts`) are competing lifecycle strategies; the overhead
measurement picks the survivor, not aesthetics.

### 0.2 Shared database-test harness and parallel test execution

**Scope:** M. **Depends on:** nothing. **Unblocks:** 0.3, 0.4, 1.2, faster pre-commit.

**Today.** `vitest.config.ts` sets `fileParallelism: false` and
`sequence: { concurrent: false }`, so all 52 test files (~20,800 lines) run one at a time.
The cause: every database-backed file — `typescript/core/test/integration.test.ts`,
`typescript/core/test/benchmark-conventional.test.ts`, `typescript/core/test/local-database.test.ts`, the four
`typescript/*/test/integration.test.ts`, and `typescript/demo/test/app.integration.test.ts` — runs
`DROP SCHEMA IF EXISTS workhorse CASCADE; installSchema(pool)` against the _same_ database
resolved by `localDatabaseUrl("test")` from `typescript/core/src/local-database.ts`. Roughly 40 files never
touch PostgreSQL and still pay the serialization cost. The setup preamble (pool creation,
`assertLocalDatabasePurpose`, schema install) and the `beforeEach` TRUNCATE lists are
copy-pasted across six files with divergent table sets — the root file truncates 17 tables
and restarts `workhorse.fence_token_seq` (`typescript/core/test/integration.test.ts:122`); the adapter files
truncate 8. A table added to `sql/schema.sql` leaks state silently until every list is
updated by hand.

**Change.** Build `typescript/core/test/support/db.ts` owning: pool creation with the purpose guard; schema
install; per-file isolation (dedicated schema or database per test file — pick one mechanism
and document it in the module header); and a truncation helper that derives the table list
from `information_schema.tables WHERE table_schema = 'workhorse'` so it cannot drift. Port
the six database-backed files to it. Then lift `fileParallelism: false` for non-database
files immediately, and for database files once isolated.

**Done when** the six files share one harness with zero copy-pasted DDL; a deliberate
cross-file state-leak canary test proves isolation; suite wall-clock before/after is recorded
in the pull request; adding a table to `sql/schema.sql` requires no test-harness edit.

### 0.3 Split `typescript/core/test/integration.test.ts` along the future `Queue` seams

**Scope:** M. **Depends on:** 0.2. **Unblocks:** 1.2.

**Today.** The file holds 8,876 lines and 208 `it()` blocks under two top-level `describe`
blocks, so no subset is targetable with `-t` and `test:integration` runs everything.
`typescript/core/src/queue.ts` is exercised almost solely through this file. A latent footgun: an
`afterAll(pool.end())` sits at line 418, lexically before a `describe` at line 421 that still
uses the pool — legal under vitest hook scoping, but a trap in a file this long.

**Change.** Split into per-domain files matching the seams intended for the 1.2
decomposition: enqueue and contracts; claim/lease/fence; retry and attempt lifecycle;
checkpoints, progress, and waits; queue administration; cron schedules; retention and
maintenance; worker registry; operator reads (listJobs, dead letters, redrive); health and
snapshots. Use the 0.2 harness for each. If a test does not fit any seam cleanly, that is
signal the seam is wrong — adjust the 1.2 plan, not the test. Add coverage tooling
(`@vitest/coverage-v8`) and record a baseline; the repo currently has none.

**Done when** no test file under `typescript/core/test/` exceeds ~1,500 lines; each domain file runs green in
isolation; a coverage baseline for `typescript/core/src/` is checked into the pull request description.

### 0.4 Drift checks and build/CI hygiene

**Scope:** S/M. **Depends on:** 0.2 for the CI and lefthook changes. **Unblocks:** safe
review of every Phase 1 refactor.

A bundle of mechanical fixes. Each is independent; land them in any order.

- **TS↔SQL limit parity.** `typescript/core/src/types.ts` exports 22 limit constants; several repeat as
  literals in `sql/schema.sql` with no check — `MAX_CHECKPOINT_VALUE_BYTES = 1_048_576`
  (`types.ts:212`) vs `schema.sql:424` and `:4184`; `MAX_PROGRESS_VALUE_BYTES = 65_536`
  (`types.ts:214`) vs `schema.sql:439` and `:4282`; default payload/result caps `1048576` at
  `schema.sql:380-381`, `:1714-1715`, `:2314-2315`. Add a unit test that parses
  `sql/schema.sql` for the named constants and asserts parity. `typescript/core/test/support-matrix.test.ts`
  (which asserts `.github/workflows/ci.yml` agrees with `typescript/core/src/support.ts`) is the pattern to
  copy.
- **Shared helpers in core.** One camel-to-snake mapping table — it is copy-pasted at
  `queue.ts:2008-2020`, `:2036-2048`, `:2190-2195`, and in `syncMaintenancePolicy`. One
  SQLSTATE decoder — today only `enqueueConflict()` (`queue.ts:1078`) and
  `redriveConflict()` (`queue.ts:1169`) decode; every other raw `pg` error escapes
  untranslated. A common `WorkhorseError` base for the 15 exported error classes so callers
  can `instanceof` one type. An `expectOneRow()` helper replacing the 31 `result.rows[0]!`
  non-null assertions.
- **Single-source lists.** `build:runtime` uses the package inventory under `typescript/` while
  `build:runtime:dev` names the five packages individually — a new package silently misses
  the dev build. The packed-tarball list `dashboard drizzle prisma typeorm kysely` is spelled
  three ways: `typescript/core/test/packed-packages.ts` plus two bash loops in
  `.github/workflows/release.yml`. Competitor versions (pg-boss `12.26.2`,
  graphile-worker `0.17.3`) live in both `package.json` devDependencies and the hardcoded
  `version:` fields in `benchmarks/targets/*.ts` with nothing asserting agreement. Give each
  list one source and a drift test.
- **CI and hooks.** Add `timeout-minutes` to every job in `ci.yml` and `release.yml`. The
  test job's node×postgres matrix (2×4 = 8 legs) re-runs all 52 files including ~40
  database-independent ones; split so environment-independent files run once. `lefthook.yml`
  pre-commit currently runs `pnpm typecheck` (which itself runs a full build mid-chain —
  fix by extracting the build out of the `typecheck` script) plus the entire serial DB
  suite; reduce pre-commit to typecheck + changed-scope tests, moving the full suite to
  pre-push or CI. Also gitignore `scripts/with-env-probe.tmp.*`, which
  `scripts/with-env.test.ts` writes into the working tree.

**Done when** each named duplication has one source of truth guarded by a test, and a
pre-commit on a one-line change completes without running the full database suite.

### 0.5 A real benchmark job in CI

**Scope:** S. **Depends on:** nothing, though 0.1 first keeps baselines honest.
**Unblocks:** every evidence gate below.

**Today.** `benchmarks/` (~5,900 lines) is well built: `scenarios.ts` (3,577 lines,
invariant-checked operational scenarios), `comparative.ts` (Workhorse vs the in-repo
conventional baseline), `competitor-baseline.ts` (pg-boss and graphile-worker targets with
fairness metadata and `claimLatencyComparable`/`fencingComparable` flags), `telemetry.ts`
(WAL LSN deltas, `pg_stat_io`, relation sizes, `EXPLAIN (ANALYZE, BUFFERS)`), and `run.ts`
(reports with git/hardware/PostgreSQL-settings provenance). CI only tests the planners as
pure functions; nothing ever executes a run, so benchmarks cannot serve as regression
evidence for the refactors below.

**Change.** Add a nightly or main-branch workflow that provisions PostgreSQL, runs the
`smoke` profile through `benchmarks/run.ts` (scenarios subset + comparative), and uploads the
report JSON as an artifact. Trend line first, not a merge gate — runner variance would make a
hard gate cry wolf. Promote to a gate only for the specific pull requests this roadmap names,
under pinned conditions.

**Done when** the workflow exists with `timeout-minutes`, produces an artifact on main, and a
short section in `docs/benchmarking.md` explains how to read the trend.

## Phase 1: low-risk extractions, then the god objects

### 1.1 Shared adapter core and conformance suite

**Scope:** M. **Depends on:** 0.2, 0.4. **Unblocks:** future adapters; the contract text that
P2-13/P2-14 SDK authors need.

**Today.** The adapter contract is `WorkhorseAdapter<TTransaction>` built by
`createWorkhorseAdapter` in `typescript/core/src/adapter.ts` (53 lines — the one clean seam), but that
factory covers only the last ~12 lines of each ORM package. The four packages
(`typescript/drizzle` 525 lines, `prisma` 341, `typeorm` 294, `kysely` 292) each re-implement
five blocks in `typescript/core/src/index.ts`: an options interface (identical field-for-field), an
`XQueryError` class (byte-identical apart from the vendor noun), `databaseErrorCode(error)`,
a `xQueryable()` wrapper with an identical `QueryResult` shim
(`{ command: "", rowCount, oid: 0, fields: [], rows }`) and an identical notification-pool
tail, and an identical 7-line `createXAdapter`. The four `databaseErrorCode` implementations
have drifted: drizzle (`drizzle/src/index.ts:40-49`) unwraps depth 5 with no SQLSTATE shape
check; kysely uses depth 16 with `/^[0-9A-Z]{5}$/`; typeorm does BFS over
`cause`+`driverError`; prisma does BFS over `cause`+`meta` with a P-code fallback. Core's
typed conflict errors (`EnqueueIdempotencyConflictError` and friends) depend on this
extraction, so drizzle's is measurably the weakest for no stated reason. The per-adapter
tests duplicate scaffolding with divergent truncation lists, and all four import core
internals via `import { ... } from "../../../src/local-database.js"` — a workspace path
escape that only works in-repo. Drizzle's only genuinely unique code is its SQL placeholder
translator (`drizzle/src/index.ts:51-69`).

**Change.** Extract one shared module — in core or a small `@workhorse/adapter-core`
package — holding: the `QueryError` base; one correct `databaseErrorCode` (BFS with a `seen`
set, follows `cause`/`driverError`/`meta`, SQLSTATE regex; replace drizzle's, don't bless
it); `rowsToQueryResult()`; `attachNotificationPool()`; and a generic adapter factory. Each
ORM package becomes ~30 lines of glue plus anything genuinely dialect-specific. Replace the
four test suites with one parameterized conformance suite (on the 0.2 harness) that runs
against built packages, not the source tree.

**Done when** each `typescript/*/src/index.ts` is under ~50 lines; the conformance suite covers
error-code extraction for each driver's real error shapes; no `typescript/*` test imports from
`../../../src`; a written "what an adapter must guarantee" section lands in
`docs/architecture.md`.

### 1.2 Decompose `typescript/core/src/queue.ts` behind a stable facade

**Scope:** L. **Depends on:** 0.1 (metrics code out of queue.ts), 0.3 (tests split along the
same seams), 0.4 (error/mapping helpers exist). **Unblocks:** P1-05, 2.1, reviewability.

**Today.** `typescript/core/src/queue.ts` is 3,964 lines: the `Queue` class (~2,570 lines, ~80 public
methods) plus 15 error classes, ~20 row types, row mappers, and validators. The class doc at
`queue.ts:1383-1387` promises a "thin TypeScript facade"; `health()` alone is ~624 lines
(`queue.ts:3251-3874`) containing ~254 lines of inline SQL with eight concurrent queries
against `pg_class`, `pg_partition_tree`, `pg_stat_user_tables`, and `pg_stat_activity`.
Other structural facts an implementer needs: `listJobs` contains a ~60-line inline
allowlist/cursor validator (`queue.ts:2357-2440`) not reused by `listDeadLetters`;
`deadLetterFilter()`/`jobListFilter()` (`queue.ts:541-554`/`590-603`) and their row mappers
are near-duplicates; `getRedriveLineage()` runs a recursive CTE inline
(`queue.ts:2673-2690`) while every other redrive operation is a SQL function;
`BigInt(row.fence_token)` conversion repeats 6 times and the fence threads manually through
8 call sites — a `FencedLease` value object would collapse both.

**Change.** Keep the public `Queue` class and its method signatures exactly as they are.
Delegate to internal modules along ten concerns: enqueue and contracts; claim/lease/fence;
retry and attempt lifecycle; checkpoints, progress, and waits; queue administration
(pause/resume/purge/promote); worker registry; retention and maintenance policy; cron
schedules; operator reads; health and metric snapshots. Move `health()`'s inline SQL into
`sql/` as versioned functions or at minimum a dedicated read module. Extract the shared
filter/cursor validator. No behavior change, no hot-path SQL change — mechanical relocation,
one concern per pull request, each landing green against the 0.3 test files. P1-05 priority
queues then modifies a small claim module instead of a 3,964-line file.

**Done when** `queue.ts` is under ~600 lines of pure delegation; each internal module has a
matching 0.3 test file; the public API surface (checked via `typescript/core/src/index.ts` exports and the
packed-package test) is unchanged.

**Benchmark gate.** Before/after `comparative.ts` self-run on enqueue, claim, and complete.
The indirection cost must be noise; the gate exists to prove it.

### 1.3 Worker execution state machine and durable-wait hardening

**Status:** Completed.

`AttemptOutcomeArbiter` now resolves competing completion, failure, expiry, cancellation,
and suspension outcomes once. `Worker` reasserts a recorded suspension after handler code
returns, so swallowing the internal signal cannot complete or fail the job. Adversarial
coverage lives in `integration-checkpoints-progress-waits.test.ts`, and maintenance uses one
loop taxonomy.

### 1.4 A `Worker`-to-`Queue` interface seam

**Status:** Completed.

`WorkerQueueApi` is the worker's declared queue protocol for claims, fences, lifecycle
writes, durable boundaries, maintenance, and optional notifications. `Worker` accepts that
interface, and unit tests use structural implementations without importing the concrete
`Queue` class.

### 1.5 Stabilize the feature-wave seams before another language implements them

**Scope:** M. **Depends on:** 1.3 and 1.4. **Unblocks:** P2-13/P2-14 directly.

**Today.** The versioned SQL protocol now owns dependencies, child jobs, signals, human
decisions, keyed debounce, keyed throttle, priority dispatch, and batch claims. The worker
runtime owns child suspension and excludes suspension methods from `BatchHandlerContext`.
`protocol/v1/runtime.json` pins batch ordering and suspension behavior for other language
runtimes.

Three public seams still need cleanup before Python or Go copies them. WOR-98 consolidates
the dependency input and results from keyed coalescing. WOR-99 aligns signal and human-wait
naming, validation, typed errors, limits, and test depth. WOR-122 defines how retry,
promotion, and redrive preserve priority and documents strict-priority starvation.

**Done when** the protocol fixtures represent those public shapes once. TypeScript must
implement them without compatibility-only siblings. Language SDK issues must not depend on
TypeScript-specific interpretation.

## Phase 2: schema lifecycle and evidence-gated confrontations

### 2.1 Split the clean-install schema from migrations

**Scope:** M/L. **Depends on:** 1.2 helps (health SQL relocated), not required.
**Unblocks:** P2-07, P1-05, 3.2.

**Today.** `sql/schema.sql` (6,309 lines; 26 tables, 78 versioned `workhorse.*_vN`
functions) is simultaneously the clean-install artifact and a de-facto migration script: it
carries in-place `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` (`schema.sql:377-383`, `:539`,
`:1022`), `DROP FUNCTION IF EXISTS` prologues for every retired signature
(`:1768`, `:2585-2590`, `:2883-2886`, `:3381`, `:3459`), and dead versions kept for
compatibility (`claim_v1` at `:3382` while only `claim_v2` is called; `heartbeat_v1` at
`:3947` delegating to `heartbeat_v2`). Meanwhile `typescript/core/src/schema.ts:36-73` executes the whole
file in one shot, refuses any existing schema that does not already match
`WORKHORSE_SCHEMA_VERSION = 23`, and its own comment says production callers must not treat
it as an upgrade mechanism. The legacy-relation poison markers (`job_current`, `ready_job`,
`scheduled_job`, `lease`) are duplicated in `typescript/core/src/schema.ts:51-54` and inside the health SQL
at `queue.ts:3366-3373`.

**Change.** Restructure into: (a) a generated clean-install artifact with retired functions
and `DROP ... IF EXISTS` prologues removed; (b) per-version migration step files starting at
v23→v24 — do not retro-derive versions 1 through 23, nobody upgrades from pre-release; (c) a
CI check that clean-install equals migrated-from-previous (schema dump diff, normalized).
The `_vN` function convention stays; this item formalizes around it, not against it. Keep
`installSchema`'s public behavior for fresh installs. The P2-07 feature (framework, CLI,
operator UX) builds on this substrate; the P1-05 priority column becomes the first real
migration through it.

**Done when** the clean-install artifact contains no retired function versions; CI proves
install-equals-migrate; `docs/schema-lifecycle.md` describes the new layout.

### 2.2 Cron cadence authority — evidence-gated, possibly "don't"

**Scope:** M. **Depends on:** 0.5; 2.1 only if the SQL variant wins.

**Today.** `dueOccurrences()` (`worker.ts:1239-1260`) computes occurrence times in Node with
`cron-parser` against the process clock, and only the worker owning the tick advisory lock
fires them, serially, one nested `await` per occurrence (`worker.ts:937-954`). This is the
one place process-local state owns cadence, against the repo's "PostgreSQL owns correctness"
story — but `fire_schedule_v1` (`schema.sql:1769`) dedups occurrences, so correctness holds.
The open question is jitter and worst-case delay, not safety. ADRs 0002 (pg_cron, rejected)
and 0003 (worker-owned scheduler) record the original reasoning.

**Change — the benchmark decides existence, not just validation.** Add a schedule-fire
scenario to `typescript/core/benchmarks/scenarios.ts`: hundreds of schedules, loaded workers, capturing
fire-time jitter and worst-case delay through the telemetry capture. If jitter is acceptable
under load, do not move cadence to SQL — write the ADR that SQL owns dedup and the process
owns cadence, and close the question. If unacceptable, move next-occurrence computation into
a versioned SQL function (shipped through 2.1) and re-measure.

**Done when** the ADR exists with measured jitter numbers and an explicit accept/move
decision.

### 2.3 Partitioning versus vacuuming — evidence-gated

**Scope:** M. **Depends on:** 0.5.

**Today.** The storage design is two separable decisions that deserve different verdicts.

Decision one, the four-way lifecycle split (ADR 0001): immutable `job`, mutable `job_runtime`
existing only for scheduled/ready/active work with three partial indexes, immutable
`job_outcome`, append-only history. This stays in either outcome. It keeps claim indexes and
vacuum load proportional to live work rather than lifetime history — the documented failure
mode of single-table queues — and both variants below depend on it.

Decision two, the history machinery (ADRs 0007 and 0011), is the open question: UTC-daily
range partitions for `job_event` and `attempt_history` with default-partition fallbacks;
`prepare_history_partitions_v1` replenishing current-day-plus-three; default-partition spill
repair and re-attach; retention by partition drop in `retain_history_v1` with per-pass
limits, advisory-lock skips, and 250 ms DDL lock caps; a global retained-through watermark
gating `prune_terminal_storage_v1`; and a per-insert trigger locking and verifying the
parent identity (history tables deliberately carry no reverse foreign keys to `job`). That
machinery pays for itself only above a history-volume threshold that has never been
measured. Below the threshold, plain history tables with row-wise `DELETE` and autovacuum
are operationally simpler and adequate.

**Benchmark gate.** Extend `typescript/core/benchmarks/comparative.ts` and `typescript/core/benchmarks/conventional.ts` with
a sustained churn-plus-retention scenario — millions of jobs of steady enqueue/claim/complete
with retention active — comparing (a) partition-drop retention against (b) row-wise delete
with autovacuum on the existing single-lifetime-table baseline in
`sql/benchmark-conventional.sql` (schema `workhorse_benchmark_conventional`, built for
exactly this comparison). Measure: claim p50/p99 _over elapsed time_, because bloat shows up
late, not early; WAL volume per job; table and index bloat; vacuum duration and frequency;
and the per-insert cost of the history parent-identity trigger. `typescript/core/benchmarks/telemetry.ts`
already captures WAL LSN deltas, `pg_stat_io`, and relation sizes.

Decision rules: if delete-plus-vacuum holds claim p99 at the product's target scale,
simplify the machinery — candidate simplifications, in order of payoff: coarser partition
granularity (the design already moved weekly→daily once, in ADR 0011; it can move back), a
documented non-partitioned mode for small deployments, less default-partition repair
machinery. If it degrades, the design is proven — record the measured threshold in an ADR
and in `docs/benchmarking.md`, and close the question.

**Done when** the ADR exists with the measured threshold and either a simplification plan or
an explicit "proven, keep" verdict.

## Phase 3: dashboard structure — parallel-safe, never blocks Phases 0–2

### 3.1 Single-source the dashboard contract

**Scope:** M. **Depends on:** nothing outside the dashboard. **Unblocks:** P0-08 directly.

**Today.** One API surface is defined three times by hand: the ~200-line `DashboardClient`
interface (~25 methods) in `typescript/dashboard-server/src/client.ts`; the oRPC router in
`typescript/dashboard-server/src/server/router.ts` (439 lines); and the return shapes in
`server/read-model.ts`. `model.ts` (1,570 lines, 86 exports) fuses wire DTOs, presentation
formatters (`describeRetryPolicy`, `formatIdempotencyWindow`, `describeCancelOutcome`), and
enum tables, and is imported by both server and browser. The operator controllers (the seven
interfaces in `server/types.ts`) are implemented twice: `standaloneControllers()` in
`typescript/core/src/cli/dashboard.ts:69-121` and `createLocalQueueController` etc. in
`typescript/demo/src/app.ts:698-880`, same method set, same `Queue` calls, differing only in audit
plumbing. The core→dashboard edge is hidden from the type-checker by a string-concatenated
dynamic import: `["@workhorse", "dashboard/server"].join("/")` at `typescript/core/src/cli/dashboard.ts:52`,
with a hand-written structural stand-in for the module's types at `:32-40`; only
`typescript/core/test/packed-packages.ts` keeps it honest.

**Change.** Derive the client types from the router by oRPC type inference and delete the
hand-written `DashboardClient`. Split `model.ts` into `wire.ts` (DTOs, shared) and
`presentation.ts` (formatters and enum tables, browser-only). Extract one shared
operator-controller module consumed by both the CLI and the demo, and replace the dynamic-
import hack with an honest small package boundary (a `@workhorse/dashboard-contract` or
`server-embed` package) so the cycle disappears rather than hides. Do this before P0-08:
auth changes the router surface, and today that is a three-place hand-synced change.

**Done when** the surface has one definition; `grep -r 'join("/")' typescript/core/src/cli` returns nothing;
CLI and demo share one controller module; P0-08 can add an authed route by editing only the
router.

### 3.2 A versioned read surface for the dashboard

**Scope:** M/L. **Depends on:** 2.1. **Unblocks:** independent core and dashboard release
cadence; P1-05 dashboard support.

**Today.** `server/read-model.ts` (2,766 lines) issues raw SQL through its own 69-line
tagged-template builder (`server/sql.ts`) against ~14 core-private tables — `workhorse.job`,
`job_runtime`, `job_outcome`, `job_event`, `attempt_history`, `worker_registry`,
`queue_control`, `schedule_definition`, `schedule_occurrence`, `job_wait`, `job_checkpoint`,
`concurrency_policy`, `rate_limit_policy`, and the `redact_top_level_keys_v` view — all
private DDL from `sql/schema.sql`. The only guard is a runtime `assertSchemaCompatible`
against `WORKHORSE_SCHEMA_VERSION = 23`, while the peer range claims `>=0.1.0 <1`. Any core
schema change silently breaks the published dashboard until both re-release together; the
schema has two independent clients with two query styles, and the "correctness lives in SQL
functions" story covers only one of them.

**Change.** Give core an explicitly owned read surface — `dashboard_*` views or versioned
read functions in `sql/`, shipped through 2.1's migration substrate — and point the read
model at it. Cheapest honest first step, landable immediately: narrow the peer range to the
pinned schema version so the manifest stops lying.

**Done when** the dashboard queries only core-owned surfaces (or the pin is narrowed and
documented as the interim state); a core schema change that preserves the views requires no
dashboard release.

**Benchmark gate.** A dashboard-read scenario over a loaded database with EXPLAIN capture
(the harness supports it), comparing direct SQL against the views. If views regress query
plans — predicate pushdown failures are the known risk — fall back to versioned read
functions, or keep direct SQL with the narrowed pin. Evidence decides.

### 3.3 Incremental `dashboard.tsx` modularization

**Scope:** M, spread over time. **Depends on:** 3.1 helps. This is a rule, not a project.

**Today.** `dashboard/app/src/dashboard.tsx` is 6,447 lines with ~120 top-level
declarations: every page (`TasksPage:2326`, `CronPage:2694`, `QueuesPage:2805`,
`SystemPage:3532`, `EventsPage:4188`, `WorkersPage:4531`, `SettingsPage:4835`), every
widget, the date/byte/duration formatters, a module-global timezone store, and the 873-line
`useDashboardController` hook (`:5179-6052`) that hand-rolls routing (`history.pushState`),
fetching, load state, and refresh intervals persisted to `localStorage`. Only one component
is `lazy`; there is no query library and no route-level code-splitting.

**Change.** Split per page with route-level code-splitting _as pages are touched_, starting
with what P0-08 auth touches (shell, session, settings). Carve `useDashboardController` into
per-page data hooks in the same motion. Adopt a query library only if a page extraction
shows it pulls its weight. No big-bang rewrite; the file shrinks monotonically with each
touched page.

**Done when** (rolling) every newly touched page lives in its own module behind a lazy
route; `dashboard.tsx` never grows.

## Explicitly not worth doing now

- A full dashboard rewrite or framework migration. The leverage is in the contract (3.1) and
  the read surface (3.2), not the React code.
- Moving cron cadence to SQL without the 2.2 evidence.
- Retro-deriving migrations for schema versions 1 through 23. The chain starts at current.
- Replacing the `_vN` SQL function versioning convention. It is unusual, working, and
  load-bearing for compatibility.
- A full tsconfig project-references overhaul. Fix the concrete drift (0.4) and stop.
- Making the CI benchmark job a hard merge gate immediately. Trend line first; promote it
  per pull request, under pinned conditions.

## Dependency summary

```
0.1 metrics fix ──────────────┐
0.2 test harness ─ 0.3 split ─┼─ 1.2 queue split ─ 2.1 schema/migrations ─ 3.2 read surface
0.4 drift/CI ─────────────────┤        └─ 1.4 worker interface ─ (P2 SDKs)
0.5 bench CI ─────────────────┼─ 1.3 worker state machine
                              └─ 2.2 cron (gated)   2.3 partition-vs-vacuum (gated)
1.1 adapter core (independent after 0.2/0.4)
3.1 dashboard contract (independent; before P0-08) ─ 3.3 incremental UI split
```
