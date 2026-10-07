-- workhorse-migration: {"kind":"additive"}

-- Close a released task without attributing its unrun attempt (SM-1158).

-- release_owned_v1 returns an owned full-tier task to ready when its worker has no handler. It
-- clears ownership but keeps attempt_started_at, and it records no suspension provenance, because no
-- worker reached the handler. cancel_v1 and terminalize_deadline_v1 assumed that an unowned task
-- with attempt_started_at always retained a wait, signal, or human-wait row for its current attempt.
-- Cancelling a released task therefore raised, and deadline recovery raised from a strict lookup and
-- rolled back its whole recovery pass. Claims already exclude the expired task, so it stayed stuck.
--
-- Both functions now close such a task like never-started work: the outcome carries fence 0, no
-- attempt_history row is written, and the terminal event carries no attempt. A task that suspended
-- before a later release keeps the attribution its suspension retained. Rows released before this
-- migration need no repair, because the replaced functions read them correctly.

CREATE OR REPLACE FUNCTION workhorse.terminalize_deadline_v1(p_task_id uuid)
RETURNS boolean
LANGUAGE plpgsql
AS $$
DECLARE
  v_runtime workhorse.task_runtime%ROWTYPE;
  v_error jsonb;
  v_worker_id text;
  v_fence_token bigint := 0;
  v_claimed_at timestamptz;
  v_attributed boolean := false;
