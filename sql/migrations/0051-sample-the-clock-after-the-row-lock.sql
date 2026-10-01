-- workhorse-migration: {"kind":"additive"}

-- Sample the clock after the row lock in completion and heartbeat functions (SM-1036).

-- Schema version 49 read clock_timestamp() into v_now before these functions waited for the task's
-- row lock. When another transaction held that lock, the function compared expiry against the time
-- it started waiting. A fast completion could accept a lease that expired during the wait and
-- record a finish time earlier than the real one. A heartbeat could renew such a lease, and it
-- computed a renewed lease from the stale time.
--
-- Each function now takes its row locks first and samples v_now afterwards, as update_progress_v1
-- already did. heartbeat_v1 and the full-tier path of heartbeat_many_v1 previously locked only
-- inside their UPDATE, so they now lock explicitly, the batch in task ID order. Recovery and reclaim
-- skip locked rows and change the fence, so the stale time could not duplicate or lose a task.

CREATE OR REPLACE FUNCTION workhorse.fast_complete_many_v1(
  p_worker_id text, p_task_ids uuid[], p_fence_tokens bigint[], p_results jsonb[]
) RETURNS uuid[]
LANGUAGE plpgsql
SET plan_cache_mode = force_generic_plan
AS $$
DECLARE
  v_now timestamptz;
  v_accepted uuid[];
  v_oversized uuid[] := '{}'::uuid[];
  v_rejection record;
BEGIN
  PERFORM 1 FROM (
    SELECT FROM workhorse.fast_task_runtime runtime
     WHERE runtime.task_id = ANY (p_task_ids) AND runtime.worker_id = p_worker_id
     ORDER BY runtime.task_id
       FOR UPDATE
  ) locked;
  -- Sample time only after the row locks. A timestamp taken before a blocked lock wait could accept
  -- a lease that expired during the wait and record a finish time earlier than the real one.
  v_now := clock_timestamp();
  FOR v_rejection IN
    SELECT input.task_id, input.fence_token, runtime.task_type
      FROM unnest(p_task_ids, p_fence_tokens, p_results) AS input(task_id, fence_token, result)
      JOIN workhorse.fast_task_runtime runtime ON runtime.task_id = input.task_id
     WHERE octet_length(COALESCE(input.result, 'null'::jsonb)::text) > runtime.result_max_bytes
     ORDER BY input.task_id
  LOOP
    v_oversized := v_oversized || v_rejection.task_id;
    PERFORM workhorse.fast_fail_v1(
      v_rejection.task_id, p_worker_id, v_rejection.fence_token,
      jsonb_build_object(
        'name', 'TaskValueSizeLimitError',
        'message', v_rejection.task_type || ' result exceeds its configured size limit',
        'stack', NULL
      ),
      NULL
    );
  END LOOP;
  WITH input AS (
    SELECT * FROM unnest(p_task_ids, p_fence_tokens, p_results)
      AS input(task_id, fence_token, result)
     WHERE input.task_id <> ALL (v_oversized)
  ), done AS (
    DELETE FROM workhorse.fast_task_runtime runtime
     USING input
     WHERE runtime.task_id = input.task_id
       AND runtime.fence_token = input.fence_token AND runtime.worker_id = p_worker_id
       AND runtime.expires_at > v_now
       AND (runtime.deadline_at IS NULL OR runtime.deadline_at > v_now)
       AND (runtime.attempt_timeout_at IS NULL OR runtime.attempt_timeout_at > v_now)
       AND runtime.cancel_requested_at IS NULL
    RETURNING runtime.*, COALESCE(input.result, 'null'::jsonb) AS result
  ), kept AS (
    INSERT INTO workhorse.fast_task_outcome(
      task_id, queue_name, task_type, state, attempt, result,
      fence_token, worker_id, claimed_at, enqueued_at, finished_at, errors, errors_dropped
    )
    SELECT done.task_id, done.queue_name, done.task_type, 'succeeded', done.attempt, done.result,
           done.fence_token, done.worker_id, done.claimed_at, done.enqueued_at, v_now,
           done.errors, done.errors_dropped
      FROM done
    RETURNING fast_task_outcome.task_id
  ), history AS (
    INSERT INTO workhorse.attempt_history(
      task_id, attempt, fence_token, worker_id, outcome, started_at, claimed_at, finished_at
    )
    SELECT done.task_id, done.attempt, done.fence_token, done.worker_id, 'succeeded',
           done.claimed_at, done.claimed_at, v_now
      FROM done
      JOIN workhorse.queue_control control
        ON control.queue_name = done.queue_name AND control.record_attempts
  )
  SELECT COALESCE(array_agg(kept.task_id), '{}'::uuid[]) INTO v_accepted FROM kept;
  RETURN v_accepted;
