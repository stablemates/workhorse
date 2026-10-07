-- workhorse-migration: {"kind":"additive"}

-- Raise a health reason for a terminal cleanup backlog and show its follow-up pass as due (SM-1178).

-- Migration 0058 records maintenance_state.terminal_cleanup_backlog_since while terminal storage
-- passes end with a full batch. No health reason read it. When completions roughly match cleanup
-- pace, every pass fills and the tables grow, yet cleanup deletes the oldest rows first, so the
-- oldest eligible row stays young and retention-lag never fires. evaluate_queue_health_v1 now
-- raises the degraded reason terminal-cleanup-backlog once the backlog is older than
-- row_retention_lag_ms. It reads the snapshot's captured_at as a timestamp, so it is STABLE.
--
-- dashboard_cron_v1 reported the terminal_storage routine as due only after
-- terminal_cleanup_interval_ms, while prune_terminal_storage_v1 runs a follow-up pass five seconds
-- after a backlogged one. terminal_cleanup_follow_up_delay_ms_v1 now names that delay, both
-- functions read it, and dashboard_maintenance_state_v1 carries terminal_cleanup_backlog_since.
--
-- No change touches stored data.

CREATE OR REPLACE FUNCTION workhorse.evaluate_queue_health_v1(
  p_snapshot jsonb, p_policy jsonb
) RETURNS jsonb
LANGUAGE sql
STABLE
PARALLEL SAFE
AS $$
  WITH reasons AS (
    SELECT 10 AS position, jsonb_build_object(
      'code', 'expired-leases', 'severity', 'critical',
      'observed', (p_snapshot->>'expired')::numeric, 'budget', 0
    ) AS reason
    WHERE (p_snapshot->>'expired')::numeric > 0
    UNION ALL
    SELECT 20, jsonb_build_object(
      'code', 'overdue-deadlines', 'severity', 'critical',
      'observed', (p_snapshot->>'overdue_deadlines')::numeric, 'budget', 0
    ) WHERE (p_snapshot->>'overdue_deadlines')::numeric > 0
    UNION ALL
    SELECT 30, jsonb_build_object(
      'code', 'overdue-execution-timeouts', 'severity', 'critical',
      'observed', (p_snapshot->>'overdue_execution_timeouts')::numeric, 'budget', 0
    ) WHERE (p_snapshot->>'overdue_execution_timeouts')::numeric > 0
    UNION ALL
    SELECT 40, jsonb_build_object(
      'code', 'overdue-external-waits', 'severity', 'critical',
      'observed', (p_snapshot->>'overdue_external_waits')::numeric, 'budget', 0
    ) WHERE (p_snapshot->>'overdue_external_waits')::numeric > 0
    UNION ALL
    SELECT 50, jsonb_build_object(
      'code', 'stalled-promotion', 'severity', 'critical',
      'observed', (p_snapshot->>'oldest_overdue_scheduled_age_ms')::numeric,
      'budget', (p_policy->>'promotion_lag_ms')::numeric
    ) WHERE p_snapshot->>'oldest_overdue_scheduled_age_ms' IS NOT NULL
      AND (p_snapshot->>'oldest_overdue_scheduled_age_ms')::numeric
        > (p_policy->>'promotion_lag_ms')::numeric
    UNION ALL
    SELECT 60, jsonb_build_object(
      'code', 'missing-history-partitions', 'severity', 'critical',
      'observed', missing.count, 'budget', 0
    ) FROM (
      SELECT count(*) FILTER (WHERE NOT value->>'has_task_events' = 'true')
           + count(*) FILTER (WHERE NOT value->>'has_attempt_history' = 'true') AS count
        FROM jsonb_array_elements(p_snapshot->'history_partition_days') value
    ) missing WHERE missing.count > 0
    UNION ALL
    SELECT 100, jsonb_build_object(
      'code', 'rollup-stalled', 'severity', 'degraded',
      'observed', (p_snapshot->>'rollup_lag_ms')::numeric,
      'budget', (p_policy->>'rollup_stalled_lag_ms')::numeric
    ) WHERE (p_snapshot->>'rollup_lag_ms')::numeric
      > (p_policy->>'rollup_stalled_lag_ms')::numeric
    UNION ALL
    SELECT 110 + retention.position, jsonb_build_object(
      'code', 'retention-lag', 'severity', 'degraded',
      'observed', retention.observed_text::numeric,
      'budget', retention.budget_text::numeric,
      'category', retention.category
    ) FROM (
      VALUES
        (1, 'taskIdentity', p_snapshot->>'task_identity_lag_ms',
          p_policy->>'row_retention_lag_ms'),
        (2, 'terminalOutcome', p_snapshot->>'terminal_outcome_lag_ms',
          p_policy->>'row_retention_lag_ms'),
        (3, 'taskEvents', p_snapshot->>'task_event_lag_ms',
          p_policy->>'partition_retention_lag_ms'),
        (4, 'attemptHistory', p_snapshot->>'attempt_history_lag_ms',
          p_policy->>'partition_retention_lag_ms'),
        (6, 'statistics', p_snapshot->>'statistics_lag_ms',
          p_policy->>'row_retention_lag_ms')
    ) retention(position, category, observed_text, budget_text)
    WHERE retention.observed_text IS NOT NULL
      AND retention.observed_text::numeric > retention.budget_text::numeric
    UNION ALL
    SELECT 115, jsonb_build_object(
      'code', 'retention-lag', 'severity', 'degraded',
      'observed', (p_snapshot->>'schedule_occurrence_lag_ms')::numeric,
      'budget', (p_policy->>'row_retention_lag_ms')::numeric,
      'category', 'scheduleOccurrences'
    ) WHERE (p_snapshot->>'schedule_occurrence_pass_lag_ms')::numeric
        > (p_policy->>'row_retention_lag_ms')::numeric
      OR ((p_snapshot->>'schedule_occurrence_due_lag_ms')::numeric
            > (p_policy->>'row_retention_lag_ms')::numeric
          AND (p_snapshot->>'schedule_occurrence_lag_ms')::numeric > 0)
    UNION ALL
    -- A backlog that outlasts the row retention budget means cleanup has run saturated that long.
    -- The oldest eligible row can still be young, because cleanup deletes the oldest rows first.
    SELECT 120, jsonb_build_object(
      'code', 'terminal-cleanup-backlog', 'severity', 'degraded',
      'observed', backlog.age_ms,
      'budget', (p_policy->>'row_retention_lag_ms')::numeric
    ) FROM (
      SELECT floor(extract(epoch FROM (p_snapshot->>'captured_at')::timestamptz
        - (p_snapshot->>'terminal_cleanup_backlog_since')::timestamptz) * 1000) AS age_ms
    ) backlog
    WHERE backlog.age_ms > (p_policy->>'row_retention_lag_ms')::numeric
    UNION ALL
    SELECT 130, jsonb_build_object(
      'code', 'eligible-history-partitions', 'severity', 'degraded',
      'observed', (p_snapshot->>'eligible_event_partitions')::numeric
        + (p_snapshot->>'eligible_attempt_partitions')::numeric,
      'budget', (p_policy->>'eligible_history_partitions')::numeric
    ) WHERE (p_snapshot->>'eligible_event_partitions')::numeric
        + (p_snapshot->>'eligible_attempt_partitions')::numeric
      > (p_policy->>'eligible_history_partitions')::numeric
    UNION ALL
    SELECT 140, jsonb_build_object(
      'code', 'default-history-rows', 'severity', 'degraded',
      'observed', (p_snapshot->>'default_event_rows')::numeric
        + (p_snapshot->>'default_attempt_rows')::numeric,
      'budget', 0
    ) WHERE (p_snapshot->>'default_event_rows')::numeric
        + (p_snapshot->>'default_attempt_rows')::numeric > 0
    UNION ALL
    SELECT 200 + admission.ordinality::integer, jsonb_build_object(
      'code', 'concurrency-blocked', 'severity', 'degraded',
      'observed', (admission.value->>'blocked_ready')::numeric,
      'budget', 0, 'queue', admission.value->>'queue_name'
    ) FROM jsonb_array_elements(p_snapshot->'concurrency_policies')
      WITH ORDINALITY admission(value, ordinality)
    WHERE (admission.value->>'blocked_ready')::numeric > 0
    UNION ALL
    SELECT 400 + admission.ordinality::integer, jsonb_build_object(
      'code', 'rate-limit-throttled', 'severity', 'degraded',
      'observed', (admission.value->>'throttled_ready')::numeric,
      'budget', 0, 'queue', admission.value->>'queue_name'
    ) FROM jsonb_array_elements(p_snapshot->'rate_limit_policies')
      WITH ORDINALITY admission(value, ordinality)
    WHERE (admission.value->>'throttled_ready')::numeric > 0
    UNION ALL
    SELECT 600 + admission.ordinality::integer, jsonb_build_object(
      'code', 'budget-blocked', 'severity', 'degraded',
      'observed', (admission.value->>'blocked_ready')::numeric,
      'budget', 0, 'budgetName', admission.value->>'budget_name'
    ) FROM jsonb_array_elements(COALESCE(p_snapshot->'budget_policies', '[]'::jsonb))
      WITH ORDINALITY admission(value, ordinality)
    WHERE (admission.value->>'blocked_ready')::numeric > 0
  ), aggregate AS (
    SELECT COALESCE(jsonb_agg(reason ORDER BY position), '[]'::jsonb) AS reasons,
           bool_or(reason->>'severity' = 'critical') AS critical,
           count(*) > 0 AS unhealthy
      FROM reasons
  )
  SELECT jsonb_build_object(
    'level', CASE WHEN critical THEN 'critical' WHEN unhealthy THEN 'degraded' ELSE 'healthy' END,
    'reasons', reasons
  ) FROM aggregate;
