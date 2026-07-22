# Future feature roadmap

This roadmap starts from the schema version 2 validation MVP described in
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

1. **P0-00A Drizzle and Hono integration packages**
2. **P0-00B Demo application built with Drizzle and Hono**
3. **P0-01 Automated history retention**
4. **P0-02 Production telemetry**
5. **P0-03 Configurable worker concurrency**
6. **P0-04 Notification-assisted dispatch**
7. **P0-05 Built-in retry policies**

## P0: demo vertical slice and production hardening

### [x] P0-00A Drizzle and Hono integration packages

**Depends on:** none

These are the minimum ecosystem packages required by the first demo, not the start of broad
provider coverage.

- [x] Define the stable adapter boundary needed by both ORM providers and framework integrations.
- [x] Ship a separate Drizzle ORM provider package with caller-owned transaction support.
- [x] Ship a separate Hono integration package with configuration, startup, and graceful shutdown
      behavior.
- [x] Keep Drizzle and Hono dependencies out of the core package.
- [x] Add packed-package integration tests for transaction ownership, pooling, error translation,
      worker lifecycle, and shutdown.

### [ ] P0-00B Demo application built with Drizzle and Hono

**Depends on:** P0-00A

**Do this before adding unrelated product features.** The first demo should validate that the core
and its intended integration experience are understandable, installable, and useful.

- [ ] Build one small end-to-end Hono application in `examples/` using the Drizzle provider and Hono
      integration packages.
- [ ] Build the demo frontend with shadcn/ui so the first runnable vertical slice validates the
      intended component foundation before the operator console.
- [ ] Demonstrate transactional enqueue from a realistic Hono request handled through Drizzle.
- [ ] Demonstrate installation, schema setup, enqueueing, worker execution, retries, recurring jobs,
      and basic operational inspection.
- [ ] Make the demo runnable locally with one documented command and minimal prerequisites.
- [ ] Use the demo to identify API, documentation, packaging, and developer-experience gaps.
- [ ] Add a smoke test that proves the documented demo path works from a clean checkout.

### [ ] P0-01 Automated history retention

**Depends on:** none

- [x] Precreate weekly `job_event` and `attempt_history` partitions four weeks ahead through `maintain_v1`.
- [ ] Add bounded retirement or archival of completed history partitions.
- [ ] Define independent retention for job identity, terminal outcomes, events, attempts, and
      schedule occurrences.
- [ ] Refuse unsafe retention that could remove live jobs or break lifecycle attribution.
- [ ] Report retention lag, default-partition usage, and the oldest retained boundary in health
      output.

### [ ] P0-02 Production telemetry

**Depends on:** none

- [ ] Add OpenTelemetry spans for enqueue, claim, handler execution, heartbeat, retry, completion,
      recovery, maintenance, and schedule synchronization.
- [ ] Expose low-cardinality metrics for queue depth, age, throughput, failures, retries, expired
      leases, claim latency, handler latency, and maintenance drift.
- [ ] Define trace and metric attribute cardinality limits. Never use job IDs as metric labels.
- [ ] Propagate caller trace context through job metadata without mutating the job payload.
- [ ] Document dashboards and alert thresholds for stalled queues and degraded maintenance.

### [ ] P0-03 Configurable worker concurrency

**Depends on:** P0-02

- [ ] Allow one worker process to execute a bounded number of jobs concurrently.
- [ ] Preserve per-job heartbeat and fence ownership while handlers overlap.
- [ ] Add fair queue scheduling and avoid claim bursts that exceed available handler slots.
- [ ] Make shutdown stop new claims and wait for all in-flight handlers.
- [ ] Benchmark throughput, connection use, lease safety, and shutdown behavior across concurrency
      levels.

### [ ] P0-04 Notification-assisted dispatch

**Depends on:** P0-03

- [ ] Listen to `ironshift_jobs` notifications as wake hints while retaining polling as the source
      of truth.
- [ ] Coalesce wakeups and reconnect safely after PostgreSQL connection loss.
- [ ] Bound idle polling so lost notifications cannot strand ready work.
- [ ] Measure idle database load and enqueue-to-claim latency against polling-only behavior.

### [ ] P0-05 Built-in retry policies

**Depends on:** none

- [ ] Add fixed, exponential, and decorrelated-jitter retry policies.
- [ ] Persist the selected policy inputs needed for deterministic retry scheduling.
- [ ] Support explicit handler overrides without bypassing retry-budget enforcement.
- [ ] Cap delays and reject overflow or invalid policy configuration.
- [ ] Add deterministic tests for delay sequences and terminal exhaustion.

### [ ] P0-06 Consistent operational snapshots

**Depends on:** P0-02

- [ ] Provide a transactionally consistent queue-health snapshot for correctness-sensitive counts.
- [ ] Separate exact transactional values from lagging PostgreSQL statistics.
- [ ] Add health budgets and machine-readable degraded reasons.
- [ ] Keep snapshot latency bounded on large runtime and history relations.

