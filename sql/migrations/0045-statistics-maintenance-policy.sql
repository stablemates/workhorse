-- Migration 0045: move the rolling-statistics cadence, group limit, and recompute window into
-- maintenance_policy beside the other maintenance cadences (ADR 0020). Released migrations are
-- immutable; never edit this file.
--
-- The runtime wraps this body in one transaction that takes the workhorse:schema-migration
-- advisory lock, validates the starting version, and records the version step. The body contains
-- only the schema change itself.

ALTER TABLE workhorse.maintenance_policy
  ADD COLUMN statistics_rollup_interval_ms integer NOT NULL DEFAULT 60000 CHECK (
    statistics_rollup_interval_ms = 0
    OR statistics_rollup_interval_ms BETWEEN 1000 AND 86400000
  ),
  ADD COLUMN statistics_group_limit integer NOT NULL DEFAULT 200 CHECK (
    statistics_group_limit BETWEEN 1 AND 10000
  ),
  ADD COLUMN statistics_recompute_buckets integer NOT NULL DEFAULT 2 CHECK (
    statistics_recompute_buckets BETWEEN 0 AND 1440
  ),
  ADD COLUMN application_statistics_rollup_interval_ms integer NOT NULL DEFAULT 60000 CHECK (
    application_statistics_rollup_interval_ms = 0
    OR application_statistics_rollup_interval_ms BETWEEN 1000 AND 86400000
  ),
  ADD COLUMN application_statistics_group_limit integer NOT NULL DEFAULT 200 CHECK (
    application_statistics_group_limit BETWEEN 1 AND 10000
  ),
  ADD COLUMN application_statistics_recompute_buckets integer NOT NULL DEFAULT 2 CHECK (
    application_statistics_recompute_buckets BETWEEN 0 AND 1440
  );
ALTER TABLE workhorse.maintenance_policy
  ALTER COLUMN statistics_rollup_interval_ms DROP DEFAULT,
  ALTER COLUMN statistics_group_limit DROP DEFAULT,
  ALTER COLUMN statistics_recompute_buckets DROP DEFAULT,
  ALTER COLUMN application_statistics_rollup_interval_ms DROP DEFAULT,
  ALTER COLUMN application_statistics_group_limit DROP DEFAULT,
  ALTER COLUMN application_statistics_recompute_buckets DROP DEFAULT;

ALTER TABLE workhorse.maintenance_policy
  DROP CONSTRAINT maintenance_policy_operator_overrides_check;
ALTER TABLE workhorse.maintenance_policy
  ADD CONSTRAINT maintenance_policy_operator_overrides_check CHECK (
    operator_overrides <@ ARRAY[
      'timezone', 'partition_preparation_interval_ms',
      'terminal_cleanup_interval_ms', 'history_retention_local_time',
      'statistics_rollup_interval_ms', 'statistics_group_limit', 'statistics_recompute_buckets'
    ]::text[]
  );

-- The sync, override, and rollup signatures change, so the old overloads must go first: a bare
-- CREATE OR REPLACE would leave both signatures installed.
DROP FUNCTION workhorse.sync_maintenance_policy_v1(text, integer, integer, time, boolean);
DROP FUNCTION workhorse.override_maintenance_policy_v1(text, integer, integer, time);
DROP FUNCTION workhorse.rollup_stats_v1(timestamptz, integer, integer, integer);

