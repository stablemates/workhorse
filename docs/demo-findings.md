# Demo findings and follow-up gaps

The Workhorse demo is a vertical slice of the project: transactional enqueue, worker lifecycle, retry
behavior, recurring scheduling, and operator inspection. It uses Hono and Drizzle to prove the supported
integrations in a realistic application, but those libraries are implementation details rather than the
subject of the demo. This document records what the implementation proved, what it forced the repository
to fix, and which gaps remain.

## Validation performed

The demo now proves these paths against PostgreSQL rather than mocks:

- a Hono request inserts an application order and its Workhorse job in the same Drizzle transaction;
- a Hono-managed worker processes the job and shuts down through the integration lifecycle;
- an intentional handler saves a named capacity-reservation checkpoint, records a `retry` attempt, and
  reuses the checkpoint value when attempt 2 succeeds;
- fixed, exponential, and decorrelated-jitter seeds persist their policy, expose it through the read
  model and task drawer, and show PostgreSQL-selected delay and source in the lifecycle timeline;
- three demo-declared pipelines expose multi-step checkpoint progress for order fulfillment, customer
  onboarding, and report publication without treating the presentation plan as a core workflow graph;
- three representative durable seeds persistently fail at configured boundaries, preserve checkpoint-backed
  interim artifacts and per-attempt errors, schedule retries at about 5, 7, and 10 minutes, and never execute
  later planned stages;
- schema v12 persists terminal outcomes/results and immutable checkpoint outputs as public data;
  the existing task drawer now makes both the terminal result or failure evidence and checkpoint-backed
  interim artifacts inspectable alongside attempt history;
- a named durable timer demo checkpoints preparation, suspends with no active lease, and later reclaims the
  same logical attempt with a new fence; replay reuses preparation exactly once before publishing;
- the worker-owned scheduler synchronizes and fires a recurring definition with occurrence deduplication;
- a data-driven living showcase keeps three one-off scenarios and one varied recurring definition for each
  of eight task-visible feature families, including deadline, timeout, cancellation, progress, dead-letter,
  redrive, and idempotent replay evidence;
- the typed oRPC snapshot exposes queues, jobs, checkpoint and wait provenance, logical and final-claim
  attempt timestamps, demo-owned progress plans, schedules, workers, failures, and database health;
- schema version 12 installs daily retained history, split scheduled maintenance, scoped enqueue-idempotency, and cooperative cancellation contracts, although the demo still omits a dedicated idempotency-key form or seed;
- the dashboard can be omitted without changing core queue behavior;
- worker instances expose bounded local concurrency and `{ concurrency, activeSlots, paused, draining }`
  runtime state, while the demo intentionally keeps two default-concurrency workers rather than presenting
  an unrecorded performance comparison;
- a dedicated partner API queue consumes a queue-wide and per-key token burst through the public claim
  path, then leaves a bounded throttled backlog visible beside its sustained rate and next eligibility;
  a serial worker drains that queue only when PostgreSQL admits another start;
- `pnpm demo` recreates only a purpose-guarded demo database, builds the workspace, and serves the app.

Checkpoint outputs remain immutable durable evidence. Schema version 16 adds a separate fenced, bounded
latest-progress projection with defined frequency and size limits and exposes it in the task drawer.

## Gaps fixed while building the demo

| Area        | Finding                                                                                                       | Resolution                                                                                                                               |
| ----------- | ------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| DX          | Reusing `workhorse_dev` made the documented command fail when that database contained an old or mixed schema. | Added the suffix-guarded `workhorse_demo` database and made `pnpm demo` recreate only that disposable target.                            |
| Packaging   | Starting the source demo without building workspace package outputs depended on stale local `dist` files.     | Made `pnpm demo` build core, integrations, and the demo before startup.                                                                  |
| Integration | A dashboard coupled to process startup would make the queue unusable in API-only deployments.                 | Added `{ dashboard: false }` and an integration test that proves workers and Hono routes remain functional.                              |
| Correctness | Transactional enqueue was documented but not demonstrated through an ORM-owned request transaction.           | Added a test comparing PostgreSQL `xmin` for the application row and accepted job.                                                       |
| Operations  | Notification-driven refreshes made the browser update too often under high load.                              | Use a bounded, page-local polling interval with a 15-second default.                                                                     |
| Timing      | A sleeping job could look worker-owned or inflate execution time across the sleep.                            | Project current ownership separately from last-held provenance and compute execution from final `claimed_at`.                            |
| Retry       | Retry configuration was process-local callback logic with no durable policy or provenance.                    | Added PostgreSQL-owned persisted policies, deterministic jitter, compatibility defaults, and policy/delay/source inspection in the demo. |

The timer demo deliberately uses only a named relative wait as its primary proof. The visible default is ten
seconds so operators can inspect the sleeping row. The approximately one-second maintenance cadence is only
a floor and queue state, process downtime, conservative worker polling, or worker availability can delay
promotion and claim. Test-only options shorten the wait and observe checkpoint callbacks without changing
the normal path.

Named waits persist timer boundaries, not JavaScript stacks. A resumed handler starts from its entry point,
so side effects before `sleep` must be checkpointed or independently idempotent. The demo's prepare/wait/
publish narrative is presentation and handler structure, not a persisted workflow graph.

## Remaining API gaps

### A1. No supported operational query surface

The dashboard must issue bounded SQL directly against `workhorse.job`, `job_runtime`, `job_outcome`,
`attempt_history`, `schedule_definition`, and `schedule_occurrence`. Those relations are protocol
internals, so a schema evolution can break an otherwise type-safe dashboard.

