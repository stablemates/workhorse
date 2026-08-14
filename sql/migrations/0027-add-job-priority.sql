BEGIN;

SELECT pg_advisory_xact_lock(hashtextextended('workhorse:schema-migration', 0));

DO $migration$
DECLARE
  v_version integer;
  v_version_rows integer;
BEGIN
  SELECT count(*)::integer, min(version) INTO v_version_rows, v_version
    FROM workhorse.schema_version;

  IF v_version_rows <> 1 THEN
    RAISE EXCEPTION 'workhorse.schema_version must contain exactly one row';
  END IF;
  IF v_version NOT IN (26, 27) THEN
    RAISE EXCEPTION 'migration 0027 requires schema version 26, found %', v_version;
  END IF;
END;
$migration$;

ALTER TABLE workhorse.job
  ADD COLUMN IF NOT EXISTS priority integer NOT NULL DEFAULT 0 CHECK (priority BETWEEN 0 AND 100);
ALTER TABLE workhorse.job_runtime
  ADD COLUMN IF NOT EXISTS priority integer NOT NULL DEFAULT 0 CHECK (priority BETWEEN 0 AND 100);
ALTER TABLE workhorse.schedule_definition
  ADD COLUMN IF NOT EXISTS priority integer NOT NULL DEFAULT 0 CHECK (priority BETWEEN 0 AND 100);

DROP INDEX IF EXISTS workhorse.job_runtime_ready_idx;
CREATE INDEX job_runtime_ready_idx
  ON workhorse.job_runtime (queue_name, priority DESC, sequence, job_id) WHERE state = 'ready';

DROP FUNCTION IF EXISTS workhorse.enqueue_v1(
  text, text, jsonb, timestamptz, integer, text[], jsonb, text, integer, integer, text[], text[], text
);
DROP FUNCTION IF EXISTS workhorse.list_dead_letters_v1(jsonb, integer, timestamptz, uuid);
DROP FUNCTION IF EXISTS workhorse.claim_v2(text, text, integer);
DROP FUNCTION IF EXISTS workhorse.list_jobs_v1(jsonb, integer, timestamptz, uuid, text, jsonb);
DROP FUNCTION IF EXISTS workhorse.list_job_timeline_v1(uuid, integer, timestamptz, text, bigint);

CREATE OR REPLACE FUNCTION workhorse.sync_schedule_definitions_v1(
  p_namespace text, p_definitions jsonb, p_prune boolean DEFAULT true
) RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  IF COALESCE(p_namespace, '') = '' THEN RAISE EXCEPTION 'namespace must not be empty'; END IF;
  IF p_definitions IS NULL OR jsonb_typeof(p_definitions) <> 'array' THEN
    RAISE EXCEPTION 'schedule definitions must be a JSON array';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_definitions) definition
     WHERE COALESCE(definition->>'name', '') = ''
        OR COALESCE(definition->>'schedule', '') = ''
        OR COALESCE(definition->>'queue', '') = ''
        OR COALESCE(definition->>'type', '') = ''
        OR COALESCE((definition->>'maxAttempts')::integer, 25) NOT BETWEEN 1 AND 100
        OR COALESCE((definition->>'priority')::numeric, 0) <> trunc(COALESCE((definition->>'priority')::numeric, 0))
        OR COALESCE((definition->>'priority')::numeric, 0) NOT BETWEEN 0 AND 100
        OR (definition->>'concurrencyKey' IS NOT NULL AND (
          definition->>'concurrencyKey' = '' OR octet_length(definition->>'concurrencyKey') > 256
        ))
  ) THEN
    RAISE EXCEPTION 'each schedule requires non-empty name/schedule/queue/type and maxAttempts between 1 and 100';
  END IF;
  PERFORM workhorse.normalize_retry_policy_v1(definition->'retryPolicy')
    FROM jsonb_array_elements(p_definitions) definition WHERE definition ? 'retryPolicy';
  IF (
    SELECT count(*) FROM jsonb_array_elements(p_definitions)
  ) <> (
    SELECT count(DISTINCT definition->>'name') FROM jsonb_array_elements(p_definitions) definition
  ) THEN
    RAISE EXCEPTION 'schedule names must be unique within a namespace';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('workhorse:schedules:' || p_namespace, 0));

  INSERT INTO workhorse.schedule_definition AS existing(
    namespace, schedule_name, cron_expression, queue_name, job_type, concurrency_key, priority, payload,
    contract_version, payload_max_bytes, result_max_bytes, payload_redact_keys, result_redact_keys,
    max_attempts, retry_policy, enabled
  )
  SELECT p_namespace, definition->>'name', definition->>'schedule', definition->>'queue',
         definition->>'type', definition->>'concurrencyKey',
         COALESCE((definition->>'priority')::integer, 0),
         COALESCE(definition->'payload', 'null'::jsonb),
         definition->>'contractVersion',
         COALESCE((definition->>'payloadMaxBytes')::integer, 1048576),
         COALESCE((definition->>'resultMaxBytes')::integer, 1048576),
         ARRAY(SELECT key FROM jsonb_array_elements_text(
           COALESCE(definition->'sensitivePayloadKeys', '[]'::jsonb)
         ) key ORDER BY key COLLATE "C"),
         ARRAY(SELECT key FROM jsonb_array_elements_text(
           COALESCE(definition->'sensitiveResultKeys', '[]'::jsonb)
         ) key ORDER BY key COLLATE "C"),
         COALESCE((definition->>'maxAttempts')::integer, 25),
         workhorse.normalize_retry_policy_v1(definition->'retryPolicy'),
         COALESCE((definition->>'enabled')::boolean, true)
    FROM jsonb_array_elements(p_definitions) definition
  ON CONFLICT (namespace, schedule_name) DO UPDATE
    SET revision = existing.revision + CASE WHEN ROW(
          existing.cron_expression, existing.queue_name, existing.job_type,
          existing.concurrency_key, existing.priority, existing.payload,
          existing.contract_version, existing.payload_max_bytes, existing.result_max_bytes,
          existing.payload_redact_keys, existing.result_redact_keys,
          existing.max_attempts, existing.retry_policy, existing.enabled
        ) IS DISTINCT FROM ROW(
          EXCLUDED.cron_expression, EXCLUDED.queue_name, EXCLUDED.job_type,
          EXCLUDED.concurrency_key, EXCLUDED.priority, EXCLUDED.payload,
          EXCLUDED.contract_version, EXCLUDED.payload_max_bytes, EXCLUDED.result_max_bytes,
          EXCLUDED.payload_redact_keys, EXCLUDED.result_redact_keys,
          EXCLUDED.max_attempts, EXCLUDED.retry_policy, EXCLUDED.enabled
        ) THEN 1 ELSE 0 END,
        cron_expression = EXCLUDED.cron_expression,
        queue_name = EXCLUDED.queue_name,
        job_type = EXCLUDED.job_type,
        concurrency_key = EXCLUDED.concurrency_key,
        priority = EXCLUDED.priority,
        payload = EXCLUDED.payload,
        contract_version = EXCLUDED.contract_version,
        payload_max_bytes = EXCLUDED.payload_max_bytes,
        result_max_bytes = EXCLUDED.result_max_bytes,
        payload_redact_keys = EXCLUDED.payload_redact_keys,
        result_redact_keys = EXCLUDED.result_redact_keys,
        max_attempts = EXCLUDED.max_attempts,
        retry_policy = EXCLUDED.retry_policy,
        enabled = EXCLUDED.enabled,
        updated_at = clock_timestamp();

  IF p_prune THEN
    UPDATE workhorse.schedule_definition definition
       SET enabled = false, revision = definition.revision + 1, updated_at = clock_timestamp()
     WHERE definition.namespace = p_namespace
       AND definition.enabled
       AND NOT EXISTS (
         SELECT 1 FROM jsonb_array_elements(p_definitions) desired
          WHERE desired->>'name' = definition.schedule_name
       );
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION workhorse.fire_schedule_v1(
  p_namespace text,
  p_schedule_name text,
  p_expected_revision bigint,
  p_occurrence_at timestamptz DEFAULT date_trunc('second', clock_timestamp())
) RETURNS uuid
LANGUAGE plpgsql
AS $$
DECLARE
  v_definition workhorse.schedule_definition%ROWTYPE;
  v_job_id uuid;
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtextextended(
    'workhorse:schedule:' || p_namespace || ':' || p_schedule_name || ':' ||
    extract(epoch FROM date_trunc('second', p_occurrence_at))::bigint,
    0
  )) THEN
    RETURN NULL;
  END IF;

  SELECT * INTO v_definition
    FROM workhorse.schedule_definition definition
   WHERE definition.namespace = p_namespace
     AND definition.schedule_name = p_schedule_name
     AND definition.enabled
     AND definition.revision = p_expected_revision
   FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;

  INSERT INTO workhorse.schedule_occurrence(namespace, schedule_name, occurrence_at)
    VALUES (p_namespace, p_schedule_name, date_trunc('second', p_occurrence_at))
  ON CONFLICT DO NOTHING
  RETURNING job_id INTO v_job_id;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  v_job_id := workhorse.enqueue_v1(
    v_definition.queue_name,
    v_definition.job_type,
    v_definition.payload,
    clock_timestamp(),
    v_definition.max_attempts,
    '{}',
    v_definition.retry_policy,
    v_definition.contract_version,
    v_definition.payload_max_bytes,
    v_definition.result_max_bytes,
    v_definition.payload_redact_keys,
    v_definition.result_redact_keys,
    v_definition.concurrency_key,
    v_definition.priority
  );
  UPDATE workhorse.schedule_occurrence occurrence
     SET job_id = v_job_id
   WHERE occurrence.namespace = p_namespace
     AND occurrence.schedule_name = p_schedule_name
     AND occurrence.occurrence_at = date_trunc('second', p_occurrence_at);
  RETURN v_job_id;
