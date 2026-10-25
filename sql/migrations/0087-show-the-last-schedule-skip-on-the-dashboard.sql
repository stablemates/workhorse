-- workhorse-migration: {"kind":"additive"}

-- Show the last skip of a schedule on the dashboard Schedules page (SM-1708).

-- Migration 0083 records each skip of a `skip` schedule in schedule_definition.last_skipped_at,
-- last_skipped_count, and last_skipped_through. The dashboard read neither column, so an operator
-- could see a skip only with SQL. dashboard_schedule_definition_v1 now appends the three columns,
-- and dashboard_cron_v1 returns them as lastSkippedAt, lastSkippedCount, and lastSkippedThrough on
-- each application schedule.
--
-- The view only appends columns, so every earlier column keeps its position, type, and meaning.
-- dashboard_cron_v1 keeps its name, its argument, and its result type, and its document only gains
-- keys, so the function keeps its suffix under ADR 0109. No change touches stored data.

CREATE OR REPLACE VIEW workhorse.dashboard_schedule_definition_v1 AS
  SELECT namespace, schedule_name, cron_expression, timezone, queue_name, task_type,
         configured_enabled, paused, paused_by, paused_reason, paused_at, revision,
         updated_at, priority, catchup_policy, last_skipped_at, last_skipped_count,
         last_skipped_through FROM workhorse.schedule_definition;

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
           definition.last_skipped_at, definition.last_skipped_count,
           definition.last_skipped_through,
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
              definition.revision, definition.updated_at,
              definition.last_skipped_at, definition.last_skipped_count,
              definition.last_skipped_through
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
      'evaluatorCount', evaluator_count,
      'lastSkippedAt', workhorse.dashboard_iso_v1(last_skipped_at),
      'lastSkippedCount', last_skipped_count,
      'lastSkippedThrough', workhorse.dashboard_iso_v1(last_skipped_through)
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
