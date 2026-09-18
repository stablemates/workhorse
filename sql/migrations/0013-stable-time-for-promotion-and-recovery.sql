-- workhorse-migration: {"kind":"additive"}

-- Promotion and recovery compare against a stable time (SM-799).

-- promote_v1 and recover_expired_v1 compared run_at, deadline_at, attempt_timeout_at, and
-- expires_at against clock_timestamp(). That function is volatile, so PostgreSQL cannot use the
-- comparison as an index bound: each tick filtered every delayed row, every row with a deadline,
-- and every active attempt with a timeout, even when nothing was due. Each function now reads the
-- clock once into v_now and compares against it, so the promote, deadline, and timeout scans seek
-- task_runtime_scheduled_idx, task_runtime_deadline_idx, and task_runtime_timeout_idx to the
-- current time. The writes and the per-row rechecks still read clock_timestamp().

CREATE OR REPLACE FUNCTION workhorse.promote_v1(p_limit integer DEFAULT 100)
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  -- One stable time lets the comparison seek task_runtime_scheduled_idx; the volatile
  -- clock_timestamp() would filter every scheduled row instead.
  v_now timestamptz := clock_timestamp();
  v_count integer;
  v_notify_queues text[];
  v_notify_queue text;
BEGIN
  WITH due AS (
    SELECT r.task_id, r.wait_name, r.run_at AS wake_at FROM workhorse.task_runtime r
     WHERE r.state = 'scheduled' AND r.run_at <= v_now
     ORDER BY r.run_at, r.task_id FOR UPDATE SKIP LOCKED
     LIMIT GREATEST(1, LEAST(p_limit, 10000))
  ), promoted AS (
    UPDATE workhorse.task_runtime r
       SET state = 'ready', ready_at = clock_timestamp(),
           sequence = nextval('workhorse.ready_sequence_seq'), wait_name = NULL,
           updated_at = clock_timestamp()
      FROM due d WHERE r.task_id = d.task_id AND r.state = 'scheduled'
    RETURNING r.task_id, r.queue_name, r.current_attempt, d.wait_name, d.wake_at
  ), events AS (
    INSERT INTO workhorse.task_event(task_id, attempt, event_type, details)
      SELECT task_id, current_attempt, 'promoted', '{}'::jsonb FROM promoted
      UNION ALL
      SELECT task_id, current_attempt, 'wait_elapsed',
             jsonb_build_object('name', wait_name, 'wake_at', wake_at, 'reason', 'due')
        FROM promoted WHERE wait_name IS NOT NULL
    RETURNING 1
  )
  SELECT count(*)::integer, array_agg(DISTINCT queue_name)
    INTO v_count, v_notify_queues
    FROM promoted
   WHERE (SELECT count(*) FROM events) >= 0;
  FOR v_notify_queue IN
    SELECT unnest(COALESCE(v_notify_queues, '{}'::text[]))
  LOOP
    PERFORM pg_notify('workhorse_tasks', v_notify_queue);
  END LOOP;
  RETURN v_count;
END;
$$;

CREATE OR REPLACE FUNCTION workhorse.recover_expired_v1(
  p_limit integer DEFAULT 100, p_retry_delay_ms integer DEFAULT NULL
) RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  v_runtime workhorse.task_runtime%ROWTYPE;
  v_task workhorse.task%ROWTYPE;
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
  v_notify_queues text[] := '{}';
  v_notify_queue text;
  -- The three scans compare against one stable time so the deadline and timeout comparisons
  -- seek their partial indexes, and the three scans agree on which work is due.
  v_now timestamptz := clock_timestamp();
