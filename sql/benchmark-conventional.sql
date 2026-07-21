BEGIN;

CREATE SCHEMA IF NOT EXISTS ironshift_benchmark_conventional;

-- Benchmark-only mutable-table queue baseline. This intentionally does not touch the production
-- ironshift schema. The dispatch path scans and mutates one lifetime table so benchmark scenarios can
-- compare the conventional design against Ironshift's split-projection protocol.
CREATE SEQUENCE IF NOT EXISTS ironshift_benchmark_conventional.fence_token_seq;

CREATE TABLE IF NOT EXISTS ironshift_benchmark_conventional.job (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  queue_name text NOT NULL CHECK (queue_name <> ''),
  job_type text NOT NULL CHECK (job_type <> ''),
  payload jsonb NOT NULL,
  state text NOT NULL CHECK (state IN ('scheduled', 'ready', 'active', 'succeeded', 'failed')),
  current_attempt integer NOT NULL DEFAULT 0 CHECK (current_attempt >= 0),
  max_attempts integer NOT NULL CHECK (max_attempts BETWEEN 1 AND 100),
  fence_token bigint NOT NULL DEFAULT 0 CHECK (fence_token >= 0),
  worker_id text,
  run_at timestamptz NOT NULL,
  started_at timestamptz,
  heartbeat_at timestamptz,
  lease_expires_at timestamptz,
  finished_at timestamptz,
  result jsonb,
  error jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((state = 'active') = (worker_id IS NOT NULL AND lease_expires_at IS NOT NULL))
) WITH (fillfactor = 70);

CREATE INDEX IF NOT EXISTS conventional_job_claim_idx
  ON ironshift_benchmark_conventional.job (queue_name, created_at, id)
  WHERE state = 'ready';
CREATE INDEX IF NOT EXISTS conventional_job_scheduled_idx
  ON ironshift_benchmark_conventional.job (run_at, id)
  WHERE state = 'scheduled';
CREATE INDEX IF NOT EXISTS conventional_job_expired_lease_idx
  ON ironshift_benchmark_conventional.job (lease_expires_at, id)
  WHERE state = 'active';

