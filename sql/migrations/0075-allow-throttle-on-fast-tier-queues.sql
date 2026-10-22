-- workhorse-migration: {"kind":"additive"}

-- Allow throttle on fast-tier queues (SM-928, ADR 0077).

-- enqueue_throttle_v1 and enqueue_many_v1 rejected throttle on a fast-tier queue with P1007. No
-- step of throttle needs the full tier. It converts the window into an idempotency retention, and
-- enqueue_batch_v1 settles idempotency on both tiers before any runtime row exists.
--
-- Both functions now accept throttle on a fast-tier queue. They keep their tier locks, so a tier
-- change cannot interleave with a throttled enqueue. enqueue_many_v1 still locks the tiers of every
-- debounce and throttle queue in name order before its first member runs. enqueue_many_v1 still rejects debounce on a
-- fast-tier queue with its ordinal, because debounce changes the pending task_runtime row.
--
-- A coalesced request appends a throttled event only for a full-tier task. A fast-tier task writes
-- no throttled event, because ADR 0077 limits fast-tier history to attempts and claims. The
-- retained task decides, not the queue of the request, because one scoped key can name a task on
-- another queue.
--
-- enqueue_many_v1 runs a batch with a debounce or throttle member one member at a time. A P1007
-- from such a member, for example a concurrency key on a fast-tier throttle member, now reports
-- the ordinal of the member in the batch, as a P1001 already does. Before, it reported ordinal 1.
--
-- The signatures and the outcomes do not change. No change touches stored data.

CREATE OR REPLACE FUNCTION workhorse.enqueue_throttle_v1(p_request jsonb)
RETURNS TABLE (task_id uuid, outcome text)
LANGUAGE plpgsql
AS $$
DECLARE
  v_now timestamptz;
  v_throttle jsonb := p_request->'throttle';
  v_key text;
  v_scope text;
  v_key_hash bytea;
  v_key_digest text;
  v_key_length integer;
  v_window_ms numeric;
  v_expires_at timestamptz;
  v_existing record;
  v_normalized jsonb;
  v_row record;
BEGIN
  -- Throttle works on both tiers. The tier lock comes before the key lock, as in every enqueue.
  PERFORM workhorse.lock_queue_tiers_v1(ARRAY[p_request->>'queue']);
  IF p_request IS NULL OR jsonb_typeof(p_request) <> 'object'
     OR v_throttle IS NULL OR jsonb_typeof(v_throttle) <> 'object'
     OR v_throttle - ARRAY['key', 'scope', 'windowMs'] <> '{}'::jsonb
     OR NOT (v_throttle ?& ARRAY['key', 'windowMs'])
     OR jsonb_typeof(v_throttle->'key') <> 'string'
     OR (v_throttle ? 'scope' AND jsonb_typeof(v_throttle->'scope') <> 'string')
     OR jsonb_typeof(v_throttle->'windowMs') <> 'number' THEN
    RAISE EXCEPTION 'throttle requires key, windowMs, and only an optional scope';
  END IF;
  IF p_request ? 'idempotency' OR p_request ? 'debounce' THEN
    RAISE EXCEPTION 'enqueue requests cannot combine idempotency, debounce, or throttle';
  END IF;
  IF COALESCE(p_request->'prerequisiteTaskId', 'null'::jsonb) <> 'null'::jsonb
     OR COALESCE(p_request->'dependencies', 'null'::jsonb) <> 'null'::jsonb THEN
    RAISE EXCEPTION
      'enqueue requests cannot combine debounce or throttle with prerequisiteTaskId or dependencies';
  END IF;

  v_key := v_throttle->>'key';
  v_scope := COALESCE(v_throttle->>'scope', 'default');
  v_window_ms := (v_throttle->>'windowMs')::numeric;
  IF v_key = '' OR octet_length(v_key) > 512 THEN
    RAISE EXCEPTION 'throttle key must contain between 1 and 512 UTF-8 bytes';
  END IF;
  IF v_scope = '' OR octet_length(v_scope) > 256 THEN
    RAISE EXCEPTION 'throttle scope must contain between 1 and 256 UTF-8 bytes';
  END IF;
  IF v_window_ms <> trunc(v_window_ms) OR v_window_ms NOT BETWEEN 1 AND 31536000000 THEN
    RAISE EXCEPTION 'throttle windowMs must be an integer between 1 and 31536000000';
  END IF;

  v_key_hash := workhorse.idempotency_key_hash_v1(v_scope, v_key);
  v_key_digest := left(encode(v_key_hash, 'hex'), 12);
  v_key_length := char_length(v_key);
  PERFORM pg_advisory_xact_lock(hashtextextended(v_scope || chr(31) || v_key, 0));
  v_now := clock_timestamp();
  SELECT identity.task_id, identity.expires_at, identity.coalescing_mode
    INTO v_existing
    FROM workhorse.enqueue_idempotency identity
   WHERE identity.idempotency_scope = v_scope
     AND identity.idempotency_key_hash = v_key_hash
   FOR UPDATE OF identity;
  IF FOUND AND v_existing.expires_at > v_now
     AND v_existing.coalescing_mode <> 'throttle' THEN
    RAISE EXCEPTION 'throttle key is retained for incompatible coalescing mode';
  END IF;

  v_normalized := (p_request - 'throttle') || jsonb_build_object(
    'idempotency', jsonb_build_object('key', v_key, 'scope', v_scope, 'ttlMs', v_window_ms)
  );
  SELECT * INTO v_row FROM workhorse.enqueue_batch_v1(jsonb_build_array(v_normalized));
  IF v_row.accepted THEN
    UPDATE workhorse.enqueue_idempotency SET coalescing_mode = 'throttle'
    WHERE idempotency_scope = v_scope AND idempotency_key_hash = v_key_hash;
  END IF;
  SELECT expires_at INTO v_expires_at
    FROM workhorse.enqueue_idempotency
   WHERE idempotency_scope = v_scope AND idempotency_key_hash = v_key_hash;
  IF v_row.accepted THEN
    UPDATE workhorse.task_event event SET details = event.details || jsonb_build_object(
      'throttle', jsonb_build_object(
        'scope', v_scope, 'key_digest', v_key_digest, 'key_length', v_key_length,
        'window_ms', v_window_ms, 'expires_at', v_expires_at
      )
    ) WHERE event.task_id = v_row.task_id AND event.event_type = 'enqueued';
  -- A fast-tier task writes no throttled event (ADR 0077). The retained task decides, because one
  -- scoped key can name a task on another queue. Exactly one fast row exists for a fast-tier task.
  ELSIF NOT EXISTS (
          SELECT 1 FROM workhorse.fast_task_runtime runtime WHERE runtime.task_id = v_row.task_id
        )
    AND NOT EXISTS (
          SELECT 1 FROM workhorse.fast_task_outcome outcome WHERE outcome.task_id = v_row.task_id
        ) THEN
    INSERT INTO workhorse.task_event(task_id, event_type, details)
    VALUES (v_row.task_id, 'throttled', jsonb_build_object(
      'throttle', jsonb_build_object(
        'scope', v_scope, 'key_digest', v_key_digest, 'key_length', v_key_length,
        'window_ms', v_window_ms, 'expires_at', v_expires_at
      )
    ));
  END IF;
  task_id := v_row.task_id;
  outcome := CASE WHEN v_row.accepted THEN 'accepted' ELSE 'coalesced' END;
  RETURN NEXT;