CREATE OR REPLACE FUNCTION workhorse.sync_maintenance_policy_v1(
  p_timezone text,
  p_partition_preparation_interval_ms integer DEFAULT NULL,
  p_terminal_cleanup_interval_ms integer DEFAULT NULL,
  p_history_retention_local_time time DEFAULT NULL,
  p_statistics_rollup_interval_ms integer DEFAULT NULL,
  p_statistics_group_limit integer DEFAULT NULL,
  p_statistics_recompute_buckets integer DEFAULT NULL,
  p_force boolean DEFAULT false
) RETURNS workhorse.maintenance_policy
LANGUAGE plpgsql
AS $$
DECLARE v_policy workhorse.maintenance_policy%ROWTYPE;
DECLARE v_previous workhorse.maintenance_policy%ROWTYPE;
BEGIN
  IF p_timezone IS NULL OR NOT EXISTS (
    SELECT 1 FROM pg_timezone_names timezone WHERE timezone.name = p_timezone
  ) THEN
    RAISE EXCEPTION 'maintenance timezone must be a valid IANA timezone name';
  END IF;
  SELECT * INTO STRICT v_previous FROM workhorse.maintenance_policy WHERE singleton FOR UPDATE;
  UPDATE workhorse.maintenance_policy policy SET
    application_timezone = p_timezone,
    application_partition_preparation_interval_ms = COALESCE(
      p_partition_preparation_interval_ms, policy.application_partition_preparation_interval_ms
    ),
    application_terminal_cleanup_interval_ms = COALESCE(
      p_terminal_cleanup_interval_ms, policy.application_terminal_cleanup_interval_ms
    ),
    application_history_retention_local_time = COALESCE(
      p_history_retention_local_time, policy.application_history_retention_local_time
    ),
    application_statistics_rollup_interval_ms = COALESCE(
      p_statistics_rollup_interval_ms, policy.application_statistics_rollup_interval_ms
    ),
    application_statistics_group_limit = COALESCE(
      p_statistics_group_limit, policy.application_statistics_group_limit
    ),
    application_statistics_recompute_buckets = COALESCE(
      p_statistics_recompute_buckets, policy.application_statistics_recompute_buckets
    ),
    timezone = CASE WHEN p_force OR NOT ('timezone' = ANY(policy.operator_overrides))
      THEN p_timezone ELSE policy.timezone END,
    partition_preparation_interval_ms = CASE
      WHEN p_force THEN COALESCE(
        p_partition_preparation_interval_ms, policy.application_partition_preparation_interval_ms
      )
      WHEN p_partition_preparation_interval_ms IS NULL THEN policy.partition_preparation_interval_ms
      WHEN NOT ('partition_preparation_interval_ms' = ANY(policy.operator_overrides))
        THEN p_partition_preparation_interval_ms
      ELSE policy.partition_preparation_interval_ms END,
    terminal_cleanup_interval_ms = CASE
      WHEN p_force THEN COALESCE(
        p_terminal_cleanup_interval_ms, policy.application_terminal_cleanup_interval_ms
      )
      WHEN p_terminal_cleanup_interval_ms IS NULL THEN policy.terminal_cleanup_interval_ms
      WHEN NOT ('terminal_cleanup_interval_ms' = ANY(policy.operator_overrides))
        THEN p_terminal_cleanup_interval_ms
      ELSE policy.terminal_cleanup_interval_ms END,
    history_retention_local_time = CASE
      WHEN p_force THEN COALESCE(
        p_history_retention_local_time, policy.application_history_retention_local_time
      )
      WHEN p_history_retention_local_time IS NULL THEN policy.history_retention_local_time
      WHEN NOT ('history_retention_local_time' = ANY(policy.operator_overrides))
        THEN p_history_retention_local_time
      ELSE policy.history_retention_local_time END,
    statistics_rollup_interval_ms = CASE
      WHEN p_force THEN COALESCE(
        p_statistics_rollup_interval_ms, policy.application_statistics_rollup_interval_ms
      )
      WHEN p_statistics_rollup_interval_ms IS NULL THEN policy.statistics_rollup_interval_ms
      WHEN NOT ('statistics_rollup_interval_ms' = ANY(policy.operator_overrides))
        THEN p_statistics_rollup_interval_ms
      ELSE policy.statistics_rollup_interval_ms END,
    statistics_group_limit = CASE
      WHEN p_force THEN COALESCE(
        p_statistics_group_limit, policy.application_statistics_group_limit
      )
      WHEN p_statistics_group_limit IS NULL THEN policy.statistics_group_limit
      WHEN NOT ('statistics_group_limit' = ANY(policy.operator_overrides))
        THEN p_statistics_group_limit
      ELSE policy.statistics_group_limit END,
    statistics_recompute_buckets = CASE
      WHEN p_force THEN COALESCE(
        p_statistics_recompute_buckets, policy.application_statistics_recompute_buckets
      )
      WHEN p_statistics_recompute_buckets IS NULL THEN policy.statistics_recompute_buckets
      WHEN NOT ('statistics_recompute_buckets' = ANY(policy.operator_overrides))
        THEN p_statistics_recompute_buckets
      ELSE policy.statistics_recompute_buckets END,
    operator_overrides = CASE WHEN p_force THEN '{}'::text[] ELSE policy.operator_overrides END,
    updated_at = clock_timestamp()
  WHERE singleton
  RETURNING * INTO v_policy;
  IF v_previous.timezone IS DISTINCT FROM v_policy.timezone
     OR v_previous.history_retention_local_time IS DISTINCT FROM v_policy.history_retention_local_time THEN
    UPDATE workhorse.maintenance_state
       SET last_completed_local_date = NULL, updated_at = clock_timestamp()
     WHERE task_name = 'history_retention';
  END IF;
  RETURN v_policy;
