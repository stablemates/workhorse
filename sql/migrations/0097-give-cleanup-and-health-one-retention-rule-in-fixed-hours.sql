-- workhorse-migration: {"kind":"additive"}

-- Give terminal cleanup and queue health one retention rule, bound the work of both, measure each
-- retention window in fixed hours, and report failing maintenance and schedules (ADR 0122).
--
-- prune_full_terminal_tasks_internal_v1 locked the oldest terminal tasks and only then removed each
-- task that a schedule occurrence, an enqueue key, a dependency edge, or a young child keeps. When
-- each locked task had such a reference, the batch deleted nothing, and the next pass locked the
-- same rows (SM-1935). Each full and fast batch now examines one slice of the outcome retention
-- index, terminal_prune_slice_rows_internal_v1(p_limit) rows: four times the limit, at least 1,000,
-- at most 100,000. The new table terminal_prune_position stores two walks for each tier. The main
-- walk starts after its position and continues from the oldest row at the end of the rows past the
-- cutoffs. While the main walk has a position, the batch after each main batch that deleted rows
-- uses the sweep walk, which starts after its own position and stops at the main position. read_terminal_prune_slice_internal_v1 and
-- store_terminal_prune_slice_internal_v1 read and store the slices. The new
-- terminal_row_kept_internal_v1 tests the references of each row of the slice, one call for each
-- row, so the batch locks only rows that it can delete. A later statement still rechecks the locked
-- rows with a snapshot from after the locks (SM-1665). The batch deletes no key and no edge. When a
-- batch deletes the last target of a redrive source, it deletes that source with the rest of its
-- limit. A batch that deletes nothing reports dependency_starved when a dependency edge keeps a
-- prerequisite of its slice that passes each cutoff. prune_terminal_storage_v1 keeps the order of its phases. A pass
-- repeats batches while a batch fills or a main position remains, for at most one second. It
-- records a backlog when it ends that way after it deleted rows.
--
-- The key phase and the released-edge phase delete a reference before the terminal phase reaches
-- its task. prune_enqueue_idempotency_v1 and prune_released_dependencies_v1 now write the end of
-- that hold to the new nullable column task_outcome.held_until, in the statement that deletes the
-- reference, when the new terminal_hold_end_internal_v1 gives it for one lag: the hold ends after
-- the retention anchor of the task plus the window of that lag. queue_health_v1 uses the same
-- function. The phases look up each outcome and task by primary key and take the outcome with SKIP
-- LOCKED, so they never wait. If another transaction holds the outcome, the reference stays for a
-- later pass. A reference that went before this migration left a null value. A cleanup batch that
-- deletes the last target of a redrive source continues down the chain while it has room.
--
-- Each other statement that removes a reference that a health gate skips saves the end of that hold
-- through the new save_terminal_hold_ends_internal_v1, when the end moves a due instant. These are
-- enqueue_batch_v1 when an enqueue reuses an expired key, prune_schedule_occurrences_v1,
-- purge_queue_internal_v1, maintain_task_groups_v1 when it deletes a finished group, and the
-- cleanup batches when a delete cascades a child edge, a dependency edge, or a redrive edge. The
-- write takes the outcome with SKIP LOCKED. A maintenance statement keeps the reference while
-- another transaction holds the outcome. An enqueue or a purge continues without the write. A sweep
-- batch that fills its limit keeps its position also in a short slice.
--
-- queue_health_v1 counted a row as retention lag although cleanup keeps it on purpose: a redrive
-- source with a target, a prerequisite of a live dependent, a parent of a child that is not yet
-- eligible, a task of an unexpired schedule occurrence, and a task of an unexpired enqueue key
-- (SM-1852). The new function terminal_retention_boundaries_internal_v1 skips those rows and the
-- members of an unfinished task group, through terminal_row_held_internal_v1. It counts the rows
-- that cleanup or history retention is late to release: a runtime row, history rows, and an expired
-- occurrence. A row is due at the
-- latest of its row window, the history pass that releases it, and the end of each hold that ended,
-- as terminal_row_due_at_internal_v1 computes.
--
-- The health cutoffs read clock_timestamp(), which is volatile, so PostgreSQL tested each index row
-- in a filter, and each poll read every task and terminal outcome (SM-1936). queue_health_v1 now
-- reads the clock one time and gives it to the new function as a parameter. Each step of a walk
-- reads one index row in order, with the cutoff in its index condition. Each walk stops at the
-- history watermark, at the first row that cannot be due before the earliest due instant, and after
-- terminal_retention_walk_rows_internal_v1() rows (1,000). A held watermark, the members of finished
-- groups, and the rows that a hold keeps therefore do not make a poll read more rows (SM-1990).
--
-- Each retention cutoff computed N days as make_interval(days => N). PostgreSQL steps those days in
-- the session TimeZone, so across a daylight-saving change the window was one hour longer or
-- shorter, and the result depended on the session. Each retention window is now N times 24 hours:
-- in queue_health_v1, retain_history_v1, prune_terminal_storage_v1, sync_retention_policy_v1,
-- override_retention_policy_v1, prune_enqueue_idempotency_v1, rollup_stats_v1, and
-- dashboard_retention_preview_v1. In a UTC session the results do not change.
--
-- evaluate_queue_health_v1 adds two degraded reasons (SM-1992). maintenance-failing names a routine
-- whose newest three recorded runs failed one after another after its last completion.
-- schedule-failing counts the enabled schedules whose last schedule pass stored an error. queue_health_v1 adds the document
-- keys failing_maintenance_routines, failing_schedule_definitions, and
-- failing_schedule_definitions_capped.
--
-- Each function keeps its name, its arguments, and its result type under ADR 0109. queue_health_v1
-- keeps the keys of its document and adds three. The new table, the new column, and the thirteen
-- new functions are internal and only add. The migration rewrites no row. The SDK floor does not change.

ALTER TABLE workhorse.task_outcome
  ADD COLUMN IF NOT EXISTS held_until timestamptz;

CREATE TABLE IF NOT EXISTS workhorse.terminal_prune_position (
  tier text PRIMARY KEY CHECK (tier IN ('full', 'fast')),
  finished_at timestamptz,
  task_id uuid,
  quiet_finished_at timestamptz,
  quiet_task_id uuid,
  sweep_finished_at timestamptz,
  sweep_task_id uuid,
  sweep_next boolean NOT NULL DEFAULT false,
  CHECK ((finished_at IS NULL) = (task_id IS NULL)),
  CHECK ((quiet_finished_at IS NULL) = (quiet_task_id IS NULL)),
  CHECK ((sweep_finished_at IS NULL) = (sweep_task_id IS NULL))
);

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
    -- A routine whose newest three recorded runs failed, with no completion since (SM-1992). Two
    -- failed runs in a row do not change the verdict.
    SELECT 150 + routine.ordinality::integer, jsonb_build_object(
      'code', 'maintenance-failing', 'severity', 'degraded',
      'observed', (routine.value->>'failed_runs')::numeric, 'budget', 2,
      'routine', routine.value->>'routine_name'
    ) FROM jsonb_array_elements(COALESCE(p_snapshot->'failing_maintenance_routines', '[]'::jsonb))
      WITH ORDINALITY routine(value, ordinality)
    WHERE (routine.value->>'failed_runs')::numeric > 2
    UNION ALL
    -- An enabled schedule whose last schedule pass failed. The error stays until a pass fires the
    -- definition, so one failed pass raises the reason at once (SM-1992).
    SELECT 160, jsonb_build_object(
      'code', 'schedule-failing', 'severity', 'degraded',
      'observed', (p_snapshot->>'failing_schedule_definitions')::numeric, 'budget', 0
    ) WHERE (p_snapshot->>'failing_schedule_definitions')::numeric > 0
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

CREATE OR REPLACE FUNCTION workhorse.history_pass_due_at_internal_v1(
  p_at timestamptz, p_timezone text, p_local_time time
) RETURNS timestamptz
LANGUAGE sql
STABLE
PARALLEL SAFE
AS $$
  SELECT CASE
           WHEN ((p_at AT TIME ZONE p_timezone)::date + p_local_time) AT TIME ZONE p_timezone >= p_at
             THEN ((p_at AT TIME ZONE p_timezone)::date + p_local_time) AT TIME ZONE p_timezone
           ELSE ((p_at AT TIME ZONE p_timezone)::date + 1 + p_local_time) AT TIME ZONE p_timezone
         END;
$$;

CREATE OR REPLACE FUNCTION workhorse.history_release_due_at_internal_v1(
  p_history_through_at timestamptz, p_history_window interval, p_timezone text,
  p_local_time time
) RETURNS timestamptz
LANGUAGE sql
STABLE
PARALLEL SAFE
AS $$
  SELECT workhorse.history_pass_due_at_internal_v1(
    (date_trunc('day', (p_history_through_at + p_history_window) AT TIME ZONE 'UTC')
      + interval '1 day') AT TIME ZONE 'UTC',
    p_timezone, p_local_time
  );
$$;

CREATE OR REPLACE FUNCTION workhorse.terminal_row_held_internal_v1(
  p_task_id uuid, p_now timestamptz, p_identity_before timestamptz,
  p_outcome_before timestamptz, p_history_before timestamptz, p_occurrence_window interval
) RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT EXISTS (
           SELECT 1 FROM workhorse.task_redrive redrive WHERE redrive.source_task_id = p_task_id
         )
      OR EXISTS (
           SELECT 1
             FROM workhorse.task_group_member member
             JOIN workhorse.task_group member_group ON member_group.id = member.group_id
            WHERE member.task_id = p_task_id AND member_group.state <> 'finished'
         )
      OR EXISTS (
           SELECT 1 FROM workhorse.task_dependency dependency
            WHERE dependency.prerequisite_task_id = p_task_id
              AND NOT EXISTS (
                SELECT 1 FROM workhorse.task_outcome dependent
                 WHERE dependent.task_id = dependency.dependent_task_id
              )
         )
      OR EXISTS (
           SELECT 1
             FROM workhorse.task_child edge
             JOIN workhorse.task child ON child.id = edge.child_task_id
             LEFT JOIN workhorse.task_outcome child_outcome
               ON child_outcome.task_id = edge.child_task_id
            WHERE edge.parent_task_id = p_task_id
              AND (
                child_outcome.task_id IS NULL
                OR child.created_at >= p_identity_before
                OR child_outcome.finished_at >= p_outcome_before
                OR child_outcome.history_through_at >= p_history_before
              )
         )
      OR EXISTS (
           SELECT 1 FROM workhorse.schedule_occurrence occurrence
            WHERE occurrence.task_id = p_task_id
              AND (
                p_occurrence_window IS NULL
                OR occurrence.occurrence_at >= p_now - p_occurrence_window
              )
         )
      OR EXISTS (
           SELECT 1 FROM workhorse.enqueue_idempotency idempotency
            WHERE idempotency.task_id = p_task_id AND idempotency.expires_at > p_now
         );
$$;

CREATE OR REPLACE FUNCTION workhorse.terminal_hold_end_internal_v1(
  p_hold_end timestamptz, p_window_end timestamptz
) RETURNS timestamptz
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT CASE WHEN p_window_end IS NULL OR p_hold_end > p_window_end THEN p_hold_end END;
$$;

CREATE OR REPLACE FUNCTION workhorse.terminal_child_hold_end_internal_v1(p_child_task_id uuid)
RETURNS timestamptz
LANGUAGE sql
STABLE
AS $$
  SELECT GREATEST(
           child.created_at + make_interval(hours => 24 * policy.task_identity_retention_days),
           child_outcome.finished_at
             + make_interval(hours => 24 * policy.terminal_outcome_retention_days),
           workhorse.history_release_due_at_internal_v1(
             child_outcome.history_through_at,
             make_interval(hours => 24 * GREATEST(
               COALESCE(policy.task_event_retention_days, 0),
               COALESCE(policy.attempt_history_retention_days, 0)
             )),
             maintenance.timezone, maintenance.history_retention_local_time
           )
         )
    FROM workhorse.task child
    JOIN workhorse.task_outcome child_outcome ON child_outcome.task_id = child.id
    CROSS JOIN workhorse.retention_policy policy
    CROSS JOIN workhorse.maintenance_policy maintenance
   WHERE child.id = p_child_task_id AND policy.singleton AND maintenance.singleton
     AND policy.task_identity_retention_days IS NOT NULL
     AND policy.terminal_outcome_retention_days IS NOT NULL;
$$;

CREATE OR REPLACE FUNCTION workhorse.save_terminal_hold_ends_internal_v1(
  p_task_ids uuid[], p_hold_ends timestamptz[]
) RETURNS uuid[]
LANGUAGE plpgsql
AS $$
DECLARE v_identity_window interval;
DECLARE v_outcome_window interval;
DECLARE v_needed uuid[];
DECLARE v_ends timestamptz[];
DECLARE v_locked uuid[];
BEGIN
  IF p_task_ids IS NULL OR cardinality(p_task_ids) = 0 THEN
    RETURN '{}'::uuid[];
  END IF;
  SELECT make_interval(hours => 24 * policy.task_identity_retention_days),
         make_interval(hours => 24 * policy.terminal_outcome_retention_days)
    INTO v_identity_window, v_outcome_window
    FROM workhorse.retention_policy policy WHERE policy.singleton;
  SELECT COALESCE(array_agg(ended.task_id ORDER BY ended.task_id), '{}'::uuid[]),
         COALESCE(array_agg(ended.at ORDER BY ended.task_id), '{}'::timestamptz[])
    INTO v_needed, v_ends
    FROM (
      SELECT hold.task_id, max(hold.at) AS at
        FROM unnest(p_task_ids, p_hold_ends) AS hold(task_id, at)
       WHERE hold.task_id IS NOT NULL AND hold.at IS NOT NULL
       GROUP BY hold.task_id
    ) ended
    CROSS JOIN LATERAL (
      SELECT outcome.finished_at, outcome.held_until FROM workhorse.task_outcome outcome
       WHERE outcome.task_id = ended.task_id LIMIT 1
    ) terminal
    CROSS JOIN LATERAL (
      SELECT task.created_at FROM workhorse.task task WHERE task.id = ended.task_id LIMIT 1
    ) identity
   WHERE (terminal.held_until IS NULL OR terminal.held_until < ended.at)
     AND COALESCE(
           workhorse.terminal_hold_end_internal_v1(
             ended.at, identity.created_at + v_identity_window
           ),
           workhorse.terminal_hold_end_internal_v1(
             ended.at, terminal.finished_at + v_outcome_window
           )
         ) IS NOT NULL;
  IF cardinality(v_needed) = 0 THEN
    RETURN '{}'::uuid[];
  END IF;
  SELECT COALESCE(array_agg(locked.task_id), '{}'::uuid[])
    INTO v_locked
    FROM (
      SELECT outcome.task_id
        FROM workhorse.task_outcome outcome
       WHERE outcome.task_id = ANY(v_needed)
       ORDER BY outcome.task_id
         FOR NO KEY UPDATE OF outcome SKIP LOCKED
    ) locked;
  IF cardinality(v_locked) > 0 THEN
    UPDATE workhorse.task_outcome outcome
       SET held_until = GREATEST(outcome.held_until, ended.at)
      FROM unnest(v_needed, v_ends) AS ended(task_id, at)
     WHERE outcome.task_id = ANY(v_locked)
       AND ended.task_id = outcome.task_id;
  END IF;
  RETURN ARRAY(
    SELECT needed.task_id FROM unnest(v_needed) AS needed(task_id)
     WHERE NOT needed.task_id = ANY(v_locked)
     ORDER BY needed.task_id
  );
END;
$$;

CREATE OR REPLACE FUNCTION workhorse.terminal_row_due_at_internal_v1(
  p_task_id uuid, p_window_end timestamptz, p_history_through_at timestamptz,
  p_identity_window interval, p_outcome_window interval, p_history_window interval,
  p_occurrence_window interval, p_timezone text, p_local_time time
) RETURNS timestamptz
LANGUAGE sql
STABLE
AS $$
  SELECT GREATEST(
    p_window_end,
    workhorse.history_release_due_at_internal_v1(
      p_history_through_at, p_history_window, p_timezone, p_local_time
    ),
    (SELECT workhorse.terminal_hold_end_internal_v1(outcome.held_until, p_window_end)
       FROM workhorse.task_outcome outcome
      WHERE outcome.task_id = p_task_id),
    (SELECT member_group.finished_at
       FROM workhorse.task_group_member member
       JOIN workhorse.task_group member_group ON member_group.id = member.group_id
      WHERE member.task_id = p_task_id),
    (SELECT max(idempotency.expires_at) FROM workhorse.enqueue_idempotency idempotency
      WHERE idempotency.task_id = p_task_id),
    (SELECT max(workhorse.history_pass_due_at_internal_v1(
              occurrence.occurrence_at + p_occurrence_window, p_timezone, p_local_time
            ))
       FROM workhorse.schedule_occurrence occurrence
      WHERE occurrence.task_id = p_task_id),
    (SELECT max(dependent.finished_at)
       FROM workhorse.task_dependency dependency
       JOIN workhorse.task_outcome dependent ON dependent.task_id = dependency.dependent_task_id
      WHERE dependency.prerequisite_task_id = p_task_id),
    (SELECT max(GREATEST(
              child.created_at + p_identity_window,
              child_outcome.finished_at + p_outcome_window,
              workhorse.history_release_due_at_internal_v1(
                child_outcome.history_through_at, p_history_window, p_timezone, p_local_time
              )
            ))
       FROM workhorse.task_child edge
       JOIN workhorse.task child ON child.id = edge.child_task_id
       JOIN workhorse.task_outcome child_outcome ON child_outcome.task_id = edge.child_task_id
      WHERE edge.parent_task_id = p_task_id)
  );
$$;

CREATE OR REPLACE FUNCTION workhorse.terminal_retention_walk_rows_internal_v1()
RETURNS integer
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT 1000;
$$;

