BEGIN;

CREATE SCHEMA IF NOT EXISTS workhorse;

-- Canonical clean-install schema. This is not an incremental production migration.
CREATE TABLE IF NOT EXISTS workhorse.schema_version (
  version integer PRIMARY KEY,
  installed_at timestamptz NOT NULL DEFAULT clock_timestamp()
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

-- Sparse per-queue operational control. The dispatch path remains a cheap anti-join when no queue
-- has been explicitly managed.
CREATE TABLE IF NOT EXISTS workhorse.queue_control (
  queue_name text PRIMARY KEY CHECK (queue_name <> ''),
  paused boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

-- Immutable accepted-job identity and payload.
CREATE TABLE IF NOT EXISTS workhorse.job (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  queue_name text NOT NULL CHECK (queue_name <> ''),
  job_type text NOT NULL CHECK (job_type <> ''),
  payload jsonb NOT NULL,
  tags text[] NOT NULL DEFAULT '{}'
    CONSTRAINT job_tags_valid CHECK (workhorse.valid_tags(tags)),
  max_attempts integer NOT NULL CHECK (max_attempts BETWEEN 1 AND 100),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE workhorse.job ADD COLUMN IF NOT EXISTS tags text[] NOT NULL DEFAULT '{}';
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'workhorse.job'::regclass AND conname = 'job_tags_valid'
  ) THEN
    ALTER TABLE workhorse.job
      ADD CONSTRAINT job_tags_valid CHECK (workhorse.valid_tags(tags));
  END IF;
END;
$$;
-- GIN indexes array elements so overlap and containment tag filters avoid scanning every job row.
CREATE INDEX IF NOT EXISTS job_tags_gin_idx ON workhorse.job USING gin (tags);

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

-- Monotonic ownership generations and FIFO placement generations.
CREATE SEQUENCE IF NOT EXISTS workhorse.fence_token_seq;
CREATE SEQUENCE IF NOT EXISTS workhorse.ready_sequence_seq;

-- The sole mutable row for a nonterminal job. State-specific columns are constrained so a runtime
-- cannot simultaneously represent ready, scheduled, and active ownership.
CREATE TABLE IF NOT EXISTS workhorse.job_runtime (
  job_id uuid PRIMARY KEY REFERENCES workhorse.job(id) ON DELETE CASCADE,
  queue_name text NOT NULL CHECK (queue_name <> ''),
  state text NOT NULL CHECK (state IN ('scheduled', 'ready', 'active')),
  current_attempt integer NOT NULL DEFAULT 1 CHECK (current_attempt BETWEEN 1 AND 100),
  fence_token bigint NOT NULL DEFAULT 0 CHECK (fence_token >= 0),
  run_at timestamptz NOT NULL,
  ready_at timestamptz,
  sequence bigint,
  worker_id text,
  acquired_at timestamptz,
  heartbeat_at timestamptz,
  expires_at timestamptz,
  error jsonb,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (
    (state = 'scheduled' AND ready_at IS NULL AND sequence IS NULL AND worker_id IS NULL
      AND acquired_at IS NULL AND heartbeat_at IS NULL AND expires_at IS NULL)
    OR
    (state = 'ready' AND ready_at IS NOT NULL AND sequence IS NOT NULL AND worker_id IS NULL
      AND acquired_at IS NULL AND heartbeat_at IS NULL AND expires_at IS NULL)
    OR
    (state = 'active' AND ready_at IS NULL AND sequence IS NULL AND worker_id IS NOT NULL
      AND acquired_at IS NOT NULL AND heartbeat_at IS NOT NULL AND expires_at IS NOT NULL
      AND fence_token > 0)
  )
) WITH (fillfactor = 70);
CREATE INDEX IF NOT EXISTS job_runtime_ready_idx
  ON workhorse.job_runtime (queue_name, sequence, job_id) WHERE state = 'ready';
CREATE INDEX IF NOT EXISTS job_runtime_scheduled_idx
  ON workhorse.job_runtime (run_at, job_id) WHERE state = 'scheduled';
CREATE INDEX IF NOT EXISTS job_runtime_expired_active_idx
  ON workhorse.job_runtime (expires_at, job_id) WHERE state = 'active';

-- Immutable terminal materialization. Moving here removes completed work from every dispatch index.
CREATE TABLE IF NOT EXISTS workhorse.job_outcome (
  job_id uuid PRIMARY KEY REFERENCES workhorse.job(id) ON DELETE CASCADE,
  state text NOT NULL CHECK (state IN ('succeeded', 'failed')),
  current_attempt integer NOT NULL CHECK (current_attempt >= 1),
  fence_token bigint NOT NULL CHECK (fence_token > 0),
  run_at timestamptz NOT NULL,
  result jsonb,
  error jsonb,
  finished_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((state = 'succeeded' AND error IS NULL) OR state = 'failed')
);

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

-- One immutable row for every closed attempt.
CREATE TABLE IF NOT EXISTS workhorse.attempt_history (
  attempt_id bigint GENERATED ALWAYS AS IDENTITY,
  job_id uuid NOT NULL,
  attempt integer NOT NULL,
  fence_token bigint NOT NULL,
  worker_id text NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('succeeded', 'failed', 'retry', 'lease_expired')),
  started_at timestamptz NOT NULL,
  finished_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  error jsonb,
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp()
) PARTITION BY RANGE (occurred_at);
CREATE TABLE IF NOT EXISTS workhorse.attempt_history_default
  PARTITION OF workhorse.attempt_history DEFAULT;
CREATE INDEX IF NOT EXISTS attempt_history_job_idx
  ON workhorse.attempt_history (job_id, attempt, occurred_at);

-- Declarative schedules are synchronized from application code and evaluated by worker processes.
-- Payloads, occurrence ownership, and queue semantics remain owned by the Workhorse protocol.
CREATE TABLE IF NOT EXISTS workhorse.schedule_definition (
  namespace text NOT NULL CHECK (namespace <> ''),
  schedule_name text NOT NULL CHECK (schedule_name <> ''),
  cron_expression text NOT NULL CHECK (cron_expression <> ''),
  queue_name text NOT NULL CHECK (queue_name <> ''),
  job_type text NOT NULL CHECK (job_type <> ''),
  payload jsonb NOT NULL,
  max_attempts integer NOT NULL CHECK (max_attempts BETWEEN 1 AND 100),
  enabled boolean NOT NULL DEFAULT true,
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
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
  ) THEN
    RAISE EXCEPTION 'each schedule requires non-empty name/schedule/queue/type and maxAttempts between 1 and 100';
  END IF;
  IF (
    SELECT count(*) FROM jsonb_array_elements(p_definitions)
  ) <> (
    SELECT count(DISTINCT definition->>'name') FROM jsonb_array_elements(p_definitions) definition
  ) THEN
    RAISE EXCEPTION 'schedule names must be unique within a namespace';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('workhorse:schedules:' || p_namespace, 0));

  INSERT INTO workhorse.schedule_definition AS existing(
    namespace, schedule_name, cron_expression, queue_name, job_type, payload, max_attempts, enabled
  )
  SELECT p_namespace, definition->>'name', definition->>'schedule', definition->>'queue',
         definition->>'type', COALESCE(definition->'payload', 'null'::jsonb),
         COALESCE((definition->>'maxAttempts')::integer, 25),
         COALESCE((definition->>'enabled')::boolean, true)
    FROM jsonb_array_elements(p_definitions) definition
  ON CONFLICT (namespace, schedule_name) DO UPDATE
    SET revision = existing.revision + CASE WHEN ROW(
          existing.cron_expression, existing.queue_name, existing.job_type, existing.payload,
          existing.max_attempts, existing.enabled
        ) IS DISTINCT FROM ROW(
          EXCLUDED.cron_expression, EXCLUDED.queue_name, EXCLUDED.job_type, EXCLUDED.payload,
          EXCLUDED.max_attempts, EXCLUDED.enabled
        ) THEN 1 ELSE 0 END,
        cron_expression = EXCLUDED.cron_expression,
        queue_name = EXCLUDED.queue_name,
        job_type = EXCLUDED.job_type,
        payload = EXCLUDED.payload,
        max_attempts = EXCLUDED.max_attempts,
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