END;
$$;

CREATE OR REPLACE FUNCTION workhorse.override_maintenance_policy_v1(
  p_timezone text DEFAULT NULL,
  p_partition_preparation_interval_ms integer DEFAULT NULL,
  p_terminal_cleanup_interval_ms integer DEFAULT NULL,
  p_history_retention_local_time time DEFAULT NULL,
  p_statistics_rollup_interval_ms integer DEFAULT NULL,
  p_statistics_group_limit integer DEFAULT NULL,
  p_statistics_recompute_buckets integer DEFAULT NULL
) RETURNS workhorse.maintenance_policy
LANGUAGE plpgsql
AS $$
DECLARE v_policy workhorse.maintenance_policy%ROWTYPE;
DECLARE v_previous workhorse.maintenance_policy%ROWTYPE;
DECLARE v_overrides text[] := ARRAY[]::text[];
BEGIN
  IF p_timezone IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pg_timezone_names timezone WHERE timezone.name = p_timezone
  ) THEN
    RAISE EXCEPTION 'maintenance timezone must be a valid IANA timezone name';
  END IF;
  IF p_timezone IS NULL AND p_partition_preparation_interval_ms IS NULL
     AND p_terminal_cleanup_interval_ms IS NULL AND p_history_retention_local_time IS NULL
     AND p_statistics_rollup_interval_ms IS NULL AND p_statistics_group_limit IS NULL
     AND p_statistics_recompute_buckets IS NULL THEN
    RAISE EXCEPTION 'maintenance override must include at least one setting';
  END IF;
  IF p_timezone IS NOT NULL THEN v_overrides := array_append(v_overrides, 'timezone'); END IF;
  IF p_partition_preparation_interval_ms IS NOT NULL THEN
    v_overrides := array_append(v_overrides, 'partition_preparation_interval_ms');
  END IF;
  IF p_terminal_cleanup_interval_ms IS NOT NULL THEN
    v_overrides := array_append(v_overrides, 'terminal_cleanup_interval_ms');
  END IF;
  IF p_history_retention_local_time IS NOT NULL THEN
    v_overrides := array_append(v_overrides, 'history_retention_local_time');
  END IF;
  IF p_statistics_rollup_interval_ms IS NOT NULL THEN
    v_overrides := array_append(v_overrides, 'statistics_rollup_interval_ms');
  END IF;
  IF p_statistics_group_limit IS NOT NULL THEN
    v_overrides := array_append(v_overrides, 'statistics_group_limit');
  END IF;
  IF p_statistics_recompute_buckets IS NOT NULL THEN
    v_overrides := array_append(v_overrides, 'statistics_recompute_buckets');
  END IF;

  SELECT * INTO STRICT v_previous FROM workhorse.maintenance_policy WHERE singleton FOR UPDATE;
  UPDATE workhorse.maintenance_policy policy SET
    timezone = COALESCE(p_timezone, policy.timezone),
    partition_preparation_interval_ms = COALESCE(
      p_partition_preparation_interval_ms, policy.partition_preparation_interval_ms
    ),
    terminal_cleanup_interval_ms = COALESCE(
      p_terminal_cleanup_interval_ms, policy.terminal_cleanup_interval_ms
    ),
    history_retention_local_time = COALESCE(
      p_history_retention_local_time, policy.history_retention_local_time
    ),
    statistics_rollup_interval_ms = COALESCE(
      p_statistics_rollup_interval_ms, policy.statistics_rollup_interval_ms
    ),
    statistics_group_limit = COALESCE(p_statistics_group_limit, policy.statistics_group_limit),
    statistics_recompute_buckets = COALESCE(
      p_statistics_recompute_buckets, policy.statistics_recompute_buckets
    ),
    operator_overrides = ARRAY(
      SELECT DISTINCT name FROM unnest(policy.operator_overrides || v_overrides) name ORDER BY name
    ),
    updated_at = clock_timestamp()
  WHERE singleton
  RETURNING * INTO v_policy;
  IF v_previous.timezone IS DISTINCT FROM v_policy.timezone
     OR v_previous.history_retention_local_time IS DISTINCT FROM v_policy.history_retention_local_time THEN
    UPDATE workhorse.maintenance_state
       SET last_completed_local_date = NULL, updated_at = clock_timestamp()
     WHERE task_name = 'history_retention';
  END IF;
  RETURN v_policy;
END;
$$;