CREATE TABLE IF NOT EXISTS ironshift_benchmark_conventional.job_event (
  event_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  job_id uuid NOT NULL,
  attempt integer,
  event_type text NOT NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS conventional_job_event_job_time_idx
  ON ironshift_benchmark_conventional.job_event (job_id, occurred_at, event_id);

CREATE TABLE IF NOT EXISTS ironshift_benchmark_conventional.attempt_history (
  attempt_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  job_id uuid NOT NULL,
  attempt integer NOT NULL CHECK (attempt >= 1),
  fence_token bigint NOT NULL,
  worker_id text NOT NULL CHECK (worker_id <> ''),
  outcome text NOT NULL CHECK (outcome IN ('succeeded', 'failed', 'retry', 'lease_expired')),
  started_at timestamptz NOT NULL,
  finished_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  error jsonb,
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS conventional_attempt_history_job_idx
  ON ironshift_benchmark_conventional.attempt_history (job_id, attempt, occurred_at);

CREATE OR REPLACE FUNCTION ironshift_benchmark_conventional.reset_v1()
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  TRUNCATE ironshift_benchmark_conventional.attempt_history,
           ironshift_benchmark_conventional.job_event,
           ironshift_benchmark_conventional.job
    RESTART IDENTITY;
  ALTER SEQUENCE ironshift_benchmark_conventional.fence_token_seq RESTART WITH 1;
END;
$$;

CREATE OR REPLACE FUNCTION ironshift_benchmark_conventional.enqueue_v1(
  p_queue_name text,
  p_job_type text,
  p_payload jsonb,
  p_run_at timestamptz DEFAULT clock_timestamp(),
  p_max_attempts integer DEFAULT 3
) RETURNS uuid
LANGUAGE plpgsql
AS $$
DECLARE
  v_job_id uuid;
  v_now timestamptz := clock_timestamp();
  v_state text;
BEGIN
  IF p_queue_name IS NULL OR p_queue_name = '' THEN
    RAISE EXCEPTION 'queue_name must not be empty';
  END IF;
  IF p_job_type IS NULL OR p_job_type = '' THEN
    RAISE EXCEPTION 'job_type must not be empty';
  END IF;
  IF p_max_attempts NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'max_attempts must be between 1 and 100';
  END IF;

  v_state := CASE WHEN p_run_at <= v_now THEN 'ready' ELSE 'scheduled' END;
  INSERT INTO ironshift_benchmark_conventional.job(
    queue_name, job_type, payload, state, max_attempts, run_at
  ) VALUES (
    p_queue_name, p_job_type, COALESCE(p_payload, 'null'::jsonb), v_state, p_max_attempts, p_run_at
  ) RETURNING id INTO v_job_id;

  INSERT INTO ironshift_benchmark_conventional.job_event(job_id, event_type, details)
    VALUES (v_job_id, 'enqueued', jsonb_build_object('state', v_state, 'run_at', p_run_at));
  RETURN v_job_id;
END;
$$;

CREATE OR REPLACE FUNCTION ironshift_benchmark_conventional.promote_v1(p_limit integer DEFAULT 100)
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  v_count integer;
BEGIN
  WITH due AS (
    SELECT id
      FROM ironshift_benchmark_conventional.job
     WHERE state = 'scheduled' AND run_at <= clock_timestamp()
     ORDER BY run_at, id
     FOR UPDATE SKIP LOCKED
     LIMIT GREATEST(1, LEAST(p_limit, 10000))
  ), updated AS (
    UPDATE ironshift_benchmark_conventional.job j
       SET state = 'ready', updated_at = clock_timestamp()
      FROM due
     WHERE j.id = due.id
     RETURNING j.id
  ), events AS (
    INSERT INTO ironshift_benchmark_conventional.job_event(job_id, event_type)
      SELECT id, 'promoted' FROM updated
    RETURNING 1
  )
  SELECT count(*)::integer INTO v_count FROM events;
  RETURN v_count;
END;
$$;

CREATE OR REPLACE FUNCTION ironshift_benchmark_conventional.claim_v1(
  p_queue_name text,
  p_worker_id text,
  p_lease_ms integer DEFAULT 30000
) RETURNS TABLE (
  job_id uuid,
  job_type text,
  payload jsonb,
  attempt integer,
  max_attempts integer,
  fence_token bigint,
  lease_expires_at timestamptz
)
LANGUAGE plpgsql
AS $$
DECLARE
  v_job ironshift_benchmark_conventional.job%ROWTYPE;
  v_fence bigint;
  v_expires timestamptz;
BEGIN
  IF p_worker_id IS NULL OR p_worker_id = '' THEN
    RAISE EXCEPTION 'worker_id must not be empty';
  END IF;
  IF p_lease_ms NOT BETWEEN 100 AND 86400000 THEN
    RAISE EXCEPTION 'lease_ms must be between 100 and 86400000';
  END IF;

  SELECT * INTO v_job
    FROM ironshift_benchmark_conventional.job
   WHERE queue_name = p_queue_name AND state = 'ready'
   ORDER BY created_at, id
   FOR UPDATE SKIP LOCKED
   LIMIT 1;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  v_fence := nextval('ironshift_benchmark_conventional.fence_token_seq');
  v_expires := clock_timestamp() + make_interval(secs => p_lease_ms::double precision / 1000.0);

  UPDATE ironshift_benchmark_conventional.job j
     SET state = 'active', current_attempt = v_job.current_attempt + 1, fence_token = v_fence,
         worker_id = p_worker_id, started_at = clock_timestamp(), heartbeat_at = clock_timestamp(),
         lease_expires_at = v_expires, finished_at = NULL, result = NULL, error = NULL,
         updated_at = clock_timestamp()
   WHERE j.id = v_job.id;

  INSERT INTO ironshift_benchmark_conventional.job_event(job_id, attempt, event_type, details)
    VALUES (v_job.id, v_job.current_attempt + 1, 'claimed',
      jsonb_build_object('worker_id', p_worker_id, 'fence_token', v_fence, 'expires_at', v_expires));

  RETURN QUERY
    SELECT v_job.id, v_job.job_type, v_job.payload, v_job.current_attempt + 1,
           v_job.max_attempts, v_fence, v_expires;
END;
$$;

CREATE OR REPLACE FUNCTION ironshift_benchmark_conventional.heartbeat_v1(
  p_job_id uuid,
  p_worker_id text,
  p_fence_token bigint,
  p_lease_ms integer DEFAULT 30000
) RETURNS boolean
LANGUAGE plpgsql
AS $$
DECLARE
  v_updated integer;
BEGIN
  UPDATE ironshift_benchmark_conventional.job
     SET heartbeat_at = clock_timestamp(),
         lease_expires_at = clock_timestamp() + make_interval(secs => p_lease_ms::double precision / 1000.0),
         updated_at = clock_timestamp()
   WHERE id = p_job_id
     AND state = 'active'
     AND worker_id = p_worker_id
     AND fence_token = p_fence_token
     AND lease_expires_at > clock_timestamp();
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated = 1;
END;
$$;

CREATE OR REPLACE FUNCTION ironshift_benchmark_conventional.complete_v1(
  p_job_id uuid,
  p_worker_id text,
  p_fence_token bigint,
  p_result jsonb DEFAULT '{}'::jsonb
) RETURNS boolean
LANGUAGE plpgsql
AS $$
DECLARE
  v_job ironshift_benchmark_conventional.job%ROWTYPE;
BEGIN
  SELECT * INTO v_job
    FROM ironshift_benchmark_conventional.job
   WHERE id = p_job_id
     AND state = 'active'
     AND worker_id = p_worker_id
     AND fence_token = p_fence_token
     AND lease_expires_at > clock_timestamp()
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN false;
  END IF;

  UPDATE ironshift_benchmark_conventional.job
     SET state = 'succeeded', worker_id = NULL, lease_expires_at = NULL,
         finished_at = clock_timestamp(), result = COALESCE(p_result, 'null'::jsonb),
         updated_at = clock_timestamp()
   WHERE id = p_job_id;
  INSERT INTO ironshift_benchmark_conventional.attempt_history(
    job_id, attempt, fence_token, worker_id, outcome, started_at
  ) VALUES (v_job.id, v_job.current_attempt, v_job.fence_token, v_job.worker_id, 'succeeded', v_job.started_at);
  INSERT INTO ironshift_benchmark_conventional.job_event(job_id, attempt, event_type, details)
    VALUES (v_job.id, v_job.current_attempt, 'completed', jsonb_build_object('fence_token', v_job.fence_token));
  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION ironshift_benchmark_conventional.fail_v1(
  p_job_id uuid,
  p_worker_id text,
  p_fence_token bigint,
  p_error jsonb DEFAULT '{}'::jsonb,
  p_retry_delay_ms integer DEFAULT 0
) RETURNS text
LANGUAGE plpgsql
AS $$
DECLARE
  v_job ironshift_benchmark_conventional.job%ROWTYPE;
  v_next_state text;
  v_next_run_at timestamptz;
  v_outcome text;
BEGIN
  SELECT * INTO v_job
    FROM ironshift_benchmark_conventional.job
   WHERE id = p_job_id
     AND state = 'active'
     AND worker_id = p_worker_id
     AND fence_token = p_fence_token
     AND lease_expires_at > clock_timestamp()
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN 'stale';
  END IF;

  IF v_job.current_attempt < v_job.max_attempts THEN
    v_next_state := CASE WHEN p_retry_delay_ms <= 0 THEN 'ready' ELSE 'scheduled' END;
    v_next_run_at := clock_timestamp() + make_interval(secs => GREATEST(p_retry_delay_ms, 0)::double precision / 1000.0);
    v_outcome := 'retry';
  ELSE
    v_next_state := 'failed';
    v_next_run_at := v_job.run_at;
    v_outcome := 'failed';
  END IF;

  UPDATE ironshift_benchmark_conventional.job
     SET state = v_next_state, worker_id = NULL, lease_expires_at = NULL,
         run_at = v_next_run_at, finished_at = CASE WHEN v_next_state = 'failed' THEN clock_timestamp() ELSE NULL END,
         error = COALESCE(p_error, '{}'::jsonb), updated_at = clock_timestamp()
   WHERE id = p_job_id;
  INSERT INTO ironshift_benchmark_conventional.attempt_history(
    job_id, attempt, fence_token, worker_id, outcome, started_at, error
  ) VALUES (v_job.id, v_job.current_attempt, v_job.fence_token, v_job.worker_id, v_outcome, v_job.started_at, p_error);
  INSERT INTO ironshift_benchmark_conventional.job_event(job_id, attempt, event_type, details)
    VALUES (v_job.id, v_job.current_attempt, 'failed',
      jsonb_build_object('state', v_next_state, 'retry_delay_ms', p_retry_delay_ms, 'fence_token', v_job.fence_token));
  RETURN v_next_state;
END;
$$;

CREATE OR REPLACE FUNCTION ironshift_benchmark_conventional.recover_expired_v1(
  p_limit integer DEFAULT 100,
  p_retry_delay_ms integer DEFAULT 0
) RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  v_count integer;
BEGIN
  WITH expired AS (
    SELECT *
      FROM ironshift_benchmark_conventional.job
     WHERE state = 'active' AND lease_expires_at <= clock_timestamp()
     ORDER BY lease_expires_at, id
     FOR UPDATE SKIP LOCKED
     LIMIT GREATEST(1, LEAST(p_limit, 10000))
  ), history AS (
    INSERT INTO ironshift_benchmark_conventional.attempt_history(
      job_id, attempt, fence_token, worker_id, outcome, started_at, error
    )
      SELECT id, current_attempt, fence_token, worker_id, 'lease_expired', started_at,
             jsonb_build_object('lease_expires_at', lease_expires_at)
        FROM expired
    RETURNING job_id
  ), updated AS (
    UPDATE ironshift_benchmark_conventional.job j
       SET state = CASE
             WHEN j.current_attempt < j.max_attempts AND p_retry_delay_ms <= 0 THEN 'ready'
             WHEN j.current_attempt < j.max_attempts THEN 'scheduled'
             ELSE 'failed'
           END,
           worker_id = NULL,
           lease_expires_at = NULL,
           run_at = CASE
             WHEN j.current_attempt < j.max_attempts THEN clock_timestamp() + make_interval(secs => GREATEST(p_retry_delay_ms, 0)::double precision / 1000.0)
             ELSE j.run_at
           END,
           finished_at = CASE WHEN j.current_attempt >= j.max_attempts THEN clock_timestamp() ELSE NULL END,
           error = jsonb_build_object('lease_expired', true),
           updated_at = clock_timestamp()
      FROM expired e
     WHERE j.id = e.id
     RETURNING j.id, j.current_attempt, j.state
  ), events AS (
    INSERT INTO ironshift_benchmark_conventional.job_event(job_id, attempt, event_type, details)
      SELECT id, current_attempt, 'lease_expired', jsonb_build_object('state', state) FROM updated
    RETURNING 1
  )
  SELECT count(*)::integer INTO v_count FROM events;
  RETURN v_count;
END;
$$;

COMMIT;
