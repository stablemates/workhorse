-- workhorse-migration: {"kind":"additive"}

-- Give the terminal cleanup backlog reason its own health budget (SM-1197).

-- terminal-cleanup-backlog was budgeted by row_retention_lag_ms, so an operator could not warn on a
-- saturated cleanup earlier than on row retention lag without also tightening retention-lag.
-- queue_health_policy gains terminal_cleanup_backlog_ms and its application default, appended after
-- updated_at, and evaluate_queue_health_v1 budgets the reason by it.
--
-- Every installation evaluates exactly as before. Each new column starts from its row retention
-- counterpart, and an operator override of row_retention_lag_ms carries over to
-- terminal_cleanup_backlog_ms. From then on the two budgets are independent: overriding or
-- reverting row_retention_lag_ms no longer moves terminal_cleanup_backlog_ms.
--
-- sync_queue_health_policy_v2 seeds all six application values. sync_queue_health_policy_v1 keeps
-- its released signature and writes only its five budgets, so a v1 sync no longer moves the backlog
-- budget; with p_force it restores that budget's application value as it clears every override.
-- override_queue_health_policy_v1 and revert_queue_health_policy_v1 accept the new name.
-- queue_health_v1 reports the budget as budgets.terminalCleanupBacklogMs.

ALTER TABLE workhorse.queue_health_policy
  ADD COLUMN terminal_cleanup_backlog_ms integer CHECK (terminal_cleanup_backlog_ms >= 0),
  ADD COLUMN application_terminal_cleanup_backlog_ms integer CHECK (
    application_terminal_cleanup_backlog_ms >= 0
  );

-- A replacement that only widens: every value the old CHECK accepted still passes.
ALTER TABLE workhorse.queue_health_policy
  DROP CONSTRAINT queue_health_policy_operator_overrides_check,
  ADD CONSTRAINT queue_health_policy_operator_overrides_check CHECK (
    operator_overrides <@ ARRAY[
      'promotion_lag_ms', 'rollup_stalled_lag_ms', 'row_retention_lag_ms',
      'partition_retention_lag_ms', 'eligible_history_partitions',
      'terminal_cleanup_backlog_ms'
    ]::text[]
  );

UPDATE workhorse.queue_health_policy SET
  terminal_cleanup_backlog_ms = row_retention_lag_ms,
  application_terminal_cleanup_backlog_ms = application_row_retention_lag_ms,
  operator_overrides = CASE WHEN 'row_retention_lag_ms' = ANY(operator_overrides)
    THEN ARRAY(
      SELECT name FROM unnest(operator_overrides || 'terminal_cleanup_backlog_ms'::text) name
       ORDER BY name
    )
    ELSE operator_overrides END;

ALTER TABLE workhorse.queue_health_policy
  ALTER COLUMN terminal_cleanup_backlog_ms SET NOT NULL,
  ALTER COLUMN application_terminal_cleanup_backlog_ms SET NOT NULL;

-- Retained beside sync_queue_health_policy_v2. It writes only its five budgets, so a v1 sync leaves
-- terminal_cleanup_backlog_ms alone. p_force clears every override, so it also restores that
-- budget's application value.
CREATE OR REPLACE FUNCTION workhorse.sync_queue_health_policy_v1(
  p_promotion_lag_ms integer,
  p_rollup_stalled_lag_ms integer,
  p_row_retention_lag_ms integer,
  p_partition_retention_lag_ms integer,
  p_eligible_history_partitions integer,
  p_force boolean DEFAULT false
) RETURNS workhorse.queue_health_policy
LANGUAGE plpgsql
AS $$
DECLARE
  v_policy workhorse.queue_health_policy;
BEGIN
  UPDATE workhorse.queue_health_policy policy SET
    application_promotion_lag_ms = p_promotion_lag_ms,
    application_rollup_stalled_lag_ms = p_rollup_stalled_lag_ms,
    application_row_retention_lag_ms = p_row_retention_lag_ms,
    application_partition_retention_lag_ms = p_partition_retention_lag_ms,
    application_eligible_history_partitions = p_eligible_history_partitions,
    promotion_lag_ms = CASE
      WHEN p_force OR NOT ('promotion_lag_ms' = ANY(policy.operator_overrides))
        THEN p_promotion_lag_ms ELSE policy.promotion_lag_ms END,
    rollup_stalled_lag_ms = CASE
      WHEN p_force OR NOT ('rollup_stalled_lag_ms' = ANY(policy.operator_overrides))
        THEN p_rollup_stalled_lag_ms ELSE policy.rollup_stalled_lag_ms END,
    row_retention_lag_ms = CASE
      WHEN p_force OR NOT ('row_retention_lag_ms' = ANY(policy.operator_overrides))
        THEN p_row_retention_lag_ms ELSE policy.row_retention_lag_ms END,
    partition_retention_lag_ms = CASE
      WHEN p_force OR NOT ('partition_retention_lag_ms' = ANY(policy.operator_overrides))
        THEN p_partition_retention_lag_ms ELSE policy.partition_retention_lag_ms END,
    eligible_history_partitions = CASE
      WHEN p_force OR NOT ('eligible_history_partitions' = ANY(policy.operator_overrides))
        THEN p_eligible_history_partitions ELSE policy.eligible_history_partitions END,
    terminal_cleanup_backlog_ms = CASE WHEN p_force
      THEN policy.application_terminal_cleanup_backlog_ms
      ELSE policy.terminal_cleanup_backlog_ms END,
    operator_overrides = CASE WHEN p_force THEN '{}'::text[] ELSE policy.operator_overrides END,
    updated_at = clock_timestamp()
  WHERE singleton
  RETURNING * INTO v_policy;
  RETURN v_policy;
END;
$$;

-- Seeds every application value, terminal_cleanup_backlog_ms included, without replacing operator
-- overrides unless p_force is true.
CREATE OR REPLACE FUNCTION workhorse.sync_queue_health_policy_v2(
  p_promotion_lag_ms integer,
  p_rollup_stalled_lag_ms integer,
  p_row_retention_lag_ms integer,
  p_partition_retention_lag_ms integer,
  p_eligible_history_partitions integer,
  p_terminal_cleanup_backlog_ms integer,
  p_force boolean DEFAULT false
) RETURNS workhorse.queue_health_policy
LANGUAGE plpgsql
AS $$
DECLARE
  v_policy workhorse.queue_health_policy;