DROP FUNCTION IF EXISTS workhorse.fire_schedule_v1(text, text, timestamptz);
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
    SELECT occurrence.job_id INTO v_job_id
      FROM workhorse.schedule_occurrence occurrence
     WHERE occurrence.namespace = p_namespace
       AND occurrence.schedule_name = p_schedule_name
       AND occurrence.occurrence_at = date_trunc('second', p_occurrence_at);
    RETURN v_job_id;
  END IF;

  v_job_id := workhorse.enqueue_v1(
    v_definition.queue_name,
    v_definition.job_type,
    v_definition.payload,
    clock_timestamp(),
    v_definition.max_attempts
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
  IF p_limit NOT BETWEEN 1 AND 100000 THEN
    RAISE EXCEPTION 'occurrence prune limit must be between 1 and 100000';
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

-- Accept up to 1,000 jobs atomically. One timestamp classifies the whole batch, ordinality preserves
-- returned IDs and ready FIFO, and notifications are coalesced by ready queue.
CREATE OR REPLACE FUNCTION workhorse.enqueue_many_v1(p_requests jsonb)
RETURNS TABLE (ordinal integer, job_id uuid)
LANGUAGE plpgsql
AS $$
DECLARE
  v_count integer;
  v_now timestamptz := clock_timestamp();
BEGIN
  IF p_requests IS NULL OR jsonb_typeof(p_requests) <> 'array' THEN
    RAISE EXCEPTION 'requests must be a JSON array';
  END IF;
  v_count := jsonb_array_length(p_requests);
  IF v_count > 1000 THEN
    RAISE EXCEPTION 'enqueue batch exceeds maximum size of 1000';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_requests) request
    WHERE COALESCE(request->>'queue', '') = ''
       OR COALESCE(request->>'type', '') = ''
       OR COALESCE((request->>'maxAttempts')::integer, 25) NOT BETWEEN 1 AND 100
       OR request->>'runAt' IS NULL
       OR jsonb_typeof(COALESCE(request->'tags', '[]'::jsonb)) <> 'array'
       OR jsonb_array_length(COALESCE(request->'tags', '[]'::jsonb)) > 20
       OR EXISTS (
         SELECT 1
           FROM jsonb_array_elements(COALESCE(request->'tags', '[]'::jsonb)) tag
          WHERE jsonb_typeof(tag) <> 'string'
             OR tag #>> '{}' = ''
             OR char_length(tag #>> '{}') > 100
       )
  ) THEN
    RAISE EXCEPTION 'each request requires non-empty queue/type/runAt, maxAttempts between 1 and 100, and at most 20 non-empty tags of at most 100 characters';
  END IF;

  RETURN QUERY
  WITH parsed AS MATERIALIZED (
    SELECT ordinality::integer AS ordinal,
           gen_random_uuid() AS job_id,
           request->>'queue' AS queue_name,
           request->>'type' AS job_type,
           COALESCE(request->'payload', 'null'::jsonb) AS payload,
           ARRAY(SELECT jsonb_array_elements_text(COALESCE(request->'tags', '[]'::jsonb))) AS tags,
           (request->>'runAt')::timestamptz AS run_at,
           COALESCE((request->>'maxAttempts')::integer, 25) AS max_attempts,
           CASE WHEN (request->>'runAt')::timestamptz <= v_now THEN 'ready' ELSE 'scheduled' END AS state
      FROM jsonb_array_elements(p_requests) WITH ORDINALITY input(request, ordinality)
  ), inserted_jobs AS (
    INSERT INTO workhorse.job(id, queue_name, job_type, payload, tags, max_attempts)
      SELECT p.job_id, p.queue_name, p.job_type, p.payload, p.tags, p.max_attempts
        FROM parsed p ORDER BY p.ordinal
    RETURNING id
  ), inserted_runtime AS (
    INSERT INTO workhorse.job_runtime AS runtime(job_id, queue_name, state, current_attempt, run_at,
      ready_at, sequence)
      SELECT p.job_id, p.queue_name, p.state, 1, p.run_at,
             CASE WHEN p.state = 'ready' THEN v_now END,
             CASE WHEN p.state = 'ready' THEN nextval('workhorse.ready_sequence_seq') END
        FROM parsed p JOIN inserted_jobs j ON j.id = p.job_id ORDER BY p.ordinal
    RETURNING runtime.job_id, runtime.queue_name, runtime.state
  ), inserted_events AS (
    INSERT INTO workhorse.job_event AS event(job_id, event_type, details)
      SELECT p.job_id, 'enqueued', jsonb_build_object('state', p.state, 'run_at', p.run_at)
        FROM parsed p JOIN inserted_runtime r ON r.job_id = p.job_id ORDER BY p.ordinal
    RETURNING event.job_id
  ), notifications AS MATERIALIZED (
    SELECT pg_notify('workhorse_jobs', queue_name)
      FROM (SELECT DISTINCT queue_name FROM inserted_runtime WHERE state = 'ready') ready_queues
  )
  SELECT p.ordinal, p.job_id FROM parsed p
   WHERE (SELECT count(*) FROM inserted_events) >= 0
     AND (SELECT count(*) FROM notifications) >= 0
   ORDER BY p.ordinal;
