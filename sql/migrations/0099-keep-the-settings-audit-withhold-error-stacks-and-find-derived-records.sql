-- workhorse-migration: {"kind":"additive"}

-- Keep the audit of each dashboard settings change, withhold error stacks in SQL, and find each
-- derived history record by its identity.

-- The dashboard asks for an actor, a reason, and a request ID for each change of the retention or
-- the maintenance policy, but the policy functions took none, and nothing kept them (SM-1996).
-- Each policy table holds one row, and the dashboard shows the provenance of each setting, so the
-- audit is kept for each setting. retention_policy and maintenance_policy get the nullable column
-- operator_audit. It maps a column name to the entry of the last operator change of that setting:
-- action (override or revert), actor, reason, requestIdPreview, requestIdDigest, requestIdLength,
-- and changedAt. The raw request ID is never stored, as in queue_control.
--
-- override_retention_policy_v2, revert_retention_policy_v2, override_maintenance_policy_v2, and
-- revert_maintenance_policy_v2 take the actor, the reason, and the request ID. They check them with
-- the limits of set_queue_paused_v1: 1 to 200 characters, 1 to 2000 characters, and 1 to 512 UTF-8
-- bytes. Then they call the v1 function and write one entry for each changed setting. changedAt is
-- the updated_at of the row, which the v1 function reads after the row lock.
--
-- The released writers change only their body, to keep each entry true. Without this, a setting
-- shows an actor who did not set its value:
-- - override_*_policy_v1 and revert_*_policy_v1 remove the entry of each setting that they change.
-- - sync_*_policy_v1 with p_force removes every entry. Without p_force, it removes the entry of
--   each setting whose effective value it changes.
-- revert_retention_policy_v2 locks the row before it calls revert_retention_policy_v1, so the time
-- of the change is read after any wait for the lock.
-- dashboard_settings_v1 shows an entry under lastChanges.<setting> when its action matches
-- the source of the setting: override for an operator value, revert for an application value.
--
-- dashboard_task_detail_v1, dashboard_events_v1, and dashboard_event_detail_v1 read the input key
-- redactErrorStacks (SM-1968). If it is true, each error envelope in their documents comes without
-- its stack, also details.error of a failure event. The search of dashboard_events_v1 then does not
-- match a withheld stack. A host sets the key from its own option, after it drops each input key
-- that the request schema does not declare.
--
-- dashboard_event_detail_v1 accepted only a version 7 UUID, so it returned null for each record
-- that dashboard_task_event_v1 or dashboard_attempt_history_v1 derives for a fast-tier task
-- (SM-1999). It now accepts any UUID in canonical form. The comment above `filtered` in
-- dashboard_tasks_v1 now states when PostgreSQL materializes it (SM-1961).
--
-- Each released function keeps its name, its arguments, and its result columns under ADR 0109.
-- The functions that return a policy row also return the new column at its end. An input without
-- redactErrorStacks gets the same document as before, and an event identity that the earlier body
-- refused is a new input that the function accepts. The two new columns have no default, so the
-- migration rewrites no row.

ALTER TABLE workhorse.retention_policy ADD COLUMN IF NOT EXISTS operator_audit jsonb;
ALTER TABLE workhorse.maintenance_policy ADD COLUMN IF NOT EXISTS operator_audit jsonb;

CREATE OR REPLACE FUNCTION workhorse.policy_audit_entry_internal_v1(
  p_action text,
  p_actor text,
  p_reason text,
  p_request_id text
) RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  v_length integer;
BEGIN
  IF p_action IS NULL OR p_action NOT IN ('override', 'revert') THEN
    RAISE EXCEPTION 'policy audit action must be override or revert';
  END IF;
  IF p_actor IS NULL OR p_actor = '' OR char_length(p_actor) > 200 THEN
    RAISE EXCEPTION 'requested_by must contain between 1 and 200 characters';
  END IF;
  IF p_reason IS NULL OR p_reason = '' OR char_length(p_reason) > 2000 THEN
    RAISE EXCEPTION 'reason must contain between 1 and 2000 characters';
  END IF;
  IF p_request_id IS NULL OR p_request_id = '' OR octet_length(p_request_id) > 512 THEN
    RAISE EXCEPTION 'request_id must contain between 1 and 512 UTF-8 bytes';
  END IF;
  v_length := char_length(p_request_id);
  RETURN jsonb_build_object(
    'action', p_action,
    'actor', p_actor,
    'reason', p_reason,
    'requestIdPreview', CASE
      WHEN v_length <= 4 THEN repeat('•', v_length)
      WHEN v_length <= 8 THEN left(p_request_id, 2) || '…' || right(p_request_id, 2)
      ELSE left(p_request_id, 8) || '…' || right(p_request_id, 4)
    END,
    'requestIdDigest', left(encode(sha256(convert_to(p_request_id, 'UTF8')), 'hex'), 12),
    'requestIdLength', v_length
  );
END;
$$;