END;
$$;

CREATE OR REPLACE FUNCTION workhorse.fast_heartbeat_many_v1(
  p_worker_id text, p_task_ids uuid[], p_fence_tokens bigint[], p_lease_ms integer[]
) RETURNS TABLE (ordinal bigint, task_id uuid, status text)
LANGUAGE plpgsql
AS $$
#variable_conflict use_column
DECLARE
  v_now timestamptz;
BEGIN
  PERFORM 1 FROM (
    SELECT FROM workhorse.fast_task_runtime runtime
     WHERE runtime.task_id = ANY (p_task_ids) AND runtime.worker_id = p_worker_id
     ORDER BY runtime.task_id
       FOR NO KEY UPDATE
  ) locked;
  -- Sample time only after the row locks, so a lease that expired during a blocked lock wait is not
  -- renewed and a renewed lease starts from the time it was granted.
  v_now := clock_timestamp();
  RETURN QUERY
  WITH leases AS MATERIALIZED (
    SELECT input.ordinal, input.task_id, input.fence_token, input.lease_ms
      FROM unnest(p_task_ids, p_fence_tokens, p_lease_ms)
        WITH ORDINALITY AS input(task_id, fence_token, lease_ms, ordinal)
  ), heartbeated AS (
    UPDATE workhorse.fast_task_runtime runtime
       SET expires_at = CASE
             WHEN runtime.cancel_requested_at IS NULL
               AND (runtime.deadline_at IS NULL OR runtime.deadline_at > v_now)
               AND (runtime.attempt_timeout_at IS NULL OR runtime.attempt_timeout_at > v_now)
               AND runtime.expires_at > v_now
             THEN v_now + lease.lease_ms * interval '1 millisecond'
             ELSE runtime.expires_at END
      FROM leases lease
     WHERE runtime.task_id = lease.task_id AND runtime.state = 'active'
       AND runtime.worker_id = p_worker_id AND runtime.fence_token = lease.fence_token
    RETURNING lease.ordinal, runtime.task_id,
      CASE
        WHEN runtime.cancel_requested_at IS NOT NULL THEN 'cancel_requested'
        WHEN runtime.deadline_at IS NOT NULL AND runtime.deadline_at <= v_now THEN 'deadline_exceeded'
        WHEN runtime.attempt_timeout_at IS NOT NULL AND runtime.attempt_timeout_at <= v_now THEN 'timeout_exceeded'
        WHEN runtime.expires_at <= v_now THEN 'stale'
        ELSE 'accepted'
      END AS status
  )
  SELECT lease.ordinal, lease.task_id, COALESCE(heartbeated.status, 'stale')
    FROM leases lease
    LEFT JOIN heartbeated USING (ordinal, task_id)
   ORDER BY lease.ordinal;
END;
$$;

CREATE OR REPLACE FUNCTION workhorse.heartbeat_v1(
  p_task_id uuid, p_worker_id text, p_fence_token bigint, p_lease_ms integer DEFAULT 30000
) RETURNS text
LANGUAGE plpgsql
AS $$
DECLARE
  v_now timestamptz;
  v_status text;