END;
$$;

DROP FUNCTION IF EXISTS workhorse.enqueue_v1(text, text, jsonb, timestamptz, integer);
CREATE OR REPLACE FUNCTION workhorse.enqueue_v1(
  p_queue_name text,
  p_job_type text,
  p_payload jsonb,
  p_run_at timestamptz DEFAULT clock_timestamp(),
  p_max_attempts integer DEFAULT 25,
  p_tags text[] DEFAULT '{}'
) RETURNS uuid
LANGUAGE sql
AS $$
  SELECT job_id FROM workhorse.enqueue_many_v1(jsonb_build_array(jsonb_build_object(
    'queue', p_queue_name, 'type', p_job_type, 'payload', COALESCE(p_payload, 'null'::jsonb),
    'runAt', p_run_at, 'maxAttempts', p_max_attempts, 'tags', to_jsonb(COALESCE(p_tags, '{}'))
  ))) ORDER BY ordinal LIMIT 1;
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
  WITH purgeable AS (
    SELECT r.job_id
      FROM workhorse.job_runtime r
     WHERE r.queue_name = p_queue_name AND r.state IN ('ready', 'scheduled')
     FOR UPDATE OF r
  ), deleted AS (
    DELETE FROM workhorse.job j
     USING purgeable p
     WHERE j.id = p.job_id
     RETURNING j.id
  )
  SELECT count(*)::integer INTO v_count FROM deleted;
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
    SELECT r.job_id FROM workhorse.job_runtime r
     WHERE r.state = 'scheduled' AND r.run_at <= clock_timestamp()
     ORDER BY r.run_at, r.job_id FOR UPDATE SKIP LOCKED
     LIMIT GREATEST(1, LEAST(p_limit, 10000))
  ), promoted AS (
    UPDATE workhorse.job_runtime r
       SET state = 'ready', ready_at = clock_timestamp(),
           sequence = nextval('workhorse.ready_sequence_seq'), updated_at = clock_timestamp()
      FROM due d WHERE r.job_id = d.job_id AND r.state = 'scheduled'
    RETURNING r.job_id, r.queue_name
  ), events AS (
    INSERT INTO workhorse.job_event(job_id, event_type)
      SELECT job_id, 'promoted' FROM promoted RETURNING 1
  )
  SELECT count(*)::integer INTO v_count FROM events;
  IF v_count > 0 THEN PERFORM pg_notify('workhorse_jobs', '*'); END IF;
  RETURN v_count;