$$;

-- How long after a terminal storage pass that ended with a backlog the follow-up pass falls due,
-- unless terminal_cleanup_interval_ms is shorter. prune_terminal_storage_v1 gates on it and
-- dashboard_cron_v1 reports the routine as due by it, so the two cannot disagree.
CREATE OR REPLACE FUNCTION workhorse.terminal_cleanup_follow_up_delay_ms_v1()
RETURNS integer
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT 5000;
$$;

CREATE OR REPLACE FUNCTION workhorse.prune_terminal_storage_v1(
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
DECLARE v_history_before timestamptz;
DECLARE v_success boolean := true;
DECLARE v_identity_before timestamptz;
DECLARE v_outcome_before timestamptz;
DECLARE v_run_started_at timestamptz;
DECLARE v_run_completed_at timestamptz;
DECLARE v_rows_affected integer := 0;
DECLARE v_phases jsonb := '[]'::jsonb;
DECLARE v_batch integer;
DECLARE v_backlog boolean := false;
BEGIN
  IF p_now IS NULL OR NOT isfinite(p_now) THEN RAISE EXCEPTION 'maintenance time is required'; END IF;
  IF NOT pg_try_advisory_xact_lock(
    hashtextextended('workhorse:maintenance:terminal-storage', 0)
  ) THEN
    RETURN QUERY VALUES
      ('enqueue_idempotency'::text, 0, 0, true, NULL::jsonb),
      ('released_dependencies'::text, 0, 0, true, NULL::jsonb),
      ('terminal_tasks'::text, 0, 0, true, NULL::jsonb);
    RETURN;
  END IF;
  SELECT * INTO STRICT v_policy FROM workhorse.retention_policy WHERE singleton;
  SELECT * INTO STRICT v_maintenance FROM workhorse.maintenance_policy WHERE singleton;
  SELECT * INTO STRICT v_state FROM workhorse.maintenance_state
   WHERE routine_name = 'terminal_storage' FOR UPDATE;
  -- A pass that ended with a full batch left eligible rows behind. The follow-up pass is due after
  -- the follow-up delay, or after the configured interval when that is shorter, instead of a full
  -- interval.
  IF NOT p_force AND v_state.last_completed_at IS NOT NULL
     AND v_state.last_completed_at > p_now - make_interval(
       secs => CASE WHEN v_state.terminal_cleanup_backlog_since IS NULL
         THEN v_maintenance.terminal_cleanup_interval_ms
         ELSE LEAST(v_maintenance.terminal_cleanup_interval_ms,
           workhorse.terminal_cleanup_follow_up_delay_ms_v1()) END / 1000.0
     ) THEN
    RETURN;
  END IF;
  v_run_started_at := clock_timestamp();
  SELECT history_retained_before INTO v_history_before
    FROM workhorse.maintenance_state WHERE routine_name = 'history_retention';
  UPDATE workhorse.maintenance_state SET last_started_at = p_now, updated_at = clock_timestamp()
   WHERE routine_name = 'terminal_storage';

  phase := 'enqueue_idempotency';
  rows_affected := 0;
  skipped_lock := false;
  error := NULL;
  v_started_at := clock_timestamp();
  BEGIN
    rows_affected := workhorse.prune_enqueue_idempotency_v1(
      p_now, v_policy.terminal_task_prune_limit
    );
    v_backlog := v_backlog OR rows_affected >= v_policy.terminal_task_prune_limit;
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

  phase := 'released_dependencies';
  rows_affected := 0;
  error := NULL;
  v_started_at := clock_timestamp();
  BEGIN
    rows_affected := workhorse.prune_released_dependencies_v1(
      v_policy.terminal_task_prune_limit
    );
    v_backlog := v_backlog OR rows_affected >= v_policy.terminal_task_prune_limit;
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

  phase := 'terminal_tasks';
  rows_affected := 0;
  error := NULL;
  v_started_at := clock_timestamp();
  BEGIN
    IF v_policy.task_identity_retention_days IS NOT NULL AND v_history_before IS NOT NULL THEN
      v_identity_before := p_now - make_interval(days => v_policy.task_identity_retention_days);
      v_outcome_before := p_now - make_interval(days => v_policy.terminal_outcome_retention_days);
      -- Batches repeat while each one fills, until the phase has run for one second. The time
      -- budget bounds how long one pass holds its transaction, whatever the batch limit.
      LOOP
        v_batch := workhorse.prune_terminal_tasks_v1(
          v_identity_before,
          v_outcome_before,
          v_history_before,
          v_policy.terminal_task_prune_limit
        );
        rows_affected := rows_affected + v_batch;
        EXIT WHEN v_batch < v_policy.terminal_task_prune_limit
          OR clock_timestamp() - v_started_at >= interval '1 second';
      END LOOP;
      v_backlog := v_backlog OR v_batch >= v_policy.terminal_task_prune_limit;
    ELSE
      UPDATE workhorse.maintenance_state
         SET terminal_prune_dependency_starved = false,
             updated_at = clock_timestamp()
       WHERE routine_name = 'terminal_storage';
    END IF;
  EXCEPTION WHEN OTHERS THEN
    -- The subtransaction rolled back every batch of this phase.
    rows_affected := 0;
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
  -- The backlog start survives follow-up passes that still fill a batch. A phase that reached its
  -- limit shows a backlog even when another phase failed. Only a pass whose every phase succeeded
  -- can show that cleanup caught up, so only such a pass clears the start.
  UPDATE workhorse.maintenance_state
     SET terminal_cleanup_backlog_since = CASE
           WHEN v_backlog THEN COALESCE(terminal_cleanup_backlog_since, p_now)
           WHEN v_success THEN NULL
           ELSE terminal_cleanup_backlog_since END,
         updated_at = clock_timestamp()
   WHERE routine_name = 'terminal_storage';
  v_run_completed_at := clock_timestamp();
  IF v_success THEN
    UPDATE workhorse.maintenance_state
       SET last_completed_at = p_now, updated_at = clock_timestamp()
     WHERE routine_name = 'terminal_storage';
  END IF;
  PERFORM workhorse.record_maintenance_run_internal_v1(
    'terminal_storage', v_run_started_at, v_run_completed_at,
    CASE WHEN v_success THEN 'succeeded' ELSE 'failed' END,
    v_rows_affected, v_phases
  );
  RETURN NEXT;
END;
$$;

CREATE OR REPLACE VIEW workhorse.dashboard_maintenance_state_v1 AS
  SELECT routine_name, last_started_at, last_completed_at, last_completed_local_date,
         terminal_cleanup_backlog_since
    FROM workhorse.maintenance_state;

CREATE OR REPLACE FUNCTION workhorse.dashboard_cron_v1(p_input jsonb)
RETURNS jsonb
LANGUAGE sql
AS $$
  WITH schedule_rows AS (
    SELECT definition.namespace, definition.schedule_name, definition.cron_expression,
           definition.queue_name, definition.task_type, definition.priority,
           definition.catchup_policy,
           definition.configured_enabled, definition.paused, definition.paused_by,
           definition.paused_reason, definition.paused_at,
           definition.revision, definition.updated_at,
           count(occurrence.occurrence_at)::integer AS occurrence_count,
           max(occurrence.fired_at) AS last_fired_at,
           (SELECT count(*)::integer
              FROM workhorse.dashboard_worker_registry_v1 registry
             WHERE definition.namespace = ANY(registry.schedule_namespaces)
               AND registry.last_heartbeat_at >= clock_timestamp() - interval '30 seconds')
             AS evaluator_count
      FROM workhorse.dashboard_schedule_definition_v1 definition
      LEFT JOIN workhorse.dashboard_schedule_occurrence_v1 occurrence
        ON occurrence.namespace = definition.namespace
       AND occurrence.schedule_name = definition.schedule_name
     GROUP BY definition.namespace, definition.schedule_name, definition.cron_expression,
              definition.queue_name, definition.task_type, definition.priority,
              definition.catchup_policy,
              definition.configured_enabled, definition.paused, definition.paused_by,
              definition.paused_reason, definition.paused_at,
              definition.revision, definition.updated_at
     ORDER BY definition.namespace, definition.schedule_name
     LIMIT 50
  ), schedules AS (
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'kind', 'user',
      'identity', jsonb_build_object(
        'kind', 'user', 'namespace', namespace, 'name', schedule_name),
      'namespace', namespace, 'name', schedule_name, 'cron', cron_expression,
      'queue', queue_name, 'type', task_type, 'priority', priority,
      'catchupPolicy', catchup_policy,
      'configuredEnabled', configured_enabled, 'paused', paused,
      'pausedBy', paused_by, 'pausedReason', paused_reason,
      'pausedAt', workhorse.dashboard_iso_v1(paused_at),
      'active', configured_enabled AND NOT paused, 'revision', revision::text,
      'updatedAt', workhorse.dashboard_iso_v1(updated_at),
      'occurrenceCount', occurrence_count,
      'lastFiredAt', workhorse.dashboard_iso_v1(last_fired_at),
      'evaluatorCount', evaluator_count
    ) ORDER BY namespace, schedule_name), '[]'::jsonb) AS value FROM schedule_rows
  ), policy AS (
    SELECT * FROM workhorse.dashboard_maintenance_policy_v1 WHERE singleton
  ), routines AS (
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'routine', state.routine_name,
      'lastStartedAt', workhorse.dashboard_iso_v1(state.last_started_at),
      'lastCompletedAt', workhorse.dashboard_iso_v1(state.last_completed_at),
      'due', CASE state.routine_name
        WHEN 'tick' THEN state.last_completed_at IS NULL
          OR state.last_completed_at <= clock_timestamp()
            - make_interval(secs => COALESCE(
                (p_input #>> '{maintenanceLoops,tickIntervalMs}')::numeric,
                1000
              ) / 1000.0)
        WHEN 'history_partitions' THEN state.last_completed_at IS NULL
          OR state.last_completed_at <= clock_timestamp()
            - make_interval(secs => policy.partition_preparation_interval_ms / 1000.0)
        -- A recorded backlog makes the follow-up pass due as prune_terminal_storage_v1 gates it.
        WHEN 'terminal_storage' THEN state.last_completed_at IS NULL
          OR state.last_completed_at <= clock_timestamp()
            - make_interval(secs => CASE WHEN state.terminal_cleanup_backlog_since IS NULL
                THEN policy.terminal_cleanup_interval_ms
                ELSE LEAST(policy.terminal_cleanup_interval_ms,
                  workhorse.terminal_cleanup_follow_up_delay_ms_v1()) END / 1000.0)
        WHEN 'history_retention' THEN
          (clock_timestamp() AT TIME ZONE policy.timezone)::time
            >= policy.history_retention_local_time
          AND (state.last_completed_local_date IS NULL
            OR state.last_completed_local_date
              < (clock_timestamp() AT TIME ZONE policy.timezone)::date)
        ELSE false END,
      'incomplete', state.last_started_at IS NOT NULL
        AND (state.last_completed_at IS NULL
          OR state.last_started_at > state.last_completed_at),
      'recordedRunCount', (
        SELECT count(*)::integer
          FROM workhorse.dashboard_maintenance_run_v1 counted
         WHERE counted.routine_name = state.routine_name
      ),
      'runs', COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'id', recent.run_id::text,
          'startedAt', workhorse.dashboard_iso_v1(recent.started_at),
          'completedAt', workhorse.dashboard_iso_v1(recent.completed_at),
          'durationMs', GREATEST(0, round(extract(epoch FROM
            recent.completed_at - recent.started_at) * 1000)::integer),
          'outcome', recent.outcome,
          'rowsAffected', recent.rows_affected,
          'phases', recent.phases
        ) ORDER BY recent.started_at DESC, recent.run_id DESC)
          FROM (
            SELECT run.* FROM workhorse.dashboard_maintenance_run_v1 run
             WHERE run.routine_name = state.routine_name
             ORDER BY run.started_at DESC, run.run_id DESC
             LIMIT 5
          ) recent
      ), '[]'::jsonb)
    ) ORDER BY state.routine_name), '[]'::jsonb) AS value
      FROM workhorse.dashboard_maintenance_state_v1 state
      CROSS JOIN policy
     WHERE state.routine_name IN ('tick', 'history_partitions', 'history_retention', 'terminal_storage')
  )
  SELECT jsonb_build_object(
    'capturedAt', workhorse.dashboard_iso_v1(clock_timestamp()),
    'schedules', schedules.value,
    -- The listing stops at 50 schedules, so the count tells the page how many it did not show.
    'scheduleCount', (
      SELECT count(*)::integer FROM workhorse.dashboard_schedule_definition_v1
    ),
    'maintenance', jsonb_build_object(
      'cadences', COALESCE(p_input->'maintenanceLoops', '{}'::jsonb),
      'policy', jsonb_build_object(
        'timezone', policy.timezone,
        'partitionPreparationIntervalMs', policy.partition_preparation_interval_ms,
        'terminalCleanupIntervalMs', policy.terminal_cleanup_interval_ms,
        'historyRetentionLocalTime', left(policy.history_retention_local_time::text, 5),
        'updatedAt', workhorse.dashboard_iso_v1(policy.updated_at)),
      'routines', routines.value))
    FROM policy CROSS JOIN schedules CROSS JOIN routines;
$$;
