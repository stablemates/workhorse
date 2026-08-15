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
  IF v_version NOT IN (30, 31) THEN
    RAISE EXCEPTION 'migration 0031 requires schema version 30, found %', v_version;
  END IF;
END;
$migration$;

ALTER TABLE workhorse.job_dependency
  ADD COLUMN IF NOT EXISTS on_failure text NOT NULL DEFAULT 'fail'
    CHECK (on_failure IN ('release', 'cancel', 'fail')),
  ADD COLUMN IF NOT EXISTS on_cancellation text NOT NULL DEFAULT 'cancel'
    CHECK (on_cancellation IN ('release', 'cancel', 'fail'));
ALTER TABLE workhorse.job_dependency
  ADD COLUMN IF NOT EXISTS on_success text NOT NULL DEFAULT 'release'
    CHECK (on_success IN ('release', 'cancel', 'fail')),
  ADD COLUMN IF NOT EXISTS resolution text
    CHECK (resolution IN ('release', 'cancel', 'fail'));
UPDATE workhorse.job_dependency SET resolution = 'release' WHERE released_at IS NOT NULL;
ALTER TABLE workhorse.job_dependency
  ALTER COLUMN on_failure DROP DEFAULT,
  ALTER COLUMN on_cancellation DROP DEFAULT,
  ALTER COLUMN on_success DROP DEFAULT;
ALTER TABLE workhorse.job_dependency DROP CONSTRAINT IF EXISTS job_dependency_check1;
ALTER TABLE workhorse.job_dependency ADD CHECK (
  (released_at IS NULL AND resolution IS NULL)
  OR (released_at >= created_at AND resolution IS NOT NULL)
);
ALTER TABLE workhorse.job_dependency DROP CONSTRAINT IF EXISTS job_dependency_pkey;
ALTER TABLE workhorse.job_dependency
  ADD CONSTRAINT job_dependency_pkey PRIMARY KEY (dependent_job_id, prerequisite_job_id);

ALTER TABLE workhorse.job_outcome DROP CONSTRAINT IF EXISTS job_outcome_check;
ALTER TABLE workhorse.job_outcome ADD CHECK (
  (state = 'succeeded' AND fence_token > 0 AND error IS NULL)
  OR (
    state = 'failed' AND (
      fence_token > 0
      OR (fence_token = 0 AND error->>'name' IN ('DeadlineExceeded', 'DependencyFailed'))
    )
  )
  OR (state = 'canceled' AND error IS NOT NULL)
);

CREATE OR REPLACE FUNCTION workhorse.validate_job_dependency_v1()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_cycle uuid[];
BEGIN
  -- Serialize graph mutations so two transactions cannot create opposite edges from snapshots that
  -- cannot see each other. Ordinary lifecycle resolution never needs this lock.
  PERFORM pg_advisory_xact_lock(hashtextextended('workhorse:job-dependency-graph', 0));
  IF NEW.dependent_job_id = NEW.prerequisite_job_id THEN
    v_cycle := ARRAY[NEW.dependent_job_id, NEW.prerequisite_job_id];
  ELSE
    WITH RECURSIVE reachable(job_id, path) AS (
      SELECT NEW.prerequisite_job_id, ARRAY[NEW.dependent_job_id, NEW.prerequisite_job_id]
      UNION ALL
      SELECT edge.prerequisite_job_id, reachable.path || edge.prerequisite_job_id
        FROM reachable
        JOIN workhorse.job_dependency edge ON edge.dependent_job_id = reachable.job_id
       WHERE (
         edge.prerequisite_job_id = NEW.dependent_job_id
         OR NOT edge.prerequisite_job_id = ANY(reachable.path)
       )
         AND reachable.job_id <> NEW.dependent_job_id
    )
    SELECT path INTO v_cycle FROM reachable
     WHERE job_id = NEW.dependent_job_id
     ORDER BY cardinality(path)
     LIMIT 1;
  END IF;
  IF v_cycle IS NOT NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P1002',
      MESSAGE = 'dependency cycle rejected',
      DETAIL = jsonb_build_object(
        'dependentJobId', NEW.dependent_job_id,
        'prerequisiteJobId', NEW.prerequisite_job_id,
        'cycleJobIds', to_jsonb(v_cycle[1:101]),
        'truncated', cardinality(v_cycle) > 101
      )::text;
  END IF;
  IF (
    SELECT count(*) FROM workhorse.job_dependency dependency
     WHERE dependency.dependent_job_id = NEW.dependent_job_id
  ) >= 100 THEN
    RAISE EXCEPTION 'a job accepts at most 100 prerequisite dependencies';
  END IF;
  IF EXISTS (
    SELECT 1 FROM workhorse.job_dependency dependency
     WHERE dependency.dependent_job_id = NEW.dependent_job_id
       AND (
         dependency.on_success <> NEW.on_success
         OR dependency.on_failure <> NEW.on_failure
         OR dependency.on_cancellation <> NEW.on_cancellation
       )
  ) THEN
    RAISE EXCEPTION 'every dependency edge for one job must use the same outcome policies';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE TRIGGER job_dependency_validate_insert
  BEFORE INSERT ON workhorse.job_dependency
  FOR EACH ROW EXECUTE FUNCTION workhorse.validate_job_dependency_v1();

