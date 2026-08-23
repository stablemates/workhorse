# ADR 0003: Worker-owned in-process scheduling and maintenance

- **Status:** Accepted, amended by [ADR 0004](0004-two-cadence-maintenance.md) and [ADR 0038](0038-evaluate-cron-occurrences-in-postgresql.md)
- **Date:** 2026-07-29
- **Supersedes:** [ADR 0002: pg_cron-backed declarative scheduling and maintenance](0002-pg-cron-scheduler.md)

## Context

ADR 0002 made pg_cron 1.6+ a first-class production requirement for recurring jobs, due-job promotion, and expired-lease recovery. Operating that decision demonstrated that pg_cron is Workhorse's single highest-friction dependency:

- It requires a preloaded server extension, a restart, and administrator-level installation before any schedule can run.
- Its metadata lives in one configured cluster database, normally `postgres`, forcing every deployment to hold a second metadata connection and coupling application deploys to cluster-wide state.
- The cron daemon must independently authenticate to the target database, which drags `pg_hba.conf`, server-side `.pgpass`, and background-worker capacity planning into application setup.
- Target desired state and cron metadata cannot share a transaction, so synchronization is convergent rather than atomic and needs revision fencing to stay safe.
- Provider support is uneven, grants differ per host, and serverless compute that suspends silently pauses schedules.
- The demo findings recorded pg_cron as the highest-friction prerequisite for adoption (`docs/demo-findings.md`, finding D2).

Meanwhile, the ecosystem shows this dependency is unnecessary. good_job (Ruby), pg-boss (Node), and Oban (Elixir) all run production cron scheduling entirely inside worker processes against plain PostgreSQL: workers parse cron expressions themselves, coordinate through advisory locks so only one process fires a given occurrence, and rely on unique keys in SQL to deduplicate enqueue. No extension, no superuser, no second database.

## Decision

Remove pg_cron entirely. Workers own scheduling and maintenance in process.

1. Schedule definitions remain declarative desired state in the target database's `workhorse.schedule_definition` table, synchronized atomically per namespace during deployment. Definitions still contain typed Workhorse jobs, never arbitrary SQL.
2. Workers own schedule cadence. [ADR 0038](0038-evaluate-cron-occurrences-in-postgresql.md) moves deterministic cron occurrence evaluation into PostgreSQL.
3. A PostgreSQL advisory lock coordinates scheduling across worker instances, so any number of workers can run the scheduler loop while only one drives a given tick. Every worker is a candidate; losing the lock is not an error. This removes the single-scheduler failure mode without an external coordinator.
4. Occurrence deduplication stays in SQL. `fire_schedule_v1` reserves one durable `(namespace, schedule_name, occurrence_at)` key before enqueueing, so a fire raced or replayed by multiple workers still enqueues exactly one job for that occurrence second. Because PostgreSQL computes the planned occurrence, occurrence keys use the planned slot rather than pg_cron's observed execution second.
5. Maintenance (bounded due promotion, expired-lease recovery, occurrence-key pruning, history-partition replenishment) runs on worker-owned cadences coordinated by the same advisory-lock mechanism instead of a pg_cron entry. [ADR 0004](0004-two-cadence-maintenance.md) splits this into a fast tick and a slow housekeeping entry point.
6. Revision fencing is retained: stale, disabled, or pruned definitions make `fire_schedule_v1` a no-op.

## Consequences

### Positive

- Workhorse now requires only plain PostgreSQL. No extension, no `shared_preload_libraries`, no server restart, no superuser installation step.
- The metadata-database topology disappears: no second connection pool, no cross-database convergence, no cron-daemon authentication into the target database.
- Portability becomes universal. Every managed PostgreSQL, serverless PostgreSQL with wake-on-connect, local container, and CI database works identically.
- Deployment synchronization becomes a single-database, fully transactional operation.
- Scheduling availability follows worker availability. If workers run, schedules fire; there is no separately supervised daemon whose silent failure stops recurring work.
- Precedent risk is low: good_job, pg-boss, and Oban have validated worker-owned advisory-lock scheduling in production for years.

### Negative

- Schedules fire only while at least one worker process is running. pg_cron could fire with zero workers, although those jobs could not execute anyway.
- After total worker downtime, missed occurrences are governed by worker catch-up policy rather than a cron daemon's history.
- Workhorse's PostgreSQL schema takes on cron parsing and occurrence evaluation, which the extension previously provided.
- pg_cron's `cron.job_run_details` execution history is gone; Workhorse's own occurrence, event, and attempt history is now the sole record.
- Scheduling drift is bounded by the worker's polling/timer cadence rather than a dedicated daemon tick.

## Rejected alternatives

### Keep pg_cron as an optional backend

Two scheduling backends double the test matrix, keep all the documentation and provider-compatibility burden, and blur the portability story for marginal benefit.

### External scheduler service

Still adds a control plane, deployment surface, and failure domain outside PostgreSQL, which ADR 0002 already rejected.

### Database triggers or `LISTEN`-driven scheduling

PostgreSQL has no native timer primitive without an extension; triggers cannot originate time-based work.

## Validation

Acceptance requires live PostgreSQL tests for: multi-worker scheduling with advisory-lock mutual exclusion, duplicate occurrence suppression under concurrent fires, catch-up behavior after worker downtime, revision-fenced no-ops for stale and disabled definitions, worker-owned promotion and recovery cadence, and end-to-end recurring execution with no pg_cron extension installed.