### [ ] P0-07 Release and compatibility matrix

**Depends on:** none

- [ ] Test supported Node.js, PostgreSQL, and pg_cron versions in CI.
- [ ] Publish package provenance, changelog, upgrade notes, and protocol compatibility guarantees.
- [ ] Add install and smoke tests against a packed package rather than source-only imports.
- [ ] Define the production-support boundary separately from benchmark validation.

## P1: job controls and reliability

### [ ] P1-01 Enqueue idempotency keys

**Depends on:** none

- [ ] Support caller-scoped idempotency keys with an explicit retention window.
- [ ] Return the existing job identity when the same key and equivalent request are repeated.
- [ ] Reject key reuse with a materially different request.
- [ ] Preserve atomic behavior for transactional and batch enqueue.
- [ ] Document how enqueue deduplication differs from exactly-once handler effects.

### [ ] P1-02 Cancellation

**Depends on:** P0-03

- [ ] Add fenced cancellation transitions for scheduled, ready, and active jobs.
- [ ] Define cooperative cancellation delivery to active handlers.
- [ ] Materialize cancellation as an immutable terminal outcome with event and attempt history.
- [ ] Ensure stale completion, failure, and heartbeat calls cannot overwrite cancellation.
- [ ] Define cancellation behavior for recurring-job occurrences.

### [ ] P1-03 Deadlines and execution timeouts

**Depends on:** P1-02

- [ ] Support enqueue deadlines and per-attempt execution timeouts.
- [ ] Prevent expired jobs from being newly claimed.
- [ ] Fence late handler completion after timeout or deadline termination.
- [ ] Distinguish timeout, deadline, cancellation, and lease-expiry outcomes.
- [ ] Surface deadline pressure in health and telemetry.

### [ ] P1-04 Dead-letter views and redrive

**Depends on:** P1-01, P1-02

- [ ] Add query APIs for terminal failures without copying them into dispatch indexes.
- [ ] Add audited redrive that creates a new job linked to the failed source job.
- [ ] Support bounded bulk redrive with filters and dry-run output.
- [ ] Preserve the original immutable outcome and complete redrive lineage.
- [ ] Define idempotency behavior for repeated redrive requests.

### [ ] P1-05 Priority queues

**Depends on:** none

- [ ] Add a bounded priority range with FIFO ordering inside each priority.
- [ ] Preserve selective ready indexes and live-work claim scaling.
- [ ] Define promotion, retry, and redrive priority behavior.
- [ ] Add starvation controls or document strict-priority starvation explicitly.
- [ ] Benchmark index size and claim latency under mixed priorities.

### [ ] P1-06 Queue concurrency policies

**Depends on:** P0-03

- [ ] Limit active jobs by queue and optionally by an application-defined concurrency key.
- [ ] Make admission atomic across competing workers.
- [ ] Recover capacity automatically after lease expiry or worker loss.
- [ ] Expose blocked-ready depth and policy utilization.
- [ ] Prove that policy checks do not turn claims into lifetime-table scans.

### [ ] P1-07 Rate limiting

**Depends on:** P1-06

- [ ] Add queue or key-scoped token-bucket limits with explicit time semantics.
- [ ] Coordinate limits transactionally across worker processes.
- [ ] Avoid busy loops when work is ready but rate-limited.
- [ ] Report throttled depth, next eligibility, and effective throughput.
- [ ] Test clock skew, bursts, retries, and crash recovery.

### [ ] P1-08 Payload contracts and limits

**Depends on:** none

- [ ] Support optional per-job-type payload and result validators.
- [ ] Enforce configurable payload and result size limits before durable writes.
- [ ] Version contracts without making historical payloads unreadable.
- [ ] Redact configured sensitive fields from logs, traces, and operator views.

### [ ] P1-09 Progress and job metadata

**Depends on:** P0-02, P1-02

- [ ] Add fenced, bounded progress updates for active jobs.
- [ ] Keep mutable progress out of immutable payload and outcome fields.
- [ ] Define update frequency and size limits to control write amplification.
- [ ] Expose latest progress through lookup APIs and telemetry.

## P2: operator and ecosystem experience

### [ ] P2-01 Query and listing API

**Depends on:** P0-01, P1-04

- [ ] Add cursor-based listing by queue, type, lifecycle state, and time range.
- [ ] Keep operational reads away from claim-critical indexes.
- [ ] Support lifecycle timeline retrieval from events and attempt history.
- [ ] Define bounded payload inclusion and redaction controls.

### [ ] P2-02 Administrative CLI and TUI

**Depends on:** P2-01

- [ ] Add commands to inspect jobs, queues, schedules, failures, and maintenance state.
- [ ] Add guarded cancellation, redrive, pause, and resume operations as those APIs become stable.
- [ ] Require explicit target environment and confirmation for destructive operations.
- [ ] Provide JSON output for automation and human-readable output for operators.
- [ ] Build a TUI application with basic job, queue, schedule, failure, worker, and health views.
- [ ] Reuse the same administrative client and safety checks across the non-interactive CLI and TUI.

