-- workhorse-migration: {"kind":"additive"}

-- Prune past redrive sources pinned by younger targets (SM-1005).

-- Schema version 47 locked the oldest terminal tasks into a window of four times the pass limit,
-- and only then excluded redrive sources. A source stays while its target exists, and the target
-- finishes later. After a bulk redrive of at least four times the limit, every pass locked the same
-- pinned sources, deleted nothing, and never reached the targets that would release them. Terminal
-- pruning stopped for good, and terminal_prune_dependency_starved stayed false.
--
-- prune_terminal_tasks_v1 now excludes a redrive source inside the window, before its limit. The
-- exclusion reads task_redrive_source_time_idx, so each pass stays bounded. A source still waits
-- for its target, and becomes a candidate once the target is pruned.

CREATE OR REPLACE FUNCTION workhorse.prune_terminal_tasks_v1(
  p_identity_before timestamptz, p_outcome_before timestamptz,
  p_history_before timestamptz, p_limit integer
) RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  v_count integer;
  v_fast_count integer;
  v_fast_before timestamptz := p_history_before;
BEGIN
  IF p_identity_before IS NULL OR p_outcome_before IS NULL OR p_history_before IS NULL
     OR NOT isfinite(p_identity_before) OR NOT isfinite(p_outcome_before)
     OR NOT isfinite(p_history_before) THEN
    RAISE EXCEPTION 'identity, outcome, and history cutoffs are required';
  END IF;
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100000 THEN RAISE EXCEPTION 'terminal task limit must be between 1 and 100000'; END IF;

  WITH candidate_window AS MATERIALIZED (
    SELECT task.id, outcome.finished_at
      FROM workhorse.task task
      JOIN workhorse.task_outcome outcome ON outcome.task_id = task.id
     WHERE task.created_at < p_identity_before
       AND outcome.finished_at < p_outcome_before
       AND outcome.history_through_at < p_history_before
       AND NOT EXISTS (SELECT 1 FROM workhorse.task_runtime runtime WHERE runtime.task_id = task.id)
       AND NOT EXISTS (SELECT 1 FROM workhorse.task_event event WHERE event.task_id = task.id)
       AND NOT EXISTS (
             SELECT 1 FROM workhorse.attempt_history attempt WHERE attempt.task_id = task.id
           )
       -- A redrive source waits for its younger target, so it stays out of the window. Otherwise a
       -- window of sources would hide the targets that release them, and no pass would progress.
       AND NOT EXISTS (
             SELECT 1 FROM workhorse.task_redrive redrive WHERE redrive.source_task_id = task.id
           )
     ORDER BY outcome.finished_at, task.id
     FOR UPDATE OF task SKIP LOCKED
     LIMIT LEAST(p_limit * 4, 100000)
  ), candidates AS (
    SELECT candidate.id
      FROM candidate_window candidate
     WHERE NOT EXISTS (
             SELECT 1 FROM workhorse.schedule_occurrence occurrence
              WHERE occurrence.task_id = candidate.id
           )
       AND NOT EXISTS (
             SELECT 1 FROM workhorse.enqueue_idempotency idempotency
              WHERE idempotency.task_id = candidate.id
           )
       AND NOT EXISTS (
             SELECT 1 FROM workhorse.task_dependency dependency
              WHERE dependency.prerequisite_task_id = candidate.id
           )
       AND NOT EXISTS (
             SELECT 1
               FROM workhorse.task_child edge
               JOIN workhorse.task child ON child.id = edge.child_task_id
               LEFT JOIN workhorse.task_outcome child_outcome
                 ON child_outcome.task_id = edge.child_task_id
              WHERE edge.parent_task_id = candidate.id
                AND (
                  child_outcome.task_id IS NULL
                  OR child.created_at >= p_identity_before
                  OR child_outcome.finished_at >= p_outcome_before
                  OR child_outcome.history_through_at >= p_history_before
                )
           )
     ORDER BY candidate.finished_at, candidate.id
     LIMIT p_limit
  ), deleted AS (
    DELETE FROM workhorse.task task USING candidates WHERE task.id = candidates.id
    RETURNING task.id
  ), result AS (
    SELECT count(*)::integer AS pruned,
           count(*) = 0 AND EXISTS (
             SELECT 1
               FROM candidate_window candidate
               JOIN workhorse.task_dependency dependency
                 ON dependency.prerequisite_task_id = candidate.id
           ) AS dependency_starved
      FROM deleted
  ), recorded AS (
    UPDATE workhorse.maintenance_state state
       SET terminal_prune_dependency_starved = result.dependency_starved,
           updated_at = clock_timestamp()
      FROM result
     WHERE state.routine_name = 'terminal_storage'
    RETURNING result.pruned
  )
  SELECT pruned INTO STRICT v_count FROM recorded;

  -- Fast-tier outcomes share the batch. No fast task is a prerequisite or a child, and its history
  -- rows exist only when the queue opted in, so their absence stands in for history_through_at.
  -- The outcome row is the task's archived history, so while cold export is on it also waits for
  -- the fast_task_outcome export to pass its close time.
  IF EXISTS (SELECT 1 FROM workhorse.cold_export_policy policy WHERE policy.singleton AND policy.enabled) THEN
    SELECT LEAST(v_fast_before, COALESCE(
             (SELECT exported.exported_through FROM workhorse.cold_export_dataset exported
               WHERE exported.dataset = 'fast_task_outcome'),
             timestamp '2000-01-01' AT TIME ZONE 'UTC'))
      INTO v_fast_before;
  END IF;
  IF v_count < p_limit THEN
    WITH candidates AS MATERIALIZED (
      SELECT task.id
        FROM workhorse.fast_task_outcome outcome
        JOIN workhorse.task task ON task.id = outcome.task_id
       WHERE outcome.finished_at < p_outcome_before
         AND outcome.finished_at < v_fast_before
         AND task.created_at < p_identity_before
         AND NOT EXISTS (SELECT 1 FROM workhorse.task_event event WHERE event.task_id = task.id)
         AND NOT EXISTS (
               SELECT 1 FROM workhorse.attempt_history attempt WHERE attempt.task_id = task.id
             )
         AND NOT EXISTS (
               SELECT 1 FROM workhorse.schedule_occurrence occurrence
                WHERE occurrence.task_id = task.id
             )
         AND NOT EXISTS (
               SELECT 1 FROM workhorse.enqueue_idempotency idempotency
                WHERE idempotency.task_id = task.id
             )
         AND NOT EXISTS (
               SELECT 1 FROM workhorse.task_redrive redrive
                WHERE redrive.source_task_id = task.id
             )
       ORDER BY outcome.finished_at, outcome.task_id
       FOR UPDATE OF task SKIP LOCKED
       LIMIT p_limit - v_count
    )
    DELETE FROM workhorse.task task USING candidates WHERE task.id = candidates.id;
    GET DIAGNOSTICS v_fast_count = ROW_COUNT;
    v_count := v_count + v_fast_count;
  END IF;
  RETURN v_count;
END;
$$;
