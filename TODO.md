# Future feature roadmap

This roadmap starts from the schema version 12 validation MVP described in
[`docs/features.md`](docs/features.md). Items are ordered by product risk and dependency, not by
feature visibility. A feature is complete only when its SQL contract, TypeScript API, integration
tests, operational diagnostics, documentation, and benchmark impact are addressed.

## Roadmap rules

- Preserve PostgreSQL as the durable authority and keep correctness-sensitive transitions in
  versioned SQL functions.
- Preserve the invariant that every accepted job has exactly one live runtime or one terminal
  outcome.
- Keep claim cost proportional to live work rather than lifetime history.
- Treat delivery as at least once. Do not claim exactly-once external effects.
- Keep recurring schedules declarative and typed. Arbitrary scheduled SQL remains out of scope.
- Require benchmark evidence before making performance or scale claims.

## Recommended next sequence

This ordering is informed by the dated competitive snapshot kept outside version control at
`docs/research/competitive-landscape-2026-08.md` (the `docs/research/` directory is
intentionally gitignored).
Priorities are the one remaining table-stakes gap. Batch processing is open as a first-class
open-source feature on PostgreSQL. The orchestration gate below P3 is satisfied, and every
durable-execution competitor now leads with agentic workloads built on primitives Workhorse
already has. The Python and Go SDKs deliberately follow orchestration: they are thin protocol
clients, so landing dependencies and signals in the versioned SQL contract first means both
languages bind a stable, complete surface instead of chasing it.

1. **P0-08 Built-in single-admin dashboard authentication**
2. **P1-05 Priority queues**
3. **P1-12 Task batches**
4. **P1-13 Debounce and throttle**
5. **P3-01 Job dependencies** and **P3-02 Child jobs and result joining**
6. **P3-03 Signals and human-in-the-loop wait tokens**
7. **P2-15 Agentic flows guide and example**
8. **P2-13 Python client and worker SDK**, then **P2-14 Go client and worker SDK**

The demo, the ORM integration packages, the operator query surface, progress, dead letters,
deadlines, the durable worker registry, the framework-neutral dashboard host, and the release and
compatibility matrix are complete.

Full OpenTelemetry support is complete, so later claim-path work can measure latency before and
after changing dispatch. P0-07 also established the published compatibility contract needed by
P2-06, P2-07, P2-13, and P2-14.

## P0: demo vertical slice and production hardening

### [x] P0-00A Core adapter and Drizzle integration package

**Depends on:** none

These are the minimum ecosystem packages required by the first demo, not the start of broad
provider coverage.

- [x] Define the stable adapter boundary needed by ORM providers and dedicated workers.
- [x] Ship a separate Drizzle ORM provider package with caller-owned transaction support.
- [x] Ship a framework-neutral dashboard host that owns its packaged UI, assets, private oRPC
      transport, authorization boundary, and mount path.
- [x] Keep ORM and web-framework dependencies out of the core package.
- [x] Add packed-package integration tests for transaction ownership, pooling, error translation,
      worker lifecycle, shutdown, and dashboard package contents.

### [x] P0-00B Demo application and complete dashboard built with Drizzle and Hono

**Depends on:** P0-00A

**Do this before adding unrelated product features.** The first demo should validate that the core,
its intended integration experience, and its complete initial operator dashboard are
understandable, installable, and useful.

- [x] Build one end-to-end Workhorse application in `demo/`, using the Drizzle adapter and Hono as
      an application-owned HTTP server.
- [x] Build a complete dashboard with queue, job, schedule, worker, failure, and health views.
- [x] Extract the dashboard into `@workhorse/dashboard` and make the demo consume the generic host
      rather than owning a separate dashboard implementation.
- [x] Use Mantine as the component foundation for the dashboard.
- [x] Use oRPC for the dashboard's typed API boundary.
- [x] Stream or efficiently refresh active state without polling every row.
- [x] Include full audit context for every mutating operator action supported by the product.
- [x] Keep the dashboard optional. Core queue operation must not depend on it.
- [x] Demonstrate transactional enqueue from a realistic Hono request handled through Drizzle.
- [x] Demonstrate installation, schema setup, enqueueing, worker execution, retries, recurring jobs,
      and complete operational inspection through the dashboard.
- [x] Make the demo runnable locally with one documented command and minimal prerequisites.
- [x] Use the demo to identify API, documentation, packaging, and developer-experience gaps.
- [x] Add a smoke test that proves the documented demo path works from a clean checkout.

### [x] P0-01 Automated history retention

**Depends on:** none

- [x] Precreate UTC-daily `job_event` and `attempt_history` partitions for the current day plus three future days through `prepare_history_partitions_v1`.
- [x] Add bounded retirement or archival of completed history partitions.
- [x] Define independent retention for job identity, terminal outcomes, events, attempts, and
      schedule occurrences.
- [x] Default every retained category to 14 days while keeping each window configurable in PostgreSQL.
- [x] Split partition preparation, daily history retention, and terminal/idempotency cleanup into
      independently locked tasks with persisted cadence state and one global IANA timezone.
