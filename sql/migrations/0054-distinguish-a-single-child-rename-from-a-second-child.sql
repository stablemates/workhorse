-- workhorse-migration: {"kind":"additive"}

-- A single-child name change is a replay conflict unless this handler activation already
-- created or joined the retained child. The fence identifies an activation, not an attempt:
-- suspension preserves the logical attempt but the next claim receives a new fence.
-- Existing edges start with no observed fence, so their first renamed replay conflicts too.
-- Keep v1 unchanged for workers from an older release.
ALTER TABLE workhorse.task_child ADD COLUMN last_seen_fence_token bigint;

CREATE OR REPLACE FUNCTION workhorse.create_single_child_v2(
  p_parent_task_id uuid,
  p_worker_id text,
  p_fence_token bigint,
  p_child_name text,
  p_request jsonb
) RETURNS TABLE (
  status text,
  child_task_id uuid,
  child_type text,
  created_at timestamptz,
  joined_at timestamptz,
  result jsonb,
  stored_child_name text
)
LANGUAGE plpgsql
AS $$
DECLARE
  v_runtime workhorse.task_runtime%ROWTYPE;
  v_edge workhorse.task_child%ROWTYPE;
  v_enqueue record;
  v_outcome workhorse.task_outcome%ROWTYPE;
  v_now timestamptz;