END;
$$;

CREATE OR REPLACE FUNCTION workhorse.claim_v1(
  p_queue_name text,
  p_worker_id text,
  p_lease_ms integer DEFAULT 30000
) RETURNS TABLE (
  job_id uuid, job_type text, payload jsonb, attempt integer, max_attempts integer,
  fence_token bigint, lease_expires_at timestamptz
)
LANGUAGE plpgsql
AS $$
DECLARE
  v_runtime workhorse.job_runtime%ROWTYPE;
  v_fence bigint;
  v_now timestamptz;
  v_expires timestamptz;
BEGIN
  IF p_worker_id IS NULL OR p_worker_id = '' THEN RAISE EXCEPTION 'worker_id must not be empty'; END IF;
  IF p_lease_ms NOT BETWEEN 100 AND 86400000 THEN
    RAISE EXCEPTION 'lease_ms must be between 100 and 86400000';
  END IF;
  v_fence := nextval('workhorse.fence_token_seq');
  v_now := clock_timestamp();
  v_expires := v_now + make_interval(secs => p_lease_ms::double precision / 1000.0);

  WITH candidate AS (
    SELECT r.job_id FROM workhorse.job_runtime r
     WHERE r.state = 'ready' AND r.queue_name = p_queue_name
       AND NOT EXISTS (
         SELECT 1 FROM workhorse.queue_control control
          WHERE control.queue_name = p_queue_name AND control.paused
       )
     ORDER BY r.sequence, r.job_id FOR UPDATE SKIP LOCKED LIMIT 1
  )
  UPDATE workhorse.job_runtime r
     SET state = 'active', fence_token = v_fence, worker_id = p_worker_id,
         acquired_at = v_now, heartbeat_at = v_now, expires_at = v_expires,
         ready_at = NULL, sequence = NULL, error = NULL, updated_at = v_now
    FROM candidate c WHERE r.job_id = c.job_id AND r.state = 'ready'
  RETURNING r.* INTO v_runtime;
  IF NOT FOUND THEN RETURN; END IF;

  INSERT INTO workhorse.job_event(job_id, attempt, event_type, details)
    VALUES (v_runtime.job_id, v_runtime.current_attempt, 'claimed',
      jsonb_build_object('worker_id', p_worker_id, 'fence_token', v_fence, 'expires_at', v_expires));
  RETURN QUERY
    SELECT j.id, j.job_type, j.payload, v_runtime.current_attempt, j.max_attempts, v_fence, v_expires
      FROM workhorse.job j WHERE j.id = v_runtime.job_id;
