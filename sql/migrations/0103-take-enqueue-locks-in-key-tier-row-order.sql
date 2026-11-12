-- workhorse-migration: {"kind":"additive"}

-- Take the locks of an enqueue call in one order: keys, then tiers, then rows.
--
-- An enqueue_many_v1 batch could hold a debounce member and a plain member whose prerequisite D is
-- a dependent of the keyed task P of that member. The batch locked the runtime rows of the keyed
-- tasks and the prerequisites in identity order. If D sorted below P, the batch held D and waited
-- for P. A cancel, a purge, or a completion of P that rejects D held P and waited for D. PostgreSQL
-- then ended one transaction with SQLSTATE 40P01 (SM-2004). lock_enqueue_prerequisites_internal_v1
-- now locks each row that is not blocked before each blocked row, in identity order inside each
-- part. A keyed task of the debounce mode is never blocked, so the batch locks it before its
-- dependents, as a resolver does. The keyed tasks of two batches stay in identity order.
--
-- Outside read committed, lock_queue_tiers_v1 creates the queue_control row of a queue, and a
-- second transaction that creates the same row waits for the first. A call could hold a row lock
-- or a key lock and then wait for such a row, while the other transaction held the row and waited
-- for that lock (SM-2006). Outside read committed:
--
-- - cancel_task_group_v1 locked the members and then enqueued a callback, while a purge of the
--   callback queue held the new row and waited for a member. The cancel now locks the tiers of the
--   callback queues before the members.
-- - add_task_group_members_v1 created the row and then waited for a key, while an enqueue held the
--   key and waited for the row. The add now takes the key locks of its requests first.
-- - An enqueue_many_v1 batch with a debounce or throttle member locked the tier of a plain member
--   after the prerequisite rows. It now locks the tier of every member before any row.
--
-- At read committed a tier lock takes no row lock, so these three calls run as before there. This
-- step changes only the bodies of four functions. The signatures and the results do not change.

CREATE OR REPLACE FUNCTION workhorse.lock_enqueue_prerequisites_internal_v1(p_requests jsonb)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  v_prerequisite_task_ids uuid[];
  v_debounced_task_ids uuid[];
  v_lock record;
BEGIN
  v_prerequisite_task_ids := ARRAY(
    SELECT DISTINCT prerequisite.value::uuid
      FROM jsonb_array_elements(p_requests) input(request)
      CROSS JOIN LATERAL (
        SELECT input.request->>'prerequisiteTaskId' AS value
         WHERE jsonb_typeof(input.request->'prerequisiteTaskId') = 'string'
        UNION ALL
        SELECT item.value
          FROM jsonb_array_elements_text(
            CASE WHEN jsonb_typeof(input.request->'dependencies') = 'object'
                  AND jsonb_typeof(input.request->'dependencies'->'prerequisiteTaskIds') = 'array'
              THEN input.request->'dependencies'->'prerequisiteTaskIds' ELSE '[]'::jsonb END
          ) item(value)
      ) prerequisite
     WHERE prerequisite.value ~* '^(\{[0-9a-f]{4}(-?[0-9a-f]{4}){7}\}|[0-9a-f]{4}(-?[0-9a-f]{4}){7})$'
  );
  v_debounced_task_ids := ARRAY(
    SELECT DISTINCT identity.task_id
      FROM jsonb_array_elements(p_requests) input(request)
      JOIN workhorse.enqueue_idempotency identity
        ON identity.idempotency_scope = COALESCE(input.request->'debounce'->>'scope', 'default')
       AND identity.idempotency_key_hash = workhorse.idempotency_key_hash_v1(
             COALESCE(input.request->'debounce'->>'scope', 'default'),
             input.request->'debounce'->>'key'
           )
     WHERE jsonb_typeof(input.request->'debounce') = 'object'
       AND jsonb_typeof(input.request->'debounce'->'key') = 'string'
       AND jsonb_typeof(COALESCE(input.request->'debounce'->'scope', '"default"'::jsonb)) = 'string'
       AND identity.coalescing_mode = 'debounce'
  );
  IF cardinality(v_debounced_task_ids) > 0 THEN
    -- One pass. A row that is not blocked comes before a blocked row, and identity order decides
    -- inside each part. A task that is both a prerequisite and a keyed task takes the stronger lock.
    -- A keyed task is never blocked, so only the other prerequisites read their state. A batch of
    -- debounce members alone thus reads no state. The state is read without a lock, so it only
    -- orders the pass.
    FOR v_lock IN
      SELECT ids.task_id, bool_or(ids.exclusive) AS exclusive,
             bool_or(NOT ids.exclusive AND EXISTS (
               SELECT 1 FROM workhorse.task_runtime runtime
                WHERE runtime.task_id = ids.task_id AND runtime.state = 'blocked'
                  AND NOT ids.task_id = ANY(v_debounced_task_ids)
             )) AS blocked
        FROM (
          SELECT task_id, true AS exclusive FROM unnest(v_debounced_task_ids) task_id
          UNION ALL
          SELECT task_id, false AS exclusive FROM unnest(v_prerequisite_task_ids) task_id
        ) ids
       GROUP BY ids.task_id
       ORDER BY blocked, ids.task_id
    LOOP
      IF v_lock.exclusive THEN
        PERFORM 1 FROM workhorse.task_runtime runtime
         WHERE runtime.task_id = v_lock.task_id FOR UPDATE;
      ELSE
        PERFORM 1 FROM workhorse.task_runtime runtime
         WHERE runtime.task_id = v_lock.task_id FOR KEY SHARE;
      END IF;
    END LOOP;
  ELSIF cardinality(v_prerequisite_task_ids) > 0 THEN
    PERFORM 1 FROM workhorse.task_runtime runtime
     WHERE runtime.task_id = ANY(v_prerequisite_task_ids)
     ORDER BY runtime.task_id FOR KEY SHARE;
  END IF;
  IF cardinality(v_prerequisite_task_ids) > 0 THEN
    PERFORM 1 FROM workhorse.task prerequisite
     WHERE prerequisite.id = ANY(v_prerequisite_task_ids)
     ORDER BY prerequisite.id FOR KEY SHARE;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION workhorse.enqueue_many_v1(p_requests jsonb)
