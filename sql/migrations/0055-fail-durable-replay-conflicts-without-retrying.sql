-- workhorse-migration: {"kind":"additive"}

-- Reserve -1 in fail_v1's delay override for terminal handler failures (SM-1107).
-- Ownership, cancellation, and expiration still win before failure settlement.
-- NULL and every other delay retain their existing retry behavior.

CREATE OR REPLACE FUNCTION workhorse.fast_fail_v1(
  p_task_id uuid, p_worker_id text, p_fence_token bigint, p_error jsonb, p_retry_delay_ms integer
) RETURNS text
LANGUAGE plpgsql
AS $$
DECLARE
  v_runtime workhorse.fast_task_runtime%ROWTYPE;
  v_error jsonb;
  v_retry record;
BEGIN
  SELECT * INTO v_runtime FROM workhorse.fast_task_runtime runtime
   WHERE runtime.task_id = p_task_id AND runtime.state = 'active'
     AND runtime.worker_id = p_worker_id AND runtime.fence_token = p_fence_token
   FOR UPDATE;
  IF NOT FOUND OR v_runtime.expires_at <= clock_timestamp() THEN RETURN 'stale'; END IF;
  IF v_runtime.cancel_requested_at IS NOT NULL THEN RETURN 'cancel_requested'; END IF;
  IF (v_runtime.deadline_at IS NOT NULL AND v_runtime.deadline_at <= clock_timestamp())
     OR (v_runtime.attempt_timeout_at IS NOT NULL
       AND v_runtime.attempt_timeout_at <= clock_timestamp()) THEN
    RETURN workhorse.fast_expire_owned_v1(p_task_id, p_worker_id, p_fence_token);
  END IF;
  v_error := workhorse.redact_error_details_v1(p_error, v_runtime.redact);
  IF v_runtime.attempt < v_runtime.max_attempts AND p_retry_delay_ms IS DISTINCT FROM -1 THEN
    SELECT * INTO STRICT v_retry FROM workhorse.retry_delay_v1(
      p_task_id, v_runtime.attempt, v_runtime.retry_policy, v_runtime.previous_retry_delay_ms,
      p_retry_delay_ms, 'legacy-handler'
    );
    RETURN workhorse.fast_retry_v1(
      v_runtime, 'retry', v_error, v_retry.delay_ms, v_retry.next_previous_retry_delay_ms
    );
  END IF;
  PERFORM workhorse.fast_finish_v1(v_runtime, 'failed', NULL, v_error, NULL, 'failed');
  RETURN 'failed';
END;
$$;

CREATE OR REPLACE FUNCTION workhorse.fail_v1(
  p_task_id uuid, p_worker_id text, p_fence_token bigint, p_error jsonb,
  p_retry_delay_ms integer DEFAULT NULL
) RETURNS text
LANGUAGE plpgsql
AS $$
DECLARE
  v_runtime workhorse.task_runtime%ROWTYPE;
  v_task workhorse.task%ROWTYPE;
  v_run_at timestamptz;
  v_state text;
  v_started_at timestamptz;
  v_claimed_at timestamptz;
  v_retry record;
  v_error jsonb;
