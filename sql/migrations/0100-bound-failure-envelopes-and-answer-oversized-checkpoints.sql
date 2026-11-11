-- workhorse-migration: {"kind":"additive"}

-- Bound the failure envelope and answer an oversized checkpoint value with a status.
--
-- A handler error can carry a very large message or stack, such as a full response body.
-- fail_v1 and fast_fail_v1 store the envelope as it comes, and a retry writes it three times
-- (SM-1983). fail_v2 and fast_fail_v2 cut the name, the message, and the stack to 1,024, 16,384,
-- and 65,536 UTF-8 bytes with bound_error_envelope_v1, then call the first versions. The cut is at
-- a code point boundary (utf8_prefix_v1), and a cut adds the key truncated with the value true.
-- Each SDK cuts by the same rule before the call, so the cut in PostgreSQL does not change a value
-- that an SDK cut. The bound reads no clock and takes no lock.
--
-- save_checkpoint_v2 raises a plain exception for a value above 1,048,576 bytes of jsonb text, and
-- the worker retried the task, which ran the operation of the checkpoint again (SM-1982).
-- save_checkpoint_v3 answers value_too_large and stores nothing, after the lease check and after
-- the check of a stored name. It also gives value_bytes and max_bytes.
--
-- This step only adds functions. fail_v1, fast_fail_v1, save_checkpoint_v1, and save_checkpoint_v2
-- keep their bodies and their answers, so a worker of an earlier release keeps working.

-- The longest prefix of p_text whose UTF-8 form has at most p_max_bytes bytes. The cut is at a
-- code point boundary, so the prefix is valid text. A text that fits does not change, so a second
-- cut of a prefix gives the same prefix. Each SDK cuts an envelope field by the same rule.
CREATE OR REPLACE FUNCTION workhorse.utf8_prefix_v1(p_text text, p_max_bytes integer)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
STRICT
PARALLEL SAFE
AS $$
DECLARE
  v_bytes bytea;
  v_cut integer := greatest(p_max_bytes, 0);
BEGIN
  IF octet_length(convert_to(p_text, 'UTF8')) <= v_cut THEN
    RETURN p_text;
  END IF;
  -- One character has at least one byte, so this prefix holds byte v_cut and the bytes before it.
  v_bytes := convert_to(left(p_text, v_cut + 1), 'UTF8');
  -- get_byte counts from zero, so byte v_cut is the first byte after the cut. Move the cut back
  -- while that byte continues a character (10xxxxxx). A character has at most four bytes.
  WHILE v_cut > 0 AND (get_byte(v_bytes, v_cut) & 192) = 128 LOOP
    v_cut := v_cut - 1;
  END LOOP;
  RETURN convert_from(substring(v_bytes FROM 1 FOR v_cut), 'UTF8');
END;
$$;

-- p_error with its name, message, and stack cut to 1,024, 16,384, and 65,536 UTF-8 bytes. A cut
-- adds the key truncated with the value true. A field that is not a string, another key, and an
-- envelope that is not an object do not change. This function never raises for a large envelope.
CREATE OR REPLACE FUNCTION workhorse.bound_error_envelope_v1(p_error jsonb)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
AS $$
DECLARE
  v_error jsonb := p_error;
  v_field record;
  v_cut boolean := false;
BEGIN
  IF jsonb_typeof(p_error) IS DISTINCT FROM 'object' THEN
    RETURN p_error;
  END IF;
  FOR v_field IN
    SELECT limits.field_name, limits.max_bytes
      FROM (VALUES ('name', 1024), ('message', 16384), ('stack', 65536))
        AS limits(field_name, max_bytes)
  LOOP
    IF jsonb_typeof(v_error -> v_field.field_name) = 'string'
       AND octet_length(convert_to(v_error ->> v_field.field_name, 'UTF8')) > v_field.max_bytes THEN
      v_error := jsonb_set(
        v_error, ARRAY[v_field.field_name],
        to_jsonb(workhorse.utf8_prefix_v1(v_error ->> v_field.field_name, v_field.max_bytes))
      );
      v_cut := true;
    END IF;
  END LOOP;
  IF v_cut THEN
    v_error := v_error || jsonb_build_object('truncated', true);
  END IF;
  RETURN v_error;
