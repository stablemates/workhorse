-- workhorse-migration: {"kind":"additive"}

-- Named budgets (ADR 0067).

-- Deployment-synchronized budgets that span queues (ADR 0067). A task names at most one budget.
-- A missing row means the named budget imposes no limit.
CREATE TABLE IF NOT EXISTS workhorse.budget (
  budget_name text PRIMARY KEY CHECK (budget_name <> '' AND octet_length(budget_name) <= 256),
  namespace text NOT NULL CHECK (namespace <> '' AND octet_length(namespace) <= 256),
  max_active integer CHECK (max_active IS NULL OR max_active BETWEEN 1 AND 1000000),
  rate_limit integer,
  rate_interval_ms integer,
  rate_burst integer,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT budget_rate_check CHECK (
    (rate_limit IS NULL AND rate_interval_ms IS NULL AND rate_burst IS NULL)
    OR (rate_limit BETWEEN 1 AND 1000000
      AND rate_interval_ms BETWEEN 1 AND 86400000
      AND rate_burst BETWEEN 1 AND 1000000)
  ),
  CONSTRAINT budget_limit_check CHECK (max_active IS NOT NULL OR rate_limit IS NOT NULL)
);
-- One durable token bucket per budget. Deleting the budget removes its balance.
CREATE TABLE IF NOT EXISTS workhorse.budget_bucket (
  budget_name text PRIMARY KEY REFERENCES workhorse.budget(budget_name) ON DELETE CASCADE,
  tokens numeric NOT NULL CHECK (tokens >= 0),
  refilled_at timestamptz NOT NULL
);

ALTER TABLE workhorse.task
  ADD COLUMN budget_name text CONSTRAINT task_budget_name_check CHECK (
    budget_name IS NULL OR (budget_name <> '' AND octet_length(budget_name) <= 256)
  );
ALTER TABLE workhorse.task_runtime
  ADD COLUMN budget_name text CONSTRAINT task_runtime_budget_name_check CHECK (
    budget_name IS NULL OR (budget_name <> '' AND octet_length(budget_name) <= 256)
  );
CREATE INDEX IF NOT EXISTS task_runtime_active_budget_expiry_idx
  ON workhorse.task_runtime (budget_name, task_id)
  WHERE state = 'active' AND budget_name IS NOT NULL;
CREATE INDEX IF NOT EXISTS task_runtime_ready_budget_queue_idx
  ON workhorse.task_runtime (queue_name, budget_name)
  WHERE state = 'ready' AND budget_name IS NOT NULL;
CREATE INDEX IF NOT EXISTS task_runtime_ready_budget_idx
  ON workhorse.task_runtime (budget_name, queue_name)
  WHERE state = 'ready' AND budget_name IS NOT NULL;

CREATE OR REPLACE FUNCTION workhorse.notify_budget_capacity_v1()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_queue_name text;
BEGIN
  IF OLD.state = 'active'
     AND OLD.budget_name IS NOT NULL
     AND (TG_OP = 'DELETE' OR NEW.state <> 'active')
     AND EXISTS (
       SELECT 1 FROM workhorse.budget budget
        WHERE budget.budget_name = OLD.budget_name
     ) THEN
    FOR v_queue_name IN
      WITH RECURSIVE waiting AS (
        (SELECT runtime.queue_name
           FROM workhorse.task_runtime runtime
          WHERE runtime.state = 'ready' AND runtime.budget_name = OLD.budget_name
          ORDER BY runtime.queue_name
          LIMIT 1)
        UNION ALL
        SELECT (
          SELECT runtime.queue_name
            FROM workhorse.task_runtime runtime
           WHERE runtime.state = 'ready' AND runtime.budget_name = OLD.budget_name
             AND runtime.queue_name > waiting.queue_name
           ORDER BY runtime.queue_name
           LIMIT 1
        )
          FROM waiting
         WHERE waiting.queue_name IS NOT NULL
      )
      SELECT waiting.queue_name FROM waiting WHERE waiting.queue_name IS NOT NULL LIMIT 100
    LOOP
      PERFORM pg_notify('workhorse_tasks', v_queue_name);
    END LOOP;
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

CREATE OR REPLACE TRIGGER task_runtime_budget_capacity_update
AFTER UPDATE OF state ON workhorse.task_runtime
FOR EACH ROW EXECUTE FUNCTION workhorse.notify_budget_capacity_v1();

CREATE OR REPLACE TRIGGER task_runtime_budget_capacity_delete
AFTER DELETE ON workhorse.task_runtime
FOR EACH ROW EXECUTE FUNCTION workhorse.notify_budget_capacity_v1();

CREATE OR REPLACE FUNCTION workhorse.sync_budgets_v1(
  p_namespace text,
  p_definitions jsonb,
  p_prune boolean DEFAULT true
) RETURNS TABLE (
  namespace text,
  budget_name text,
  max_active integer,
  rate_limit integer,
  rate_interval_ms integer,
  rate_burst integer,
  updated_at timestamptz
)
LANGUAGE plpgsql
AS $$
DECLARE
  v_definition jsonb;
  v_rate jsonb;
  v_budget_name text;
  v_max_active numeric;
  v_rate_limit numeric;
  v_rate_interval_ms numeric;
  v_rate_burst numeric;
  v_seen text[] := '{}';
  v_affected text[] := '{}';
  v_queue_name text;
BEGIN
  IF p_namespace IS NULL OR p_namespace = '' OR octet_length(p_namespace) > 256 THEN
    RAISE EXCEPTION 'budget namespace must contain between 1 and 256 UTF-8 bytes';
  END IF;
  IF p_definitions IS NULL OR jsonb_typeof(p_definitions) <> 'array' THEN
    RAISE EXCEPTION 'budget definitions must be a JSON array';
  END IF;
  IF jsonb_array_length(p_definitions) > 10000 THEN
    RAISE EXCEPTION 'budget definitions exceed maximum size of 10000';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('workhorse:budgets', 0));

  FOR v_definition IN SELECT value FROM jsonb_array_elements(p_definitions)
  LOOP
    IF jsonb_typeof(v_definition) <> 'object'
       OR v_definition - ARRAY['name', 'maxActive', 'rate'] <> '{}'::jsonb
       OR NOT (v_definition ? 'name')
       OR jsonb_typeof(v_definition->'name') <> 'string'
       OR (v_definition ? 'maxActive'
         AND v_definition->'maxActive' <> 'null'::jsonb
         AND jsonb_typeof(v_definition->'maxActive') <> 'number')
       OR (v_definition ? 'rate'
         AND v_definition->'rate' <> 'null'::jsonb
         AND jsonb_typeof(v_definition->'rate') <> 'object') THEN
      RAISE EXCEPTION 'each budget requires name, with optional maxActive and rate';
    END IF;
    v_budget_name := v_definition->>'name';
    v_max_active := (v_definition->>'maxActive')::numeric;
    v_rate := CASE WHEN v_definition->'rate' = 'null'::jsonb THEN NULL
      ELSE v_definition->'rate' END;
    IF v_budget_name = '' OR octet_length(v_budget_name) > 256 THEN
      RAISE EXCEPTION 'budget name must contain between 1 and 256 UTF-8 bytes';
    END IF;
    IF v_budget_name = ANY(v_seen) THEN
      RAISE EXCEPTION 'budget names must be unique';
    END IF;
    IF v_max_active IS NULL AND v_rate IS NULL THEN
      RAISE EXCEPTION 'each budget requires maxActive, rate, or both';
    END IF;
    IF v_max_active IS NOT NULL AND (
      v_max_active <> trunc(v_max_active) OR v_max_active NOT BETWEEN 1 AND 1000000
    ) THEN
      RAISE EXCEPTION 'budget maxActive must be an integer between 1 and 1000000';
    END IF;
    IF v_rate IS NOT NULL THEN
      IF v_rate - ARRAY['limit', 'intervalMs', 'burst'] <> '{}'::jsonb
         OR NOT (v_rate ?& ARRAY['limit', 'intervalMs', 'burst'])
         OR jsonb_typeof(v_rate->'limit') <> 'number'
         OR jsonb_typeof(v_rate->'intervalMs') <> 'number'
         OR jsonb_typeof(v_rate->'burst') <> 'number' THEN
        RAISE EXCEPTION 'budget rate requires limit, intervalMs, and burst';
      END IF;
      v_rate_limit := (v_rate->>'limit')::numeric;
      v_rate_interval_ms := (v_rate->>'intervalMs')::numeric;
      v_rate_burst := (v_rate->>'burst')::numeric;
      IF v_rate_limit <> trunc(v_rate_limit) OR v_rate_limit NOT BETWEEN 1 AND 1000000
         OR v_rate_interval_ms <> trunc(v_rate_interval_ms)
         OR v_rate_interval_ms NOT BETWEEN 1 AND 86400000
         OR v_rate_burst <> trunc(v_rate_burst) OR v_rate_burst NOT BETWEEN 1 AND 1000000 THEN
        RAISE EXCEPTION 'budget rate values must be bounded positive integers';
      END IF;
    ELSE
      v_rate_limit := NULL;
      v_rate_interval_ms := NULL;
      v_rate_burst := NULL;
    END IF;
    v_seen := array_append(v_seen, v_budget_name);
    v_affected := array_append(v_affected, v_budget_name);
    IF EXISTS (
      SELECT 1 FROM workhorse.budget budget
       WHERE budget.budget_name = v_budget_name AND budget.namespace <> p_namespace
    ) THEN
      RAISE EXCEPTION 'budget is owned by another namespace';
    END IF;
    INSERT INTO workhorse.budget AS budget(
      budget_name, namespace, max_active, rate_limit, rate_interval_ms, rate_burst, updated_at
    ) VALUES (
      v_budget_name, p_namespace, v_max_active::integer, v_rate_limit::integer,
      v_rate_interval_ms::integer, v_rate_burst::integer, clock_timestamp()
    )
    ON CONFLICT ON CONSTRAINT budget_pkey DO UPDATE SET
      max_active = EXCLUDED.max_active,
      rate_limit = EXCLUDED.rate_limit,
      rate_interval_ms = EXCLUDED.rate_interval_ms,
      rate_burst = EXCLUDED.rate_burst,
      updated_at = CASE
        WHEN budget.max_active IS DISTINCT FROM EXCLUDED.max_active
          OR budget.rate_limit IS DISTINCT FROM EXCLUDED.rate_limit
          OR budget.rate_interval_ms IS DISTINCT FROM EXCLUDED.rate_interval_ms
          OR budget.rate_burst IS DISTINCT FROM EXCLUDED.rate_burst
        THEN EXCLUDED.updated_at ELSE budget.updated_at
      END;
  END LOOP;

  IF p_prune THEN
    v_affected := v_affected || ARRAY(
      SELECT budget.budget_name
        FROM workhorse.budget budget
       WHERE budget.namespace = p_namespace AND NOT (budget.budget_name = ANY(v_seen))
       ORDER BY budget.budget_name
    );
    DELETE FROM workhorse.budget budget
     WHERE budget.namespace = p_namespace AND NOT (budget.budget_name = ANY(v_seen));
  END IF;

  FOR v_queue_name IN
    SELECT DISTINCT runtime.queue_name
      FROM workhorse.task_runtime runtime
     WHERE runtime.state = 'ready' AND runtime.budget_name = ANY(v_affected)
     ORDER BY runtime.queue_name
     LIMIT 100
  LOOP
    PERFORM pg_notify('workhorse_tasks', v_queue_name);
  END LOOP;

  RETURN QUERY
    SELECT budget.namespace, budget.budget_name, budget.max_active, budget.rate_limit,
           budget.rate_interval_ms, budget.rate_burst, budget.updated_at
      FROM workhorse.budget budget
     WHERE budget.namespace = p_namespace
     ORDER BY budget.budget_name;
END;
$$;

CREATE OR REPLACE FUNCTION workhorse.budget_bucket_v1(
  p_budget_name text,
  p_now timestamptz,
  p_consume boolean DEFAULT false
) RETURNS TABLE (allowed boolean, tokens numeric, next_eligible_at timestamptz)
LANGUAGE plpgsql
AS $$
DECLARE
  v_budget workhorse.budget%ROWTYPE;
  v_bucket workhorse.budget_bucket%ROWTYPE;
  v_tokens numeric;
  v_refill_baseline timestamptz;
BEGIN
  IF p_budget_name IS NOT NULL THEN
    SELECT * INTO v_budget FROM workhorse.budget budget WHERE budget.budget_name = p_budget_name;
  END IF;
  IF v_budget.rate_limit IS NULL THEN
    allowed := true; tokens := NULL; next_eligible_at := NULL; RETURN NEXT; RETURN;
  END IF;
  SELECT * INTO v_bucket FROM workhorse.budget_bucket bucket
   WHERE bucket.budget_name = p_budget_name
   FOR UPDATE;
  IF NOT FOUND THEN
    IF NOT p_consume THEN
      allowed := true; tokens := v_budget.rate_burst; next_eligible_at := NULL;
      RETURN NEXT; RETURN;
    END IF;
    INSERT INTO workhorse.budget_bucket(budget_name, tokens, refilled_at)
      VALUES (p_budget_name, v_budget.rate_burst, p_now)
    ON CONFLICT DO NOTHING;
    SELECT * INTO STRICT v_bucket FROM workhorse.budget_bucket bucket
     WHERE bucket.budget_name = p_budget_name
     FOR UPDATE;
  END IF;
  v_tokens := LEAST(
    v_budget.rate_burst::numeric,
    v_bucket.tokens + GREATEST(
      0::numeric,
      extract(epoch FROM p_now - v_bucket.refilled_at) * 1000
    ) * v_budget.rate_limit::numeric / v_budget.rate_interval_ms::numeric
  );
  v_refill_baseline := GREATEST(p_now, v_bucket.refilled_at);
  allowed := v_tokens >= 1;
  IF allowed AND p_consume THEN v_tokens := v_tokens - 1; END IF;
  tokens := v_tokens;
  next_eligible_at := CASE WHEN allowed THEN p_now ELSE v_refill_baseline + make_interval(
    secs => CEIL(
      (1 - v_tokens) * v_budget.rate_interval_ms::numeric / v_budget.rate_limit::numeric
    )::double precision / 1000
  ) END;
  IF p_consume THEN
    UPDATE workhorse.budget_bucket bucket
       SET tokens = v_tokens, refilled_at = v_refill_baseline
     WHERE bucket.budget_name = p_budget_name;
  END IF;
  RETURN NEXT;