- [x] Gate terminal identity deletion on a persisted history-retention watermark so cleanup never
      outruns retained attribution after removing reverse history foreign keys.
- [x] Refuse unsafe retention that could remove live jobs or break lifecycle attribution.
- [x] Report retention lag, default-partition usage, and the oldest retained boundary in health
      output.

### [x] P0-02 Production telemetry

**Depends on:** none

- [x] Add OpenTelemetry spans for enqueue, claim, handler execution, heartbeat, retry, completion,
      recovery, maintenance, and schedule synchronization.
- [x] Expose low-cardinality metrics for queue depth, age, throughput, failures, retries, expired
      leases, claim latency, handler latency, and maintenance drift.
- [x] Define trace and metric attribute cardinality limits. Never use job IDs as metric labels.
- [x] Propagate caller trace context through job metadata without mutating the job payload.
- [x] Document dashboards and alert thresholds for stalled queues and degraded maintenance.

### [x] P0-03 Configurable worker concurrency

**Depends on:** none

Configurable concurrency must ship focused lease, shutdown, and benchmark diagnostics, but it does
not depend on the later full OpenTelemetry and metrics package.

- [x] Accept integer `WorkerOptions.concurrency` values from 1 through 100, default to 1, and expose
      readonly `worker.concurrency` plus runtime state reporting concurrency, active slots, draining,
      and both local and operator-requested pause.
- [x] Preserve per-job heartbeat, abort, and fence ownership while handlers overlap.
- [x] Fill only free slots with serial claims, stop at the first null claim, and never exceed the
      configured handler bound.
- [x] Make pause block claims and make shutdown stop new claims while draining all in-flight handlers.
- [x] Add the invariant-gated `worker-concurrency` operational scenario for concurrency levels,
      claim-inclusive throughput timing, overlap and slot bounds, connection/claim pressure proxies,
      lease safety, first-null behavior, pause, and graceful shutdown. A recorded live artifact is still
      required before making performance or scale claims.

### [x] P0-03A Dedicated production worker process

**Depends on:** P0-03

- [x] Add framework-neutral worker process definitions and startup orchestration.
- [x] Add a `workhorse worker --config` CLI for compiled application configuration modules.
- [x] Handle the first `SIGINT`/`SIGTERM` by stopping claims and draining active handlers while
      heartbeats continue.
- [x] Add a bounded deadline, immediate second-signal exit, process-fatal worker-loop failures, and
      idempotent adapter cleanup.
- [x] Add optional status-only liveness/readiness probes that report draining without exposing
      application ingress.
- [x] Document dedicated workers as the supported topology and one multi-slot coordinator per queue
      or policy group as the benchmark-backed default within a process.

### [x] P0-03B Durable worker fleet registration

**Depends on:** P0-03A

Operator surfaces read worker identity and runtime state from process-local `Worker` objects, which
made the fleet invisible to any process that did not host it. That was the single design decision
forcing the dashboard and the workers into one process.

- [x] Add `workhorse.worker_registry` with one row per live worker, keyed by the durable worker id.
- [x] Split ownership: the worker publishes `concurrency`, `active_slots`, and `draining`;
      PostgreSQL owns the operator-requested `paused` flag, returned by the same round trip.
- [x] Add `Queue.registerWorker`, `deregisterWorker`, `setWorkerPaused`, `listWorkers`, and
      `pruneWorkerRegistry`, plus `WorkerOptions.registryIntervalMs` with an explicit opt-out.
- [x] Make operator pause cooperative and process-scoped: applied at the next refresh, never
      interrupting a running handler, not clearable by a local `resume()`, and cleared when the
      worker process is restarted or replaced. Durable "stop this work" remains queue pause.
- [x] Default worker identity to `<hostname>-<pid>-<random>` so a fleet view is readable, and
      document that the default is deliberately unstable across restarts.
- [x] Publish a final draining registration on stop, deregister on graceful shutdown, and age out
      plus prune a killed worker.
- [x] Read the dashboard fleet from the registry, deleting the process-local worker controller, and
      keep the relation off the claim path.

### [x] P0-03C Framework-neutral dashboard host

**Depends on:** P0-00B

- [x] Move asset serving, HTML templating, runtime-config injection, oRPC prefixing, and the SSE
      stream into a `Request`/`Response` host in `@workhorse/dashboard`.
- [x] Change the mount input from a Hono worker-lifecycle object to `{ database, queue }` so mounting
      never requires a worker runtime.
- [x] Add a Connect-style Node bridge so Express, Connect, and Fastify integrate without new packages.
- [x] Fall through untouched on requests outside the mount path.

### [x] P0-04 Notification-assisted dispatch

**Depends on:** P0-03

Use `workhorse_jobs` to wake a claiming worker instead of polling. The notification stays a wake
hint, and polling stays the source of truth.

- [x] Listen to `workhorse_jobs` notifications as wake hints while retaining polling as the source
      of truth.
- [x] Coalesce wakeups and reconnect safely after PostgreSQL connection loss.
- [x] Bound idle polling so lost notifications cannot strand ready work.
- [x] Measure idle database load and enqueue-to-claim latency against polling-only behavior.