**Needed:** a typed, cursor-based read API for job lists, queue pressure, lifecycle timelines, schedule
status, worker observations, failures, and health. Keep payload inclusion bounded and support redaction.
This is tracked primarily by **P2-01 Query and listing API** and **P0-06 Consistent operational snapshots**.

### A3. Framework integrations do not own schedule deployment

The Drizzle adapter can enqueue through a caller-owned transaction, but recurring schedules still need
an explicit deploy-time schedule synchronization call against a raw `pg` pool. Hono has
worker lifecycle hooks but no deploy-time schedule synchronization hook.

**Needed:** a framework-neutral deploy lifecycle abstraction, plus Drizzle and Hono helpers that retain
clear pool ownership and still expose the full synchronization result. This does not block the current
API, but should be designed before adding more framework integrations.

### A4. Worker identity is observational only

The worker view infers active workers from leases and recent workers from attempt history. A live Worker
now exposes its declared concurrency, active slots, pause state, and drain state in process, but there is no
durable registry, start time, build version, graceful-stop record, or authoritative liveness record.

**Needed:** decide whether production telemetry is sufficient or whether Workhorse needs a bounded,
expiring worker registry. Any registry must avoid turning worker heartbeats into unbounded write load.
P0-03 supplies the local runtime contract. The remaining durable-registry decision belongs with **P0-02
Production telemetry**.

### A5. Redrive now has a supported core mutation contract

Schema v11 now provides `Queue.cancel` and the demo operator surface can attribute a cancellation request
with actor and reason. Ready, scheduled, and durable-wait work cancels immediately; active work displays a
request until the exact worker/fence acknowledges it or expiry materializes it. The demo must not present
`requestedBy` as authorization, forced interruption, or exactly-once settlement.

Schema v14 adds failure-only cursor queries, audited single and bounded bulk redrive, non-mutating
dry-run, exact request replay, conflict diagnostics, immutable source outcomes, and retained lineage.
Every mutation requires actor, reason, and request ID and records target plus before/after state.

The core transition is complete under **P1-04 Dead-letter views and redrive**. A dashboard mutation
still requires an application authorization policy and is intentionally deferred to later operator
tooling rather than treating attribution as RBAC.

## Remaining packaging gaps

### P1. The demo validates workspace source, not a consumer installation

The app imports workspace packages and the one-command path builds local outputs. That proves repository
integration but not registry metadata, exported files, peer-dependency behavior, or installation from
published tarballs.

**Needed:** run the same application shape against packed artifacts in an isolated project, then include
that path in the release compatibility matrix. This is tracked by **P0-07 Release and compatibility
matrix**. Existing package tests cover important pieces, but not the complete dashboard application.

### P2. Dashboard asset serving assumes a package working directory

`serveStatic({ root: "./dist" })` is simple for the demo, but production launchers, containers, and
bundlers may use another current directory. The dashboard also has no standalone package or asset
manifest contract.

**Needed:** resolve assets relative to the installed module or publish a dedicated dashboard package
with an explicit mounting API. Keep the dashboard optional and avoid adding React to core dependencies.

## Remaining documentation gaps

### D1. Schema upgrades are not documented because they do not exist

`installSchema()` intentionally rejects non-v11 or mixed installations. The live demo exposed how quickly
that clean-install boundary becomes user-visible.

**Needed:** ordered transactional migrations, independent schema and protocol versions, dry-run/status
commands, rollback guidance, and upgrade tests. This is tracked by **P2-07 Schema migration framework**.

### D2. Recurring-job setup friction was removed with the pg_cron dependency

Earlier iterations required pg_cron: a second metadata connection, matching deployment roles, grants,
target authentication, and cluster-level configuration, and the demo had to make recurrence optional to
stay portable. The worker-owned scheduler removed that entire prerequisite class: recurring jobs now
run on plain PostgreSQL through in-process cron evaluation, advisory-lock coordination, and SQL
occurrence deduplication.

**Needed:** document worker scheduling cadence and catch-up behavior in task-oriented guides, and keep
the demo exercising recurring jobs by default now that no extra infrastructure is required.

### D3. Operational semantics need task-oriented guides

The architecture references are comprehensive, but application developers still need short guides for
idempotent handlers, retry exhaustion, lease loss, schedule deployment, transaction ownership, and
reading immutable attempt history.

**Needed:** derive task-oriented guides from the working demo and link each guide to the authoritative
protocol documentation rather than duplicating invariants.

## Remaining developer-experience gaps

### X1. Startup failure cleanup is manual

The executable creates its pool before server startup. Graceful shutdown is centralized after startup,
but failures during schema installation or schedule synchronization still rely on process exit to release
the resource.

**Needed:** a small acquisition/cleanup helper or integration lifecycle that disposes partially acquired
resources in reverse order. Ownership must remain explicit so caller-owned pools are never closed.

### X3. The core query API is complete; dashboard adoption remains

Schema v16 exposes cursor-based cross-state job listing, explicit payload omission/redaction/size
status, and a merged retained event/attempt timeline through the public Queue API. The existing task drawer
still uses its package-owned direct SQL read model and does not yet expose the complete core timeline,
payload projection state, or redrive lineage.

**Needed:** migrate the dashboard read model onto the stable P2-01 contracts where its search and aggregate
requirements fit, without weakening its authorization boundary or exposing payload by default.

## Priority conclusion

The demo validates the current write path, persisted retry policies, enqueue idempotency, cancellation,
progress, and lifecycle semantics. The next recommended product work is production telemetry. The P2-01
core query surface is complete, while broader dashboard adoption and the later CLI remain separate
operator-experience work.