END;
$$;

CREATE OR REPLACE FUNCTION workhorse.budget_admission_v1(
  p_budget_name text,
  p_now timestamptz
) RETURNS boolean
LANGUAGE plpgsql
AS $$
DECLARE
  v_budget workhorse.budget%ROWTYPE;
  v_active integer;
  v_status record;
BEGIN
  IF p_budget_name IS NULL THEN RETURN true; END IF;
  SELECT * INTO v_budget FROM workhorse.budget budget WHERE budget.budget_name = p_budget_name;
  IF NOT FOUND THEN RETURN true; END IF;
  IF v_budget.max_active IS NOT NULL THEN
    SELECT count(*)::integer INTO v_active
      FROM workhorse.task_runtime active
     WHERE active.state = 'active'
       AND active.budget_name = p_budget_name
       AND active.expires_at > p_now;
    IF v_active >= v_budget.max_active THEN RETURN false; END IF;
  END IF;
  IF v_budget.rate_limit IS NOT NULL THEN
    SELECT * INTO STRICT v_status FROM workhorse.budget_bucket_v1(p_budget_name, p_now, false);
    IF NOT v_status.allowed THEN RETURN false; END IF;
  END IF;
  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION workhorse.budget_status_v1(p_budget_names text[])
RETURNS TABLE (
  namespace text,
  budget_name text,
  max_active integer,
  rate_limit integer,
  rate_interval_ms integer,
  rate_burst integer,
  updated_at timestamptz,
  active text,
  available_tokens text,
  saturated boolean,
  blocked_ready text,
  next_eligible_at timestamptz,
  sample_capped boolean,
  budget_set_capped boolean
)
LANGUAGE sql
STABLE
AS $$
  WITH observed AS (
    SELECT clock_timestamp() AS now
  ), budgets AS MATERIALIZED (
    SELECT budget.* FROM workhorse.budget budget
     WHERE cardinality(COALESCE(p_budget_names, '{}')) = 0
        OR budget.budget_name = ANY(p_budget_names)
     ORDER BY budget.budget_name LIMIT 101
  ), status AS (
    SELECT budget.*, observed.now,
           GREATEST(observed.now, COALESCE(bucket.refilled_at, observed.now)) AS refill_baseline,
           CASE WHEN budget.rate_limit IS NULL THEN NULL ELSE LEAST(
             budget.rate_burst::numeric,
             COALESCE(
               bucket.tokens + GREATEST(
                 0::numeric,
                 extract(epoch FROM observed.now - bucket.refilled_at) * 1000
               ) * budget.rate_limit::numeric / budget.rate_interval_ms::numeric,
               budget.rate_burst::numeric
             )
           ) END AS available_tokens,
           (SELECT count(*)::integer
              FROM workhorse.task_runtime active
             WHERE active.state = 'active'
               AND active.budget_name = budget.budget_name
               AND active.expires_at > observed.now) AS active
      FROM budgets budget CROSS JOIN observed
      LEFT JOIN workhorse.budget_bucket bucket ON bucket.budget_name = budget.budget_name
  ), evaluated AS (
    SELECT status.*,
           (status.max_active IS NOT NULL AND status.active >= status.max_active)
             OR (status.available_tokens IS NOT NULL AND status.available_tokens < 1)
             AS saturated
      FROM status
  )
  SELECT budget.namespace, budget.budget_name, budget.max_active, budget.rate_limit,
         budget.rate_interval_ms, budget.rate_burst, budget.updated_at,
         budget.active::text,
         budget.available_tokens::text,
         budget.saturated,
         CASE WHEN budget.saturated THEN waiting.sampled ELSE 0 END::text AS blocked_ready,
         CASE WHEN budget.available_tokens < 1 THEN budget.refill_baseline + make_interval(
           secs => CEIL(
             (1 - budget.available_tokens) * budget.rate_interval_ms::numeric
             / budget.rate_limit::numeric
           )::double precision / 1000
         ) END AS next_eligible_at,
         waiting.sampled > 100 AS sample_capped,
         (SELECT count(*) FROM budgets) > 100 AS budget_set_capped
    FROM evaluated budget
    CROSS JOIN LATERAL (
      SELECT count(*)::integer AS sampled
        FROM (
          SELECT runtime.task_id
            FROM workhorse.task_runtime runtime
           WHERE runtime.state = 'ready' AND runtime.budget_name = budget.budget_name
           LIMIT 101
        ) sample
    ) waiting
   ORDER BY budget.budget_name
   LIMIT 100;
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
  v_proposed_task_id uuid;
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
    v_prerequisite_task_id := CASE
      WHEN v_dependencies IS NULL OR v_dependencies = 'null'::jsonb
        THEN NULLIF(v_request->>'prerequisiteTaskId', '')::uuid
      ELSE NULL
    END;
    IF cardinality(v_prerequisite_task_ids) <> (
      SELECT count(DISTINCT prerequisite_id) FROM unnest(v_prerequisite_task_ids) prerequisite_id
    ) THEN
      RAISE EXCEPTION 'dependency prerequisiteTaskIds must be unique';
    END IF;
    PERFORM 1 FROM workhorse.task prerequisite
     WHERE prerequisite.id = ANY(v_prerequisite_task_ids)
     ORDER BY prerequisite.id FOR UPDATE;
    GET DIAGNOSTICS v_pending_prerequisites = ROW_COUNT;
    IF v_pending_prerequisites <> cardinality(v_prerequisite_task_ids) THEN
      RAISE EXCEPTION 'prerequisite task does not exist';
    END IF;
    SELECT count(*)::integer INTO v_pending_prerequisites
      FROM unnest(v_prerequisite_task_ids) prerequisite_id
      LEFT JOIN workhorse.task_outcome outcome ON outcome.task_id = prerequisite_id
     WHERE outcome.task_id IS NULL;
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

    IF v_is_new THEN
      INSERT INTO workhorse.task(
        id, queue_name, task_type, concurrency_key, priority, payload, contract_version,
        payload_max_bytes, result_max_bytes,
        payload_redact_keys, result_redact_keys, trace_context, tags, max_attempts, retry_policy,
        deadline_at, execution_timeout_ms, budget_name
      ) VALUES (
        task_id, v_queue_name, v_task_type, v_concurrency_key, v_priority::integer, v_payload, v_contract_version,
        v_payload_max_bytes::integer, v_result_max_bytes::integer,
        v_payload_redact_keys, v_result_redact_keys, v_trace_context, v_tags,
        v_max_attempts, v_retry_policy,
        v_deadline_at, v_execution_timeout_ms::bigint, v_budget_name
      );
      INSERT INTO workhorse.task_runtime(
        task_id, queue_name, concurrency_key, priority, state, current_attempt, run_at, ready_at, sequence,
        deadline_at, budget_name
      ) VALUES (
        task_id, v_queue_name, v_concurrency_key, v_priority::integer, v_state, 1, v_run_at,
        CASE WHEN v_state = 'ready' THEN v_now END,
        CASE WHEN v_state = 'ready' THEN nextval('workhorse.ready_sequence_seq') END,
        v_deadline_at, v_budget_name
      );
      WITH prerequisites AS MATERIALIZED (
        SELECT input.prerequisite_task_id, outcome.state,
               outcome.state IS NOT NULL AND (
                 (outcome.state = 'succeeded' AND v_on_success = 'release')
                 OR (outcome.state = 'failed' AND v_on_failure = 'release')
                 OR (outcome.state = 'canceled' AND v_on_cancellation = 'release')
               ) AS releases_immediately
          FROM unnest(v_prerequisite_task_ids) input(prerequisite_task_id)
          LEFT JOIN workhorse.task_outcome outcome
            ON outcome.task_id = input.prerequisite_task_id
      ), inserted_edges AS (
        INSERT INTO workhorse.task_dependency(
          dependent_task_id, prerequisite_task_id, on_success, on_failure, on_cancellation,
          created_at, released_at, resolution
        )
        SELECT task_id, prerequisites.prerequisite_task_id,
               v_on_success, v_on_failure, v_on_cancellation, v_now,
               CASE WHEN prerequisites.releases_immediately THEN v_now END,
               CASE WHEN prerequisites.releases_immediately THEN 'release' END
          FROM prerequisites
        RETURNING prerequisite_task_id, released_at
      )
      INSERT INTO workhorse.task_event(task_id, event_type, details)
      SELECT task_id,
             CASE WHEN inserted_edges.released_at IS NOT NULL
               THEN 'dependency_released' ELSE 'dependency_blocked' END,
             jsonb_build_object(
               'prerequisite_task_id', inserted_edges.prerequisite_task_id,
               'state', v_state,
               'reason', CASE
                 WHEN NOT prerequisites.releases_immediately THEN 'prerequisite_pending'
                 WHEN prerequisites.state = 'succeeded' THEN 'prerequisite_already_succeeded'
                 ELSE 'prerequisite_terminal_policy'
               END
             )
        FROM inserted_edges
        JOIN prerequisites USING (prerequisite_task_id);
      FOR v_terminal IN
        SELECT outcome.task_id, outcome.state FROM workhorse.task_outcome outcome
         WHERE outcome.task_id = ANY(v_prerequisite_task_ids)
         ORDER BY outcome.task_id
      LOOP
        PERFORM workhorse.resolve_dependents_v1(v_terminal.task_id, v_terminal.state);
      END LOOP;
      INSERT INTO workhorse.task_event(task_id, event_type, details)
        VALUES (
          task_id,
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
        PERFORM workhorse.terminalize_deadline_v1(task_id);
      ELSIF v_state = 'ready' AND NOT v_queue_name = ANY(v_ready_queues) THEN
        v_ready_queues := array_append(v_ready_queues, v_queue_name);
      END IF;
    END IF;
    ordinal := v_ordinal;
    accepted := v_is_new;
    RETURN NEXT;
  END LOOP;

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
       OR v_runtime.state NOT IN ('ready', 'scheduled') THEN
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
      'runAt', to_jsonb(v_run_at),
      'deadline', to_jsonb((v_normalized->>'deadline')::timestamptz),
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

CREATE OR REPLACE FUNCTION workhorse.redrive_v1(
  p_source_task_id uuid,
  p_requested_by text,
  p_reason text,
  p_request_id text
) RETURNS TABLE (
  status text, source_task_id uuid, target_task_id uuid, source_state text,
  target_state text, requested_at timestamptz
)
LANGUAGE plpgsql
AS $$
DECLARE
  v_task workhorse.task%ROWTYPE;
  v_outcome workhorse.task_outcome%ROWTYPE;
  v_existing workhorse.task_redrive%ROWTYPE;
  v_fingerprint jsonb;
  v_conflicting_fields text[];
  v_request_id_hash bytea;
  v_request_id_preview text;
  v_request_id_digest text;
  v_request_id_length integer;
  v_now timestamptz := clock_timestamp();
BEGIN
  IF p_source_task_id IS NULL THEN RAISE EXCEPTION 'source_task_id is required'; END IF;
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
    'workhorse:redrive:' || p_source_task_id::text || ':' || p_request_id, 0
  ));

  SELECT * INTO v_existing FROM workhorse.task_redrive redrive
   WHERE redrive.source_task_id = p_source_task_id
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
          'sourceTaskId', p_source_task_id,
          'existingTargetTaskId', v_existing.target_task_id,
          'requestIdPreview', v_request_id_preview,
          'requestIdDigest', v_request_id_digest,
          'requestIdLength', v_request_id_length,
          'conflictingFields', to_jsonb(v_conflicting_fields),
          'storedRequestDigest', workhorse.sha256_hex_v1(v_existing.request_fingerprint::text),
          'rejectedRequestDigest', workhorse.sha256_hex_v1(v_fingerprint::text)
        )::text;
    END IF;
    RETURN QUERY
    SELECT 'replayed'::text, p_source_task_id, v_existing.target_task_id,
           'failed'::text,
           COALESCE(runtime.state, outcome.state), v_existing.requested_at
      FROM (VALUES (1)) singleton(value)
      LEFT JOIN workhorse.task_runtime runtime ON runtime.task_id = v_existing.target_task_id
      LEFT JOIN workhorse.task_outcome outcome ON outcome.task_id = v_existing.target_task_id;
    RETURN;
  END IF;

  SELECT task.* INTO v_task FROM workhorse.task task
   WHERE task.id = p_source_task_id FOR KEY SHARE;
  IF NOT FOUND THEN
    RETURN QUERY VALUES ('not_found'::text, p_source_task_id, NULL::uuid, NULL::text, NULL::text, NULL::timestamptz);
    RETURN;
  END IF;
  SELECT outcome.* INTO v_outcome FROM workhorse.task_outcome outcome
   WHERE outcome.task_id = p_source_task_id FOR SHARE;
  IF NOT FOUND OR v_outcome.state <> 'failed' THEN
    RETURN QUERY VALUES (
      'not_failed'::text, p_source_task_id, NULL::uuid,
      COALESCE(v_outcome.state, (SELECT runtime.state FROM workhorse.task_runtime runtime
                                 WHERE runtime.task_id = p_source_task_id)),
      NULL::text, NULL::timestamptz
    );
    RETURN;
  END IF;

  target_task_id := gen_random_uuid();
  INSERT INTO workhorse.task(
    id, queue_name, task_type, concurrency_key, priority, payload, contract_version,
    payload_max_bytes, result_max_bytes,
    payload_redact_keys, result_redact_keys, tags, max_attempts, retry_policy,
    deadline_at, execution_timeout_ms, budget_name
  ) VALUES (
    target_task_id, v_task.queue_name, v_task.task_type, v_task.concurrency_key, v_task.priority,
    v_task.payload, v_task.contract_version,
    v_task.payload_max_bytes, v_task.result_max_bytes,
    v_task.payload_redact_keys, v_task.result_redact_keys, v_task.tags,
    v_task.max_attempts, v_task.retry_policy, NULL, v_task.execution_timeout_ms, v_task.budget_name
  );
  INSERT INTO workhorse.task_runtime(
    task_id, queue_name, concurrency_key, priority, state, current_attempt, run_at, ready_at, sequence,
    deadline_at, budget_name
  ) VALUES (
    target_task_id, v_task.queue_name, v_task.concurrency_key, v_task.priority, 'ready', 1, v_now, v_now,
    nextval('workhorse.ready_sequence_seq'), NULL, v_task.budget_name
  );
  INSERT INTO workhorse.task_redrive(
    source_task_id, target_task_id, request_id_hash, request_id_preview,
    request_id_digest, request_id_length, requested_by, reason,
    request_fingerprint, source_state, target_initial_state, requested_at
  ) VALUES (
    p_source_task_id, target_task_id, v_request_id_hash, v_request_id_preview,
    v_request_id_digest, v_request_id_length, p_requested_by, p_reason,
    v_fingerprint, 'failed', 'ready', v_now
  );
  -- The history foreign key keeps the source identity while this event is retained. Semantic
  -- terminal evidence and its materialization watermark remain immutable.
  INSERT INTO workhorse.task_event(task_id, attempt, event_type, details)
    VALUES (p_source_task_id, v_outcome.current_attempt, 'redriven', jsonb_build_object(
      'target_task_id', target_task_id,
      'request_id_preview', v_request_id_preview,
      'request_id_digest', v_request_id_digest,
      'request_id_length', v_request_id_length,
      'requested_by', p_requested_by, 'reason', p_reason, 'requested_at', v_now
    ));
  INSERT INTO workhorse.task_event(task_id, attempt, event_type, details)
    VALUES (target_task_id, 1, 'redrive_created', jsonb_build_object(
      'source_task_id', p_source_task_id,
      'request_id_preview', v_request_id_preview,
      'request_id_digest', v_request_id_digest,
      'request_id_length', v_request_id_length,
      'requested_by', p_requested_by, 'reason', p_reason, 'requested_at', v_now,
      'state', 'ready', 'priority', v_task.priority
    ));
  PERFORM pg_notify('workhorse_tasks', v_task.queue_name);
  RETURN QUERY VALUES (
    'redriven'::text, p_source_task_id, target_task_id, 'failed'::text, 'ready'::text, v_now
  );
