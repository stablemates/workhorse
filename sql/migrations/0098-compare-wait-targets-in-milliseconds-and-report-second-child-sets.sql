-- workhorse-migration: {"kind":"additive"}

-- Add three function versions whose answers differ from the released versions, and show a group
-- callback that failed to enqueue in the group snapshot.
--
-- schedule_wait_v2 compares an absolute target at millisecond precision (SM-1945). If the stored
-- target and the sent target are in the same millisecond in UTC, it replays the stored target
-- through schedule_wait_v1. Else it calls schedule_wait_v1 with the target as the SDK sent it, so
-- the first write stores that value. schedule_wait_v1 compared at microsecond precision.
-- TypeScript, Ruby, the JVM, and .NET send milliseconds, and Python, Go, and Rust send
-- microseconds. Thus a replay of the same instant from another SDK answered conflict, and the
-- task failed with no retry. Each SDK keeps the precision that it sends, so a worker of an earlier
-- release that replays a target of its own language through schedule_wait_v1 still matches. A
-- relative wait is not changed.
--
-- send_signal_v2 answers stale, and appends no task_event row, for a terminal task that has no
-- wait of the signal name (SM-1946). send_signal_v1 answered not_waiting, so a sender that tried
-- again had no end condition, and each refused send kept the task out of terminal cleanup. The
-- function reads the task state under the runtime row lock, so a send and a terminal transition
-- that run together give one of the two correct answers.
--
-- create_children_v2 answers limit_exceeded for a second child set in the activation that created
-- or joined the first set, as migration 0054 does for a second single child (SM-1956).
-- create_children_v1 answered conflict, which reports a change of the handler code. Each edge
-- records the fence of the call that created or joined it in last_seen_fence_token. A changed
-- request from another activation still answers conflict.
--
-- get_task_group_v1 adds a failure object to a callback of a finished group that has no callback
-- task. The object holds the code, the message, and the time of the callback_failed event, which
-- lives as long as the group row (SM-1955, ADR 0095). Each released reader reads only taskId from
-- a callback object, so the function keeps its suffix under ADR 0109.
--
-- schedule_wait_v1, send_signal_v1, and create_children_v1 keep their bodies and their answers.
-- Each SDK of this release calls the new versions, so the SDK floor rises to this schema version.
-- The migration adds no column and rewrites no row.

-- Record or replay one named durable timer boundary, as schedule_wait_v1 does, and compare an
-- absolute target at millisecond precision (SM-1945). If the task has an absolute wait of this name
-- whose stored target and p_wake_at are in the same millisecond in UTC, the replay sends the stored
-- target to schedule_wait_v1. Thus an SDK that sends microseconds and an SDK that sends
-- milliseconds get one answer for the same instant. Each other call goes to schedule_wait_v1 as
-- sent, so the first write stores the target as the SDK sent it, and a worker of an earlier release
-- that replays its own value through schedule_wait_v1 still matches. A relative wait is not
-- changed. Before it reads the wait row, the function locks the runtime row of the active lease
-- as schedule_wait_v1 does, so a concurrent first write of the same lease commits first. Then
-- schedule_wait_v1 takes the same lock again in the same transaction, and the lock order does not
-- change.
CREATE OR REPLACE FUNCTION workhorse.schedule_wait_v2(
  p_task_id uuid,
  p_worker_id text,
  p_fence_token bigint,
  p_wait_name text,
  p_duration_ms bigint,
  p_wake_at timestamptz
) RETURNS TABLE (
  status text,
  wait_name text,
  mode text,
  duration_ms bigint,
  requested_wake_at timestamptz,
  wake_at timestamptz,
  attempt integer,
  fence_token bigint,
  worker_id text,
  created_at timestamptz
)
LANGUAGE plpgsql
AS $$
DECLARE
  v_target timestamptz := p_wake_at;
  v_stored timestamptz;
