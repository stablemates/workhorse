-- workhorse-migration: {"kind":"additive"}

-- Cold history export (ADR 0068).

-- Cold history export (ADR 0068). One deployment-owned switch: while it is on, retain_history_v1
-- will not delete a history day that no completed export covers, so an exporter that falls behind
-- holds history the same way a stalled rollup does. Off is the default and leaves PostgreSQL-only
-- operation unchanged.
CREATE TABLE IF NOT EXISTS workhorse.cold_export_policy (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  enabled boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
INSERT INTO workhorse.cold_export_policy(singleton) VALUES (true)
ON CONFLICT (singleton) DO NOTHING;

-- One exclusive, UTC-day-aligned watermark per exported dataset. Every history day below it has a
-- complete row in cold_export_segment. The row is created when export is first enabled.
CREATE TABLE IF NOT EXISTS workhorse.cold_export_dataset (
  dataset text PRIMARY KEY CHECK (dataset IN ('task_event', 'attempt_history')),
  exported_through timestamptz NOT NULL CHECK (isfinite(exported_through)),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

-- The export ledger: one row per (dataset, UTC day). Object names derive from this identity, so a
-- retried segment rewrites the same key with the same bytes. `attempts` fences completion the way a
-- fence token fences a task attempt: a stale exporter cannot complete a segment another one holds.
CREATE TABLE IF NOT EXISTS workhorse.cold_export_segment (
  dataset text NOT NULL CHECK (dataset IN ('task_event', 'attempt_history')),
  segment_start timestamptz NOT NULL CHECK (isfinite(segment_start)),
  segment_end timestamptz NOT NULL CHECK (isfinite(segment_end) AND segment_end > segment_start),
  status text NOT NULL CHECK (status IN ('exporting', 'complete')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  exporter_id text CHECK (
    exporter_id IS NULL OR (exporter_id <> '' AND octet_length(exporter_id) <= 256)
  ),
  lease_expires_at timestamptz,
  object_key text CHECK (object_key IS NULL OR (object_key <> '' AND octet_length(object_key) <= 1024)),
  manifest_key text CHECK (
    manifest_key IS NULL OR (manifest_key <> '' AND octet_length(manifest_key) <= 1024)
  ),
  checksum_sha256 text CHECK (checksum_sha256 IS NULL OR checksum_sha256 ~ '^[0-9a-f]{64}$'),
  byte_length bigint CHECK (byte_length IS NULL OR byte_length >= 0),
  row_count bigint CHECK (row_count IS NULL OR row_count >= 0),
  last_error jsonb,
  started_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (dataset, segment_start),
  CHECK (
    status <> 'complete'
    OR (row_count IS NOT NULL AND byte_length IS NOT NULL AND completed_at IS NOT NULL)
  ),
  CHECK ((row_count IS NULL OR row_count = 0) OR (object_key IS NOT NULL AND checksum_sha256 IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS cold_export_segment_exporting_idx
  ON workhorse.cold_export_segment (dataset, segment_start)
  WHERE status = 'exporting';

-- The newest UTC day boundary a segment may end at: the day must be closed and the statistics
-- rollup must have passed it, because rollup is what makes deletion safe and export precedes deletion.
CREATE OR REPLACE FUNCTION workhorse.cold_export_exportable_through_internal_v1(
  p_now timestamptz
) RETURNS timestamptz
LANGUAGE sql
STABLE
AS $$
  SELECT LEAST(
    date_bin('1 day', state.rolled_up_through, timestamp '2000-01-01' AT TIME ZONE 'UTC'),
    date_trunc('day', p_now AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
  )
    FROM workhorse.task_stat_state state
   WHERE state.singleton
$$;

-- The UTC day that holds the oldest retained row of one history dataset, or NULL when nothing is
-- retained. Day partitions answer from their bounds; the default partition is scanned for its minimum.
CREATE OR REPLACE FUNCTION workhorse.cold_export_oldest_history_day_internal_v1(
  p_dataset text
) RETURNS timestamptz
LANGUAGE plpgsql
STABLE
AS $$
DECLARE v_partition_day timestamptz;
DECLARE v_default_day timestamptz;
BEGIN
  IF p_dataset NOT IN ('task_event', 'attempt_history') THEN
    RAISE EXCEPTION 'cold export dataset must be task_event or attempt_history';
  END IF;
  SELECT min(((regexp_match(
           pg_get_expr(child.relpartbound, child.oid),
           'FROM \(''([^'']+)''\)'
         ))[1])::timestamptz)
    INTO v_partition_day
    FROM pg_inherits inheritance
    JOIN pg_class parent ON parent.oid = inheritance.inhparent
    JOIN pg_namespace namespace ON namespace.oid = parent.relnamespace
    JOIN pg_class child ON child.oid = inheritance.inhrelid
   WHERE namespace.nspname = 'workhorse'
     AND parent.relname = p_dataset
     AND child.relname <> p_dataset || '_default';
  IF p_dataset = 'task_event' THEN
    SELECT date_trunc('day', min(history.occurred_at) AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
      INTO v_default_day
      FROM workhorse.task_event_default history;
  ELSE
    SELECT date_trunc('day', min(history.occurred_at) AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
      INTO v_default_day
      FROM workhorse.attempt_history_default history;
  END IF;
  RETURN LEAST(v_partition_day, v_default_day);
END;
$$;

CREATE OR REPLACE FUNCTION workhorse.get_cold_export_status_v1()
RETURNS TABLE (
  enabled boolean,
  dataset text,
  exported_through timestamptz,
  exportable_through timestamptz,
  complete_segments bigint,
  exporting_segment_start timestamptz,
  exporting_attempts integer,
  last_error jsonb,
  updated_at timestamptz
)
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE(policy.enabled, false),
         names.dataset,
         exported.exported_through,
         workhorse.cold_export_exportable_through_internal_v1(clock_timestamp()),
         (SELECT count(*) FROM workhorse.cold_export_segment segment
           WHERE segment.dataset = names.dataset AND segment.status = 'complete'),
         exporting.segment_start,
         exporting.attempts,
         (SELECT failed.last_error FROM workhorse.cold_export_segment failed
           WHERE failed.dataset = names.dataset AND failed.last_error IS NOT NULL
           ORDER BY failed.updated_at DESC LIMIT 1),
         GREATEST(policy.updated_at, exported.updated_at)
    FROM unnest(ARRAY['task_event', 'attempt_history']) AS names(dataset)
    LEFT JOIN workhorse.cold_export_policy policy ON policy.singleton
    LEFT JOIN workhorse.cold_export_dataset exported ON exported.dataset = names.dataset
    LEFT JOIN LATERAL (
      SELECT segment.segment_start, segment.attempts
        FROM workhorse.cold_export_segment segment
       WHERE segment.dataset = names.dataset AND segment.status = 'exporting'
       ORDER BY segment.segment_start
       LIMIT 1
    ) exporting ON true
   ORDER BY names.dataset
$$;

-- Turn export on or off. Enabling starts each dataset at the UTC day of its oldest retained row
-- unless p_from names an earlier or later day; the start never moves once a dataset has one, and
-- re-enabling skips days retention deleted while export was off, because they cannot be exported.
CREATE OR REPLACE FUNCTION workhorse.set_cold_export_policy_v1(
  p_enabled boolean,
  p_from timestamptz DEFAULT NULL
) RETURNS TABLE (
  enabled boolean,
  dataset text,
  exported_through timestamptz,
  exportable_through timestamptz,
  complete_segments bigint,
  exporting_segment_start timestamptz,
  exporting_attempts integer,
  last_error jsonb,
  updated_at timestamptz
)
LANGUAGE plpgsql
AS $$
DECLARE v_policy workhorse.cold_export_policy%ROWTYPE;
DECLARE v_dataset text;
DECLARE v_existing timestamptz;
DECLARE v_oldest timestamptz;
DECLARE v_start timestamptz;
BEGIN
  IF p_enabled IS NULL THEN RAISE EXCEPTION 'cold export enabled flag is required'; END IF;
  IF p_from IS NOT NULL AND NOT isfinite(p_from) THEN
    RAISE EXCEPTION 'cold export start must be a finite timestamp';
  END IF;
  IF p_from IS NOT NULL AND NOT p_enabled THEN
    RAISE EXCEPTION 'cold export start applies only when enabling export';
  END IF;
  INSERT INTO workhorse.cold_export_policy(singleton) VALUES (true)
  ON CONFLICT (singleton) DO NOTHING;
  SELECT * INTO STRICT v_policy FROM workhorse.cold_export_policy WHERE singleton FOR UPDATE;
  IF p_enabled THEN
    FOREACH v_dataset IN ARRAY ARRAY['task_event', 'attempt_history'] LOOP
      v_oldest := COALESCE(
        workhorse.cold_export_oldest_history_day_internal_v1(v_dataset),
        date_trunc('day', clock_timestamp() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
      );
      SELECT exported.exported_through INTO v_existing
        FROM workhorse.cold_export_dataset exported
       WHERE exported.dataset = v_dataset
         FOR UPDATE;
      IF FOUND THEN
        IF p_from IS NOT NULL
           AND date_trunc('day', p_from AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' <> v_existing THEN
          RAISE EXCEPTION 'cold export of % already started at %; the start cannot move',
            v_dataset, v_existing;
        END IF;
        UPDATE workhorse.cold_export_dataset exported
           SET exported_through = GREATEST(exported.exported_through, v_oldest),
               updated_at = clock_timestamp()
         WHERE exported.dataset = v_dataset
           AND exported.exported_through < v_oldest;
      ELSE
        v_start := COALESCE(
          date_trunc('day', p_from AT TIME ZONE 'UTC') AT TIME ZONE 'UTC', v_oldest
        );
        INSERT INTO workhorse.cold_export_dataset(dataset, exported_through)
        VALUES (v_dataset, v_start);
      END IF;
    END LOOP;
  END IF;
  UPDATE workhorse.cold_export_policy policy
     SET enabled = p_enabled,
         updated_at = CASE WHEN policy.enabled = p_enabled THEN policy.updated_at
                           ELSE clock_timestamp() END
   WHERE policy.singleton;
  RETURN QUERY SELECT * FROM workhorse.get_cold_export_status_v1();
END;
$$;

-- Hand one exporter the next day to export, oldest first. An abandoned segment whose lease has
-- lapsed is handed out again before a new one is opened, so a crashed export resumes rather than
-- leaving a hole. Nothing is handed out while export is off or while another exporter holds a lease.
CREATE OR REPLACE FUNCTION workhorse.claim_cold_export_segment_v1(
  p_dataset text,
  p_exporter_id text,
  p_lease_ms integer,
  p_now timestamptz DEFAULT clock_timestamp()
) RETURNS TABLE (
  dataset text,
  segment_start timestamptz,
  segment_end timestamptz,
  attempts integer,
  exportable_through timestamptz
)
LANGUAGE plpgsql
AS $$
DECLARE v_enabled boolean;
DECLARE v_exported_through timestamptz;
DECLARE v_limit timestamptz;
DECLARE v_segment workhorse.cold_export_segment%ROWTYPE;
BEGIN
  IF p_dataset NOT IN ('task_event', 'attempt_history') THEN
    RAISE EXCEPTION 'cold export dataset must be task_event or attempt_history';
  END IF;
  IF p_exporter_id IS NULL OR p_exporter_id = '' OR octet_length(p_exporter_id) > 256 THEN
    RAISE EXCEPTION 'cold export exporter id must contain 1 through 256 bytes';
  END IF;
  IF p_lease_ms IS NULL OR p_lease_ms NOT BETWEEN 1000 AND 86400000 THEN
    RAISE EXCEPTION 'cold export lease must be between 1000 and 86400000 milliseconds';
  END IF;
  IF p_now IS NULL OR NOT isfinite(p_now) THEN RAISE EXCEPTION 'claim time is required'; END IF;
  SELECT policy.enabled INTO v_enabled
    FROM workhorse.cold_export_policy policy WHERE policy.singleton;
  IF NOT COALESCE(v_enabled, false) THEN RETURN; END IF;
  SELECT exported.exported_through INTO v_exported_through
    FROM workhorse.cold_export_dataset exported
   WHERE exported.dataset = p_dataset
     FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  v_limit := workhorse.cold_export_exportable_through_internal_v1(p_now);

  SELECT * INTO v_segment
    FROM workhorse.cold_export_segment segment
   WHERE segment.dataset = p_dataset AND segment.status = 'exporting'
   ORDER BY segment.segment_start
   LIMIT 1
     FOR UPDATE;
  IF FOUND THEN
    IF v_segment.lease_expires_at IS NOT NULL AND v_segment.lease_expires_at > p_now THEN
      RETURN;
    END IF;
    UPDATE workhorse.cold_export_segment segment
       SET attempts = segment.attempts + 1,
           exporter_id = p_exporter_id,
           lease_expires_at = p_now + make_interval(secs => p_lease_ms / 1000.0),
           started_at = p_now,
           updated_at = clock_timestamp()
     WHERE segment.dataset = v_segment.dataset
       AND segment.segment_start = v_segment.segment_start
    RETURNING * INTO v_segment;
  ELSE
    IF v_exported_through + interval '1 day' > v_limit THEN RETURN; END IF;
    INSERT INTO workhorse.cold_export_segment(
      dataset, segment_start, segment_end, status, attempts, exporter_id, lease_expires_at,
      started_at
    ) VALUES (
      p_dataset, v_exported_through, v_exported_through + interval '1 day', 'exporting', 1,
      p_exporter_id, p_now + make_interval(secs => p_lease_ms / 1000.0), p_now
    )
    RETURNING * INTO v_segment;
  END IF;
  dataset := v_segment.dataset;
  segment_start := v_segment.segment_start;
  segment_end := v_segment.segment_end;
  attempts := v_segment.attempts;
  exportable_through := v_limit;
  RETURN NEXT;
END;
$$;

-- One keyset page of a history dataset inside a segment, in immutable identity order. The page
-- reads the parent relation so partition pruning selects the day, and to_jsonb keeps every column.
CREATE OR REPLACE FUNCTION workhorse.read_cold_export_rows_v1(
  p_dataset text,
  p_from timestamptz,
  p_to timestamptz,
  p_after_occurred_at timestamptz,
  p_after_id uuid,
  p_limit integer
) RETURNS TABLE (occurred_at timestamptz, row_id uuid, record jsonb)
LANGUAGE plpgsql
STABLE
AS $$
BEGIN
  IF p_from IS NULL OR p_to IS NULL OR NOT isfinite(p_from) OR NOT isfinite(p_to) OR p_to <= p_from THEN
    RAISE EXCEPTION 'cold export segment bounds must be a finite half-open range';
  END IF;
  IF (p_after_occurred_at IS NULL) <> (p_after_id IS NULL) THEN
    RAISE EXCEPTION 'cold export cursor needs both a time and an identity';
  END IF;
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100000 THEN
    RAISE EXCEPTION 'cold export page size must be between 1 and 100000';
  END IF;
  IF p_dataset = 'task_event' THEN
    RETURN QUERY
      SELECT history.occurred_at, history.event_id, to_jsonb(history)
        FROM workhorse.task_event history
       WHERE history.occurred_at >= p_from AND history.occurred_at < p_to
         AND (p_after_id IS NULL
              OR (history.occurred_at, history.event_id) > (p_after_occurred_at, p_after_id))
       ORDER BY history.occurred_at, history.event_id
       LIMIT p_limit;
  ELSIF p_dataset = 'attempt_history' THEN
    RETURN QUERY
      SELECT history.occurred_at, history.attempt_id, to_jsonb(history)
        FROM workhorse.attempt_history history
       WHERE history.occurred_at >= p_from AND history.occurred_at < p_to
         AND (p_after_id IS NULL
              OR (history.occurred_at, history.attempt_id) > (p_after_occurred_at, p_after_id))
       ORDER BY history.occurred_at, history.attempt_id
       LIMIT p_limit;
  ELSE
    RAISE EXCEPTION 'cold export dataset must be task_event or attempt_history';
  END IF;
END;
$$;

-- Record a finished segment and advance the dataset watermark across every contiguous complete
-- day. The attempt number must match the claim, so a stale exporter cannot complete a segment that
-- has since been handed to another one.
CREATE OR REPLACE FUNCTION workhorse.complete_cold_export_segment_v1(
  p_dataset text,
  p_segment_start timestamptz,
  p_attempts integer,
  p_object_key text,
  p_manifest_key text,
  p_checksum_sha256 text,
  p_byte_length bigint,
  p_row_count bigint
) RETURNS timestamptz
LANGUAGE plpgsql
AS $$
DECLARE v_segment workhorse.cold_export_segment%ROWTYPE;
DECLARE v_exported_through timestamptz;
DECLARE v_next_end timestamptz;
BEGIN
  IF p_row_count IS NULL OR p_row_count < 0 OR p_byte_length IS NULL OR p_byte_length < 0 THEN
    RAISE EXCEPTION 'cold export segment counts must be non-negative';
  END IF;
  SELECT exported.exported_through INTO v_exported_through
    FROM workhorse.cold_export_dataset exported
   WHERE exported.dataset = p_dataset
     FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'cold export of % has not been enabled', p_dataset; END IF;
  SELECT * INTO v_segment
    FROM workhorse.cold_export_segment segment
   WHERE segment.dataset = p_dataset AND segment.segment_start = p_segment_start
     FOR UPDATE;
  IF NOT FOUND OR v_segment.status <> 'exporting' OR v_segment.attempts IS DISTINCT FROM p_attempts THEN
    RAISE EXCEPTION 'cold export segment % starting % is not held by attempt %',
      p_dataset, p_segment_start, p_attempts;
  END IF;
  UPDATE workhorse.cold_export_segment segment
     SET status = 'complete',
         object_key = p_object_key,
         manifest_key = p_manifest_key,
         checksum_sha256 = p_checksum_sha256,
         byte_length = p_byte_length,
         row_count = p_row_count,
         lease_expires_at = NULL,
         last_error = NULL,
         completed_at = clock_timestamp(),
         updated_at = clock_timestamp()
   WHERE segment.dataset = p_dataset AND segment.segment_start = p_segment_start;
  LOOP
    SELECT segment.segment_end INTO v_next_end
      FROM workhorse.cold_export_segment segment
     WHERE segment.dataset = p_dataset
       AND segment.segment_start = v_exported_through
       AND segment.status = 'complete';
    EXIT WHEN NOT FOUND;
    v_exported_through := v_next_end;
  END LOOP;
  UPDATE workhorse.cold_export_dataset exported
     SET exported_through = v_exported_through, updated_at = clock_timestamp()
   WHERE exported.dataset = p_dataset
     AND exported.exported_through <> v_exported_through;
  RETURN v_exported_through;
END;
$$;

-- Release a segment after a failed attempt and keep the error for the status read. The next claim
-- hands the same day out again immediately, with the same object names.
CREATE OR REPLACE FUNCTION workhorse.fail_cold_export_segment_v1(
  p_dataset text,
  p_segment_start timestamptz,
  p_attempts integer,
  p_error jsonb
) RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE v_updated integer;
BEGIN
  UPDATE workhorse.cold_export_segment segment
     SET lease_expires_at = NULL,
         last_error = COALESCE(p_error, '{}'::jsonb),
         updated_at = clock_timestamp()
   WHERE segment.dataset = p_dataset
     AND segment.segment_start = p_segment_start
     AND segment.status = 'exporting'
     AND segment.attempts = p_attempts;
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  IF v_updated = 0 THEN
    RAISE EXCEPTION 'cold export segment % starting % is not held by attempt %',
      p_dataset, p_segment_start, p_attempts;
  END IF;
END;
$$;

-- History retention now also waits for a completed cold export while export is enabled.
CREATE OR REPLACE FUNCTION workhorse.retain_history_v1(
  p_force boolean DEFAULT false,
  p_now timestamptz DEFAULT clock_timestamp()
) RETURNS TABLE (
  phase text, rows_affected integer, duration_ms integer, skipped_lock boolean, error jsonb
)
LANGUAGE plpgsql
AS $$
DECLARE v_started_at timestamptz;
DECLARE v_policy workhorse.retention_policy%ROWTYPE;
DECLARE v_maintenance workhorse.maintenance_policy%ROWTYPE;
DECLARE v_state workhorse.maintenance_state%ROWTYPE;
DECLARE v_local_now timestamp;
DECLARE v_event_before timestamptz;
DECLARE v_attempt_before timestamptz;
DECLARE v_occurrence_before timestamptz;
DECLARE v_safe_before timestamptz;
DECLARE v_rolled_up_through timestamptz;
DECLARE v_cold_export_enabled boolean;
DECLARE v_event_exported_through timestamptz;
DECLARE v_attempt_exported_through timestamptz;
DECLARE v_success boolean := true;
DECLARE v_complete boolean := false;
DECLARE v_run_started_at timestamptz;
DECLARE v_run_completed_at timestamptz;
DECLARE v_rows_affected integer := 0;
DECLARE v_phases jsonb := '[]'::jsonb;
BEGIN
  IF p_now IS NULL OR NOT isfinite(p_now) THEN RAISE EXCEPTION 'maintenance time is required'; END IF;
  IF NOT pg_try_advisory_xact_lock(
    hashtextextended('workhorse:maintenance:history-retention', 0)
  ) THEN
    RETURN QUERY VALUES
      ('event_retention'::text, 0, 0, true, NULL::jsonb),
      ('attempt_retention'::text, 0, 0, true, NULL::jsonb),
      ('schedule_occurrences'::text, 0, 0, true, NULL::jsonb);
    RETURN;
  END IF;
  SELECT * INTO STRICT v_policy FROM workhorse.retention_policy WHERE singleton;
  SELECT * INTO STRICT v_maintenance FROM workhorse.maintenance_policy WHERE singleton;
  SELECT * INTO STRICT v_state FROM workhorse.maintenance_state
   WHERE routine_name = 'history_retention' FOR UPDATE;
  v_local_now := p_now AT TIME ZONE v_maintenance.timezone;
  IF NOT p_force AND (
    v_local_now::time(0) < v_maintenance.history_retention_local_time
    OR v_state.last_completed_local_date >= v_local_now::date
  ) THEN
    RETURN;
  END IF;
  v_run_started_at := clock_timestamp();
  UPDATE workhorse.maintenance_state SET last_started_at = p_now, updated_at = clock_timestamp()
   WHERE routine_name = 'history_retention';
  v_event_before := date_trunc('day', p_now AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
    - make_interval(days => COALESCE(v_policy.task_event_retention_days, 0));
  v_attempt_before := date_trunc('day', p_now AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
    - make_interval(days => COALESCE(v_policy.attempt_history_retention_days, 0));
  v_occurrence_before := p_now
    - make_interval(days => COALESCE(v_policy.schedule_occurrence_retention_days, 0));
  -- Raw history is the only input a statistics bucket can be rebuilt from. Deleting past the rollup
  -- watermark would create a permanent hole in long-window operator views, so a stalled rollup
  -- holds history instead: the cutoff waits, retention reports itself incomplete, and the growing
  -- retention lag is what surfaces on the health page.
  SELECT state.rolled_up_through INTO v_rolled_up_through
    FROM workhorse.task_stat_state state WHERE state.singleton;
  IF v_rolled_up_through IS NOT NULL THEN
    v_event_before := LEAST(v_event_before, v_rolled_up_through);
    v_attempt_before := LEAST(v_attempt_before, v_rolled_up_through);
  END IF;
  -- A completed cold export is the second interlock, and only while export is enabled. Deleting a
  -- day that no export covers would leave the archive permanently incomplete, so an exporter that
  -- falls behind holds history the same way a stalled rollup does and surfaces the same way.
  SELECT policy.enabled INTO v_cold_export_enabled
    FROM workhorse.cold_export_policy policy WHERE policy.singleton;
  IF COALESCE(v_cold_export_enabled, false) THEN
    SELECT exported.exported_through INTO v_event_exported_through
      FROM workhorse.cold_export_dataset exported WHERE exported.dataset = 'task_event';
    SELECT exported.exported_through INTO v_attempt_exported_through
      FROM workhorse.cold_export_dataset exported WHERE exported.dataset = 'attempt_history';
    v_event_before := LEAST(
      v_event_before,
      COALESCE(v_event_exported_through, timestamp '2000-01-01' AT TIME ZONE 'UTC')
    );
    v_attempt_before := LEAST(
      v_attempt_before,
      COALESCE(v_attempt_exported_through, timestamp '2000-01-01' AT TIME ZONE 'UTC')
    );
  END IF;

  phase := 'event_retention';
  rows_affected := 0;
  skipped_lock := false;
  error := NULL;
  v_started_at := clock_timestamp();
  BEGIN
    IF v_policy.task_event_retention_days IS NOT NULL THEN
      rows_affected := workhorse.retire_history_partitions_v1(
        'task_event', v_event_before, v_policy.history_partitions_per_pass
      );
      rows_affected := rows_affected + workhorse.prune_default_history_v1(
        'task_event', v_event_before, v_policy.default_partition_rows_per_pass
      );
    END IF;
  EXCEPTION WHEN OTHERS THEN
    error := jsonb_build_object('code', SQLSTATE, 'message', SQLERRM);
    v_success := false;
  END;
  duration_ms := GREATEST(
    0, round(extract(epoch FROM clock_timestamp() - v_started_at) * 1000)::integer
  );
  v_rows_affected := v_rows_affected + rows_affected;
  v_phases := v_phases || jsonb_build_array(jsonb_build_object(
    'phase', phase, 'rowsAffected', rows_affected, 'durationMs', duration_ms,
    'error', error
  ));
  RETURN NEXT;

  phase := 'attempt_retention';
  rows_affected := 0;
  error := NULL;
  v_started_at := clock_timestamp();
  BEGIN
    IF v_policy.attempt_history_retention_days IS NOT NULL THEN
      rows_affected := workhorse.retire_history_partitions_v1(
        'attempt_history', v_attempt_before, v_policy.history_partitions_per_pass
      );
      rows_affected := rows_affected + workhorse.prune_default_history_v1(
        'attempt_history', v_attempt_before, v_policy.default_partition_rows_per_pass
      );
    END IF;
  EXCEPTION WHEN OTHERS THEN
    error := jsonb_build_object('code', SQLSTATE, 'message', SQLERRM);
    v_success := false;
  END;
  duration_ms := GREATEST(
    0, round(extract(epoch FROM clock_timestamp() - v_started_at) * 1000)::integer
  );
  v_rows_affected := v_rows_affected + rows_affected;
  v_phases := v_phases || jsonb_build_array(jsonb_build_object(
    'phase', phase, 'rowsAffected', rows_affected, 'durationMs', duration_ms,
    'error', error
  ));
  RETURN NEXT;

  phase := 'schedule_occurrences';
  rows_affected := 0;
  error := NULL;
  v_started_at := clock_timestamp();
  BEGIN
    IF v_policy.schedule_occurrence_retention_days IS NOT NULL THEN
      rows_affected := workhorse.prune_schedule_occurrences_v1(
        v_occurrence_before,
        v_policy.occurrence_rows_per_pass
      );
    END IF;
  EXCEPTION WHEN OTHERS THEN
    error := jsonb_build_object('code', SQLSTATE, 'message', SQLERRM);
    v_success := false;
  END;
  duration_ms := GREATEST(
    0, round(extract(epoch FROM clock_timestamp() - v_started_at) * 1000)::integer
  );
  v_rows_affected := v_rows_affected + rows_affected;
  v_phases := v_phases || jsonb_build_array(jsonb_build_object(
    'phase', phase, 'rowsAffected', rows_affected, 'durationMs', duration_ms,
    'error', error
  ));
  RETURN NEXT;

  IF v_success THEN
    v_complete := (
      v_policy.task_event_retention_days IS NULL
      OR workhorse.history_retention_complete_v1('task_event', v_event_before)
    ) AND (
      v_policy.attempt_history_retention_days IS NULL
      OR workhorse.history_retention_complete_v1('attempt_history', v_attempt_before)
    ) AND (
      v_policy.schedule_occurrence_retention_days IS NULL
      OR NOT EXISTS (
        SELECT 1 FROM workhorse.schedule_occurrence
         WHERE occurrence_at < v_occurrence_before
      )
    );
    IF v_complete THEN
      v_safe_before := LEAST(v_event_before, v_attempt_before);
      UPDATE workhorse.maintenance_state
         SET last_completed_at = p_now,
             last_completed_local_date = v_local_now::date,
             history_retained_before = GREATEST(history_retained_before, v_safe_before),
             updated_at = clock_timestamp()
      WHERE routine_name = 'history_retention';
    END IF;
  END IF;
  v_run_completed_at := clock_timestamp();
  PERFORM workhorse.record_maintenance_run_internal_v1(
    'history_retention', v_run_started_at, v_run_completed_at,
    CASE WHEN NOT v_success THEN 'failed'
         WHEN v_complete THEN 'succeeded'
         ELSE 'incomplete' END,
    v_rows_affected, v_phases
  );
END;
$$;

INSERT INTO workhorse.protocol_version(version) VALUES (4) ON CONFLICT DO NOTHING;