### [x] P0-05 Built-in retry policies

**Depends on:** none

- [x] Add fixed, exponential, and decorrelated-jitter policies to enqueue and recurring schedule
      definitions, claims, snapshots, demo seeds, the task drawer, and lifecycle timelines.
- [x] Persist normalized policy inputs and the previous decorrelated-jitter delay so PostgreSQL owns
      deterministic selection across replay, lease recovery, and `Queue` recreation.
- [x] Preserve numeric `Queue.fail` and `WorkerOptions.retryDelayMs` as higher-precedence manual
      overrides without bypassing retry-budget enforcement.
- [x] Cap delays at 365 days, require integer multipliers from 1 through 100, require maxima at least
      initial/base delays, and reject overflow or invalid policy configuration in PostgreSQL.
- [x] Cover policy delay sequences, handler failure, lease recovery, compatibility defaults,
      provenance events, manual overrides, queue recreation, and terminal exhaustion with deterministic
      integration tests and the extended `retry-paths` lifecycle benchmark.

### [x] P0-06 Consistent operational snapshots

**Depends on:** P0-02

- [x] Provide a transactionally consistent queue-health snapshot for correctness-sensitive counts.
      Every exact value is read in one SQL statement and stamped `capturedAt`.
- [x] Separate exact transactional values from lagging PostgreSQL statistics, which moved under
      `QueueHealth.observations`.
- [x] Add health budgets and machine-readable degraded reasons. `evaluateQueueHealth` owns the
      thresholds; the CLI exit code, the benchmark invariants, and the dashboard verdict consume
      the same reasons.
- [x] Keep snapshot latency bounded on large runtime and history relations. Terminal and bucket
      counts stop at a scan cap with explicit lower-bound flags, and the smoke-profile
      `health-snapshot` scenario records the latency evidence.

### [x] P0-06B Installation path for existing applications

**Depends on:** P0-03C

- [x] Add `workhorse init` to detect ORM, framework, and package manager, write exactly one worker
      configuration file, and print the dashboard mount for the detected framework.
- [x] Never edit `package.json`, application routes, or anything else `init` does not own.
- [x] Promote schema installation to `workhorse schema install` and `workhorse schema status`,
      resolving the database URL from `--database-url`, `WORKHORSE_DATABASE_URL`, then `DATABASE_URL`.
- [x] Keep installation clean-database only and keep refusing to modify an existing schema. Ordered
      migrations remain P2-07.
- [x] Add `workhorse dashboard` to serve the operator console as its own process against any
      database, binding loopback and read-only by default with explicit, warned opt-outs. The
      dashboard package is an optional runtime dependency so worker-only installs stay lean.
- [x] Record worker placement (`hostname`, `pid`) separately from worker identity so a fleet view
      answers "which host" even when a deployment configures stable worker names.
- [x] Share one `renderDashboardHtml` between the request host and the development harness so the
      runtime-configuration contract cannot drift between them.
- [x] Make the demo a plain consumer: it serves the packaged dashboard bundle in development and
      production, owns no Vite config or browser entry, and needs no React dependency. The UI
      harness moved into `@workhorse/dashboard`, which is the package it develops.
- [ ] Reconsider a single shared `workhorse.config.ts` consumed by both the worker CLI and the
      dashboard mount once P2-07 defines what configuration a migration step also needs.
- [ ] Replace the raster brand marks with vector sources so the dashboard's library build no longer
      ships copied PNGs. Needs the original vector artwork; tracing the rasters would change the
      brand.

### [x] P0-07 Release and compatibility matrix

**Depends on:** none

- [x] Test supported Node.js and PostgreSQL versions in CI. `src/support.ts` owns the matrix,
      `.github/workflows/ci.yml` runs the full suite across every Node 22/24 by PostgreSQL 15-18
      combination, and `test/support-matrix.test.ts` fails when the constants, the workflow, the
      package `engines` fields, and the documentation disagree.
- [x] Publish package provenance, changelog, upgrade notes, and protocol compatibility guarantees.
      `.github/workflows/release.yml` verifies the tag against every manifest and the changelog,
      runs `pnpm check`, and publishes each packed tarball with `npm publish --provenance`.
      `CHANGELOG.md` carries versions, required schema version, and upgrade notes;
      `docs/compatibility.md` and the site's Compatibility page carry the protocol guarantees.
- [x] Add install and smoke tests against a packed package rather than source-only imports. The
      existing `test:packed` consumer now also runs on both supported Node majors in CI, alongside
      `test:demo-smoke` and `test:site-smoke`.
- [x] Define the production-support boundary separately from benchmark validation. Supported means
      exercised by the CI matrix; installation refuses PostgreSQL below the minimum with the
      server's own version, a newer-than-tested major runs but claims nothing, and benchmark
      evidence stays one fixed configuration that implies neither.

### [ ] P0-08 Built-in single-admin dashboard authentication

**Depends on:** P0-03C, P0-06B