BEGIN
  IF p_wake_at IS NOT NULL AND isfinite(p_wake_at) THEN
    PERFORM 1 FROM workhorse.task_runtime runtime
     WHERE runtime.task_id = p_task_id
       AND runtime.state = 'active'
       AND runtime.worker_id = p_worker_id
       AND runtime.fence_token = p_fence_token
       FOR UPDATE;
    SELECT stored.requested_wake_at INTO v_stored
      FROM workhorse.task_wait stored
     WHERE stored.task_id = p_task_id
       AND stored.wait_name = p_wait_name
       AND stored.mode = 'absolute';
    -- A truncation in UTC keeps a time before 1970 at the earlier millisecond, as the protocol
    -- text form of a timestamp does.
    IF FOUND AND date_trunc('milliseconds', v_stored, 'UTC')
                 = date_trunc('milliseconds', p_wake_at, 'UTC') THEN
      v_target := v_stored;
    END IF;
  END IF;
  RETURN QUERY
    SELECT replay.status, replay.wait_name, replay.mode, replay.duration_ms,
           replay.requested_wake_at, replay.wake_at, replay.attempt, replay.fence_token,
           replay.worker_id, replay.created_at
      FROM workhorse.schedule_wait_v1(
        p_task_id, p_worker_id, p_fence_token, p_wait_name, p_duration_ms, v_target
      ) replay;
END;
$$;

-- Deliver one bounded signal, as send_signal_v1 does, and answer stale for a terminal task that has
-- no wait of that name (SM-1946). A terminal task can never declare the wait, so the send writes no
-- event. The task state is read under the runtime row lock, the lock that each transition of the
-- task takes. If a terminal transition holds it, the send waits, then reads the committed outcome.
-- A live task that has not reached the wait still answers not_waiting.
CREATE OR REPLACE FUNCTION workhorse.send_signal_v2(
  p_task_id uuid,
  p_signal_name text,
  p_payload jsonb,
  p_idempotency_key text,
  p_requested_by text
) RETURNS TABLE (
  status text,
  payload jsonb,
  delivered_at timestamptz,
  delivered_by text
)
LANGUAGE plpgsql
AS $$
DECLARE
  v_wait workhorse.task_signal_wait%ROWTYPE;
  v_runtime workhorse.task_runtime%ROWTYPE;
  v_key_hash bytea;
  v_key_digest text;
  v_fingerprint jsonb;
  v_now timestamptz;
  v_reason text;