END;
$$;

CREATE OR REPLACE FUNCTION workhorse.claim_v1(
  p_queue_name text,
  p_worker_id text,
  p_lease_ms integer DEFAULT 30000
) RETURNS TABLE (
  task_id uuid, task_type text, priority integer, payload jsonb, contract_version text, result_max_bytes integer,
  redact_error_details boolean,
  trace_context jsonb,
  attempt integer, max_attempts integer,
  retry_policy jsonb, deadline_at timestamptz, execution_timeout_ms bigint,
  attempt_timeout_at timestamptz, fence_token bigint, lease_expires_at timestamptz
)
LANGUAGE plpgsql
AS $$
DECLARE
  v_runtime workhorse.task_runtime%ROWTYPE;
  v_policy workhorse.concurrency_policy%ROWTYPE;
  v_rate_policy workhorse.rate_limit_policy%ROWTYPE;
  v_rate_status record;
  v_active integer;
  v_budgeted boolean;
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
  -- Budget admission counts across queues, so claims that can admit budget-named work serialize
  -- on one lock. A queue without budget-named ready work never takes it.
  SELECT EXISTS (
    SELECT 1 FROM workhorse.task_runtime waiting
     WHERE waiting.state = 'ready' AND waiting.queue_name = p_queue_name
       AND waiting.budget_name IS NOT NULL
  ) INTO v_budgeted;
  IF v_budgeted THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('workhorse:budgets', 0));
  END IF;
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
      FROM workhorse.task_runtime active
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
    SELECT runtime.task_id, runtime.concurrency_key, runtime.budget_name, runtime.priority,
           runtime.sequence
      FROM workhorse.task_runtime runtime
      JOIN workhorse.task task ON task.id = runtime.task_id
     WHERE runtime.state = 'ready' AND runtime.queue_name = p_queue_name
       AND (runtime.deadline_at IS NULL OR runtime.deadline_at > v_now)
       AND (task.execution_timeout_ms IS NULL
         OR runtime.execution_used_ms < task.execution_timeout_ms)
       AND NOT EXISTS (
         SELECT 1 FROM workhorse.queue_control control
          WHERE control.queue_name = p_queue_name AND control.paused
       )
     ORDER BY runtime.priority DESC, runtime.sequence, runtime.task_id
     FOR UPDATE OF runtime SKIP LOCKED
     LIMIT CASE
       WHEN v_policy.queue_name IS NULL AND v_rate_policy.per_key_limit IS NULL
         AND NOT v_budgeted THEN 1
       ELSE 100
     END
  ), candidate AS (
    SELECT ready.task_id
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
            FROM workhorse.task_runtime active
           WHERE active.state = 'active'
             AND active.queue_name = p_queue_name
             AND active.concurrency_key = ready.concurrency_key
             AND active.expires_at > v_now
        ) < v_policy.max_active_per_key
     ) AND keyed_rate.allowed
       AND workhorse.budget_admission_v1(ready.budget_name, v_now)
     ORDER BY ready.priority DESC, ready.sequence, ready.task_id
     LIMIT 1
  )
  UPDATE workhorse.task_runtime runtime
     SET state = 'active', fence_token = v_fence, worker_id = p_worker_id,
         acquired_at = v_now, heartbeat_at = v_now, expires_at = v_expires,
         ready_at = NULL, sequence = NULL, wait_name = NULL,
         attempt_started_at = COALESCE(runtime.attempt_started_at, v_now),
         attempt_timeout_at = CASE
           WHEN task.execution_timeout_ms IS NULL THEN NULL
           ELSE v_now + make_interval(secs =>
             (task.execution_timeout_ms - runtime.execution_used_ms)::double precision / 1000.0)
         END,
         error = NULL, updated_at = v_now
    FROM candidate, workhorse.task task
   WHERE runtime.task_id = candidate.task_id AND runtime.state = 'ready' AND task.id = runtime.task_id
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
  IF v_runtime.budget_name IS NOT NULL THEN
    PERFORM * FROM workhorse.budget_bucket_v1(v_runtime.budget_name, v_now, true);
  END IF;

  INSERT INTO workhorse.task_event(task_id, attempt, event_type, details)
    VALUES (v_runtime.task_id, v_runtime.current_attempt, 'claimed',
      jsonb_build_object('worker_id', p_worker_id, 'fence_token', v_fence::text, 'expires_at', v_expires));
  RETURN QUERY
    SELECT task.id, task.task_type, task.priority, task.payload, task.contract_version, task.result_max_bytes,
           cardinality(task.payload_redact_keys) > 0 OR cardinality(task.result_redact_keys) > 0,
           task.trace_context,
           v_runtime.current_attempt, task.max_attempts,
           task.retry_policy, task.deadline_at, task.execution_timeout_ms,
           v_runtime.attempt_timeout_at, v_fence, v_expires
      FROM workhorse.task task WHERE task.id = v_runtime.task_id;
END;
$$;

CREATE OR REPLACE FUNCTION workhorse.evaluate_queue_health_v1(
  p_snapshot jsonb, p_policy jsonb
) RETURNS jsonb
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  WITH reasons AS (
    SELECT 10 AS position, jsonb_build_object(
      'code', 'expired-leases', 'severity', 'critical',
      'observed', (p_snapshot->>'expired')::numeric, 'budget', 0
    ) AS reason
    WHERE (p_snapshot->>'expired')::numeric > 0
    UNION ALL
    SELECT 20, jsonb_build_object(
      'code', 'overdue-deadlines', 'severity', 'critical',
      'observed', (p_snapshot->>'overdue_deadlines')::numeric, 'budget', 0
    ) WHERE (p_snapshot->>'overdue_deadlines')::numeric > 0
    UNION ALL
    SELECT 30, jsonb_build_object(
      'code', 'overdue-execution-timeouts', 'severity', 'critical',
      'observed', (p_snapshot->>'overdue_execution_timeouts')::numeric, 'budget', 0
    ) WHERE (p_snapshot->>'overdue_execution_timeouts')::numeric > 0
    UNION ALL
    SELECT 40, jsonb_build_object(
      'code', 'overdue-external-waits', 'severity', 'critical',
      'observed', (p_snapshot->>'overdue_external_waits')::numeric, 'budget', 0
    ) WHERE (p_snapshot->>'overdue_external_waits')::numeric > 0
    UNION ALL
    SELECT 50, jsonb_build_object(
      'code', 'stalled-promotion', 'severity', 'critical',
      'observed', (p_snapshot->>'oldest_overdue_scheduled_age_ms')::numeric,
      'budget', (p_policy->>'promotion_lag_ms')::numeric
    ) WHERE p_snapshot->>'oldest_overdue_scheduled_age_ms' IS NOT NULL
      AND (p_snapshot->>'oldest_overdue_scheduled_age_ms')::numeric
        > (p_policy->>'promotion_lag_ms')::numeric
    UNION ALL
    SELECT 60, jsonb_build_object(
      'code', 'missing-history-partitions', 'severity', 'critical',
      'observed', missing.count, 'budget', 0
    ) FROM (
      SELECT count(*) FILTER (WHERE NOT value->>'has_task_events' = 'true')
           + count(*) FILTER (WHERE NOT value->>'has_attempt_history' = 'true') AS count
        FROM jsonb_array_elements(p_snapshot->'history_partition_days') value
    ) missing WHERE missing.count > 0
    UNION ALL
    SELECT 100, jsonb_build_object(
      'code', 'rollup-stalled', 'severity', 'degraded',
      'observed', (p_snapshot->>'rollup_lag_ms')::numeric,
      'budget', (p_policy->>'rollup_stalled_lag_ms')::numeric
    ) WHERE (p_snapshot->>'rollup_lag_ms')::numeric
      > (p_policy->>'rollup_stalled_lag_ms')::numeric
    UNION ALL
    SELECT 110 + retention.position, jsonb_build_object(
      'code', 'retention-lag', 'severity', 'degraded',
      'observed', retention.observed_text::numeric,
      'budget', retention.budget_text::numeric,
      'category', retention.category
    ) FROM (
      VALUES
        (1, 'taskIdentity', p_snapshot->>'task_identity_lag_ms',
          p_policy->>'row_retention_lag_ms'),
        (2, 'terminalOutcome', p_snapshot->>'terminal_outcome_lag_ms',
          p_policy->>'row_retention_lag_ms'),
        (3, 'taskEvents', p_snapshot->>'task_event_lag_ms',
          p_policy->>'partition_retention_lag_ms'),
        (4, 'attemptHistory', p_snapshot->>'attempt_history_lag_ms',
          p_policy->>'partition_retention_lag_ms'),
        (5, 'scheduleOccurrences', p_snapshot->>'schedule_occurrence_lag_ms',
          p_policy->>'row_retention_lag_ms'),
        (6, 'statistics', p_snapshot->>'statistics_lag_ms',
          p_policy->>'row_retention_lag_ms')
    ) retention(position, category, observed_text, budget_text)
    WHERE retention.observed_text IS NOT NULL
      AND retention.observed_text::numeric > retention.budget_text::numeric
    UNION ALL
    SELECT 130, jsonb_build_object(
      'code', 'eligible-history-partitions', 'severity', 'degraded',
      'observed', (p_snapshot->>'eligible_event_partitions')::numeric
        + (p_snapshot->>'eligible_attempt_partitions')::numeric,
      'budget', (p_policy->>'eligible_history_partitions')::numeric
    ) WHERE (p_snapshot->>'eligible_event_partitions')::numeric
        + (p_snapshot->>'eligible_attempt_partitions')::numeric
      > (p_policy->>'eligible_history_partitions')::numeric
    UNION ALL
    SELECT 140, jsonb_build_object(
      'code', 'default-history-rows', 'severity', 'degraded',
      'observed', (p_snapshot->>'default_event_rows')::numeric
        + (p_snapshot->>'default_attempt_rows')::numeric,
      'budget', 0
    ) WHERE (p_snapshot->>'default_event_rows')::numeric
        + (p_snapshot->>'default_attempt_rows')::numeric > 0
    UNION ALL
    SELECT 200 + admission.ordinality::integer, jsonb_build_object(
      'code', 'concurrency-blocked', 'severity', 'degraded',
      'observed', (admission.value->>'blocked_ready')::numeric,
      'budget', 0, 'queue', admission.value->>'queue_name'
    ) FROM jsonb_array_elements(p_snapshot->'concurrency_policies')
      WITH ORDINALITY admission(value, ordinality)
    WHERE (admission.value->>'blocked_ready')::numeric > 0
    UNION ALL
    SELECT 400 + admission.ordinality::integer, jsonb_build_object(
      'code', 'rate-limit-throttled', 'severity', 'degraded',
      'observed', (admission.value->>'throttled_ready')::numeric,
      'budget', 0, 'queue', admission.value->>'queue_name'
    ) FROM jsonb_array_elements(p_snapshot->'rate_limit_policies')
      WITH ORDINALITY admission(value, ordinality)
    WHERE (admission.value->>'throttled_ready')::numeric > 0
    UNION ALL
    SELECT 600 + admission.ordinality::integer, jsonb_build_object(
      'code', 'budget-blocked', 'severity', 'degraded',
      'observed', (admission.value->>'blocked_ready')::numeric,
      'budget', 0, 'budgetName', admission.value->>'budget_name'
    ) FROM jsonb_array_elements(COALESCE(p_snapshot->'budget_policies', '[]'::jsonb))
      WITH ORDINALITY admission(value, ordinality)
    WHERE (admission.value->>'blocked_ready')::numeric > 0
  ), aggregate AS (
    SELECT COALESCE(jsonb_agg(reason ORDER BY position), '[]'::jsonb) AS reasons,
           bool_or(reason->>'severity' = 'critical') AS critical,
           count(*) > 0 AS unhealthy
      FROM reasons
  )
  SELECT jsonb_build_object(
    'level', CASE WHEN critical THEN 'critical' WHEN unhealthy THEN 'degraded' ELSE 'healthy' END,
    'reasons', reasons
  ) FROM aggregate;
$$;