The embedded host already accepts an application-owned `authorize` callback, but the standalone
dashboard has no identity provider to delegate to. Give standalone deployments a secure baseline
without treating one shared administrator as multi-user RBAC.

- [x] Add an optional single-admin username and password mode configured through environment
      variables or equivalent explicit server options.
- [x] Store only a password hash in production configuration, accept secrets through files where
      container platforms support them, and keep any plaintext-password convenience explicitly
      development-only.
- [ ] Exchange a successful login for a bounded `Secure`, `HttpOnly`, and explicitly `SameSite`
      session cookie; add logout, expiry, credential rotation, origin checks, and login throttling.
- [ ] Derive the audit actor from the authenticated server session. Never trust the browser's
      `auditActor` or mutation payload as identity evidence.
- [x] Keep host-supplied authorization as an alternative mode for embedded applications that
      already own sessions. Reject ambiguous configurations that enable both modes.
- [ ] Publish the authenticated standalone service as a supported container artifact so Python and
      Go users do not need a Node.js application or npm installation to run the dashboard.
- [ ] Allow an explicit local-development bypass only while the listener is bound to loopback or a
      Unix socket, and refuse that bypass for a remotely reachable listener.
- [ ] Cover HTML, asset, private RPC, mutation, expiry, rotation, CSRF, brute-force, and proxy/TLS
      behavior in packed-package tests and deployment documentation.

## P1: job controls and reliability

### [x] P1-01 Enqueue idempotency keys

**Depends on:** none

- [x] Support caller-scoped idempotency keys with a default 24-hour retention window and explicit
      bounded TTL override.
- [x] Return the existing job identity when the same key and equivalent request are repeated, without
      duplicate job, event, FIFO, or notification side effects.
- [x] Reject retained key reuse with a materially different request through structured redacted conflict
      details.
- [x] Preserve atomic behavior for transactional and batch enqueue, including duplicates within one
      batch and whole-batch rollback on conflict.
- [x] Release bindings on expiry and queued/scheduled purge, and clean expired bindings before terminal
      identity pruning.
- [x] Document how enqueue deduplication differs from exactly-once handler effects and cover the ingress
      transitions with the `idempotent-ingress` operational benchmark scenario.

### [x] P1-02 Cancellation

**Depends on:** P0-03

- [x] Cancel scheduled, ready, and durable-wait continuations immediately; request cancellation for
      active jobs without revoking their lease out of band.
- [x] Deliver active requests additively through `heartbeat_v2` and handler `AbortSignal`, while
      retaining boolean `heartbeat_v1` compatibility.
- [x] Require the exact active worker and fence to acknowledge cancellation; if the handler ignores
      the signal, materialize the requested cancellation when its lease expires instead of retrying.
- [x] Materialize one immutable canceled outcome and lifecycle event, with canceled attempt history
      only when an attempt actually started; repeated requests do not duplicate terminal evidence.
- [x] Fence completion, failure, checkpoint, wait, heartbeat, and stale acknowledgement writes;
      cancellation versus completion or failure is first-committer-wins.
- [x] Keep `requestedBy` as bounded attribution rather than authorization, and explicitly avoid
      forced interruption, exactly-once effects, or a claim that JavaScript can be preempted.
- [x] Cancel only the targeted recurring occurrence; its schedule definition remains enabled and
      later occurrences continue independently.
- [x] Cover immediate, cooperative, ignored-signal expiry, race, history, duplicate, stale-fence,
      query-timing, and recurring behavior in the `cancellation-lifecycle` operational scenario.

### [x] P1-03 Deadlines and execution timeouts

**Depends on:** P1-02

- [x] Support enqueue deadlines and per-attempt execution timeouts.
- [x] Prevent expired jobs from being newly claimed.
- [x] Fence late handler completion after timeout or deadline termination.
- [x] Distinguish timeout, deadline, cancellation, and lease-expiry outcomes.
- [x] Surface deadline pressure in health and telemetry.

### [x] P1-04 Dead-letter views and redrive

**Depends on:** P1-01, P1-02

- [x] Add query APIs for terminal failures without copying them into dispatch indexes.
- [x] Add audited redrive that creates a new job linked to the failed source job.
- [x] Support bounded bulk redrive with filters and dry-run output.
- [x] Preserve the original immutable outcome and complete redrive lineage.
- [x] Define idempotency behavior for repeated redrive requests.

### [ ] P1-05 Priority queues

**Depends on:** none

- [ ] Add a bounded priority range with FIFO ordering inside each priority.
- [ ] Preserve selective ready indexes and live-work claim scaling.
- [ ] Define promotion, retry, and redrive priority behavior.
- [ ] Add starvation controls or document strict-priority starvation explicitly.
- [ ] Benchmark index size and claim latency under mixed priorities.

### [x] P1-06 Queue concurrency policies

**Depends on:** P0-03

- [x] Limit active jobs by queue and optionally by an application-defined concurrency key.
- [x] Make admission atomic across competing workers.
- [x] Recover capacity automatically after lease expiry or worker loss.
- [x] Expose blocked-ready depth and policy utilization.
- [x] Prove that policy checks do not turn claims into lifetime-table scans.

