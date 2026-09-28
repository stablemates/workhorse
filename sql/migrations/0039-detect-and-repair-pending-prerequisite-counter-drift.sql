-- workhorse-migration: {"kind":"additive"}

-- Detect and repair pending-prerequisite counter drift (SM-937).

-- Since schema version 30 a blocked task counts its pending edges in pending_prerequisites, and the
-- resolver releases the task when that counter reaches zero without reading its edges. A counter
-- that disagreed with the edges had no report and no repair. A counter below the edges a resolver
-- resolved violated task_runtime_pending_prerequisites_check, so the prerequisite's own terminal
-- transition failed. Migration 0032 repaired one known cause, a parent blocked on a child that
-- already held an outcome, but nothing found a blocked task whose edges were all resolved.
--
-- dependency_counter_drift_v1 reports blocked tasks whose counter or rejection flag disagrees with
-- their edges, and blocked tasks whose edges are all resolved. repair_dependency_counters_v1
-- recounts those tasks under the resolver's lock and settles the ones with no pending edge.
-- resolve_dependents_many_v1 recounts a dependent whose counter would fall below zero, records a
-- dependency_counter_repaired event, and continues. settle_dependents_v1 holds the settlement both
-- paths share. Every existing signature and result shape is unchanged.
--
-- Replacing resolve_dependents_many_v1 resets the plan_cache_mode that migration 0037 set on it,
-- so its definition restates the setting. settle_dependents_v1 now runs the release and rejection
-- statements the resolver ran, and it keeps its generic plans for the session too.

-- Settle blocked dependents whose pending edges are all resolved. A rejected dependent fails or is
-- canceled; every other dependent moves to ready or scheduled. The resolver and the counter repair
-- both call it while they hold every dependent's runtime row, so it sees the edges those locks
-- protect. It runs the resolver's release and rejection statements, so it keeps the resolver's
-- generic plans for the session.
CREATE OR REPLACE FUNCTION workhorse.settle_dependents_v1(
  p_now timestamptz, p_rejected_task_ids uuid[], p_released_task_ids uuid[],
  p_released_prerequisite_task_ids uuid[], p_released_prerequisite_states text[]
)
RETURNS integer
LANGUAGE plpgsql
SET plan_cache_mode = force_generic_plan
AS $$
DECLARE
  v_terminated integer := 0;
  v_released integer;
  v_deadline_task_ids uuid[];
  v_queue_names text[];
  v_task_id uuid;
  v_queue_name text;