END;
$$;

CREATE OR REPLACE FUNCTION workhorse.heartbeat_v1(
  p_job_id uuid, p_worker_id text, p_fence_token bigint, p_lease_ms integer DEFAULT 30000
) RETURNS boolean
LANGUAGE plpgsql
AS $$
DECLARE v_updated integer;
BEGIN
  UPDATE workhorse.job_runtime r
     SET heartbeat_at = clock_timestamp(),
         expires_at = clock_timestamp() + make_interval(secs => p_lease_ms::double precision / 1000.0),
         updated_at = clock_timestamp()
   WHERE r.job_id = p_job_id AND r.state = 'active' AND r.worker_id = p_worker_id
     AND r.fence_token = p_fence_token AND r.expires_at > clock_timestamp();
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated = 1;
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
  IF NOT FOUND OR v_runtime.expires_at <= clock_timestamp() THEN
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
      jsonb_build_object('name', p_checkpoint_name, 'fence_token', p_fence_token)
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

CREATE OR REPLACE FUNCTION workhorse.complete_v1(
  p_job_id uuid, p_worker_id text, p_fence_token bigint, p_result jsonb DEFAULT 'null'::jsonb
) RETURNS boolean
LANGUAGE plpgsql
AS $$
DECLARE v_runtime workhorse.job_runtime%ROWTYPE;
BEGIN
  DELETE FROM workhorse.job_runtime r
   WHERE r.job_id = p_job_id AND r.state = 'active' AND r.worker_id = p_worker_id
     AND r.fence_token = p_fence_token AND r.expires_at > clock_timestamp()
  RETURNING * INTO v_runtime;
  IF NOT FOUND THEN RETURN false; END IF;

  INSERT INTO workhorse.job_outcome(job_id, state, current_attempt, fence_token, run_at, result)
    VALUES (p_job_id, 'succeeded', v_runtime.current_attempt, p_fence_token, v_runtime.run_at, p_result);
  INSERT INTO workhorse.attempt_history(job_id, attempt, fence_token, worker_id, outcome, started_at)
    VALUES (p_job_id, v_runtime.current_attempt, p_fence_token, p_worker_id, 'succeeded', v_runtime.acquired_at);
  INSERT INTO workhorse.job_event(job_id, attempt, event_type, details)
    VALUES (p_job_id, v_runtime.current_attempt, 'succeeded', jsonb_build_object('fence_token', p_fence_token));
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
  v_retry_count integer;
  v_retry_delay_seconds double precision;