CREATE OR REPLACE FUNCTION workhorse.sync_retention_policy_v1(
  p_task_identity_retention_days integer,
  p_terminal_outcome_retention_days integer,
  p_task_event_retention_days integer,
  p_attempt_history_retention_days integer,
  p_schedule_occurrence_retention_days integer,
  p_statistics_retention_days integer DEFAULT NULL,
  p_terminal_task_prune_limit integer DEFAULT NULL,
  p_history_partitions_per_pass integer DEFAULT NULL,
  p_default_partition_rows_per_pass integer DEFAULT NULL,
  p_occurrence_rows_per_pass integer DEFAULT NULL,
  p_statistics_rows_per_pass integer DEFAULT NULL,
  p_force boolean DEFAULT false
) RETURNS workhorse.retention_policy
LANGUAGE plpgsql
AS $$
DECLARE v_policy workhorse.retention_policy%ROWTYPE;
DECLARE v_previous workhorse.retention_policy%ROWTYPE;
BEGIN
  SELECT * INTO STRICT v_previous
    FROM workhorse.retention_policy
   WHERE singleton
   FOR UPDATE;
  UPDATE workhorse.retention_policy policy SET
    application_task_identity_retention_days = p_task_identity_retention_days,
    application_terminal_outcome_retention_days = p_terminal_outcome_retention_days,
    application_task_event_retention_days = p_task_event_retention_days,
    application_attempt_history_retention_days = p_attempt_history_retention_days,
    application_schedule_occurrence_retention_days = p_schedule_occurrence_retention_days,
    application_statistics_retention_days = p_statistics_retention_days,
    application_terminal_task_prune_limit = COALESCE(
      p_terminal_task_prune_limit, policy.application_terminal_task_prune_limit
    ),
    application_history_partitions_per_pass = COALESCE(
      p_history_partitions_per_pass, policy.application_history_partitions_per_pass
    ),
    application_default_partition_rows_per_pass = COALESCE(
      p_default_partition_rows_per_pass, policy.application_default_partition_rows_per_pass
    ),
    application_occurrence_rows_per_pass = COALESCE(
      p_occurrence_rows_per_pass, policy.application_occurrence_rows_per_pass
    ),
    application_statistics_rows_per_pass = COALESCE(
      p_statistics_rows_per_pass, policy.application_statistics_rows_per_pass
    ),
    task_identity_retention_days = CASE
      WHEN p_force OR NOT ('task_identity_retention_days' = ANY(policy.operator_overrides))
        THEN p_task_identity_retention_days ELSE policy.task_identity_retention_days END,
    terminal_outcome_retention_days = CASE
      WHEN p_force OR NOT ('terminal_outcome_retention_days' = ANY(policy.operator_overrides))
        THEN p_terminal_outcome_retention_days ELSE policy.terminal_outcome_retention_days END,
    task_event_retention_days = CASE
      WHEN p_force OR NOT ('task_event_retention_days' = ANY(policy.operator_overrides))
        THEN p_task_event_retention_days ELSE policy.task_event_retention_days END,
    attempt_history_retention_days = CASE
      WHEN p_force OR NOT ('attempt_history_retention_days' = ANY(policy.operator_overrides))
        THEN p_attempt_history_retention_days ELSE policy.attempt_history_retention_days END,
    schedule_occurrence_retention_days = CASE
      WHEN p_force OR NOT ('schedule_occurrence_retention_days' = ANY(policy.operator_overrides))
        THEN p_schedule_occurrence_retention_days ELSE policy.schedule_occurrence_retention_days END,
    statistics_retention_days = CASE
      WHEN p_force OR NOT ('statistics_retention_days' = ANY(policy.operator_overrides))
        THEN p_statistics_retention_days ELSE policy.statistics_retention_days END,
    terminal_task_prune_limit = CASE
      WHEN p_force THEN COALESCE(
        p_terminal_task_prune_limit, policy.application_terminal_task_prune_limit
      )
      WHEN p_terminal_task_prune_limit IS NULL THEN policy.terminal_task_prune_limit
      WHEN NOT ('terminal_task_prune_limit' = ANY(policy.operator_overrides))
        THEN p_terminal_task_prune_limit ELSE policy.terminal_task_prune_limit END,
    history_partitions_per_pass = CASE
      WHEN p_force THEN COALESCE(
        p_history_partitions_per_pass, policy.application_history_partitions_per_pass
      )
      WHEN p_history_partitions_per_pass IS NULL THEN policy.history_partitions_per_pass
      WHEN NOT ('history_partitions_per_pass' = ANY(policy.operator_overrides))
        THEN p_history_partitions_per_pass ELSE policy.history_partitions_per_pass END,
    default_partition_rows_per_pass = CASE
      WHEN p_force THEN COALESCE(
        p_default_partition_rows_per_pass, policy.application_default_partition_rows_per_pass
      )
      WHEN p_default_partition_rows_per_pass IS NULL THEN policy.default_partition_rows_per_pass
      WHEN NOT ('default_partition_rows_per_pass' = ANY(policy.operator_overrides))
        THEN p_default_partition_rows_per_pass ELSE policy.default_partition_rows_per_pass END,
    occurrence_rows_per_pass = CASE
      WHEN p_force THEN COALESCE(
        p_occurrence_rows_per_pass, policy.application_occurrence_rows_per_pass
      )
      WHEN p_occurrence_rows_per_pass IS NULL THEN policy.occurrence_rows_per_pass
      WHEN NOT ('occurrence_rows_per_pass' = ANY(policy.operator_overrides))
        THEN p_occurrence_rows_per_pass ELSE policy.occurrence_rows_per_pass END,
    statistics_rows_per_pass = CASE
      WHEN p_force THEN COALESCE(
        p_statistics_rows_per_pass, policy.application_statistics_rows_per_pass
      )
      WHEN p_statistics_rows_per_pass IS NULL THEN policy.statistics_rows_per_pass
      WHEN NOT ('statistics_rows_per_pass' = ANY(policy.operator_overrides))
        THEN p_statistics_rows_per_pass ELSE policy.statistics_rows_per_pass END,
    operator_overrides = CASE WHEN p_force THEN '{}'::text[] ELSE policy.operator_overrides END,
    operator_audit = CASE WHEN p_force THEN NULL ELSE policy.operator_audit END,
    updated_at = clock_timestamp()
  WHERE singleton
  RETURNING * INTO v_policy;
  -- A sync without force changes the effective value of a setting only when no operator owns it.
  -- An entry of such a setting describes a revert to the earlier value, so it goes too.
  IF p_force IS NOT TRUE AND v_policy.operator_audit IS NOT NULL THEN
    UPDATE workhorse.retention_policy policy
       SET operator_audit = NULLIF(policy.operator_audit - ARRAY(
             SELECT setting.name
               FROM unnest(ARRAY[
        'task_identity_retention_days', 'terminal_outcome_retention_days',
        'task_event_retention_days', 'attempt_history_retention_days',
        'schedule_occurrence_retention_days', 'statistics_retention_days',
        'terminal_task_prune_limit', 'history_partitions_per_pass',
        'default_partition_rows_per_pass', 'occurrence_rows_per_pass',
        'statistics_rows_per_pass'
               ]::text[]) setting(name)
              WHERE to_jsonb(v_policy) -> setting.name
                    IS DISTINCT FROM to_jsonb(v_previous) -> setting.name
           ), '{}'::jsonb)
     WHERE singleton
     RETURNING * INTO v_policy;
  END IF;
  IF (
       v_previous.task_event_retention_days IS DISTINCT FROM v_policy.task_event_retention_days
       OR v_previous.attempt_history_retention_days IS DISTINCT FROM
            v_policy.attempt_history_retention_days
       OR v_previous.schedule_occurrence_retention_days IS DISTINCT FROM
            v_policy.schedule_occurrence_retention_days
     ) THEN
    UPDATE workhorse.maintenance_state state
       SET history_retained_before = CASE
             WHEN v_policy.task_event_retention_days IS NOT NULL
              AND v_policy.attempt_history_retention_days IS NOT NULL THEN
               LEAST(
                 state.history_retained_before,
                 LEAST(
                   date_trunc('day', clock_timestamp() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
                     - make_interval(hours => 24 * v_policy.task_event_retention_days),
                   date_trunc('day', clock_timestamp() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
                     - make_interval(hours => 24 * v_policy.attempt_history_retention_days)
                 )
               )
             ELSE state.history_retained_before
           END,
           last_completed_local_date = NULL,
           updated_at = clock_timestamp()
     WHERE state.routine_name = 'history_retention';
  END IF;
  RETURN v_policy;
END;
$$;

CREATE OR REPLACE FUNCTION workhorse.override_retention_policy_v1(
  p_overrides jsonb
) RETURNS workhorse.retention_policy
LANGUAGE plpgsql
AS $$
DECLARE v_policy workhorse.retention_policy%ROWTYPE;
DECLARE v_previous workhorse.retention_policy%ROWTYPE;
DECLARE v_names text[];
BEGIN
  IF p_overrides IS NULL OR jsonb_typeof(p_overrides) <> 'object'
     OR p_overrides = '{}'::jsonb THEN
    RAISE EXCEPTION 'retention override must be a non-empty object';
  END IF;
  SELECT array_agg(name ORDER BY name) INTO v_names FROM jsonb_object_keys(p_overrides) name;
  IF NOT v_names <@ ARRAY[
    'task_identity_retention_days', 'terminal_outcome_retention_days',
    'task_event_retention_days', 'attempt_history_retention_days',
    'schedule_occurrence_retention_days', 'statistics_retention_days',
    'terminal_task_prune_limit', 'history_partitions_per_pass',
    'default_partition_rows_per_pass', 'occurrence_rows_per_pass',
    'statistics_rows_per_pass'
  ]::text[] THEN
    RAISE EXCEPTION 'retention override contains unknown settings';
  END IF;

  SELECT * INTO STRICT v_previous FROM workhorse.retention_policy WHERE singleton FOR UPDATE;
  UPDATE workhorse.retention_policy policy SET
    task_identity_retention_days = CASE WHEN p_overrides ? 'task_identity_retention_days'
      THEN (p_overrides->>'task_identity_retention_days')::integer
      ELSE policy.task_identity_retention_days END,
    terminal_outcome_retention_days = CASE WHEN p_overrides ? 'terminal_outcome_retention_days'
      THEN (p_overrides->>'terminal_outcome_retention_days')::integer
      ELSE policy.terminal_outcome_retention_days END,
    task_event_retention_days = CASE WHEN p_overrides ? 'task_event_retention_days'
      THEN (p_overrides->>'task_event_retention_days')::integer
      ELSE policy.task_event_retention_days END,
    attempt_history_retention_days = CASE WHEN p_overrides ? 'attempt_history_retention_days'
      THEN (p_overrides->>'attempt_history_retention_days')::integer
      ELSE policy.attempt_history_retention_days END,
    schedule_occurrence_retention_days = CASE
      WHEN p_overrides ? 'schedule_occurrence_retention_days'
        THEN (p_overrides->>'schedule_occurrence_retention_days')::integer
      ELSE policy.schedule_occurrence_retention_days END,
    statistics_retention_days = CASE WHEN p_overrides ? 'statistics_retention_days'
      THEN (p_overrides->>'statistics_retention_days')::integer
      ELSE policy.statistics_retention_days END,
    terminal_task_prune_limit = CASE WHEN p_overrides ? 'terminal_task_prune_limit'
      THEN (p_overrides->>'terminal_task_prune_limit')::integer
      ELSE policy.terminal_task_prune_limit END,
    history_partitions_per_pass = CASE WHEN p_overrides ? 'history_partitions_per_pass'
      THEN (p_overrides->>'history_partitions_per_pass')::integer
      ELSE policy.history_partitions_per_pass END,
    default_partition_rows_per_pass = CASE
      WHEN p_overrides ? 'default_partition_rows_per_pass'
        THEN (p_overrides->>'default_partition_rows_per_pass')::integer
      ELSE policy.default_partition_rows_per_pass END,
    occurrence_rows_per_pass = CASE WHEN p_overrides ? 'occurrence_rows_per_pass'
      THEN (p_overrides->>'occurrence_rows_per_pass')::integer
      ELSE policy.occurrence_rows_per_pass END,
    statistics_rows_per_pass = CASE WHEN p_overrides ? 'statistics_rows_per_pass'
      THEN (p_overrides->>'statistics_rows_per_pass')::integer
      ELSE policy.statistics_rows_per_pass END,
    operator_overrides = ARRAY(
      SELECT DISTINCT name FROM unnest(policy.operator_overrides || v_names) name ORDER BY name
    ),
    operator_audit = NULLIF(policy.operator_audit - v_names, '{}'::jsonb),
    updated_at = clock_timestamp()
  WHERE singleton
  RETURNING * INTO v_policy;
  IF (
       v_previous.task_event_retention_days IS DISTINCT FROM v_policy.task_event_retention_days
       OR v_previous.attempt_history_retention_days IS DISTINCT FROM
            v_policy.attempt_history_retention_days
       OR v_previous.schedule_occurrence_retention_days IS DISTINCT FROM
            v_policy.schedule_occurrence_retention_days
     ) THEN
    UPDATE workhorse.maintenance_state state
       SET history_retained_before = CASE
             WHEN v_policy.task_event_retention_days IS NOT NULL
              AND v_policy.attempt_history_retention_days IS NOT NULL THEN
               LEAST(
                 state.history_retained_before,
                 LEAST(
                   date_trunc('day', clock_timestamp() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
                     - make_interval(hours => 24 * v_policy.task_event_retention_days),
                   date_trunc('day', clock_timestamp() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
                     - make_interval(hours => 24 * v_policy.attempt_history_retention_days)
                 )
               )
             ELSE state.history_retained_before
           END,
           last_completed_local_date = NULL,
           updated_at = clock_timestamp()
     WHERE state.routine_name = 'history_retention';
  END IF;
  RETURN v_policy;
END;
$$;

CREATE OR REPLACE FUNCTION workhorse.revert_retention_policy_v1(
  p_settings text[]
) RETURNS workhorse.retention_policy
LANGUAGE plpgsql
AS $$
DECLARE v_policy workhorse.retention_policy%ROWTYPE;
BEGIN
  IF p_settings IS NULL OR cardinality(p_settings) = 0 OR NOT p_settings <@ ARRAY[
    'task_identity_retention_days', 'terminal_outcome_retention_days',
    'task_event_retention_days', 'attempt_history_retention_days',
    'schedule_occurrence_retention_days', 'statistics_retention_days',
    'terminal_task_prune_limit', 'history_partitions_per_pass',
    'default_partition_rows_per_pass', 'occurrence_rows_per_pass',
    'statistics_rows_per_pass'
  ]::text[] THEN
    RAISE EXCEPTION 'retention revert must name known settings';
  END IF;
  UPDATE workhorse.retention_policy policy SET
    task_identity_retention_days = CASE WHEN 'task_identity_retention_days' = ANY(p_settings)
      THEN policy.application_task_identity_retention_days
      ELSE policy.task_identity_retention_days END,
    terminal_outcome_retention_days = CASE WHEN 'terminal_outcome_retention_days' = ANY(p_settings)
      THEN policy.application_terminal_outcome_retention_days
      ELSE policy.terminal_outcome_retention_days END,
    task_event_retention_days = CASE WHEN 'task_event_retention_days' = ANY(p_settings)
      THEN policy.application_task_event_retention_days ELSE policy.task_event_retention_days END,
    attempt_history_retention_days = CASE WHEN 'attempt_history_retention_days' = ANY(p_settings)
      THEN policy.application_attempt_history_retention_days
      ELSE policy.attempt_history_retention_days END,
    schedule_occurrence_retention_days = CASE
      WHEN 'schedule_occurrence_retention_days' = ANY(p_settings)
        THEN policy.application_schedule_occurrence_retention_days
      ELSE policy.schedule_occurrence_retention_days END,
    statistics_retention_days = CASE WHEN 'statistics_retention_days' = ANY(p_settings)
      THEN policy.application_statistics_retention_days ELSE policy.statistics_retention_days END,
    terminal_task_prune_limit = CASE WHEN 'terminal_task_prune_limit' = ANY(p_settings)
      THEN policy.application_terminal_task_prune_limit ELSE policy.terminal_task_prune_limit END,
    history_partitions_per_pass = CASE WHEN 'history_partitions_per_pass' = ANY(p_settings)
      THEN policy.application_history_partitions_per_pass ELSE policy.history_partitions_per_pass END,
    default_partition_rows_per_pass = CASE
      WHEN 'default_partition_rows_per_pass' = ANY(p_settings)
        THEN policy.application_default_partition_rows_per_pass
      ELSE policy.default_partition_rows_per_pass END,
    occurrence_rows_per_pass = CASE WHEN 'occurrence_rows_per_pass' = ANY(p_settings)
      THEN policy.application_occurrence_rows_per_pass ELSE policy.occurrence_rows_per_pass END,
    statistics_rows_per_pass = CASE WHEN 'statistics_rows_per_pass' = ANY(p_settings)
      THEN policy.application_statistics_rows_per_pass ELSE policy.statistics_rows_per_pass END,
    operator_overrides = ARRAY(
      SELECT name FROM unnest(policy.operator_overrides) name WHERE NOT (name = ANY(p_settings))
    ),
    operator_audit = NULLIF(policy.operator_audit - p_settings, '{}'::jsonb),
    updated_at = clock_timestamp()
  WHERE singleton
  RETURNING * INTO v_policy;
  UPDATE workhorse.maintenance_state
     SET last_completed_local_date = NULL, updated_at = clock_timestamp()
   WHERE routine_name = 'history_retention'
     AND p_settings && ARRAY[
       'task_event_retention_days', 'attempt_history_retention_days',
       'schedule_occurrence_retention_days'
     ]::text[];
  RETURN v_policy;
END;
$$;

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
    operator_audit = CASE WHEN p_force THEN NULL ELSE policy.operator_audit END,
    updated_at = clock_timestamp()
  WHERE singleton
  RETURNING * INTO v_policy;
  -- A sync without force changes the effective value of a setting only when no operator owns it.
  -- An entry of such a setting describes a revert to the earlier value, so it goes too.
  IF p_force IS NOT TRUE AND v_policy.operator_audit IS NOT NULL THEN
    UPDATE workhorse.maintenance_policy policy
       SET operator_audit = NULLIF(policy.operator_audit - ARRAY(
             SELECT setting.name
               FROM unnest(ARRAY[
        'timezone', 'partition_preparation_interval_ms',
        'terminal_cleanup_interval_ms', 'history_retention_local_time',
        'statistics_rollup_interval_ms', 'statistics_group_limit', 'statistics_recompute_buckets'
               ]::text[]) setting(name)
              WHERE to_jsonb(v_policy) -> setting.name
                    IS DISTINCT FROM to_jsonb(v_previous) -> setting.name
           ), '{}'::jsonb)
     WHERE singleton
     RETURNING * INTO v_policy;
  END IF;
  IF v_previous.timezone IS DISTINCT FROM v_policy.timezone
     OR v_previous.history_retention_local_time IS DISTINCT FROM v_policy.history_retention_local_time THEN
    UPDATE workhorse.maintenance_state
       SET last_completed_local_date = NULL, updated_at = clock_timestamp()
     WHERE routine_name = 'history_retention';
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
    operator_audit = NULLIF(policy.operator_audit - v_overrides, '{}'::jsonb),
    updated_at = clock_timestamp()
  WHERE singleton
  RETURNING * INTO v_policy;
  IF v_previous.timezone IS DISTINCT FROM v_policy.timezone
     OR v_previous.history_retention_local_time IS DISTINCT FROM v_policy.history_retention_local_time THEN
    UPDATE workhorse.maintenance_state
       SET last_completed_local_date = NULL, updated_at = clock_timestamp()
     WHERE routine_name = 'history_retention';
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
    operator_audit = NULLIF(policy.operator_audit - p_settings, '{}'::jsonb),
    updated_at = clock_timestamp()
  WHERE singleton
  RETURNING * INTO v_policy;
  IF v_previous.timezone IS DISTINCT FROM v_policy.timezone
     OR v_previous.history_retention_local_time IS DISTINCT FROM v_policy.history_retention_local_time THEN
    UPDATE workhorse.maintenance_state
       SET last_completed_local_date = NULL, updated_at = clock_timestamp()
     WHERE routine_name = 'history_retention';
  END IF;
  RETURN v_policy;
END;
$$;

CREATE OR REPLACE FUNCTION workhorse.override_retention_policy_v2(
  p_overrides jsonb,
  p_actor text,
  p_reason text,
  p_request_id text
) RETURNS workhorse.retention_policy
LANGUAGE plpgsql
AS $$
DECLARE v_entry jsonb := workhorse.policy_audit_entry_internal_v1(
  'override', p_actor, p_reason, p_request_id
);
DECLARE v_policy workhorse.retention_policy%ROWTYPE;
BEGIN
  v_policy := workhorse.override_retention_policy_v1(p_overrides);
  UPDATE workhorse.retention_policy policy
     SET operator_audit = COALESCE(policy.operator_audit, '{}'::jsonb) || (
           SELECT jsonb_object_agg(name, v_entry || jsonb_build_object('changedAt',
                    to_char(v_policy.updated_at AT TIME ZONE 'UTC',
                            'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')))
             FROM jsonb_object_keys(p_overrides) name
         )
   WHERE singleton
   RETURNING * INTO v_policy;
  RETURN v_policy;
END;
$$;

CREATE OR REPLACE FUNCTION workhorse.revert_retention_policy_v2(
  p_settings text[],
  p_actor text,
  p_reason text,
  p_request_id text
) RETURNS workhorse.retention_policy
LANGUAGE plpgsql
AS $$
DECLARE v_entry jsonb := workhorse.policy_audit_entry_internal_v1(
  'revert', p_actor, p_reason, p_request_id
);
DECLARE v_policy workhorse.retention_policy%ROWTYPE;
BEGIN
  -- revert_retention_policy_v1 reads the clock in its UPDATE. Take the row lock first, so the
  -- time of the change is read after any wait for the lock.
  PERFORM 1 FROM workhorse.retention_policy WHERE singleton FOR UPDATE;
  v_policy := workhorse.revert_retention_policy_v1(p_settings);
  UPDATE workhorse.retention_policy policy
     SET operator_audit = COALESCE(policy.operator_audit, '{}'::jsonb) || (
           SELECT jsonb_object_agg(name, v_entry || jsonb_build_object('changedAt',
                    to_char(v_policy.updated_at AT TIME ZONE 'UTC',
                            'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')))
             FROM unnest(p_settings) name
         )
   WHERE singleton
   RETURNING * INTO v_policy;
  RETURN v_policy;
END;
$$;

CREATE OR REPLACE FUNCTION workhorse.override_maintenance_policy_v2(
  p_timezone text,
  p_partition_preparation_interval_ms integer,
  p_terminal_cleanup_interval_ms integer,
  p_history_retention_local_time time,
  p_statistics_rollup_interval_ms integer,
  p_statistics_group_limit integer,
  p_statistics_recompute_buckets integer,
  p_actor text,
  p_reason text,
  p_request_id text
) RETURNS workhorse.maintenance_policy
LANGUAGE plpgsql
AS $$
DECLARE v_entry jsonb := workhorse.policy_audit_entry_internal_v1(
  'override', p_actor, p_reason, p_request_id
);
DECLARE v_policy workhorse.maintenance_policy%ROWTYPE;
BEGIN
  v_policy := workhorse.override_maintenance_policy_v1(
    p_timezone, p_partition_preparation_interval_ms, p_terminal_cleanup_interval_ms,
    p_history_retention_local_time, p_statistics_rollup_interval_ms, p_statistics_group_limit,
    p_statistics_recompute_buckets
  );
  UPDATE workhorse.maintenance_policy policy
     SET operator_audit = COALESCE(policy.operator_audit, '{}'::jsonb) || (
           SELECT jsonb_object_agg(setting.name, v_entry || jsonb_build_object('changedAt',
                    to_char(v_policy.updated_at AT TIME ZONE 'UTC',
                            'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')))
             FROM (VALUES
               ('timezone', p_timezone IS NOT NULL),
               ('partition_preparation_interval_ms', p_partition_preparation_interval_ms IS NOT NULL),
               ('terminal_cleanup_interval_ms', p_terminal_cleanup_interval_ms IS NOT NULL),
               ('history_retention_local_time', p_history_retention_local_time IS NOT NULL),
               ('statistics_rollup_interval_ms', p_statistics_rollup_interval_ms IS NOT NULL),
               ('statistics_group_limit', p_statistics_group_limit IS NOT NULL),
               ('statistics_recompute_buckets', p_statistics_recompute_buckets IS NOT NULL)
             ) setting(name, changed)
            WHERE setting.changed
         )
   WHERE singleton
   RETURNING * INTO v_policy;
  RETURN v_policy;
END;
$$;

CREATE OR REPLACE FUNCTION workhorse.revert_maintenance_policy_v2(
  p_settings text[],
  p_actor text,
  p_reason text,
  p_request_id text
) RETURNS workhorse.maintenance_policy
LANGUAGE plpgsql
AS $$
DECLARE v_entry jsonb := workhorse.policy_audit_entry_internal_v1(
  'revert', p_actor, p_reason, p_request_id
);
DECLARE v_policy workhorse.maintenance_policy%ROWTYPE;
BEGIN
  v_policy := workhorse.revert_maintenance_policy_v1(p_settings);
  UPDATE workhorse.maintenance_policy policy
     SET operator_audit = COALESCE(policy.operator_audit, '{}'::jsonb) || (
           SELECT jsonb_object_agg(name, v_entry || jsonb_build_object('changedAt',
                    to_char(v_policy.updated_at AT TIME ZONE 'UTC',
                            'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')))
             FROM unnest(p_settings) name
         )
   WHERE singleton
   RETURNING * INTO v_policy;
  RETURN v_policy;
END;
$$;

CREATE OR REPLACE FUNCTION workhorse.dashboard_error_without_stack_v1(
  p_error jsonb, p_redact boolean
) RETURNS jsonb
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT CASE WHEN p_redact AND jsonb_typeof(p_error) = 'object'
              THEN p_error - 'stack' ELSE p_error END;
$$;

CREATE OR REPLACE FUNCTION workhorse.dashboard_details_without_stack_v1(
  p_details jsonb, p_redact boolean
) RETURNS jsonb
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT CASE WHEN p_redact AND jsonb_typeof(p_details) = 'object' AND p_details ? 'error'
              THEN jsonb_set(p_details, '{error}',
                             workhorse.dashboard_error_without_stack_v1(p_details->'error', true))
              ELSE p_details END;
$$;

CREATE OR REPLACE FUNCTION workhorse.dashboard_tasks_v1(p_input jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SET jit = off
AS $$
DECLARE
  v_scope text := '';
  v_scope_from text := 'FROM workhorse.dashboard_task_v1 j';
  v_query text;
  v_result jsonb;
BEGIN
  IF cardinality(workhorse.dashboard_tag_filter_v1(p_input->'tags')) > 0 THEN
    v_scope := $scope$task_scope AS (
    SELECT j.id FROM workhorse.dashboard_task_v1 j
     WHERE j.tags && workhorse.dashboard_tag_filter_v1($1->'tags')
  ), $scope$;
  ELSIF NULLIF(p_input->>'queue', '') IS NOT NULL
     OR NULLIF(p_input->>'taskType', '') IS NOT NULL THEN
    v_scope := $scope$task_scope AS (
    SELECT query_row.task_id AS id FROM workhorse.dashboard_task_query_v1 query_row
     WHERE (NULLIF($1->>'queue', '') IS NULL
            OR query_row.queue_name = NULLIF($1->>'queue', ''))
       AND (NULLIF($1->>'taskType', '') IS NULL
            OR query_row.task_type = NULLIF($1->>'taskType', ''))
  ), $scope$;
  END IF;
  IF v_scope <> '' THEN
    v_scope_from := 'FROM task_scope
      JOIN workhorse.dashboard_task_v1 j ON j.id = task_scope.id';
  END IF;
  v_query := replace(replace($query$
  WITH parameters AS (
    SELECT COALESCE(NULLIF($1->>'filter', ''), 'all') AS filter,
           NULLIF($1->>'queue', '') AS queue_filter,
           NULLIF($1->>'worker', '') AS worker_filter,
           NULLIF($1->>'taskType', '') AS type_filter,
           NULLIF($1->>'priority', '')::integer AS priority_filter,
           workhorse.dashboard_tag_filter_v1($1->'tags') AS tag_filter,
           NULLIF($1->>'search', '') AS search,
           CASE WHEN NULLIF($1->>'search', '') IS NULL THEN NULL ELSE
             '%' || replace(replace(replace(replace(
               $1->>'search', '!', '!!'), '%', '!%'), '_', '!_'), '*', '%') || '%'
           END AS search_filter,
           COALESCE(NULLIF($1->>'page', '')::integer, 1) AS page,
           COALESCE(NULLIF($1->>'pageSize', '')::integer, 50) AS page_size,
           COALESCE(NULLIF($1->>'sort', ''), 'updated') AS sort,
           COALESCE(NULLIF($1->>'count', ''), 'none') AS count_mode,
           COALESCE(($1->>'canCompleteHumanWait')::boolean, false)
             AS can_complete_human_wait
  ), __task_scope__task_rows AS (
    SELECT j.id, j.queue_name AS queue, j.task_type AS type, j.priority,
           COALESCE(r.state, o.state) AS state,
           COALESCE(r.current_attempt, o.current_attempt) AS attempt,
           j.tags, r.worker_id AS current_worker_id, r.wait_name,
           COALESCE(r.updated_at, o.updated_at, j.created_at) AS updated_at
      __scope_from__
      LEFT JOIN workhorse.dashboard_task_runtime_v1 r ON r.task_id = j.id
      LEFT JOIN workhorse.dashboard_task_outcome_v1 o ON o.task_id = j.id
  -- The statement names filtered two times in each request: in candidate_ids and in the
  -- exact-count branch of `total`, which the plan keeps also when the request asks for no count.
  -- Thus PostgreSQL materializes filtered for each request, and the limit of candidate_ids cannot
  -- reach the filter. A request with no tag, queue, or task type therefore reads each task. The
  -- SPA uses dashboard_tasks_cursor_v1, and the read time bound of each host ends a long read.
  ), filtered AS (
    SELECT task_rows.* FROM task_rows CROSS JOIN parameters
     WHERE CASE parameters.filter
       WHEN 'blocked' THEN task_rows.state = 'blocked'
       WHEN 'waiting' THEN EXISTS (
         SELECT 1 FROM workhorse.dashboard_signal_wait_v1 signal_wait
          WHERE signal_wait.task_id = task_rows.id
         UNION ALL
         SELECT 1 FROM workhorse.dashboard_human_wait_v1 human_wait
          WHERE human_wait.task_id = task_rows.id
       )
       WHEN 'scheduled' THEN task_rows.state = 'scheduled'
       WHEN 'retried' THEN task_rows.attempt > 1
       WHEN 'queued' THEN task_rows.state = 'ready'
       WHEN 'running' THEN task_rows.state = 'active'
       WHEN 'completed' THEN task_rows.state = 'succeeded'
       WHEN 'discarded' THEN task_rows.state = 'failed'
       WHEN 'canceled' THEN task_rows.state = 'canceled'
       ELSE true
     END
       AND (parameters.queue_filter IS NULL OR task_rows.queue = parameters.queue_filter)
       AND (parameters.worker_filter IS NULL OR COALESCE(
         task_rows.current_worker_id,
         (
           SELECT wait.worker_id FROM workhorse.dashboard_task_wait_v1 wait
            WHERE wait.task_id = task_rows.id AND wait.wait_name = task_rows.wait_name
         ),
         (
           SELECT history.worker_id FROM workhorse.dashboard_attempt_history_v1 history
            WHERE history.task_id = task_rows.id
            ORDER BY history.attempt DESC LIMIT 1
         )
       ) = parameters.worker_filter)
       AND (parameters.type_filter IS NULL OR task_rows.type = parameters.type_filter)
       AND (parameters.priority_filter IS NULL OR task_rows.priority = parameters.priority_filter)
       AND (cardinality(parameters.tag_filter) = 0 OR task_rows.tags && parameters.tag_filter)
       AND (parameters.search_filter IS NULL
            OR task_rows.type ILIKE parameters.search_filter ESCAPE '!'
            OR task_rows.queue ILIKE parameters.search_filter ESCAPE '!'
            OR task_rows.id::text ILIKE parameters.search_filter ESCAPE '!')
  -- Offset paging already reads every row up to the page, so counting those rows plus one costs
  -- nothing more and answers what a pager asks: the total when it is this small, and otherwise that
  -- one more page exists. The exact count over every matching task stays behind "count": "exact".
  ), candidate_ids AS MATERIALIZED (
    SELECT filtered.id, filtered.priority, filtered.updated_at, parameters.worker_filter
      FROM filtered CROSS JOIN parameters
     ORDER BY CASE WHEN parameters.sort = 'priority' THEN priority END DESC,
              updated_at DESC, id DESC
     LIMIT (SELECT page * page_size + 1 FROM parameters)
  ), page_ids AS MATERIALIZED (
    SELECT candidate_ids.* FROM candidate_ids CROSS JOIN parameters
     ORDER BY CASE WHEN parameters.sort = 'priority' THEN priority END DESC,
              updated_at DESC, id DESC
     LIMIT (SELECT page_size FROM parameters)
     OFFSET (SELECT (page - 1) * page_size FROM parameters)
  ), page AS (
    SELECT j.id, j.queue_name AS queue, j.task_type AS type, page_ids.priority,
           COALESCE(r.state, o.state) AS state,
           CASE WHEN r.state = 'blocked' THEN 'prerequisite_pending' END AS blocked_reason,
           COALESCE((
             SELECT jsonb_agg(dependency.prerequisite_task_id::text
                              ORDER BY dependency.prerequisite_task_id)
               FROM workhorse.dashboard_task_dependency_v1 dependency
              WHERE dependency.dependent_task_id = j.id AND dependency.released_at IS NULL
           ), '[]'::jsonb) AS prerequisite_task_ids,
           COALESCE(r.current_attempt, o.current_attempt) AS attempt,
           j.max_attempts, j.retry_policy, j.tags,
           COALESCE(r.run_at, o.run_at) AS run_at,
           r.worker_id AS current_worker_id,
           COALESCE(r.worker_id, durable_wait.worker_id, attempt_worker.worker_id) AS worker_id,
           o.finished_at, COALESCE(o.error, r.error) AS error, j.created_at,
           page_ids.updated_at,
           r.wait_name, r.cancel_requested_at, r.cancel_requested_by, r.cancel_reason,
           durable_wait.wake_at, durable_wait.mode AS wait_mode,
           signal_wait.deadline_at AS signal_wait_deadline_at,
           human_wait.token_name AS human_wait_name,
           human_wait.context AS human_wait_context,
           human_wait.deadline_at AS human_wait_deadline_at,
           enqueued_event.details AS enqueued_details
      FROM page_ids
      JOIN workhorse.dashboard_task_v1 j ON j.id = page_ids.id
      LEFT JOIN workhorse.dashboard_task_runtime_v1 r ON r.task_id = j.id
      LEFT JOIN workhorse.dashboard_task_outcome_v1 o ON o.task_id = j.id
      LEFT JOIN workhorse.dashboard_task_wait_v1 durable_wait
        ON durable_wait.task_id = j.id AND durable_wait.wait_name = r.wait_name
      LEFT JOIN workhorse.dashboard_signal_wait_v1 signal_wait
        ON signal_wait.task_id = j.id AND signal_wait.signal_name = r.wait_name
      LEFT JOIN workhorse.dashboard_human_wait_v1 human_wait
        ON human_wait.task_id = j.id AND human_wait.token_name = r.wait_name
      LEFT JOIN LATERAL (
        SELECT event.details FROM workhorse.dashboard_task_event_v1 event
         WHERE event.task_id = j.id AND event.event_type = 'enqueued'
           AND event.occurred_at >= j.created_at
           AND event.occurred_at <= statement_timestamp()
         ORDER BY event.occurred_at, event.event_id LIMIT 1
      ) enqueued_event ON true
      LEFT JOIN LATERAL (
        SELECT history.worker_id FROM workhorse.dashboard_attempt_history_v1 history
         WHERE history.task_id = j.id ORDER BY history.attempt DESC LIMIT 1
      ) attempt_worker ON page_ids.worker_filter IS NOT NULL
  )
  SELECT jsonb_build_object(
    'capturedAt', workhorse.dashboard_iso_v1(clock_timestamp()),
    'canCompleteHumanWait', parameters.can_complete_human_wait,
    'filter', parameters.filter,
    'queue', parameters.queue_filter,
    'worker', parameters.worker_filter,
    'taskType', parameters.type_filter,
    'priority', parameters.priority_filter,
    'sort', parameters.sort,
    'tags', to_jsonb(parameters.tag_filter),
    'search', parameters.search,
    'page', parameters.page,
    'pageSize', parameters.page_size,
    'count', parameters.count_mode,
    'hasMore', (SELECT count(*) FROM candidate_ids) > parameters.page * parameters.page_size,
    'total', CASE WHEN parameters.count_mode = 'exact' THEN (SELECT count(*) FROM filtered)
      ELSE (SELECT count(*) FROM candidate_ids) END,
    'tasks', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', id::text, 'queue', queue, 'type', type, 'priority', priority, 'state', state,
        'blockedReason', blocked_reason, 'prerequisiteTaskIds', prerequisite_task_ids,
        'attempt', attempt, 'maxAttempts', max_attempts, 'retryPolicy', retry_policy, 'tags', tags,
        'keyed', COALESCE(jsonb_typeof(enqueued_details->'idempotency') = 'object', false),
        'enqueueMode', CASE
          WHEN jsonb_typeof(enqueued_details->'debounce') = 'object' THEN 'debounce'
          WHEN jsonb_typeof(enqueued_details->'throttle') = 'object' THEN 'throttle'
          WHEN jsonb_typeof(enqueued_details->'idempotency') = 'object' THEN 'idempotency'
          ELSE NULL END,
        'cancellation', CASE WHEN cancel_requested_at IS NULL THEN NULL ELSE jsonb_build_object(
          'requestedAt', workhorse.dashboard_iso_v1(cancel_requested_at),
          'requestedBy', NULLIF(cancel_requested_by, ''),
          'reason', NULLIF(cancel_reason, '')) END,
        'runAt', workhorse.dashboard_iso_v1(run_at), 'workerId', current_worker_id,
        'lastWorkerId', worker_id, 'finishedAt', workhorse.dashboard_iso_v1(finished_at),
        'errorMessage', error->>'message', 'createdAt', workhorse.dashboard_iso_v1(created_at),
        'updatedAt', workhorse.dashboard_iso_v1(updated_at), 'durability', NULL,
        'waitName', wait_name, 'wakeAt', workhorse.dashboard_iso_v1(wake_at),
        'wait', CASE WHEN wait_name IS NOT NULL AND wake_at IS NOT NULL AND wait_mode IS NOT NULL
          THEN jsonb_build_object('name', wait_name,
                                  'wakeAt', workhorse.dashboard_iso_v1(wake_at),
                                  'mode', wait_mode) END,
        'signalWait', CASE WHEN wait_name IS NOT NULL AND signal_wait_deadline_at IS NOT NULL
          THEN jsonb_build_object('name', wait_name,
                                  'deadlineAt',
                                  workhorse.dashboard_iso_v1(signal_wait_deadline_at)) END,
        'humanWait', CASE WHEN human_wait_name IS NOT NULL AND human_wait_deadline_at IS NOT NULL
          THEN jsonb_build_object('name', human_wait_name,
                                  'quickAction',
                                  workhorse.dashboard_human_wait_quick_action_v1(human_wait_context),
                                  'deadlineAt',
                                  workhorse.dashboard_iso_v1(human_wait_deadline_at)) END
      ) ORDER BY CASE WHEN parameters.sort = 'priority' THEN priority END DESC,
                 updated_at DESC, id DESC)
        FROM page CROSS JOIN parameters
    ), '[]'::jsonb)
  ) FROM parameters;
$query$, '__task_scope__', v_scope), '__scope_from__', v_scope_from);
  EXECUTE v_query INTO v_result USING p_input;
  RETURN v_result;
END;
$$;

CREATE OR REPLACE FUNCTION workhorse.dashboard_events_v1(p_input jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SET jit = off
AS $$
DECLARE
  v_from timestamptz := NULLIF(p_input->>'rangeStart', '')::timestamptz;
  v_to timestamptz := NULLIF(p_input->>'rangeEnd', '')::timestamptz;
  v_captured_at timestamptz := clock_timestamp();
BEGIN
  IF (v_from IS NULL) <> (v_to IS NULL) THEN
    RAISE EXCEPTION 'rangeStart and rangeEnd must be supplied together' USING ERRCODE = '22023';
  END IF;
  IF v_from IS NOT NULL AND v_from >= v_to THEN
    RAISE EXCEPTION 'rangeEnd must be later than rangeStart' USING ERRCODE = '22023';
  END IF;

  IF v_from IS NULL THEN
    v_to := v_captured_at;
    v_from := v_captured_at - make_interval(secs => CASE
      COALESCE(NULLIF(p_input->>'window', ''), '1h')
      WHEN '15m' THEN 900 WHEN '1h' THEN 3600 WHEN '6h' THEN 21600
      WHEN '24h' THEN 86400
    END);
  END IF;

  RETURN (
    WITH parameters AS (
      SELECT v_captured_at AS captured_at, v_from AS range_start, v_to AS range_end,
             COALESCE(NULLIF(p_input->>'window', ''), '1h') AS window,
             round(extract(epoch FROM v_to - v_from)) AS window_seconds,
             COALESCE(NULLIF(p_input->>'page', '')::integer, 1) AS page,
             COALESCE(NULLIF(p_input->>'pageSize', '')::integer, 50) AS page_size,
             COALESCE(NULLIF(p_input->>'count', ''), 'none') AS count_mode,
             COALESCE(NULLIF(p_input->>'kind', ''), 'all') AS kind,
             NULLIF(p_input->>'queue', '') AS queue_filter,
             NULLIF(p_input->>'taskType', '') AS type_filter,
             NULLIF(p_input->>'worker', '') AS worker_filter,
             NULLIF(trim(p_input->>'search'), '') AS search_filter,
             CASE WHEN jsonb_typeof(p_input->'types') = 'array'
                  THEN ARRAY(SELECT jsonb_array_elements_text(p_input->'types'))
                  ELSE ARRAY[]::text[] END AS event_types,
             NULLIF(p_input->>'taskId', '')::uuid AS task_id,
             COALESCE((p_input->>'redactErrorStacks')::boolean, false) AS redact_error_stacks
    ), event_records AS NOT MATERIALIZED (
      SELECT event.*, COALESCE(event.details->>'worker_id', (
        SELECT history.worker_id FROM workhorse.dashboard_attempt_history_v1 history
         WHERE history.task_id = event.task_id AND history.attempt = event.attempt
         ORDER BY history.occurred_at DESC, history.attempt_id DESC LIMIT 1
      )) AS resolved_worker_id
        FROM workhorse.dashboard_task_event_v1 event
    ), event_feed AS (
      SELECT 'event'::text AS kind, event.event_id AS record_id, event.task_id,
             event.occurred_at, event.attempt, event.event_type AS type, event.details,
             event.resolved_worker_id AS worker_id, NULL::bigint AS fence_token,
             NULL::timestamptz AS started_at, NULL::timestamptz AS finished_at,
             NULL::jsonb AS error, 1 AS kind_rank
        FROM event_records event CROSS JOIN parameters
       WHERE parameters.kind <> 'attempt'
         AND event.occurred_at >= parameters.range_start
         AND event.occurred_at < parameters.range_end
         AND (parameters.task_id IS NULL OR event.task_id = parameters.task_id)
         AND (parameters.worker_filter IS NULL OR event.resolved_worker_id = parameters.worker_filter)
         AND (parameters.search_filter IS NULL
           OR strpos(lower(concat_ws(' ', event.task_id::text, event.event_type, event.resolved_worker_id, workhorse.dashboard_details_without_stack_v1(event.details, parameters.redact_error_stacks)::text)), lower(parameters.search_filter)) > 0
           OR EXISTS (SELECT 1 FROM workhorse.dashboard_task_v1 task WHERE task.id = event.task_id
             AND strpos(lower(concat_ws(' ', task.queue_name, task.task_type)), lower(parameters.search_filter)) > 0))
         AND (cardinality(parameters.event_types) = 0
              OR event.event_type = ANY (parameters.event_types))
         AND ((parameters.queue_filter IS NULL AND parameters.type_filter IS NULL) OR EXISTS (
           SELECT 1 FROM workhorse.dashboard_task_v1 task WHERE task.id = event.task_id
             AND (parameters.queue_filter IS NULL OR task.queue_name = parameters.queue_filter)
             AND (parameters.type_filter IS NULL OR task.task_type = parameters.type_filter)
         ))
       ORDER BY event.occurred_at DESC, event.event_id DESC
       LIMIT (SELECT page * page_size + 1 FROM parameters)
    ), attempt_feed AS (
      SELECT 'attempt'::text AS kind, history.attempt_id AS record_id, history.task_id,
             history.occurred_at, history.attempt, history.outcome AS type,
             NULL::jsonb AS details, history.worker_id, history.fence_token,
             history.started_at, history.finished_at, history.error, 0 AS kind_rank
        FROM workhorse.dashboard_attempt_history_v1 history CROSS JOIN parameters
       WHERE parameters.kind <> 'event'
         AND history.occurred_at >= parameters.range_start
         AND history.occurred_at < parameters.range_end
         AND (parameters.task_id IS NULL OR history.task_id = parameters.task_id)
         AND (parameters.worker_filter IS NULL OR history.worker_id = parameters.worker_filter)
         AND (parameters.search_filter IS NULL
           OR strpos(lower(concat_ws(' ', history.task_id::text, history.outcome, history.worker_id, history.error->>'message')), lower(parameters.search_filter)) > 0
           OR EXISTS (SELECT 1 FROM workhorse.dashboard_task_v1 task WHERE task.id = history.task_id
             AND strpos(lower(concat_ws(' ', task.queue_name, task.task_type)), lower(parameters.search_filter)) > 0))
         AND (cardinality(parameters.event_types) = 0
              OR history.outcome = ANY (parameters.event_types))
         AND ((parameters.queue_filter IS NULL AND parameters.type_filter IS NULL) OR EXISTS (
           SELECT 1 FROM workhorse.dashboard_task_v1 task WHERE task.id = history.task_id
             AND (parameters.queue_filter IS NULL OR task.queue_name = parameters.queue_filter)
             AND (parameters.type_filter IS NULL OR task.task_type = parameters.type_filter)
         ))
       ORDER BY history.occurred_at DESC, history.attempt_id DESC
       LIMIT (SELECT page * page_size + 1 FROM parameters)
    ), merged AS MATERIALIZED (
      SELECT * FROM event_feed UNION ALL SELECT * FROM attempt_feed
    -- Offset paging already merges every row up to the page, so counting those rows plus one costs
    -- nothing more and answers what a pager asks: the total when it is this small, and otherwise
    -- that one more page exists. The exact count over the window stays behind "count": "exact".
    ), candidates AS MATERIALIZED (
      SELECT merged.* FROM merged
       ORDER BY occurred_at DESC, kind_rank DESC, record_id DESC
       LIMIT (SELECT page * page_size + 1 FROM parameters)
    ), event_page AS MATERIALIZED (
      SELECT candidates.* FROM candidates
       ORDER BY occurred_at DESC, kind_rank DESC, record_id DESC
       LIMIT (SELECT page_size FROM parameters)
      OFFSET (SELECT (page - 1) * page_size FROM parameters)
    -- The exact count filters both source tables a second time. A one-time filter on the request's
    -- count mode keeps that second pass out of the plan for every request that did not ask for it.
    ), total AS (
      SELECT count(*) AS count FROM (
        SELECT event.event_id
          FROM event_records event CROSS JOIN parameters
         WHERE parameters.kind <> 'attempt'
           AND event.occurred_at >= parameters.range_start
           AND event.occurred_at < parameters.range_end
           AND (parameters.task_id IS NULL OR event.task_id = parameters.task_id)
           AND (parameters.worker_filter IS NULL OR event.resolved_worker_id = parameters.worker_filter)
           AND (parameters.search_filter IS NULL
             OR strpos(lower(concat_ws(' ', event.task_id::text, event.event_type, event.resolved_worker_id, workhorse.dashboard_details_without_stack_v1(event.details, parameters.redact_error_stacks)::text)), lower(parameters.search_filter)) > 0
             OR EXISTS (SELECT 1 FROM workhorse.dashboard_task_v1 task WHERE task.id = event.task_id
               AND strpos(lower(concat_ws(' ', task.queue_name, task.task_type)), lower(parameters.search_filter)) > 0))
           AND (cardinality(parameters.event_types) = 0
                OR event.event_type = ANY (parameters.event_types))
           AND ((parameters.queue_filter IS NULL AND parameters.type_filter IS NULL) OR EXISTS (
             SELECT 1 FROM workhorse.dashboard_task_v1 task WHERE task.id = event.task_id
               AND (parameters.queue_filter IS NULL OR task.queue_name = parameters.queue_filter)
               AND (parameters.type_filter IS NULL OR task.task_type = parameters.type_filter)
           ))
        UNION ALL
        SELECT history.attempt_id
          FROM workhorse.dashboard_attempt_history_v1 history CROSS JOIN parameters
         WHERE parameters.kind <> 'event'
           AND history.occurred_at >= parameters.range_start
           AND history.occurred_at < parameters.range_end
           AND (parameters.task_id IS NULL OR history.task_id = parameters.task_id)
           AND (parameters.worker_filter IS NULL OR history.worker_id = parameters.worker_filter)
           AND (parameters.search_filter IS NULL
             OR strpos(lower(concat_ws(' ', history.task_id::text, history.outcome, history.worker_id, history.error->>'message')), lower(parameters.search_filter)) > 0
             OR EXISTS (SELECT 1 FROM workhorse.dashboard_task_v1 task WHERE task.id = history.task_id
               AND strpos(lower(concat_ws(' ', task.queue_name, task.task_type)), lower(parameters.search_filter)) > 0))
           AND (cardinality(parameters.event_types) = 0
                OR history.outcome = ANY (parameters.event_types))
           AND ((parameters.queue_filter IS NULL AND parameters.type_filter IS NULL) OR EXISTS (
             SELECT 1 FROM workhorse.dashboard_task_v1 task WHERE task.id = history.task_id
               AND (parameters.queue_filter IS NULL OR task.queue_name = parameters.queue_filter)
               AND (parameters.type_filter IS NULL OR task.task_type = parameters.type_filter)
           ))
      ) records
       WHERE (SELECT count_mode FROM parameters) = 'exact'
    )
    SELECT jsonb_build_object(
      'capturedAt', workhorse.dashboard_iso_v1(parameters.captured_at),
      'window', parameters.window, 'windowSeconds', parameters.window_seconds,
      'rangeStart', workhorse.dashboard_iso_v1(parameters.range_start),
      'rangeEnd', workhorse.dashboard_iso_v1(parameters.range_end),
      'page', parameters.page, 'pageSize', parameters.page_size,
      'count', parameters.count_mode,
      'hasMore', (SELECT count(*) FROM candidates) > parameters.page * parameters.page_size,
      'total', CASE WHEN parameters.count_mode = 'exact' THEN (SELECT count FROM total)
        ELSE (SELECT count(*) FROM candidates) END,
      'retention', jsonb_build_object(
        'taskEventDays', retention.task_event_retention_days,
        'attemptHistoryDays', retention.attempt_history_retention_days),
      'events', COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'id', event_page.kind || ':' || event_page.record_id::text,
          'kind', event_page.kind, 'recordId', event_page.record_id::text,
          'taskId', event_page.task_id::text, 'queue', task.queue_name,
          'taskType', task.task_type,
          'occurredAt', workhorse.dashboard_iso_v1(event_page.occurred_at),
          'attempt', event_page.attempt, 'type', event_page.type,
          'details', workhorse.dashboard_details_without_stack_v1(
            event_page.details, parameters.redact_error_stacks),
          'workerId', event_page.worker_id,
          'fenceToken', event_page.fence_token::text,
          'durationMs', CASE WHEN event_page.started_at IS NULL
                                  OR event_page.finished_at IS NULL THEN NULL
                             ELSE round(extract(epoch FROM event_page.finished_at
                                                          - event_page.started_at) * 1000) END,
          'errorMessage', event_page.error->>'message')
          ORDER BY event_page.occurred_at DESC, event_page.kind_rank DESC,
                   event_page.record_id DESC)
          FROM event_page
          LEFT JOIN workhorse.dashboard_task_v1 task ON task.id = event_page.task_id
      ), '[]'::jsonb))
      FROM parameters CROSS JOIN workhorse.dashboard_retention_policy_v1 retention
     WHERE retention.singleton
  );