### [x] P1-07 Rate limiting

**Depends on:** P1-06

- [x] Add queue and key-scoped token-bucket limits with PostgreSQL-owned time semantics.
- [x] Coordinate limits transactionally across worker processes.
- [x] Preserve bounded empty-claim backoff when work is ready but rate-limited.
- [x] Report throttled depth, next eligibility, available tokens, and configured throughput.
- [x] Test atomic bursts, continuous refill, keyed work conservation, and crash-safe state.

### [x] P1-08 Payload contracts and limits

**Depends on:** none

- [x] Support optional per-job-type payload and result validators.
- [x] Enforce configurable payload and result size limits before durable writes.
- [x] Version contracts without making historical payloads unreadable.
- [x] Redact configured sensitive fields from logs, traces, and operator views.
- [x] Extend the `retry-paths` lifecycle benchmark with versioned validation, redaction invariants,
      and full enqueue, claim, and completion timings without making an unrecorded overhead claim.

### [x] P1-09 Progress and job metadata

**Depends on:** P1-02

Immutable checkpoint outputs can already serve as inspectable interim artifacts in the demo task drawer,
but they are not mutable progress. P1-09 remains open for a distinct fenced, bounded update contract.
Progress remains observable through the query and dashboard contracts; full trace and metric export is a
later integration rather than a prerequisite.

- [x] Add fenced, bounded progress updates for active jobs.
- [x] Keep mutable progress out of immutable payload and outcome fields.
- [x] Define update frequency and size limits to control write amplification.
- [x] Expose latest progress through lookup APIs and telemetry.

### [x] P1-10 Explicit durable checkpoints

**Depends on:** none

- [x] Persist immutable named JSON results for a stable job identity across retries and terminal
      materialization.
- [x] Fence checkpoint writes against the exact active, unexpired worker ownership generation.
- [x] Preserve attempt, fence, worker, and creation-time provenance and append a lifecycle event.
- [x] Expose low-level Queue read/write methods and a handler helper that reuses completed names and
      coalesces overlapping same-name calls.
- [x] Reject repeated names with materially different values and document the external-effect crash
      window without making an exactly-once claim.
- [x] Expose schema v11 terminal results or failure evidence and checkpoint-backed interim artifacts in the
      existing task drawer, including representative persistent-failure seeds between retries.

### [x] P1-11 Named durable timer waits

**Depends on:** P1-10

- [x] Persist immutable relative or absolute timer boundaries keyed by stable job and wait names.
- [x] Fence scheduling against the exact active, unexpired ownership generation and atomically release
      the lease into the existing scheduled index.
- [x] Resume in the same logical attempt with a new fence, one final attempt-history row, and explicit
      scheduled, elapsed, and replay lifecycle events.
- [x] Expose Queue reads plus `context.sleep`, `sleepUntil`, and `getWait` with typed conflict, lease,
      and per-job limit failures.
- [x] Bound names, durations, future horizons, and retained waits, and document restart-from-entry
      semantics without claiming continuation or workflow persistence.

### [x] P1-12 Task batches

**Depends on:** P0-03, P1-06

Batch processing — several ready jobs delivered to one handler invocation — exists today only as
a paid tier (BullMQ Pro, River Pro) or a platform primitive (Inngest). No open-source
PostgreSQL queue offers it. Workhorse already has batch enqueue; this is batch claim.

- [x] Define batch claim: up to a bounded number of ready jobs of one queue and job type
      delivered to one handler invocation, with a configured maximum batch size and a bounded
      linger window before a partial batch dispatches.
- [x] Preserve per-job lifecycle: every job in a batch keeps its own identity, lease, fence,
      heartbeat, retry budget, and independent success, failure, or cancellation outcome.
- [x] Keep batch claims on the selective ready indexes and prove claim cost stays proportional
      to live work.
- [x] Define how a batch interacts with priorities, concurrency policies, and rate limits, and
      document whether a batch consumes one policy slot or one per job.
- [x] Benchmark batch claim throughput against serial claims in an operational scenario before
      making any performance claim.

### [x] P1-13 Debounce and throttle

**Depends on:** P1-01

Named coalescing primitives on top of the existing idempotency machinery. Inngest, pg-boss,
Trigger.dev, and DBOS all name these; Workhorse currently only rejects or replays.

- [x] Add debounce semantics: a repeated key within the window replaces the pending job's
      payload and either resets or preserves its run time, chosen explicitly by the caller.
- [x] Add throttle semantics: at most one accepted job per key per window, with later
      equivalent requests coalesced into the retained job rather than rejected.
- [x] Keep PostgreSQL the owner of window arithmetic and define behavior when the keyed job is
      already active or terminal.
- [x] Report coalescing in structured results, debug logs, and queue-level metrics. Throttle omits
      durable events because repeated requests could amplify audit writes without changing job state.
- [x] Cover replace, preserve, coalesce, and concurrent-enqueue races with integration tests
      and a benchmark scenario.

## P2: operator and ecosystem experience

### [x] P2-01 Query and listing API

**Depends on:** P0-01, P1-04

