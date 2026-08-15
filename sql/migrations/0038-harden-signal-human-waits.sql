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
  IF v_version NOT IN (37, 38) THEN
    RAISE EXCEPTION 'migration 0038 requires schema version 37, found %', v_version;
  END IF;
END;
$migration$;

ALTER TABLE workhorse.job_signal_wait ADD COLUMN IF NOT EXISTS timeout_at timestamptz;
ALTER TABLE workhorse.job_human_wait ADD COLUMN IF NOT EXISTS timeout_at timestamptz;

UPDATE workhorse.job_signal_wait signal
   SET timeout_at = LEAST(
     COALESCE((
       SELECT runtime.deadline_at FROM workhorse.job_runtime runtime
        WHERE runtime.job_id = signal.job_id
          AND runtime.state = 'scheduled'
          AND runtime.wait_name = signal.signal_name
          AND runtime.current_attempt = signal.attempt
     ), signal.created_at + interval '7 days'),
     signal.created_at + interval '7 days'
   )
 WHERE signal.timeout_at IS NULL;
UPDATE workhorse.job_human_wait human_wait
   SET timeout_at = LEAST(
     COALESCE((
       SELECT runtime.deadline_at FROM workhorse.job_runtime runtime
        WHERE runtime.job_id = human_wait.job_id
          AND runtime.state = 'scheduled'
          AND runtime.wait_name = human_wait.token_name
          AND runtime.current_attempt = human_wait.attempt
     ), human_wait.created_at + interval '7 days'),
     human_wait.created_at + interval '7 days'
   )
 WHERE human_wait.timeout_at IS NULL;

ALTER TABLE workhorse.job_signal_wait ALTER COLUMN timeout_at SET NOT NULL;
ALTER TABLE workhorse.job_human_wait ALTER COLUMN timeout_at SET NOT NULL;
DO $constraints$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'job_signal_wait_timeout_finite'
       AND conrelid = 'workhorse.job_signal_wait'::regclass
  ) THEN
    ALTER TABLE workhorse.job_signal_wait ADD CONSTRAINT job_signal_wait_timeout_finite
      CHECK (isfinite(timeout_at));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'job_human_wait_timeout_finite'
       AND conrelid = 'workhorse.job_human_wait'::regclass
  ) THEN
    ALTER TABLE workhorse.job_human_wait ADD CONSTRAINT job_human_wait_timeout_finite
      CHECK (isfinite(timeout_at));
  END IF;
END;
$constraints$;

UPDATE workhorse.job_runtime runtime
   SET deadline_at = LEAST(COALESCE(runtime.deadline_at, 'infinity'::timestamptz), boundary.timeout_at)
  FROM (
    SELECT signal.job_id, signal.timeout_at
      FROM workhorse.job_signal_wait signal
     WHERE signal.delivered_at IS NULL
    UNION ALL
    SELECT human_wait.job_id, human_wait.timeout_at
      FROM workhorse.job_human_wait human_wait
     WHERE human_wait.completed_at IS NULL
  ) boundary
 WHERE runtime.job_id = boundary.job_id
   AND runtime.state = 'scheduled';

CREATE INDEX IF NOT EXISTS job_signal_wait_pending_idx
  ON workhorse.job_signal_wait(created_at, job_id, signal_name)
  WHERE delivered_at IS NULL;

-- PostgreSQL supplies a finite default timeout for each newly declared external boundary. An
-- earlier job deadline remains authoritative. Successful delivery restores the immutable job
-- deadline before the handler is claimed again.
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


-- Suspended human waits retain the same attempt attribution as timers and signals. Deadline and
-- cancellation terminalization must preserve that provenance before removing the runtime row.
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

INSERT INTO workhorse.schema_migration(version, description)
VALUES (38, 'harden signal and human wait lifecycles')
ON CONFLICT (version) DO UPDATE SET description = EXCLUDED.description;

DELETE FROM workhorse.schema_version WHERE version = 37;
INSERT INTO workhorse.schema_version(version) VALUES (38) ON CONFLICT DO NOTHING;

COMMIT;