CREATE OR REPLACE FUNCTION workhorse.resolve_dependents_v1(
  p_prerequisite_job_id uuid, p_prerequisite_state text
)
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  v_dependency workhorse.job_dependency%ROWTYPE;
  v_runtime workhorse.job_runtime%ROWTYPE;
  v_now timestamptz := clock_timestamp();
  v_count integer := 0;
  v_action text;
  v_final_action text;
  v_error jsonb;
BEGIN
  IF p_prerequisite_state NOT IN ('succeeded', 'failed', 'canceled') THEN
    RAISE EXCEPTION 'prerequisite state must be succeeded, failed, or canceled';
  END IF;
  FOR v_dependency IN
    SELECT dependency.* FROM workhorse.job_dependency dependency
     WHERE dependency.prerequisite_job_id = p_prerequisite_job_id
       AND dependency.released_at IS NULL
     ORDER BY dependency.dependent_job_id FOR UPDATE
  LOOP
    SELECT * INTO v_runtime FROM workhorse.job_runtime runtime
     WHERE runtime.job_id = v_dependency.dependent_job_id FOR UPDATE;
    IF NOT FOUND OR v_runtime.state <> 'blocked' THEN CONTINUE; END IF;
    v_action := CASE p_prerequisite_state
      WHEN 'succeeded' THEN v_dependency.on_success
      WHEN 'failed' THEN v_dependency.on_failure
      WHEN 'canceled' THEN v_dependency.on_cancellation
    END;
    UPDATE workhorse.job_dependency dependency
       SET released_at = v_now, resolution = v_action
     WHERE dependency.dependent_job_id = v_dependency.dependent_job_id
       AND dependency.prerequisite_job_id = p_prerequisite_job_id
       AND dependency.released_at IS NULL;
    IF EXISTS (
      SELECT 1 FROM workhorse.job_dependency dependency
       WHERE dependency.dependent_job_id = v_dependency.dependent_job_id
         AND dependency.released_at IS NULL
    ) THEN CONTINUE; END IF;
    SELECT resolution INTO STRICT v_final_action
      FROM workhorse.job_dependency dependency
     WHERE dependency.dependent_job_id = v_dependency.dependent_job_id
     ORDER BY CASE resolution WHEN 'fail' THEN 0 WHEN 'cancel' THEN 1 ELSE 2 END
     LIMIT 1;
    IF v_final_action IN ('fail', 'cancel') THEN
      v_error := jsonb_build_object(
        'name', CASE WHEN v_final_action = 'fail' THEN 'DependencyFailed' ELSE 'DependencyCanceled' END,
        'message', CASE WHEN v_final_action = 'fail'
          THEN 'a prerequisite reached a terminal outcome rejected by dependency policy'
          ELSE 'a prerequisite reached a terminal outcome that canceled its dependent' END,
        'prerequisite_job_id', p_prerequisite_job_id,
        'prerequisite_state', p_prerequisite_state,
        'policy_action', v_final_action
      );
      DELETE FROM workhorse.job_runtime runtime
       WHERE runtime.job_id = v_dependency.dependent_job_id AND runtime.state = 'blocked';
      IF NOT FOUND THEN CONTINUE; END IF;
      INSERT INTO workhorse.job_outcome(
        job_id, state, current_attempt, fence_token, run_at, error, finished_at, updated_at
      ) VALUES (
        v_dependency.dependent_job_id,
        CASE WHEN v_final_action = 'fail' THEN 'failed' ELSE 'canceled' END,
        v_runtime.current_attempt, 0, v_runtime.run_at, v_error, v_now, v_now
      );
      INSERT INTO workhorse.job_event(job_id, event_type, details)
        VALUES (
          v_dependency.dependent_job_id,
          CASE WHEN v_final_action = 'fail' THEN 'dependency_failed' ELSE 'dependency_canceled' END,
          v_error
        );
      v_count := v_count + 1;
      CONTINUE;
    END IF;
    UPDATE workhorse.job_runtime runtime
       SET state = CASE WHEN runtime.run_at <= v_now THEN 'ready' ELSE 'scheduled' END,
           ready_at = CASE WHEN runtime.run_at <= v_now THEN v_now END,
           sequence = CASE WHEN runtime.run_at <= v_now
             THEN nextval('workhorse.ready_sequence_seq') END,
           updated_at = v_now
     WHERE runtime.job_id = v_dependency.dependent_job_id AND runtime.state = 'blocked'
    RETURNING * INTO v_runtime;
    IF NOT FOUND THEN CONTINUE; END IF;

    INSERT INTO workhorse.job_event(job_id, event_type, details)
      VALUES (v_runtime.job_id, 'dependency_released', jsonb_build_object(
        'prerequisite_job_id', p_prerequisite_job_id, 'state', v_runtime.state,
        'reason', 'prerequisite_succeeded'
      ));
    v_count := v_count + 1;
    IF v_runtime.deadline_at IS NOT NULL AND v_runtime.deadline_at <= v_now THEN
      PERFORM workhorse.terminalize_deadline_v1(v_runtime.job_id);
    ELSIF v_runtime.state = 'ready' THEN
      PERFORM pg_notify('workhorse_jobs', v_runtime.queue_name);
    END IF;
  END LOOP;
  RETURN v_count;