CREATE OR REPLACE FUNCTION workhorse.queue_health_v1(
  p_rejected_since timestamptz DEFAULT clock_timestamp() - interval '1 day'
) RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
AS $$
DECLARE
  v_document jsonb;
  v_observations jsonb;
BEGIN
  SELECT to_jsonb(snapshot) || jsonb_build_object(
           'status', workhorse.evaluate_queue_health_v1(to_jsonb(snapshot), to_jsonb(policy)),
           'budgets', jsonb_build_object(
             'promotionLagMs', policy.promotion_lag_ms,
             'rollupStalledLagMs', policy.rollup_stalled_lag_ms,
             'rowRetentionLagMs', policy.row_retention_lag_ms,
             'partitionRetentionLagMs', policy.partition_retention_lag_ms,
             'eligibleHistoryPartitions', policy.eligible_history_partitions
           )
         )
    INTO v_document
    FROM (
      WITH installed AS (
          SELECT CASE
                   WHEN count(*) = 1
                    AND min(version) = max(version)
                    AND NOT EXISTS (
                      SELECT 1
                        FROM unnest(ARRAY['task_current', 'ready_task', 'scheduled_task', 'lease'])
                          AS legacy(relation_name)
                       WHERE to_regclass(format('workhorse.%I', relation_name)) IS NOT NULL
                    )
                   THEN min(version)::integer
                   ELSE NULL
                 END AS schema_version
            FROM workhorse.schema_version
        ), depth AS (
          SELECT count(runtime.task_id) FILTER (WHERE runtime.state = 'blocked')::text AS blocked,
               count(runtime.task_id) FILTER (WHERE runtime.state = 'ready')::text AS ready,
               count(runtime.task_id) FILTER (WHERE runtime.state = 'scheduled')::text AS scheduled,
               count(runtime.task_id) FILTER (
             WHERE runtime.state = 'scheduled' AND runtime.wait_name IS NOT NULL
               AND EXISTS (
                 SELECT 1 FROM workhorse.task_wait timer
                  WHERE timer.task_id = runtime.task_id AND timer.wait_name = runtime.wait_name
               )
           )::text AS sleeping,
               count(runtime.task_id) FILTER (
             WHERE runtime.state = 'scheduled' AND runtime.wait_name IS NOT NULL
               AND EXISTS (
                 SELECT 1 FROM workhorse.task_wait timer
                  WHERE timer.task_id = runtime.task_id AND timer.wait_name = runtime.wait_name
               )
               AND runtime.run_at <= clock_timestamp()
           )::text AS overdue_waits,
               min(runtime.run_at) FILTER (
             WHERE runtime.state = 'scheduled' AND runtime.wait_name IS NOT NULL
               AND EXISTS (
                 SELECT 1 FROM workhorse.task_wait timer
                  WHERE timer.task_id = runtime.task_id AND timer.wait_name = runtime.wait_name
               )
           ) AS next_wake_at,
               count(runtime.task_id) FILTER (WHERE runtime.state = 'active')::text AS active,
               count(runtime.task_id) FILTER (
             WHERE runtime.state = 'active' AND runtime.expires_at <= clock_timestamp()
           )::text AS expired,
               extract(epoch FROM clock_timestamp() - min(runtime.ready_at) FILTER (
             WHERE runtime.state = 'ready'
           )) * 1000 AS oldest_ready_age_ms,
               count(runtime.task_id) FILTER (
             WHERE runtime.state = 'scheduled' AND runtime.run_at <= clock_timestamp()
           )::text AS overdue_scheduled,
               extract(epoch FROM clock_timestamp() - min(runtime.run_at) FILTER (
             WHERE runtime.state = 'scheduled' AND runtime.run_at <= clock_timestamp()
           )) * 1000 AS oldest_overdue_scheduled_age_ms,
               count(runtime.task_id) FILTER (WHERE runtime.deadline_at IS NOT NULL)::text AS pending_deadlines,
               count(runtime.task_id) FILTER (
             WHERE runtime.deadline_at IS NOT NULL AND runtime.deadline_at <= clock_timestamp()
           )::text AS overdue_deadlines,
               count(runtime.task_id) FILTER (
             WHERE runtime.deadline_at > clock_timestamp()
               AND runtime.deadline_at <= clock_timestamp() + interval '1 minute'
           )::text AS deadlines_due_within_minute,
               min(runtime.deadline_at) AS earliest_deadline_at,
               count(runtime.task_id) FILTER (
             WHERE runtime.state = 'active' AND runtime.attempt_timeout_at IS NOT NULL
           )::text AS active_execution_timeouts,
               count(runtime.task_id) FILTER (
             WHERE runtime.state = 'active' AND runtime.attempt_timeout_at <= clock_timestamp()
           )::text AS overdue_execution_timeouts
            FROM workhorse.task_runtime runtime
        ), terminal AS (
          -- Terminal history is unbounded, so its counts stop scanning at the cap. Live-state counts
          -- come from depth and stay exact; claim-shaped work never pays for lifetime history here.
          SELECT count(*) FILTER (WHERE state = 'succeeded')::text AS succeeded_count,
                 count(*) FILTER (WHERE state = 'failed')::text AS failed_count,
                 count(*) FILTER (WHERE state = 'canceled')::text AS canceled_count,
                 count(*) > 100000 AS terminal_counts_capped
            FROM (SELECT state FROM workhorse.task_outcome LIMIT 100001)
              sampled_outcomes
        ), retention AS (
          -- The LIMIT 1 clauses on the singleton CTEs here and below are planner facts, not semantics:
          -- without them each CTE gets a default multi-hundred-row estimate, the cross joins multiply
          -- into a cost that trips JIT compilation, and compiling this statement costs a full second.
          WITH policy AS (
            SELECT * FROM workhorse.retention_policy WHERE singleton LIMIT 1
          ), boundaries AS (
            SELECT
              (SELECT task.created_at
                 FROM workhorse.task task
                 JOIN workhorse.task_outcome outcome ON outcome.task_id = task.id
                ORDER BY task.created_at, task.id LIMIT 1)
                AS oldest_task_identity_at,
              (SELECT finished_at FROM workhorse.task_outcome ORDER BY finished_at, task_id LIMIT 1)
                AS oldest_terminal_outcome_at,
              (SELECT task.created_at
                 FROM workhorse.task task
                 JOIN workhorse.task_outcome outcome ON outcome.task_id = task.id
                WHERE policy.task_identity_retention_days IS NOT NULL
                  AND policy.terminal_outcome_retention_days IS NOT NULL
                  AND task.created_at < clock_timestamp()
                    - make_interval(days => policy.task_identity_retention_days)
                  AND outcome.finished_at < clock_timestamp()
                    - make_interval(days => policy.terminal_outcome_retention_days)
                ORDER BY task.created_at, task.id LIMIT 1)
                AS eligible_task_identity_at,
              (SELECT outcome.finished_at
                 FROM workhorse.task task
                 JOIN workhorse.task_outcome outcome ON outcome.task_id = task.id
                WHERE policy.task_identity_retention_days IS NOT NULL
                  AND policy.terminal_outcome_retention_days IS NOT NULL
                  AND task.created_at < clock_timestamp()
                    - make_interval(days => policy.task_identity_retention_days)
                  AND outcome.finished_at < clock_timestamp()
                    - make_interval(days => policy.terminal_outcome_retention_days)
                ORDER BY outcome.finished_at, outcome.task_id LIMIT 1)
                AS eligible_terminal_outcome_at,
              (SELECT occurred_at FROM workhorse.task_event ORDER BY occurred_at, event_id LIMIT 1)
                AS oldest_task_event_at,
              (SELECT occurred_at FROM workhorse.task_event
                WHERE tableoid <> 'workhorse.task_event_default'::regclass
                ORDER BY occurred_at, event_id LIMIT 1) AS oldest_partitioned_task_event_at,
              (SELECT occurred_at FROM workhorse.task_event_default
                ORDER BY occurred_at, event_id LIMIT 1) AS oldest_default_task_event_at,
              (SELECT occurred_at FROM workhorse.attempt_history ORDER BY occurred_at, attempt_id LIMIT 1)
                AS oldest_attempt_history_at,
              (SELECT occurred_at FROM workhorse.attempt_history
                WHERE tableoid <> 'workhorse.attempt_history_default'::regclass
                ORDER BY occurred_at, attempt_id LIMIT 1) AS oldest_partitioned_attempt_history_at,
              (SELECT occurred_at FROM workhorse.attempt_history_default
                ORDER BY occurred_at, attempt_id LIMIT 1) AS oldest_default_attempt_history_at,
              (SELECT occurrence_at FROM workhorse.schedule_occurrence ORDER BY occurrence_at LIMIT 1)
                AS oldest_schedule_occurrence_at,
              (SELECT min(bucket_start) FROM (
                 SELECT bucket_start FROM workhorse.task_stat_bucket
                 UNION ALL SELECT bucket_start FROM workhorse.task_stat_bucket_hour
                 UNION ALL SELECT bucket_start FROM workhorse.task_stat_bucket_day
               ) statistic_tiers) AS oldest_statistics_at
            FROM policy
          ), partitions AS (
            SELECT parent.relname AS parent_name,
                   ((regexp_match(
                     pg_get_expr(child.relpartbound, child.oid),
                     'TO \(''([^'']+)''\)'
                   ))[1])::timestamptz AS upper_bound
              FROM pg_inherits inheritance
              JOIN pg_class parent ON parent.oid = inheritance.inhparent
              JOIN pg_namespace namespace ON namespace.oid = parent.relnamespace
              JOIN pg_class child ON child.oid = inheritance.inhrelid
             WHERE namespace.nspname = 'workhorse'
               AND parent.relname IN ('task_event', 'attempt_history')
               AND child.relname <> parent.relname || '_default'
          ), eligible AS (
            SELECT
              count(*) FILTER (
                WHERE parent_name = 'task_event'
                  AND policy.task_event_retention_days IS NOT NULL
                  AND upper_bound <= clock_timestamp()
                    - make_interval(days => policy.task_event_retention_days)
                  AND upper_bound <= (
                    date_trunc('day', clock_timestamp() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
                  )
              )::text AS eligible_event_partitions,
              count(*) FILTER (
                WHERE parent_name = 'attempt_history'
                  AND policy.attempt_history_retention_days IS NOT NULL
                  AND upper_bound <= clock_timestamp()
                    - make_interval(days => policy.attempt_history_retention_days)
                  AND upper_bound <= (
                    date_trunc('day', clock_timestamp() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
                  )
              )::text AS eligible_attempt_partitions
            FROM partitions CROSS JOIN policy
          ), default_rows AS (
            SELECT event_rows::text AS default_event_rows,
                   attempt_rows::text AS default_attempt_rows,
                   event_rows > 10000 AS default_event_rows_capped,
                   attempt_rows > 10000 AS default_attempt_rows_capped
              FROM (
                SELECT
                  (SELECT count(*) FROM (
                    SELECT 1 FROM workhorse.task_event_default LIMIT 10001
                  ) sampled_events) AS event_rows,
                  (SELECT count(*) FROM (
                    SELECT 1 FROM workhorse.attempt_history_default LIMIT 10001
                  ) sampled_attempts) AS attempt_rows
              ) sampled
          )
          SELECT policy.*, boundaries.*,
                 CASE WHEN policy.task_identity_retention_days IS NULL
                             OR boundaries.eligible_task_identity_at IS NULL THEN NULL
                      ELSE GREATEST(0, extract(epoch FROM
                        clock_timestamp() - make_interval(days => policy.task_identity_retention_days)
                        - boundaries.eligible_task_identity_at) * 1000) END AS task_identity_lag_ms,
                 CASE WHEN policy.terminal_outcome_retention_days IS NULL
                             OR boundaries.eligible_terminal_outcome_at IS NULL THEN NULL
                      ELSE GREATEST(0, extract(epoch FROM
                        clock_timestamp() - make_interval(days => policy.terminal_outcome_retention_days)
                        - boundaries.eligible_terminal_outcome_at) * 1000) END AS terminal_outcome_lag_ms,
                 CASE WHEN policy.task_event_retention_days IS NULL
                             OR boundaries.oldest_task_event_at IS NULL THEN NULL
                      ELSE GREATEST(
                        0,
                        COALESCE(extract(epoch FROM
                          date_trunc(
                            'day',
                            (clock_timestamp() - make_interval(
                              days => policy.task_event_retention_days
                            )) AT TIME ZONE 'UTC'
                          ) AT TIME ZONE 'UTC'
                          - boundaries.oldest_partitioned_task_event_at) * 1000, 0),
                        COALESCE(extract(epoch FROM
                          clock_timestamp() - make_interval(days => policy.task_event_retention_days)
                          - boundaries.oldest_default_task_event_at) * 1000, 0)
                      ) END AS task_event_lag_ms,
                 CASE WHEN policy.attempt_history_retention_days IS NULL
                             OR boundaries.oldest_attempt_history_at IS NULL THEN NULL
                      ELSE GREATEST(
                        0,
                        COALESCE(extract(epoch FROM
                          date_trunc(
                            'day',
                            (clock_timestamp() - make_interval(
                              days => policy.attempt_history_retention_days
                            )) AT TIME ZONE 'UTC'
                          ) AT TIME ZONE 'UTC'
                          - boundaries.oldest_partitioned_attempt_history_at) * 1000, 0),
                        COALESCE(extract(epoch FROM
                          clock_timestamp()
                          - make_interval(days => policy.attempt_history_retention_days)
                          - boundaries.oldest_default_attempt_history_at) * 1000, 0)
                      ) END AS attempt_history_lag_ms,
                 CASE WHEN policy.schedule_occurrence_retention_days IS NULL
                             OR boundaries.oldest_schedule_occurrence_at IS NULL THEN NULL
                      ELSE GREATEST(0, extract(epoch FROM
                        clock_timestamp()
                        - make_interval(days => policy.schedule_occurrence_retention_days)
                        - boundaries.oldest_schedule_occurrence_at) * 1000) END
                   AS schedule_occurrence_lag_ms,
                 CASE WHEN policy.statistics_retention_days IS NULL
                        OR boundaries.oldest_statistics_at IS NULL THEN NULL
                      ELSE GREATEST(0, extract(epoch FROM
                        clock_timestamp()
                        - make_interval(days => policy.statistics_retention_days)
                        - boundaries.oldest_statistics_at) * 1000) END
                   AS statistics_lag_ms,
                 eligible.*, default_rows.*
            FROM policy CROSS JOIN boundaries CROSS JOIN eligible CROSS JOIN default_rows
        ), dependencies AS (
          SELECT LEAST(blocked_tasks, 10000)::text
                   AS dependency_blocked_tasks,
                 LEAST(pending_edges, 10000)::text
                   AS dependency_pending_edges,
                 LEAST(failed_resolutions, 10000)::text
                   AS dependency_failed_resolutions,
                 (SELECT terminal_prune_dependency_starved
                    FROM workhorse.maintenance_state
                   WHERE routine_name = 'terminal_storage') AS dependency_retention_prune_starved,
                 blocked_tasks > 10000
                   OR pending_edges > 10000
                   OR failed_resolutions > 10000
                   AS dependency_counts_capped
            FROM (
              SELECT
                (SELECT count(*) FROM (
                  SELECT 1 FROM workhorse.task_runtime WHERE state = 'blocked'
                   LIMIT 10001
                ) sampled_blocked) AS blocked_tasks,
                (SELECT count(*) FROM (
                  SELECT 1 FROM workhorse.task_dependency WHERE released_at IS NULL
                   LIMIT 10001
                ) sampled_pending) AS pending_edges,
                (SELECT count(*) FROM (
                  SELECT 1 FROM workhorse.task_outcome
                   WHERE state = 'failed' AND error->>'name' = 'DependencyFailed'
                   LIMIT 10001
                ) sampled_failed) AS failed_resolutions
            ) samples
        ), children AS (
          SELECT LEAST(samples.waiting_parents, 10000)::text
                   AS child_waiting_parents,
                 LEAST(samples.pending_children, 10000)::text
                   AS child_pending_children,
                 LEAST(samples.unjoined_results, 10000)::text
                   AS child_unjoined_results,
                 LEAST(samples.failed_parents, 10000)::text
                   AS child_failed_parents,
                 LEAST(samples.canceled_parents, 10000)::text
                   AS child_canceled_parents,
                 samples.waiting_parents > 10000
                   OR samples.pending_children > 10000
                   OR samples.unjoined_results > 10000
                   OR samples.failed_parents > 10000
                   OR samples.canceled_parents > 10000
                   AS child_counts_capped
            FROM (
          SELECT
            (SELECT count(*) FROM (
              SELECT 1 FROM workhorse.task_runtime runtime
               WHERE runtime.state = 'blocked'
                 AND EXISTS (
                   SELECT 1 FROM workhorse.task_child edge WHERE edge.parent_task_id = runtime.task_id
                 )
               LIMIT 10001
            ) sampled_waiting) AS waiting_parents,
            (SELECT count(*) FROM (
              SELECT 1 FROM workhorse.task_child edge

               WHERE edge.joined_at IS NULL
                 AND NOT EXISTS (
                   SELECT 1 FROM workhorse.task_outcome outcome WHERE outcome.task_id = edge.child_task_id
                 )
               LIMIT 10001
            ) sampled_pending) AS pending_children,
            (SELECT count(*) FROM (
              SELECT 1 FROM workhorse.task_child edge

               JOIN workhorse.task_outcome outcome ON outcome.task_id = edge.child_task_id
              WHERE edge.joined_at IS NULL AND outcome.state = 'succeeded'
               LIMIT 10001
            ) sampled_unjoined) AS unjoined_results,
            (SELECT count(*) FROM (
              SELECT 1 FROM workhorse.task_outcome outcome

               WHERE outcome.state = 'failed'
                 AND outcome.error->>'name' = 'DependencyFailed'
                 AND EXISTS (
                   SELECT 1 FROM workhorse.task_child edge WHERE edge.parent_task_id = outcome.task_id
                 )
               LIMIT 10001
            ) sampled_failed) AS failed_parents,
            (SELECT count(*) FROM (
              SELECT 1 FROM workhorse.task_outcome outcome

               WHERE outcome.state = 'canceled'
                 AND outcome.error->>'name' = 'DependencyCanceled'
                 AND EXISTS (
                   SELECT 1 FROM workhorse.task_child edge WHERE edge.parent_task_id = outcome.task_id
                 )
               LIMIT 10001
            ) sampled_canceled) AS canceled_parents) samples
        ), external_waits AS (
          WITH pending AS (
            SELECT 'signal'::text AS kind, signal.created_at, runtime.deadline_at
              FROM workhorse.task_signal_wait signal
              JOIN workhorse.task_runtime runtime
                ON runtime.task_id = signal.task_id
               AND runtime.state = 'scheduled'
               AND runtime.wait_name = signal.signal_name
               AND runtime.current_attempt = signal.attempt
             WHERE signal.delivered_at IS NULL
             ORDER BY signal.created_at, signal.task_id, signal.signal_name
             LIMIT 10001
          ), pending_human AS (
            SELECT 'human'::text AS kind, human_wait.created_at, runtime.deadline_at
              FROM workhorse.task_human_wait human_wait
              JOIN workhorse.task_runtime runtime
                ON runtime.task_id = human_wait.task_id
               AND runtime.state = 'scheduled'
               AND runtime.wait_name = human_wait.token_name
               AND runtime.current_attempt = human_wait.attempt
             WHERE human_wait.completed_at IS NULL
             ORDER BY human_wait.created_at, human_wait.task_id, human_wait.token_name
             LIMIT 10001
          ), combined AS (
            SELECT * FROM pending UNION ALL SELECT * FROM pending_human
          ), overdue_signals AS (
            SELECT 1
              FROM workhorse.task_signal_wait signal
              JOIN workhorse.task_runtime runtime
                ON runtime.task_id = signal.task_id
               AND runtime.state = 'scheduled'
               AND runtime.wait_name = signal.signal_name
               AND runtime.current_attempt = signal.attempt
             WHERE signal.delivered_at IS NULL AND runtime.deadline_at <= clock_timestamp()
             ORDER BY runtime.deadline_at, signal.task_id, signal.signal_name
             LIMIT 10001
          ), overdue_humans AS (
            SELECT 1
              FROM workhorse.task_human_wait human_wait
              JOIN workhorse.task_runtime runtime
                ON runtime.task_id = human_wait.task_id
               AND runtime.state = 'scheduled'
               AND runtime.wait_name = human_wait.token_name
               AND runtime.current_attempt = human_wait.attempt
             WHERE human_wait.completed_at IS NULL AND runtime.deadline_at <= clock_timestamp()
             ORDER BY runtime.deadline_at, human_wait.task_id, human_wait.token_name
             LIMIT 10001
          ), rejected AS (
            SELECT 1
              FROM workhorse.task_event
             WHERE event_type IN ('signal_rejected', 'human_wait_rejected')
               AND occurred_at >= p_rejected_since
             ORDER BY occurred_at DESC, event_id DESC
             LIMIT 10001
          )
          SELECT LEAST(count(*) FILTER (WHERE kind = 'signal'), 10000)::text
                   AS pending_signal_waits,
                 LEAST(count(*) FILTER (WHERE kind = 'human'), 10000)::text
                   AS pending_human_waits,
                 LEAST(
                   (SELECT count(*) FROM overdue_signals) + (SELECT count(*) FROM overdue_humans),
                   10000
                 )::text AS overdue_external_waits,
                 extract(epoch FROM clock_timestamp() - min(created_at)) * 1000
                   AS oldest_external_wait_age_ms,
                 LEAST((SELECT count(*) FROM rejected), 10000)::text
                   AS rejected_wait_deliveries,
                 count(*) FILTER (WHERE kind = 'signal') > 10000
                   OR count(*) FILTER (WHERE kind = 'human') > 10000
                   OR (SELECT count(*) FROM overdue_signals)
                        + (SELECT count(*) FROM overdue_humans) > 10000
                   OR (SELECT count(*) FROM rejected) > 10000
                   AS external_wait_counts_capped
            FROM combined
        ), rollup AS (
          SELECT state.rolled_up_through,
                 GREATEST(0, extract(epoch FROM clock_timestamp() - state.rolled_up_through) * 1000)
                   AS rollup_lag_ms,
                 state.last_run_at,
                 bucket_sample.buckets::text AS buckets,
                 bucket_sample.buckets_capped,
                 (SELECT max(bucket_start) FROM (
                    SELECT bucket_start FROM workhorse.task_stat_bucket
                    UNION ALL SELECT bucket_start FROM workhorse.task_stat_bucket_hour
                    UNION ALL SELECT bucket_start FROM workhorse.task_stat_bucket_day
                  ) statistic_tiers) AS newest_bucket_at
            FROM workhorse.task_stat_state state
            CROSS JOIN LATERAL (
              SELECT count(*) AS buckets, count(*) > 100000 AS buckets_capped
                FROM (
                  SELECT 1 FROM workhorse.task_stat_bucket
                  UNION ALL SELECT 1 FROM workhorse.task_stat_bucket_hour
                  UNION ALL SELECT 1 FROM workhorse.task_stat_bucket_day
                  LIMIT 100001
                ) sampled_buckets
            ) bucket_sample
           WHERE state.singleton
           LIMIT 1
        ), concurrency AS (
          WITH policies AS MATERIALIZED (
            SELECT policy.*
              FROM workhorse.concurrency_policy policy
             ORDER BY policy.queue_name
             LIMIT 101
          )
          SELECT policy.namespace, policy.queue_name, policy.max_active,
                 policy.max_active_per_key,
                 usage.active::text,
                 blocked.blocked_ready::text,
                 usage.saturated_keys::text,
                 usage.highest_key_active::text,
                 (SELECT count(*) FROM policies) > 100 OR blocked.sample_capped AS capped
            FROM policies policy
            CROSS JOIN LATERAL (
              SELECT COALESCE(sum(keyed.key_active), 0)::integer AS active,
                     count(*) FILTER (
                       WHERE policy.max_active_per_key IS NOT NULL
                         AND keyed.concurrency_key IS NOT NULL
                         AND keyed.key_active >= policy.max_active_per_key
                     )::integer AS saturated_keys,
                     COALESCE(max(keyed.key_active) FILTER (
                       WHERE keyed.concurrency_key IS NOT NULL
                     ), 0)::integer AS highest_key_active
                FROM (
                  SELECT active.concurrency_key, count(*)::integer AS key_active
                    FROM workhorse.task_runtime active
                   WHERE active.state = 'active'
                     AND active.queue_name = policy.queue_name
                     AND active.expires_at > clock_timestamp()
                   GROUP BY active.concurrency_key
                ) keyed
            ) usage
            CROSS JOIN LATERAL (
              SELECT count(*) FILTER (
                       WHERE usage.active >= policy.max_active
                          OR (
                            policy.max_active_per_key IS NOT NULL
                            AND sample.concurrency_key IS NOT NULL
                            AND COALESCE(sample.key_active, 0) >= policy.max_active_per_key
                          )
                     )::integer AS blocked_ready,
                     count(*) > 100 AS sample_capped
                FROM (
                  SELECT ready.concurrency_key,
                         (SELECT count(*)::integer
                            FROM workhorse.task_runtime active
                           WHERE active.state = 'active'
                             AND active.queue_name = policy.queue_name
                             AND active.concurrency_key = ready.concurrency_key
                             AND active.expires_at > clock_timestamp()) AS key_active
                    FROM workhorse.task_runtime ready
                   WHERE ready.state = 'ready' AND ready.queue_name = policy.queue_name
                   ORDER BY ready.sequence, ready.task_id
                   LIMIT 101
                ) sample
            ) blocked
           ORDER BY policy.queue_name
           LIMIT 100
        ), rate_limits AS (
        WITH observed AS (
          SELECT clock_timestamp() AS now
        ), policies AS MATERIALIZED (
          SELECT policy.* FROM workhorse.rate_limit_policy policy
           WHERE cardinality(ARRAY[]::text[]) = 0 OR policy.queue_name = ANY(ARRAY[]::text[])
           ORDER BY policy.queue_name LIMIT 101
        ), queue_status AS (
          SELECT policy.*, observed.now,
                 GREATEST(observed.now, COALESCE(bucket.refilled_at, observed.now))
                   AS refill_baseline,
                 LEAST(policy.rate_burst::numeric, COALESCE(
                   bucket.tokens + GREATEST(
                     0::numeric,
                     extract(epoch FROM observed.now - bucket.refilled_at) * 1000
                   ) * policy.rate_limit::numeric / policy.rate_interval_ms::numeric,
                   policy.rate_burst::numeric
                 )) AS available_tokens
            FROM policies policy CROSS JOIN observed
            LEFT JOIN workhorse.rate_limit_bucket bucket
              ON bucket.queue_name = policy.queue_name
             AND bucket.bucket_scope = 'queue' AND bucket.bucket_key = ''
        )
        SELECT policy.namespace, policy.queue_name, policy.rate_limit,
               policy.rate_interval_ms, policy.rate_burst, policy.per_key_limit,
               policy.per_key_interval_ms, policy.per_key_burst, policy.updated_at,
               policy.available_tokens::text,
               pressure.throttled_ready::text, pressure.throttled_keys::text,
               pressure.next_eligible_at, pressure.sample_capped
               , (SELECT count(*) FROM policies) > 100 AS policy_set_capped
          FROM queue_status policy
          CROSS JOIN LATERAL (
            SELECT count(*) FILTER (WHERE sample.throttled)::integer AS throttled_ready,
                   count(DISTINCT sample.concurrency_key) FILTER (
                     WHERE sample.key_throttled
                   )::integer AS throttled_keys,
                   min(sample.eligible_at) FILTER (WHERE sample.throttled) AS next_eligible_at,
                   count(*) > 100 AS sample_capped
              FROM (
                SELECT ready.concurrency_key,
                       policy.available_tokens < 1 OR keyed.available_tokens < 1 AS throttled,
                       keyed.available_tokens < 1 AS key_throttled,
                       CASE WHEN policy.available_tokens < 1 OR keyed.available_tokens < 1 THEN
                         GREATEST(
                           CASE WHEN policy.available_tokens < 1 THEN
                             policy.refill_baseline + make_interval(
                             secs => CEIL(
                               (1 - policy.available_tokens) * policy.rate_interval_ms::numeric
                               / policy.rate_limit::numeric
                             )::double precision / 1000
                           ) END,
                           CASE WHEN keyed.available_tokens < 1 THEN
                             keyed.refill_baseline + make_interval(
                             secs => CEIL(
                               (1 - keyed.available_tokens) * policy.per_key_interval_ms::numeric
                               / policy.per_key_limit::numeric
                             )::double precision / 1000
                           ) END
                         )
                       END AS eligible_at
                  FROM (
                    SELECT runtime.concurrency_key
                      FROM workhorse.task_runtime runtime
                     WHERE runtime.state = 'ready' AND runtime.queue_name = policy.queue_name
                     ORDER BY runtime.sequence, runtime.task_id LIMIT 101
                  ) ready
                  CROSS JOIN LATERAL (
                    SELECT CASE
                      WHEN policy.per_key_limit IS NULL OR ready.concurrency_key IS NULL THEN 1
                      ELSE LEAST(policy.per_key_burst::numeric, COALESCE(
                        bucket.tokens + GREATEST(
                          0::numeric,
                          extract(epoch FROM policy.now - bucket.refilled_at) * 1000
                        ) * policy.per_key_limit::numeric / policy.per_key_interval_ms::numeric,
                        policy.per_key_burst::numeric
                      ))
                    END AS available_tokens,
                    CASE
                      WHEN policy.per_key_limit IS NULL OR ready.concurrency_key IS NULL
                        THEN policy.now
                      ELSE GREATEST(policy.now, COALESCE(bucket.refilled_at, policy.now))
                    END AS refill_baseline
                    FROM (SELECT true) present
                    LEFT JOIN workhorse.rate_limit_bucket bucket
                      ON bucket.queue_name = policy.queue_name
                     AND bucket.bucket_scope = 'key'
                     AND bucket.bucket_key = ready.concurrency_key
                  ) keyed
              ) sample
          ) pressure
         ORDER BY policy.queue_name LIMIT 100
        ), budget_policies AS (
          SELECT * FROM workhorse.budget_status_v1(ARRAY[]::text[])
        ), partition_days AS (
          SELECT to_char(day_start, 'YYYYMMDD') AS day, day_start AS starts_at,
                 to_regclass(format('workhorse.%I', 'task_event_' || to_char(day_start, 'YYYYMMDD')))
                   IS NOT NULL AS has_task_events,
                 to_regclass(format('workhorse.%I', 'attempt_history_' || to_char(day_start, 'YYYYMMDD')))
                   IS NOT NULL AS has_attempt_history
            FROM generate_series(
              date_trunc('day', clock_timestamp() AT TIME ZONE 'UTC'),
              date_trunc('day', clock_timestamp() AT TIME ZONE 'UTC') + interval '3 days',
              interval '1 day'
            ) day_start
        )
        SELECT now() AS captured_at,
               installed.schema_version,
               depth.*, terminal.*, dependencies.*, children.*, external_waits.*, retention.*, rollup.*,
               (SELECT COALESCE(jsonb_agg(to_jsonb(c.*) ORDER BY c.queue_name), '[]'::jsonb)
                  FROM concurrency c) AS concurrency_policies,
               (SELECT COALESCE(jsonb_agg(to_jsonb(r.*) ORDER BY r.queue_name), '[]'::jsonb)
                  FROM rate_limits r) AS rate_limit_policies,
               (SELECT COALESCE(jsonb_agg(to_jsonb(b.*) ORDER BY b.budget_name), '[]'::jsonb)
                  FROM budget_policies b) AS budget_policies,
               (SELECT jsonb_agg(to_jsonb(p.*) ORDER BY p.starts_at)
                  FROM partition_days p) AS history_partition_days
          FROM installed
          CROSS JOIN depth
          CROSS JOIN terminal
          CROSS JOIN dependencies
          CROSS JOIN children
          CROSS JOIN external_waits
          CROSS JOIN retention
          CROSS JOIN rollup
    ) snapshot
    CROSS JOIN workhorse.queue_health_policy policy
   WHERE policy.singleton;

  SELECT jsonb_build_object(
           'relations', COALESCE((
             SELECT jsonb_agg(to_jsonb(relation_row) ORDER BY relation_row.relation)
               FROM (
                 SELECT parent.relname AS relation,
                        sum(pg_total_relation_size(COALESCE(tree.relid, parent.oid)))::text
                          AS total_bytes,
                        sum(pg_relation_size(COALESCE(tree.relid, parent.oid)))::text AS table_bytes,
                        sum(pg_indexes_size(COALESCE(tree.relid, parent.oid)))::text AS index_bytes,
                        sum(COALESCE(statistics.n_live_tup, 0))::text AS live_tuples,
                        sum(COALESCE(statistics.n_dead_tup, 0))::text AS dead_tuples,
                        sum(COALESCE(statistics.n_mod_since_analyze, 0))::text
                          AS modifications_since_analyze,
                        CASE WHEN sum(COALESCE(statistics.n_tup_upd, 0)) = 0 THEN NULL
                             ELSE sum(statistics.n_tup_hot_upd)::double precision
                               / sum(statistics.n_tup_upd) END AS hot_update_ratio,
                        max(statistics.last_vacuum) AS last_vacuum,
                        max(statistics.last_autovacuum) AS last_autovacuum,
                        count(*) FILTER (
                          WHERE tree.relid IS NOT NULL AND tree.relid <> parent.oid
                        )::text AS partitions
                   FROM pg_class parent
                   JOIN pg_namespace namespace ON namespace.oid = parent.relnamespace
                   LEFT JOIN LATERAL pg_partition_tree(parent.oid) tree ON true
                   LEFT JOIN pg_stat_user_tables statistics
                     ON statistics.relid = COALESCE(tree.relid, parent.oid)
                  WHERE namespace.nspname = 'workhorse'
                    AND parent.relkind IN ('r', 'p')
                    AND parent.relispartition = false
                  GROUP BY parent.relname, parent.oid
               ) relation_row
           ), '[]'::jsonb),
           'oldest_transaction_age_ms', activity.age_ms,
           'lock_wait_count', activity.lock_wait_count,
           'notification_queue_usage', pg_notification_queue_usage()
         )
    INTO v_observations
    FROM (
      SELECT extract(epoch FROM clock_timestamp() - min(xact_start)) * 1000 AS age_ms,
             count(*) FILTER (WHERE wait_event_type = 'Lock')::text AS lock_wait_count
        FROM pg_stat_activity
       WHERE pid <> pg_backend_pid()
    ) activity;

  RETURN v_document || jsonb_build_object('observations', v_observations);
END;
$$;

CREATE OR REPLACE FUNCTION workhorse.dashboard_budgets_v1(p_health jsonb)
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
  SELECT jsonb_build_object(
    'budgets', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'name', budget->>'budget_name',
               'namespace', budget->>'namespace',
               'maxActive', (budget->>'max_active')::integer,
               'rate', CASE WHEN COALESCE(budget->'rate_limit', 'null'::jsonb) = 'null'::jsonb
                 THEN NULL
                 ELSE jsonb_build_object('limit', (budget->>'rate_limit')::integer,
                   'intervalMs', (budget->>'rate_interval_ms')::integer,
                   'burst', (budget->>'rate_burst')::integer) END,
               'active', (budget->>'active')::integer,
               'availableTokens', (budget->>'available_tokens')::numeric,
               'blockedReady', (budget->>'blocked_ready')::integer,
               'saturated', (budget->>'saturated')::boolean,
               'nextEligibleAt',
               workhorse.dashboard_iso_v1((budget->>'next_eligible_at')::timestamptz)
             ) ORDER BY budget->>'budget_name')
        FROM jsonb_array_elements(COALESCE(p_health->'budget_policies', '[]'::jsonb)) budget
    ), '[]'::jsonb),
    'budgetsCapped', EXISTS (
      SELECT 1 FROM jsonb_array_elements(COALESCE(p_health->'budget_policies', '[]'::jsonb)) budget
       WHERE (budget->>'budget_set_capped')::boolean OR (budget->>'sample_capped')::boolean)
  );