END;
$$;

-- fast_fail_v1 with the envelope bounded first. The bound reads no clock and takes no lock, so the
-- lock order and the clock reads of fast_fail_v1 do not change.
CREATE OR REPLACE FUNCTION workhorse.fast_fail_v2(
  p_task_id uuid, p_worker_id text, p_fence_token bigint, p_error jsonb, p_retry_delay_ms integer
) RETURNS text
LANGUAGE sql
AS $$
  SELECT workhorse.fast_fail_v1(
    p_task_id, p_worker_id, p_fence_token, workhorse.bound_error_envelope_v1(p_error),
    p_retry_delay_ms
  );
$$;

-- fail_v1 with the envelope bounded first, for each tier. fail_v1 sends a fast-tier task to
-- fast_fail_v1, which gets the bounded envelope. The bound reads no clock and takes no lock, so
-- the lock order and the clock reads of fail_v1 do not change.
CREATE OR REPLACE FUNCTION workhorse.fail_v2(
  p_task_id uuid, p_worker_id text, p_fence_token bigint, p_error jsonb,
  p_retry_delay_ms integer DEFAULT NULL
) RETURNS text
LANGUAGE sql
AS $$
  SELECT workhorse.fail_v1(
    p_task_id, p_worker_id, p_fence_token, workhorse.bound_error_envelope_v1(p_error),
    p_retry_delay_ms
  );
$$;

-- The version 3 contract: save_checkpoint_v2, but a value above 1,048,576 bytes of jsonb text gives
-- the status value_too_large and stores nothing. The answer comes after the lease check and after
-- the check of a stored name, so a caller that lost its lease reads stale, and a stored name keeps
-- its existing, conflict, and input_conflict answers. value_bytes and max_bytes are set only for
-- value_too_large. The size is measured before the row lock, so the lock is not held for it.
CREATE OR REPLACE FUNCTION workhorse.save_checkpoint_v3(
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
  input_fingerprint text,
  value_bytes integer,
  max_bytes integer
)
LANGUAGE plpgsql
AS $$
DECLARE
  v_runtime workhorse.task_runtime%ROWTYPE;
  v_checkpoint workhorse.task_checkpoint%ROWTYPE;
  v_value_bytes integer;
  v_max_bytes constant integer := 1048576;
BEGIN
  IF p_checkpoint_name IS NULL OR p_checkpoint_name = '' OR char_length(p_checkpoint_name) > 200 THEN
    RAISE EXCEPTION 'checkpoint_name must contain between 1 and 200 characters';
  END IF;
  IF p_checkpoint_value IS NULL THEN
    RAISE EXCEPTION 'checkpoint_value must be JSON, including JSON null when appropriate';
  END IF;
  IF p_input_fingerprint IS NOT NULL AND p_input_fingerprint !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'input_fingerprint must be 64 lowercase hexadecimal characters';
  END IF;
  v_value_bytes := octet_length(p_checkpoint_value::text);

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
      NULL::text, NULL::integer, NULL::integer
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
      v_checkpoint.input_fingerprint,
      NULL::integer,
      NULL::integer
    );
    RETURN;
  END IF;

  IF v_value_bytes > v_max_bytes THEN
    RETURN QUERY VALUES (
      'value_too_large'::text, NULL::jsonb, NULL::integer, NULL::bigint, NULL::text,
      NULL::timestamptz, NULL::text, v_value_bytes, v_max_bytes
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
    v_checkpoint.input_fingerprint,
    NULL::integer,
    NULL::integer
  );
END;
$$;