### [ ] P2-03 Web operator console

**Depends on:** P2-01, P2-02, P2-04

- [ ] Build queue, job, schedule, worker, failure, and health views.
- [ ] Use shadcn/ui as the component foundation for the generic dashboard.
- [ ] Use oRPC for the dashboard's typed API boundary.
- [ ] Stream or efficiently refresh active state without polling every row.
- [ ] Include full audit context for every mutating operator action.
- [ ] Keep the UI optional. Core queue operation must not depend on it.

### [ ] P2-04 Authentication, RBAC, and audit log

**Depends on:** none

- [ ] Define read-only, operator, scheduler-deployer, and administrator roles.
- [ ] Enforce authorization outside claim-critical SQL paths.
- [ ] Record append-only audit events for administrative mutations.
- [ ] Document direct-database access assumptions and least-privilege grants.

### [ ] P2-05 Multi-tenancy

**Depends on:** P1-06, P1-07, P2-04

- [ ] Define tenant identity and isolation boundaries across jobs, queues, schedules, and telemetry.
- [ ] Support tenant-scoped concurrency, rate, and retention policies.
- [ ] Prevent cross-tenant reads and operator actions.
- [ ] Benchmark high-tenant-cardinality index and planning behavior.

### [ ] P2-06 Additional ORM and framework integration packages

**Depends on:** P0-00A, P0-07, P1-01

- [ ] Evolve the adapter interface validated by Drizzle and Hono without moving lifecycle
      correctness out of SQL.
- [ ] Expand beyond Drizzle to a small set of popular TypeScript ORM providers, with transactional
      enqueue support and provider-specific integration tests.
- [ ] Select and document the next ORM support matrix before implementation. Prisma and TypeORM are
      candidates rather than commitments until the initial adapter contract is validated.
- [ ] Ship each ORM provider and framework integration as a separate optional package rather than
      adding ecosystem dependencies to the core package.
- [ ] Expand beyond Hono to a small framework matrix and validate lifecycle, dependency injection,
      configuration, startup, and graceful shutdown behavior for each package.
- [ ] Provide transactional enqueue examples for common PostgreSQL clients and supported ORMs.
- [ ] Test transaction ownership, connection pooling, shutdown, and error translation.
- [ ] Keep the core package free of framework dependencies.

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

- [ ] Expand `examples/` from the initial demo into real, runnable sample applications.
- [ ] Include at least one core-only example, one example per supported ORM provider, and one example
      per supported framework integration package.
- [ ] Keep examples focused on realistic application flows rather than isolated API snippets.
- [ ] Run example smoke tests in CI so package releases cannot silently break documented setups.
- [ ] Link every integration package to its corresponding example and setup guide.

## P3: orchestration

Do not start orchestration until cancellation, idempotency, concurrency controls, telemetry, and
operator tooling have stable contracts.

### [ ] P3-01 Job dependencies

**Depends on:** P1-01, P1-02, P1-06, P2-01

- [ ] Model dependency edges without putting blocked jobs in ready dispatch indexes.
- [ ] Atomically release dependents when prerequisites reach accepted terminal states.
- [ ] Define failure, cancellation, fan-in, and dependency-cycle behavior.
- [ ] Expose dependency state and lineage through query APIs.

### [ ] P3-02 Child jobs and result joining

**Depends on:** P3-01

- [ ] Allow a handler transaction to create linked child jobs.
- [ ] Define parent completion behavior for zero, one, or many children.
- [ ] Bound fan-out and result materialization.
- [ ] Preserve lineage across retry, cancellation, redrive, and retention.

### [ ] P3-03 Signals and durable waits

**Depends on:** P3-01, P2-04

- [ ] Add idempotent, authorized signals addressed to a stable waiting execution.
- [ ] Define signal retention, timeout, cancellation, and duplicate-delivery semantics.
- [ ] Keep waiting executions out of ready and active dispatch indexes.
- [ ] Audit every accepted and rejected signal.

### [ ] P3-04 Workflow runtime

**Depends on:** P3-01, P3-02, P3-03

- [ ] Define a deterministic workflow state model and versioning contract.
- [ ] Support retryable activities without implying exactly-once external effects.
- [ ] Add replay, migration, cancellation, compensation, and operator-debugging semantics.
- [ ] Build dedicated correctness and long-history benchmarks before production claims.

## Deferred or rejected

- [ ] Reconsider arbitrary scheduled SQL only if Ironshift intentionally expands beyond typed job
      orchestration. It is not part of the current product direction.
- [ ] Reconsider compatibility write views only with a proven single-authority migration design.
      Dual-write compatibility is explicitly rejected.
- [ ] Reconsider exactly-once marketing only if the claim is narrowly scoped to a transactionally
      provable boundary. External effects remain at least once.
