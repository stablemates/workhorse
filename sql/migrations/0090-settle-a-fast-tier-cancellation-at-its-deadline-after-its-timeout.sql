-- workhorse-migration: {"kind":"additive"}

-- Settle a fast-tier attempt with a pending cancellation when its deadline passed after its attempt
-- timeout (SM-1881).
--
-- fast_recover_expired_v1 selected such a row, because its deadline passed, and locked it. The
-- deadline branch did not take the row, because the attempt timeout was earlier than the deadline.
-- The timeout branch did not take it, because the cancellation wins over the timeout. The lease
-- branch did not take it while the lease was live. Thus each tick held the lock and settled
-- nothing until the lease expired. The heartbeats of the owning worker reported busy, and the row
-- used the recovery limit.
--
-- The deadline branch now also takes a row with a pending cancellation. fast_terminalize_deadline_v1
-- closes that row canceled, as terminalize_deadline_v1 does on the full tier since migration 0089.
--
-- The function keeps its name, its arguments, and its result type under ADR 0109. The migration
-- changes no stored rows, and the SDK floor does not change.

-- Recover fast-tier rows that crossed a boundary: a ready row past its deadline, or an active row
-- past its deadline, attempt timeout, or lease. One index range scan finds the active rows, because
-- the index key is the earliest of the three boundaries. An active row with a pending cancellation
-- waits for its lease to lapse, unless its deadline passed. A passed deadline then closes the row
-- canceled, also when the attempt timeout is earlier, as it does on the full tier.
CREATE OR REPLACE FUNCTION workhorse.fast_recover_expired_v1(
  p_limit integer, p_retry_delay_ms integer, p_now timestamptz
) RETURNS TABLE (
  recovered integer, expired_leases integer, retried integer, retry_dimensions jsonb,
  queues text[]
)
LANGUAGE plpgsql
AS $$
#variable_conflict use_column
DECLARE
  v_candidate uuid;
  v_runtime workhorse.fast_task_runtime%ROWTYPE;
  v_retry record;
  v_error jsonb := jsonb_build_object('name', 'LeaseExpired', 'message', 'worker lease expired');
BEGIN
  recovered := 0;
  expired_leases := 0;
  retried := 0;
  retry_dimensions := '[]'::jsonb;
  queues := '{}'::text[];
  IF p_limit <= 0 THEN
    RETURN NEXT;
    RETURN;
  END IF;
  FOR v_candidate IN
    SELECT due.task_id FROM (
      SELECT runtime.task_id, runtime.deadline_at AS due_at
        FROM workhorse.fast_task_runtime runtime
       WHERE runtime.state = 'ready' AND runtime.deadline_at IS NOT NULL
         AND runtime.deadline_at <= p_now
      UNION ALL
      SELECT runtime.task_id, least(runtime.expires_at, runtime.attempt_timeout_at, runtime.deadline_at)
        FROM workhorse.fast_task_runtime runtime
       WHERE runtime.state = 'active'
         AND least(runtime.expires_at, runtime.attempt_timeout_at, runtime.deadline_at) <= p_now
         AND (
           runtime.cancel_requested_at IS NULL
           OR runtime.expires_at <= p_now
           OR runtime.deadline_at <= p_now
         )
    ) due
     ORDER BY due.due_at, due.task_id
     LIMIT p_limit
  LOOP
    -- The scan read an unlocked snapshot. Re-read the row under its lock so that a heartbeat,
    -- completion, or concurrent recovery that won the race is respected.
    SELECT * INTO v_runtime FROM workhorse.fast_task_runtime runtime
     WHERE runtime.task_id = v_candidate
     FOR UPDATE SKIP LOCKED;
    CONTINUE WHEN NOT FOUND;
    IF v_runtime.deadline_at IS NOT NULL AND v_runtime.deadline_at <= p_now
       AND (
         v_runtime.state = 'ready'
         OR v_runtime.cancel_requested_at IS NOT NULL
         OR v_runtime.attempt_timeout_at IS NULL
         OR v_runtime.attempt_timeout_at > p_now
         OR v_runtime.deadline_at <= v_runtime.attempt_timeout_at
       ) THEN
      CONTINUE WHEN NOT workhorse.fast_terminalize_deadline_v1(v_runtime.task_id);
    ELSIF v_runtime.attempt_timeout_at IS NOT NULL AND v_runtime.attempt_timeout_at <= p_now
       AND v_runtime.cancel_requested_at IS NULL THEN
      CONTINUE WHEN NOT workhorse.fast_timeout_owned_v1(
        v_runtime.task_id, v_runtime.worker_id, v_runtime.fence_token
      );
      IF v_runtime.attempt < v_runtime.max_attempts THEN
        retried := retried + 1;
        retry_dimensions := retry_dimensions || jsonb_build_array(jsonb_build_object(
          'queue', v_runtime.queue_name, 'type', v_runtime.task_type
        ));
      END IF;
    ELSIF v_runtime.expires_at <= p_now THEN
      IF v_runtime.cancel_requested_at IS NOT NULL THEN
        PERFORM workhorse.fast_finish_v1(
          v_runtime, 'canceled', NULL,
          workhorse.cancellation_envelope_v1(
            v_runtime.cancel_requested_at, v_runtime.cancel_requested_by, v_runtime.cancel_reason
          ),
          'canceled', 'canceled'
        );
      ELSIF v_runtime.attempt < v_runtime.max_attempts THEN
        SELECT * INTO STRICT v_retry FROM workhorse.retry_delay_v1(
          v_runtime.task_id, v_runtime.attempt, v_runtime.retry_policy,
          v_runtime.previous_retry_delay_ms, p_retry_delay_ms, 'lease-recovery-immediate'
        );
        PERFORM workhorse.fast_retry_v1(
          v_runtime, 'lease_expired', v_error, v_retry.delay_ms,
          v_retry.next_previous_retry_delay_ms
        );
        retried := retried + 1;
        retry_dimensions := retry_dimensions || jsonb_build_array(jsonb_build_object(
          'queue', v_runtime.queue_name, 'type', v_runtime.task_type
        ));
      ELSE
        PERFORM workhorse.fast_finish_v1(
          v_runtime, 'failed', NULL, v_error, 'lease_expired', 'lease_expired'
        );
      END IF;
      expired_leases := expired_leases + 1;
    ELSE
      CONTINUE;
    END IF;
    recovered := recovered + 1;
    queues := array_append(queues, v_runtime.queue_name);
  END LOOP;
  RETURN NEXT;
END;
$$;
