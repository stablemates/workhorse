BEGIN;

CREATE SCHEMA IF NOT EXISTS ironshift;

-- This file is the canonical schema for the validation phase. Development resets the entire test
-- database after schema changes, so this is not an incremental or production-safe migration.
CREATE TABLE IF NOT EXISTS ironshift.schema_version (
  version integer PRIMARY KEY,
  installed_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

-- Immutable accepted-job facts. Dispatch never scans this payload-bearing table.
CREATE TABLE IF NOT EXISTS ironshift.job (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  queue_name text NOT NULL CHECK (queue_name <> ''),
  job_type text NOT NULL CHECK (job_type <> ''),
  payload jsonb NOT NULL,
  max_attempts integer NOT NULL CHECK (max_attempts BETWEEN 1 AND 100),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

-- One operator-facing current-state row per retained job. The version column stores the active
-- fence token, but this table is intentionally absent from the claim path.
CREATE TABLE IF NOT EXISTS ironshift.job_current (
  job_id uuid PRIMARY KEY REFERENCES ironshift.job(id) ON DELETE CASCADE,
  state text NOT NULL CHECK (state IN ('scheduled', 'ready', 'active', 'succeeded', 'failed')),
  current_attempt integer NOT NULL DEFAULT 0 CHECK (current_attempt >= 0),
  version bigint NOT NULL DEFAULT 0 CHECK (version >= 0),
  run_at timestamptz NOT NULL,
  started_at timestamptz,
  finished_at timestamptz,
  result jsonb,
  error jsonb,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

-- Narrow runnable projection. Deleting on claim keeps this relation proportional to current ready
-- depth instead of lifetime completed work.
CREATE TABLE IF NOT EXISTS ironshift.ready_job (
  job_id uuid PRIMARY KEY REFERENCES ironshift.job(id) ON DELETE CASCADE,
  queue_name text NOT NULL,
  attempt integer NOT NULL CHECK (attempt >= 1),
  enqueued_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  sequence bigint GENERATED ALWAYS AS IDENTITY
);
CREATE INDEX IF NOT EXISTS ready_job_claim_idx
  ON ironshift.ready_job (queue_name, sequence, job_id);

-- Future work is physically separated so a large delayed backlog cannot precede runnable rows in
-- the ready claim index.
CREATE TABLE IF NOT EXISTS ironshift.scheduled_job (
  job_id uuid PRIMARY KEY REFERENCES ironshift.job(id) ON DELETE CASCADE,
  queue_name text NOT NULL,
  attempt integer NOT NULL CHECK (attempt >= 1),
  run_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS scheduled_job_due_idx
  ON ironshift.scheduled_job (run_at, job_id);

-- Fence tokens are globally monotonic ownership generations. Expiry handles abandonment; fencing
-- prevents an old worker from committing after recovery and reclamation.
CREATE SEQUENCE IF NOT EXISTS ironshift.fence_token_seq;
CREATE TABLE IF NOT EXISTS ironshift.lease (
  job_id uuid PRIMARY KEY REFERENCES ironshift.job(id) ON DELETE CASCADE,
  worker_id text NOT NULL CHECK (worker_id <> ''),
  attempt integer NOT NULL CHECK (attempt >= 1),
  fence_token bigint NOT NULL UNIQUE,
  acquired_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  heartbeat_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL
) WITH (fillfactor = 70);
CREATE INDEX IF NOT EXISTS lease_expiry_idx ON ironshift.lease (expires_at, job_id);

-- Append-only lifecycle audit. Time partitioning allows bulk history retirement without DELETE
-- churn on the dispatch relations.
CREATE TABLE IF NOT EXISTS ironshift.job_event (
  event_id bigint GENERATED ALWAYS AS IDENTITY,
  job_id uuid NOT NULL,
  attempt integer,
  event_type text NOT NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp()
) PARTITION BY RANGE (occurred_at);
CREATE TABLE IF NOT EXISTS ironshift.job_event_default
  PARTITION OF ironshift.job_event DEFAULT;
CREATE INDEX IF NOT EXISTS job_event_job_time_idx
  ON ironshift.job_event (job_id, occurred_at, event_id);

-- One immutable row for every closed attempt, including retries and lease expiry. A retry creates a
-- new attempt number rather than mutating this historical outcome.
CREATE TABLE IF NOT EXISTS ironshift.attempt_history (
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
CREATE TABLE IF NOT EXISTS ironshift.attempt_history_default
  PARTITION OF ironshift.attempt_history DEFAULT;
CREATE INDEX IF NOT EXISTS attempt_history_job_idx
  ON ironshift.attempt_history (job_id, attempt, occurred_at);

-- Accept a job atomically with its initial current state, dispatch projection, and audit event.
-- When called through an existing application transaction, enqueue commits or rolls back with it.
CREATE OR REPLACE FUNCTION ironshift.enqueue_v1(
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
  INSERT INTO ironshift.job(queue_name, job_type, payload, max_attempts)
    VALUES (p_queue_name, p_job_type, COALESCE(p_payload, 'null'::jsonb), p_max_attempts)
    RETURNING id INTO v_job_id;
  INSERT INTO ironshift.job_current(job_id, state, run_at)
    VALUES (v_job_id, v_state, p_run_at);
  IF v_state = 'ready' THEN
    INSERT INTO ironshift.ready_job(job_id, queue_name, attempt)
      VALUES (v_job_id, p_queue_name, 1);
    -- NOTIFY is delivered after commit and is only a wake hint. The ready row is the durable fact.
    PERFORM pg_notify('ironshift_jobs', p_queue_name);
  ELSE
    INSERT INTO ironshift.scheduled_job(job_id, queue_name, attempt, run_at)
      VALUES (v_job_id, p_queue_name, 1, p_run_at);
  END IF;
  INSERT INTO ironshift.job_event(job_id, event_type, details)
    VALUES (v_job_id, 'enqueued', jsonb_build_object('state', v_state, 'run_at', p_run_at));
  RETURN v_job_id;
END;
$$;

-- Move a bounded due batch from scheduled to ready. SKIP LOCKED lets many promoters cooperate
-- without moving one scheduled row twice or waiting behind another promoter's batch.
CREATE OR REPLACE FUNCTION ironshift.promote_v1(p_limit integer DEFAULT 100)
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  v_count integer;
BEGIN
  WITH due AS (
    SELECT s.job_id, s.queue_name, s.attempt
    FROM ironshift.scheduled_job s
    WHERE s.run_at <= clock_timestamp()
    ORDER BY s.run_at, s.job_id
    FOR UPDATE SKIP LOCKED
    LIMIT GREATEST(1, LEAST(p_limit, 10000))
  ), deleted AS (
    DELETE FROM ironshift.scheduled_job s
    USING due d
    WHERE s.job_id = d.job_id
    RETURNING d.job_id, d.queue_name, d.attempt
  ), inserted AS (
    INSERT INTO ironshift.ready_job(job_id, queue_name, attempt)
      SELECT job_id, queue_name, attempt FROM deleted
    RETURNING job_id, queue_name
  ), updated AS (
    UPDATE ironshift.job_current c
    SET state = 'ready', updated_at = clock_timestamp()
    FROM inserted i
    WHERE c.job_id = i.job_id
    RETURNING c.job_id, i.queue_name
  ), events AS (
    INSERT INTO ironshift.job_event(job_id, event_type)
      SELECT job_id, 'promoted' FROM updated
    RETURNING 1
  )
  SELECT count(*)::integer INTO v_count FROM events;
  IF v_count > 0 THEN
    PERFORM pg_notify('ironshift_jobs', '*');
  END IF;
  RETURN v_count;
END;
$$;

-- Claim exactly one FIFO row for a queue. Ownership, current projection, and the claim event commit
-- before the payload is returned, so handler execution never spans this transaction.
CREATE OR REPLACE FUNCTION ironshift.claim_v1(
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
  v_ready ironshift.ready_job%ROWTYPE;
  v_fence bigint;
  v_expires timestamptz;
BEGIN
  IF p_worker_id IS NULL OR p_worker_id = '' THEN
    RAISE EXCEPTION 'worker_id must not be empty';
  END IF;
  IF p_lease_ms NOT BETWEEN 100 AND 86400000 THEN
    RAISE EXCEPTION 'lease_ms must be between 100 and 86400000';
  END IF;

  -- Locked rows are skipped rather than waited on, allowing independent workers to make progress.
  SELECT r.* INTO v_ready
  FROM ironshift.ready_job r
  WHERE r.queue_name = p_queue_name
  ORDER BY r.sequence, r.job_id
  FOR UPDATE SKIP LOCKED
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  -- Removing the ready projection and inserting the lease happen in the same function transaction.
  DELETE FROM ironshift.ready_job r WHERE r.job_id = v_ready.job_id;
  v_fence := nextval('ironshift.fence_token_seq');
  v_expires := clock_timestamp() + make_interval(secs => p_lease_ms::double precision / 1000.0);

  INSERT INTO ironshift.lease(job_id, worker_id, attempt, fence_token, expires_at)
    VALUES (v_ready.job_id, p_worker_id, v_ready.attempt, v_fence, v_expires);
  UPDATE ironshift.job_current c
    SET state = 'active', current_attempt = v_ready.attempt, version = v_fence,
        started_at = clock_timestamp(), finished_at = NULL, result = NULL, error = NULL,
        updated_at = clock_timestamp()
    WHERE c.job_id = v_ready.job_id;
  INSERT INTO ironshift.job_event(job_id, attempt, event_type, details)
    VALUES (v_ready.job_id, v_ready.attempt, 'claimed',
      jsonb_build_object('worker_id', p_worker_id, 'fence_token', v_fence, 'expires_at', v_expires));

  RETURN QUERY
    SELECT j.id, j.job_type, j.payload, v_ready.attempt, j.max_attempts, v_fence, v_expires
    FROM ironshift.job j WHERE j.id = v_ready.job_id;
END;
$$;

-- Extend only the exact current, unexpired lease. False tells the runtime it no longer owns the job.
CREATE OR REPLACE FUNCTION ironshift.heartbeat_v1(
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
  UPDATE ironshift.lease l
  SET heartbeat_at = clock_timestamp(),
      expires_at = clock_timestamp() + make_interval(secs => p_lease_ms::double precision / 1000.0)
  WHERE l.job_id = p_job_id AND l.worker_id = p_worker_id
    AND l.fence_token = p_fence_token AND l.expires_at > clock_timestamp();
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated = 1;
END;
$$;

-- Finalize success only for the matching unexpired worker/fence pair. The current-projection check
-- is a second invariant guard; a mismatch raises and rolls back the consumed lease.
CREATE OR REPLACE FUNCTION ironshift.complete_v1(
  p_job_id uuid,
  p_worker_id text,
  p_fence_token bigint,
  p_result jsonb DEFAULT 'null'::jsonb
) RETURNS boolean
LANGUAGE plpgsql
AS $$
DECLARE
  v_lease ironshift.lease%ROWTYPE;
BEGIN
  DELETE FROM ironshift.lease l
  WHERE l.job_id = p_job_id AND l.worker_id = p_worker_id
    AND l.fence_token = p_fence_token AND l.expires_at > clock_timestamp()
  RETURNING * INTO v_lease;
  IF NOT FOUND THEN
    RETURN false;
  END IF;

  UPDATE ironshift.job_current c
  SET state = 'succeeded', result = p_result, error = NULL,
      finished_at = clock_timestamp(), updated_at = clock_timestamp()
  WHERE c.job_id = p_job_id AND c.version = p_fence_token;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'current state fence mismatch for job %', p_job_id;
  END IF;
  INSERT INTO ironshift.attempt_history(job_id, attempt, fence_token, worker_id, outcome, started_at)
    VALUES (p_job_id, v_lease.attempt, p_fence_token, p_worker_id, 'succeeded', v_lease.acquired_at);
  INSERT INTO ironshift.job_event(job_id, attempt, event_type, details)
    VALUES (p_job_id, v_lease.attempt, 'succeeded', jsonb_build_object('fence_token', p_fence_token));
  RETURN true;
END;
$$;

-- Close a failed attempt and either create the next attempt or enter terminal failure. Projection,
-- history, and lease changes are one transaction, so a fence mismatch rolls everything back.
CREATE OR REPLACE FUNCTION ironshift.fail_v1(
  p_job_id uuid,
  p_worker_id text,
  p_fence_token bigint,
  p_error jsonb,
  p_retry_delay_ms integer DEFAULT 0
) RETURNS text
LANGUAGE plpgsql
AS $$
DECLARE
  v_lease ironshift.lease%ROWTYPE;
  v_job ironshift.job%ROWTYPE;
  v_next_attempt integer;
  v_run_at timestamptz;
  v_state text;
BEGIN
  DELETE FROM ironshift.lease l
  WHERE l.job_id = p_job_id AND l.worker_id = p_worker_id
    AND l.fence_token = p_fence_token AND l.expires_at > clock_timestamp()
  RETURNING * INTO v_lease;
  IF NOT FOUND THEN
    RETURN 'stale';
  END IF;
  SELECT * INTO STRICT v_job FROM ironshift.job j WHERE j.id = p_job_id;

  IF v_lease.attempt < v_job.max_attempts THEN
    v_next_attempt := v_lease.attempt + 1;
    v_run_at := clock_timestamp() + make_interval(secs => GREATEST(0, p_retry_delay_ms)::double precision / 1000.0);
    v_state := CASE WHEN p_retry_delay_ms <= 0 THEN 'ready' ELSE 'scheduled' END;
    IF v_state = 'ready' THEN
      INSERT INTO ironshift.ready_job(job_id, queue_name, attempt)
        VALUES (p_job_id, v_job.queue_name, v_next_attempt);
      PERFORM pg_notify('ironshift_jobs', v_job.queue_name);
    ELSE
      INSERT INTO ironshift.scheduled_job(job_id, queue_name, attempt, run_at)
        VALUES (p_job_id, v_job.queue_name, v_next_attempt, v_run_at);
    END IF;
    UPDATE ironshift.job_current c
      SET state = v_state, run_at = v_run_at, error = p_error, updated_at = clock_timestamp()
      WHERE c.job_id = p_job_id AND c.version = p_fence_token;
    -- Do not commit a retry projection unless the lease token is still the current generation.
    IF NOT FOUND THEN
      RAISE EXCEPTION 'current state fence mismatch for job %', p_job_id;
    END IF;
    INSERT INTO ironshift.attempt_history(job_id, attempt, fence_token, worker_id, outcome, started_at, error)
      VALUES (p_job_id, v_lease.attempt, p_fence_token, p_worker_id, 'retry', v_lease.acquired_at, p_error);
    INSERT INTO ironshift.job_event(job_id, attempt, event_type, details)
      VALUES (p_job_id, v_lease.attempt, 'retry_scheduled',
        jsonb_build_object('next_attempt', v_next_attempt, 'run_at', v_run_at, 'error', p_error));
  ELSE
    v_state := 'failed';
    UPDATE ironshift.job_current c
      SET state = 'failed', error = p_error, finished_at = clock_timestamp(), updated_at = clock_timestamp()
      WHERE c.job_id = p_job_id AND c.version = p_fence_token;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'current state fence mismatch for job %', p_job_id;
    END IF;
    INSERT INTO ironshift.attempt_history(job_id, attempt, fence_token, worker_id, outcome, started_at, error)
      VALUES (p_job_id, v_lease.attempt, p_fence_token, p_worker_id, 'failed', v_lease.acquired_at, p_error);
    INSERT INTO ironshift.job_event(job_id, attempt, event_type, details)
      VALUES (p_job_id, v_lease.attempt, 'failed', jsonb_build_object('error', p_error));
  END IF;
  RETURN v_state;
END;
$$;

-- Recover abandoned work in bounded, cooperative batches. The expired lease is locked before it is
-- consumed, so heartbeat/completion/failure cannot race through the same ownership generation.
CREATE OR REPLACE FUNCTION ironshift.recover_expired_v1(
  p_limit integer DEFAULT 100,
  p_retry_delay_ms integer DEFAULT 0
) RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  v_lease ironshift.lease%ROWTYPE;
  v_job ironshift.job%ROWTYPE;
  v_state text;
  v_run_at timestamptz;
  v_count integer := 0;
BEGIN
  FOR v_lease IN
    SELECT l.* FROM ironshift.lease l
    WHERE l.expires_at <= clock_timestamp()
    ORDER BY l.expires_at, l.job_id
    FOR UPDATE SKIP LOCKED
    LIMIT GREATEST(1, LEAST(p_limit, 10000))
  LOOP
    -- The row remains locked from selection through deletion and requeue inside this transaction.
    DELETE FROM ironshift.lease l
      WHERE l.job_id = v_lease.job_id AND l.fence_token = v_lease.fence_token;
    IF NOT FOUND THEN CONTINUE; END IF;
    SELECT * INTO STRICT v_job FROM ironshift.job j WHERE j.id = v_lease.job_id;

    IF v_lease.attempt < v_job.max_attempts THEN
      v_run_at := clock_timestamp() + make_interval(secs => GREATEST(0, p_retry_delay_ms)::double precision / 1000.0);
      v_state := CASE WHEN p_retry_delay_ms <= 0 THEN 'ready' ELSE 'scheduled' END;
      IF v_state = 'ready' THEN
        INSERT INTO ironshift.ready_job(job_id, queue_name, attempt)
          VALUES (v_lease.job_id, v_job.queue_name, v_lease.attempt + 1);
      ELSE
        INSERT INTO ironshift.scheduled_job(job_id, queue_name, attempt, run_at)
          VALUES (v_lease.job_id, v_job.queue_name, v_lease.attempt + 1, v_run_at);
      END IF;
      UPDATE ironshift.job_current c
        SET state = v_state, run_at = v_run_at,
            error = jsonb_build_object('name', 'LeaseExpired', 'message', 'worker lease expired'),
            updated_at = clock_timestamp()
        WHERE c.job_id = v_lease.job_id AND c.version = v_lease.fence_token;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'current state fence mismatch for job %', v_lease.job_id;
      END IF;
    ELSE
      v_state := 'failed';
      UPDATE ironshift.job_current c
        SET state = 'failed', error = jsonb_build_object('name', 'LeaseExpired', 'message', 'worker lease expired'),
            finished_at = clock_timestamp(), updated_at = clock_timestamp()
        WHERE c.job_id = v_lease.job_id AND c.version = v_lease.fence_token;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'current state fence mismatch for job %', v_lease.job_id;
      END IF;
    END IF;
    INSERT INTO ironshift.attempt_history(job_id, attempt, fence_token, worker_id, outcome, started_at, error)
      VALUES (v_lease.job_id, v_lease.attempt, v_lease.fence_token, v_lease.worker_id,
        'lease_expired', v_lease.acquired_at,
        jsonb_build_object('name', 'LeaseExpired', 'message', 'worker lease expired'));
    INSERT INTO ironshift.job_event(job_id, attempt, event_type, details)
      VALUES (v_lease.job_id, v_lease.attempt, 'lease_expired',
        jsonb_build_object('fence_token', v_lease.fence_token, 'next_state', v_state));
    v_count := v_count + 1;
  END LOOP;
  IF v_count > 0 THEN PERFORM pg_notify('ironshift_jobs', '*'); END IF;
  RETURN v_count;
END;
$$;

-- Pre-create monthly partitions. If the default partition already contains rows in this range,
-- PostgreSQL will reject attachment until those rows are moved, which is preferable to overlap.
CREATE OR REPLACE FUNCTION ironshift.create_history_partitions_v1(p_month date)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  v_start date := date_trunc('month', p_month)::date;
  v_end date := (date_trunc('month', p_month) + interval '1 month')::date;
  v_suffix text := to_char(v_start, 'YYYYMM');
BEGIN
  EXECUTE format(
    'CREATE TABLE IF NOT EXISTS ironshift.%I PARTITION OF ironshift.job_event FOR VALUES FROM (%L) TO (%L)',
    'job_event_' || v_suffix, v_start, v_end);
  EXECUTE format(
    'CREATE TABLE IF NOT EXISTS ironshift.%I PARTITION OF ironshift.attempt_history FOR VALUES FROM (%L) TO (%L)',
    'attempt_history_' || v_suffix, v_start, v_end);
END;
$$;

-- Bulk-retire completed history by dropping both month partitions. Current/future months are
-- rejected to reduce accidental removal of active operational history.
CREATE OR REPLACE FUNCTION ironshift.retire_history_month_v1(p_month date)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  v_start date := date_trunc('month', p_month)::date;
  v_suffix text := to_char(v_start, 'YYYYMM');
BEGIN
  IF v_start >= date_trunc('month', current_date)::date THEN
    RAISE EXCEPTION 'only completed history months can be retired';
  END IF;
  EXECUTE format('DROP TABLE IF EXISTS ironshift.%I', 'job_event_' || v_suffix);
  EXECUTE format('DROP TABLE IF EXISTS ironshift.%I', 'attempt_history_' || v_suffix);
END;
$$;

INSERT INTO ironshift.schema_version(version) VALUES (1) ON CONFLICT DO NOTHING;
SELECT ironshift.create_history_partitions_v1(current_date);
SELECT ironshift.create_history_partitions_v1((current_date + interval '1 month')::date);

COMMIT;