BEGIN
  IF p_worker_id IS NULL OR p_worker_id = '' THEN RAISE EXCEPTION 'worker_id must not be empty'; END IF;
  IF p_lease_ms IS NULL OR p_lease_ms NOT BETWEEN 100 AND 86400000 THEN
    RAISE EXCEPTION 'lease_ms must be between 100 and 86400000';
  END IF;
  IF EXISTS (SELECT 1 FROM workhorse.fast_task_runtime fast WHERE fast.task_id = p_task_id) THEN
    RETURN (SELECT beat.status FROM workhorse.fast_heartbeat_many_v1(
      p_worker_id, ARRAY[p_task_id], ARRAY[p_fence_token], ARRAY[p_lease_ms]
    ) beat);
  END IF;
  PERFORM 1 FROM workhorse.task_runtime r
   WHERE r.task_id = p_task_id AND r.state = 'active' AND r.worker_id = p_worker_id
     AND r.fence_token = p_fence_token
     FOR NO KEY UPDATE;
  -- Sample time only after the row lock, so a lease that expired during a blocked lock wait is not
  -- renewed and a renewed lease starts from the time it was granted.
  v_now := clock_timestamp();
  UPDATE workhorse.task_runtime r
     SET heartbeat_at = CASE
           WHEN r.cancel_requested_at IS NULL
             AND (r.deadline_at IS NULL OR r.deadline_at > v_now)
             AND (r.attempt_timeout_at IS NULL OR r.attempt_timeout_at > v_now)
             AND r.expires_at > v_now THEN v_now
           ELSE r.heartbeat_at END,
         expires_at = CASE
           WHEN r.cancel_requested_at IS NULL
             AND (r.deadline_at IS NULL OR r.deadline_at > v_now)
             AND (r.attempt_timeout_at IS NULL OR r.attempt_timeout_at > v_now)
             AND r.expires_at > v_now
           THEN v_now + make_interval(secs => p_lease_ms::double precision / 1000.0)
           ELSE r.expires_at END,
         updated_at = CASE
           WHEN r.cancel_requested_at IS NULL
             AND (r.deadline_at IS NULL OR r.deadline_at > v_now)
             AND (r.attempt_timeout_at IS NULL OR r.attempt_timeout_at > v_now)
             AND r.expires_at > v_now THEN v_now
           ELSE r.updated_at END
   WHERE r.task_id = p_task_id AND r.state = 'active' AND r.worker_id = p_worker_id
     AND r.fence_token = p_fence_token
  RETURNING CASE
    WHEN r.cancel_requested_at IS NOT NULL THEN 'cancel_requested'
    WHEN r.deadline_at IS NOT NULL AND r.deadline_at <= v_now THEN 'deadline_exceeded'
    WHEN r.attempt_timeout_at IS NOT NULL AND r.attempt_timeout_at <= v_now THEN 'timeout_exceeded'
    WHEN r.expires_at <= v_now THEN 'stale'
    ELSE 'accepted'
  END INTO v_status;
  RETURN COALESCE(v_status, 'stale');
END;
$$;

CREATE OR REPLACE FUNCTION workhorse.heartbeat_many_v1(
  p_worker_id text, p_leases jsonb
) RETURNS TABLE (ordinal bigint, task_id uuid, status text)
LANGUAGE plpgsql
AS $$
DECLARE
  v_now timestamptz;
  v_fast_count bigint;
  v_full_count bigint;