BEGIN
  -- A rejected dependent's fate is the first rejecting resolution in the order fail, cancel, with
  -- ties broken by prerequisite identity. The terminal outcomes are this statement's last write, so
  -- their trigger resolves the next level after this level's evidence exists.
  IF p_rejected_task_ids IS NOT NULL THEN
    PERFORM 1 FROM workhorse.task_runtime runtime
     WHERE runtime.task_id = ANY(p_rejected_task_ids)
     ORDER BY runtime.task_id FOR UPDATE;
    WITH settled AS (
      SELECT rejected.task_id,
             CASE WHEN final.resolution = 'fail' THEN 'failed' ELSE 'canceled' END AS state,
             CASE WHEN final.resolution = 'fail'
               THEN 'dependency_failed' ELSE 'dependency_canceled' END AS event_type,
             jsonb_build_object(
               'name', CASE WHEN final.resolution = 'fail'
                 THEN 'DependencyFailed' ELSE 'DependencyCanceled' END,
               'message', CASE WHEN final.resolution = 'fail'
                 THEN 'a prerequisite reached a terminal outcome rejected by dependency policy'
                 ELSE 'a prerequisite reached a terminal outcome that canceled its dependent' END,
               'prerequisite_task_id', final.prerequisite_task_id,
               'prerequisite_state', final.prerequisite_state,
               'policy_action', final.resolution
             ) AS error
        FROM unnest(p_rejected_task_ids) rejected(task_id)
        CROSS JOIN LATERAL (
          SELECT dependency.resolution, dependency.prerequisite_task_id,
                 outcome.state AS prerequisite_state
            FROM workhorse.task_dependency dependency
            LEFT JOIN workhorse.task_outcome outcome
              ON outcome.task_id = dependency.prerequisite_task_id
           WHERE dependency.dependent_task_id = rejected.task_id
             AND dependency.resolution IN ('fail', 'cancel')
           ORDER BY CASE dependency.resolution WHEN 'fail' THEN 0 ELSE 1 END,
                    dependency.prerequisite_task_id
           LIMIT 1
        ) final
    ), removed AS (
      DELETE FROM workhorse.task_runtime runtime
       USING settled
       WHERE runtime.task_id = settled.task_id
         AND runtime.state = 'blocked'
      RETURNING runtime.task_id, runtime.current_attempt, runtime.run_at
    ), events AS (
      INSERT INTO workhorse.task_event(task_id, event_type, details)
      SELECT removed.task_id, settled.event_type, settled.error
        FROM removed
        JOIN settled USING (task_id)
       ORDER BY removed.task_id
    )
    INSERT INTO workhorse.task_outcome(
      task_id, state, current_attempt, fence_token, run_at, error, finished_at, updated_at,
      history_through_at
    )
    SELECT removed.task_id, settled.state, removed.current_attempt, 0, removed.run_at,
           settled.error, p_now, p_now, p_now
      FROM removed
      JOIN settled USING (task_id)
     ORDER BY removed.task_id;
    GET DIAGNOSTICS v_terminated = ROW_COUNT;
    IF v_terminated <> cardinality(p_rejected_task_ids) THEN
      RAISE EXCEPTION 'a rejected dependent has no rejecting edge';
    END IF;
  END IF;
  IF p_released_task_ids IS NULL THEN
    RETURN v_terminated;
  END IF;

  -- Ready dependents take FIFO sequence numbers in identity order. A release that no prerequisite
  -- state explains comes from a counter repair.
  WITH releasing AS (
    SELECT settled.task_id, settled.prerequisite_task_id, settled.prerequisite_state
      FROM unnest(
        p_released_task_ids, p_released_prerequisite_task_ids, p_released_prerequisite_states
      ) settled(task_id, prerequisite_task_id, prerequisite_state)
  ), ready AS (
    SELECT ordered.task_id, nextval('workhorse.ready_sequence_seq') AS sequence
      FROM (
        SELECT runtime.task_id
          FROM workhorse.task_runtime runtime
          JOIN releasing USING (task_id)
         WHERE runtime.run_at <= p_now
         ORDER BY runtime.task_id
        OFFSET 0
      ) ordered
  ), released AS (
    UPDATE workhorse.task_runtime runtime
       SET state = CASE WHEN ready.task_id IS NULL THEN 'scheduled' ELSE 'ready' END,
           ready_at = CASE WHEN ready.task_id IS NOT NULL THEN p_now END,
           sequence = ready.sequence,
           pending_prerequisites = 0,
           dependency_rejected = false,
           updated_at = p_now
      FROM releasing
      LEFT JOIN ready ON ready.task_id = releasing.task_id
     WHERE runtime.task_id = releasing.task_id
       AND runtime.state = 'blocked'
    RETURNING runtime.task_id, runtime.state, runtime.queue_name, runtime.deadline_at
  ), events AS (
    INSERT INTO workhorse.task_event(task_id, event_type, details)
    SELECT released.task_id, 'dependency_released', jsonb_build_object(
             'prerequisite_task_id', releasing.prerequisite_task_id,
             'state', released.state,
             'reason', CASE releasing.prerequisite_state
               WHEN 'succeeded' THEN 'prerequisite_succeeded'
               WHEN 'failed' THEN 'prerequisite_failed_policy'
               WHEN 'canceled' THEN 'prerequisite_canceled_policy'
               ELSE 'dependency_counter_repaired'
             END
           )
      FROM released
      JOIN releasing USING (task_id)
     ORDER BY released.task_id
  )
  SELECT count(*),
         array_agg(released.task_id ORDER BY released.task_id)
           FILTER (WHERE released.deadline_at <= p_now),
         array_agg(DISTINCT released.queue_name ORDER BY released.queue_name)
           FILTER (
             WHERE released.state = 'ready'
               AND (released.deadline_at IS NULL OR released.deadline_at > p_now)
           )
    INTO v_released, v_deadline_task_ids, v_queue_names
    FROM released;
  FOREACH v_task_id IN ARRAY coalesce(v_deadline_task_ids, '{}') LOOP
    PERFORM workhorse.terminalize_deadline_v1(v_task_id);
  END LOOP;
  FOREACH v_queue_name IN ARRAY coalesce(v_queue_names, '{}') LOOP
    PERFORM pg_notify('workhorse_tasks', v_queue_name);
  END LOOP;
  RETURN v_terminated + v_released;