END;
$$;

CREATE OR REPLACE FUNCTION workhorse.enqueue_many_v1(p_requests jsonb)
RETURNS TABLE (ordinal integer, job_id uuid, accepted boolean)
LANGUAGE plpgsql
AS $$
DECLARE
  v_count integer;
  v_now timestamptz := clock_timestamp();
  v_request jsonb;
  v_lock record;
  v_ordinal integer;
  v_queue_name text;
  v_job_type text;
  v_concurrency_key text;
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
  v_proposed_job_id uuid;
  v_existing workhorse.enqueue_idempotency%ROWTYPE;
  v_is_new boolean;
  v_is_keyed boolean;
  v_ready_queues text[] := '{}';
  v_notify_queue text;
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

  FOR v_request, v_ordinal IN
    SELECT request, ordinality::integer
      FROM jsonb_array_elements(p_requests) WITH ORDINALITY input(request, ordinality)
     ORDER BY ordinality
  LOOP
    v_queue_name := v_request->>'queue';
    v_job_type := v_request->>'type';
    v_concurrency_key := v_request->>'concurrencyKey';
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
    IF v_priority <> trunc(v_priority) OR v_priority NOT BETWEEN 0 AND 100 THEN
      RAISE EXCEPTION 'priority must be an integer between 0 and 100';
    END IF;
    IF COALESCE(v_queue_name, '') = '' OR COALESCE(v_job_type, '') = ''
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
    v_state := CASE WHEN v_run_at <= v_now THEN 'ready' ELSE 'scheduled' END;
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
        'type', v_job_type,
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
        'ttlMs', v_ttl_ms
      );
      v_request_digest := workhorse.sha256_hex_v1(v_fingerprint::text);

      LOOP
        v_proposed_job_id := gen_random_uuid();
        INSERT INTO workhorse.enqueue_idempotency AS existing(
          idempotency_scope, idempotency_key_hash, request_fingerprint, job_id, expires_at
        ) VALUES (
          v_scope, v_key_hash, v_fingerprint, v_proposed_job_id, v_expires_at
        )
        ON CONFLICT (idempotency_scope, idempotency_key_hash) DO UPDATE
          SET idempotency_key_hash = existing.idempotency_key_hash
        RETURNING existing.* INTO v_existing;

        IF v_existing.job_id = v_proposed_job_id THEN
          job_id := v_proposed_job_id;
          EXIT;
        END IF;
        IF v_existing.expires_at <= v_now THEN
          DELETE FROM workhorse.enqueue_idempotency AS expired
           WHERE expired.idempotency_scope = v_scope
             AND expired.idempotency_key_hash = v_key_hash
             AND expired.job_id = v_existing.job_id AND expired.expires_at <= v_now;
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
              'existingJobId', v_existing.job_id,
              'ordinal', v_ordinal,
              'conflictingFields', to_jsonb(v_conflicting_fields),
              'storedRequestDigest', workhorse.sha256_hex_v1(v_existing.request_fingerprint::text),
              'rejectedRequestDigest', v_request_digest
            )::text;
        END IF;
        job_id := v_existing.job_id;
        v_is_new := false;
        EXIT;
      END LOOP;
    ELSE
      job_id := gen_random_uuid();
    END IF;

    IF v_is_new THEN
      INSERT INTO workhorse.job(
        id, queue_name, job_type, concurrency_key, priority, payload, contract_version,
        payload_max_bytes, result_max_bytes,
        payload_redact_keys, result_redact_keys, trace_context, tags, max_attempts, retry_policy,
        deadline_at, execution_timeout_ms
      ) VALUES (
        job_id, v_queue_name, v_job_type, v_concurrency_key, v_priority::integer, v_payload, v_contract_version,
        v_payload_max_bytes::integer, v_result_max_bytes::integer,
        v_payload_redact_keys, v_result_redact_keys, v_trace_context, v_tags,
        v_max_attempts, v_retry_policy,
        v_deadline_at, v_execution_timeout_ms::bigint
      );
      INSERT INTO workhorse.job_runtime(
        job_id, queue_name, concurrency_key, priority, state, current_attempt, run_at, ready_at, sequence,
        deadline_at
      ) VALUES (
        job_id, v_queue_name, v_concurrency_key, v_priority::integer, v_state, 1, v_run_at,
        CASE WHEN v_state = 'ready' THEN v_now END,
        CASE WHEN v_state = 'ready' THEN nextval('workhorse.ready_sequence_seq') END,
        v_deadline_at
      );
      INSERT INTO workhorse.job_event(job_id, event_type, details)
        VALUES (
          job_id,
          'enqueued',
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
        PERFORM workhorse.terminalize_deadline_v1(job_id);
      ELSIF v_state = 'ready' AND NOT v_queue_name = ANY(v_ready_queues) THEN
        v_ready_queues := array_append(v_ready_queues, v_queue_name);
      END IF;
    END IF;
    ordinal := v_ordinal;
    accepted := v_is_new;
    RETURN NEXT;
  END LOOP;

  FOREACH v_notify_queue IN ARRAY v_ready_queues LOOP
    PERFORM pg_notify('workhorse_jobs', v_notify_queue);
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION workhorse.enqueue_v1(
  p_queue_name text,
  p_job_type text,
  p_payload jsonb,
  p_run_at timestamptz DEFAULT clock_timestamp(),
  p_max_attempts integer DEFAULT 25,
  p_tags text[] DEFAULT '{}',
  p_retry_policy jsonb DEFAULT NULL,
  p_contract_version text DEFAULT NULL,
  p_payload_max_bytes integer DEFAULT 1048576,
  p_result_max_bytes integer DEFAULT 1048576,
  p_payload_redact_keys text[] DEFAULT '{}',
  p_result_redact_keys text[] DEFAULT '{}',
  p_concurrency_key text DEFAULT NULL,
  p_priority integer DEFAULT 0
) RETURNS uuid
LANGUAGE sql
AS $$
  SELECT job_id FROM workhorse.enqueue_many_v1(jsonb_build_array(jsonb_build_object(
    'queue', p_queue_name, 'type', p_job_type, 'payload', COALESCE(p_payload, 'null'::jsonb),
    'runAt', p_run_at, 'maxAttempts', p_max_attempts, 'tags', to_jsonb(COALESCE(p_tags, '{}')),
    'retryPolicy', p_retry_policy, 'contractVersion', p_contract_version,
    'payloadMaxBytes', p_payload_max_bytes, 'resultMaxBytes', p_result_max_bytes,
    'sensitivePayloadKeys', to_jsonb(COALESCE(p_payload_redact_keys, '{}')),
    'sensitiveResultKeys', to_jsonb(COALESCE(p_result_redact_keys, '{}')),
    'concurrencyKey', to_jsonb(p_concurrency_key), 'priority', p_priority
  ))) ORDER BY ordinal LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION workhorse.list_dead_letters_v2(
  p_filter jsonb DEFAULT '{}'::jsonb,
  p_limit integer DEFAULT 100,
  p_cursor_finished_at timestamptz DEFAULT NULL,
  p_cursor_job_id uuid DEFAULT NULL
) RETURNS TABLE (
  job_id uuid, queue_name text, job_type text, concurrency_key text, priority integer,
  payload jsonb, tags text[],
  current_attempt integer, max_attempts integer, retry_policy jsonb,
  deadline_at timestamptz, execution_timeout_ms bigint, error jsonb,
  finished_at timestamptz, redrive_count integer, has_more boolean,
  cursor_finished_at text
)
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v_filter jsonb := COALESCE(p_filter, '{}'::jsonb);
  v_tags text[];
  v_finished_after timestamptz;
  v_finished_before timestamptz;
BEGIN
  IF jsonb_typeof(v_filter) <> 'object'
     OR v_filter - ARRAY['queue', 'type', 'tags', 'errorName', 'finishedAfter', 'finishedBefore']
        <> '{}'::jsonb THEN
    RAISE EXCEPTION 'dead-letter filter must be an object containing only queue, type, tags, errorName, finishedAfter, and finishedBefore';
  END IF;
  IF p_limit NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION 'dead-letter limit must be between 1 and 1000';
  END IF;
  IF (p_cursor_finished_at IS NULL) <> (p_cursor_job_id IS NULL) THEN
    RAISE EXCEPTION 'dead-letter cursor requires both finished_at and job_id';
  END IF;
  IF p_cursor_finished_at IS NOT NULL AND NOT isfinite(p_cursor_finished_at) THEN
    RAISE EXCEPTION 'dead-letter cursor finished_at must be finite';
  END IF;
  IF v_filter ? 'queue' AND (
       jsonb_typeof(v_filter->'queue') <> 'string' OR v_filter->>'queue' = ''
     ) THEN RAISE EXCEPTION 'dead-letter queue filter must be a non-empty string'; END IF;
  IF v_filter ? 'type' AND (
       jsonb_typeof(v_filter->'type') <> 'string' OR v_filter->>'type' = ''
     ) THEN RAISE EXCEPTION 'dead-letter type filter must be a non-empty string'; END IF;
  IF v_filter ? 'errorName' AND (
       jsonb_typeof(v_filter->'errorName') <> 'string' OR v_filter->>'errorName' = ''
     ) THEN RAISE EXCEPTION 'dead-letter errorName filter must be a non-empty string'; END IF;
  IF v_filter ? 'tags' THEN
    IF jsonb_typeof(v_filter->'tags') <> 'array' THEN
      RAISE EXCEPTION 'dead-letter tags filter must be an array';
    END IF;
    SELECT COALESCE(array_agg(value), '{}') INTO v_tags
      FROM jsonb_array_elements_text(v_filter->'tags') tag(value);
    IF NOT workhorse.valid_tags(v_tags) THEN
      RAISE EXCEPTION 'dead-letter tags filter must contain at most 20 non-empty tags of at most 100 characters';
    END IF;
  END IF;
  IF v_filter ? 'finishedAfter' THEN
    IF jsonb_typeof(v_filter->'finishedAfter') <> 'string' THEN
      RAISE EXCEPTION 'dead-letter finishedAfter filter must be a timestamp string';
    END IF;
    v_finished_after := (v_filter->>'finishedAfter')::timestamptz;
    IF NOT isfinite(v_finished_after) THEN RAISE EXCEPTION 'dead-letter finishedAfter must be finite'; END IF;
  END IF;
  IF v_filter ? 'finishedBefore' THEN
    IF jsonb_typeof(v_filter->'finishedBefore') <> 'string' THEN
      RAISE EXCEPTION 'dead-letter finishedBefore filter must be a timestamp string';
    END IF;
    v_finished_before := (v_filter->>'finishedBefore')::timestamptz;
    IF NOT isfinite(v_finished_before) THEN RAISE EXCEPTION 'dead-letter finishedBefore must be finite'; END IF;
  END IF;
  IF v_finished_after IS NOT NULL AND v_finished_before IS NOT NULL
     AND v_finished_after >= v_finished_before THEN
    RAISE EXCEPTION 'dead-letter finishedAfter must be earlier than finishedBefore';
  END IF;

  RETURN QUERY
  WITH candidates AS MATERIALIZED (
    SELECT job.id, job.queue_name, job.job_type, job.concurrency_key, job.priority,
           workhorse.redact_top_level_keys_v1(job.payload, job.payload_redact_keys) AS payload,
           job.tags,
           outcome.current_attempt, job.max_attempts, job.retry_policy,
           job.deadline_at, job.execution_timeout_ms, outcome.error,
           outcome.finished_at,
           (SELECT count(*)::integer FROM workhorse.job_redrive redrive
             WHERE redrive.source_job_id = job.id) AS redrive_count
      FROM workhorse.job_outcome outcome
      JOIN workhorse.job job ON job.id = outcome.job_id
     WHERE outcome.state = 'failed'
       AND (NOT (v_filter ? 'queue') OR job.queue_name = v_filter->>'queue')
       AND (NOT (v_filter ? 'type') OR job.job_type = v_filter->>'type')
       AND (v_tags IS NULL OR job.tags @> v_tags)
       AND (NOT (v_filter ? 'errorName') OR outcome.error->>'name' = v_filter->>'errorName')
       AND (v_finished_after IS NULL OR outcome.finished_at >= v_finished_after)
       AND (v_finished_before IS NULL OR outcome.finished_at < v_finished_before)
       AND (p_cursor_finished_at IS NULL OR
            (outcome.finished_at, outcome.job_id) < (p_cursor_finished_at, p_cursor_job_id))
     ORDER BY outcome.finished_at DESC, outcome.job_id DESC
     LIMIT p_limit + 1
  )
  SELECT candidate.id, candidate.queue_name, candidate.job_type, candidate.concurrency_key,
         candidate.priority, candidate.payload, candidate.tags,
         candidate.current_attempt, candidate.max_attempts, candidate.retry_policy,
         candidate.deadline_at, candidate.execution_timeout_ms, candidate.error,
         candidate.finished_at, candidate.redrive_count,
         (SELECT count(*) FROM candidates) > p_limit,
         to_char(candidate.finished_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
    FROM candidates candidate
   ORDER BY candidate.finished_at DESC, candidate.id DESC
   LIMIT p_limit;
END;
$$;

CREATE OR REPLACE FUNCTION workhorse.redrive_v1(
  p_source_job_id uuid,
  p_requested_by text,
  p_reason text,
  p_request_id text
) RETURNS TABLE (
  status text, source_job_id uuid, target_job_id uuid, source_state text,
  target_state text, requested_at timestamptz
)
LANGUAGE plpgsql
AS $$
DECLARE
  v_job workhorse.job%ROWTYPE;
  v_outcome workhorse.job_outcome%ROWTYPE;
  v_existing workhorse.job_redrive%ROWTYPE;
  v_fingerprint jsonb;
  v_conflicting_fields text[];
  v_request_id_hash bytea;
  v_request_id_preview text;
  v_request_id_digest text;
  v_request_id_length integer;
  v_now timestamptz := clock_timestamp();
BEGIN
  IF p_source_job_id IS NULL THEN RAISE EXCEPTION 'source_job_id is required'; END IF;
  IF p_requested_by IS NULL OR p_requested_by = '' OR char_length(p_requested_by) > 200 THEN
    RAISE EXCEPTION 'requested_by must contain between 1 and 200 characters';
  END IF;
  IF p_reason IS NULL OR p_reason = '' OR char_length(p_reason) > 2000 THEN
    RAISE EXCEPTION 'reason must contain between 1 and 2000 characters';
  END IF;
  IF p_request_id IS NULL OR p_request_id = '' OR octet_length(p_request_id) > 512 THEN
    RAISE EXCEPTION 'request_id must contain between 1 and 512 UTF-8 bytes';
  END IF;

  v_fingerprint := jsonb_build_object('requestedBy', p_requested_by, 'reason', p_reason);
  v_request_id_hash := sha256(convert_to(p_request_id, 'UTF8'));
  v_request_id_digest := left(encode(v_request_id_hash, 'hex'), 12);
  v_request_id_length := char_length(p_request_id);
  v_request_id_preview := CASE
    WHEN v_request_id_length <= 4 THEN repeat('•', v_request_id_length)
    WHEN v_request_id_length <= 8 THEN left(p_request_id, 2) || '…' || right(p_request_id, 2)
    ELSE left(p_request_id, 8) || '…' || right(p_request_id, 4)
  END;
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'workhorse:redrive:' || p_source_job_id::text || ':' || p_request_id, 0
  ));

  SELECT * INTO v_existing FROM workhorse.job_redrive redrive
   WHERE redrive.source_job_id = p_source_job_id
     AND redrive.request_id_hash = v_request_id_hash;
  IF FOUND THEN
    IF v_existing.request_fingerprint <> v_fingerprint THEN
      SELECT COALESCE(array_agg(field ORDER BY field COLLATE "C"), '{}')
        INTO v_conflicting_fields
        FROM jsonb_object_keys(v_fingerprint) field
       WHERE v_existing.request_fingerprint->field IS DISTINCT FROM v_fingerprint->field;
      RAISE EXCEPTION USING
        ERRCODE = 'P1002',
        MESSAGE = 'redrive request conflict with a retained request',
        DETAIL = jsonb_build_object(
          'sourceJobId', p_source_job_id,
          'existingTargetJobId', v_existing.target_job_id,
          'requestIdPreview', v_request_id_preview,
          'requestIdDigest', v_request_id_digest,
          'requestIdLength', v_request_id_length,
          'conflictingFields', to_jsonb(v_conflicting_fields),
          'storedRequestDigest', workhorse.sha256_hex_v1(v_existing.request_fingerprint::text),
          'rejectedRequestDigest', workhorse.sha256_hex_v1(v_fingerprint::text)
        )::text;
    END IF;
    RETURN QUERY
    SELECT 'replayed'::text, p_source_job_id, v_existing.target_job_id,
           'failed'::text,
           COALESCE(runtime.state, outcome.state), v_existing.requested_at
      FROM (VALUES (1)) singleton(value)
      LEFT JOIN workhorse.job_runtime runtime ON runtime.job_id = v_existing.target_job_id
      LEFT JOIN workhorse.job_outcome outcome ON outcome.job_id = v_existing.target_job_id;
    RETURN;
  END IF;

  SELECT job.* INTO v_job FROM workhorse.job job
   WHERE job.id = p_source_job_id FOR KEY SHARE;
  IF NOT FOUND THEN
    RETURN QUERY VALUES ('not_found'::text, p_source_job_id, NULL::uuid, NULL::text, NULL::text, NULL::timestamptz);
    RETURN;
  END IF;
  SELECT outcome.* INTO v_outcome FROM workhorse.job_outcome outcome
   WHERE outcome.job_id = p_source_job_id FOR SHARE;
  IF NOT FOUND OR v_outcome.state <> 'failed' THEN
    RETURN QUERY VALUES (
      'not_failed'::text, p_source_job_id, NULL::uuid,
      COALESCE(v_outcome.state, (SELECT runtime.state FROM workhorse.job_runtime runtime
                                 WHERE runtime.job_id = p_source_job_id)),
      NULL::text, NULL::timestamptz
    );
    RETURN;
  END IF;

  target_job_id := gen_random_uuid();
  INSERT INTO workhorse.job(
    id, queue_name, job_type, concurrency_key, priority, payload, contract_version,
    payload_max_bytes, result_max_bytes,
    payload_redact_keys, result_redact_keys, tags, max_attempts, retry_policy,
    deadline_at, execution_timeout_ms
  ) VALUES (
    target_job_id, v_job.queue_name, v_job.job_type, v_job.concurrency_key, v_job.priority,
    v_job.payload, v_job.contract_version,
    v_job.payload_max_bytes, v_job.result_max_bytes,
    v_job.payload_redact_keys, v_job.result_redact_keys, v_job.tags,
    v_job.max_attempts, v_job.retry_policy, NULL, v_job.execution_timeout_ms
  );
  INSERT INTO workhorse.job_runtime(
    job_id, queue_name, concurrency_key, priority, state, current_attempt, run_at, ready_at, sequence,
    deadline_at
  ) VALUES (
    target_job_id, v_job.queue_name, v_job.concurrency_key, v_job.priority, 'ready', 1, v_now, v_now,
    nextval('workhorse.ready_sequence_seq'), NULL
  );
  INSERT INTO workhorse.job_redrive(
    source_job_id, target_job_id, request_id_hash, request_id_preview,
    request_id_digest, request_id_length, requested_by, reason,
    request_fingerprint, source_state, target_initial_state, requested_at
  ) VALUES (
    p_source_job_id, target_job_id, v_request_id_hash, v_request_id_preview,
    v_request_id_digest, v_request_id_length, p_requested_by, p_reason,
    v_fingerprint, 'failed', 'ready', v_now
  );
  -- The history trigger may advance history_through_at for retention safety. Semantic terminal
  -- evidence remains immutable and the lifecycle event keeps its truthful request-time chronology.
  INSERT INTO workhorse.job_event(job_id, attempt, event_type, details)
    VALUES (p_source_job_id, v_outcome.current_attempt, 'redriven', jsonb_build_object(
      'target_job_id', target_job_id,
      'request_id_preview', v_request_id_preview,
      'request_id_digest', v_request_id_digest,
      'request_id_length', v_request_id_length,
      'requested_by', p_requested_by, 'reason', p_reason, 'requested_at', v_now
    ));
  INSERT INTO workhorse.job_event(job_id, attempt, event_type, details)
    VALUES (target_job_id, 1, 'redrive_created', jsonb_build_object(
      'source_job_id', p_source_job_id,
      'request_id_preview', v_request_id_preview,
      'request_id_digest', v_request_id_digest,
      'request_id_length', v_request_id_length,
      'requested_by', p_requested_by, 'reason', p_reason, 'requested_at', v_now,
      'state', 'ready', 'priority', v_job.priority
    ));
  PERFORM pg_notify('workhorse_jobs', v_job.queue_name);
  RETURN QUERY VALUES (
    'redriven'::text, p_source_job_id, target_job_id, 'failed'::text, 'ready'::text, v_now
  );