- [x] Add cursor-based listing by queue, type, lifecycle state, and time range.
- [x] Keep operational reads away from claim-critical indexes.
- [x] Support lifecycle timeline retrieval from events and attempt history.
- [x] Define bounded payload inclusion and redaction controls.

### [ ] P2-02 Administrative CLI and TUI

**Depends on:** P2-01

- [ ] Add commands to inspect jobs, queues, schedules, failures, and maintenance state.
- [ ] Add guarded cancellation, redrive, pause, and resume operations as those APIs become stable.
- [ ] Require explicit target environment and confirmation for destructive operations.
- [ ] Provide JSON output for automation and human-readable output for operators.
- [ ] Build a TUI application with basic job, queue, schedule, failure, worker, and health views.
- [ ] Reuse the same administrative client and safety checks across the non-interactive CLI and TUI.

### P2-03 Web operator console (moved to P0-00B)

The complete dashboard scope was moved into the first demo so the product's operator experience is
validated before unrelated feature expansion. The P2-03 identifier remains here only to preserve
roadmap references; all implementation requirements now live under P0-00B.

### [ ] P2-04 Premium SSO, RBAC, and multi-user audit

**Depends on:** P0-08

- [ ] Integrate external identity providers through a documented SSO protocol and keep this
      capability outside the baseline single-admin distribution.
- [ ] Define read-only, operator, scheduler-deployer, and administrator roles.
- [ ] Enforce authorization outside claim-critical SQL paths.
- [ ] Record the authenticated human identity and append-only audit events for administrative
      mutations.
- [ ] Preserve the built-in single-admin mode for installations that do not need SSO or multiple
      roles.
- [ ] Document direct-database access assumptions and least-privilege grants.

### [ ] P2-05 Multi-tenancy

**Depends on:** P1-06, P1-07, P2-04

- [ ] Define tenant identity and isolation boundaries across jobs, queues, schedules, and telemetry.
- [ ] Support tenant-scoped concurrency, rate, and retention policies.
- [ ] Prevent cross-tenant reads and operator actions.
- [ ] Benchmark high-tenant-cardinality index and planning behavior.

### [ ] P2-06 Additional ORM integration packages

**Depends on:** P0-00A, P0-03C, P0-07, P1-01

Framework packages are intentionally outside the roadmap. Applications use their existing
dependency injection for `Queue`, while the generic dashboard host covers Fetch-native and
Connect-style servers. ORM transaction ownership still differs enough to justify provider packages.

- [ ] Evolve the adapter interface validated by the supported ORM providers without moving lifecycle
      correctness out of SQL.
- [x] Expand beyond Drizzle to a small set of popular TypeScript ORM providers, with transactional
      enqueue support and provider-specific integration tests.
- [x] Select and document Prisma, TypeORM, and Kysely as the next ORM support matrix.
- [x] Ship each ORM provider as a separate optional package rather than
      adding ecosystem dependencies to the core package.
- [ ] Provide transactional enqueue examples for common PostgreSQL clients and supported ORMs.
- [ ] Test transaction ownership, connection pooling, shutdown, and error translation.
- [x] Keep the core package free of ORM and framework dependencies.

### [ ] P2-07 Schema migration framework

**Depends on:** P0-07

**Start when:** the core SQL and TypeScript contracts have shipped in at least one supported release
and the compatibility policy is stable enough to define a real upgrade boundary.

- [ ] Replace clean-install-only schema management with ordered, transactional migrations.
- [ ] Record installed migration and protocol versions independently.
- [ ] Define expand/contract rules for changes that span application deployments.
- [ ] Add upgrade tests from every supported released schema version.
- [ ] Provide backup, rollback, and failed-migration recovery guidance.
- [ ] Define the supported upgrade window only after real released versions require it.

### [ ] P2-08 Example application suite

**Depends on:** P0-00B, P2-06

- [ ] Add focused, runnable examples alongside the full product demo.
- [ ] Include at least one core-only example and one example per supported ORM provider.
- [ ] Keep examples focused on realistic application flows rather than isolated API snippets.
- [ ] Run example smoke tests in CI so package releases cannot silently break documented setups.
- [ ] Link every integration package to its corresponding example and setup guide.

### [ ] P2-09 Public HTTP ingress API and clients

**Depends on:** P0-07, P2-01

**Design before implementation.** Workhorse currently exposes no supported application ingress over
HTTP. The demo must not become the accidental contract. Define a reusable, versioned ingress API
and its authorization boundary before exposing job operations over HTTP. Ingress remains separate
from the dashboard, administrative API, and private oRPC transport.

- [ ] Define the supported enqueue, lookup, cancellation, signal, and result surface independently
      from the dashboard's private oRPC transport; include only operations whose core contracts are
      stable when implementation begins.
- [ ] Specify a versioned wire contract, idempotency, authentication, caller authorization, audit
      context, error mapping, pagination, redaction, request limits, and compatibility semantics.
- [ ] Decide package boundaries for the transport-neutral API contract, generated clients, a
      standalone ingress service, and optional JavaScript framework mounts.