END;
$$;

CREATE OR REPLACE FUNCTION workhorse.dashboard_event_detail_v1(p_input jsonb)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_identity text := p_input->>'id';
  v_redact boolean := COALESCE((p_input->>'redactErrorStacks')::boolean, false);
  v_kind text;
  v_record_id uuid;
  v_result jsonb;
BEGIN
  -- A recorded event or attempt has a version 7 UUID. A record that dashboard_task_event_v1 or
  -- dashboard_attempt_history_v1 derives for a fast-tier task has an MD5 value cast to uuid, which
  -- can have any version and variant digits. Thus the check accepts any UUID in canonical form, and
  -- the lookup below reads each fast-tier row to find a derived record.
  IF v_identity IS NULL OR v_identity !~* '^(event|attempt):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RETURN NULL;
  END IF;
  v_kind := split_part(v_identity, ':', 1);
  v_record_id := split_part(v_identity, ':', 2)::uuid;

  IF v_kind = 'event' THEN
    SELECT jsonb_build_object(
      'id', 'event:' || event.event_id::text, 'kind', 'event',
      'recordId', event.event_id::text, 'taskId', event.task_id::text,
      'queue', task.queue_name, 'taskType', task.task_type,
      'occurredAt', workhorse.dashboard_iso_v1(event.occurred_at),
      'attempt', event.attempt, 'type', event.event_type,
      'details', workhorse.dashboard_details_without_stack_v1(event.details, v_redact),
      'workerId', COALESCE(event.details->>'worker_id', (
        SELECT history.worker_id FROM workhorse.dashboard_attempt_history_v1 history
         WHERE history.task_id = event.task_id AND history.attempt = event.attempt
         ORDER BY history.occurred_at DESC, history.attempt_id DESC LIMIT 1
      )), 'fenceToken', NULL, 'startedAt', NULL, 'claimedAt', NULL,
      'finishedAt', NULL, 'durationMs', NULL, 'error', NULL, 'errorMessage', NULL)
      INTO v_result
      FROM workhorse.dashboard_task_event_v1 event
      LEFT JOIN workhorse.dashboard_task_v1 task ON task.id = event.task_id
     WHERE event.event_id = v_record_id;
  ELSE
    SELECT jsonb_build_object(
      'id', 'attempt:' || history.attempt_id::text, 'kind', 'attempt',
      'recordId', history.attempt_id::text, 'taskId', history.task_id::text,
      'queue', task.queue_name, 'taskType', task.task_type,
      'occurredAt', workhorse.dashboard_iso_v1(history.occurred_at),
      'attempt', history.attempt, 'type', history.outcome, 'details', NULL,
      'workerId', history.worker_id, 'fenceToken', history.fence_token::text,
      'startedAt', workhorse.dashboard_iso_v1(history.started_at),
      'claimedAt', workhorse.dashboard_iso_v1(history.claimed_at),
      'finishedAt', workhorse.dashboard_iso_v1(history.finished_at),
      'durationMs', round(extract(epoch FROM history.finished_at - history.started_at) * 1000),
      'error', workhorse.dashboard_error_without_stack_v1(history.error, v_redact),
      'errorMessage', history.error->>'message')
      INTO v_result
      FROM workhorse.dashboard_attempt_history_v1 history
      LEFT JOIN workhorse.dashboard_task_v1 task ON task.id = history.task_id
     WHERE history.attempt_id = v_record_id;
  END IF;

  RETURN v_result;