$$;

CREATE OR REPLACE FUNCTION workhorse.dashboard_queues_v1(p_input jsonb)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_approximate boolean;
  v_health jsonb;
  v_queues jsonb := '[]'::jsonb;
  v_row record;
  v_plan jsonb;
  v_state text;
  v_estimate integer;
  v_succeeded integer;
  v_failed integer;
  v_canceled integer;
  v_concurrency jsonb;
  v_rate_limit jsonb;
BEGIN
  SELECT estimate >= 50000 INTO v_approximate
    FROM workhorse.dashboard_task_estimate_v1();
  v_health := workhorse.queue_health_v1();

  FOR v_row IN
    WITH known_queues AS (
      SELECT queue_name FROM workhorse.dashboard_task_v1
      UNION SELECT queue_name FROM workhorse.dashboard_queue_control_v1
      UNION SELECT queue_name FROM workhorse.dashboard_concurrency_policy_v1
      UNION SELECT queue_name FROM workhorse.dashboard_rate_limit_policy_v1
    ), live_counts AS (
      SELECT queue_name,
             count(*) FILTER (WHERE state = 'scheduled')::integer AS scheduled,
             count(*) FILTER (WHERE state = 'ready')::integer AS ready,
             count(*) FILTER (WHERE state = 'active')::integer AS active
        FROM workhorse.dashboard_task_runtime_v1 GROUP BY queue_name
    ), terminal_counts AS (
      SELECT task.queue_name,
             count(*) FILTER (WHERE outcome.state = 'succeeded')::integer AS succeeded,
             count(*) FILTER (WHERE outcome.state = 'failed')::integer AS failed,
             count(*) FILTER (WHERE outcome.state = 'canceled')::integer AS canceled
        FROM workhorse.dashboard_task_outcome_v1 outcome
        JOIN workhorse.dashboard_task_v1 task ON task.id = outcome.task_id
       WHERE NOT v_approximate GROUP BY task.queue_name
    )
    SELECT known.queue_name AS queue, COALESCE(control.paused, false) AS paused,
           COALESCE(live.scheduled, 0)::integer AS scheduled,
           COALESCE(live.ready, 0)::integer AS ready,
           COALESCE(live.active, 0)::integer AS active,
           COALESCE(terminal.succeeded, 0)::integer AS succeeded,
           COALESCE(terminal.failed, 0)::integer AS failed,
           COALESCE(terminal.canceled, 0)::integer AS canceled
      FROM known_queues known
      LEFT JOIN workhorse.dashboard_queue_control_v1 control USING (queue_name)
      LEFT JOIN live_counts live USING (queue_name)
      LEFT JOIN terminal_counts terminal USING (queue_name)
     ORDER BY known.queue_name
  LOOP
    v_succeeded := v_row.succeeded;
    v_failed := v_row.failed;
    v_canceled := v_row.canceled;
    IF v_approximate THEN
      FOREACH v_state IN ARRAY ARRAY['succeeded', 'failed', 'canceled'] LOOP
        EXECUTE 'EXPLAIN (FORMAT JSON) SELECT 1 '
                'FROM workhorse.dashboard_task_outcome_v1 outcome '
                'JOIN workhorse.dashboard_task_v1 task ON task.id=outcome.task_id '
                'WHERE task.queue_name=$1 AND outcome.state=$2'
          INTO v_plan USING v_row.queue, v_state;
        v_estimate := GREATEST(0, round((v_plan->0->'Plan'->>'Plan Rows')::numeric));
        CASE v_state
          WHEN 'succeeded' THEN v_succeeded := v_estimate;
          WHEN 'failed' THEN v_failed := v_estimate;
          WHEN 'canceled' THEN v_canceled := v_estimate;
        END CASE;
      END LOOP;
    END IF;

    SELECT jsonb_build_object(
             'namespace', policy->>'namespace',
             'maxActive', (policy->>'max_active')::integer,
             'utilizationKnown', true,
             'active', (policy->>'active')::integer,
             'available', GREATEST(0, (policy->>'max_active')::integer -
                                       (policy->>'active')::integer),
             'blockedReady', (policy->>'blocked_ready')::integer,
             'maxActivePerKey', (policy->>'max_active_per_key')::integer,
             'saturatedKeys', (policy->>'saturated_keys')::integer,
             'highestKeyActive', (policy->>'highest_key_active')::integer)
      INTO v_concurrency
      FROM jsonb_array_elements(v_health->'concurrency_policies') policy
     WHERE policy->>'queue_name' = v_row.queue;
    SELECT jsonb_build_object(
             'namespace', policy->>'namespace',
             'rate', jsonb_build_object('limit', (policy->>'rate_limit')::integer,
               'intervalMs', (policy->>'rate_interval_ms')::integer,
               'burst', (policy->>'rate_burst')::integer),
             'perKey', CASE WHEN policy->'per_key_limit' = 'null'::jsonb THEN NULL
               ELSE jsonb_build_object('limit', (policy->>'per_key_limit')::integer,
                 'intervalMs', (policy->>'per_key_interval_ms')::integer,
                 'burst', (policy->>'per_key_burst')::integer) END,
             'availableTokens', (policy->>'available_tokens')::numeric,
             'throttledReady', (policy->>'throttled_ready')::integer,
             'throttledKeys', (policy->>'throttled_keys')::integer,
             'nextEligibleAt',
             workhorse.dashboard_iso_v1((policy->>'next_eligible_at')::timestamptz))
      INTO v_rate_limit
      FROM jsonb_array_elements(v_health->'rate_limit_policies') policy
     WHERE policy->>'queue_name' = v_row.queue;

    v_queues := v_queues || jsonb_build_array(jsonb_build_object(
      'queue', v_row.queue, 'paused', v_row.paused, 'scheduled', v_row.scheduled,
      'ready', v_row.ready, 'active', v_row.active, 'succeeded', v_succeeded,
      'failed', v_failed, 'canceled', v_canceled,
      'terminalCountsApproximate', v_approximate,
      'concurrencyPolicy', v_concurrency, 'rateLimitPolicy', v_rate_limit));
  END LOOP;

  RETURN jsonb_build_object(
    'capturedAt', workhorse.dashboard_iso_v1(clock_timestamp()), 'queues', v_queues,
    'concurrencyPoliciesCapped', EXISTS (
      SELECT 1 FROM jsonb_array_elements(v_health->'concurrency_policies') policy
       WHERE (policy->>'capped')::boolean),
    'rateLimitPoliciesCapped', EXISTS (
      SELECT 1 FROM jsonb_array_elements(v_health->'rate_limit_policies') policy
       WHERE (policy->>'policy_set_capped')::boolean OR (policy->>'sample_capped')::boolean))
    || workhorse.dashboard_budgets_v1(v_health);
