-- workhorse-migration: {"kind":"additive"}

-- A child that is terminal at creation settles its parent (SM-936).

-- Child creation enqueues a child first and inserts the parent's pending edge on it afterwards. A
-- child whose absolute deadline had already passed reaches its outcome inside that enqueue, while
-- no edge exists yet, so its outcome resolved nothing. The edge was then inserted pending and the
-- parent was blocked on a prerequisite that would never fire again. With the pending-prerequisite
-- counter from 0030 the parent stayed blocked until its own deadline, or forever without one.
--
-- create_single_child_v1 and create_children_v1 now pass every child that already holds an
-- outcome to workhorse.resolve_dependents_many_v1 after they block the parent. The resolver
-- releases or rejects the parent exactly as a later child outcome would have. Both signatures and
-- result shapes are unchanged.

-- Create one child and suspend its exact active parent generation in the same transaction. A
-- replay after the child succeeds returns its retained result and marks the join exactly once.
CREATE OR REPLACE FUNCTION workhorse.create_single_child_v1(
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
  result jsonb
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
      NULL::timestamptz, NULL::jsonb
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
        'limit_exceeded'::text, v_edge.child_task_id,
        (SELECT task_type FROM workhorse.task WHERE id = v_edge.child_task_id),
        v_edge.created_at, v_edge.joined_at, NULL::jsonb
      );
      RETURN;
    END IF;
    IF v_edge.request_fingerprint <> p_request THEN
      RETURN QUERY VALUES (
        'conflict'::text, v_edge.child_task_id,
        (SELECT task_type FROM workhorse.task WHERE id = v_edge.child_task_id),
        v_edge.created_at, v_edge.joined_at, NULL::jsonb
      );
      RETURN;
    END IF;
    SELECT * INTO v_outcome FROM workhorse.task_outcome outcome
     WHERE outcome.task_id = v_edge.child_task_id;
    IF NOT FOUND OR v_outcome.state <> 'succeeded' THEN
      RETURN QUERY VALUES (
        'stale'::text, v_edge.child_task_id,
        (SELECT task_type FROM workhorse.task WHERE id = v_edge.child_task_id),
        v_edge.created_at, v_edge.joined_at, NULL::jsonb
      );
      RETURN;
    END IF;
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
      v_edge.created_at, v_edge.joined_at, v_outcome.result
    );
    RETURN;
  END IF;

  IF EXISTS (SELECT 1 FROM workhorse.task_child edge WHERE edge.parent_task_id = p_parent_task_id) THEN
    RETURN QUERY VALUES (
      'limit_exceeded'::text, NULL::uuid, NULL::text, NULL::timestamptz,
      NULL::timestamptz, NULL::jsonb
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
      parent_task_id, child_task_id, child_name, request_fingerprint, created_at
    ) VALUES (
      p_parent_task_id, v_enqueue.task_id, p_child_name, p_request, v_now
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
      NULL::timestamptz, NULL::jsonb
    );
  EXCEPTION
    WHEN SQLSTATE 'P1004' THEN
      RETURN QUERY VALUES (
        'stale'::text, NULL::uuid, NULL::text, NULL::timestamptz,
        NULL::timestamptz, NULL::jsonb
      );
  END;
END;
$$;

CREATE OR REPLACE FUNCTION workhorse.create_children_v1(
  p_parent_task_id uuid,
  p_worker_id text,
  p_fence_token bigint,
  p_children jsonb,
  p_mode text
) RETURNS TABLE (
  status text,
  children jsonb,
  results jsonb,
  result_bytes integer,
  result_limit_bytes integer
)
LANGUAGE plpgsql
AS $$
DECLARE
  v_runtime workhorse.task_runtime%ROWTYPE;
  v_item record;
  v_enqueue record;
  v_existing_count integer;
  v_result_limit integer;
  v_children jsonb := '[]'::jsonb;
  v_results jsonb := '{}'::jsonb;
  v_result_bytes integer := 2;
  v_now timestamptz;
  v_had_unjoined boolean;
  v_fast_queue text;
