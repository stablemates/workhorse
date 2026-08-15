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
  IF v_version NOT IN (36, 37) THEN
    RAISE EXCEPTION 'migration 0037 requires schema version 36, found %', v_version;
  END IF;
END;
$migration$;

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
    job_id, token_name, context, attempt, fence_token, worker_id, claimed_at
  ) VALUES (
    p_job_id, p_token_name, p_context, v_runtime.current_attempt, p_fence_token,
    p_worker_id, v_runtime.acquired_at
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
         attempt_timeout_at = NULL, error = NULL, updated_at = clock_timestamp()
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
         wait.attempt, wait.created_at, wait.completed_at, wait.completed_by
    FROM workhorse.job_human_wait wait
    JOIN workhorse.job job ON job.id = wait.job_id
    JOIN workhorse.job_runtime runtime
      ON runtime.job_id = wait.job_id
     AND runtime.state = 'scheduled'
     AND runtime.wait_name = wait.token_name
     AND runtime.current_attempt = wait.attempt
   WHERE wait.completed_at IS NULL;

INSERT INTO workhorse.schema_migration(version, description)
VALUES (37, 'add completable human wait tokens')
ON CONFLICT (version) DO UPDATE SET description = EXCLUDED.description;

DELETE FROM workhorse.schema_version WHERE version = 36;
INSERT INTO workhorse.schema_version(version) VALUES (37) ON CONFLICT DO NOTHING;

COMMIT;