END;
$$;

CREATE OR REPLACE FUNCTION workhorse.claim_v3(
  p_queue_name text,
  p_worker_id text,
  p_lease_ms integer DEFAULT 30000
) RETURNS TABLE (
  job_id uuid, job_type text, priority integer, payload jsonb, contract_version text, result_max_bytes integer,
  redact_error_details boolean,
  trace_context jsonb,
  attempt integer, max_attempts integer,
  retry_policy jsonb, deadline_at timestamptz, execution_timeout_ms bigint,
  attempt_timeout_at timestamptz, fence_token bigint, lease_expires_at timestamptz
)
LANGUAGE plpgsql
AS $$
DECLARE
  v_runtime workhorse.job_runtime%ROWTYPE;
  v_policy workhorse.concurrency_policy%ROWTYPE;
  v_rate_policy workhorse.rate_limit_policy%ROWTYPE;
  v_rate_status record;
  v_active integer;
  v_fence bigint;
  v_now timestamptz;
  v_expires timestamptz;
BEGIN
  IF p_worker_id IS NULL OR p_worker_id = '' THEN RAISE EXCEPTION 'worker_id must not be empty'; END IF;
  IF p_lease_ms NOT BETWEEN 100 AND 86400000 THEN
    RAISE EXCEPTION 'lease_ms must be between 100 and 86400000';
  END IF;
  -- Shared queue locks allow unrelated claims to overlap while serializing first policy creation
  -- and pruning against deployment synchronization for this queue.
  PERFORM pg_advisory_xact_lock_shared(
    hashtextextended('workhorse:concurrency-policy:' || p_queue_name, 0)
  );
  PERFORM pg_advisory_xact_lock_shared(
    hashtextextended('workhorse:rate-limit-policy:' || p_queue_name, 0)
  );
  SELECT policy.* INTO v_policy
    FROM workhorse.concurrency_policy policy
   WHERE policy.queue_name = p_queue_name
   FOR UPDATE;
  SELECT policy.* INTO v_rate_policy
    FROM workhorse.rate_limit_policy policy
   WHERE policy.queue_name = p_queue_name
   FOR UPDATE;
  v_now := clock_timestamp();
  v_expires := v_now + make_interval(secs => p_lease_ms::double precision / 1000.0);
  WITH oldest_key_buckets AS MATERIALIZED (
    SELECT bucket.bucket_key, bucket.tokens, bucket.refilled_at
      FROM workhorse.rate_limit_bucket bucket
     WHERE bucket.queue_name = p_queue_name AND bucket.bucket_scope = 'key'
     ORDER BY bucket.refilled_at, bucket.bucket_key
     FOR UPDATE SKIP LOCKED
     LIMIT 100
  ), full_key_buckets AS (
    SELECT oldest.bucket_key
      FROM oldest_key_buckets oldest
     WHERE v_rate_policy.per_key_limit IS NULL OR LEAST(
       v_rate_policy.per_key_burst::numeric,
       oldest.tokens + GREATEST(
         0::numeric,
         extract(epoch FROM v_now - oldest.refilled_at) * 1000
       ) * v_rate_policy.per_key_limit::numeric / v_rate_policy.per_key_interval_ms::numeric
     ) >= v_rate_policy.per_key_burst
  )
  DELETE FROM workhorse.rate_limit_bucket bucket
   USING full_key_buckets refilled
   WHERE bucket.queue_name = p_queue_name AND bucket.bucket_scope = 'key'
     AND bucket.bucket_key = refilled.bucket_key;
  IF v_policy.queue_name IS NOT NULL THEN
    SELECT count(*)::integer INTO v_active
      FROM workhorse.job_runtime active
     WHERE active.state = 'active'
       AND active.queue_name = p_queue_name
       AND active.expires_at > v_now;
    IF v_active >= v_policy.max_active THEN RETURN; END IF;
  END IF;

  SELECT * INTO STRICT v_rate_status FROM workhorse.rate_limit_bucket_v1(
    p_queue_name, 'queue', '', v_rate_policy.rate_limit, v_rate_policy.rate_interval_ms,
    v_rate_policy.rate_burst, v_now, false
  );
  IF NOT v_rate_status.allowed THEN RETURN; END IF;

  v_fence := nextval('workhorse.fence_token_seq');
  WITH ready_window AS MATERIALIZED (
    SELECT runtime.job_id, runtime.concurrency_key, runtime.priority, runtime.sequence
      FROM workhorse.job_runtime runtime
      JOIN workhorse.job job ON job.id = runtime.job_id
     WHERE runtime.state = 'ready' AND runtime.queue_name = p_queue_name
       AND (runtime.deadline_at IS NULL OR runtime.deadline_at > v_now)
       AND (job.execution_timeout_ms IS NULL
         OR runtime.execution_used_ms < job.execution_timeout_ms)
       AND NOT EXISTS (
         SELECT 1 FROM workhorse.queue_control control
          WHERE control.queue_name = p_queue_name AND control.paused
       )
     ORDER BY runtime.priority DESC, runtime.sequence, runtime.job_id
     FOR UPDATE OF runtime SKIP LOCKED
     LIMIT CASE
       WHEN v_policy.queue_name IS NULL AND v_rate_policy.per_key_limit IS NULL THEN 1
       ELSE 100
     END
  ), candidate AS (
    SELECT ready.job_id
      FROM ready_window ready
      CROSS JOIN LATERAL workhorse.rate_limit_bucket_v1(
        p_queue_name, 'key', ready.concurrency_key, v_rate_policy.per_key_limit,
        v_rate_policy.per_key_interval_ms, v_rate_policy.per_key_burst, v_now, false
      ) keyed_rate
     WHERE (
       v_policy.queue_name IS NULL
       OR v_policy.max_active_per_key IS NULL
       OR ready.concurrency_key IS NULL
       OR (
          SELECT count(*)
            FROM workhorse.job_runtime active
           WHERE active.state = 'active'
             AND active.queue_name = p_queue_name
             AND active.concurrency_key = ready.concurrency_key
             AND active.expires_at > v_now
        ) < v_policy.max_active_per_key
     ) AND keyed_rate.allowed
     ORDER BY ready.priority DESC, ready.sequence, ready.job_id
     LIMIT 1
  )
  UPDATE workhorse.job_runtime runtime
     SET state = 'active', fence_token = v_fence, worker_id = p_worker_id,
         acquired_at = v_now, heartbeat_at = v_now, expires_at = v_expires,
         ready_at = NULL, sequence = NULL, wait_name = NULL,
         attempt_started_at = COALESCE(runtime.attempt_started_at, v_now),
         attempt_timeout_at = CASE
           WHEN job.execution_timeout_ms IS NULL THEN NULL
           ELSE v_now + make_interval(secs =>
             (job.execution_timeout_ms - runtime.execution_used_ms)::double precision / 1000.0)
         END,
         error = NULL, updated_at = v_now
    FROM candidate, workhorse.job job
   WHERE runtime.job_id = candidate.job_id AND runtime.state = 'ready' AND job.id = runtime.job_id
     AND (runtime.deadline_at IS NULL OR runtime.deadline_at > v_now)
  RETURNING runtime.* INTO v_runtime;
  IF NOT FOUND THEN RETURN; END IF;

  PERFORM * FROM workhorse.rate_limit_bucket_v1(
    p_queue_name, 'queue', '', v_rate_policy.rate_limit, v_rate_policy.rate_interval_ms,
    v_rate_policy.rate_burst, v_now, true
  );
  PERFORM * FROM workhorse.rate_limit_bucket_v1(
    p_queue_name, 'key', v_runtime.concurrency_key, v_rate_policy.per_key_limit,
    v_rate_policy.per_key_interval_ms, v_rate_policy.per_key_burst, v_now, true
  );

  INSERT INTO workhorse.job_event(job_id, attempt, event_type, details)
    VALUES (v_runtime.job_id, v_runtime.current_attempt, 'claimed',
      jsonb_build_object('worker_id', p_worker_id, 'fence_token', v_fence::text, 'expires_at', v_expires));
  RETURN QUERY
    SELECT job.id, job.job_type, job.priority, job.payload, job.contract_version, job.result_max_bytes,
           cardinality(job.payload_redact_keys) > 0 OR cardinality(job.result_redact_keys) > 0,
           job.trace_context,
           v_runtime.current_attempt, job.max_attempts,
           job.retry_policy, job.deadline_at, job.execution_timeout_ms,
           v_runtime.attempt_timeout_at, v_fence, v_expires
      FROM workhorse.job job WHERE job.id = v_runtime.job_id;