RETURNS TABLE (ordinal integer, task_id uuid, outcome text, reason text)
LANGUAGE plpgsql
AS $$
DECLARE
  v_diagnostic text;
  v_request jsonb;
  v_ordinal integer;
  v_row record;
  v_lock record;
  v_error_message text;
  v_error_detail text;
  v_contract_mismatch jsonb;
  v_fast_queue text;
  v_fast_queues text[];
BEGIN
  IF p_requests IS NULL OR jsonb_typeof(p_requests) <> 'array' THEN
    RAISE EXCEPTION 'requests must be a JSON array';
  END IF;
  IF jsonb_array_length(p_requests) > 1000 THEN
    RAISE EXCEPTION 'enqueue batch exceeds maximum size of 1000';
  END IF;

  SELECT jsonb_build_object(
           'taskTypes', jsonb_agg(mismatch.task_type ORDER BY mismatch.task_type COLLATE "C")
         )
    INTO v_contract_mismatch
    FROM (
      SELECT DISTINCT request->>'type' AS task_type
        FROM jsonb_array_elements(p_requests) input(request)
        JOIN workhorse.contract_policy policy ON policy.task_type = request->>'type'
       WHERE request ? 'contractVersion'
         AND request->>'contractVersion' IS DISTINCT FROM policy.current_version
  ) mismatch;
  IF jsonb_typeof(v_contract_mismatch->'taskTypes') = 'array' THEN
    ordinal := 0;
    task_id := NULL;
    outcome := 'contract_mismatch';
    reason := v_contract_mismatch::text;
    RETURN NEXT;
    RETURN;
  END IF;

  IF EXISTS (
    SELECT 1
      FROM jsonb_array_elements(p_requests) input(request)
     WHERE (request ? 'idempotency')::integer
         + (request ? 'debounce')::integer
         + (request ? 'throttle')::integer > 1
  ) THEN
    RAISE EXCEPTION 'enqueue requests cannot combine idempotency, debounce, or throttle';
  END IF;

  IF EXISTS (
    SELECT keyed.scope, keyed.key
      FROM (
        SELECT COALESCE(request->'idempotency'->>'scope', 'default') AS scope,
               request->'idempotency'->>'key' AS key, 'idempotency' AS mode
          FROM jsonb_array_elements(p_requests) input(request) WHERE request ? 'idempotency'
        UNION ALL
        SELECT COALESCE(request->'debounce'->>'scope', 'default') AS scope,
               request->'debounce'->>'key' AS key, 'debounce' AS mode
          FROM jsonb_array_elements(p_requests) input(request) WHERE request ? 'debounce'
        UNION ALL
        SELECT COALESCE(request->'throttle'->>'scope', 'default') AS scope,
               request->'throttle'->>'key' AS key, 'throttle' AS mode
          FROM jsonb_array_elements(p_requests) input(request) WHERE request ? 'throttle'
      ) keyed
     WHERE keyed.key IS NOT NULL
     GROUP BY keyed.scope, keyed.key
    HAVING count(DISTINCT keyed.mode) > 1
  ) THEN
    RAISE EXCEPTION 'one enqueue batch cannot reuse a scoped key across incompatible coalescing modes';
  END IF;

  FOR v_lock IN
    SELECT ordered.scope, ordered.key
      FROM (
        SELECT DISTINCT keyed.scope COLLATE "C" AS scope, keyed.key COLLATE "C" AS key
          FROM (
        SELECT COALESCE(request->'debounce'->>'scope', 'default') AS scope,
               request->'debounce'->>'key' AS key
          FROM jsonb_array_elements(p_requests) input(request) WHERE request ? 'debounce'
        UNION ALL
        SELECT COALESCE(request->'throttle'->>'scope', 'default') AS scope,
               request->'throttle'->>'key' AS key
          FROM jsonb_array_elements(p_requests) input(request) WHERE request ? 'throttle'
        UNION ALL
        SELECT COALESCE(request->'idempotency'->>'scope', 'default') AS scope,
               request->'idempotency'->>'key' AS key
          FROM jsonb_array_elements(p_requests) input(request) WHERE request ? 'idempotency'
          ) keyed
         WHERE keyed.key IS NOT NULL
      ) ordered
     ORDER BY ordered.scope, ordered.key
  LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended(v_lock.scope || chr(31) || v_lock.key, 0));
  END LOOP;

  IF EXISTS (
    SELECT 1
      FROM jsonb_array_elements(p_requests) input(request)
      JOIN workhorse.enqueue_idempotency identity
        ON identity.idempotency_scope = COALESCE(request->'idempotency'->>'scope', 'default')
       AND identity.idempotency_key_hash = workhorse.idempotency_key_hash_v1(
             COALESCE(request->'idempotency'->>'scope', 'default'),
             request->'idempotency'->>'key'
           )
     WHERE request ? 'idempotency'
       AND jsonb_typeof(request->'idempotency') = 'object'
       AND jsonb_typeof(request->'idempotency'->'key') = 'string'
       AND identity.expires_at > clock_timestamp()
       AND identity.coalescing_mode <> 'idempotency'
  ) THEN
    RAISE EXCEPTION 'idempotency key is retained for incompatible coalescing mode';
  END IF;

  -- Every enqueue call takes its key locks, then its tier locks, then its row locks (SM-2006). A
  -- batch with a debounce or throttle member enqueues member by member after the prerequisite row
  -- locks below. Outside read committed, a tier lock creates the queue_control row of a new queue,
  -- so the batch locks the tier of every member queue here, in name order, before any request
  -- runs. At read committed a tier lock takes no row lock, so the plain members keep their own
  -- tier locks and the call runs as before. A plain batch passes no queue, and enqueue_batch_v1
  -- locks its tiers before its row locks. A queue name that enqueue_batch_v1 rejects is left to
  -- that rejection.
  v_fast_queues := workhorse.lock_queue_tiers_v1(ARRAY(
    SELECT DISTINCT candidate->>'queue'
      FROM jsonb_array_elements(p_requests) candidate
     WHERE candidate ? 'debounce' OR candidate ? 'throttle'
        OR (COALESCE(candidate->>'queue', '') <> ''
            AND octet_length(candidate->>'queue') <= 256
            AND current_setting('transaction_isolation')
                NOT IN ('read committed', 'read uncommitted')
            AND EXISTS (
                  SELECT 1 FROM jsonb_array_elements(p_requests) keyed(request)
                   WHERE keyed.request ? 'debounce' OR keyed.request ? 'throttle'
                ))
  ));
  -- Report a debounce request on a fast-tier queue with its ordinal.
  SELECT input.request->>'queue', input.ordinality::integer
    INTO v_fast_queue, v_ordinal
    FROM jsonb_array_elements(p_requests) WITH ORDINALITY input(request, ordinality)
   WHERE input.request ? 'debounce'
     AND input.request->>'queue' = ANY(v_fast_queues)
   ORDER BY input.ordinality
   LIMIT 1;
  IF FOUND THEN
    PERFORM workhorse.reject_fast_feature_v1(v_fast_queue, 'debounce', v_ordinal);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_requests) input(request)
     WHERE request ? 'debounce' OR request ? 'throttle'
  ) THEN
    RETURN QUERY
      SELECT result.ordinal, result.task_id,
             CASE WHEN result.accepted THEN 'accepted' ELSE 'replayed' END,
             NULL::text
        FROM workhorse.enqueue_batch_v1(p_requests) result ORDER BY result.ordinal;
    RETURN;
  END IF;

  -- A debounce or throttle member makes the batch enqueue member by member. Each plain member
  -- would then lock only its own prerequisites, so lock every member's prerequisites first.
  PERFORM workhorse.lock_enqueue_prerequisites_internal_v1(p_requests);

  FOR v_request, v_ordinal IN
    SELECT request, ordinality::integer
      FROM jsonb_array_elements(p_requests) WITH ORDINALITY input(request, ordinality)
     ORDER BY ordinality
  LOOP
    IF v_request ? 'debounce' THEN
      SELECT * INTO v_row FROM workhorse.enqueue_debounce_v1(v_request);
      ordinal := v_ordinal;
      task_id := v_row.task_id;
      outcome := v_row.outcome;
      reason := CASE WHEN outcome = 'non_replaceable' THEN (
        SELECT event.details->>'reason'
          FROM workhorse.task_event event
         WHERE event.task_id = v_row.task_id
           AND event.event_type = 'debounce_rejected'
         ORDER BY event.occurred_at DESC, event.event_id DESC
         LIMIT 1
      ) ELSE NULL END;
    ELSIF v_request ? 'throttle' THEN
      BEGIN
        SELECT * INTO v_row FROM workhorse.enqueue_throttle_v1(v_request);
      EXCEPTION
        WHEN SQLSTATE 'P1001' THEN
          GET STACKED DIAGNOSTICS
            v_error_message = MESSAGE_TEXT,
            v_error_detail = PG_EXCEPTION_DETAIL;
          v_diagnostic := (v_error_detail::jsonb || jsonb_build_object('ordinal', v_ordinal))::text;
          RAISE EXCEPTION USING
            ERRCODE = 'P1001',
            MESSAGE = v_error_message,
            DETAIL = v_diagnostic,
            HINT = v_diagnostic;
        -- A fast-tier rejection of the member reports the ordinal of the member in the batch.
        WHEN SQLSTATE 'P1007' THEN
          GET STACKED DIAGNOSTICS
            v_error_message = MESSAGE_TEXT,
            v_error_detail = PG_EXCEPTION_DETAIL;
          v_diagnostic := (v_error_detail::jsonb || jsonb_build_object('ordinal', v_ordinal))::text;
          RAISE EXCEPTION USING
            ERRCODE = 'P1007',
            MESSAGE = v_error_message,
            DETAIL = v_diagnostic,
            HINT = v_diagnostic;
      END;
      ordinal := v_ordinal;
      task_id := v_row.task_id;
      outcome := v_row.outcome;
      reason := NULL;
    ELSE
      BEGIN
        SELECT * INTO v_row FROM workhorse.enqueue_batch_v1(jsonb_build_array(v_request));
      EXCEPTION
        WHEN SQLSTATE 'P1001' THEN
          GET STACKED DIAGNOSTICS
            v_error_message = MESSAGE_TEXT,
            v_error_detail = PG_EXCEPTION_DETAIL;
          v_diagnostic := (v_error_detail::jsonb || jsonb_build_object('ordinal', v_ordinal))::text;
          RAISE EXCEPTION USING
            ERRCODE = 'P1001',
            MESSAGE = v_error_message,
            DETAIL = v_diagnostic,
            HINT = v_diagnostic;
        -- A fast-tier rejection of the member reports the ordinal of the member in the batch.
        WHEN SQLSTATE 'P1007' THEN
          GET STACKED DIAGNOSTICS
            v_error_message = MESSAGE_TEXT,
            v_error_detail = PG_EXCEPTION_DETAIL;
          v_diagnostic := (v_error_detail::jsonb || jsonb_build_object('ordinal', v_ordinal))::text;
          RAISE EXCEPTION USING
            ERRCODE = 'P1007',
            MESSAGE = v_error_message,
            DETAIL = v_diagnostic,
            HINT = v_diagnostic;
      END;
      ordinal := v_ordinal;
      task_id := v_row.task_id;
      outcome := CASE WHEN v_row.accepted THEN 'accepted' ELSE 'replayed' END;
      reason := NULL;
    END IF;
    RETURN NEXT;
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION workhorse.add_task_group_members_v1(
  p_group_id uuid,
  p_requests jsonb,
  p_member_task_id uuid DEFAULT NULL,
  p_worker_id text DEFAULT NULL,
  p_fence_token bigint DEFAULT NULL
) RETURNS TABLE (ordinal integer, task_id uuid, outcome text, reason text)
LANGUAGE plpgsql
AS $$
#variable_conflict use_column
DECLARE
  v_diagnostic text;
  v_group workhorse.task_group%ROWTYPE;
  v_member workhorse.task_runtime%ROWTYPE;
  v_lock_task_id uuid;
  v_refusal text;
  v_fast_queue text;
  v_fast_ordinal integer;
  v_row record;
  v_member_group_id uuid;
  v_lock record;
  v_new_task_ids uuid[] := '{}';
  v_total integer;
  v_opened integer;
  v_counted_task_ids uuid[];
  v_counted_states text[];
  v_now timestamptz := clock_timestamp();