BEGIN
  IF EXISTS (SELECT 1 FROM workhorse.fast_task_runtime fast WHERE fast.task_id = p_task_id) THEN
    RETURN workhorse.fast_terminalize_deadline_v1(p_task_id);
  END IF;
  SELECT * INTO v_runtime FROM workhorse.task_runtime runtime
   WHERE runtime.task_id = p_task_id FOR UPDATE;
  IF NOT FOUND OR v_runtime.deadline_at IS NULL
     OR v_runtime.deadline_at > clock_timestamp() THEN RETURN false; END IF;
  IF v_runtime.cancel_requested_at IS NOT NULL THEN
    v_error := workhorse.cancellation_envelope_v1(
      v_runtime.cancel_requested_at, v_runtime.cancel_requested_by, v_runtime.cancel_reason
    );
    DELETE FROM workhorse.task_runtime runtime WHERE runtime.task_id = p_task_id;
    INSERT INTO workhorse.task_outcome(
      task_id, state, current_attempt, fence_token, run_at, error, history_through_at
    ) VALUES (
      p_task_id, 'canceled', v_runtime.current_attempt, v_runtime.fence_token,
      v_runtime.run_at, v_error, clock_timestamp()
    );
    INSERT INTO workhorse.attempt_history(
      task_id, attempt, fence_token, worker_id, outcome, started_at, claimed_at, error
    ) VALUES (
      p_task_id, v_runtime.current_attempt, v_runtime.fence_token, v_runtime.worker_id,
      'canceled', v_runtime.attempt_started_at, v_runtime.acquired_at, v_error
    );
    INSERT INTO workhorse.task_event(task_id, attempt, event_type, details)
      VALUES (
        p_task_id, v_runtime.current_attempt, 'canceled',
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
    v_attributed := true;
  ELSIF v_runtime.attempt_started_at IS NOT NULL THEN
    -- A suspension retains the attribution of the worker that ran the handler. A task an owner
    -- released through release_owned_v1 keeps attempt_started_at but retains none, because no
    -- worker reached the handler; it closes like never-started work.
    SELECT provenance.worker_id, provenance.fence_token, provenance.claimed_at
      INTO v_worker_id, v_fence_token, v_claimed_at
      FROM (
        SELECT wait_row.worker_id, wait_row.fence_token, wait_row.claimed_at,
               wait_row.created_at, wait_row.wait_name AS name
          FROM workhorse.task_wait wait_row
         WHERE wait_row.task_id = p_task_id AND wait_row.attempt = v_runtime.current_attempt
        UNION ALL
        SELECT signal.worker_id, signal.fence_token, signal.claimed_at,
               signal.created_at, signal.signal_name AS name
          FROM workhorse.task_signal_wait signal
         WHERE signal.task_id = p_task_id AND signal.attempt = v_runtime.current_attempt
        UNION ALL
        SELECT human_wait.worker_id, human_wait.fence_token, human_wait.claimed_at,
               human_wait.created_at, human_wait.token_name AS name
          FROM workhorse.task_human_wait human_wait
         WHERE human_wait.task_id = p_task_id
           AND human_wait.attempt = v_runtime.current_attempt
      ) provenance
     ORDER BY provenance.created_at DESC, provenance.name DESC LIMIT 1;
    v_attributed := FOUND;
    IF NOT v_attributed THEN v_fence_token := 0; END IF;
  END IF;
  DELETE FROM workhorse.task_runtime runtime WHERE runtime.task_id = p_task_id;
  INSERT INTO workhorse.task_outcome(
    task_id, state, current_attempt, fence_token, run_at, error, history_through_at
  ) VALUES (
    p_task_id, 'failed', v_runtime.current_attempt, v_fence_token, v_runtime.run_at, v_error,
    clock_timestamp()
  );
  IF v_attributed THEN
    INSERT INTO workhorse.attempt_history(
      task_id, attempt, fence_token, worker_id, outcome, started_at, claimed_at, error
    ) VALUES (
      p_task_id, v_runtime.current_attempt, v_fence_token, v_worker_id,
      'deadline_exceeded', v_runtime.attempt_started_at, v_claimed_at, v_error
    );
  END IF;
  INSERT INTO workhorse.task_event(task_id, attempt, event_type, details)
    VALUES (
      p_task_id,
      CASE WHEN v_attributed THEN v_runtime.current_attempt END,
      'deadline_exceeded',
      jsonb_build_object(
        'deadline_at', v_runtime.deadline_at,
        'fence_token', v_fence_token::text,
        'started', v_attributed
      )
    );
  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION workhorse.cancel_v1(
  p_task_id uuid, p_requested_by text DEFAULT NULL, p_reason text DEFAULT NULL
) RETURNS TABLE (
  status text, state text, current_attempt integer, requested_at timestamptz,
  requested_by text, reason text, finished_at timestamptz
)
LANGUAGE plpgsql
AS $$
DECLARE
  v_runtime workhorse.task_runtime%ROWTYPE;
  v_outcome workhorse.task_outcome%ROWTYPE;
  v_now timestamptz := clock_timestamp();
  v_fence_token bigint := 0;
  v_worker_id text;
  v_claimed_at timestamptz;
  v_attempt integer;
  v_envelope jsonb;
  v_fast_outcome workhorse.fast_task_outcome%ROWTYPE;
BEGIN
  IF p_task_id IS NULL THEN RAISE EXCEPTION 'task_id is required'; END IF;
  IF p_requested_by IS NOT NULL
     AND (p_requested_by = '' OR char_length(p_requested_by) > 200) THEN
    RAISE EXCEPTION 'requested_by must contain between 1 and 200 characters';
  END IF;
  IF p_reason IS NOT NULL AND (p_reason = '' OR char_length(p_reason) > 2000) THEN
    RAISE EXCEPTION 'reason must contain between 1 and 2000 characters';
  END IF;

  -- A fast-tier task that settles between this check and its lock falls through to the outcome
  -- lookup below, which reads both outcome tables.
  IF EXISTS (SELECT 1 FROM workhorse.fast_task_runtime fast WHERE fast.task_id = p_task_id) THEN
    RETURN QUERY SELECT * FROM workhorse.fast_cancel_v1(p_task_id, p_requested_by, p_reason);
    IF FOUND THEN RETURN; END IF;
  END IF;

  SELECT * INTO v_runtime
    FROM workhorse.task_runtime runtime
   WHERE runtime.task_id = p_task_id
   FOR UPDATE;
  IF FOUND THEN
    IF v_runtime.state = 'active' THEN
      IF v_runtime.cancel_requested_at IS NULL THEN
        UPDATE workhorse.task_runtime runtime
           SET cancel_requested_at = v_now,
               cancel_requested_by = p_requested_by,
               cancel_reason = p_reason,
               updated_at = v_now
         WHERE runtime.task_id = p_task_id AND runtime.state = 'active'
           AND runtime.cancel_requested_at IS NULL
        RETURNING * INTO v_runtime;
        IF FOUND THEN
          INSERT INTO workhorse.task_event(task_id, attempt, event_type, details)
            VALUES (
              p_task_id,
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
    -- signal or human boundary even though scheduled runtime ownership has been released. A task an
    -- owner released through release_owned_v1 keeps attempt_started_at but retains none, because
    -- no worker reached the handler; it closes like never-started work.
    IF v_runtime.attempt_started_at IS NOT NULL THEN
      SELECT provenance.fence_token, provenance.worker_id, provenance.attempt,
             provenance.claimed_at
        INTO v_fence_token, v_worker_id, v_attempt, v_claimed_at
        FROM (
          SELECT wait_row.fence_token, wait_row.worker_id, wait_row.attempt,
                 wait_row.claimed_at, wait_row.created_at, wait_row.wait_name AS name
            FROM workhorse.task_wait wait_row
           WHERE wait_row.task_id = p_task_id AND wait_row.attempt = v_runtime.current_attempt
          UNION ALL
          SELECT signal.fence_token, signal.worker_id, signal.attempt,
                 signal.claimed_at, signal.created_at, signal.signal_name AS name
            FROM workhorse.task_signal_wait signal
           WHERE signal.task_id = p_task_id AND signal.attempt = v_runtime.current_attempt
          UNION ALL
          SELECT human_wait.fence_token, human_wait.worker_id, human_wait.attempt,
                 human_wait.claimed_at, human_wait.created_at, human_wait.token_name AS name
            FROM workhorse.task_human_wait human_wait
           WHERE human_wait.task_id = p_task_id
             AND human_wait.attempt = v_runtime.current_attempt
        ) provenance
       ORDER BY provenance.created_at DESC, provenance.name DESC
       LIMIT 1;
      IF NOT FOUND THEN v_fence_token := 0; END IF;
    END IF;
    v_envelope := workhorse.cancellation_envelope_v1(v_now, p_requested_by, p_reason);
    DELETE FROM workhorse.task_runtime runtime WHERE runtime.task_id = p_task_id;
    INSERT INTO workhorse.task_outcome(
      task_id, state, current_attempt, fence_token, run_at, error, finished_at, updated_at,
      history_through_at
    ) VALUES (
      p_task_id, 'canceled', v_runtime.current_attempt, v_fence_token, v_runtime.run_at,
      v_envelope, v_now, v_now, v_now
    ) RETURNING * INTO v_outcome;
    IF v_attempt IS NOT NULL THEN
      INSERT INTO workhorse.attempt_history(
        task_id, attempt, fence_token, worker_id, outcome, started_at, claimed_at, error
      ) VALUES (
        p_task_id, v_attempt, v_fence_token, v_worker_id, 'canceled',
        v_runtime.attempt_started_at, v_claimed_at, v_envelope
      );
    END IF;
    INSERT INTO workhorse.task_event(task_id, attempt, event_type, details)
      VALUES (
        p_task_id,
        v_attempt,
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

  SELECT * INTO v_outcome FROM workhorse.task_outcome outcome WHERE outcome.task_id = p_task_id;
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

  SELECT * INTO v_fast_outcome FROM workhorse.fast_task_outcome outcome
   WHERE outcome.task_id = p_task_id;
  IF FOUND THEN
    IF v_fast_outcome.state = 'canceled' THEN
      RETURN QUERY VALUES (
        'canceled'::text, v_fast_outcome.state, v_fast_outcome.attempt,
        NULLIF(v_fast_outcome.error->>'requested_at', '')::timestamptz,
        v_fast_outcome.error->>'requested_by', v_fast_outcome.error->>'reason',
        v_fast_outcome.finished_at
      );
    ELSE
      RETURN QUERY VALUES (
        'already_terminal'::text, v_fast_outcome.state, v_fast_outcome.attempt,
        NULL::timestamptz, NULL::text, NULL::text, v_fast_outcome.finished_at
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