END;
$$;

CREATE OR REPLACE FUNCTION workhorse.list_jobs_v2(
  p_filter jsonb,
  p_limit integer,
  p_cursor_created_at timestamptz,
  p_cursor_job_id uuid,
  p_cursor_signature text,
  p_payload_projection jsonb
) RETURNS TABLE (
  job_id uuid,
  queue_name text,
  job_type text,
  concurrency_key text,
  priority integer,
  tags text[],
  state text,
  current_attempt integer,
  max_attempts integer,
  retry_policy jsonb,
  deadline_at timestamptz,
  execution_timeout_ms bigint,
  run_at timestamptz,
  cancel_requested_at timestamptz,
  cancel_requested_by text,
  cancel_reason text,
  created_at timestamptz,
  updated_at timestamptz,
  payload jsonb,
  payload_status text,
  payload_bytes integer,
  has_more boolean,
  cursor_created_at timestamptz,
  cursor_signature text
)
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v_filter jsonb := COALESCE(p_filter, '{}'::jsonb);
  v_projection jsonb := COALESCE(p_payload_projection, '{}'::jsonb);
  v_normalized_filter jsonb;
  v_normalized_projection jsonb;
  v_queue text;
  v_type text;
  v_states text[];
  v_created_after timestamptz;
  v_created_before timestamptz;
  v_include boolean := false;
  v_max_bytes integer := 16384;
  v_redact_keys text[] := '{}';
  v_signature text;
  v_has_duplicates boolean;
