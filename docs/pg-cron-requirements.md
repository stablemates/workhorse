# pg_cron production requirements

Workhorse treats pg_cron 1.6+ as the production scheduler for recurring jobs, due-job promotion, expired-lease recovery, and bounded schedule-occurrence retention. The worker fallback remains available, but it does not provide deployment-synchronized recurring schedules.

## Required topology

- Install pg_cron once in the cluster metadata database configured by `cron.database_name`, normally `postgres`.
- Connect `PgCronScheduler` to both the Workhorse target database and that metadata database.
- Use the same deployment role for both pools. Workhorse passes a NULL username to `schedule_in_database`, so pg_cron executes target commands as the role that synchronized the job.
- The deployment role needs `CONNECT` to every target database and normal execution rights on its `workhorse` schema.
- Keep the database compute active. A suspended serverless compute does not execute cron jobs.
- Use UTC for `cron.timezone` unless every application schedule deliberately follows another cluster-wide timezone.

## Administrator setup

Self-hosted PostgreSQL requires `pg_cron` in `shared_preload_libraries`, `cron.database_name = 'postgres'`, and a restart before extension creation.

```sql
\c postgres
CREATE EXTENSION IF NOT EXISTS pg_cron;
GRANT USAGE ON SCHEMA cron TO workhorse;
GRANT SELECT ON cron.job, cron.job_run_details TO workhorse;
GRANT EXECUTE ON FUNCTION
  cron.schedule_in_database(text, text, text, text, text, boolean) TO workhorse;
GRANT EXECUTE ON FUNCTION cron.unschedule(bigint) TO workhorse;
```

The function grant is required in addition to schema usage. Validate the exact runtime role and metadata connection before deploying:

```bash
DATABASE_URL='postgres://workhorse:...@host:5432/app' \
CRON_DATABASE_URL='postgres://workhorse:...@host:5432/postgres' \
pnpm pg-cron:check
```

A successful result has `"ready": true`, `"metadataReady": true`, and `"executionReady": true`. The command creates a temporary one-second `SELECT 1` job, waits for pg_cron to execute it in the target database, then unschedules it. It exits nonzero for missing metadata privileges, daemon connection/authentication failure, or execution timeout. For isolated local databases, use `pnpm pg-cron:check -- --database test` or `bench`.

## Authentication and capacity

When `cron.use_background_workers` is off, pg_cron opens a PostgreSQL connection for each run. Configure `pg_hba.conf` and a password source such as `.pgpass` for the deployment role. When background workers are enabled, ensure `max_worker_processes` exceeds the expected pg_cron concurrency and `cron.max_running_jobs`.

If the live preflight returns `status: "failed"` and `message: "connection failed"`, metadata grants are correct but the daemon cannot authenticate to the target database. Prefer background workers when the provider supports them:

```sql
ALTER SYSTEM SET cron.use_background_workers = 'on';
ALTER SYSTEM SET cron.max_running_jobs = '4'; -- keep below available max_worker_processes
```

Restart PostgreSQL after changing background-worker mode. Otherwise install a server-side `.pgpass` owned by the PostgreSQL operating-system account with mode `0600`, or add a narrowly scoped `pg_hba.conf` rule. An application user's local `.pgpass` is not read by the server-side pg_cron process.

Workhorse's maintenance job runs every second by default. Keep its batch size bounded and monitor duration. pg_cron serializes overlapping executions of the same job, so a maintenance job that consistently exceeds its interval accumulates delay rather than concurrent copies.

## Retention

Workhorse maintenance deletes at most 10,000 `schedule_occurrence` rows older than 30 days per run by default. Configure `occurrenceRetentionDays` and `occurrencePruneLimit` in `PgCronScheduler.sync()` when a different dedupe window is required. Replaying an occurrence after its key has aged out can enqueue it again, so choose a retention window longer than the maximum expected scheduler replay or restore horizon. Job identity, outcomes, and lifecycle history have separate retention contracts.

`cron.job_run_details` is provider-owned cluster metadata. Workhorse reads it for status but never deletes it. Configure an administrator-owned retention job. AWS recommends retaining a bounded troubleshooting window rather than allowing this table to grow indefinitely.

pg_cron 1.6 creates only a primary-key index on `runid`. Workhorse's status query scans retained history once for its owned job IDs rather than once per schedule. On a high-volume cluster, an administrator can additionally create `CREATE INDEX job_run_details_jobid_runid_idx ON cron.job_run_details (jobid, runid DESC);`; keep retention bounded even with that index.

## Hosted provider compatibility

| Provider                                                                                                                                                  | Support and required controls                                                                                                                                                                                  | Workhorse-specific note                                                                                                                                  |
| --------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [AWS RDS / Aurora PostgreSQL](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/PostgreSQL_pg_cron.html)                                             | Add `pg_cron` to the custom parameter group's `shared_preload_libraries`, restart, create the extension in `postgres` as `rds_superuser`, then grant least-privilege access. RDS supports cross-database jobs. | Compatible with the required metadata-database topology and NULL scheduling username. Size `max_worker_processes` above `cron.max_running_jobs`.         |
| [Supabase Cron](https://supabase.com/docs/guides/cron)                                                                                                    | Supabase Cron is backed by pg_cron, supports schedules from every second to yearly, and records runs in `cron.job_run_details`.                                                                                | Verify the project role can receive the exact function/table grants. Supabase recommends no more than eight concurrent jobs and ten-minute job duration. |
| [Neon](https://neon.com/docs/extensions/pg_cron)                                                                                                          | Set `cron.database_name` through endpoint settings, restart compute, then create the extension.                                                                                                                | Disable scale to zero or use an always-active compute. Jobs run only while compute is active.                                                            |
| [Azure Database for PostgreSQL Flexible Server](https://learn.microsoft.com/en-us/azure/postgresql/extensions/concepts-extensions-considerations#pg_cron) | Allowlist pg_cron, add it to `shared_preload_libraries`, restart, and create the extension. Azure supports `schedule_in_database` but does not support selecting a non-NULL target username.                   | Compatible because Workhorse uses the same role for both pools and passes NULL as the target username.                                                   |

Provider support is necessary but not sufficient. Run `pnpm pg-cron:check` and require `ready: true` before enabling production schedules.

## Deployment and failure behavior

Each definition carries a monotonically increasing revision. Generated cron commands include that expected revision. If target desired state commits but metadata reconciliation fails, the old cron command becomes a safe no-op instead of running a new payload at an old cadence. Retrying `sync()` converges metadata to the accepted revision.

`fire_schedule_v1` locks the definition row while reserving and enqueueing an occurrence. A disable deployment waits for an already-started fire to commit before returning, and no later stale revision can enqueue. Target-wide advisory locking also prevents database reset cleanup from racing deployment synchronization.
