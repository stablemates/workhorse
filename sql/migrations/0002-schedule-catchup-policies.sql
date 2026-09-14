-- workhorse-migration: {"kind":"additive"}

ALTER TABLE workhorse.schedule_definition
  ADD COLUMN catchup_policy text NOT NULL DEFAULT 'skip'
    CHECK (catchup_policy IN ('skip', 'latest', 'all')),
  ADD COLUMN last_evaluated_at timestamptz NOT NULL
    DEFAULT (date_trunc('second', clock_timestamp()) - interval '1 microsecond');

CREATE OR REPLACE FUNCTION workhorse.sync_schedule_definitions_v2(
  p_namespace text, p_definitions jsonb, p_prune boolean DEFAULT true
) RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  v_previous jsonb;
BEGIN
  IF COALESCE(p_namespace, '') = '' THEN RAISE EXCEPTION 'namespace must not be empty'; END IF;
  IF p_definitions IS NULL OR jsonb_typeof(p_definitions) <> 'array' THEN
    RAISE EXCEPTION 'schedule definitions must be a JSON array';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_definitions) definition
     WHERE COALESCE(definition->>'catchupPolicy', 'skip') NOT IN ('skip', 'latest', 'all')
  ) THEN
    RAISE EXCEPTION 'schedule catch-up policy must be skip, latest, or all';
  END IF;

  SELECT COALESCE(jsonb_object_agg(
    definition.schedule_name,
    jsonb_build_object(
      'revision', definition.revision,
      'cronExpression', definition.cron_expression,
      'timezone', definition.timezone,
      'configuredEnabled', definition.configured_enabled,
      'catchupPolicy', definition.catchup_policy
    )
  ), '{}'::jsonb)
  INTO v_previous
  FROM workhorse.schedule_definition definition
  WHERE definition.namespace = p_namespace;

  PERFORM workhorse.sync_schedule_definitions_v1(p_namespace, p_definitions, p_prune);

  UPDATE workhorse.schedule_definition definition
     SET revision = definition.revision + CASE
           WHEN v_previous ? definition.schedule_name
             AND definition.revision = (v_previous->definition.schedule_name->>'revision')::bigint
             AND definition.catchup_policy IS DISTINCT FROM
               COALESCE(desired.value->>'catchupPolicy', 'skip')
           THEN 1 ELSE 0
         END,
         last_evaluated_at = CASE
           WHEN NOT (v_previous ? definition.schedule_name)
             OR (v_previous->definition.schedule_name->>'cronExpression') IS DISTINCT FROM
               definition.cron_expression
             OR (v_previous->definition.schedule_name->>'timezone') IS DISTINCT FROM
               definition.timezone
             OR (v_previous->definition.schedule_name->>'catchupPolicy') IS DISTINCT FROM
               COALESCE(desired.value->>'catchupPolicy', 'skip')
             OR (
               NOT (v_previous->definition.schedule_name->>'configuredEnabled')::boolean
               AND definition.configured_enabled
               AND COALESCE(desired.value->>'catchupPolicy', 'skip') = 'skip'
             )
           THEN date_trunc('second', clock_timestamp()) - interval '1 microsecond'
           ELSE definition.last_evaluated_at
         END,
         catchup_policy = COALESCE(desired.value->>'catchupPolicy', 'skip')
    FROM jsonb_array_elements(p_definitions) desired(value)
   WHERE definition.namespace = p_namespace
     AND definition.schedule_name = desired.value->>'name';
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
  v_occurrence timestamptz;
  v_evaluation_start timestamptz;
  v_last_evaluated_at timestamptz;
  v_evaluated_count integer;
  v_locked_namespaces text[] := '{}';
  v_skipped_namespaces text[] := '{}';
