-- workhorse-migration: {"kind":"additive"}

-- Make the advisory lock keys of history days and schedule occurrences unambiguous (SM-1665).

-- A history-day lock key converted its date to text with the session DateStyle. Two sessions with
-- different DateStyle settings therefore took different locks for one day and did not exclude each
-- other. After this step, create_history_day_v1, retire_history_day_v1, and
-- retire_history_partitions_v1 write the day with to_char(day::timestamp, 'YYYY-MM-DD'). Under an
-- ISO DateStyle, the PostgreSQL default, the key is the same as before.
--
-- to_char has no date overload, so it converts a date to timestamptz in the session TimeZone. The
-- partition names in create_history_day_v1, retire_history_day_v1, and
-- prepare_history_partitions_v1 used to_char on a date. In a zone that skipped a whole day, such as
-- Pacific/Apia on 2011-12-30, the name of that day therefore named the next day. These functions
-- now cast the day to timestamp before to_char. The new day lock keys use the same cast, so neither
-- a lock key nor a partition name depends on the session TimeZone.
--
-- Only a calendar day that the session time zone skipped can produce such a name. Examples are
-- 2011-12-30 in Pacific/Apia and in Pacific/Fakaofo. An earlier body that created that day in such
-- a session named the partition after the next day. Before this step, retire_history_day_v1 for
-- the next day dropped that partition, which holds the rows of the wrong day. The repair block at
-- the end of this step renames such a partition to the name of its UTC day.
--
-- A schedule occurrence lock key joined the namespace, the schedule name, and the occurrence
-- second with colons. A namespace or a name can contain a colon. Thus the occurrences of two
-- different schedules could share one key, and one pass could falsely defer the other. After this
-- step, fire_schedule_v1 and fire_due_schedules_v2 hash the three values as separate elements of
-- a JSON array.
--
-- No signature, result column, or documented guarantee changes, so each function keeps its suffix
-- (ADR 0109). No document states a key string. Duplicate-occurrence protection, busy-occurrence
-- deferral, and the order of the history parent locks stay the same.
--
-- Every call that starts after this step commits runs the new body. A transaction can already be
-- inside an old body when the step commits. It can then hold an old key while a new body takes a
-- new key. That overlap lasts at most for that one transaction.
--
-- During the overlap, each history-day function still takes ACCESS EXCLUSIVE on attempt_history
-- and then task_event before its DDL. Thus the DDL of one day stays serialized. A duplicate
-- partition creation can fail its maintenance phase, and the next pass repeats the phase.
--
-- During the overlap, the definition row lock in fire_schedule_v1 makes a second caller of one
-- occurrence wait. The primary key of schedule_occurrence with ON CONFLICT DO NOTHING then makes
-- it return a null task id if the holder committed. If the holder rolled back, the second caller
-- fires the occurrence. Thus no occurrence fires twice and none is lost.

CREATE OR REPLACE FUNCTION workhorse.fire_schedule_v1(
  p_namespace text,
  p_schedule_name text,
  p_expected_revision bigint,
  p_occurrence_at timestamptz DEFAULT date_trunc('second', clock_timestamp())
) RETURNS uuid
LANGUAGE plpgsql
AS $$
DECLARE
  v_definition workhorse.schedule_definition%ROWTYPE;
  v_task_id uuid;
BEGIN
  -- The key keeps the namespace, the name, and the second as separate JSON array elements. A colon
  -- in a namespace or a name therefore cannot make two occurrences share one key (SM-1665).
  IF NOT pg_try_advisory_xact_lock(hashtextextended(
    'workhorse:schedule-occurrence:' || jsonb_build_array(
      p_namespace,
      p_schedule_name,
      extract(epoch FROM date_trunc('second', p_occurrence_at))::bigint
    )::text,
    0
  )) THEN
    RETURN NULL;
  END IF;

  SELECT * INTO v_definition
    FROM workhorse.schedule_definition definition
   WHERE definition.namespace = p_namespace
     AND definition.schedule_name = p_schedule_name
     AND definition.configured_enabled
     AND NOT definition.paused
     AND definition.revision = p_expected_revision
   FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;

  INSERT INTO workhorse.schedule_occurrence(namespace, schedule_name, occurrence_at)
    VALUES (p_namespace, p_schedule_name, date_trunc('second', p_occurrence_at))
  ON CONFLICT DO NOTHING
  RETURNING task_id INTO v_task_id;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  v_task_id := workhorse.enqueue_v1(
    v_definition.queue_name,
    v_definition.task_type,
    v_definition.payload,
    clock_timestamp(),
    v_definition.max_attempts,
    '{}',
    v_definition.retry_policy,
    v_definition.contract_version,
    v_definition.payload_max_bytes,
    v_definition.result_max_bytes,
    v_definition.payload_redact_keys,
    v_definition.result_redact_keys,
    v_definition.concurrency_key,
    v_definition.priority
  );
  UPDATE workhorse.schedule_occurrence occurrence
     SET task_id = v_task_id
   WHERE occurrence.namespace = p_namespace
     AND occurrence.schedule_name = p_schedule_name
     AND occurrence.occurrence_at = date_trunc('second', p_occurrence_at);
  RETURN v_task_id;