END;
$$;

CREATE OR REPLACE FUNCTION workhorse.dashboard_task_detail_v1(p_input jsonb)
RETURNS jsonb
LANGUAGE sql
SET jit = off
AS $$
  WITH parameters AS (
    SELECT (p_input->>'id')::uuid AS task_id,
           COALESCE((p_input->>'canSignal')::boolean, false) AS can_signal,
           COALESCE((p_input->>'redactErrorStacks')::boolean, false) AS redact
  ), task AS (
    SELECT j.id, j.queue_name AS queue, j.task_type AS type, j.priority, j.payload,
           j.max_attempts, j.retry_policy, j.deadline_at, j.execution_timeout_ms,
           j.concurrency_key, j.created_at, j.tags,
           runtime.state AS runtime_state, runtime.current_attempt AS runtime_attempt,
           runtime.run_at, runtime.ready_at, runtime.worker_id,
           runtime.fence_token::text AS fence_token, runtime.acquired_at,
           runtime.heartbeat_at, runtime.expires_at, runtime.wait_name,
           runtime.attempt_started_at, runtime.attempt_timeout_at,
           runtime.cancel_requested_at, runtime.cancel_requested_by, runtime.cancel_reason,
           runtime.error AS runtime_error,
           outcome.state AS outcome_state, outcome.current_attempt AS outcome_attempt,
           outcome.finished_at, workhorse.dashboard_task_result_v1(j.id) AS result,
           outcome.error AS outcome_error,
           progress.progress_value, progress.revision::text AS progress_revision,
           progress.attempt AS progress_attempt,
           progress.fence_token::text AS progress_fence_token,
           progress.worker_id AS progress_worker_id,
           progress.created_at AS progress_created_at,
           progress.updated_at AS progress_updated_at,
           signal_wait.deadline_at AS signal_wait_deadline_at
      FROM parameters
      JOIN workhorse.dashboard_task_v1 j ON j.id = parameters.task_id
      LEFT JOIN workhorse.dashboard_task_runtime_v1 runtime ON runtime.task_id = j.id
      LEFT JOIN workhorse.dashboard_task_outcome_v1 outcome ON outcome.task_id = j.id
      LEFT JOIN workhorse.dashboard_task_progress_v1 progress ON progress.task_id = j.id
      LEFT JOIN workhorse.dashboard_signal_wait_v1 signal_wait
        ON signal_wait.task_id = j.id AND signal_wait.signal_name = runtime.wait_name
     LIMIT 1
  ), task_values AS (
    -- The payload and the result are measured once here, because both the outcome and the document
    -- below decide on the same two sizes and re-measuring a megabyte twice is the cost this bound
    -- exists to avoid. A task with neither measures zero, which reads as present and empty.
    SELECT COALESCE(octet_length(task.payload::text), 0) AS payload_bytes,
           COALESCE(octet_length(task.result::text), 0) AS result_bytes,
           workhorse.dashboard_inline_value_bytes_v1() AS inline_bytes
      FROM task
  ), identity AS (
    SELECT jsonb_build_object(
      'id', task.id::text, 'queue', task.queue, 'type', task.type, 'priority', task.priority,
      'state', COALESCE(task.outcome_state, task.runtime_state, 'unknown'),
      'createdAt', workhorse.dashboard_iso_v1(task.created_at),
      'retryPolicy', task.retry_policy, 'maxAttempts', task.max_attempts,
      'deadlineAt', workhorse.dashboard_iso_v1(task.deadline_at),
      'executionTimeoutMs', task.execution_timeout_ms,
      'concurrencyKey', task.concurrency_key,
      'prerequisiteTaskId', CASE WHEN count(dependency.*) = 1
        THEN (array_agg(dependency.prerequisite_task_id))[1]::text END,
      'prerequisiteTaskIds', COALESCE(jsonb_agg(dependency.prerequisite_task_id::text
        ORDER BY dependency.prerequisite_task_id)
        FILTER (WHERE dependency.prerequisite_task_id IS NOT NULL), '[]'::jsonb),
      'dependencyPolicy', CASE WHEN count(dependency.*) > 0 THEN jsonb_build_object(
        'onSuccess', min(dependency.on_success),
        'onFailure', min(dependency.on_failure),
        'onCancellation', min(dependency.on_cancellation)) END,
      'dependencyReleasedAt', CASE WHEN bool_and(dependency.released_at IS NOT NULL)
        THEN workhorse.dashboard_iso_v1(max(dependency.released_at)) END,
      'blockedReason', CASE WHEN task.runtime_state = 'blocked' AND count(dependency.*) > 0
        THEN 'prerequisite_pending' END
    ) AS value
      FROM task
      LEFT JOIN workhorse.dashboard_task_dependency_v1 dependency
        ON dependency.dependent_task_id = task.id
     GROUP BY task.id, task.queue, task.type, task.priority, task.outcome_state, task.runtime_state,
              task.created_at, task.retry_policy, task.max_attempts, task.deadline_at,
              task.execution_timeout_ms, task.concurrency_key
  ), dependency_lineage AS (
    SELECT jsonb_build_object(
      'records', COALESCE(jsonb_agg(jsonb_build_object(
        'dependentTaskId', dependent_task_id::text,
        'prerequisiteTaskId', prerequisite_task_id::text,
        'onSuccess', on_success, 'onFailure', on_failure,
        'onCancellation', on_cancellation,
        'createdAt', workhorse.dashboard_iso_v1(created_at),
        'releasedAt', workhorse.dashboard_iso_v1(released_at), 'resolution', resolution
      ) ORDER BY dependent_task_id, prerequisite_task_id) FILTER (WHERE ordinal <= 100),
        '[]'::jsonb),
      'truncated', count(*) > 100
    ) AS value
      FROM (
        SELECT dependency.*, row_number() OVER (
          ORDER BY dependent_task_id, prerequisite_task_id) AS ordinal
          FROM parameters
          JOIN workhorse.dashboard_task_dependency_v1 dependency
            ON dependency.dependent_task_id = parameters.task_id
            OR dependency.prerequisite_task_id = parameters.task_id
         ORDER BY dependent_task_id, prerequisite_task_id LIMIT 101
      ) bounded
  ), child_lineage AS (
    SELECT jsonb_build_object(
      'records', COALESCE(jsonb_agg(jsonb_build_object(
        'parentTaskId', parent_task_id::text, 'childTaskId', child_task_id::text,
        'name', child_name, 'type', child_type,
        'createdAt', workhorse.dashboard_iso_v1(created_at),
        'joinedAt', workhorse.dashboard_iso_v1(joined_at),
        'outcomeState', outcome_state,
        'error', workhorse.dashboard_error_without_stack_v1(outcome_error, redact)
      ) ORDER BY created_at, parent_task_id, child_task_id) FILTER (WHERE ordinal <= 101),
        '[]'::jsonb),
      'truncated', count(*) > 101
    ) AS value
      FROM (
        SELECT edge.*, child.task_type AS child_type, outcome.state AS outcome_state,
               outcome.error AS outcome_error, parameters.redact,
               row_number() OVER (ORDER BY edge.created_at, edge.parent_task_id,
                                            edge.child_task_id) AS ordinal
          FROM parameters
          JOIN workhorse.dashboard_task_child_v1 edge
            ON edge.parent_task_id = parameters.task_id OR edge.child_task_id = parameters.task_id
          JOIN workhorse.dashboard_task_v1 child ON child.id = edge.child_task_id
          LEFT JOIN workhorse.dashboard_task_outcome_v1 outcome ON outcome.task_id = edge.child_task_id
         ORDER BY edge.created_at, edge.parent_task_id, edge.child_task_id LIMIT 102
      ) bounded
  ), redrive_lineage AS (
    SELECT jsonb_build_object(
      'records', COALESCE(jsonb_agg(jsonb_build_object(
        'sourceTaskId', source_task_id::text, 'targetTaskId', target_task_id::text,
        'requestedBy', requested_by, 'reason', reason,
        'requestIdPreview', request_id_preview, 'requestIdDigest', request_id_digest,
        'requestIdLength', request_id_length, 'sourceState', source_state,
        'targetInitialState', target_initial_state,
        'requestedAt', workhorse.dashboard_iso_v1(requested_at)
      ) ORDER BY ordinal) FILTER (WHERE ordinal <= 100), '[]'::jsonb),
      'truncated', count(*) > 100
    ) AS value
      FROM (
        SELECT lineage.*
          FROM parameters
          CROSS JOIN LATERAL workhorse.redrive_lineage_v1(parameters.task_id, 101)
            WITH ORDINALITY AS lineage(
              source_task_id, target_task_id, requested_by, reason, request_id_preview,
              request_id_digest, request_id_length, source_state, target_initial_state,
              requested_at, ordinal
            )
      ) bounded
  ), concurrency_policy AS (
    SELECT CASE WHEN policy.queue_name IS NULL THEN NULL ELSE jsonb_build_object(
      'namespace', policy.namespace, 'maxActive', policy.max_active,
      'utilizationKnown', measured.value IS NOT NULL,
      'active', COALESCE((measured.value->>'active')::integer, 0),
      'available', COALESCE(GREATEST(0, policy.max_active -
        (measured.value->>'active')::integer), 0),
      'blockedReady', COALESCE((measured.value->>'blocked_ready')::integer, 0),
      'maxActivePerKey', policy.max_active_per_key,
      'saturatedKeys', COALESCE((measured.value->>'saturated_keys')::integer, 0),
      'highestKeyActive', COALESCE((measured.value->>'highest_key_active')::integer, 0)
    ) END AS value
      FROM task
      LEFT JOIN workhorse.dashboard_concurrency_policy_v1 policy
        ON policy.queue_name = task.queue
      LEFT JOIN LATERAL (
        SELECT item AS value
          FROM jsonb_array_elements(CASE WHEN task.runtime_state IS NULL THEN '[]'::jsonb
            ELSE COALESCE(p_input->'health', workhorse.queue_health_v1())->'concurrency_policies'
            END) item
         WHERE item->>'queue_name' = task.queue
      ) measured ON true
  ), signal_wait AS (
    SELECT CASE WHEN wait_name IS NOT NULL AND signal_wait_deadline_at IS NOT NULL
      THEN jsonb_build_object('name', wait_name, 'deadlineAt',
        workhorse.dashboard_iso_v1(signal_wait_deadline_at)) END AS value FROM task
  ), progress AS (
    SELECT CASE WHEN progress_revision IS NOT NULL THEN jsonb_build_object(
      'value', progress_value, 'revision', progress_revision, 'attempt', progress_attempt,
      'fenceToken', progress_fence_token, 'workerId', progress_worker_id,
      'createdAt', workhorse.dashboard_iso_v1(progress_created_at),
      'updatedAt', workhorse.dashboard_iso_v1(progress_updated_at)) END AS value FROM task
  ), current_state AS (
    SELECT jsonb_build_object(
      'runtime', CASE WHEN runtime_state IS NOT NULL THEN jsonb_build_object(
        'state', runtime_state, 'attempt', runtime_attempt,
        'runAt', workhorse.dashboard_iso_v1(run_at),
        'readyAt', workhorse.dashboard_iso_v1(ready_at), 'workerId', worker_id,
        'fenceToken', fence_token, 'acquiredAt', workhorse.dashboard_iso_v1(acquired_at),
        'heartbeatAt', workhorse.dashboard_iso_v1(heartbeat_at),
        'expiresAt', workhorse.dashboard_iso_v1(expires_at), 'waitName', wait_name,
        'attemptStartedAt', workhorse.dashboard_iso_v1(attempt_started_at),
        'attemptTimeoutAt', workhorse.dashboard_iso_v1(attempt_timeout_at),
        'cancellation', CASE WHEN cancel_requested_at IS NOT NULL THEN jsonb_build_object(
          'requestedAt', workhorse.dashboard_iso_v1(cancel_requested_at),
          'requestedBy', NULLIF(cancel_requested_by, ''),
          'reason', NULLIF(cancel_reason, '')) END,
        'error', workhorse.dashboard_error_without_stack_v1(runtime_error, parameters.redact)) END,
      'outcome', CASE WHEN outcome_state IS NOT NULL THEN jsonb_build_object(
        'state', outcome_state, 'attempt', outcome_attempt,
        'finishedAt', workhorse.dashboard_iso_v1(finished_at),
        -- A result larger than the inline bound is reported by size alone, exactly as a checkpoint
        -- value is. `dashboard_task_value_v1` returns the one an operator opens.
        'result', CASE WHEN task_values.result_bytes <= task_values.inline_bytes THEN result END,
        'resultBytes', task_values.result_bytes,
        'resultOmitted', task_values.result_bytes > task_values.inline_bytes,
        'error', workhorse.dashboard_error_without_stack_v1(outcome_error, parameters.redact)) END,
      -- The result appears under the outcome alone. A result exists only once a task finishes, so
      -- a second copy beside it doubled what a megabyte result costs to open and named no new fact.
      'error', workhorse.dashboard_error_without_stack_v1(
        COALESCE(outcome_error, runtime_error), parameters.redact)
    ) AS value FROM task CROSS JOIN task_values CROSS JOIN parameters
  ), batch_executions AS (
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'id', batch_id, 'attempt', selected_attempt,
      'dispatchedAt', workhorse.dashboard_iso_v1(dispatched_at),
      'batchWideFailure', batch_wide_failure, 'members', members
    ) ORDER BY dispatched_at, batch_id), '[]'::jsonb) AS value
      FROM (
        SELECT batch_id, selected_attempt, dispatched_at, batch_wide_failure,
               jsonb_agg(jsonb_build_object(
                 'id', member_task_id, 'type', task_type, 'attempt', attempt,
                 'outcome', outcome,
                 'error', workhorse.dashboard_error_without_stack_v1(error, redact))
                 ORDER BY ordinal) AS members
          FROM (
            SELECT dispatch.details->>'batch_id' AS batch_id,
                   dispatch.attempt AS selected_attempt,
                   dispatch.occurred_at AS dispatched_at,
                   EXISTS (
                     SELECT 1 FROM workhorse.dashboard_task_event_v1 failure
                      WHERE failure.task_id = dispatch.task_id
                        AND failure.attempt = dispatch.attempt
                        AND failure.event_type = 'batch_failed'
                        AND failure.details->>'batch_id' = dispatch.details->>'batch_id'
                   ) AS batch_wide_failure,
                   member.ordinal, member.value->>'task_id' AS member_task_id,
                   COALESCE(member_task.task_type, selected_task.task_type) AS task_type,
                   (member.value->>'attempt')::integer AS attempt,
                   history.outcome, history.error, parameters.redact
              FROM parameters
              JOIN workhorse.dashboard_task_event_v1 dispatch
                ON dispatch.task_id = parameters.task_id AND dispatch.event_type = 'batch_dispatched'
              CROSS JOIN LATERAL jsonb_array_elements(dispatch.details->'members')
                WITH ORDINALITY AS member(value, ordinal)
              JOIN workhorse.dashboard_task_v1 selected_task ON selected_task.id = dispatch.task_id
              LEFT JOIN workhorse.dashboard_task_v1 member_task
                ON member_task.id = (member.value->>'task_id')::uuid
              LEFT JOIN workhorse.dashboard_attempt_history_v1 history
                ON history.task_id = (member.value->>'task_id')::uuid
               AND history.attempt = (member.value->>'attempt')::integer
          ) batch_rows
         GROUP BY batch_id, selected_attempt, dispatched_at, batch_wide_failure, redact
      ) executions
  -- Each history section keeps its most recent rows and reports that it was cut. A task that
  -- retried for days would otherwise put its whole recorded life into one drawer, and the event
  -- feed filtered by this task identity is where the rest of it stays readable.
  ), attempts AS (
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'attempt', attempt, 'workerId', worker_id, 'outcome', outcome,
      'startedAt', workhorse.dashboard_iso_v1(started_at),
      'claimedAt', workhorse.dashboard_iso_v1(claimed_at),
      'finishedAt', workhorse.dashboard_iso_v1(finished_at),
      'durationMs', extract(epoch FROM finished_at - claimed_at) * 1000,
      'executionMs', extract(epoch FROM finished_at - claimed_at) * 1000,
      'elapsedMs', extract(epoch FROM finished_at - started_at) * 1000,
      'error', workhorse.dashboard_error_without_stack_v1(error, redact))
      ORDER BY attempt, attempt_id)
      FILTER (WHERE ordinal <= workhorse.dashboard_task_detail_limit_v1()), '[]'::jsonb) AS value,
      count(*) > workhorse.dashboard_task_detail_limit_v1() AS truncated
      FROM (
        SELECT recent.*, row_number() OVER (ORDER BY recent.attempt DESC, recent.attempt_id DESC)
                 AS ordinal
          FROM (
            SELECT history.*, parameters.redact FROM parameters
              JOIN workhorse.dashboard_attempt_history_v1 history
                ON history.task_id = parameters.task_id
             ORDER BY history.attempt DESC, history.attempt_id DESC
             LIMIT workhorse.dashboard_task_detail_limit_v1() + 1
          ) recent
      ) bounded
  ), checkpoints AS (
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'name', checkpoint_name,
      'value', CASE WHEN value_bytes <= workhorse.dashboard_inline_value_bytes_v1()
                    THEN checkpoint_value END,
      'valueBytes', value_bytes,
      'valueOmitted', value_bytes > workhorse.dashboard_inline_value_bytes_v1(),
      'attempt', attempt,
      'fenceToken', fence_token::text, 'workerId', worker_id,
      'createdAt', workhorse.dashboard_iso_v1(created_at)
    ) ORDER BY created_at, checkpoint_name)
      FILTER (WHERE ordinal <= workhorse.dashboard_task_detail_limit_v1()), '[]'::jsonb) AS value,
      count(*) > workhorse.dashboard_task_detail_limit_v1() AS truncated
      FROM (
        SELECT recent.*,
               row_number() OVER (ORDER BY recent.created_at DESC, recent.checkpoint_name DESC)
                 AS ordinal
          FROM (
            SELECT checkpoint.*,
                   octet_length(checkpoint.checkpoint_value::text) AS value_bytes
              FROM parameters
              JOIN workhorse.dashboard_task_checkpoint_v1 checkpoint
                ON checkpoint.task_id = parameters.task_id
             ORDER BY checkpoint.created_at DESC, checkpoint.checkpoint_name DESC
             LIMIT workhorse.dashboard_task_detail_limit_v1() + 1
          ) recent
      ) bounded
  ), waits AS (
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'name', wait_name, 'mode', mode, 'durationMs', duration_ms,
      'requestedWakeAt', workhorse.dashboard_iso_v1(requested_wake_at),
      'wakeAt', workhorse.dashboard_iso_v1(wake_at), 'attempt', attempt,
      'fenceToken', fence_token::text, 'workerId', worker_id,
      'createdAt', workhorse.dashboard_iso_v1(created_at)
    ) ORDER BY created_at, wait_name)
      FILTER (WHERE ordinal <= workhorse.dashboard_task_detail_limit_v1()), '[]'::jsonb) AS value,
      count(*) > workhorse.dashboard_task_detail_limit_v1() AS truncated
      FROM (
        SELECT recent.*,
               row_number() OVER (ORDER BY recent.created_at DESC, recent.wait_name DESC) AS ordinal
          FROM (
            SELECT wait_record.* FROM parameters
              JOIN workhorse.dashboard_task_wait_v1 wait_record
                ON wait_record.task_id = parameters.task_id
             ORDER BY wait_record.created_at DESC, wait_record.wait_name DESC
             LIMIT workhorse.dashboard_task_detail_limit_v1() + 1
          ) recent
      ) bounded
  ), events AS (
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'id', event_id::text, 'attempt', attempt, 'type', event_type,
      'details', workhorse.dashboard_details_without_stack_v1(details, redact),
      'occurredAt', workhorse.dashboard_iso_v1(occurred_at)
    ) ORDER BY occurred_at, event_id)
      FILTER (WHERE ordinal <= workhorse.dashboard_task_event_limit_v1()), '[]'::jsonb) AS value,
      count(*) > workhorse.dashboard_task_event_limit_v1() AS truncated
      FROM (
        SELECT recent.*,
               row_number() OVER (ORDER BY recent.occurred_at DESC, recent.event_id DESC) AS ordinal
          FROM (
            SELECT event_record.*, parameters.redact FROM parameters
              JOIN workhorse.dashboard_task_event_v1 event_record
                ON event_record.task_id = parameters.task_id
             ORDER BY event_record.occurred_at DESC, event_record.event_id DESC
             LIMIT workhorse.dashboard_task_event_limit_v1() + 1
          ) recent
      ) bounded
  )
  SELECT jsonb_build_object(
    'tags', task.tags,
    'canCompleteHumanWait', COALESCE((p_input->>'canCompleteHumanWait')::boolean, false),
    'humanWait', (SELECT jsonb_build_object(
      'name', wait.token_name, 'context', wait.context,
      'deadlineAt', workhorse.dashboard_iso_v1(wait.deadline_at))
      FROM workhorse.dashboard_human_wait_v1 wait WHERE wait.task_id = task.id),
    -- A task is a member of one group at most, so the member row is the one group of the task.
    'group', (SELECT jsonb_build_object(
      'id', task_group.id::text, 'position', member.position, 'state', task_group.state)
      FROM workhorse.task_group_member member
      JOIN workhorse.task_group task_group ON task_group.id = member.group_id
     WHERE member.task_id = task.id),
    'identity', identity.value,
    'dependencyLineage', dependency_lineage.value,
    'childLineage', child_lineage.value,
    'redriveLineage', redrive_lineage.value,
    'concurrencyPolicy', concurrency_policy.value,
    'signalWait', signal_wait.value,
    'canSignal', parameters.can_signal,
    'payload', CASE WHEN task_values.payload_bytes <= task_values.inline_bytes
                    THEN task.payload END,
    'payloadBytes', task_values.payload_bytes,
    'payloadOmitted', task_values.payload_bytes > task_values.inline_bytes,
    'progress', progress.value,
    'durability', NULL,
    'current', current_state.value,
    'batchExecutions', batch_executions.value,
    'attempts', attempts.value,
    'checkpoints', checkpoints.value,
    'waits', waits.value,
    'events', events.value,
    'truncated', jsonb_build_object(
      'attempts', attempts.truncated, 'checkpoints', checkpoints.truncated,
      'waits', waits.truncated, 'events', events.truncated)
  )
    FROM parameters
    JOIN task ON true
    JOIN task_values ON true
    JOIN identity ON true
    JOIN dependency_lineage ON true
    JOIN child_lineage ON true
    JOIN redrive_lineage ON true
    JOIN concurrency_policy ON true
    JOIN signal_wait ON true
    JOIN progress ON true
    JOIN current_state ON true
    JOIN batch_executions ON true
    JOIN attempts ON true
    JOIN checkpoints ON true
    JOIN waits ON true
    JOIN events ON true;
