-- workhorse-migration: {"kind":"additive"}

-- Release dependent tasks through a pending-prerequisite counter (SM-920).

-- A blocked dependent now carries pending_prerequisites, the number of its dependency edges still
-- pending, and dependency_rejected, whether any resolved edge chose fail or cancel. Resolving a
-- prerequisite decrements the counter of each dependent it releases an edge for. A dependent with
-- edges left no longer scans its edges, and a dependent released without a rejection reads none.
-- Edges still record released_at and resolution, so every reader of task_dependency is unchanged.
--
-- workhorse.resolve_dependents_many_v1 keeps its locks, its statement order, and its events. It
-- decrements the counter in the statement after it resolves the edges, releases a dependent at
-- zero in the same write, and reads edges only for a rejected dependent. enqueue_batch_v1 calls it
-- once for every terminal prerequisite in a batch. Enqueue and child creation set the counter
-- when they block a task. The backfill counts the pending edges of every task that is blocked when
-- the step runs.

ALTER TABLE workhorse.task_runtime
  ADD COLUMN IF NOT EXISTS pending_prerequisites integer NOT NULL DEFAULT 0
    CONSTRAINT task_runtime_pending_prerequisites_check CHECK (pending_prerequisites >= 0),
  ADD COLUMN IF NOT EXISTS dependency_rejected boolean NOT NULL DEFAULT false;

UPDATE workhorse.task_runtime runtime
   SET pending_prerequisites = edges.pending, dependency_rejected = edges.rejected
  FROM (
    SELECT dependency.dependent_task_id,
           count(*) FILTER (WHERE dependency.released_at IS NULL)::integer AS pending,
           coalesce(bool_or(dependency.resolution IN ('fail', 'cancel')), false) AS rejected
      FROM workhorse.task_dependency dependency
     GROUP BY dependency.dependent_task_id
  ) edges
 WHERE runtime.task_id = edges.dependent_task_id AND runtime.state = 'blocked';

ALTER TABLE workhorse.task_runtime
  ADD CONSTRAINT task_runtime_dependency_counter_check CHECK (
    state = 'blocked' OR (pending_prerequisites = 0 AND NOT dependency_rejected)
  ) NOT VALID;
ALTER TABLE workhorse.task_runtime VALIDATE CONSTRAINT task_runtime_dependency_counter_check;