BEGIN
  IF p_mode NOT IN ('settled', 'all_success') THEN
    RAISE EXCEPTION 'child join mode must be settled or all_success';
  END IF;
  IF p_children IS NULL OR jsonb_typeof(p_children) <> 'array' THEN
    RAISE EXCEPTION 'children must be a JSON array';
  END IF;
  IF jsonb_array_length(p_children) > 100 THEN
    RETURN QUERY VALUES (
      'limit_exceeded'::text, NULL::jsonb, NULL::jsonb, NULL::integer, NULL::integer
    );
    RETURN;
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_children) input(item)
     WHERE jsonb_typeof(item) <> 'object'
       OR jsonb_typeof(item->'name') <> 'string'
       OR item->>'name' = '' OR char_length(item->>'name') > 200
       OR jsonb_typeof(item->'request') <> 'object'
  ) THEN
    RAISE EXCEPTION 'each child requires a valid name and request object';
  END IF;
  IF EXISTS (
    SELECT item->>'name' FROM jsonb_array_elements(p_children) input(item)
     GROUP BY item->>'name' HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'child names must be unique';
  END IF;

  SELECT runtime.* INTO v_runtime
    FROM workhorse.task_runtime runtime
    JOIN workhorse.task task ON task.id = runtime.task_id
   WHERE runtime.task_id = p_parent_task_id
     AND runtime.state = 'active'
     AND runtime.worker_id = p_worker_id
     AND runtime.fence_token = p_fence_token
   FOR UPDATE OF runtime;
  IF FOUND THEN
    SELECT task.result_max_bytes INTO STRICT v_result_limit
      FROM workhorse.task task WHERE task.id = p_parent_task_id;
  END IF;
  v_now := clock_timestamp();
  IF NOT FOUND OR v_runtime.expires_at <= v_now
     OR (v_runtime.deadline_at IS NOT NULL AND v_runtime.deadline_at <= v_now)
     OR (v_runtime.attempt_timeout_at IS NOT NULL AND v_runtime.attempt_timeout_at <= v_now)
     OR v_runtime.cancel_requested_at IS NOT NULL THEN
    RETURN QUERY VALUES (
      'stale'::text, NULL::jsonb, NULL::jsonb, NULL::integer, v_result_limit
    );
    RETURN;
  END IF;

  PERFORM 1 FROM workhorse.task_child edge
   WHERE edge.parent_task_id = p_parent_task_id
   ORDER BY edge.child_name FOR UPDATE;
  SELECT count(*)::integer INTO v_existing_count FROM workhorse.task_child edge
   WHERE edge.parent_task_id = p_parent_task_id;

  IF jsonb_array_length(p_children) = 0 THEN
    IF v_existing_count > 0 THEN
      RETURN QUERY VALUES (
        'conflict'::text, NULL::jsonb, NULL::jsonb, NULL::integer, v_result_limit
      );
    ELSIF 2 > v_result_limit THEN
      RETURN QUERY VALUES (
        'result_too_large'::text, NULL::jsonb, NULL::jsonb, 2, v_result_limit
      );
    ELSE
      RETURN QUERY VALUES ('completed'::text, '[]'::jsonb, '{}'::jsonb, 2, v_result_limit);
    END IF;
    RETURN;
  END IF;

  IF v_existing_count > 0 THEN
    IF v_existing_count <> jsonb_array_length(p_children) OR EXISTS (
      SELECT 1 FROM jsonb_array_elements(p_children) input(item)
      LEFT JOIN workhorse.task_child edge
        ON edge.parent_task_id = p_parent_task_id AND edge.child_name = item->>'name'
      WHERE edge.child_task_id IS NULL OR edge.request_fingerprint <> item->'request'
    ) OR EXISTS (
      SELECT 1 FROM workhorse.task_child edge
       WHERE edge.parent_task_id = p_parent_task_id AND NOT edge.created_as_set
    ) OR EXISTS (
      SELECT 1
        FROM workhorse.task_dependency dependency
        JOIN workhorse.task_child edge
          ON edge.parent_task_id = p_parent_task_id
         AND edge.child_task_id = dependency.prerequisite_task_id
       WHERE dependency.dependent_task_id = p_parent_task_id
         AND (
           dependency.on_success <> 'release'
           OR dependency.on_failure <> CASE WHEN p_mode = 'settled' THEN 'release' ELSE 'fail' END
           OR dependency.on_cancellation <> CASE WHEN p_mode = 'settled' THEN 'release' ELSE 'cancel' END
         )
    ) THEN
      RETURN QUERY VALUES (
        'conflict'::text, NULL::jsonb, NULL::jsonb, NULL::integer, v_result_limit
      );
      RETURN;
    END IF;
    IF EXISTS (
      SELECT 1 FROM workhorse.task_child edge
      LEFT JOIN workhorse.task_outcome outcome ON outcome.task_id = edge.child_task_id
       WHERE edge.parent_task_id = p_parent_task_id
         AND (
           outcome.task_id IS NULL
           OR (p_mode = 'all_success' AND outcome.state <> 'succeeded')
         )
    ) THEN
      RETURN QUERY VALUES (
        'stale'::text, NULL::jsonb, NULL::jsonb, NULL::integer, v_result_limit
      );
      RETURN;
    END IF;

    SELECT jsonb_object_agg(edge.child_name, joined.value),
           jsonb_agg(jsonb_build_object(
             'childTaskId', edge.child_task_id,
             'name', edge.child_name,
             'type', task.task_type,
             'createdAt', edge.created_at,
             'joinedAt', COALESCE(edge.joined_at, v_now),
             CASE WHEN p_mode = 'all_success' THEN 'result' ELSE 'outcome' END,
             joined.value
           ) ORDER BY input.ordinality),
           bool_or(edge.joined_at IS NULL)
      INTO v_results, v_children, v_had_unjoined
      FROM jsonb_array_elements(p_children) WITH ORDINALITY input(item, ordinality)
      JOIN workhorse.task_child edge
        ON edge.parent_task_id = p_parent_task_id AND edge.child_name = input.item->>'name'
      JOIN workhorse.task task ON task.id = edge.child_task_id
      JOIN workhorse.task_outcome outcome ON outcome.task_id = edge.child_task_id
      CROSS JOIN LATERAL (
        SELECT CASE WHEN p_mode = 'all_success' THEN outcome.result ELSE
          CASE outcome.state
            WHEN 'succeeded' THEN jsonb_build_object(
              'status', 'succeeded', 'result', outcome.result
            )
            WHEN 'failed' THEN jsonb_build_object(
              'status', 'failed', 'error', outcome.error
            )
            WHEN 'canceled' THEN jsonb_build_object(
              'status', 'canceled', 'error', outcome.error
            )
          END
        END AS value
      ) joined;
    v_result_bytes := octet_length(v_results::text);
    IF v_result_bytes > v_result_limit THEN
      RETURN QUERY VALUES (
        'result_too_large'::text, NULL::jsonb, NULL::jsonb, v_result_bytes, v_result_limit
      );
      RETURN;
    END IF;
    IF v_had_unjoined THEN
      UPDATE workhorse.task_child edge SET joined_at = v_now
       WHERE edge.parent_task_id = p_parent_task_id AND edge.joined_at IS NULL;
      INSERT INTO workhorse.task_event(task_id, attempt, event_type, details)
        VALUES (
          p_parent_task_id, v_runtime.current_attempt, 'children_joined',
          jsonb_build_object(
            'child_count', v_existing_count,
            'names', (SELECT jsonb_agg(item->>'name' ORDER BY ordinality)
              FROM jsonb_array_elements(p_children) WITH ORDINALITY input(item, ordinality)),
            'fence_token', p_fence_token::text,
            'result_bytes', v_result_bytes
          )
        );
    END IF;
    RETURN QUERY VALUES (
      'completed'::text, v_children, v_results, v_result_bytes, v_result_limit
    );
    RETURN;
  END IF;

  SELECT item->'request'->>'queue' INTO v_fast_queue
    FROM jsonb_array_elements(p_children) WITH ORDINALITY input(item, ordinality)
   WHERE item->'request'->>'queue' = ANY(workhorse.lock_queue_tiers_v1(ARRAY(
           SELECT DISTINCT child->'request'->>'queue'
             FROM jsonb_array_elements(p_children) child
            WHERE COALESCE(child->'request'->>'queue', '') <> '')))
   ORDER BY ordinality
   LIMIT 1;
  IF FOUND THEN
    PERFORM workhorse.reject_fast_feature_v1(v_fast_queue, 'child tasks');
  END IF;

  BEGIN
    FOR v_item IN
      SELECT item, ordinality::integer AS ordinal
        FROM jsonb_array_elements(p_children) WITH ORDINALITY input(item, ordinality)
       ORDER BY ordinality
    LOOP
      SELECT * INTO v_enqueue
        FROM workhorse.enqueue_many_v1(jsonb_build_array(v_item.item->'request'));
      IF v_enqueue.outcome <> 'accepted' THEN
        RAISE EXCEPTION 'child enqueue must create one new task';
      END IF;
      INSERT INTO workhorse.task_child(
        parent_task_id, child_task_id, child_name, request_fingerprint, created_at, created_as_set
      ) VALUES (
        p_parent_task_id, v_enqueue.task_id, v_item.item->>'name', v_item.item->'request', v_now, true
      );
      INSERT INTO workhorse.task_dependency(
        dependent_task_id, prerequisite_task_id, on_success, on_failure, on_cancellation, created_at
      ) VALUES (
        p_parent_task_id, v_enqueue.task_id, 'release',
        CASE WHEN p_mode = 'settled' THEN 'release' ELSE 'fail' END,
        CASE WHEN p_mode = 'settled' THEN 'release' ELSE 'cancel' END,
        v_now
      );
      INSERT INTO workhorse.task_event(task_id, event_type, details)
        VALUES (
          v_enqueue.task_id, 'parent_linked',
          jsonb_build_object('parent_task_id', p_parent_task_id, 'name', v_item.item->>'name')
        );
    END LOOP;

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
      RAISE EXCEPTION USING ERRCODE = 'P1004', MESSAGE = 'child creation lost the parent lease';
    END IF;

    SELECT jsonb_agg(jsonb_build_object(
             'childTaskId', edge.child_task_id,
             'name', edge.child_name,
             'type', task.task_type,
             'createdAt', edge.created_at,
             'joinedAt', edge.joined_at
           ) ORDER BY input.ordinality)
      INTO v_children
      FROM jsonb_array_elements(p_children) WITH ORDINALITY input(item, ordinality)
      JOIN workhorse.task_child edge
        ON edge.parent_task_id = p_parent_task_id AND edge.child_name = input.item->>'name'
      JOIN workhorse.task task ON task.id = edge.child_task_id;
    INSERT INTO workhorse.task_event(task_id, attempt, event_type, details)
      VALUES (
        p_parent_task_id, v_runtime.current_attempt, 'children_created',
        jsonb_build_object(
          'child_count', jsonb_array_length(p_children),
          'names', (SELECT jsonb_agg(item->>'name' ORDER BY ordinality)
            FROM jsonb_array_elements(p_children) WITH ORDINALITY input(item, ordinality)),
          'fence_token', p_fence_token::text
        )
      );
    -- A child whose deadline had already passed reached its outcome inside the enqueue, before
    -- its edge existed. Resolve those edges together now that the parent is blocked.
    PERFORM workhorse.resolve_dependents_many_v1(terminal.task_ids, terminal.states)
       FROM (
         SELECT array_agg(outcome.task_id ORDER BY outcome.task_id) AS task_ids,
                array_agg(outcome.state ORDER BY outcome.task_id) AS states
           FROM workhorse.task_child edge
           JOIN workhorse.task_outcome outcome ON outcome.task_id = edge.child_task_id
          WHERE edge.parent_task_id = p_parent_task_id
       ) terminal
      WHERE terminal.task_ids IS NOT NULL;
    RETURN QUERY VALUES (
      'created'::text, v_children, NULL::jsonb, NULL::integer, v_result_limit
    );
  EXCEPTION
    WHEN SQLSTATE 'P1004' THEN
      RETURN QUERY VALUES (
        'stale'::text, NULL::jsonb, NULL::jsonb, NULL::integer, v_result_limit
      );
  END;
END;
$$;

-- Settle every parent that an earlier child creation left blocked this way. Each stuck edge is a
-- pending parent-to-child edge whose child already holds an outcome and whose parent is blocked.
-- The 0030 backfill counted that edge as pending, so the resolver's decrement keeps the counter
-- consistent and writes the same release or rejection events a timely resolution writes.
DO $$
BEGIN
  PERFORM workhorse.resolve_dependents_many_v1(terminal.task_ids, terminal.states)
     FROM (
       SELECT array_agg(outcome.task_id ORDER BY outcome.task_id) AS task_ids,
              array_agg(outcome.state ORDER BY outcome.task_id) AS states
         FROM workhorse.task_outcome outcome
        WHERE outcome.task_id IN (
          SELECT dependency.prerequisite_task_id
            FROM workhorse.task_dependency dependency
            JOIN workhorse.task_child edge
              ON edge.parent_task_id = dependency.dependent_task_id
             AND edge.child_task_id = dependency.prerequisite_task_id
            JOIN workhorse.task_runtime runtime
              ON runtime.task_id = dependency.dependent_task_id AND runtime.state = 'blocked'
           WHERE dependency.released_at IS NULL
        )
     ) terminal
    WHERE terminal.task_ids IS NOT NULL;
END;
$$;
