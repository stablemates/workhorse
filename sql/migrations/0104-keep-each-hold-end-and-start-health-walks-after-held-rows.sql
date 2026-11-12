-- workhorse-migration: {"kind":"additive"}

-- Keep each hold end, count fast-tier tasks from it, bound the hold code, start the health walks
-- after held rows, and report a terminal cleanup that does not complete.
--
-- An enqueue that reused an expired key and a queue purge saved the end of the hold that they
-- removed only when they could lock the outcome of the held task (SM-2022). A fast-tier outcome had
-- no place for that end (SM-2024). Both ends now go to the new table terminal_hold_end, whose
-- insert takes no row lock. Queue health reads the latest end of a task there too. A row stays
-- until the cleanup batch that deletes its task deletes it too.
--
-- The hold code tested an array once for each row with NOT x = ANY(array), and under a generic
-- plan PostgreSQL searches that array for each row (SM-2023). Each such test now uses one sort or
-- one hash over the batch: a grouping, a window, or EXCEPT.
--
-- Each retention walk of queue_health_v1 read up to 1,000 held rows again on each poll (SM-2021).
-- The new table terminal_retention_walk_start stores where a run of held rows ends, and the walk
-- starts there while no row of the run can become eligible. A poll writes it only in a writable
-- transaction and only when it gets an advisory lock at once.
--
-- The new degraded reason terminal-cleanup-stalled reports a terminal cleanup that has rows to
-- examine and did not complete a pass for longer than row_retention_lag_ms plus its interval
-- (SM-2019).
--
-- Each changed function keeps its name, its arguments, and its result type. queue_health_v1
-- returns the same keys. The reason is a new row in the reason list, and ADR 0109 counts a new row
-- in a result as compatible. A dashboard package that does not know the code skips it (ADR 0122).
-- The step adds two tables and six internal functions, rewrites no row,
-- and does not raise the SDK floor. terminal_retention_boundaries_internal_v1 stays and is no longer
-- called.