- [ ] Support mounting the future public API either at the application root or below a caller-owned
      namespace such as `/workhorse`, without taking over unrelated host routes or middleware in the
      namespaced case.
- [ ] Give ingress and administration different listeners, credentials, authorization policies,
      rate limits, and deployment guidance. Enabling one must never expose the other.
- [ ] Preserve caller-owned PostgreSQL transactions as the preferred path for atomic enqueue; state
      clearly that an HTTP request cannot join the caller's database transaction.
- [ ] Keep schema installation, migrations, seed data, and application-specific job creation outside the API
      package.
- [ ] Add packed-consumer tests proving independent installation, namespace mounting, authorization, and
      upgrades across supported API versions.

### [ ] P2-10 Long-horizon statistics rollups

**Depends on:** P0-01, P0-02, P2-01

The per-minute tier is implemented: `job_stat_bucket`, `job_stat_state`, `aggregate_stats_v1`,
`rollup_stats_v1`, `stat_buckets_v1`, and the dashboard system page reading through them. What
remains is the long-horizon tier — coarser buckets, a retention ladder, and the benchmarks that
would justify stabilizing the schema.

- [x] Define a per-minute aggregate table for low-cardinality queue, job-type, state, latency,
      retry, cancellation, and throughput dimensions.
- [ ] Add hourly and daily tiers derived from the minute tier, with a tier-aware read path.
- [x] Specify job-level versus attempt-level metric semantics and mergeable histogram buckets before
      stabilizing the schema.
- [x] Recompute bounded time buckets idempotently so late terminal outcomes and retries converge
      without double counting.
- [x] Persist a rollup watermark and prohibit raw-history retention from crossing it. A stalled
      rollup must degrade health rather than silently create incomplete long-term statistics.
- [x] Stitch recent raw detail and older aggregates in dashboard queries without scanning retained
      job history.
- [x] Give aggregates their own configurable, bounded retention category, independent of the
      identity chain so they may outlive the history they were derived from.
- [ ] Add mergeable latency percentiles. A fixed-edge histogram was implemented and removed: it cost
      accuracy at every scale and was slower than the exact self join below roughly 1M jobs/day.
- [ ] Benchmark write amplification, query latency, and storage on production-shaped payloads. The
      current evidence is a synthetic seed at 200k and 2M jobs/day, recorded in
      `docs/rolling-statistics.md`.
- [ ] Decide whether worker and tag dimensions belong in the rollup. Both are currently served by
      live queries because their cardinality is unbounded in a way queue and job type are not.

### [ ] P2-12 Database-authoritative configuration and the operator settings page

**Depends on:** P2-01

**Design recorded in** [ADR 0020](docs/decisions/0020-database-authoritative-configuration.md).
Decide the ownership question before building any form field: it determines whether the page can be
editable at all.

- [x] Make `syncRetentionPolicy` and `syncMaintenancePolicy` seed rather than overwrite, with an
      explicit opt-in that restores assert-on-deploy semantics for infrastructure-as-code callers.
- [x] Record provenance per policy value so sync can skip operator-set values, and expose an explicit
      revert-to-application-default that clears the override.
- [ ] Move the rolling-statistics cadence out of `WorkerOptions` and into `maintenance_policy`
      alongside the other three maintenance cadences, and move the rollup group limit and recompute
      window into policy as well.
- [x] Build one settings page grouped by ownership — editable here, set at deploy, per-object toggles
      — rather than by topic. Process-owned options are shown read-only with provenance; omitting
      them silently would imply they do not exist.
- [ ] Derive recommendations from measured state rather than restating defaults. The queue already
      knows its enqueue rate, retention lag, rollup watermark, partition spill, and HOT-update
      ratios. The terminal-cleanup throughput ceiling — roughly 288k jobs/day at the default limit
      and cadence — is the worked example: it was found by benchmarking and should have been
      reported by the product.
- [x] Require an impact preview for destructive edits, computed from the same boundary queries health
      already runs. Shortening a retention window deletes irreversibly on the next pass; pausing a
      queue does not, and the two must not look alike.
- [x] Reuse the existing operator-mutation contract and audit context rather than adding a second
      authorization path.

### [ ] P2-11 Cold history export

**Depends on:** P2-10, P2-04

- [ ] Design an optional exporter for finalized raw history and/or rollup buckets after the rollup
      watermark makes deletion safe.
- [ ] Define immutable object naming, checksums, manifests, encryption, access control, retries, and
      idempotent resume semantics without coupling core dispatch to object storage.
- [ ] Make export completion an explicit retention interlock only when cold export is enabled.
- [ ] Provide restore and offline-query guidance without promising transparent hot/cold dashboard
      queries in the first version.
- [ ] Keep storage providers in optional packages and preserve PostgreSQL-only operation by default.

### [ ] P2-13 Python client and worker SDK

**Depends on:** P0-07

Python applications use the same PostgreSQL protocol as TypeScript applications. They run the
standalone dashboard for administration rather than embedding or reimplementing its private
transport.

- [ ] Publish an enqueue client that supports caller-owned transactions through a documented set of
      PostgreSQL drivers.