BEGIN
  IF p_namespaces IS NULL OR array_position(p_namespaces, '') IS NOT NULL THEN
    RAISE EXCEPTION 'schedule namespaces must contain non-empty names';
  END IF;
  IF p_now IS NULL THEN RAISE EXCEPTION 'schedule evaluation time is required'; END IF;
  IF p_catchup_limit NOT BETWEEN 1 AND 10000 THEN
    RAISE EXCEPTION 'schedule catch-up limit must be between 1 and 10000';
  END IF;
  IF p_evaluation_window_ms < 100 THEN
    RAISE EXCEPTION 'schedule evaluation window must be at least 100 milliseconds';
  END IF;

  FOR v_definition IN
    SELECT definition.namespace, definition.schedule_name, definition.cron_expression,
           definition.timezone, definition.revision, definition.catchup_policy,
           definition.last_evaluated_at,
           max(occurrence.occurrence_at) AS last_occurrence_at
      FROM workhorse.schedule_definition definition
      LEFT JOIN workhorse.schedule_occurrence occurrence
        ON occurrence.namespace = definition.namespace
       AND occurrence.schedule_name = definition.schedule_name
     WHERE definition.configured_enabled
       AND NOT definition.paused
       AND definition.namespace = ANY(p_namespaces)
     GROUP BY definition.namespace, definition.schedule_name, definition.cron_expression,
              definition.timezone, definition.revision, definition.catchup_policy,
              definition.last_evaluated_at
     ORDER BY definition.namespace, definition.schedule_name
  LOOP
    IF v_definition.namespace = ANY(v_skipped_namespaces) THEN CONTINUE; END IF;
    IF NOT v_definition.namespace = ANY(v_locked_namespaces) THEN
      IF pg_try_advisory_xact_lock(hashtextextended(
        'workhorse:schedule-namespace:' || v_definition.namespace,
        0
      )) THEN
        v_locked_namespaces := array_append(v_locked_namespaces, v_definition.namespace);
      ELSE
        v_skipped_namespaces := array_append(v_skipped_namespaces, v_definition.namespace);
        CONTINUE;
      END IF;
    END IF;

    v_evaluation_start := GREATEST(
      v_definition.last_evaluated_at,
      v_definition.last_occurrence_at
    );
    IF v_definition.catchup_policy = 'skip' THEN
      v_evaluation_start := GREATEST(
        v_evaluation_start,
        p_now - make_interval(secs => p_evaluation_window_ms::double precision / 1000)
      );
    END IF;
    v_evaluated_count := 0;
    v_last_evaluated_at := NULL;

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

    UPDATE workhorse.schedule_definition definition
       SET last_evaluated_at = CASE
         WHEN v_definition.catchup_policy = 'all'
           AND v_evaluated_count = p_catchup_limit
           AND v_last_evaluated_at IS NOT NULL
         THEN v_last_evaluated_at
         ELSE p_now
       END
     WHERE definition.namespace = v_definition.namespace
       AND definition.schedule_name = v_definition.schedule_name
       AND definition.revision = v_definition.revision;
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION workhorse.set_schedule_paused_v1(
  p_namespace text,
  p_schedule_name text,
  p_paused boolean,
  p_requested_by text,
  p_reason text,
  p_occurred_at timestamptz DEFAULT clock_timestamp()
) RETURNS boolean
LANGUAGE plpgsql
AS $$
DECLARE
  v_paused boolean;
BEGIN
  IF COALESCE(p_namespace, '') = '' THEN RAISE EXCEPTION 'namespace must not be empty'; END IF;
  IF COALESCE(p_schedule_name, '') = '' THEN RAISE EXCEPTION 'schedule name must not be empty'; END IF;
  IF p_paused IS NULL THEN RAISE EXCEPTION 'paused must not be null'; END IF;
  IF COALESCE(p_requested_by, '') = '' THEN RAISE EXCEPTION 'requested by must not be empty'; END IF;
  IF COALESCE(p_reason, '') = '' THEN RAISE EXCEPTION 'reason must not be empty'; END IF;
  IF p_occurred_at IS NULL THEN RAISE EXCEPTION 'occurred at must not be null'; END IF;

  UPDATE workhorse.schedule_definition definition
     SET paused = p_paused,
         paused_by = CASE WHEN p_paused THEN p_requested_by ELSE NULL END,
         paused_reason = CASE WHEN p_paused THEN p_reason ELSE NULL END,
         paused_at = CASE WHEN p_paused THEN p_occurred_at ELSE NULL END,
         last_evaluated_at = CASE
           WHEN NOT p_paused AND definition.catchup_policy = 'skip' THEN p_occurred_at
           ELSE definition.last_evaluated_at
         END,
         revision = definition.revision + 1,
         updated_at = clock_timestamp()
   WHERE definition.namespace = p_namespace
     AND definition.schedule_name = p_schedule_name
  RETURNING definition.paused INTO v_paused;
  RETURN v_paused;
END;
$$;

CREATE OR REPLACE VIEW workhorse.dashboard_schedule_definition_v1 AS
  SELECT namespace, schedule_name, cron_expression, timezone, queue_name, task_type,
         configured_enabled, paused, paused_by, paused_reason, paused_at, revision,
         updated_at, priority, catchup_policy FROM workhorse.schedule_definition;

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
        WHEN 'terminal_storage' THEN state.last_completed_at IS NULL
          OR state.last_completed_at <= clock_timestamp()
            - make_interval(secs => policy.terminal_cleanup_interval_ms / 1000.0)
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

INSERT INTO workhorse.protocol_version(version) VALUES (2) ON CONFLICT DO NOTHING;
