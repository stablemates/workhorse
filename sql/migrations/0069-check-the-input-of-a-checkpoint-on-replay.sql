-- workhorse-migration: {"kind":"additive"}

-- Check the input of a checkpoint on replay (SM-1211, ADR 0098).

-- A checkpoint stored only its name and its value. If a deploy changed the input of a checkpoint
-- operation, a replay with the same name returned the stored result of the old input. A handler can
-- now give the input of a checkpoint. The SDK stores the SHA-256 digest of its canonical JSON in
-- task_checkpoint.input_fingerprint. save_checkpoint_v2 compares the digest when the name already
-- exists, and returns input_conflict when the two digests differ.
--
-- save_checkpoint_v1 now calls save_checkpoint_v2 with no fingerprint, so its result does not
-- change. Existing rows keep a NULL fingerprint, and a NULL fingerprint never conflicts.

-- The column has no CHECK, because a CHECK on a new column scans the table under ACCESS
-- EXCLUSIVE. save_checkpoint_v2, the only writer, checks the format.
ALTER TABLE workhorse.task_checkpoint ADD COLUMN IF NOT EXISTS input_fingerprint text;

-- Persist one immutable named checkpoint only while the caller owns the active, unexpired lease.
-- Locking the runtime row serializes this write with completion, failure, and expiry recovery. When
-- the name exists, a different non-NULL input fingerprint on both sides is an input conflict, and a
-- different value is a conflict.
CREATE OR REPLACE FUNCTION workhorse.save_checkpoint_v2(
  p_task_id uuid,
  p_worker_id text,
  p_fence_token bigint,
  p_checkpoint_name text,
  p_checkpoint_value jsonb,
  p_input_fingerprint text
) RETURNS TABLE (
  status text,
  checkpoint_value jsonb,
  attempt integer,
  fence_token bigint,
  worker_id text,
  created_at timestamptz,
  input_fingerprint text
)
LANGUAGE plpgsql
AS $$
DECLARE
  v_runtime workhorse.task_runtime%ROWTYPE;
  v_checkpoint workhorse.task_checkpoint%ROWTYPE;
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
  IF p_input_fingerprint IS NOT NULL AND p_input_fingerprint !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'input_fingerprint must be 64 lowercase hexadecimal characters';
  END IF;

  SELECT * INTO v_runtime
    FROM workhorse.task_runtime runtime
   WHERE runtime.task_id = p_task_id
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
      'stale'::text, NULL::jsonb, NULL::integer, NULL::bigint, NULL::text, NULL::timestamptz,
      NULL::text
    );
    RETURN;
  END IF;

  SELECT * INTO v_checkpoint
    FROM workhorse.task_checkpoint checkpoint
   WHERE checkpoint.task_id = p_task_id AND checkpoint.checkpoint_name = p_checkpoint_name;
  IF FOUND THEN
    RETURN QUERY VALUES (
      CASE
        WHEN p_input_fingerprint IS NOT NULL AND v_checkpoint.input_fingerprint IS NOT NULL
             AND v_checkpoint.input_fingerprint <> p_input_fingerprint
          THEN 'input_conflict'::text
        WHEN v_checkpoint.checkpoint_value IS NOT DISTINCT FROM p_checkpoint_value
          THEN 'existing'::text
        ELSE 'conflict'::text
      END,
      v_checkpoint.checkpoint_value,
      v_checkpoint.attempt,
      v_checkpoint.fence_token,
      v_checkpoint.worker_id,
      v_checkpoint.created_at,
      v_checkpoint.input_fingerprint
    );
    RETURN;
  END IF;

  INSERT INTO workhorse.task_checkpoint(
    task_id, checkpoint_name, checkpoint_value, attempt, fence_token, worker_id, input_fingerprint
  ) VALUES (
    p_task_id, p_checkpoint_name, p_checkpoint_value, v_runtime.current_attempt,
    p_fence_token, p_worker_id, p_input_fingerprint
  )
  RETURNING * INTO v_checkpoint;
  INSERT INTO workhorse.task_event(task_id, attempt, event_type, details)
    VALUES (
      p_task_id,
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
    v_checkpoint.created_at,
    v_checkpoint.input_fingerprint
  );
END;
$$;

-- The version 1 contract: the same write with no input fingerprint, so no input conflict.
CREATE OR REPLACE FUNCTION workhorse.save_checkpoint_v1(
  p_task_id uuid,
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
LANGUAGE sql
AS $$
  SELECT saved.status, saved.checkpoint_value, saved.attempt, saved.fence_token, saved.worker_id,
         saved.created_at
    FROM workhorse.save_checkpoint_v2(
      p_task_id, p_worker_id, p_fence_token, p_checkpoint_name, p_checkpoint_value, NULL
    ) saved;
$$;