CREATE OR REPLACE FUNCTION workhorse.revert_maintenance_policy_v1(
  p_settings text[]
) RETURNS workhorse.maintenance_policy
LANGUAGE plpgsql
AS $$
DECLARE v_policy workhorse.maintenance_policy%ROWTYPE;
DECLARE v_previous workhorse.maintenance_policy%ROWTYPE;
BEGIN
  IF p_settings IS NULL OR cardinality(p_settings) = 0 OR NOT p_settings <@ ARRAY[
    'timezone', 'partition_preparation_interval_ms',
    'terminal_cleanup_interval_ms', 'history_retention_local_time',
    'statistics_rollup_interval_ms', 'statistics_group_limit', 'statistics_recompute_buckets'
  ]::text[] THEN
    RAISE EXCEPTION 'maintenance revert must name known settings';
  END IF;
  SELECT * INTO STRICT v_previous FROM workhorse.maintenance_policy WHERE singleton FOR UPDATE;
  UPDATE workhorse.maintenance_policy policy SET
    timezone = CASE WHEN 'timezone' = ANY(p_settings)
      THEN policy.application_timezone ELSE policy.timezone END,
    partition_preparation_interval_ms = CASE
      WHEN 'partition_preparation_interval_ms' = ANY(p_settings)
        THEN policy.application_partition_preparation_interval_ms
      ELSE policy.partition_preparation_interval_ms END,
    terminal_cleanup_interval_ms = CASE
      WHEN 'terminal_cleanup_interval_ms' = ANY(p_settings)
        THEN policy.application_terminal_cleanup_interval_ms
      ELSE policy.terminal_cleanup_interval_ms END,
    history_retention_local_time = CASE
      WHEN 'history_retention_local_time' = ANY(p_settings)
        THEN policy.application_history_retention_local_time
      ELSE policy.history_retention_local_time END,
    statistics_rollup_interval_ms = CASE
      WHEN 'statistics_rollup_interval_ms' = ANY(p_settings)
        THEN policy.application_statistics_rollup_interval_ms
      ELSE policy.statistics_rollup_interval_ms END,
    statistics_group_limit = CASE
      WHEN 'statistics_group_limit' = ANY(p_settings)
        THEN policy.application_statistics_group_limit
      ELSE policy.statistics_group_limit END,
    statistics_recompute_buckets = CASE
      WHEN 'statistics_recompute_buckets' = ANY(p_settings)
        THEN policy.application_statistics_recompute_buckets
      ELSE policy.statistics_recompute_buckets END,
    operator_overrides = ARRAY(
      SELECT name FROM unnest(policy.operator_overrides) name WHERE NOT (name = ANY(p_settings))
    ),
    updated_at = clock_timestamp()
  WHERE singleton
  RETURNING * INTO v_policy;
  IF v_previous.timezone IS DISTINCT FROM v_policy.timezone
     OR v_previous.history_retention_local_time IS DISTINCT FROM v_policy.history_retention_local_time THEN
    UPDATE workhorse.maintenance_state
       SET last_completed_local_date = NULL, updated_at = clock_timestamp()
     WHERE task_name = 'history_retention';
  END IF;
  RETURN v_policy;
END;
$$;

