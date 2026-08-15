BEGIN;

CREATE SCHEMA IF NOT EXISTS workhorse;

-- Canonical clean-install schema. This is not an incremental production migration.
CREATE TABLE IF NOT EXISTS workhorse.schema_version (
  version integer PRIMARY KEY,
  installed_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE IF NOT EXISTS workhorse.schema_migration (
  version integer PRIMARY KEY,
  description text NOT NULL CHECK (description <> ''),
  applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE OR REPLACE FUNCTION workhorse.valid_tags(p_tags text[])
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT p_tags IS NOT NULL
     AND cardinality(p_tags) <= 20
     AND array_position(p_tags, NULL) IS NULL
     AND NOT EXISTS (
       SELECT 1 FROM unnest(p_tags) tag WHERE tag = '' OR char_length(tag) > 100
     );
$$;

CREATE OR REPLACE FUNCTION workhorse.valid_contract_redact_keys_v1(p_keys text[])
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT p_keys IS NOT NULL
     AND cardinality(p_keys) <= 50
     AND array_position(p_keys, NULL) IS NULL
     AND cardinality(p_keys) = (SELECT count(DISTINCT key) FROM unnest(p_keys) key)
     AND NOT EXISTS (
       SELECT 1 FROM unnest(p_keys) key
        WHERE char_length(key) NOT BETWEEN 1 AND 200
     );
$$;

CREATE OR REPLACE FUNCTION workhorse.redact_top_level_keys_v1(p_value jsonb, p_keys text[])
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT CASE WHEN jsonb_typeof(p_value) = 'object'
    THEN p_value - COALESCE(p_keys, '{}') ELSE p_value END;
$$;

CREATE OR REPLACE FUNCTION workhorse.redact_error_details_v1(p_error jsonb, p_redact boolean)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT CASE WHEN NOT COALESCE(p_redact, false) OR p_error IS NULL THEN p_error
    ELSE jsonb_build_object(
      'name', 'RedactedJobError',
      'message', 'Job handler failed; details redacted'
    ) END;
$$;

CREATE OR REPLACE FUNCTION workhorse.valid_trace_context_v1(p_context jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT p_context IS NULL OR (
    jsonb_typeof(p_context) = 'object'
    AND p_context ? 'traceparent'
    AND p_context - ARRAY['traceparent', 'tracestate'] = '{}'::jsonb
    AND jsonb_typeof(p_context->'traceparent') = 'string'
    AND (NOT p_context ? 'tracestate' OR jsonb_typeof(p_context->'tracestate') = 'string')
    AND octet_length(p_context::text) <= 1024
  );
$$;

CREATE OR REPLACE FUNCTION workhorse.sha256_hex_v1(p_value text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT encode(sha256(convert_to(p_value, 'UTF8')), 'hex');
$$;

CREATE OR REPLACE FUNCTION workhorse.idempotency_key_hash_v1(p_scope text, p_key text)
RETURNS bytea
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT sha256(convert_to(p_scope || chr(31) || p_key, 'UTF8'));
$$;

-- Safe, bounded cancellation diagnostics. requested_by is attribution only and does not assert that
-- the caller was authorized to cancel the job.
CREATE OR REPLACE FUNCTION workhorse.cancellation_envelope_v1(
  p_requested_at timestamptz, p_requested_by text, p_reason text
) RETURNS jsonb
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT jsonb_build_object(
    'name', 'CancellationRequested',
    'message', 'job cancellation was requested',
    'requested_at', p_requested_at,
    'requested_by', p_requested_by,
    'reason', p_reason
  );
$$;

CREATE OR REPLACE FUNCTION workhorse.normalize_retry_policy_v1(p_policy jsonb)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
AS $$
DECLARE
  v_type text;
  v_delay numeric;
  v_initial numeric;
  v_multiplier numeric;
  v_max numeric;
  v_base numeric;
  v_max_delay constant numeric := 31536000000;
BEGIN
  IF p_policy IS NULL OR p_policy = 'null'::jsonb THEN RETURN NULL; END IF;
  IF jsonb_typeof(p_policy) <> 'object' THEN RAISE EXCEPTION 'retryPolicy must be an object'; END IF;
  v_type := p_policy->>'type';
  IF v_type = 'fixed' THEN
    IF p_policy <> jsonb_build_object('type', 'fixed', 'delayMs', p_policy->'delayMs')
       OR jsonb_typeof(p_policy->'delayMs') <> 'number' THEN
      RAISE EXCEPTION 'fixed retryPolicy requires exactly type and delayMs';
    END IF;
    v_delay := (p_policy->>'delayMs')::numeric;
    IF v_delay <> trunc(v_delay) OR v_delay NOT BETWEEN 0 AND v_max_delay THEN
      RAISE EXCEPTION 'fixed delayMs must be an integer between 0 and 31536000000';
    END IF;
    RETURN jsonb_build_object('type', 'fixed', 'delayMs', v_delay::bigint);
  ELSIF v_type = 'exponential' THEN
    IF p_policy <> jsonb_build_object('type', 'exponential', 'initialDelayMs', p_policy->'initialDelayMs', 'multiplier', p_policy->'multiplier', 'maxDelayMs', p_policy->'maxDelayMs')
       OR jsonb_typeof(p_policy->'initialDelayMs') <> 'number'
       OR jsonb_typeof(p_policy->'multiplier') <> 'number'
       OR jsonb_typeof(p_policy->'maxDelayMs') <> 'number' THEN
      RAISE EXCEPTION 'exponential retryPolicy requires exactly type, initialDelayMs, multiplier, and maxDelayMs';
    END IF;
    v_initial := (p_policy->>'initialDelayMs')::numeric;
    v_multiplier := (p_policy->>'multiplier')::numeric;
    v_max := (p_policy->>'maxDelayMs')::numeric;
    IF v_initial <> trunc(v_initial) OR v_initial NOT BETWEEN 0 AND v_max_delay THEN RAISE EXCEPTION 'exponential initialDelayMs must be an integer between 0 and 31536000000'; END IF;
    IF v_multiplier <> trunc(v_multiplier) OR v_multiplier NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'exponential multiplier must be an integer between 1 and 100'; END IF;
    IF v_max <> trunc(v_max) OR v_max NOT BETWEEN 0 AND v_max_delay OR v_max < v_initial THEN RAISE EXCEPTION 'exponential maxDelayMs must be an integer between initialDelayMs and 31536000000'; END IF;
    RETURN jsonb_build_object('type', 'exponential', 'initialDelayMs', v_initial::bigint, 'multiplier', v_multiplier::integer, 'maxDelayMs', v_max::bigint);
  ELSIF v_type = 'decorrelated-jitter' THEN
    IF p_policy <> jsonb_build_object('type', 'decorrelated-jitter', 'baseDelayMs', p_policy->'baseDelayMs', 'maxDelayMs', p_policy->'maxDelayMs')
       OR jsonb_typeof(p_policy->'baseDelayMs') <> 'number'
       OR jsonb_typeof(p_policy->'maxDelayMs') <> 'number' THEN
      RAISE EXCEPTION 'decorrelated-jitter retryPolicy requires exactly type, baseDelayMs, and maxDelayMs';
    END IF;
    v_base := (p_policy->>'baseDelayMs')::numeric;
    v_max := (p_policy->>'maxDelayMs')::numeric;
    IF v_base <> trunc(v_base) OR v_base NOT BETWEEN 0 AND v_max_delay THEN RAISE EXCEPTION 'decorrelated-jitter baseDelayMs must be an integer between 0 and 31536000000'; END IF;
    IF v_max <> trunc(v_max) OR v_max NOT BETWEEN 0 AND v_max_delay OR v_max < v_base THEN RAISE EXCEPTION 'decorrelated-jitter maxDelayMs must be an integer between baseDelayMs and 31536000000'; END IF;
    RETURN jsonb_build_object('type', 'decorrelated-jitter', 'baseDelayMs', v_base::bigint, 'maxDelayMs', v_max::bigint);
  END IF;
  RAISE EXCEPTION 'retryPolicy type must be fixed, exponential, or decorrelated-jitter';
END;
$$;

CREATE OR REPLACE FUNCTION workhorse.retry_delay_v1(
  p_job_id uuid, p_attempt integer, p_policy jsonb, p_previous_retry_delay_ms bigint,
  p_override_delay_ms integer, p_omitted_source text
) RETURNS TABLE (delay_ms bigint, source text, next_previous_retry_delay_ms bigint)
LANGUAGE plpgsql
AS $$
DECLARE
  v_policy jsonb := workhorse.normalize_retry_policy_v1(p_policy);
  v_base bigint;
  v_max bigint;
  v_upper bigint;
  v_hash bigint;
BEGIN
  IF p_job_id IS NULL OR p_attempt < 1 THEN RAISE EXCEPTION 'job identity and attempt are required'; END IF;
  IF p_override_delay_ms IS NOT NULL THEN
    delay_ms := GREATEST(0, p_override_delay_ms); source := 'override';
  ELSIF v_policy IS NULL THEN
    IF p_omitted_source = 'legacy-handler' THEN
      delay_ms := round((power((p_attempt - 1)::double precision, 4) + 15 + floor(random() * 10) * p_attempt) * 1000)::bigint;
      source := 'legacy-handler';
    ELSIF p_omitted_source = 'lease-recovery-immediate' THEN
      delay_ms := 0; source := 'lease-recovery-immediate';
    ELSIF p_omitted_source = 'execution-timeout-immediate' THEN
      delay_ms := 0; source := 'execution-timeout-immediate';
    ELSE
      RAISE EXCEPTION 'unsupported omitted retry source %', p_omitted_source;
    END IF;
  ELSIF v_policy->>'type' = 'fixed' THEN
    delay_ms := (v_policy->>'delayMs')::bigint; source := 'policy:fixed';
  ELSIF v_policy->>'type' = 'exponential' THEN
    delay_ms := LEAST((v_policy->>'maxDelayMs')::numeric, (v_policy->>'initialDelayMs')::numeric * power((v_policy->>'multiplier')::numeric, GREATEST(0, p_attempt - 1)))::bigint;
    source := 'policy:exponential';
  ELSE
    v_base := (v_policy->>'baseDelayMs')::bigint;
    v_max := (v_policy->>'maxDelayMs')::bigint;
    v_upper := LEAST(v_max, GREATEST(v_base, COALESCE(p_previous_retry_delay_ms, v_base) * 3));
    IF v_upper = v_base THEN delay_ms := v_base;
    ELSE
      v_hash := hashtextextended(
        p_job_id::text || ':' || p_attempt::text || ':' ||
        COALESCE(p_previous_retry_delay_ms::text, 'null'),
        0
      );
      delay_ms := v_base + mod(mod(v_hash, v_upper - v_base + 1) +
        (v_upper - v_base + 1), v_upper - v_base + 1);
    END IF;
    source := 'policy:decorrelated-jitter';
  END IF;
  next_previous_retry_delay_ms := CASE
    WHEN v_policy->>'type' = 'decorrelated-jitter' THEN delay_ms
  END;
  RETURN NEXT;
END;
$$;

-- Sparse per-queue operational control. The dispatch path remains a cheap anti-join when no queue
-- has been explicitly managed.
CREATE TABLE IF NOT EXISTS workhorse.queue_control (
  queue_name text PRIMARY KEY CHECK (queue_name <> ''),
  paused boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

-- Deployment-synchronized queue admission budgets. A missing row means no durable concurrency limit.
CREATE TABLE IF NOT EXISTS workhorse.concurrency_policy (
  queue_name text PRIMARY KEY CHECK (queue_name <> ''),
  namespace text NOT NULL CHECK (namespace <> '' AND octet_length(namespace) <= 256),
  max_active integer NOT NULL CHECK (max_active BETWEEN 1 AND 1000000),
  max_active_per_key integer,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT concurrency_policy_max_active_per_key_check CHECK (
    max_active_per_key IS NULL OR max_active_per_key BETWEEN 1 AND max_active
  )
);

-- Deployment-synchronized token buckets. PostgreSQL's wall clock is the sole refill authority.
-- A missing policy means starts are unrestricted; completed or failed work never refunds a token.
CREATE TABLE IF NOT EXISTS workhorse.rate_limit_policy (
  queue_name text PRIMARY KEY CHECK (queue_name <> ''),
  namespace text NOT NULL CHECK (namespace <> '' AND octet_length(namespace) <= 256),
  rate_limit integer NOT NULL CHECK (rate_limit BETWEEN 1 AND 1000000),
  rate_interval_ms integer NOT NULL CHECK (rate_interval_ms BETWEEN 1 AND 86400000),
  rate_burst integer NOT NULL CHECK (rate_burst BETWEEN 1 AND 1000000),
  per_key_limit integer,
  per_key_interval_ms integer,
  per_key_burst integer,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT rate_limit_policy_per_key_check CHECK (
    (per_key_limit IS NULL AND per_key_interval_ms IS NULL AND per_key_burst IS NULL)
    OR (
      per_key_limit BETWEEN 1 AND 1000000
      AND per_key_interval_ms BETWEEN 1 AND 86400000
      AND per_key_burst BETWEEN 1 AND 1000000
    )
  )
);

-- One row for the queue bucket plus one sparse row for each concurrency key that has attempted a
-- start. Policy deletion cascades state so redeployment starts with a full bucket deliberately.
CREATE TABLE IF NOT EXISTS workhorse.rate_limit_bucket (
  queue_name text NOT NULL REFERENCES workhorse.rate_limit_policy(queue_name) ON DELETE CASCADE,
  bucket_scope text NOT NULL CHECK (bucket_scope IN ('queue', 'key')),
  bucket_key text NOT NULL,
  tokens numeric NOT NULL CHECK (tokens >= 0),
  refilled_at timestamptz NOT NULL,
  PRIMARY KEY (queue_name, bucket_scope, bucket_key),
  CONSTRAINT rate_limit_bucket_scope_check CHECK (
    (bucket_scope = 'queue' AND bucket_key = '') OR bucket_scope = 'key'
  )
);
CREATE INDEX IF NOT EXISTS rate_limit_bucket_queue_refill_idx
  ON workhorse.rate_limit_bucket(queue_name, bucket_scope, refilled_at);

-- Durable worker fleet registration.
--
-- Every worker process announces itself here and refreshes `last_heartbeat_at` on its maintenance
-- cadence. This relation exists so that an operator surface running in a *different* process than
-- the workers can still observe and control the fleet: process-local memory cannot answer "which
-- workers exist" once workers are deployed independently of the web tier.
--
-- Ownership is deliberately split. The worker owns the reported runtime columns (`concurrency`,
-- `active_slots`, `draining`); PostgreSQL owns the operator-requested `paused` flag, which each
-- worker reads back on every registration heartbeat. This relation is never consulted by the claim
-- path and holds one row per live worker, so it cannot affect dispatch cost.
CREATE TABLE IF NOT EXISTS workhorse.worker_registry (
  worker_id text PRIMARY KEY CHECK (worker_id <> ''),
  -- One process incarnation of `worker_id`, generated fresh by every Worker instance.
  --
  -- This is what makes operator pause process-scoped: a routine heartbeat arrives with the same
  -- instance, while a restarted or replaced worker arrives with a new one. Without it PostgreSQL
  -- cannot tell "still running" from "started again" and the pause flag would be either
  -- indefinitely sticky or cleared by the very next heartbeat.
  instance_id uuid NOT NULL,
  -- Where this worker is running, recorded independently of what it is called.
  --
  -- Identity and placement are different questions. A deployment that configures a stable
  -- `workerId` gets a recognizable name but would otherwise lose any trace of which host or
  -- process it lives on, which is the first thing an operator asks about a busy worker.
  hostname text NOT NULL CHECK (hostname <> ''),
  pid integer NOT NULL CHECK (pid > 0),
  queue_name text NOT NULL CHECK (queue_name <> ''),
  concurrency integer NOT NULL CHECK (concurrency BETWEEN 1 AND 100),
  lease_ms integer NOT NULL CHECK (lease_ms > 0),
  heartbeat_ms integer NOT NULL CHECK (heartbeat_ms > 0 AND heartbeat_ms < lease_ms),
  poll_ms integer NOT NULL CHECK (poll_ms >= 0),
  maintenance_interval_ms integer NOT NULL CHECK (maintenance_interval_ms >= 100),
  maintenance_task_poll_ms integer NOT NULL CHECK (maintenance_task_poll_ms >= 100),
  registry_interval_ms integer NOT NULL CHECK (registry_interval_ms >= 100),
  active_slots integer NOT NULL DEFAULT 0 CHECK (active_slots >= 0),
  draining boolean NOT NULL DEFAULT false,
  paused boolean NOT NULL DEFAULT false,
  paused_by text CHECK (paused_by IS NULL OR paused_by <> ''),
  paused_reason text CHECK (paused_reason IS NULL OR paused_reason <> ''),
  paused_at timestamptz,
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_heartbeat_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX IF NOT EXISTS worker_registry_heartbeat_idx
  ON workhorse.worker_registry (last_heartbeat_at);

CREATE INDEX IF NOT EXISTS worker_registry_queue_idx
  ON workhorse.worker_registry (queue_name, worker_id);

-- Stable accepted-job identity and definition. Keyed debounce may replace the definition only
-- while its runtime remains pending; dispatch makes the accepted definition immutable.
CREATE TABLE IF NOT EXISTS workhorse.job (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  queue_name text NOT NULL CHECK (queue_name <> ''),
  job_type text NOT NULL CHECK (job_type <> ''),
  concurrency_key text CHECK (
    concurrency_key IS NULL OR (concurrency_key <> '' AND octet_length(concurrency_key) <= 256)
  ),
  payload jsonb NOT NULL,
  contract_version text CHECK (
    contract_version IS NULL OR char_length(contract_version) BETWEEN 1 AND 100
  ),
  payload_max_bytes integer NOT NULL DEFAULT 1048576 CHECK (
    payload_max_bytes BETWEEN 1 AND 16777216
  ),
  result_max_bytes integer NOT NULL DEFAULT 1048576 CHECK (
    result_max_bytes BETWEEN 1 AND 16777216
  ),
  payload_redact_keys text[] NOT NULL DEFAULT '{}'
    CHECK (workhorse.valid_contract_redact_keys_v1(payload_redact_keys)),
  result_redact_keys text[] NOT NULL DEFAULT '{}'
    CHECK (workhorse.valid_contract_redact_keys_v1(result_redact_keys)),
  trace_context jsonb
    CONSTRAINT job_trace_context_valid CHECK (workhorse.valid_trace_context_v1(trace_context)),
  tags text[] NOT NULL DEFAULT '{}'
    CONSTRAINT job_tags_valid CHECK (workhorse.valid_tags(tags)),
  max_attempts integer NOT NULL CHECK (max_attempts BETWEEN 1 AND 100),
  retry_policy jsonb
    CONSTRAINT job_retry_policy_normalized CHECK (
      retry_policy IS NULL OR (
        retry_policy <> 'null'::jsonb
        AND retry_policy = workhorse.normalize_retry_policy_v1(retry_policy)
      )
    ),
  deadline_at timestamptz CHECK (deadline_at IS NULL OR isfinite(deadline_at)),
  execution_timeout_ms bigint CHECK (execution_timeout_ms BETWEEN 1 AND 31536000000),
  CHECK (octet_length(payload::text) <= payload_max_bytes),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  priority integer NOT NULL DEFAULT 0 CHECK (priority BETWEEN 0 AND 100)
);
-- GIN indexes array elements so overlap and containment tag filters avoid scanning every job row.
CREATE INDEX IF NOT EXISTS job_tags_gin_idx ON workhorse.job USING gin (tags);
CREATE INDEX IF NOT EXISTS job_created_retention_idx ON workhorse.job (created_at, id);

-- Bounded immutable prerequisite edges. Prerequisite references deliberately restrict identity
-- pruning so retention cannot strand blocked work or erase released lineage.
CREATE TABLE IF NOT EXISTS workhorse.job_dependency (
  dependent_job_id uuid NOT NULL REFERENCES workhorse.job(id) ON DELETE CASCADE,
  prerequisite_job_id uuid NOT NULL REFERENCES workhorse.job(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  released_at timestamptz,
  on_failure text NOT NULL CHECK (on_failure IN ('release', 'cancel', 'fail')),
  on_cancellation text NOT NULL CHECK (on_cancellation IN ('release', 'cancel', 'fail')),
  on_success text NOT NULL CHECK (on_success IN ('release', 'cancel', 'fail')),
  resolution text CHECK (resolution IN ('release', 'cancel', 'fail')),
  PRIMARY KEY (dependent_job_id, prerequisite_job_id),
  CHECK (dependent_job_id <> prerequisite_job_id),
  CHECK (
    (released_at IS NULL AND resolution IS NULL)
    OR (released_at >= created_at AND resolution IS NOT NULL)
  )
);
CREATE INDEX IF NOT EXISTS job_dependency_prerequisite_pending_idx
  ON workhorse.job_dependency (prerequisite_job_id, dependent_job_id)
  WHERE released_at IS NULL;
CREATE INDEX IF NOT EXISTS job_dependency_prerequisite_idx
  ON workhorse.job_dependency (prerequisite_job_id, dependent_job_id);
CREATE INDEX IF NOT EXISTS job_dependency_dependent_pending_idx
  ON workhorse.job_dependency (dependent_job_id, prerequisite_job_id)
  WHERE released_at IS NULL;

-- Immutable named child edges support bounded fan-out. The parent owns edge lifetime. Retention
-- only removes it after every child is terminal and outside the configured evidence windows.
CREATE TABLE IF NOT EXISTS workhorse.job_child (
  parent_job_id uuid NOT NULL REFERENCES workhorse.job(id) ON DELETE CASCADE,
  child_job_id uuid NOT NULL UNIQUE REFERENCES workhorse.job(id) ON DELETE CASCADE,
  child_name text NOT NULL CHECK (child_name <> '' AND char_length(child_name) <= 200),
  request_fingerprint jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  joined_at timestamptz,
  created_as_set boolean NOT NULL DEFAULT false,
  PRIMARY KEY (parent_job_id, child_name),
  CHECK (parent_job_id <> child_job_id),
  CHECK (joined_at IS NULL OR joined_at >= created_at)
);
CREATE INDEX IF NOT EXISTS job_child_unjoined_idx
  ON workhorse.job_child (parent_job_id, child_job_id) WHERE joined_at IS NULL;
CREATE OR REPLACE FUNCTION workhorse.validate_job_dependency_v1()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_cycle uuid[];
  v_fan_out_root uuid;
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
  IF (
    SELECT count(*) FROM workhorse.job_dependency dependency
     WHERE dependency.prerequisite_job_id = NEW.prerequisite_job_id
  ) >= 100 THEN
    RAISE EXCEPTION 'a job accepts at most 100 dependent jobs';
  END IF;
  IF NEW.released_at IS NULL THEN
    WITH RECURSIVE graph(prerequisite_job_id, dependent_job_id) AS (
      SELECT dependency.prerequisite_job_id, dependency.dependent_job_id
        FROM workhorse.job_dependency dependency
       WHERE dependency.released_at IS NULL
      UNION
      SELECT NEW.prerequisite_job_id, NEW.dependent_job_id
    ), affected(root_job_id) AS (
      SELECT NEW.prerequisite_job_id
      UNION
      SELECT graph.prerequisite_job_id
        FROM affected
        JOIN graph ON graph.dependent_job_id = affected.root_job_id
    ), reachable(root_job_id, dependent_job_id) AS (
      SELECT affected.root_job_id, graph.dependent_job_id
        FROM affected
        JOIN graph ON graph.prerequisite_job_id = affected.root_job_id
      UNION
      SELECT reachable.root_job_id, graph.dependent_job_id
        FROM reachable
        JOIN graph ON graph.prerequisite_job_id = reachable.dependent_job_id
    )
    SELECT reachable.root_job_id INTO v_fan_out_root
      FROM reachable
     GROUP BY reachable.root_job_id
    HAVING count(*) > 100
     ORDER BY reachable.root_job_id
     LIMIT 1;
    IF v_fan_out_root IS NOT NULL THEN
      RAISE EXCEPTION
        'a job accepts at most 100 unresolved transitive dependent jobs';
    END IF;
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

-- PostgreSQL owns enqueue deduplication. The deferred reference lets enqueue reserve a scoped key
-- through the unique index before creating any job, event, FIFO, or notification side effects.
CREATE TABLE IF NOT EXISTS workhorse.enqueue_idempotency (
  idempotency_scope text NOT NULL CHECK (
    idempotency_scope <> '' AND octet_length(idempotency_scope) <= 256
  ),
  idempotency_key_hash bytea NOT NULL CHECK (octet_length(idempotency_key_hash) = 32),
  request_fingerprint jsonb NOT NULL,
  job_id uuid NOT NULL REFERENCES workhorse.job(id) DEFERRABLE INITIALLY DEFERRED,
  expires_at timestamptz NOT NULL CHECK (isfinite(expires_at)),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  coalescing_mode text NOT NULL DEFAULT 'idempotency'
    CHECK (coalescing_mode IN ('idempotency', 'debounce', 'throttle')),
  PRIMARY KEY (idempotency_scope, idempotency_key_hash)
);
CREATE INDEX IF NOT EXISTS enqueue_idempotency_expiry_idx
  ON workhorse.enqueue_idempotency (expires_at, idempotency_scope, idempotency_key_hash);

-- Immutable explicit restart boundaries. A name can be completed once for a stable job identity and
-- remains available across retries and terminal materialization.
CREATE TABLE IF NOT EXISTS workhorse.job_checkpoint (
  job_id uuid NOT NULL REFERENCES workhorse.job(id) ON DELETE CASCADE,
  checkpoint_name text NOT NULL CHECK (
    checkpoint_name <> '' AND char_length(checkpoint_name) <= 200
  ),
  checkpoint_value jsonb NOT NULL
    CONSTRAINT job_checkpoint_value_size CHECK (
      octet_length(checkpoint_value::text) <= 1048576
    ),
  attempt integer NOT NULL CHECK (attempt >= 1),
  fence_token bigint NOT NULL CHECK (fence_token > 0),
  worker_id text NOT NULL CHECK (worker_id <> ''),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (job_id, checkpoint_name)
);

-- One bounded mutable progress projection per stable identity. Progress is separate from immutable
-- payloads, checkpoints, and outcomes and retains provenance for its latest accepted change.
CREATE TABLE IF NOT EXISTS workhorse.job_progress (
  job_id uuid PRIMARY KEY REFERENCES workhorse.job(id) ON DELETE CASCADE,
  progress_value jsonb NOT NULL
    CONSTRAINT job_progress_value_size CHECK (
      octet_length(progress_value::text) <= 65536
    ),
  revision bigint NOT NULL CHECK (revision >= 1),
  attempt integer NOT NULL CHECK (attempt >= 1),
  fence_token bigint NOT NULL CHECK (fence_token > 0),
  worker_id text NOT NULL CHECK (worker_id <> ''),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

-- Immutable named durable timer boundaries. Relative waits preserve the first PostgreSQL-computed
-- target, while absolute waits preserve the caller's exact target for deterministic replay.
CREATE TABLE IF NOT EXISTS workhorse.job_wait (
  job_id uuid NOT NULL REFERENCES workhorse.job(id) ON DELETE CASCADE,
  wait_name text NOT NULL CHECK (wait_name <> '' AND char_length(wait_name) <= 200),
  mode text NOT NULL CHECK (mode IN ('relative', 'absolute')),
  duration_ms bigint,
  requested_wake_at timestamptz,
  wake_at timestamptz NOT NULL CHECK (isfinite(wake_at)),
  attempt integer NOT NULL CHECK (attempt >= 1),
  fence_token bigint NOT NULL CHECK (fence_token > 0),
  worker_id text NOT NULL CHECK (worker_id <> ''),
  claimed_at timestamptz NOT NULL CHECK (isfinite(claimed_at)),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (job_id, wait_name),
  CHECK (
    (mode = 'relative' AND duration_ms BETWEEN 1 AND 31536000000
      AND requested_wake_at IS NULL)
    OR
    (mode = 'absolute' AND duration_ms IS NULL AND requested_wake_at IS NOT NULL
      AND isfinite(requested_wake_at) AND wake_at = requested_wake_at)
  )
);

-- One named external signal boundary per stable job identity. A row starts as a fenced waiting
-- declaration and later retains the one accepted payload, idempotency identity, and audit actor.
CREATE TABLE IF NOT EXISTS workhorse.job_signal_wait (
  job_id uuid NOT NULL REFERENCES workhorse.job(id) ON DELETE CASCADE,
  signal_name text NOT NULL CHECK (signal_name <> '' AND char_length(signal_name) <= 200),
  attempt integer NOT NULL CHECK (attempt >= 1),
  fence_token bigint NOT NULL CHECK (fence_token > 0),
  worker_id text NOT NULL CHECK (worker_id <> ''),
  claimed_at timestamptz NOT NULL CHECK (isfinite(claimed_at)),
  payload jsonb CONSTRAINT job_signal_payload_size CHECK (
    payload IS NULL OR octet_length(payload::text) <= 65536
  ),
  idempotency_key_hash bytea CHECK (
    idempotency_key_hash IS NULL OR octet_length(idempotency_key_hash) = 32
  ),
  request_fingerprint jsonb,
  delivered_by text CHECK (
    delivered_by IS NULL OR (delivered_by <> '' AND char_length(delivered_by) <= 200)
  ),
  delivered_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  timeout_at timestamptz NOT NULL CONSTRAINT job_signal_wait_timeout_finite
    CHECK (isfinite(timeout_at)),
  PRIMARY KEY (job_id, signal_name),
  CHECK (
    (payload IS NULL AND idempotency_key_hash IS NULL AND request_fingerprint IS NULL
      AND delivered_by IS NULL AND delivered_at IS NULL)
    OR
    (payload IS NOT NULL AND idempotency_key_hash IS NOT NULL AND request_fingerprint IS NOT NULL
      AND delivered_by IS NOT NULL AND delivered_at IS NOT NULL)
  )
);

-- Monotonic ownership generations and FIFO placement generations.
CREATE SEQUENCE IF NOT EXISTS workhorse.fence_token_seq;
CREATE SEQUENCE IF NOT EXISTS workhorse.ready_sequence_seq;

-- The sole mutable row for a nonterminal job. State-specific columns are constrained so a runtime
-- cannot simultaneously represent ready, scheduled, and active ownership.
CREATE TABLE IF NOT EXISTS workhorse.job_runtime (
  job_id uuid PRIMARY KEY REFERENCES workhorse.job(id) ON DELETE CASCADE,
  queue_name text NOT NULL CHECK (queue_name <> ''),
  concurrency_key text CHECK (
    concurrency_key IS NULL OR (concurrency_key <> '' AND octet_length(concurrency_key) <= 256)
  ),
  state text NOT NULL CHECK (state IN ('blocked', 'scheduled', 'ready', 'active')),
  current_attempt integer NOT NULL DEFAULT 1 CHECK (current_attempt BETWEEN 1 AND 100),
  fence_token bigint NOT NULL DEFAULT 0 CHECK (fence_token >= 0),
  run_at timestamptz NOT NULL,
  ready_at timestamptz,
  sequence bigint,
  worker_id text,
  acquired_at timestamptz,
  heartbeat_at timestamptz,
  expires_at timestamptz,
  deadline_at timestamptz CHECK (deadline_at IS NULL OR isfinite(deadline_at)),
  execution_used_ms bigint NOT NULL DEFAULT 0 CHECK (
    execution_used_ms BETWEEN 0 AND 31536000000
  ),
  attempt_timeout_at timestamptz CHECK (
    attempt_timeout_at IS NULL OR isfinite(attempt_timeout_at)
  ),
  wait_name text,
  attempt_started_at timestamptz,
  cancel_requested_at timestamptz,
  cancel_requested_by text CHECK (
    cancel_requested_by IS NULL OR (cancel_requested_by <> '' AND char_length(cancel_requested_by) <= 200)
  ),
  cancel_reason text CHECK (
    cancel_reason IS NULL OR (cancel_reason <> '' AND char_length(cancel_reason) <= 2000)
  ),
  error jsonb,
  previous_retry_delay_ms bigint CHECK (
    previous_retry_delay_ms BETWEEN 0 AND 31536000000
  ),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  priority integer NOT NULL DEFAULT 0 CHECK (priority BETWEEN 0 AND 100),
  CHECK (wait_name IS NULL OR (wait_name <> '' AND char_length(wait_name) <= 200)),
  CHECK (
    (cancel_requested_at IS NULL AND cancel_requested_by IS NULL AND cancel_reason IS NULL)
    OR (state = 'active' AND cancel_requested_at IS NOT NULL)
  ),
  CONSTRAINT job_runtime_state_shape_check CHECK (
    (state = 'blocked' AND ready_at IS NULL AND sequence IS NULL AND worker_id IS NULL
      AND acquired_at IS NULL AND heartbeat_at IS NULL AND expires_at IS NULL
      AND attempt_timeout_at IS NULL AND fence_token = 0
      AND wait_name IS NULL AND attempt_started_at IS NULL)
    OR
    (state = 'scheduled' AND ready_at IS NULL AND sequence IS NULL AND worker_id IS NULL
      AND acquired_at IS NULL AND heartbeat_at IS NULL AND expires_at IS NULL
      AND attempt_timeout_at IS NULL
      AND fence_token = 0
      AND ((wait_name IS NULL AND attempt_started_at IS NULL)
        OR (wait_name IS NOT NULL AND attempt_started_at IS NOT NULL)))
    OR
    (state = 'ready' AND ready_at IS NOT NULL AND sequence IS NOT NULL AND worker_id IS NULL
      AND acquired_at IS NULL AND heartbeat_at IS NULL AND expires_at IS NULL
      AND attempt_timeout_at IS NULL
      AND fence_token = 0 AND wait_name IS NULL)
    OR
    (state = 'active' AND ready_at IS NULL AND sequence IS NULL AND worker_id IS NOT NULL
      AND acquired_at IS NOT NULL AND heartbeat_at IS NOT NULL AND expires_at IS NOT NULL
      AND fence_token > 0 AND wait_name IS NULL AND attempt_started_at IS NOT NULL)
  )
) WITH (fillfactor = 70);
CREATE INDEX IF NOT EXISTS job_runtime_ready_idx
  ON workhorse.job_runtime (queue_name, priority DESC, sequence, job_id) WHERE state = 'ready';
CREATE INDEX IF NOT EXISTS job_runtime_blocked_queue_idx
  ON workhorse.job_runtime (queue_name, job_id) WHERE state = 'blocked';
CREATE INDEX IF NOT EXISTS job_runtime_ready_age_idx
  ON workhorse.job_runtime (ready_at, job_id) WHERE state = 'ready';
CREATE INDEX IF NOT EXISTS job_runtime_scheduled_idx
  ON workhorse.job_runtime (run_at, job_id) WHERE state = 'scheduled';
CREATE INDEX IF NOT EXISTS job_runtime_scheduled_wait_idx
  ON workhorse.job_runtime (run_at, job_id)
  WHERE state = 'scheduled' AND wait_name IS NOT NULL;
CREATE INDEX IF NOT EXISTS job_runtime_expired_active_idx
  ON workhorse.job_runtime (expires_at, job_id) WHERE state = 'active';
CREATE INDEX IF NOT EXISTS job_runtime_active_queue_key_expiry_idx
  ON workhorse.job_runtime (queue_name, concurrency_key, expires_at, job_id)
  WHERE state = 'active';
CREATE INDEX IF NOT EXISTS job_runtime_deadline_idx
  ON workhorse.job_runtime (deadline_at, job_id) WHERE deadline_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS job_runtime_timeout_idx
  ON workhorse.job_runtime (attempt_timeout_at, job_id)
  WHERE state = 'active' AND attempt_timeout_at IS NOT NULL;

CREATE OR REPLACE FUNCTION workhorse.notify_concurrency_capacity_v1()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.state = 'active'
     AND (TG_OP = 'DELETE' OR NEW.state <> 'active')
     AND EXISTS (
       SELECT 1 FROM workhorse.concurrency_policy policy
        WHERE policy.queue_name = OLD.queue_name
     ) THEN
    PERFORM pg_notify('workhorse_jobs', OLD.queue_name);
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

CREATE OR REPLACE TRIGGER job_runtime_concurrency_capacity_update
AFTER UPDATE OF state ON workhorse.job_runtime
FOR EACH ROW EXECUTE FUNCTION workhorse.notify_concurrency_capacity_v1();

CREATE OR REPLACE TRIGGER job_runtime_concurrency_capacity_delete
AFTER DELETE ON workhorse.job_runtime
FOR EACH ROW EXECUTE FUNCTION workhorse.notify_concurrency_capacity_v1();

-- Immutable terminal materialization. Moving here removes completed work from every dispatch index.
CREATE TABLE IF NOT EXISTS workhorse.job_outcome (
  job_id uuid PRIMARY KEY REFERENCES workhorse.job(id) ON DELETE CASCADE,
  state text NOT NULL CHECK (state IN ('succeeded', 'failed', 'canceled')),
  current_attempt integer NOT NULL CHECK (current_attempt >= 1),
  fence_token bigint NOT NULL CHECK (fence_token >= 0),
  run_at timestamptz NOT NULL,
  result jsonb,
  error jsonb,
  finished_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  history_through_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (
    (state = 'succeeded' AND fence_token > 0 AND error IS NULL)
    OR (
      state = 'failed' AND (
        fence_token > 0
        OR (fence_token = 0 AND error->>'name' IN ('DeadlineExceeded', 'DependencyFailed'))
      )
    )
    OR (state = 'canceled' AND error IS NOT NULL)
  )
);
CREATE INDEX IF NOT EXISTS job_outcome_retention_idx
  ON workhorse.job_outcome (finished_at, job_id);
-- Failed outcomes are operationally cold and never participate in dispatch. This partial index
-- supports dead-letter keyset scans without adding failed work to any runtime dispatch index.
CREATE INDEX IF NOT EXISTS job_outcome_failed_finished_idx
  ON workhorse.job_outcome (finished_at DESC, job_id DESC) WHERE state = 'failed';
CREATE INDEX IF NOT EXISTS job_outcome_dependency_failed_idx
  ON workhorse.job_outcome (job_id)
  WHERE state = 'failed' AND error->>'name' = 'DependencyFailed';
CREATE INDEX IF NOT EXISTS job_outcome_dependency_canceled_idx
  ON workhorse.job_outcome (job_id)
  WHERE state = 'canceled' AND error->>'name' = 'DependencyCanceled';
-- Operator activity views ask which tasks changed inside a trailing window. Without this they have
-- to start from every job that ever existed; with it they start from the window. updated_at is
-- stamped once when the row is written, so this never costs a heartbeat a HOT update the way the
-- same index on job_runtime would.
CREATE INDEX IF NOT EXISTS job_outcome_updated_idx
  ON workhorse.job_outcome (updated_at, job_id);

-- Bounded operator metadata projection. Payloads and heartbeat-owned fields deliberately remain in
-- their authoritative relations so operator reads cannot become claim paths or churn on heartbeats.
CREATE TABLE IF NOT EXISTS workhorse.job_query (
  job_id uuid PRIMARY KEY REFERENCES workhorse.job(id) ON DELETE CASCADE,
  queue_name text NOT NULL CHECK (queue_name <> ''),
  job_type text NOT NULL CHECK (job_type <> ''),
  state text NOT NULL CHECK (
    state IN ('blocked', 'scheduled', 'ready', 'active', 'succeeded', 'failed', 'canceled')
  ),
  current_attempt integer NOT NULL CHECK (current_attempt BETWEEN 1 AND 100),
  run_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  cancel_requested_at timestamptz,
  cancel_requested_by text,
  cancel_reason text,
  CHECK (
    (cancel_requested_at IS NULL AND cancel_requested_by IS NULL AND cancel_reason IS NULL)
    OR (state IN ('active', 'canceled') AND cancel_requested_at IS NOT NULL)
  )
);
CREATE INDEX IF NOT EXISTS job_query_created_idx
  ON workhorse.job_query (created_at DESC, job_id DESC);
CREATE INDEX IF NOT EXISTS job_query_queue_created_idx
  ON workhorse.job_query (queue_name, created_at DESC, job_id DESC);
CREATE INDEX IF NOT EXISTS job_query_type_created_idx
  ON workhorse.job_query (job_type, created_at DESC, job_id DESC);
CREATE INDEX IF NOT EXISTS job_query_state_created_idx
  ON workhorse.job_query (state, created_at DESC, job_id DESC);

CREATE OR REPLACE FUNCTION workhorse.project_job_runtime_v1()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO workhorse.job_query(
    job_id, queue_name, job_type, state, current_attempt, run_at, created_at, updated_at,
    cancel_requested_at, cancel_requested_by, cancel_reason
  )
  SELECT
    NEW.job_id, NEW.queue_name, job.job_type, NEW.state, NEW.current_attempt, NEW.run_at,
    job.created_at, NEW.updated_at, NEW.cancel_requested_at, NEW.cancel_requested_by,
    NEW.cancel_reason
  FROM workhorse.job job
  WHERE job.id = NEW.job_id
  ON CONFLICT (job_id) DO UPDATE SET
    queue_name = EXCLUDED.queue_name,
    job_type = EXCLUDED.job_type,
    state = EXCLUDED.state,
    current_attempt = EXCLUDED.current_attempt,
    run_at = EXCLUDED.run_at,
    created_at = EXCLUDED.created_at,
    updated_at = EXCLUDED.updated_at,
    cancel_requested_at = EXCLUDED.cancel_requested_at,
    cancel_requested_by = EXCLUDED.cancel_requested_by,
    cancel_reason = EXCLUDED.cancel_reason;
  RETURN NEW;
END;
$$;
CREATE OR REPLACE TRIGGER job_runtime_query_projection_insert
  AFTER INSERT ON workhorse.job_runtime
  FOR EACH ROW EXECUTE FUNCTION workhorse.project_job_runtime_v1();
CREATE OR REPLACE TRIGGER job_runtime_query_projection_update
  AFTER UPDATE OF queue_name, state, current_attempt, run_at,
    cancel_requested_at, cancel_requested_by, cancel_reason
  ON workhorse.job_runtime
  FOR EACH ROW EXECUTE FUNCTION workhorse.project_job_runtime_v1();

CREATE OR REPLACE FUNCTION workhorse.project_job_outcome_v1()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO workhorse.job_query(
    job_id, queue_name, job_type, state, current_attempt, run_at, created_at, updated_at,
    cancel_requested_at, cancel_requested_by, cancel_reason
  )
  SELECT
    NEW.job_id, job.queue_name, job.job_type, NEW.state, NEW.current_attempt, NEW.run_at,
    job.created_at, NEW.updated_at,
    CASE WHEN NEW.state = 'canceled' THEN NULLIF(NEW.error->>'requested_at', '')::timestamptz END,
    CASE WHEN NEW.state = 'canceled' THEN NEW.error->>'requested_by' END,
    CASE WHEN NEW.state = 'canceled' THEN NEW.error->>'reason' END
  FROM workhorse.job job
  WHERE job.id = NEW.job_id
  ON CONFLICT (job_id) DO UPDATE SET
    queue_name = EXCLUDED.queue_name,
    job_type = EXCLUDED.job_type,
    state = EXCLUDED.state,
    current_attempt = EXCLUDED.current_attempt,
    run_at = EXCLUDED.run_at,
    created_at = EXCLUDED.created_at,
    updated_at = EXCLUDED.updated_at,
    cancel_requested_at = EXCLUDED.cancel_requested_at,
    cancel_requested_by = EXCLUDED.cancel_requested_by,
    cancel_reason = EXCLUDED.cancel_reason;
  RETURN NEW;
END;
$$;
CREATE OR REPLACE TRIGGER job_outcome_query_projection_insert
  AFTER INSERT ON workhorse.job_outcome
  FOR EACH ROW EXECUTE FUNCTION workhorse.project_job_outcome_v1();

-- Repeated v15 installation converges the projection from authoritative state without touching
-- payloads. Removing impossible orphan rows also repairs interrupted/manual pre-release installs.
INSERT INTO workhorse.job_query(
  job_id, queue_name, job_type, state, current_attempt, run_at, created_at, updated_at,
  cancel_requested_at, cancel_requested_by, cancel_reason
)
SELECT
  runtime.job_id, runtime.queue_name, job.job_type, runtime.state, runtime.current_attempt,
  runtime.run_at, job.created_at, runtime.updated_at, runtime.cancel_requested_at,
  runtime.cancel_requested_by, runtime.cancel_reason
FROM workhorse.job_runtime runtime
JOIN workhorse.job job ON job.id = runtime.job_id
UNION ALL
SELECT
  outcome.job_id, job.queue_name, job.job_type, outcome.state, outcome.current_attempt,
  outcome.run_at, job.created_at, outcome.updated_at,
  CASE WHEN outcome.state = 'canceled'
    THEN NULLIF(outcome.error->>'requested_at', '')::timestamptz END,
  CASE WHEN outcome.state = 'canceled' THEN outcome.error->>'requested_by' END,
  CASE WHEN outcome.state = 'canceled' THEN outcome.error->>'reason' END
FROM workhorse.job_outcome outcome
JOIN workhorse.job job ON job.id = outcome.job_id
ON CONFLICT (job_id) DO UPDATE SET
  queue_name = EXCLUDED.queue_name,
  job_type = EXCLUDED.job_type,
  state = EXCLUDED.state,
  current_attempt = EXCLUDED.current_attempt,
  run_at = EXCLUDED.run_at,
  created_at = EXCLUDED.created_at,
  updated_at = EXCLUDED.updated_at,
  cancel_requested_at = EXCLUDED.cancel_requested_at,
  cancel_requested_by = EXCLUDED.cancel_requested_by,
  cancel_reason = EXCLUDED.cancel_reason;
DELETE FROM workhorse.job_query query_row
WHERE NOT EXISTS (
  SELECT 1 FROM workhorse.job_runtime runtime WHERE runtime.job_id = query_row.job_id
)
AND NOT EXISTS (
  SELECT 1 FROM workhorse.job_outcome outcome WHERE outcome.job_id = query_row.job_id
);

-- Durable redrive lineage is both the idempotency record and the audit record. A source identity
-- cannot be removed while any descendant target still exists. Deleting a target removes its
-- incoming lineage edge, allowing retention to prune the source in a later pass.
CREATE TABLE IF NOT EXISTS workhorse.job_redrive (
  source_job_id uuid NOT NULL REFERENCES workhorse.job(id),
  target_job_id uuid NOT NULL UNIQUE REFERENCES workhorse.job(id) ON DELETE CASCADE,
  request_id_hash bytea NOT NULL CHECK (octet_length(request_id_hash) = 32),
  request_id_preview text NOT NULL,
  request_id_digest text NOT NULL CHECK (char_length(request_id_digest) = 12),
  request_id_length integer NOT NULL CHECK (request_id_length BETWEEN 1 AND 512),
  requested_by text NOT NULL CHECK (requested_by <> '' AND char_length(requested_by) <= 200),
  reason text NOT NULL CHECK (reason <> '' AND char_length(reason) <= 2000),
  request_fingerprint jsonb NOT NULL,
  source_state text NOT NULL DEFAULT 'failed' CHECK (source_state = 'failed'),
  target_initial_state text NOT NULL DEFAULT 'ready' CHECK (target_initial_state = 'ready'),
  requested_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (source_job_id, request_id_hash),
  CHECK (source_job_id <> target_job_id)
);
CREATE INDEX IF NOT EXISTS job_redrive_source_time_idx
  ON workhorse.job_redrive (source_job_id, requested_at, target_job_id);

CREATE OR REPLACE FUNCTION workhorse.redrive_lineage_v1(
  p_job_id uuid,
  p_limit integer
) RETURNS TABLE (
  source_job_id uuid,
  target_job_id uuid,
  requested_by text,
  reason text,
  request_id_preview text,
  request_id_digest text,
  request_id_length integer,
  source_state text,
  target_initial_state text,
  requested_at timestamptz
)
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v_frontier uuid[] := ARRAY[p_job_id];
  v_seen_nodes uuid[] := ARRAY[p_job_id];
  v_seen_edges uuid[] := '{}'::uuid[];
  v_node uuid;
  v_neighbor uuid;
  v_edge record;
  v_count integer := 0;
BEGIN
  IF p_job_id IS NULL THEN RAISE EXCEPTION 'lineage job identity is required'; END IF;
  IF p_limit NOT BETWEEN 1 AND 1001 THEN
    RAISE EXCEPTION 'redrive lineage limit must be between 1 and 1001';
  END IF;

  WHILE cardinality(v_frontier) > 0 AND v_count < p_limit LOOP
    v_node := v_frontier[1];
    v_frontier := COALESCE(v_frontier[2:cardinality(v_frontier)], '{}'::uuid[]);
    FOR v_edge IN
      SELECT edge.*
        FROM workhorse.job_redrive edge
       WHERE (edge.source_job_id = v_node OR edge.target_job_id = v_node)
         AND NOT edge.target_job_id = ANY(v_seen_edges)
       ORDER BY edge.requested_at, edge.source_job_id, edge.target_job_id
       LIMIT p_limit - v_count
    LOOP
      v_seen_edges := array_append(v_seen_edges, v_edge.target_job_id);
      v_count := v_count + 1;
      v_neighbor := CASE WHEN v_edge.source_job_id = v_node
        THEN v_edge.target_job_id ELSE v_edge.source_job_id END;
      IF NOT v_neighbor = ANY(v_seen_nodes) THEN
        v_seen_nodes := array_append(v_seen_nodes, v_neighbor);
        v_frontier := array_append(v_frontier, v_neighbor);
      END IF;
    END LOOP;
  END LOOP;

  RETURN QUERY
    SELECT edge.source_job_id, edge.target_job_id, edge.requested_by, edge.reason,
           edge.request_id_preview, edge.request_id_digest, edge.request_id_length,
           edge.source_state, edge.target_initial_state, edge.requested_at
      FROM workhorse.job_redrive edge
     WHERE edge.target_job_id = ANY(v_seen_edges)
     ORDER BY array_position(v_seen_edges, edge.target_job_id);
END;
$$;

-- Append-only lifecycle audit.
CREATE TABLE IF NOT EXISTS workhorse.job_event (
  event_id bigint GENERATED ALWAYS AS IDENTITY,
  job_id uuid NOT NULL,
  attempt integer,
  event_type text NOT NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp()
) PARTITION BY RANGE (occurred_at);
CREATE TABLE IF NOT EXISTS workhorse.job_event_default
  PARTITION OF workhorse.job_event DEFAULT;
CREATE INDEX IF NOT EXISTS job_event_job_time_idx
  ON workhorse.job_event (job_id, occurred_at, event_id);
CREATE INDEX IF NOT EXISTS job_event_retention_idx
  ON workhorse.job_event (occurred_at, event_id);

-- One immutable row for every closed attempt.
CREATE TABLE IF NOT EXISTS workhorse.attempt_history (
  attempt_id bigint GENERATED ALWAYS AS IDENTITY,
  job_id uuid NOT NULL,
  attempt integer NOT NULL,
  fence_token bigint NOT NULL,
  worker_id text NOT NULL,
  outcome text NOT NULL CHECK (
    outcome IN (
      'succeeded', 'failed', 'retry', 'lease_expired', 'canceled',
      'deadline_exceeded', 'timeout'
    )
  ),
  started_at timestamptz NOT NULL,
  claimed_at timestamptz NOT NULL,
  finished_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  error jsonb,
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp()
) PARTITION BY RANGE (occurred_at);
CREATE TABLE IF NOT EXISTS workhorse.attempt_history_default
  PARTITION OF workhorse.attempt_history DEFAULT;
CREATE INDEX IF NOT EXISTS attempt_history_job_idx
  ON workhorse.attempt_history (job_id, attempt, occurred_at);
CREATE INDEX IF NOT EXISTS attempt_history_job_time_idx
  ON workhorse.attempt_history (job_id, occurred_at, attempt_id);
CREATE INDEX IF NOT EXISTS attempt_history_retention_idx
  ON workhorse.attempt_history (occurred_at, attempt_id);

-- One database-owned schedule coordinates low-frequency maintenance across every worker process.
-- The IANA timezone and local time control the daily history-retention boundary; interval tasks remain
-- elapsed-time based so daylight-saving transitions cannot duplicate or suppress them.
CREATE TABLE IF NOT EXISTS workhorse.maintenance_policy (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  timezone text NOT NULL,
  partition_preparation_interval_ms integer NOT NULL CHECK (
    partition_preparation_interval_ms BETWEEN 60000 AND 604800000
  ),
  terminal_cleanup_interval_ms integer NOT NULL CHECK (
    terminal_cleanup_interval_ms BETWEEN 1000 AND 86400000
  ),
  history_retention_local_time time(0) NOT NULL,
  application_timezone text NOT NULL,
  application_partition_preparation_interval_ms integer NOT NULL CHECK (
    application_partition_preparation_interval_ms BETWEEN 60000 AND 604800000
  ),
  application_terminal_cleanup_interval_ms integer NOT NULL CHECK (
    application_terminal_cleanup_interval_ms BETWEEN 1000 AND 86400000
  ),
  application_history_retention_local_time time(0) NOT NULL,
  operator_overrides text[] NOT NULL DEFAULT '{}' CHECK (
    operator_overrides <@ ARRAY[
      'timezone', 'partition_preparation_interval_ms',
      'terminal_cleanup_interval_ms', 'history_retention_local_time'
    ]::text[]
  ),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
INSERT INTO workhorse.maintenance_policy(
  singleton, timezone, partition_preparation_interval_ms,
  terminal_cleanup_interval_ms, history_retention_local_time,
  application_timezone, application_partition_preparation_interval_ms,
  application_terminal_cleanup_interval_ms, application_history_retention_local_time
) VALUES (true, 'UTC', 21600000, 300000, '03:00', 'UTC', 21600000, 300000, '03:00')
ON CONFLICT (singleton) DO NOTHING;

CREATE TABLE IF NOT EXISTS workhorse.maintenance_state (
  task_name text PRIMARY KEY CHECK (
    task_name IN ('history_partitions', 'history_retention', 'terminal_storage')
  ),
  last_started_at timestamptz,
  last_completed_at timestamptz,
  last_completed_local_date date,
  history_retained_before timestamptz,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (
    (task_name = 'history_retention')
    OR (last_completed_local_date IS NULL AND history_retained_before IS NULL)
  )
);
INSERT INTO workhorse.maintenance_state(
  task_name, history_retained_before
) VALUES
  ('history_partitions', NULL),
  ('history_retention', date_trunc('day', clock_timestamp() AT TIME ZONE 'UTC')
    AT TIME ZONE 'UTC' - interval '14 days'),
  ('terminal_storage', NULL)
ON CONFLICT (task_name) DO NOTHING;

-- Rolling statistics. Operator time windows are answered from bounded per-minute aggregates rather
-- than from scans over retained history: one row per closed minute per (queue, task type) instead
-- of one row per event. Buckets are derived from raw history and recomputed idempotently, so a pass
-- that reruns a closed minute to absorb a late commit converges instead of double counting.
--
-- Measures are deliberately split by grain. Job-level measures count terminal jobs, attempt-level
-- measures count closed attempts, and a job that retried four times before succeeding contributes
-- one job_succeeded and five attempts. Conflating the two is the usual way a throughput panel
-- starts disagreeing with a task list.
CREATE TABLE IF NOT EXISTS workhorse.job_stat_bucket (
  bucket_start timestamptz NOT NULL CHECK (isfinite(bucket_start)),
  queue_name text NOT NULL CHECK (queue_name <> ''),
  job_type text NOT NULL CHECK (job_type <> ''),
  enqueued integer NOT NULL DEFAULT 0 CHECK (enqueued >= 0),
  job_succeeded integer NOT NULL DEFAULT 0 CHECK (job_succeeded >= 0),
  job_failed integer NOT NULL DEFAULT 0 CHECK (job_failed >= 0),
  job_canceled integer NOT NULL DEFAULT 0 CHECK (job_canceled >= 0),
  attempt_succeeded integer NOT NULL DEFAULT 0 CHECK (attempt_succeeded >= 0),
  attempt_failed integer NOT NULL DEFAULT 0 CHECK (attempt_failed >= 0),
  attempt_retry integer NOT NULL DEFAULT 0 CHECK (attempt_retry >= 0),
  attempt_lease_expired integer NOT NULL DEFAULT 0 CHECK (attempt_lease_expired >= 0),
  attempt_canceled integer NOT NULL DEFAULT 0 CHECK (attempt_canceled >= 0),
  -- Deadline and execution-timeout closures. They are errors but not handler failures, so they are
  -- counted apart from attempt_failed rather than folded into it.
  attempt_other integer NOT NULL DEFAULT 0 CHECK (attempt_other >= 0),
  attempt_duration_ms bigint NOT NULL DEFAULT 0 CHECK (attempt_duration_ms >= 0),
  last_attempt_at timestamptz,
  last_error text CHECK (last_error IS NULL OR char_length(last_error) <= 500),
  last_error_at timestamptz,
  PRIMARY KEY (bucket_start, queue_name, job_type)
);

-- One watermark for the derived aggregates above. Raw history retention is forbidden from crossing
-- it, so a stalled rollup degrades health instead of silently producing gaps that no later pass can
-- fill.
CREATE TABLE IF NOT EXISTS workhorse.job_stat_state (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  -- Exclusive, minute-aligned. Every closed minute below this is materialized in job_stat_bucket.
  rolled_up_through timestamptz NOT NULL CHECK (isfinite(rolled_up_through)),
  last_run_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
INSERT INTO workhorse.job_stat_state(singleton, rolled_up_through)
VALUES (true, date_bin('1 minute', clock_timestamp(), timestamp with time zone '2000-01-01'))
ON CONFLICT (singleton) DO NOTHING;

-- History deliberately has no reverse foreign key to job. Parent deletion would otherwise probe
-- every retained history partition. This insert-side lock preserves the important half of the
-- relationship: history must be attributed to an existing job, and insertion serializes with
-- terminal identity deletion without making deletion inspect every child partition.
CREATE OR REPLACE FUNCTION workhorse.lock_history_job_v1()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM 1 FROM workhorse.job WHERE id = NEW.job_id FOR KEY SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = 'foreign_key_violation',
      MESSAGE = format('history references missing workhorse job %s', NEW.job_id),
      CONSTRAINT = TG_TABLE_NAME || '_job_exists';
  END IF;
  UPDATE workhorse.job_outcome outcome
     SET history_through_at = GREATEST(outcome.history_through_at, NEW.occurred_at)
   WHERE outcome.job_id = NEW.job_id
     AND outcome.history_through_at < NEW.occurred_at;
  UPDATE workhorse.maintenance_state state
     SET history_retained_before = LEAST(
           state.history_retained_before,
           date_trunc('day', NEW.occurred_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
         ),
         updated_at = clock_timestamp()
   WHERE state.task_name = 'history_retention'
     AND state.history_retained_before IS NOT NULL
     AND NEW.occurred_at < state.history_retained_before;
  RETURN NEW;
END;
$$;
CREATE OR REPLACE TRIGGER job_event_job_exists
  BEFORE INSERT OR UPDATE OF job_id ON workhorse.job_event
  FOR EACH ROW EXECUTE FUNCTION workhorse.lock_history_job_v1();
CREATE OR REPLACE TRIGGER attempt_history_job_exists
  BEFORE INSERT OR UPDATE OF job_id ON workhorse.attempt_history
  FOR EACH ROW EXECUTE FUNCTION workhorse.lock_history_job_v1();

-- Declarative schedules are synchronized from application code and evaluated by worker processes.
-- Payloads, occurrence ownership, and queue semantics remain owned by the Workhorse protocol.
CREATE TABLE IF NOT EXISTS workhorse.schedule_definition (
  namespace text NOT NULL CHECK (namespace <> ''),
  schedule_name text NOT NULL CHECK (schedule_name <> ''),
  cron_expression text NOT NULL CHECK (cron_expression <> ''),
  queue_name text NOT NULL CHECK (queue_name <> ''),
  job_type text NOT NULL CHECK (job_type <> ''),
  concurrency_key text CHECK (
    concurrency_key IS NULL OR (concurrency_key <> '' AND octet_length(concurrency_key) <= 256)
  ),
  payload jsonb NOT NULL,
  contract_version text CHECK (
    contract_version IS NULL OR char_length(contract_version) BETWEEN 1 AND 100
  ),
  payload_max_bytes integer NOT NULL DEFAULT 1048576 CHECK (
    payload_max_bytes BETWEEN 1 AND 16777216
  ),
  result_max_bytes integer NOT NULL DEFAULT 1048576 CHECK (
    result_max_bytes BETWEEN 1 AND 16777216
  ),
  payload_redact_keys text[] NOT NULL DEFAULT '{}'
    CHECK (workhorse.valid_contract_redact_keys_v1(payload_redact_keys)),
  result_redact_keys text[] NOT NULL DEFAULT '{}'
    CHECK (workhorse.valid_contract_redact_keys_v1(result_redact_keys)),
  CHECK (octet_length(payload::text) <= payload_max_bytes),
  max_attempts integer NOT NULL CHECK (max_attempts BETWEEN 1 AND 100),
  retry_policy jsonb
    CONSTRAINT schedule_definition_retry_policy_normalized CHECK (
      retry_policy IS NULL OR (
        retry_policy <> 'null'::jsonb
        AND retry_policy = workhorse.normalize_retry_policy_v1(retry_policy)
      )
    ),
  enabled boolean NOT NULL DEFAULT true,
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  priority integer NOT NULL DEFAULT 0 CHECK (priority BETWEEN 0 AND 100),
  PRIMARY KEY (namespace, schedule_name)
);
-- One durable row per supplied occurrence second prevents workers from enqueueing the same cron
-- occurrence twice. Definitions are deactivated rather than deleted so historical occurrence
-- ownership remains explainable.
CREATE TABLE IF NOT EXISTS workhorse.schedule_occurrence (
  namespace text NOT NULL,
  schedule_name text NOT NULL,
  occurrence_at timestamptz NOT NULL,
  job_id uuid UNIQUE REFERENCES workhorse.job(id) ON DELETE SET NULL,
  fired_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (namespace, schedule_name, occurrence_at),
  FOREIGN KEY (namespace, schedule_name)
    REFERENCES workhorse.schedule_definition(namespace, schedule_name)
);
CREATE INDEX IF NOT EXISTS schedule_occurrence_time_idx
  ON workhorse.schedule_occurrence (namespace, schedule_name, occurrence_at DESC);
CREATE INDEX IF NOT EXISTS schedule_occurrence_retention_idx
  ON workhorse.schedule_occurrence (occurrence_at);
CREATE INDEX IF NOT EXISTS schedule_occurrence_job_idx
  ON workhorse.schedule_occurrence (job_id) WHERE job_id IS NOT NULL;

-- One durable policy controls background retention. Null minimum windows disable that category.
-- Identity remains the attribution anchor, so finite identity retention is accepted only when all
-- dependent history has a finite window no longer than the identity window.
CREATE TABLE IF NOT EXISTS workhorse.retention_policy (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  job_identity_retention_days integer CHECK (
    job_identity_retention_days IS NULL OR job_identity_retention_days BETWEEN 1 AND 36500
  ),
  terminal_outcome_retention_days integer CHECK (
    terminal_outcome_retention_days IS NULL OR terminal_outcome_retention_days BETWEEN 1 AND 36500
  ),
  job_event_retention_days integer CHECK (
    job_event_retention_days IS NULL OR job_event_retention_days BETWEEN 1 AND 36500
  ),
  attempt_history_retention_days integer CHECK (
    attempt_history_retention_days IS NULL OR attempt_history_retention_days BETWEEN 1 AND 36500
  ),
  schedule_occurrence_retention_days integer CHECK (
    schedule_occurrence_retention_days IS NULL
    OR schedule_occurrence_retention_days BETWEEN 1 AND 36500
  ),
  -- Derived statistics are deliberately outside the identity chain below. A bucket is not
  -- attribution for a job, it is a summary that outlives one, so keeping aggregates far longer than
  -- the history they were derived from is the intended configuration rather than a violation.
  statistics_retention_days integer CHECK (
    statistics_retention_days IS NULL OR statistics_retention_days BETWEEN 1 AND 36500
  ),
  terminal_job_prune_limit integer NOT NULL CHECK (terminal_job_prune_limit BETWEEN 1 AND 100000),
  history_partitions_per_pass integer NOT NULL CHECK (
    history_partitions_per_pass BETWEEN 1 AND 52
  ),
  default_partition_rows_per_pass integer NOT NULL CHECK (
    default_partition_rows_per_pass BETWEEN 1 AND 1000000
  ),
  occurrence_rows_per_pass integer NOT NULL CHECK (
    occurrence_rows_per_pass BETWEEN 1 AND 1000000
  ),
  statistics_rows_per_pass integer NOT NULL CHECK (
    statistics_rows_per_pass BETWEEN 1 AND 1000000
  ),
  application_job_identity_retention_days integer CHECK (
    application_job_identity_retention_days IS NULL
    OR application_job_identity_retention_days BETWEEN 1 AND 36500
  ),
  application_terminal_outcome_retention_days integer CHECK (
    application_terminal_outcome_retention_days IS NULL
    OR application_terminal_outcome_retention_days BETWEEN 1 AND 36500
  ),
  application_job_event_retention_days integer CHECK (
    application_job_event_retention_days IS NULL
    OR application_job_event_retention_days BETWEEN 1 AND 36500
  ),
  application_attempt_history_retention_days integer CHECK (
    application_attempt_history_retention_days IS NULL
    OR application_attempt_history_retention_days BETWEEN 1 AND 36500
  ),
  application_schedule_occurrence_retention_days integer CHECK (
    application_schedule_occurrence_retention_days IS NULL
    OR application_schedule_occurrence_retention_days BETWEEN 1 AND 36500
  ),
  application_statistics_retention_days integer CHECK (
    application_statistics_retention_days IS NULL
    OR application_statistics_retention_days BETWEEN 1 AND 36500
  ),
  application_terminal_job_prune_limit integer NOT NULL CHECK (
    application_terminal_job_prune_limit BETWEEN 1 AND 100000
  ),
  application_history_partitions_per_pass integer NOT NULL CHECK (
    application_history_partitions_per_pass BETWEEN 1 AND 52
  ),
  application_default_partition_rows_per_pass integer NOT NULL CHECK (
    application_default_partition_rows_per_pass BETWEEN 1 AND 1000000
  ),
  application_occurrence_rows_per_pass integer NOT NULL CHECK (
    application_occurrence_rows_per_pass BETWEEN 1 AND 1000000
  ),
  application_statistics_rows_per_pass integer NOT NULL CHECK (
    application_statistics_rows_per_pass BETWEEN 1 AND 1000000
  ),
  operator_overrides text[] NOT NULL DEFAULT '{}' CHECK (
    operator_overrides <@ ARRAY[
      'job_identity_retention_days', 'terminal_outcome_retention_days',
      'job_event_retention_days', 'attempt_history_retention_days',
      'schedule_occurrence_retention_days', 'statistics_retention_days',
      'terminal_job_prune_limit', 'history_partitions_per_pass',
      'default_partition_rows_per_pass', 'occurrence_rows_per_pass',
      'statistics_rows_per_pass'
    ]::text[]
  ),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (
    (terminal_outcome_retention_days IS NULL OR job_identity_retention_days IS NOT NULL)
    AND (
      job_identity_retention_days IS NULL
      OR (
      terminal_outcome_retention_days IS NOT NULL
      AND job_event_retention_days IS NOT NULL
      AND attempt_history_retention_days IS NOT NULL
      AND schedule_occurrence_retention_days IS NOT NULL
      AND job_identity_retention_days >= terminal_outcome_retention_days
      AND job_identity_retention_days >= job_event_retention_days
      AND job_identity_retention_days >= attempt_history_retention_days
      AND job_identity_retention_days >= schedule_occurrence_retention_days
      )
    )
  ),
  CHECK (
    (application_terminal_outcome_retention_days IS NULL
      OR application_job_identity_retention_days IS NOT NULL)
    AND (
      application_job_identity_retention_days IS NULL
      OR (
        application_terminal_outcome_retention_days IS NOT NULL
        AND application_job_event_retention_days IS NOT NULL
        AND application_attempt_history_retention_days IS NOT NULL
        AND application_schedule_occurrence_retention_days IS NOT NULL
        AND application_job_identity_retention_days >= application_terminal_outcome_retention_days
        AND application_job_identity_retention_days >= application_job_event_retention_days
        AND application_job_identity_retention_days >= application_attempt_history_retention_days
        AND application_job_identity_retention_days >= application_schedule_occurrence_retention_days
      )
    )
  )
);
INSERT INTO workhorse.retention_policy(
  singleton, job_identity_retention_days, terminal_outcome_retention_days,
  job_event_retention_days, attempt_history_retention_days,
  schedule_occurrence_retention_days, statistics_retention_days, terminal_job_prune_limit,
  history_partitions_per_pass, default_partition_rows_per_pass, occurrence_rows_per_pass,
  statistics_rows_per_pass, application_job_identity_retention_days,
  application_terminal_outcome_retention_days, application_job_event_retention_days,
  application_attempt_history_retention_days, application_schedule_occurrence_retention_days,
  application_statistics_retention_days, application_terminal_job_prune_limit,
  application_history_partitions_per_pass, application_default_partition_rows_per_pass,
  application_occurrence_rows_per_pass, application_statistics_rows_per_pass
) VALUES (
  true, 14, 14, 14, 14, 14, 14, 1000, 4, 10000, 10000, 10000,
  14, 14, 14, 14, 14, 14, 1000, 4, 10000, 10000, 10000
)
ON CONFLICT (singleton) DO NOTHING;

CREATE OR REPLACE FUNCTION workhorse.sync_retention_policy_v1(
  p_job_identity_retention_days integer,
  p_terminal_outcome_retention_days integer,
  p_job_event_retention_days integer,
  p_attempt_history_retention_days integer,
  p_schedule_occurrence_retention_days integer,
  p_statistics_retention_days integer DEFAULT NULL,
  p_terminal_job_prune_limit integer DEFAULT NULL,
  p_history_partitions_per_pass integer DEFAULT NULL,
  p_default_partition_rows_per_pass integer DEFAULT NULL,
  p_occurrence_rows_per_pass integer DEFAULT NULL,
  p_statistics_rows_per_pass integer DEFAULT NULL,
  p_force boolean DEFAULT false
) RETURNS workhorse.retention_policy
LANGUAGE plpgsql
AS $$
DECLARE v_policy workhorse.retention_policy%ROWTYPE;
DECLARE v_previous workhorse.retention_policy%ROWTYPE;
BEGIN
  SELECT * INTO STRICT v_previous
    FROM workhorse.retention_policy
   WHERE singleton
   FOR UPDATE;
  UPDATE workhorse.retention_policy policy SET
    application_job_identity_retention_days = p_job_identity_retention_days,
    application_terminal_outcome_retention_days = p_terminal_outcome_retention_days,
    application_job_event_retention_days = p_job_event_retention_days,
    application_attempt_history_retention_days = p_attempt_history_retention_days,
    application_schedule_occurrence_retention_days = p_schedule_occurrence_retention_days,
    application_statistics_retention_days = p_statistics_retention_days,
    application_terminal_job_prune_limit = COALESCE(
      p_terminal_job_prune_limit, policy.application_terminal_job_prune_limit
    ),
    application_history_partitions_per_pass = COALESCE(
      p_history_partitions_per_pass, policy.application_history_partitions_per_pass
    ),
    application_default_partition_rows_per_pass = COALESCE(
      p_default_partition_rows_per_pass, policy.application_default_partition_rows_per_pass
    ),
    application_occurrence_rows_per_pass = COALESCE(
      p_occurrence_rows_per_pass, policy.application_occurrence_rows_per_pass
    ),
    application_statistics_rows_per_pass = COALESCE(
      p_statistics_rows_per_pass, policy.application_statistics_rows_per_pass
    ),
    job_identity_retention_days = CASE
      WHEN p_force OR NOT ('job_identity_retention_days' = ANY(policy.operator_overrides))
        THEN p_job_identity_retention_days ELSE policy.job_identity_retention_days END,
    terminal_outcome_retention_days = CASE
      WHEN p_force OR NOT ('terminal_outcome_retention_days' = ANY(policy.operator_overrides))
        THEN p_terminal_outcome_retention_days ELSE policy.terminal_outcome_retention_days END,
    job_event_retention_days = CASE
      WHEN p_force OR NOT ('job_event_retention_days' = ANY(policy.operator_overrides))
        THEN p_job_event_retention_days ELSE policy.job_event_retention_days END,
    attempt_history_retention_days = CASE
      WHEN p_force OR NOT ('attempt_history_retention_days' = ANY(policy.operator_overrides))
        THEN p_attempt_history_retention_days ELSE policy.attempt_history_retention_days END,
    schedule_occurrence_retention_days = CASE
      WHEN p_force OR NOT ('schedule_occurrence_retention_days' = ANY(policy.operator_overrides))
        THEN p_schedule_occurrence_retention_days ELSE policy.schedule_occurrence_retention_days END,
    statistics_retention_days = CASE
      WHEN p_force OR NOT ('statistics_retention_days' = ANY(policy.operator_overrides))
        THEN p_statistics_retention_days ELSE policy.statistics_retention_days END,
    terminal_job_prune_limit = CASE
      WHEN p_force THEN COALESCE(
        p_terminal_job_prune_limit, policy.application_terminal_job_prune_limit
      )
      WHEN p_terminal_job_prune_limit IS NULL THEN policy.terminal_job_prune_limit
      WHEN NOT ('terminal_job_prune_limit' = ANY(policy.operator_overrides))
        THEN p_terminal_job_prune_limit ELSE policy.terminal_job_prune_limit END,
    history_partitions_per_pass = CASE
      WHEN p_force THEN COALESCE(
        p_history_partitions_per_pass, policy.application_history_partitions_per_pass
      )
      WHEN p_history_partitions_per_pass IS NULL THEN policy.history_partitions_per_pass
      WHEN NOT ('history_partitions_per_pass' = ANY(policy.operator_overrides))
        THEN p_history_partitions_per_pass ELSE policy.history_partitions_per_pass END,
    default_partition_rows_per_pass = CASE
      WHEN p_force THEN COALESCE(
        p_default_partition_rows_per_pass, policy.application_default_partition_rows_per_pass
      )
      WHEN p_default_partition_rows_per_pass IS NULL THEN policy.default_partition_rows_per_pass
      WHEN NOT ('default_partition_rows_per_pass' = ANY(policy.operator_overrides))
        THEN p_default_partition_rows_per_pass ELSE policy.default_partition_rows_per_pass END,
    occurrence_rows_per_pass = CASE
      WHEN p_force THEN COALESCE(
        p_occurrence_rows_per_pass, policy.application_occurrence_rows_per_pass
      )
      WHEN p_occurrence_rows_per_pass IS NULL THEN policy.occurrence_rows_per_pass
      WHEN NOT ('occurrence_rows_per_pass' = ANY(policy.operator_overrides))
        THEN p_occurrence_rows_per_pass ELSE policy.occurrence_rows_per_pass END,
    statistics_rows_per_pass = CASE
      WHEN p_force THEN COALESCE(
        p_statistics_rows_per_pass, policy.application_statistics_rows_per_pass
      )
      WHEN p_statistics_rows_per_pass IS NULL THEN policy.statistics_rows_per_pass
      WHEN NOT ('statistics_rows_per_pass' = ANY(policy.operator_overrides))
        THEN p_statistics_rows_per_pass ELSE policy.statistics_rows_per_pass END,
    operator_overrides = CASE WHEN p_force THEN '{}'::text[] ELSE policy.operator_overrides END,
    updated_at = clock_timestamp()
  WHERE singleton
  RETURNING * INTO v_policy;
  IF (
       v_previous.job_event_retention_days IS DISTINCT FROM v_policy.job_event_retention_days
       OR v_previous.attempt_history_retention_days IS DISTINCT FROM
            v_policy.attempt_history_retention_days
       OR v_previous.schedule_occurrence_retention_days IS DISTINCT FROM
            v_policy.schedule_occurrence_retention_days
     ) THEN
    UPDATE workhorse.maintenance_state state
       SET history_retained_before = CASE
             WHEN v_policy.job_event_retention_days IS NOT NULL
              AND v_policy.attempt_history_retention_days IS NOT NULL THEN
               LEAST(
                 state.history_retained_before,
                 LEAST(
                   date_trunc('day', clock_timestamp() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
                     - make_interval(days => v_policy.job_event_retention_days),
                   date_trunc('day', clock_timestamp() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
                     - make_interval(days => v_policy.attempt_history_retention_days)
                 )
               )
             ELSE state.history_retained_before
           END,
           last_completed_local_date = NULL,
           updated_at = clock_timestamp()
     WHERE state.task_name = 'history_retention';
  END IF;
  RETURN v_policy;
END;
$$;

CREATE OR REPLACE FUNCTION workhorse.override_retention_policy_v1(
  p_overrides jsonb
) RETURNS workhorse.retention_policy
LANGUAGE plpgsql
AS $$
DECLARE v_policy workhorse.retention_policy%ROWTYPE;
DECLARE v_previous workhorse.retention_policy%ROWTYPE;
DECLARE v_names text[];
BEGIN
  IF p_overrides IS NULL OR jsonb_typeof(p_overrides) <> 'object'
     OR p_overrides = '{}'::jsonb THEN
    RAISE EXCEPTION 'retention override must be a non-empty object';
  END IF;
  SELECT array_agg(name ORDER BY name) INTO v_names FROM jsonb_object_keys(p_overrides) name;
  IF NOT v_names <@ ARRAY[
    'job_identity_retention_days', 'terminal_outcome_retention_days',
    'job_event_retention_days', 'attempt_history_retention_days',
    'schedule_occurrence_retention_days', 'statistics_retention_days',
    'terminal_job_prune_limit', 'history_partitions_per_pass',
    'default_partition_rows_per_pass', 'occurrence_rows_per_pass',
    'statistics_rows_per_pass'
  ]::text[] THEN
    RAISE EXCEPTION 'retention override contains unknown settings';
  END IF;

  SELECT * INTO STRICT v_previous FROM workhorse.retention_policy WHERE singleton FOR UPDATE;
  UPDATE workhorse.retention_policy policy SET
    job_identity_retention_days = CASE WHEN p_overrides ? 'job_identity_retention_days'
      THEN (p_overrides->>'job_identity_retention_days')::integer
      ELSE policy.job_identity_retention_days END,
    terminal_outcome_retention_days = CASE WHEN p_overrides ? 'terminal_outcome_retention_days'
      THEN (p_overrides->>'terminal_outcome_retention_days')::integer
      ELSE policy.terminal_outcome_retention_days END,
    job_event_retention_days = CASE WHEN p_overrides ? 'job_event_retention_days'
      THEN (p_overrides->>'job_event_retention_days')::integer
      ELSE policy.job_event_retention_days END,
    attempt_history_retention_days = CASE WHEN p_overrides ? 'attempt_history_retention_days'
      THEN (p_overrides->>'attempt_history_retention_days')::integer
      ELSE policy.attempt_history_retention_days END,
    schedule_occurrence_retention_days = CASE
      WHEN p_overrides ? 'schedule_occurrence_retention_days'
        THEN (p_overrides->>'schedule_occurrence_retention_days')::integer
      ELSE policy.schedule_occurrence_retention_days END,
    statistics_retention_days = CASE WHEN p_overrides ? 'statistics_retention_days'
      THEN (p_overrides->>'statistics_retention_days')::integer
      ELSE policy.statistics_retention_days END,
    terminal_job_prune_limit = CASE WHEN p_overrides ? 'terminal_job_prune_limit'
      THEN (p_overrides->>'terminal_job_prune_limit')::integer
      ELSE policy.terminal_job_prune_limit END,
    history_partitions_per_pass = CASE WHEN p_overrides ? 'history_partitions_per_pass'
      THEN (p_overrides->>'history_partitions_per_pass')::integer
      ELSE policy.history_partitions_per_pass END,
    default_partition_rows_per_pass = CASE
      WHEN p_overrides ? 'default_partition_rows_per_pass'
        THEN (p_overrides->>'default_partition_rows_per_pass')::integer
      ELSE policy.default_partition_rows_per_pass END,
    occurrence_rows_per_pass = CASE WHEN p_overrides ? 'occurrence_rows_per_pass'
      THEN (p_overrides->>'occurrence_rows_per_pass')::integer
      ELSE policy.occurrence_rows_per_pass END,
    statistics_rows_per_pass = CASE WHEN p_overrides ? 'statistics_rows_per_pass'
      THEN (p_overrides->>'statistics_rows_per_pass')::integer
      ELSE policy.statistics_rows_per_pass END,
    operator_overrides = ARRAY(
      SELECT DISTINCT name FROM unnest(policy.operator_overrides || v_names) name ORDER BY name
    ),
    updated_at = clock_timestamp()
  WHERE singleton
  RETURNING * INTO v_policy;
  IF (
       v_previous.job_event_retention_days IS DISTINCT FROM v_policy.job_event_retention_days
       OR v_previous.attempt_history_retention_days IS DISTINCT FROM
            v_policy.attempt_history_retention_days
       OR v_previous.schedule_occurrence_retention_days IS DISTINCT FROM
            v_policy.schedule_occurrence_retention_days
     ) THEN
    UPDATE workhorse.maintenance_state state
       SET history_retained_before = CASE
             WHEN v_policy.job_event_retention_days IS NOT NULL
              AND v_policy.attempt_history_retention_days IS NOT NULL THEN
               LEAST(
                 state.history_retained_before,
                 LEAST(
                   date_trunc('day', clock_timestamp() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
                     - make_interval(days => v_policy.job_event_retention_days),
                   date_trunc('day', clock_timestamp() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
                     - make_interval(days => v_policy.attempt_history_retention_days)
                 )
               )
             ELSE state.history_retained_before
           END,
           last_completed_local_date = NULL,
           updated_at = clock_timestamp()
     WHERE state.task_name = 'history_retention';
  END IF;
  RETURN v_policy;
END;
$$;

CREATE OR REPLACE FUNCTION workhorse.revert_retention_policy_v1(
  p_settings text[]
) RETURNS workhorse.retention_policy
LANGUAGE plpgsql
AS $$
DECLARE v_policy workhorse.retention_policy%ROWTYPE;
BEGIN
  IF p_settings IS NULL OR cardinality(p_settings) = 0 OR NOT p_settings <@ ARRAY[
    'job_identity_retention_days', 'terminal_outcome_retention_days',
    'job_event_retention_days', 'attempt_history_retention_days',
    'schedule_occurrence_retention_days', 'statistics_retention_days',
    'terminal_job_prune_limit', 'history_partitions_per_pass',
    'default_partition_rows_per_pass', 'occurrence_rows_per_pass',
    'statistics_rows_per_pass'
  ]::text[] THEN
    RAISE EXCEPTION 'retention revert must name known settings';
  END IF;
  UPDATE workhorse.retention_policy policy SET
    job_identity_retention_days = CASE WHEN 'job_identity_retention_days' = ANY(p_settings)
      THEN policy.application_job_identity_retention_days
      ELSE policy.job_identity_retention_days END,
    terminal_outcome_retention_days = CASE WHEN 'terminal_outcome_retention_days' = ANY(p_settings)
      THEN policy.application_terminal_outcome_retention_days
      ELSE policy.terminal_outcome_retention_days END,
    job_event_retention_days = CASE WHEN 'job_event_retention_days' = ANY(p_settings)
      THEN policy.application_job_event_retention_days ELSE policy.job_event_retention_days END,
    attempt_history_retention_days = CASE WHEN 'attempt_history_retention_days' = ANY(p_settings)
      THEN policy.application_attempt_history_retention_days
      ELSE policy.attempt_history_retention_days END,
    schedule_occurrence_retention_days = CASE
      WHEN 'schedule_occurrence_retention_days' = ANY(p_settings)
        THEN policy.application_schedule_occurrence_retention_days
      ELSE policy.schedule_occurrence_retention_days END,
    statistics_retention_days = CASE WHEN 'statistics_retention_days' = ANY(p_settings)
      THEN policy.application_statistics_retention_days ELSE policy.statistics_retention_days END,
    terminal_job_prune_limit = CASE WHEN 'terminal_job_prune_limit' = ANY(p_settings)
      THEN policy.application_terminal_job_prune_limit ELSE policy.terminal_job_prune_limit END,
    history_partitions_per_pass = CASE WHEN 'history_partitions_per_pass' = ANY(p_settings)
      THEN policy.application_history_partitions_per_pass ELSE policy.history_partitions_per_pass END,
    default_partition_rows_per_pass = CASE
      WHEN 'default_partition_rows_per_pass' = ANY(p_settings)
        THEN policy.application_default_partition_rows_per_pass
      ELSE policy.default_partition_rows_per_pass END,
    occurrence_rows_per_pass = CASE WHEN 'occurrence_rows_per_pass' = ANY(p_settings)
      THEN policy.application_occurrence_rows_per_pass ELSE policy.occurrence_rows_per_pass END,
    statistics_rows_per_pass = CASE WHEN 'statistics_rows_per_pass' = ANY(p_settings)
      THEN policy.application_statistics_rows_per_pass ELSE policy.statistics_rows_per_pass END,
    operator_overrides = ARRAY(
      SELECT name FROM unnest(policy.operator_overrides) name WHERE NOT (name = ANY(p_settings))
    ),
    updated_at = clock_timestamp()
  WHERE singleton
  RETURNING * INTO v_policy;
  UPDATE workhorse.maintenance_state
     SET last_completed_local_date = NULL, updated_at = clock_timestamp()
   WHERE task_name = 'history_retention'
     AND p_settings && ARRAY[
       'job_event_retention_days', 'attempt_history_retention_days',
       'schedule_occurrence_retention_days'
     ]::text[];
  RETURN v_policy;
END;
$$;

CREATE OR REPLACE FUNCTION workhorse.get_retention_policy_v1()
RETURNS workhorse.retention_policy
LANGUAGE sql
STABLE
AS $$
  SELECT policy FROM workhorse.retention_policy policy WHERE singleton;
$$;

CREATE OR REPLACE FUNCTION workhorse.sync_maintenance_policy_v1(
  p_timezone text,
  p_partition_preparation_interval_ms integer DEFAULT NULL,
  p_terminal_cleanup_interval_ms integer DEFAULT NULL,
  p_history_retention_local_time time DEFAULT NULL,
  p_force boolean DEFAULT false
) RETURNS workhorse.maintenance_policy
LANGUAGE plpgsql
AS $$
DECLARE v_policy workhorse.maintenance_policy%ROWTYPE;
DECLARE v_previous workhorse.maintenance_policy%ROWTYPE;
BEGIN
  IF p_timezone IS NULL OR NOT EXISTS (
    SELECT 1 FROM pg_timezone_names timezone WHERE timezone.name = p_timezone
  ) THEN
    RAISE EXCEPTION 'maintenance timezone must be a valid IANA timezone name';
  END IF;
  SELECT * INTO STRICT v_previous FROM workhorse.maintenance_policy WHERE singleton FOR UPDATE;
  UPDATE workhorse.maintenance_policy policy SET
    application_timezone = p_timezone,
    application_partition_preparation_interval_ms = COALESCE(
      p_partition_preparation_interval_ms, policy.application_partition_preparation_interval_ms
    ),
    application_terminal_cleanup_interval_ms = COALESCE(
      p_terminal_cleanup_interval_ms, policy.application_terminal_cleanup_interval_ms
    ),
    application_history_retention_local_time = COALESCE(
      p_history_retention_local_time, policy.application_history_retention_local_time
    ),
    timezone = CASE WHEN p_force OR NOT ('timezone' = ANY(policy.operator_overrides))
      THEN p_timezone ELSE policy.timezone END,
    partition_preparation_interval_ms = CASE
      WHEN p_force THEN COALESCE(
        p_partition_preparation_interval_ms, policy.application_partition_preparation_interval_ms
      )
      WHEN p_partition_preparation_interval_ms IS NULL THEN policy.partition_preparation_interval_ms
      WHEN NOT ('partition_preparation_interval_ms' = ANY(policy.operator_overrides))
        THEN p_partition_preparation_interval_ms
      ELSE policy.partition_preparation_interval_ms END,
    terminal_cleanup_interval_ms = CASE
      WHEN p_force THEN COALESCE(
        p_terminal_cleanup_interval_ms, policy.application_terminal_cleanup_interval_ms
      )
      WHEN p_terminal_cleanup_interval_ms IS NULL THEN policy.terminal_cleanup_interval_ms
      WHEN NOT ('terminal_cleanup_interval_ms' = ANY(policy.operator_overrides))
        THEN p_terminal_cleanup_interval_ms
      ELSE policy.terminal_cleanup_interval_ms END,
    history_retention_local_time = CASE
      WHEN p_force THEN COALESCE(
        p_history_retention_local_time, policy.application_history_retention_local_time
      )
      WHEN p_history_retention_local_time IS NULL THEN policy.history_retention_local_time
      WHEN NOT ('history_retention_local_time' = ANY(policy.operator_overrides))
        THEN p_history_retention_local_time
      ELSE policy.history_retention_local_time END,
    operator_overrides = CASE WHEN p_force THEN '{}'::text[] ELSE policy.operator_overrides END,
    updated_at = clock_timestamp()
  WHERE singleton
  RETURNING * INTO v_policy;
  IF v_previous.timezone IS DISTINCT FROM v_policy.timezone
     OR v_previous.history_retention_local_time IS DISTINCT FROM v_policy.history_retention_local_time THEN
    UPDATE workhorse.maintenance_state
       SET last_completed_local_date = NULL, updated_at = clock_timestamp()
     WHERE task_name = 'history_retention';
  END IF;
  RETURN v_policy;
END;
$$;

CREATE OR REPLACE FUNCTION workhorse.override_maintenance_policy_v1(
  p_timezone text DEFAULT NULL,
  p_partition_preparation_interval_ms integer DEFAULT NULL,
  p_terminal_cleanup_interval_ms integer DEFAULT NULL,
  p_history_retention_local_time time DEFAULT NULL
) RETURNS workhorse.maintenance_policy
LANGUAGE plpgsql
AS $$
DECLARE v_policy workhorse.maintenance_policy%ROWTYPE;
DECLARE v_previous workhorse.maintenance_policy%ROWTYPE;
DECLARE v_overrides text[] := ARRAY[]::text[];
BEGIN
  IF p_timezone IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pg_timezone_names timezone WHERE timezone.name = p_timezone
  ) THEN
    RAISE EXCEPTION 'maintenance timezone must be a valid IANA timezone name';
  END IF;
  IF p_timezone IS NULL AND p_partition_preparation_interval_ms IS NULL
     AND p_terminal_cleanup_interval_ms IS NULL AND p_history_retention_local_time IS NULL THEN
    RAISE EXCEPTION 'maintenance override must include at least one setting';
  END IF;
  IF p_timezone IS NOT NULL THEN v_overrides := array_append(v_overrides, 'timezone'); END IF;
  IF p_partition_preparation_interval_ms IS NOT NULL THEN
    v_overrides := array_append(v_overrides, 'partition_preparation_interval_ms');
  END IF;
  IF p_terminal_cleanup_interval_ms IS NOT NULL THEN
    v_overrides := array_append(v_overrides, 'terminal_cleanup_interval_ms');
  END IF;
  IF p_history_retention_local_time IS NOT NULL THEN
    v_overrides := array_append(v_overrides, 'history_retention_local_time');
  END IF;

  SELECT * INTO STRICT v_previous FROM workhorse.maintenance_policy WHERE singleton FOR UPDATE;
  UPDATE workhorse.maintenance_policy policy SET
    timezone = COALESCE(p_timezone, policy.timezone),
    partition_preparation_interval_ms = COALESCE(
      p_partition_preparation_interval_ms, policy.partition_preparation_interval_ms
    ),
    terminal_cleanup_interval_ms = COALESCE(
      p_terminal_cleanup_interval_ms, policy.terminal_cleanup_interval_ms
    ),
    history_retention_local_time = COALESCE(
      p_history_retention_local_time, policy.history_retention_local_time
    ),
    operator_overrides = ARRAY(
      SELECT DISTINCT name FROM unnest(policy.operator_overrides || v_overrides) name ORDER BY name
    ),
    updated_at = clock_timestamp()
  WHERE singleton
  RETURNING * INTO v_policy;
  IF v_previous.timezone IS DISTINCT FROM v_policy.timezone
     OR v_previous.history_retention_local_time IS DISTINCT FROM v_policy.history_retention_local_time THEN
    UPDATE workhorse.maintenance_state
       SET last_completed_local_date = NULL, updated_at = clock_timestamp()
     WHERE task_name = 'history_retention';
  END IF;
  RETURN v_policy;
END;
$$;

CREATE OR REPLACE FUNCTION workhorse.revert_maintenance_policy_v1(
  p_settings text[]
) RETURNS workhorse.maintenance_policy
LANGUAGE plpgsql
AS $$
DECLARE v_policy workhorse.maintenance_policy%ROWTYPE;
DECLARE v_previous workhorse.maintenance_policy%ROWTYPE;
BEGIN
  IF p_settings IS NULL OR cardinality(p_settings) = 0 OR NOT p_settings <@ ARRAY[
    'timezone', 'partition_preparation_interval_ms',
    'terminal_cleanup_interval_ms', 'history_retention_local_time'
  ]::text[] THEN
    RAISE EXCEPTION 'maintenance revert must name known settings';
  END IF;
  SELECT * INTO STRICT v_previous FROM workhorse.maintenance_policy WHERE singleton FOR UPDATE;
  UPDATE workhorse.maintenance_policy policy SET
    timezone = CASE WHEN 'timezone' = ANY(p_settings)
      THEN policy.application_timezone ELSE policy.timezone END,
    partition_preparation_interval_ms = CASE
      WHEN 'partition_preparation_interval_ms' = ANY(p_settings)
        THEN policy.application_partition_preparation_interval_ms
      ELSE policy.partition_preparation_interval_ms END,
    terminal_cleanup_interval_ms = CASE
      WHEN 'terminal_cleanup_interval_ms' = ANY(p_settings)
        THEN policy.application_terminal_cleanup_interval_ms
      ELSE policy.terminal_cleanup_interval_ms END,
    history_retention_local_time = CASE
      WHEN 'history_retention_local_time' = ANY(p_settings)
        THEN policy.application_history_retention_local_time
      ELSE policy.history_retention_local_time END,
    operator_overrides = ARRAY(
      SELECT name FROM unnest(policy.operator_overrides) name WHERE NOT (name = ANY(p_settings))
    ),
    updated_at = clock_timestamp()
  WHERE singleton
  RETURNING * INTO v_policy;
  IF v_previous.timezone IS DISTINCT FROM v_policy.timezone
     OR v_previous.history_retention_local_time IS DISTINCT FROM v_policy.history_retention_local_time THEN
    UPDATE workhorse.maintenance_state
       SET last_completed_local_date = NULL, updated_at = clock_timestamp()
     WHERE task_name = 'history_retention';
  END IF;
  RETURN v_policy;
END;
$$;

CREATE OR REPLACE FUNCTION workhorse.get_maintenance_policy_v1()
RETURNS workhorse.maintenance_policy
LANGUAGE sql
STABLE
AS $$
  SELECT policy FROM workhorse.maintenance_policy policy WHERE singleton;
$$;

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

CREATE OR REPLACE FUNCTION workhorse.prune_schedule_occurrences_v1(
  p_before timestamptz, p_limit integer DEFAULT 10000
) RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  v_count integer;
BEGIN
  IF p_before IS NULL THEN RAISE EXCEPTION 'occurrence retention cutoff is required'; END IF;
  IF p_limit NOT BETWEEN 1 AND 1000000 THEN
    RAISE EXCEPTION 'occurrence prune limit must be between 1 and 1000000';
  END IF;

  WITH victims AS MATERIALIZED (
    SELECT occurrence.ctid
      FROM workhorse.schedule_occurrence occurrence
     WHERE occurrence.occurrence_at < p_before
     ORDER BY occurrence.occurrence_at
     LIMIT p_limit
     FOR UPDATE SKIP LOCKED
  )
  DELETE FROM workhorse.schedule_occurrence occurrence
   USING victims
   WHERE occurrence.ctid = victims.ctid;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

-- Synchronize queue concurrency policies as deployment-owned desired state. Omitted rows are pruned
-- by default, so one deployment cannot leave stale admission budgets behind indefinitely.
CREATE OR REPLACE FUNCTION workhorse.sync_concurrency_policies_v1(
  p_namespace text,
  p_definitions jsonb,
  p_prune boolean DEFAULT true
) RETURNS TABLE (
  namespace text,
  queue_name text,
  max_active integer,
  max_active_per_key integer,
  updated_at timestamptz
)
LANGUAGE plpgsql
AS $$
DECLARE
  v_definition jsonb;
  v_queue_name text;
  v_max_active numeric;
  v_max_active_per_key numeric;
  v_seen text[] := '{}';
BEGIN
  IF p_namespace IS NULL OR p_namespace = '' OR octet_length(p_namespace) > 256 THEN
    RAISE EXCEPTION 'concurrency policy namespace must contain between 1 and 256 UTF-8 bytes';
  END IF;
  IF p_definitions IS NULL OR jsonb_typeof(p_definitions) <> 'array' THEN
    RAISE EXCEPTION 'concurrency policy definitions must be a JSON array';
  END IF;
  IF jsonb_array_length(p_definitions) > 10000 THEN
    RAISE EXCEPTION 'concurrency policy definitions exceed maximum size of 10000';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('workhorse:concurrency-policies', 0));

  FOR v_definition IN SELECT value FROM jsonb_array_elements(p_definitions)
  LOOP
    IF jsonb_typeof(v_definition) <> 'object'
       OR v_definition - ARRAY['queue', 'maxActive', 'maxActivePerKey'] <> '{}'::jsonb
       OR NOT (v_definition ? 'queue')
       OR NOT (v_definition ? 'maxActive')
       OR jsonb_typeof(v_definition->'queue') <> 'string'
       OR jsonb_typeof(v_definition->'maxActive') <> 'number'
       OR (v_definition ? 'maxActivePerKey'
         AND v_definition->'maxActivePerKey' <> 'null'::jsonb
         AND jsonb_typeof(v_definition->'maxActivePerKey') <> 'number') THEN
      RAISE EXCEPTION 'each concurrency policy requires queue and maxActive, with optional maxActivePerKey';
    END IF;
    v_queue_name := v_definition->>'queue';
    v_max_active := (v_definition->>'maxActive')::numeric;
    v_max_active_per_key := (v_definition->>'maxActivePerKey')::numeric;
    IF v_queue_name = '' OR octet_length(v_queue_name) > 256 THEN
      RAISE EXCEPTION 'concurrency policy queue must contain between 1 and 256 UTF-8 bytes';
    END IF;
    IF v_queue_name = ANY(v_seen) THEN
      RAISE EXCEPTION 'concurrency policy queue names must be unique';
    END IF;
    IF v_max_active <> trunc(v_max_active) OR v_max_active NOT BETWEEN 1 AND 1000000 THEN
      RAISE EXCEPTION 'max_active must be an integer between 1 and 1000000';
    END IF;
    IF v_max_active_per_key IS NOT NULL AND (
      v_max_active_per_key <> trunc(v_max_active_per_key)
      OR v_max_active_per_key NOT BETWEEN 1 AND v_max_active
    ) THEN
      RAISE EXCEPTION 'max_active_per_key must be an integer between 1 and max_active';
    END IF;
    v_seen := array_append(v_seen, v_queue_name);
    PERFORM pg_advisory_xact_lock(
      hashtextextended('workhorse:concurrency-policy:' || v_queue_name, 0)
    );
    IF EXISTS (
      SELECT 1 FROM workhorse.concurrency_policy policy
       WHERE policy.queue_name = v_queue_name AND policy.namespace <> p_namespace
    ) THEN
      RAISE EXCEPTION 'concurrency policy queue is owned by another namespace';
    END IF;
    INSERT INTO workhorse.concurrency_policy AS policy(
      queue_name, namespace, max_active, max_active_per_key, updated_at
    ) VALUES (
      v_queue_name, p_namespace, v_max_active::integer, v_max_active_per_key::integer,
      clock_timestamp()
    )
    ON CONFLICT ON CONSTRAINT concurrency_policy_pkey DO UPDATE SET
      max_active = EXCLUDED.max_active,
      max_active_per_key = EXCLUDED.max_active_per_key,
      updated_at = CASE
        WHEN policy.max_active IS DISTINCT FROM EXCLUDED.max_active
          OR policy.max_active_per_key IS DISTINCT FROM EXCLUDED.max_active_per_key
        THEN EXCLUDED.updated_at ELSE policy.updated_at
      END;
  END LOOP;

  IF p_prune THEN
    FOR v_queue_name IN
      SELECT policy.queue_name
        FROM workhorse.concurrency_policy policy
       WHERE policy.namespace = p_namespace AND NOT (policy.queue_name = ANY(v_seen))
       ORDER BY policy.queue_name
    LOOP
      PERFORM pg_advisory_xact_lock(
        hashtextextended('workhorse:concurrency-policy:' || v_queue_name, 0)
      );
    END LOOP;
    DELETE FROM workhorse.concurrency_policy policy
     WHERE policy.namespace = p_namespace AND NOT (policy.queue_name = ANY(v_seen));
  END IF;

  PERFORM pg_notify('workhorse_jobs', '*');

  RETURN QUERY
    SELECT policy.namespace, policy.queue_name, policy.max_active, policy.max_active_per_key,
           policy.updated_at
      FROM workhorse.concurrency_policy policy
     WHERE policy.namespace = p_namespace
     ORDER BY policy.queue_name;
END;
$$;

-- Synchronize queue rate limits as deployment-owned desired state. A policy update keeps accrued
-- bucket state, clamps it to the new burst on the next observation, and never manufactures starts.
CREATE OR REPLACE FUNCTION workhorse.sync_rate_limit_policies_v1(
  p_namespace text,
  p_definitions jsonb,
  p_prune boolean DEFAULT true
) RETURNS TABLE (
  namespace text,
  queue_name text,
  rate_limit integer,
  rate_interval_ms integer,
  rate_burst integer,
  per_key_limit integer,
  per_key_interval_ms integer,
  per_key_burst integer,
  updated_at timestamptz
)
LANGUAGE plpgsql
AS $$
DECLARE
  v_definition jsonb;
  v_rate jsonb;
  v_per_key jsonb;
  v_queue_name text;
  v_rate_limit numeric;
  v_rate_interval_ms numeric;
  v_rate_burst numeric;
  v_per_key_limit numeric;
  v_per_key_interval_ms numeric;
  v_per_key_burst numeric;
  v_seen text[] := '{}';
BEGIN
  IF p_namespace IS NULL OR p_namespace = '' OR octet_length(p_namespace) > 256 THEN
    RAISE EXCEPTION 'rate-limit policy namespace must contain between 1 and 256 UTF-8 bytes';
  END IF;
  IF p_definitions IS NULL OR jsonb_typeof(p_definitions) <> 'array' THEN
    RAISE EXCEPTION 'rate-limit policy definitions must be a JSON array';
  END IF;
  IF jsonb_array_length(p_definitions) > 10000 THEN
    RAISE EXCEPTION 'rate-limit policy definitions exceed maximum size of 10000';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('workhorse:rate-limit-policies', 0));

  FOR v_definition IN SELECT value FROM jsonb_array_elements(p_definitions)
  LOOP
    IF jsonb_typeof(v_definition) <> 'object'
       OR v_definition - ARRAY['queue', 'rate', 'perKey'] <> '{}'::jsonb
       OR NOT (v_definition ? 'queue') OR NOT (v_definition ? 'rate')
       OR jsonb_typeof(v_definition->'queue') <> 'string'
       OR jsonb_typeof(v_definition->'rate') <> 'object'
       OR (v_definition ? 'perKey' AND v_definition->'perKey' <> 'null'::jsonb
         AND jsonb_typeof(v_definition->'perKey') <> 'object') THEN
      RAISE EXCEPTION 'each rate-limit policy requires queue and rate, with optional perKey';
    END IF;
    v_queue_name := v_definition->>'queue';
    v_rate := v_definition->'rate';
    v_per_key := v_definition->'perKey';
    IF v_queue_name = '' OR octet_length(v_queue_name) > 256 THEN
      RAISE EXCEPTION 'rate-limit policy queue must contain between 1 and 256 UTF-8 bytes';
    END IF;
    IF v_queue_name = ANY(v_seen) THEN
      RAISE EXCEPTION 'rate-limit policy queue names must be unique';
    END IF;
    IF v_rate - ARRAY['limit', 'intervalMs', 'burst'] <> '{}'::jsonb
       OR NOT (v_rate ?& ARRAY['limit', 'intervalMs', 'burst'])
       OR jsonb_typeof(v_rate->'limit') <> 'number'
       OR jsonb_typeof(v_rate->'intervalMs') <> 'number'
       OR jsonb_typeof(v_rate->'burst') <> 'number' THEN
      RAISE EXCEPTION 'rate requires numeric limit, intervalMs, and burst';
    END IF;
    IF v_per_key IS NOT NULL AND v_per_key <> 'null'::jsonb AND (
      v_per_key - ARRAY['limit', 'intervalMs', 'burst'] <> '{}'::jsonb
      OR NOT (v_per_key ?& ARRAY['limit', 'intervalMs', 'burst'])
      OR jsonb_typeof(v_per_key->'limit') <> 'number'
      OR jsonb_typeof(v_per_key->'intervalMs') <> 'number'
      OR jsonb_typeof(v_per_key->'burst') <> 'number'
    ) THEN
      RAISE EXCEPTION 'perKey requires numeric limit, intervalMs, and burst';
    END IF;
    v_rate_limit := (v_rate->>'limit')::numeric;
    v_rate_interval_ms := (v_rate->>'intervalMs')::numeric;
    v_rate_burst := (v_rate->>'burst')::numeric;
    v_per_key_limit := (v_per_key->>'limit')::numeric;
    v_per_key_interval_ms := (v_per_key->>'intervalMs')::numeric;
    v_per_key_burst := (v_per_key->>'burst')::numeric;
    IF v_rate_limit <> trunc(v_rate_limit) OR v_rate_limit NOT BETWEEN 1 AND 1000000
       OR v_rate_interval_ms <> trunc(v_rate_interval_ms)
       OR v_rate_interval_ms NOT BETWEEN 1 AND 86400000
       OR v_rate_burst <> trunc(v_rate_burst) OR v_rate_burst NOT BETWEEN 1 AND 1000000 THEN
      RAISE EXCEPTION 'rate values must be bounded positive integers';
    END IF;
    IF v_per_key_limit IS NOT NULL AND (
      v_per_key_limit <> trunc(v_per_key_limit) OR v_per_key_limit NOT BETWEEN 1 AND 1000000
      OR v_per_key_interval_ms <> trunc(v_per_key_interval_ms)
      OR v_per_key_interval_ms NOT BETWEEN 1 AND 86400000
      OR v_per_key_burst <> trunc(v_per_key_burst)
      OR v_per_key_burst NOT BETWEEN 1 AND 1000000
    ) THEN
      RAISE EXCEPTION 'perKey values must be bounded positive integers';
    END IF;
    v_seen := array_append(v_seen, v_queue_name);
    PERFORM pg_advisory_xact_lock(
      hashtextextended('workhorse:rate-limit-policy:' || v_queue_name, 0)
    );
    IF EXISTS (
      SELECT 1 FROM workhorse.rate_limit_policy policy
       WHERE policy.queue_name = v_queue_name AND policy.namespace <> p_namespace
    ) THEN
      RAISE EXCEPTION 'rate-limit policy queue is owned by another namespace';
    END IF;
    INSERT INTO workhorse.rate_limit_policy AS policy(
      queue_name, namespace, rate_limit, rate_interval_ms, rate_burst,
      per_key_limit, per_key_interval_ms, per_key_burst, updated_at
    ) VALUES (
      v_queue_name, p_namespace, v_rate_limit::integer, v_rate_interval_ms::integer,
      v_rate_burst::integer, v_per_key_limit::integer, v_per_key_interval_ms::integer,
      v_per_key_burst::integer, clock_timestamp()
    )
    ON CONFLICT ON CONSTRAINT rate_limit_policy_pkey DO UPDATE SET
      rate_limit = EXCLUDED.rate_limit,
      rate_interval_ms = EXCLUDED.rate_interval_ms,
      rate_burst = EXCLUDED.rate_burst,
      per_key_limit = EXCLUDED.per_key_limit,
      per_key_interval_ms = EXCLUDED.per_key_interval_ms,
      per_key_burst = EXCLUDED.per_key_burst,
      updated_at = CASE WHEN
        (policy.rate_limit, policy.rate_interval_ms, policy.rate_burst,
         policy.per_key_limit, policy.per_key_interval_ms, policy.per_key_burst)
        IS DISTINCT FROM
        (EXCLUDED.rate_limit, EXCLUDED.rate_interval_ms, EXCLUDED.rate_burst,
         EXCLUDED.per_key_limit, EXCLUDED.per_key_interval_ms, EXCLUDED.per_key_burst)
        THEN EXCLUDED.updated_at ELSE policy.updated_at END;
  END LOOP;

  IF p_prune THEN
    FOR v_queue_name IN
      SELECT policy.queue_name FROM workhorse.rate_limit_policy policy
       WHERE policy.namespace = p_namespace AND NOT (policy.queue_name = ANY(v_seen))
       ORDER BY policy.queue_name
    LOOP
      PERFORM pg_advisory_xact_lock(
        hashtextextended('workhorse:rate-limit-policy:' || v_queue_name, 0)
      );
    END LOOP;
    DELETE FROM workhorse.rate_limit_policy policy
     WHERE policy.namespace = p_namespace AND NOT (policy.queue_name = ANY(v_seen));
  END IF;

  PERFORM pg_notify('workhorse_jobs', '*');
  RETURN QUERY
    SELECT policy.namespace, policy.queue_name, policy.rate_limit, policy.rate_interval_ms,
           policy.rate_burst, policy.per_key_limit, policy.per_key_interval_ms,
           policy.per_key_burst, policy.updated_at
      FROM workhorse.rate_limit_policy policy
     WHERE policy.namespace = p_namespace ORDER BY policy.queue_name;
END;
$$;

-- Refill and optionally consume one durable token. Negative elapsed time is clamped to zero, so a
-- wall-clock correction can delay refill but can never create capacity.
CREATE OR REPLACE FUNCTION workhorse.rate_limit_bucket_v1(
  p_queue_name text,
  p_scope text,
  p_bucket_key text,
  p_limit integer,
  p_interval_ms integer,
  p_burst integer,
  p_now timestamptz,
  p_consume boolean DEFAULT false
) RETURNS TABLE (allowed boolean, tokens numeric, next_eligible_at timestamptz)
LANGUAGE plpgsql
AS $$
DECLARE
  v_bucket workhorse.rate_limit_bucket%ROWTYPE;
  v_tokens numeric;
  v_refill_baseline timestamptz;
  v_missing boolean := p_limit IS NULL OR (p_scope = 'key' AND p_bucket_key IS NULL);
BEGIN
  IF v_missing THEN
    allowed := true; tokens := NULL; next_eligible_at := NULL; RETURN NEXT; RETURN;
  END IF;
  SELECT * INTO v_bucket FROM workhorse.rate_limit_bucket bucket
   WHERE bucket.queue_name = p_queue_name AND bucket.bucket_scope = p_scope
     AND bucket.bucket_key = p_bucket_key
   FOR UPDATE;
  IF NOT FOUND THEN
    IF NOT p_consume THEN
      allowed := true; tokens := p_burst; next_eligible_at := NULL; RETURN NEXT; RETURN;
    END IF;
    INSERT INTO workhorse.rate_limit_bucket(
      queue_name, bucket_scope, bucket_key, tokens, refilled_at
    ) VALUES (p_queue_name, p_scope, p_bucket_key, p_burst, p_now)
    ON CONFLICT DO NOTHING;
    SELECT * INTO STRICT v_bucket FROM workhorse.rate_limit_bucket bucket
     WHERE bucket.queue_name = p_queue_name AND bucket.bucket_scope = p_scope
       AND bucket.bucket_key = p_bucket_key
     FOR UPDATE;
  END IF;
  v_tokens := LEAST(
    p_burst::numeric,
    v_bucket.tokens + GREATEST(
      0::numeric,
      extract(epoch FROM p_now - v_bucket.refilled_at) * 1000
    ) * p_limit::numeric / p_interval_ms::numeric
  );
  v_refill_baseline := GREATEST(p_now, v_bucket.refilled_at);
  allowed := v_tokens >= 1;
  IF allowed AND p_consume THEN v_tokens := v_tokens - 1; END IF;
  tokens := v_tokens;
  next_eligible_at := CASE WHEN allowed THEN p_now ELSE v_refill_baseline + make_interval(
    secs => CEIL((1 - v_tokens) * p_interval_ms::numeric / p_limit::numeric)::double precision / 1000
  ) END;
  IF p_consume THEN
    UPDATE workhorse.rate_limit_bucket bucket
       SET tokens = v_tokens, refilled_at = v_refill_baseline
     WHERE bucket.queue_name = p_queue_name AND bucket.bucket_scope = p_scope
       AND bucket.bucket_key = p_bucket_key;
  END IF;
  RETURN NEXT;
END;
$$;

-- Accept up to 1,000 jobs atomically. Scoped idempotency keys are resolved in ordinal order through
-- their unique index before any durable job side effects. Exact replays return the original identity;
-- material mismatches abort the whole statement with SQLSTATE P1001.
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

CREATE OR REPLACE FUNCTION workhorse.enqueue_debounce_v1(p_request jsonb)
RETURNS TABLE (job_id uuid, outcome text)
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
  v_runtime workhorse.job_runtime%ROWTYPE;
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

  SELECT identity.job_id, identity.request_fingerprint, identity.expires_at,
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
      FROM workhorse.job_runtime runtime
     WHERE runtime.job_id = v_existing.job_id
     FOR UPDATE;
  END IF;

  IF v_has_identity AND v_existing.expires_at > v_now THEN
    IF v_existing.coalescing_mode <> 'debounce'
       OR v_runtime.state IS NULL
       OR v_runtime.state NOT IN ('ready', 'scheduled') THEN
      INSERT INTO workhorse.job_event(job_id, event_type, details)
      VALUES (v_existing.job_id, 'debounce_rejected', jsonb_build_object(
        'state', COALESCE(v_runtime.state, 'terminal'),
        'reason', CASE WHEN v_existing.coalescing_mode <> 'debounce'
          THEN 'incompatible_key_mode' ELSE 'not_pending' END,
        'debounce', jsonb_build_object(
          'scope', v_scope, 'key_preview', v_key_preview, 'key_digest', v_key_digest,
          'key_length', v_key_length, 'window_ms', v_window_ms, 'schedule', v_schedule
        )
      ));
      job_id := v_existing.job_id;
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
        FROM workhorse.enqueue_many_v1(jsonb_build_array(v_normalized));
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
    );
    v_stored_digest := workhorse.sha256_hex_v1(v_existing.request_fingerprint::text);
    v_request_digest := workhorse.sha256_hex_v1(v_fingerprint::text);

    UPDATE workhorse.job SET
      queue_name = v_normalized->>'queue',
      job_type = v_normalized->>'type',
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
      execution_timeout_ms = (v_normalized->>'executionTimeoutMs')::bigint
    WHERE id = v_existing.job_id;

    v_state := CASE WHEN v_run_at <= v_now THEN 'ready' ELSE 'scheduled' END;
    v_sequence := CASE
      WHEN v_state = 'ready' AND v_runtime.state = 'ready' THEN v_runtime.sequence
      WHEN v_state = 'ready' THEN nextval('workhorse.ready_sequence_seq')
      ELSE NULL
    END;
    UPDATE workhorse.job_runtime runtime SET
      queue_name = v_normalized->>'queue',
      concurrency_key = v_normalized->>'concurrencyKey',
      priority = COALESCE((v_normalized->>'priority')::integer, 0),
      state = v_state,
      run_at = v_run_at,
      ready_at = CASE WHEN v_state = 'ready'
        THEN COALESCE(v_runtime.ready_at, v_now) ELSE NULL END,
      sequence = v_sequence,
      deadline_at = (v_normalized->>'deadline')::timestamptz,
      updated_at = v_now
    WHERE runtime.job_id = v_existing.job_id;

    UPDATE workhorse.enqueue_idempotency SET
      request_fingerprint = v_fingerprint,
      expires_at = v_expires_at
    WHERE idempotency_scope = v_scope AND idempotency_key_hash = v_key_hash;

    INSERT INTO workhorse.job_event(job_id, event_type, details)
    VALUES (v_existing.job_id, 'debounced', jsonb_build_object(
      'state', v_state, 'run_at', v_run_at,
      'stored_request_digest', v_stored_digest, 'request_digest', v_request_digest,
      'debounce', jsonb_build_object(
        'scope', v_scope, 'key_preview', v_key_preview, 'key_digest', v_key_digest,
        'key_length', v_key_length, 'window_ms', v_window_ms, 'schedule', v_schedule,
        'expires_at', v_expires_at
      )
    ));
    IF (v_normalized->>'deadline')::timestamptz <= v_now THEN
      PERFORM workhorse.terminalize_deadline_v1(v_existing.job_id);
    ELSIF v_state = 'ready' THEN
      PERFORM pg_notify('workhorse_jobs', v_normalized->>'queue');
    END IF;
    job_id := v_existing.job_id;
    outcome := 'replaced';
    RETURN NEXT;
    RETURN;
  END IF;

  IF v_has_identity AND v_existing.expires_at <= v_now
     AND v_runtime.state IN ('ready', 'scheduled') THEN
    INSERT INTO workhorse.job_event(job_id, event_type, details)
    VALUES (v_existing.job_id, 'debounce_rejected', jsonb_build_object(
      'state', v_runtime.state, 'reason', 'window_elapsed_pending',
      'debounce', jsonb_build_object(
        'scope', v_scope, 'key_preview', v_key_preview, 'key_digest', v_key_digest,
        'key_length', v_key_length, 'window_ms', v_window_ms, 'schedule', v_schedule
      )
    ));
    job_id := v_existing.job_id;
    outcome := 'non_replaceable';
    RETURN NEXT;
    RETURN;
  END IF;

  v_run_at := v_now + v_window_ms * interval '1 millisecond';
  v_normalized := (p_request - 'debounce') || jsonb_build_object(
    'runAt', v_run_at,
    'idempotency', jsonb_build_object('key', v_key, 'scope', v_scope, 'ttlMs', v_window_ms)
  );
  SELECT * INTO v_row FROM workhorse.enqueue_many_v1(jsonb_build_array(v_normalized));
  UPDATE workhorse.enqueue_idempotency SET coalescing_mode = 'debounce', expires_at = v_run_at
   WHERE idempotency_scope = v_scope AND idempotency_key_hash = v_key_hash;
  UPDATE workhorse.job_event event SET details = event.details || jsonb_build_object(
    'debounce', jsonb_build_object(
      'scope', v_scope, 'key_preview', v_key_preview, 'key_digest', v_key_digest,
      'key_length', v_key_length, 'window_ms', v_window_ms, 'schedule', v_schedule,
      'expires_at', v_run_at
    )
  ) || jsonb_build_object(
    'idempotency', jsonb_set(event.details->'idempotency', '{expires_at}', to_jsonb(v_run_at))
  ) WHERE event.job_id = v_row.job_id AND event.event_type = 'enqueued';
  job_id := v_row.job_id;
  outcome := CASE WHEN v_row.accepted THEN 'accepted' ELSE 'replayed' END;
  RETURN NEXT;
END;
$$;

CREATE OR REPLACE FUNCTION workhorse.enqueue_throttle_v1(p_request jsonb)
RETURNS TABLE (job_id uuid, outcome text)
LANGUAGE plpgsql
AS $$
DECLARE
  v_now timestamptz;
  v_throttle jsonb := p_request->'throttle';
  v_key text;
  v_scope text;
  v_key_hash bytea;
  v_window_ms numeric;
  v_existing record;
  v_normalized jsonb;
  v_row record;
BEGIN
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
  PERFORM pg_advisory_xact_lock(hashtextextended(v_scope || chr(31) || v_key, 0));
  v_now := clock_timestamp();
  SELECT identity.job_id, identity.expires_at, identity.coalescing_mode
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
  SELECT * INTO v_row FROM workhorse.enqueue_many_v1(jsonb_build_array(v_normalized));
  IF v_row.accepted THEN
    UPDATE workhorse.enqueue_idempotency SET coalescing_mode = 'throttle'
    WHERE idempotency_scope = v_scope AND idempotency_key_hash = v_key_hash;
  END IF;
  job_id := v_row.job_id;
  outcome := CASE WHEN v_row.accepted THEN 'accepted' ELSE 'coalesced' END;
  RETURN NEXT;
END;
$$;

CREATE OR REPLACE FUNCTION workhorse.enqueue_many_v2(p_requests jsonb)
RETURNS TABLE (ordinal integer, job_id uuid, outcome text)
LANGUAGE plpgsql
AS $$
DECLARE
  v_request jsonb;
  v_ordinal integer;
  v_row record;
  v_lock record;
  v_error_message text;
  v_error_detail text;
BEGIN
  IF p_requests IS NULL OR jsonb_typeof(p_requests) <> 'array' THEN
    RAISE EXCEPTION 'requests must be a JSON array';
  END IF;
  IF jsonb_array_length(p_requests) > 1000 THEN
    RAISE EXCEPTION 'enqueue batch exceeds maximum size of 1000';
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

  IF NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_requests) input(request)
     WHERE request ? 'debounce' OR request ? 'throttle'
  ) THEN
    RETURN QUERY
      SELECT result.ordinal, result.job_id,
             CASE WHEN result.accepted THEN 'accepted' ELSE 'replayed' END
        FROM workhorse.enqueue_many_v1(p_requests) result ORDER BY result.ordinal;
    RETURN;
  END IF;

  FOR v_request, v_ordinal IN
    SELECT request, ordinality::integer
      FROM jsonb_array_elements(p_requests) WITH ORDINALITY input(request, ordinality)
     ORDER BY ordinality
  LOOP
    IF v_request ? 'debounce' THEN
      SELECT * INTO v_row FROM workhorse.enqueue_debounce_v1(v_request);
      ordinal := v_ordinal;
      job_id := v_row.job_id;
      outcome := v_row.outcome;
    ELSIF v_request ? 'throttle' THEN
      BEGIN
        SELECT * INTO v_row FROM workhorse.enqueue_throttle_v1(v_request);
      EXCEPTION WHEN SQLSTATE 'P1001' THEN
        GET STACKED DIAGNOSTICS
          v_error_message = MESSAGE_TEXT,
          v_error_detail = PG_EXCEPTION_DETAIL;
        RAISE EXCEPTION USING
          ERRCODE = 'P1001',
          MESSAGE = v_error_message,
          DETAIL = (v_error_detail::jsonb || jsonb_build_object('ordinal', v_ordinal))::text;
      END;
      ordinal := v_ordinal;
      job_id := v_row.job_id;
      outcome := v_row.outcome;
    ELSE
      BEGIN
        SELECT * INTO v_row FROM workhorse.enqueue_many_v1(jsonb_build_array(v_request));
      EXCEPTION WHEN SQLSTATE 'P1001' THEN
        GET STACKED DIAGNOSTICS
          v_error_message = MESSAGE_TEXT,
          v_error_detail = PG_EXCEPTION_DETAIL;
        RAISE EXCEPTION USING
          ERRCODE = 'P1001',
          MESSAGE = v_error_message,
          DETAIL = (v_error_detail::jsonb || jsonb_build_object('ordinal', v_ordinal))::text;
      END;
      ordinal := v_ordinal;
      job_id := v_row.job_id;
      outcome := CASE WHEN v_row.accepted THEN 'accepted' ELSE 'replayed' END;
    END IF;
    RETURN NEXT;
  END LOOP;
END;
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

CREATE OR REPLACE FUNCTION workhorse.redrive_many_v1(
  p_filter jsonb,
  p_limit integer,
  p_dry_run boolean,
  p_requested_by text,
  p_reason text,
  p_request_id text,
  p_cursor_finished_at timestamptz DEFAULT NULL,
  p_cursor_job_id uuid DEFAULT NULL
) RETURNS TABLE (
  ordinal integer, status text, source_job_id uuid, target_job_id uuid,
  source_state text, target_state text, requested_at timestamptz,
  source_finished_at_cursor text, has_more boolean
)
LANGUAGE plpgsql
AS $$
DECLARE
  v_filter jsonb := COALESCE(p_filter, '{}'::jsonb);
  v_tags text[];
  v_finished_after timestamptz;
  v_finished_before timestamptz;
  v_candidate record;
BEGIN
  IF p_limit NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION 'bulk redrive limit must be between 1 and 1000';
  END IF;
  IF (p_cursor_finished_at IS NULL) <> (p_cursor_job_id IS NULL) THEN
    RAISE EXCEPTION 'bulk redrive cursor requires both finished_at and job_id';
  END IF;
  IF p_cursor_finished_at IS NOT NULL AND NOT isfinite(p_cursor_finished_at) THEN
    RAISE EXCEPTION 'bulk redrive cursor finished_at must be finite';
  END IF;
  IF p_dry_run IS NULL THEN RAISE EXCEPTION 'bulk redrive dry_run is required'; END IF;
  -- Validate attribution even for an empty selection and dry runs.
  IF p_requested_by IS NULL OR p_requested_by = '' OR char_length(p_requested_by) > 200 THEN
    RAISE EXCEPTION 'requested_by must contain between 1 and 200 characters';
  END IF;
  IF p_reason IS NULL OR p_reason = '' OR char_length(p_reason) > 2000 THEN
    RAISE EXCEPTION 'reason must contain between 1 and 2000 characters';
  END IF;
  IF p_request_id IS NULL OR p_request_id = '' OR octet_length(p_request_id) > 512 THEN
    RAISE EXCEPTION 'request_id must contain between 1 and 512 UTF-8 bytes';
  END IF;
  IF jsonb_typeof(v_filter) <> 'object'
     OR v_filter - ARRAY['queue', 'type', 'tags', 'errorName', 'finishedAfter', 'finishedBefore']
        <> '{}'::jsonb THEN
    RAISE EXCEPTION 'bulk redrive filter must be an object containing only queue, type, tags, errorName, finishedAfter, and finishedBefore';
  END IF;
  IF v_filter ? 'queue' AND (
       jsonb_typeof(v_filter->'queue') <> 'string' OR v_filter->>'queue' = ''
     ) THEN RAISE EXCEPTION 'bulk redrive queue filter must be a non-empty string'; END IF;
  IF v_filter ? 'type' AND (
       jsonb_typeof(v_filter->'type') <> 'string' OR v_filter->>'type' = ''
     ) THEN RAISE EXCEPTION 'bulk redrive type filter must be a non-empty string'; END IF;
  IF v_filter ? 'errorName' AND (
       jsonb_typeof(v_filter->'errorName') <> 'string' OR v_filter->>'errorName' = ''
     ) THEN RAISE EXCEPTION 'bulk redrive errorName filter must be a non-empty string'; END IF;
  IF v_filter ? 'tags' THEN
    IF jsonb_typeof(v_filter->'tags') <> 'array' THEN
      RAISE EXCEPTION 'bulk redrive tags filter must be an array';
    END IF;
    SELECT COALESCE(array_agg(value), '{}') INTO v_tags
      FROM jsonb_array_elements_text(v_filter->'tags') tag(value);
    IF NOT workhorse.valid_tags(v_tags) THEN
      RAISE EXCEPTION 'bulk redrive tags filter must contain at most 20 non-empty tags of at most 100 characters';
    END IF;
  END IF;
  IF v_filter ? 'finishedAfter' THEN
    IF jsonb_typeof(v_filter->'finishedAfter') <> 'string' THEN
      RAISE EXCEPTION 'bulk redrive finishedAfter filter must be a timestamp string';
    END IF;
    v_finished_after := (v_filter->>'finishedAfter')::timestamptz;
    IF NOT isfinite(v_finished_after) THEN RAISE EXCEPTION 'bulk redrive finishedAfter must be finite'; END IF;
  END IF;
  IF v_filter ? 'finishedBefore' THEN
    IF jsonb_typeof(v_filter->'finishedBefore') <> 'string' THEN
      RAISE EXCEPTION 'bulk redrive finishedBefore filter must be a timestamp string';
    END IF;
    v_finished_before := (v_filter->>'finishedBefore')::timestamptz;
    IF NOT isfinite(v_finished_before) THEN RAISE EXCEPTION 'bulk redrive finishedBefore must be finite'; END IF;
  END IF;
  IF v_finished_after IS NOT NULL AND v_finished_before IS NOT NULL
     AND v_finished_after >= v_finished_before THEN
    RAISE EXCEPTION 'bulk redrive finishedAfter must be earlier than finishedBefore';
  END IF;

  ordinal := 0;
  FOR v_candidate IN
    WITH candidates AS MATERIALIZED (
      SELECT outcome.job_id, outcome.finished_at
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
              (outcome.finished_at, outcome.job_id) > (p_cursor_finished_at, p_cursor_job_id))
       ORDER BY outcome.finished_at, outcome.job_id
       LIMIT p_limit + 1
    )
    SELECT candidate.job_id, candidate.finished_at,
           (SELECT count(*) FROM candidates) > p_limit AS has_more
      FROM candidates candidate
     ORDER BY candidate.finished_at, candidate.job_id
     LIMIT p_limit
  LOOP
    ordinal := ordinal + 1;
    IF p_dry_run THEN
      status := 'eligible';
      source_job_id := v_candidate.job_id;
      target_job_id := NULL;
      source_state := 'failed';
      target_state := NULL;
      requested_at := NULL;
      source_finished_at_cursor := to_char(
        v_candidate.finished_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
      );
      has_more := v_candidate.has_more;
      RETURN NEXT;
    ELSE
      RETURN QUERY
      SELECT ordinal, result.status, result.source_job_id, result.target_job_id,
             result.source_state, result.target_state, result.requested_at,
             to_char(
               v_candidate.finished_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
             ),
             v_candidate.has_more
        FROM workhorse.redrive_v1(
          v_candidate.job_id, p_requested_by, p_reason, p_request_id
        ) result;
    END IF;
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION workhorse.pause_queue_v1(p_queue_name text)
RETURNS boolean
LANGUAGE plpgsql
AS $$
BEGIN
  IF p_queue_name IS NULL OR p_queue_name = '' THEN
    RAISE EXCEPTION 'queue_name must not be empty';
  END IF;
  INSERT INTO workhorse.queue_control(queue_name, paused)
    VALUES (p_queue_name, true)
  ON CONFLICT (queue_name) DO UPDATE
    SET paused = true, updated_at = clock_timestamp();
  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION workhorse.resume_queue_v1(p_queue_name text)
RETURNS boolean
LANGUAGE plpgsql
AS $$
BEGIN
  IF p_queue_name IS NULL OR p_queue_name = '' THEN
    RAISE EXCEPTION 'queue_name must not be empty';
  END IF;
  INSERT INTO workhorse.queue_control(queue_name, paused)
    VALUES (p_queue_name, false)
  ON CONFLICT (queue_name) DO UPDATE
    SET paused = false, updated_at = clock_timestamp();
  RETURN false;
END;
$$;

-- Announce or refresh one worker registration and read back the operator-requested pause flag.
--
-- This is intentionally a single round trip: the worker pushes the runtime state it owns and pulls
-- the pause decision PostgreSQL owns.
--
-- Operator pause is deliberately **process-scoped**. A heartbeat from the same instance preserves
-- the flag; a new instance of the same worker id clears it, so a restarted or replaced worker
-- always comes back running. The durable lever for "stop processing this work" is queue pause,
-- which is keyed by queue name and unaffected by worker lifecycles. Keeping the two distinct means
-- a pause can never become a forgotten flag that silently idles a worker after a later deployment.
CREATE OR REPLACE FUNCTION workhorse.register_worker_v1(
  p_worker_id text,
  p_instance_id uuid,
  p_hostname text,
  p_pid integer,
  p_queue_name text,
  p_concurrency integer,
  p_lease_ms integer,
  p_heartbeat_ms integer,
  p_poll_ms integer,
  p_maintenance_interval_ms integer,
  p_maintenance_task_poll_ms integer,
  p_registry_interval_ms integer,
  p_active_slots integer,
  p_draining boolean
)
RETURNS boolean
LANGUAGE plpgsql
AS $$
DECLARE
  v_paused boolean;
BEGIN
  IF p_worker_id IS NULL OR p_worker_id = '' THEN
    RAISE EXCEPTION 'worker_id must not be empty';
  END IF;
  IF p_instance_id IS NULL THEN
    RAISE EXCEPTION 'instance_id must not be null';
  END IF;
  IF p_queue_name IS NULL OR p_queue_name = '' THEN
    RAISE EXCEPTION 'queue_name must not be empty';
  END IF;
  IF p_hostname IS NULL OR p_hostname = '' THEN
    RAISE EXCEPTION 'hostname must not be empty';
  END IF;
  IF p_pid IS NULL OR p_pid <= 0 THEN
    RAISE EXCEPTION 'pid must be positive';
  END IF;

  INSERT INTO workhorse.worker_registry AS registry
    (worker_id, instance_id, hostname, pid, queue_name, concurrency, lease_ms, heartbeat_ms,
     poll_ms, maintenance_interval_ms, maintenance_task_poll_ms, registry_interval_ms,
     active_slots, draining)
  VALUES (p_worker_id, p_instance_id, p_hostname, p_pid, p_queue_name, p_concurrency,
          p_lease_ms, p_heartbeat_ms, p_poll_ms, p_maintenance_interval_ms,
          p_maintenance_task_poll_ms, p_registry_interval_ms,
          COALESCE(p_active_slots, 0), COALESCE(p_draining, false))
  ON CONFLICT (worker_id) DO UPDATE
    SET instance_id = EXCLUDED.instance_id,
        hostname = EXCLUDED.hostname,
        pid = EXCLUDED.pid,
        queue_name = EXCLUDED.queue_name,
        concurrency = EXCLUDED.concurrency,
        lease_ms = EXCLUDED.lease_ms,
        heartbeat_ms = EXCLUDED.heartbeat_ms,
        poll_ms = EXCLUDED.poll_ms,
        maintenance_interval_ms = EXCLUDED.maintenance_interval_ms,
        maintenance_task_poll_ms = EXCLUDED.maintenance_task_poll_ms,
        registry_interval_ms = EXCLUDED.registry_interval_ms,
        active_slots = EXCLUDED.active_slots,
        draining = EXCLUDED.draining,
        last_heartbeat_at = clock_timestamp(),
        -- A new incarnation of this worker id is a different process, so it starts running and
        -- inherits no operator decision made about the process it replaced.
        started_at = CASE
          WHEN registry.instance_id = EXCLUDED.instance_id THEN registry.started_at
          ELSE clock_timestamp()
        END,
        paused = CASE
          WHEN registry.instance_id = EXCLUDED.instance_id THEN registry.paused
          ELSE false
        END,
        paused_by = CASE
          WHEN registry.instance_id = EXCLUDED.instance_id THEN registry.paused_by
          ELSE NULL
        END,
        paused_reason = CASE
          WHEN registry.instance_id = EXCLUDED.instance_id THEN registry.paused_reason
          ELSE NULL
        END,
        paused_at = CASE
          WHEN registry.instance_id = EXCLUDED.instance_id THEN registry.paused_at
          ELSE NULL
        END
  RETURNING registry.paused INTO v_paused;

  RETURN v_paused;
END;
$$;

-- Remove one worker registration during graceful shutdown. A worker that is killed instead simply
-- stops heartbeating and ages out of the fleet view.
CREATE OR REPLACE FUNCTION workhorse.deregister_worker_v1(p_worker_id text)
RETURNS boolean
LANGUAGE plpgsql
AS $$
DECLARE
  v_deleted integer;
BEGIN
  IF p_worker_id IS NULL OR p_worker_id = '' THEN
    RAISE EXCEPTION 'worker_id must not be empty';
  END IF;
  DELETE FROM workhorse.worker_registry WHERE worker_id = p_worker_id;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted > 0;
END;
$$;

-- Request or clear an operator pause for one registered worker.
--
-- `requested_by` and `reason` are bounded audit attribution, never authorization; callers must
-- enforce their own permission checks. The flag is advisory in exactly the same cooperative sense
-- as cancellation: the worker stops claiming when it next reads the flag, and any in-flight handler
-- runs to completion.
CREATE OR REPLACE FUNCTION workhorse.set_worker_paused_v1(
  p_worker_id text,
  p_paused boolean,
  p_requested_by text DEFAULT NULL,
  p_reason text DEFAULT NULL
)
RETURNS TABLE (
  worker_id text,
  paused boolean,
  paused_by text,
  paused_reason text,
  paused_at timestamptz,
  last_heartbeat_at timestamptz
)
LANGUAGE plpgsql
AS $$
BEGIN
  IF p_worker_id IS NULL OR p_worker_id = '' THEN
    RAISE EXCEPTION 'worker_id must not be empty';
  END IF;
  IF p_paused IS NULL THEN
    RAISE EXCEPTION 'paused must not be null';
  END IF;

  RETURN QUERY
  UPDATE workhorse.worker_registry AS registry
     SET paused = p_paused,
         paused_by = CASE WHEN p_paused THEN NULLIF(p_requested_by, '') ELSE NULL END,
         paused_reason = CASE WHEN p_paused THEN NULLIF(p_reason, '') ELSE NULL END,
         paused_at = CASE WHEN p_paused THEN clock_timestamp() ELSE NULL END
   WHERE registry.worker_id = p_worker_id
  RETURNING registry.worker_id, registry.paused, registry.paused_by, registry.paused_reason,
            registry.paused_at, registry.last_heartbeat_at;
END;
$$;

-- Drop registrations whose process stopped heartbeating long ago. The relation holds one row per
-- worker, so this stays a trivial bounded delete regardless of job volume.
CREATE OR REPLACE FUNCTION workhorse.prune_worker_registry_v1(
  p_max_age interval DEFAULT interval '1 day'
)
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  v_count integer;
BEGIN
  DELETE FROM workhorse.worker_registry
   WHERE last_heartbeat_at < clock_timestamp() - GREATEST(p_max_age, interval '1 minute');
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

CREATE OR REPLACE FUNCTION workhorse.purge_queue_v1(p_queue_name text)
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  v_count integer;
BEGIN
  IF p_queue_name IS NULL OR p_queue_name = '' THEN
    RAISE EXCEPTION 'queue_name must not be empty';
  END IF;
  INSERT INTO workhorse.queue_control(queue_name, paused)
    VALUES (p_queue_name, false)
  ON CONFLICT (queue_name) DO NOTHING;
  -- Lock both runtime and parent identities before taking a fresh statement snapshot for history
  -- deletion. The history insert trigger takes KEY SHARE on job, so it either commits before these
  -- deletes become visible or fails after the parent disappears; it cannot commit an orphan.
  PERFORM 1
    FROM workhorse.job_runtime runtime
    JOIN workhorse.job job ON job.id = runtime.job_id
   WHERE runtime.queue_name = p_queue_name AND runtime.state IN ('blocked', 'ready', 'scheduled')
   FOR UPDATE OF runtime, job;

  DELETE FROM workhorse.enqueue_idempotency idempotency
   USING workhorse.job_runtime runtime
   WHERE runtime.queue_name = p_queue_name AND runtime.state IN ('blocked', 'ready', 'scheduled')
     AND idempotency.job_id = runtime.job_id;
  DELETE FROM workhorse.job_event event
   USING workhorse.job_runtime runtime
   WHERE runtime.queue_name = p_queue_name AND runtime.state IN ('blocked', 'ready', 'scheduled')
     AND event.job_id = runtime.job_id;
  DELETE FROM workhorse.attempt_history attempt
   USING workhorse.job_runtime runtime
   WHERE runtime.queue_name = p_queue_name AND runtime.state IN ('blocked', 'ready', 'scheduled')
     AND attempt.job_id = runtime.job_id;
  DELETE FROM workhorse.job job
   USING workhorse.job_runtime runtime
   WHERE runtime.queue_name = p_queue_name AND runtime.state IN ('blocked', 'ready', 'scheduled')
     AND job.id = runtime.job_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

CREATE OR REPLACE FUNCTION workhorse.promote_v1(p_limit integer DEFAULT 100)
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  v_count integer;
BEGIN
  WITH due AS (
    SELECT r.job_id, r.wait_name, r.run_at AS wake_at FROM workhorse.job_runtime r
     WHERE r.state = 'scheduled' AND r.run_at <= clock_timestamp()
     ORDER BY r.run_at, r.job_id FOR UPDATE SKIP LOCKED
     LIMIT GREATEST(1, LEAST(p_limit, 10000))
  ), promoted AS (
    UPDATE workhorse.job_runtime r
       SET state = 'ready', ready_at = clock_timestamp(),
           sequence = nextval('workhorse.ready_sequence_seq'), wait_name = NULL,
           updated_at = clock_timestamp()
      FROM due d WHERE r.job_id = d.job_id AND r.state = 'scheduled'
    RETURNING r.job_id, r.queue_name, r.current_attempt, d.wait_name, d.wake_at
  ), events AS (
    INSERT INTO workhorse.job_event(job_id, attempt, event_type, details)
      SELECT job_id, current_attempt, 'promoted', '{}'::jsonb FROM promoted
      UNION ALL
      SELECT job_id, current_attempt, 'wait_elapsed',
             jsonb_build_object('name', wait_name, 'wake_at', wake_at, 'reason', 'due')
        FROM promoted WHERE wait_name IS NOT NULL
    RETURNING 1
  )
  SELECT count(*)::integer INTO v_count FROM promoted
   WHERE (SELECT count(*) FROM events) >= 0;
  IF v_count > 0 THEN PERFORM pg_notify('workhorse_jobs', '*'); END IF;
  RETURN v_count;
END;
$$;

-- Release one ordinary future-scheduled task without bypassing a durable wait. This operator path
-- deliberately changes only the task occurrence. It never reads or updates schedule_definition or
-- schedule_occurrence, so a recurring schedule's cadence and next evaluation remain untouched.
CREATE OR REPLACE FUNCTION workhorse.run_task_now_v1(p_job_id uuid)
RETURNS TABLE(status text, state text, run_at timestamptz)
LANGUAGE plpgsql
AS $$
DECLARE
  v_runtime workhorse.job_runtime%ROWTYPE;
  v_outcome workhorse.job_outcome%ROWTYPE;
  v_now timestamptz := clock_timestamp();
BEGIN
  SELECT * INTO v_runtime
    FROM workhorse.job_runtime runtime
   WHERE runtime.job_id = p_job_id
   FOR UPDATE;

  IF FOUND THEN
    IF v_runtime.state IN ('ready', 'active') THEN
      RETURN QUERY VALUES ('already_ready'::text, v_runtime.state, v_runtime.run_at);
      RETURN;
    END IF;

    -- A scheduled row with a retained attempt is suspended at a durable wait boundary. Releasing it
    -- would skip the named wait and violate durable execution semantics, so refuse even if wait_name
    -- is momentarily unavailable due to a racing reader.
    IF v_runtime.wait_name IS NOT NULL OR v_runtime.attempt_started_at IS NOT NULL THEN
      RETURN QUERY VALUES ('waiting'::text, v_runtime.state, v_runtime.run_at);
      RETURN;
    END IF;

    UPDATE workhorse.job_runtime runtime
       SET state = 'ready', run_at = v_now, ready_at = v_now,
           sequence = nextval('workhorse.ready_sequence_seq'), updated_at = v_now
     WHERE runtime.job_id = p_job_id AND runtime.state = 'scheduled'
    RETURNING * INTO v_runtime;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'locked scheduled task % changed state unexpectedly', p_job_id;
    END IF;

    INSERT INTO workhorse.job_event(job_id, attempt, event_type, details)
      VALUES (
        p_job_id,
        v_runtime.current_attempt,
        'promoted',
        jsonb_build_object('reason', 'manual')
      );
    PERFORM pg_notify('workhorse_jobs', '*');
    RETURN QUERY VALUES ('released'::text, v_runtime.state, v_runtime.run_at);
    RETURN;
  END IF;

  SELECT * INTO v_outcome
    FROM workhorse.job_outcome outcome
   WHERE outcome.job_id = p_job_id;
  IF FOUND THEN
    RETURN QUERY VALUES ('not_scheduled'::text, v_outcome.state, v_outcome.run_at);
    RETURN;
  END IF;

  IF EXISTS (SELECT 1 FROM workhorse.job job WHERE job.id = p_job_id) THEN
    RETURN QUERY VALUES ('not_scheduled'::text, NULL::text, NULL::timestamptz);
  ELSE
    RETURN QUERY VALUES ('not_found'::text, NULL::text, NULL::timestamptz);
  END IF;
END;
$$;

-- Policy-aware claim. Governed queues serialize the short admission transaction through policy
-- rows, count only unexpired active leases, refill durable rate tokens from PostgreSQL time, and
-- inspect at most the highest-priority 100 ready rows. Concurrency remains a dispatch budget rather than a
-- guarantee that expired handler code has stopped executing.
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

CREATE OR REPLACE FUNCTION workhorse.deadline_envelope_v1(p_deadline_at timestamptz)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT jsonb_build_object(
    'name', 'DeadlineExceeded',
    'message', 'job deadline was exceeded',
    'deadline_at', p_deadline_at
  );
$$;

CREATE OR REPLACE FUNCTION workhorse.timeout_envelope_v1(
  p_timeout_ms bigint, p_timeout_at timestamptz
) RETURNS jsonb
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT jsonb_build_object(
    'name', 'ExecutionTimeout',
    'message', 'attempt execution timeout was exceeded',
    'execution_timeout_ms', p_timeout_ms,
    'timeout_at', p_timeout_at
  );
$$;

-- Absolute deadlines are terminal regardless of attempt budget. The runtime row is locked and moved
-- once, so a handler completion, cancellation, or another reaper can win only by committing first.
CREATE OR REPLACE FUNCTION workhorse.terminalize_deadline_v1(p_job_id uuid)
RETURNS boolean
LANGUAGE plpgsql
AS $$
DECLARE
  v_runtime workhorse.job_runtime%ROWTYPE;
  v_error jsonb;
  v_worker_id text;
  v_fence_token bigint := 0;
  v_claimed_at timestamptz;
BEGIN
  SELECT * INTO v_runtime FROM workhorse.job_runtime runtime
   WHERE runtime.job_id = p_job_id FOR UPDATE;
  IF NOT FOUND OR v_runtime.deadline_at IS NULL
     OR v_runtime.deadline_at > clock_timestamp() THEN RETURN false; END IF;
  IF v_runtime.cancel_requested_at IS NOT NULL THEN
    v_error := workhorse.cancellation_envelope_v1(
      v_runtime.cancel_requested_at, v_runtime.cancel_requested_by, v_runtime.cancel_reason
    );
    DELETE FROM workhorse.job_runtime runtime WHERE runtime.job_id = p_job_id;
    INSERT INTO workhorse.job_outcome(
      job_id, state, current_attempt, fence_token, run_at, error
    ) VALUES (
      p_job_id, 'canceled', v_runtime.current_attempt, v_runtime.fence_token,
      v_runtime.run_at, v_error
    );
    INSERT INTO workhorse.attempt_history(
      job_id, attempt, fence_token, worker_id, outcome, started_at, claimed_at, error
    ) VALUES (
      p_job_id, v_runtime.current_attempt, v_runtime.fence_token, v_runtime.worker_id,
      'canceled', v_runtime.attempt_started_at, v_runtime.acquired_at, v_error
    );
    INSERT INTO workhorse.job_event(job_id, attempt, event_type, details)
      VALUES (
        p_job_id, v_runtime.current_attempt, 'canceled',
        jsonb_build_object(
          'requested_at', v_runtime.cancel_requested_at,
          'requested_by', v_runtime.cancel_requested_by,
          'reason', v_runtime.cancel_reason,
          'fence_token', v_runtime.fence_token::text,
          'source', 'deadline_reaper'
        )
      );
    RETURN true;
  END IF;
  v_error := workhorse.deadline_envelope_v1(v_runtime.deadline_at);
  IF v_runtime.state = 'active' THEN
    v_worker_id := v_runtime.worker_id;
    v_fence_token := v_runtime.fence_token;
    v_claimed_at := v_runtime.acquired_at;
  ELSIF v_runtime.attempt_started_at IS NOT NULL THEN
    SELECT provenance.worker_id, provenance.fence_token, provenance.claimed_at
      INTO STRICT v_worker_id, v_fence_token, v_claimed_at
      FROM (
        SELECT wait_row.worker_id, wait_row.fence_token, wait_row.claimed_at,
               wait_row.created_at, wait_row.wait_name AS name
          FROM workhorse.job_wait wait_row
         WHERE wait_row.job_id = p_job_id AND wait_row.attempt = v_runtime.current_attempt
        UNION ALL
        SELECT signal.worker_id, signal.fence_token, signal.claimed_at,
               signal.created_at, signal.signal_name AS name
          FROM workhorse.job_signal_wait signal
         WHERE signal.job_id = p_job_id AND signal.attempt = v_runtime.current_attempt
      ) provenance
     ORDER BY provenance.created_at DESC, provenance.name DESC LIMIT 1;
  END IF;
  DELETE FROM workhorse.job_runtime runtime WHERE runtime.job_id = p_job_id;
  INSERT INTO workhorse.job_outcome(
    job_id, state, current_attempt, fence_token, run_at, error
  ) VALUES (
    p_job_id, 'failed', v_runtime.current_attempt, v_fence_token, v_runtime.run_at, v_error
  );
  IF v_runtime.attempt_started_at IS NOT NULL THEN
    INSERT INTO workhorse.attempt_history(
      job_id, attempt, fence_token, worker_id, outcome, started_at, claimed_at, error
    ) VALUES (
      p_job_id, v_runtime.current_attempt, v_fence_token, v_worker_id,
      'deadline_exceeded', v_runtime.attempt_started_at, v_claimed_at, v_error
    );
  END IF;
  INSERT INTO workhorse.job_event(job_id, attempt, event_type, details)
    VALUES (
      p_job_id,
      CASE WHEN v_runtime.attempt_started_at IS NULL THEN NULL ELSE v_runtime.current_attempt END,
      'deadline_exceeded',
      jsonb_build_object(
        'deadline_at', v_runtime.deadline_at,
        'fence_token', v_fence_token::text,
        'started', v_runtime.attempt_started_at IS NOT NULL
      )
    );
  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION workhorse.timeout_owned_v1(
  p_job_id uuid, p_worker_id text, p_fence_token bigint
) RETURNS boolean
LANGUAGE plpgsql
AS $$
DECLARE
  v_runtime workhorse.job_runtime%ROWTYPE;
  v_job workhorse.job%ROWTYPE;
  v_error jsonb;
  v_retry record;
  v_state text;
  v_run_at timestamptz;
BEGIN
  SELECT * INTO v_runtime FROM workhorse.job_runtime runtime
   WHERE runtime.job_id = p_job_id AND runtime.state = 'active'
     AND runtime.worker_id = p_worker_id AND runtime.fence_token = p_fence_token
   FOR UPDATE;
  IF NOT FOUND OR v_runtime.attempt_timeout_at IS NULL
     OR v_runtime.attempt_timeout_at > clock_timestamp() THEN RETURN false; END IF;
  IF v_runtime.cancel_requested_at IS NOT NULL THEN RETURN false; END IF;
  SELECT * INTO STRICT v_job FROM workhorse.job job WHERE job.id = p_job_id;
  IF v_job.deadline_at IS NOT NULL
     AND v_job.deadline_at <= v_runtime.attempt_timeout_at
     AND v_job.deadline_at <= clock_timestamp() THEN
    RETURN workhorse.terminalize_deadline_v1(p_job_id);
  END IF;
  v_error := workhorse.timeout_envelope_v1(
    v_job.execution_timeout_ms, v_runtime.attempt_timeout_at
  );
  IF v_runtime.current_attempt < v_job.max_attempts THEN
    SELECT * INTO STRICT v_retry FROM workhorse.retry_delay_v1(
      p_job_id, v_runtime.current_attempt, v_job.retry_policy,
      v_runtime.previous_retry_delay_ms, NULL, 'execution-timeout-immediate'
    );
    v_run_at := clock_timestamp() +
      make_interval(secs => v_retry.delay_ms::double precision / 1000.0);
    v_state := CASE WHEN v_retry.delay_ms <= 0 THEN 'ready' ELSE 'scheduled' END;
    UPDATE workhorse.job_runtime runtime SET
      state = v_state,
      current_attempt = runtime.current_attempt + 1,
      fence_token = 0,
      run_at = v_run_at,
      ready_at = CASE WHEN v_state = 'ready' THEN clock_timestamp() END,
      sequence = CASE WHEN v_state = 'ready' THEN nextval('workhorse.ready_sequence_seq') END,
      worker_id = NULL,
      acquired_at = NULL,
      heartbeat_at = NULL,
      expires_at = NULL,
      wait_name = NULL,
      attempt_started_at = NULL,
      execution_used_ms = 0,
      attempt_timeout_at = NULL,
      previous_retry_delay_ms = v_retry.next_previous_retry_delay_ms,
      error = v_error,
      updated_at = clock_timestamp()
     WHERE runtime.job_id = p_job_id;
    IF v_state = 'ready' THEN PERFORM pg_notify('workhorse_jobs', v_job.queue_name); END IF;
    INSERT INTO workhorse.job_event(job_id, attempt, event_type, details)
      VALUES (
        p_job_id, v_runtime.current_attempt, 'execution_timed_out',
        jsonb_build_object(
          'fence_token', p_fence_token::text,
          'timeout_at', v_runtime.attempt_timeout_at,
          'execution_timeout_ms', v_job.execution_timeout_ms,
          'next_state', v_state,
          'next_attempt', v_runtime.current_attempt + 1,
          'retry_delay_ms', v_retry.delay_ms,
          'retry_delay_source', v_retry.source
        )
      );
  ELSE
    DELETE FROM workhorse.job_runtime runtime WHERE runtime.job_id = p_job_id;
    INSERT INTO workhorse.job_outcome(
      job_id, state, current_attempt, fence_token, run_at, error
    ) VALUES (
      p_job_id, 'failed', v_runtime.current_attempt, p_fence_token, v_runtime.run_at, v_error
    );
    INSERT INTO workhorse.job_event(job_id, attempt, event_type, details)
      VALUES (
        p_job_id, v_runtime.current_attempt, 'execution_timed_out',
        jsonb_build_object(
          'fence_token', p_fence_token::text,
          'timeout_at', v_runtime.attempt_timeout_at,
          'execution_timeout_ms', v_job.execution_timeout_ms,
          'next_state', 'failed'
        )
      );
  END IF;
  INSERT INTO workhorse.attempt_history(
    job_id, attempt, fence_token, worker_id, outcome, started_at, claimed_at, error
  ) VALUES (
    p_job_id, v_runtime.current_attempt, p_fence_token, p_worker_id, 'timeout',
    v_runtime.attempt_started_at, v_runtime.acquired_at, v_error
  );
  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION workhorse.expire_owned_v1(
  p_job_id uuid, p_worker_id text, p_fence_token bigint
) RETURNS text
LANGUAGE plpgsql
AS $$
DECLARE
  v_runtime workhorse.job_runtime%ROWTYPE;
BEGIN
  SELECT * INTO v_runtime FROM workhorse.job_runtime runtime
   WHERE runtime.job_id = p_job_id AND runtime.state = 'active'
     AND runtime.worker_id = p_worker_id AND runtime.fence_token = p_fence_token
   FOR UPDATE;
  IF NOT FOUND THEN RETURN 'stale'; END IF;
  IF v_runtime.cancel_requested_at IS NOT NULL THEN RETURN 'cancel_requested'; END IF;
  IF v_runtime.deadline_at IS NOT NULL AND v_runtime.deadline_at <= clock_timestamp()
     AND (
       v_runtime.attempt_timeout_at IS NULL
       OR v_runtime.attempt_timeout_at > clock_timestamp()
       OR v_runtime.deadline_at <= v_runtime.attempt_timeout_at
     ) THEN
    IF workhorse.terminalize_deadline_v1(p_job_id) THEN RETURN 'deadline_exceeded'; END IF;
    RETURN 'stale';
  END IF;
  IF v_runtime.attempt_timeout_at IS NOT NULL
     AND v_runtime.attempt_timeout_at <= clock_timestamp() THEN
    IF workhorse.timeout_owned_v1(p_job_id, p_worker_id, p_fence_token) THEN
      RETURN 'timeout_exceeded';
    END IF;
    RETURN 'stale';
  END IF;
  IF v_runtime.deadline_at IS NOT NULL AND v_runtime.deadline_at <= clock_timestamp() THEN
    IF workhorse.terminalize_deadline_v1(p_job_id) THEN RETURN 'deadline_exceeded'; END IF;
    RETURN 'stale';
  END IF;
  RETURN 'not_due';
END;
$$;

CREATE OR REPLACE FUNCTION workhorse.expire_owned_telemetry_v1(
  p_job_id uuid, p_worker_id text, p_fence_token bigint
) RETURNS TABLE(status text, retry_state text)
LANGUAGE plpgsql
AS $$
BEGIN
  status := workhorse.expire_owned_v1(p_job_id, p_worker_id, p_fence_token);
  SELECT runtime.state INTO retry_state FROM workhorse.job_runtime runtime
     WHERE runtime.job_id = p_job_id AND runtime.state IN ('ready', 'scheduled')
       AND status = 'timeout_exceeded';
  RETURN NEXT;
END;
$$;

CREATE OR REPLACE FUNCTION workhorse.heartbeat_v2(
  p_job_id uuid, p_worker_id text, p_fence_token bigint, p_lease_ms integer DEFAULT 30000
) RETURNS text
LANGUAGE plpgsql
AS $$
DECLARE
  v_runtime workhorse.job_runtime%ROWTYPE;
  v_queue_name text;
BEGIN
  IF p_worker_id IS NULL OR p_worker_id = '' THEN RAISE EXCEPTION 'worker_id must not be empty'; END IF;
  IF p_lease_ms NOT BETWEEN 100 AND 86400000 THEN
    RAISE EXCEPTION 'lease_ms must be between 100 and 86400000';
  END IF;
  SELECT r.queue_name INTO v_queue_name
    FROM workhorse.job_runtime r
   WHERE r.job_id = p_job_id AND r.state = 'active' AND r.worker_id = p_worker_id
     AND r.fence_token = p_fence_token;
  IF NOT FOUND THEN RETURN 'stale'; END IF;
  PERFORM pg_advisory_xact_lock_shared(
    hashtextextended('workhorse:concurrency-policy:' || v_queue_name, 0)
  );
  PERFORM 1 FROM workhorse.concurrency_policy policy
   WHERE policy.queue_name = v_queue_name
   FOR UPDATE;
  SELECT * INTO v_runtime
    FROM workhorse.job_runtime r
   WHERE r.job_id = p_job_id AND r.state = 'active' AND r.worker_id = p_worker_id
     AND r.fence_token = p_fence_token
   FOR UPDATE;
  IF NOT FOUND THEN RETURN 'stale'; END IF;
  IF v_runtime.cancel_requested_at IS NOT NULL THEN RETURN 'cancel_requested'; END IF;
  IF v_runtime.deadline_at IS NOT NULL AND v_runtime.deadline_at <= clock_timestamp() THEN
    RETURN workhorse.expire_owned_v1(p_job_id, p_worker_id, p_fence_token);
  END IF;
  IF v_runtime.attempt_timeout_at IS NOT NULL
     AND v_runtime.attempt_timeout_at <= clock_timestamp() THEN
    RETURN workhorse.expire_owned_v1(p_job_id, p_worker_id, p_fence_token);
  END IF;
  IF v_runtime.expires_at <= clock_timestamp() THEN RETURN 'stale'; END IF;
  UPDATE workhorse.job_runtime r
     SET heartbeat_at = clock_timestamp(),
         expires_at = clock_timestamp() + make_interval(secs => p_lease_ms::double precision / 1000.0),
         updated_at = clock_timestamp()
   WHERE r.job_id = p_job_id AND r.state = 'active' AND r.worker_id = p_worker_id
     AND r.fence_token = p_fence_token AND r.expires_at > clock_timestamp()
     AND (r.deadline_at IS NULL OR r.deadline_at > clock_timestamp())
     AND (r.attempt_timeout_at IS NULL OR r.attempt_timeout_at > clock_timestamp())
     AND r.cancel_requested_at IS NULL;
  IF NOT FOUND THEN RETURN 'stale'; END IF;
  RETURN 'accepted';
END;
$$;

CREATE OR REPLACE FUNCTION workhorse.cancel_v1(
  p_job_id uuid, p_requested_by text DEFAULT NULL, p_reason text DEFAULT NULL
) RETURNS TABLE (
  status text, state text, current_attempt integer, requested_at timestamptz,
  requested_by text, reason text, finished_at timestamptz
)
LANGUAGE plpgsql
AS $$
DECLARE
  v_runtime workhorse.job_runtime%ROWTYPE;
  v_outcome workhorse.job_outcome%ROWTYPE;
  v_now timestamptz := clock_timestamp();
  v_fence_token bigint := 0;
  v_worker_id text;
  v_claimed_at timestamptz;
  v_attempt integer;
  v_envelope jsonb;
BEGIN
  IF p_job_id IS NULL THEN RAISE EXCEPTION 'job_id is required'; END IF;
  IF p_requested_by IS NOT NULL
     AND (p_requested_by = '' OR char_length(p_requested_by) > 200) THEN
    RAISE EXCEPTION 'requested_by must contain between 1 and 200 characters';
  END IF;
  IF p_reason IS NOT NULL AND (p_reason = '' OR char_length(p_reason) > 2000) THEN
    RAISE EXCEPTION 'reason must contain between 1 and 2000 characters';
  END IF;

  SELECT * INTO v_runtime
    FROM workhorse.job_runtime runtime
   WHERE runtime.job_id = p_job_id
   FOR UPDATE;
  IF FOUND THEN
    IF v_runtime.state = 'active' THEN
      IF v_runtime.cancel_requested_at IS NULL THEN
        UPDATE workhorse.job_runtime runtime
           SET cancel_requested_at = v_now,
               cancel_requested_by = p_requested_by,
               cancel_reason = p_reason,
               updated_at = v_now
         WHERE runtime.job_id = p_job_id AND runtime.state = 'active'
           AND runtime.cancel_requested_at IS NULL
        RETURNING * INTO v_runtime;
        IF FOUND THEN
          INSERT INTO workhorse.job_event(job_id, attempt, event_type, details)
            VALUES (
              p_job_id,
              v_runtime.current_attempt,
              'cancel_requested',
              jsonb_build_object(
                'requested_at', v_now,
                'requested_by', p_requested_by,
                'reason', p_reason,
                'fence_token', v_runtime.fence_token::text
              )
            );
        END IF;
      END IF;
      RETURN QUERY VALUES (
        'cancel_requested'::text,
        'active'::text,
        v_runtime.current_attempt,
        v_runtime.cancel_requested_at,
        v_runtime.cancel_requested_by,
        v_runtime.cancel_reason,
        NULL::timestamptz
      );
      RETURN;
    END IF;

    -- A suspended logical attempt retains its original worker/fence attribution in its timer or
    -- signal boundary even though scheduled runtime ownership has been released.
    IF v_runtime.attempt_started_at IS NOT NULL THEN
      SELECT provenance.fence_token, provenance.worker_id, provenance.attempt,
             provenance.claimed_at
        INTO v_fence_token, v_worker_id, v_attempt, v_claimed_at
        FROM (
          SELECT wait_row.fence_token, wait_row.worker_id, wait_row.attempt,
                 wait_row.claimed_at, wait_row.created_at, wait_row.wait_name AS name
            FROM workhorse.job_wait wait_row
           WHERE wait_row.job_id = p_job_id AND wait_row.attempt = v_runtime.current_attempt
          UNION ALL
          SELECT signal.fence_token, signal.worker_id, signal.attempt,
                 signal.claimed_at, signal.created_at, signal.signal_name AS name
            FROM workhorse.job_signal_wait signal
           WHERE signal.job_id = p_job_id AND signal.attempt = v_runtime.current_attempt
        ) provenance
       ORDER BY provenance.created_at DESC, provenance.name DESC
       LIMIT 1;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'started job % has no retained suspension attribution', p_job_id;
      END IF;
    END IF;
    v_envelope := workhorse.cancellation_envelope_v1(v_now, p_requested_by, p_reason);
    DELETE FROM workhorse.job_runtime runtime WHERE runtime.job_id = p_job_id;
    INSERT INTO workhorse.job_outcome(
      job_id, state, current_attempt, fence_token, run_at, error, finished_at, updated_at
    ) VALUES (
      p_job_id, 'canceled', v_runtime.current_attempt, v_fence_token, v_runtime.run_at,
      v_envelope, v_now, v_now
    ) RETURNING * INTO v_outcome;
    IF v_runtime.attempt_started_at IS NOT NULL THEN
      INSERT INTO workhorse.attempt_history(
        job_id, attempt, fence_token, worker_id, outcome, started_at, claimed_at, error
      ) VALUES (
        p_job_id, v_attempt, v_fence_token, v_worker_id, 'canceled',
        v_runtime.attempt_started_at, v_claimed_at, v_envelope
      );
    END IF;
    INSERT INTO workhorse.job_event(job_id, attempt, event_type, details)
      VALUES (
        p_job_id,
        CASE WHEN v_runtime.attempt_started_at IS NULL THEN NULL ELSE v_attempt END,
        'canceled',
        jsonb_build_object(
          'requested_at', v_now,
          'requested_by', p_requested_by,
          'reason', p_reason,
          'fence_token', v_fence_token::text,
          'source', 'immediate'
        )
      );
    RETURN QUERY VALUES (
      'canceled'::text, 'canceled'::text, v_runtime.current_attempt,
      v_now, p_requested_by, p_reason, v_outcome.finished_at
    );
    RETURN;
  END IF;

  SELECT * INTO v_outcome FROM workhorse.job_outcome outcome WHERE outcome.job_id = p_job_id;
  IF FOUND THEN
    IF v_outcome.state = 'canceled' THEN
      RETURN QUERY VALUES (
        'canceled'::text,
        v_outcome.state,
        v_outcome.current_attempt,
        NULLIF(v_outcome.error->>'requested_at', '')::timestamptz,
        v_outcome.error->>'requested_by',
        v_outcome.error->>'reason',
        v_outcome.finished_at
      );
    ELSE
      RETURN QUERY VALUES (
        'already_terminal'::text, v_outcome.state, v_outcome.current_attempt,
        NULL::timestamptz, NULL::text, NULL::text, v_outcome.finished_at
      );
    END IF;
    RETURN;
  END IF;

  RETURN QUERY VALUES (
    'not_found'::text, NULL::text, NULL::integer, NULL::timestamptz,
    NULL::text, NULL::text, NULL::timestamptz
  );
END;
$$;

CREATE OR REPLACE FUNCTION workhorse.acknowledge_cancel_v1(
  p_job_id uuid, p_worker_id text, p_fence_token bigint
) RETURNS boolean
LANGUAGE plpgsql
AS $$
DECLARE
  v_runtime workhorse.job_runtime%ROWTYPE;
  v_envelope jsonb;
BEGIN
  SELECT * INTO v_runtime
    FROM workhorse.job_runtime runtime
   WHERE runtime.job_id = p_job_id AND runtime.state = 'active'
     AND runtime.worker_id = p_worker_id AND runtime.fence_token = p_fence_token
   FOR UPDATE;
  IF NOT FOUND OR v_runtime.expires_at <= clock_timestamp()
     OR v_runtime.cancel_requested_at IS NULL THEN
    RETURN false;
  END IF;
  v_envelope := workhorse.cancellation_envelope_v1(
    v_runtime.cancel_requested_at, v_runtime.cancel_requested_by, v_runtime.cancel_reason
  );
  DELETE FROM workhorse.job_runtime runtime
   WHERE runtime.job_id = p_job_id AND runtime.state = 'active'
     AND runtime.worker_id = p_worker_id AND runtime.fence_token = p_fence_token
     AND runtime.expires_at > clock_timestamp() AND runtime.cancel_requested_at IS NOT NULL;
  IF NOT FOUND THEN RETURN false; END IF;
  INSERT INTO workhorse.job_outcome(job_id, state, current_attempt, fence_token, run_at, error)
    VALUES (
      p_job_id, 'canceled', v_runtime.current_attempt, p_fence_token, v_runtime.run_at, v_envelope
    );
  INSERT INTO workhorse.attempt_history(
    job_id, attempt, fence_token, worker_id, outcome, started_at, claimed_at, error
  ) VALUES (
    p_job_id, v_runtime.current_attempt, p_fence_token, p_worker_id, 'canceled',
    v_runtime.attempt_started_at, v_runtime.acquired_at, v_envelope
  );
  INSERT INTO workhorse.job_event(job_id, attempt, event_type, details)
    VALUES (
      p_job_id,
      v_runtime.current_attempt,
      'canceled',
      jsonb_build_object(
        'requested_at', v_runtime.cancel_requested_at,
        'requested_by', v_runtime.cancel_requested_by,
        'reason', v_runtime.cancel_reason,
        'fence_token', p_fence_token::text,
        'source', 'acknowledged'
      )
    );
  RETURN true;
END;
$$;

-- Persist one immutable named checkpoint only while the caller owns the active, unexpired lease.
-- Locking the runtime row serializes this write with completion, failure, and expiry recovery.
CREATE OR REPLACE FUNCTION workhorse.save_checkpoint_v1(
  p_job_id uuid,
  p_worker_id text,
  p_fence_token bigint,
  p_checkpoint_name text,
  p_checkpoint_value jsonb
) RETURNS TABLE (
  status text,
  checkpoint_value jsonb,
  attempt integer,
  fence_token bigint,
  worker_id text,
  created_at timestamptz
)
LANGUAGE plpgsql
AS $$
DECLARE
  v_runtime workhorse.job_runtime%ROWTYPE;
  v_checkpoint workhorse.job_checkpoint%ROWTYPE;
BEGIN
  IF p_checkpoint_name IS NULL OR p_checkpoint_name = '' OR char_length(p_checkpoint_name) > 200 THEN
    RAISE EXCEPTION 'checkpoint_name must contain between 1 and 200 characters';
  END IF;
  IF p_checkpoint_value IS NULL THEN
    RAISE EXCEPTION 'checkpoint_value must be JSON, including JSON null when appropriate';
  END IF;
  IF octet_length(p_checkpoint_value::text) > 1048576 THEN
    RAISE EXCEPTION 'checkpoint_value must be at most 1048576 bytes';
  END IF;

  SELECT * INTO v_runtime
    FROM workhorse.job_runtime runtime
   WHERE runtime.job_id = p_job_id
     AND runtime.state = 'active'
     AND runtime.worker_id = p_worker_id
     AND runtime.fence_token = p_fence_token
   FOR UPDATE;
  -- Recheck expiry after acquiring the row lock. A pre-lock predicate can become stale while this
  -- transaction waits behind another lifecycle operation that does not modify the runtime row.
  IF NOT FOUND OR v_runtime.expires_at <= clock_timestamp()
     OR (v_runtime.deadline_at IS NOT NULL AND v_runtime.deadline_at <= clock_timestamp())
     OR (v_runtime.attempt_timeout_at IS NOT NULL
       AND v_runtime.attempt_timeout_at <= clock_timestamp())
     OR v_runtime.cancel_requested_at IS NOT NULL THEN
    RETURN QUERY VALUES (
      'stale'::text, NULL::jsonb, NULL::integer, NULL::bigint, NULL::text, NULL::timestamptz
    );
    RETURN;
  END IF;

  SELECT * INTO v_checkpoint
    FROM workhorse.job_checkpoint checkpoint
   WHERE checkpoint.job_id = p_job_id AND checkpoint.checkpoint_name = p_checkpoint_name;
  IF FOUND THEN
    RETURN QUERY VALUES (
      CASE
        WHEN v_checkpoint.checkpoint_value IS NOT DISTINCT FROM p_checkpoint_value
          THEN 'existing'::text
        ELSE 'conflict'::text
      END,
      v_checkpoint.checkpoint_value,
      v_checkpoint.attempt,
      v_checkpoint.fence_token,
      v_checkpoint.worker_id,
      v_checkpoint.created_at
    );
    RETURN;
  END IF;

  INSERT INTO workhorse.job_checkpoint(
    job_id, checkpoint_name, checkpoint_value, attempt, fence_token, worker_id
  ) VALUES (
    p_job_id, p_checkpoint_name, p_checkpoint_value, v_runtime.current_attempt,
    p_fence_token, p_worker_id
  )
  RETURNING * INTO v_checkpoint;
  INSERT INTO workhorse.job_event(job_id, attempt, event_type, details)
    VALUES (
      p_job_id,
      v_runtime.current_attempt,
      'checkpoint_saved',
      jsonb_build_object('name', p_checkpoint_name, 'fence_token', p_fence_token::text)
    );

  RETURN QUERY VALUES (
    'saved'::text,
    v_checkpoint.checkpoint_value,
    v_checkpoint.attempt,
    v_checkpoint.fence_token,
    v_checkpoint.worker_id,
    v_checkpoint.created_at
  );
END;
$$;

-- Replace the latest progress only while the caller owns the exact active, unexpired generation.
-- Changed writes from one generation are limited to ten per second. Identical writes are no-ops.
CREATE OR REPLACE FUNCTION workhorse.update_progress_v1(
  p_job_id uuid,
  p_worker_id text,
  p_fence_token bigint,
  p_progress_value jsonb
) RETURNS TABLE (
  status text,
  progress_value jsonb,
  revision bigint,
  attempt integer,
  fence_token bigint,
  worker_id text,
  created_at timestamptz,
  updated_at timestamptz,
  retry_after_ms bigint
)
LANGUAGE plpgsql
AS $$
DECLARE
  v_runtime workhorse.job_runtime%ROWTYPE;
  v_progress workhorse.job_progress%ROWTYPE;
  v_now timestamptz;
  v_elapsed_ms numeric;
BEGIN
  IF p_progress_value IS NULL THEN
    RAISE EXCEPTION 'progress_value must be JSON, including JSON null when appropriate';
  END IF;
  IF octet_length(p_progress_value::text) > 65536 THEN
    RAISE EXCEPTION 'progress_value must be at most 65536 bytes';
  END IF;

  SELECT * INTO v_runtime
    FROM workhorse.job_runtime runtime
   WHERE runtime.job_id = p_job_id
     AND runtime.state = 'active'
     AND runtime.worker_id = p_worker_id
     AND runtime.fence_token = p_fence_token
   FOR UPDATE;
  -- Sample time only after ownership serialization. A timestamp captured before a blocked lock wait
  -- could accept an expired lease or calculate an invalid update interval.
  v_now := clock_timestamp();
  IF NOT FOUND OR v_runtime.expires_at <= v_now
     OR (v_runtime.deadline_at IS NOT NULL AND v_runtime.deadline_at <= v_now)
     OR (v_runtime.attempt_timeout_at IS NOT NULL AND v_runtime.attempt_timeout_at <= v_now)
     OR v_runtime.cancel_requested_at IS NOT NULL THEN
    RETURN QUERY VALUES (
      'stale'::text, NULL::jsonb, NULL::bigint, NULL::integer, NULL::bigint,
      NULL::text, NULL::timestamptz, NULL::timestamptz, NULL::bigint
    );
    RETURN;
  END IF;
  SELECT * INTO v_progress
    FROM workhorse.job_progress progress
   WHERE progress.job_id = p_job_id
   FOR UPDATE;
  -- A non-protocol writer could hold the progress row while this transaction owns runtime. Resample
  -- before any mutation so a lease, deadline, or execution timeout cannot expire during that wait.
  v_now := clock_timestamp();
  IF v_runtime.expires_at <= v_now
     OR (v_runtime.deadline_at IS NOT NULL AND v_runtime.deadline_at <= v_now)
     OR (v_runtime.attempt_timeout_at IS NOT NULL AND v_runtime.attempt_timeout_at <= v_now) THEN
    RETURN QUERY VALUES (
      'stale'::text, NULL::jsonb, NULL::bigint, NULL::integer, NULL::bigint,
      NULL::text, NULL::timestamptz, NULL::timestamptz, NULL::bigint
    );
    RETURN;
  END IF;
  IF FOUND AND v_progress.progress_value IS NOT DISTINCT FROM p_progress_value THEN
    RETURN QUERY VALUES (
      'unchanged'::text, v_progress.progress_value, v_progress.revision, v_progress.attempt,
      v_progress.fence_token, v_progress.worker_id, v_progress.created_at,
      v_progress.updated_at, NULL::bigint
    );
    RETURN;
  END IF;

  IF FOUND AND v_progress.fence_token = p_fence_token THEN
    v_elapsed_ms := extract(epoch FROM (v_now - v_progress.updated_at)) * 1000;
    IF v_elapsed_ms < 100 THEN
      RETURN QUERY VALUES (
        'rate_limited'::text, v_progress.progress_value, v_progress.revision,
        v_progress.attempt, v_progress.fence_token, v_progress.worker_id,
        v_progress.created_at, v_progress.updated_at, ceil(100 - v_elapsed_ms)::bigint
      );
      RETURN;
    END IF;
  END IF;

  INSERT INTO workhorse.job_progress(
    job_id, progress_value, revision, attempt, fence_token, worker_id, created_at, updated_at
  ) VALUES (
    p_job_id, p_progress_value, 1, v_runtime.current_attempt, p_fence_token, p_worker_id,
    v_now, v_now
  )
  ON CONFLICT (job_id) DO UPDATE SET
    progress_value = EXCLUDED.progress_value,
    revision = workhorse.job_progress.revision + 1,
    attempt = EXCLUDED.attempt,
    fence_token = EXCLUDED.fence_token,
    worker_id = EXCLUDED.worker_id,
    updated_at = EXCLUDED.updated_at
  RETURNING * INTO v_progress;

  INSERT INTO workhorse.job_event(job_id, attempt, event_type, details)
    VALUES (
      p_job_id,
      v_runtime.current_attempt,
      'progress_updated',
      jsonb_build_object(
        'revision', v_progress.revision::text,
        'bytes', octet_length(v_progress.progress_value::text),
        'fence_token', p_fence_token::text
      )
    );

  RETURN QUERY VALUES (
    'updated'::text, v_progress.progress_value, v_progress.revision, v_progress.attempt,
    v_progress.fence_token, v_progress.worker_id, v_progress.created_at,
    v_progress.updated_at, NULL::bigint
  );
END;
$$;

-- Atomically record or replay one named durable timer boundary while the caller owns the exact
-- active, unexpired runtime generation. Wait rows are immutable after their first committed write.
CREATE OR REPLACE FUNCTION workhorse.schedule_wait_v1(
  p_job_id uuid,
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
  v_runtime workhorse.job_runtime%ROWTYPE;
  v_wait workhorse.job_wait%ROWTYPE;
  v_mode text;
  v_now timestamptz;
  v_requested_target timestamptz;
BEGIN
  IF p_wait_name IS NULL OR p_wait_name = '' OR char_length(p_wait_name) > 200 THEN
    RAISE EXCEPTION 'wait_name must contain between 1 and 200 characters';
  END IF;
  IF (p_duration_ms IS NULL) = (p_wake_at IS NULL) THEN
    RAISE EXCEPTION 'exactly one of duration_ms or wake_at is required';
  END IF;
  IF p_duration_ms IS NOT NULL AND p_duration_ms NOT BETWEEN 1 AND 31536000000 THEN
    RAISE EXCEPTION 'duration_ms must be between 1 and 31536000000';
  END IF;
  IF p_wake_at IS NOT NULL AND NOT isfinite(p_wake_at) THEN
    RAISE EXCEPTION 'wake_at must be finite';
  END IF;
  v_mode := CASE WHEN p_duration_ms IS NOT NULL THEN 'relative' ELSE 'absolute' END;

  SELECT * INTO v_runtime
    FROM workhorse.job_runtime runtime
   WHERE runtime.job_id = p_job_id
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
      'stale'::text, NULL::text, NULL::text, NULL::bigint, NULL::timestamptz,
      NULL::timestamptz, NULL::integer, NULL::bigint, NULL::text, NULL::timestamptz
    );
    RETURN;
  END IF;

  v_requested_target := CASE
    WHEN p_duration_ms IS NOT NULL
      THEN v_now + make_interval(secs => p_duration_ms::double precision / 1000.0)
    ELSE p_wake_at
  END;

  SELECT * INTO v_wait
    FROM workhorse.job_wait stored
   WHERE stored.job_id = p_job_id AND stored.wait_name = p_wait_name;
  IF FOUND THEN
    IF v_wait.mode <> v_mode
       OR (v_mode = 'absolute' AND v_wait.requested_wake_at IS DISTINCT FROM p_wake_at) THEN
      RETURN QUERY VALUES (
        'conflict'::text, v_wait.wait_name, v_wait.mode, v_wait.duration_ms,
        v_wait.requested_wake_at, v_wait.wake_at, v_wait.attempt, v_wait.fence_token,
        v_wait.worker_id, v_wait.created_at
      );
      RETURN;
    END IF;

    INSERT INTO workhorse.job_event(job_id, attempt, event_type, details)
      VALUES (
        p_job_id,
        v_runtime.current_attempt,
        'wait_replayed',
        jsonb_build_object(
          'name', p_wait_name,
          'mode', v_mode,
          'requested_duration_ms', p_duration_ms,
          'stored_duration_ms', v_wait.duration_ms,
          'requested_wake_at', v_requested_target,
          'stored_wake_at', v_wait.wake_at,
          'fence_token', p_fence_token::text
        )
      );
    RETURN QUERY VALUES (
      'elapsed'::text, v_wait.wait_name, v_wait.mode, v_wait.duration_ms,
      v_wait.requested_wake_at, v_wait.wake_at, v_wait.attempt, v_wait.fence_token,
      v_wait.worker_id, v_wait.created_at
    );
    RETURN;
  END IF;

  IF p_wake_at IS NOT NULL AND p_wake_at > v_now + interval '365 days' THEN
    RAISE EXCEPTION 'wake_at must be no more than 365 days in the future';
  END IF;
  IF (SELECT count(*) FROM workhorse.job_wait stored WHERE stored.job_id = p_job_id) >= 1000 THEN
    RETURN QUERY VALUES (
      'limit_exceeded'::text, NULL::text, NULL::text, NULL::bigint, NULL::timestamptz,
      NULL::timestamptz, NULL::integer, NULL::bigint, NULL::text, NULL::timestamptz
    );
    RETURN;
  END IF;

  INSERT INTO workhorse.job_wait(
    job_id, wait_name, mode, duration_ms, requested_wake_at, wake_at,
    attempt, fence_token, worker_id, claimed_at
  ) VALUES (
    p_job_id, p_wait_name, v_mode, p_duration_ms, p_wake_at, v_requested_target,
    v_runtime.current_attempt, p_fence_token, p_worker_id, v_runtime.acquired_at
  )
  RETURNING * INTO v_wait;

  IF v_wait.wake_at <= v_now THEN
    INSERT INTO workhorse.job_event(job_id, attempt, event_type, details)
      VALUES (
        p_job_id,
        v_runtime.current_attempt,
        'wait_elapsed',
        jsonb_build_object(
          'name', p_wait_name,
          'mode', v_mode,
          'wake_at', v_wait.wake_at,
          'reason', 'due',
          'immediate', true,
          'fence_token', p_fence_token::text
        )
      );
    RETURN QUERY VALUES (
      'elapsed'::text, v_wait.wait_name, v_wait.mode, v_wait.duration_ms,
      v_wait.requested_wake_at, v_wait.wake_at, v_wait.attempt, v_wait.fence_token,
      v_wait.worker_id, v_wait.created_at
    );
    RETURN;
  END IF;

  UPDATE workhorse.job_runtime runtime
     SET state = 'scheduled', run_at = v_wait.wake_at, fence_token = 0,
         ready_at = NULL, sequence = NULL, worker_id = NULL, acquired_at = NULL,
         heartbeat_at = NULL, expires_at = NULL, wait_name = p_wait_name,
         execution_used_ms = LEAST(
           31536000000,
           runtime.execution_used_ms + GREATEST(
             0, floor(extract(epoch FROM v_now - runtime.acquired_at) * 1000)::bigint
           )
         ),
         attempt_timeout_at = NULL,
         error = NULL, updated_at = clock_timestamp()
   WHERE runtime.job_id = p_job_id
     AND runtime.state = 'active'
     AND runtime.worker_id = p_worker_id
     AND runtime.fence_token = p_fence_token
     AND runtime.expires_at > clock_timestamp()
     AND (runtime.deadline_at IS NULL OR runtime.deadline_at > clock_timestamp())
     AND (runtime.attempt_timeout_at IS NULL OR runtime.attempt_timeout_at > clock_timestamp());
  IF NOT FOUND THEN
    -- The lease can cross its deadline after the post-lock validation above while the immutable
    -- row is being inserted. Remove that transaction-local row and preserve the public stale
    -- result instead of leaking an implementation exception to the client.
    DELETE FROM workhorse.job_wait stored
     WHERE stored.job_id = p_job_id AND stored.wait_name = p_wait_name;
    RETURN QUERY VALUES (
      'stale'::text, NULL::text, NULL::text, NULL::bigint, NULL::timestamptz,
      NULL::timestamptz, NULL::integer, NULL::bigint, NULL::text, NULL::timestamptz
    );
    RETURN;
  END IF;

  INSERT INTO workhorse.job_event(job_id, attempt, event_type, details)
    VALUES (
      p_job_id,
      v_runtime.current_attempt,
      'wait_scheduled',
      jsonb_build_object(
        'name', p_wait_name,
        'mode', v_mode,
        'duration_ms', p_duration_ms,
        'requested_wake_at', p_wake_at,
        'wake_at', v_wait.wake_at,
        'fence_token', p_fence_token::text
      )
    );
  RETURN QUERY VALUES (
    'scheduled'::text, v_wait.wait_name, v_wait.mode, v_wait.duration_ms,
    v_wait.requested_wake_at, v_wait.wake_at, v_wait.attempt, v_wait.fence_token,
    v_wait.worker_id, v_wait.created_at
  );
END;
$$;

-- Declare or replay one named signal wait while the caller owns the exact active generation.
-- A first declaration releases the lease and preserves the logical attempt for handler replay.
CREATE OR REPLACE FUNCTION workhorse.wait_for_signal_v1(
  p_job_id uuid,
  p_worker_id text,
  p_fence_token bigint,
  p_signal_name text
) RETURNS TABLE (status text, payload jsonb)
LANGUAGE plpgsql
AS $$
DECLARE
  v_runtime workhorse.job_runtime%ROWTYPE;
  v_wait workhorse.job_signal_wait%ROWTYPE;
  v_now timestamptz;
  v_timeout_at timestamptz;
BEGIN
  IF p_signal_name IS NULL OR p_signal_name = '' OR char_length(p_signal_name) > 200 THEN
    RAISE EXCEPTION 'signal_name must contain between 1 and 200 characters';
  END IF;
  IF p_worker_id IS NULL OR p_worker_id = '' THEN
    RAISE EXCEPTION 'worker_id must not be empty';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(
    'workhorse:signal:' || p_job_id::text || ':' || p_signal_name, 0
  ));
  SELECT * INTO v_runtime
    FROM workhorse.job_runtime runtime
   WHERE runtime.job_id = p_job_id
     AND runtime.state = 'active'
     AND runtime.worker_id = p_worker_id
     AND runtime.fence_token = p_fence_token
   FOR UPDATE;
  v_now := clock_timestamp();
  IF NOT FOUND OR v_runtime.expires_at <= v_now
     OR (v_runtime.deadline_at IS NOT NULL AND v_runtime.deadline_at <= v_now)
     OR (v_runtime.attempt_timeout_at IS NOT NULL AND v_runtime.attempt_timeout_at <= v_now)
     OR v_runtime.cancel_requested_at IS NOT NULL THEN
    RETURN QUERY VALUES ('stale'::text, NULL::jsonb);
    RETURN;
  END IF;
  v_timeout_at := LEAST(
    COALESCE(v_runtime.deadline_at, 'infinity'::timestamptz),
    v_now + interval '7 days'
  );

  SELECT * INTO v_wait
    FROM workhorse.job_signal_wait stored
   WHERE stored.job_id = p_job_id AND stored.signal_name = p_signal_name;
  IF FOUND THEN
    IF v_wait.delivered_at IS NULL THEN
      RETURN QUERY VALUES ('stale'::text, NULL::jsonb);
      RETURN;
    END IF;
    INSERT INTO workhorse.job_event(job_id, attempt, event_type, details)
      VALUES (
        p_job_id, v_runtime.current_attempt, 'signal_replayed',
        jsonb_build_object('name', p_signal_name, 'delivered_at', v_wait.delivered_at)
      );
    RETURN QUERY VALUES ('delivered'::text, v_wait.payload);
    RETURN;
  END IF;

  IF (SELECT count(*) FROM workhorse.job_signal_wait stored WHERE stored.job_id = p_job_id) >= 1000 THEN
    RETURN QUERY VALUES ('limit_exceeded'::text, NULL::jsonb);
    RETURN;
  END IF;

  INSERT INTO workhorse.job_signal_wait(
    job_id, signal_name, attempt, fence_token, worker_id, claimed_at, timeout_at
  ) VALUES (
    p_job_id, p_signal_name, v_runtime.current_attempt, p_fence_token,
    p_worker_id, v_runtime.acquired_at, v_timeout_at
  );

  UPDATE workhorse.job_runtime runtime
     SET state = 'scheduled', run_at = '9999-12-31 00:00:00+00'::timestamptz,
         fence_token = 0, ready_at = NULL, sequence = NULL, worker_id = NULL,
         acquired_at = NULL, heartbeat_at = NULL, expires_at = NULL,
         wait_name = p_signal_name,
         execution_used_ms = LEAST(
           31536000000,
           runtime.execution_used_ms + GREATEST(
             0, floor(extract(epoch FROM v_now - runtime.acquired_at) * 1000)::bigint
           )
         ),
         attempt_timeout_at = NULL, deadline_at = v_timeout_at,
         error = NULL, updated_at = clock_timestamp()
   WHERE runtime.job_id = p_job_id
     AND runtime.state = 'active'
     AND runtime.worker_id = p_worker_id
     AND runtime.fence_token = p_fence_token
     AND runtime.expires_at > clock_timestamp()
     AND (runtime.deadline_at IS NULL OR runtime.deadline_at > clock_timestamp())
     AND (runtime.attempt_timeout_at IS NULL OR runtime.attempt_timeout_at > clock_timestamp());
  IF NOT FOUND THEN
    DELETE FROM workhorse.job_signal_wait stored
     WHERE stored.job_id = p_job_id AND stored.signal_name = p_signal_name;
    RETURN QUERY VALUES ('stale'::text, NULL::jsonb);
    RETURN;
  END IF;

  INSERT INTO workhorse.job_event(job_id, attempt, event_type, details)
    VALUES (
      p_job_id, v_runtime.current_attempt, 'signal_waiting',
      jsonb_build_object('name', p_signal_name, 'fence_token', p_fence_token::text)
    );
  RETURN QUERY VALUES ('waiting'::text, NULL::jsonb);
END;
$$;

-- Deliver one bounded signal at the waiting-to-ready transition. The retained key hash and request
-- fingerprint make same-key retries return the accepted result without repeating the transition.
CREATE OR REPLACE FUNCTION workhorse.send_signal_v1(
  p_job_id uuid,
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
  v_wait workhorse.job_signal_wait%ROWTYPE;
  v_runtime workhorse.job_runtime%ROWTYPE;
  v_key_hash bytea;
  v_key_digest text;
  v_fingerprint jsonb;
  v_now timestamptz;
  v_reason text;
BEGIN
  IF p_signal_name IS NULL OR p_signal_name = '' OR char_length(p_signal_name) > 200 THEN
    RAISE EXCEPTION 'signal_name must contain between 1 and 200 characters';
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
    'signal:' || p_job_id::text || ':' || p_signal_name, p_idempotency_key
  );
  v_key_digest := left(encode(v_key_hash, 'hex'), 12);
  v_fingerprint := jsonb_build_object('payload', p_payload, 'requestedBy', p_requested_by);
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'workhorse:signal:' || p_job_id::text || ':' || p_signal_name, 0
  ));

  IF NOT EXISTS (SELECT 1 FROM workhorse.job WHERE id = p_job_id) THEN
    RETURN QUERY VALUES ('not_found'::text, NULL::jsonb, NULL::timestamptz, NULL::text);
    RETURN;
  END IF;
  SELECT * INTO v_wait
    FROM workhorse.job_signal_wait stored
   WHERE stored.job_id = p_job_id AND stored.signal_name = p_signal_name
   FOR UPDATE;
  IF NOT FOUND THEN
    INSERT INTO workhorse.job_event(job_id, event_type, details)
      VALUES (
        p_job_id, 'signal_rejected',
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
    INSERT INTO workhorse.job_event(job_id, attempt, event_type, details)
      VALUES (
        p_job_id, v_wait.attempt, 'signal_rejected',
        jsonb_build_object(
          'name', p_signal_name, 'reason', v_reason, 'requested_by', p_requested_by,
          'idempotency_key_digest', v_key_digest
        )
      );
    RETURN QUERY VALUES (status, v_wait.payload, v_wait.delivered_at, v_wait.delivered_by);
    RETURN;
  END IF;

  SELECT * INTO v_runtime
    FROM workhorse.job_runtime runtime
   WHERE runtime.job_id = p_job_id
     AND runtime.state = 'scheduled'
     AND runtime.wait_name = p_signal_name
     AND runtime.current_attempt = v_wait.attempt
   FOR UPDATE;
  v_now := clock_timestamp();
  IF NOT FOUND OR (v_runtime.deadline_at IS NOT NULL AND v_runtime.deadline_at <= v_now) THEN
    INSERT INTO workhorse.job_event(job_id, attempt, event_type, details)
      VALUES (
        p_job_id, v_wait.attempt, 'signal_rejected',
        jsonb_build_object(
          'name', p_signal_name, 'reason', 'stale', 'requested_by', p_requested_by,
          'idempotency_key_digest', v_key_digest
        )
      );
    RETURN QUERY VALUES ('stale'::text, NULL::jsonb, NULL::timestamptz, NULL::text);
    RETURN;
  END IF;

  UPDATE workhorse.job_signal_wait stored
     SET payload = p_payload, idempotency_key_hash = v_key_hash,
         request_fingerprint = v_fingerprint, delivered_by = p_requested_by, delivered_at = v_now
   WHERE stored.job_id = p_job_id AND stored.signal_name = p_signal_name
   RETURNING * INTO v_wait;
  UPDATE workhorse.job_runtime runtime
     SET state = 'ready', run_at = v_now, ready_at = v_now,
         sequence = nextval('workhorse.ready_sequence_seq'), wait_name = NULL,
         deadline_at = (SELECT job.deadline_at FROM workhorse.job job WHERE job.id = p_job_id),
         updated_at = v_now
   WHERE runtime.job_id = p_job_id;
  INSERT INTO workhorse.job_event(job_id, attempt, event_type, details)
    VALUES (
      p_job_id, v_wait.attempt, 'signal_received',
      jsonb_build_object(
        'name', p_signal_name, 'requested_by', p_requested_by,
        'idempotency_key_digest', v_key_digest, 'payload_bytes', octet_length(p_payload::text)
      )
    );
  PERFORM pg_notify('workhorse_jobs', v_runtime.queue_name);
  RETURN QUERY VALUES ('delivered'::text, v_wait.payload, v_wait.delivered_at, v_wait.delivered_by);
END;
$$;

-- Create one child and suspend its exact active parent generation in the same transaction. A
-- replay after the child succeeds returns its retained result and marks the join exactly once.
CREATE OR REPLACE FUNCTION workhorse.create_child_v1(
  p_parent_job_id uuid,
  p_worker_id text,
  p_fence_token bigint,
  p_child_name text,
  p_request jsonb
) RETURNS TABLE (
  status text,
  child_job_id uuid,
  child_type text,
  created_at timestamptz,
  joined_at timestamptz,
  result jsonb
)
LANGUAGE plpgsql
AS $$
DECLARE
  v_runtime workhorse.job_runtime%ROWTYPE;
  v_edge workhorse.job_child%ROWTYPE;
  v_enqueue record;
  v_outcome workhorse.job_outcome%ROWTYPE;
  v_now timestamptz;
BEGIN
  IF p_child_name IS NULL OR p_child_name = '' OR char_length(p_child_name) > 200 THEN
    RAISE EXCEPTION 'child_name must contain between 1 and 200 characters';
  END IF;
  IF p_request IS NULL OR jsonb_typeof(p_request) <> 'object' THEN
    RAISE EXCEPTION 'child request must be a JSON object';
  END IF;
  IF p_request ?| ARRAY['idempotency', 'debounce', 'throttle']
     OR COALESCE(p_request->'prerequisiteJobId', 'null'::jsonb) <> 'null'::jsonb
     OR COALESCE(p_request->'dependencies', 'null'::jsonb) <> 'null'::jsonb THEN
    RAISE EXCEPTION 'child jobs cannot use coalescing or dependency enqueue options';
  END IF;

  SELECT * INTO v_runtime
    FROM workhorse.job_runtime runtime
   WHERE runtime.job_id = p_parent_job_id
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
    FROM workhorse.job_child edge
   WHERE edge.parent_job_id = p_parent_job_id
   FOR UPDATE;
  IF FOUND THEN
    IF v_edge.child_name <> p_child_name THEN
      RETURN QUERY VALUES (
        'limit_exceeded'::text, v_edge.child_job_id,
        (SELECT job_type FROM workhorse.job WHERE id = v_edge.child_job_id),
        v_edge.created_at, v_edge.joined_at, NULL::jsonb
      );
      RETURN;
    END IF;
    IF v_edge.request_fingerprint <> p_request THEN
      RETURN QUERY VALUES (
        'conflict'::text, v_edge.child_job_id,
        (SELECT job_type FROM workhorse.job WHERE id = v_edge.child_job_id),
        v_edge.created_at, v_edge.joined_at, NULL::jsonb
      );
      RETURN;
    END IF;
    SELECT * INTO v_outcome FROM workhorse.job_outcome outcome
     WHERE outcome.job_id = v_edge.child_job_id;
    IF NOT FOUND OR v_outcome.state <> 'succeeded' THEN
      RETURN QUERY VALUES (
        'stale'::text, v_edge.child_job_id,
        (SELECT job_type FROM workhorse.job WHERE id = v_edge.child_job_id),
        v_edge.created_at, v_edge.joined_at, NULL::jsonb
      );
      RETURN;
    END IF;
    IF v_edge.joined_at IS NULL THEN
      UPDATE workhorse.job_child edge SET joined_at = v_now
       WHERE edge.parent_job_id = p_parent_job_id
       RETURNING * INTO v_edge;
      INSERT INTO workhorse.job_event(job_id, attempt, event_type, details)
        VALUES (
          p_parent_job_id, v_runtime.current_attempt, 'child_joined',
          jsonb_build_object(
            'name', p_child_name,
            'child_job_id', v_edge.child_job_id,
            'fence_token', p_fence_token::text
          )
        );
    END IF;
    RETURN QUERY VALUES (
      'completed'::text, v_edge.child_job_id,
      (SELECT job_type FROM workhorse.job WHERE id = v_edge.child_job_id),
      v_edge.created_at, v_edge.joined_at, v_outcome.result
    );
    RETURN;
  END IF;

  IF EXISTS (SELECT 1 FROM workhorse.job_child edge WHERE edge.parent_job_id = p_parent_job_id) THEN
    RETURN QUERY VALUES (
      'limit_exceeded'::text, NULL::uuid, NULL::text, NULL::timestamptz,
      NULL::timestamptz, NULL::jsonb
    );
    RETURN;
  END IF;

  BEGIN
    SELECT * INTO v_enqueue FROM workhorse.enqueue_many_v2(jsonb_build_array(p_request));
    IF v_enqueue.outcome <> 'accepted' THEN
      RAISE EXCEPTION 'child enqueue must create one new job';
    END IF;
    INSERT INTO workhorse.job_child(
      parent_job_id, child_job_id, child_name, request_fingerprint, created_at
    ) VALUES (
      p_parent_job_id, v_enqueue.job_id, p_child_name, p_request, v_now
    ) RETURNING * INTO v_edge;
    INSERT INTO workhorse.job_dependency(
      dependent_job_id, prerequisite_job_id, on_success, on_failure, on_cancellation, created_at
    ) VALUES (
      p_parent_job_id, v_enqueue.job_id, 'release', 'fail', 'cancel', v_now
    );

    UPDATE workhorse.job_runtime runtime
       SET state = 'blocked', fence_token = 0, ready_at = NULL, sequence = NULL,
           worker_id = NULL, acquired_at = NULL, heartbeat_at = NULL, expires_at = NULL,
           wait_name = NULL, attempt_started_at = NULL,
           execution_used_ms = LEAST(
             31536000000,
             runtime.execution_used_ms + GREATEST(
               0, floor(extract(epoch FROM v_now - runtime.acquired_at) * 1000)::bigint
             )
           ),
           attempt_timeout_at = NULL, error = NULL, updated_at = v_now
     WHERE runtime.job_id = p_parent_job_id
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

    INSERT INTO workhorse.job_event(job_id, attempt, event_type, details)
      VALUES (
        p_parent_job_id, v_runtime.current_attempt, 'child_created',
        jsonb_build_object(
          'name', p_child_name,
          'child_job_id', v_edge.child_job_id,
          'fence_token', p_fence_token::text
        )
      );
    INSERT INTO workhorse.job_event(job_id, event_type, details)
      VALUES (
        v_edge.child_job_id, 'parent_linked',
        jsonb_build_object('parent_job_id', p_parent_job_id, 'name', p_child_name)
      );
    RETURN QUERY VALUES (
      'created'::text, v_edge.child_job_id, p_request->>'type', v_edge.created_at,
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

DO $migration$
BEGIN
  IF to_regprocedure('workhorse.create_single_child_v1(uuid,text,bigint,text,jsonb)') IS NULL THEN
    ALTER FUNCTION workhorse.create_child_v1(uuid, text, bigint, text, jsonb)
      RENAME TO create_single_child_v1;
  END IF;
END;
$migration$;

CREATE OR REPLACE FUNCTION workhorse.create_child_v1(
  p_parent_job_id uuid,
  p_worker_id text,
  p_fence_token bigint,
  p_child_name text,
  p_request jsonb
) RETURNS TABLE (
  status text,
  child_job_id uuid,
  child_type text,
  created_at timestamptz,
  joined_at timestamptz,
  result jsonb
)
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM workhorse.job_child edge
     WHERE edge.parent_job_id = p_parent_job_id AND edge.created_as_set
  ) THEN
    RETURN QUERY VALUES (
      'limit_exceeded'::text, NULL::uuid, NULL::text, NULL::timestamptz,
      NULL::timestamptz, NULL::jsonb
    );
    RETURN;
  END IF;
  RETURN QUERY
    SELECT single.status, single.child_job_id, single.child_type, single.created_at,
           single.joined_at, single.result
      FROM workhorse.create_single_child_v1(
        p_parent_job_id, p_worker_id, p_fence_token, p_child_name, p_request
      ) single;
END;
$$;

CREATE OR REPLACE FUNCTION workhorse.create_children_v1(
  p_parent_job_id uuid,
  p_worker_id text,
  p_fence_token bigint,
  p_children jsonb
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
  v_runtime workhorse.job_runtime%ROWTYPE;
  v_item record;
  v_enqueue record;
  v_existing_count integer;
  v_result_limit integer;
  v_children jsonb := '[]'::jsonb;
  v_results jsonb := '{}'::jsonb;
  v_result_bytes integer := 2;
  v_now timestamptz;
  v_had_unjoined boolean;
BEGIN
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
    FROM workhorse.job_runtime runtime
    JOIN workhorse.job job ON job.id = runtime.job_id
   WHERE runtime.job_id = p_parent_job_id
     AND runtime.state = 'active'
     AND runtime.worker_id = p_worker_id
     AND runtime.fence_token = p_fence_token
   FOR UPDATE OF runtime;
  IF FOUND THEN
    SELECT job.result_max_bytes INTO STRICT v_result_limit
      FROM workhorse.job job WHERE job.id = p_parent_job_id;
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

  PERFORM 1 FROM workhorse.job_child edge
   WHERE edge.parent_job_id = p_parent_job_id
   ORDER BY edge.child_name FOR UPDATE;
  SELECT count(*)::integer INTO v_existing_count FROM workhorse.job_child edge
   WHERE edge.parent_job_id = p_parent_job_id;

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
      LEFT JOIN workhorse.job_child edge
        ON edge.parent_job_id = p_parent_job_id AND edge.child_name = item->>'name'
      WHERE edge.child_job_id IS NULL OR edge.request_fingerprint <> item->'request'
    ) OR EXISTS (
      SELECT 1 FROM workhorse.job_child edge
       WHERE edge.parent_job_id = p_parent_job_id AND NOT edge.created_as_set
    ) THEN
      RETURN QUERY VALUES (
        'conflict'::text, NULL::jsonb, NULL::jsonb, NULL::integer, v_result_limit
      );
      RETURN;
    END IF;
    IF EXISTS (
      SELECT 1 FROM workhorse.job_child edge
      LEFT JOIN workhorse.job_outcome outcome ON outcome.job_id = edge.child_job_id
       WHERE edge.parent_job_id = p_parent_job_id
         AND (outcome.job_id IS NULL OR outcome.state <> 'succeeded')
    ) THEN
      RETURN QUERY VALUES (
        'stale'::text, NULL::jsonb, NULL::jsonb, NULL::integer, v_result_limit
      );
      RETURN;
    END IF;

    SELECT jsonb_object_agg(edge.child_name, outcome.result),
           jsonb_agg(jsonb_build_object(
             'childJobId', edge.child_job_id,
             'name', edge.child_name,
             'type', job.job_type,
             'createdAt', edge.created_at,
             'joinedAt', COALESCE(edge.joined_at, v_now),
             'result', outcome.result
           ) ORDER BY input.ordinality),
           bool_or(edge.joined_at IS NULL)
      INTO v_results, v_children, v_had_unjoined
      FROM jsonb_array_elements(p_children) WITH ORDINALITY input(item, ordinality)
      JOIN workhorse.job_child edge
        ON edge.parent_job_id = p_parent_job_id AND edge.child_name = input.item->>'name'
      JOIN workhorse.job job ON job.id = edge.child_job_id
      JOIN workhorse.job_outcome outcome ON outcome.job_id = edge.child_job_id;
    v_result_bytes := octet_length(v_results::text);
    IF v_result_bytes > v_result_limit THEN
      RETURN QUERY VALUES (
        'result_too_large'::text, NULL::jsonb, NULL::jsonb, v_result_bytes, v_result_limit
      );
      RETURN;
    END IF;
    IF v_had_unjoined THEN
      UPDATE workhorse.job_child edge SET joined_at = v_now
       WHERE edge.parent_job_id = p_parent_job_id AND edge.joined_at IS NULL;
      INSERT INTO workhorse.job_event(job_id, attempt, event_type, details)
        VALUES (
          p_parent_job_id, v_runtime.current_attempt, 'children_joined',
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

  BEGIN
    FOR v_item IN
      SELECT item, ordinality::integer AS ordinal
        FROM jsonb_array_elements(p_children) WITH ORDINALITY input(item, ordinality)
       ORDER BY ordinality
    LOOP
      SELECT * INTO v_enqueue
        FROM workhorse.enqueue_many_v2(jsonb_build_array(v_item.item->'request'));
      IF v_enqueue.outcome <> 'accepted' THEN
        RAISE EXCEPTION 'child enqueue must create one new job';
      END IF;
      INSERT INTO workhorse.job_child(
        parent_job_id, child_job_id, child_name, request_fingerprint, created_at, created_as_set
      ) VALUES (
        p_parent_job_id, v_enqueue.job_id, v_item.item->>'name', v_item.item->'request', v_now, true
      );
      INSERT INTO workhorse.job_dependency(
        dependent_job_id, prerequisite_job_id, on_success, on_failure, on_cancellation, created_at
      ) VALUES (
        p_parent_job_id, v_enqueue.job_id, 'release', 'fail', 'cancel', v_now
      );
      INSERT INTO workhorse.job_event(job_id, event_type, details)
        VALUES (
          v_enqueue.job_id, 'parent_linked',
          jsonb_build_object('parent_job_id', p_parent_job_id, 'name', v_item.item->>'name')
        );
    END LOOP;

    UPDATE workhorse.job_runtime runtime
       SET state = 'blocked', fence_token = 0, ready_at = NULL, sequence = NULL,
           worker_id = NULL, acquired_at = NULL, heartbeat_at = NULL, expires_at = NULL,
           wait_name = NULL, attempt_started_at = NULL,
           execution_used_ms = LEAST(
             31536000000,
             runtime.execution_used_ms + GREATEST(
               0, floor(extract(epoch FROM v_now - runtime.acquired_at) * 1000)::bigint
             )
           ),
           attempt_timeout_at = NULL, error = NULL, updated_at = v_now
     WHERE runtime.job_id = p_parent_job_id
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
             'childJobId', edge.child_job_id,
             'name', edge.child_name,
             'type', job.job_type,
             'createdAt', edge.created_at,
             'joinedAt', edge.joined_at
           ) ORDER BY input.ordinality)
      INTO v_children
      FROM jsonb_array_elements(p_children) WITH ORDINALITY input(item, ordinality)
      JOIN workhorse.job_child edge
        ON edge.parent_job_id = p_parent_job_id AND edge.child_name = input.item->>'name'
      JOIN workhorse.job job ON job.id = edge.child_job_id;
    INSERT INTO workhorse.job_event(job_id, attempt, event_type, details)
      VALUES (
        p_parent_job_id, v_runtime.current_attempt, 'children_created',
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

-- Resolve every pending edge in the same transaction that materializes a prerequisite outcome.
-- Dependents lock in identity order, so concurrent fan-in outcomes serialize at the one state
-- transition boundary without repeating terminal evidence, FIFO allocation, or notifications.
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
  v_final_prerequisite_job_id uuid;
  v_final_prerequisite_state text;
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
    SELECT dependency.resolution, dependency.prerequisite_job_id, outcome.state
      INTO STRICT v_final_action, v_final_prerequisite_job_id, v_final_prerequisite_state
      FROM workhorse.job_dependency dependency
      JOIN workhorse.job_outcome outcome ON outcome.job_id = dependency.prerequisite_job_id
     WHERE dependency.dependent_job_id = v_dependency.dependent_job_id
     ORDER BY CASE dependency.resolution WHEN 'fail' THEN 0 WHEN 'cancel' THEN 1 ELSE 2 END,
              dependency.prerequisite_job_id
     LIMIT 1;
    IF v_final_action IN ('fail', 'cancel') THEN
      v_error := jsonb_build_object(
        'name', CASE WHEN v_final_action = 'fail' THEN 'DependencyFailed' ELSE 'DependencyCanceled' END,
        'message', CASE WHEN v_final_action = 'fail'
          THEN 'a prerequisite reached a terminal outcome rejected by dependency policy'
          ELSE 'a prerequisite reached a terminal outcome that canceled its dependent' END,
        'prerequisite_job_id', v_final_prerequisite_job_id,
        'prerequisite_state', v_final_prerequisite_state,
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
        'reason', CASE p_prerequisite_state
          WHEN 'succeeded' THEN 'prerequisite_succeeded'
          WHEN 'failed' THEN 'prerequisite_failed_policy'
          WHEN 'canceled' THEN 'prerequisite_canceled_policy'
        END
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

CREATE OR REPLACE FUNCTION workhorse.complete_v1(
  p_job_id uuid, p_worker_id text, p_fence_token bigint, p_result jsonb DEFAULT 'null'::jsonb
) RETURNS boolean
LANGUAGE plpgsql
AS $$
DECLARE
  v_runtime workhorse.job_runtime%ROWTYPE;
  v_result_max_bytes integer;
BEGIN
  SELECT job.result_max_bytes INTO v_result_max_bytes
    FROM workhorse.job_runtime runtime
    JOIN workhorse.job job ON job.id = runtime.job_id
   WHERE runtime.job_id = p_job_id AND runtime.state = 'active'
     AND runtime.worker_id = p_worker_id AND runtime.fence_token = p_fence_token
     AND runtime.expires_at > clock_timestamp()
     AND (runtime.deadline_at IS NULL OR runtime.deadline_at > clock_timestamp())
     AND (runtime.attempt_timeout_at IS NULL OR runtime.attempt_timeout_at > clock_timestamp())
     AND runtime.cancel_requested_at IS NULL
   FOR UPDATE OF runtime, job;
  IF NOT FOUND THEN RETURN false; END IF;
  IF octet_length(COALESCE(p_result, 'null'::jsonb)::text) > v_result_max_bytes THEN
    RAISE EXCEPTION 'result exceeds its configured size limit';
  END IF;
  DELETE FROM workhorse.job_runtime r
   WHERE r.job_id = p_job_id AND r.state = 'active' AND r.worker_id = p_worker_id
     AND r.fence_token = p_fence_token AND r.expires_at > clock_timestamp()
     AND (r.deadline_at IS NULL OR r.deadline_at > clock_timestamp())
     AND (r.attempt_timeout_at IS NULL OR r.attempt_timeout_at > clock_timestamp())
     AND r.cancel_requested_at IS NULL
  RETURNING * INTO v_runtime;
  IF NOT FOUND THEN RETURN false; END IF;

  INSERT INTO workhorse.job_outcome(job_id, state, current_attempt, fence_token, run_at, result)
    VALUES (p_job_id, 'succeeded', v_runtime.current_attempt, p_fence_token, v_runtime.run_at, p_result);
  INSERT INTO workhorse.attempt_history(
    job_id, attempt, fence_token, worker_id, outcome, started_at, claimed_at
  ) VALUES (
    p_job_id, v_runtime.current_attempt, p_fence_token, p_worker_id, 'succeeded',
    v_runtime.attempt_started_at, v_runtime.acquired_at
  );
  INSERT INTO workhorse.job_event(job_id, attempt, event_type, details)
    VALUES (p_job_id, v_runtime.current_attempt, 'succeeded', jsonb_build_object('fence_token', p_fence_token::text));
  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION workhorse.fail_v1(
  p_job_id uuid, p_worker_id text, p_fence_token bigint, p_error jsonb,
  p_retry_delay_ms integer DEFAULT NULL
) RETURNS text
LANGUAGE plpgsql
AS $$
DECLARE
  v_runtime workhorse.job_runtime%ROWTYPE;
  v_job workhorse.job%ROWTYPE;
  v_run_at timestamptz;
  v_state text;
  v_started_at timestamptz;
  v_claimed_at timestamptz;
  v_retry record;
  v_error jsonb;
BEGIN
  SELECT * INTO v_runtime FROM workhorse.job_runtime r
   WHERE r.job_id = p_job_id AND r.state = 'active' AND r.worker_id = p_worker_id
     AND r.fence_token = p_fence_token
   FOR UPDATE;
  IF NOT FOUND OR v_runtime.expires_at <= clock_timestamp() THEN RETURN 'stale'; END IF;
  IF v_runtime.cancel_requested_at IS NOT NULL THEN RETURN 'cancel_requested'; END IF;
  IF v_runtime.deadline_at IS NOT NULL AND v_runtime.deadline_at <= clock_timestamp() THEN
    RETURN workhorse.expire_owned_v1(p_job_id, p_worker_id, p_fence_token);
  END IF;
  IF v_runtime.attempt_timeout_at IS NOT NULL
     AND v_runtime.attempt_timeout_at <= clock_timestamp() THEN
    RETURN workhorse.expire_owned_v1(p_job_id, p_worker_id, p_fence_token);
  END IF;
  SELECT * INTO STRICT v_job FROM workhorse.job j WHERE j.id = p_job_id;
  v_error := workhorse.redact_error_details_v1(
    p_error,
    cardinality(v_job.payload_redact_keys) > 0 OR cardinality(v_job.result_redact_keys) > 0
  );

  IF v_runtime.current_attempt < v_job.max_attempts THEN
    v_started_at := v_runtime.attempt_started_at;
    v_claimed_at := v_runtime.acquired_at;
    SELECT * INTO STRICT v_retry FROM workhorse.retry_delay_v1(
      p_job_id, v_runtime.current_attempt, v_job.retry_policy,
      v_runtime.previous_retry_delay_ms, p_retry_delay_ms, 'legacy-handler'
    );
    v_run_at := clock_timestamp() + make_interval(secs => v_retry.delay_ms::double precision / 1000.0);
    v_state := CASE WHEN v_retry.delay_ms <= 0 THEN 'ready' ELSE 'scheduled' END;
    UPDATE workhorse.job_runtime r
       SET state = v_state, current_attempt = r.current_attempt + 1, fence_token = 0,
           run_at = v_run_at,
           ready_at = CASE WHEN v_state = 'ready' THEN clock_timestamp() END,
           sequence = CASE WHEN v_state = 'ready' THEN nextval('workhorse.ready_sequence_seq') END,
           worker_id = NULL, acquired_at = NULL, heartbeat_at = NULL, expires_at = NULL,
           wait_name = NULL, attempt_started_at = NULL, execution_used_ms = 0,
           attempt_timeout_at = NULL,
           previous_retry_delay_ms = v_retry.next_previous_retry_delay_ms,
           error = v_error, updated_at = clock_timestamp()
     WHERE r.job_id = p_job_id AND r.state = 'active' AND r.worker_id = p_worker_id
       AND r.fence_token = p_fence_token AND r.expires_at > clock_timestamp()
       AND (r.deadline_at IS NULL OR r.deadline_at > clock_timestamp())
       AND (r.attempt_timeout_at IS NULL OR r.attempt_timeout_at > clock_timestamp())
    RETURNING * INTO v_runtime;
    IF NOT FOUND THEN RETURN 'stale'; END IF;
    IF v_state = 'ready' THEN PERFORM pg_notify('workhorse_jobs', v_job.queue_name); END IF;
    INSERT INTO workhorse.attempt_history(
      job_id, attempt, fence_token, worker_id, outcome, started_at, claimed_at, error
    )
      VALUES (p_job_id, v_runtime.current_attempt - 1, p_fence_token, p_worker_id, 'retry',
        v_started_at, v_claimed_at, v_error);
    INSERT INTO workhorse.job_event(job_id, attempt, event_type, details)
      VALUES (p_job_id, v_runtime.current_attempt - 1, 'retry_scheduled',
        jsonb_build_object('next_attempt', v_runtime.current_attempt, 'run_at', v_run_at,
          'error', v_error, 'retry_policy', v_job.retry_policy,
          'retry_delay_ms', v_retry.delay_ms, 'retry_delay_source', v_retry.source));
  ELSE
    DELETE FROM workhorse.job_runtime r
     WHERE r.job_id = p_job_id AND r.state = 'active' AND r.worker_id = p_worker_id
       AND r.fence_token = p_fence_token AND r.expires_at > clock_timestamp()
       AND (r.deadline_at IS NULL OR r.deadline_at > clock_timestamp())
       AND (r.attempt_timeout_at IS NULL OR r.attempt_timeout_at > clock_timestamp())
    RETURNING * INTO v_runtime;
    IF NOT FOUND THEN RETURN 'stale'; END IF;
    v_state := 'failed';
    INSERT INTO workhorse.job_outcome(job_id, state, current_attempt, fence_token, run_at, error)
      VALUES (p_job_id, 'failed', v_runtime.current_attempt, p_fence_token, v_runtime.run_at, v_error);
    INSERT INTO workhorse.attempt_history(
      job_id, attempt, fence_token, worker_id, outcome, started_at, claimed_at, error
    ) VALUES (
      p_job_id, v_runtime.current_attempt, p_fence_token, p_worker_id, 'failed',
      v_runtime.attempt_started_at, v_runtime.acquired_at, v_error
    );
    INSERT INTO workhorse.job_event(job_id, attempt, event_type, details)
      VALUES (p_job_id, v_runtime.current_attempt, 'failed', jsonb_build_object('error', v_error));
  END IF;
  RETURN v_state;
END;
$$;

CREATE OR REPLACE FUNCTION workhorse.recover_expired_v1(
  p_limit integer DEFAULT 100, p_retry_delay_ms integer DEFAULT NULL
) RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  v_runtime workhorse.job_runtime%ROWTYPE;
  v_job workhorse.job%ROWTYPE;
  v_state text;
  v_run_at timestamptz;
  v_error jsonb := jsonb_build_object('name', 'LeaseExpired', 'message', 'worker lease expired');
  v_count integer := 0;
  v_retry record;
  v_retry_delay_ms bigint;
  v_retry_source text;
  v_envelope jsonb;
  v_expired_leases integer := 0;
  v_retried integer := 0;
  v_retry_dimensions jsonb := '[]'::jsonb;
BEGIN
  PERFORM set_config('workhorse.recovery_expired_leases', '0', true);
  PERFORM set_config('workhorse.recovery_retried', '0', true);
  PERFORM set_config('workhorse.recovery_retry_dimensions', '[]', true);
  FOR v_runtime IN
    SELECT runtime.* FROM workhorse.job_runtime runtime
     WHERE runtime.deadline_at IS NOT NULL AND runtime.deadline_at <= clock_timestamp()
       AND (
         runtime.state <> 'active'
         OR runtime.attempt_timeout_at IS NULL
         OR runtime.attempt_timeout_at > clock_timestamp()
         OR runtime.deadline_at <= runtime.attempt_timeout_at
       )
     ORDER BY runtime.deadline_at, runtime.job_id FOR UPDATE SKIP LOCKED
     LIMIT GREATEST(1, LEAST(p_limit, 10000))
  LOOP
    IF workhorse.terminalize_deadline_v1(v_runtime.job_id) THEN
      v_count := v_count + 1;
    END IF;
  END LOOP;

  IF v_count < GREATEST(1, LEAST(p_limit, 10000)) THEN
    FOR v_runtime IN
      SELECT runtime.* FROM workhorse.job_runtime runtime
       WHERE runtime.state = 'active' AND runtime.attempt_timeout_at IS NOT NULL
         AND runtime.attempt_timeout_at <= clock_timestamp()
         AND (
           runtime.deadline_at IS NULL
           OR runtime.deadline_at > clock_timestamp()
           OR runtime.attempt_timeout_at < runtime.deadline_at
         )
       ORDER BY runtime.attempt_timeout_at, runtime.job_id FOR UPDATE SKIP LOCKED
       LIMIT GREATEST(0, LEAST(p_limit, 10000) - v_count)
    LOOP
      SELECT * INTO STRICT v_job FROM workhorse.job job WHERE job.id = v_runtime.job_id;
      IF workhorse.timeout_owned_v1(
        v_runtime.job_id, v_runtime.worker_id, v_runtime.fence_token
      ) THEN
        v_count := v_count + 1;
        IF v_runtime.current_attempt < v_job.max_attempts THEN
          v_retried := v_retried + 1;
          v_retry_dimensions := v_retry_dimensions || jsonb_build_array(jsonb_build_object(
            'queue', v_job.queue_name, 'type', v_job.job_type
          ));
        END IF;
      END IF;
    END LOOP;
  END IF;

  IF v_count >= GREATEST(1, LEAST(p_limit, 10000)) THEN
    PERFORM set_config('workhorse.recovery_expired_leases', v_expired_leases::text, true);
    PERFORM set_config('workhorse.recovery_retried', v_retried::text, true);
    PERFORM set_config('workhorse.recovery_retry_dimensions', v_retry_dimensions::text, true);
    IF v_count > 0 THEN PERFORM pg_notify('workhorse_jobs', '*'); END IF;
    RETURN v_count;
  END IF;

  FOR v_runtime IN
    SELECT r.* FROM workhorse.job_runtime r
     WHERE r.state = 'active' AND r.expires_at <= clock_timestamp()
       AND (
         r.cancel_requested_at IS NOT NULL
         OR r.deadline_at IS NULL OR r.deadline_at > clock_timestamp()
       )
       AND (
         r.cancel_requested_at IS NOT NULL
         OR r.attempt_timeout_at IS NULL OR r.attempt_timeout_at > clock_timestamp()
       )
     ORDER BY r.expires_at, r.job_id FOR UPDATE SKIP LOCKED
     LIMIT GREATEST(0, LEAST(p_limit, 10000) - v_count)
  LOOP
    SELECT * INTO STRICT v_job FROM workhorse.job j WHERE j.id = v_runtime.job_id;
    IF v_runtime.cancel_requested_at IS NOT NULL THEN
      v_envelope := workhorse.cancellation_envelope_v1(
        v_runtime.cancel_requested_at, v_runtime.cancel_requested_by, v_runtime.cancel_reason
      );
      DELETE FROM workhorse.job_runtime r
       WHERE r.job_id = v_runtime.job_id AND r.state = 'active'
         AND r.fence_token = v_runtime.fence_token AND r.expires_at <= clock_timestamp()
         AND r.cancel_requested_at IS NOT NULL;
      IF NOT FOUND THEN CONTINUE; END IF;
      INSERT INTO workhorse.job_outcome(job_id, state, current_attempt, fence_token, run_at, error)
        VALUES (
          v_runtime.job_id, 'canceled', v_runtime.current_attempt, v_runtime.fence_token,
          v_runtime.run_at, v_envelope
        );
      INSERT INTO workhorse.attempt_history(
        job_id, attempt, fence_token, worker_id, outcome, started_at, claimed_at, error
      ) VALUES (
        v_runtime.job_id, v_runtime.current_attempt, v_runtime.fence_token,
        v_runtime.worker_id, 'canceled', v_runtime.attempt_started_at,
        v_runtime.acquired_at, v_envelope
      );
      INSERT INTO workhorse.job_event(job_id, attempt, event_type, details)
        VALUES (
          v_runtime.job_id,
          v_runtime.current_attempt,
          'canceled',
          jsonb_build_object(
            'requested_at', v_runtime.cancel_requested_at,
            'requested_by', v_runtime.cancel_requested_by,
            'reason', v_runtime.cancel_reason,
            'fence_token', v_runtime.fence_token::text,
            'source', 'recovered'
          )
        );
      v_count := v_count + 1;
      v_expired_leases := v_expired_leases + 1;
      CONTINUE;
    END IF;
    IF v_runtime.current_attempt < v_job.max_attempts THEN
      SELECT * INTO STRICT v_retry FROM workhorse.retry_delay_v1(
        v_runtime.job_id, v_runtime.current_attempt, v_job.retry_policy,
        v_runtime.previous_retry_delay_ms, p_retry_delay_ms, 'lease-recovery-immediate'
      );
      v_retry_delay_ms := v_retry.delay_ms;
      v_retry_source := v_retry.source;
      v_run_at := clock_timestamp() + make_interval(secs => v_retry_delay_ms::double precision / 1000.0);
      v_state := CASE WHEN v_retry_delay_ms <= 0 THEN 'ready' ELSE 'scheduled' END;
      UPDATE workhorse.job_runtime r
         SET state = v_state, current_attempt = r.current_attempt + 1, fence_token = 0,
             run_at = v_run_at,
             ready_at = CASE WHEN v_state = 'ready' THEN clock_timestamp() END,
             sequence = CASE WHEN v_state = 'ready' THEN nextval('workhorse.ready_sequence_seq') END,
             worker_id = NULL, acquired_at = NULL, heartbeat_at = NULL, expires_at = NULL,
             wait_name = NULL, attempt_started_at = NULL, execution_used_ms = 0,
             attempt_timeout_at = NULL,
             previous_retry_delay_ms = v_retry.next_previous_retry_delay_ms,
             error = v_error, updated_at = clock_timestamp()
       WHERE r.job_id = v_runtime.job_id AND r.state = 'active'
         AND r.fence_token = v_runtime.fence_token AND r.expires_at <= clock_timestamp();
      IF NOT FOUND THEN CONTINUE; END IF;
      v_retried := v_retried + 1;
      v_retry_dimensions := v_retry_dimensions || jsonb_build_array(jsonb_build_object(
        'queue', v_job.queue_name, 'type', v_job.job_type
      ));
    ELSE
      v_state := 'failed';
      v_retry_delay_ms := NULL;
      v_retry_source := 'terminal';
      DELETE FROM workhorse.job_runtime r
       WHERE r.job_id = v_runtime.job_id AND r.state = 'active'
         AND r.fence_token = v_runtime.fence_token AND r.expires_at <= clock_timestamp();
      IF NOT FOUND THEN CONTINUE; END IF;
      INSERT INTO workhorse.job_outcome(job_id, state, current_attempt, fence_token, run_at, error)
        VALUES (v_runtime.job_id, 'failed', v_runtime.current_attempt, v_runtime.fence_token,
          v_runtime.run_at, v_error);
    END IF;
    INSERT INTO workhorse.attempt_history(
      job_id, attempt, fence_token, worker_id, outcome, started_at, claimed_at, error
    )
      VALUES (v_runtime.job_id, v_runtime.current_attempt, v_runtime.fence_token, v_runtime.worker_id,
        'lease_expired', v_runtime.attempt_started_at, v_runtime.acquired_at, v_error);
    INSERT INTO workhorse.job_event(job_id, attempt, event_type, details)
      VALUES (v_runtime.job_id, v_runtime.current_attempt, 'lease_expired',
        jsonb_build_object('fence_token', v_runtime.fence_token::text, 'next_state', v_state,
          'retry_policy', v_job.retry_policy, 'retry_delay_ms', v_retry_delay_ms,
          'retry_delay_source', v_retry_source));
    v_count := v_count + 1;
    v_expired_leases := v_expired_leases + 1;
  END LOOP;
  PERFORM set_config('workhorse.recovery_expired_leases', v_expired_leases::text, true);
  PERFORM set_config('workhorse.recovery_retried', v_retried::text, true);
  PERFORM set_config('workhorse.recovery_retry_dimensions', v_retry_dimensions::text, true);
  IF v_count > 0 THEN PERFORM pg_notify('workhorse_jobs', '*'); END IF;
  RETURN v_count;
END;
$$;

CREATE OR REPLACE FUNCTION workhorse.recover_expired_telemetry_v1(
  p_limit integer DEFAULT 100, p_retry_delay_ms integer DEFAULT NULL
) RETURNS TABLE (
  rows_affected integer, expired_leases integer, retried integer, retry_dimensions jsonb
)
LANGUAGE plpgsql
AS $$
BEGIN
  rows_affected := workhorse.recover_expired_v1(p_limit, p_retry_delay_ms);
  expired_leases := COALESCE(
    NULLIF(current_setting('workhorse.recovery_expired_leases', true), ''), '0'
  )::integer;
  retried := COALESCE(
    NULLIF(current_setting('workhorse.recovery_retried', true), ''), '0'
  )::integer;
  retry_dimensions := COALESCE(
    NULLIF(current_setting('workhorse.recovery_retry_dimensions', true), ''), '[]'
  )::jsonb;
  RETURN NEXT;
END;
$$;

CREATE OR REPLACE FUNCTION workhorse.tick_v1(
  p_promote_limit integer DEFAULT 1000, p_recover_limit integer DEFAULT 1000
) RETURNS TABLE (
  phase text, rows_affected integer, duration_ms integer, skipped_lock boolean, error jsonb,
  expired_leases integer, retried integer, retry_dimensions jsonb
)
LANGUAGE plpgsql
AS $$
DECLARE
  v_started_at timestamptz;
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtextextended('workhorse:tick', 0)) THEN
    RETURN QUERY VALUES
      ('promote'::text, 0, 0, true, NULL::jsonb, 0, 0, '[]'::jsonb),
      ('recover'::text, 0, 0, true, NULL::jsonb, 0, 0, '[]'::jsonb);
    RETURN;
  END IF;

  phase := 'promote';
  rows_affected := 0;
  skipped_lock := false;
  error := NULL;
  expired_leases := 0;
  retried := 0;
  retry_dimensions := '[]'::jsonb;
  v_started_at := clock_timestamp();
  BEGIN
    rows_affected := workhorse.promote_v1(p_promote_limit);
  EXCEPTION WHEN OTHERS THEN
    error := jsonb_build_object('code', SQLSTATE, 'message', SQLERRM);
  END;
  duration_ms := GREATEST(
    0, round(extract(epoch FROM clock_timestamp() - v_started_at) * 1000)::integer
  );
  RETURN NEXT;

  phase := 'recover';
  rows_affected := 0;
  error := NULL;
  v_started_at := clock_timestamp();
  BEGIN
    SELECT recovery.rows_affected, recovery.expired_leases, recovery.retried,
           recovery.retry_dimensions
      INTO rows_affected, expired_leases, retried, retry_dimensions
      FROM workhorse.recover_expired_telemetry_v1(p_recover_limit) recovery;
  EXCEPTION WHEN OTHERS THEN
    error := jsonb_build_object('code', SQLSTATE, 'message', SQLERRM);
  END;
  duration_ms := GREATEST(
    0, round(extract(epoch FROM clock_timestamp() - v_started_at) * 1000)::integer
  );
  RETURN NEXT;
END;
$$;

CREATE OR REPLACE FUNCTION workhorse.retire_history_partitions_v1(
  p_parent text, p_before timestamptz, p_limit integer
) RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  v_partition record;
  v_count integer := 0;
  v_previous_lock_timeout text;
BEGIN
  IF p_parent NOT IN ('job_event', 'attempt_history') THEN
    RAISE EXCEPTION 'history parent must be job_event or attempt_history';
  END IF;
  IF p_before IS NULL OR NOT isfinite(p_before) THEN RAISE EXCEPTION 'retention cutoff is required'; END IF;
  IF p_limit NOT BETWEEN 1 AND 52 THEN RAISE EXCEPTION 'partition limit must be between 1 and 52'; END IF;

  FOR v_partition IN
    SELECT child_namespace.nspname AS schema_name, child.relname,
           ((regexp_match(
             pg_get_expr(child.relpartbound, child.oid),
             'TO \(''([^'']+)''\)'
           ))[1])::timestamptz AS upper_bound
      FROM pg_inherits inheritance
      JOIN pg_class parent ON parent.oid = inheritance.inhparent
      JOIN pg_namespace namespace ON namespace.oid = parent.relnamespace
      JOIN pg_class child ON child.oid = inheritance.inhrelid
      JOIN pg_namespace child_namespace ON child_namespace.oid = child.relnamespace
     WHERE namespace.nspname = 'workhorse'
       AND parent.relname = p_parent
       AND child.relname <> p_parent || '_default'
       AND ((regexp_match(
             pg_get_expr(child.relpartbound, child.oid),
             'TO \(''([^'']+)''\)'
           ))[1])::timestamptz <= p_before
       AND ((regexp_match(
             pg_get_expr(child.relpartbound, child.oid),
             'TO \(''([^'']+)''\)'
           ))[1])::timestamptz <= (
             date_trunc('day', clock_timestamp() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
           )
     ORDER BY upper_bound, child.relname
     LIMIT p_limit
  LOOP
    IF NOT pg_try_advisory_xact_lock(hashtextextended(
      'workhorse:history-day:' || ((v_partition.upper_bound AT TIME ZONE 'UTC')::date - 1),
      0
    )) THEN
      CONTINUE;
    END IF;
    v_previous_lock_timeout := current_setting('lock_timeout');
    PERFORM set_config('lock_timeout', '250ms', true);
    BEGIN
      EXECUTE format(
        'DROP TABLE IF EXISTS %I.%I', v_partition.schema_name, v_partition.relname
      );
      v_count := v_count + 1;
    EXCEPTION
      WHEN lock_not_available THEN NULL;
      WHEN OTHERS THEN
        PERFORM set_config('lock_timeout', v_previous_lock_timeout, true);
        RAISE;
    END;
    PERFORM set_config('lock_timeout', v_previous_lock_timeout, true);
  END LOOP;
  RETURN v_count;
END;
$$;

CREATE OR REPLACE FUNCTION workhorse.prune_default_history_v1(
  p_parent text, p_before timestamptz, p_limit integer
) RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE v_count integer;
BEGIN
  IF p_before IS NULL OR NOT isfinite(p_before) THEN RAISE EXCEPTION 'retention cutoff is required'; END IF;
  IF p_limit NOT BETWEEN 1 AND 1000000 THEN RAISE EXCEPTION 'row limit must be between 1 and 1000000'; END IF;
  IF p_parent = 'job_event' THEN
    WITH candidates AS (
      SELECT ctid FROM workhorse.job_event_default
       WHERE occurred_at < p_before ORDER BY occurred_at, event_id
       FOR UPDATE SKIP LOCKED LIMIT p_limit
    )
    DELETE FROM workhorse.job_event_default history USING candidates
     WHERE history.ctid = candidates.ctid;
  ELSIF p_parent = 'attempt_history' THEN
    WITH candidates AS (
      SELECT ctid FROM workhorse.attempt_history_default
       WHERE occurred_at < p_before ORDER BY occurred_at, attempt_id
       FOR UPDATE SKIP LOCKED LIMIT p_limit
    )
    DELETE FROM workhorse.attempt_history_default history USING candidates
     WHERE history.ctid = candidates.ctid;
  ELSE
    RAISE EXCEPTION 'history parent must be job_event or attempt_history';
  END IF;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

CREATE OR REPLACE FUNCTION workhorse.prune_terminal_jobs_v1(
  p_identity_before timestamptz, p_outcome_before timestamptz,
  p_history_before timestamptz, p_limit integer
) RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE v_count integer;
BEGIN
  IF p_identity_before IS NULL OR p_outcome_before IS NULL OR p_history_before IS NULL
     OR NOT isfinite(p_identity_before) OR NOT isfinite(p_outcome_before)
     OR NOT isfinite(p_history_before) THEN
    RAISE EXCEPTION 'identity, outcome, and history cutoffs are required';
  END IF;
  IF p_limit NOT BETWEEN 1 AND 100000 THEN RAISE EXCEPTION 'terminal job limit must be between 1 and 100000'; END IF;

  WITH candidate_window AS MATERIALIZED (
    SELECT job.id, outcome.finished_at
      FROM workhorse.job job
      JOIN workhorse.job_outcome outcome ON outcome.job_id = job.id
     WHERE job.created_at < p_identity_before
       AND outcome.finished_at < p_outcome_before
       AND outcome.history_through_at < p_history_before
       AND NOT EXISTS (SELECT 1 FROM workhorse.job_runtime runtime WHERE runtime.job_id = job.id)
     ORDER BY outcome.finished_at, job.id
     FOR UPDATE OF job SKIP LOCKED
     LIMIT LEAST(p_limit * 4, 100000)
  ), candidates AS (
    SELECT candidate.id
      FROM candidate_window candidate
     WHERE NOT EXISTS (
             SELECT 1 FROM workhorse.schedule_occurrence occurrence
              WHERE occurrence.job_id = candidate.id
           )
       AND NOT EXISTS (
             SELECT 1 FROM workhorse.enqueue_idempotency idempotency
              WHERE idempotency.job_id = candidate.id
           )
       AND NOT EXISTS (
             SELECT 1 FROM workhorse.job_redrive redrive
              WHERE redrive.source_job_id = candidate.id
           )
       AND NOT EXISTS (
             SELECT 1 FROM workhorse.job_dependency dependency
              WHERE dependency.prerequisite_job_id = candidate.id
           )
       AND NOT EXISTS (
             SELECT 1
               FROM workhorse.job_child edge
               JOIN workhorse.job child ON child.id = edge.child_job_id
               LEFT JOIN workhorse.job_outcome child_outcome
                 ON child_outcome.job_id = edge.child_job_id
              WHERE edge.parent_job_id = candidate.id
                AND (
                  child_outcome.job_id IS NULL
                  OR child.created_at >= p_identity_before
                  OR child_outcome.finished_at >= p_outcome_before
                  OR child_outcome.history_through_at >= p_history_before
                )
           )
     ORDER BY candidate.finished_at, candidate.id
     LIMIT p_limit
  )
  DELETE FROM workhorse.job job USING candidates WHERE job.id = candidates.id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

CREATE OR REPLACE FUNCTION workhorse.prune_enqueue_idempotency_v1(
  p_before timestamptz, p_limit integer
) RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE v_count integer;
BEGIN
  IF p_before IS NULL OR NOT isfinite(p_before) THEN
    RAISE EXCEPTION 'idempotency cutoff is required';
  END IF;
  IF p_limit NOT BETWEEN 1 AND 100000 THEN
    RAISE EXCEPTION 'idempotency prune limit must be between 1 and 100000';
  END IF;
  WITH candidates AS MATERIALIZED (
    SELECT idempotency_scope, idempotency_key_hash
      FROM workhorse.enqueue_idempotency
     WHERE expires_at <= p_before
     ORDER BY expires_at, idempotency_scope, idempotency_key_hash
     FOR UPDATE SKIP LOCKED
     LIMIT p_limit
  )
  DELETE FROM workhorse.enqueue_idempotency idempotency USING candidates
   WHERE idempotency.idempotency_scope = candidates.idempotency_scope
     AND idempotency.idempotency_key_hash = candidates.idempotency_key_hash;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

CREATE OR REPLACE FUNCTION workhorse.history_retention_complete_v1(
  p_parent text, p_before timestamptz
) RETURNS boolean
LANGUAGE plpgsql
STABLE
AS $$
DECLARE v_partitions_remain boolean;
DECLARE v_default_rows_remain boolean;
BEGIN
  IF p_parent NOT IN ('job_event', 'attempt_history') THEN
    RAISE EXCEPTION 'history parent must be job_event or attempt_history';
  END IF;
  IF p_before IS NULL OR NOT isfinite(p_before) THEN
    RAISE EXCEPTION 'retention cutoff is required';
  END IF;
  SELECT EXISTS (
    SELECT 1
      FROM pg_inherits inheritance
      JOIN pg_class parent ON parent.oid = inheritance.inhparent
      JOIN pg_namespace namespace ON namespace.oid = parent.relnamespace
      JOIN pg_class child ON child.oid = inheritance.inhrelid
     WHERE namespace.nspname = 'workhorse'
       AND parent.relname = p_parent
       AND child.relname <> p_parent || '_default'
       AND ((regexp_match(
             pg_get_expr(child.relpartbound, child.oid),
             'TO \(''([^'']+)''\)'
           ))[1])::timestamptz <= p_before
  ) INTO v_partitions_remain;
  IF p_parent = 'job_event' THEN
    SELECT EXISTS (
      SELECT 1 FROM workhorse.job_event_default WHERE occurred_at < p_before LIMIT 1
    ) INTO v_default_rows_remain;
  ELSE
    SELECT EXISTS (
      SELECT 1 FROM workhorse.attempt_history_default WHERE occurred_at < p_before LIMIT 1
    ) INTO v_default_rows_remain;
  END IF;
  RETURN NOT v_partitions_remain AND NOT v_default_rows_remain;
END;
$$;

CREATE OR REPLACE FUNCTION workhorse.prepare_history_partitions_v1(
  p_force boolean DEFAULT false,
  p_now timestamptz DEFAULT clock_timestamp()
) RETURNS TABLE (
  phase text, rows_affected integer, duration_ms integer, skipped_lock boolean, error jsonb
)
LANGUAGE plpgsql
AS $$
DECLARE v_started_at timestamptz;
DECLARE v_day_offset integer;
DECLARE v_suffix text;
DECLARE v_today date := (p_now AT TIME ZONE 'UTC')::date;
DECLARE v_policy workhorse.maintenance_policy%ROWTYPE;
DECLARE v_state workhorse.maintenance_state%ROWTYPE;
BEGIN
  IF p_now IS NULL OR NOT isfinite(p_now) THEN RAISE EXCEPTION 'maintenance time is required'; END IF;
  IF NOT pg_try_advisory_xact_lock(
    hashtextextended('workhorse:maintenance:history-partitions', 0)
  ) THEN
    RETURN QUERY VALUES ('history_partitions'::text, 0, 0, true, NULL::jsonb);
    RETURN;
  END IF;
  SELECT * INTO STRICT v_policy FROM workhorse.maintenance_policy WHERE singleton;
  SELECT * INTO STRICT v_state FROM workhorse.maintenance_state
   WHERE task_name = 'history_partitions' FOR UPDATE;
  IF NOT p_force AND v_state.last_completed_at IS NOT NULL
     AND v_state.last_completed_at > p_now - make_interval(
       secs => v_policy.partition_preparation_interval_ms / 1000.0
     ) THEN
    RETURN;
  END IF;
  UPDATE workhorse.maintenance_state SET last_started_at = p_now, updated_at = clock_timestamp()
   WHERE task_name = 'history_partitions';

  phase := 'history_partitions';
  rows_affected := 0;
  skipped_lock := false;
  error := NULL;
  v_started_at := clock_timestamp();
  BEGIN
    FOR v_day_offset IN 0..3 LOOP
      v_suffix := to_char(v_today + v_day_offset, 'YYYYMMDD');
      IF to_regclass(format('workhorse.%I', 'job_event_' || v_suffix)) IS NULL
         OR to_regclass(format('workhorse.%I', 'attempt_history_' || v_suffix)) IS NULL THEN
        PERFORM workhorse.create_history_day_v1(v_today + v_day_offset);
        rows_affected := rows_affected + 1;
      END IF;
    END LOOP;
  EXCEPTION WHEN OTHERS THEN
    rows_affected := 0;
    error := jsonb_build_object('code', SQLSTATE, 'message', SQLERRM);
  END;
  duration_ms := GREATEST(
    0, round(extract(epoch FROM clock_timestamp() - v_started_at) * 1000)::integer
  );
  IF error IS NULL THEN
    UPDATE workhorse.maintenance_state
       SET last_completed_at = p_now, updated_at = clock_timestamp()
     WHERE task_name = 'history_partitions';
  END IF;
  RETURN NEXT;
END;
$$;

-- Job type used when a bucket exceeds its group limit. Statistics stay bounded even if job types
-- are generated rather than declared, and the overflow stays attributed to its queue.
CREATE OR REPLACE FUNCTION workhorse.stat_overflow_type_v1() RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $$ SELECT '__other__'::text $$;

-- Derive per-minute statistics from raw history for [p_from, p_to). This is the single definition
-- of what a bucket means: workhorse.rollup_stats_v1 materializes it for closed minutes, and
-- workhorse.stat_buckets_v1 evaluates it live for the minutes a rollup has not reached yet.
--
-- Sources are bucketed by the timestamp each grain is stamped with when it lands: enqueue events
-- and closed attempts by occurred_at, which is also the history partition key, and terminal jobs by
-- finished_at. Bucketing by anything the row does not carry would make recomputation non-idempotent.
CREATE OR REPLACE FUNCTION workhorse.aggregate_stats_v1(
  p_from timestamptz, p_to timestamptz, p_group_limit integer DEFAULT 200
) RETURNS TABLE (
  bucket_start timestamptz, queue_name text, job_type text, enqueued integer,
  job_succeeded integer, job_failed integer, job_canceled integer,
  attempt_succeeded integer, attempt_failed integer, attempt_retry integer,
  attempt_lease_expired integer, attempt_canceled integer, attempt_other integer,
  attempt_duration_ms bigint,
  last_attempt_at timestamptz, last_error text, last_error_at timestamptz
)
LANGUAGE sql STABLE
AS $$
  WITH enqueue_source AS (
    SELECT date_bin('1 minute', event.occurred_at, timestamp with time zone '2000-01-01') AS bucket,
           job.queue_name AS queue, job.job_type AS type,
           count(*)::integer AS enqueued
      FROM workhorse.job_event event
      JOIN workhorse.job job ON job.id = event.job_id
     WHERE event.event_type = 'enqueued'
       AND event.occurred_at >= p_from AND event.occurred_at < p_to
     GROUP BY 1, 2, 3
  ), attempt_source AS (
    SELECT date_bin('1 minute', history.occurred_at, timestamp with time zone '2000-01-01') AS bucket,
           job.queue_name AS queue, job.job_type AS type,
           count(*) FILTER (WHERE history.outcome = 'succeeded')::integer AS attempt_succeeded,
           count(*) FILTER (WHERE history.outcome = 'failed')::integer AS attempt_failed,
           count(*) FILTER (WHERE history.outcome = 'retry')::integer AS attempt_retry,
           count(*) FILTER (WHERE history.outcome = 'lease_expired')::integer AS attempt_lease_expired,
           count(*) FILTER (WHERE history.outcome = 'canceled')::integer AS attempt_canceled,
           count(*) FILTER (
             WHERE history.outcome IN ('deadline_exceeded', 'timeout')
           )::integer AS attempt_other,
           COALESCE(sum(GREATEST(
             0, round(extract(epoch FROM history.finished_at - history.started_at) * 1000)
           )), 0)::bigint AS attempt_duration_ms,
           max(history.finished_at) AS last_attempt_at,
           (array_agg(
              left(COALESCE(
                history.error->>'message', history.error->>'code', history.error::text
              ), 500)
              ORDER BY history.finished_at DESC, history.attempt_id DESC
            ) FILTER (WHERE history.error IS NOT NULL))[1] AS last_error,
           max(history.finished_at) FILTER (WHERE history.error IS NOT NULL) AS last_error_at
      FROM workhorse.attempt_history history
      JOIN workhorse.job job ON job.id = history.job_id
     WHERE history.occurred_at >= p_from AND history.occurred_at < p_to
     GROUP BY 1, 2, 3
  ), outcome_source AS (
    SELECT date_bin('1 minute', outcome.finished_at, timestamp with time zone '2000-01-01') AS bucket,
           job.queue_name AS queue, job.job_type AS type,
           count(*) FILTER (WHERE outcome.state = 'succeeded')::integer AS job_succeeded,
           count(*) FILTER (WHERE outcome.state = 'failed')::integer AS job_failed,
           count(*) FILTER (WHERE outcome.state = 'canceled')::integer AS job_canceled
      FROM workhorse.job_outcome outcome
      JOIN workhorse.job job ON job.id = outcome.job_id
     WHERE outcome.finished_at >= p_from AND outcome.finished_at < p_to
     GROUP BY 1, 2, 3
  ), measure AS (
    SELECT source.bucket, source.queue, source.type, source.enqueued,
           0 AS job_succeeded, 0 AS job_failed, 0 AS job_canceled,
           0 AS attempt_succeeded, 0 AS attempt_failed, 0 AS attempt_retry,
           0 AS attempt_lease_expired, 0 AS attempt_canceled, 0 AS attempt_other,
           0::bigint AS attempt_duration_ms,
           NULL::timestamptz AS last_attempt_at, NULL::text AS last_error,
           NULL::timestamptz AS last_error_at
      FROM enqueue_source source
     UNION ALL
    SELECT source.bucket, source.queue, source.type, 0,
           0, 0, 0,
           source.attempt_succeeded, source.attempt_failed, source.attempt_retry,
           source.attempt_lease_expired, source.attempt_canceled, source.attempt_other,
           source.attempt_duration_ms,
           source.last_attempt_at, source.last_error, source.last_error_at
      FROM attempt_source source
     UNION ALL
    SELECT source.bucket, source.queue, source.type, 0,
           source.job_succeeded, source.job_failed, source.job_canceled,
           0, 0, 0,
           0, 0, 0,
           0::bigint,
           NULL::timestamptz, NULL::text, NULL::timestamptz
      FROM outcome_source source
  ), total AS (
    SELECT measure.bucket, measure.queue, measure.type,
           sum(measure.enqueued)::integer AS enqueued,
           sum(measure.job_succeeded)::integer AS job_succeeded,
           sum(measure.job_failed)::integer AS job_failed,
           sum(measure.job_canceled)::integer AS job_canceled,
           sum(measure.attempt_succeeded)::integer AS attempt_succeeded,
           sum(measure.attempt_failed)::integer AS attempt_failed,
           sum(measure.attempt_retry)::integer AS attempt_retry,
           sum(measure.attempt_lease_expired)::integer AS attempt_lease_expired,
           sum(measure.attempt_canceled)::integer AS attempt_canceled,
           sum(measure.attempt_other)::integer AS attempt_other,
           sum(measure.attempt_duration_ms)::bigint AS attempt_duration_ms,
           max(measure.last_attempt_at) AS last_attempt_at,
           (array_agg(measure.last_error ORDER BY measure.last_error_at DESC NULLS LAST)
             FILTER (WHERE measure.last_error IS NOT NULL))[1] AS last_error,
           max(measure.last_error_at) AS last_error_at
      FROM measure
     GROUP BY 1, 2, 3
  ), fold AS (
    SELECT total.bucket, total.queue, total.type,
           CASE
             WHEN row_number() OVER (
               PARTITION BY total.bucket
               ORDER BY total.enqueued + total.attempt_succeeded + total.attempt_failed
                        + total.attempt_retry + total.attempt_lease_expired
                        + total.attempt_canceled + total.attempt_other DESC,
                        total.queue, total.type
             ) <= p_group_limit
             THEN total.type
             ELSE workhorse.stat_overflow_type_v1()
           END AS fold_type
      FROM total
  ), folded AS (
    SELECT total.bucket, total.queue, fold.fold_type,
           sum(total.enqueued)::integer AS enqueued,
           sum(total.job_succeeded)::integer AS job_succeeded,
           sum(total.job_failed)::integer AS job_failed,
           sum(total.job_canceled)::integer AS job_canceled,
           sum(total.attempt_succeeded)::integer AS attempt_succeeded,
           sum(total.attempt_failed)::integer AS attempt_failed,
           sum(total.attempt_retry)::integer AS attempt_retry,
           sum(total.attempt_lease_expired)::integer AS attempt_lease_expired,
           sum(total.attempt_canceled)::integer AS attempt_canceled,
           sum(total.attempt_other)::integer AS attempt_other,
           sum(total.attempt_duration_ms)::bigint AS attempt_duration_ms,
           max(total.last_attempt_at) AS last_attempt_at,
           (array_agg(total.last_error ORDER BY total.last_error_at DESC NULLS LAST)
             FILTER (WHERE total.last_error IS NOT NULL))[1] AS last_error,
           max(total.last_error_at) AS last_error_at
      FROM total
      JOIN fold ON fold.bucket = total.bucket AND fold.queue = total.queue
                AND fold.type = total.type
     GROUP BY 1, 2, 3
  )
  SELECT folded.bucket, folded.queue, folded.fold_type, folded.enqueued,
         folded.job_succeeded, folded.job_failed, folded.job_canceled,
         folded.attempt_succeeded, folded.attempt_failed, folded.attempt_retry,
         folded.attempt_lease_expired, folded.attempt_canceled, folded.attempt_other,
         folded.attempt_duration_ms,
         folded.last_attempt_at, folded.last_error, folded.last_error_at
    FROM folded
$$;

-- Statistics for [p_from, p_to) stitched from materialized buckets and a live tail. Callers never
-- need to know where the rollup watermark sits: everything below it is read, everything above it is
-- derived from the few minutes of raw history a rollup pass has not closed yet.
CREATE OR REPLACE FUNCTION workhorse.stat_buckets_v1(
  p_from timestamptz, p_to timestamptz
) RETURNS TABLE (
  bucket_start timestamptz, queue_name text, job_type text, enqueued integer,
  job_succeeded integer, job_failed integer, job_canceled integer,
  attempt_succeeded integer, attempt_failed integer, attempt_retry integer,
  attempt_lease_expired integer, attempt_canceled integer, attempt_other integer,
  attempt_duration_ms bigint,
  last_attempt_at timestamptz, last_error text, last_error_at timestamptz
)
LANGUAGE sql STABLE
AS $$
  -- The watermark is read through scalar subqueries rather than joined in from a CTE. A CTE here
  -- reads better but plans catastrophically: the planner has no statistics for it, estimates
  -- hundreds of rows, and the resulting cross-join estimate carries the plan past jit_above_cost.
  -- Every call then pays roughly a second of LLVM compilation to scan a few thousand rows. A
  -- scalar subquery over a singleton primary key is an InitPlan evaluated once, and it keeps the
  -- `p_to > watermark` test a one-time filter, so the live tail is skipped outright when the
  -- window ends at or below the watermark.
  SELECT bucket.bucket_start, bucket.queue_name, bucket.job_type, bucket.enqueued,
         bucket.job_succeeded, bucket.job_failed, bucket.job_canceled,
         bucket.attempt_succeeded, bucket.attempt_failed, bucket.attempt_retry,
         bucket.attempt_lease_expired, bucket.attempt_canceled, bucket.attempt_other,
         bucket.attempt_duration_ms,
         bucket.last_attempt_at, bucket.last_error, bucket.last_error_at
    FROM workhorse.job_stat_bucket bucket
   WHERE bucket.bucket_start >= p_from
     AND bucket.bucket_start < LEAST(p_to, (
           SELECT state.rolled_up_through FROM workhorse.job_stat_state state WHERE state.singleton
         ))
   UNION ALL
  SELECT live.bucket_start, live.queue_name, live.job_type, live.enqueued,
         live.job_succeeded, live.job_failed, live.job_canceled,
         live.attempt_succeeded, live.attempt_failed, live.attempt_retry,
         live.attempt_lease_expired, live.attempt_canceled, live.attempt_other,
         live.attempt_duration_ms,
         live.last_attempt_at, live.last_error, live.last_error_at
    FROM workhorse.aggregate_stats_v1(
           GREATEST(p_from, (
             SELECT state.rolled_up_through FROM workhorse.job_stat_state state WHERE state.singleton
           )),
           p_to
         ) live
   WHERE p_to > (
           SELECT state.rolled_up_through FROM workhorse.job_stat_state state WHERE state.singleton
         )
$$;

-- Materialize closed minutes and advance the watermark. Only fully elapsed minutes are rolled up,
-- and the pass rewrites the last few of them each time: a transaction that commits its history row
-- after its own minute closed is absorbed by the rewrite instead of being lost. Rewriting is safe
-- because a bucket is a pure function of the raw history in its minute.
CREATE OR REPLACE FUNCTION workhorse.rollup_stats_v1(
  p_now timestamptz DEFAULT clock_timestamp(),
  p_max_buckets integer DEFAULT 240,
  p_recompute_buckets integer DEFAULT 2,
  p_group_limit integer DEFAULT 200
) RETURNS TABLE (
  phase text, rows_affected integer, duration_ms integer, skipped_lock boolean, error jsonb
)
LANGUAGE plpgsql
AS $$
DECLARE v_started_at timestamptz;
DECLARE v_state workhorse.job_stat_state%ROWTYPE;
DECLARE v_policy workhorse.retention_policy%ROWTYPE;
DECLARE v_from timestamptz;
DECLARE v_to timestamptz;
DECLARE v_closed timestamptz;
BEGIN
  IF p_now IS NULL OR NOT isfinite(p_now) THEN RAISE EXCEPTION 'maintenance time is required'; END IF;
  IF p_max_buckets NOT BETWEEN 1 AND 100000 THEN
    RAISE EXCEPTION 'bucket limit must be between 1 and 100000';
  END IF;
  IF p_recompute_buckets NOT BETWEEN 0 AND 1440 THEN
    RAISE EXCEPTION 'recompute window must be between 0 and 1440 buckets';
  END IF;
  IF p_group_limit NOT BETWEEN 1 AND 10000 THEN
    RAISE EXCEPTION 'group limit must be between 1 and 10000';
  END IF;
  IF NOT pg_try_advisory_xact_lock(hashtextextended('workhorse:maintenance:stat-rollup', 0)) THEN
    RETURN QUERY VALUES
      ('stat_rollup'::text, 0, 0, true, NULL::jsonb),
      ('stat_retention'::text, 0, 0, true, NULL::jsonb);
    RETURN;
  END IF;
  SELECT * INTO STRICT v_state FROM workhorse.job_stat_state WHERE singleton FOR UPDATE;
  SELECT * INTO STRICT v_policy FROM workhorse.retention_policy WHERE singleton;

  phase := 'stat_rollup';
  rows_affected := 0;
  skipped_lock := false;
  error := NULL;
  v_started_at := clock_timestamp();
  BEGIN
    v_closed := date_bin('1 minute', p_now, timestamp with time zone '2000-01-01');
    v_from := LEAST(
      v_state.rolled_up_through - make_interval(mins => p_recompute_buckets), v_closed
    );
    -- Catching up after an outage advances in bounded passes rather than in one long transaction.
    v_to := LEAST(v_closed, v_from + make_interval(mins => p_max_buckets));
    IF v_to > v_from THEN
      DELETE FROM workhorse.job_stat_bucket
       WHERE bucket_start >= v_from AND bucket_start < v_to;
      INSERT INTO workhorse.job_stat_bucket (
        bucket_start, queue_name, job_type, enqueued,
        job_succeeded, job_failed, job_canceled,
        attempt_succeeded, attempt_failed, attempt_retry,
        attempt_lease_expired, attempt_canceled, attempt_other,
        attempt_duration_ms, last_attempt_at, last_error, last_error_at
      )
      SELECT * FROM workhorse.aggregate_stats_v1(v_from, v_to, p_group_limit);
      GET DIAGNOSTICS rows_affected = ROW_COUNT;
      UPDATE workhorse.job_stat_state
         SET rolled_up_through = v_to, last_run_at = p_now, updated_at = clock_timestamp()
       WHERE singleton;
    ELSE
      UPDATE workhorse.job_stat_state
         SET last_run_at = p_now, updated_at = clock_timestamp()
       WHERE singleton;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    error := jsonb_build_object('code', SQLSTATE, 'message', SQLERRM);
  END;
  duration_ms := GREATEST(
    0, round(extract(epoch FROM clock_timestamp() - v_started_at) * 1000)::integer
  );
  RETURN NEXT;

  -- Bucket retention is bounded per pass like every other retained category. Shortening the policy
  -- makes the next pass eligible to delete months of buckets at once, and an unbounded statement
  -- there would hold a long lock on the relation every operator window reads.
  phase := 'stat_retention';
  rows_affected := 0;
  error := NULL;
  v_started_at := clock_timestamp();
  BEGIN
    IF v_policy.statistics_retention_days IS NOT NULL THEN
      WITH expired AS (
        SELECT bucket.ctid
          FROM workhorse.job_stat_bucket bucket
         WHERE bucket.bucket_start < p_now
               - make_interval(days => v_policy.statistics_retention_days)
         ORDER BY bucket.bucket_start
           FOR UPDATE SKIP LOCKED
         LIMIT v_policy.statistics_rows_per_pass
      )
      DELETE FROM workhorse.job_stat_bucket bucket USING expired
       WHERE bucket.ctid = expired.ctid;
      GET DIAGNOSTICS rows_affected = ROW_COUNT;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    error := jsonb_build_object('code', SQLSTATE, 'message', SQLERRM);
  END;
  duration_ms := GREATEST(
    0, round(extract(epoch FROM clock_timestamp() - v_started_at) * 1000)::integer
  );
  RETURN NEXT;
END;
$$;

CREATE OR REPLACE FUNCTION workhorse.retain_history_v1(
  p_force boolean DEFAULT false,
  p_now timestamptz DEFAULT clock_timestamp()
) RETURNS TABLE (
  phase text, rows_affected integer, duration_ms integer, skipped_lock boolean, error jsonb
)
LANGUAGE plpgsql
AS $$
DECLARE v_started_at timestamptz;
DECLARE v_policy workhorse.retention_policy%ROWTYPE;
DECLARE v_maintenance workhorse.maintenance_policy%ROWTYPE;
DECLARE v_state workhorse.maintenance_state%ROWTYPE;
DECLARE v_local_now timestamp;
DECLARE v_event_before timestamptz;
DECLARE v_attempt_before timestamptz;
DECLARE v_occurrence_before timestamptz;
DECLARE v_safe_before timestamptz;
DECLARE v_rolled_up_through timestamptz;
DECLARE v_success boolean := true;
DECLARE v_complete boolean := false;
BEGIN
  IF p_now IS NULL OR NOT isfinite(p_now) THEN RAISE EXCEPTION 'maintenance time is required'; END IF;
  IF NOT pg_try_advisory_xact_lock(
    hashtextextended('workhorse:maintenance:history-retention', 0)
  ) THEN
    RETURN QUERY VALUES
      ('event_retention'::text, 0, 0, true, NULL::jsonb),
      ('attempt_retention'::text, 0, 0, true, NULL::jsonb),
      ('schedule_occurrences'::text, 0, 0, true, NULL::jsonb);
    RETURN;
  END IF;
  SELECT * INTO STRICT v_policy FROM workhorse.retention_policy WHERE singleton;
  SELECT * INTO STRICT v_maintenance FROM workhorse.maintenance_policy WHERE singleton;
  SELECT * INTO STRICT v_state FROM workhorse.maintenance_state
   WHERE task_name = 'history_retention' FOR UPDATE;
  v_local_now := p_now AT TIME ZONE v_maintenance.timezone;
  IF NOT p_force AND (
    v_local_now::time(0) < v_maintenance.history_retention_local_time
    OR v_state.last_completed_local_date >= v_local_now::date
  ) THEN
    RETURN;
  END IF;
  UPDATE workhorse.maintenance_state SET last_started_at = p_now, updated_at = clock_timestamp()
   WHERE task_name = 'history_retention';
  v_event_before := date_trunc('day', p_now AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
    - make_interval(days => COALESCE(v_policy.job_event_retention_days, 0));
  v_attempt_before := date_trunc('day', p_now AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
    - make_interval(days => COALESCE(v_policy.attempt_history_retention_days, 0));
  v_occurrence_before := p_now
    - make_interval(days => COALESCE(v_policy.schedule_occurrence_retention_days, 0));
  -- Raw history is the only input a statistics bucket can be rebuilt from. Deleting past the rollup
  -- watermark would create a permanent hole in long-window operator views, so a stalled rollup
  -- holds history instead: the cutoff waits, retention reports itself incomplete, and the growing
  -- retention lag is what surfaces on the health page.
  SELECT state.rolled_up_through INTO v_rolled_up_through
    FROM workhorse.job_stat_state state WHERE state.singleton;
  IF v_rolled_up_through IS NOT NULL THEN
    v_event_before := LEAST(v_event_before, v_rolled_up_through);
    v_attempt_before := LEAST(v_attempt_before, v_rolled_up_through);
  END IF;

  phase := 'event_retention';
  rows_affected := 0;
  skipped_lock := false;
  error := NULL;
  v_started_at := clock_timestamp();
  BEGIN
    IF v_policy.job_event_retention_days IS NOT NULL THEN
      rows_affected := workhorse.retire_history_partitions_v1(
        'job_event', v_event_before, v_policy.history_partitions_per_pass
      );
      rows_affected := rows_affected + workhorse.prune_default_history_v1(
        'job_event', v_event_before, v_policy.default_partition_rows_per_pass
      );
    END IF;
  EXCEPTION WHEN OTHERS THEN
    error := jsonb_build_object('code', SQLSTATE, 'message', SQLERRM);
    v_success := false;
  END;
  duration_ms := GREATEST(
    0, round(extract(epoch FROM clock_timestamp() - v_started_at) * 1000)::integer
  );
  RETURN NEXT;

  phase := 'attempt_retention';
  rows_affected := 0;
  error := NULL;
  v_started_at := clock_timestamp();
  BEGIN
    IF v_policy.attempt_history_retention_days IS NOT NULL THEN
      rows_affected := workhorse.retire_history_partitions_v1(
        'attempt_history', v_attempt_before, v_policy.history_partitions_per_pass
      );
      rows_affected := rows_affected + workhorse.prune_default_history_v1(
        'attempt_history', v_attempt_before, v_policy.default_partition_rows_per_pass
      );
    END IF;
  EXCEPTION WHEN OTHERS THEN
    error := jsonb_build_object('code', SQLSTATE, 'message', SQLERRM);
    v_success := false;
  END;
  duration_ms := GREATEST(
    0, round(extract(epoch FROM clock_timestamp() - v_started_at) * 1000)::integer
  );
  RETURN NEXT;

  phase := 'schedule_occurrences';
  rows_affected := 0;
  error := NULL;
  v_started_at := clock_timestamp();
  BEGIN
    IF v_policy.schedule_occurrence_retention_days IS NOT NULL THEN
      rows_affected := workhorse.prune_schedule_occurrences_v1(
        v_occurrence_before,
        v_policy.occurrence_rows_per_pass
      );
    END IF;
  EXCEPTION WHEN OTHERS THEN
    error := jsonb_build_object('code', SQLSTATE, 'message', SQLERRM);
    v_success := false;
  END;
  duration_ms := GREATEST(
    0, round(extract(epoch FROM clock_timestamp() - v_started_at) * 1000)::integer
  );
  RETURN NEXT;

  IF v_success THEN
    v_complete := (
      v_policy.job_event_retention_days IS NULL
      OR workhorse.history_retention_complete_v1('job_event', v_event_before)
    ) AND (
      v_policy.attempt_history_retention_days IS NULL
      OR workhorse.history_retention_complete_v1('attempt_history', v_attempt_before)
    ) AND (
      v_policy.schedule_occurrence_retention_days IS NULL
      OR NOT EXISTS (
        SELECT 1 FROM workhorse.schedule_occurrence
         WHERE occurrence_at < v_occurrence_before
      )
    );
    IF v_complete THEN
      v_safe_before := LEAST(v_event_before, v_attempt_before);
      UPDATE workhorse.maintenance_state
         SET last_completed_at = p_now,
             last_completed_local_date = v_local_now::date,
             history_retained_before = GREATEST(history_retained_before, v_safe_before),
             updated_at = clock_timestamp()
       WHERE task_name = 'history_retention';
    END IF;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION workhorse.prune_terminal_storage_v1(
  p_force boolean DEFAULT false,
  p_now timestamptz DEFAULT clock_timestamp()
) RETURNS TABLE (
  phase text, rows_affected integer, duration_ms integer, skipped_lock boolean, error jsonb
)
LANGUAGE plpgsql
AS $$
DECLARE v_started_at timestamptz;
DECLARE v_policy workhorse.retention_policy%ROWTYPE;
DECLARE v_maintenance workhorse.maintenance_policy%ROWTYPE;
DECLARE v_state workhorse.maintenance_state%ROWTYPE;
DECLARE v_history_before timestamptz;
DECLARE v_success boolean := true;
BEGIN
  IF p_now IS NULL OR NOT isfinite(p_now) THEN RAISE EXCEPTION 'maintenance time is required'; END IF;
  IF NOT pg_try_advisory_xact_lock(
    hashtextextended('workhorse:maintenance:terminal-storage', 0)
  ) THEN
    RETURN QUERY VALUES
      ('enqueue_idempotency'::text, 0, 0, true, NULL::jsonb),
      ('terminal_jobs'::text, 0, 0, true, NULL::jsonb);
    RETURN;
  END IF;
  SELECT * INTO STRICT v_policy FROM workhorse.retention_policy WHERE singleton;
  SELECT * INTO STRICT v_maintenance FROM workhorse.maintenance_policy WHERE singleton;
  SELECT * INTO STRICT v_state FROM workhorse.maintenance_state
   WHERE task_name = 'terminal_storage' FOR UPDATE;
  IF NOT p_force AND v_state.last_completed_at IS NOT NULL
     AND v_state.last_completed_at > p_now - make_interval(
       secs => v_maintenance.terminal_cleanup_interval_ms / 1000.0
     ) THEN
    RETURN;
  END IF;
  SELECT history_retained_before INTO v_history_before
    FROM workhorse.maintenance_state WHERE task_name = 'history_retention';
  UPDATE workhorse.maintenance_state SET last_started_at = p_now, updated_at = clock_timestamp()
   WHERE task_name = 'terminal_storage';

  phase := 'enqueue_idempotency';
  rows_affected := 0;
  skipped_lock := false;
  error := NULL;
  v_started_at := clock_timestamp();
  BEGIN
    rows_affected := workhorse.prune_enqueue_idempotency_v1(
      p_now, v_policy.terminal_job_prune_limit
    );
  EXCEPTION WHEN OTHERS THEN
    error := jsonb_build_object('code', SQLSTATE, 'message', SQLERRM);
    v_success := false;
  END;
  duration_ms := GREATEST(
    0, round(extract(epoch FROM clock_timestamp() - v_started_at) * 1000)::integer
  );
  RETURN NEXT;

  phase := 'terminal_jobs';
  rows_affected := 0;
  error := NULL;
  v_started_at := clock_timestamp();
  BEGIN
    IF v_policy.job_identity_retention_days IS NOT NULL AND v_history_before IS NOT NULL THEN
      rows_affected := workhorse.prune_terminal_jobs_v1(
        p_now - make_interval(days => v_policy.job_identity_retention_days),
        p_now - make_interval(days => v_policy.terminal_outcome_retention_days),
        v_history_before,
        v_policy.terminal_job_prune_limit
      );
    END IF;
  EXCEPTION WHEN OTHERS THEN
    error := jsonb_build_object('code', SQLSTATE, 'message', SQLERRM);
    v_success := false;
  END;
  duration_ms := GREATEST(
    0, round(extract(epoch FROM clock_timestamp() - v_started_at) * 1000)::integer
  );
  IF v_success THEN
    UPDATE workhorse.maintenance_state
       SET last_completed_at = p_now, updated_at = clock_timestamp()
     WHERE task_name = 'terminal_storage';
  END IF;
  RETURN NEXT;
END;
$$;

CREATE OR REPLACE FUNCTION workhorse.create_history_day_v1(p_day date)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  v_start timestamptz := p_day::timestamp AT TIME ZONE 'UTC';
  v_end timestamptz := (p_day + 1)::timestamp AT TIME ZONE 'UTC';
  v_suffix text := to_char(p_day, 'YYYYMMDD');
  v_event_partition text := 'job_event_' || v_suffix;
  v_attempt_partition text := 'attempt_history_' || v_suffix;
  v_event_staging text := 'workhorse_job_event_' || v_suffix;
  v_attempt_staging text := 'workhorse_attempt_history_' || v_suffix;
  v_event_exists boolean;
  v_attempt_exists boolean;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('workhorse:history-day:' || p_day, 0));
  v_event_exists := to_regclass(format('workhorse.%I', v_event_partition)) IS NOT NULL;
  v_attempt_exists := to_regclass(format('workhorse.%I', v_attempt_partition)) IS NOT NULL;
  IF v_event_exists AND v_attempt_exists THEN RETURN; END IF;

  -- Lifecycle transitions insert attempt history before job events. Take the partitioned-parent
  -- locks in that order before either CREATE TABLE can acquire them implicitly, otherwise a
  -- transition and paired partition creation can each hold the relation the other needs.
  LOCK TABLE ONLY workhorse.attempt_history IN ACCESS EXCLUSIVE MODE;
  LOCK TABLE ONLY workhorse.job_event IN ACCESS EXCLUSIVE MODE;
  LOCK TABLE workhorse.attempt_history_default IN ACCESS EXCLUSIVE MODE;
  LOCK TABLE workhorse.job_event_default IN ACCESS EXCLUSIVE MODE;
  IF NOT v_event_exists THEN
    EXECUTE format(
      'CREATE TEMP TABLE %I ON COMMIT DROP AS SELECT * FROM workhorse.job_event_default WHERE occurred_at >= %L AND occurred_at < %L',
      v_event_staging, v_start, v_end);
    DELETE FROM workhorse.job_event_default WHERE occurred_at >= v_start AND occurred_at < v_end;
    EXECUTE format(
      'CREATE TABLE workhorse.%I PARTITION OF workhorse.job_event FOR VALUES FROM (%L) TO (%L)',
      v_event_partition, v_start, v_end);
    EXECUTE format(
      'INSERT INTO workhorse.%I (event_id, job_id, attempt, event_type, details, occurred_at) OVERRIDING SYSTEM VALUE SELECT event_id, job_id, attempt, event_type, details, occurred_at FROM %I',
      v_event_partition, v_event_staging);
    EXECUTE format('DROP TABLE %I', v_event_staging);
  END IF;

  IF NOT v_attempt_exists THEN
    EXECUTE format(
      'CREATE TEMP TABLE %I ON COMMIT DROP AS SELECT * FROM workhorse.attempt_history_default WHERE occurred_at >= %L AND occurred_at < %L',
      v_attempt_staging, v_start, v_end);
    DELETE FROM workhorse.attempt_history_default WHERE occurred_at >= v_start AND occurred_at < v_end;
    EXECUTE format(
      'CREATE TABLE workhorse.%I PARTITION OF workhorse.attempt_history FOR VALUES FROM (%L) TO (%L)',
      v_attempt_partition, v_start, v_end);
    EXECUTE format(
      'INSERT INTO workhorse.%I (attempt_id, job_id, attempt, fence_token, worker_id, outcome, started_at, claimed_at, finished_at, error, occurred_at) OVERRIDING SYSTEM VALUE SELECT attempt_id, job_id, attempt, fence_token, worker_id, outcome, started_at, claimed_at, finished_at, error, occurred_at FROM %I',
      v_attempt_partition, v_attempt_staging);
    EXECUTE format('DROP TABLE %I', v_attempt_staging);
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION workhorse.retire_history_day_v1(p_day date)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  v_start date := p_day;
  v_suffix text := to_char(v_start, 'YYYYMMDD');
BEGIN
  IF v_start >= (clock_timestamp() AT TIME ZONE 'UTC')::date THEN
    RAISE EXCEPTION 'only completed history days can be retired';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('workhorse:history-day:' || v_start, 0));
  LOCK TABLE ONLY workhorse.attempt_history IN ACCESS EXCLUSIVE MODE;
  LOCK TABLE ONLY workhorse.job_event IN ACCESS EXCLUSIVE MODE;
  EXECUTE format('DROP TABLE IF EXISTS workhorse.%I', 'job_event_' || v_suffix);
  EXECUTE format('DROP TABLE IF EXISTS workhorse.%I', 'attempt_history_' || v_suffix);
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
           'blocked', 'scheduled', 'ready', 'active', 'succeeded', 'failed', 'canceled'
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

-- One named human decision per stable job. Context tells an operator what they are deciding;
-- completion retains the first bounded result and trusted actor for deterministic replay.
CREATE TABLE IF NOT EXISTS workhorse.job_human_wait (
  job_id uuid NOT NULL REFERENCES workhorse.job(id) ON DELETE CASCADE,
  token_name text NOT NULL CHECK (token_name <> '' AND char_length(token_name) <= 200),
  context jsonb NOT NULL CONSTRAINT job_human_wait_context_size CHECK (
    octet_length(context::text) <= 65536
  ),
  attempt integer NOT NULL CHECK (attempt >= 1),
  fence_token bigint NOT NULL CHECK (fence_token > 0),
  worker_id text NOT NULL CHECK (worker_id <> ''),
  claimed_at timestamptz NOT NULL CHECK (isfinite(claimed_at)),
  result jsonb CONSTRAINT job_human_wait_result_size CHECK (
    result IS NULL OR octet_length(result::text) <= 65536
  ),
  idempotency_key_hash bytea CHECK (
    idempotency_key_hash IS NULL OR octet_length(idempotency_key_hash) = 32
  ),
  request_fingerprint jsonb,
  completed_by text CHECK (
    completed_by IS NULL OR (completed_by <> '' AND char_length(completed_by) <= 200)
  ),
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  timeout_at timestamptz NOT NULL CONSTRAINT job_human_wait_timeout_finite
    CHECK (isfinite(timeout_at)),
  PRIMARY KEY (job_id, token_name),
  CHECK (
    (completed_at IS NULL AND result IS NULL AND idempotency_key_hash IS NULL
      AND request_fingerprint IS NULL AND completed_by IS NULL)
    OR
    (completed_at IS NOT NULL AND result IS NOT NULL AND idempotency_key_hash IS NOT NULL
      AND request_fingerprint IS NOT NULL AND completed_by IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS job_human_wait_actionable_idx
  ON workhorse.job_human_wait(created_at, job_id, token_name)
  WHERE completed_at IS NULL;

CREATE INDEX IF NOT EXISTS job_signal_wait_pending_idx
  ON workhorse.job_signal_wait(created_at, job_id, signal_name)
  WHERE delivered_at IS NULL;

CREATE OR REPLACE FUNCTION workhorse.wait_for_human_v1(
  p_job_id uuid,
  p_worker_id text,
  p_fence_token bigint,
  p_token_name text,
  p_context jsonb
) RETURNS TABLE (status text, result jsonb)
LANGUAGE plpgsql
AS $$
DECLARE
  v_runtime workhorse.job_runtime%ROWTYPE;
  v_wait workhorse.job_human_wait%ROWTYPE;
  v_now timestamptz;
  v_timeout_at timestamptz;
BEGIN
  IF p_token_name IS NULL OR p_token_name = '' OR char_length(p_token_name) > 200 THEN
    RAISE EXCEPTION 'token_name must contain between 1 and 200 characters';
  END IF;
  IF p_token_name <> btrim(p_token_name) THEN
    RAISE EXCEPTION 'token_name must not have leading or trailing whitespace';
  END IF;
  IF p_worker_id IS NULL OR p_worker_id = '' THEN
    RAISE EXCEPTION 'worker_id must not be empty';
  END IF;
  IF p_context IS NULL OR octet_length(p_context::text) > 65536 THEN
    RAISE EXCEPTION 'human wait context must be JSON and at most 65536 bytes';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(
    'workhorse:human-wait:' || p_job_id::text || ':' || p_token_name, 0
  ));
  SELECT * INTO v_runtime
    FROM workhorse.job_runtime runtime
   WHERE runtime.job_id = p_job_id
     AND runtime.state = 'active'
     AND runtime.worker_id = p_worker_id
     AND runtime.fence_token = p_fence_token
   FOR UPDATE;
  v_now := clock_timestamp();
  IF NOT FOUND OR v_runtime.expires_at <= v_now
     OR (v_runtime.deadline_at IS NOT NULL AND v_runtime.deadline_at <= v_now)
     OR (v_runtime.attempt_timeout_at IS NOT NULL AND v_runtime.attempt_timeout_at <= v_now)
     OR v_runtime.cancel_requested_at IS NOT NULL THEN
    RETURN QUERY VALUES ('stale'::text, NULL::jsonb);
    RETURN;
  END IF;
  v_timeout_at := LEAST(
    COALESCE(v_runtime.deadline_at, 'infinity'::timestamptz),
    v_now + interval '7 days'
  );

  SELECT * INTO v_wait
    FROM workhorse.job_human_wait stored
   WHERE stored.job_id = p_job_id AND stored.token_name = p_token_name;
  IF FOUND THEN
    IF v_wait.context IS DISTINCT FROM p_context THEN
      RETURN QUERY VALUES ('conflict'::text, NULL::jsonb);
      RETURN;
    END IF;
    IF v_wait.completed_at IS NULL THEN
      RETURN QUERY VALUES ('stale'::text, NULL::jsonb);
      RETURN;
    END IF;
    INSERT INTO workhorse.job_event(job_id, attempt, event_type, details)
      VALUES (
        p_job_id, v_runtime.current_attempt, 'human_wait_replayed',
        jsonb_build_object('name', p_token_name, 'completed_at', v_wait.completed_at)
      );
    RETURN QUERY VALUES ('completed'::text, v_wait.result);
    RETURN;
  END IF;

  IF (SELECT count(*) FROM workhorse.job_human_wait stored WHERE stored.job_id = p_job_id) >= 1000 THEN
    RETURN QUERY VALUES ('limit_exceeded'::text, NULL::jsonb);
    RETURN;
  END IF;

  INSERT INTO workhorse.job_human_wait(
    job_id, token_name, context, attempt, fence_token, worker_id, claimed_at, timeout_at
  ) VALUES (
    p_job_id, p_token_name, p_context, v_runtime.current_attempt, p_fence_token,
    p_worker_id, v_runtime.acquired_at, v_timeout_at
  );
  UPDATE workhorse.job_runtime runtime
     SET state = 'scheduled', run_at = '9999-12-31 00:00:00+00'::timestamptz,
         fence_token = 0, ready_at = NULL, sequence = NULL, worker_id = NULL,
         acquired_at = NULL, heartbeat_at = NULL, expires_at = NULL,
         wait_name = p_token_name,
         execution_used_ms = LEAST(
           31536000000,
           runtime.execution_used_ms + GREATEST(
             0, floor(extract(epoch FROM v_now - runtime.acquired_at) * 1000)::bigint
           )
         ),
         attempt_timeout_at = NULL, deadline_at = v_timeout_at,
         error = NULL, updated_at = clock_timestamp()
   WHERE runtime.job_id = p_job_id
     AND runtime.state = 'active'
     AND runtime.worker_id = p_worker_id
     AND runtime.fence_token = p_fence_token
     AND runtime.expires_at > clock_timestamp()
     AND (runtime.deadline_at IS NULL OR runtime.deadline_at > clock_timestamp())
     AND (runtime.attempt_timeout_at IS NULL OR runtime.attempt_timeout_at > clock_timestamp());
  IF NOT FOUND THEN
    DELETE FROM workhorse.job_human_wait stored
     WHERE stored.job_id = p_job_id AND stored.token_name = p_token_name;
    RETURN QUERY VALUES ('stale'::text, NULL::jsonb);
    RETURN;
  END IF;

  INSERT INTO workhorse.job_event(job_id, attempt, event_type, details)
    VALUES (
      p_job_id, v_runtime.current_attempt, 'human_wait_created',
      jsonb_build_object(
        'name', p_token_name, 'fence_token', p_fence_token::text,
        'context_bytes', octet_length(p_context::text)
      )
    );
  RETURN QUERY VALUES ('waiting'::text, NULL::jsonb);
END;
$$;

CREATE OR REPLACE FUNCTION workhorse.complete_human_wait_v1(
  p_job_id uuid,
  p_token_name text,
  p_result jsonb,
  p_idempotency_key text,
  p_completed_by text
) RETURNS TABLE (
  status text,
  result jsonb,
  completed_at timestamptz,
  completed_by text
)
LANGUAGE plpgsql
AS $$
DECLARE
  v_wait workhorse.job_human_wait%ROWTYPE;
  v_runtime workhorse.job_runtime%ROWTYPE;
  v_key_hash bytea;
  v_key_digest text;
  v_fingerprint jsonb;
  v_now timestamptz;
  v_reason text;
BEGIN
  IF p_token_name IS NULL OR p_token_name = '' OR char_length(p_token_name) > 200 THEN
    RAISE EXCEPTION 'token_name must contain between 1 and 200 characters';
  END IF;
  IF p_token_name <> btrim(p_token_name) THEN
    RAISE EXCEPTION 'token_name must not have leading or trailing whitespace';
  END IF;
  IF p_result IS NULL OR octet_length(p_result::text) > 65536 THEN
    RAISE EXCEPTION 'human wait result must be JSON and at most 65536 bytes';
  END IF;
  IF p_idempotency_key IS NULL OR octet_length(p_idempotency_key) NOT BETWEEN 1 AND 512 THEN
    RAISE EXCEPTION 'human wait idempotency key must contain between 1 and 512 UTF-8 bytes';
  END IF;
  IF p_completed_by IS NULL OR p_completed_by = '' OR char_length(p_completed_by) > 200 THEN
    RAISE EXCEPTION 'human wait completed_by must contain between 1 and 200 characters';
  END IF;

  v_key_hash := workhorse.idempotency_key_hash_v1(
    'human-wait:' || p_job_id::text || ':' || p_token_name, p_idempotency_key
  );
  v_key_digest := left(encode(v_key_hash, 'hex'), 12);
  v_fingerprint := jsonb_build_object('result', p_result, 'completedBy', p_completed_by);
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'workhorse:human-wait:' || p_job_id::text || ':' || p_token_name, 0
  ));

  IF NOT EXISTS (SELECT 1 FROM workhorse.job WHERE id = p_job_id) THEN
    RETURN QUERY VALUES ('not_found'::text, NULL::jsonb, NULL::timestamptz, NULL::text);
    RETURN;
  END IF;
  SELECT * INTO v_wait
    FROM workhorse.job_human_wait stored
   WHERE stored.job_id = p_job_id AND stored.token_name = p_token_name
   FOR UPDATE;
  IF NOT FOUND THEN
    INSERT INTO workhorse.job_event(job_id, event_type, details)
      VALUES (
        p_job_id, 'human_wait_rejected',
        jsonb_build_object(
          'name', p_token_name, 'reason', 'not_waiting', 'completed_by', p_completed_by,
          'idempotency_key_digest', v_key_digest
        )
      );
    RETURN QUERY VALUES ('not_waiting'::text, NULL::jsonb, NULL::timestamptz, NULL::text);
    RETURN;
  END IF;

  IF v_wait.completed_at IS NOT NULL THEN
    IF v_wait.idempotency_key_hash = v_key_hash THEN
      IF v_wait.request_fingerprint IS DISTINCT FROM v_fingerprint THEN
        v_reason := 'idempotency_conflict';
        status := 'conflict';
      ELSE
        RETURN QUERY VALUES (
          'duplicate'::text, v_wait.result, v_wait.completed_at, v_wait.completed_by
        );
        RETURN;
      END IF;
    ELSE
      v_reason := 'already_completed';
      status := 'already_completed';
    END IF;
    INSERT INTO workhorse.job_event(job_id, attempt, event_type, details)
      VALUES (
        p_job_id, v_wait.attempt, 'human_wait_rejected',
        jsonb_build_object(
          'name', p_token_name, 'reason', v_reason, 'completed_by', p_completed_by,
          'idempotency_key_digest', v_key_digest
        )
      );
    RETURN QUERY VALUES (status, v_wait.result, v_wait.completed_at, v_wait.completed_by);
    RETURN;
  END IF;

  SELECT * INTO v_runtime
    FROM workhorse.job_runtime runtime
   WHERE runtime.job_id = p_job_id
     AND runtime.state = 'scheduled'
     AND runtime.wait_name = p_token_name
     AND runtime.current_attempt = v_wait.attempt
   FOR UPDATE;
  v_now := clock_timestamp();
  IF NOT FOUND OR (v_runtime.deadline_at IS NOT NULL AND v_runtime.deadline_at <= v_now) THEN
    INSERT INTO workhorse.job_event(job_id, attempt, event_type, details)
      VALUES (
        p_job_id, v_wait.attempt, 'human_wait_rejected',
        jsonb_build_object(
          'name', p_token_name, 'reason', 'stale', 'completed_by', p_completed_by,
          'idempotency_key_digest', v_key_digest
        )
      );
    RETURN QUERY VALUES ('stale'::text, NULL::jsonb, NULL::timestamptz, NULL::text);
    RETURN;
  END IF;

  UPDATE workhorse.job_human_wait stored
     SET result = p_result, idempotency_key_hash = v_key_hash,
         request_fingerprint = v_fingerprint, completed_by = p_completed_by, completed_at = v_now
   WHERE stored.job_id = p_job_id AND stored.token_name = p_token_name
   RETURNING * INTO v_wait;
  UPDATE workhorse.job_runtime runtime
     SET state = 'ready', run_at = v_now, ready_at = v_now,
         sequence = nextval('workhorse.ready_sequence_seq'), wait_name = NULL,
         deadline_at = (SELECT job.deadline_at FROM workhorse.job job WHERE job.id = p_job_id),
         updated_at = v_now
   WHERE runtime.job_id = p_job_id;
  INSERT INTO workhorse.job_event(job_id, attempt, event_type, details)
    VALUES (
      p_job_id, v_wait.attempt, 'human_wait_completed',
      jsonb_build_object(
        'name', p_token_name, 'completed_by', p_completed_by,
        'idempotency_key_digest', v_key_digest, 'result_bytes', octet_length(p_result::text)
      )
    );
  PERFORM pg_notify('workhorse_jobs', v_runtime.queue_name);
  RETURN QUERY VALUES ('completed'::text, v_wait.result, v_wait.completed_at, v_wait.completed_by);
END;
$$;

CREATE OR REPLACE VIEW workhorse.dashboard_human_wait_v1 AS
  SELECT wait.job_id, job.queue_name, job.job_type, wait.token_name, wait.context,
         wait.attempt, wait.created_at, wait.completed_at, wait.completed_by,
         runtime.deadline_at
    FROM workhorse.job_human_wait wait
    JOIN workhorse.job job ON job.id = wait.job_id
    JOIN workhorse.job_runtime runtime
      ON runtime.job_id = wait.job_id
     AND runtime.state = 'scheduled'
     AND runtime.wait_name = wait.token_name
     AND runtime.current_attempt = wait.attempt
   WHERE wait.completed_at IS NULL;

-- Human waits are defined after the core lifecycle functions in the clean-install layout. Replace
-- those functions now that all suspension provenance tables exist.
CREATE OR REPLACE FUNCTION workhorse.terminalize_deadline_v1(p_job_id uuid)
RETURNS boolean
LANGUAGE plpgsql
AS $$
DECLARE
  v_runtime workhorse.job_runtime%ROWTYPE;
  v_error jsonb;
  v_worker_id text;
  v_fence_token bigint := 0;
  v_claimed_at timestamptz;
BEGIN
  SELECT * INTO v_runtime FROM workhorse.job_runtime runtime
   WHERE runtime.job_id = p_job_id FOR UPDATE;
  IF NOT FOUND OR v_runtime.deadline_at IS NULL
     OR v_runtime.deadline_at > clock_timestamp() THEN RETURN false; END IF;
  IF v_runtime.cancel_requested_at IS NOT NULL THEN
    v_error := workhorse.cancellation_envelope_v1(
      v_runtime.cancel_requested_at, v_runtime.cancel_requested_by, v_runtime.cancel_reason
    );
    DELETE FROM workhorse.job_runtime runtime WHERE runtime.job_id = p_job_id;
    INSERT INTO workhorse.job_outcome(
      job_id, state, current_attempt, fence_token, run_at, error
    ) VALUES (
      p_job_id, 'canceled', v_runtime.current_attempt, v_runtime.fence_token,
      v_runtime.run_at, v_error
    );
    INSERT INTO workhorse.attempt_history(
      job_id, attempt, fence_token, worker_id, outcome, started_at, claimed_at, error
    ) VALUES (
      p_job_id, v_runtime.current_attempt, v_runtime.fence_token, v_runtime.worker_id,
      'canceled', v_runtime.attempt_started_at, v_runtime.acquired_at, v_error
    );
    INSERT INTO workhorse.job_event(job_id, attempt, event_type, details)
      VALUES (
        p_job_id, v_runtime.current_attempt, 'canceled',
        jsonb_build_object(
          'requested_at', v_runtime.cancel_requested_at,
          'requested_by', v_runtime.cancel_requested_by,
          'reason', v_runtime.cancel_reason,
          'fence_token', v_runtime.fence_token::text,
          'source', 'deadline_reaper'
        )
      );
    RETURN true;
  END IF;
  v_error := workhorse.deadline_envelope_v1(v_runtime.deadline_at);
  IF v_runtime.state = 'active' THEN
    v_worker_id := v_runtime.worker_id;
    v_fence_token := v_runtime.fence_token;
    v_claimed_at := v_runtime.acquired_at;
  ELSIF v_runtime.attempt_started_at IS NOT NULL THEN
    SELECT provenance.worker_id, provenance.fence_token, provenance.claimed_at
      INTO STRICT v_worker_id, v_fence_token, v_claimed_at
      FROM (
        SELECT wait_row.worker_id, wait_row.fence_token, wait_row.claimed_at,
               wait_row.created_at, wait_row.wait_name AS name
          FROM workhorse.job_wait wait_row
         WHERE wait_row.job_id = p_job_id AND wait_row.attempt = v_runtime.current_attempt
        UNION ALL
        SELECT signal.worker_id, signal.fence_token, signal.claimed_at,
               signal.created_at, signal.signal_name AS name
          FROM workhorse.job_signal_wait signal
         WHERE signal.job_id = p_job_id AND signal.attempt = v_runtime.current_attempt
        UNION ALL
        SELECT human_wait.worker_id, human_wait.fence_token, human_wait.claimed_at,
               human_wait.created_at, human_wait.token_name AS name
          FROM workhorse.job_human_wait human_wait
         WHERE human_wait.job_id = p_job_id
           AND human_wait.attempt = v_runtime.current_attempt
      ) provenance
     ORDER BY provenance.created_at DESC, provenance.name DESC LIMIT 1;
  END IF;
  DELETE FROM workhorse.job_runtime runtime WHERE runtime.job_id = p_job_id;
  INSERT INTO workhorse.job_outcome(
    job_id, state, current_attempt, fence_token, run_at, error
  ) VALUES (
    p_job_id, 'failed', v_runtime.current_attempt, v_fence_token, v_runtime.run_at, v_error
  );
  IF v_runtime.attempt_started_at IS NOT NULL THEN
    INSERT INTO workhorse.attempt_history(
      job_id, attempt, fence_token, worker_id, outcome, started_at, claimed_at, error
    ) VALUES (
      p_job_id, v_runtime.current_attempt, v_fence_token, v_worker_id,
      'deadline_exceeded', v_runtime.attempt_started_at, v_claimed_at, v_error
    );
  END IF;
  INSERT INTO workhorse.job_event(job_id, attempt, event_type, details)
    VALUES (
      p_job_id,
      CASE WHEN v_runtime.attempt_started_at IS NULL THEN NULL ELSE v_runtime.current_attempt END,
      'deadline_exceeded',
      jsonb_build_object(
        'deadline_at', v_runtime.deadline_at,
        'fence_token', v_fence_token::text,
        'started', v_runtime.attempt_started_at IS NOT NULL
      )
    );
  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION workhorse.cancel_v1(
  p_job_id uuid, p_requested_by text DEFAULT NULL, p_reason text DEFAULT NULL
) RETURNS TABLE (
  status text, state text, current_attempt integer, requested_at timestamptz,
  requested_by text, reason text, finished_at timestamptz
)
LANGUAGE plpgsql
AS $$
DECLARE
  v_runtime workhorse.job_runtime%ROWTYPE;
  v_outcome workhorse.job_outcome%ROWTYPE;
  v_now timestamptz := clock_timestamp();
  v_fence_token bigint := 0;
  v_worker_id text;
  v_claimed_at timestamptz;
  v_attempt integer;
  v_envelope jsonb;
BEGIN
  IF p_job_id IS NULL THEN RAISE EXCEPTION 'job_id is required'; END IF;
  IF p_requested_by IS NOT NULL
     AND (p_requested_by = '' OR char_length(p_requested_by) > 200) THEN
    RAISE EXCEPTION 'requested_by must contain between 1 and 200 characters';
  END IF;
  IF p_reason IS NOT NULL AND (p_reason = '' OR char_length(p_reason) > 2000) THEN
    RAISE EXCEPTION 'reason must contain between 1 and 2000 characters';
  END IF;

  SELECT * INTO v_runtime
    FROM workhorse.job_runtime runtime
   WHERE runtime.job_id = p_job_id
   FOR UPDATE;
  IF FOUND THEN
    IF v_runtime.state = 'active' THEN
      IF v_runtime.cancel_requested_at IS NULL THEN
        UPDATE workhorse.job_runtime runtime
           SET cancel_requested_at = v_now,
               cancel_requested_by = p_requested_by,
               cancel_reason = p_reason,
               updated_at = v_now
         WHERE runtime.job_id = p_job_id AND runtime.state = 'active'
           AND runtime.cancel_requested_at IS NULL
        RETURNING * INTO v_runtime;
        IF FOUND THEN
          INSERT INTO workhorse.job_event(job_id, attempt, event_type, details)
            VALUES (
              p_job_id,
              v_runtime.current_attempt,
              'cancel_requested',
              jsonb_build_object(
                'requested_at', v_now,
                'requested_by', p_requested_by,
                'reason', p_reason,
                'fence_token', v_runtime.fence_token::text
              )
            );
        END IF;
      END IF;
      RETURN QUERY VALUES (
        'cancel_requested'::text,
        'active'::text,
        v_runtime.current_attempt,
        v_runtime.cancel_requested_at,
        v_runtime.cancel_requested_by,
        v_runtime.cancel_reason,
        NULL::timestamptz
      );
      RETURN;
    END IF;

    -- A suspended logical attempt retains its original worker/fence attribution in its timer or
    -- signal or human boundary even though scheduled runtime ownership has been released.
    IF v_runtime.attempt_started_at IS NOT NULL THEN
      SELECT provenance.fence_token, provenance.worker_id, provenance.attempt,
             provenance.claimed_at
        INTO v_fence_token, v_worker_id, v_attempt, v_claimed_at
        FROM (
          SELECT wait_row.fence_token, wait_row.worker_id, wait_row.attempt,
                 wait_row.claimed_at, wait_row.created_at, wait_row.wait_name AS name
            FROM workhorse.job_wait wait_row
           WHERE wait_row.job_id = p_job_id AND wait_row.attempt = v_runtime.current_attempt
          UNION ALL
          SELECT signal.fence_token, signal.worker_id, signal.attempt,
                 signal.claimed_at, signal.created_at, signal.signal_name AS name
            FROM workhorse.job_signal_wait signal
           WHERE signal.job_id = p_job_id AND signal.attempt = v_runtime.current_attempt
          UNION ALL
          SELECT human_wait.fence_token, human_wait.worker_id, human_wait.attempt,
                 human_wait.claimed_at, human_wait.created_at, human_wait.token_name AS name
            FROM workhorse.job_human_wait human_wait
           WHERE human_wait.job_id = p_job_id
             AND human_wait.attempt = v_runtime.current_attempt
        ) provenance
       ORDER BY provenance.created_at DESC, provenance.name DESC
       LIMIT 1;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'started job % has no retained suspension attribution', p_job_id;
      END IF;
    END IF;
    v_envelope := workhorse.cancellation_envelope_v1(v_now, p_requested_by, p_reason);
    DELETE FROM workhorse.job_runtime runtime WHERE runtime.job_id = p_job_id;
    INSERT INTO workhorse.job_outcome(
      job_id, state, current_attempt, fence_token, run_at, error, finished_at, updated_at
    ) VALUES (
      p_job_id, 'canceled', v_runtime.current_attempt, v_fence_token, v_runtime.run_at,
      v_envelope, v_now, v_now
    ) RETURNING * INTO v_outcome;
    IF v_runtime.attempt_started_at IS NOT NULL THEN
      INSERT INTO workhorse.attempt_history(
        job_id, attempt, fence_token, worker_id, outcome, started_at, claimed_at, error
      ) VALUES (
        p_job_id, v_attempt, v_fence_token, v_worker_id, 'canceled',
        v_runtime.attempt_started_at, v_claimed_at, v_envelope
      );
    END IF;
    INSERT INTO workhorse.job_event(job_id, attempt, event_type, details)
      VALUES (
        p_job_id,
        CASE WHEN v_runtime.attempt_started_at IS NULL THEN NULL ELSE v_attempt END,
        'canceled',
        jsonb_build_object(
          'requested_at', v_now,
          'requested_by', p_requested_by,
          'reason', p_reason,
          'fence_token', v_fence_token::text,
          'source', 'immediate'
        )
      );
    RETURN QUERY VALUES (
      'canceled'::text, 'canceled'::text, v_runtime.current_attempt,
      v_now, p_requested_by, p_reason, v_outcome.finished_at
    );
    RETURN;
  END IF;

  SELECT * INTO v_outcome FROM workhorse.job_outcome outcome WHERE outcome.job_id = p_job_id;
  IF FOUND THEN
    IF v_outcome.state = 'canceled' THEN
      RETURN QUERY VALUES (
        'canceled'::text,
        v_outcome.state,
        v_outcome.current_attempt,
        NULLIF(v_outcome.error->>'requested_at', '')::timestamptz,
        v_outcome.error->>'requested_by',
        v_outcome.error->>'reason',
        v_outcome.finished_at
      );
    ELSE
      RETURN QUERY VALUES (
        'already_terminal'::text, v_outcome.state, v_outcome.current_attempt,
        NULL::timestamptz, NULL::text, NULL::text, v_outcome.finished_at
      );
    END IF;
    RETURN;
  END IF;

  RETURN QUERY VALUES (
    'not_found'::text, NULL::text, NULL::integer, NULL::timestamptz,
    NULL::text, NULL::text, NULL::timestamptz
  );
END;
$$;


-- Stable, versioned relations owned by core for dashboard reads. PostgreSQL stores each view's
-- expanded target list, so later private-table changes can preserve this contract in one migration.
CREATE OR REPLACE VIEW workhorse.dashboard_attempt_history_v1 AS
  SELECT attempt_id, job_id, attempt, fence_token, worker_id, outcome, started_at, claimed_at,
         finished_at, error, occurred_at FROM workhorse.attempt_history;
CREATE OR REPLACE VIEW workhorse.dashboard_concurrency_policy_v1 AS
  SELECT queue_name FROM workhorse.concurrency_policy;
CREATE OR REPLACE VIEW workhorse.dashboard_job_checkpoint_v1 AS
  SELECT job_id, checkpoint_name, checkpoint_value, attempt, fence_token, worker_id, created_at
    FROM workhorse.job_checkpoint;
CREATE OR REPLACE VIEW workhorse.dashboard_job_dependency_v1 AS
  SELECT dependent_job_id, prerequisite_job_id, on_success, on_failure, on_cancellation,
         created_at, released_at, resolution
    FROM workhorse.job_dependency;
CREATE OR REPLACE VIEW workhorse.dashboard_job_child_v1 AS
  SELECT parent_job_id, child_job_id, child_name, created_at, joined_at
    FROM workhorse.job_child;
CREATE OR REPLACE VIEW workhorse.dashboard_job_redrive_v1 AS
  SELECT source_job_id, target_job_id, request_id_preview, request_id_digest, request_id_length,
         requested_by, reason, source_state, target_initial_state, requested_at
    FROM workhorse.job_redrive;
CREATE OR REPLACE VIEW workhorse.dashboard_job_event_v1 AS
  SELECT event_id, job_id, attempt, event_type, details, occurred_at FROM workhorse.job_event;
CREATE OR REPLACE VIEW workhorse.dashboard_job_outcome_v1 AS
  SELECT job_id, state, current_attempt, run_at, result, error, finished_at, updated_at
    FROM workhorse.job_outcome;
CREATE OR REPLACE VIEW workhorse.dashboard_job_progress_v1 AS
  SELECT job_id, progress_value, revision, attempt, fence_token, worker_id, created_at, updated_at
    FROM workhorse.job_progress;
CREATE OR REPLACE VIEW workhorse.dashboard_job_runtime_v1 AS
  SELECT job_id, queue_name, state, current_attempt, fence_token, run_at, ready_at, worker_id,
         acquired_at, heartbeat_at, expires_at, attempt_timeout_at, wait_name, attempt_started_at,
         cancel_requested_at, cancel_requested_by, cancel_reason, error, updated_at
    FROM workhorse.job_runtime;
CREATE OR REPLACE VIEW workhorse.dashboard_job_v1 AS
  SELECT id, queue_name, job_type, concurrency_key, payload, payload_redact_keys,
         result_redact_keys, tags, max_attempts, retry_policy, deadline_at, execution_timeout_ms,
         created_at, priority FROM workhorse.job;
CREATE OR REPLACE VIEW workhorse.dashboard_job_wait_v1 AS
  SELECT job_id, wait_name, mode, duration_ms, requested_wake_at, wake_at, attempt, fence_token,
         worker_id, created_at FROM workhorse.job_wait;
CREATE OR REPLACE VIEW workhorse.dashboard_maintenance_policy_v1 AS
  SELECT singleton, timezone, partition_preparation_interval_ms, terminal_cleanup_interval_ms,
         history_retention_local_time, updated_at FROM workhorse.maintenance_policy;
CREATE OR REPLACE VIEW workhorse.dashboard_maintenance_state_v1 AS
  SELECT task_name, last_started_at, last_completed_at, last_completed_local_date
    FROM workhorse.maintenance_state;
CREATE OR REPLACE VIEW workhorse.dashboard_queue_control_v1 AS
  SELECT queue_name, paused FROM workhorse.queue_control;
CREATE OR REPLACE VIEW workhorse.dashboard_rate_limit_policy_v1 AS
  SELECT queue_name FROM workhorse.rate_limit_policy;
CREATE OR REPLACE VIEW workhorse.dashboard_retention_policy_v1 AS
  SELECT singleton, job_event_retention_days, attempt_history_retention_days
    FROM workhorse.retention_policy;
CREATE OR REPLACE VIEW workhorse.dashboard_schedule_definition_v1 AS
  SELECT namespace, schedule_name, cron_expression, queue_name, job_type, enabled, revision,
         updated_at, priority FROM workhorse.schedule_definition;
CREATE OR REPLACE VIEW workhorse.dashboard_schedule_occurrence_v1 AS
  SELECT namespace, schedule_name, occurrence_at, fired_at FROM workhorse.schedule_occurrence;
CREATE OR REPLACE VIEW workhorse.dashboard_worker_registry_v1 AS
  SELECT worker_id, hostname, pid, queue_name, concurrency, lease_ms, heartbeat_ms, poll_ms,
         maintenance_interval_ms, maintenance_task_poll_ms, registry_interval_ms, active_slots,
         draining, paused, started_at, last_heartbeat_at FROM workhorse.worker_registry;

CREATE OR REPLACE FUNCTION workhorse.dashboard_job_estimate_v1()
RETURNS TABLE (estimate bigint)
LANGUAGE sql
STABLE
PARALLEL SAFE
AS $$
  SELECT reltuples::bigint FROM pg_class WHERE oid = 'workhorse.job'::regclass;
$$;

INSERT INTO workhorse.schema_migration(version, description) VALUES
  (23, 'forward migration baseline'),
  (24, 'add schema migration ledger'),
  (25, 'make schedule occurrence replay a no-op'),
  (26, 'add versioned dashboard read surface'),
  (27, 'add strict-priority job dispatch'),
  (28, 'add keyed debounce enqueue'),
  (29, 'add keyed throttle enqueue'),
  (30, 'add one-prerequisite job dependencies'),
  (31, 'add fan-in dependency policies'),
  (32, 'index dependency failure operations'),
  (33, 'add single linked child jobs'),
  (34, 'add bounded child fan-out and joins'),
  (35, 'preserve child lineage through lifecycle changes'),
  (36, 'add idempotent signals to waiting executions'),
  (37, 'add completable human wait tokens'),
  (38, 'harden signal and human wait lifecycles'),
  (39, 'fix dependency release event reasons'),
  (40, 'bound dependency fan-out and index dependency health')
ON CONFLICT DO NOTHING;
INSERT INTO workhorse.schema_version(version) VALUES (40) ON CONFLICT DO NOTHING;
SELECT workhorse.create_history_day_v1(
         ((clock_timestamp() AT TIME ZONE 'UTC')::date + day_offset)::date
       )
  FROM generate_series(0, 3) AS days(day_offset);

COMMIT;