$$;

CREATE OR REPLACE FUNCTION workhorse.dashboard_settings_v1(p_input jsonb)
RETURNS jsonb
LANGUAGE sql
SET jit = off
AS $$
  WITH maintenance AS (
    SELECT * FROM workhorse.get_maintenance_policy_v1()
  ), retention AS (
    SELECT * FROM workhorse.get_retention_policy_v1()
  ), provenance_fields AS (
    SELECT field.*
      FROM maintenance CROSS JOIN retention CROSS JOIN LATERAL (VALUES
        ('maintenance', 'timezone', 'timezone',
          to_jsonb(maintenance.application_timezone)),
        ('maintenance', 'partitionPreparationIntervalMs',
          'partition_preparation_interval_ms',
          to_jsonb(maintenance.application_partition_preparation_interval_ms)),
        ('maintenance', 'terminalCleanupIntervalMs', 'terminal_cleanup_interval_ms',
          to_jsonb(maintenance.application_terminal_cleanup_interval_ms)),
        ('maintenance', 'historyRetentionLocalTime', 'history_retention_local_time',
          to_jsonb(to_char(maintenance.application_history_retention_local_time, 'HH24:MI'))),
        ('maintenance', 'statisticsRollupIntervalMs', 'statistics_rollup_interval_ms',
          to_jsonb(maintenance.application_statistics_rollup_interval_ms)),
        ('maintenance', 'statisticsGroupLimit', 'statistics_group_limit',
          to_jsonb(maintenance.application_statistics_group_limit)),
        ('maintenance', 'statisticsRecomputeBuckets', 'statistics_recompute_buckets',
          to_jsonb(maintenance.application_statistics_recompute_buckets)),
        ('retention', 'taskIdentityRetentionDays', 'task_identity_retention_days',
          to_jsonb(retention.application_task_identity_retention_days)),
        ('retention', 'terminalOutcomeRetentionDays', 'terminal_outcome_retention_days',
          to_jsonb(retention.application_terminal_outcome_retention_days)),
        ('retention', 'taskEventRetentionDays', 'task_event_retention_days',
          to_jsonb(retention.application_task_event_retention_days)),
        ('retention', 'attemptHistoryRetentionDays', 'attempt_history_retention_days',
          to_jsonb(retention.application_attempt_history_retention_days)),
        ('retention', 'scheduleOccurrenceRetentionDays', 'schedule_occurrence_retention_days',
          to_jsonb(retention.application_schedule_occurrence_retention_days)),
        ('retention', 'statisticsRetentionDays', 'statistics_retention_days',
          to_jsonb(retention.application_statistics_retention_days)),
        ('retention', 'terminalTaskPruneLimit', 'terminal_task_prune_limit',
          to_jsonb(retention.application_terminal_task_prune_limit)),
        ('retention', 'historyPartitionsPerPass', 'history_partitions_per_pass',
          to_jsonb(retention.application_history_partitions_per_pass)),
        ('retention', 'defaultPartitionRowsPerPass', 'default_partition_rows_per_pass',
          to_jsonb(retention.application_default_partition_rows_per_pass)),
        ('retention', 'occurrenceRowsPerPass', 'occurrence_rows_per_pass',
          to_jsonb(retention.application_occurrence_rows_per_pass)),
        ('retention', 'statisticsRowsPerPass', 'statistics_rows_per_pass',
          to_jsonb(retention.application_statistics_rows_per_pass))
      ) field(policy, wire_name, column_name, application_default)
  ), field_sources AS (
    SELECT fields.*,
           CASE WHEN fields.column_name = ANY(
             CASE fields.policy WHEN 'maintenance' THEN maintenance.operator_overrides
                                ELSE retention.operator_overrides END
           ) THEN 'operator' ELSE 'application' END AS source,
           CASE fields.policy WHEN 'maintenance' THEN maintenance.operator_audit
                              ELSE retention.operator_audit END -> fields.column_name AS audit
      FROM provenance_fields fields CROSS JOIN maintenance CROSS JOIN retention
  ), provenance AS (
    -- An override entry describes an operator value and a revert entry an application value. An
    -- entry whose action does not match the source of the setting is not shown. `provenance` keeps
    -- its released shape, and `lastChanges` holds the shown entries.
    SELECT fields.policy, jsonb_object_agg(fields.wire_name, jsonb_build_object(
             'source', fields.source,
             'applicationDefault', fields.application_default
           )) AS document,
           COALESCE(jsonb_object_agg(fields.wire_name, jsonb_build_object(
             'action', fields.audit->>'action',
             'actor', fields.audit->>'actor',
             'reason', fields.audit->>'reason',
             'requestIdPreview', fields.audit->>'requestIdPreview',
             'requestIdDigest', fields.audit->>'requestIdDigest',
             'requestIdLength', (fields.audit->>'requestIdLength')::integer,
             'changedAt', workhorse.dashboard_iso_v1((fields.audit->>'changedAt')::timestamptz))
           ) FILTER (WHERE fields.audit->>'action' = CASE fields.source
             WHEN 'operator' THEN 'override' ELSE 'revert' END), '{}'::jsonb) AS last_changes
      FROM field_sources fields
     GROUP BY fields.policy
  ), maintenance_provenance AS (
    SELECT document, last_changes FROM provenance WHERE policy = 'maintenance'
  ), retention_provenance AS (
    SELECT document, last_changes FROM provenance WHERE policy = 'retention'
  ), health AS (
    SELECT COALESCE(p_input->'health', workhorse.queue_health_v1()) AS document
  ), enqueue_rate AS (
    SELECT COALESCE(sum(stat.enqueued), 0)::bigint AS tasks
      FROM workhorse.stat_buckets_v1(
        date_bin('1 minute', clock_timestamp(), timestamp '2000-01-01' AT TIME ZONE 'UTC')
          - interval '1 hour' + interval '1 minute',
        clock_timestamp()
      ) stat
  ), workers AS (
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
             'id', worker_id,
             'queue', queue_names[1],
             'queues', to_jsonb(queue_names),
             'concurrency', concurrency,
             'leaseMs', lease_ms,
             'heartbeatMs', heartbeat_ms,
             'pollMs', poll_ms,
             'maintenanceIntervalMs', maintenance_interval_ms,
             'maintenanceRoutinePollMs', maintenance_routine_poll_ms,
             'registryIntervalMs', registry_interval_ms,
             'lastSeenAt', workhorse.dashboard_iso_v1(last_heartbeat_at)
           ) ORDER BY worker_id), '[]'::jsonb) AS document
      FROM workhorse.dashboard_worker_registry_v1
     WHERE last_heartbeat_at >= clock_timestamp() - GREATEST(
       interval '30 seconds', registry_interval_ms * 3 * interval '1 millisecond'
     )
  )
  SELECT jsonb_build_object(
    'capturedAt', workhorse.dashboard_iso_v1(clock_timestamp()),
    'editable', COALESCE((p_input->>'writable')::boolean, false)
      AND COALESCE((p_input->>'settingsController')::boolean, false),
    'maintenance', jsonb_build_object(
      'timezone', maintenance.timezone,
      'partitionPreparationIntervalMs', maintenance.partition_preparation_interval_ms,
      'terminalCleanupIntervalMs', maintenance.terminal_cleanup_interval_ms,
      'historyRetentionLocalTime', to_char(maintenance.history_retention_local_time, 'HH24:MI'),
      'statisticsRollupIntervalMs', maintenance.statistics_rollup_interval_ms,
      'statisticsGroupLimit', maintenance.statistics_group_limit,
      'statisticsRecomputeBuckets', maintenance.statistics_recompute_buckets,
      'provenance', maintenance_provenance.document,
      'lastChanges', maintenance_provenance.last_changes,
      'updatedAt', workhorse.dashboard_iso_v1(maintenance.updated_at)
    ),
    'retention', jsonb_build_object(
      'taskIdentityRetentionDays', retention.task_identity_retention_days,
      'terminalOutcomeRetentionDays', retention.terminal_outcome_retention_days,
      'taskEventRetentionDays', retention.task_event_retention_days,
      'attemptHistoryRetentionDays', retention.attempt_history_retention_days,
      'scheduleOccurrenceRetentionDays', retention.schedule_occurrence_retention_days,
      'statisticsRetentionDays', retention.statistics_retention_days,
      'terminalTaskPruneLimit', retention.terminal_task_prune_limit,
      'historyPartitionsPerPass', retention.history_partitions_per_pass,
      'defaultPartitionRowsPerPass', retention.default_partition_rows_per_pass,
      'occurrenceRowsPerPass', retention.occurrence_rows_per_pass,
      'statisticsRowsPerPass', retention.statistics_rows_per_pass,
      'provenance', retention_provenance.document,
      'lastChanges', retention_provenance.last_changes,
      'updatedAt', workhorse.dashboard_iso_v1(retention.updated_at)
    ),
    'recommendationInputs', jsonb_build_object(
      'reasons', health.document->'status'->'reasons',
      'statistics', jsonb_build_object(
        'rolledUpThrough', workhorse.dashboard_iso_v1(
          (health.document->>'rolled_up_through')::timestamptz),
        'lagMs', (health.document->>'rollup_lag_ms')::numeric,
        'lastRunAt', workhorse.dashboard_iso_v1(
          (health.document->>'last_run_at')::timestamptz)
      ),
      'defaultHistoryRows', jsonb_build_object(
        'taskEvents', (health.document->>'default_event_rows')::integer,
        'attemptHistory', (health.document->>'default_attempt_rows')::integer
      ),
      'defaultHistoryRowsCapped', jsonb_build_object(
        'taskEvents', (health.document->>'default_event_rows_capped')::boolean,
        'attemptHistory', (health.document->>'default_attempt_rows_capped')::boolean
      ),
      'enqueueRate', jsonb_build_object('tasks', enqueue_rate.tasks, 'windowMs', 3600000)
    ),
    'workers', workers.document
  )
    FROM maintenance CROSS JOIN retention
    CROSS JOIN maintenance_provenance CROSS JOIN retention_provenance
    CROSS JOIN health CROSS JOIN enqueue_rate CROSS JOIN workers;
$$;