BEGIN
  SELECT * INTO v_runtime FROM workhorse.job_runtime r
   WHERE r.job_id = p_job_id AND r.state = 'active' AND r.worker_id = p_worker_id
     AND r.fence_token = p_fence_token AND r.expires_at > clock_timestamp()
   FOR UPDATE;
  IF NOT FOUND THEN RETURN 'stale'; END IF;
  SELECT * INTO STRICT v_job FROM workhorse.job j WHERE j.id = p_job_id;

  IF v_runtime.current_attempt < v_job.max_attempts THEN
    v_started_at := v_runtime.acquired_at;
    IF p_retry_delay_ms IS NULL THEN
      -- Sidekiq-inspired retry count is zero-based: the first failed attempt has count 0.
      v_retry_count := v_runtime.current_attempt - 1;
      v_retry_delay_seconds := power(v_retry_count::double precision, 4) + 15
        + floor(random() * 10) * (v_retry_count + 1);
    ELSE
      v_retry_delay_seconds := GREATEST(0, p_retry_delay_ms)::double precision / 1000.0;
    END IF;
    v_run_at := clock_timestamp() + make_interval(secs => v_retry_delay_seconds);
    v_state := CASE WHEN v_retry_delay_seconds <= 0 THEN 'ready' ELSE 'scheduled' END;
    UPDATE workhorse.job_runtime r
       SET state = v_state, current_attempt = r.current_attempt + 1, fence_token = 0,
           run_at = v_run_at,
           ready_at = CASE WHEN v_state = 'ready' THEN clock_timestamp() END,
           sequence = CASE WHEN v_state = 'ready' THEN nextval('workhorse.ready_sequence_seq') END,
           worker_id = NULL, acquired_at = NULL, heartbeat_at = NULL, expires_at = NULL,
           error = p_error, updated_at = clock_timestamp()
     WHERE r.job_id = p_job_id AND r.state = 'active' AND r.worker_id = p_worker_id
       AND r.fence_token = p_fence_token AND r.expires_at > clock_timestamp()
    RETURNING * INTO v_runtime;
    IF NOT FOUND THEN RETURN 'stale'; END IF;
    IF v_state = 'ready' THEN PERFORM pg_notify('workhorse_jobs', v_job.queue_name); END IF;
    INSERT INTO workhorse.attempt_history(job_id, attempt, fence_token, worker_id, outcome, started_at, error)
      VALUES (p_job_id, v_runtime.current_attempt - 1, p_fence_token, p_worker_id, 'retry',
        v_started_at, p_error);
    INSERT INTO workhorse.job_event(job_id, attempt, event_type, details)
      VALUES (p_job_id, v_runtime.current_attempt - 1, 'retry_scheduled',
        jsonb_build_object('next_attempt', v_runtime.current_attempt, 'run_at', v_run_at, 'error', p_error));
  ELSE
    DELETE FROM workhorse.job_runtime r
     WHERE r.job_id = p_job_id AND r.state = 'active' AND r.worker_id = p_worker_id
       AND r.fence_token = p_fence_token AND r.expires_at > clock_timestamp()
    RETURNING * INTO v_runtime;
    IF NOT FOUND THEN RETURN 'stale'; END IF;
    v_state := 'failed';
    INSERT INTO workhorse.job_outcome(job_id, state, current_attempt, fence_token, run_at, error)
      VALUES (p_job_id, 'failed', v_runtime.current_attempt, p_fence_token, v_runtime.run_at, p_error);
    INSERT INTO workhorse.attempt_history(job_id, attempt, fence_token, worker_id, outcome, started_at, error)
      VALUES (p_job_id, v_runtime.current_attempt, p_fence_token, p_worker_id, 'failed', v_runtime.acquired_at, p_error);
    INSERT INTO workhorse.job_event(job_id, attempt, event_type, details)
      VALUES (p_job_id, v_runtime.current_attempt, 'failed', jsonb_build_object('error', p_error));
  END IF;
  RETURN v_state;
END;
$$;