CREATE OR REPLACE FUNCTION workhorse.terminal_retention_boundaries_internal_v1(
  p_now timestamptz
) RETURNS TABLE (
  eligible_task_identity_at timestamptz,
  task_identity_due_at timestamptz,
  eligible_terminal_outcome_at timestamptz,
  terminal_outcome_due_at timestamptz
)
LANGUAGE sql
STABLE
AS $$
  WITH RECURSIVE settings AS (
    -- The LIMIT 1 is a planner fact, not a rule. It keeps the estimate of this singleton at one row.
    SELECT make_interval(hours => 24 * policy.task_identity_retention_days) AS identity_window,
           make_interval(hours => 24 * policy.terminal_outcome_retention_days) AS outcome_window,
           p_now - make_interval(hours => 24 * policy.task_identity_retention_days)
             AS identity_before,
           p_now - make_interval(hours => 24 * policy.terminal_outcome_retention_days)
             AS outcome_before,
           state.history_retained_before AS history_before,
           make_interval(hours => 24 * GREATEST(
             COALESCE(policy.task_event_retention_days, 0),
             COALESCE(policy.attempt_history_retention_days, 0)
           )) AS history_window,
           make_interval(hours => 24 * policy.schedule_occurrence_retention_days)
             AS occurrence_window,
           maintenance.timezone, maintenance.history_retention_local_time AS pass_time
      FROM workhorse.retention_policy policy
      CROSS JOIN workhorse.maintenance_policy maintenance
      CROSS JOIN workhorse.maintenance_state state
     WHERE policy.singleton AND maintenance.singleton
       AND state.routine_name = 'history_retention'
       AND policy.task_identity_retention_days IS NOT NULL
       AND policy.terminal_outcome_retention_days IS NOT NULL
       AND state.history_retained_before IS NOT NULL
     LIMIT 1
  ), identity_walk(created_at, task_id, due_at, eligible_at, examined) AS (
    SELECT '-infinity'::timestamptz, '00000000-0000-0000-0000-000000000000'::uuid,
           'infinity'::timestamptz, NULL::timestamptz, 0
    UNION ALL
    SELECT step.created_at, step.task_id,
           CASE WHEN due.at IS NULL THEN walk.due_at ELSE LEAST(walk.due_at, due.at) END,
           COALESCE(walk.eligible_at, CASE WHEN due.at IS NOT NULL THEN step.created_at END),
           walk.examined + 1
      FROM identity_walk walk
      CROSS JOIN settings
      CROSS JOIN LATERAL (
        SELECT task.created_at, task.id AS task_id
          FROM workhorse.task task
         WHERE (task.created_at, task.id) > (walk.created_at, walk.task_id)
           AND task.created_at < LEAST(
             settings.identity_before, settings.history_before,
             walk.due_at - settings.identity_window
           )
         ORDER BY task.created_at, task.id
         LIMIT 1
      ) step
      LEFT JOIN LATERAL (
        SELECT terminal.finished_at, terminal.history_through_at
          FROM workhorse.task_outcome terminal
         WHERE terminal.task_id = step.task_id
        UNION ALL
        -- A fast-tier outcome has no history boundary of its own. Its history rows, if the queue
        -- recorded any, end when it finished.
        SELECT fast.finished_at, fast.finished_at
          FROM workhorse.fast_task_outcome fast
         WHERE fast.task_id = step.task_id
         LIMIT 1
      ) outcome ON true
      CROSS JOIN LATERAL (
        SELECT CASE WHEN outcome.finished_at < settings.outcome_before
                     AND outcome.history_through_at < settings.history_before
                     AND workhorse.terminal_row_held_internal_v1(
                           step.task_id, p_now, settings.identity_before,
                           settings.outcome_before, settings.history_before,
                           settings.occurrence_window
                         ) IS FALSE
                  THEN workhorse.terminal_row_due_at_internal_v1(
                         step.task_id, step.created_at + settings.identity_window,
                         outcome.history_through_at, settings.identity_window,
                         settings.outcome_window, settings.history_window,
                         settings.occurrence_window, settings.timezone, settings.pass_time
                       ) END AS at
      ) due
     -- The history of a row is at or after its anchor, so the pass that releases the anchor is a
     -- lower bound of its due instant. That bound grows with the anchor. If it is not earlier than
     -- the earliest due instant, no later row can be earlier, and the walk stops.
     WHERE walk.examined < workhorse.terminal_retention_walk_rows_internal_v1()
       AND workhorse.history_release_due_at_internal_v1(
             step.created_at, settings.history_window, settings.timezone, settings.pass_time
           ) < walk.due_at
  ), outcome_walk(finished_at, task_id, due_at, eligible_at, examined) AS (
    SELECT '-infinity'::timestamptz, '00000000-0000-0000-0000-000000000000'::uuid,
           'infinity'::timestamptz, NULL::timestamptz, 0
    UNION ALL
    SELECT step.finished_at, step.task_id,
           CASE WHEN due.at IS NULL THEN walk.due_at ELSE LEAST(walk.due_at, due.at) END,
           COALESCE(walk.eligible_at, CASE WHEN due.at IS NOT NULL THEN step.finished_at END),
           walk.examined + 1
      FROM outcome_walk walk
      CROSS JOIN settings
      CROSS JOIN LATERAL (
        SELECT terminal.finished_at, terminal.task_id, terminal.history_through_at
          FROM (
            SELECT outcome.finished_at, outcome.task_id, outcome.history_through_at
              FROM workhorse.task_outcome outcome
             WHERE (outcome.finished_at, outcome.task_id) > (walk.finished_at, walk.task_id)
               AND outcome.finished_at < LEAST(
                 settings.outcome_before, settings.history_before,
                 walk.due_at - settings.outcome_window
               )
             ORDER BY outcome.finished_at, outcome.task_id
             LIMIT 1
          ) terminal
        UNION ALL
        SELECT fast.finished_at, fast.task_id, fast.finished_at
          FROM (
            SELECT outcome.finished_at, outcome.task_id
              FROM workhorse.fast_task_outcome outcome
             WHERE (outcome.finished_at, outcome.task_id) > (walk.finished_at, walk.task_id)
               AND outcome.finished_at < LEAST(
                 settings.outcome_before, settings.history_before,
                 walk.due_at - settings.outcome_window
               )
             ORDER BY outcome.finished_at, outcome.task_id
             LIMIT 1
          ) fast
         ORDER BY 1, 2
         LIMIT 1
      ) step
      CROSS JOIN LATERAL (
        SELECT task.created_at FROM workhorse.task task WHERE task.id = step.task_id LIMIT 1
      ) identity
      CROSS JOIN LATERAL (
        SELECT CASE WHEN identity.created_at < settings.identity_before
                     AND step.history_through_at < settings.history_before
                     AND workhorse.terminal_row_held_internal_v1(
                           step.task_id, p_now, settings.identity_before,
                           settings.outcome_before, settings.history_before,
                           settings.occurrence_window
                         ) IS FALSE
                  THEN workhorse.terminal_row_due_at_internal_v1(
                         step.task_id, step.finished_at + settings.outcome_window,
                         step.history_through_at, settings.identity_window,
                         settings.outcome_window, settings.history_window,
                         settings.occurrence_window, settings.timezone, settings.pass_time
                       ) END AS at
      ) due
     WHERE walk.examined < workhorse.terminal_retention_walk_rows_internal_v1()
       AND workhorse.history_release_due_at_internal_v1(
             step.finished_at, settings.history_window, settings.timezone, settings.pass_time
           ) < walk.due_at
  )
  SELECT (SELECT min(eligible_at) FROM identity_walk),
         (SELECT min(due_at) FROM identity_walk WHERE eligible_at IS NOT NULL),
         (SELECT min(eligible_at) FROM outcome_walk),
         (SELECT min(due_at) FROM outcome_walk WHERE eligible_at IS NOT NULL);
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
  -- The retention part reads the clock one time. A cutoff from a variable is a constant for each
  -- scan, so the planner can use it as an index condition (SM-1936).
  v_now timestamptz := clock_timestamp();