BEGIN
  IF p_signal_name IS NULL OR p_signal_name = '' OR char_length(p_signal_name) > 200 THEN
    RAISE EXCEPTION 'signal_name must contain between 1 and 200 characters';
  END IF;
  IF p_signal_name <> btrim(p_signal_name) THEN
    RAISE EXCEPTION 'signal_name must not have leading or trailing whitespace';
  END IF;
  IF p_payload IS NULL THEN
    RAISE EXCEPTION 'signal payload must be JSON, including JSON null when appropriate';
  END IF;
  IF octet_length(p_payload::text) > 65536 THEN
    RAISE EXCEPTION 'signal payload must be at most 65536 bytes';
  END IF;
  IF p_idempotency_key IS NULL OR octet_length(p_idempotency_key) NOT BETWEEN 1 AND 512 THEN
    RAISE EXCEPTION 'signal idempotency key must contain between 1 and 512 UTF-8 bytes';
  END IF;
  IF p_requested_by IS NULL OR p_requested_by = '' OR char_length(p_requested_by) > 200 THEN
    RAISE EXCEPTION 'signal requested_by must contain between 1 and 200 characters';
  END IF;

  v_key_hash := workhorse.idempotency_key_hash_v1(
    'signal:' || p_task_id::text || ':' || p_signal_name, p_idempotency_key
  );
  v_key_digest := left(encode(v_key_hash, 'hex'), 12);
  v_fingerprint := jsonb_build_object('payload', p_payload, 'requestedBy', p_requested_by);
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'workhorse:signal:' || p_task_id::text || ':' || p_signal_name, 0
  ));

  IF NOT EXISTS (SELECT 1 FROM workhorse.task WHERE id = p_task_id) THEN
    RETURN QUERY VALUES ('not_found'::text, NULL::jsonb, NULL::timestamptz, NULL::text);
    RETURN;
  END IF;
  SELECT * INTO v_wait
    FROM workhorse.task_signal_wait stored
   WHERE stored.task_id = p_task_id AND stored.signal_name = p_signal_name
   FOR UPDATE;
  IF NOT FOUND THEN
    -- A terminal transition deletes the runtime row of its tier, so FOR KEY SHARE waits for it.
    -- An update that keeps the row does not need to wait for this lock. If the row is gone, a new
    -- statement reads the outcome that the transition committed. A fast-tier task cannot wait for
    -- a signal, but its terminal outcome gets the same answer.
    PERFORM 1 FROM workhorse.task_runtime runtime
     WHERE runtime.task_id = p_task_id
       FOR KEY SHARE;
    IF NOT FOUND THEN
      PERFORM 1 FROM workhorse.fast_task_runtime runtime
       WHERE runtime.task_id = p_task_id
         FOR KEY SHARE;
    END IF;
    IF NOT FOUND AND (
      EXISTS (SELECT 1 FROM workhorse.task_outcome outcome WHERE outcome.task_id = p_task_id)
      OR EXISTS (SELECT 1 FROM workhorse.fast_task_outcome outcome WHERE outcome.task_id = p_task_id)
    ) THEN
      RETURN QUERY VALUES ('stale'::text, NULL::jsonb, NULL::timestamptz, NULL::text);
      RETURN;
    END IF;
    -- The event can be the first write of the transaction. Take the transaction ID before the
    -- event reads its time, as the cold export frontier needs (ADR 0121).
    PERFORM pg_current_xact_id();
    INSERT INTO workhorse.task_event(task_id, event_type, details)
      VALUES (
        p_task_id, 'signal_rejected',
        jsonb_build_object(
          'name', p_signal_name, 'reason', 'not_waiting', 'requested_by', p_requested_by,
          'idempotency_key_digest', v_key_digest
        )
      );
    RETURN QUERY VALUES ('not_waiting'::text, NULL::jsonb, NULL::timestamptz, NULL::text);
    RETURN;
  END IF;

  IF v_wait.delivered_at IS NOT NULL THEN
    IF v_wait.idempotency_key_hash = v_key_hash THEN
      IF v_wait.request_fingerprint IS DISTINCT FROM v_fingerprint THEN
        v_reason := 'idempotency_conflict';
        status := 'conflict';
      ELSE
        RETURN QUERY VALUES (
          'duplicate'::text, v_wait.payload, v_wait.delivered_at, v_wait.delivered_by
        );
        RETURN;
      END IF;
    ELSE
      v_reason := 'already_delivered';
      status := 'already_delivered';
    END IF;
    INSERT INTO workhorse.task_event(task_id, attempt, event_type, details)
      VALUES (
        p_task_id, v_wait.attempt, 'signal_rejected',
        jsonb_build_object(
          'name', p_signal_name, 'reason', v_reason, 'requested_by', p_requested_by,
          'idempotency_key_digest', v_key_digest
        )
      );
    RETURN QUERY VALUES (status, v_wait.payload, v_wait.delivered_at, v_wait.delivered_by);
    RETURN;
  END IF;

  SELECT * INTO v_runtime
    FROM workhorse.task_runtime runtime
   WHERE runtime.task_id = p_task_id
     AND runtime.state = 'scheduled'
     AND runtime.wait_name = p_signal_name
     AND runtime.current_attempt = v_wait.attempt
   FOR UPDATE;
  v_now := clock_timestamp();
  IF NOT FOUND OR (v_runtime.deadline_at IS NOT NULL AND v_runtime.deadline_at <= v_now) THEN
    INSERT INTO workhorse.task_event(task_id, attempt, event_type, details)
      VALUES (
        p_task_id, v_wait.attempt, 'signal_rejected',
        jsonb_build_object(
          'name', p_signal_name, 'reason', 'stale', 'requested_by', p_requested_by,
          'idempotency_key_digest', v_key_digest
        )
      );
    RETURN QUERY VALUES ('stale'::text, NULL::jsonb, NULL::timestamptz, NULL::text);
    RETURN;
  END IF;

  UPDATE workhorse.task_signal_wait stored
     SET payload = p_payload, idempotency_key_hash = v_key_hash,
         request_fingerprint = v_fingerprint, delivered_by = p_requested_by, delivered_at = v_now
   WHERE stored.task_id = p_task_id AND stored.signal_name = p_signal_name
   RETURNING * INTO v_wait;
  UPDATE workhorse.task_runtime runtime
     SET state = 'ready', run_at = v_now, ready_at = v_now,
         sequence = nextval('workhorse.ready_sequence_seq'), wait_name = NULL,
         deadline_at = (SELECT task.deadline_at FROM workhorse.task task WHERE task.id = p_task_id),
         updated_at = v_now
   WHERE runtime.task_id = p_task_id;
  INSERT INTO workhorse.task_event(task_id, attempt, event_type, details)
    VALUES (
      p_task_id, v_wait.attempt, 'signal_received',
      jsonb_build_object(
        'name', p_signal_name, 'requested_by', p_requested_by,
        'idempotency_key_digest', v_key_digest, 'payload_bytes', octet_length(p_payload::text)
      )
    );
  PERFORM pg_notify('workhorse_tasks', v_runtime.queue_name);
  RETURN QUERY VALUES ('delivered'::text, v_wait.payload, v_wait.delivered_at, v_wait.delivered_by);