BEGIN
  IF p_worker_id IS NULL OR p_worker_id = '' THEN RAISE EXCEPTION 'worker_id must not be empty'; END IF;
  IF p_leases IS NULL OR jsonb_typeof(p_leases) <> 'array'
     OR jsonb_array_length(p_leases) NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'leases must contain between 1 and 100 entries';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_leases) item
     WHERE item->>'taskId' IS NULL OR item->>'fenceToken' IS NULL OR item->>'leaseMs' IS NULL
       OR (item->>'leaseMs')::integer NOT BETWEEN 100 AND 86400000
  ) THEN
    RAISE EXCEPTION 'each lease requires taskId, fenceToken, and leaseMs between 100 and 86400000';
  END IF;
  -- A batch that names no fast-tier task takes the full-tier path below unchanged. A batch that
  -- names no full-tier task takes the fast set-based path, which reports a task that has left
  -- fast_task_runtime as stale. Counting such a task as full-tier would send a worker's heartbeat
  -- one lease at a time whenever it raced that worker's own completion, and that path does not
  -- lock in task ID order. A mixed batch goes one lease at a time, in task ID order.
  SELECT count(*) FILTER (WHERE fast.task_id IS NOT NULL),
         count(*) FILTER (WHERE fast.task_id IS NULL AND EXISTS (
           SELECT 1 FROM workhorse.task_runtime runtime
            WHERE runtime.task_id = (item->>'taskId')::uuid
         ))
    INTO v_fast_count, v_full_count
    FROM jsonb_array_elements(p_leases) item
    LEFT JOIN workhorse.fast_task_runtime fast ON fast.task_id = (item->>'taskId')::uuid;
  IF v_fast_count > 0 AND v_full_count = 0 THEN
    RETURN QUERY SELECT * FROM workhorse.fast_heartbeat_many_v1(
      p_worker_id,
      ARRAY(SELECT (item->>'taskId')::uuid FROM jsonb_array_elements(p_leases) WITH ORDINALITY input(item, n) ORDER BY n),
      ARRAY(SELECT (item->>'fenceToken')::bigint FROM jsonb_array_elements(p_leases) WITH ORDINALITY input(item, n) ORDER BY n),
      ARRAY(SELECT (item->>'leaseMs')::integer FROM jsonb_array_elements(p_leases) WITH ORDINALITY input(item, n) ORDER BY n)
    );
    RETURN;
  ELSIF v_fast_count > 0 THEN
    RETURN QUERY
      WITH beats AS MATERIALIZED (
        SELECT sorted.n, sorted.task_id,
               workhorse.heartbeat_v1(sorted.task_id, p_worker_id, sorted.fence_token, sorted.lease_ms)
                 AS status
          FROM (
            SELECT input.n, (input.item->>'taskId')::uuid AS task_id,
                   (input.item->>'fenceToken')::bigint AS fence_token,
                   (input.item->>'leaseMs')::integer AS lease_ms
              FROM jsonb_array_elements(p_leases) WITH ORDINALITY input(item, n)
             ORDER BY 2
          ) sorted
      )
      SELECT beats.n, beats.task_id, beats.status FROM beats ORDER BY beats.n;
    RETURN;
  END IF;
  PERFORM 1 FROM (
    SELECT FROM workhorse.task_runtime runtime
     WHERE runtime.task_id IN (
             SELECT (item->>'taskId')::uuid FROM jsonb_array_elements(p_leases) item
           )
       AND runtime.worker_id = p_worker_id
     ORDER BY runtime.task_id
       FOR NO KEY UPDATE
  ) locked;
  -- Sample time only after the row locks, so a lease that expired during a blocked lock wait is not
  -- renewed and a renewed lease starts from the time it was granted.
  v_now := clock_timestamp();
  RETURN QUERY
  WITH leases AS MATERIALIZED (
    SELECT item.ordinality AS ordinal,
           (item.value->>'taskId')::uuid AS task_id,
           (item.value->>'fenceToken')::bigint AS fence_token,
           (item.value->>'leaseMs')::integer AS lease_ms
      FROM jsonb_array_elements(p_leases) WITH ORDINALITY AS item(value, ordinality)
  ), heartbeated AS (
    UPDATE workhorse.task_runtime runtime
       SET heartbeat_at = CASE
             WHEN runtime.cancel_requested_at IS NULL
               AND (runtime.deadline_at IS NULL OR runtime.deadline_at > v_now)
               AND (runtime.attempt_timeout_at IS NULL OR runtime.attempt_timeout_at > v_now)
               AND runtime.expires_at > v_now THEN v_now
             ELSE runtime.heartbeat_at END,
           expires_at = CASE
             WHEN runtime.cancel_requested_at IS NULL
               AND (runtime.deadline_at IS NULL OR runtime.deadline_at > v_now)
               AND (runtime.attempt_timeout_at IS NULL OR runtime.attempt_timeout_at > v_now)
               AND runtime.expires_at > v_now
             THEN v_now + make_interval(secs => lease.lease_ms::double precision / 1000.0)
             ELSE runtime.expires_at END,
           updated_at = CASE
             WHEN runtime.cancel_requested_at IS NULL
               AND (runtime.deadline_at IS NULL OR runtime.deadline_at > v_now)
               AND (runtime.attempt_timeout_at IS NULL OR runtime.attempt_timeout_at > v_now)
               AND runtime.expires_at > v_now THEN v_now
             ELSE runtime.updated_at END
      FROM leases lease
     WHERE runtime.task_id = lease.task_id AND runtime.state = 'active'
       AND runtime.worker_id = p_worker_id AND runtime.fence_token = lease.fence_token
    RETURNING lease.ordinal, runtime.task_id,
      CASE
        WHEN runtime.cancel_requested_at IS NOT NULL THEN 'cancel_requested'
        WHEN runtime.deadline_at IS NOT NULL AND runtime.deadline_at <= v_now THEN 'deadline_exceeded'
        WHEN runtime.attempt_timeout_at IS NOT NULL AND runtime.attempt_timeout_at <= v_now THEN 'timeout_exceeded'
        WHEN runtime.expires_at <= v_now THEN 'stale'
        ELSE 'accepted'
      END AS status
  )
  SELECT lease.ordinal, lease.task_id, COALESCE(heartbeated.status, 'stale')
    FROM leases lease
    LEFT JOIN heartbeated USING (ordinal, task_id)
   ORDER BY lease.ordinal;
END;
$$;