-- The end of a hold that a removed reference ended, when task_outcome.held_until cannot keep it
-- (ADR 0122). record_terminal_hold_ends_internal_v1 writes a row for a fast-tier task, whose outcome
-- has no held_until, and for a full-tier task whose outcome another transaction locks while an
-- enqueue or a purge removes the reference. The table has no unique key on the task and no foreign
-- key, so an insert never waits for a row lock. A row stays until the cleanup batch that deletes its
-- task deletes it too. Queue health reads the latest end of a task here and in held_until.
CREATE TABLE IF NOT EXISTS workhorse.terminal_hold_end (
  entry_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  task_id uuid NOT NULL,
  tier text NOT NULL CHECK (tier IN ('full', 'fast')),
  held_until timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS terminal_hold_end_task_idx
  ON workhorse.terminal_hold_end (task_id, held_until);

-- Where each retention walk of queue_health_v1 starts (ADR 0122). anchor_at and task_id mark the
-- last row of a run of rows at the start of the walk, and no row of that run can become eligible
-- before valid_until. The two row windows, occurrence_window, and history_before are the settings of
-- the poll that found the run. A walk starts after the run only while the clock is before valid_until
-- and each setting is the same. A missing row means the oldest row. A poll writes this table only at
-- read committed, in a transaction that can write, and only when it gets an advisory lock at once,
-- so a poll never waits for it and never fails on a write conflict.
CREATE TABLE IF NOT EXISTS workhorse.terminal_retention_walk_start (
  walk text PRIMARY KEY CHECK (walk IN ('identity', 'outcome')),
  anchor_at timestamptz,
  task_id uuid,
  valid_until timestamptz,
  identity_window interval,
  outcome_window interval,
  occurrence_window interval,
  history_before timestamptz,
  CHECK ((anchor_at IS NULL) = (task_id IS NULL)),
  CHECK (anchor_at IS NULL OR valid_until IS NOT NULL)
);

-- Inserts a row of terminal_hold_end for each pair of p_task_ids and p_ends, unless a row of the
-- same task already keeps that end or a later one (ADR 0122). The insert takes no row lock, so it
-- never waits. Each test of a stored row is one index lookup.
CREATE OR REPLACE FUNCTION workhorse.keep_terminal_hold_ends_internal_v1(
  p_task_ids uuid[], p_ends timestamptz[], p_tier text
) RETURNS void
LANGUAGE sql
AS $$
  INSERT INTO workhorse.terminal_hold_end(task_id, tier, held_until)
  SELECT ended.task_id, p_tier, ended.at
    FROM unnest(p_task_ids, p_ends) AS ended(task_id, at)
    -- A lateral lookup with LIMIT 1 stays one index probe for each end. A NOT EXISTS test let the
    -- planner choose a join that read the whole table.
    LEFT JOIN LATERAL (
      SELECT 1 AS kept FROM workhorse.terminal_hold_end saved
       WHERE saved.task_id = ended.task_id AND saved.held_until >= ended.at
       LIMIT 1
    ) stored ON true
   WHERE ended.task_id IS NOT NULL AND ended.at IS NOT NULL AND stored.kept IS NULL;
$$;

-- Saves the end of each hold that a removed reference ends, for the task that the reference held
-- (ADR 0122). Each statement that removes a reference that a health gate skips calls it before the
-- removal. p_task_ids and p_hold_ends are pairs, and a task can repeat. The function saves the latest
-- end of a task only when terminal_hold_end_internal_v1 gives it for one lag and the stored value is
-- earlier. A task with no outcome row needs no write.
--
-- A full-tier end goes to task_outcome.held_until. The function takes each outcome with FOR NO KEY
-- UPDATE SKIP LOCKED, so it never waits. A fast-tier outcome has no held_until, so its end goes to a
-- row of terminal_hold_end. That insert locks no row.
--
-- The function returns the full-tier tasks whose outcome another transaction locks. A maintenance
-- caller passes p_keep_locked false: it keeps the references of those tasks for a later pass, so the
-- reference still holds the task, and the function saves nothing for it. An application caller, an
-- enqueue or a purge, passes true: it removes the references, so the function saves each such end
-- in a row of terminal_hold_end, and health counts the task from it. Each task and outcome is one
-- primary-key lookup, and one grouping finds the outcomes that it could not lock, so no row searches
-- an array.
CREATE OR REPLACE FUNCTION workhorse.record_terminal_hold_ends_internal_v1(
  p_task_ids uuid[], p_hold_ends timestamptz[], p_keep_locked boolean
) RETURNS uuid[]
LANGUAGE plpgsql
AS $$
DECLARE v_identity_window interval;
DECLARE v_outcome_window interval;
DECLARE v_full uuid[];
DECLARE v_full_ends timestamptz[];
DECLARE v_fast uuid[];
DECLARE v_fast_ends timestamptz[];
DECLARE v_locked uuid[];
DECLARE v_locked_ends jsonb;
DECLARE v_skipped uuid[];
DECLARE v_skipped_ends timestamptz[];
BEGIN
  IF p_task_ids IS NULL OR cardinality(p_task_ids) = 0 THEN
    RETURN '{}'::uuid[];
  END IF;
  SELECT make_interval(hours => 24 * policy.task_identity_retention_days),
         make_interval(hours => 24 * policy.terminal_outcome_retention_days)
    INTO v_identity_window, v_outcome_window
    FROM workhorse.retention_policy policy WHERE policy.singleton;
  SELECT COALESCE(array_agg(needed.task_id ORDER BY needed.task_id) FILTER (WHERE NOT needed.fast),
                  '{}'::uuid[]),
         COALESCE(array_agg(needed.at ORDER BY needed.task_id) FILTER (WHERE NOT needed.fast),
                  '{}'::timestamptz[]),
         COALESCE(array_agg(needed.task_id ORDER BY needed.task_id) FILTER (WHERE needed.fast),
                  '{}'::uuid[]),
         COALESCE(array_agg(needed.at ORDER BY needed.task_id) FILTER (WHERE needed.fast),
                  '{}'::timestamptz[])
    INTO v_full, v_full_ends, v_fast, v_fast_ends
    FROM (
      SELECT ended.task_id, ended.at, terminal.fast
        FROM (
          SELECT hold.task_id, max(hold.at) AS at
            FROM unnest(p_task_ids, p_hold_ends) AS hold(task_id, at)
           WHERE hold.task_id IS NOT NULL AND hold.at IS NOT NULL
           GROUP BY hold.task_id
        ) ended
        CROSS JOIN LATERAL (
          SELECT outcome.finished_at, outcome.held_until, false AS fast
            FROM workhorse.task_outcome outcome WHERE outcome.task_id = ended.task_id
          UNION ALL
          SELECT fast.finished_at, NULL::timestamptz, true
            FROM workhorse.fast_task_outcome fast WHERE fast.task_id = ended.task_id
          LIMIT 1
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
             ) IS NOT NULL
    ) needed;
  IF cardinality(v_fast) > 0 THEN
    PERFORM workhorse.keep_terminal_hold_ends_internal_v1(v_fast, v_fast_ends, 'fast');
  END IF;
  IF cardinality(v_full) = 0 THEN
    RETURN '{}'::uuid[];
  END IF;
  -- One lookup and one lock attempt for each task, in task order. The ends of the locked tasks go
  -- into one JSON object, so the update reads the end of each row by its key and needs no join.
  SELECT COALESCE(array_agg(ended.task_id ORDER BY ended.task_id), '{}'::uuid[]),
         COALESCE(jsonb_object_agg(ended.task_id::text, ended.at), '{}'::jsonb)
    INTO v_locked, v_locked_ends
    FROM unnest(v_full, v_full_ends) AS ended(task_id, at)
    CROSS JOIN LATERAL (
      SELECT outcome.task_id
        FROM workhorse.task_outcome outcome
       WHERE outcome.task_id = ended.task_id
         FOR NO KEY UPDATE OF outcome SKIP LOCKED
    ) locked;
  IF cardinality(v_locked) > 0 THEN
    UPDATE workhorse.task_outcome outcome
       SET held_until = GREATEST(
             outcome.held_until, (v_locked_ends->>outcome.task_id::text)::timestamptz
           )
     WHERE outcome.task_id = ANY(v_locked);
  END IF;
  IF cardinality(v_locked) = cardinality(v_full) THEN
    RETURN '{}'::uuid[];
  END IF;
  -- The tasks that it could not lock: one grouping over both lists.
  SELECT COALESCE(array_agg(marked.task_id ORDER BY marked.task_id), '{}'::uuid[]),
         COALESCE(array_agg(marked.at ORDER BY marked.task_id), '{}'::timestamptz[])
    INTO v_skipped, v_skipped_ends
    FROM (
      SELECT side.task_id, max(side.at) AS at
        FROM (
          SELECT needed.task_id, needed.at, false AS locked
            FROM unnest(v_full, v_full_ends) AS needed(task_id, at)
          UNION ALL
          SELECT locked.task_id, NULL::timestamptz, true
            FROM unnest(v_locked) AS locked(task_id)
        ) side
       GROUP BY side.task_id
      HAVING NOT bool_or(side.locked)
    ) marked;
  IF p_keep_locked THEN
    PERFORM workhorse.keep_terminal_hold_ends_internal_v1(v_skipped, v_skipped_ends, 'full');
  END IF;
  RETURN v_skipped;
END;
$$;

-- The save of an application statement: record_terminal_hold_ends_internal_v1 with p_keep_locked
-- true (ADR 0122). An enqueue that reuses an expired key and a queue purge call it, because they
-- remove the reference also when another transaction locks the outcome.
CREATE OR REPLACE FUNCTION workhorse.save_terminal_hold_ends_internal_v1(
  p_task_ids uuid[], p_hold_ends timestamptz[]
) RETURNS uuid[]
LANGUAGE sql
AS $$
  SELECT workhorse.record_terminal_hold_ends_internal_v1(p_task_ids, p_hold_ends, true);
$$;

-- When the holds of terminal_row_held_internal_v1 on the terminal row p_task_id end (ADR 0122). The
-- value is not null exactly when that function is true. It is 'infinity' when a hold ends only at
-- an event: a redrive source with a target, a member of a task group that has not finished, a
-- prerequisite of a dependent that is not terminal, a parent of a child that is not eligible, or a
-- schedule occurrence with no retention window. Otherwise it is the latest end of the enqueue keys
-- that have not expired and of the schedule occurrences inside their window. No statement removes
-- such a key or occurrence of a terminal task before that end, so the row stays held until then.
CREATE OR REPLACE FUNCTION workhorse.terminal_row_hold_until_internal_v1(
  p_task_id uuid, p_now timestamptz, p_identity_before timestamptz,
  p_outcome_before timestamptz, p_history_before timestamptz, p_occurrence_window interval
) RETURNS timestamptz
LANGUAGE sql
STABLE
AS $$
  SELECT CASE
           WHEN EXISTS (
                  SELECT 1 FROM workhorse.task_redrive redrive
                   WHERE redrive.source_task_id = p_task_id
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
             OR (p_occurrence_window IS NULL AND EXISTS (
                  SELECT 1 FROM workhorse.schedule_occurrence occurrence
                   WHERE occurrence.task_id = p_task_id
                ))
             THEN 'infinity'::timestamptz
           ELSE GREATEST(
                  (SELECT max(idempotency.expires_at) FROM workhorse.enqueue_idempotency idempotency
                    WHERE idempotency.task_id = p_task_id AND idempotency.expires_at > p_now),
                  (SELECT max(occurrence.occurrence_at + p_occurrence_window)
                     FROM workhorse.schedule_occurrence occurrence
                    WHERE occurrence.task_id = p_task_id
                      AND occurrence.occurrence_at >= p_now - p_occurrence_window)
                )
         END;
$$;

-- The due instant of an eligible terminal row (ADR 0122): the latest of the end of its row window,
-- the scheduled history pass that releases its history, and the end of each hold that ended. Those
-- ends are the finish of its task group, the expiry of its enqueue keys, the scheduled pass after
-- its schedule occurrences expire, the finish of its dependents, and the instant when its last
-- child became eligible. task_outcome.held_until and terminal_hold_end keep the end of a hold after a
-- statement removed its reference.
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
    (SELECT workhorse.terminal_hold_end_internal_v1(max(saved.held_until), p_window_end)
       FROM workhorse.terminal_hold_end saved
      WHERE saved.task_id = p_task_id),
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

-- The retention boundaries of terminal rows that queue_health_v1 reports, with where each walk can
-- start on the next poll (ADR 0122). The walks, holds, and due instants are those of
-- terminal_retention_boundaries_internal_v1.
--
-- Each walk can start after a run of rows that a poll stored in terminal_retention_walk_start. A row
-- of the run is not eligible, and it cannot become eligible before valid_until: it waits for a row
-- window, or for an enqueue key or a schedule occurrence that ends at a known instant. A row that a
-- hold keeps until an event, a row that waits for history retention, or a task with no outcome ends
-- the run. The
-- walk uses the stored run only while the clock is before valid_until and the two row windows, the
-- occurrence window, and the history watermark are the same as when the poll stored it. A pass of history retention moves
-- the watermark, so each walk starts from the oldest row again at least once a day. No statement
-- writes a terminal row before the run, because the anchors are creation and finish instants.
--
-- Each walk returns the run that it passed: the stored run plus the rows at its start that it
-- examined and that keep the run. The cap of terminal_retention_walk_rows_internal_v1() counts only
-- the rows that the walk examines after its start, so a later poll reads the rows after the run.
CREATE OR REPLACE FUNCTION workhorse.terminal_retention_boundaries_internal_v2(
  p_now timestamptz
) RETURNS TABLE (
  eligible_task_identity_at timestamptz,
  task_identity_due_at timestamptz,
  eligible_terminal_outcome_at timestamptz,
  terminal_outcome_due_at timestamptz,
  identity_start_at timestamptz,
  identity_start_id uuid,
  identity_start_until timestamptz,
  outcome_start_at timestamptz,
  outcome_start_id uuid,
  outcome_start_until timestamptz,
  identity_window interval,
  outcome_window interval,
  occurrence_window interval,
  history_before timestamptz
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
  ), starts AS (
    SELECT stored.walk, stored.anchor_at, stored.task_id, stored.valid_until
      FROM workhorse.terminal_retention_walk_start stored
      CROSS JOIN settings
     WHERE stored.anchor_at IS NOT NULL
       AND stored.valid_until > p_now
       AND stored.identity_window = settings.identity_window
       AND stored.outcome_window = settings.outcome_window
       AND stored.occurrence_window IS NOT DISTINCT FROM settings.occurrence_window
       AND stored.history_before = settings.history_before
  ), identity_walk(
    created_at, task_id, due_at, eligible_at, examined, run_at, run_id, run_until, run_open
  ) AS (
    SELECT COALESCE(start.anchor_at, '-infinity'::timestamptz),
           COALESCE(start.task_id, '00000000-0000-0000-0000-000000000000'::uuid),
           'infinity'::timestamptz, NULL::timestamptz, 0,
           start.anchor_at, start.task_id, COALESCE(start.valid_until, 'infinity'::timestamptz),
           true
      FROM (SELECT 1) present
      LEFT JOIN starts start ON start.walk = 'identity'
    UNION ALL
    SELECT step.created_at, step.task_id,
           CASE WHEN due.at IS NULL THEN walk.due_at ELSE LEAST(walk.due_at, due.at) END,
           COALESCE(walk.eligible_at, CASE WHEN due.at IS NOT NULL THEN step.created_at END),
           walk.examined + 1,
           CASE WHEN walk.run_open AND due.passable_until IS NOT NULL
                THEN step.created_at ELSE walk.run_at END,
           CASE WHEN walk.run_open AND due.passable_until IS NOT NULL
                THEN step.task_id ELSE walk.run_id END,
           CASE WHEN walk.run_open AND due.passable_until IS NOT NULL
                THEN LEAST(walk.run_until, due.passable_until) ELSE walk.run_until END,
           walk.run_open AND due.passable_until IS NOT NULL
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
        SELECT CASE WHEN outcome.finished_at IS NOT NULL
                    THEN workhorse.terminal_row_hold_until_internal_v1(
                           step.task_id, p_now, settings.identity_before,
                           settings.outcome_before, settings.history_before,
                           settings.occurrence_window
                         ) END AS until
      ) hold
      CROSS JOIN LATERAL (
        SELECT CASE WHEN outcome.finished_at < settings.outcome_before
                     AND outcome.history_through_at < settings.history_before
                     AND hold.until IS NULL
                  THEN workhorse.terminal_row_due_at_internal_v1(
                         step.task_id, step.created_at + settings.identity_window,
                         outcome.history_through_at, settings.identity_window,
                         settings.outcome_window, settings.history_window,
                         settings.occurrence_window, settings.timezone, settings.pass_time
                       ) END AS at,
               -- The earliest instant when the row can become eligible, or null when it is
               -- eligible now, when an event decides it, or when it waits for history retention.
               CASE WHEN outcome.finished_at IS NULL OR hold.until = 'infinity'
                      OR outcome.history_through_at >= settings.history_before THEN NULL
                    WHEN outcome.finished_at < settings.outcome_before
                     AND hold.until IS NULL THEN NULL
                    ELSE COALESCE(GREATEST(
                           CASE WHEN outcome.finished_at >= settings.outcome_before
                                THEN outcome.finished_at + settings.outcome_window END,
                           hold.until
                         ), 'infinity'::timestamptz) END AS passable_until
      ) due
     -- The history of a row is at or after its anchor, so the pass that releases the anchor is a
     -- lower bound of its due instant. That bound grows with the anchor. If it is not earlier than
     -- the earliest due instant, no later row can be earlier, and the walk stops.
     WHERE walk.examined < workhorse.terminal_retention_walk_rows_internal_v1()
       AND workhorse.history_release_due_at_internal_v1(
             step.created_at, settings.history_window, settings.timezone, settings.pass_time
           ) < walk.due_at
  ), outcome_walk(
    finished_at, task_id, due_at, eligible_at, examined, run_at, run_id, run_until, run_open
  ) AS (
    SELECT COALESCE(start.anchor_at, '-infinity'::timestamptz),
           COALESCE(start.task_id, '00000000-0000-0000-0000-000000000000'::uuid),
           'infinity'::timestamptz, NULL::timestamptz, 0,
           start.anchor_at, start.task_id, COALESCE(start.valid_until, 'infinity'::timestamptz),
           true
      FROM (SELECT 1) present
      LEFT JOIN starts start ON start.walk = 'outcome'
    UNION ALL
    SELECT step.finished_at, step.task_id,
           CASE WHEN due.at IS NULL THEN walk.due_at ELSE LEAST(walk.due_at, due.at) END,
           COALESCE(walk.eligible_at, CASE WHEN due.at IS NOT NULL THEN step.finished_at END),
           walk.examined + 1,
           CASE WHEN walk.run_open AND due.passable_until IS NOT NULL
                THEN step.finished_at ELSE walk.run_at END,
           CASE WHEN walk.run_open AND due.passable_until IS NOT NULL
                THEN step.task_id ELSE walk.run_id END,
           CASE WHEN walk.run_open AND due.passable_until IS NOT NULL
                THEN LEAST(walk.run_until, due.passable_until) ELSE walk.run_until END,
           walk.run_open AND due.passable_until IS NOT NULL
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
        SELECT workhorse.terminal_row_hold_until_internal_v1(
                 step.task_id, p_now, settings.identity_before,
                 settings.outcome_before, settings.history_before,
                 settings.occurrence_window
               ) AS until
      ) hold
      CROSS JOIN LATERAL (
        SELECT CASE WHEN identity.created_at < settings.identity_before
                     AND step.history_through_at < settings.history_before
                     AND hold.until IS NULL
                  THEN workhorse.terminal_row_due_at_internal_v1(
                         step.task_id, step.finished_at + settings.outcome_window,
                         step.history_through_at, settings.identity_window,
                         settings.outcome_window, settings.history_window,
                         settings.occurrence_window, settings.timezone, settings.pass_time
                       ) END AS at,
               CASE WHEN hold.until = 'infinity'
                      OR step.history_through_at >= settings.history_before THEN NULL
                    WHEN identity.created_at < settings.identity_before
                     AND hold.until IS NULL THEN NULL
                    ELSE COALESCE(GREATEST(
                           CASE WHEN identity.created_at >= settings.identity_before
                                THEN identity.created_at + settings.identity_window END,
                           hold.until
                         ), 'infinity'::timestamptz) END AS passable_until
      ) due
     WHERE walk.examined < workhorse.terminal_retention_walk_rows_internal_v1()
       AND workhorse.history_release_due_at_internal_v1(
             step.finished_at, settings.history_window, settings.timezone, settings.pass_time
           ) < walk.due_at
  )
  SELECT (SELECT min(walk.eligible_at) FROM identity_walk walk),
         (SELECT min(walk.due_at) FROM identity_walk walk WHERE walk.eligible_at IS NOT NULL),
         (SELECT min(walk.eligible_at) FROM outcome_walk walk),
         (SELECT min(walk.due_at) FROM outcome_walk walk WHERE walk.eligible_at IS NOT NULL),
         identity_run.run_at, identity_run.run_id,
         CASE WHEN identity_run.run_at IS NOT NULL THEN identity_run.run_until END,
         outcome_run.run_at, outcome_run.run_id,
         CASE WHEN outcome_run.run_at IS NOT NULL THEN outcome_run.run_until END,
         (SELECT settings.identity_window FROM settings),
         (SELECT settings.outcome_window FROM settings),
         (SELECT settings.occurrence_window FROM settings),
         (SELECT settings.history_before FROM settings)
    FROM (
      SELECT walk.run_at, walk.run_id, walk.run_until
        FROM identity_walk walk ORDER BY walk.examined DESC LIMIT 1
    ) identity_run
    CROSS JOIN (
      SELECT walk.run_at, walk.run_id, walk.run_until
        FROM outcome_walk walk ORDER BY walk.examined DESC LIMIT 1
    ) outcome_run;
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
    -- Terminal cleanup has rows to examine and has not completed a pass for longer than the row
    -- retention budget plus its own interval. It does not depend on the capped walks, so it also
    -- reports a cleanup that does not run behind many held rows (SM-2019). A snapshot of an older
    -- schema has no stalled instant, so the reason does not fire.
    SELECT 125, jsonb_build_object(
      'code', 'terminal-cleanup-stalled', 'severity', 'degraded',
      'observed', stalled.age_ms, 'budget', stalled.budget_ms
    ) FROM (
      SELECT floor(extract(epoch FROM (p_snapshot->>'captured_at')::timestamptz
               - (p_snapshot->>'terminal_cleanup_stalled_since')::timestamptz) * 1000) AS age_ms,
             (p_policy->>'row_retention_lag_ms')::numeric
               + COALESCE((p_snapshot->>'terminal_cleanup_interval_ms')::numeric, 0) AS budget_ms
    ) stalled
    WHERE stalled.age_ms > stalled.budget_ms
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
  v_bounds record;
