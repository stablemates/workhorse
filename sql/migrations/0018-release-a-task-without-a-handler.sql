-- workhorse-migration: {"kind":"additive"}

-- Release an owned task without consuming its attempt, schema 18 (SM-823).
--
-- A claim carries no task-type filter, so a worker can claim a task whose type it has no handler
-- for. Until now the worker answered that with `fail_v1`, which charges the attempt. During a
-- rolling deployment the workers from the old release therefore burned the retry budget of every
-- task type the new release introduced, and a task with one attempt was dead-lettered without ever
-- running.
--
-- `release_owned_v1` is the transition that returns such a claim. It moves the active task back to
-- `ready` with `current_attempt` untouched, so the attempt belongs to the worker that eventually
-- runs the handler. It is fenced exactly as `complete_v1` and `fail_v1` are: a worker whose lease
-- was already recovered is refused rather than allowed to return a newer attempt to the queue.

CREATE OR REPLACE FUNCTION workhorse.release_owned_v1(
  p_task_id uuid, p_worker_id text, p_fence_token bigint
) RETURNS text
LANGUAGE plpgsql
AS $$
DECLARE
  v_runtime workhorse.task_runtime%ROWTYPE;
BEGIN
  SELECT * INTO v_runtime FROM workhorse.task_runtime r
   WHERE r.task_id = p_task_id AND r.state = 'active' AND r.worker_id = p_worker_id
     AND r.fence_token = p_fence_token
   FOR UPDATE;
  IF NOT FOUND OR v_runtime.expires_at <= clock_timestamp() THEN RETURN 'stale'; END IF;
  IF v_runtime.cancel_requested_at IS NOT NULL THEN RETURN 'cancel_requested'; END IF;
  -- A lease that already crossed its deadline or its attempt timeout is settled by the transition
  -- that owns that boundary, so a release never hides an expiry the database was about to record.
  IF v_runtime.deadline_at IS NOT NULL AND v_runtime.deadline_at <= clock_timestamp() THEN
    RETURN workhorse.expire_owned_v1(p_task_id, p_worker_id, p_fence_token);
  END IF;
  IF v_runtime.attempt_timeout_at IS NOT NULL
     AND v_runtime.attempt_timeout_at <= clock_timestamp() THEN
    RETURN workhorse.expire_owned_v1(p_task_id, p_worker_id, p_fence_token);
  END IF;
  -- The lease held time the attempt may not spend twice. Accounting it against the execution
  -- timeout keeps a task that bounces between workers without a handler from holding a budget open
  -- forever, exactly as a durable wait accounts the time it held the lease.
  UPDATE workhorse.task_runtime r
     SET state = 'ready', fence_token = 0, run_at = clock_timestamp(),
         ready_at = clock_timestamp(), sequence = nextval('workhorse.ready_sequence_seq'),
         worker_id = NULL, acquired_at = NULL, heartbeat_at = NULL, expires_at = NULL,
         wait_name = NULL,
         execution_used_ms = LEAST(
           31536000000,
           r.execution_used_ms + GREATEST(
             0, floor(extract(epoch FROM clock_timestamp() - r.acquired_at) * 1000)::bigint
           )
         ),
         attempt_timeout_at = NULL, error = NULL, updated_at = clock_timestamp()
   WHERE r.task_id = p_task_id AND r.state = 'active' AND r.worker_id = p_worker_id
     AND r.fence_token = p_fence_token AND r.expires_at > clock_timestamp()
     AND (r.deadline_at IS NULL OR r.deadline_at > clock_timestamp())
     AND (r.attempt_timeout_at IS NULL OR r.attempt_timeout_at > clock_timestamp())
     AND r.cancel_requested_at IS NULL
  RETURNING * INTO v_runtime;
  IF NOT FOUND THEN RETURN 'stale'; END IF;
  PERFORM pg_notify('workhorse_tasks', v_runtime.queue_name);
  INSERT INTO workhorse.task_event(task_id, attempt, event_type, details)
    VALUES (
      p_task_id, v_runtime.current_attempt, 'released',
      jsonb_build_object('worker_id', p_worker_id, 'fence_token', p_fence_token::text)
    );
  RETURN 'released';
END;
$$;