- [ ] Publish sync and async worker runtimes with handler registration, bounded concurrency,
      cancellation, heartbeats, graceful drain, telemetry context, and typed lifecycle failures.
- [ ] Implement lifecycle operations through the versioned SQL functions and canonical JSON
      contracts. Do not port correctness-sensitive transitions into Python.
- [ ] Assert schema compatibility before clients mutate state or workers claim jobs, and test the
      supported Python, PostgreSQL, and driver matrix in CI.
- [ ] Ship installation, dedicated-worker, transaction, retry, checkpoint, wait, and standalone
      dashboard examples as tested package artifacts.

### [ ] P2-14 Go client and worker SDK

**Depends on:** P0-07

Go applications use the same PostgreSQL protocol as TypeScript applications. They run the
standalone dashboard for administration rather than embedding or reimplementing its private
transport.

- [ ] Publish an enqueue client that supports caller-owned transactions through a documented set of
      PostgreSQL drivers.
- [ ] Publish a worker runtime with handler registration, bounded concurrency, context cancellation,
      heartbeats, graceful drain, telemetry context, and typed lifecycle failures.
- [ ] Implement lifecycle operations through the versioned SQL functions and canonical JSON
      contracts. Do not port correctness-sensitive transitions into Go.
- [ ] Assert schema compatibility before clients mutate state or workers claim jobs, and test the
      supported Go, PostgreSQL, and driver matrix in CI.
- [ ] Ship installation, dedicated-worker, transaction, retry, checkpoint, wait, and standalone
      dashboard examples as tested module artifacts.

### [ ] P2-15 Agentic flows guide and example

**Depends on:** P3-01, P3-02, P3-03

Every durable-execution competitor now markets to AI agents on primitives Workhorse already
ships or has scheduled: checkpoints, durable timer waits, fenced progress, keyed rate limits,
and — after P3 — dependencies, fan-out/fan-in, and signals. This item is composition and
documentation, not new SQL.

- [ ] Document an agent loop built from existing primitives: checkpoints for memoized model
      and tool steps, durable timer waits, signals and human-in-the-loop wait tokens, fenced
      progress for streaming visibility, and keyed rate limits per external API.
- [ ] Ship one runnable agent example in the example suite with explicit at-least-once
      framing. Make no exactly-once, persisted-continuation, or "durable stack" claims.
- [ ] Follow the documentation rules: guide layer states no numbers, one reference link,
      every identifier verified against source.

## P3: orchestration

The original gate — stable cancellation, idempotency, concurrency controls, telemetry, and
operator tooling — is satisfied as of schema version 26, so P3-01, P3-02, and P3-03 are
unblocked and pulled into the recommended sequence above. P3-04 remains deferred until the
three primitives below have shipped and proven their contracts.

### [x] P3-01 Job dependencies

**Depends on:** P1-01, P1-02, P1-06, P2-01

- [x] Model dependency edges without putting blocked jobs in ready dispatch indexes.
- [x] Atomically release dependents when prerequisites reach accepted terminal states.
- [x] Define failure, cancellation, fan-in, and dependency-cycle behavior.
- [x] Expose dependency state and lineage through query APIs.

### [x] P3-02 Child jobs and result joining

**Depends on:** P3-01

- [x] Allow a handler transaction to create linked child jobs.
- [x] Define parent completion behavior for zero, one, or many children.
- [x] Bound fan-out and result materialization.
- [x] Preserve lineage across retry, cancellation, redrive, and retention.

### [ ] P3-03 Signals and human-in-the-loop wait tokens

**Depends on:** P3-01, P0-08

The former P2-04 dependency is deliberately dropped: authenticated single-admin identity plus
audited attribution is a sufficient authorization baseline for signals, and premium SSO/RBAC
refines who may send them later without changing the primitive.

- [ ] Add idempotent, attributed signals addressed to a stable waiting execution.
- [x] Add completable wait tokens for human-in-the-loop steps: a handler creates a named
      token and suspends its lease; an operator or external caller completes it with a
      bounded payload through the dashboard or API.
- [ ] Define signal and token retention, timeout, cancellation, and duplicate-delivery
      semantics.
- [ ] Keep waiting executions out of ready and active dispatch indexes.
- [ ] Audit every accepted and rejected signal and token completion.

### [ ] P3-04 Workflow runtime

**Depends on:** P3-01, P3-02, P3-03

- [ ] Define a deterministic workflow state model and versioning contract.
- [ ] Support retryable activities without implying exactly-once external effects.
- [ ] Add replay, migration, cancellation, compensation, and operator-debugging semantics.
- [ ] Build dedicated correctness and long-history benchmarks before production claims.

## Deferred or rejected

- [ ] Reconsider arbitrary scheduled SQL only if Workhorse intentionally expands beyond typed job
      orchestration. It is not part of the current product direction.
- [ ] Reconsider compatibility write views only with a proven single-authority migration design.
      Dual-write compatibility is explicitly rejected.
- [ ] Reconsider exactly-once marketing only if the claim is narrowly scoped to a transactionally
      provable boundary. External effects remain at least once.
