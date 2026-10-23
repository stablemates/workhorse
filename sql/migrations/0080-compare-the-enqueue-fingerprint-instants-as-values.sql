-- workhorse-migration: {"kind":"additive"}

-- Compare the enqueue fingerprint instants independently of the session time zone (SM-1641).

-- An enqueue idempotency key binds a fingerprint of the request. Before this step, the fingerprint
-- stored runAt and deadline as to_jsonb() text, and that text carries the offset of the session
-- TimeZone. If a caller sent an exact replay from a session with a different TimeZone, the text
-- was different, and enqueue_batch_v1 raised SQLSTATE P1001 for the same instant.
--
-- idempotency_instant_v1 now writes each instant as UTC text with microsecond precision.
-- enqueue_batch_v1 and enqueue_debounce_v1 write the runAt and deadline members in that form.
-- When a stored fingerprint differs from the new one, enqueue_batch_v1 reads the two stored
-- members as timestamptz through canonical_enqueue_fingerprint_v1 and compares the result. A
-- fingerprint stored before this step keeps its own offset in the text, so it reads back to the
-- same instant. A different instant still raises P1001.
--
-- The signatures, the messages, and the outcomes for other requests do not change. No change
-- touches stored data.


-- An enqueue fingerprint stores each instant as UTC text with microsecond precision, so the text
-- does not depend on the session TimeZone. Before schema version 79, a fingerprint stored the
-- to_jsonb() text, which carries the offset of the session that wrote it.
CREATE OR REPLACE FUNCTION workhorse.idempotency_instant_v1(p_value timestamptz)
RETURNS jsonb
LANGUAGE sql
STABLE
PARALLEL SAFE
AS $$
  SELECT CASE
    WHEN p_value IS NULL THEN 'null'::jsonb
    WHEN NOT isfinite(p_value) THEN to_jsonb(p_value::text)
    WHEN extract(year FROM p_value AT TIME ZONE 'UTC') < 1 THEN to_jsonb(
      to_char(p_value AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z BC"')
    )
    ELSE to_jsonb(to_char(p_value AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))
  END;
$$;

-- A stored enqueue fingerprint with its runAt and deadline members in the form of
-- idempotency_instant_v1. The members compare as instants: a fingerprint that an earlier schema
-- stored keeps its own offset in the text, so it reads back to the same instant.
CREATE OR REPLACE FUNCTION workhorse.canonical_enqueue_fingerprint_v1(p_fingerprint jsonb)
RETURNS jsonb
LANGUAGE sql
STABLE
PARALLEL SAFE
AS $$
  SELECT p_fingerprint
    || CASE WHEN jsonb_typeof(p_fingerprint->'runAt') = 'string'
         THEN jsonb_build_object('runAt', workhorse.idempotency_instant_v1(
           (p_fingerprint->>'runAt')::timestamptz
         ))
         ELSE '{}'::jsonb END
    || CASE WHEN jsonb_typeof(p_fingerprint->'deadline') = 'string'
         THEN jsonb_build_object('deadline', workhorse.idempotency_instant_v1(
           (p_fingerprint->>'deadline')::timestamptz
         ))
         ELSE '{}'::jsonb END;
$$;

CREATE OR REPLACE FUNCTION workhorse.enqueue_batch_v1(p_requests jsonb)
RETURNS TABLE (ordinal integer, task_id uuid, accepted boolean)
LANGUAGE plpgsql
AS $$
DECLARE
  v_diagnostic text;
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
  v_stored_fingerprint jsonb;
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

  PERFORM workhorse.lock_enqueue_prerequisites_internal_v1(p_requests);

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
      -- The batch already holds these rows, so locking them again waits for nothing. The lock
      -- still counts the prerequisites that exist, and it covers a spelling of a UUID that the
      -- batch pattern missed.
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
        v_diagnostic := jsonb_build_object(
          'feature', 'dependencies', 'taskId', v_fast_task_id, 'ordinal', v_ordinal
        )::text;
        RAISE EXCEPTION USING
          ERRCODE = 'P1007',
          MESSAGE = format('fast-tier task %s cannot be a prerequisite', v_fast_task_id),
          DETAIL = v_diagnostic,
          HINT = v_diagnostic;
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
          WHEN v_request->>'runAt' IS NULL THEN 'null'::jsonb
          ELSE workhorse.idempotency_instant_v1(v_run_at)
        END,
        'deadline', workhorse.idempotency_instant_v1(v_deadline_at),
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
          -- The timestamp members compare as instants, so the session TimeZone of either request
          -- does not matter.
          v_stored_fingerprint :=
            workhorse.canonical_enqueue_fingerprint_v1(v_existing.request_fingerprint);
          IF v_stored_fingerprint <> v_fingerprint THEN
            SELECT COALESCE(array_agg(field ORDER BY field COLLATE "C"), '{}')
              INTO v_conflicting_fields
              FROM jsonb_object_keys(v_fingerprint) field
             WHERE v_stored_fingerprint->field IS DISTINCT FROM v_fingerprint->field;
            v_diagnostic := jsonb_build_object(
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
            RAISE EXCEPTION USING
              ERRCODE = 'P1001',
              MESSAGE = 'enqueue idempotency conflict with a retained request',
              DETAIL = v_diagnostic,
              HINT = v_diagnostic;
          END IF;
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

CREATE OR REPLACE FUNCTION workhorse.enqueue_debounce_v1(p_request jsonb)
RETURNS TABLE (task_id uuid, outcome text)
LANGUAGE plpgsql
AS $$
DECLARE
  v_now timestamptz := clock_timestamp();
  v_debounce jsonb := p_request->'debounce';
  v_key text;
  v_scope text;
  v_key_hash bytea;
  v_key_preview text;
  v_key_digest text;
  v_key_length integer;
  v_window_ms numeric;
  v_schedule text;
  v_run_at timestamptz;
  v_expires_at timestamptz;
  v_normalized jsonb;
  v_existing record;
  v_runtime workhorse.task_runtime%ROWTYPE;
  v_has_identity boolean;
  v_validation record;
  v_row record;
  v_tags text[];
  v_fingerprint_tags text[];
  v_payload_redact_keys text[];
  v_result_redact_keys text[];
  v_retry_policy jsonb;
  v_fingerprint jsonb;
  v_stored_digest text;
  v_request_digest text;
  v_state text;
  v_sequence bigint;
BEGIN
  IF cardinality(workhorse.lock_queue_tiers_v1(ARRAY[p_request->>'queue'])) > 0 THEN
    PERFORM workhorse.reject_fast_feature_v1(p_request->>'queue', 'debounce');
  END IF;
  IF p_request IS NULL OR jsonb_typeof(p_request) <> 'object'
     OR v_debounce IS NULL OR jsonb_typeof(v_debounce) <> 'object'
     OR v_debounce - ARRAY['key', 'scope', 'windowMs', 'schedule'] <> '{}'::jsonb
     OR NOT (v_debounce ?& ARRAY['key', 'windowMs', 'schedule'])
     OR jsonb_typeof(v_debounce->'key') <> 'string'
     OR (v_debounce ? 'scope' AND jsonb_typeof(v_debounce->'scope') <> 'string')
     OR jsonb_typeof(v_debounce->'windowMs') <> 'number'
     OR jsonb_typeof(v_debounce->'schedule') <> 'string' THEN
    RAISE EXCEPTION 'debounce requires key, windowMs, schedule, and only an optional scope';
  END IF;
  IF p_request ? 'idempotency' THEN
    RAISE EXCEPTION 'enqueue requests cannot combine idempotency and debounce';
  END IF;
  IF p_request ? 'runAt' THEN
    RAISE EXCEPTION 'debounced enqueue uses its PostgreSQL-owned window instead of runAt';
  END IF;
  IF COALESCE(p_request->'prerequisiteTaskId', 'null'::jsonb) <> 'null'::jsonb
     OR COALESCE(p_request->'dependencies', 'null'::jsonb) <> 'null'::jsonb THEN
    RAISE EXCEPTION
      'enqueue requests cannot combine debounce or throttle with prerequisiteTaskId or dependencies';
  END IF;

  v_key := v_debounce->>'key';
  v_scope := COALESCE(v_debounce->>'scope', 'default');
  v_window_ms := (v_debounce->>'windowMs')::numeric;
  v_schedule := v_debounce->>'schedule';
  IF v_key = '' OR octet_length(v_key) > 512 THEN
    RAISE EXCEPTION 'debounce key must contain between 1 and 512 UTF-8 bytes';
  END IF;
  IF v_scope = '' OR octet_length(v_scope) > 256 THEN
    RAISE EXCEPTION 'debounce scope must contain between 1 and 256 UTF-8 bytes';
  END IF;
  IF v_window_ms <> trunc(v_window_ms) OR v_window_ms NOT BETWEEN 1 AND 31536000000 THEN
    RAISE EXCEPTION 'debounce windowMs must be an integer between 1 and 31536000000';
  END IF;
  IF v_schedule NOT IN ('reset', 'preserve') THEN
    RAISE EXCEPTION 'debounce schedule must be reset or preserve';
  END IF;

  v_key_hash := workhorse.idempotency_key_hash_v1(v_scope, v_key);
  v_key_digest := left(encode(v_key_hash, 'hex'), 12);
  v_key_length := char_length(v_key);
  v_key_preview := CASE
    WHEN v_key_length <= 4 THEN repeat('•', v_key_length)
    WHEN v_key_length <= 8 THEN left(v_key, 2) || '…' || right(v_key, 2)
    ELSE left(v_key, 8) || '…' || right(v_key, 4)
  END;
  PERFORM pg_advisory_xact_lock(hashtextextended(v_scope || chr(31) || v_key, 0));

  SELECT identity.task_id, identity.request_fingerprint, identity.expires_at,
         identity.coalescing_mode
    INTO v_existing
    FROM workhorse.enqueue_idempotency identity
   WHERE identity.idempotency_scope = v_scope
     AND identity.idempotency_key_hash = v_key_hash
   FOR UPDATE OF identity;
  v_has_identity := FOUND;
  IF v_has_identity THEN
    SELECT runtime.*
      INTO v_runtime
      FROM workhorse.task_runtime runtime
     WHERE runtime.task_id = v_existing.task_id
     FOR UPDATE;
  END IF;

  IF v_has_identity AND v_existing.expires_at > v_now THEN
    IF v_existing.coalescing_mode <> 'debounce'
       OR v_runtime.state IS NULL
       OR v_runtime.state NOT IN ('ready', 'scheduled')
       OR v_runtime.attempt_started_at IS NOT NULL
       OR v_runtime.wait_name IS NOT NULL
       OR v_runtime.current_attempt > 1 THEN
      INSERT INTO workhorse.task_event(task_id, event_type, details)
      VALUES (v_existing.task_id, 'debounce_rejected', jsonb_build_object(
        'state', COALESCE(v_runtime.state, 'terminal'),
        'reason', CASE WHEN v_existing.coalescing_mode <> 'debounce'
          THEN 'incompatible_key_mode' ELSE 'not_pending' END,
        'debounce', jsonb_build_object(
          'scope', v_scope, 'key_preview', v_key_preview, 'key_digest', v_key_digest,
          'key_length', v_key_length, 'window_ms', v_window_ms, 'schedule', v_schedule
        )
      ));
      task_id := v_existing.task_id;
      outcome := 'non_replaceable';
      RETURN NEXT;
      RETURN;
    END IF;

    v_run_at := CASE WHEN v_schedule = 'reset'
      THEN v_now + v_window_ms * interval '1 millisecond' ELSE v_runtime.run_at END;
    v_expires_at := CASE WHEN v_schedule = 'reset'
      THEN v_now + v_window_ms * interval '1 millisecond' ELSE v_existing.expires_at END;
    v_normalized := (p_request - 'debounce') || jsonb_build_object(
      'runAt', v_run_at,
      'idempotency', jsonb_build_object('key', v_key, 'scope', v_scope, 'ttlMs', v_window_ms)
    );

    BEGIN
      SELECT * INTO v_validation
        FROM workhorse.enqueue_batch_v1(jsonb_build_array(v_normalized));
    EXCEPTION WHEN SQLSTATE 'P1001' THEN
      NULL;
    END;

    v_tags := ARRAY(
      SELECT jsonb_array_elements_text(COALESCE(v_normalized->'tags', '[]'::jsonb))
    );
    v_fingerprint_tags := ARRAY(
      SELECT unique_tags.tag
        FROM (SELECT DISTINCT tag FROM unnest(v_tags) tag) unique_tags
       ORDER BY unique_tags.tag COLLATE "C"
    );
    v_payload_redact_keys := ARRAY(
      SELECT key FROM jsonb_array_elements_text(
        COALESCE(v_normalized->'sensitivePayloadKeys', '[]'::jsonb)
      ) key ORDER BY key COLLATE "C"
    );
    v_result_redact_keys := ARRAY(
      SELECT key FROM jsonb_array_elements_text(
        COALESCE(v_normalized->'sensitiveResultKeys', '[]'::jsonb)
      ) key ORDER BY key COLLATE "C"
    );
    v_retry_policy := workhorse.normalize_retry_policy_v1(v_normalized->'retryPolicy');
    v_fingerprint := jsonb_build_object(
      'queue', v_normalized->>'queue',
      'type', v_normalized->>'type',
      'payload', COALESCE(v_normalized->'payload', 'null'::jsonb),
      'concurrencyKey', to_jsonb(v_normalized->>'concurrencyKey'),
      'contractVersion', to_jsonb(v_normalized->>'contractVersion'),
      'payloadMaxBytes', COALESCE((v_normalized->>'payloadMaxBytes')::numeric, 1048576),
      'resultMaxBytes', COALESCE((v_normalized->>'resultMaxBytes')::numeric, 1048576),
      'sensitivePayloadKeys', to_jsonb(v_payload_redact_keys),
      'sensitiveResultKeys', to_jsonb(v_result_redact_keys),
      'tags', to_jsonb(v_fingerprint_tags),
      'runAt', workhorse.idempotency_instant_v1(v_run_at),
      'deadline', workhorse.idempotency_instant_v1((v_normalized->>'deadline')::timestamptz),
      'executionTimeoutMs', to_jsonb((v_normalized->>'executionTimeoutMs')::numeric),
      'maxAttempts', COALESCE((v_normalized->>'maxAttempts')::integer, 25),
      'retryPolicy', v_retry_policy,
      'priority', COALESCE((v_normalized->>'priority')::integer, 0),
      'ttlMs', v_window_ms
    ) || CASE WHEN v_normalized->>'budget' IS NULL THEN '{}'::jsonb
         ELSE jsonb_build_object('budget', v_normalized->>'budget') END;
    v_stored_digest := workhorse.sha256_hex_v1(v_existing.request_fingerprint::text);
    v_request_digest := workhorse.sha256_hex_v1(v_fingerprint::text);

    UPDATE workhorse.task SET
      queue_name = v_normalized->>'queue',
      task_type = v_normalized->>'type',
      concurrency_key = v_normalized->>'concurrencyKey',
      payload = COALESCE(v_normalized->'payload', 'null'::jsonb),
      contract_version = v_normalized->>'contractVersion',
      payload_max_bytes = COALESCE((v_normalized->>'payloadMaxBytes')::integer, 1048576),
      result_max_bytes = COALESCE((v_normalized->>'resultMaxBytes')::integer, 1048576),
      payload_redact_keys = v_payload_redact_keys,
      result_redact_keys = v_result_redact_keys,
      trace_context = v_normalized->'traceContext',
      tags = v_tags,
      priority = COALESCE((v_normalized->>'priority')::integer, 0),
      max_attempts = COALESCE((v_normalized->>'maxAttempts')::integer, 25),
      retry_policy = v_retry_policy,
      deadline_at = (v_normalized->>'deadline')::timestamptz,
      execution_timeout_ms = (v_normalized->>'executionTimeoutMs')::bigint,
      budget_name = v_normalized->>'budget'
    WHERE id = v_existing.task_id;

    v_state := CASE WHEN v_run_at <= v_now THEN 'ready' ELSE 'scheduled' END;
    v_sequence := CASE
      WHEN v_state = 'ready' AND v_runtime.state = 'ready' THEN v_runtime.sequence
      WHEN v_state = 'ready' THEN nextval('workhorse.ready_sequence_seq')
      ELSE NULL
    END;
    UPDATE workhorse.task_runtime runtime SET
      queue_name = v_normalized->>'queue',
      concurrency_key = v_normalized->>'concurrencyKey',
      budget_name = v_normalized->>'budget',
      priority = COALESCE((v_normalized->>'priority')::integer, 0),
      state = v_state,
      run_at = v_run_at,
      ready_at = CASE WHEN v_state = 'ready'
        THEN COALESCE(v_runtime.ready_at, v_now) ELSE NULL END,
      sequence = v_sequence,
      deadline_at = (v_normalized->>'deadline')::timestamptz,
      updated_at = v_now
    WHERE runtime.task_id = v_existing.task_id;

    UPDATE workhorse.enqueue_idempotency SET
      request_fingerprint = v_fingerprint,
      expires_at = v_expires_at
    WHERE idempotency_scope = v_scope AND idempotency_key_hash = v_key_hash;

    INSERT INTO workhorse.task_event(task_id, event_type, details)
    VALUES (v_existing.task_id, 'debounced', jsonb_build_object(
      'state', v_state, 'run_at', v_run_at,
      'stored_request_digest', v_stored_digest, 'request_digest', v_request_digest,
      'debounce', jsonb_build_object(
        'scope', v_scope, 'key_preview', v_key_preview, 'key_digest', v_key_digest,
        'key_length', v_key_length, 'window_ms', v_window_ms, 'schedule', v_schedule,
        'expires_at', v_expires_at
      )
    ));
    IF (v_normalized->>'deadline')::timestamptz <= v_now THEN
      PERFORM workhorse.terminalize_deadline_v1(v_existing.task_id);
    ELSIF v_state = 'ready' THEN
      PERFORM pg_notify('workhorse_tasks', v_normalized->>'queue');
    END IF;
    task_id := v_existing.task_id;
    outcome := 'replaced';
    RETURN NEXT;
    RETURN;
  END IF;

  IF v_has_identity AND v_existing.expires_at <= v_now
     AND v_runtime.state IN ('ready', 'scheduled') THEN
    INSERT INTO workhorse.task_event(task_id, event_type, details)
    VALUES (v_existing.task_id, 'debounce_rejected', jsonb_build_object(
      'state', v_runtime.state, 'reason', 'window_elapsed_pending',
      'debounce', jsonb_build_object(
        'scope', v_scope, 'key_preview', v_key_preview, 'key_digest', v_key_digest,
        'key_length', v_key_length, 'window_ms', v_window_ms, 'schedule', v_schedule
      )
    ));
    task_id := v_existing.task_id;
    outcome := 'non_replaceable';
    RETURN NEXT;
    RETURN;
  END IF;

  v_run_at := v_now + v_window_ms * interval '1 millisecond';
  v_normalized := (p_request - 'debounce') || jsonb_build_object(
    'runAt', v_run_at,
    'idempotency', jsonb_build_object('key', v_key, 'scope', v_scope, 'ttlMs', v_window_ms)
  );
  SELECT * INTO v_row FROM workhorse.enqueue_batch_v1(jsonb_build_array(v_normalized));
  UPDATE workhorse.enqueue_idempotency SET coalescing_mode = 'debounce', expires_at = v_run_at
   WHERE idempotency_scope = v_scope AND idempotency_key_hash = v_key_hash;
  UPDATE workhorse.task_event event SET details = event.details || jsonb_build_object(
    'debounce', jsonb_build_object(
      'scope', v_scope, 'key_preview', v_key_preview, 'key_digest', v_key_digest,
      'key_length', v_key_length, 'window_ms', v_window_ms, 'schedule', v_schedule,
      'expires_at', v_run_at
    )
  ) || jsonb_build_object(
    'idempotency', jsonb_set(event.details->'idempotency', '{expires_at}', to_jsonb(v_run_at))
  ) WHERE event.task_id = v_row.task_id AND event.event_type = 'enqueued';
  task_id := v_row.task_id;
  outcome := CASE WHEN v_row.accepted THEN 'accepted' ELSE 'replayed' END;
  RETURN NEXT;
END;
$$;