END;
$$;

CREATE OR REPLACE FUNCTION workhorse.release_dependents_v1(p_prerequisite_job_id uuid)
RETURNS integer
LANGUAGE sql
AS $$
  SELECT workhorse.resolve_dependents_v1(p_prerequisite_job_id, 'succeeded');
$$;

CREATE OR REPLACE FUNCTION workhorse.resolve_job_outcome_dependencies_v1()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM workhorse.resolve_dependents_v1(NEW.job_id, NEW.state);
  RETURN NEW;
END;
$$;

CREATE OR REPLACE TRIGGER job_outcome_resolve_dependencies_insert
  AFTER INSERT ON workhorse.job_outcome
  FOR EACH ROW EXECUTE FUNCTION workhorse.resolve_job_outcome_dependencies_v1();

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
  v_dependencies jsonb;
  v_prerequisite_job_ids uuid[];
  v_prerequisite_job_id uuid;
  v_on_success text;
  v_on_failure text;
  v_on_cancellation text;
  v_pending_prerequisites integer;
  v_terminal_prerequisite_id uuid;
  v_terminal_prerequisite_state text;
  v_terminal_action text;
  v_terminal record;
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
    IF v_request ? 'prerequisiteJobId'
       AND v_request->'prerequisiteJobId' <> 'null'::jsonb
       AND jsonb_typeof(v_request->'prerequisiteJobId') <> 'string' THEN
      RAISE EXCEPTION 'prerequisiteJobId must be a UUID string or null';
    END IF;
    v_dependencies := v_request->'dependencies';
    IF v_request->>'prerequisiteJobId' IS NOT NULL
       AND v_dependencies IS NOT NULL AND v_dependencies <> 'null'::jsonb THEN
      RAISE EXCEPTION 'prerequisiteJobId and dependencies cannot be combined';
    END IF;
    IF v_dependencies IS NOT NULL AND v_dependencies <> 'null'::jsonb THEN
      IF jsonb_typeof(v_dependencies) <> 'object'
         OR v_dependencies - ARRAY['prerequisiteJobIds', 'onSuccess', 'onFailure', 'onCancellation'] <> '{}'::jsonb
         OR jsonb_typeof(v_dependencies->'prerequisiteJobIds') <> 'array'
         OR jsonb_array_length(v_dependencies->'prerequisiteJobIds') NOT BETWEEN 1 AND 100
         OR v_dependencies->>'onSuccess' NOT IN ('release', 'cancel', 'fail')
         OR v_dependencies->>'onFailure' NOT IN ('release', 'cancel', 'fail')
         OR v_dependencies->>'onCancellation' NOT IN ('release', 'cancel', 'fail')
         OR EXISTS (
           SELECT 1 FROM jsonb_array_elements(v_dependencies->'prerequisiteJobIds') item
            WHERE jsonb_typeof(item) <> 'string'
         ) THEN
        RAISE EXCEPTION 'dependencies requires 1 to 100 UUID strings and release, cancel, or fail outcome policies';
      END IF;
      v_prerequisite_job_ids := ARRAY(
        SELECT value::uuid
          FROM jsonb_array_elements_text(v_dependencies->'prerequisiteJobIds') value
         ORDER BY value::uuid
      );
      v_on_success := v_dependencies->>'onSuccess';
      v_on_failure := v_dependencies->>'onFailure';
      v_on_cancellation := v_dependencies->>'onCancellation';
    ELSIF v_request->>'prerequisiteJobId' IS NOT NULL THEN
      v_prerequisite_job_ids := ARRAY[(v_request->>'prerequisiteJobId')::uuid];
      v_on_success := 'release';
      v_on_failure := 'fail';
      v_on_cancellation := 'cancel';
    ELSE
      v_prerequisite_job_ids := '{}';
      v_on_success := 'release';
      v_on_failure := 'fail';
      v_on_cancellation := 'cancel';
    END IF;
    v_prerequisite_job_id := CASE
      WHEN v_dependencies IS NULL OR v_dependencies = 'null'::jsonb
        THEN NULLIF(v_request->>'prerequisiteJobId', '')::uuid
      ELSE NULL
    END;
    IF cardinality(v_prerequisite_job_ids) <> (
      SELECT count(DISTINCT prerequisite_id) FROM unnest(v_prerequisite_job_ids) prerequisite_id
    ) THEN
      RAISE EXCEPTION 'dependency prerequisiteJobIds must be unique';
    END IF;
    PERFORM 1 FROM workhorse.job prerequisite
     WHERE prerequisite.id = ANY(v_prerequisite_job_ids)
     ORDER BY prerequisite.id FOR UPDATE;
    GET DIAGNOSTICS v_pending_prerequisites = ROW_COUNT;
    IF v_pending_prerequisites <> cardinality(v_prerequisite_job_ids) THEN
      RAISE EXCEPTION 'prerequisite job does not exist';
    END IF;
    SELECT count(*)::integer INTO v_pending_prerequisites
      FROM unnest(v_prerequisite_job_ids) prerequisite_id
      LEFT JOIN workhorse.job_outcome outcome ON outcome.job_id = prerequisite_id
     WHERE outcome.job_id IS NULL;
    SELECT outcome.job_id, outcome.state, action.policy_action
      INTO v_terminal_prerequisite_id, v_terminal_prerequisite_state, v_terminal_action
      FROM workhorse.job_outcome outcome
      CROSS JOIN LATERAL (
        SELECT CASE outcome.state
          WHEN 'succeeded' THEN v_on_success
          WHEN 'failed' THEN v_on_failure
          WHEN 'canceled' THEN v_on_cancellation
          ELSE 'release'
        END AS policy_action
      ) action
     WHERE outcome.job_id = ANY(v_prerequisite_job_ids)
       AND action.policy_action IN ('fail', 'cancel')
     ORDER BY CASE action.policy_action WHEN 'fail' THEN 0 ELSE 1 END, outcome.job_id
     LIMIT 1;
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
        'prerequisiteJobId', to_jsonb(v_prerequisite_job_id),
        'dependencies', CASE WHEN v_dependencies IS NULL OR v_dependencies = 'null'::jsonb
          THEN 'null'::jsonb ELSE
          jsonb_build_object(
            'prerequisiteJobIds', to_jsonb(v_prerequisite_job_ids),
            'onSuccess', v_on_success,
            'onFailure', v_on_failure,
            'onCancellation', v_on_cancellation
          ) END,
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
      FOREACH v_prerequisite_job_id IN ARRAY v_prerequisite_job_ids LOOP
        INSERT INTO workhorse.job_dependency(
          dependent_job_id, prerequisite_job_id, on_success, on_failure, on_cancellation,
          created_at, released_at, resolution
        ) VALUES (
          job_id, v_prerequisite_job_id, v_on_success, v_on_failure, v_on_cancellation, v_now,
          CASE WHEN EXISTS (
            SELECT 1 FROM workhorse.job_outcome outcome
             WHERE outcome.job_id = v_prerequisite_job_id
               AND (
                 (outcome.state = 'succeeded' AND v_on_success = 'release')
                 OR (outcome.state = 'failed' AND v_on_failure = 'release')
                 OR (outcome.state = 'canceled' AND v_on_cancellation = 'release')
               )
          ) THEN v_now END,
          CASE WHEN EXISTS (
            SELECT 1 FROM workhorse.job_outcome outcome
             WHERE outcome.job_id = v_prerequisite_job_id
               AND (
                 (outcome.state = 'succeeded' AND v_on_success = 'release')
                 OR (outcome.state = 'failed' AND v_on_failure = 'release')
                 OR (outcome.state = 'canceled' AND v_on_cancellation = 'release')
               )
          ) THEN 'release' END
        );
        INSERT INTO workhorse.job_event(job_id, event_type, details)
          VALUES (
            job_id,
            CASE WHEN EXISTS (
              SELECT 1 FROM workhorse.job_outcome outcome
               WHERE outcome.job_id = v_prerequisite_job_id
                 AND (
                   (outcome.state = 'succeeded' AND v_on_success = 'release')
                   OR (outcome.state = 'failed' AND v_on_failure = 'release')
                   OR (outcome.state = 'canceled' AND v_on_cancellation = 'release')
                 )
            )
              THEN 'dependency_released' ELSE 'dependency_blocked' END,
            jsonb_build_object(
              'prerequisite_job_id', v_prerequisite_job_id,
              'state', v_state,
              'reason', COALESCE((
                SELECT CASE outcome.state
                  WHEN 'succeeded' THEN 'prerequisite_already_succeeded'
                  ELSE 'prerequisite_terminal_policy'
                END
                  FROM workhorse.job_outcome outcome
                 WHERE outcome.job_id = v_prerequisite_job_id
                   AND (
                     (outcome.state = 'succeeded' AND v_on_success = 'release')
                     OR (outcome.state = 'failed' AND v_on_failure = 'release')
                     OR (outcome.state = 'canceled' AND v_on_cancellation = 'release')
                   )
              ), 'prerequisite_pending')
            )
          );
      END LOOP;
      FOR v_terminal IN
        SELECT outcome.job_id, outcome.state FROM workhorse.job_outcome outcome
         WHERE outcome.job_id = ANY(v_prerequisite_job_ids)
         ORDER BY outcome.job_id
      LOOP
        PERFORM workhorse.resolve_dependents_v1(v_terminal.job_id, v_terminal.state);
      END LOOP;
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

DO $complete$
DECLARE
  v_definition text;
  v_changed text;
BEGIN
  SELECT pg_get_functiondef(
    'workhorse.complete_v1(uuid,text,bigint,jsonb)'::regprocedure
  ) INTO v_definition;
  v_changed := replace(
    v_definition,
    '  PERFORM workhorse.release_dependents_v1(p_job_id);' || chr(10),
    ''
  );
  IF v_changed <> v_definition THEN
    EXECUTE v_changed;
  END IF;
END;
$complete$;

DROP VIEW workhorse.dashboard_job_dependency_v1;
CREATE VIEW workhorse.dashboard_job_dependency_v1 AS
  SELECT dependent_job_id, prerequisite_job_id, on_success, on_failure, on_cancellation,
         created_at, released_at, resolution
    FROM workhorse.job_dependency;

INSERT INTO workhorse.schema_migration(version, description)
VALUES (31, 'add fan-in dependency policies')
ON CONFLICT DO NOTHING;

DELETE FROM workhorse.schema_version WHERE version = 30;
INSERT INTO workhorse.schema_version(version) VALUES (31) ON CONFLICT DO NOTHING;

COMMIT;