BEGIN
  -- terminal_retention_boundaries_internal_v2 applies the holds that terminal cleanup keeps on
  -- purpose, and it finds the earliest due instant of the rows it can delete. Each walk starts after
  -- the run of rows that an earlier poll stored, and it returns the run that it passed (SM-2021).
  SELECT * INTO v_bounds FROM workhorse.terminal_retention_boundaries_internal_v2(v_now);
  SELECT (to_jsonb(snapshot) - 'schedule_occurrence_pass_lag_ms'
           - 'schedule_occurrence_due_lag_ms' - 'task_identity_due_at'
           - 'terminal_outcome_due_at' - 'terminal_cleanup_owed_since'
           - 'terminal_cleanup_stalled_since' - 'terminal_cleanup_interval_ms') || jsonb_build_object(
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
              v_bounds.eligible_task_identity_at AS eligible_task_identity_at,
              v_bounds.task_identity_due_at AS task_identity_due_at,
              v_bounds.eligible_terminal_outcome_at AS eligible_terminal_outcome_at,
              v_bounds.terminal_outcome_due_at AS terminal_outcome_due_at,
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
                 -- The earliest instant when one terminal row passed both of its row windows, among
                 -- the first five rows of task_created_retention_idx and of each outcome retention
                 -- index. From then on, terminal cleanup has rows to examine (SM-2019). Each value
                 -- comes from one row, so two rows that each pass one window do not count. When the
                 -- outcome window is not shorter than the identity window, the first outcome row
                 -- gives the exact instant, because a task finishes after it is created.
                 CASE WHEN policy.task_identity_retention_days IS NOT NULL
                       AND policy.terminal_outcome_retention_days IS NOT NULL
                      THEN (
                        SELECT min(GREATEST(
                                 owed.created_at
                                   + make_interval(hours => 24 * policy.task_identity_retention_days),
                                 owed.finished_at
                                   + make_interval(hours => 24 * policy.terminal_outcome_retention_days)
                               ))
                          FROM (
                            -- Each part takes five index rows first and then looks up the other
                            -- side, so a live task without an outcome is one of the five rows and
                            -- does not make the part read further.
                            SELECT first.created_at, terminal.finished_at
                              FROM (
                                SELECT task.id, task.created_at FROM workhorse.task task
                                 ORDER BY task.created_at, task.id LIMIT 5
                              ) first
                              CROSS JOIN LATERAL (
                                SELECT outcome.finished_at FROM workhorse.task_outcome outcome
                                 WHERE outcome.task_id = first.id
                                UNION ALL
                                SELECT fast.finished_at FROM workhorse.fast_task_outcome fast
                                 WHERE fast.task_id = first.id
                                LIMIT 1
                              ) terminal
                            UNION ALL
                            SELECT identity.created_at, first.finished_at
                              FROM (
                                (SELECT outcome.task_id, outcome.finished_at
                                   FROM workhorse.task_outcome outcome
                                  ORDER BY outcome.finished_at, outcome.task_id LIMIT 5)
                                UNION ALL
                                (SELECT outcome.task_id, outcome.finished_at
                                   FROM workhorse.fast_task_outcome outcome
                                  ORDER BY outcome.finished_at, outcome.task_id LIMIT 5)
                              ) first
                              CROSS JOIN LATERAL (
                                SELECT task.created_at FROM workhorse.task task
                                 WHERE task.id = first.task_id LIMIT 1
                              ) identity
                          ) owed
                      ) END AS terminal_cleanup_owed_since,
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
               -- Since when terminal cleanup has not completed a pass while it has rows (SM-2019).
               -- After a first completion, it is the last completion, while a terminal outcome
               -- exists. The snapshot reads oldest_terminal_outcome_at for its public document
               -- anyway, so this test adds no read, and the reason does not depend on the capped
               -- walks or on the sample, so rows that a read skips cannot hide it. Before a first
               -- completion, it starts when the sampled rows show a row past both of its windows,
               -- so a new database does not report it.
               CASE WHEN completed.at IS NOT NULL
                     AND retention.oldest_terminal_outcome_at IS NOT NULL
                      THEN completed.at
                    WHEN completed.at IS NULL AND retention.terminal_cleanup_owed_since <= v_now
                      THEN retention.terminal_cleanup_owed_since
               END AS terminal_cleanup_stalled_since,
               (SELECT maintenance.terminal_cleanup_interval_ms
                  FROM workhorse.maintenance_policy maintenance WHERE maintenance.singleton)
                 AS terminal_cleanup_interval_ms,
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
          LEFT JOIN LATERAL (
            SELECT state.last_completed_at AS at FROM workhorse.maintenance_state state
             WHERE state.routine_name = 'terminal_storage'
          ) completed ON true
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

  -- Store where each walk can start on the next poll. A read-only transaction, a standby, and a
  -- transaction at repeatable read or serializable skip this: at those levels a row that another
  -- poll changed after the snapshot fails the write with SQLSTATE 40001. A role that can only read
  -- the table, such as the read-only dashboard role, skips it too. Every writer takes the advisory
  -- lock first and keeps it until it commits, so a poll that gets the lock waits for no row lock,
  -- and a poll that does not get it skips the write.
  IF current_setting('transaction_read_only') = 'off'
     AND current_setting('transaction_isolation') = 'read committed'
     AND has_table_privilege('workhorse.terminal_retention_walk_start', 'INSERT')
     AND has_table_privilege('workhorse.terminal_retention_walk_start', 'UPDATE')
     AND pg_try_advisory_xact_lock(hashtextextended('workhorse:terminal-retention-walk-start', 0)) THEN
    INSERT INTO workhorse.terminal_retention_walk_start AS stored(
      walk, anchor_at, task_id, valid_until, identity_window, outcome_window, occurrence_window,
      history_before
    ) VALUES
      ('identity', v_bounds.identity_start_at, v_bounds.identity_start_id,
       v_bounds.identity_start_until, v_bounds.identity_window, v_bounds.outcome_window,
       v_bounds.occurrence_window, v_bounds.history_before),
      ('outcome', v_bounds.outcome_start_at, v_bounds.outcome_start_id,
       v_bounds.outcome_start_until, v_bounds.identity_window, v_bounds.outcome_window,
       v_bounds.occurrence_window, v_bounds.history_before)
    ON CONFLICT (walk) DO UPDATE
      SET anchor_at = EXCLUDED.anchor_at, task_id = EXCLUDED.task_id,
          valid_until = EXCLUDED.valid_until, identity_window = EXCLUDED.identity_window,
          outcome_window = EXCLUDED.outcome_window,
          occurrence_window = EXCLUDED.occurrence_window,
          history_before = EXCLUDED.history_before
      WHERE (stored.anchor_at, stored.task_id, stored.valid_until, stored.identity_window,
             stored.outcome_window, stored.occurrence_window, stored.history_before)
            IS DISTINCT FROM (EXCLUDED.anchor_at, EXCLUDED.task_id, EXCLUDED.valid_until,
                              EXCLUDED.identity_window, EXCLUDED.outcome_window,
                              EXCLUDED.occurrence_window, EXCLUDED.history_before);
  END IF;

  RETURN v_document || jsonb_build_object('observations', v_observations);
END;
$$;

-- Delete schedule occurrences older than p_before. An occurrence holds its terminal task until the
-- scheduled history pass after its retention window ends, as queue health counts it. The statement
-- saves that instant on the task through save_terminal_hold_ends_internal_v1 before it deletes the
-- occurrence (ADR 0122). The write never waits. If another transaction holds the outcome of the
-- task, the occurrence stays for a later pass, and health counts the task from it.
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
    SELECT workhorse.record_terminal_hold_ends_internal_v1(
             array_agg(victims.task_id),
             array_agg(workhorse.history_pass_due_at_internal_v1(
               victims.occurrence_at + v_window, v_timezone, v_local_time
             )),
             false
           ) AS task_ids
      FROM victims
  ), removable AS MATERIALIZED (
    -- One window by task marks the occurrences of a blocked task, so no row searches the array.
    SELECT marked.ctid
      FROM (
        SELECT side.ctid, bool_or(side.blocked) OVER (PARTITION BY side.task_id) AS blocked
          FROM (
            SELECT victims.ctid, victims.task_id, false AS blocked FROM victims
            UNION ALL
            SELECT NULL::tid, held.task_id, true
              FROM blocked CROSS JOIN unnest(blocked.task_ids) AS held(task_id)
          ) side
      ) marked
     WHERE marked.ctid IS NOT NULL AND NOT marked.blocked
  )
  DELETE FROM workhorse.schedule_occurrence occurrence
   USING removable
   WHERE occurrence.ctid = removable.ctid;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
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
    -- One window by dependent marks the edges whose dependent the purge locked, so no row searches
    -- the array.
    SELECT marked.prerequisite_task_id, 0
      FROM (
        SELECT side.prerequisite_task_id, side.stays,
               bool_or(side.purged) OVER (PARTITION BY side.dependent_task_id) AS dependent_purged
          FROM (
            SELECT dependency.prerequisite_task_id, dependency.dependent_task_id,
                   (
                     dependency.released_at IS NULL
                     OR EXISTS (
                          SELECT 1 FROM workhorse.task_runtime runtime
                           WHERE runtime.task_id = dependency.dependent_task_id
                        )
                   ) AS stays,
                   false AS purged
              FROM workhorse.task_dependency dependency
             WHERE dependency.prerequisite_task_id = ANY(v_purged_task_ids)
            UNION ALL
            SELECT NULL::uuid, purged.task_id, false, true
              FROM unnest(v_purged_task_ids) AS purged(task_id)
          ) side
      ) marked
     WHERE marked.stays AND NOT marked.dependent_purged
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
    SELECT purged.task_id FROM unnest(v_purged_task_ids) purged(task_id)
    EXCEPT
    SELECT canceled.task_id FROM unnest(v_canceled_task_ids) canceled(task_id)
    ORDER BY 1
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
  -- One grouping by held task drops the tasks that the purge deletes too, so no row searches the
  -- array.
  PERFORM workhorse.save_terminal_hold_ends_internal_v1(held.task_ids, held.ends)
    FROM (
      SELECT array_agg(hold.task_id) AS task_ids, array_agg(hold.at) AS ends
        FROM (
          SELECT side.task_id, max(side.at) AS at
            FROM (
              SELECT dependency.prerequisite_task_id AS task_id,
                     COALESCE(
                       (SELECT outcome.finished_at FROM workhorse.task_outcome outcome
                         WHERE outcome.task_id = dependency.dependent_task_id),
                       clock_timestamp()
                     ) AS at,
                     false AS deleted
                FROM workhorse.task_dependency dependency
               WHERE dependency.dependent_task_id = ANY(v_deleted_task_ids)
              UNION ALL
              SELECT edge.parent_task_id,
                     LEAST(
                       COALESCE(workhorse.terminal_child_hold_end_internal_v1(edge.child_task_id),
                                clock_timestamp()),
                       clock_timestamp()
                     ),
                     false
                FROM workhorse.task_child edge
               WHERE edge.child_task_id = ANY(v_deleted_task_ids)
              UNION ALL
              SELECT redrive.source_task_id, clock_timestamp(), false
                FROM workhorse.task_redrive redrive
               WHERE redrive.target_task_id = ANY(v_deleted_task_ids)
              UNION ALL
              SELECT deleted.task_id, NULL::timestamptz, true
                FROM unnest(v_deleted_task_ids) AS deleted(task_id)
            ) side
           GROUP BY side.task_id
          HAVING NOT bool_or(side.deleted)
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
      SELECT array_agg(source.task_id) AS task_ids, array_agg(clock_timestamp()) AS ends
        FROM (
          SELECT side.task_id
            FROM (
              SELECT redrive.source_task_id AS task_id, false AS deleted
                FROM workhorse.task_redrive redrive
               WHERE redrive.target_task_id = ANY(v_fast_task_ids)
              UNION ALL
              SELECT deleted.task_id, true FROM unnest(v_fast_task_ids) AS deleted(task_id)
            ) side
           GROUP BY side.task_id
          HAVING NOT bool_or(side.deleted)
        ) source
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

-- The holds that a delete of p_task_ids ends on tasks that stay (ADR 0122): a parent of a deleted
-- child, a prerequisite of a deleted dependent, and a redrive source of a deleted target. It gives
-- one row for each task that stays, with the latest end. One index lookup for each deleted task
-- finds its references, and one grouping drops the tasks that the delete removes too, so no row
-- searches an array.
CREATE OR REPLACE FUNCTION workhorse.terminal_deleted_holds_internal_v1(
  p_task_ids uuid[], p_now timestamptz
) RETURNS TABLE (task_id uuid, ends_at timestamptz)
LANGUAGE sql
STABLE
AS $$
  SELECT side.task_id, max(side.ends_at)
    FROM (
      SELECT edge.parent_task_id AS task_id,
             workhorse.terminal_child_hold_end_internal_v1(edge.child_task_id) AS ends_at,
             false AS deleted
        FROM workhorse.task_child edge
       WHERE edge.child_task_id = ANY(p_task_ids)
      UNION ALL
      SELECT dependency.prerequisite_task_id, dependent.finished_at, false
        FROM workhorse.task_dependency dependency
        JOIN workhorse.task_outcome dependent ON dependent.task_id = dependency.dependent_task_id
       WHERE dependency.dependent_task_id = ANY(p_task_ids)
      UNION ALL
      SELECT redrive.source_task_id, p_now, false
        FROM workhorse.task_redrive redrive
       WHERE redrive.target_task_id = ANY(p_task_ids)
      UNION ALL
      SELECT deleted.task_id, NULL::timestamptz, true
        FROM unnest(p_task_ids) AS deleted(task_id)
    ) side
   GROUP BY side.task_id
  HAVING NOT bool_or(side.deleted);
$$;

-- The tasks of p_task_ids, in their order, that hold no task of p_blocked: no child edge, dependency
-- edge, or redrive edge leads from a task of p_blocked to them (ADR 0122). One index lookup for each
-- task finds its references. One window over the references marks those of a blocked task, and one
-- grouping keeps the other tasks, so no row searches an array.
CREATE OR REPLACE FUNCTION workhorse.terminal_tasks_free_of_internal_v1(
  p_task_ids uuid[], p_blocked uuid[]
) RETURNS uuid[]
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE(array_agg(kept.task_id ORDER BY kept.position), '{}'::uuid[])
    FROM (
      SELECT side.task_id, min(side.position) AS position
        FROM (
          SELECT candidate.task_id, candidate.position, false AS holds
            FROM unnest(p_task_ids) WITH ORDINALITY AS candidate(task_id, position)
          UNION ALL
          SELECT reference.task_id, NULL::bigint, true
            FROM (
              SELECT reference.task_id,
                     bool_or(reference.blocked) OVER (PARTITION BY reference.holder) AS blocked
                FROM (
                  SELECT edge.child_task_id AS task_id, edge.parent_task_id AS holder,
                         false AS blocked
                    FROM workhorse.task_child edge
                   WHERE edge.child_task_id = ANY(p_task_ids)
                  UNION ALL
                  SELECT dependency.dependent_task_id, dependency.prerequisite_task_id, false
                    FROM workhorse.task_dependency dependency
                   WHERE dependency.dependent_task_id = ANY(p_task_ids)
                  UNION ALL
                  SELECT redrive.target_task_id, redrive.source_task_id, false
                    FROM workhorse.task_redrive redrive
                   WHERE redrive.target_task_id = ANY(p_task_ids)
                  UNION ALL
                  SELECT NULL::uuid, blocked.task_id, true
                    FROM unnest(p_blocked) AS blocked(task_id)
                ) reference
            ) reference
           WHERE reference.blocked AND reference.task_id IS NOT NULL
        ) side
       GROUP BY side.task_id
      HAVING NOT bool_or(side.holds)
    ) kept;
$$;

-- One full-tier batch of terminal cleanup. It reports whether it deleted nothing while a dependency
-- edge kept a prerequisite of its slice that passes each cutoff.
--
-- The batch examines one slice from read_terminal_prune_slice_internal_v1. It tests each row of the
-- slice with terminal_row_kept_internal_v1, one probe for each row, and then locks at most p_limit
-- rows that no reference keeps. A kept row therefore does not take the place of a row that the
-- batch can delete, and many kept rows do not stop the walk (SM-1935). Queue health tests the holds
-- on purpose through terminal_row_held_internal_v1 (ADR 0122).
--
-- A later statement rechecks every reference of the locked rows and deletes the rest. At read
-- committed, it reads a snapshot taken after the locks. A reference that committed after the first
-- snapshot, such as a dependency edge or a redrive, is visible there, so its row stays, and a later
-- pass checks it again (SM-1665). The batch also keeps the lock of a candidate that holds a task
-- whose outcome another transaction locks, so that the end of the hold is not lost. These are the two
-- cases in which the batch keeps the lock of a row that it does not delete, and each lock ends when
-- the pass commits. An insert of such a reference
-- takes FOR KEY SHARE on the task row through its foreign key. That lock conflicts with FOR UPDATE,
-- so no new reference commits after the lock. In one statement, the check used the snapshot from
-- before the lock, and the ON DELETE RESTRICT check of task_dependency then failed the whole
-- terminal_tasks phase.
--
-- The batch deletes no enqueue key and no dependency edge: a row with either stays, and the key
-- phase and the released-edge phase remove them. A redrive source stays while it has a target. When
-- the batch deletes the last target of a source and has room, it locks and deletes that source too.
-- Before each delete, the batch saves the end of each hold that the delete ends on a task that stays:
-- a parent of a deleted child, a prerequisite of a deleted dependent, and a source whose last target
-- goes (ADR 0122).
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
             COALESCE(array_agg(hold.ends_at), '{}'::timestamptz[])
        INTO v_hold_ids, v_hold_ends
        FROM workhorse.terminal_deleted_holds_internal_v1(v_candidates, v_now) hold;
      EXIT holds WHEN cardinality(v_hold_ids) = 0;
      v_blocked := workhorse.record_terminal_hold_ends_internal_v1(v_hold_ids, v_hold_ends, false);
      EXIT holds WHEN cardinality(v_blocked) = 0;
      v_candidates := workhorse.terminal_tasks_free_of_internal_v1(v_candidates, v_blocked);
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
    ), saved AS (
      -- The saved hold ends of a deleted task go with it.
      DELETE FROM workhorse.terminal_hold_end saved WHERE saved.task_id = ANY(v_candidates)
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

-- One fast-tier batch of terminal cleanup. No fast task is a prerequisite or a child, and its history
-- rows exist only when the queue opted in, so their absence stands in for history_through_at. The
-- batch examines one slice from read_terminal_prune_slice_internal_v1, as the full tier does, and it
-- deletes no enqueue key. When the batch deletes the last target of a redrive source and has room, it
-- deletes that source too.
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
             COALESCE(array_agg(hold.ends_at), '{}'::timestamptz[])
        INTO v_hold_ids, v_hold_ends
        FROM workhorse.terminal_deleted_holds_internal_v1(v_locked, v_now) hold;
      EXIT holds WHEN cardinality(v_hold_ids) = 0;
      v_blocked := workhorse.record_terminal_hold_ends_internal_v1(v_hold_ids, v_hold_ends, false);
      EXIT holds WHEN cardinality(v_blocked) = 0;
      v_locked := workhorse.terminal_tasks_free_of_internal_v1(v_locked, v_blocked);
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
    ), saved AS (
      -- The saved hold ends of a deleted task go with it.
      DELETE FROM workhorse.terminal_hold_end saved WHERE saved.task_id = ANY(v_locked)
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

-- Delete released dependency edges whose dependent is terminal. When the finish of the last
-- dependent moves the due instant of a terminal prerequisite, as terminal_hold_end_internal_v1
-- decides, the statement records that finish in task_outcome.held_until of the prerequisite, through
-- save_terminal_hold_ends_internal_v1. Queue health then counts the prerequisite from the end of
-- that hold after the edge is gone (ADR 0122). The statement takes the edges and those outcomes with
-- SKIP LOCKED, so it never waits. It deletes the edges of such a prerequisite only after the write. If another transaction holds the
-- outcome, the edges stay for a later pass, and health counts the prerequisite from the finish of
-- their dependents. An edge whose prerequisite needs no write goes as before.
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
    SELECT workhorse.record_terminal_hold_ends_internal_v1(
             array_agg(candidates.prerequisite_task_id), array_agg(candidates.dependent_finished_at),
             false
           ) AS task_ids
      FROM candidates
  ), removable AS MATERIALIZED (
    -- One window by prerequisite marks the edges of a blocked task, so no row searches the array.
    SELECT marked.dependent_task_id, marked.prerequisite_task_id
      FROM (
        SELECT side.dependent_task_id, side.prerequisite_task_id, side.edge,
               bool_or(side.blocked) OVER (PARTITION BY side.prerequisite_task_id) AS blocked
          FROM (
            SELECT candidates.dependent_task_id, candidates.prerequisite_task_id, true AS edge,
                   false AS blocked
              FROM candidates
            UNION ALL
            SELECT NULL::uuid, held.task_id, false, true
              FROM blocked CROSS JOIN unnest(blocked.task_ids) AS held(task_id)
          ) side
      ) marked
     WHERE marked.edge AND NOT marked.blocked
  )
  DELETE FROM workhorse.task_dependency dependency USING removable
   WHERE dependency.dependent_task_id = removable.dependent_task_id
     AND dependency.prerequisite_task_id = removable.prerequisite_task_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

-- Delete expired enqueue keys. A debounce key stays while its task is ready or scheduled, so a
-- same-key request after the window still finds the pending task and returns non_replaceable with
-- window_elapsed_pending. A later pass deletes the key when the task is active or terminal. When the
-- expiry moves the due instant of a full-tier terminal task, as terminal_hold_end_internal_v1
-- decides, the statement records it in task_outcome.held_until, through
-- save_terminal_hold_ends_internal_v1. Queue health then counts the task from the end of that hold
-- after the key is gone (ADR 0122). The statement takes the keys and those outcomes with SKIP LOCKED,
-- so it never waits. It deletes the keys of such a task only after the write. If another transaction holds the outcome, the keys stay for a later pass, and
-- health counts the task from their expiry. A key whose task needs no write goes as before.
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
    SELECT workhorse.record_terminal_hold_ends_internal_v1(
             array_agg(candidates.task_id), array_agg(candidates.expires_at), false
           ) AS task_ids
      FROM candidates
  ), removable AS MATERIALIZED (
    -- One window by task marks the keys of a blocked task, so no row searches the array.
    SELECT marked.idempotency_scope, marked.idempotency_key_hash
      FROM (
        SELECT side.idempotency_scope, side.idempotency_key_hash, side.key,
               bool_or(side.blocked) OVER (PARTITION BY side.task_id) AS blocked
          FROM (
            SELECT candidates.idempotency_scope, candidates.idempotency_key_hash,
                   candidates.task_id, true AS key, false AS blocked
              FROM candidates
            UNION ALL
            SELECT NULL::text, NULL::bytea, held.task_id, false, true
              FROM blocked CROSS JOIN unnest(blocked.task_ids) AS held(task_id)
          ) side
      ) marked
     WHERE marked.key AND NOT marked.blocked
  )
  DELETE FROM workhorse.enqueue_idempotency idempotency USING removable
   WHERE idempotency.idempotency_scope = removable.idempotency_scope
     AND idempotency.idempotency_key_hash = removable.idempotency_key_hash;
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

-- The maintenance part of task groups, run by the terminal_storage routine. It finishes a sealed
-- group whose members are all finished but whose callbacks are not enqueued. Then it deletes a
-- finished group, with its shard, membership, callback, and event rows, after its callback tasks
-- are terminal and its finish is older than the outcome cutoff. It never deletes an open or sealed
-- group. A healthy sealed group stops each probe at its first live member.
--
-- The delete locks all shard rows of a group, then the group row, and skips the group when one of
-- them is locked. Without this order, the cascade locks the shard rows after the group row, and an
-- add to that group could deadlock with the delete. The delete never waits for a lock.
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
      CONTINUE WHEN cardinality(workhorse.record_terminal_hold_ends_internal_v1(
        v_members, array_fill(v_finished_at, ARRAY[cardinality(v_members)]), false
      )) > 0;
      DELETE FROM workhorse.task_group task_group WHERE task_group.id = v_group_id;
      v_deleted := v_deleted + 1;
    END LOOP;
  END IF;
  RETURN v_repaired + v_deleted;
END;
$$;