END;
$$;

-- Create or join the one child set of a parent, as create_children_v1 does, and answer
-- limit_exceeded for a second set in the activation that created or joined the first set
-- (SM-1956). Migration 0054 gives a second single child the same answer. The fence identifies an
-- activation, so each edge records the fence of the call that created or joined it. A second set
-- names other children than the stored set. A changed request with the stored names is still a
-- replay conflict, also in the same activation, so an SDK can replay it under the stored contract
-- versions.
CREATE OR REPLACE FUNCTION workhorse.create_children_v2(
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
  v_same_activation boolean;
  v_same_names boolean;
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
  SELECT count(*)::integer, COALESCE(bool_or(edge.last_seen_fence_token = p_fence_token), false)
    INTO v_existing_count, v_same_activation
    FROM workhorse.task_child edge
   WHERE edge.parent_task_id = p_parent_task_id;
  v_same_names := v_existing_count = jsonb_array_length(p_children) AND NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_children) input(item)
    LEFT JOIN workhorse.task_child edge
      ON edge.parent_task_id = p_parent_task_id AND edge.child_name = item->>'name'
     WHERE edge.child_task_id IS NULL
  );

  IF jsonb_array_length(p_children) = 0 THEN
    IF v_existing_count > 0 THEN
      RETURN QUERY VALUES (
        CASE WHEN v_same_activation AND NOT v_same_names
          THEN 'limit_exceeded' ELSE 'conflict' END::text,
        NULL::jsonb, NULL::jsonb, NULL::integer, v_result_limit
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
        CASE WHEN v_same_activation AND NOT v_same_names
          THEN 'limit_exceeded' ELSE 'conflict' END::text,
        NULL::jsonb, NULL::jsonb, NULL::integer, v_result_limit
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
    -- Record the join of this activation even if a previous run already joined the set.
    UPDATE workhorse.task_child edge SET last_seen_fence_token = p_fence_token
     WHERE edge.parent_task_id = p_parent_task_id;
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
        parent_task_id, child_task_id, child_name, request_fingerprint, created_at, created_as_set,
        last_seen_fence_token
      ) VALUES (
        p_parent_task_id, v_enqueue.task_id, v_item.item->>'name', v_item.item->'request', v_now, true,
        p_fence_token
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

-- For a group that is not finished, the counts are the sums of its shard rows, read in one
-- statement without a lock. For a finished group, they are the counts on its row. A callback that
-- failed to enqueue at the finish has a failure object with the code, the message, and the time
-- of its callback_failed event.
CREATE OR REPLACE FUNCTION workhorse.get_task_group_v1(p_group_id uuid)
RETURNS TABLE (
  group_id uuid, state text, result text, total integer, succeeded integer, failed integer,
  canceled integer, pending integer, created_at timestamptz, sealed_at timestamptz,
  finished_at timestamptz, canceled_at timestamptz, canceled_by text, cancel_reason text,
  callbacks jsonb
)
LANGUAGE sql
STABLE
AS $$
  SELECT task_group.id, task_group.state, task_group.result, counts.total, counts.succeeded,
         counts.failed, counts.canceled,
         counts.total - counts.succeeded - counts.failed - counts.canceled,
         task_group.created_at, task_group.sealed_at, task_group.finished_at,
         task_group.canceled_at, task_group.canceled_by, task_group.cancel_reason,
         (
           SELECT COALESCE(jsonb_object_agg(requested.kind, jsonb_build_object(
                    'taskId', callback.task_id
                  ) || COALESCE(failure.value, '{}'::jsonb) ORDER BY requested.kind), '{}'::jsonb)
             FROM (VALUES
               ('on_finish', task_group.on_finish),
               ('on_success', task_group.on_success),
               ('on_failure', task_group.on_failure)
             ) requested(kind, request)
             LEFT JOIN workhorse.task_group_callback callback
               ON callback.group_id = task_group.id AND callback.kind = requested.kind
             -- A finished group with no callback row for a kind can have a callback_failed event
             -- for it. The event lives as long as the group row (SM-1955).
             LEFT JOIN LATERAL (
               SELECT jsonb_build_object('failure', jsonb_build_object(
                        'code', event.details->>'code',
                        'message', event.details->>'message',
                        'failedAt', event.occurred_at
                      )) AS value
                 FROM workhorse.task_group_event event
                WHERE task_group.state = 'finished'
                  AND callback.task_id IS NULL
                  AND event.group_id = task_group.id
                  AND event.event_type = 'callback_failed'
                  AND event.details->>'kind' = requested.kind
                ORDER BY event.occurred_at DESC, event.event_id DESC
                LIMIT 1
             ) failure ON true
            WHERE requested.request IS NOT NULL
         )
    FROM workhorse.task_group task_group
    CROSS JOIN LATERAL (
      SELECT COALESCE(sum(shard.total_count), 0)::integer AS total,
             COALESCE(sum(shard.succeeded_count), 0)::integer AS succeeded,
             COALESCE(sum(shard.failed_count), 0)::integer AS failed,
             COALESCE(sum(shard.canceled_count), 0)::integer AS canceled
        FROM workhorse.task_group_shard shard
       WHERE shard.group_id = task_group.id AND task_group.state <> 'finished'
    ) shard_counts
    CROSS JOIN LATERAL (
      SELECT CASE WHEN task_group.state = 'finished' THEN task_group.total_count
               ELSE shard_counts.total END AS total,
             CASE WHEN task_group.state = 'finished' THEN task_group.succeeded_count
               ELSE shard_counts.succeeded END AS succeeded,
             CASE WHEN task_group.state = 'finished' THEN task_group.failed_count
               ELSE shard_counts.failed END AS failed,
             CASE WHEN task_group.state = 'finished' THEN task_group.canceled_count
               ELSE shard_counts.canceled END AS canceled
    ) counts
   WHERE task_group.id = p_group_id;
$$;