END;
$$;

-- Resolve every pending edge from a set of prerequisites that reached terminal outcomes in the
-- same statement. The resolver locks the runtime row of every blocked dependent in identity order
-- before it touches any edge. A dependent's own terminal transition also holds its runtime row
-- before it releases the dependent's edges, so the two cannot wait for each other. The lock does
-- not conflict with the key-share lock an enqueue takes on a prerequisite's runtime row. Only the
-- delete of a dependent that fails or is canceled waits for such an enqueue. Before that delete,
-- the resolver locks every rejected dependent for update in identity order, the order in which an
-- enqueue batch locks all its prerequisites. The delete's plan would otherwise lock them in any
-- order, and a batch holding one could wait for another that the resolver already held.
--
-- Each blocked dependent carries `pending_prerequisites`, the number of its edges still pending,
-- and `dependency_rejected`, whether a resolved edge chose `fail` or `cancel`. The resolver
-- subtracts the edges it resolved for a dependent from that counter. A dependent with edges left
-- costs one runtime update and no edge scan. Only a dependent that settles after a rejection reads
-- its edges, to name the prerequisite that decides its outcome. A counter that would fall below
-- zero has drifted from the edges. The resolver recounts that dependent's pending edges and
-- rejections, records a `dependency_counter_repaired` event, and continues with the recount, so
-- the drift cannot fail the prerequisite's own transition.
CREATE OR REPLACE FUNCTION workhorse.resolve_dependents_many_v1(
  p_prerequisite_task_ids uuid[], p_prerequisite_states text[]
)
RETURNS integer
LANGUAGE plpgsql
SET plan_cache_mode = force_generic_plan
AS $$
DECLARE
  v_now timestamptz := clock_timestamp();
  v_dependents uuid[];
  v_resolved_task_ids uuid[];
  v_decrements integer[];
  v_rejections boolean[];
  v_releasing_prerequisite_task_ids uuid[];
  v_releasing_prerequisite_states text[];
  v_rejected_task_ids uuid[];
  v_released_task_ids uuid[];
  v_released_prerequisite_task_ids uuid[];
  v_released_prerequisite_states text[];