DROP VIEW workhorse.dashboard_maintenance_policy_v1;
CREATE OR REPLACE FUNCTION workhorse.rollup_stats_v1(
  p_force boolean DEFAULT false,
  p_now timestamptz DEFAULT clock_timestamp(),
  p_max_buckets integer DEFAULT 240
) RETURNS TABLE (
  phase text, rows_affected integer, duration_ms integer, skipped_lock boolean, error jsonb
)
LANGUAGE plpgsql
AS $$
DECLARE v_started_at timestamptz;
DECLARE v_state workhorse.job_stat_state%ROWTYPE;
DECLARE v_policy workhorse.retention_policy%ROWTYPE;
DECLARE v_maintenance workhorse.maintenance_policy%ROWTYPE;
DECLARE v_from timestamptz;
DECLARE v_to timestamptz;
DECLARE v_closed timestamptz;
BEGIN
  IF p_now IS NULL OR NOT isfinite(p_now) THEN RAISE EXCEPTION 'maintenance time is required'; END IF;
  IF p_max_buckets NOT BETWEEN 1 AND 100000 THEN
    RAISE EXCEPTION 'bucket limit must be between 1 and 100000';
  END IF;
  IF NOT pg_try_advisory_xact_lock(hashtextextended('workhorse:maintenance:stat-rollup', 0)) THEN
    RETURN QUERY VALUES
      ('stat_rollup'::text, 0, 0, true, NULL::jsonb),
      ('stat_retention'::text, 0, 0, true, NULL::jsonb);
    RETURN;
  END IF;
  SELECT * INTO STRICT v_maintenance FROM workhorse.maintenance_policy WHERE singleton;
  SELECT * INTO STRICT v_state FROM workhorse.job_stat_state WHERE singleton FOR UPDATE;
  SELECT * INTO STRICT v_policy FROM workhorse.retention_policy WHERE singleton;
  -- The cadence, recompute window, and group limit are maintenance policy, not caller options:
  -- a fleet shares one statistics contract, and a zero interval opts the whole fleet out while
  -- holding history retention at the current watermark. Force bypasses the cadence gate only.
  IF NOT p_force AND (
    v_maintenance.statistics_rollup_interval_ms = 0
    OR (v_state.last_run_at IS NOT NULL AND v_state.last_run_at > p_now - make_interval(
      secs => v_maintenance.statistics_rollup_interval_ms / 1000.0
    ))
  ) THEN
    RETURN;
  END IF;

  phase := 'stat_rollup';
  rows_affected := 0;
  skipped_lock := false;
  error := NULL;
  v_started_at := clock_timestamp();
  BEGIN
    v_closed := date_bin('1 minute', p_now, timestamp with time zone '2000-01-01');
    v_from := LEAST(
      v_state.rolled_up_through
        - make_interval(mins => v_maintenance.statistics_recompute_buckets),
      v_closed
    );
    -- Catching up after an outage advances in bounded passes rather than in one long transaction.
    v_to := LEAST(v_closed, v_from + make_interval(mins => p_max_buckets));
    IF v_to > v_from THEN
      DELETE FROM workhorse.job_stat_bucket
       WHERE bucket_start >= v_from AND bucket_start < v_to;
      INSERT INTO workhorse.job_stat_bucket (
        bucket_start, queue_name, job_type, enqueued,
        job_succeeded, job_failed, job_canceled,
        attempt_succeeded, attempt_failed, attempt_retry,
        attempt_lease_expired, attempt_canceled, attempt_other,
        attempt_duration_ms, last_attempt_at, last_error, last_error_at
      )
      SELECT * FROM workhorse.aggregate_stats_v1(v_from, v_to, v_maintenance.statistics_group_limit);
      GET DIAGNOSTICS rows_affected = ROW_COUNT;
      UPDATE workhorse.job_stat_state
         SET rolled_up_through = v_to, last_run_at = p_now, updated_at = clock_timestamp()
       WHERE singleton;
    ELSE
      UPDATE workhorse.job_stat_state
         SET last_run_at = p_now, updated_at = clock_timestamp()
       WHERE singleton;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    error := jsonb_build_object('code', SQLSTATE, 'message', SQLERRM);
  END;
  duration_ms := GREATEST(
    0, round(extract(epoch FROM clock_timestamp() - v_started_at) * 1000)::integer
  );
  RETURN NEXT;

  -- Bucket retention is bounded per pass like every other retained category. Shortening the policy
  -- makes the next pass eligible to delete months of buckets at once, and an unbounded statement
  -- there would hold a long lock on the relation every operator window reads.
  phase := 'stat_retention';
  rows_affected := 0;
  error := NULL;
  v_started_at := clock_timestamp();
  BEGIN
    IF v_policy.statistics_retention_days IS NOT NULL THEN
      WITH expired AS (
        SELECT bucket.ctid
          FROM workhorse.job_stat_bucket bucket
         WHERE bucket.bucket_start < p_now
               - make_interval(days => v_policy.statistics_retention_days)
         ORDER BY bucket.bucket_start
           FOR UPDATE SKIP LOCKED
         LIMIT v_policy.statistics_rows_per_pass
      )
      DELETE FROM workhorse.job_stat_bucket bucket USING expired
       WHERE bucket.ctid = expired.ctid;
      GET DIAGNOSTICS rows_affected = ROW_COUNT;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    error := jsonb_build_object('code', SQLSTATE, 'message', SQLERRM);
  END;
  duration_ms := GREATEST(
    0, round(extract(epoch FROM clock_timestamp() - v_started_at) * 1000)::integer
  );
  RETURN NEXT;
END;
$$;

CREATE OR REPLACE VIEW workhorse.dashboard_maintenance_policy_v1 AS
  SELECT singleton, timezone, partition_preparation_interval_ms, terminal_cleanup_interval_ms,
         history_retention_local_time, statistics_rollup_interval_ms, statistics_group_limit,
         statistics_recompute_buckets, updated_at FROM workhorse.maintenance_policy;