END;
$$;

CREATE OR REPLACE FUNCTION workhorse.fire_due_schedules_v2(
  p_namespaces text[],
  p_now timestamptz,
  p_catchup_limit integer,
  p_evaluation_window_ms bigint
) RETURNS TABLE(
  namespace text,
  schedule_name text,
  occurrence_at timestamptz,
  task_id uuid
)
LANGUAGE plpgsql
AS $$
DECLARE
  v_definition record;
  v_namespace text;
  v_occurrence timestamptz;
  v_evaluation_start timestamptz;
  v_last_evaluated_at timestamptz;
  v_evaluated_count integer;
  v_deferred boolean;
  v_next_evaluated_at timestamptz;
  v_locked_namespaces text[] := '{}';
  v_skip_before timestamptz;
  v_skipped_count integer;
  v_skipped_through timestamptz;
BEGIN
  IF p_namespaces IS NULL OR array_position(p_namespaces, '') IS NOT NULL THEN
    RAISE EXCEPTION 'schedule namespaces must contain non-empty names';
  END IF;
  p_now := COALESCE(p_now, clock_timestamp());
  IF p_catchup_limit IS NULL OR p_catchup_limit NOT BETWEEN 1 AND 10000 THEN
    RAISE EXCEPTION 'schedule catch-up limit must be between 1 and 10000';
  END IF;
  IF p_evaluation_window_ms < 100 THEN
    RAISE EXCEPTION 'schedule evaluation window must be at least 100 milliseconds';
  END IF;
  -- The supported delay is the longest gap between two passes that `skip` still fires in full.
  -- A later occurrence is never older than it.
  v_skip_before := p_now - GREATEST(
    interval '60 seconds',
    make_interval(secs => p_evaluation_window_ms::double precision * 2 / 1000)
  );

  -- Try each namespace lock before any read of schedule_occurrence. A namespace that another pass
  -- holds costs this pass one lock attempt and no history read.
  FOR v_namespace IN
    SELECT DISTINCT definition.namespace
      FROM workhorse.schedule_definition definition
     WHERE definition.configured_enabled
       AND NOT definition.paused
       AND definition.namespace = ANY(p_namespaces)
     ORDER BY definition.namespace
  LOOP
    IF pg_try_advisory_xact_lock(hashtextextended(
      'workhorse:schedule-namespace:' || v_namespace,
      0
    )) THEN
      v_locked_namespaces := array_append(v_locked_namespaces, v_namespace);
    END IF;
  END LOOP;
  IF cardinality(v_locked_namespaces) = 0 THEN RETURN; END IF;

  FOR v_definition IN
    SELECT definition.namespace, definition.schedule_name, definition.cron_expression,
           definition.timezone, definition.revision, definition.catchup_policy,
           definition.last_evaluated_at,
           (
             SELECT occurrence.occurrence_at
               FROM workhorse.schedule_occurrence occurrence
              WHERE occurrence.namespace = definition.namespace
                AND occurrence.schedule_name = definition.schedule_name
              ORDER BY occurrence.occurrence_at DESC
              LIMIT 1
           ) AS last_occurrence_at
      FROM workhorse.schedule_definition definition
     WHERE definition.configured_enabled
       AND NOT definition.paused
       AND definition.namespace = ANY(v_locked_namespaces)
     ORDER BY definition.namespace, definition.schedule_name
  LOOP
    v_evaluation_start := GREATEST(
      v_definition.last_evaluated_at,
      v_definition.last_occurrence_at
    );
    v_skipped_count := 0;
    v_skipped_through := NULL;
    IF v_definition.catchup_policy = 'skip' AND v_evaluation_start < v_skip_before THEN
      -- Count the occurrences older than the supported delay, up to 10,000, and find the newest
      -- of them. The pass fires only the occurrences after it.
      SELECT count(*)::integer, max(skipped.occurrence_at)
        INTO v_skipped_count, v_skipped_through
        FROM workhorse.cron_occurrences_v1(
          v_definition.cron_expression,
          v_evaluation_start,
          v_skip_before - interval '1 microsecond',
          10000,
          v_definition.timezone
        ) skipped;
      IF v_skipped_count = 10000 THEN
        SELECT newest.occurrence_at INTO v_skipped_through
          FROM workhorse.cron_occurrences_v1(
            v_definition.cron_expression,
            NULL,
            v_skip_before - interval '1 microsecond',
            1,
            v_definition.timezone
          ) newest;
      END IF;
      IF v_skipped_count > 0 THEN
        v_evaluation_start := v_skipped_through;
      END IF;
    END IF;
    v_evaluated_count := 0;
    v_last_evaluated_at := NULL;
    v_deferred := false;

    FOR v_occurrence IN
      SELECT evaluated.occurrence_at
        FROM workhorse.cron_occurrences_v1(
          v_definition.cron_expression,
          CASE WHEN v_definition.catchup_policy = 'latest'
            THEN NULL ELSE v_evaluation_start END,
          p_now,
          CASE WHEN v_definition.catchup_policy = 'latest'
            THEN 1 ELSE p_catchup_limit END,
          v_definition.timezone
        ) evaluated
       WHERE evaluated.occurrence_at > v_evaluation_start
    LOOP
      -- Another transaction holds this occurrence. It may still roll back, so this pass neither
      -- reports the occurrence nor evaluates anything after it, and the durable position below
      -- stays behind it. `fire_schedule_v1` takes the same lock again, which a transaction that
      -- already holds it always wins.
      IF NOT pg_try_advisory_xact_lock(hashtextextended(
        'workhorse:schedule-occurrence:' || jsonb_build_array(
          v_definition.namespace,
          v_definition.schedule_name,
          extract(epoch FROM date_trunc('second', v_occurrence))::bigint
        )::text,
        0
      )) THEN
        v_deferred := true;
        EXIT;
      END IF;
      v_evaluated_count := v_evaluated_count + 1;
      v_last_evaluated_at := v_occurrence;
      namespace := v_definition.namespace;
      schedule_name := v_definition.schedule_name;
      occurrence_at := v_occurrence;
      task_id := workhorse.fire_schedule_v1(
        v_definition.namespace,
        v_definition.schedule_name,
        v_definition.revision,
        v_occurrence
      );
      RETURN NEXT;
    END LOOP;

    -- A `skip` or `all` pass that reaches the catch-up limit advances only through its last
    -- occurrence, so the next pass fires the rest.
    v_next_evaluated_at := CASE
      WHEN v_deferred THEN v_last_evaluated_at
      WHEN v_definition.catchup_policy IN ('skip', 'all')
        AND v_evaluated_count = p_catchup_limit
        AND v_last_evaluated_at IS NOT NULL
      THEN v_last_evaluated_at
      ELSE p_now
    END;
    -- A pass deferred before its first occurrence leaves the position and the skip record alone, so
    -- it never waits on the row lock the transaction holding that occurrence already owns. The next
    -- pass records the same skip.
    IF v_next_evaluated_at IS DISTINCT FROM v_definition.last_evaluated_at
      AND v_next_evaluated_at IS NOT NULL THEN
      UPDATE workhorse.schedule_definition definition
         SET last_evaluated_at = v_next_evaluated_at,
             last_skipped_at = CASE
               WHEN v_skipped_count > 0 THEN p_now ELSE definition.last_skipped_at
             END,
             last_skipped_count = CASE
               WHEN v_skipped_count > 0 THEN v_skipped_count ELSE definition.last_skipped_count
             END,
             last_skipped_through = CASE
               WHEN v_skipped_count > 0 THEN v_skipped_through
               ELSE definition.last_skipped_through
             END
       WHERE definition.namespace = v_definition.namespace
         AND definition.schedule_name = v_definition.schedule_name
         AND definition.revision = v_definition.revision;
    END IF;
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION workhorse.retire_history_partitions_v1(
  p_parent text, p_before timestamptz, p_limit integer
) RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  v_partition record;
  v_count integer := 0;
  v_previous_lock_timeout text;