BEGIN
  UPDATE workhorse.queue_health_policy policy SET
    application_promotion_lag_ms = p_promotion_lag_ms,
    application_rollup_stalled_lag_ms = p_rollup_stalled_lag_ms,
    application_row_retention_lag_ms = p_row_retention_lag_ms,
    application_partition_retention_lag_ms = p_partition_retention_lag_ms,
    application_eligible_history_partitions = p_eligible_history_partitions,
    application_terminal_cleanup_backlog_ms = p_terminal_cleanup_backlog_ms,
    promotion_lag_ms = CASE
      WHEN p_force OR NOT ('promotion_lag_ms' = ANY(policy.operator_overrides))
        THEN p_promotion_lag_ms ELSE policy.promotion_lag_ms END,
    rollup_stalled_lag_ms = CASE
      WHEN p_force OR NOT ('rollup_stalled_lag_ms' = ANY(policy.operator_overrides))
        THEN p_rollup_stalled_lag_ms ELSE policy.rollup_stalled_lag_ms END,
    row_retention_lag_ms = CASE
      WHEN p_force OR NOT ('row_retention_lag_ms' = ANY(policy.operator_overrides))
        THEN p_row_retention_lag_ms ELSE policy.row_retention_lag_ms END,
    partition_retention_lag_ms = CASE
      WHEN p_force OR NOT ('partition_retention_lag_ms' = ANY(policy.operator_overrides))
        THEN p_partition_retention_lag_ms ELSE policy.partition_retention_lag_ms END,
    eligible_history_partitions = CASE
      WHEN p_force OR NOT ('eligible_history_partitions' = ANY(policy.operator_overrides))
        THEN p_eligible_history_partitions ELSE policy.eligible_history_partitions END,
    terminal_cleanup_backlog_ms = CASE
      WHEN p_force OR NOT ('terminal_cleanup_backlog_ms' = ANY(policy.operator_overrides))
        THEN p_terminal_cleanup_backlog_ms ELSE policy.terminal_cleanup_backlog_ms END,
    operator_overrides = CASE WHEN p_force THEN '{}'::text[] ELSE policy.operator_overrides END,
    updated_at = clock_timestamp()
  WHERE singleton
  RETURNING * INTO v_policy;
  RETURN v_policy;
END;
$$;

CREATE OR REPLACE FUNCTION workhorse.override_queue_health_policy_v1(p_values jsonb)
RETURNS workhorse.queue_health_policy
LANGUAGE plpgsql
AS $$
DECLARE
  v_names text[];
  v_policy workhorse.queue_health_policy;
BEGIN
  IF p_values IS NULL OR jsonb_typeof(p_values) <> 'object' THEN
    RAISE EXCEPTION 'queue health policy overrides must be a JSON object';
  END IF;
  SELECT COALESCE(array_agg(key ORDER BY key), '{}') INTO v_names
    FROM jsonb_object_keys(p_values) key;
  IF cardinality(v_names) = 0 OR NOT v_names <@ ARRAY[
    'promotion_lag_ms', 'rollup_stalled_lag_ms', 'row_retention_lag_ms',
    'partition_retention_lag_ms', 'eligible_history_partitions', 'terminal_cleanup_backlog_ms'
  ]::text[] THEN
    RAISE EXCEPTION 'queue health policy override names are invalid';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_each_text(p_values) value
     WHERE value.value !~ '^[0-9]+$' OR value.value::numeric > 2147483647
  ) THEN
    RAISE EXCEPTION 'queue health policy overrides must be non-negative integers';
  END IF;
  UPDATE workhorse.queue_health_policy policy SET
    promotion_lag_ms = CASE WHEN p_values ? 'promotion_lag_ms'
      THEN (p_values->>'promotion_lag_ms')::integer ELSE policy.promotion_lag_ms END,
    rollup_stalled_lag_ms = CASE WHEN p_values ? 'rollup_stalled_lag_ms'
      THEN (p_values->>'rollup_stalled_lag_ms')::integer ELSE policy.rollup_stalled_lag_ms END,
    row_retention_lag_ms = CASE WHEN p_values ? 'row_retention_lag_ms'
      THEN (p_values->>'row_retention_lag_ms')::integer ELSE policy.row_retention_lag_ms END,
    partition_retention_lag_ms = CASE WHEN p_values ? 'partition_retention_lag_ms'
      THEN (p_values->>'partition_retention_lag_ms')::integer
      ELSE policy.partition_retention_lag_ms END,
    eligible_history_partitions = CASE WHEN p_values ? 'eligible_history_partitions'
      THEN (p_values->>'eligible_history_partitions')::integer
      ELSE policy.eligible_history_partitions END,
    terminal_cleanup_backlog_ms = CASE WHEN p_values ? 'terminal_cleanup_backlog_ms'
      THEN (p_values->>'terminal_cleanup_backlog_ms')::integer
      ELSE policy.terminal_cleanup_backlog_ms END,
    operator_overrides = ARRAY(
      SELECT DISTINCT name FROM unnest(policy.operator_overrides || v_names) name ORDER BY name
    ),
    updated_at = clock_timestamp()
  WHERE singleton
  RETURNING * INTO v_policy;
  RETURN v_policy;
END;
$$;

CREATE OR REPLACE FUNCTION workhorse.revert_queue_health_policy_v1(p_settings text[])
RETURNS workhorse.queue_health_policy
LANGUAGE plpgsql
AS $$
DECLARE
  v_policy workhorse.queue_health_policy;
BEGIN
  IF p_settings IS NULL OR cardinality(p_settings) = 0 OR NOT p_settings <@ ARRAY[
    'promotion_lag_ms', 'rollup_stalled_lag_ms', 'row_retention_lag_ms',
    'partition_retention_lag_ms', 'eligible_history_partitions', 'terminal_cleanup_backlog_ms'
  ]::text[] THEN
    RAISE EXCEPTION 'queue health policy setting names are invalid';
  END IF;
  UPDATE workhorse.queue_health_policy policy SET
    promotion_lag_ms = CASE WHEN 'promotion_lag_ms' = ANY(p_settings)
      THEN policy.application_promotion_lag_ms ELSE policy.promotion_lag_ms END,
    rollup_stalled_lag_ms = CASE WHEN 'rollup_stalled_lag_ms' = ANY(p_settings)
      THEN policy.application_rollup_stalled_lag_ms ELSE policy.rollup_stalled_lag_ms END,
    row_retention_lag_ms = CASE WHEN 'row_retention_lag_ms' = ANY(p_settings)
      THEN policy.application_row_retention_lag_ms ELSE policy.row_retention_lag_ms END,
    partition_retention_lag_ms = CASE WHEN 'partition_retention_lag_ms' = ANY(p_settings)
      THEN policy.application_partition_retention_lag_ms ELSE policy.partition_retention_lag_ms END,
    eligible_history_partitions = CASE WHEN 'eligible_history_partitions' = ANY(p_settings)
      THEN policy.application_eligible_history_partitions
      ELSE policy.eligible_history_partitions END,
    terminal_cleanup_backlog_ms = CASE WHEN 'terminal_cleanup_backlog_ms' = ANY(p_settings)
      THEN policy.application_terminal_cleanup_backlog_ms
      ELSE policy.terminal_cleanup_backlog_ms END,
    operator_overrides = ARRAY(
      SELECT name FROM unnest(policy.operator_overrides) name
       WHERE NOT (name = ANY(p_settings))
    ),
    updated_at = clock_timestamp()
  WHERE singleton
  RETURNING * INTO v_policy;
  RETURN v_policy;
END;
$$;

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
    -- A backlog that outlasts its budget means cleanup has run saturated that long. The oldest
    -- eligible row can still be young, because cleanup deletes the oldest rows first.
    SELECT 120, jsonb_build_object(
      'code', 'terminal-cleanup-backlog', 'severity', 'degraded',
      'observed', backlog.age_ms,
      'budget', (p_policy->>'terminal_cleanup_backlog_ms')::numeric
    ) FROM (
      SELECT floor(extract(epoch FROM (p_snapshot->>'captured_at')::timestamptz
        - (p_snapshot->>'terminal_cleanup_backlog_since')::timestamptz) * 1000) AS age_ms
    ) backlog
    WHERE backlog.age_ms > (p_policy->>'terminal_cleanup_backlog_ms')::numeric
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