END;
$$;

CREATE OR REPLACE FUNCTION workhorse.dashboard_system_v1(p_input jsonb)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_now timestamptz := clock_timestamp();
  v_window text := COALESCE(p_input->>'window', '1h');
  v_seconds integer;
  v_minutes double precision;
  v_health jsonb;
  v_outcomes jsonb;
  v_summary jsonb;
  v_wait jsonb;
  v_runtime record;
  v_retry_buckets jsonb;
  v_queues jsonb;
  v_retry_types jsonb;
  v_failing_types jsonb;
  v_categories jsonb;
  v_max_lag jsonb;
  v_oldest_retained jsonb;
  v_retention jsonb;
  v_relations jsonb;
  v_storage jsonb;
  v_total_storage_bytes bigint;
  v_partitions jsonb;
  v_current_error_rate double precision;
  v_previous_error_rate double precision;
BEGIN
  v_seconds := CASE v_window WHEN '15m' THEN 900 WHEN '24h' THEN 86400 ELSE 3600 END;
  v_minutes := v_seconds::double precision / 60;
  v_health := workhorse.queue_health_v1();

  WITH current_stats AS MATERIALIZED (SELECT * FROM workhorse.stat_buckets_v1(
        date_bin('1 minute', v_now, timestamp '2000-01-01' AT TIME ZONE 'UTC')
          - make_interval(secs => v_seconds) + interval '1 minute',
        v_now
      ) stat)
  SELECT
    (
WITH buckets AS (
    SELECT generate_series(
      date_bin('1 minute', v_now, timestamp '2000-01-01' AT TIME ZONE 'UTC')
        - make_interval(secs => v_seconds) + interval '1 minute',
      date_bin('1 minute', v_now, timestamp '2000-01-01' AT TIME ZONE 'UTC'),
      interval '1 minute'
    ) AS bucket_start
  ), rolled AS (
    SELECT stat.bucket_start,
           sum(stat.enqueued)::integer AS enqueued,
           sum(stat.attempt_succeeded)::integer AS succeeded,
           sum(stat.attempt_failed)::integer AS failed,
           sum(stat.attempt_retry)::integer AS retry,
           sum(stat.attempt_lease_expired)::integer AS lease_expired,
           sum(stat.attempt_canceled)::integer AS canceled
      FROM current_stats stat
     GROUP BY stat.bucket_start
  ), rows AS (
    SELECT buckets.bucket_start,
           COALESCE(rolled.enqueued, 0)::integer AS enqueued,
           COALESCE(rolled.succeeded, 0)::integer AS succeeded,
           COALESCE(rolled.failed, 0)::integer AS failed,
           COALESCE(rolled.retry, 0)::integer AS retry,
           COALESCE(rolled.lease_expired, 0)::integer AS lease_expired,
           COALESCE(rolled.canceled, 0)::integer AS canceled
      FROM buckets LEFT JOIN rolled USING (bucket_start)
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'bucketStart', workhorse.dashboard_iso_v1(bucket_start),
           'enqueued', enqueued, 'succeeded', succeeded, 'failed', failed,
           'retry', retry, 'leaseExpired', lease_expired, 'canceled', canceled
         ) ORDER BY bucket_start), '[]'::jsonb) FROM rows
    ),
    (
SELECT to_jsonb(result) FROM (
WITH current_window AS (
    SELECT COALESCE(sum(stat.enqueued), 0)::integer AS enqueued,
           COALESCE(sum(stat.attempt_succeeded + stat.attempt_failed
             + stat.attempt_canceled), 0)::integer AS completed,
           COALESCE(sum(stat.attempt_succeeded + stat.attempt_failed + stat.attempt_retry
             + stat.attempt_lease_expired + stat.attempt_canceled + stat.attempt_other),
             0)::integer AS attempts,
           COALESCE(sum(stat.attempt_failed + stat.attempt_retry
             + stat.attempt_lease_expired + stat.attempt_other), 0)::integer AS errors,
           COALESCE(sum(stat.attempt_lease_expired), 0)::integer AS recovered
      FROM current_stats stat
  ), previous_window AS (
    SELECT COALESCE(sum(stat.attempt_succeeded + stat.attempt_failed + stat.attempt_retry
             + stat.attempt_lease_expired + stat.attempt_canceled + stat.attempt_other),
             0)::integer AS attempts,
           COALESCE(sum(stat.attempt_failed + stat.attempt_retry
             + stat.attempt_lease_expired + stat.attempt_other), 0)::integer AS errors
      FROM workhorse.stat_buckets_v1(
        date_bin('1 minute', v_now, timestamp '2000-01-01' AT TIME ZONE 'UTC')
          - make_interval(secs => v_seconds * 2) + interval '1 minute',
        date_bin('1 minute', v_now, timestamp '2000-01-01' AT TIME ZONE 'UTC')
          - make_interval(secs => v_seconds) + interval '1 minute'
      ) stat
  )
  SELECT current_window.*, previous_window.attempts AS previous_attempts,
         previous_window.errors AS previous_errors FROM current_window CROSS JOIN previous_window
) result
    ),
    (
SELECT to_jsonb(result) FROM (
WITH merged AS (
    SELECT workhorse.stat_sketch_merge_v1(array_agg(stat.wait_sketch)) AS sketch
      FROM current_stats stat
  )
  SELECT workhorse.stat_sketch_percentile_v1(sketch, 0.50) AS p50,
         workhorse.stat_sketch_percentile_v1(sketch, 0.95) AS p95,
         workhorse.stat_sketch_percentile_v1(sketch, 0.99) AS p99 FROM merged
) result
    ),
    (
WITH rolled AS (
    SELECT stat.queue_name,
           COALESCE(sum(stat.enqueued), 0)::integer AS enqueued,
           COALESCE(sum(stat.attempt_succeeded + stat.attempt_failed
             + stat.attempt_canceled), 0)::integer AS completed
      FROM current_stats stat
     GROUP BY stat.queue_name
  ), queue_names AS (
    SELECT queue_name FROM workhorse.dashboard_task_runtime_v1
    UNION SELECT queue_name FROM workhorse.dashboard_queue_control_v1
    UNION SELECT queue_name FROM workhorse.dashboard_concurrency_policy_v1
    UNION SELECT queue_name FROM workhorse.dashboard_rate_limit_policy_v1
    UNION SELECT queue_name FROM rolled
  ), runtime AS (
    SELECT queue_name,
           count(*) FILTER (WHERE state = 'ready')::integer AS ready,
           (extract(epoch FROM v_now
             - min(ready_at) FILTER (WHERE state = 'ready')) * 1000)::text AS oldest_ready_ms,
           count(*) FILTER (WHERE state = 'scheduled'
             AND run_at <= v_now + interval '5 minutes')::integer AS due_soon,
           count(*) FILTER (WHERE state = 'active')::integer AS active,
           count(*) FILTER (WHERE state = 'scheduled'
             AND current_attempt > 1)::integer AS retrying
      FROM workhorse.dashboard_task_runtime_v1 GROUP BY queue_name
  ), priorities AS (
    SELECT runtime.queue_name, task.priority, count(*)::integer AS ready,
           (extract(epoch FROM v_now - min(runtime.ready_at)) * 1000)::text
             AS oldest_ready_ms
      FROM workhorse.dashboard_task_runtime_v1 runtime
      JOIN workhorse.dashboard_task_v1 task ON task.id = runtime.task_id
     WHERE runtime.state = 'ready'
     GROUP BY runtime.queue_name, task.priority
  ), rows AS (
    SELECT queue_names.queue_name AS queue, COALESCE(control.paused, false) AS paused,
           COALESCE(runtime.ready, 0)::integer AS ready, runtime.oldest_ready_ms,
           COALESCE(runtime.due_soon, 0)::integer AS due_soon,
           COALESCE(runtime.active, 0)::integer AS active,
           COALESCE(runtime.retrying, 0)::integer AS retrying,
           COALESCE(rolled.enqueued, 0)::integer AS enqueued,
           COALESCE(rolled.completed, 0)::integer AS completed
      FROM queue_names
      LEFT JOIN workhorse.dashboard_queue_control_v1 control USING (queue_name)
      LEFT JOIN runtime USING (queue_name)
      LEFT JOIN rolled USING (queue_name)
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'queue', rows.queue,
           'paused', rows.paused,
           'ready', rows.ready,
           'oldestReadyMs', rows.oldest_ready_ms,
           'priorityBacklog', COALESCE((
             SELECT jsonb_agg(jsonb_build_object(
                      'priority', priority, 'ready', ready,
                      'oldestReadyMs', oldest_ready_ms
                    ) ORDER BY priority DESC)
               FROM priorities WHERE priorities.queue_name = rows.queue
           ), '[]'::jsonb),
           'dueSoon', rows.due_soon,
           'active', rows.active,
           'retrying', rows.retrying,
           'enqueuedPerMinute', rows.enqueued / v_minutes,
           'completedPerMinute', rows.completed / v_minutes,
           'concurrencyPolicy', (
             SELECT jsonb_build_object(
               'namespace', policy->>'namespace',
               'maxActive', (policy->>'max_active')::integer,
               'utilizationKnown', true,
               'active', (policy->>'active')::integer,
               'available', GREATEST(0, (policy->>'max_active')::integer
                 - (policy->>'active')::integer),
               'blockedReady', (policy->>'blocked_ready')::integer,
               'maxActivePerKey', (policy->>'max_active_per_key')::integer,
               'saturatedKeys', (policy->>'saturated_keys')::integer,
               'highestKeyActive', (policy->>'highest_key_active')::integer
             ) FROM jsonb_array_elements(v_health->'concurrency_policies') policy
               WHERE policy->>'queue_name' = rows.queue
           ),
           'rateLimitPolicy', (
             SELECT jsonb_build_object(
               'namespace', policy->>'namespace',
               'rate', jsonb_build_object(
                 'limit', (policy->>'rate_limit')::integer,
                 'intervalMs', (policy->>'rate_interval_ms')::integer,
                 'burst', (policy->>'rate_burst')::integer),
               'perKey', CASE WHEN policy->'per_key_limit' = 'null'::jsonb THEN NULL
                 ELSE jsonb_build_object(
                   'limit', (policy->>'per_key_limit')::integer,
                   'intervalMs', (policy->>'per_key_interval_ms')::integer,
                   'burst', (policy->>'per_key_burst')::integer) END,
               'availableTokens', (policy->>'available_tokens')::numeric,
               'throttledReady', (policy->>'throttled_ready')::integer,
               'throttledKeys', (policy->>'throttled_keys')::integer,
               'nextEligibleAt', workhorse.dashboard_iso_v1(
                 (policy->>'next_eligible_at')::timestamptz)
             ) FROM jsonb_array_elements(v_health->'rate_limit_policies') policy
               WHERE policy->>'queue_name' = rows.queue
           )
         ) ORDER BY rows.queue), '[]'::jsonb) FROM rows
    ),
    (
WITH rows AS (
    SELECT stat.queue_name AS queue, stat.task_type AS type,
           sum(stat.attempt_succeeded + stat.attempt_failed + stat.attempt_retry
             + stat.attempt_lease_expired + stat.attempt_canceled
             + stat.attempt_other)::integer AS attempts,
           sum(stat.attempt_failed + stat.attempt_retry
             + stat.attempt_lease_expired + stat.attempt_other)::integer AS errors,
           sum(stat.attempt_failed)::integer AS terminal_failures,
           (array_agg(stat.last_error ORDER BY stat.last_error_at DESC NULLS LAST)
             FILTER (WHERE stat.last_error IS NOT NULL))[1] AS last_error,
           max(stat.last_attempt_at) AS last_seen_at
      FROM current_stats stat
     GROUP BY stat.queue_name, stat.task_type
    HAVING sum(stat.attempt_failed + stat.attempt_retry
      + stat.attempt_lease_expired + stat.attempt_other) > 0
     ORDER BY errors DESC, last_seen_at DESC
     LIMIT 8
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'queue', queue, 'type', type, 'attempts', attempts,
           'errorRate', CASE WHEN attempts = 0 THEN 0 ELSE errors::double precision / attempts END,
           'terminalFailures', terminal_failures, 'lastError', last_error,
           'lastSeenAt', workhorse.dashboard_iso_v1(last_seen_at)
         ) ORDER BY errors DESC, last_seen_at DESC), '[]'::jsonb) FROM rows
    )
  INTO v_outcomes, v_summary, v_wait, v_queues, v_failing_types;

  SELECT count(*) FILTER (WHERE state = 'ready')::integer AS ready,
         (extract(epoch FROM v_now
           - min(ready_at) FILTER (WHERE state = 'ready')) * 1000)::text AS oldest_ready_ms,
         count(*) FILTER (WHERE state = 'scheduled' AND current_attempt > 1)::integer AS backoff,
         count(*) FILTER (WHERE state = 'scheduled' AND current_attempt > 1
           AND run_at <= v_now + interval '5 minutes')::integer AS due_soon,
         count(*) FILTER (WHERE state = 'active')::integer AS active,
         count(*) FILTER (WHERE state = 'active'
           AND expires_at <= v_now)::integer AS expired,
         count(*) FILTER (WHERE state = 'active' AND expires_at > v_now
           AND expires_at <= v_now + interval '30 seconds')::integer AS expiring_soon,
         count(*) FILTER (WHERE state = 'scheduled'
           AND run_at < v_now - interval '10 seconds')::integer AS due_but_unpromoted
    INTO v_runtime FROM workhorse.dashboard_task_runtime_v1;

  WITH bounds(upper_bound_ms, ordering) AS (
    VALUES (60000, 1), (300000, 2), (900000, 3), (3600000, 4), (NULL::integer, 5)
  ), counts AS (
    SELECT CASE
             WHEN run_at <= v_now + interval '1 minute' THEN 60000
             WHEN run_at <= v_now + interval '5 minutes' THEN 300000
             WHEN run_at <= v_now + interval '15 minutes' THEN 900000
             WHEN run_at <= v_now + interval '1 hour' THEN 3600000
             ELSE NULL
           END AS upper_bound_ms,
           count(*)::integer AS count
      FROM workhorse.dashboard_task_runtime_v1
     WHERE state = 'scheduled' AND current_attempt > 1
     GROUP BY 1
  )
  SELECT jsonb_agg(jsonb_build_object(
           'upperBoundMs', bounds.upper_bound_ms, 'count', COALESCE(counts.count, 0)
         ) ORDER BY bounds.ordering)
    INTO v_retry_buckets
    FROM bounds LEFT JOIN counts ON counts.upper_bound_ms IS NOT DISTINCT FROM bounds.upper_bound_ms;

  WITH rows AS (
    SELECT task.queue_name AS queue, task.task_type AS type, count(*)::integer AS count
      FROM workhorse.dashboard_task_runtime_v1 runtime
      JOIN workhorse.dashboard_task_v1 task ON task.id = runtime.task_id
     WHERE runtime.state = 'scheduled' AND runtime.current_attempt > 1
     GROUP BY task.queue_name, task.task_type
     ORDER BY count DESC, task.queue_name, task.task_type
     LIMIT 3
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'queue', queue, 'type', type, 'count', count
         ) ORDER BY count DESC, queue, type), '[]'::jsonb)
    INTO v_retry_types FROM rows;

  v_categories := jsonb_build_array(
    jsonb_build_object('category', 'taskIdentity',
      'retentionDays', (v_health->>'task_identity_retention_days')::integer,
      'lagMs', (v_health->>'task_identity_lag_ms')::numeric,
      'oldestRetainedAt', workhorse.dashboard_iso_v1(
        (v_health->>'oldest_task_identity_at')::timestamptz), 'prunedByPartition', false),
    jsonb_build_object('category', 'terminalOutcome',
      'retentionDays', (v_health->>'terminal_outcome_retention_days')::integer,
      'lagMs', (v_health->>'terminal_outcome_lag_ms')::numeric,
      'oldestRetainedAt', workhorse.dashboard_iso_v1(
        (v_health->>'oldest_terminal_outcome_at')::timestamptz), 'prunedByPartition', false),
    jsonb_build_object('category', 'taskEvents',
      'retentionDays', (v_health->>'task_event_retention_days')::integer,
      'lagMs', (v_health->>'task_event_lag_ms')::numeric,
      'oldestRetainedAt', workhorse.dashboard_iso_v1(
        (v_health->>'oldest_task_event_at')::timestamptz), 'prunedByPartition', true),
    jsonb_build_object('category', 'attemptHistory',
      'retentionDays', (v_health->>'attempt_history_retention_days')::integer,
      'lagMs', (v_health->>'attempt_history_lag_ms')::numeric,
      'oldestRetainedAt', workhorse.dashboard_iso_v1(
        (v_health->>'oldest_attempt_history_at')::timestamptz), 'prunedByPartition', true),
    jsonb_build_object('category', 'scheduleOccurrences',
      'retentionDays', (v_health->>'schedule_occurrence_retention_days')::integer,
      'lagMs', (v_health->>'schedule_occurrence_lag_ms')::numeric,
      'oldestRetainedAt', workhorse.dashboard_iso_v1(
        (v_health->>'oldest_schedule_occurrence_at')::timestamptz), 'prunedByPartition', false),
    jsonb_build_object('category', 'statistics',
      'retentionDays', (v_health->>'statistics_retention_days')::integer,
      'lagMs', (v_health->>'statistics_lag_ms')::numeric,
      'oldestRetainedAt', workhorse.dashboard_iso_v1(
        (v_health->>'oldest_statistics_at')::timestamptz), 'prunedByPartition', false)
  );

  SELECT value INTO v_max_lag
    FROM jsonb_array_elements(v_categories) value
   WHERE (value->>'lagMs')::numeric > 0
   ORDER BY (value->>'lagMs')::numeric DESC LIMIT 1;
  SELECT value INTO v_oldest_retained
    FROM jsonb_array_elements(v_categories) value
   WHERE value->>'oldestRetainedAt' IS NOT NULL
   ORDER BY value->>'oldestRetainedAt' LIMIT 1;

  v_retention := jsonb_build_object(
    'policyUpdatedAt', workhorse.dashboard_iso_v1((v_health->>'updated_at')::timestamptz),
    'categories', v_categories,
    'maxLagMs', (v_max_lag->>'lagMs')::numeric,
    'maxLagCategory', v_max_lag->>'category',
    'oldestRetainedAt', v_oldest_retained->>'oldestRetainedAt',
    'oldestRetainedCategory', v_oldest_retained->>'category',
    'eligibleHistoryPartitions', jsonb_build_object(
      'taskEvents', (v_health->>'eligible_event_partitions')::integer,
      'attemptHistory', (v_health->>'eligible_attempt_partitions')::integer),
    'defaultHistoryRows', jsonb_build_object(
      'taskEvents', (v_health->>'default_event_rows')::integer,
      'attemptHistory', (v_health->>'default_attempt_rows')::integer),
    'defaultHistoryRowsCapped', jsonb_build_object(
      'taskEvents', (v_health->>'default_event_rows_capped')::boolean,
      'attemptHistory', (v_health->>'default_attempt_rows_capped')::boolean)
  );

  WITH names(relation, ordering) AS (
    VALUES ('task', 1), ('task_outcome', 2), ('task_runtime', 3), ('task_query', 4),
           ('task_event', 5), ('attempt_history', 6), ('schedule_occurrence', 7),
           ('task_stat_bucket', 8), ('task_stat_bucket_hour', 9), ('task_stat_bucket_day', 10)
  ), observations AS (
    SELECT value FROM jsonb_array_elements(v_health->'observations'->'relations') value
  ), rows AS (
    SELECT names.ordering, names.relation,
           COALESCE((observations.value->>'total_bytes')::bigint, 0) AS total_bytes,
           COALESCE((observations.value->>'table_bytes')::bigint, 0) AS table_bytes,
           COALESCE((observations.value->>'index_bytes')::bigint, 0) AS index_bytes,
           COALESCE((observations.value->>'live_tuples')::bigint, 0) AS live_tuples,
           COALESCE((observations.value->>'dead_tuples')::bigint, 0) AS dead_tuples,
           COALESCE((observations.value->>'partitions')::integer, 0) AS partitions,
           COALESCE(observations.value->>'last_autovacuum',
                    observations.value->>'last_vacuum') AS last_vacuum_at
      FROM names LEFT JOIN observations ON observations.value->>'relation' = names.relation
  )
  SELECT jsonb_agg(jsonb_build_object(
           'relation', relation, 'totalBytes', total_bytes, 'tableBytes', table_bytes,
           'indexBytes', index_bytes, 'rows', live_tuples, 'deadRows', dead_tuples,
           'partitions', partitions,
           'lastVacuumAt', workhorse.dashboard_iso_v1(last_vacuum_at::timestamptz)
         ) ORDER BY total_bytes DESC, ordering), sum(total_bytes)
    INTO v_relations, v_total_storage_bytes FROM rows;

  v_storage := jsonb_build_object(
    'rollup', jsonb_build_object(
      'rolledUpThrough', workhorse.dashboard_iso_v1(
        (v_health->>'rolled_up_through')::timestamptz),
      'lagMs', (v_health->>'rollup_lag_ms')::numeric,
      'lastRunAt', workhorse.dashboard_iso_v1((v_health->>'last_run_at')::timestamptz),
      'buckets', (v_health->>'buckets')::integer,
      'oldestBucketAt', workhorse.dashboard_iso_v1(
        (v_health->>'oldest_statistics_at')::timestamptz),
      'newestBucketAt', workhorse.dashboard_iso_v1((v_health->>'newest_bucket_at')::timestamptz),
      'stalled', EXISTS (
        SELECT 1 FROM jsonb_array_elements(v_health->'status'->'reasons') reason
         WHERE reason->>'code' = 'rollup-stalled'
      )
    ),
    'relations', v_relations,
    'totalBytes', v_total_storage_bytes
  );

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'day', value->>'day',
           'startsAt', workhorse.dashboard_iso_v1((value->>'starts_at')::timestamptz),
           'eventExists', (value->>'has_task_events')::boolean,
           'attemptExists', (value->>'has_attempt_history')::boolean
         ) ORDER BY value->>'day'), '[]'::jsonb)
    INTO v_partitions FROM jsonb_array_elements(v_health->'history_partition_days') value;

  v_current_error_rate := CASE WHEN (v_summary->>'attempts')::integer = 0 THEN 0
    ELSE (v_summary->>'errors')::integer::double precision / (v_summary->>'attempts')::integer END;
  v_previous_error_rate := CASE WHEN (v_summary->>'previous_attempts')::integer = 0 THEN 0
    ELSE (v_summary->>'previous_errors')::integer::double precision / (v_summary->>'previous_attempts')::integer END;

  RETURN jsonb_build_object(
    'capturedAt', workhorse.dashboard_iso_v1(v_now),
    'window', v_window,
    'windowSeconds', v_seconds,
    'status', v_health->'status',
    'pausedQueues', COALESCE((
      SELECT jsonb_agg(value->'queue' ORDER BY value->>'queue')
        FROM jsonb_array_elements(v_queues) value WHERE (value->>'paused')::boolean
    ), '[]'::jsonb),
    'kpis', jsonb_build_object(
      'drain', jsonb_build_object(
        'enqueuedPerMinute', (v_summary->>'enqueued')::integer / v_minutes,
        'completedPerMinute', (v_summary->>'completed')::integer / v_minutes,
        'netPerMinute', ((v_summary->>'completed')::integer - (v_summary->>'enqueued')::integer) / v_minutes),
      'backlog', jsonb_build_object(
        'ready', v_runtime.ready, 'oldestReadyMs', v_runtime.oldest_ready_ms),
      'errorRate', jsonb_build_object(
        'current', v_current_error_rate, 'previous', v_previous_error_rate,
        'delta', v_current_error_rate - v_previous_error_rate),
      'queueWait', jsonb_build_object(
        'p50Ms', (v_wait->>'p50')::double precision, 'p95Ms', (v_wait->>'p95')::double precision, 'p99Ms', (v_wait->>'p99')::double precision),
      'retry', jsonb_build_object(
        'backoff', v_runtime.backoff, 'dueSoon', v_runtime.due_soon,
        'buckets', v_retry_buckets),
      'lease', jsonb_build_object(
        'active', v_runtime.active, 'expired', v_runtime.expired,
        'expiringSoon', v_runtime.expiring_soon, 'recovered', (v_summary->>'recovered')::integer),
      'dependencies', jsonb_build_object(
        'blockedTasks', (v_health->>'dependency_blocked_tasks')::integer,
        'pendingEdges', (v_health->>'dependency_pending_edges')::integer,
        'failedResolutions', (v_health->>'dependency_failed_resolutions')::integer,
        'retentionPruneStarved', (v_health->>'dependency_retention_prune_starved')::boolean,
        'capped', (v_health->>'dependency_counts_capped')::boolean),
      'children', jsonb_build_object(
        'waitingParents', (v_health->>'child_waiting_parents')::integer,
        'pendingChildren', (v_health->>'child_pending_children')::integer,
        'unjoinedResults', (v_health->>'child_unjoined_results')::integer,
        'failedParents', (v_health->>'child_failed_parents')::integer,
        'canceledParents', (v_health->>'child_canceled_parents')::integer,
        'capped', (v_health->>'child_counts_capped')::boolean),
      'externalWaits', jsonb_build_object(
        'pendingSignals', (v_health->>'pending_signal_waits')::integer,
        'pendingHumanDecisions', (v_health->>'pending_human_waits')::integer,
        'overdue', (v_health->>'overdue_external_waits')::integer,
        'oldestPendingAgeMs', (v_health->>'oldest_external_wait_age_ms')::numeric,
        'rejectedDeliveries', (v_health->>'rejected_wait_deliveries')::integer,
        'capped', (v_health->>'external_wait_counts_capped')::boolean),
      'deadline', jsonb_build_object(
        'pending', (v_health->>'pending_deadlines')::integer,
        'overdue', (v_health->>'overdue_deadlines')::integer,
        'dueWithinMinute', (v_health->>'deadlines_due_within_minute')::integer,
        'earliestAt', workhorse.dashboard_iso_v1(
          (v_health->>'earliest_deadline_at')::timestamptz),
        'activeTimeouts', (v_health->>'active_execution_timeouts')::integer,
        'overdueTimeouts', (v_health->>'overdue_execution_timeouts')::integer)
    ),
    'outcomes', v_outcomes,
    'queues', v_queues,
    'concurrencyPoliciesCapped', EXISTS (
      SELECT 1 FROM jsonb_array_elements(v_health->'concurrency_policies') policy
       WHERE (policy->>'capped')::boolean),
    'rateLimitPoliciesCapped', EXISTS (
      SELECT 1 FROM jsonb_array_elements(v_health->'rate_limit_policies') policy
       WHERE (policy->>'policy_set_capped')::boolean OR (policy->>'sample_capped')::boolean),
    'budgets', workhorse.dashboard_budgets_v1(v_health)->'budgets',
    'budgetsCapped', workhorse.dashboard_budgets_v1(v_health)->'budgetsCapped',
    'retryStorm', jsonb_build_object('buckets', v_retry_buckets, 'topTypes', v_retry_types),
    'failingTypes', v_failing_types,
    'integrity', jsonb_build_object(
      'dueButUnpromoted', v_runtime.due_but_unpromoted,
      'partitions', v_partitions,
      'defaultEventRows', (v_health->>'default_event_rows')::integer,
      'defaultAttemptRows', (v_health->>'default_attempt_rows')::integer,
      'retention', v_retention,
      'storage', v_storage)
  );
END;
$$;

INSERT INTO workhorse.protocol_version(version) VALUES (3) ON CONFLICT DO NOTHING;