BEGIN
  IF EXISTS (SELECT 1 FROM workhorse.fast_task_runtime fast WHERE fast.task_id = p_task_id) THEN
    RETURN workhorse.fast_fail_v1(p_task_id, p_worker_id, p_fence_token, p_error, p_retry_delay_ms);
  END IF;
  SELECT * INTO v_runtime FROM workhorse.task_runtime r
   WHERE r.task_id = p_task_id AND r.state = 'active' AND r.worker_id = p_worker_id
     AND r.fence_token = p_fence_token
   FOR UPDATE;
  IF NOT FOUND OR v_runtime.expires_at <= clock_timestamp() THEN RETURN 'stale'; END IF;
  IF v_runtime.cancel_requested_at IS NOT NULL THEN RETURN 'cancel_requested'; END IF;
  IF v_runtime.deadline_at IS NOT NULL AND v_runtime.deadline_at <= clock_timestamp() THEN
    RETURN workhorse.expire_owned_v1(p_task_id, p_worker_id, p_fence_token);
  END IF;
  IF v_runtime.attempt_timeout_at IS NOT NULL
     AND v_runtime.attempt_timeout_at <= clock_timestamp() THEN
    RETURN workhorse.expire_owned_v1(p_task_id, p_worker_id, p_fence_token);
  END IF;
  SELECT * INTO STRICT v_task FROM workhorse.task j WHERE j.id = p_task_id;
  v_error := workhorse.redact_error_details_v1(
    p_error,
    cardinality(v_task.payload_redact_keys) > 0 OR cardinality(v_task.result_redact_keys) > 0
  );

  IF v_runtime.current_attempt < v_task.max_attempts AND p_retry_delay_ms IS DISTINCT FROM -1 THEN
    v_started_at := v_runtime.attempt_started_at;
    v_claimed_at := v_runtime.acquired_at;
    SELECT * INTO STRICT v_retry FROM workhorse.retry_delay_v1(
      p_task_id, v_runtime.current_attempt, v_task.retry_policy,
      v_runtime.previous_retry_delay_ms, p_retry_delay_ms, 'legacy-handler'
    );
    v_run_at := clock_timestamp() + make_interval(secs => v_retry.delay_ms::double precision / 1000.0);
    v_state := CASE WHEN v_retry.delay_ms <= 0 THEN 'ready' ELSE 'scheduled' END;
    UPDATE workhorse.task_runtime r
       SET state = v_state, current_attempt = r.current_attempt + 1, fence_token = 0,
           run_at = v_run_at,
           ready_at = CASE WHEN v_state = 'ready' THEN clock_timestamp() END,
           sequence = CASE WHEN v_state = 'ready' THEN nextval('workhorse.ready_sequence_seq') END,
           worker_id = NULL, acquired_at = NULL, heartbeat_at = NULL, expires_at = NULL,
           wait_name = NULL, attempt_started_at = NULL, execution_used_ms = 0,
           attempt_timeout_at = NULL,
           previous_retry_delay_ms = v_retry.next_previous_retry_delay_ms,
           error = v_error, updated_at = clock_timestamp()
     WHERE r.task_id = p_task_id AND r.state = 'active' AND r.worker_id = p_worker_id
       AND r.fence_token = p_fence_token AND r.expires_at > clock_timestamp()
       AND (r.deadline_at IS NULL OR r.deadline_at > clock_timestamp())
       AND (r.attempt_timeout_at IS NULL OR r.attempt_timeout_at > clock_timestamp())
    RETURNING * INTO v_runtime;
    IF NOT FOUND THEN RETURN 'stale'; END IF;
    IF v_state = 'ready' THEN PERFORM pg_notify('workhorse_tasks', v_task.queue_name); END IF;
    INSERT INTO workhorse.attempt_history(
      task_id, attempt, fence_token, worker_id, outcome, started_at, claimed_at, error
    )
      VALUES (p_task_id, v_runtime.current_attempt - 1, p_fence_token, p_worker_id, 'retry',
        v_started_at, v_claimed_at, v_error);
    INSERT INTO workhorse.task_event(task_id, attempt, event_type, details)
      VALUES (p_task_id, v_runtime.current_attempt - 1, 'retry_scheduled',
        jsonb_build_object('next_attempt', v_runtime.current_attempt, 'run_at', v_run_at,
          'error', v_error, 'retry_policy', v_task.retry_policy,
          'retry_delay_ms', v_retry.delay_ms, 'retry_delay_source', v_retry.source));
  ELSE
    DELETE FROM workhorse.task_runtime r
     WHERE r.task_id = p_task_id AND r.state = 'active' AND r.worker_id = p_worker_id
       AND r.fence_token = p_fence_token AND r.expires_at > clock_timestamp()
       AND (r.deadline_at IS NULL OR r.deadline_at > clock_timestamp())
       AND (r.attempt_timeout_at IS NULL OR r.attempt_timeout_at > clock_timestamp())
    RETURNING * INTO v_runtime;
    IF NOT FOUND THEN RETURN 'stale'; END IF;
    v_state := 'failed';
    INSERT INTO workhorse.task_outcome(
      task_id, state, current_attempt, fence_token, run_at, error, history_through_at
    ) VALUES (
      p_task_id, 'failed', v_runtime.current_attempt, p_fence_token, v_runtime.run_at, v_error,
      clock_timestamp()
    );
    INSERT INTO workhorse.attempt_history(
      task_id, attempt, fence_token, worker_id, outcome, started_at, claimed_at, error
    ) VALUES (
      p_task_id, v_runtime.current_attempt, p_fence_token, p_worker_id, 'failed',
      v_runtime.attempt_started_at, v_runtime.acquired_at, v_error
    );
    INSERT INTO workhorse.task_event(task_id, attempt, event_type, details)
      VALUES (p_task_id, v_runtime.current_attempt, 'failed', jsonb_build_object('error', v_error));
  END IF;
  RETURN v_state;
END;
$$;