CREATE OR REPLACE FUNCTION workhorse.queue_health_v1(
  p_rejected_since timestamptz DEFAULT clock_timestamp() - interval '1 day'
) RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SET jit = off
AS $$
DECLARE
  v_document jsonb;
  v_observations jsonb;
BEGIN
  SELECT (to_jsonb(snapshot) - 'schedule_occurrence_pass_lag_ms'
           - 'schedule_occurrence_due_lag_ms' - 'eligible_task_identity_history_at'
           - 'eligible_terminal_outcome_history_at') || jsonb_build_object(
           'status', workhorse.evaluate_queue_health_v1(to_jsonb(snapshot), to_jsonb(policy)),
           'budgets', jsonb_build_object(
             'promotionLagMs', policy.promotion_lag_ms,
             'rollupStalledLagMs', policy.rollup_stalled_lag_ms,
             'rowRetentionLagMs', policy.row_retention_lag_ms,
             'partitionRetentionLagMs', policy.partition_retention_lag_ms,
             'eligibleHistoryPartitions', policy.eligible_history_partitions,
             'terminalCleanupBacklogMs', policy.terminal_cleanup_backlog_ms
           )
         )
    INTO v_document
    FROM (
      WITH installed AS (
          SELECT CASE
                   WHEN count(*) = 1
                    AND min(version) = max(version)
                    AND NOT EXISTS (
                      SELECT 1
                        FROM unnest(ARRAY['task_current', 'ready_task', 'scheduled_task', 'lease'])
                          AS legacy(relation_name)
                       WHERE to_regclass(format('workhorse.%I', relation_name)) IS NOT NULL
                    )
                   THEN min(version)::integer
                   ELSE NULL
                 END AS schema_version
            FROM workhorse.schema_version
        ), depth AS (
          SELECT count(runtime.task_id) FILTER (WHERE runtime.state = 'blocked')::text AS blocked,
               count(runtime.task_id) FILTER (WHERE runtime.state = 'ready')::text AS ready,
               count(runtime.task_id) FILTER (WHERE runtime.state = 'scheduled')::text AS scheduled,
               count(runtime.task_id) FILTER (
             WHERE runtime.state = 'scheduled' AND runtime.wait_name IS NOT NULL
               AND EXISTS (
                 SELECT 1 FROM workhorse.task_wait timer
                  WHERE timer.task_id = runtime.task_id AND timer.wait_name = runtime.wait_name
               )
           )::text AS sleeping,
               count(runtime.task_id) FILTER (
             WHERE runtime.state = 'scheduled' AND runtime.wait_name IS NOT NULL
               AND EXISTS (
                 SELECT 1 FROM workhorse.task_wait timer
                  WHERE timer.task_id = runtime.task_id AND timer.wait_name = runtime.wait_name
               )
               AND runtime.run_at <= clock_timestamp()
           )::text AS overdue_waits,
               min(runtime.run_at) FILTER (
             WHERE runtime.state = 'scheduled' AND runtime.wait_name IS NOT NULL
               AND EXISTS (
                 SELECT 1 FROM workhorse.task_wait timer
                  WHERE timer.task_id = runtime.task_id AND timer.wait_name = runtime.wait_name
               )
           ) AS next_wake_at,
               count(runtime.task_id) FILTER (WHERE runtime.state = 'active')::text AS active,
               count(runtime.task_id) FILTER (
             WHERE runtime.state = 'active' AND runtime.expires_at <= clock_timestamp()
           )::text AS expired,
               extract(epoch FROM clock_timestamp() - min(runtime.ready_at) FILTER (
             WHERE runtime.state = 'ready'
           )) * 1000 AS oldest_ready_age_ms,
               count(runtime.task_id) FILTER (
             WHERE runtime.state = 'scheduled' AND runtime.run_at <= clock_timestamp()
           )::text AS overdue_scheduled,
               extract(epoch FROM clock_timestamp() - min(runtime.run_at) FILTER (
             WHERE runtime.state = 'scheduled' AND runtime.run_at <= clock_timestamp()
           )) * 1000 AS oldest_overdue_scheduled_age_ms,
               count(runtime.task_id) FILTER (WHERE runtime.deadline_at IS NOT NULL)::text AS pending_deadlines,
               count(runtime.task_id) FILTER (
             WHERE runtime.deadline_at IS NOT NULL AND runtime.deadline_at <= clock_timestamp()
           )::text AS overdue_deadlines,
               count(runtime.task_id) FILTER (
             WHERE runtime.deadline_at > clock_timestamp()
               AND runtime.deadline_at <= clock_timestamp() + interval '1 minute'
           )::text AS deadlines_due_within_minute,
               min(runtime.deadline_at) AS earliest_deadline_at,
               count(runtime.task_id) FILTER (
             WHERE runtime.state = 'active' AND runtime.attempt_timeout_at IS NOT NULL
           )::text AS active_execution_timeouts,
               count(runtime.task_id) FILTER (
             WHERE runtime.state = 'active' AND runtime.attempt_timeout_at <= clock_timestamp()
           )::text AS overdue_execution_timeouts
            FROM (
              SELECT task_id, state, run_at, ready_at, wait_name, expires_at, deadline_at,
                     attempt_timeout_at
                FROM workhorse.task_runtime
              UNION ALL
              -- A fast-tier row has no scheduled state; a ready row with a future run time is one.
              SELECT task_id,
                     CASE WHEN state = 'ready' AND run_at > clock_timestamp() THEN 'scheduled'
                          ELSE state END,
                     run_at, CASE WHEN state = 'ready' THEN run_at END, NULL::text, expires_at,
                     deadline_at, attempt_timeout_at
                FROM workhorse.fast_task_runtime
            ) runtime
        ), terminal AS (
          -- Terminal history is unbounded, so its counts stop scanning at the cap. Live-state counts
          -- come from depth and stay exact; claim-shaped work never pays for lifetime history here.
          SELECT count(*) FILTER (WHERE state = 'succeeded')::text AS succeeded_count,
                 count(*) FILTER (WHERE state = 'failed')::text AS failed_count,
                 count(*) FILTER (WHERE state = 'canceled')::text AS canceled_count,
                 count(*) > 100000 AS terminal_counts_capped
            FROM (
              SELECT state FROM workhorse.task_outcome
              UNION ALL
              SELECT state FROM workhorse.fast_task_outcome
              LIMIT 100001
            ) sampled_outcomes
        ), retention AS (
          -- The LIMIT 1 clauses on the singleton CTEs here and below are planner facts, not semantics:
          -- without them each CTE gets a default multi-hundred-row estimate, the cross joins multiply
          -- into a cost that trips JIT compilation, and compiling this statement costs a full second.
          WITH policy AS (
            SELECT * FROM workhorse.retention_policy WHERE singleton LIMIT 1
          ), maintenance AS (
            -- A start at or after the local retention time counts as that day's pass, and a
            -- completed date covers its day even when a forced pass ran earlier. A routine with
            -- neither has no due time here; the due lag measures it from the oldest expired run.
            SELECT state.last_started_at, state.last_completed_local_date,
                   policy.timezone, policy.history_retention_local_time,
                   GREATEST(
                     (CASE
                        WHEN local_clock.started::time >= policy.history_retention_local_time
                          THEN local_clock.started::date + 1
                        ELSE local_clock.started::date
                      END + policy.history_retention_local_time) AT TIME ZONE policy.timezone,
                     (state.last_completed_local_date + 1 + policy.history_retention_local_time)
                       AT TIME ZONE policy.timezone
                   ) AS next_due_at
              FROM workhorse.maintenance_state state
              CROSS JOIN workhorse.maintenance_policy policy
              CROSS JOIN LATERAL (
                SELECT state.last_started_at AT TIME ZONE policy.timezone AS started
              ) local_clock
             WHERE state.routine_name = 'history_retention' AND policy.singleton
             LIMIT 1
          ), terminal_outcome AS NOT MATERIALIZED (
            -- A fast-tier outcome has no history boundary of its own. Its history rows, if the queue
            -- recorded any, end when it finished.
            SELECT task_id, finished_at, history_through_at FROM workhorse.task_outcome
            UNION ALL
            SELECT task_id, finished_at, finished_at FROM workhorse.fast_task_outcome
          ), boundaries AS (
            SELECT
              (SELECT task.created_at
                 FROM workhorse.task task
                 JOIN terminal_outcome outcome ON outcome.task_id = task.id
                ORDER BY task.created_at, task.id LIMIT 1)
                AS oldest_task_identity_at,
              (SELECT finished_at FROM terminal_outcome ORDER BY finished_at, task_id LIMIT 1)
                AS oldest_terminal_outcome_at,
              eligible_task_identity.created_at AS eligible_task_identity_at,
              eligible_task_identity.history_through_at AS eligible_task_identity_history_at,
              eligible_terminal_outcome.finished_at AS eligible_terminal_outcome_at,
              eligible_terminal_outcome.history_through_at AS eligible_terminal_outcome_history_at,
              (SELECT occurred_at FROM workhorse.task_event ORDER BY occurred_at, event_id LIMIT 1)
                AS oldest_task_event_at,
              (SELECT occurred_at FROM workhorse.task_event
                WHERE tableoid <> 'workhorse.task_event_default'::regclass
                ORDER BY occurred_at, event_id LIMIT 1) AS oldest_partitioned_task_event_at,
              (SELECT occurred_at FROM workhorse.task_event_default
                ORDER BY occurred_at, event_id LIMIT 1) AS oldest_default_task_event_at,
              (SELECT occurred_at FROM workhorse.attempt_history ORDER BY occurred_at, attempt_id LIMIT 1)
                AS oldest_attempt_history_at,
              (SELECT occurred_at FROM workhorse.attempt_history
                WHERE tableoid <> 'workhorse.attempt_history_default'::regclass
                ORDER BY occurred_at, attempt_id LIMIT 1) AS oldest_partitioned_attempt_history_at,
              (SELECT occurred_at FROM workhorse.attempt_history_default
                ORDER BY occurred_at, attempt_id LIMIT 1) AS oldest_default_attempt_history_at,
              (SELECT occurrence_at FROM workhorse.schedule_occurrence ORDER BY occurrence_at LIMIT 1)
                AS oldest_schedule_occurrence_at,
              -- A row fired after the pass could not have been left behind by that pass.
              (SELECT occurrence_at FROM workhorse.schedule_occurrence
                WHERE fired_at <= (SELECT last_started_at FROM maintenance)
                ORDER BY occurrence_at LIMIT 1) AS oldest_schedule_occurrence_at_last_pass,
              (SELECT min(bucket_start) FROM (
                 SELECT bucket_start FROM workhorse.task_stat_bucket
                 UNION ALL SELECT bucket_start FROM workhorse.task_stat_bucket_hour
                 UNION ALL SELECT bucket_start FROM workhorse.task_stat_bucket_day
               ) statistic_tiers) AS oldest_statistics_at
            FROM policy
            -- A row counts as eligible only once workhorse.prune_terminal_tasks_v1 could delete it.
            -- That prune also waits until daily history retention has passed the row's history, so
            -- a row held only by that gate is waiting on history retention, not lagging here.
            LEFT JOIN LATERAL (
              SELECT task.created_at, outcome.history_through_at
                FROM workhorse.task task
                JOIN terminal_outcome outcome ON outcome.task_id = task.id
               WHERE policy.task_identity_retention_days IS NOT NULL
                 AND policy.terminal_outcome_retention_days IS NOT NULL
                 AND task.created_at < clock_timestamp()
                   - make_interval(days => policy.task_identity_retention_days)
                 AND outcome.finished_at < clock_timestamp()
                   - make_interval(days => policy.terminal_outcome_retention_days)
                 AND outcome.history_through_at < (
                   SELECT history_retained_before FROM workhorse.maintenance_state
                    WHERE routine_name = 'history_retention'
                 )
               ORDER BY task.created_at, task.id LIMIT 1
            ) eligible_task_identity ON true
            LEFT JOIN LATERAL (
              SELECT outcome.finished_at, outcome.history_through_at
                FROM workhorse.task task
                JOIN terminal_outcome outcome ON outcome.task_id = task.id
               WHERE policy.task_identity_retention_days IS NOT NULL
                 AND policy.terminal_outcome_retention_days IS NOT NULL
                 AND task.created_at < clock_timestamp()
                   - make_interval(days => policy.task_identity_retention_days)
                 AND outcome.finished_at < clock_timestamp()
                   - make_interval(days => policy.terminal_outcome_retention_days)
                 AND outcome.history_through_at < (
                   SELECT history_retained_before FROM workhorse.maintenance_state
                    WHERE routine_name = 'history_retention'
                 )
               ORDER BY outcome.finished_at, outcome.task_id LIMIT 1
            ) eligible_terminal_outcome ON true
          ), partitions AS (
            SELECT parent.relname AS parent_name,
                   ((regexp_match(
                     pg_get_expr(child.relpartbound, child.oid),
                     'TO \(''([^'']+)''\)'
                   ))[1])::timestamptz AS upper_bound
              FROM pg_inherits inheritance
              JOIN pg_class parent ON parent.oid = inheritance.inhparent
              JOIN pg_namespace namespace ON namespace.oid = parent.relnamespace
              JOIN pg_class child ON child.oid = inheritance.inhrelid
             WHERE namespace.nspname = 'workhorse'
               AND parent.relname IN ('task_event', 'attempt_history')
               AND child.relname <> parent.relname || '_default'
          ), eligible AS (
            SELECT
              count(*) FILTER (
                WHERE parent_name = 'task_event'
                  AND policy.task_event_retention_days IS NOT NULL
                  AND upper_bound <= clock_timestamp()
                    - make_interval(days => policy.task_event_retention_days)
                  AND upper_bound <= (
                    date_trunc('day', clock_timestamp() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
                  )
              )::text AS eligible_event_partitions,
              count(*) FILTER (
                WHERE parent_name = 'attempt_history'
                  AND policy.attempt_history_retention_days IS NOT NULL
                  AND upper_bound <= clock_timestamp()
                    - make_interval(days => policy.attempt_history_retention_days)
                  AND upper_bound <= (
                    date_trunc('day', clock_timestamp() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
                  )
              )::text AS eligible_attempt_partitions
            FROM partitions CROSS JOIN policy
          ), default_rows AS (
            SELECT event_rows::text AS default_event_rows,
                   attempt_rows::text AS default_attempt_rows,
                   event_rows > 10000 AS default_event_rows_capped,
                   attempt_rows > 10000 AS default_attempt_rows_capped
              FROM (
                SELECT
                  (SELECT count(*) FROM (
                    SELECT 1 FROM workhorse.task_event_default LIMIT 10001
                  ) sampled_events) AS event_rows,
                  (SELECT count(*) FROM (
                    SELECT 1 FROM workhorse.attempt_history_default LIMIT 10001
                  ) sampled_attempts) AS attempt_rows
              ) sampled
          )
          SELECT policy.*, boundaries.*,
                 -- Row lag counts from the later of two instants: the row passing its row window,
                 -- and the scheduled history pass that released it. One pass releases a whole day
                 -- of rows at once, and the bounded prune needs time to delete them.
                 CASE WHEN policy.task_identity_retention_days IS NULL
                             OR boundaries.eligible_task_identity_at IS NULL THEN NULL
                      ELSE GREATEST(0, extract(epoch FROM
                        clock_timestamp() - GREATEST(
                          boundaries.eligible_task_identity_at
                            + make_interval(days => policy.task_identity_retention_days),
                          released.task_identity_at
                        )) * 1000) END AS task_identity_lag_ms,
                 CASE WHEN policy.terminal_outcome_retention_days IS NULL
                             OR boundaries.eligible_terminal_outcome_at IS NULL THEN NULL
                      ELSE GREATEST(0, extract(epoch FROM
                        clock_timestamp() - GREATEST(
                          boundaries.eligible_terminal_outcome_at
                            + make_interval(days => policy.terminal_outcome_retention_days),
                          released.terminal_outcome_at
                        )) * 1000) END AS terminal_outcome_lag_ms,
                 CASE WHEN policy.task_event_retention_days IS NULL
                             OR boundaries.oldest_task_event_at IS NULL THEN NULL
                      ELSE GREATEST(
                        0,
                        COALESCE(extract(epoch FROM
                          date_trunc(
                            'day',
                            (clock_timestamp() - make_interval(
                              days => policy.task_event_retention_days
                            )) AT TIME ZONE 'UTC'
                          ) AT TIME ZONE 'UTC'
                          - boundaries.oldest_partitioned_task_event_at) * 1000, 0),
                        COALESCE(extract(epoch FROM
                          clock_timestamp() - make_interval(days => policy.task_event_retention_days)
                          - boundaries.oldest_default_task_event_at) * 1000, 0)
                      ) END AS task_event_lag_ms,
                 CASE WHEN policy.attempt_history_retention_days IS NULL
                             OR boundaries.oldest_attempt_history_at IS NULL THEN NULL
                      ELSE GREATEST(
                        0,
                        COALESCE(extract(epoch FROM
                          date_trunc(
                            'day',
                            (clock_timestamp() - make_interval(
                              days => policy.attempt_history_retention_days
                            )) AT TIME ZONE 'UTC'
                          ) AT TIME ZONE 'UTC'
                          - boundaries.oldest_partitioned_attempt_history_at) * 1000, 0),
                        COALESCE(extract(epoch FROM
                          clock_timestamp()
                          - make_interval(days => policy.attempt_history_retention_days)
                          - boundaries.oldest_default_attempt_history_at) * 1000, 0)
                      ) END AS attempt_history_lag_ms,
                 CASE WHEN policy.schedule_occurrence_retention_days IS NULL
                             OR boundaries.oldest_schedule_occurrence_at IS NULL THEN NULL
                      ELSE GREATEST(0, extract(epoch FROM
                        clock_timestamp()
                        - make_interval(days => policy.schedule_occurrence_retention_days)
                        - boundaries.oldest_schedule_occurrence_at) * 1000) END
                   AS schedule_occurrence_lag_ms,
                 CASE WHEN policy.schedule_occurrence_retention_days IS NULL
                             OR boundaries.oldest_schedule_occurrence_at_last_pass IS NULL THEN NULL
                      -- A retention change resets completion; earlier passes used another window.
                      WHEN maintenance.last_completed_local_date IS NULL
                           AND maintenance.last_started_at < policy.updated_at THEN 0
                      ELSE GREATEST(0, COALESCE(extract(epoch FROM
                        maintenance.last_started_at
                        - make_interval(days => policy.schedule_occurrence_retention_days)
                        - boundaries.oldest_schedule_occurrence_at_last_pass) * 1000, 0)) END
                   AS schedule_occurrence_pass_lag_ms,
                 -- A routine that never ran owes the first scheduled pass after the oldest run
                 -- expired, so its lag keeps growing instead of restarting every day. The
                 -- comparison uses instants because a daylight-saving change can put a scheduled
                 -- time later than an expiry whose local time-of-day is later.
                 CASE WHEN policy.schedule_occurrence_retention_days IS NULL
                             OR boundaries.oldest_schedule_occurrence_at IS NULL THEN NULL
                      ELSE GREATEST(0, extract(epoch FROM
                        clock_timestamp() - COALESCE(maintenance.next_due_at, (
                          SELECT CASE
                                   WHEN same_day.at >= expired.at THEN same_day.at
                                   ELSE (expired.local_date + 1 + maintenance.history_retention_local_time)
                                          AT TIME ZONE maintenance.timezone END
                            FROM (
                              SELECT expiry.at, (expiry.at AT TIME ZONE maintenance.timezone)::date
                                       AS local_date
                                FROM (
                                  SELECT boundaries.oldest_schedule_occurrence_at + make_interval(
                                           days => policy.schedule_occurrence_retention_days) AS at
                                ) expiry
                            ) expired
                            CROSS JOIN LATERAL (
                              SELECT (expired.local_date + maintenance.history_retention_local_time)
                                       AT TIME ZONE maintenance.timezone AS at
                            ) same_day
                        ))) * 1000) END
                   AS schedule_occurrence_due_lag_ms,
                 CASE WHEN policy.statistics_retention_days IS NULL
                        OR boundaries.oldest_statistics_at IS NULL THEN NULL
                      ELSE GREATEST(0, extract(epoch FROM
                        clock_timestamp()
                        - make_interval(days => policy.statistics_retention_days)
                        - boundaries.oldest_statistics_at) * 1000) END
                   AS statistics_lag_ms,
                 eligible.*, default_rows.*
            FROM policy CROSS JOIN maintenance CROSS JOIN boundaries CROSS JOIN eligible
              CROSS JOIN default_rows
              -- A history pass at time t keeps history from the UTC day that began the longer
              -- history window before t. It therefore releases history through h from the start of
              -- the UTC day after h plus that window, and the first scheduled pass at or after that
              -- instant is the one due to release it. A late pass makes the row look late too.
              CROSS JOIN LATERAL (
                SELECT max(due.at) FILTER (WHERE gate.category = 'taskIdentity') AS task_identity_at,
                       max(due.at) FILTER (WHERE gate.category = 'terminalOutcome')
                         AS terminal_outcome_at
                  FROM (VALUES
                    ('taskIdentity', boundaries.eligible_task_identity_history_at),
                    ('terminalOutcome', boundaries.eligible_terminal_outcome_history_at)
                  ) gate(category, history_through_at)
                  CROSS JOIN LATERAL (
                    SELECT earliest.at, (earliest.at AT TIME ZONE maintenance.timezone)::date
                             AS local_date
                      FROM (
                        SELECT (date_trunc('day', (gate.history_through_at + make_interval(
                                 days => GREATEST(
                                   COALESCE(policy.task_event_retention_days, 0),
                                   COALESCE(policy.attempt_history_retention_days, 0)
                                 )
                               )) AT TIME ZONE 'UTC') + interval '1 day') AT TIME ZONE 'UTC' AS at
                      ) earliest
                  ) releasable
                  CROSS JOIN LATERAL (
                    SELECT (releasable.local_date + maintenance.history_retention_local_time)
                             AT TIME ZONE maintenance.timezone AS at
                  ) same_day
                  CROSS JOIN LATERAL (
                    SELECT CASE
                             WHEN same_day.at >= releasable.at THEN same_day.at
                             ELSE (releasable.local_date + 1 + maintenance.history_retention_local_time)
                                    AT TIME ZONE maintenance.timezone END AS at
                  ) due
              ) released
        ), dependencies AS (
          SELECT LEAST(blocked_tasks, 10000)::text
                   AS dependency_blocked_tasks,
                 LEAST(pending_edges, 10000)::text
                   AS dependency_pending_edges,
                 LEAST(failed_resolutions, 10000)::text
                   AS dependency_failed_resolutions,
                 (SELECT terminal_prune_dependency_starved
                    FROM workhorse.maintenance_state
                   WHERE routine_name = 'terminal_storage') AS dependency_retention_prune_starved,
                 blocked_tasks > 10000
                   OR pending_edges > 10000
                   OR failed_resolutions > 10000
                   AS dependency_counts_capped
            FROM (
              SELECT
                (SELECT count(*) FROM (
                  SELECT 1 FROM workhorse.task_runtime WHERE state = 'blocked'
                   LIMIT 10001
                ) sampled_blocked) AS blocked_tasks,
                (SELECT count(*) FROM (
                  SELECT 1 FROM workhorse.task_dependency WHERE released_at IS NULL
                   LIMIT 10001
                ) sampled_pending) AS pending_edges,
                (SELECT count(*) FROM (
                  SELECT 1 FROM workhorse.task_outcome
                   WHERE state = 'failed' AND error->>'name' = 'DependencyFailed'
                   LIMIT 10001
                ) sampled_failed) AS failed_resolutions
            ) samples
        ), children AS (
          SELECT LEAST(samples.waiting_parents, 10000)::text
                   AS child_waiting_parents,
                 LEAST(samples.pending_children, 10000)::text
                   AS child_pending_children,
                 LEAST(samples.unjoined_results, 10000)::text
                   AS child_unjoined_results,
                 LEAST(samples.failed_parents, 10000)::text
                   AS child_failed_parents,
                 LEAST(samples.canceled_parents, 10000)::text
                   AS child_canceled_parents,
                 samples.waiting_parents > 10000
                   OR samples.pending_children > 10000
                   OR samples.unjoined_results > 10000
                   OR samples.failed_parents > 10000
                   OR samples.canceled_parents > 10000
                   AS child_counts_capped
            FROM (
          SELECT
            (SELECT count(*) FROM (
              SELECT 1 FROM workhorse.task_runtime runtime
               WHERE runtime.state = 'blocked'
                 AND EXISTS (
                   SELECT 1 FROM workhorse.task_child edge WHERE edge.parent_task_id = runtime.task_id
                 )
               LIMIT 10001
            ) sampled_waiting) AS waiting_parents,
            (SELECT count(*) FROM (
              SELECT 1 FROM workhorse.task_child edge

               WHERE edge.joined_at IS NULL
                 AND NOT EXISTS (
                   SELECT 1 FROM workhorse.task_outcome outcome WHERE outcome.task_id = edge.child_task_id
                 )
               LIMIT 10001
            ) sampled_pending) AS pending_children,
            (SELECT count(*) FROM (
              SELECT 1 FROM workhorse.task_child edge

               JOIN workhorse.task_outcome outcome ON outcome.task_id = edge.child_task_id
              WHERE edge.joined_at IS NULL AND outcome.state = 'succeeded'
               LIMIT 10001
            ) sampled_unjoined) AS unjoined_results,
            (SELECT count(*) FROM (
              SELECT 1 FROM workhorse.task_outcome outcome

               WHERE outcome.state = 'failed'
                 AND outcome.error->>'name' = 'DependencyFailed'
                 AND EXISTS (
                   SELECT 1 FROM workhorse.task_child edge WHERE edge.parent_task_id = outcome.task_id
                 )
               LIMIT 10001
            ) sampled_failed) AS failed_parents,
            (SELECT count(*) FROM (
              SELECT 1 FROM workhorse.task_outcome outcome

               WHERE outcome.state = 'canceled'
                 AND outcome.error->>'name' = 'DependencyCanceled'
                 AND EXISTS (
                   SELECT 1 FROM workhorse.task_child edge WHERE edge.parent_task_id = outcome.task_id
                 )
               LIMIT 10001
            ) sampled_canceled) AS canceled_parents) samples
        ), external_waits AS (
          WITH pending AS (
            SELECT 'signal'::text AS kind, signal.created_at, runtime.deadline_at
              FROM workhorse.task_signal_wait signal
              JOIN workhorse.task_runtime runtime
                ON runtime.task_id = signal.task_id
               AND runtime.state = 'scheduled'
               AND runtime.wait_name = signal.signal_name
               AND runtime.current_attempt = signal.attempt
             WHERE signal.delivered_at IS NULL
             ORDER BY signal.created_at, signal.task_id, signal.signal_name
             LIMIT 10001
          ), pending_human AS (
            SELECT 'human'::text AS kind, human_wait.created_at, runtime.deadline_at
              FROM workhorse.task_human_wait human_wait
              JOIN workhorse.task_runtime runtime
                ON runtime.task_id = human_wait.task_id
               AND runtime.state = 'scheduled'
               AND runtime.wait_name = human_wait.token_name
               AND runtime.current_attempt = human_wait.attempt
             WHERE human_wait.completed_at IS NULL
             ORDER BY human_wait.created_at, human_wait.task_id, human_wait.token_name
             LIMIT 10001
          ), combined AS (
            SELECT * FROM pending UNION ALL SELECT * FROM pending_human
          ), overdue_signals AS (
            SELECT 1
              FROM workhorse.task_signal_wait signal
              JOIN workhorse.task_runtime runtime
                ON runtime.task_id = signal.task_id
               AND runtime.state = 'scheduled'
               AND runtime.wait_name = signal.signal_name
               AND runtime.current_attempt = signal.attempt
             WHERE signal.delivered_at IS NULL AND runtime.deadline_at <= clock_timestamp()
             ORDER BY runtime.deadline_at, signal.task_id, signal.signal_name
             LIMIT 10001
          ), overdue_humans AS (
            SELECT 1
              FROM workhorse.task_human_wait human_wait
              JOIN workhorse.task_runtime runtime
                ON runtime.task_id = human_wait.task_id
               AND runtime.state = 'scheduled'
               AND runtime.wait_name = human_wait.token_name
               AND runtime.current_attempt = human_wait.attempt
             WHERE human_wait.completed_at IS NULL AND runtime.deadline_at <= clock_timestamp()
             ORDER BY runtime.deadline_at, human_wait.task_id, human_wait.token_name
             LIMIT 10001
          ), rejected AS (
            SELECT 1
              FROM workhorse.task_event
             WHERE event_type IN ('signal_rejected', 'human_wait_rejected')
               AND occurred_at >= p_rejected_since
             ORDER BY occurred_at DESC, event_id DESC
             LIMIT 10001
          )
          SELECT LEAST(count(*) FILTER (WHERE kind = 'signal'), 10000)::text
                   AS pending_signal_waits,
                 LEAST(count(*) FILTER (WHERE kind = 'human'), 10000)::text
                   AS pending_human_waits,
                 LEAST(
                   (SELECT count(*) FROM overdue_signals) + (SELECT count(*) FROM overdue_humans),
                   10000
                 )::text AS overdue_external_waits,
                 extract(epoch FROM clock_timestamp() - min(created_at)) * 1000
                   AS oldest_external_wait_age_ms,
                 LEAST((SELECT count(*) FROM rejected), 10000)::text
                   AS rejected_wait_deliveries,
                 count(*) FILTER (WHERE kind = 'signal') > 10000
                   OR count(*) FILTER (WHERE kind = 'human') > 10000
                   OR (SELECT count(*) FROM overdue_signals)
                        + (SELECT count(*) FROM overdue_humans) > 10000
                   OR (SELECT count(*) FROM rejected) > 10000
                   AS external_wait_counts_capped
            FROM combined
        ), rollup AS (
          SELECT state.rolled_up_through,
                 GREATEST(0, extract(epoch FROM clock_timestamp() - state.rolled_up_through) * 1000)
                   AS rollup_lag_ms,
                 state.last_run_at,
                 bucket_sample.buckets::text AS buckets,
                 bucket_sample.buckets_capped,
                 (SELECT max(bucket_start) FROM (
                    SELECT bucket_start FROM workhorse.task_stat_bucket
                    UNION ALL SELECT bucket_start FROM workhorse.task_stat_bucket_hour
                    UNION ALL SELECT bucket_start FROM workhorse.task_stat_bucket_day
                  ) statistic_tiers) AS newest_bucket_at
            FROM workhorse.task_stat_state state
            CROSS JOIN LATERAL (
              SELECT count(*) AS buckets, count(*) > 100000 AS buckets_capped
                FROM (
                  SELECT 1 FROM workhorse.task_stat_bucket
                  UNION ALL SELECT 1 FROM workhorse.task_stat_bucket_hour
                  UNION ALL SELECT 1 FROM workhorse.task_stat_bucket_day
                  LIMIT 100001
                ) sampled_buckets
            ) bucket_sample
           WHERE state.singleton
           LIMIT 1
        ), concurrency AS (
          WITH policies AS MATERIALIZED (
            SELECT policy.*
              FROM workhorse.concurrency_policy policy
             ORDER BY policy.queue_name
             LIMIT 101
          )
          SELECT policy.namespace, policy.queue_name, policy.max_active,
                 policy.max_active_per_key,
                 usage.active::text,
                 blocked.blocked_ready::text,
                 usage.saturated_keys::text,
                 usage.highest_key_active::text,
                 (SELECT count(*) FROM policies) > 100 OR blocked.sample_capped AS capped
            FROM policies policy
            CROSS JOIN LATERAL (
              SELECT COALESCE(sum(keyed.key_active), 0)::integer AS active,
                     count(*) FILTER (
                       WHERE policy.max_active_per_key IS NOT NULL
                         AND keyed.concurrency_key IS NOT NULL
                         AND keyed.key_active >= policy.max_active_per_key
                     )::integer AS saturated_keys,
                     COALESCE(max(keyed.key_active) FILTER (
                       WHERE keyed.concurrency_key IS NOT NULL
                     ), 0)::integer AS highest_key_active
                FROM (
                  SELECT active.concurrency_key, count(*)::integer AS key_active
                    FROM workhorse.task_runtime active
                   WHERE active.state = 'active'
                     AND active.queue_name = policy.queue_name
                     AND active.expires_at > clock_timestamp()
                   GROUP BY active.concurrency_key
                ) keyed
            ) usage
            CROSS JOIN LATERAL (
              SELECT count(*) FILTER (
                       WHERE usage.active >= policy.max_active
                          OR (
                            policy.max_active_per_key IS NOT NULL
                            AND sample.concurrency_key IS NOT NULL
                            AND COALESCE(sample.key_active, 0) >= policy.max_active_per_key
                          )
                     )::integer AS blocked_ready,
                     count(*) > 100 AS sample_capped
                FROM (
                  SELECT ready.concurrency_key,
                         (SELECT count(*)::integer
                            FROM workhorse.task_runtime active
                           WHERE active.state = 'active'
                             AND active.queue_name = policy.queue_name
                             AND active.concurrency_key = ready.concurrency_key
                             AND active.expires_at > clock_timestamp()) AS key_active
                    FROM workhorse.task_runtime ready
                   WHERE ready.state = 'ready' AND ready.queue_name = policy.queue_name
                   ORDER BY ready.sequence, ready.task_id
                   LIMIT 101
                ) sample
            ) blocked
           ORDER BY policy.queue_name
           LIMIT 100
        ), rate_limits AS (
        WITH observed AS (
          SELECT clock_timestamp() AS now
        ), policies AS MATERIALIZED (
          SELECT policy.* FROM workhorse.rate_limit_policy policy
           WHERE cardinality(ARRAY[]::text[]) = 0 OR policy.queue_name = ANY(ARRAY[]::text[])
           ORDER BY policy.queue_name LIMIT 101
        ), queue_status AS (
          SELECT policy.*, observed.now,
                 GREATEST(observed.now, COALESCE(bucket.refilled_at, observed.now))
                   AS refill_baseline,
                 LEAST(policy.rate_burst::numeric, COALESCE(bucket.tokens, policy.rate_burst::numeric))
                   AS available_tokens
            FROM policies policy CROSS JOIN observed
            CROSS JOIN LATERAL (
              SELECT max(shard_row.refilled_at) AS refilled_at,
                     sum(LEAST(shard_row.share::numeric, COALESCE(
                       shard_row.tokens + GREATEST(
                         0::numeric,
                         extract(epoch FROM observed.now - shard_row.refilled_at) * 1000
                       ) * policy.rate_limit::numeric * shard_row.share
                         / (policy.rate_interval_ms::numeric * policy.rate_burst),
                       shard_row.share::numeric
                     ))) AS tokens
                FROM (
                  SELECT stored.tokens, stored.refilled_at,
                         policy.rate_burst / count(*) OVER ()
                           + ((row_number() OVER (ORDER BY stored.shard) - 1)
                              < policy.rate_burst % count(*) OVER ())::integer AS share
                    FROM workhorse.admission_shard stored
                   WHERE stored.queue_name = policy.queue_name
                ) shard_row
            ) bucket
        )
        SELECT policy.namespace, policy.queue_name, policy.rate_limit,
               policy.rate_interval_ms, policy.rate_burst, policy.per_key_limit,
               policy.per_key_interval_ms, policy.per_key_burst, policy.updated_at,
               policy.available_tokens::text,
               pressure.throttled_ready::text, pressure.throttled_keys::text,
               pressure.next_eligible_at, pressure.sample_capped
               , (SELECT count(*) FROM policies) > 100 AS policy_set_capped
          FROM queue_status policy
          CROSS JOIN LATERAL (
            SELECT count(*) FILTER (WHERE sample.throttled)::integer AS throttled_ready,
                   count(DISTINCT sample.concurrency_key) FILTER (
                     WHERE sample.key_throttled
                   )::integer AS throttled_keys,
                   min(sample.eligible_at) FILTER (WHERE sample.throttled) AS next_eligible_at,
                   count(*) > 100 AS sample_capped
              FROM (
                SELECT ready.concurrency_key,
                       policy.available_tokens < 1 OR keyed.available_tokens < 1 AS throttled,
                       keyed.available_tokens < 1 AS key_throttled,
                       CASE WHEN policy.available_tokens < 1 OR keyed.available_tokens < 1 THEN
                         GREATEST(
                           CASE WHEN policy.available_tokens < 1 THEN
                             policy.refill_baseline + make_interval(
                             secs => CEIL(
                               (1 - policy.available_tokens) * policy.rate_interval_ms::numeric
                               / policy.rate_limit::numeric
                             )::double precision / 1000
                           ) END,
                           CASE WHEN keyed.available_tokens < 1 THEN
                             keyed.refill_baseline + make_interval(
                             secs => CEIL(
                               (1 - keyed.available_tokens) * policy.per_key_interval_ms::numeric
                               / policy.per_key_limit::numeric
                             )::double precision / 1000
                           ) END
                         )
                       END AS eligible_at
                  FROM (
                    SELECT runtime.concurrency_key
                      FROM workhorse.task_runtime runtime
                     WHERE runtime.state = 'ready' AND runtime.queue_name = policy.queue_name
                     ORDER BY runtime.sequence, runtime.task_id LIMIT 101
                  ) ready
                  CROSS JOIN LATERAL (
                    SELECT CASE
                      WHEN policy.per_key_limit IS NULL OR ready.concurrency_key IS NULL THEN 1
                      ELSE LEAST(policy.per_key_burst::numeric, COALESCE(
                        bucket.tokens + GREATEST(
                          0::numeric,
                          extract(epoch FROM policy.now - bucket.refilled_at) * 1000
                        ) * policy.per_key_limit::numeric / policy.per_key_interval_ms::numeric,
                        policy.per_key_burst::numeric
                      ))
                    END AS available_tokens,
                    CASE
                      WHEN policy.per_key_limit IS NULL OR ready.concurrency_key IS NULL
                        THEN policy.now
                      ELSE GREATEST(policy.now, COALESCE(bucket.refilled_at, policy.now))
                    END AS refill_baseline
                    FROM (SELECT true) present
                    LEFT JOIN workhorse.rate_limit_bucket bucket
                      ON bucket.queue_name = policy.queue_name
                     AND bucket.bucket_scope = 'key'
                     AND bucket.bucket_key = ready.concurrency_key
                  ) keyed
              ) sample
          ) pressure
         ORDER BY policy.queue_name LIMIT 100
        ), budget_policies AS (
          SELECT * FROM workhorse.budget_status_v1(ARRAY[]::text[])
        ), partition_days AS (
          -- Workhorse demands prepared storage for today and the three days after it. Preparation
          -- covers a longer horizon so this window can never outrun it; see
          -- history_partition_horizon_days_v1 before changing the three days here.
          SELECT to_char(day_start, 'YYYYMMDD') AS day, day_start AS starts_at,
                 to_regclass(format('workhorse.%I', 'task_event_' || to_char(day_start, 'YYYYMMDD')))
                   IS NOT NULL AS has_task_events,
                 to_regclass(format('workhorse.%I', 'attempt_history_' || to_char(day_start, 'YYYYMMDD')))
                   IS NOT NULL AS has_attempt_history
            FROM generate_series(
              date_trunc('day', clock_timestamp() AT TIME ZONE 'UTC'),
              date_trunc('day', clock_timestamp() AT TIME ZONE 'UTC') + interval '3 days',
              interval '1 day'
            ) day_start
        )
        SELECT now() AS captured_at,
               installed.schema_version,
               depth.*, terminal.*, dependencies.*, children.*, external_waits.*, retention.*, rollup.*,
               (SELECT COALESCE(jsonb_agg(to_jsonb(c.*) ORDER BY c.queue_name), '[]'::jsonb)
                  FROM concurrency c) AS concurrency_policies,
               (SELECT COALESCE(jsonb_agg(to_jsonb(r.*) ORDER BY r.queue_name), '[]'::jsonb)
                  FROM rate_limits r) AS rate_limit_policies,
               (SELECT COALESCE(jsonb_agg(to_jsonb(b.*) ORDER BY b.budget_name), '[]'::jsonb)
                  FROM budget_policies b) AS budget_policies,
               (SELECT jsonb_agg(to_jsonb(p.*) ORDER BY p.starts_at)
                  FROM partition_days p) AS history_partition_days,
               -- Set while terminal cleanup ends its passes with a full batch, so it is behind.
               (SELECT terminal_cleanup_backlog_since FROM workhorse.maintenance_state
                 WHERE routine_name = 'terminal_storage') AS terminal_cleanup_backlog_since
          FROM installed
          CROSS JOIN depth
          CROSS JOIN terminal
          CROSS JOIN dependencies
          CROSS JOIN children
          CROSS JOIN external_waits
          CROSS JOIN retention
          CROSS JOIN rollup
    ) snapshot
    CROSS JOIN workhorse.queue_health_policy policy
   WHERE policy.singleton;

  SELECT jsonb_build_object(
           'relations', COALESCE((
             SELECT jsonb_agg(to_jsonb(relation_row) ORDER BY relation_row.relation)
               FROM (
                 SELECT parent.relname AS relation,
                        sum(pg_total_relation_size(COALESCE(tree.relid, parent.oid)))::text
                          AS total_bytes,
                        sum(pg_relation_size(COALESCE(tree.relid, parent.oid)))::text AS table_bytes,
                        sum(pg_indexes_size(COALESCE(tree.relid, parent.oid)))::text AS index_bytes,
                        sum(COALESCE(statistics.n_live_tup, 0))::text AS live_tuples,
                        sum(COALESCE(statistics.n_dead_tup, 0))::text AS dead_tuples,
                        sum(COALESCE(statistics.n_mod_since_analyze, 0))::text
                          AS modifications_since_analyze,
                        CASE WHEN sum(COALESCE(statistics.n_tup_upd, 0)) = 0 THEN NULL
                             ELSE sum(statistics.n_tup_hot_upd)::double precision
                               / sum(statistics.n_tup_upd) END AS hot_update_ratio,
                        max(statistics.last_vacuum) AS last_vacuum,
                        max(statistics.last_autovacuum) AS last_autovacuum,
                        count(*) FILTER (
                          WHERE tree.relid IS NOT NULL AND tree.relid <> parent.oid
                        )::text AS partitions
                   FROM pg_class parent
                   JOIN pg_namespace namespace ON namespace.oid = parent.relnamespace
                   LEFT JOIN LATERAL pg_partition_tree(parent.oid) tree ON true
                   LEFT JOIN pg_stat_user_tables statistics
                     ON statistics.relid = COALESCE(tree.relid, parent.oid)
                  WHERE namespace.nspname = 'workhorse'
                    AND parent.relkind IN ('r', 'p')
                    AND parent.relispartition = false
                  GROUP BY parent.relname, parent.oid
               ) relation_row
           ), '[]'::jsonb),
           'oldest_transaction_age_ms', activity.age_ms,
           'lock_wait_count', activity.lock_wait_count,
           'notification_queue_usage', pg_notification_queue_usage()
         )
    INTO v_observations
    FROM (
      SELECT extract(epoch FROM clock_timestamp() - min(xact_start)) * 1000 AS age_ms,
             count(*) FILTER (WHERE wait_event_type = 'Lock')::text AS lock_wait_count
        FROM pg_stat_activity
       WHERE pid <> pg_backend_pid()
    ) activity;

  RETURN v_document || jsonb_build_object('observations', v_observations);
END;
$$;