-- Resolve every pending edge from a set of prerequisites that reached terminal outcomes in the
-- same statement. The resolver locks the runtime row of every blocked dependent in identity order
-- before it touches any edge. A dependent's own terminal transition also holds its runtime row
-- before it releases the dependent's edges, so the two cannot wait for each other. The lock does
-- not conflict with the key-share lock an enqueue takes on a prerequisite's runtime row. Only the
-- delete of a dependent that fails or is canceled waits for such an enqueue, and that enqueue
-- waits for nothing the resolver holds.
--
-- Each blocked dependent carries `pending_prerequisites`, the number of its edges still pending,
-- and `dependency_rejected`, whether a resolved edge chose `fail` or `cancel`. The resolver
-- subtracts the edges it resolved for a dependent from that counter. A dependent with edges left
-- costs one runtime update and no edge scan. Only a dependent that settles after a rejection reads
-- its edges, to name the prerequisite that decides its outcome. A counter that would fall below
-- zero violates the runtime check instead of releasing a dependent early.
CREATE OR REPLACE FUNCTION workhorse.resolve_dependents_many_v1(
  p_prerequisite_task_ids uuid[], p_prerequisite_states text[]
)
RETURNS integer
LANGUAGE plpgsql
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
  v_terminated integer := 0;
  v_released integer;
  v_deadline_task_ids uuid[];
  v_queue_names text[];
  v_task_id uuid;
  v_queue_name text;
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
  -- the statement that terminates or releases them, so each dependent takes one runtime write.
  WITH counted AS MATERIALIZED (
    SELECT runtime.task_id,
           runtime.pending_prerequisites - resolved.decrement AS remaining,
           runtime.dependency_rejected OR resolved.rejected AS rejected,
           resolved.prerequisite_task_id, resolved.state
      FROM unnest(
        v_resolved_task_ids, v_decrements, v_rejections, v_releasing_prerequisite_task_ids,
        v_releasing_prerequisite_states
      ) resolved(task_id, decrement, rejected, prerequisite_task_id, state)
      JOIN workhorse.task_runtime runtime ON runtime.task_id = resolved.task_id
  ), decremented AS (
    UPDATE workhorse.task_runtime runtime
       SET pending_prerequisites = counted.remaining, dependency_rejected = counted.rejected
      FROM counted
     WHERE runtime.task_id = counted.task_id
       AND counted.remaining <> 0
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

  -- A rejected dependent's fate is the first rejecting resolution in the order fail, cancel, with
  -- ties broken by prerequisite identity. The terminal outcomes are this statement's last write, so
  -- their trigger resolves the next level after this level's evidence exists.
  IF v_rejected_task_ids IS NOT NULL THEN
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
        FROM unnest(v_rejected_task_ids) rejected(task_id)
        CROSS JOIN LATERAL (
          SELECT dependency.resolution, dependency.prerequisite_task_id,
                 outcome.state AS prerequisite_state
            FROM workhorse.task_dependency dependency
            JOIN workhorse.task_outcome outcome
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
           settled.error, v_now, v_now, v_now
      FROM removed
      JOIN settled USING (task_id)
     ORDER BY removed.task_id;
    GET DIAGNOSTICS v_terminated = ROW_COUNT;
    IF v_terminated <> cardinality(v_rejected_task_ids) THEN
      RAISE EXCEPTION 'a rejected dependent has no rejecting edge';
    END IF;
  END IF;
  IF v_released_task_ids IS NULL THEN
    RETURN v_terminated;
  END IF;

  -- Ready dependents take FIFO sequence numbers in identity order.
  WITH releasing AS (
    SELECT settled.task_id, settled.prerequisite_task_id, settled.prerequisite_state
      FROM unnest(
        v_released_task_ids, v_released_prerequisite_task_ids, v_released_prerequisite_states
      ) settled(task_id, prerequisite_task_id, prerequisite_state)
  ), ready AS (
    SELECT ordered.task_id, nextval('workhorse.ready_sequence_seq') AS sequence
      FROM (
        SELECT runtime.task_id
          FROM workhorse.task_runtime runtime
          JOIN releasing USING (task_id)
         WHERE runtime.run_at <= v_now
         ORDER BY runtime.task_id
        OFFSET 0
      ) ordered
  ), released AS (
    UPDATE workhorse.task_runtime runtime
       SET state = CASE WHEN ready.task_id IS NULL THEN 'scheduled' ELSE 'ready' END,
           ready_at = CASE WHEN ready.task_id IS NOT NULL THEN v_now END,
           sequence = ready.sequence,
           pending_prerequisites = 0,
           updated_at = v_now
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
             END
           )
      FROM released
      JOIN releasing USING (task_id)
     ORDER BY released.task_id
  )
  SELECT count(*),
         array_agg(released.task_id ORDER BY released.task_id)
           FILTER (WHERE released.deadline_at <= v_now),
         array_agg(DISTINCT released.queue_name ORDER BY released.queue_name)
           FILTER (
             WHERE released.state = 'ready'
               AND (released.deadline_at IS NULL OR released.deadline_at > v_now)
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

CREATE OR REPLACE FUNCTION workhorse.enqueue_batch_v1(p_requests jsonb)
RETURNS TABLE (ordinal integer, task_id uuid, accepted boolean)
LANGUAGE plpgsql
AS $$
DECLARE
  v_count integer;
  v_now timestamptz := clock_timestamp();
  v_request jsonb;
  v_lock record;
  v_ordinal integer;
  v_queue_name text;
  v_task_type text;
  v_concurrency_key text;
  v_budget_name text;
  v_priority numeric;
  v_payload jsonb;
  v_contract_version text;
  v_payload_max_bytes numeric;
  v_result_max_bytes numeric;
  v_payload_redact_keys text[];
  v_result_redact_keys text[];
  v_trace_context jsonb;
  v_tags text[];
  v_run_at timestamptz;
  v_max_attempts integer;
  v_retry_policy jsonb;
  v_deadline_at timestamptz;
  v_execution_timeout_ms numeric;
  v_dependencies jsonb;
  v_prerequisite_task_ids uuid[];
  v_prerequisite_task_id uuid;
  v_on_success text;
  v_on_failure text;
  v_on_cancellation text;
  v_pending_prerequisites integer;
  v_pending_edges integer;
  v_terminal_prerequisite_id uuid;
  v_terminal_prerequisite_state text;
  v_terminal_action text;
  v_state text;
  v_idempotency jsonb;
  v_key text;
  v_scope text;
  v_key_hash bytea;
  v_key_preview text;
  v_key_digest text;
  v_key_length integer;
  v_ttl_ms numeric;
  v_expires_at timestamptz;
  v_fingerprint jsonb;
  v_fingerprint_tags text[];
  v_request_digest text;
  v_conflicting_fields text[];
  v_proposed_task_id uuid;
  v_existing workhorse.enqueue_idempotency%ROWTYPE;
  v_is_new boolean;
  v_is_keyed boolean;
  v_ready_queues text[] := '{}';
  v_notify_queue text;
  v_fast_queues text[];
  v_is_fast boolean;
  v_fast_feature text;
  v_fast_task workhorse.task;
  v_fast_tasks workhorse.task[] := '{}';
  v_fast_runtime workhorse.fast_task_runtime;
  v_fast_runtimes workhorse.fast_task_runtime[] := '{}';
  v_fast_past_deadline uuid[] := '{}';
  v_fast_task_id uuid;
  v_full_task workhorse.task;
  v_full_tasks workhorse.task[] := '{}';
  v_full_runtime workhorse.task_runtime;
  v_full_runtimes workhorse.task_runtime[] := '{}';
  v_full_enqueued_details jsonb[] := '{}';
  v_full_past_deadline uuid[] := '{}';
  v_edge workhorse.task_dependency;
  v_edges workhorse.task_dependency[] := '{}';
  v_full_task_id uuid;
BEGIN
  IF p_requests IS NULL OR jsonb_typeof(p_requests) <> 'array' THEN
    RAISE EXCEPTION 'requests must be a JSON array';
  END IF;
  v_count := jsonb_array_length(p_requests);
  IF v_count > 1000 THEN
    RAISE EXCEPTION 'enqueue batch exceeds maximum size of 1000';
  END IF;

  -- Validate key identities before locking so malformed requests fail predictably, then acquire every
  -- batch key in one deterministic order. This prevents reverse-order overlapping batches from
  -- deadlocking while still serializing new and retained keys through the transaction boundary.
  FOR v_request IN SELECT value FROM jsonb_array_elements(p_requests)
  LOOP
    v_idempotency := v_request->'idempotency';
    IF v_idempotency IS NULL OR v_idempotency = 'null'::jsonb THEN CONTINUE; END IF;
    IF jsonb_typeof(v_idempotency) <> 'object'
       OR v_idempotency - ARRAY['key', 'scope', 'ttlMs'] <> '{}'::jsonb
       OR NOT (v_idempotency ? 'key')
       OR jsonb_typeof(v_idempotency->'key') <> 'string'
       OR (v_idempotency ? 'scope' AND jsonb_typeof(v_idempotency->'scope') <> 'string')
       OR (v_idempotency ? 'ttlMs' AND jsonb_typeof(v_idempotency->'ttlMs') <> 'number') THEN
      RAISE EXCEPTION 'idempotency requires a string key and only optional string scope and numeric ttlMs';
    END IF;
    v_key := v_idempotency->>'key';
    v_scope := COALESCE(v_idempotency->>'scope', 'default');
    v_ttl_ms := COALESCE((v_idempotency->>'ttlMs')::numeric, 86400000);
    IF v_key = '' OR octet_length(v_key) > 512 THEN
      RAISE EXCEPTION 'idempotency key must contain between 1 and 512 UTF-8 bytes';
    END IF;
    IF v_scope = '' OR octet_length(v_scope) > 256 THEN
      RAISE EXCEPTION 'idempotency scope must contain between 1 and 256 UTF-8 bytes';
    END IF;
    IF v_ttl_ms <> trunc(v_ttl_ms) OR v_ttl_ms NOT BETWEEN 1 AND 31536000000 THEN
      RAISE EXCEPTION 'idempotency ttlMs must be an integer between 1 and 31536000000';
    END IF;
  END LOOP;
  FOR v_lock IN
    SELECT locks.scope, locks.key
      FROM (
        SELECT DISTINCT COALESCE(idempotency->>'scope', 'default') AS scope,
               idempotency->>'key' AS key
          FROM jsonb_array_elements(p_requests) AS input(request)
          CROSS JOIN LATERAL (SELECT request->'idempotency' AS idempotency) parsed
         WHERE idempotency IS NOT NULL AND idempotency <> 'null'::jsonb
      ) locks
     ORDER BY locks.scope COLLATE "C", locks.key COLLATE "C"
  LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended(v_lock.scope || chr(31) || v_lock.key, 0));
  END LOOP;

  -- A queue's tier can change only while it holds no live task. The shared tier lock keeps the
  -- tier read here valid until this batch commits, so set_queue_tier_v1 cannot switch a queue
  -- between that read and the insert of its first task.
  v_fast_queues := workhorse.lock_queue_tiers_v1(ARRAY(
    SELECT DISTINCT request->>'queue'
      FROM jsonb_array_elements(p_requests) input(request)
     WHERE COALESCE(request->>'queue', '') <> ''
  ));

  FOR v_request, v_ordinal IN
    SELECT request, ordinality::integer
      FROM jsonb_array_elements(p_requests) WITH ORDINALITY input(request, ordinality)
     ORDER BY ordinality
  LOOP
    v_queue_name := v_request->>'queue';
    v_task_type := v_request->>'type';
    v_concurrency_key := v_request->>'concurrencyKey';
    v_budget_name := v_request->>'budget';
    v_priority := COALESCE((v_request->>'priority')::numeric, 0);
    v_payload := COALESCE(v_request->'payload', 'null'::jsonb);
    v_contract_version := v_request->>'contractVersion';
    v_payload_max_bytes := COALESCE((v_request->>'payloadMaxBytes')::numeric, 1048576);
    v_result_max_bytes := COALESCE((v_request->>'resultMaxBytes')::numeric, 1048576);
    IF v_contract_version IS NOT NULL
       AND char_length(v_contract_version) NOT BETWEEN 1 AND 100 THEN
      RAISE EXCEPTION 'contractVersion must contain 1 to 100 characters';
    END IF;
    IF v_payload_max_bytes <> trunc(v_payload_max_bytes)
       OR v_payload_max_bytes NOT BETWEEN 1 AND 16777216
       OR v_result_max_bytes <> trunc(v_result_max_bytes)
       OR v_result_max_bytes NOT BETWEEN 1 AND 16777216 THEN
      RAISE EXCEPTION 'payloadMaxBytes and resultMaxBytes must be integers between 1 and 16777216';
    END IF;
    IF octet_length(v_payload::text) > v_payload_max_bytes THEN
      RAISE EXCEPTION 'payload exceeds its configured size limit';
    END IF;
    IF jsonb_typeof(COALESCE(v_request->'sensitivePayloadKeys', '[]'::jsonb)) <> 'array'
       OR jsonb_array_length(COALESCE(v_request->'sensitivePayloadKeys', '[]'::jsonb)) > 50
       OR jsonb_typeof(COALESCE(v_request->'sensitiveResultKeys', '[]'::jsonb)) <> 'array'
       OR jsonb_array_length(COALESCE(v_request->'sensitiveResultKeys', '[]'::jsonb)) > 50
       OR EXISTS (
         SELECT 1
           FROM jsonb_array_elements(
             COALESCE(v_request->'sensitivePayloadKeys', '[]'::jsonb) ||
             COALESCE(v_request->'sensitiveResultKeys', '[]'::jsonb)
           ) key
          WHERE jsonb_typeof(key) <> 'string'
             OR char_length(key #>> '{}') NOT BETWEEN 1 AND 200
       ) THEN
      RAISE EXCEPTION 'sensitive payload and result keys must contain at most 50 strings of 1 to 200 characters';
    END IF;
    v_payload_redact_keys := ARRAY(
      SELECT key
        FROM jsonb_array_elements_text(
          COALESCE(v_request->'sensitivePayloadKeys', '[]'::jsonb)
        ) key
       ORDER BY key COLLATE "C"
    );
    v_result_redact_keys := ARRAY(
      SELECT key
        FROM jsonb_array_elements_text(
          COALESCE(v_request->'sensitiveResultKeys', '[]'::jsonb)
        ) key
       ORDER BY key COLLATE "C"
    );
    IF cardinality(v_payload_redact_keys) <> (
         SELECT count(DISTINCT key) FROM unnest(v_payload_redact_keys) key
       ) OR cardinality(v_result_redact_keys) <> (
         SELECT count(DISTINCT key) FROM unnest(v_result_redact_keys) key
       ) THEN
      RAISE EXCEPTION 'sensitive payload and result keys must contain unique values';
    END IF;
    v_trace_context := v_request->'traceContext';
    IF v_concurrency_key IS NOT NULL AND (
      v_concurrency_key = '' OR octet_length(v_concurrency_key) > 256
    ) THEN
      RAISE EXCEPTION 'concurrencyKey must contain between 1 and 256 UTF-8 bytes';
    END IF;
    IF v_budget_name IS NOT NULL AND (
      v_budget_name = '' OR octet_length(v_budget_name) > 256
    ) THEN
      RAISE EXCEPTION 'budget must contain between 1 and 256 UTF-8 bytes';
    END IF;
    IF v_priority <> trunc(v_priority) OR v_priority NOT BETWEEN 0 AND 100 THEN
      RAISE EXCEPTION 'priority must be an integer between 0 and 100';
    END IF;
    IF COALESCE(v_queue_name, '') = '' OR COALESCE(v_task_type, '') = ''
       OR jsonb_typeof(COALESCE(v_request->'tags', '[]'::jsonb)) <> 'array'
       OR jsonb_array_length(COALESCE(v_request->'tags', '[]'::jsonb)) > 20
       OR EXISTS (
         SELECT 1 FROM jsonb_array_elements(COALESCE(v_request->'tags', '[]'::jsonb)) tag
          WHERE jsonb_typeof(tag) <> 'string' OR tag #>> '{}' = ''
             OR char_length(tag #>> '{}') > 100
       ) THEN
      RAISE EXCEPTION 'each request requires non-empty queue/type, maxAttempts between 1 and 100, and at most 20 non-empty tags of at most 100 characters';
    END IF;
    v_tags := ARRAY(
      SELECT jsonb_array_elements_text(COALESCE(v_request->'tags', '[]'::jsonb))
    );
    IF NOT workhorse.valid_trace_context_v1(v_trace_context) THEN
      RAISE EXCEPTION 'traceContext must contain a string traceparent, optional string tracestate, and at most 1024 UTF-8 bytes';
    END IF;
    v_max_attempts := COALESCE((v_request->>'maxAttempts')::integer, 25);
    IF v_max_attempts NOT BETWEEN 1 AND 100 THEN
      RAISE EXCEPTION 'each request requires non-empty queue/type, maxAttempts between 1 and 100, and at most 20 non-empty tags of at most 100 characters';
    END IF;
    v_retry_policy := workhorse.normalize_retry_policy_v1(v_request->'retryPolicy');
    v_run_at := COALESCE((v_request->>'runAt')::timestamptz, v_now);
    IF NOT isfinite(v_run_at) THEN RAISE EXCEPTION 'runAt must be finite'; END IF;
    v_deadline_at := (v_request->>'deadline')::timestamptz;
    IF v_deadline_at IS NOT NULL AND NOT isfinite(v_deadline_at) THEN
      RAISE EXCEPTION 'deadline must be a finite absolute timestamp';
    END IF;
    v_execution_timeout_ms := (v_request->>'executionTimeoutMs')::numeric;
    IF v_execution_timeout_ms IS NOT NULL AND (
      v_execution_timeout_ms <> trunc(v_execution_timeout_ms)
      OR v_execution_timeout_ms NOT BETWEEN 1 AND 31536000000
    ) THEN
      RAISE EXCEPTION 'executionTimeoutMs must be an integer between 1 and 31536000000';
    END IF;
    IF v_request ? 'prerequisiteTaskId'
       AND v_request->'prerequisiteTaskId' <> 'null'::jsonb
       AND jsonb_typeof(v_request->'prerequisiteTaskId') <> 'string' THEN
      RAISE EXCEPTION 'prerequisiteTaskId must be a UUID string or null';
    END IF;
    v_dependencies := v_request->'dependencies';
    IF v_request->>'prerequisiteTaskId' IS NOT NULL
       AND v_dependencies IS NOT NULL AND v_dependencies <> 'null'::jsonb THEN
      RAISE EXCEPTION 'prerequisiteTaskId and dependencies cannot be combined';
    END IF;
    IF v_dependencies IS NOT NULL AND v_dependencies <> 'null'::jsonb THEN
      IF jsonb_typeof(v_dependencies) <> 'object'
         OR v_dependencies - ARRAY['prerequisiteTaskIds', 'onSuccess', 'onFailure', 'onCancellation'] <> '{}'::jsonb
         OR jsonb_typeof(v_dependencies->'prerequisiteTaskIds') <> 'array'
         OR jsonb_array_length(v_dependencies->'prerequisiteTaskIds') NOT BETWEEN 1 AND 100
         OR v_dependencies->>'onSuccess' NOT IN ('release', 'cancel', 'fail')
         OR v_dependencies->>'onFailure' NOT IN ('release', 'cancel', 'fail')
         OR v_dependencies->>'onCancellation' NOT IN ('release', 'cancel', 'fail')
         OR EXISTS (
           SELECT 1 FROM jsonb_array_elements(v_dependencies->'prerequisiteTaskIds') item
            WHERE jsonb_typeof(item) <> 'string'
         ) THEN
        RAISE EXCEPTION 'dependencies requires 1 to 100 UUID strings and release, cancel, or fail outcome policies';
      END IF;
      v_prerequisite_task_ids := ARRAY(
        SELECT value::uuid
          FROM jsonb_array_elements_text(v_dependencies->'prerequisiteTaskIds') value
         ORDER BY value::uuid
      );
      v_on_success := v_dependencies->>'onSuccess';
      v_on_failure := v_dependencies->>'onFailure';
      v_on_cancellation := v_dependencies->>'onCancellation';
    ELSIF v_request->>'prerequisiteTaskId' IS NOT NULL THEN
      v_prerequisite_task_ids := ARRAY[(v_request->>'prerequisiteTaskId')::uuid];
      v_on_success := 'release';
      v_on_failure := 'fail';
      v_on_cancellation := 'cancel';
    ELSE
      v_prerequisite_task_ids := '{}';
      v_on_success := 'release';
      v_on_failure := 'fail';
      v_on_cancellation := 'cancel';
    END IF;
    v_is_fast := v_queue_name = ANY(v_fast_queues);
    IF v_is_fast THEN
      v_fast_feature := CASE
        WHEN v_concurrency_key IS NOT NULL THEN 'concurrency keys'
        WHEN v_budget_name IS NOT NULL THEN 'budgets'
        WHEN v_dependencies IS NOT NULL AND v_dependencies <> 'null'::jsonb THEN 'dependencies'
        WHEN cardinality(v_prerequisite_task_ids) > 0 THEN 'prerequisite tasks'
      END;
      IF v_fast_feature IS NOT NULL THEN
        PERFORM workhorse.reject_fast_feature_v1(v_queue_name, v_fast_feature, v_ordinal);
      END IF;
    END IF;
    v_prerequisite_task_id := CASE
      WHEN v_dependencies IS NULL OR v_dependencies = 'null'::jsonb
        THEN NULLIF(v_request->>'prerequisiteTaskId', '')::uuid
      ELSE NULL
    END;
    -- Most requests carry no prerequisite. The prerequisite lock, the existence check and both
    -- outcome scans answer nothing for an empty set, so a request without prerequisites states
    -- their answers directly and reaches the buffer without touching dependency relations.
    IF cardinality(v_prerequisite_task_ids) > 0 THEN
      IF cardinality(v_prerequisite_task_ids) <> (
        SELECT count(DISTINCT prerequisite_id) FROM unnest(v_prerequisite_task_ids) prerequisite_id
      ) THEN
        RAISE EXCEPTION 'dependency prerequisiteTaskIds must be unique';
      END IF;
      -- Every terminal transition deletes the runtime row before it records the outcome that
      -- resolves dependents. Holding the runtime row makes that transition wait until this edge
      -- commits, so its resolver sees the edge. A transition that committed first has already
      -- deleted the row, and the outcome reads below see its outcome. Key-share locks do not
      -- block the non-key updates that claims and heartbeats make. The runtime rows are locked
      -- before the task rows, in the order completion and purge lock them, so neither side can
      -- hold one row while it waits for the other.
      PERFORM 1 FROM workhorse.task_runtime runtime
       WHERE runtime.task_id = ANY(v_prerequisite_task_ids)
       ORDER BY runtime.task_id FOR KEY SHARE;
      PERFORM 1 FROM workhorse.task prerequisite
       WHERE prerequisite.id = ANY(v_prerequisite_task_ids)
       ORDER BY prerequisite.id FOR KEY SHARE;
      GET DIAGNOSTICS v_pending_prerequisites = ROW_COUNT;
      IF v_pending_prerequisites <> cardinality(v_prerequisite_task_ids) THEN
        RAISE EXCEPTION 'prerequisite task does not exist';
      END IF;
      -- A fast-tier task never resolves dependents when it finishes, so a dependent on it would
      -- stay blocked forever.
      SELECT prerequisite_id INTO v_fast_task_id
        FROM unnest(v_prerequisite_task_ids) prerequisite_id
       WHERE EXISTS (
               SELECT 1 FROM workhorse.fast_task_runtime runtime
                WHERE runtime.task_id = prerequisite_id
             ) OR EXISTS (
               SELECT 1 FROM workhorse.fast_task_outcome outcome
                WHERE outcome.task_id = prerequisite_id
             )
       LIMIT 1;
      IF FOUND THEN
        RAISE EXCEPTION USING
          ERRCODE = 'P1007',
          MESSAGE = format('fast-tier task %s cannot be a prerequisite', v_fast_task_id),
          DETAIL = jsonb_build_object(
            'feature', 'dependencies', 'taskId', v_fast_task_id, 'ordinal', v_ordinal
          )::text;
      END IF;
      -- An edge starts pending unless its prerequisite is terminal and its policy releases. The
      -- dependent's counter starts at that count and falls as the pending edges resolve.
      SELECT count(*) FILTER (WHERE outcome.task_id IS NULL)::integer,
             count(*) FILTER (
               WHERE outcome.task_id IS NULL OR CASE outcome.state
                 WHEN 'succeeded' THEN v_on_success
                 WHEN 'failed' THEN v_on_failure
                 WHEN 'canceled' THEN v_on_cancellation
               END <> 'release'
             )::integer
        INTO v_pending_prerequisites, v_pending_edges
        FROM unnest(v_prerequisite_task_ids) prerequisite_id
        LEFT JOIN workhorse.task_outcome outcome ON outcome.task_id = prerequisite_id;
      SELECT outcome.task_id, outcome.state, action.policy_action
        INTO v_terminal_prerequisite_id, v_terminal_prerequisite_state, v_terminal_action
        FROM workhorse.task_outcome outcome
        CROSS JOIN LATERAL (
          SELECT CASE outcome.state
            WHEN 'succeeded' THEN v_on_success
            WHEN 'failed' THEN v_on_failure
            WHEN 'canceled' THEN v_on_cancellation
            ELSE 'release'
          END AS policy_action
        ) action
       WHERE outcome.task_id = ANY(v_prerequisite_task_ids)
         AND action.policy_action IN ('fail', 'cancel')
       ORDER BY CASE action.policy_action WHEN 'fail' THEN 0 ELSE 1 END, outcome.task_id
       LIMIT 1;
    ELSE
      v_pending_prerequisites := 0;
      v_pending_edges := 0;
      v_terminal_prerequisite_id := NULL;
      v_terminal_prerequisite_state := NULL;
      v_terminal_action := NULL;
    END IF;
    v_state := CASE
      WHEN v_terminal_action IS NOT NULL THEN 'blocked'
      WHEN v_pending_prerequisites > 0 THEN 'blocked'
      WHEN v_run_at <= v_now THEN 'ready'
      ELSE 'scheduled'
    END;
    v_idempotency := v_request->'idempotency';
    v_is_new := true;
    v_is_keyed := false;
    v_key_hash := NULL;
    v_key_preview := NULL;
    v_key_digest := NULL;
    v_key_length := NULL;
    v_expires_at := NULL;
    v_request_digest := NULL;

    IF v_idempotency IS NOT NULL AND v_idempotency <> 'null'::jsonb THEN
      IF jsonb_typeof(v_idempotency) <> 'object'
         OR v_idempotency - ARRAY['key', 'scope', 'ttlMs'] <> '{}'::jsonb
         OR NOT (v_idempotency ? 'key')
         OR jsonb_typeof(v_idempotency->'key') <> 'string'
         OR (v_idempotency ? 'scope' AND jsonb_typeof(v_idempotency->'scope') <> 'string')
         OR (v_idempotency ? 'ttlMs' AND jsonb_typeof(v_idempotency->'ttlMs') <> 'number') THEN
        RAISE EXCEPTION 'idempotency requires a string key and only optional string scope and numeric ttlMs';
      END IF;
      v_is_keyed := true;
      v_key := v_idempotency->>'key';
      v_scope := COALESCE(v_idempotency->>'scope', 'default');
      v_ttl_ms := COALESCE((v_idempotency->>'ttlMs')::numeric, 86400000);
      IF v_key = '' OR octet_length(v_key) > 512 THEN
        RAISE EXCEPTION 'idempotency key must contain between 1 and 512 UTF-8 bytes';
      END IF;
      IF v_scope = '' OR octet_length(v_scope) > 256 THEN
        RAISE EXCEPTION 'idempotency scope must contain between 1 and 256 UTF-8 bytes';
      END IF;
      IF v_ttl_ms <> trunc(v_ttl_ms) OR v_ttl_ms NOT BETWEEN 1 AND 31536000000 THEN
        RAISE EXCEPTION 'idempotency ttlMs must be an integer between 1 and 31536000000';
      END IF;
      v_key_hash := workhorse.idempotency_key_hash_v1(v_scope, v_key);
      v_key_digest := left(encode(v_key_hash, 'hex'), 12);
      v_key_length := char_length(v_key);
      v_key_preview := CASE
        WHEN v_key_length <= 4 THEN repeat('•', v_key_length)
        WHEN v_key_length <= 8 THEN left(v_key, 2) || '…' || right(v_key, 2)
        ELSE left(v_key, 8) || '…' || right(v_key, 4)
      END;
      v_expires_at := v_now + v_ttl_ms * interval '1 millisecond';
      v_fingerprint_tags := ARRAY(
        SELECT unique_tags.tag
          FROM (SELECT DISTINCT tag FROM unnest(v_tags) tag) unique_tags
         ORDER BY unique_tags.tag COLLATE "C"
      );
      v_fingerprint := jsonb_build_object(
        'queue', v_queue_name,
        'type', v_task_type,
        'payload', v_payload,
        'priority', v_priority,
        'concurrencyKey', to_jsonb(v_concurrency_key),
        'contractVersion', to_jsonb(v_contract_version),
        'payloadMaxBytes', v_payload_max_bytes,
        'resultMaxBytes', v_result_max_bytes,
        'sensitivePayloadKeys', to_jsonb(v_payload_redact_keys),
        'sensitiveResultKeys', to_jsonb(v_result_redact_keys),
        'tags', to_jsonb(v_fingerprint_tags),
        'runAt', CASE
          WHEN v_request->>'runAt' IS NULL THEN 'null'::jsonb ELSE to_jsonb(v_run_at)
        END,
        'deadline', to_jsonb(v_deadline_at),
        'executionTimeoutMs', to_jsonb(v_execution_timeout_ms),
        'maxAttempts', v_max_attempts,
        'retryPolicy', v_retry_policy,
        'prerequisiteTaskId', to_jsonb(v_prerequisite_task_id),
        'dependencies', CASE WHEN v_dependencies IS NULL OR v_dependencies = 'null'::jsonb
          THEN 'null'::jsonb ELSE
          jsonb_build_object(
            'prerequisiteTaskIds', to_jsonb(v_prerequisite_task_ids),
            'onSuccess', v_on_success,
            'onFailure', v_on_failure,
            'onCancellation', v_on_cancellation
          ) END,
        'ttlMs', v_ttl_ms
      ) || CASE WHEN v_budget_name IS NULL THEN '{}'::jsonb
           ELSE jsonb_build_object('budget', v_budget_name) END;
      v_request_digest := workhorse.sha256_hex_v1(v_fingerprint::text);

      LOOP
        v_proposed_task_id := gen_random_uuid();
        INSERT INTO workhorse.enqueue_idempotency AS existing(
          idempotency_scope, idempotency_key_hash, request_fingerprint, task_id, expires_at
        ) VALUES (
          v_scope, v_key_hash, v_fingerprint, v_proposed_task_id, v_expires_at
        )
        ON CONFLICT (idempotency_scope, idempotency_key_hash) DO UPDATE
          SET idempotency_key_hash = existing.idempotency_key_hash
        RETURNING existing.* INTO v_existing;

        IF v_existing.task_id = v_proposed_task_id THEN
          task_id := v_proposed_task_id;
          EXIT;
        END IF;
        IF v_existing.expires_at <= v_now THEN
          DELETE FROM workhorse.enqueue_idempotency AS expired
           WHERE expired.idempotency_scope = v_scope
             AND expired.idempotency_key_hash = v_key_hash
             AND expired.task_id = v_existing.task_id AND expired.expires_at <= v_now;
          CONTINUE;
        END IF;
        IF v_existing.request_fingerprint <> v_fingerprint THEN
          SELECT COALESCE(array_agg(field ORDER BY field COLLATE "C"), '{}')
            INTO v_conflicting_fields
            FROM jsonb_object_keys(v_fingerprint) field
           WHERE v_existing.request_fingerprint->field IS DISTINCT FROM v_fingerprint->field;
          RAISE EXCEPTION USING
            ERRCODE = 'P1001',
            MESSAGE = 'enqueue idempotency conflict with a retained request',
            DETAIL = jsonb_build_object(
              'scope', v_scope,
              'keyPreview', v_key_preview,
              'keyDigest', v_key_digest,
              'keyLength', v_key_length,
              'existingTaskId', v_existing.task_id,
              'ordinal', v_ordinal,
              'conflictingFields', to_jsonb(v_conflicting_fields),
              'storedRequestDigest', workhorse.sha256_hex_v1(v_existing.request_fingerprint::text),
              'rejectedRequestDigest', v_request_digest
            )::text;
        END IF;
        task_id := v_existing.task_id;
        v_is_new := false;
        EXIT;
      END LOOP;
    ELSE
      task_id := gen_random_uuid();
    END IF;

    IF v_is_new AND v_is_fast THEN
      -- Fast-tier rows are collected here and written after the loop, one statement per table.
      v_fast_task.id := task_id;
      v_fast_task.queue_name := v_queue_name;
      v_fast_task.task_type := v_task_type;
      v_fast_task.concurrency_key := NULL;
      v_fast_task.payload := v_payload;
      v_fast_task.contract_version := v_contract_version;
      v_fast_task.payload_max_bytes := v_payload_max_bytes::integer;
      v_fast_task.result_max_bytes := v_result_max_bytes::integer;
      v_fast_task.payload_redact_keys := v_payload_redact_keys;
      v_fast_task.result_redact_keys := v_result_redact_keys;
      v_fast_task.trace_context := v_trace_context;
      v_fast_task.tags := v_tags;
      v_fast_task.max_attempts := v_max_attempts;
      v_fast_task.retry_policy := v_retry_policy;
      v_fast_task.deadline_at := v_deadline_at;
      v_fast_task.execution_timeout_ms := v_execution_timeout_ms::bigint;
      v_fast_task.created_at := v_now;
      v_fast_task.priority := v_priority::integer;
      v_fast_task.budget_name := NULL;
      v_fast_tasks := array_append(v_fast_tasks, v_fast_task);

      v_fast_runtime := NULL;
      v_fast_runtime.task_id := task_id;
      v_fast_runtime.queue_name := v_queue_name;
      v_fast_runtime.task_type := v_task_type;
      v_fast_runtime.state := 'ready';
      v_fast_runtime.priority := v_priority::integer;
      v_fast_runtime.run_at := v_run_at;
      v_fast_runtime.sequence := nextval('workhorse.ready_sequence_seq');
      v_fast_runtime.payload := v_payload;
      v_fast_runtime.contract_version := v_contract_version;
      v_fast_runtime.result_max_bytes := v_result_max_bytes::integer;
      v_fast_runtime.redact := cardinality(v_payload_redact_keys) > 0
        OR cardinality(v_result_redact_keys) > 0;
      v_fast_runtime.trace_context := v_trace_context;
      v_fast_runtime.retry_policy := v_retry_policy;
      v_fast_runtime.max_attempts := v_max_attempts;
      v_fast_runtime.attempt := 1;
      v_fast_runtime.fence_token := 0;
      v_fast_runtime.deadline_at := v_deadline_at;
      v_fast_runtime.execution_timeout_ms := v_execution_timeout_ms::bigint;
      v_fast_runtime.errors := '[]'::jsonb;
      v_fast_runtime.errors_dropped := 0;
      v_fast_runtime.enqueued_at := v_now;
      v_fast_runtimes := array_append(v_fast_runtimes, v_fast_runtime);

      IF v_deadline_at IS NOT NULL AND v_deadline_at <= v_now THEN
        v_fast_past_deadline := array_append(v_fast_past_deadline, task_id);
      ELSIF v_run_at <= v_now AND NOT v_queue_name = ANY(v_ready_queues) THEN
        v_ready_queues := array_append(v_ready_queues, v_queue_name);
      END IF;
    ELSIF v_is_new THEN
      -- Full-tier rows are collected here and written after the loop, one statement per table.
      -- A prerequisite exists before this batch starts, because the batch generates every new task
      -- identity, so no check or lock above needs a buffered row.
      v_full_task := NULL;
      v_full_task.id := task_id;
      v_full_task.queue_name := v_queue_name;
      v_full_task.task_type := v_task_type;
      v_full_task.concurrency_key := v_concurrency_key;
      v_full_task.priority := v_priority::integer;
      v_full_task.payload := v_payload;
      v_full_task.contract_version := v_contract_version;
      v_full_task.payload_max_bytes := v_payload_max_bytes::integer;
      v_full_task.result_max_bytes := v_result_max_bytes::integer;
      v_full_task.payload_redact_keys := v_payload_redact_keys;
      v_full_task.result_redact_keys := v_result_redact_keys;
      v_full_task.trace_context := v_trace_context;
      v_full_task.tags := v_tags;
      v_full_task.max_attempts := v_max_attempts;
      v_full_task.retry_policy := v_retry_policy;
      v_full_task.deadline_at := v_deadline_at;
      v_full_task.execution_timeout_ms := v_execution_timeout_ms::bigint;
      v_full_task.budget_name := v_budget_name;
      v_full_tasks := array_append(v_full_tasks, v_full_task);

      v_full_runtime := NULL;
      v_full_runtime.task_id := task_id;
      v_full_runtime.queue_name := v_queue_name;
      v_full_runtime.concurrency_key := v_concurrency_key;
      v_full_runtime.priority := v_priority::integer;
      v_full_runtime.state := v_state;
      v_full_runtime.current_attempt := 1;
      v_full_runtime.run_at := v_run_at;
      v_full_runtime.ready_at := CASE WHEN v_state = 'ready' THEN v_now END;
      v_full_runtime.sequence := CASE WHEN v_state = 'ready'
        THEN nextval('workhorse.ready_sequence_seq') END;
      v_full_runtime.deadline_at := v_deadline_at;
      v_full_runtime.budget_name := v_budget_name;
      v_full_runtime.pending_prerequisites := v_pending_edges;
      v_full_runtime.dependency_rejected := false;
      v_full_runtimes := array_append(v_full_runtimes, v_full_runtime);

      FOREACH v_prerequisite_task_id IN ARRAY v_prerequisite_task_ids LOOP
        v_edge := NULL;
        v_edge.dependent_task_id := task_id;
        v_edge.prerequisite_task_id := v_prerequisite_task_id;
        v_edge.on_success := v_on_success;
        v_edge.on_failure := v_on_failure;
        v_edge.on_cancellation := v_on_cancellation;
        v_edges := array_append(v_edges, v_edge);
      END LOOP;

      v_full_enqueued_details := array_append(v_full_enqueued_details,
        jsonb_build_object(
          'state', v_state,
          'priority', v_priority,
          'run_at', v_run_at,
          'deadline_at', v_deadline_at,
          'execution_timeout_ms', v_execution_timeout_ms
        ) ||
        CASE WHEN v_is_keyed THEN jsonb_build_object(
          'idempotency', jsonb_build_object(
            'scope', v_scope,
            'key_preview', v_key_preview,
            'key_digest', v_key_digest,
            'key_length', v_key_length,
            'ttl_ms', v_ttl_ms,
            'expires_at', v_expires_at,
            'request_digest', v_request_digest
          )
        ) ELSE '{}'::jsonb END
      );
      IF v_deadline_at IS NOT NULL AND v_deadline_at <= v_now THEN
        v_full_past_deadline := array_append(v_full_past_deadline, task_id);
      ELSIF v_state = 'ready' AND NOT v_queue_name = ANY(v_ready_queues) THEN
        v_ready_queues := array_append(v_ready_queues, v_queue_name);
      END IF;
    END IF;
    ordinal := v_ordinal;
    accepted := v_is_new;
    RETURN NEXT;
  END LOOP;

  -- The buffered writes keep each task's evidence in the order the one-row writes produced: its
  -- dependency events, the resolution of any terminal prerequisite, `enqueued`, then an expired
  -- deadline. Omitted columns keep their per-row defaults, so created_at, updated_at and the event
  -- identity advance with each row.
  IF cardinality(v_full_tasks) > 0 THEN
    INSERT INTO workhorse.task(
      id, queue_name, task_type, concurrency_key, priority, payload, contract_version,
      payload_max_bytes, result_max_bytes,
      payload_redact_keys, result_redact_keys, trace_context, tags, max_attempts, retry_policy,
      deadline_at, execution_timeout_ms, budget_name
    )
    SELECT buffered.id, buffered.queue_name, buffered.task_type, buffered.concurrency_key,
           buffered.priority, buffered.payload, buffered.contract_version,
           buffered.payload_max_bytes, buffered.result_max_bytes,
           buffered.payload_redact_keys, buffered.result_redact_keys, buffered.trace_context,
           buffered.tags, buffered.max_attempts, buffered.retry_policy,
           buffered.deadline_at, buffered.execution_timeout_ms, buffered.budget_name
      FROM unnest(v_full_tasks) WITH ORDINALITY buffered
     ORDER BY buffered.ordinality;
    INSERT INTO workhorse.task_runtime(
      task_id, queue_name, concurrency_key, priority, state, current_attempt, run_at, ready_at,
      sequence, deadline_at, budget_name, pending_prerequisites, dependency_rejected
    )
    SELECT buffered.task_id, buffered.queue_name, buffered.concurrency_key, buffered.priority,
           buffered.state, buffered.current_attempt, buffered.run_at, buffered.ready_at,
           buffered.sequence, buffered.deadline_at, buffered.budget_name,
           buffered.pending_prerequisites, buffered.dependency_rejected
      FROM unnest(v_full_runtimes) WITH ORDINALITY buffered
     ORDER BY buffered.ordinality;
    -- A batch without prerequisites has no edge to write and no dependent to resolve. Running the
    -- insert anyway would fire the statement trigger on `task_dependency`, and that trigger walks
    -- the dependency graph recursively for a transition that cannot have occurred.
    IF cardinality(v_edges) > 0 THEN
      WITH edges AS MATERIALIZED (
        SELECT edge.dependent_task_id, edge.prerequisite_task_id, edge.on_success,
               edge.on_failure, edge.on_cancellation, edge.ordinality, outcome.state,
               outcome.state IS NOT NULL AND (
                 (outcome.state = 'succeeded' AND edge.on_success = 'release')
                 OR (outcome.state = 'failed' AND edge.on_failure = 'release')
                 OR (outcome.state = 'canceled' AND edge.on_cancellation = 'release')
               ) AS releases_immediately
          FROM unnest(v_edges) WITH ORDINALITY edge
          LEFT JOIN workhorse.task_outcome outcome
            ON outcome.task_id = edge.prerequisite_task_id
      ), inserted_edges AS (
        INSERT INTO workhorse.task_dependency(
          dependent_task_id, prerequisite_task_id, on_success, on_failure, on_cancellation,
          created_at, released_at, resolution
        )
        SELECT edges.dependent_task_id, edges.prerequisite_task_id,
               edges.on_success, edges.on_failure, edges.on_cancellation, v_now,
               CASE WHEN edges.releases_immediately THEN v_now END,
               CASE WHEN edges.releases_immediately THEN 'release' END
          FROM edges
         ORDER BY edges.ordinality
        RETURNING dependent_task_id, prerequisite_task_id
      )
      INSERT INTO workhorse.task_event(task_id, event_type, details)
      SELECT edges.dependent_task_id,
             CASE WHEN edges.releases_immediately
               THEN 'dependency_released' ELSE 'dependency_blocked' END,
             jsonb_build_object(
               'prerequisite_task_id', edges.prerequisite_task_id,
               'state', runtime.state,
               'reason', CASE
                 WHEN NOT edges.releases_immediately THEN 'prerequisite_pending'
                 WHEN edges.state = 'succeeded' THEN 'prerequisite_already_succeeded'
                 ELSE 'prerequisite_terminal_policy'
               END
             )
        FROM edges
        JOIN inserted_edges USING (dependent_task_id, prerequisite_task_id)
        JOIN unnest(v_full_runtimes) runtime ON runtime.task_id = edges.dependent_task_id
       ORDER BY edges.ordinality;
      -- One resolver call resolves the pending edges to every terminal prerequisite in the batch. A
      -- dependent's fate depends only on the resolutions of its edges, so it matches the fate that
      -- one call per dependent produced.
      PERFORM workhorse.resolve_dependents_many_v1(terminal.task_ids, terminal.states)
         FROM (
           SELECT array_agg(outcome.task_id ORDER BY outcome.task_id) AS task_ids,
                  array_agg(outcome.state ORDER BY outcome.task_id) AS states
             FROM workhorse.task_outcome outcome
            WHERE outcome.task_id IN (
              SELECT edge.prerequisite_task_id FROM unnest(v_edges) edge
            )
         ) terminal
        WHERE terminal.task_ids IS NOT NULL;
    END IF;
    INSERT INTO workhorse.task_event(task_id, event_type, details)
    SELECT buffered.id, 'enqueued', event.details
      FROM unnest(v_full_tasks) WITH ORDINALITY buffered
      JOIN unnest(v_full_enqueued_details) WITH ORDINALITY event(details, ordinality)
        ON event.ordinality = buffered.ordinality
     ORDER BY buffered.ordinality;
    FOREACH v_full_task_id IN ARRAY v_full_past_deadline LOOP
      PERFORM workhorse.terminalize_deadline_v1(v_full_task_id);
    END LOOP;
  END IF;

  IF cardinality(v_fast_tasks) > 0 THEN
    INSERT INTO workhorse.task SELECT * FROM unnest(v_fast_tasks);
    INSERT INTO workhorse.fast_task_runtime SELECT * FROM unnest(v_fast_runtimes);
    FOREACH v_fast_task_id IN ARRAY v_fast_past_deadline LOOP
      PERFORM workhorse.fast_terminalize_deadline_v1(v_fast_task_id);
    END LOOP;
  END IF;

  FOREACH v_notify_queue IN ARRAY v_ready_queues LOOP
    PERFORM pg_notify('workhorse_tasks', v_notify_queue);
  END LOOP;
END;
$$;

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