CREATE OR REPLACE FUNCTION workhorse.recover_expired_v1(
  p_limit integer DEFAULT 100, p_retry_delay_ms integer DEFAULT 0
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
BEGIN
  FOR v_runtime IN
    SELECT r.* FROM workhorse.job_runtime r
     WHERE r.state = 'active' AND r.expires_at <= clock_timestamp()
     ORDER BY r.expires_at, r.job_id FOR UPDATE SKIP LOCKED
     LIMIT GREATEST(1, LEAST(p_limit, 10000))
  LOOP
    SELECT * INTO STRICT v_job FROM workhorse.job j WHERE j.id = v_runtime.job_id;
    IF v_runtime.current_attempt < v_job.max_attempts THEN
      v_run_at := clock_timestamp() + make_interval(secs => GREATEST(0, p_retry_delay_ms)::double precision / 1000.0);
      v_state := CASE WHEN p_retry_delay_ms <= 0 THEN 'ready' ELSE 'scheduled' END;
      UPDATE workhorse.job_runtime r
         SET state = v_state, current_attempt = r.current_attempt + 1, fence_token = 0,
             run_at = v_run_at,
             ready_at = CASE WHEN v_state = 'ready' THEN clock_timestamp() END,
             sequence = CASE WHEN v_state = 'ready' THEN nextval('workhorse.ready_sequence_seq') END,
             worker_id = NULL, acquired_at = NULL, heartbeat_at = NULL, expires_at = NULL,
             error = v_error, updated_at = clock_timestamp()
       WHERE r.job_id = v_runtime.job_id AND r.state = 'active'
         AND r.fence_token = v_runtime.fence_token AND r.expires_at <= clock_timestamp();
      IF NOT FOUND THEN CONTINUE; END IF;
    ELSE
      v_state := 'failed';
      DELETE FROM workhorse.job_runtime r
       WHERE r.job_id = v_runtime.job_id AND r.state = 'active'
         AND r.fence_token = v_runtime.fence_token AND r.expires_at <= clock_timestamp();
      IF NOT FOUND THEN CONTINUE; END IF;
      INSERT INTO workhorse.job_outcome(job_id, state, current_attempt, fence_token, run_at, error)
        VALUES (v_runtime.job_id, 'failed', v_runtime.current_attempt, v_runtime.fence_token,
          v_runtime.run_at, v_error);
    END IF;
    INSERT INTO workhorse.attempt_history(job_id, attempt, fence_token, worker_id, outcome, started_at, error)
      VALUES (v_runtime.job_id, v_runtime.current_attempt, v_runtime.fence_token, v_runtime.worker_id,
        'lease_expired', v_runtime.acquired_at, v_error);
    INSERT INTO workhorse.job_event(job_id, attempt, event_type, details)
      VALUES (v_runtime.job_id, v_runtime.current_attempt, 'lease_expired',
        jsonb_build_object('fence_token', v_runtime.fence_token, 'next_state', v_state));
    v_count := v_count + 1;
  END LOOP;
  IF v_count > 0 THEN PERFORM pg_notify('workhorse_jobs', '*'); END IF;
  RETURN v_count;
END;
$$;

DROP FUNCTION IF EXISTS workhorse.maintain_v1(integer, integer, integer, integer);

CREATE OR REPLACE FUNCTION workhorse.tick_v1(
  p_promote_limit integer DEFAULT 1000, p_recover_limit integer DEFAULT 1000
) RETURNS TABLE (
  phase text, rows_affected integer, duration_ms integer, skipped_lock boolean, error jsonb
)
LANGUAGE plpgsql
AS $$
DECLARE
  v_started_at timestamptz;
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtextextended('workhorse:tick', 0)) THEN
    RETURN QUERY VALUES
      ('promote'::text, 0, 0, true, NULL::jsonb),
      ('recover'::text, 0, 0, true, NULL::jsonb);
    RETURN;
  END IF;

  phase := 'promote';
  rows_affected := 0;
  skipped_lock := false;
  error := NULL;
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
    rows_affected := workhorse.recover_expired_v1(p_recover_limit);
  EXCEPTION WHEN OTHERS THEN
    error := jsonb_build_object('code', SQLSTATE, 'message', SQLERRM);
  END;
  duration_ms := GREATEST(
    0, round(extract(epoch FROM clock_timestamp() - v_started_at) * 1000)::integer
  );
  RETURN NEXT;
END;
$$;

CREATE OR REPLACE FUNCTION workhorse.housekeep_v1(
  p_occurrence_retention_days integer DEFAULT 30,
  p_occurrence_prune_limit integer DEFAULT 10000
) RETURNS TABLE (
  phase text, rows_affected integer, duration_ms integer, skipped_lock boolean, error jsonb
)
LANGUAGE plpgsql
AS $$
DECLARE
  v_started_at timestamptz;
  v_week_offset integer;
  v_suffix text;
BEGIN
  IF p_occurrence_retention_days NOT BETWEEN 1 AND 3650 THEN
    RAISE EXCEPTION 'occurrence retention days must be between 1 and 3650';
  END IF;
  IF NOT pg_try_advisory_xact_lock(hashtextextended('workhorse:housekeeping', 0)) THEN
    RETURN QUERY VALUES
      ('history_partitions'::text, 0, 0, true, NULL::jsonb),
      ('schedule_occurrences'::text, 0, 0, true, NULL::jsonb);
    RETURN;
  END IF;

  phase := 'history_partitions';
  rows_affected := 0;
  skipped_lock := false;
  error := NULL;
  v_started_at := clock_timestamp();
  BEGIN
    FOR v_week_offset IN 0..4 LOOP
      v_suffix := to_char(
        date_trunc('week', current_date + make_interval(weeks => v_week_offset)), 'IYYY"w"IW'
      );
      IF to_regclass(format('workhorse.%I', 'job_event_' || v_suffix)) IS NULL
         OR to_regclass(format('workhorse.%I', 'attempt_history_' || v_suffix)) IS NULL THEN
        PERFORM workhorse.create_history_week_v1(
          (current_date + make_interval(weeks => v_week_offset))::date
        );
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
  RETURN NEXT;

  phase := 'schedule_occurrences';
  rows_affected := 0;
  error := NULL;
  v_started_at := clock_timestamp();
  BEGIN
    rows_affected := workhorse.prune_schedule_occurrences_v1(
      clock_timestamp() - make_interval(days => p_occurrence_retention_days),
      p_occurrence_prune_limit
    );
  EXCEPTION WHEN OTHERS THEN
    error := jsonb_build_object('code', SQLSTATE, 'message', SQLERRM);
  END;
  duration_ms := GREATEST(
    0, round(extract(epoch FROM clock_timestamp() - v_started_at) * 1000)::integer
  );
  RETURN NEXT;
