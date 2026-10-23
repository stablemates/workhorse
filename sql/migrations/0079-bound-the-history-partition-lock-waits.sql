-- workhorse-migration: {"kind":"additive"}

-- Bound the history partition lock waits and release them before other routines (SM-1640).

-- Partition preparation creates the next daily partitions of task_event and attempt_history. To
-- attach a partition, create_history_day_v1 locks both parents in ACCESS EXCLUSIVE mode. Before
-- this step, the lock request had no wait limit. If a reader such as pg_dump held a parent lock,
-- the request waited, and every claim, completion, and enqueue that writes history waited behind
-- it. When PostgreSQL granted the locks, run_maintenance_v1 held them through retention and
-- terminal cleanup, because every SDK sends that call as one statement. Retention also held the
-- parent locks of each partition that it dropped through terminal cleanup.
--
-- prepare_history_partitions_v1 now sets lock_timeout to 250 ms around each day, as partition
-- retirement does. If a lock stays busy, the day is deferred. Its subtransaction rolls back, the
-- remaining days wait, and the pass does not fail. The returned row sets skipped_lock, the
-- recorded run has the outcome 'incomplete' and names the deferredDay, and the routine stays due,
-- so the next pass creates the day.
--
-- retire_history_partitions_v1 now locks attempt_history and then task_event before each DROP, so
-- retirement and creation in one call take the parents in the documented order.
--
-- run_maintenance_v1 now runs terminal cleanup and registry cleanup before history retention and
-- partition preparation. The call returns, and the caller commits, directly after the partition
-- DDL. Terminal cleanup now reads the retention watermark of the previous pass.
--
-- The signatures do not change. No change touches stored data.


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
    IF NOT pg_try_advisory_xact_lock(hashtextextended(
      'workhorse:history-day:' || ((v_partition.upper_bound AT TIME ZONE 'UTC')::date - 1),
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
      v_suffix := to_char(v_today + v_day_offset, 'YYYYMMDD');
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


-- Run every slow maintenance routine in one database-owned order so each language worker participates
-- in the same housekeeping contract. The individual functions retain their own cadence gates and
-- advisory locks, and report their expected per-phase failures as telemetry rows. Registry pruning
-- remains best-effort so its failure cannot reject an otherwise successful maintenance pass.
--
-- Every SDK sends this call as one statement, so PostgreSQL holds each lock that a routine takes
-- until the call returns. History retention and partition preparation change the partitions of the
-- history parents and lock them in ACCESS EXCLUSIVE mode, so they run last: no other routine can
-- extend how long those locks block lifecycle transitions. Each lock request waits at most 250 ms,
-- and both routines take the parents in the order attempt_history, task_event. Terminal cleanup
-- reads the watermark that retention records, so it uses the watermark of the previous retention
-- pass. Retention runs once per local date, so that delays terminal cleanup by one pass each day.
CREATE OR REPLACE FUNCTION workhorse.run_maintenance_v1(
  p_now timestamptz DEFAULT clock_timestamp()
) RETURNS TABLE (
  phase text, rows_affected integer, duration_ms integer, skipped_lock boolean, error jsonb
)
LANGUAGE plpgsql
AS $$
DECLARE v_started_at timestamptz;
BEGIN
  IF p_now IS NULL OR NOT isfinite(p_now) THEN RAISE EXCEPTION 'maintenance time is required'; END IF;

  RETURN QUERY SELECT * FROM workhorse.rollup_stats_v1(false, p_now, 240);
  RETURN QUERY SELECT * FROM workhorse.prune_terminal_storage_v1(false, p_now);

  phase := 'worker_registry';
  rows_affected := 0;
  skipped_lock := false;
  error := NULL;
  v_started_at := clock_timestamp();
  BEGIN
    rows_affected := workhorse.prune_worker_registry_v1(interval '1 minute');
  EXCEPTION WHEN OTHERS THEN
    error := jsonb_build_object('code', SQLSTATE, 'message', SQLERRM);
  END;
  duration_ms := GREATEST(
    0, round(extract(epoch FROM clock_timestamp() - v_started_at) * 1000)::integer
  );
  RETURN NEXT;

  RETURN QUERY SELECT * FROM workhorse.retain_history_v1(false, p_now);
  RETURN QUERY SELECT * FROM workhorse.prepare_history_partitions_v1(false, p_now);
END;
$$;