BEGIN
  IF cardinality(p_prerequisite_task_ids) IS DISTINCT FROM cardinality(p_prerequisite_states) THEN
    RAISE EXCEPTION 'prerequisite identities and states must have the same length';
  END IF;
  IF EXISTS (
    SELECT 1 FROM unnest(p_prerequisite_states) prerequisite(state)
     WHERE prerequisite.state IS NULL
        OR prerequisite.state NOT IN ('succeeded', 'failed', 'canceled')
  ) THEN
    RAISE EXCEPTION 'prerequisite state must be succeeded, failed, or canceled';
  END IF;
  SELECT array_agg(locked.task_id ORDER BY locked.task_id) INTO v_dependents
    FROM (
      SELECT runtime.task_id
        FROM workhorse.task_runtime runtime
       WHERE runtime.task_id IN (
               SELECT dependency.dependent_task_id
                 FROM workhorse.task_dependency dependency
                WHERE dependency.prerequisite_task_id = ANY(p_prerequisite_task_ids)
                  AND dependency.released_at IS NULL
             )
         AND runtime.state = 'blocked'
       ORDER BY runtime.task_id
         FOR NO KEY UPDATE OF runtime
    ) locked;
  IF v_dependents IS NULL THEN
    RETURN 0;
  END IF;

  -- A release names the smallest prerequisite in this call that resolved one of the dependent's
  -- edges.
  WITH resolved AS (
    UPDATE workhorse.task_dependency dependency
       SET released_at = v_now,
           resolution = CASE prerequisite.state
             WHEN 'succeeded' THEN dependency.on_success
             WHEN 'failed' THEN dependency.on_failure
             ELSE dependency.on_cancellation
           END
      FROM unnest(p_prerequisite_task_ids, p_prerequisite_states) prerequisite(task_id, state)
     WHERE dependency.prerequisite_task_id = prerequisite.task_id
       AND dependency.dependent_task_id = ANY(v_dependents)
       AND dependency.released_at IS NULL
    RETURNING dependency.dependent_task_id, dependency.prerequisite_task_id,
              dependency.resolution, prerequisite.state
  ), counted AS (
    SELECT resolved.dependent_task_id,
           count(*)::integer AS decrement,
           bool_or(resolved.resolution IN ('fail', 'cancel')) AS rejected,
           (array_agg(resolved.prerequisite_task_id
              ORDER BY resolved.prerequisite_task_id))[1] AS prerequisite_task_id,
           (array_agg(resolved.state ORDER BY resolved.prerequisite_task_id))[1] AS state
      FROM resolved
     GROUP BY resolved.dependent_task_id
  )
  SELECT array_agg(counted.dependent_task_id ORDER BY counted.dependent_task_id),
         array_agg(counted.decrement ORDER BY counted.dependent_task_id),
         array_agg(counted.rejected ORDER BY counted.dependent_task_id),
         array_agg(counted.prerequisite_task_id ORDER BY counted.dependent_task_id),
         array_agg(counted.state ORDER BY counted.dependent_task_id)
    INTO v_resolved_task_ids, v_decrements, v_rejections, v_releasing_prerequisite_task_ids,
         v_releasing_prerequisite_states
    FROM counted;
  IF v_resolved_task_ids IS NULL THEN
    RETURN 0;
  END IF;

  -- A dependent settles once its counter reaches zero. Settled dependents keep their counters until
  -- the statement that terminates or releases them, so each dependent takes one runtime write. A
  -- counter below its resolved edges is replaced by a recount of the edges this statement sees,
  -- which already include the resolutions written above.
  WITH measured AS MATERIALIZED (
    SELECT runtime.task_id, runtime.pending_prerequisites AS recorded, resolved.decrement,
           runtime.pending_prerequisites < resolved.decrement AS repaired,
           runtime.pending_prerequisites - resolved.decrement AS remaining,
           runtime.dependency_rejected OR resolved.rejected AS rejected,
           resolved.prerequisite_task_id, resolved.state
      FROM unnest(
        v_resolved_task_ids, v_decrements, v_rejections, v_releasing_prerequisite_task_ids,
        v_releasing_prerequisite_states
      ) resolved(task_id, decrement, rejected, prerequisite_task_id, state)
      JOIN workhorse.task_runtime runtime ON runtime.task_id = resolved.task_id
  ), counted AS MATERIALIZED (
    SELECT measured.task_id, measured.recorded, measured.decrement, measured.repaired,
           CASE WHEN measured.repaired THEN edges.pending_edges ELSE measured.remaining END
             AS remaining,
           CASE WHEN measured.repaired THEN edges.rejected_edges ELSE measured.rejected END
             AS rejected,
           measured.prerequisite_task_id, measured.state
      FROM measured
      LEFT JOIN LATERAL (
        SELECT (count(*) FILTER (WHERE dependency.released_at IS NULL))::integer AS pending_edges,
               coalesce(bool_or(dependency.resolution IN ('fail', 'cancel')), false)
                 AS rejected_edges
          FROM workhorse.task_dependency dependency
         WHERE dependency.dependent_task_id = measured.task_id
      ) edges ON measured.repaired
  ), decremented AS (
    UPDATE workhorse.task_runtime runtime
       SET pending_prerequisites = counted.remaining, dependency_rejected = counted.rejected
      FROM counted
     WHERE runtime.task_id = counted.task_id
       AND counted.remaining <> 0
  ), repairs AS (
    INSERT INTO workhorse.task_event(task_id, event_type, details)
    SELECT counted.task_id, 'dependency_counter_repaired', jsonb_build_object(
             'source', 'resolver',
             'prerequisite_task_id', counted.prerequisite_task_id,
             'recorded_pending_prerequisites', counted.recorded,
             'resolved_edges', counted.decrement,
             'pending_edges', counted.remaining,
             'dependency_rejected', counted.rejected
           )
      FROM counted
     WHERE counted.repaired
     ORDER BY counted.task_id
  )
  SELECT array_agg(counted.task_id ORDER BY counted.task_id)
           FILTER (WHERE counted.remaining = 0 AND counted.rejected),
         array_agg(counted.task_id ORDER BY counted.task_id)
           FILTER (WHERE counted.remaining = 0 AND NOT counted.rejected),
         array_agg(counted.prerequisite_task_id ORDER BY counted.task_id)
           FILTER (WHERE counted.remaining = 0 AND NOT counted.rejected),
         array_agg(counted.state ORDER BY counted.task_id)
           FILTER (WHERE counted.remaining = 0 AND NOT counted.rejected)
    INTO v_rejected_task_ids, v_released_task_ids, v_released_prerequisite_task_ids,
         v_released_prerequisite_states
    FROM counted;

  RETURN workhorse.settle_dependents_v1(
    v_now, v_rejected_task_ids, v_released_task_ids, v_released_prerequisite_task_ids,
    v_released_prerequisite_states
  );