BEGIN
  IF p_group_id IS NULL THEN RAISE EXCEPTION 'task group identity is required'; END IF;
  IF p_requests IS NULL OR jsonb_typeof(p_requests) <> 'array' THEN
    RAISE EXCEPTION 'requests must be a JSON array';
  END IF;
  IF jsonb_array_length(p_requests) > 1000 THEN
    RAISE EXCEPTION 'a task group add accepts at most 1000 tasks';
  END IF;
  IF (p_member_task_id IS NULL) <> (p_worker_id IS NULL)
     OR (p_member_task_id IS NULL) <> (p_fence_token IS NULL) THEN
    RAISE EXCEPTION 'a member add requires the member task, worker, and fence token';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_requests) input(request)
     WHERE jsonb_typeof(input.request) = 'object'
       AND (input.request ? 'debounce' OR input.request ? 'throttle')
  ) THEN
    RAISE EXCEPTION 'a task group add cannot use debounce or throttle';
  END IF;

  -- Every enqueue call takes its key locks, then its tier locks, then its row locks (SM-2006).
  -- Outside read committed, lock_queue_tiers_v1 creates and locks the queue_control row of each
  -- queue. An enqueue that holds a key creates that row after the key. Thus the add takes the key
  -- locks that enqueue_many_v1 takes, in the same order, before the tier locks. Otherwise it could
  -- hold the uncommitted row while it waited for a key that the enqueue holds. At read committed a
  -- tier lock takes no row lock, so the add takes its key locks in enqueue_many_v1 as before.
  IF current_setting('transaction_isolation') NOT IN ('read committed', 'read uncommitted') THEN
    FOR v_lock IN
      SELECT ordered.scope, ordered.key
        FROM (
          SELECT DISTINCT
                 COALESCE(input.request->'idempotency'->>'scope', 'default') COLLATE "C" AS scope,
                 (input.request->'idempotency'->>'key') COLLATE "C" AS key
            FROM jsonb_array_elements(p_requests) input(request)
           WHERE jsonb_typeof(input.request) = 'object' AND input.request ? 'idempotency'
        ) ordered
       WHERE ordered.key IS NOT NULL
       ORDER BY ordered.scope, ordered.key
    LOOP
      PERFORM pg_advisory_xact_lock(hashtextextended(v_lock.scope || chr(31) || v_lock.key, 0));
    END LOOP;
  END IF;

  -- A purge creates the row of its queue before it locks the tasks of that queue, so the add
  -- takes the tier locks before any row lock. Otherwise it could hold a prerequisite that the purge
  -- waits for while it waits for the uncommitted row of the purge.
  PERFORM workhorse.lock_queue_tiers_v1(ARRAY(
    SELECT DISTINCT candidate->>'queue' FROM jsonb_array_elements(p_requests) candidate
  ));

  -- Completion, cancellation, and purge lock a runtime row before the shard and group rows. Lock
  -- the prerequisites of the requests first, so an add that names a member as a prerequisite takes
  -- the same order and cannot deadlock with that member's completion. A member add also locks the
  -- member's runtime row in this pass. FOR NO KEY UPDATE conflicts with every update and delete of
  -- the row, and it does not block the key-share lock of an enqueue that names the member as a
  -- prerequisite. The pass locks in identity order, as cancel_task_group_v1 and a resolver do, so
  -- it does not hold the member while it waits for a lower runtime row that a cancel holds.
  IF p_member_task_id IS NOT NULL THEN
    FOR v_lock_task_id IN
      SELECT locked.task_id
        FROM unnest(
          workhorse.enqueue_prerequisite_task_ids_internal_v1(p_requests) || p_member_task_id
        ) locked(task_id)
       GROUP BY locked.task_id
       ORDER BY locked.task_id
    LOOP
      IF v_lock_task_id = p_member_task_id THEN
        SELECT * INTO v_member FROM workhorse.task_runtime runtime
         WHERE runtime.task_id = p_member_task_id FOR NO KEY UPDATE;
      ELSE
        PERFORM 1 FROM workhorse.task_runtime runtime
         WHERE runtime.task_id = v_lock_task_id FOR KEY SHARE;
      END IF;
    END LOOP;
  END IF;
  PERFORM workhorse.lock_enqueue_prerequisites_internal_v1(p_requests);
  PERFORM 1 FROM workhorse.task_group_shard shard
   WHERE shard.group_id = p_group_id
   ORDER BY shard.shard FOR UPDATE;
  SELECT * INTO v_group FROM workhorse.task_group task_group
   WHERE task_group.id = p_group_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'task group % does not exist', p_group_id; END IF;
  v_refusal := CASE
    WHEN v_group.canceled_at IS NOT NULL THEN 'canceled'
    WHEN v_group.state = 'finished' THEN 'finished'
    WHEN p_member_task_id IS NOT NULL AND NOT COALESCE(
      v_member.state = 'active'
        AND v_member.worker_id = p_worker_id
        AND v_member.fence_token = p_fence_token
        AND v_member.expires_at > clock_timestamp()
        AND (v_member.deadline_at IS NULL OR v_member.deadline_at > clock_timestamp())
        AND (v_member.attempt_timeout_at IS NULL
          OR v_member.attempt_timeout_at > clock_timestamp())
        AND v_member.cancel_requested_at IS NULL
        AND EXISTS (
          SELECT 1 FROM workhorse.task_group_member member
           WHERE member.task_id = p_member_task_id AND member.group_id = p_group_id
        ),
      false
    ) THEN 'not_running_member'
    WHEN v_group.state = 'sealed' AND p_member_task_id IS NULL THEN 'sealed'
  END;
  IF v_refusal IS NOT NULL THEN
    v_diagnostic := jsonb_build_object(
      'groupId', p_group_id, 'state', v_group.state, 'reason', v_refusal
    )::text;
    RAISE EXCEPTION USING
      ERRCODE = 'P1008',
      MESSAGE = 'the task group does not accept tasks',
      DETAIL = v_diagnostic,
      HINT = v_diagnostic;
  END IF;

  -- A fast-tier task records no outcome row that a group could count (ADR 0077).
  SELECT input.request->>'queue', input.ordinality::integer
    INTO v_fast_queue, v_fast_ordinal
    FROM jsonb_array_elements(p_requests) WITH ORDINALITY input(request, ordinality)
   WHERE input.request->>'queue' = ANY(workhorse.lock_queue_tiers_v1(ARRAY(
     SELECT DISTINCT candidate->>'queue' FROM jsonb_array_elements(p_requests) candidate
   )))
   ORDER BY input.ordinality
   LIMIT 1;
  IF FOUND THEN
    PERFORM workhorse.reject_fast_feature_v1(v_fast_queue, 'task groups', v_fast_ordinal);
  END IF;

  FOR v_row IN SELECT * FROM workhorse.enqueue_many_v1(p_requests) enqueued
                ORDER BY enqueued.ordinal LOOP
    IF v_row.outcome = 'contract_mismatch' THEN
      -- Nothing was enqueued. The caller refreshes its contracts and calls again.
      ordinal := v_row.ordinal;
      task_id := NULL;
      outcome := v_row.outcome;
      reason := v_row.reason;
      RETURN NEXT;
      RETURN;
    END IF;
    IF v_row.outcome = 'accepted' THEN
      v_new_task_ids := array_append(v_new_task_ids, v_row.task_id);
    ELSIF NOT v_row.task_id = ANY(v_new_task_ids) THEN
      SELECT member.group_id INTO v_member_group_id
        FROM workhorse.task_group_member member WHERE member.task_id = v_row.task_id;
      IF v_member_group_id IS DISTINCT FROM p_group_id THEN
        v_diagnostic := jsonb_build_object(
          'groupId', p_group_id, 'taskId', v_row.task_id, 'ordinal', v_row.ordinal,
          'memberOf', v_member_group_id
        )::text;
        RAISE EXCEPTION USING
          ERRCODE = 'P1010',
          MESSAGE = 'enqueue idempotency returned a task that is not a member of the task group',
          DETAIL = v_diagnostic,
          HINT = v_diagnostic;
      END IF;
    END IF;
    ordinal := v_row.ordinal;
    task_id := v_row.task_id;
    outcome := v_row.outcome;
    reason := v_row.reason;
    RETURN NEXT;
  END LOOP;

  IF cardinality(v_new_task_ids) = 0 THEN RETURN; END IF;
  SELECT COALESCE(sum(shard.total_count), 0)::integer INTO v_total
    FROM workhorse.task_group_shard shard WHERE shard.group_id = p_group_id;
  IF v_total + cardinality(v_new_task_ids) > workhorse.task_group_member_limit_v1() THEN
    v_diagnostic := jsonb_build_object(
      'groupId', p_group_id, 'limit', workhorse.task_group_member_limit_v1(),
      'total', v_total, 'requested', cardinality(v_new_task_ids)
    )::text;
    RAISE EXCEPTION USING
      ERRCODE = 'P1009',
      MESSAGE = 'a task group accepts at most 100000 member tasks',
      DETAIL = v_diagnostic,
      HINT = v_diagnostic;
  END IF;
  INSERT INTO workhorse.task_group_member(task_id, group_id, position, added_at)
  SELECT added.task_id, p_group_id, v_total + added.ordinality::integer, v_now
    FROM unnest(v_new_task_ids) WITH ORDINALITY added(task_id, ordinality);
  -- A member task uses the shard (position - 1) mod shard_count. A shard whose pending count
  -- changes from 0 to more than 0 increases pending_shard_count.
  WITH added AS (
    SELECT ((v_total + slot.ordinality - 1) % v_group.shard_count)::smallint AS shard,
           count(*)::integer AS members
      FROM generate_series(1, cardinality(v_new_task_ids)) slot(ordinality)
     GROUP BY 1
  ), changed AS (
    UPDATE workhorse.task_group_shard shard
       SET total_count = shard.total_count + added.members
      FROM added
     WHERE shard.group_id = p_group_id AND shard.shard = added.shard
    RETURNING shard.total_count - added.members - shard.succeeded_count - shard.failed_count
                - shard.canceled_count AS pending_before
  )
  SELECT count(*) FILTER (WHERE changed.pending_before = 0)::integer INTO v_opened FROM changed;
  UPDATE workhorse.task_group task_group
     SET pending_shard_count = task_group.pending_shard_count + v_opened,
         updated_at = v_now
   WHERE task_group.id = p_group_id;

  -- An enqueue can write an outcome at once, for example for a deadline in the past or a rejected
  -- prerequisite. That outcome came before the membership row, so the trigger did not record it.
  SELECT array_agg(task_outcome.task_id ORDER BY task_outcome.task_id),
         array_agg(task_outcome.state ORDER BY task_outcome.task_id)
    INTO v_counted_task_ids, v_counted_states
    FROM workhorse.task_outcome task_outcome
   WHERE task_outcome.task_id = ANY(v_new_task_ids);
  IF v_counted_task_ids IS NOT NULL THEN
    PERFORM workhorse.count_task_group_outcomes_internal_v1(v_counted_task_ids, v_counted_states);
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION workhorse.cancel_task_group_v1(
  p_group_id uuid,
  p_requested_by text,
  p_reason text,
  p_request_id text
) RETURNS TABLE (
  group_id uuid, state text, result text, total integer, succeeded integer, failed integer,
  canceled integer, pending integer, created_at timestamptz, sealed_at timestamptz,
  finished_at timestamptz, canceled_at timestamptz, canceled_by text, cancel_reason text,
  callbacks jsonb
)
LANGUAGE plpgsql
AS $$
DECLARE
  v_group workhorse.task_group%ROWTYPE;
  v_now timestamptz := clock_timestamp();
  v_request_id_length integer;
  v_request_id_preview text;
  v_task_id uuid;
  v_canceled integer := 0;