BEGIN
  IF p_child_name IS NULL OR p_child_name = '' OR char_length(p_child_name) > 200 THEN
    RAISE EXCEPTION 'child_name must contain between 1 and 200 characters';
  END IF;
  IF p_request IS NULL OR jsonb_typeof(p_request) <> 'object' THEN
    RAISE EXCEPTION 'child request must be a JSON object';
  END IF;
  IF p_request ?| ARRAY['idempotency', 'debounce', 'throttle']
     OR COALESCE(p_request->'prerequisiteTaskId', 'null'::jsonb) <> 'null'::jsonb
     OR COALESCE(p_request->'dependencies', 'null'::jsonb) <> 'null'::jsonb THEN
    RAISE EXCEPTION 'child tasks cannot use coalescing or dependency enqueue options';
  END IF;

  SELECT * INTO v_runtime
    FROM workhorse.task_runtime runtime
   WHERE runtime.task_id = p_parent_task_id
     AND runtime.state = 'active'
     AND runtime.worker_id = p_worker_id
     AND runtime.fence_token = p_fence_token
   FOR UPDATE;
  v_now := clock_timestamp();
  IF NOT FOUND OR v_runtime.expires_at <= v_now
     OR (v_runtime.deadline_at IS NOT NULL AND v_runtime.deadline_at <= v_now)
     OR (v_runtime.attempt_timeout_at IS NOT NULL AND v_runtime.attempt_timeout_at <= v_now)
     OR v_runtime.cancel_requested_at IS NOT NULL THEN
    RETURN QUERY VALUES (
      'stale'::text, NULL::uuid, NULL::text, NULL::timestamptz,
      NULL::timestamptz, NULL::jsonb, v_edge.child_name
    );
    RETURN;
  END IF;

  SELECT * INTO v_edge
    FROM workhorse.task_child edge
   WHERE edge.parent_task_id = p_parent_task_id
   FOR UPDATE;
  IF FOUND THEN
    IF v_edge.child_name <> p_child_name THEN
      RETURN QUERY VALUES (
        CASE WHEN v_edge.last_seen_fence_token = p_fence_token
          THEN 'limit_exceeded' ELSE 'conflict' END::text, v_edge.child_task_id,
        (SELECT task_type FROM workhorse.task WHERE id = v_edge.child_task_id),
        v_edge.created_at, v_edge.joined_at, NULL::jsonb, v_edge.child_name
      );
      RETURN;
    END IF;
    IF v_edge.request_fingerprint <> p_request THEN
      RETURN QUERY VALUES (
        'conflict'::text, v_edge.child_task_id,
        (SELECT task_type FROM workhorse.task WHERE id = v_edge.child_task_id),
        v_edge.created_at, v_edge.joined_at, NULL::jsonb, v_edge.child_name
      );
      RETURN;
    END IF;
    SELECT * INTO v_outcome FROM workhorse.task_outcome outcome
     WHERE outcome.task_id = v_edge.child_task_id;
    IF NOT FOUND OR v_outcome.state <> 'succeeded' THEN
      RETURN QUERY VALUES (
        'stale'::text, v_edge.child_task_id,
        (SELECT task_type FROM workhorse.task WHERE id = v_edge.child_task_id),
        v_edge.created_at, v_edge.joined_at, NULL::jsonb, v_edge.child_name
      );
      RETURN;
    END IF;
    -- Record the successful join even if a previous run already joined this child.
    UPDATE workhorse.task_child edge SET last_seen_fence_token = p_fence_token
     WHERE edge.parent_task_id = p_parent_task_id;
    IF v_edge.joined_at IS NULL THEN
      UPDATE workhorse.task_child edge SET joined_at = v_now
       WHERE edge.parent_task_id = p_parent_task_id
       RETURNING * INTO v_edge;
      INSERT INTO workhorse.task_event(task_id, attempt, event_type, details)
        VALUES (
          p_parent_task_id, v_runtime.current_attempt, 'child_joined',
          jsonb_build_object(
            'name', p_child_name,
            'child_task_id', v_edge.child_task_id,
            'fence_token', p_fence_token::text
          )
        );
    END IF;
    RETURN QUERY VALUES (
      'completed'::text, v_edge.child_task_id,
      (SELECT task_type FROM workhorse.task WHERE id = v_edge.child_task_id),
      v_edge.created_at, v_edge.joined_at, v_outcome.result, v_edge.child_name
    );
    RETURN;
  END IF;

  IF EXISTS (SELECT 1 FROM workhorse.task_child edge WHERE edge.parent_task_id = p_parent_task_id) THEN
    RETURN QUERY VALUES (
      'limit_exceeded'::text, NULL::uuid, NULL::text, NULL::timestamptz,
      NULL::timestamptz, NULL::jsonb, v_edge.child_name
    );
    RETURN;
  END IF;

  -- A fast-tier task never resolves dependents, so it cannot be joined as a child.
  IF cardinality(workhorse.lock_queue_tiers_v1(ARRAY[p_request->>'queue'])) > 0 THEN
    PERFORM workhorse.reject_fast_feature_v1(p_request->>'queue', 'child tasks');
  END IF;

  BEGIN
    SELECT * INTO v_enqueue FROM workhorse.enqueue_many_v1(jsonb_build_array(p_request));
    IF v_enqueue.outcome <> 'accepted' THEN
      RAISE EXCEPTION 'child enqueue must create one new task';
    END IF;
    INSERT INTO workhorse.task_child(
      parent_task_id, child_task_id, child_name, request_fingerprint, created_at, last_seen_fence_token
    ) VALUES (
      p_parent_task_id, v_enqueue.task_id, p_child_name, p_request, v_now, p_fence_token
    ) RETURNING * INTO v_edge;
    INSERT INTO workhorse.task_dependency(
      dependent_task_id, prerequisite_task_id, on_success, on_failure, on_cancellation, created_at
    ) VALUES (
      p_parent_task_id, v_enqueue.task_id, 'release', 'fail', 'cancel', v_now
    );

    UPDATE workhorse.task_runtime runtime
       SET state = 'blocked', fence_token = 0, ready_at = NULL, sequence = NULL,
           worker_id = NULL, acquired_at = NULL, heartbeat_at = NULL, expires_at = NULL,
           wait_name = NULL, attempt_started_at = NULL,
           execution_used_ms = LEAST(
             31536000000,
             runtime.execution_used_ms + GREATEST(
               0, floor(extract(epoch FROM v_now - runtime.acquired_at) * 1000)::bigint
             )
           ),
           attempt_timeout_at = NULL, error = NULL, updated_at = v_now,
           pending_prerequisites = (
             SELECT count(*)::integer FROM workhorse.task_dependency dependency
              WHERE dependency.dependent_task_id = p_parent_task_id
                AND dependency.released_at IS NULL
           )
     WHERE runtime.task_id = p_parent_task_id
       AND runtime.state = 'active'
       AND runtime.worker_id = p_worker_id
       AND runtime.fence_token = p_fence_token
       AND runtime.expires_at > clock_timestamp()
       AND (runtime.deadline_at IS NULL OR runtime.deadline_at > clock_timestamp())
       AND (runtime.attempt_timeout_at IS NULL OR runtime.attempt_timeout_at > clock_timestamp());
    IF NOT FOUND THEN
      RAISE EXCEPTION USING
        ERRCODE = 'P1004',
        MESSAGE = 'child creation lost the parent lease';
    END IF;

    INSERT INTO workhorse.task_event(task_id, attempt, event_type, details)
      VALUES (
        p_parent_task_id, v_runtime.current_attempt, 'child_created',
        jsonb_build_object(
          'name', p_child_name,
          'child_task_id', v_edge.child_task_id,
          'fence_token', p_fence_token::text
        )
      );
    INSERT INTO workhorse.task_event(task_id, event_type, details)
      VALUES (
        v_edge.child_task_id, 'parent_linked',
        jsonb_build_object('parent_task_id', p_parent_task_id, 'name', p_child_name)
      );
    -- A child whose deadline had already passed reached its outcome inside the enqueue, before
    -- its edge existed, so that outcome resolved nothing. Resolve the edge now that the parent
    -- is blocked, or the parent waits for an outcome that will never fire again.
    SELECT * INTO v_outcome FROM workhorse.task_outcome outcome
     WHERE outcome.task_id = v_edge.child_task_id;
    IF FOUND THEN
      PERFORM workhorse.resolve_dependents_many_v1(
        ARRAY[v_outcome.task_id], ARRAY[v_outcome.state]
      );
    END IF;
    RETURN QUERY VALUES (
      'created'::text, v_edge.child_task_id, p_request->>'type', v_edge.created_at,
      NULL::timestamptz, NULL::jsonb, v_edge.child_name
    );
  EXCEPTION
    WHEN SQLSTATE 'P1004' THEN
      RETURN QUERY VALUES (
        'stale'::text, NULL::uuid, NULL::text, NULL::timestamptz,
        NULL::timestamptz, NULL::jsonb, v_edge.child_name
      );
  END;
END;
$$;

CREATE OR REPLACE FUNCTION workhorse.create_child_v2(
  p_parent_task_id uuid,
  p_worker_id text,
  p_fence_token bigint,
  p_child_name text,
  p_request jsonb
) RETURNS TABLE (
  status text,
  child_task_id uuid,
  child_type text,
  created_at timestamptz,
  joined_at timestamptz,
  result jsonb,
  stored_child_name text
)
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM workhorse.task_child edge
     WHERE edge.parent_task_id = p_parent_task_id AND edge.created_as_set
  ) THEN
    RETURN QUERY VALUES (
      'limit_exceeded'::text, NULL::uuid, NULL::text, NULL::timestamptz,
      NULL::timestamptz, NULL::jsonb, NULL::text
    );
    RETURN;
  END IF;
  RETURN QUERY
    SELECT single.status, single.child_task_id, single.child_type, single.created_at,
           single.joined_at, single.result, single.stored_child_name
      FROM workhorse.create_single_child_v2(
        p_parent_task_id, p_worker_id, p_fence_token, p_child_name, p_request
      ) single;
END;
$$;