END;
$$;

-- Report blocked tasks whose dependency counters disagree with their edges. A row is drifted when
-- `pending_prerequisites` differs from its pending edges or `dependency_rejected` differs from its
-- rejecting resolutions. A row is also reported when every edge is resolved but the task is still
-- blocked, whatever its counter says. Every blocked task keeps all its edges, because pruning
-- removes only edges whose dependent has a terminal outcome.
CREATE OR REPLACE FUNCTION workhorse.dependency_counter_drift_v1(p_limit integer DEFAULT 1000)
RETURNS TABLE(
  task_id uuid, queue_name text, pending_prerequisites integer, pending_edges integer,
  dependency_rejected boolean, rejected_edges boolean, counter_drifted boolean,
  edges_resolved boolean
)
LANGUAGE plpgsql
STABLE
AS $$
#variable_conflict use_column
BEGIN
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 100000 THEN
    RAISE EXCEPTION 'dependency counter drift limit must be between 1 and 100000';
  END IF;
  RETURN QUERY
  SELECT runtime.task_id, runtime.queue_name, runtime.pending_prerequisites, edges.pending_edges,
         runtime.dependency_rejected, edges.rejected_edges,
         runtime.pending_prerequisites <> edges.pending_edges
           OR runtime.dependency_rejected <> edges.rejected_edges,
         edges.pending_edges = 0
    FROM workhorse.task_runtime runtime
    CROSS JOIN LATERAL (
      SELECT (count(*) FILTER (WHERE dependency.released_at IS NULL))::integer AS pending_edges,
             coalesce(bool_or(dependency.resolution IN ('fail', 'cancel')), false)
               AS rejected_edges
        FROM workhorse.task_dependency dependency
       WHERE dependency.dependent_task_id = runtime.task_id
    ) edges
   WHERE runtime.state = 'blocked'
     AND (
       runtime.pending_prerequisites <> edges.pending_edges
       OR runtime.dependency_rejected <> edges.rejected_edges
       OR edges.pending_edges = 0
     )
   ORDER BY runtime.task_id
   LIMIT p_limit;
END;
$$;

-- Repair the blocked tasks that `dependency_counter_drift_v1` reports, in identity order. The
-- repair locks their runtime rows the way the resolver does, then recounts each one's edges under
-- the lock, because an edge resolves only while its dependent's runtime row is held. A task with
-- pending edges left takes the recounted counter and rejection flag. A task with no pending edge
-- settles: it fails or is canceled after a rejecting resolution and is released otherwise. Each
-- repaired task gets a `dependency_counter_repaired` event before any settlement event.
CREATE OR REPLACE FUNCTION workhorse.repair_dependency_counters_v1(p_limit integer DEFAULT 1000)
RETURNS TABLE(
  task_id uuid, recorded_pending_prerequisites integer, pending_edges integer, action text
)
LANGUAGE plpgsql
AS $$
#variable_conflict use_column
DECLARE
  v_now timestamptz := clock_timestamp();
  v_candidates uuid[];
  v_locked uuid[];
  v_task_ids uuid[];
  v_recorded integer[];
  v_pending_edges integer[];
  v_rejected_edges boolean[];
  v_prerequisite_task_ids uuid[];
  v_actions text[];
  v_rejected_task_ids uuid[];
  v_released_task_ids uuid[];
  v_released_prerequisite_task_ids uuid[];