BEGIN
  IF p_group_id IS NULL THEN RAISE EXCEPTION 'task group identity is required'; END IF;
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

  -- The cancel can finish the group, and the finish enqueues the callbacks. Every enqueue call
  -- takes its tier locks before its row locks (SM-2006), so the cancel locks the tiers of the
  -- callback queues first. The callbacks of a group never change after its creation, so a read
  -- without a lock finds them. Outside read committed this creates the queue_control row of each
  -- callback queue before the member locks. A purge of that queue creates the same row before it
  -- locks its tasks, so the cancel cannot hold a member that the purge waits for while it waits
  -- for the uncommitted row of the purge. A queue name that the callback enqueue rejects is left
  -- to that rejection, which records a callback_failed event. At read committed a tier lock takes
  -- no row lock, so the cancel takes the tier locks in the callback enqueue as before.
  --
  -- A completion of the last member outside read committed still locks the member before the tier
  -- of a callback queue, so it can deadlock with this cancel. Before, the cancel waited for the
  -- member and failed with SQLSTATE 40001 instead.
  IF current_setting('transaction_isolation') NOT IN ('read committed', 'read uncommitted') THEN
    PERFORM workhorse.lock_queue_tiers_v1(ARRAY(
      SELECT DISTINCT callback.request->>'queue'
        FROM workhorse.task_group task_group
        CROSS JOIN LATERAL (
          VALUES (task_group.on_finish), (task_group.on_success), (task_group.on_failure)
        ) callback(request)
       WHERE task_group.id = p_group_id
         AND task_group.state <> 'finished'
         AND jsonb_typeof(callback.request) = 'object'
         AND COALESCE(callback.request->>'queue', '') <> ''
         AND octet_length(callback.request->>'queue') <= 256
    ));
  END IF;

  PERFORM 1
    FROM workhorse.task_group_member member
    JOIN workhorse.task_runtime runtime ON runtime.task_id = member.task_id
   WHERE member.group_id = p_group_id AND member.outcome IS NULL
   ORDER BY runtime.task_id
   FOR UPDATE OF runtime;
  PERFORM 1 FROM workhorse.task_group_shard shard
   WHERE shard.group_id = p_group_id
   ORDER BY shard.shard FOR UPDATE;
  SELECT * INTO v_group FROM workhorse.task_group task_group
   WHERE task_group.id = p_group_id FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  IF v_group.state = 'finished' THEN
    RETURN QUERY SELECT * FROM workhorse.get_task_group_v1(p_group_id);
    RETURN;
  END IF;

  IF v_group.state = 'open' THEN
    UPDATE workhorse.task_group task_group
       SET state = 'sealed', sealed_at = v_now, updated_at = v_now
     WHERE task_group.id = p_group_id;
    INSERT INTO workhorse.task_group_event(group_id, event_type, details, occurred_at)
    VALUES (p_group_id, 'sealed', jsonb_build_object('total', (
      SELECT COALESCE(sum(shard.total_count), 0)::integer
        FROM workhorse.task_group_shard shard WHERE shard.group_id = p_group_id
    )), v_now);
  END IF;
  IF v_group.canceled_at IS NULL THEN
    UPDATE workhorse.task_group task_group
       SET canceled_at = v_now, canceled_by = p_requested_by, cancel_reason = p_reason,
           updated_at = v_now
     WHERE task_group.id = p_group_id;
  END IF;

  FOR v_task_id IN
    SELECT member.task_id
      FROM workhorse.task_group_member member
     WHERE member.group_id = p_group_id
       AND member.outcome IS NULL
       AND EXISTS (
             SELECT 1 FROM workhorse.task_runtime runtime WHERE runtime.task_id = member.task_id
           )
     ORDER BY member.task_id
  LOOP
    PERFORM workhorse.cancel_v1(v_task_id, p_requested_by, p_reason);
    v_canceled := v_canceled + 1;
    IF v_canceled % 100 = 0 THEN
      PERFORM workhorse.apply_task_group_outcomes_internal_v1(ARRAY[p_group_id]);
    END IF;
  END LOOP;
  PERFORM workhorse.apply_task_group_outcomes_internal_v1(ARRAY[p_group_id]);

  INSERT INTO workhorse.task_group_event(group_id, event_type, details)
  VALUES (p_group_id, 'canceled', jsonb_build_object(
    'requested_by', p_requested_by,
    'request_reason', p_reason,
    'request_id_preview', v_request_id_preview,
    'request_id_digest', left(encode(sha256(convert_to(p_request_id, 'UTF8')), 'hex'), 12),
    'request_id_length', v_request_id_length,
    'members', v_canceled
  ));
  -- An empty group, or a group whose members were all finished, finishes here. Otherwise the last
  -- canceled member finishes it, possibly after its handler acknowledges the cancellation.
  PERFORM workhorse.finish_task_group_internal_v1(p_group_id);
  RETURN QUERY SELECT * FROM workhorse.get_task_group_v1(p_group_id);
END;
$$;
