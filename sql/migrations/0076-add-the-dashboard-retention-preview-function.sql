-- workhorse-migration: {"kind":"additive"}

-- Add dashboard_retention_preview_v1 (SM-1478, ADR 0040).

-- The dashboard procedure previewRetentionPolicy was the one database-backed dashboard procedure
-- with no dashboard function. Each of the six hosts read get_retention_policy_v1(), merged the
-- candidate definition into the current policy, sent the shared retention_policy_preview statement,
-- and capped the counts in host code. ADR 0040 asks for one SQL implementation for each dashboard
-- procedure, and ADRs 0027 and 0029 send every dashboard read through the versioned read surface.
--
-- dashboard_retention_preview_v1 takes the previewRetentionPolicy input and returns the complete
-- RetentionPolicyImpact document. A setting that the definition does not name keeps its current
-- value. A setting that the definition sets to null disables its category, so the function counts
-- no rows for it. Each count stops at 10,001 rows. The document reports each count capped at 10,000
-- and a capped flag that is true when more rows are eligible.
--
-- The function adds no table and no index. No change touches stored data.

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
            < clock_timestamp() - make_interval(days => candidate.task_identity_days)
          AND outcome.finished_at
            < clock_timestamp() - make_interval(days => candidate.terminal_outcome_days)
        LIMIT 10001
      ) rows) AS terminal_tasks,
      (SELECT count(*)::integer FROM (
        SELECT 1 FROM workhorse.task_event
        WHERE candidate.task_event_days IS NOT NULL
          AND occurred_at < clock_timestamp() - make_interval(days => candidate.task_event_days)
        LIMIT 10001
      ) rows) AS task_events,
      (SELECT count(*)::integer FROM (
        SELECT 1 FROM workhorse.attempt_history
        WHERE candidate.attempt_history_days IS NOT NULL
          AND occurred_at
            < clock_timestamp() - make_interval(days => candidate.attempt_history_days)
        LIMIT 10001
      ) rows) AS attempt_history,
      (SELECT count(*)::integer FROM (
        SELECT 1 FROM workhorse.schedule_occurrence
        WHERE candidate.schedule_occurrence_days IS NOT NULL
          AND occurrence_at
            < clock_timestamp() - make_interval(days => candidate.schedule_occurrence_days)
        LIMIT 10001
      ) rows) AS schedule_occurrences,
      (SELECT count(*)::integer FROM (
        SELECT 1 FROM workhorse.task_stat_bucket
        WHERE candidate.statistics_days IS NOT NULL
          AND bucket_start < clock_timestamp() - make_interval(days => candidate.statistics_days)
        UNION ALL
        SELECT 1 FROM workhorse.task_stat_bucket_hour
        WHERE candidate.statistics_days IS NOT NULL
          AND bucket_start < clock_timestamp() - make_interval(days => candidate.statistics_days)
        UNION ALL
        SELECT 1 FROM workhorse.task_stat_bucket_day
        WHERE candidate.statistics_days IS NOT NULL
          AND bucket_start < clock_timestamp() - make_interval(days => candidate.statistics_days)
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