BEGIN
  IF p_parent NOT IN ('task_event', 'attempt_history') THEN
    RAISE EXCEPTION 'history parent must be task_event or attempt_history';
  END IF;
  IF p_before IS NULL OR NOT isfinite(p_before) THEN RAISE EXCEPTION 'retention cutoff is required'; END IF;
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 52 THEN RAISE EXCEPTION 'partition limit must be between 1 and 52'; END IF;

  FOR v_partition IN
    SELECT child_namespace.nspname AS schema_name, child.relname,
           ((regexp_match(
             pg_get_expr(child.relpartbound, child.oid),
             'TO \(''([^'']+)''\)'
           ))[1])::timestamptz AS upper_bound
      FROM pg_inherits inheritance
      JOIN pg_class parent ON parent.oid = inheritance.inhparent
      JOIN pg_namespace namespace ON namespace.oid = parent.relnamespace
      JOIN pg_class child ON child.oid = inheritance.inhrelid
      JOIN pg_namespace child_namespace ON child_namespace.oid = child.relnamespace
     WHERE namespace.nspname = 'workhorse'
       AND parent.relname = p_parent
       AND child.relname <> p_parent || '_default'
       AND ((regexp_match(
             pg_get_expr(child.relpartbound, child.oid),
             'TO \(''([^'']+)''\)'
           ))[1])::timestamptz <= p_before
       AND ((regexp_match(
             pg_get_expr(child.relpartbound, child.oid),
             'TO \(''([^'']+)''\)'
           ))[1])::timestamptz <= (
             date_trunc('day', clock_timestamp() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
           )
     ORDER BY upper_bound, child.relname
     LIMIT p_limit
  LOOP
    -- The cast to timestamp keeps the session TimeZone out of to_char, and to_char keeps the
    -- session DateStyle out of the day text (SM-1665).
    IF NOT pg_try_advisory_xact_lock(hashtextextended(
      'workhorse:history-day:' ||
        to_char(((v_partition.upper_bound AT TIME ZONE 'UTC')::date - 1)::timestamp, 'YYYY-MM-DD'),
      0
    )) THEN
      CONTINUE;
    END IF;
    v_previous_lock_timeout := current_setting('lock_timeout');
    PERFORM set_config('lock_timeout', '250ms', true);
    BEGIN
      -- DROP locks the parent of the partition. Take both parents first, in the order that
      -- lifecycle transitions and partition creation use: attempt_history before task_event.
      -- run_maintenance_v1 can retire both kinds and then create partitions in one transaction.
      LOCK TABLE ONLY workhorse.attempt_history IN ACCESS EXCLUSIVE MODE;
      LOCK TABLE ONLY workhorse.task_event IN ACCESS EXCLUSIVE MODE;
      EXECUTE format(
        'DROP TABLE IF EXISTS %I.%I', v_partition.schema_name, v_partition.relname
      );
      v_count := v_count + 1;
    EXCEPTION
      WHEN lock_not_available THEN NULL;
      WHEN OTHERS THEN
        PERFORM set_config('lock_timeout', v_previous_lock_timeout, true);
        RAISE;
    END;
    PERFORM set_config('lock_timeout', v_previous_lock_timeout, true);
  END LOOP;
  RETURN v_count;
END;
$$;

CREATE OR REPLACE FUNCTION workhorse.prepare_history_partitions_v1(
  p_force boolean DEFAULT false,
  p_now timestamptz DEFAULT clock_timestamp()
) RETURNS TABLE (
  phase text, rows_affected integer, duration_ms integer, skipped_lock boolean, error jsonb
)
LANGUAGE plpgsql
AS $$
DECLARE v_started_at timestamptz;
DECLARE v_day_offset integer;
DECLARE v_horizon_days integer;
DECLARE v_suffix text;
DECLARE v_today date := (p_now AT TIME ZONE 'UTC')::date;
DECLARE v_policy workhorse.maintenance_policy%ROWTYPE;
DECLARE v_state workhorse.maintenance_state%ROWTYPE;
DECLARE v_run_started_at timestamptz;
DECLARE v_run_completed_at timestamptz;
DECLARE v_phases jsonb;
DECLARE v_previous_lock_timeout text;
DECLARE v_deferred_day date;
BEGIN
  IF p_now IS NULL OR NOT isfinite(p_now) THEN RAISE EXCEPTION 'maintenance time is required'; END IF;
  IF NOT pg_try_advisory_xact_lock(
    hashtextextended('workhorse:maintenance:history-partitions', 0)
  ) THEN
    RETURN QUERY VALUES ('history_partitions'::text, 0, 0, true, NULL::jsonb);
    RETURN;
  END IF;
  SELECT * INTO STRICT v_policy FROM workhorse.maintenance_policy WHERE singleton;
  SELECT * INTO STRICT v_state FROM workhorse.maintenance_state
   WHERE routine_name = 'history_partitions' FOR UPDATE;
  IF NOT p_force AND v_state.last_completed_at IS NOT NULL
     AND v_state.last_completed_at > p_now - make_interval(
       secs => v_policy.partition_preparation_interval_ms / 1000.0
     ) THEN
    RETURN;
  END IF;
  v_run_started_at := clock_timestamp();
  UPDATE workhorse.maintenance_state SET last_started_at = p_now, updated_at = clock_timestamp()
   WHERE routine_name = 'history_partitions';

  phase := 'history_partitions';
  rows_affected := 0;
  skipped_lock := false;
  error := NULL;
  v_started_at := clock_timestamp();
  BEGIN
    v_horizon_days := workhorse.history_partition_horizon_days_v1(
      v_policy.partition_preparation_interval_ms
    );
    FOR v_day_offset IN 0..v_horizon_days LOOP
      -- The cast to timestamp keeps the session TimeZone out of the partition name (SM-1665).
      v_suffix := to_char((v_today + v_day_offset)::timestamp, 'YYYYMMDD');
      IF to_regclass(format('workhorse.%I', 'task_event_' || v_suffix)) IS NULL
         OR to_regclass(format('workhorse.%I', 'attempt_history_' || v_suffix)) IS NULL THEN
        -- Creation locks both history parents in ACCESS EXCLUSIVE mode. A request that waits
        -- for a reader, such as pg_dump, makes every claim, completion, and enqueue wait behind it.
        -- Each lock request therefore waits at most 250 ms, as partition retirement does. A day
        -- whose locks stay busy is deferred: its subtransaction rolls back, the remaining days
        -- wait too because they need the same locks, and the routine stays due for the next pass.
        v_previous_lock_timeout := current_setting('lock_timeout');
        PERFORM set_config('lock_timeout', '250ms', true);
        BEGIN
          PERFORM workhorse.create_history_day_v1(v_today + v_day_offset);
          rows_affected := rows_affected + 1;
        EXCEPTION WHEN lock_not_available THEN
          v_deferred_day := v_today + v_day_offset;
        END;
        PERFORM set_config('lock_timeout', v_previous_lock_timeout, true);
        EXIT WHEN v_deferred_day IS NOT NULL;
      END IF;
    END LOOP;
  EXCEPTION WHEN OTHERS THEN
    -- The subtransaction also rolled back the lock_timeout change.
    rows_affected := 0;
    v_deferred_day := NULL;
    error := jsonb_build_object('code', SQLSTATE, 'message', SQLERRM);
  END;
  skipped_lock := v_deferred_day IS NOT NULL;
  duration_ms := GREATEST(
    0, round(extract(epoch FROM clock_timestamp() - v_started_at) * 1000)::integer
  );
  v_phases := jsonb_build_array(jsonb_build_object(
    'phase', phase, 'rowsAffected', rows_affected, 'durationMs', duration_ms,
    'error', error
  ) || CASE WHEN v_deferred_day IS NULL THEN '{}'::jsonb
            ELSE jsonb_build_object('skippedLock', true, 'deferredDay', v_deferred_day) END);
  v_run_completed_at := clock_timestamp();
  IF error IS NULL AND v_deferred_day IS NULL THEN
    UPDATE workhorse.maintenance_state
       SET last_completed_at = p_now, updated_at = clock_timestamp()
     WHERE routine_name = 'history_partitions';
  END IF;
  PERFORM workhorse.record_maintenance_run_internal_v1(
    'history_partitions', v_run_started_at, v_run_completed_at,
    CASE WHEN error IS NOT NULL THEN 'failed'
         WHEN v_deferred_day IS NOT NULL THEN 'incomplete'
         ELSE 'succeeded' END,
    rows_affected, v_phases
  );
  RETURN NEXT;
END;
$$;

CREATE OR REPLACE FUNCTION workhorse.create_history_day_v1(p_day date)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  v_start timestamptz := p_day::timestamp AT TIME ZONE 'UTC';
  v_end timestamptz := (p_day + 1)::timestamp AT TIME ZONE 'UTC';
  v_suffix text := to_char(p_day::timestamp, 'YYYYMMDD');
  v_event_partition text := 'task_event_' || v_suffix;
  v_attempt_partition text := 'attempt_history_' || v_suffix;
  v_event_staging text := 'workhorse_task_event_' || v_suffix;
  v_attempt_staging text := 'workhorse_attempt_history_' || v_suffix;
  v_event_exists boolean;
  v_attempt_exists boolean;
BEGIN
  -- The cast to timestamp keeps the session TimeZone out of to_char, and to_char keeps the
  -- session DateStyle out of the day text (SM-1665).
  PERFORM pg_advisory_xact_lock(
    hashtextextended('workhorse:history-day:' || to_char(p_day::timestamp, 'YYYY-MM-DD'), 0)
  );
  v_event_exists := to_regclass(format('workhorse.%I', v_event_partition)) IS NOT NULL;
  v_attempt_exists := to_regclass(format('workhorse.%I', v_attempt_partition)) IS NOT NULL;
  IF v_event_exists AND v_attempt_exists THEN RETURN; END IF;

  -- Lifecycle transitions insert attempt history before task events. Take the partitioned-parent
  -- locks in that order before either CREATE TABLE can acquire them implicitly, otherwise a
  -- transition and paired partition creation can each hold the relation the other needs.
  LOCK TABLE ONLY workhorse.attempt_history IN ACCESS EXCLUSIVE MODE;
  LOCK TABLE ONLY workhorse.task_event IN ACCESS EXCLUSIVE MODE;
  LOCK TABLE workhorse.attempt_history_default IN ACCESS EXCLUSIVE MODE;
  LOCK TABLE workhorse.task_event_default IN ACCESS EXCLUSIVE MODE;
  IF NOT v_event_exists THEN
    EXECUTE format(
      'CREATE TEMP TABLE pg_temp.%I ON COMMIT DROP AS SELECT * FROM workhorse.task_event_default WHERE occurred_at >= %L AND occurred_at < %L',
      v_event_staging, v_start, v_end);
    DELETE FROM workhorse.task_event_default WHERE occurred_at >= v_start AND occurred_at < v_end;
    EXECUTE format(
      'CREATE TABLE workhorse.%I PARTITION OF workhorse.task_event FOR VALUES FROM (%L) TO (%L)',
      v_event_partition, v_start, v_end);
    EXECUTE format(
      'INSERT INTO workhorse.%I (event_id, task_id, attempt, event_type, details, occurred_at) SELECT event_id, task_id, attempt, event_type, details, occurred_at FROM pg_temp.%I',
      v_event_partition, v_event_staging);
    EXECUTE format('DROP TABLE pg_temp.%I', v_event_staging);
  END IF;

  IF NOT v_attempt_exists THEN
    EXECUTE format(
      'CREATE TEMP TABLE pg_temp.%I ON COMMIT DROP AS SELECT * FROM workhorse.attempt_history_default WHERE occurred_at >= %L AND occurred_at < %L',
      v_attempt_staging, v_start, v_end);
    DELETE FROM workhorse.attempt_history_default WHERE occurred_at >= v_start AND occurred_at < v_end;
    EXECUTE format(
      'CREATE TABLE workhorse.%I PARTITION OF workhorse.attempt_history FOR VALUES FROM (%L) TO (%L)',
      v_attempt_partition, v_start, v_end);
    EXECUTE format(
      'INSERT INTO workhorse.%I (attempt_id, task_id, attempt, fence_token, worker_id, outcome, started_at, claimed_at, finished_at, error, occurred_at) SELECT attempt_id, task_id, attempt, fence_token, worker_id, outcome, started_at, claimed_at, finished_at, error, occurred_at FROM pg_temp.%I',
      v_attempt_partition, v_attempt_staging);
    EXECUTE format('DROP TABLE pg_temp.%I', v_attempt_staging);
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION workhorse.retire_history_day_v1(p_day date)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  v_start date := p_day;
  v_suffix text := to_char(v_start::timestamp, 'YYYYMMDD');
BEGIN
  IF v_start >= (clock_timestamp() AT TIME ZONE 'UTC')::date THEN
    RAISE EXCEPTION 'only completed history days can be retired';
  END IF;
  -- The cast to timestamp keeps the session TimeZone out of to_char, and to_char keeps the
  -- session DateStyle out of the day text (SM-1665).
  PERFORM pg_advisory_xact_lock(
    hashtextextended('workhorse:history-day:' || to_char(v_start::timestamp, 'YYYY-MM-DD'), 0)
  );
  LOCK TABLE ONLY workhorse.attempt_history IN ACCESS EXCLUSIVE MODE;
  LOCK TABLE ONLY workhorse.task_event IN ACCESS EXCLUSIVE MODE;
  EXECUTE format('DROP TABLE IF EXISTS workhorse.%I', 'task_event_' || v_suffix);
  EXECUTE format('DROP TABLE IF EXISTS workhorse.%I', 'attempt_history_' || v_suffix);
END;
$$;

-- Give each history partition the name of its UTC day. A partition that an earlier body created in
-- a session time zone that skipped a whole calendar day can have the name of the next day. This
-- block renames only a child of attempt_history or task_event in the workhorse schema whose bounds
-- cover exactly one UTC day. If the correct name is taken, it raises a NOTICE and changes nothing.
-- pg_get_expr takes ACCESS SHARE on each child while it reads the bounds. A rename takes ACCESS
-- EXCLUSIVE on that one child. Both waits are under the lock_timeout of the migration runner. Thus
-- a child that a long transaction holds fails the step instead of a wait without a bound. In a
-- database without such a name, the block requests no ACCESS EXCLUSIVE lock.
DO $repair$
DECLARE
  v_previous_datestyle text := current_setting('datestyle');
  v_child record;
  v_correct text;
BEGIN
  -- pg_get_expr writes a bound with the session DateStyle, and the cast below reads it back.
  PERFORM set_config('datestyle', 'ISO, MDY', true);
  FOR v_child IN
    SELECT parent.relname AS parent_name, child.relname AS child_name, bounds.lower_bound
      FROM pg_inherits inheritance
      JOIN pg_class parent ON parent.oid = inheritance.inhparent
      JOIN pg_namespace namespace ON namespace.oid = parent.relnamespace
      JOIN pg_class child ON child.oid = inheritance.inhrelid
      JOIN pg_namespace child_namespace ON child_namespace.oid = child.relnamespace
      CROSS JOIN LATERAL regexp_match(
        pg_get_expr(child.relpartbound, child.oid),
        '^FOR VALUES FROM \(''([^'']+)''\) TO \(''([^'']+)''\)$'
      ) AS matched(parts)
      CROSS JOIN LATERAL (
        SELECT matched.parts[1]::timestamptz AS lower_bound,
               matched.parts[2]::timestamptz AS upper_bound
      ) bounds
     WHERE namespace.nspname = 'workhorse'
       AND parent.relname IN ('attempt_history', 'task_event')
       AND child_namespace.nspname = 'workhorse'
       AND bounds.lower_bound =
         date_trunc('day', bounds.lower_bound AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
       AND bounds.upper_bound = bounds.lower_bound + interval '24 hours'
     ORDER BY parent.relname, bounds.lower_bound
  LOOP
    v_correct := v_child.parent_name || '_' ||
      to_char(v_child.lower_bound AT TIME ZONE 'UTC', 'YYYYMMDD');
    CONTINUE WHEN v_child.child_name = v_correct;
    IF to_regclass(format('workhorse.%I', v_correct)) IS NOT NULL THEN
      RAISE NOTICE 'history partition workhorse.% keeps its name: workhorse.% already exists',
        v_child.child_name, v_correct;
      CONTINUE;
    END IF;
    EXECUTE format('ALTER TABLE workhorse.%I RENAME TO %I', v_child.child_name, v_correct);
  END LOOP;
  PERFORM set_config('datestyle', v_previous_datestyle, true);
END;
$repair$;
