# ADR 0002: pg_cron-backed declarative scheduling and maintenance

- **Status:** Accepted
- **Date:** 2026-07-22
- **Requires:** pg_cron 1.6 or newer in the cluster's `postgres` database

## Context

Workers previously called due-job promotion and expired-lease recovery before every claim attempt. The partial indexes make empty scans selective, but the design still adds two sequential database round trips per processed job and duplicates maintenance work across worker instances.

Workhorse also needs recurring jobs that can be defined in application code, reviewed with a deployment, and synchronized without granting applications arbitrary SQL scheduling.

## Decision

Make pg_cron a first-class Workhorse platform requirement for production scheduling and maintenance.

`PgCronScheduler` synchronizes a namespaced desired state during deployment:

1. Schedule definitions and payloads are stored in the target database's `workhorse.schedule_definition` table.
2. pg_cron stores only generated calls to `workhorse.fire_schedule_v1(namespace, name, revision)` in its configured metadata database.
3. A durable `schedule_occurrence` key deduplicates a supplied occurrence second before normal Workhorse enqueue semantics run. Generated pg_cron calls use their observed execution second because pg_cron does not expose the planned slot to the target command.
4. One namespaced maintenance job calls `maintain_v1`, which promotes due jobs, recovers expired leases, and prunes old occurrence keys in bounded batches.
5. Removed definitions are deactivated and their owned pg_cron entries are pruned. Other namespaces and non-Workhorse cron jobs are never touched.
6. A target-wide metadata session lock coordinates sync with reset cleanup, while a target namespace lock and pg_cron transaction lock serialize reconciliation. Material definition changes increment a revision embedded in generated commands. If target state commits before cron metadata fails, the old command becomes a no-op rather than executing the new payload at the old cadence.

Workers default to externally coordinated maintenance and execute only the claim path. `maintenance: "worker"` remains an explicit compatibility fallback.

## Safety boundaries

- Synchronization uses the same least-privilege role for the target and pg_cron metadata connections.
- Schedule names and namespaces use a restricted identifier vocabulary.
- Users declare Workhorse jobs, not arbitrary SQL commands.
- Generated cron commands contain only validated identifiers and stable Workhorse functions.
- The cron job name includes target database, namespace, and schedule name.
- Synchronization prunes only jobs owned by the current role with the exact Workhorse target/namespace prefix.
- Database reset tooling unschedules all Workhorse-owned jobs targeting the database before dropping it.
- Stale, disabled, or pruned definitions make `fire_schedule_v1` a no-op; definition row locking makes disable wait for an already-started fire before returning.
- Schedule occurrence insertion and enqueue are one target-database transaction.

## Consequences

### Positive

- Two maintenance round trips leave the normal worker claim path.
- Promotion and recovery have one centralized cadence independent of worker count.
- Recurring jobs become deployment-reviewed, drift-corrected configuration.
- Scheduled jobs use the same queues, retries, fencing, events, attempts, outcomes, and health model as manually enqueued jobs.
- pg_cron supplies execution history and prevents overlapping execution of one named cron job.

### Negative

- Full scheduling requires a provider or host that supports pg_cron.
- Initial installation and some grants require an administrative role and can require a server restart.
- pg_cron metadata lives in one configured database per cluster, so synchronization across the metadata and target databases is convergent rather than atomically distributed.
- Occurrence dedupe rows require a retention window; maintenance defaults to 30 days and bounded deletion.
- Serverless compute that scales to zero may not run schedules while suspended.
- Schedule precision is one second and schedules follow the configured pg_cron timezone.
- Restores, clones, and preview environments require explicit namespaces and deployment synchronization to prevent unintended schedule activation.

## Rejected alternatives

### Run maintenance before every worker claim

Portable, but it imposes avoidable query and connection-pool load and multiplies maintenance callers with worker count.

### Store arbitrary SQL in application schedule definitions

More flexible, but it creates a broad database-execution product and expands injection, privilege, review, and portability risk. Workhorse schedules enqueue typed jobs instead.

### Require an external scheduler service

Avoids a PostgreSQL extension, but adds another control plane and weakens Workhorse's same-database operational model.

## Validation

Acceptance requires live PostgreSQL tests for namespaced create/update/disable/prune behavior, stale-revision rejection, fire/disable serialization, bounded occurrence retention, duplicate occurrence suppression, configured job enqueue, default external worker maintenance, explicit worker fallback, reset cleanup, and at least one observed pg_cron execution against a target database.