END;
$$;

CREATE OR REPLACE FUNCTION workhorse.enqueue_many_v1(p_requests jsonb)
RETURNS TABLE (ordinal integer, task_id uuid, outcome text, reason text)
LANGUAGE plpgsql
AS $$
DECLARE
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

  -- Lock the tiers of every debounce and throttle queue in name order before any request runs.
  -- Throttle works on both tiers, but its queues still take their tier locks here.
  v_fast_queues := workhorse.lock_queue_tiers_v1(ARRAY(
    SELECT DISTINCT candidate->>'queue'
      FROM jsonb_array_elements(p_requests) candidate
     WHERE candidate ? 'debounce' OR candidate ? 'throttle'
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
          RAISE EXCEPTION USING
            ERRCODE = 'P1001',
            MESSAGE = v_error_message,
            DETAIL = (v_error_detail::jsonb || jsonb_build_object('ordinal', v_ordinal))::text;
        -- A fast-tier rejection of the member reports the ordinal of the member in the batch.
        WHEN SQLSTATE 'P1007' THEN
          GET STACKED DIAGNOSTICS
            v_error_message = MESSAGE_TEXT,
            v_error_detail = PG_EXCEPTION_DETAIL;
          RAISE EXCEPTION USING
            ERRCODE = 'P1007',
            MESSAGE = v_error_message,
            DETAIL = (v_error_detail::jsonb || jsonb_build_object('ordinal', v_ordinal))::text;
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
          RAISE EXCEPTION USING
            ERRCODE = 'P1001',
            MESSAGE = v_error_message,
            DETAIL = (v_error_detail::jsonb || jsonb_build_object('ordinal', v_ordinal))::text;
        -- A fast-tier rejection of the member reports the ordinal of the member in the batch.
        WHEN SQLSTATE 'P1007' THEN
          GET STACKED DIAGNOSTICS
            v_error_message = MESSAGE_TEXT,
            v_error_detail = PG_EXCEPTION_DETAIL;
          RAISE EXCEPTION USING
            ERRCODE = 'P1007',
            MESSAGE = v_error_message,
            DETAIL = (v_error_detail::jsonb || jsonb_build_object('ordinal', v_ordinal))::text;
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