BEGIN
  PERFORM set_config('workhorse.recovery_expired_leases', '0', true);
  PERFORM set_config('workhorse.recovery_retried', '0', true);
  PERFORM set_config('workhorse.recovery_retry_dimensions', '[]', true);
  FOR v_runtime IN
    SELECT runtime.* FROM workhorse.task_runtime runtime
     WHERE runtime.deadline_at IS NOT NULL AND runtime.deadline_at <= v_now
       AND (
         runtime.state <> 'active'
         OR runtime.attempt_timeout_at IS NULL
         OR runtime.attempt_timeout_at > v_now
         OR runtime.deadline_at <= runtime.attempt_timeout_at
       )
     ORDER BY runtime.deadline_at, runtime.task_id FOR UPDATE SKIP LOCKED
     LIMIT GREATEST(1, LEAST(p_limit, 10000))
  LOOP
    IF workhorse.terminalize_deadline_v1(v_runtime.task_id) THEN
      v_count := v_count + 1;
      v_notify_queues := array_append(v_notify_queues, v_runtime.queue_name);
    END IF;
  END LOOP;

  IF v_count < GREATEST(1, LEAST(p_limit, 10000)) THEN
    FOR v_runtime IN
      SELECT runtime.* FROM workhorse.task_runtime runtime
       WHERE runtime.state = 'active' AND runtime.attempt_timeout_at IS NOT NULL
         AND runtime.attempt_timeout_at <= v_now
         AND (
           runtime.deadline_at IS NULL
           OR runtime.deadline_at > v_now
           OR runtime.attempt_timeout_at < runtime.deadline_at
         )
       ORDER BY runtime.attempt_timeout_at, runtime.task_id FOR UPDATE SKIP LOCKED
       LIMIT GREATEST(0, LEAST(p_limit, 10000) - v_count)
    LOOP
      SELECT * INTO STRICT v_task FROM workhorse.task task WHERE task.id = v_runtime.task_id;
      IF workhorse.timeout_owned_v1(
        v_runtime.task_id, v_runtime.worker_id, v_runtime.fence_token
      ) THEN
        v_count := v_count + 1;
        v_notify_queues := array_append(v_notify_queues, v_task.queue_name);
        IF v_runtime.current_attempt < v_task.max_attempts THEN
          v_retried := v_retried + 1;
          v_retry_dimensions := v_retry_dimensions || jsonb_build_array(jsonb_build_object(
            'queue', v_task.queue_name, 'type', v_task.task_type
          ));
        END IF;
      END IF;
    END LOOP;
  END IF;

  IF v_count >= GREATEST(1, LEAST(p_limit, 10000)) THEN
    PERFORM set_config('workhorse.recovery_expired_leases', v_expired_leases::text, true);
    PERFORM set_config('workhorse.recovery_retried', v_retried::text, true);
    PERFORM set_config('workhorse.recovery_retry_dimensions', v_retry_dimensions::text, true);
    FOR v_notify_queue IN
      SELECT DISTINCT affected.queue_name
        FROM unnest(v_notify_queues) AS affected(queue_name)
       ORDER BY affected.queue_name
    LOOP
      PERFORM pg_notify('workhorse_tasks', v_notify_queue);
    END LOOP;
    RETURN v_count;
  END IF;

  FOR v_runtime IN
    SELECT r.* FROM workhorse.task_runtime r
     WHERE r.state = 'active' AND r.expires_at <= v_now
       AND (
         r.cancel_requested_at IS NOT NULL
         OR r.deadline_at IS NULL OR r.deadline_at > v_now
       )
       AND (
         r.cancel_requested_at IS NOT NULL
         OR r.attempt_timeout_at IS NULL OR r.attempt_timeout_at > v_now
       )
     ORDER BY r.expires_at, r.task_id FOR UPDATE SKIP LOCKED
     LIMIT GREATEST(0, LEAST(p_limit, 10000) - v_count)
  LOOP
    SELECT * INTO STRICT v_task FROM workhorse.task j WHERE j.id = v_runtime.task_id;
    IF v_runtime.cancel_requested_at IS NOT NULL THEN
      v_envelope := workhorse.cancellation_envelope_v1(
        v_runtime.cancel_requested_at, v_runtime.cancel_requested_by, v_runtime.cancel_reason
      );
      DELETE FROM workhorse.task_runtime r
       WHERE r.task_id = v_runtime.task_id AND r.state = 'active'
         AND r.fence_token = v_runtime.fence_token AND r.expires_at <= clock_timestamp()
         AND r.cancel_requested_at IS NOT NULL;
      IF NOT FOUND THEN CONTINUE; END IF;
      INSERT INTO workhorse.task_outcome(
        task_id, state, current_attempt, fence_token, run_at, error, history_through_at
      )
        VALUES (
          v_runtime.task_id, 'canceled', v_runtime.current_attempt, v_runtime.fence_token,
          v_runtime.run_at, v_envelope, clock_timestamp()
        );
      INSERT INTO workhorse.attempt_history(
        task_id, attempt, fence_token, worker_id, outcome, started_at, claimed_at, error
      ) VALUES (
        v_runtime.task_id, v_runtime.current_attempt, v_runtime.fence_token,
        v_runtime.worker_id, 'canceled', v_runtime.attempt_started_at,
        v_runtime.acquired_at, v_envelope
      );
      INSERT INTO workhorse.task_event(task_id, attempt, event_type, details)
        VALUES (
          v_runtime.task_id,
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
      v_notify_queues := array_append(v_notify_queues, v_task.queue_name);
      CONTINUE;
    END IF;
    IF v_runtime.current_attempt < v_task.max_attempts THEN
      SELECT * INTO STRICT v_retry FROM workhorse.retry_delay_v1(
        v_runtime.task_id, v_runtime.current_attempt, v_task.retry_policy,
        v_runtime.previous_retry_delay_ms, p_retry_delay_ms, 'lease-recovery-immediate'
      );
      v_retry_delay_ms := v_retry.delay_ms;
      v_retry_source := v_retry.source;
      v_run_at := clock_timestamp() + make_interval(secs => v_retry_delay_ms::double precision / 1000.0);
      v_state := CASE WHEN v_retry_delay_ms <= 0 THEN 'ready' ELSE 'scheduled' END;
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
       WHERE r.task_id = v_runtime.task_id AND r.state = 'active'
         AND r.fence_token = v_runtime.fence_token AND r.expires_at <= clock_timestamp();
      IF NOT FOUND THEN CONTINUE; END IF;
      v_retried := v_retried + 1;
      v_retry_dimensions := v_retry_dimensions || jsonb_build_array(jsonb_build_object(
        'queue', v_task.queue_name, 'type', v_task.task_type
      ));
    ELSE
      v_state := 'failed';
      v_retry_delay_ms := NULL;
      v_retry_source := 'terminal';
      DELETE FROM workhorse.task_runtime r
       WHERE r.task_id = v_runtime.task_id AND r.state = 'active'
         AND r.fence_token = v_runtime.fence_token AND r.expires_at <= clock_timestamp();
      IF NOT FOUND THEN CONTINUE; END IF;
      INSERT INTO workhorse.task_outcome(
        task_id, state, current_attempt, fence_token, run_at, error, history_through_at
      ) VALUES (
        v_runtime.task_id, 'failed', v_runtime.current_attempt, v_runtime.fence_token,
        v_runtime.run_at, v_error, clock_timestamp()
      );
    END IF;
    INSERT INTO workhorse.attempt_history(
      task_id, attempt, fence_token, worker_id, outcome, started_at, claimed_at, error
    )
      VALUES (v_runtime.task_id, v_runtime.current_attempt, v_runtime.fence_token, v_runtime.worker_id,
        'lease_expired', v_runtime.attempt_started_at, v_runtime.acquired_at, v_error);
    INSERT INTO workhorse.task_event(task_id, attempt, event_type, details)
      VALUES (v_runtime.task_id, v_runtime.current_attempt, 'lease_expired',
        jsonb_build_object('fence_token', v_runtime.fence_token::text, 'next_state', v_state,
          'retry_policy', v_task.retry_policy, 'retry_delay_ms', v_retry_delay_ms,
          'retry_delay_source', v_retry_source));
    v_count := v_count + 1;
    v_expired_leases := v_expired_leases + 1;
    v_notify_queues := array_append(v_notify_queues, v_task.queue_name);
  END LOOP;
  PERFORM set_config('workhorse.recovery_expired_leases', v_expired_leases::text, true);
  PERFORM set_config('workhorse.recovery_retried', v_retried::text, true);
  PERFORM set_config('workhorse.recovery_retry_dimensions', v_retry_dimensions::text, true);
  FOR v_notify_queue IN
    SELECT DISTINCT affected.queue_name
      FROM unnest(v_notify_queues) AS affected(queue_name)
     ORDER BY affected.queue_name
  LOOP
    PERFORM pg_notify('workhorse_tasks', v_notify_queue);
  END LOOP;
  RETURN v_count;
END;
$$;