BEGIN
  SELECT array_agg(drift.task_id ORDER BY drift.task_id) INTO v_candidates
    FROM workhorse.dependency_counter_drift_v1(p_limit) drift;
  IF v_candidates IS NULL THEN
    RETURN;
  END IF;
  SELECT array_agg(locked.task_id ORDER BY locked.task_id) INTO v_locked
    FROM (
      SELECT runtime.task_id
        FROM workhorse.task_runtime runtime
       WHERE runtime.task_id = ANY(v_candidates)
         AND runtime.state = 'blocked'
       ORDER BY runtime.task_id
         FOR NO KEY UPDATE OF runtime
    ) locked;
  IF v_locked IS NULL THEN
    RETURN;
  END IF;

  -- A release names the prerequisite whose edge resolved last. Its reason records the repair
  -- rather than a prerequisite outcome.
  SELECT array_agg(measured.task_id ORDER BY measured.task_id),
         array_agg(measured.recorded ORDER BY measured.task_id),
         array_agg(measured.pending_edges ORDER BY measured.task_id),
         array_agg(measured.rejected_edges ORDER BY measured.task_id),
         array_agg(measured.prerequisite_task_id ORDER BY measured.task_id),
         array_agg(measured.action ORDER BY measured.task_id)
    INTO v_task_ids, v_recorded, v_pending_edges, v_rejected_edges, v_prerequisite_task_ids,
         v_actions
    FROM (
      SELECT runtime.task_id, runtime.pending_prerequisites AS recorded, edges.pending_edges,
             edges.rejected_edges, edges.prerequisite_task_id,
             CASE
               WHEN edges.pending_edges > 0 THEN 'recounted'
               WHEN edges.rejected_edges THEN 'rejected'
               ELSE 'released'
             END AS action
        FROM workhorse.task_runtime runtime
        CROSS JOIN LATERAL (
          SELECT (count(*) FILTER (WHERE dependency.released_at IS NULL))::integer
                   AS pending_edges,
                 coalesce(bool_or(dependency.resolution IN ('fail', 'cancel')), false)
                   AS rejected_edges,
                 (array_agg(dependency.prerequisite_task_id
                    ORDER BY dependency.released_at DESC, dependency.prerequisite_task_id)
                    FILTER (WHERE dependency.released_at IS NOT NULL))[1] AS prerequisite_task_id
            FROM workhorse.task_dependency dependency
           WHERE dependency.dependent_task_id = runtime.task_id
        ) edges
       WHERE runtime.task_id = ANY(v_locked)
         AND (
           runtime.pending_prerequisites <> edges.pending_edges
           OR runtime.dependency_rejected <> edges.rejected_edges
           OR edges.pending_edges = 0
         )
    ) measured;
  IF v_task_ids IS NULL THEN
    RETURN;
  END IF;

  WITH recounted AS (
    UPDATE workhorse.task_runtime runtime
       SET pending_prerequisites = repair.pending_edges,
           dependency_rejected = repair.rejected_edges,
           updated_at = v_now
      FROM unnest(v_task_ids, v_pending_edges, v_rejected_edges, v_actions)
             repair(task_id, pending_edges, rejected_edges, action)
     WHERE runtime.task_id = repair.task_id
       AND repair.action = 'recounted'
  )
  INSERT INTO workhorse.task_event(task_id, event_type, details)
  SELECT repair.task_id, 'dependency_counter_repaired', jsonb_build_object(
           'source', 'repair',
           'prerequisite_task_id', repair.prerequisite_task_id,
           'recorded_pending_prerequisites', repair.recorded,
           'pending_edges', repair.pending_edges,
           'dependency_rejected', repair.rejected_edges
         )
    FROM unnest(v_task_ids, v_recorded, v_pending_edges, v_rejected_edges, v_prerequisite_task_ids)
           repair(task_id, recorded, pending_edges, rejected_edges, prerequisite_task_id)
   ORDER BY repair.task_id;

  SELECT array_agg(repair.task_id ORDER BY repair.task_id)
           FILTER (WHERE repair.action = 'rejected'),
         array_agg(repair.task_id ORDER BY repair.task_id)
           FILTER (WHERE repair.action = 'released'),
         array_agg(repair.prerequisite_task_id ORDER BY repair.task_id)
           FILTER (WHERE repair.action = 'released')
    INTO v_rejected_task_ids, v_released_task_ids, v_released_prerequisite_task_ids
    FROM unnest(v_task_ids, v_prerequisite_task_ids, v_actions)
           repair(task_id, prerequisite_task_id, action);
  PERFORM workhorse.settle_dependents_v1(
    v_now, v_rejected_task_ids, v_released_task_ids, v_released_prerequisite_task_ids,
    array_fill(NULL::text, ARRAY[coalesce(cardinality(v_released_task_ids), 0)])
  );

  RETURN QUERY
  SELECT repair.task_id, repair.recorded, repair.pending_edges, repair.action
    FROM unnest(v_task_ids, v_recorded, v_pending_edges, v_actions)
           repair(task_id, recorded, pending_edges, action)
   ORDER BY repair.task_id;
END;
$$;