BEGIN
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION 'limit must be between 1 and 1000';
  END IF;
  IF jsonb_typeof(v_filter) <> 'object' THEN RAISE EXCEPTION 'filter must be an object'; END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_object_keys(v_filter) key
    WHERE key <> ALL (ARRAY['queue', 'type', 'states', 'createdAfter', 'createdBefore'])
  ) THEN
    RAISE EXCEPTION 'filter permits only queue, type, states, createdAfter, and createdBefore';
  END IF;
  IF v_filter ? 'queue' THEN
    IF jsonb_typeof(v_filter->'queue') <> 'string' OR v_filter->>'queue' = '' THEN
      RAISE EXCEPTION 'filter.queue must be a non-empty string';
    END IF;
    v_queue := v_filter->>'queue';
  END IF;
  IF v_filter ? 'type' THEN
    IF jsonb_typeof(v_filter->'type') <> 'string' OR v_filter->>'type' = '' THEN
      RAISE EXCEPTION 'filter.type must be a non-empty string';
    END IF;
    v_type := v_filter->>'type';
  END IF;
  IF v_filter ? 'states' THEN
    IF jsonb_typeof(v_filter->'states') <> 'array'
       OR jsonb_array_length(v_filter->'states') = 0 THEN
      RAISE EXCEPTION 'filter.states must be a non-empty array';
    END IF;
    IF EXISTS (
      SELECT 1 FROM jsonb_array_elements(v_filter->'states') state_value
      WHERE jsonb_typeof(state_value) <> 'string'
         OR state_value #>> '{}' NOT IN (
           'scheduled', 'ready', 'active', 'succeeded', 'failed', 'canceled'
         )
    ) THEN
      RAISE EXCEPTION 'filter.states contains an invalid lifecycle state';
    END IF;
    SELECT array_agg(state_value ORDER BY state_value), count(*) <> count(DISTINCT state_value)
      INTO STRICT v_states, v_has_duplicates
      FROM jsonb_array_elements_text(v_filter->'states') state_value;
    IF v_has_duplicates THEN RAISE EXCEPTION 'filter.states must contain unique values'; END IF;
  END IF;
  IF v_filter ? 'createdAfter' THEN
    IF jsonb_typeof(v_filter->'createdAfter') <> 'string' THEN
      RAISE EXCEPTION 'filter.createdAfter must be a timestamp string';
    END IF;
    v_created_after := (v_filter->>'createdAfter')::timestamptz;
    IF NOT isfinite(v_created_after) THEN RAISE EXCEPTION 'filter.createdAfter must be finite'; END IF;
  END IF;
  IF v_filter ? 'createdBefore' THEN
    IF jsonb_typeof(v_filter->'createdBefore') <> 'string' THEN
      RAISE EXCEPTION 'filter.createdBefore must be a timestamp string';
    END IF;
    v_created_before := (v_filter->>'createdBefore')::timestamptz;
    IF NOT isfinite(v_created_before) THEN RAISE EXCEPTION 'filter.createdBefore must be finite'; END IF;
  END IF;
  IF v_created_after IS NOT NULL AND v_created_before IS NOT NULL
     AND v_created_after >= v_created_before THEN
    RAISE EXCEPTION 'filter.createdAfter must be earlier than createdBefore';
  END IF;

  IF jsonb_typeof(v_projection) <> 'object' THEN
    RAISE EXCEPTION 'payloadProjection must be an object';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_object_keys(v_projection) key
    WHERE key <> ALL (ARRAY['include', 'maxBytes', 'redactKeys'])
  ) THEN
    RAISE EXCEPTION 'payloadProjection permits only include, maxBytes, and redactKeys';
  END IF;
  IF v_projection ? 'include' THEN
    IF jsonb_typeof(v_projection->'include') <> 'boolean' THEN
      RAISE EXCEPTION 'payloadProjection.include must be boolean';
    END IF;
    v_include := (v_projection->>'include')::boolean;
  END IF;
  IF v_projection ? 'maxBytes' THEN
    IF jsonb_typeof(v_projection->'maxBytes') <> 'number'
       OR (v_projection->>'maxBytes')::numeric <> trunc((v_projection->>'maxBytes')::numeric)
       OR (v_projection->>'maxBytes')::numeric NOT BETWEEN 1 AND 1048576 THEN
      RAISE EXCEPTION 'payloadProjection.maxBytes must be an integer between 1 and 1048576';
    END IF;
    v_max_bytes := (v_projection->>'maxBytes')::integer;
  END IF;
  IF v_projection ? 'redactKeys' THEN
    IF jsonb_typeof(v_projection->'redactKeys') <> 'array'
       OR jsonb_array_length(v_projection->'redactKeys') > 50 THEN
      RAISE EXCEPTION 'payloadProjection.redactKeys must contain at most 50 values';
    END IF;
    IF EXISTS (
      SELECT 1 FROM jsonb_array_elements(v_projection->'redactKeys') key_value
      WHERE jsonb_typeof(key_value) <> 'string'
         OR char_length(key_value #>> '{}') NOT BETWEEN 1 AND 200
    ) THEN
      RAISE EXCEPTION 'payloadProjection.redactKeys values must contain 1 to 200 characters';
    END IF;
    SELECT COALESCE(array_agg(key_value ORDER BY key_value), '{}'),
           count(*) <> count(DISTINCT key_value)
      INTO STRICT v_redact_keys, v_has_duplicates
      FROM jsonb_array_elements_text(v_projection->'redactKeys') key_value;
    IF v_has_duplicates THEN
      RAISE EXCEPTION 'payloadProjection.redactKeys must contain unique values';
    END IF;
  END IF;

  v_normalized_filter := jsonb_strip_nulls(jsonb_build_object(
    'queue', v_queue,
    'type', v_type,
    'states', CASE WHEN v_states IS NULL THEN NULL ELSE to_jsonb(v_states) END,
    'createdAfter', CASE WHEN v_created_after IS NULL THEN NULL
      ELSE to_char(v_created_after AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') END,
    'createdBefore', CASE WHEN v_created_before IS NULL THEN NULL
      ELSE to_char(v_created_before AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') END
  ));
  v_normalized_projection := jsonb_build_object(
    'include', v_include,
    'maxBytes', v_max_bytes,
    'redactKeys', to_jsonb(v_redact_keys)
  );
  v_signature := left(workhorse.sha256_hex_v1(jsonb_build_object(
    'filter', v_normalized_filter,
    'payloadProjection', v_normalized_projection
  )::text), 16);

  IF (p_cursor_created_at IS NULL) <> (p_cursor_job_id IS NULL)
     OR (p_cursor_created_at IS NULL) <> (p_cursor_signature IS NULL) THEN
    RAISE EXCEPTION 'cursor timestamp, job id, and signature must be provided together';
  END IF;
  IF p_cursor_created_at IS NOT NULL THEN
    IF NOT isfinite(p_cursor_created_at) THEN RAISE EXCEPTION 'cursor timestamp must be finite'; END IF;
    IF p_cursor_signature !~ '^[0-9a-f]{16}$' THEN
      RAISE EXCEPTION 'cursor signature must be 16 lowercase hexadecimal characters';
    END IF;
    IF p_cursor_signature <> v_signature THEN
      RAISE EXCEPTION 'cursor does not match the requested filter and payload projection';
    END IF;
  END IF;

  RETURN QUERY
  WITH candidates AS MATERIALIZED (
    SELECT query_row.*
    FROM workhorse.job_query query_row
    WHERE (v_queue IS NULL OR query_row.queue_name = v_queue)
      AND (v_type IS NULL OR query_row.job_type = v_type)
      AND (v_states IS NULL OR query_row.state = ANY(v_states))
      AND (v_created_after IS NULL OR query_row.created_at >= v_created_after)
      AND (v_created_before IS NULL OR query_row.created_at < v_created_before)
      AND (p_cursor_created_at IS NULL
        OR (query_row.created_at, query_row.job_id) < (p_cursor_created_at, p_cursor_job_id))
    ORDER BY query_row.created_at DESC, query_row.job_id DESC
    LIMIT p_limit + 1
  ), page AS MATERIALIZED (
    SELECT candidate.*
    FROM candidates candidate
    ORDER BY candidate.created_at DESC, candidate.job_id DESC
    LIMIT p_limit
  ), page_meta AS (
    SELECT count(*) > p_limit AS has_more FROM candidates
  )
  SELECT
    page.job_id,
    page.queue_name,
    page.job_type,
    job.concurrency_key,
    job.priority,
    job.tags,
    page.state,
    page.current_attempt,
    job.max_attempts,
    job.retry_policy,
    job.deadline_at,
    job.execution_timeout_ms,
    page.run_at,
    page.cancel_requested_at,
    page.cancel_requested_by,
    page.cancel_reason,
    page.created_at,
    page.updated_at,
    CASE WHEN v_include AND payload_value.payload_bytes <= v_max_bytes
      THEN payload_value.payload END,
    CASE
      WHEN NOT v_include THEN 'omitted'
      WHEN payload_value.payload_bytes <= v_max_bytes THEN 'included'
      ELSE 'too_large'
    END,
    CASE WHEN v_include THEN payload_value.payload_bytes END,
    page_meta.has_more,
    page.created_at,
    v_signature
  FROM page
  JOIN workhorse.job job ON job.id = page.job_id
  CROSS JOIN page_meta
  LEFT JOIN LATERAL (
    SELECT redacted.payload, octet_length(redacted.payload::text)::integer AS payload_bytes
    FROM (
      SELECT workhorse.redact_top_level_keys_v1(
        job.payload, job.payload_redact_keys || v_redact_keys
      ) AS payload
    ) redacted
    WHERE v_include
  ) payload_value ON true
  ORDER BY page.created_at DESC, page.job_id DESC;
END;
$$;


CREATE OR REPLACE FUNCTION workhorse.list_job_timeline_v2(
  p_job_id uuid,
  p_limit integer,
  p_cursor_occurred_at timestamptz,
  p_cursor_kind text,
  p_cursor_record_id bigint
) RETURNS TABLE (
  kind text,
  record_id bigint,
  job_id uuid,
  priority integer,
  occurred_at timestamptz,
  attempt integer,
  event_type text,
  details jsonb,
  fence_token bigint,
  worker_id text,
  outcome text,
  started_at timestamptz,
  claimed_at timestamptz,
  finished_at timestamptz,
  error jsonb,
  has_more boolean,
  cursor_occurred_at timestamptz
)
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v_cursor_rank integer;
BEGIN
  IF p_job_id IS NULL THEN RAISE EXCEPTION 'job_id is required'; END IF;
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION 'limit must be between 1 and 1000';
  END IF;
  IF (p_cursor_occurred_at IS NULL) <> (p_cursor_kind IS NULL)
     OR (p_cursor_occurred_at IS NULL) <> (p_cursor_record_id IS NULL) THEN
    RAISE EXCEPTION 'timeline cursor timestamp, kind, and record id must be provided together';
  END IF;
  IF p_cursor_occurred_at IS NOT NULL THEN
    IF NOT isfinite(p_cursor_occurred_at) THEN
      RAISE EXCEPTION 'timeline cursor timestamp must be finite';
    END IF;
    IF p_cursor_kind NOT IN ('event', 'attempt') THEN
      RAISE EXCEPTION 'timeline cursor kind must be event or attempt';
    END IF;
    IF p_cursor_record_id <= 0 THEN
      RAISE EXCEPTION 'timeline cursor record id must be positive';
    END IF;
    v_cursor_rank := CASE p_cursor_kind WHEN 'event' THEN 1 ELSE 0 END;
  END IF;

  RETURN QUERY
  WITH merged AS MATERIALIZED (
    SELECT
      'event'::text AS kind,
      event.event_id AS record_id,
      event.job_id,
      event.occurred_at,
      event.attempt,
      event.event_type,
      event.details,
      NULL::bigint AS fence_token,
      NULL::text AS worker_id,
      NULL::text AS outcome,
      NULL::timestamptz AS started_at,
      NULL::timestamptz AS claimed_at,
      NULL::timestamptz AS finished_at,
      NULL::jsonb AS error,
      1 AS kind_rank
    FROM workhorse.job_event event
    WHERE event.job_id = p_job_id
      AND (p_cursor_occurred_at IS NULL
        OR (event.occurred_at, 1, event.event_id)
          < (p_cursor_occurred_at, v_cursor_rank, p_cursor_record_id))
    UNION ALL
    SELECT
      'attempt'::text,
      history.attempt_id,
      history.job_id,
      history.occurred_at,
      history.attempt,
      NULL::text,
      NULL::jsonb,
      history.fence_token,
      history.worker_id,
      history.outcome,
      history.started_at,
      history.claimed_at,
      history.finished_at,
      history.error,
      0 AS kind_rank
    FROM workhorse.attempt_history history
    WHERE history.job_id = p_job_id
      AND (p_cursor_occurred_at IS NULL
        OR (history.occurred_at, 0, history.attempt_id)
          < (p_cursor_occurred_at, v_cursor_rank, p_cursor_record_id))
    ORDER BY occurred_at DESC, kind_rank DESC, record_id DESC
    LIMIT p_limit + 1
  ), page AS MATERIALIZED (
    SELECT merged.* FROM merged
    ORDER BY merged.occurred_at DESC, merged.kind_rank DESC, merged.record_id DESC
    LIMIT p_limit
  ), page_meta AS (
    SELECT count(*) > p_limit AS has_more FROM merged
  )
  SELECT
    page.kind,
    page.record_id,
    page.job_id,
    job.priority,
    page.occurred_at,
    page.attempt,
    page.event_type,
    page.details,
    page.fence_token,
    page.worker_id,
    page.outcome,
    page.started_at,
    page.claimed_at,
    page.finished_at,
    page.error,
    page_meta.has_more,
    page.occurred_at
  FROM page
  JOIN workhorse.job job ON job.id = page.job_id
  CROSS JOIN page_meta
  ORDER BY page.occurred_at DESC, page.kind_rank DESC, page.record_id DESC;
END;
$$;

CREATE OR REPLACE VIEW workhorse.dashboard_job_v1 AS
  SELECT id, queue_name, job_type, concurrency_key, payload, payload_redact_keys,
         result_redact_keys, tags, max_attempts, retry_policy, deadline_at, execution_timeout_ms,
         created_at, priority FROM workhorse.job;
CREATE OR REPLACE VIEW workhorse.dashboard_schedule_definition_v1 AS
  SELECT namespace, schedule_name, cron_expression, queue_name, job_type, enabled, revision,
         updated_at, priority FROM workhorse.schedule_definition;

INSERT INTO workhorse.schema_migration(version, description)
VALUES (27, 'add strict-priority job dispatch')
ON CONFLICT DO NOTHING;

DELETE FROM workhorse.schema_version WHERE version = 26;
INSERT INTO workhorse.schema_version(version) VALUES (27) ON CONFLICT DO NOTHING;

COMMIT;