BEGIN
  SELECT (to_jsonb(snapshot) - 'schedule_occurrence_pass_lag_ms'
           - 'schedule_occurrence_due_lag_ms' - 'task_identity_due_at'
           - 'terminal_outcome_due_at') || jsonb_build_object(
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
              row_boundaries.eligible_task_identity_at,
              row_boundaries.task_identity_due_at,
              row_boundaries.eligible_terminal_outcome_at,
              row_boundaries.terminal_outcome_due_at,
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
            -- terminal_retention_boundaries_internal_v1 applies the holds that terminal cleanup
            -- keeps on purpose, and it finds the earliest due instant of the rows it can delete.
            CROSS JOIN LATERAL workhorse.terminal_retention_boundaries_internal_v1(v_now)
              row_boundaries
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
                  AND upper_bound <= v_now
                    - make_interval(hours => 24 * policy.task_event_retention_days)
                  AND upper_bound <= (
                    date_trunc('day', v_now AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
                  )
              )::text AS eligible_event_partitions,
              count(*) FILTER (
                WHERE parent_name = 'attempt_history'
                  AND policy.attempt_history_retention_days IS NOT NULL
                  AND upper_bound <= v_now
                    - make_interval(hours => 24 * policy.attempt_history_retention_days)
                  AND upper_bound <= (
                    date_trunc('day', v_now AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
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
                 -- Row lag counts from the earliest due instant of a row that cleanup can delete: the
                 -- latest of its row window, the scheduled history pass that released it, and the
                 -- end of each hold that ended. One pass releases a whole day of rows at once, and
                 -- the bounded prune needs time to delete them.
                 CASE WHEN policy.task_identity_retention_days IS NULL
                             OR boundaries.eligible_task_identity_at IS NULL THEN NULL
                      ELSE GREATEST(0, extract(epoch FROM
                        v_now - boundaries.task_identity_due_at) * 1000) END AS task_identity_lag_ms,
                 CASE WHEN policy.terminal_outcome_retention_days IS NULL
                             OR boundaries.eligible_terminal_outcome_at IS NULL THEN NULL
                      ELSE GREATEST(0, extract(epoch FROM
                        v_now - boundaries.terminal_outcome_due_at) * 1000) END
                   AS terminal_outcome_lag_ms,
                 CASE WHEN policy.task_event_retention_days IS NULL
                             OR boundaries.oldest_task_event_at IS NULL THEN NULL
                      ELSE GREATEST(
                        0,
                        COALESCE(extract(epoch FROM
                          date_trunc(
                            'day',
                            (v_now - make_interval(
                              hours => 24 * policy.task_event_retention_days
                            )) AT TIME ZONE 'UTC'
                          ) AT TIME ZONE 'UTC'
                          - boundaries.oldest_partitioned_task_event_at) * 1000, 0),
                        COALESCE(extract(epoch FROM
                          v_now
                          - make_interval(hours => 24 * policy.task_event_retention_days)
                          - boundaries.oldest_default_task_event_at) * 1000, 0)
                      ) END AS task_event_lag_ms,
                 CASE WHEN policy.attempt_history_retention_days IS NULL
                             OR boundaries.oldest_attempt_history_at IS NULL THEN NULL
                      ELSE GREATEST(
                        0,
                        COALESCE(extract(epoch FROM
                          date_trunc(
                            'day',
                            (v_now - make_interval(
                              hours => 24 * policy.attempt_history_retention_days
                            )) AT TIME ZONE 'UTC'
                          ) AT TIME ZONE 'UTC'
                          - boundaries.oldest_partitioned_attempt_history_at) * 1000, 0),
                        COALESCE(extract(epoch FROM
                          v_now
                          - make_interval(hours => 24 * policy.attempt_history_retention_days)
                          - boundaries.oldest_default_attempt_history_at) * 1000, 0)
                      ) END AS attempt_history_lag_ms,
                 CASE WHEN policy.schedule_occurrence_retention_days IS NULL
                             OR boundaries.oldest_schedule_occurrence_at IS NULL THEN NULL
                      ELSE GREATEST(0, extract(epoch FROM
                        v_now
                        - make_interval(hours => 24 * policy.schedule_occurrence_retention_days)
                        - boundaries.oldest_schedule_occurrence_at) * 1000) END
                   AS schedule_occurrence_lag_ms,
                 CASE WHEN policy.schedule_occurrence_retention_days IS NULL
                             OR boundaries.oldest_schedule_occurrence_at_last_pass IS NULL THEN NULL
                      -- A retention change resets completion; earlier passes used another window.
                      WHEN maintenance.last_completed_local_date IS NULL
                           AND maintenance.last_started_at < policy.updated_at THEN 0
                      ELSE GREATEST(0, COALESCE(extract(epoch FROM
                        maintenance.last_started_at
                        - make_interval(hours => 24 * policy.schedule_occurrence_retention_days)
                        - boundaries.oldest_schedule_occurrence_at_last_pass) * 1000, 0)) END
                   AS schedule_occurrence_pass_lag_ms,
                 -- A routine that never ran owes the first scheduled pass after the oldest run
                 -- expired, so its lag keeps growing instead of restarting every day. The
                 -- comparison uses instants because a daylight-saving change can put a scheduled
                 -- time later than an expiry whose local time-of-day is later.
                 CASE WHEN policy.schedule_occurrence_retention_days IS NULL
                             OR boundaries.oldest_schedule_occurrence_at IS NULL THEN NULL
                      ELSE GREATEST(0, extract(epoch FROM
                        v_now - COALESCE(
                          maintenance.next_due_at,
                          workhorse.history_pass_due_at_internal_v1(
                            boundaries.oldest_schedule_occurrence_at + make_interval(
                              hours => 24 * policy.schedule_occurrence_retention_days
                            ),
                            maintenance.timezone, maintenance.history_retention_local_time
                          )
                        )) * 1000) END
                   AS schedule_occurrence_due_lag_ms,
                 CASE WHEN policy.statistics_retention_days IS NULL
                        OR boundaries.oldest_statistics_at IS NULL THEN NULL
                      ELSE GREATEST(0, extract(epoch FROM
                        v_now
                        - make_interval(hours => 24 * policy.statistics_retention_days)
                        - boundaries.oldest_statistics_at) * 1000) END
                   AS statistics_lag_ms,
                 eligible.*, default_rows.*
            FROM policy CROSS JOIN maintenance CROSS JOIN boundaries CROSS JOIN eligible
              CROSS JOIN default_rows
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
                 WHERE routine_name = 'terminal_storage') AS terminal_cleanup_backlog_since,
               -- Each routine whose newest recorded runs failed one after another, with the count
               -- of those failed runs. The count reads only the runs that started after the last
               -- completion of the routine. The tick records a successful run only when it changed
               -- a task, so a failure before an idle success does not count again (SM-1992).
               (SELECT COALESCE(jsonb_agg(jsonb_build_object(
                         'routine_name', failing.routine_name,
                         'failed_runs', failing.failed_runs,
                         'last_failed_at', failing.last_failed_at
                       ) ORDER BY failing.routine_name), '[]'::jsonb)
                  FROM (
                    SELECT state.routine_name, streak.failed_runs, streak.last_failed_at
                      FROM workhorse.maintenance_state state
                      CROSS JOIN LATERAL (
                        SELECT COALESCE(
                                 min(newest.position) FILTER (WHERE newest.outcome <> 'failed') - 1,
                                 count(*)
                               )::integer AS failed_runs,
                               max(newest.started_at) FILTER (WHERE newest.position = 1)
                                 AS last_failed_at
                          FROM (
                            SELECT run.outcome, run.started_at,
                                   row_number() OVER (
                                     ORDER BY run.started_at DESC, run.run_id DESC
                                   ) AS position
                              FROM (
                                SELECT run.outcome, run.started_at, run.run_id
                                  FROM workhorse.maintenance_run run
                                 WHERE run.routine_name = state.routine_name
                                   AND (state.last_completed_at IS NULL
                                        OR run.started_at > state.last_completed_at)
                                 ORDER BY run.started_at DESC, run.run_id DESC
                                 LIMIT 50
                              ) run
                          ) newest
                      ) streak
                     WHERE streak.failed_runs > 0
                       AND (state.last_completed_at IS NULL
                            OR state.last_completed_at < streak.last_failed_at)
                  ) failing) AS failing_maintenance_routines,
               -- Enabled schedules whose last schedule pass stored an error. The next pass that
               -- fires the definition clears the error (migration 0095).
               LEAST(failing_schedules.definitions, 10000)::text AS failing_schedule_definitions,
               failing_schedules.definitions > 10000 AS failing_schedule_definitions_capped
          FROM installed
          CROSS JOIN depth
          CROSS JOIN terminal
          CROSS JOIN dependencies
          CROSS JOIN children
          CROSS JOIN external_waits
          CROSS JOIN retention
          CROSS JOIN rollup
          -- One capped read gives both schedule fields.
          CROSS JOIN LATERAL (
            SELECT count(*) AS definitions FROM (
              SELECT 1 FROM workhorse.schedule_definition definition
               WHERE definition.last_error_at IS NOT NULL
                 AND definition.configured_enabled AND NOT definition.paused
               LIMIT 10001
            ) failing
          ) failing_schedules
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

CREATE OR REPLACE FUNCTION workhorse.prune_schedule_occurrences_v1(
  p_before timestamptz, p_limit integer DEFAULT 10000
) RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  v_count integer;
  v_window interval;
  v_timezone text;
  v_local_time time;
BEGIN
  IF p_before IS NULL THEN RAISE EXCEPTION 'occurrence retention cutoff is required'; END IF;
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 1000000 THEN
    RAISE EXCEPTION 'occurrence prune limit must be between 1 and 1000000';
  END IF;
  SELECT make_interval(hours => 24 * policy.schedule_occurrence_retention_days)
    INTO v_window
    FROM workhorse.retention_policy policy WHERE policy.singleton;
  SELECT maintenance.timezone, maintenance.history_retention_local_time
    INTO v_timezone, v_local_time
    FROM workhorse.maintenance_policy maintenance WHERE maintenance.singleton;

  WITH victims AS MATERIALIZED (
    SELECT occurrence.ctid, occurrence.task_id, occurrence.occurrence_at
      FROM workhorse.schedule_occurrence occurrence
     WHERE occurrence.occurrence_at < p_before
     ORDER BY occurrence.occurrence_at
     LIMIT p_limit
     FOR UPDATE SKIP LOCKED
  ), blocked AS MATERIALIZED (
    SELECT workhorse.save_terminal_hold_ends_internal_v1(
             array_agg(victims.task_id),
             array_agg(workhorse.history_pass_due_at_internal_v1(
               victims.occurrence_at + v_window, v_timezone, v_local_time
             ))
           ) AS task_ids
      FROM victims
  )
  DELETE FROM workhorse.schedule_occurrence occurrence
   USING victims, blocked
   WHERE occurrence.ctid = victims.ctid
     AND (victims.task_id IS NULL OR NOT victims.task_id = ANY(blocked.task_ids));
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

CREATE OR REPLACE FUNCTION workhorse.enqueue_batch_v1(p_requests jsonb)
RETURNS TABLE (ordinal integer, task_id uuid, accepted boolean)
LANGUAGE plpgsql
AS $$
DECLARE
  v_diagnostic text;
  v_count integer;
  v_now timestamptz;
  v_request jsonb;
  v_lock record;
  v_ordinal integer;
  v_queue_name text;
  v_task_type text;
  v_concurrency_key text;
  v_budget_name text;
  v_priority numeric;
  v_payload jsonb;
  v_contract_version text;
  v_payload_max_bytes numeric;
  v_result_max_bytes numeric;
  v_payload_redact_keys text[];
  v_result_redact_keys text[];
  v_trace_context jsonb;
  v_tags text[];
  v_run_at timestamptz;
  v_max_attempts integer;
  v_retry_policy jsonb;
  v_deadline_at timestamptz;
  v_execution_timeout_ms numeric;
  v_dependencies jsonb;
  v_prerequisite_task_ids uuid[];
  v_prerequisite_task_id uuid;
  v_on_success text;
  v_on_failure text;
  v_on_cancellation text;
  v_pending_prerequisites integer;
  v_pending_edges integer;
  v_terminal_prerequisite_id uuid;
  v_terminal_prerequisite_state text;
  v_terminal_action text;
  v_state text;
  v_idempotency jsonb;
  v_key text;
  v_scope text;
  v_key_hash bytea;
  v_key_preview text;
  v_key_digest text;
  v_key_length integer;
  v_ttl_ms numeric;
  v_expires_at timestamptz;
  v_fingerprint jsonb;
  v_fingerprint_tags text[];
  v_request_digest text;
  v_conflicting_fields text[];
  v_stored_fingerprint jsonb;
  v_proposed_task_id uuid;
  v_existing workhorse.enqueue_idempotency%ROWTYPE;
  v_expired_task_id uuid;
  v_expired_at timestamptz;
  v_is_new boolean;
  v_is_keyed boolean;
  v_ready_queues text[] := '{}';
  v_notify_queue text;
  v_fast_queues text[];
  v_is_fast boolean;
  v_fast_feature text;
  v_fast_task workhorse.task;
  v_fast_tasks workhorse.task[] := '{}';
  v_fast_runtime workhorse.fast_task_runtime;
  v_fast_runtimes workhorse.fast_task_runtime[] := '{}';
  v_fast_past_deadline uuid[] := '{}';
  v_fast_task_id uuid;
  v_full_task workhorse.task;
  v_full_tasks workhorse.task[] := '{}';
  v_full_runtime workhorse.task_runtime;
  v_full_runtimes workhorse.task_runtime[] := '{}';
  v_full_enqueued_details jsonb[] := '{}';
  v_full_past_deadline uuid[] := '{}';
  v_edge workhorse.task_dependency;
  v_edges workhorse.task_dependency[] := '{}';
  v_full_task_id uuid;
BEGIN
  IF p_requests IS NULL OR jsonb_typeof(p_requests) <> 'array' THEN
    RAISE EXCEPTION 'requests must be a JSON array';
  END IF;
  v_count := jsonb_array_length(p_requests);
  IF v_count > 1000 THEN
    RAISE EXCEPTION 'enqueue batch exceeds maximum size of 1000';
  END IF;
  -- A queue name has the limit of the policy functions. The check runs before any lock or write,
  -- so a longer name never reaches a queue_control row or a wake-up notification.
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_requests) input(request)
     WHERE octet_length(input.request->>'queue') > 256
  ) THEN
    RAISE EXCEPTION 'queue name must contain at most 256 UTF-8 bytes';
  END IF;

  -- Validate key identities before locking so malformed requests fail predictably, then acquire every
  -- batch key in one deterministic order. This prevents reverse-order overlapping batches from
  -- deadlocking while still serializing new and retained keys through the transaction boundary.
  FOR v_request IN SELECT value FROM jsonb_array_elements(p_requests)
  LOOP
    v_idempotency := v_request->'idempotency';
    IF v_idempotency IS NULL OR v_idempotency = 'null'::jsonb THEN CONTINUE; END IF;
    IF jsonb_typeof(v_idempotency) <> 'object'
       OR v_idempotency - ARRAY['key', 'scope', 'ttlMs'] <> '{}'::jsonb
       OR NOT (v_idempotency ? 'key')
       OR jsonb_typeof(v_idempotency->'key') <> 'string'
       OR (v_idempotency ? 'scope' AND jsonb_typeof(v_idempotency->'scope') <> 'string')
       OR (v_idempotency ? 'ttlMs' AND jsonb_typeof(v_idempotency->'ttlMs') <> 'number') THEN
      RAISE EXCEPTION 'idempotency requires a string key and only optional string scope and numeric ttlMs';
    END IF;
    v_key := v_idempotency->>'key';
    v_scope := COALESCE(v_idempotency->>'scope', 'default');
    v_ttl_ms := COALESCE((v_idempotency->>'ttlMs')::numeric, 86400000);
    IF v_key = '' OR octet_length(v_key) > 512 THEN
      RAISE EXCEPTION 'idempotency key must contain between 1 and 512 UTF-8 bytes';
    END IF;
    IF v_scope = '' OR octet_length(v_scope) > 256 THEN
      RAISE EXCEPTION 'idempotency scope must contain between 1 and 256 UTF-8 bytes';
    END IF;
    IF v_ttl_ms <> trunc(v_ttl_ms) OR v_ttl_ms NOT BETWEEN 1 AND 31536000000 THEN
      RAISE EXCEPTION 'idempotency ttlMs must be an integer between 1 and 31536000000';
    END IF;
  END LOOP;
  FOR v_lock IN
    SELECT locks.scope, locks.key
      FROM (
        SELECT DISTINCT COALESCE(idempotency->>'scope', 'default') AS scope,
               idempotency->>'key' AS key
          FROM jsonb_array_elements(p_requests) AS input(request)
          CROSS JOIN LATERAL (SELECT request->'idempotency' AS idempotency) parsed
         WHERE idempotency IS NOT NULL AND idempotency <> 'null'::jsonb
      ) locks
     ORDER BY locks.scope COLLATE "C", locks.key COLLATE "C"
  LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended(v_lock.scope || chr(31) || v_lock.key, 0));
  END LOOP;

  -- A queue's tier can change only while it holds no live task. The shared tier lock keeps the
  -- tier read here valid until this batch commits, so set_queue_tier_v1 cannot switch a queue
  -- between that read and the insert of its first task.
  v_fast_queues := workhorse.lock_queue_tiers_v1(ARRAY(
    SELECT DISTINCT request->>'queue'
      FROM jsonb_array_elements(p_requests) input(request)
     WHERE COALESCE(request->>'queue', '') <> ''
  ));

  PERFORM workhorse.lock_enqueue_prerequisites_internal_v1(p_requests);

  -- Lock the stored key rows of the batch before the clock read. A purge deletes key rows without
  -- the key advisory lock. Without this lock, the key insert below can wait for that delete to
  -- commit after the clock read, and the new key then expires too early.
  PERFORM 1
    FROM workhorse.enqueue_idempotency identity
   WHERE (identity.idempotency_scope, identity.idempotency_key_hash) IN (
           SELECT DISTINCT COALESCE(input.request->'idempotency'->>'scope', 'default'),
                  workhorse.idempotency_key_hash_v1(
                    COALESCE(input.request->'idempotency'->>'scope', 'default'),
                    input.request->'idempotency'->>'key'
                  )
             FROM jsonb_array_elements(p_requests) input(request)
            WHERE jsonb_typeof(input.request->'idempotency') = 'object'
         )
   ORDER BY identity.idempotency_scope COLLATE "C", identity.idempotency_key_hash
   FOR UPDATE OF identity;

  -- The batch reads its one timestamp after its last lock and before it writes a row. A lock wait
  -- above then cannot move run_at, ready_at, or a key expiry into the past, and the expiry test of
  -- a stored key uses the same instant as the rows that the batch writes.
  v_now := clock_timestamp();

  FOR v_request, v_ordinal IN
    SELECT request, ordinality::integer
      FROM jsonb_array_elements(p_requests) WITH ORDINALITY input(request, ordinality)
     ORDER BY ordinality
  LOOP
    v_queue_name := v_request->>'queue';
    v_task_type := v_request->>'type';
    v_concurrency_key := v_request->>'concurrencyKey';
    v_budget_name := v_request->>'budget';
    v_priority := COALESCE((v_request->>'priority')::numeric, 0);
    v_payload := COALESCE(v_request->'payload', 'null'::jsonb);
    v_contract_version := v_request->>'contractVersion';
    v_payload_max_bytes := COALESCE((v_request->>'payloadMaxBytes')::numeric, 1048576);
    v_result_max_bytes := COALESCE((v_request->>'resultMaxBytes')::numeric, 1048576);
    IF v_contract_version IS NOT NULL
       AND char_length(v_contract_version) NOT BETWEEN 1 AND 100 THEN
      RAISE EXCEPTION 'contractVersion must contain 1 to 100 characters';
    END IF;
    IF v_payload_max_bytes <> trunc(v_payload_max_bytes)
       OR v_payload_max_bytes NOT BETWEEN 1 AND 16777216
       OR v_result_max_bytes <> trunc(v_result_max_bytes)
       OR v_result_max_bytes NOT BETWEEN 1 AND 16777216 THEN
      RAISE EXCEPTION 'payloadMaxBytes and resultMaxBytes must be integers between 1 and 16777216';
    END IF;
    IF octet_length(v_payload::text) > v_payload_max_bytes THEN
      RAISE EXCEPTION 'payload exceeds its configured size limit';
    END IF;
    IF jsonb_typeof(COALESCE(v_request->'sensitivePayloadKeys', '[]'::jsonb)) <> 'array'
       OR jsonb_array_length(COALESCE(v_request->'sensitivePayloadKeys', '[]'::jsonb)) > 50
       OR jsonb_typeof(COALESCE(v_request->'sensitiveResultKeys', '[]'::jsonb)) <> 'array'
       OR jsonb_array_length(COALESCE(v_request->'sensitiveResultKeys', '[]'::jsonb)) > 50
       OR EXISTS (
         SELECT 1
           FROM jsonb_array_elements(
             COALESCE(v_request->'sensitivePayloadKeys', '[]'::jsonb) ||
             COALESCE(v_request->'sensitiveResultKeys', '[]'::jsonb)
           ) key
          WHERE jsonb_typeof(key) <> 'string'
             OR char_length(key #>> '{}') NOT BETWEEN 1 AND 200
       ) THEN
      RAISE EXCEPTION 'sensitive payload and result keys must contain at most 50 strings of 1 to 200 characters';
    END IF;
    v_payload_redact_keys := ARRAY(
      SELECT key
        FROM jsonb_array_elements_text(
          COALESCE(v_request->'sensitivePayloadKeys', '[]'::jsonb)
        ) key
       ORDER BY key COLLATE "C"
    );
    v_result_redact_keys := ARRAY(
      SELECT key
        FROM jsonb_array_elements_text(
          COALESCE(v_request->'sensitiveResultKeys', '[]'::jsonb)
        ) key
       ORDER BY key COLLATE "C"
    );
    IF cardinality(v_payload_redact_keys) <> (
         SELECT count(DISTINCT key) FROM unnest(v_payload_redact_keys) key
       ) OR cardinality(v_result_redact_keys) <> (
         SELECT count(DISTINCT key) FROM unnest(v_result_redact_keys) key
       ) THEN
      RAISE EXCEPTION 'sensitive payload and result keys must contain unique values';
    END IF;
    v_trace_context := v_request->'traceContext';
    IF v_concurrency_key IS NOT NULL AND (
      v_concurrency_key = '' OR octet_length(v_concurrency_key) > 256
    ) THEN
      RAISE EXCEPTION 'concurrencyKey must contain between 1 and 256 UTF-8 bytes';
    END IF;
    IF v_budget_name IS NOT NULL AND (
      v_budget_name = '' OR octet_length(v_budget_name) > 256
    ) THEN
      RAISE EXCEPTION 'budget must contain between 1 and 256 UTF-8 bytes';
    END IF;
    IF v_priority <> trunc(v_priority) OR v_priority NOT BETWEEN 0 AND 100 THEN
      RAISE EXCEPTION 'priority must be an integer between 0 and 100';
    END IF;
    IF COALESCE(v_queue_name, '') = '' OR COALESCE(v_task_type, '') = ''
       OR jsonb_typeof(COALESCE(v_request->'tags', '[]'::jsonb)) <> 'array'
       OR jsonb_array_length(COALESCE(v_request->'tags', '[]'::jsonb)) > 20
       OR EXISTS (
         SELECT 1 FROM jsonb_array_elements(COALESCE(v_request->'tags', '[]'::jsonb)) tag
          WHERE jsonb_typeof(tag) <> 'string' OR tag #>> '{}' = ''
             OR char_length(tag #>> '{}') > 100
       ) THEN
      RAISE EXCEPTION 'each request requires non-empty queue/type, maxAttempts between 1 and 100, and at most 20 non-empty tags of at most 100 characters';
    END IF;
    v_tags := ARRAY(
      SELECT jsonb_array_elements_text(COALESCE(v_request->'tags', '[]'::jsonb))
    );
    IF NOT workhorse.valid_trace_context_v1(v_trace_context) THEN
      RAISE EXCEPTION 'traceContext must contain a string traceparent, optional string tracestate, and at most 1024 UTF-8 bytes';
    END IF;
    v_max_attempts := COALESCE((v_request->>'maxAttempts')::integer, 25);
    IF v_max_attempts NOT BETWEEN 1 AND 100 THEN
      RAISE EXCEPTION 'each request requires non-empty queue/type, maxAttempts between 1 and 100, and at most 20 non-empty tags of at most 100 characters';
    END IF;
    v_retry_policy := workhorse.normalize_retry_policy_v1(v_request->'retryPolicy');
    v_run_at := COALESCE((v_request->>'runAt')::timestamptz, v_now);
    IF NOT isfinite(v_run_at) THEN RAISE EXCEPTION 'runAt must be finite'; END IF;
    v_deadline_at := (v_request->>'deadline')::timestamptz;
    IF v_deadline_at IS NOT NULL AND NOT isfinite(v_deadline_at) THEN
      RAISE EXCEPTION 'deadline must be a finite absolute timestamp';
    END IF;
    v_execution_timeout_ms := (v_request->>'executionTimeoutMs')::numeric;
    IF v_execution_timeout_ms IS NOT NULL AND (
      v_execution_timeout_ms <> trunc(v_execution_timeout_ms)
      OR v_execution_timeout_ms NOT BETWEEN 1 AND 31536000000
    ) THEN
      RAISE EXCEPTION 'executionTimeoutMs must be an integer between 1 and 31536000000';
    END IF;
    IF v_request ? 'prerequisiteTaskId'
       AND v_request->'prerequisiteTaskId' <> 'null'::jsonb
       AND jsonb_typeof(v_request->'prerequisiteTaskId') <> 'string' THEN
      RAISE EXCEPTION 'prerequisiteTaskId must be a UUID string or null';
    END IF;
    v_dependencies := v_request->'dependencies';
    IF v_request->>'prerequisiteTaskId' IS NOT NULL
       AND v_dependencies IS NOT NULL AND v_dependencies <> 'null'::jsonb THEN
      RAISE EXCEPTION 'prerequisiteTaskId and dependencies cannot be combined';
    END IF;
    IF v_dependencies IS NOT NULL AND v_dependencies <> 'null'::jsonb THEN
      IF jsonb_typeof(v_dependencies) <> 'object'
         OR v_dependencies - ARRAY['prerequisiteTaskIds', 'onSuccess', 'onFailure', 'onCancellation'] <> '{}'::jsonb
         OR jsonb_typeof(v_dependencies->'prerequisiteTaskIds') <> 'array'
         OR jsonb_array_length(v_dependencies->'prerequisiteTaskIds') NOT BETWEEN 1 AND 100
         OR v_dependencies->>'onSuccess' NOT IN ('release', 'cancel', 'fail')
         OR v_dependencies->>'onFailure' NOT IN ('release', 'cancel', 'fail')
         OR v_dependencies->>'onCancellation' NOT IN ('release', 'cancel', 'fail')
         OR EXISTS (
           SELECT 1 FROM jsonb_array_elements(v_dependencies->'prerequisiteTaskIds') item
            WHERE jsonb_typeof(item) <> 'string'
         ) THEN
        RAISE EXCEPTION 'dependencies requires 1 to 100 UUID strings and release, cancel, or fail outcome policies';
      END IF;
      v_prerequisite_task_ids := ARRAY(
        SELECT value::uuid
          FROM jsonb_array_elements_text(v_dependencies->'prerequisiteTaskIds') value
         ORDER BY value::uuid
      );
      v_on_success := v_dependencies->>'onSuccess';
      v_on_failure := v_dependencies->>'onFailure';
      v_on_cancellation := v_dependencies->>'onCancellation';
    ELSIF v_request->>'prerequisiteTaskId' IS NOT NULL THEN
      v_prerequisite_task_ids := ARRAY[(v_request->>'prerequisiteTaskId')::uuid];
      v_on_success := 'release';
      v_on_failure := 'fail';
      v_on_cancellation := 'cancel';
    ELSE
      v_prerequisite_task_ids := '{}';
      v_on_success := 'release';
      v_on_failure := 'fail';
      v_on_cancellation := 'cancel';
    END IF;
    v_is_fast := v_queue_name = ANY(v_fast_queues);
    IF v_is_fast THEN
      v_fast_feature := CASE
        WHEN v_concurrency_key IS NOT NULL THEN 'concurrency keys'
        WHEN v_budget_name IS NOT NULL THEN 'budgets'
        WHEN v_dependencies IS NOT NULL AND v_dependencies <> 'null'::jsonb THEN 'dependencies'
        WHEN cardinality(v_prerequisite_task_ids) > 0 THEN 'prerequisite tasks'
      END;
      IF v_fast_feature IS NOT NULL THEN
        PERFORM workhorse.reject_fast_feature_v1(v_queue_name, v_fast_feature, v_ordinal);
      END IF;
    END IF;
    v_prerequisite_task_id := CASE
      WHEN v_dependencies IS NULL OR v_dependencies = 'null'::jsonb
        THEN NULLIF(v_request->>'prerequisiteTaskId', '')::uuid
      ELSE NULL
    END;
    -- Most requests carry no prerequisite. The prerequisite lock, the existence check and both
    -- outcome scans answer nothing for an empty set, so a request without prerequisites states
    -- their answers directly and reaches the buffer without touching dependency relations.
    IF cardinality(v_prerequisite_task_ids) > 0 THEN
      IF cardinality(v_prerequisite_task_ids) <> (
        SELECT count(DISTINCT prerequisite_id) FROM unnest(v_prerequisite_task_ids) prerequisite_id
      ) THEN
        RAISE EXCEPTION 'dependency prerequisiteTaskIds must be unique';
      END IF;
      -- The batch already holds these rows, so locking them again waits for nothing. The lock
      -- still counts the prerequisites that exist, and it covers a spelling of a UUID that the
      -- batch pattern missed.
      PERFORM 1 FROM workhorse.task_runtime runtime
       WHERE runtime.task_id = ANY(v_prerequisite_task_ids)
       ORDER BY runtime.task_id FOR KEY SHARE;
      PERFORM 1 FROM workhorse.task prerequisite
       WHERE prerequisite.id = ANY(v_prerequisite_task_ids)
       ORDER BY prerequisite.id FOR KEY SHARE;
      GET DIAGNOSTICS v_pending_prerequisites = ROW_COUNT;
      IF v_pending_prerequisites <> cardinality(v_prerequisite_task_ids) THEN
        RAISE EXCEPTION 'prerequisite task does not exist';
      END IF;
      -- A fast-tier task never resolves dependents when it finishes, so a dependent on it would
      -- stay blocked forever.
      SELECT prerequisite_id INTO v_fast_task_id
        FROM unnest(v_prerequisite_task_ids) prerequisite_id
       WHERE EXISTS (
               SELECT 1 FROM workhorse.fast_task_runtime runtime
                WHERE runtime.task_id = prerequisite_id
             ) OR EXISTS (
               SELECT 1 FROM workhorse.fast_task_outcome outcome
                WHERE outcome.task_id = prerequisite_id
             )
       LIMIT 1;
      IF FOUND THEN
        v_diagnostic := jsonb_build_object(
          'feature', 'dependencies', 'taskId', v_fast_task_id, 'ordinal', v_ordinal
        )::text;
        RAISE EXCEPTION USING
          ERRCODE = 'P1007',
          MESSAGE = format('fast-tier task %s cannot be a prerequisite', v_fast_task_id),
          DETAIL = v_diagnostic,
          HINT = v_diagnostic;
      END IF;
      -- An edge starts pending unless its prerequisite is terminal and its policy releases. The
      -- dependent's counter starts at that count and falls as the pending edges resolve.
      SELECT count(*) FILTER (WHERE outcome.task_id IS NULL)::integer,
             count(*) FILTER (
               WHERE outcome.task_id IS NULL OR CASE outcome.state
                 WHEN 'succeeded' THEN v_on_success
                 WHEN 'failed' THEN v_on_failure
                 WHEN 'canceled' THEN v_on_cancellation
               END <> 'release'
             )::integer
        INTO v_pending_prerequisites, v_pending_edges
        FROM unnest(v_prerequisite_task_ids) prerequisite_id
        LEFT JOIN workhorse.task_outcome outcome ON outcome.task_id = prerequisite_id;
      SELECT outcome.task_id, outcome.state, action.policy_action
        INTO v_terminal_prerequisite_id, v_terminal_prerequisite_state, v_terminal_action
        FROM workhorse.task_outcome outcome
        CROSS JOIN LATERAL (
          SELECT CASE outcome.state
            WHEN 'succeeded' THEN v_on_success
            WHEN 'failed' THEN v_on_failure
            WHEN 'canceled' THEN v_on_cancellation
            ELSE 'release'
          END AS policy_action
        ) action
       WHERE outcome.task_id = ANY(v_prerequisite_task_ids)
         AND action.policy_action IN ('fail', 'cancel')
       ORDER BY CASE action.policy_action WHEN 'fail' THEN 0 ELSE 1 END, outcome.task_id
       LIMIT 1;
    ELSE
      v_pending_prerequisites := 0;
      v_pending_edges := 0;
      v_terminal_prerequisite_id := NULL;
      v_terminal_prerequisite_state := NULL;
      v_terminal_action := NULL;
    END IF;
    v_state := CASE
      WHEN v_terminal_action IS NOT NULL THEN 'blocked'
      WHEN v_pending_prerequisites > 0 THEN 'blocked'
      WHEN v_run_at <= v_now THEN 'ready'
      ELSE 'scheduled'
    END;
    v_idempotency := v_request->'idempotency';
    v_is_new := true;
    v_is_keyed := false;
    v_key_hash := NULL;
    v_key_preview := NULL;
    v_key_digest := NULL;
    v_key_length := NULL;
    v_expires_at := NULL;
    v_request_digest := NULL;

    IF v_idempotency IS NOT NULL AND v_idempotency <> 'null'::jsonb THEN
      IF jsonb_typeof(v_idempotency) <> 'object'
         OR v_idempotency - ARRAY['key', 'scope', 'ttlMs'] <> '{}'::jsonb
         OR NOT (v_idempotency ? 'key')
         OR jsonb_typeof(v_idempotency->'key') <> 'string'
         OR (v_idempotency ? 'scope' AND jsonb_typeof(v_idempotency->'scope') <> 'string')
         OR (v_idempotency ? 'ttlMs' AND jsonb_typeof(v_idempotency->'ttlMs') <> 'number') THEN
        RAISE EXCEPTION 'idempotency requires a string key and only optional string scope and numeric ttlMs';
      END IF;
      v_is_keyed := true;
      v_key := v_idempotency->>'key';
      v_scope := COALESCE(v_idempotency->>'scope', 'default');
      v_ttl_ms := COALESCE((v_idempotency->>'ttlMs')::numeric, 86400000);
      IF v_key = '' OR octet_length(v_key) > 512 THEN
        RAISE EXCEPTION 'idempotency key must contain between 1 and 512 UTF-8 bytes';
      END IF;
      IF v_scope = '' OR octet_length(v_scope) > 256 THEN
        RAISE EXCEPTION 'idempotency scope must contain between 1 and 256 UTF-8 bytes';
      END IF;
      IF v_ttl_ms <> trunc(v_ttl_ms) OR v_ttl_ms NOT BETWEEN 1 AND 31536000000 THEN
        RAISE EXCEPTION 'idempotency ttlMs must be an integer between 1 and 31536000000';
      END IF;
      v_key_hash := workhorse.idempotency_key_hash_v1(v_scope, v_key);
      v_key_digest := left(encode(v_key_hash, 'hex'), 12);
      v_key_length := char_length(v_key);
      v_key_preview := CASE
        WHEN v_key_length <= 4 THEN repeat('•', v_key_length)
        WHEN v_key_length <= 8 THEN left(v_key, 2) || '…' || right(v_key, 2)
        ELSE left(v_key, 8) || '…' || right(v_key, 4)
      END;
      v_expires_at := v_now + v_ttl_ms * interval '1 millisecond';
      v_fingerprint_tags := ARRAY(
        SELECT unique_tags.tag
          FROM (SELECT DISTINCT tag FROM unnest(v_tags) tag) unique_tags
         ORDER BY unique_tags.tag COLLATE "C"
      );
      v_fingerprint := jsonb_build_object(
        'queue', v_queue_name,
        'type', v_task_type,
        'payload', v_payload,
        'priority', v_priority,
        'concurrencyKey', to_jsonb(v_concurrency_key),
        'contractVersion', to_jsonb(v_contract_version),
        'payloadMaxBytes', v_payload_max_bytes,
        'resultMaxBytes', v_result_max_bytes,
        'sensitivePayloadKeys', to_jsonb(v_payload_redact_keys),
        'sensitiveResultKeys', to_jsonb(v_result_redact_keys),
        'tags', to_jsonb(v_fingerprint_tags),
        'runAt', CASE
          WHEN v_request->>'runAt' IS NULL THEN 'null'::jsonb
          ELSE workhorse.idempotency_instant_v1(v_run_at)
        END,
        'deadline', workhorse.idempotency_instant_v1(v_deadline_at),
        'executionTimeoutMs', to_jsonb(v_execution_timeout_ms),
        'maxAttempts', v_max_attempts,
        'retryPolicy', v_retry_policy,
        'prerequisiteTaskId', to_jsonb(v_prerequisite_task_id),
        'dependencies', CASE WHEN v_dependencies IS NULL OR v_dependencies = 'null'::jsonb
          THEN 'null'::jsonb ELSE
          jsonb_build_object(
            'prerequisiteTaskIds', to_jsonb(v_prerequisite_task_ids),
            'onSuccess', v_on_success,
            'onFailure', v_on_failure,
            'onCancellation', v_on_cancellation
          ) END,
        'ttlMs', v_ttl_ms
      ) || CASE WHEN v_budget_name IS NULL THEN '{}'::jsonb
           ELSE jsonb_build_object('budget', v_budget_name) END;
      v_request_digest := workhorse.sha256_hex_v1(v_fingerprint::text);

      LOOP
        v_proposed_task_id := gen_random_uuid();
        INSERT INTO workhorse.enqueue_idempotency AS existing(
          idempotency_scope, idempotency_key_hash, request_fingerprint, task_id, expires_at
        ) VALUES (
          v_scope, v_key_hash, v_fingerprint, v_proposed_task_id, v_expires_at
        )
        ON CONFLICT (idempotency_scope, idempotency_key_hash) DO UPDATE
          SET idempotency_key_hash = existing.idempotency_key_hash
        RETURNING existing.* INTO v_existing;

        IF v_existing.task_id = v_proposed_task_id THEN
          task_id := v_proposed_task_id;
          EXIT;
        END IF;
        IF v_existing.expires_at <= v_now THEN
          DELETE FROM workhorse.enqueue_idempotency AS expired
           WHERE expired.idempotency_scope = v_scope
             AND expired.idempotency_key_hash = v_key_hash
             AND expired.task_id = v_existing.task_id AND expired.expires_at <= v_now
          RETURNING expired.task_id, expired.expires_at INTO v_expired_task_id, v_expired_at;
          -- The expired key held its task, so the enqueue saves the end of that hold (ADR 0122).
          -- The write takes the outcome with SKIP LOCKED and never waits. If another transaction
          -- holds the outcome, the enqueue continues without the write. A task with no outcome row
          -- needs no write. Only this branch reads the old task.
          IF FOUND THEN
            PERFORM workhorse.save_terminal_hold_ends_internal_v1(
              ARRAY[v_expired_task_id], ARRAY[v_expired_at]
            );
          END IF;
          CONTINUE;
        END IF;
        IF v_existing.request_fingerprint <> v_fingerprint THEN
          -- The timestamp members compare as instants, so the session TimeZone of either request
          -- does not matter.
          v_stored_fingerprint :=
            workhorse.canonical_enqueue_fingerprint_v1(v_existing.request_fingerprint);
          IF v_stored_fingerprint <> v_fingerprint THEN
            SELECT COALESCE(array_agg(field ORDER BY field COLLATE "C"), '{}')
              INTO v_conflicting_fields
              FROM jsonb_object_keys(v_fingerprint) field
             WHERE v_stored_fingerprint->field IS DISTINCT FROM v_fingerprint->field;
            v_diagnostic := jsonb_build_object(
              'scope', v_scope,
              'keyPreview', v_key_preview,
              'keyDigest', v_key_digest,
              'keyLength', v_key_length,
              'existingTaskId', v_existing.task_id,
              'ordinal', v_ordinal,
              'conflictingFields', to_jsonb(v_conflicting_fields),
              'storedRequestDigest', workhorse.sha256_hex_v1(v_existing.request_fingerprint::text),
              'rejectedRequestDigest', v_request_digest
            )::text;
            RAISE EXCEPTION USING
              ERRCODE = 'P1001',
              MESSAGE = 'enqueue idempotency conflict with a retained request',
              DETAIL = v_diagnostic,
              HINT = v_diagnostic;
          END IF;
        END IF;
        task_id := v_existing.task_id;
        v_is_new := false;
        EXIT;
      END LOOP;
    ELSE
      task_id := gen_random_uuid();
    END IF;

    IF v_is_new AND v_is_fast THEN
      -- Fast-tier rows are collected here and written after the loop, one statement per table.
      v_fast_task.id := task_id;
      v_fast_task.queue_name := v_queue_name;
      v_fast_task.task_type := v_task_type;
      v_fast_task.concurrency_key := NULL;
      v_fast_task.payload := v_payload;
      v_fast_task.contract_version := v_contract_version;
      v_fast_task.payload_max_bytes := v_payload_max_bytes::integer;
      v_fast_task.result_max_bytes := v_result_max_bytes::integer;
      v_fast_task.payload_redact_keys := v_payload_redact_keys;
      v_fast_task.result_redact_keys := v_result_redact_keys;
      v_fast_task.trace_context := v_trace_context;
      v_fast_task.tags := v_tags;
      v_fast_task.max_attempts := v_max_attempts;
      v_fast_task.retry_policy := v_retry_policy;
      v_fast_task.deadline_at := v_deadline_at;
      v_fast_task.execution_timeout_ms := v_execution_timeout_ms::bigint;
      v_fast_task.created_at := v_now;
      v_fast_task.priority := v_priority::integer;
      v_fast_task.budget_name := NULL;
      v_fast_tasks := array_append(v_fast_tasks, v_fast_task);

      v_fast_runtime := NULL;
      v_fast_runtime.task_id := task_id;
      v_fast_runtime.queue_name := v_queue_name;
      v_fast_runtime.task_type := v_task_type;
      v_fast_runtime.state := 'ready';
      v_fast_runtime.priority := v_priority::integer;
      v_fast_runtime.run_at := v_run_at;
      v_fast_runtime.sequence := nextval('workhorse.ready_sequence_seq');
      v_fast_runtime.payload := v_payload;
      v_fast_runtime.contract_version := v_contract_version;
      v_fast_runtime.result_max_bytes := v_result_max_bytes::integer;
      v_fast_runtime.redact := cardinality(v_payload_redact_keys) > 0
        OR cardinality(v_result_redact_keys) > 0;
      v_fast_runtime.trace_context := v_trace_context;
      v_fast_runtime.retry_policy := v_retry_policy;
      v_fast_runtime.max_attempts := v_max_attempts;
      v_fast_runtime.attempt := 1;
      v_fast_runtime.fence_token := 0;
      v_fast_runtime.deadline_at := v_deadline_at;
      v_fast_runtime.execution_timeout_ms := v_execution_timeout_ms::bigint;
      v_fast_runtime.errors := '[]'::jsonb;
      v_fast_runtime.errors_dropped := 0;
      v_fast_runtime.enqueued_at := v_now;
      v_fast_runtimes := array_append(v_fast_runtimes, v_fast_runtime);

      IF v_deadline_at IS NOT NULL AND v_deadline_at <= v_now THEN
        v_fast_past_deadline := array_append(v_fast_past_deadline, task_id);
      ELSIF v_run_at <= v_now AND NOT v_queue_name = ANY(v_ready_queues) THEN
        v_ready_queues := array_append(v_ready_queues, v_queue_name);
      END IF;
    ELSIF v_is_new THEN
      -- Full-tier rows are collected here and written after the loop, one statement per table.
      -- A prerequisite exists before this batch starts, because the batch generates every new task
      -- identity, so no check or lock above needs a buffered row.
      v_full_task := NULL;
      v_full_task.id := task_id;
      v_full_task.queue_name := v_queue_name;
      v_full_task.task_type := v_task_type;
      v_full_task.concurrency_key := v_concurrency_key;
      v_full_task.priority := v_priority::integer;
      v_full_task.payload := v_payload;
      v_full_task.contract_version := v_contract_version;
      v_full_task.payload_max_bytes := v_payload_max_bytes::integer;
      v_full_task.result_max_bytes := v_result_max_bytes::integer;
      v_full_task.payload_redact_keys := v_payload_redact_keys;
      v_full_task.result_redact_keys := v_result_redact_keys;
      v_full_task.trace_context := v_trace_context;
      v_full_task.tags := v_tags;
      v_full_task.max_attempts := v_max_attempts;
      v_full_task.retry_policy := v_retry_policy;
      v_full_task.deadline_at := v_deadline_at;
      v_full_task.execution_timeout_ms := v_execution_timeout_ms::bigint;
      v_full_task.budget_name := v_budget_name;
      v_full_tasks := array_append(v_full_tasks, v_full_task);

      v_full_runtime := NULL;
      v_full_runtime.task_id := task_id;
      v_full_runtime.queue_name := v_queue_name;
      v_full_runtime.concurrency_key := v_concurrency_key;
      v_full_runtime.priority := v_priority::integer;
      v_full_runtime.state := v_state;
      v_full_runtime.current_attempt := 1;
      v_full_runtime.run_at := v_run_at;
      v_full_runtime.ready_at := CASE WHEN v_state = 'ready' THEN v_now END;
      v_full_runtime.sequence := CASE WHEN v_state = 'ready'
        THEN nextval('workhorse.ready_sequence_seq') END;
      v_full_runtime.deadline_at := v_deadline_at;
      v_full_runtime.budget_name := v_budget_name;
      v_full_runtime.pending_prerequisites := v_pending_edges;
      v_full_runtime.dependency_rejected := false;
      v_full_runtimes := array_append(v_full_runtimes, v_full_runtime);

      FOREACH v_prerequisite_task_id IN ARRAY v_prerequisite_task_ids LOOP
        v_edge := NULL;
        v_edge.dependent_task_id := task_id;
        v_edge.prerequisite_task_id := v_prerequisite_task_id;
        v_edge.on_success := v_on_success;
        v_edge.on_failure := v_on_failure;
        v_edge.on_cancellation := v_on_cancellation;
        v_edges := array_append(v_edges, v_edge);
      END LOOP;

      v_full_enqueued_details := array_append(v_full_enqueued_details,
        jsonb_build_object(
          'state', v_state,
          'priority', v_priority,
          'run_at', v_run_at,
          'deadline_at', v_deadline_at,
          'execution_timeout_ms', v_execution_timeout_ms
        ) ||
        CASE WHEN v_is_keyed THEN jsonb_build_object(
          'idempotency', jsonb_build_object(
            'scope', v_scope,
            'key_preview', v_key_preview,
            'key_digest', v_key_digest,
            'key_length', v_key_length,
            'ttl_ms', v_ttl_ms,
            'expires_at', v_expires_at,
            'request_digest', v_request_digest
          )
        ) ELSE '{}'::jsonb END
      );
      IF v_deadline_at IS NOT NULL AND v_deadline_at <= v_now THEN
        v_full_past_deadline := array_append(v_full_past_deadline, task_id);
      ELSIF v_state = 'ready' AND NOT v_queue_name = ANY(v_ready_queues) THEN
        v_ready_queues := array_append(v_ready_queues, v_queue_name);
      END IF;
    END IF;
    ordinal := v_ordinal;
    accepted := v_is_new;
    RETURN NEXT;
  END LOOP;

  -- The buffered writes keep each task's evidence in the order the one-row writes produced: its
  -- dependency events, the resolution of any terminal prerequisite, `enqueued`, then an expired
  -- deadline. Omitted columns keep their per-row defaults, so created_at, updated_at and the event
  -- identity advance with each row.
  IF cardinality(v_full_tasks) > 0 THEN
    INSERT INTO workhorse.task(
      id, queue_name, task_type, concurrency_key, priority, payload, contract_version,
      payload_max_bytes, result_max_bytes,
      payload_redact_keys, result_redact_keys, trace_context, tags, max_attempts, retry_policy,
      deadline_at, execution_timeout_ms, budget_name
    )
    SELECT buffered.id, buffered.queue_name, buffered.task_type, buffered.concurrency_key,
           buffered.priority, buffered.payload, buffered.contract_version,
           buffered.payload_max_bytes, buffered.result_max_bytes,
           buffered.payload_redact_keys, buffered.result_redact_keys, buffered.trace_context,
           buffered.tags, buffered.max_attempts, buffered.retry_policy,
           buffered.deadline_at, buffered.execution_timeout_ms, buffered.budget_name
      FROM unnest(v_full_tasks) WITH ORDINALITY buffered
     ORDER BY buffered.ordinality;
    INSERT INTO workhorse.task_runtime(
      task_id, queue_name, concurrency_key, priority, state, current_attempt, run_at, ready_at,
      sequence, deadline_at, budget_name, pending_prerequisites, dependency_rejected
    )
    SELECT buffered.task_id, buffered.queue_name, buffered.concurrency_key, buffered.priority,
           buffered.state, buffered.current_attempt, buffered.run_at, buffered.ready_at,
           buffered.sequence, buffered.deadline_at, buffered.budget_name,
           buffered.pending_prerequisites, buffered.dependency_rejected
      FROM unnest(v_full_runtimes) WITH ORDINALITY buffered
     ORDER BY buffered.ordinality;
    -- A batch without prerequisites has no edge to write and no dependent to resolve. Running the
    -- insert anyway would fire the statement trigger on `task_dependency`, and that trigger walks
    -- the dependency graph recursively for a transition that cannot have occurred.
    IF cardinality(v_edges) > 0 THEN
      WITH edges AS MATERIALIZED (
        SELECT edge.dependent_task_id, edge.prerequisite_task_id, edge.on_success,
               edge.on_failure, edge.on_cancellation, edge.ordinality, outcome.state,
               outcome.state IS NOT NULL AND (
                 (outcome.state = 'succeeded' AND edge.on_success = 'release')
                 OR (outcome.state = 'failed' AND edge.on_failure = 'release')
                 OR (outcome.state = 'canceled' AND edge.on_cancellation = 'release')
               ) AS releases_immediately
          FROM unnest(v_edges) WITH ORDINALITY edge
          LEFT JOIN workhorse.task_outcome outcome
            ON outcome.task_id = edge.prerequisite_task_id
      ), inserted_edges AS (
        INSERT INTO workhorse.task_dependency(
          dependent_task_id, prerequisite_task_id, on_success, on_failure, on_cancellation,
          created_at, released_at, resolution
        )
        SELECT edges.dependent_task_id, edges.prerequisite_task_id,
               edges.on_success, edges.on_failure, edges.on_cancellation, v_now,
               CASE WHEN edges.releases_immediately THEN v_now END,
               CASE WHEN edges.releases_immediately THEN 'release' END
          FROM edges
         ORDER BY edges.ordinality
        RETURNING dependent_task_id, prerequisite_task_id
      )
      INSERT INTO workhorse.task_event(task_id, event_type, details)
      SELECT edges.dependent_task_id,
             CASE WHEN edges.releases_immediately
               THEN 'dependency_released' ELSE 'dependency_blocked' END,
             jsonb_build_object(
               'prerequisite_task_id', edges.prerequisite_task_id,
               'state', runtime.state,
               'reason', CASE
                 WHEN NOT edges.releases_immediately THEN 'prerequisite_pending'
                 WHEN edges.state = 'succeeded' THEN 'prerequisite_already_succeeded'
                 ELSE 'prerequisite_terminal_policy'
               END
             )
        FROM edges
        JOIN inserted_edges USING (dependent_task_id, prerequisite_task_id)
        JOIN unnest(v_full_runtimes) runtime ON runtime.task_id = edges.dependent_task_id
       ORDER BY edges.ordinality;
      -- One resolver call resolves the pending edges to every terminal prerequisite in the batch. A
      -- dependent's fate depends only on the resolutions of its edges, so it matches the fate that
      -- one call per dependent produced.
      PERFORM workhorse.resolve_dependents_many_v1(terminal.task_ids, terminal.states)
         FROM (
           SELECT array_agg(outcome.task_id ORDER BY outcome.task_id) AS task_ids,
                  array_agg(outcome.state ORDER BY outcome.task_id) AS states
             FROM workhorse.task_outcome outcome
            WHERE outcome.task_id IN (
              SELECT edge.prerequisite_task_id FROM unnest(v_edges) edge
            )
         ) terminal
        WHERE terminal.task_ids IS NOT NULL;
    END IF;
    INSERT INTO workhorse.task_event(task_id, event_type, details)
    SELECT buffered.id, 'enqueued', event.details
      FROM unnest(v_full_tasks) WITH ORDINALITY buffered
      JOIN unnest(v_full_enqueued_details) WITH ORDINALITY event(details, ordinality)
        ON event.ordinality = buffered.ordinality
     ORDER BY buffered.ordinality;
    FOREACH v_full_task_id IN ARRAY v_full_past_deadline LOOP
      PERFORM workhorse.terminalize_deadline_v1(v_full_task_id);
    END LOOP;
  END IF;

  IF cardinality(v_fast_tasks) > 0 THEN
    INSERT INTO workhorse.task SELECT * FROM unnest(v_fast_tasks);
    INSERT INTO workhorse.fast_task_runtime SELECT * FROM unnest(v_fast_runtimes);
    FOREACH v_fast_task_id IN ARRAY v_fast_past_deadline LOOP
      PERFORM workhorse.fast_terminalize_deadline_v1(v_fast_task_id);
    END LOOP;
  END IF;

  FOREACH v_notify_queue IN ARRAY v_ready_queues LOOP
    PERFORM pg_notify('workhorse_tasks', v_notify_queue);
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION workhorse.purge_queue_internal_v1(p_queue_name text)
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  v_count integer;
  v_fast_count integer;
  v_purged_task_ids uuid[];
  v_fast_task_ids uuid[];
  v_canceled_task_ids uuid[];
  v_deleted_task_ids uuid[];
  v_member_task_ids uuid[];
  v_task_id uuid;
BEGIN
  IF p_queue_name IS NULL OR p_queue_name = '' THEN
    RAISE EXCEPTION 'queue_name must not be empty';
  END IF;
  -- Two purges run one after the other, also for different queues. Each purge locks its own tasks
  -- before their dependents in other queues, so two purges whose queues depend on each other could
  -- otherwise lock the same rows in opposite orders. Take this lock before any row lock.
  PERFORM pg_advisory_xact_lock(hashtextextended('workhorse:purge-queue', 0));
  INSERT INTO workhorse.queue_control(queue_name, paused)
    VALUES (p_queue_name, false)
  ON CONFLICT (queue_name) DO NOTHING;
  -- Lock both runtime and parent identities before taking a fresh statement snapshot for history
  -- deletion. The history insert trigger takes KEY SHARE on task, so it either commits before these
  -- deletes become visible or fails after the parent disappears; it cannot commit an orphan.
  -- Lock every runtime row in identity order, then every task row in identity order. An enqueue
  -- locks its prerequisites in the same order, so the two cannot deadlock.
  --
  -- The purge removes exactly the tasks that its first lock statement locks, and every later
  -- statement uses that identity array. A task that commits while the purge waits for a lock is
  -- not in the array, so it stays and a worker can claim and complete it. A later read of the
  -- queue could find that task after a worker claimed it, and the delete of its task row would
  -- remove its active runtime row. The task-row lock also takes only these identities, so a task
  -- that commits between the two lock statements cannot hold a lock that a claim waits for.
  v_purged_task_ids := ARRAY(
    SELECT locked.task_id
      FROM (
        SELECT runtime.task_id
          FROM workhorse.task_runtime runtime
         WHERE runtime.queue_name = p_queue_name
           AND runtime.state IN ('blocked', 'ready', 'scheduled')
         ORDER BY runtime.task_id
         FOR UPDATE
      ) locked
     ORDER BY locked.task_id
  );
  PERFORM 1
    FROM workhorse.task task
   WHERE task.id = ANY(v_purged_task_ids)
   ORDER BY task.id
   FOR UPDATE;
  -- A cancel below settles the blocked dependents in other queues. Lock them as a cancel does:
  -- after the prerequisites, in identity order, FOR NO KEY UPDATE. A terminal transition of a
  -- purged task also locks it before its dependents, so the two cannot deadlock. The lock does not
  -- conflict with the key-share lock of an enqueue that names a dependent.
  PERFORM 1
    FROM workhorse.task_runtime runtime
   WHERE runtime.task_id IN (
           SELECT dependency.dependent_task_id
             FROM workhorse.task_dependency dependency
            WHERE dependency.prerequisite_task_id = ANY(v_purged_task_ids)
              AND dependency.released_at IS NULL
         )
     AND runtime.state = 'blocked'
     AND runtime.queue_name <> p_queue_name
   ORDER BY runtime.task_id
   FOR NO KEY UPDATE;

  -- A purged task stays, and the purge cancels it, when an edge leads to a dependent that stays.
  -- That is a dependent outside the purge, unless the edge is released and the dependent is
  -- terminal, or a purged task that stays itself. Depth counts the edges to the nearest dependent
  -- outside the purge along the longest path. The purge cancels in depth order, so every task is
  -- canceled after its dependents that stay, and each of them sees the purge's own cancel.
  WITH RECURSIVE staying(task_id, depth) AS (
    SELECT dependency.prerequisite_task_id, 0
      FROM workhorse.task_dependency dependency
     WHERE dependency.prerequisite_task_id = ANY(v_purged_task_ids)
       AND NOT dependency.dependent_task_id = ANY(v_purged_task_ids)
       AND (
             dependency.released_at IS NULL
             OR EXISTS (
                  SELECT 1 FROM workhorse.task_runtime runtime
                   WHERE runtime.task_id = dependency.dependent_task_id
                )
           )
    UNION
    SELECT dependency.prerequisite_task_id, staying.depth + 1
      FROM staying
      JOIN workhorse.task_dependency dependency
        ON dependency.dependent_task_id = staying.task_id
     WHERE dependency.prerequisite_task_id = ANY(v_purged_task_ids)
  )
  SELECT array_agg(deepest.task_id ORDER BY deepest.depth, deepest.task_id)
    INTO v_canceled_task_ids
    FROM (
      SELECT staying.task_id, max(staying.depth) AS depth
        FROM staying
       GROUP BY staying.task_id
    ) deepest;
  v_canceled_task_ids := coalesce(v_canceled_task_ids, '{}');
  v_deleted_task_ids := ARRAY(
    SELECT purged.task_id
      FROM unnest(v_purged_task_ids) purged(task_id)
     WHERE NOT purged.task_id = ANY(v_canceled_task_ids)
     ORDER BY purged.task_id
  );

  -- A purged member task counts as canceled for its group (ADR 0095). Every member is full-tier.
  -- The outcome trigger counts a canceled member, so this counts only the deleted ones.
  v_member_task_ids := ARRAY(
    SELECT member.task_id
      FROM workhorse.task_group_member member
     WHERE member.task_id = ANY(v_deleted_task_ids)
       AND member.outcome IS NULL
     ORDER BY member.task_id
  );

  -- A deleted task can hold a task that stays: a prerequisite of a deleted dependent, a parent of a
  -- deleted child, or a redrive source of a deleted target. Each removed target saves the end on its
  -- source, also when another target remains, because a concurrent statement can remove that one. The purge saves the end
  -- of each such hold before the delete removes the reference (ADR 0122). It is the finish of a
  -- terminal dependent, the instant when a terminal child became eligible, and otherwise the purge.
  -- The write never waits. If another transaction holds an outcome, the purge continues without it.
  PERFORM workhorse.save_terminal_hold_ends_internal_v1(held.task_ids, held.ends)
    FROM (
      SELECT array_agg(hold.task_id) AS task_ids, array_agg(hold.at) AS ends
        FROM (
          SELECT dependency.prerequisite_task_id AS task_id,
                 COALESCE(
                   (SELECT outcome.finished_at FROM workhorse.task_outcome outcome
                     WHERE outcome.task_id = dependency.dependent_task_id),
                   clock_timestamp()
                 ) AS at
            FROM workhorse.task_dependency dependency
           WHERE dependency.dependent_task_id = ANY(v_deleted_task_ids)
             AND NOT dependency.prerequisite_task_id = ANY(v_deleted_task_ids)
          UNION ALL
          SELECT edge.parent_task_id,
                 LEAST(
                   COALESCE(workhorse.terminal_child_hold_end_internal_v1(edge.child_task_id),
                            clock_timestamp()),
                   clock_timestamp()
                 )
            FROM workhorse.task_child edge
           WHERE edge.child_task_id = ANY(v_deleted_task_ids)
             AND NOT edge.parent_task_id = ANY(v_deleted_task_ids)
          UNION ALL
          SELECT redrive.source_task_id, clock_timestamp()
            FROM workhorse.task_redrive redrive
           WHERE redrive.target_task_id = ANY(v_deleted_task_ids)
             AND NOT redrive.source_task_id = ANY(v_deleted_task_ids)
        ) hold
    ) held
   WHERE held.task_ids IS NOT NULL;
  DELETE FROM workhorse.enqueue_idempotency idempotency
   WHERE idempotency.task_id = ANY(v_deleted_task_ids);
  DELETE FROM workhorse.task_event event
   WHERE event.task_id = ANY(v_deleted_task_ids);
  DELETE FROM workhorse.attempt_history attempt
   WHERE attempt.task_id = ANY(v_deleted_task_ids);
  -- The restricting reference does not wait for the cascade from the dependent's delete, so the
  -- edges go first. An edge from a deleted task leads to a deleted dependent, or it is released
  -- and its dependent is terminal, as the pruning of released edges requires.
  DELETE FROM workhorse.task_dependency dependency
   WHERE dependency.dependent_task_id = ANY(v_deleted_task_ids);
  DELETE FROM workhorse.task_dependency dependency
   WHERE dependency.prerequisite_task_id = ANY(v_deleted_task_ids);
  DELETE FROM workhorse.task task
   WHERE task.id = ANY(v_deleted_task_ids);
  GET DIAGNOSTICS v_count = ROW_COUNT;
  -- The counters change after the deletes, so a callback a group enqueues on this queue survives.
  IF cardinality(v_member_task_ids) > 0 THEN
    PERFORM workhorse.count_task_group_outcomes_internal_v1(
      v_member_task_ids, array_fill('canceled'::text, ARRAY[cardinality(v_member_task_ids)])
    );
  END IF;
  -- The cancels follow the deletes for the same reason. Each one writes the canceled outcome whose
  -- trigger resolves the task's dependents and counts it for its group.
  FOREACH v_task_id IN ARRAY v_canceled_task_ids LOOP
    PERFORM workhorse.cancel_v1(v_task_id, NULL, 'queue purge');
  END LOOP;
  v_count := v_count + cardinality(v_canceled_task_ids);

  -- Fast-tier ready rows carry no events, and deleting the task cascades to the runtime row.
  -- The same order applies: every runtime row, then every task row, each in identity order.
  -- A fast-tier task is never a prerequisite. As above, every delete uses the identities that the
  -- first lock statement locked. A keyed task that commits between two deletes then keeps both its
  -- task row and its key row.
  v_fast_task_ids := ARRAY(
    SELECT locked.task_id
      FROM (
        SELECT fast.task_id
          FROM workhorse.fast_task_runtime fast
         WHERE fast.queue_name = p_queue_name AND fast.state = 'ready'
         ORDER BY fast.task_id
         FOR UPDATE
      ) locked
     ORDER BY locked.task_id
  );
  PERFORM 1
    FROM workhorse.task task
   WHERE task.id = ANY(v_fast_task_ids)
   ORDER BY task.id
   FOR UPDATE;
  -- A redrive takes the current tier of its queue, so a full-tier source can have a fast target. The
  -- purge saves the end of that hold before the delete removes the redrive edge (ADR 0122).
  PERFORM workhorse.save_terminal_hold_ends_internal_v1(held.task_ids, held.ends)
    FROM (
      SELECT array_agg(redrive.source_task_id) AS task_ids,
             array_agg(clock_timestamp()) AS ends
        FROM workhorse.task_redrive redrive
       WHERE redrive.target_task_id = ANY(v_fast_task_ids)
         AND NOT redrive.source_task_id = ANY(v_fast_task_ids)
    ) held
   WHERE held.task_ids IS NOT NULL;
  DELETE FROM workhorse.enqueue_idempotency idempotency
   WHERE idempotency.task_id = ANY(v_fast_task_ids);
  DELETE FROM workhorse.attempt_history attempt
   WHERE attempt.task_id = ANY(v_fast_task_ids);
  DELETE FROM workhorse.task task
   WHERE task.id = ANY(v_fast_task_ids);
  GET DIAGNOSTICS v_fast_count = ROW_COUNT;
  RETURN v_count + v_fast_count;
END;
$$;

CREATE OR REPLACE FUNCTION workhorse.terminal_prune_slice_rows_internal_v1(p_limit integer)
RETURNS integer
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT LEAST(GREATEST(GREATEST(p_limit, 1) * 4, 1000), 100000);
$$;

CREATE OR REPLACE FUNCTION workhorse.terminal_row_kept_internal_v1(
  p_task_id uuid, p_now timestamptz, p_identity_before timestamptz,
  p_outcome_before timestamptz, p_history_before timestamptz
) RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT EXISTS (SELECT 1 FROM workhorse.task_runtime runtime WHERE runtime.task_id = p_task_id)
      OR EXISTS (SELECT 1 FROM workhorse.task_event event WHERE event.task_id = p_task_id)
      OR EXISTS (
           SELECT 1 FROM workhorse.attempt_history attempt WHERE attempt.task_id = p_task_id
         )
      OR EXISTS (
           SELECT 1 FROM workhorse.enqueue_idempotency idempotency
            WHERE idempotency.task_id = p_task_id
         )
      OR EXISTS (
           SELECT 1 FROM workhorse.task_dependency dependency
            WHERE dependency.prerequisite_task_id = p_task_id
         )
      OR workhorse.terminal_row_held_internal_v1(
           p_task_id, p_now, p_identity_before, p_outcome_before, p_history_before, NULL
         );
$$;

CREATE OR REPLACE FUNCTION workhorse.read_terminal_prune_slice_internal_v1(
  p_tier text, p_before timestamptz, p_limit integer
) RETURNS TABLE (
  task_ids uuid[], finished_ats timestamptz[], sweep boolean, wrapped boolean,
  start_at timestamptz, start_id uuid
)
LANGUAGE plpgsql
STABLE
AS $$
DECLARE v_rows integer := workhorse.terminal_prune_slice_rows_internal_v1(p_limit);
DECLARE v_main_at timestamptz;
DECLARE v_main_id uuid;
DECLARE v_sweep_at timestamptz;
DECLARE v_sweep_id uuid;
DECLARE v_sweep_next boolean;
BEGIN
  SELECT position.finished_at, position.task_id, position.sweep_finished_at,
         position.sweep_task_id, position.sweep_next
    INTO v_main_at, v_main_id, v_sweep_at, v_sweep_id, v_sweep_next
    FROM workhorse.terminal_prune_position position WHERE position.tier = p_tier;
  sweep := COALESCE(v_sweep_next, false) AND v_main_at IS NOT NULL;
  wrapped := false;
  task_ids := '{}'::uuid[];
  finished_ats := '{}'::timestamptz[];
  IF sweep THEN
    start_at := v_sweep_at;
    start_id := v_sweep_id;
  ELSE
    start_at := v_main_at;
    start_id := v_main_id;
  END IF;
  -- Each slice reads only the index in order. No OR here: a generic plan keeps each row comparison
  -- as an index condition.
  IF p_tier = 'full' THEN
    SELECT COALESCE(array_agg(slice.task_id ORDER BY slice.finished_at, slice.task_id), '{}'::uuid[]),
           COALESCE(array_agg(slice.finished_at ORDER BY slice.finished_at, slice.task_id),
                    '{}'::timestamptz[])
      INTO task_ids, finished_ats
      FROM (
        SELECT outcome.finished_at, outcome.task_id
          FROM workhorse.task_outcome outcome
         WHERE outcome.finished_at < p_before
           AND (outcome.finished_at, outcome.task_id) > (
                 COALESCE(start_at, '-infinity'::timestamptz),
                 COALESCE(start_id, '00000000-0000-0000-0000-000000000000'::uuid)
               )
           AND (outcome.finished_at, outcome.task_id) <= (
                 CASE WHEN sweep THEN v_main_at ELSE 'infinity'::timestamptz END,
                 CASE WHEN sweep THEN v_main_id
                      ELSE 'ffffffff-ffff-ffff-ffff-ffffffffffff'::uuid END
               )
         ORDER BY outcome.finished_at, outcome.task_id
         LIMIT v_rows
      ) slice;
  ELSE
    SELECT COALESCE(array_agg(slice.task_id ORDER BY slice.finished_at, slice.task_id), '{}'::uuid[]),
           COALESCE(array_agg(slice.finished_at ORDER BY slice.finished_at, slice.task_id),
                    '{}'::timestamptz[])
      INTO task_ids, finished_ats
      FROM (
        SELECT outcome.finished_at, outcome.task_id
          FROM workhorse.fast_task_outcome outcome
         WHERE outcome.finished_at < p_before
           AND (outcome.finished_at, outcome.task_id) > (
                 COALESCE(start_at, '-infinity'::timestamptz),
                 COALESCE(start_id, '00000000-0000-0000-0000-000000000000'::uuid)
               )
           AND (outcome.finished_at, outcome.task_id) <= (
                 CASE WHEN sweep THEN v_main_at ELSE 'infinity'::timestamptz END,
                 CASE WHEN sweep THEN v_main_id
                      ELSE 'ffffffff-ffff-ffff-ffff-ffffffffffff'::uuid END
               )
         ORDER BY outcome.finished_at, outcome.task_id
         LIMIT v_rows
      ) slice;
  END IF;
  IF sweep OR v_main_at IS NULL OR cardinality(task_ids) >= v_rows THEN
    RETURN NEXT;
    RETURN;
  END IF;
  -- The rows after the main position are fewer than the slice, so the main walk continues from the
  -- oldest row up to its position.
  IF p_tier = 'full' THEN
    SELECT task_ids || COALESCE(array_agg(slice.task_id ORDER BY slice.finished_at, slice.task_id),
                                '{}'::uuid[]),
           finished_ats || COALESCE(array_agg(slice.finished_at
                                      ORDER BY slice.finished_at, slice.task_id),
                                    '{}'::timestamptz[]),
           count(*) > 0
      INTO task_ids, finished_ats, wrapped
      FROM (
        SELECT outcome.finished_at, outcome.task_id
          FROM workhorse.task_outcome outcome
         WHERE outcome.finished_at < p_before
           AND (outcome.finished_at, outcome.task_id) <= (v_main_at, v_main_id)
         ORDER BY outcome.finished_at, outcome.task_id
         LIMIT v_rows - cardinality(task_ids)
      ) slice;
  ELSE
    SELECT task_ids || COALESCE(array_agg(slice.task_id ORDER BY slice.finished_at, slice.task_id),
                                '{}'::uuid[]),
           finished_ats || COALESCE(array_agg(slice.finished_at
                                      ORDER BY slice.finished_at, slice.task_id),
                                    '{}'::timestamptz[]),
           count(*) > 0
      INTO task_ids, finished_ats, wrapped
      FROM (
        SELECT outcome.finished_at, outcome.task_id
          FROM workhorse.fast_task_outcome outcome
         WHERE outcome.finished_at < p_before
           AND (outcome.finished_at, outcome.task_id) <= (v_main_at, v_main_id)
         ORDER BY outcome.finished_at, outcome.task_id
         LIMIT v_rows - cardinality(task_ids)
      ) slice;
  END IF;
  RETURN NEXT;
END;
$$;

CREATE OR REPLACE FUNCTION workhorse.store_terminal_prune_slice_internal_v1(
  p_tier text, p_sweep boolean, p_start_at timestamptz, p_start_id uuid,
  p_end_at timestamptz, p_end_id uuid, p_wrapped boolean, p_whole boolean, p_deleted integer,
  p_filled boolean, p_last_at timestamptz, p_last_id uuid
) RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE v_quiet_at timestamptz;
DECLARE v_quiet_id uuid;
DECLARE v_start_at timestamptz := COALESCE(p_start_at, '-infinity'::timestamptz);
DECLARE v_start_id uuid := COALESCE(p_start_id, '00000000-0000-0000-0000-000000000000'::uuid);
BEGIN
  INSERT INTO workhorse.terminal_prune_position(tier) VALUES (p_tier)
  ON CONFLICT (tier) DO NOTHING;
  IF p_sweep THEN
    -- A sweep batch that filled its limit continues after its last locked row, also in a short
    -- slice, so the next sweep batch does not walk the rows before that row again.
    UPDATE workhorse.terminal_prune_position
       SET sweep_finished_at = CASE WHEN p_filled THEN p_last_at
                                    WHEN p_whole OR p_end_at IS NULL THEN NULL ELSE p_end_at END,
           sweep_task_id = CASE WHEN p_filled THEN p_last_id
                                WHEN p_whole OR p_end_at IS NULL THEN NULL ELSE p_end_id END,
           sweep_next = false
     WHERE tier = p_tier;
    RETURN;
  END IF;
  IF p_whole OR p_end_at IS NULL THEN
    UPDATE workhorse.terminal_prune_position
       SET finished_at = NULL, task_id = NULL, quiet_finished_at = NULL, quiet_task_id = NULL,
           sweep_finished_at = NULL, sweep_task_id = NULL, sweep_next = false
     WHERE tier = p_tier;
    RETURN;
  END IF;
  IF p_deleted > 0 THEN
    UPDATE workhorse.terminal_prune_position
       SET finished_at = CASE WHEN p_filled THEN p_last_at ELSE p_end_at END,
           task_id = CASE WHEN p_filled THEN p_last_id ELSE p_end_id END,
           quiet_finished_at = NULL, quiet_task_id = NULL, sweep_next = true
     WHERE tier = p_tier;
    RETURN;
  END IF;
  SELECT position.quiet_finished_at, position.quiet_task_id INTO v_quiet_at, v_quiet_id
    FROM workhorse.terminal_prune_position position WHERE position.tier = p_tier;
  IF v_quiet_at IS NOT NULL AND (
       (NOT p_wrapped
         AND (v_quiet_at, v_quiet_id) > (v_start_at, v_start_id)
         AND (v_quiet_at, v_quiet_id) <= (p_end_at, p_end_id))
       OR (p_wrapped
         AND ((v_quiet_at, v_quiet_id) > (v_start_at, v_start_id)
              OR (v_quiet_at, v_quiet_id) <= (p_end_at, p_end_id)))
     ) THEN
    UPDATE workhorse.terminal_prune_position
       SET finished_at = NULL, task_id = NULL, quiet_finished_at = NULL, quiet_task_id = NULL,
           sweep_finished_at = NULL, sweep_task_id = NULL, sweep_next = false
     WHERE tier = p_tier;
    RETURN;
  END IF;
  UPDATE workhorse.terminal_prune_position
     SET finished_at = p_end_at, task_id = p_end_id,
         quiet_finished_at = COALESCE(v_quiet_at, v_start_at),
         quiet_task_id = COALESCE(v_quiet_id, v_start_id),
         sweep_next = true
   WHERE tier = p_tier;
END;
$$;

CREATE OR REPLACE FUNCTION workhorse.prune_full_terminal_tasks_internal_v1(
  p_identity_before timestamptz, p_outcome_before timestamptz,
  p_history_before timestamptz, p_limit integer
) RETURNS TABLE (pruned integer, dependency_starved boolean)
LANGUAGE plpgsql
AS $$
DECLARE v_now timestamptz := clock_timestamp();
DECLARE v_slice record;
DECLARE v_slice_rows integer;
DECLARE v_open uuid[] := '{}'::uuid[];
DECLARE v_open_at timestamptz[] := '{}'::timestamptz[];
DECLARE v_due uuid[] := '{}'::uuid[];
DECLARE v_locked uuid[] := '{}'::uuid[];
DECLARE v_last_at timestamptz;
DECLARE v_last_id uuid;
DECLARE v_candidates uuid[];
DECLARE v_released uuid[];
DECLARE v_count integer;
DECLARE v_filled boolean;
DECLARE v_hold_ids uuid[];
DECLARE v_hold_ends timestamptz[];
DECLARE v_blocked uuid[];
BEGIN
  IF p_limit < 1 THEN
    pruned := 0;
    dependency_starved := NULL;
    RETURN NEXT;
    RETURN;
  END IF;
  pruned := 0;
  -- history_through_at is at or after finished_at, so the history cutoff bounds the slice too.
  SELECT * INTO v_slice
    FROM workhorse.read_terminal_prune_slice_internal_v1(
      'full', LEAST(p_outcome_before, p_history_before), p_limit
    );
  v_slice_rows := cardinality(v_slice.task_ids);
  -- Each row of the slice is one lookup of its task and one call of the reference test. A generic
  -- plan cannot change this into a scan of a whole table.
  IF v_slice_rows > 0 THEN
    -- v_due holds each row of the slice that passes every cutoff. Only such a row can show that a
    -- dependency edge stops the batch: a row inside a window only waits for it. The OFFSET 0 keeps
    -- each level apart, so the reference test runs one time for each row that passes the cutoffs.
    SELECT COALESCE(array_agg(tested.id ORDER BY tested.position) FILTER (WHERE tested.kept IS FALSE),
                    '{}'::uuid[]),
           COALESCE(array_agg(tested.at ORDER BY tested.position) FILTER (WHERE tested.kept IS FALSE),
                    '{}'::timestamptz[]),
           COALESCE(array_agg(tested.id ORDER BY tested.position), '{}'::uuid[])
      INTO v_open, v_open_at, v_due
      FROM (
        SELECT due.id, due.at, due.position,
               workhorse.terminal_row_kept_internal_v1(
                 due.id, v_now, p_identity_before, p_outcome_before, p_history_before
               ) AS kept
          FROM (
            SELECT slice.id, slice.at, slice.position
              FROM unnest(v_slice.task_ids, v_slice.finished_ats) WITH ORDINALITY
                     AS slice(id, at, position)
              CROSS JOIN LATERAL (
                SELECT task.created_at FROM workhorse.task task WHERE task.id = slice.id LIMIT 1
              ) identity
              CROSS JOIN LATERAL (
                SELECT outcome.finished_at, outcome.history_through_at
                  FROM workhorse.task_outcome outcome WHERE outcome.task_id = slice.id LIMIT 1
              ) terminal
             WHERE identity.created_at < p_identity_before
               AND terminal.finished_at < p_outcome_before
               AND terminal.history_through_at < p_history_before
            OFFSET 0
          ) due
        OFFSET 0
      ) tested;
  END IF;
  -- An empty list locks nothing, and a generic plan could still scan the table for it.
  IF cardinality(v_open) > 0 THEN
    SELECT COALESCE(array_agg(locked.id ORDER BY locked.position), '{}'::uuid[]),
           (array_agg(locked.at ORDER BY locked.position DESC))[1],
           (array_agg(locked.id ORDER BY locked.position DESC))[1]
      INTO v_locked, v_last_at, v_last_id
      FROM (
        -- task.id = ANY keeps the lock on the primary key also under a generic plan. The position
        -- comes from the slice, so no row searches the array.
        SELECT task.id, slice.at, slice.position
          FROM workhorse.task task
          JOIN unnest(v_open, v_open_at) WITH ORDINALITY AS slice(id, at, position)
            ON slice.id = task.id
         WHERE task.id = ANY(v_open)
         ORDER BY slice.position
         FOR UPDATE OF task SKIP LOCKED
         LIMIT p_limit
      ) locked;
  END IF;
  v_filled := cardinality(v_locked) >= p_limit;
  -- Each round deletes at least one row or ends the loop, so a batch runs at most p_limit rounds,
  -- and each statement of a round handles at most p_limit rows. A round after the first one takes
  -- the next link of each redrive chain whose target the batch deleted.
  LOOP
    EXIT WHEN cardinality(v_locked) = 0;
    -- The batch filters again, now with a snapshot taken after the locks.
    SELECT COALESCE(array_agg(locked.id ORDER BY locked.position), '{}'::uuid[])
      INTO v_candidates
      FROM (
        SELECT locked.id, locked.position
          FROM unnest(v_locked) WITH ORDINALITY AS locked(id, position)
          CROSS JOIN LATERAL (
            SELECT task.created_at FROM workhorse.task task WHERE task.id = locked.id LIMIT 1
          ) identity
          CROSS JOIN LATERAL (
            SELECT outcome.finished_at, outcome.history_through_at
              FROM workhorse.task_outcome outcome WHERE outcome.task_id = locked.id LIMIT 1
          ) terminal
         WHERE identity.created_at < p_identity_before
           AND terminal.finished_at < p_outcome_before
           AND terminal.history_through_at < p_history_before
           AND workhorse.terminal_row_kept_internal_v1(
                 locked.id, v_now, p_identity_before, p_outcome_before, p_history_before
               ) IS FALSE
         ORDER BY locked.position
         LIMIT p_limit - pruned
      ) locked;
    EXIT WHEN cardinality(v_candidates) = 0;
    -- A deleted task can hold a task that stays: a parent of a deleted child, a prerequisite of a
    -- deleted dependent, or a redrive source of a deleted target. The cascade of the delete removes
    -- that reference, so the batch saves the end of each such hold first (ADR 0122). If another
    -- transaction holds the outcome of a held task, the batch keeps the candidates that hold it, and
    -- their locks end with the pass. A kept candidate then stays and holds its own children,
    -- dependents, and sources, so the batch computes the holds again for the candidates that remain.
    -- Each repeat keeps at least one more candidate, so the loop ends.
    <<holds>>
    LOOP
      SELECT COALESCE(array_agg(hold.task_id), '{}'::uuid[]),
             COALESCE(array_agg(hold.at), '{}'::timestamptz[])
        INTO v_hold_ids, v_hold_ends
        FROM (
          SELECT edge.parent_task_id AS task_id,
                 workhorse.terminal_child_hold_end_internal_v1(edge.child_task_id) AS at
            FROM workhorse.task_child edge
           WHERE edge.child_task_id = ANY(v_candidates)
             AND NOT edge.parent_task_id = ANY(v_candidates)
          UNION ALL
          SELECT dependency.prerequisite_task_id, dependent.finished_at
            FROM workhorse.task_dependency dependency
            JOIN workhorse.task_outcome dependent ON dependent.task_id = dependency.dependent_task_id
           WHERE dependency.dependent_task_id = ANY(v_candidates)
             AND NOT dependency.prerequisite_task_id = ANY(v_candidates)
          UNION ALL
          SELECT redrive.source_task_id, v_now
            FROM workhorse.task_redrive redrive
           WHERE redrive.target_task_id = ANY(v_candidates)
             AND NOT redrive.source_task_id = ANY(v_candidates)
        ) hold;
      EXIT holds WHEN cardinality(v_hold_ids) = 0;
      v_blocked := workhorse.save_terminal_hold_ends_internal_v1(v_hold_ids, v_hold_ends);
      EXIT holds WHEN cardinality(v_blocked) = 0;
      SELECT COALESCE(array_agg(kept.id ORDER BY kept.position), '{}'::uuid[])
        INTO v_candidates
        FROM unnest(v_candidates) WITH ORDINALITY AS kept(id, position)
       WHERE NOT EXISTS (
               SELECT 1 FROM workhorse.task_child edge
                WHERE edge.child_task_id = kept.id AND edge.parent_task_id = ANY(v_blocked)
             )
         AND NOT EXISTS (
               SELECT 1 FROM workhorse.task_dependency dependency
                WHERE dependency.dependent_task_id = kept.id
                  AND dependency.prerequisite_task_id = ANY(v_blocked)
             )
         AND NOT EXISTS (
               SELECT 1 FROM workhorse.task_redrive redrive
                WHERE redrive.target_task_id = kept.id AND redrive.source_task_id = ANY(v_blocked)
             );
      EXIT holds WHEN cardinality(v_candidates) = 0;
    END LOOP holds;
    EXIT WHEN cardinality(v_candidates) = 0;
    WITH released AS (
      -- This statement reads task_redrive before its delete, so it finds the sources of the targets
      -- that it deletes.
      SELECT DISTINCT redrive.source_task_id AS id
        FROM workhorse.task_redrive redrive
       WHERE redrive.target_task_id = ANY(v_candidates)
    ), deleted AS (
      DELETE FROM workhorse.task task WHERE task.id = ANY(v_candidates)
      RETURNING task.id
    )
    SELECT (SELECT count(*)::integer FROM deleted),
           COALESCE((SELECT array_agg(released.id ORDER BY released.id) FROM released),
                    '{}'::uuid[])
      INTO STRICT v_count, v_released;
    pruned := pruned + v_count;
    EXIT WHEN pruned >= p_limit OR cardinality(v_released) = 0;
    -- The next round locks only the released sources that no reference keeps, up to the rest of the
    -- limit. Its statements above check each of them again after the lock.
    SELECT COALESCE(array_agg(source.id ORDER BY source.id), '{}'::uuid[])
      INTO v_released
      FROM unnest(v_released) AS source(id)
      CROSS JOIN LATERAL (
        SELECT task.created_at FROM workhorse.task task WHERE task.id = source.id LIMIT 1
      ) identity
      CROSS JOIN LATERAL (
        SELECT outcome.finished_at, outcome.history_through_at
          FROM workhorse.task_outcome outcome WHERE outcome.task_id = source.id LIMIT 1
      ) terminal
     WHERE identity.created_at < p_identity_before
       AND terminal.finished_at < p_outcome_before
       AND terminal.history_through_at < p_history_before
       AND workhorse.terminal_row_kept_internal_v1(
             source.id, v_now, p_identity_before, p_outcome_before, p_history_before
           ) IS FALSE;
    EXIT WHEN cardinality(v_released) = 0;
    SELECT COALESCE(array_agg(source.id ORDER BY source.id), '{}'::uuid[])
      INTO v_locked
      FROM (
        SELECT task.id
          FROM workhorse.task task
         WHERE task.id = ANY(v_released)
         ORDER BY task.id
         FOR UPDATE OF task SKIP LOCKED
         LIMIT p_limit - pruned
      ) source;
  END LOOP;
  PERFORM workhorse.store_terminal_prune_slice_internal_v1(
    'full', v_slice.sweep, v_slice.start_at, v_slice.start_id,
    v_slice.finished_ats[v_slice_rows], v_slice.task_ids[v_slice_rows], v_slice.wrapped,
    v_slice_rows < workhorse.terminal_prune_slice_rows_internal_v1(p_limit), pruned, v_filled,
    v_last_at, v_last_id
  );
  dependency_starved := false;
  IF pruned = 0 AND cardinality(v_due) > 0 THEN
    -- The batch deleted nothing. It reports a dependency edge that keeps a prerequisite of its
    -- slice that passes every cutoff, as before migration 0097. One lookup for each row of the slice finds the pinned prerequisites. The probe locks only those, FOR KEY SHARE and SKIP LOCKED, so it
    -- skips a row that another transaction locks, as the lock does. That lock blocks only a delete
    -- of the prerequisite, and it ends when the pass commits.
    SELECT COALESCE(array_agg(slice.id), '{}'::uuid[])
      INTO v_candidates
      FROM unnest(v_due) AS slice(id)
     CROSS JOIN LATERAL (
       SELECT 1
         FROM workhorse.task_dependency dependency
        WHERE dependency.prerequisite_task_id = slice.id
        LIMIT 1
     ) pinned;
    IF cardinality(v_candidates) > 0 THEN
      SELECT EXISTS (
        SELECT 1 FROM workhorse.task task
         WHERE task.id = ANY(v_candidates)
         FOR KEY SHARE OF task SKIP LOCKED
      ) INTO STRICT dependency_starved;
    END IF;
  END IF;
  RETURN NEXT;
END;
$$;

CREATE OR REPLACE FUNCTION workhorse.prune_fast_terminal_tasks_internal_v1(
  p_identity_before timestamptz, p_outcome_before timestamptz,
  p_fast_before timestamptz, p_limit integer
) RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE v_now timestamptz := clock_timestamp();
DECLARE v_count integer := 0;
DECLARE v_released uuid[];
DECLARE v_deleted integer;
DECLARE v_slice record;
DECLARE v_slice_rows integer;
DECLARE v_open uuid[] := '{}'::uuid[];
DECLARE v_open_at timestamptz[] := '{}'::timestamptz[];
DECLARE v_locked uuid[] := '{}'::uuid[];
DECLARE v_last_at timestamptz;
DECLARE v_last_id uuid;
DECLARE v_filled boolean;
DECLARE v_hold_ids uuid[];
DECLARE v_hold_ends timestamptz[];
DECLARE v_blocked uuid[];
BEGIN
  IF p_limit < 1 THEN RETURN 0; END IF;
  SELECT * INTO v_slice
    FROM workhorse.read_terminal_prune_slice_internal_v1(
      'fast', LEAST(p_outcome_before, p_fast_before), p_limit
    );
  v_slice_rows := cardinality(v_slice.task_ids);
  IF v_slice_rows > 0 THEN
    SELECT COALESCE(array_agg(slice.id ORDER BY slice.position), '{}'::uuid[]),
           COALESCE(array_agg(slice.at ORDER BY slice.position), '{}'::timestamptz[])
      INTO v_open, v_open_at
      FROM unnest(v_slice.task_ids, v_slice.finished_ats) WITH ORDINALITY AS slice(id, at, position)
      CROSS JOIN LATERAL (
        SELECT task.created_at FROM workhorse.task task WHERE task.id = slice.id LIMIT 1
      ) identity
     WHERE identity.created_at < p_identity_before
       AND slice.at < p_outcome_before
       AND slice.at < p_fast_before
       AND workhorse.terminal_row_kept_internal_v1(
             slice.id, v_now, p_identity_before, p_outcome_before, p_fast_before
           ) IS FALSE;
  END IF;
  IF cardinality(v_open) > 0 THEN
    SELECT COALESCE(array_agg(locked.id ORDER BY locked.position), '{}'::uuid[]),
           (array_agg(locked.at ORDER BY locked.position DESC))[1],
           (array_agg(locked.id ORDER BY locked.position DESC))[1]
      INTO v_locked, v_last_at, v_last_id
      FROM (
        -- task.id = ANY keeps the lock on the primary key also under a generic plan. The position
        -- comes from the slice, so no row searches the array.
        SELECT task.id, slice.at, slice.position
          FROM workhorse.task task
          JOIN unnest(v_open, v_open_at) WITH ORDINALITY AS slice(id, at, position)
            ON slice.id = task.id
         WHERE task.id = ANY(v_open)
         ORDER BY slice.position
         FOR UPDATE OF task SKIP LOCKED
         LIMIT p_limit
      ) locked;
  END IF;
  v_filled := cardinality(v_locked) >= p_limit;
  -- Each round deletes at least one row or ends the loop, as in the full tier.
  LOOP
    EXIT WHEN cardinality(v_locked) = 0;
    -- The batch filters again, now with a snapshot taken after the locks.
    SELECT COALESCE(array_agg(locked.id), '{}'::uuid[])
      INTO v_locked
      FROM unnest(v_locked) AS locked(id)
     WHERE workhorse.terminal_row_kept_internal_v1(
             locked.id, v_now, p_identity_before, p_outcome_before, p_fast_before
           ) IS FALSE;
    EXIT WHEN cardinality(v_locked) = 0;
    -- A deleted task can hold a task that stays: a parent of a deleted child, a prerequisite of a
    -- deleted dependent, or a redrive source of a deleted target. The cascade of the delete removes
    -- that reference, so the batch saves the end of each such hold first (ADR 0122). If another
    -- transaction holds the outcome of a held task, the batch keeps the candidates that hold it, and
    -- their locks end with the pass. A kept candidate then stays and holds its own children,
    -- dependents, and sources, so the batch computes the holds again for the candidates that remain.
    -- Each repeat keeps at least one more candidate, so the loop ends.
    <<holds>>
    LOOP
      SELECT COALESCE(array_agg(hold.task_id), '{}'::uuid[]),
             COALESCE(array_agg(hold.at), '{}'::timestamptz[])
        INTO v_hold_ids, v_hold_ends
        FROM (
          SELECT edge.parent_task_id AS task_id,
                 workhorse.terminal_child_hold_end_internal_v1(edge.child_task_id) AS at
            FROM workhorse.task_child edge
           WHERE edge.child_task_id = ANY(v_locked)
             AND NOT edge.parent_task_id = ANY(v_locked)
          UNION ALL
          SELECT dependency.prerequisite_task_id, dependent.finished_at
            FROM workhorse.task_dependency dependency
            JOIN workhorse.task_outcome dependent ON dependent.task_id = dependency.dependent_task_id
           WHERE dependency.dependent_task_id = ANY(v_locked)
             AND NOT dependency.prerequisite_task_id = ANY(v_locked)
          UNION ALL
          SELECT redrive.source_task_id, v_now
            FROM workhorse.task_redrive redrive
           WHERE redrive.target_task_id = ANY(v_locked)
             AND NOT redrive.source_task_id = ANY(v_locked)
        ) hold;
      EXIT holds WHEN cardinality(v_hold_ids) = 0;
      v_blocked := workhorse.save_terminal_hold_ends_internal_v1(v_hold_ids, v_hold_ends);
      EXIT holds WHEN cardinality(v_blocked) = 0;
      SELECT COALESCE(array_agg(kept.id ORDER BY kept.position), '{}'::uuid[])
        INTO v_locked
        FROM unnest(v_locked) WITH ORDINALITY AS kept(id, position)
       WHERE NOT EXISTS (
               SELECT 1 FROM workhorse.task_child edge
                WHERE edge.child_task_id = kept.id AND edge.parent_task_id = ANY(v_blocked)
             )
         AND NOT EXISTS (
               SELECT 1 FROM workhorse.task_dependency dependency
                WHERE dependency.dependent_task_id = kept.id
                  AND dependency.prerequisite_task_id = ANY(v_blocked)
             )
         AND NOT EXISTS (
               SELECT 1 FROM workhorse.task_redrive redrive
                WHERE redrive.target_task_id = kept.id AND redrive.source_task_id = ANY(v_blocked)
             );
      EXIT holds WHEN cardinality(v_locked) = 0;
    END LOOP holds;
    EXIT WHEN cardinality(v_locked) = 0;
    WITH released AS (
      SELECT DISTINCT redrive.source_task_id AS id
        FROM workhorse.task_redrive redrive
       WHERE redrive.target_task_id = ANY(v_locked)
    ), deleted AS (
      DELETE FROM workhorse.task task WHERE task.id = ANY(v_locked)
      RETURNING task.id
    )
    SELECT (SELECT count(*)::integer FROM deleted),
           COALESCE((SELECT array_agg(released.id ORDER BY released.id) FROM released),
                    '{}'::uuid[])
      INTO STRICT v_deleted, v_released;
    v_count := v_count + v_deleted;
    EXIT WHEN v_count >= p_limit OR cardinality(v_released) = 0;
    SELECT COALESCE(array_agg(source.id ORDER BY source.id), '{}'::uuid[])
      INTO v_locked
      FROM (
        SELECT task.id
          FROM workhorse.task task
          JOIN workhorse.fast_task_outcome outcome ON outcome.task_id = task.id
         WHERE task.id = ANY(v_released)
           AND task.created_at < p_identity_before
           AND outcome.finished_at < p_outcome_before
           AND outcome.finished_at < p_fast_before
           AND workhorse.terminal_row_kept_internal_v1(
                 task.id, v_now, p_identity_before, p_outcome_before, p_fast_before
               ) IS FALSE
         ORDER BY task.id
         FOR UPDATE OF task SKIP LOCKED
         LIMIT p_limit - v_count
      ) source;
  END LOOP;
  PERFORM workhorse.store_terminal_prune_slice_internal_v1(
    'fast', v_slice.sweep, v_slice.start_at, v_slice.start_id,
    v_slice.finished_ats[v_slice_rows], v_slice.task_ids[v_slice_rows], v_slice.wrapped,
    v_slice_rows < workhorse.terminal_prune_slice_rows_internal_v1(p_limit), v_count, v_filled,
    v_last_at, v_last_id
  );
  RETURN v_count;
END;
$$;

CREATE OR REPLACE FUNCTION workhorse.prune_released_dependencies_v1(p_limit integer)
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE v_count integer;
BEGIN
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100000 THEN
    RAISE EXCEPTION 'released dependency limit must be between 1 and 100000';
  END IF;
  WITH candidates AS MATERIALIZED (
    SELECT dependency.dependent_task_id, dependency.prerequisite_task_id,
           outcome.finished_at AS dependent_finished_at
      FROM workhorse.task_dependency dependency
      JOIN workhorse.task_outcome outcome ON outcome.task_id = dependency.dependent_task_id
     WHERE dependency.released_at IS NOT NULL
     ORDER BY dependency.released_at,
              dependency.dependent_task_id,
              dependency.prerequisite_task_id
       FOR UPDATE OF dependency SKIP LOCKED
     LIMIT p_limit
  ), blocked AS MATERIALIZED (
    -- The prerequisites whose outcome needs the write but another transaction locks.
    SELECT workhorse.save_terminal_hold_ends_internal_v1(
             array_agg(candidates.prerequisite_task_id), array_agg(candidates.dependent_finished_at)
           ) AS task_ids
      FROM candidates
  )
  DELETE FROM workhorse.task_dependency dependency USING candidates, blocked
   WHERE dependency.dependent_task_id = candidates.dependent_task_id
     AND dependency.prerequisite_task_id = candidates.prerequisite_task_id
     AND NOT candidates.prerequisite_task_id = ANY(blocked.task_ids);
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

CREATE OR REPLACE FUNCTION workhorse.prune_enqueue_idempotency_v1(
  p_before timestamptz, p_limit integer
) RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE v_count integer;
DECLARE v_purge_count integer := 0;
DECLARE v_purge_retention_days integer;
BEGIN
  IF p_before IS NULL OR NOT isfinite(p_before) THEN
    RAISE EXCEPTION 'idempotency cutoff is required';
  END IF;
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100000 THEN
    RAISE EXCEPTION 'idempotency prune limit must be between 1 and 100000';
  END IF;
  WITH candidates AS MATERIALIZED (
    SELECT idempotency.idempotency_scope, idempotency.idempotency_key_hash,
           idempotency.task_id, idempotency.expires_at
      FROM workhorse.enqueue_idempotency idempotency
     WHERE idempotency.expires_at <= p_before
       AND NOT (
         idempotency.coalescing_mode = 'debounce'
         AND EXISTS (
           SELECT 1 FROM workhorse.task_runtime runtime
            WHERE runtime.task_id = idempotency.task_id
              AND runtime.state IN ('ready', 'scheduled')
         )
       )
     ORDER BY idempotency.expires_at, idempotency.idempotency_scope,
              idempotency.idempotency_key_hash
     FOR UPDATE OF idempotency SKIP LOCKED
     LIMIT p_limit
  ), blocked AS MATERIALIZED (
    -- The tasks whose outcome needs the write but another transaction locks.
    SELECT workhorse.save_terminal_hold_ends_internal_v1(
             array_agg(candidates.task_id), array_agg(candidates.expires_at)
           ) AS task_ids
      FROM candidates
  )
  DELETE FROM workhorse.enqueue_idempotency idempotency USING candidates, blocked
   WHERE idempotency.idempotency_scope = candidates.idempotency_scope
     AND idempotency.idempotency_key_hash = candidates.idempotency_key_hash
     AND NOT candidates.task_id = ANY(blocked.task_ids);
  GET DIAGNOSTICS v_count = ROW_COUNT;
  SELECT task_identity_retention_days INTO v_purge_retention_days
    FROM workhorse.retention_policy WHERE singleton;
  IF v_purge_retention_days IS NOT NULL THEN
    WITH candidates AS MATERIALIZED (
      SELECT request_id_hash
        FROM workhorse.queue_purge_request
       WHERE requested_at < p_before - make_interval(hours => 24 * v_purge_retention_days)
       ORDER BY requested_at, request_id_hash
       FOR UPDATE SKIP LOCKED
       LIMIT p_limit
    )
    DELETE FROM workhorse.queue_purge_request request USING candidates
     WHERE request.request_id_hash = candidates.request_id_hash;
    GET DIAGNOSTICS v_purge_count = ROW_COUNT;
  END IF;
  RETURN v_count + v_purge_count;
END;
$$;

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
DECLARE v_state workhorse.task_stat_state%ROWTYPE;
DECLARE v_policy workhorse.retention_policy%ROWTYPE;
DECLARE v_maintenance workhorse.maintenance_policy%ROWTYPE;
DECLARE v_from timestamptz;
DECLARE v_to timestamptz;
DECLARE v_closed timestamptz;
DECLARE v_hour_from timestamptz;
DECLARE v_hour_to timestamptz;
DECLARE v_day_from timestamptz;
DECLARE v_day_to timestamptz;
DECLARE v_keep_minutes_from timestamptz;
DECLARE v_keep_hours_from timestamptz;
DECLARE v_inserted integer; BEGIN
  IF p_now IS NULL OR NOT isfinite(p_now) THEN RAISE EXCEPTION 'maintenance time is required'; END IF;
  IF p_max_buckets IS NULL OR p_max_buckets NOT BETWEEN 1 AND 100000 THEN
    RAISE EXCEPTION 'bucket limit must be between 1 and 100000';
  END IF;
  IF NOT pg_try_advisory_xact_lock(hashtextextended('workhorse:maintenance:stat-rollup', 0)) THEN
    RETURN QUERY VALUES
      ('stat_rollup'::text, 0, 0, true, NULL::jsonb),
      ('stat_retention'::text, 0, 0, true, NULL::jsonb);
    RETURN;
  END IF;
  SELECT * INTO STRICT v_maintenance FROM workhorse.maintenance_policy WHERE singleton;
  SELECT * INTO STRICT v_state FROM workhorse.task_stat_state WHERE singleton FOR UPDATE;
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
  v_started_at := clock_timestamp(); BEGIN
    v_closed := date_bin('1 minute', p_now, timestamp '2000-01-01' AT TIME ZONE 'UTC');
    v_from := LEAST(
      v_state.rolled_up_through
        - make_interval(mins => v_maintenance.statistics_recompute_buckets),
      v_closed
    );
    -- Catching up after an outage advances in bounded passes rather than in one long transaction.
    v_to := LEAST(v_closed, v_from + make_interval(mins => p_max_buckets));
    IF v_to > v_from THEN
      DELETE FROM workhorse.task_stat_bucket
       WHERE bucket_start >= v_from AND bucket_start < v_to;
      INSERT INTO workhorse.task_stat_bucket (
        bucket_start, queue_name, task_type, enqueued,
        task_succeeded, task_failed, task_canceled,
        attempt_succeeded, attempt_failed, attempt_retry,
        attempt_lease_expired, attempt_canceled, attempt_other,
        attempt_duration_ms, wait_sketch, last_attempt_at, last_error, last_error_at
      )
      SELECT * FROM workhorse.aggregate_stats_v1(v_from, v_to, v_maintenance.statistics_group_limit);
      GET DIAGNOSTICS rows_affected = ROW_COUNT;

      v_hour_from := LEAST(
        v_state.hourly_rolled_up_through,
        date_bin('1 hour', v_from, timestamp '2000-01-01' AT TIME ZONE 'UTC')
      );
      v_hour_to := date_bin('1 hour', v_to, timestamp '2000-01-01' AT TIME ZONE 'UTC');
      IF v_hour_to > v_hour_from THEN
        DELETE FROM workhorse.task_stat_bucket_hour
         WHERE bucket_start >= v_hour_from AND bucket_start < v_hour_to;
        INSERT INTO workhorse.task_stat_bucket_hour (
          bucket_start, queue_name, task_type, enqueued,
          task_succeeded, task_failed, task_canceled,
          attempt_succeeded, attempt_failed, attempt_retry,
          attempt_lease_expired, attempt_canceled, attempt_other,
          attempt_duration_ms, wait_sketch, last_attempt_at, last_error, last_error_at
        )
        SELECT date_bin('1 hour', bucket.bucket_start,
                        timestamp '2000-01-01' AT TIME ZONE 'UTC'),
               bucket.queue_name, bucket.task_type,
               sum(bucket.enqueued), sum(bucket.task_succeeded), sum(bucket.task_failed),
               sum(bucket.task_canceled), sum(bucket.attempt_succeeded),
               sum(bucket.attempt_failed), sum(bucket.attempt_retry),
               sum(bucket.attempt_lease_expired), sum(bucket.attempt_canceled),
               sum(bucket.attempt_other), sum(bucket.attempt_duration_ms),
               workhorse.stat_sketch_merge_v1(array_agg(bucket.wait_sketch)),
               max(bucket.last_attempt_at),
               (array_agg(bucket.last_error ORDER BY bucket.last_error_at DESC NULLS LAST)
                 FILTER (WHERE bucket.last_error IS NOT NULL))[1],
               max(bucket.last_error_at)
          FROM workhorse.task_stat_bucket bucket
         WHERE bucket.bucket_start >= v_hour_from AND bucket.bucket_start < v_hour_to
         GROUP BY 1, 2, 3;
        GET DIAGNOSTICS v_inserted = ROW_COUNT;
        rows_affected := rows_affected + v_inserted;
      ELSE
        v_hour_to := v_state.hourly_rolled_up_through;
      END IF;

      v_day_from := LEAST(
        v_state.daily_rolled_up_through,
        date_bin('1 day', v_hour_from, timestamp '2000-01-01' AT TIME ZONE 'UTC')
      );
      v_day_to := date_bin('1 day', v_hour_to, timestamp '2000-01-01' AT TIME ZONE 'UTC');
      IF v_day_to > v_day_from THEN
        DELETE FROM workhorse.task_stat_bucket_day
         WHERE bucket_start >= v_day_from AND bucket_start < v_day_to;
        INSERT INTO workhorse.task_stat_bucket_day (
          bucket_start, queue_name, task_type, enqueued,
          task_succeeded, task_failed, task_canceled,
          attempt_succeeded, attempt_failed, attempt_retry,
          attempt_lease_expired, attempt_canceled, attempt_other,
          attempt_duration_ms, wait_sketch, last_attempt_at, last_error, last_error_at
        )
        SELECT date_bin('1 day', bucket.bucket_start,
                        timestamp '2000-01-01' AT TIME ZONE 'UTC'),
               bucket.queue_name, bucket.task_type,
               sum(bucket.enqueued), sum(bucket.task_succeeded), sum(bucket.task_failed),
               sum(bucket.task_canceled), sum(bucket.attempt_succeeded),
               sum(bucket.attempt_failed), sum(bucket.attempt_retry),
               sum(bucket.attempt_lease_expired), sum(bucket.attempt_canceled),
               sum(bucket.attempt_other), sum(bucket.attempt_duration_ms),
               workhorse.stat_sketch_merge_v1(array_agg(bucket.wait_sketch)),
               max(bucket.last_attempt_at),
               (array_agg(bucket.last_error ORDER BY bucket.last_error_at DESC NULLS LAST)
                 FILTER (WHERE bucket.last_error IS NOT NULL))[1],
               max(bucket.last_error_at)
          FROM workhorse.task_stat_bucket_hour bucket
         WHERE bucket.bucket_start >= v_day_from AND bucket.bucket_start < v_day_to
         GROUP BY 1, 2, 3;
        GET DIAGNOSTICS v_inserted = ROW_COUNT;
        rows_affected := rows_affected + v_inserted;
      ELSE
        v_day_to := v_state.daily_rolled_up_through;
      END IF;

      UPDATE workhorse.task_stat_state
         SET rolled_up_through = v_to,
             hourly_rolled_up_through = GREATEST(hourly_rolled_up_through, v_hour_to),
             daily_rolled_up_through = GREATEST(daily_rolled_up_through, v_day_to),
             last_run_at = p_now, updated_at = clock_timestamp()
       WHERE singleton;
    ELSE
      UPDATE workhorse.task_stat_state
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
  --
  -- A coarser tier is built only from the finer rows that remain. After a long stop, a catch-up
  -- pass writes minute rows older than their retention, and the hour tier uses them only up to the
  -- last complete hour of the pass. The next pass also rebuilds the hour and the day that hold the
  -- start of its recompute window. Retention therefore keeps each minute row from the first hour
  -- that the next pass can rebuild, and each hour row from the first day that it can rebuild
  -- (SM-1978). In a normal pass those bounds are far newer than the retention cutoffs, so the same
  -- rows are deleted.
  phase := 'stat_retention';
  rows_affected := 0;
  error := NULL;
  v_started_at := clock_timestamp(); BEGIN
    SELECT * INTO STRICT v_state FROM workhorse.task_stat_state WHERE singleton;
    -- The same bounds as v_hour_from and v_day_from of the next pass.
    v_keep_minutes_from := LEAST(
      v_state.hourly_rolled_up_through,
      date_bin('1 hour',
               v_state.rolled_up_through
                 - make_interval(mins => v_maintenance.statistics_recompute_buckets),
               timestamp '2000-01-01' AT TIME ZONE 'UTC')
    );
    v_keep_hours_from := LEAST(
      v_state.daily_rolled_up_through,
      date_bin('1 day', v_keep_minutes_from, timestamp '2000-01-01' AT TIME ZONE 'UTC')
    );
    WITH expired AS (
      SELECT bucket.ctid
        FROM workhorse.task_stat_bucket bucket
       WHERE bucket.bucket_start < p_now - make_interval(
         hours => 24 * LEAST(COALESCE(v_policy.statistics_retention_days, 2), 2)
       )
         AND bucket.bucket_start < v_keep_minutes_from
       ORDER BY bucket.bucket_start
         FOR UPDATE SKIP LOCKED
       LIMIT v_policy.statistics_rows_per_pass
    )
    DELETE FROM workhorse.task_stat_bucket bucket USING expired
     WHERE bucket.ctid = expired.ctid;
    GET DIAGNOSTICS rows_affected = ROW_COUNT;

    WITH expired AS (
      SELECT bucket.ctid
        FROM workhorse.task_stat_bucket_hour bucket
       WHERE bucket.bucket_start < p_now - make_interval(
         hours => 24 * LEAST(COALESCE(v_policy.statistics_retention_days, 90), 90)
       )
         AND bucket.bucket_start < v_keep_hours_from
       ORDER BY bucket.bucket_start
         FOR UPDATE SKIP LOCKED
       LIMIT v_policy.statistics_rows_per_pass
    )
    DELETE FROM workhorse.task_stat_bucket_hour bucket USING expired
     WHERE bucket.ctid = expired.ctid;
    GET DIAGNOSTICS v_inserted = ROW_COUNT;
    rows_affected := rows_affected + v_inserted;

    IF v_policy.statistics_retention_days IS NOT NULL THEN
      WITH expired AS (
        SELECT bucket.ctid
          FROM workhorse.task_stat_bucket_day bucket
         WHERE bucket.bucket_start < p_now
               - make_interval(hours => 24 * v_policy.statistics_retention_days)
         ORDER BY bucket.bucket_start
           FOR UPDATE SKIP LOCKED
         LIMIT v_policy.statistics_rows_per_pass
      )
      DELETE FROM workhorse.task_stat_bucket_day bucket USING expired
       WHERE bucket.ctid = expired.ctid;
      GET DIAGNOSTICS v_inserted = ROW_COUNT;
      rows_affected := rows_affected + v_inserted;
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
DECLARE v_event_target timestamptz;
DECLARE v_attempt_target timestamptz;
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
    - make_interval(hours => 24 * COALESCE(v_policy.task_event_retention_days, 0));
  v_attempt_before := date_trunc('day', p_now AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
    - make_interval(hours => 24 * COALESCE(v_policy.attempt_history_retention_days, 0));
  v_occurrence_before := p_now
    - make_interval(hours => 24 * COALESCE(v_policy.schedule_occurrence_retention_days, 0));
  -- The policy cutoffs before any clamp. A pass is complete only when no history before them
  -- remains, so a pass that a clamp holds back records incomplete and stays due (SM-1979).
  v_event_target := v_event_before;
  v_attempt_target := v_attempt_before;
  -- Raw history is the only input a statistics bucket can be rebuilt from. Deleting past the rollup
  -- watermark would create a permanent hole in long-window operator views, so a stalled rollup
  -- holds history instead: the cutoff waits, retention reports itself incomplete and runs again on
  -- the next offer, and the growing retention lag is what surfaces on the health page.
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
      OR workhorse.history_retention_complete_v1('task_event', v_event_target)
    ) AND (
      v_policy.attempt_history_retention_days IS NULL
      OR workhorse.history_retention_complete_v1('attempt_history', v_attempt_target)
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
DECLARE v_starved boolean := false;
BEGIN
  IF p_now IS NULL OR NOT isfinite(p_now) THEN RAISE EXCEPTION 'maintenance time is required'; END IF;
  IF NOT pg_try_advisory_xact_lock(
    hashtextextended('workhorse:maintenance:terminal-storage', 0)
  ) THEN
    RETURN QUERY VALUES
      ('enqueue_idempotency'::text, 0, 0, true, NULL::jsonb),
      ('released_dependencies'::text, 0, 0, true, NULL::jsonb),
      ('terminal_tasks'::text, 0, 0, true, NULL::jsonb),
      ('task_groups'::text, 0, 0, true, NULL::jsonb);
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
      v_identity_before := p_now - make_interval(hours => 24 * v_policy.task_identity_retention_days);
      v_outcome_before := p_now - make_interval(hours => 24 * v_policy.terminal_outcome_retention_days);
      -- Batches repeat while each one fills or leaves a main position, until the phase has run for
      -- one second. A main position means that a batch examined its whole slice and more rows past
      -- the cutoffs follow. The time budget bounds how long one pass holds its transaction,
      -- whatever the batch limit.
      LOOP
        v_batch := workhorse.prune_terminal_tasks_v1(
          v_identity_before,
          v_outcome_before,
          v_history_before,
          v_policy.terminal_task_prune_limit
        );
        rows_affected := rows_affected + v_batch;
        -- Each batch examines another slice, so the pass keeps a pin that any batch saw.
        v_starved := v_starved OR COALESCE((
          SELECT state.terminal_prune_dependency_starved FROM workhorse.maintenance_state state
           WHERE state.routine_name = 'terminal_storage'
        ), false);
        EXIT WHEN (
            v_batch < v_policy.terminal_task_prune_limit
            AND NOT EXISTS (
              SELECT 1 FROM workhorse.terminal_prune_position position
               WHERE position.finished_at IS NOT NULL
            )
          )
          OR clock_timestamp() - v_started_at >= interval '1 second';
      END LOOP;
      -- The pass reports a pin when it deleted nothing and one of its batches saw a pin.
      UPDATE workhorse.maintenance_state
         SET terminal_prune_dependency_starved = rows_affected = 0 AND v_starved,
             updated_at = clock_timestamp()
       WHERE routine_name = 'terminal_storage';
      -- A pass that ends with a full batch left rows to delete. A pass that deleted rows and ends
      -- with a stored position left rows to examine. A pass that deleted nothing shows no backlog,
      -- also when it walked many kept rows.
      v_backlog := v_backlog OR v_batch >= v_policy.terminal_task_prune_limit
        OR (rows_affected > 0 AND EXISTS (
          SELECT 1 FROM workhorse.terminal_prune_position position
           WHERE position.finished_at IS NOT NULL
        ));
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
  RETURN NEXT;

  -- A finished group uses the retention period of terminal outcomes (ADR 0095).
  phase := 'task_groups';
  rows_affected := 0;
  error := NULL;
  v_started_at := clock_timestamp();
  BEGIN
    rows_affected := workhorse.maintain_task_groups_v1(
      CASE WHEN v_policy.terminal_outcome_retention_days IS NOT NULL
        THEN p_now - make_interval(hours => 24 * v_policy.terminal_outcome_retention_days) END,
      v_policy.terminal_task_prune_limit
    );
  EXCEPTION WHEN OTHERS THEN
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

CREATE OR REPLACE FUNCTION workhorse.maintain_task_groups_v1(
  p_outcome_before timestamptz, p_limit integer
) RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  v_group_id uuid;
  v_shard_count integer;
  v_finished_at timestamptz;
  v_members uuid[];
  v_locked integer;
  v_repaired integer := 0;
  v_deleted integer := 0;
BEGIN
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100000 THEN
    RAISE EXCEPTION 'task group maintenance limit must be between 1 and 100000';
  END IF;
  -- The phase selects the oldest sealed groups, and repairs them in identity order: the order of
  -- repair_task_group_drift_v1 and of the apply step. A repair keeps the locks of each group until
  -- the transaction ends, so another order could deadlock with an operator repair.
  FOR v_group_id IN
    SELECT oldest.id
      FROM (
        SELECT task_group.id
          FROM workhorse.task_group task_group
         WHERE task_group.state = 'sealed'
           AND NOT EXISTS (
                 SELECT 1
                   FROM workhorse.task_group_member member
                   JOIN workhorse.task_runtime runtime ON runtime.task_id = member.task_id
                  WHERE member.group_id = task_group.id AND member.outcome IS NULL
               )
         ORDER BY task_group.sealed_at, task_group.id
         LIMIT p_limit
      ) oldest
     ORDER BY oldest.id
  LOOP
    v_repaired := v_repaired + (
      SELECT count(*)::integer FROM workhorse.repair_task_group_internal_v1(
        v_group_id, jsonb_build_object('requested_by', 'maintenance')
      )
    );
  END LOOP;

  IF p_outcome_before IS NOT NULL THEN
    FOR v_group_id, v_shard_count, v_finished_at IN
      SELECT task_group.id, task_group.shard_count, task_group.finished_at
        FROM workhorse.task_group task_group
       WHERE task_group.state = 'finished'
         AND task_group.finished_at < p_outcome_before
         AND NOT EXISTS (
               SELECT 1
                 FROM workhorse.task_group_callback callback
                WHERE callback.group_id = task_group.id
                  AND (
                    EXISTS (SELECT 1 FROM workhorse.task_runtime runtime
                             WHERE runtime.task_id = callback.task_id)
                    OR EXISTS (SELECT 1 FROM workhorse.fast_task_runtime runtime
                                WHERE runtime.task_id = callback.task_id)
                  )
             )
       ORDER BY task_group.finished_at, task_group.id
       LIMIT p_limit
    LOOP
      PERFORM 1 FROM workhorse.task_group_shard shard
       WHERE shard.group_id = v_group_id
       ORDER BY shard.shard FOR UPDATE SKIP LOCKED;
      GET DIAGNOSTICS v_locked = ROW_COUNT;
      CONTINUE WHEN v_locked < v_shard_count;
      PERFORM 1 FROM workhorse.task_group task_group
       WHERE task_group.id = v_group_id
       FOR UPDATE SKIP LOCKED;
      CONTINUE WHEN NOT FOUND;
      -- The membership rows go with the group, and they hold each member that stays until the
      -- group finished. The delete saves that finish on those members first (ADR 0122). The write
      -- never waits. If another transaction holds the outcome of a member, the group stays for a
      -- later pass, and health counts the member from the finish of the group.
      v_members := ARRAY(
        SELECT member.task_id FROM workhorse.task_group_member member
         WHERE member.group_id = v_group_id
      );
      CONTINUE WHEN cardinality(workhorse.save_terminal_hold_ends_internal_v1(
        v_members, array_fill(v_finished_at, ARRAY[cardinality(v_members)])
      )) > 0;
      DELETE FROM workhorse.task_group task_group WHERE task_group.id = v_group_id;
      v_deleted := v_deleted + 1;
    END LOOP;
  END IF;
  RETURN v_repaired + v_deleted;
END;
$$;

CREATE OR REPLACE FUNCTION workhorse.dashboard_retention_preview_v1(p_input jsonb)
RETURNS jsonb
LANGUAGE sql
SET jit = off
AS $$
  WITH candidate AS (
    SELECT
      CASE WHEN definition ? 'taskIdentityRetentionDays'
        THEN (definition->>'taskIdentityRetentionDays')::integer
        ELSE policy.task_identity_retention_days END AS task_identity_days,
      CASE WHEN definition ? 'terminalOutcomeRetentionDays'
        THEN (definition->>'terminalOutcomeRetentionDays')::integer
        ELSE policy.terminal_outcome_retention_days END AS terminal_outcome_days,
      CASE WHEN definition ? 'taskEventRetentionDays'
        THEN (definition->>'taskEventRetentionDays')::integer
        ELSE policy.task_event_retention_days END AS task_event_days,
      CASE WHEN definition ? 'attemptHistoryRetentionDays'
        THEN (definition->>'attemptHistoryRetentionDays')::integer
        ELSE policy.attempt_history_retention_days END AS attempt_history_days,
      CASE WHEN definition ? 'scheduleOccurrenceRetentionDays'
        THEN (definition->>'scheduleOccurrenceRetentionDays')::integer
        ELSE policy.schedule_occurrence_retention_days END AS schedule_occurrence_days,
      CASE WHEN definition ? 'statisticsRetentionDays'
        THEN (definition->>'statisticsRetentionDays')::integer
        ELSE policy.statistics_retention_days END AS statistics_days
    FROM workhorse.get_retention_policy_v1() policy
    CROSS JOIN LATERAL (
      SELECT COALESCE(p_input->'definition', '{}'::jsonb) AS definition
    ) input
  ), counts AS (
    SELECT
      (SELECT count(*)::integer FROM (
        SELECT 1 FROM workhorse.task task
        JOIN (
          SELECT task_id, finished_at FROM workhorse.task_outcome
          UNION ALL
          SELECT task_id, finished_at FROM workhorse.fast_task_outcome
        ) outcome ON outcome.task_id = task.id
        WHERE candidate.task_identity_days IS NOT NULL
          AND candidate.terminal_outcome_days IS NOT NULL
          AND task.created_at
            < clock_timestamp() - make_interval(hours => 24 * candidate.task_identity_days)
          AND outcome.finished_at
            < clock_timestamp() - make_interval(hours => 24 * candidate.terminal_outcome_days)
        LIMIT 10001
      ) rows) AS terminal_tasks,
      (SELECT count(*)::integer FROM (
        SELECT 1 FROM workhorse.task_event
        WHERE candidate.task_event_days IS NOT NULL
          AND occurred_at < clock_timestamp() - make_interval(hours => 24 * candidate.task_event_days)
        LIMIT 10001
      ) rows) AS task_events,
      (SELECT count(*)::integer FROM (
        SELECT 1 FROM workhorse.attempt_history
        WHERE candidate.attempt_history_days IS NOT NULL
          AND occurred_at
            < clock_timestamp() - make_interval(hours => 24 * candidate.attempt_history_days)
        LIMIT 10001
      ) rows) AS attempt_history,
      (SELECT count(*)::integer FROM (
        SELECT 1 FROM workhorse.schedule_occurrence
        WHERE candidate.schedule_occurrence_days IS NOT NULL
          AND occurrence_at
            < clock_timestamp() - make_interval(hours => 24 * candidate.schedule_occurrence_days)
        LIMIT 10001
      ) rows) AS schedule_occurrences,
      (SELECT count(*)::integer FROM (
        SELECT 1 FROM workhorse.task_stat_bucket
        WHERE candidate.statistics_days IS NOT NULL
          AND bucket_start < clock_timestamp() - make_interval(hours => 24 * candidate.statistics_days)
        UNION ALL
        SELECT 1 FROM workhorse.task_stat_bucket_hour
        WHERE candidate.statistics_days IS NOT NULL
          AND bucket_start < clock_timestamp() - make_interval(hours => 24 * candidate.statistics_days)
        UNION ALL
        SELECT 1 FROM workhorse.task_stat_bucket_day
        WHERE candidate.statistics_days IS NOT NULL
          AND bucket_start < clock_timestamp() - make_interval(hours => 24 * candidate.statistics_days)
        LIMIT 10001
      ) rows) AS statistics
    FROM candidate
  )
  SELECT jsonb_build_object(
    'eligible', jsonb_build_object(
      'terminalTasks', LEAST(terminal_tasks, 10000),
      'taskEvents', LEAST(task_events, 10000),
      'attemptHistory', LEAST(attempt_history, 10000),
      'scheduleOccurrences', LEAST(schedule_occurrences, 10000),
      'statistics', LEAST(statistics, 10000)),
    'capped', jsonb_build_object(
      'terminalTasks', terminal_tasks > 10000,
      'taskEvents', task_events > 10000,
      'attemptHistory', attempt_history > 10000,
      'scheduleOccurrences', schedule_occurrences > 10000,
      'statistics', statistics > 10000))
  FROM counts;
$$;