END;
$$;

CREATE OR REPLACE FUNCTION workhorse.create_history_week_v1(p_week date)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  v_start date := date_trunc('week', p_week)::date;
  v_end date := (date_trunc('week', p_week) + interval '1 week')::date;
  v_suffix text := to_char(v_start, 'IYYY"w"IW');
  v_event_partition text := 'job_event_' || v_suffix;
  v_attempt_partition text := 'attempt_history_' || v_suffix;
  v_event_staging text := 'workhorse_job_event_' || v_suffix;
  v_attempt_staging text := 'workhorse_attempt_history_' || v_suffix;
  v_event_exists boolean;
  v_attempt_exists boolean;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('workhorse:history-week:' || v_start, 0));
  v_event_exists := to_regclass(format('workhorse.%I', v_event_partition)) IS NOT NULL;
  v_attempt_exists := to_regclass(format('workhorse.%I', v_attempt_partition)) IS NOT NULL;
  IF v_event_exists AND v_attempt_exists THEN RETURN; END IF;
  IF v_event_exists <> v_attempt_exists THEN
    RAISE EXCEPTION 'history week % is only partially partitioned', v_start;
  END IF;

  LOCK TABLE workhorse.job_event_default, workhorse.attempt_history_default IN ACCESS EXCLUSIVE MODE;
  EXECUTE format(
    'CREATE TEMP TABLE %I ON COMMIT DROP AS SELECT * FROM workhorse.job_event_default WHERE occurred_at >= %L AND occurred_at < %L',
    v_event_staging, v_start, v_end);
  EXECUTE format(
    'CREATE TEMP TABLE %I ON COMMIT DROP AS SELECT * FROM workhorse.attempt_history_default WHERE occurred_at >= %L AND occurred_at < %L',
    v_attempt_staging, v_start, v_end);
  DELETE FROM workhorse.job_event_default WHERE occurred_at >= v_start AND occurred_at < v_end;
  DELETE FROM workhorse.attempt_history_default WHERE occurred_at >= v_start AND occurred_at < v_end;

  EXECUTE format(
    'CREATE TABLE IF NOT EXISTS workhorse.%I PARTITION OF workhorse.job_event FOR VALUES FROM (%L) TO (%L)',
    v_event_partition, v_start, v_end);
  EXECUTE format(
    'CREATE TABLE IF NOT EXISTS workhorse.%I PARTITION OF workhorse.attempt_history FOR VALUES FROM (%L) TO (%L)',
    v_attempt_partition, v_start, v_end);
  EXECUTE format(
    'INSERT INTO workhorse.%I (event_id, job_id, attempt, event_type, details, occurred_at) OVERRIDING SYSTEM VALUE SELECT event_id, job_id, attempt, event_type, details, occurred_at FROM %I',
    v_event_partition, v_event_staging);
  EXECUTE format(
    'INSERT INTO workhorse.%I (attempt_id, job_id, attempt, fence_token, worker_id, outcome, started_at, finished_at, error, occurred_at) OVERRIDING SYSTEM VALUE SELECT attempt_id, job_id, attempt, fence_token, worker_id, outcome, started_at, finished_at, error, occurred_at FROM %I',
    v_attempt_partition, v_attempt_staging);
  EXECUTE format('DROP TABLE %I', v_event_staging);
  EXECUTE format('DROP TABLE %I', v_attempt_staging);
END;
$$;

CREATE OR REPLACE FUNCTION workhorse.retire_history_week_v1(p_week date)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  v_start date := date_trunc('week', p_week)::date;
  v_suffix text := to_char(v_start, 'IYYY"w"IW');
BEGIN
  IF v_start >= date_trunc('week', current_date)::date THEN
    RAISE EXCEPTION 'only completed history weeks can be retired';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('workhorse:history-week:' || v_start, 0));
  EXECUTE format('DROP TABLE IF EXISTS workhorse.%I', 'job_event_' || v_suffix);
  EXECUTE format('DROP TABLE IF EXISTS workhorse.%I', 'attempt_history_' || v_suffix);
END;
$$;

  INSERT INTO workhorse.schema_version(version) VALUES (6) ON CONFLICT DO NOTHING;
SELECT workhorse.create_history_week_v1((current_date + make_interval(weeks => week_offset))::date)
  FROM generate_series(0, 4) AS weeks(week_offset);

COMMIT;
