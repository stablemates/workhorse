BEGIN;

SELECT pg_advisory_xact_lock(hashtextextended('workhorse:schema-migration', 0));

DO $migration$
DECLARE
  v_version integer;
  v_version_rows integer;
BEGIN
  SELECT count(*)::integer, min(version) INTO v_version_rows, v_version
    FROM workhorse.schema_version;

  IF v_version_rows <> 1 THEN
    RAISE EXCEPTION 'workhorse.schema_version must contain exactly one row';
  END IF;
  IF v_version NOT IN (25, 26) THEN
    RAISE EXCEPTION 'migration 0026 requires schema version 25, found %', v_version;
  END IF;
END;
$migration$;

CREATE OR REPLACE VIEW workhorse.dashboard_attempt_history_v1 AS
  SELECT attempt_id, job_id, attempt, fence_token, worker_id, outcome, started_at, claimed_at,
         finished_at, error, occurred_at FROM workhorse.attempt_history;
CREATE OR REPLACE VIEW workhorse.dashboard_concurrency_policy_v1 AS
  SELECT queue_name FROM workhorse.concurrency_policy;
CREATE OR REPLACE VIEW workhorse.dashboard_job_checkpoint_v1 AS
  SELECT job_id, checkpoint_name, checkpoint_value, attempt, fence_token, worker_id, created_at
    FROM workhorse.job_checkpoint;
CREATE OR REPLACE VIEW workhorse.dashboard_job_event_v1 AS
  SELECT event_id, job_id, attempt, event_type, details, occurred_at FROM workhorse.job_event;
CREATE OR REPLACE VIEW workhorse.dashboard_job_outcome_v1 AS
  SELECT job_id, state, current_attempt, run_at, result, error, finished_at, updated_at
    FROM workhorse.job_outcome;
CREATE OR REPLACE VIEW workhorse.dashboard_job_progress_v1 AS
  SELECT job_id, progress_value, revision, attempt, fence_token, worker_id, created_at, updated_at
    FROM workhorse.job_progress;
CREATE OR REPLACE VIEW workhorse.dashboard_job_runtime_v1 AS
  SELECT job_id, queue_name, state, current_attempt, fence_token, run_at, ready_at, worker_id,
         acquired_at, heartbeat_at, expires_at, attempt_timeout_at, wait_name, attempt_started_at,
         cancel_requested_at, cancel_requested_by, cancel_reason, error, updated_at
    FROM workhorse.job_runtime;
CREATE OR REPLACE VIEW workhorse.dashboard_job_v1 AS
  SELECT id, queue_name, job_type, concurrency_key, payload, payload_redact_keys,
         result_redact_keys, tags, max_attempts, retry_policy, deadline_at, execution_timeout_ms,
         created_at FROM workhorse.job;
CREATE OR REPLACE VIEW workhorse.dashboard_job_wait_v1 AS
  SELECT job_id, wait_name, mode, duration_ms, requested_wake_at, wake_at, attempt, fence_token,
         worker_id, created_at FROM workhorse.job_wait;
CREATE OR REPLACE VIEW workhorse.dashboard_maintenance_policy_v1 AS
  SELECT singleton, timezone, partition_preparation_interval_ms, terminal_cleanup_interval_ms,
         history_retention_local_time, updated_at FROM workhorse.maintenance_policy;
CREATE OR REPLACE VIEW workhorse.dashboard_maintenance_state_v1 AS
  SELECT task_name, last_started_at, last_completed_at, last_completed_local_date
    FROM workhorse.maintenance_state;
CREATE OR REPLACE VIEW workhorse.dashboard_queue_control_v1 AS
  SELECT queue_name, paused FROM workhorse.queue_control;
CREATE OR REPLACE VIEW workhorse.dashboard_rate_limit_policy_v1 AS
  SELECT queue_name FROM workhorse.rate_limit_policy;
CREATE OR REPLACE VIEW workhorse.dashboard_retention_policy_v1 AS
  SELECT singleton, job_event_retention_days, attempt_history_retention_days
    FROM workhorse.retention_policy;
CREATE OR REPLACE VIEW workhorse.dashboard_schedule_definition_v1 AS
  SELECT namespace, schedule_name, cron_expression, queue_name, job_type, enabled, revision,
         updated_at FROM workhorse.schedule_definition;
CREATE OR REPLACE VIEW workhorse.dashboard_schedule_occurrence_v1 AS
  SELECT namespace, schedule_name, occurrence_at, fired_at FROM workhorse.schedule_occurrence;
CREATE OR REPLACE VIEW workhorse.dashboard_worker_registry_v1 AS
  SELECT worker_id, hostname, pid, queue_name, concurrency, lease_ms, heartbeat_ms, poll_ms,
         maintenance_interval_ms, maintenance_task_poll_ms, registry_interval_ms, active_slots,
         draining, paused, started_at, last_heartbeat_at FROM workhorse.worker_registry;

CREATE OR REPLACE FUNCTION workhorse.dashboard_job_estimate_v1()
RETURNS TABLE (estimate bigint)
LANGUAGE sql
STABLE
PARALLEL SAFE
AS $$
  SELECT reltuples::bigint FROM pg_class WHERE oid = 'workhorse.job'::regclass;
$$;

INSERT INTO workhorse.schema_migration(version, description)
VALUES (26, 'add versioned dashboard read surface')
ON CONFLICT DO NOTHING;

DELETE FROM workhorse.schema_version WHERE version = 25;
INSERT INTO workhorse.schema_version(version) VALUES (26) ON CONFLICT DO NOTHING;

COMMIT;
