-- workhorse-migration: {"kind":"additive"}

-- Govern the dependency counter drift check and repair (SM-958).

-- Migration 0039 added dependency_counter_drift_v1 and repair_dependency_counters_v1, but no
-- governed surface called them. An operator had to run raw SQL, and a repair recorded nobody who
-- asked for it or why.
--
-- list_dependency_drift_v1 reads the drifted blocked tasks and the action a repair would take on
-- each, so a dry run reports the plan without writing. repair_dependency_drift_v1 takes the
-- actor, reason, and request id every guarded admin mutation takes. It validates them the way
-- purge_queue_v1 does and records them in each dependency_counter_repaired event it appends.
--
-- The request id correlates the repair with the operator's request, but it is not an
-- idempotency key. A second repair finds only rows that drifted again, so a rerun is safe without
-- a retained request.
--
-- repair_dependency_counters_internal_v1 holds the repair body and takes the audit fields to
-- merge into each event. repair_dependency_counters_v1 keeps its signature and result and calls
-- the internal function with no audit. The resolver, settle_dependents_v1, and queue_health_v1
-- are unchanged.

-- Repair the blocked tasks that `dependency_counter_drift_v1` reports, in identity order. The
-- repair locks their runtime rows the way the resolver does, then recounts each one's edges under
-- the lock, because an edge resolves only while its dependent's runtime row is held. A task with
-- pending edges left takes the recounted counter and rejection flag. A task with no pending edge
-- settles: it fails or is canceled after a rejecting resolution and is released otherwise. Each
-- repaired task gets a `dependency_counter_repaired` event before any settlement event, and the
-- event carries `p_audit`'s keys.
CREATE OR REPLACE FUNCTION workhorse.repair_dependency_counters_internal_v1(
  p_limit integer, p_audit jsonb
)
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
         ) || coalesce(p_audit, '{}'::jsonb)
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

-- The ungoverned repair, kept for callers of migration 0039. It records no audit.
CREATE OR REPLACE FUNCTION workhorse.repair_dependency_counters_v1(p_limit integer DEFAULT 1000)
RETURNS TABLE(
  task_id uuid, recorded_pending_prerequisites integer, pending_edges integer, action text
)
LANGUAGE sql
AS $$
  SELECT repair.task_id, repair.recorded_pending_prerequisites, repair.pending_edges,
         repair.action
    FROM workhorse.repair_dependency_counters_internal_v1(p_limit, '{}'::jsonb) repair;
$$;

-- List the blocked tasks whose dependency counters disagree with their edges, with the action a
-- repair would take on each: `recounted` while a pending edge remains, `rejected` after a
-- rejecting resolution, and `released` otherwise. A repair recounts under lock, so its action can
-- differ from this plan when an edge resolves in between. It writes nothing.
CREATE OR REPLACE FUNCTION workhorse.list_dependency_drift_v1(p_limit integer)
RETURNS TABLE(
  task_id uuid, queue_name text, pending_prerequisites integer, pending_edges integer,
  dependency_rejected boolean, rejected_edges boolean, action text
)
LANGUAGE sql
STABLE
AS $$
  SELECT drift.task_id, drift.queue_name, drift.pending_prerequisites, drift.pending_edges,
         drift.dependency_rejected, drift.rejected_edges,
         CASE
           WHEN drift.pending_edges > 0 THEN 'recounted'
           WHEN drift.rejected_edges THEN 'rejected'
           ELSE 'released'
         END
    FROM workhorse.dependency_counter_drift_v1(p_limit) drift
   ORDER BY drift.task_id;
$$;

-- Repair drifted blocked tasks on an operator's request. The actor, reason, and request id follow
-- the limits of every guarded admin mutation. Each `dependency_counter_repaired` event records the
-- actor and reason, and a preview, digest, and length of the request id rather than the id itself.
CREATE OR REPLACE FUNCTION workhorse.repair_dependency_drift_v1(
  p_limit integer,
  p_requested_by text,
  p_reason text,
  p_request_id text
)
RETURNS TABLE(
  task_id uuid, recorded_pending_prerequisites integer, pending_edges integer, action text
)
LANGUAGE plpgsql
AS $$
#variable_conflict use_column
DECLARE
  v_request_id_length integer;
  v_request_id_preview text;
BEGIN
  IF p_requested_by IS NULL OR p_requested_by = '' OR char_length(p_requested_by) > 200 THEN
    RAISE EXCEPTION 'requested_by must contain between 1 and 200 characters';
  END IF;
  IF p_reason IS NULL OR p_reason = '' OR char_length(p_reason) > 2000 THEN
    RAISE EXCEPTION 'reason must contain between 1 and 2000 characters';
  END IF;
  IF p_request_id IS NULL OR p_request_id = '' OR octet_length(p_request_id) > 512 THEN
    RAISE EXCEPTION 'request_id must contain between 1 and 512 UTF-8 bytes';
  END IF;

  v_request_id_length := char_length(p_request_id);
  v_request_id_preview := CASE
    WHEN v_request_id_length <= 4 THEN repeat('•', v_request_id_length)
    WHEN v_request_id_length <= 8 THEN left(p_request_id, 2) || '…' || right(p_request_id, 2)
    ELSE left(p_request_id, 8) || '…' || right(p_request_id, 4)
  END;

  RETURN QUERY
  SELECT repair.task_id, repair.recorded_pending_prerequisites, repair.pending_edges,
         repair.action
    FROM workhorse.repair_dependency_counters_internal_v1(
      p_limit,
      jsonb_build_object(
        'requested_by', p_requested_by,
        'request_reason', p_reason,
        'request_id_preview', v_request_id_preview,
        'request_id_digest', left(encode(sha256(convert_to(p_request_id, 'UTF8')), 'hex'), 12),
        'request_id_length', v_request_id_length
      )
    ) repair;
END;
$$;
