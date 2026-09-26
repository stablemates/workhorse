-- workhorse-migration: {"kind":"additive"}

-- Lock a worker's fast-tier rows in task ID order (SM-929).

-- A worker's batched completion and its own heartbeat round can name the same runtime rows. The
-- completion's DELETE locked them in input order, and the heartbeat's UPDATE could lock them in
-- the order of fast_task_runtime_active_due_idx. Each could hold a row the other needed, and
-- PostgreSQL rolled one back with 40P01. The fused claim in complete_many_and_claim_v1 kept the
-- completion's locks held for longer and made the cycle more likely. Both functions now lock the
-- worker's rows in task ID order before they change any, so the order no longer depends on the
-- caller or the plan.
--
-- heartbeat_many_v1 also counted a task that had just left fast_task_runtime as full-tier, so a
-- heartbeat that raced its worker's own completion went one lease at a time in input order. It now
-- takes the fast path unless the batch names a full-tier task, and its mixed path goes in task ID
-- order. Every signature and result shape is unchanged.

-- Complete a batch of fast-tier attempts in one statement. Each accepted attempt deletes its
-- runtime row and writes its outcome row. An attempt whose fence, lease, deadline, attempt timeout,
-- or cancellation no longer allows completion is left alone and missing from the result, exactly
-- as complete_v1 returns false for it. The worker checks result sizes before it calls; an oversized
-- result that still arrives fails the whole batch, as it fails complete_v1.
--
-- The DELETE matches on the primary key, the fence, and the owning worker. It has no state
-- predicate: fast_task_runtime_state_shape_check gives a ready row a NULL worker_id, so the
-- worker match already implies an active row. A state predicate let the planner prefer
-- fast_task_runtime_active_due_idx, whose scan grows with every active row of every worker.
-- The generic plan keeps the primary-key plan: a custom plan per call cost more to plan than
-- the statement costs to run. The history insert joins queue_control once instead of calling
-- fast_records_attempts_v1 per completed row.
--
-- Before the DELETE, the function locks the worker's rows in task ID order, as
-- fast_heartbeat_many_v1 does. The DELETE's plan locks rows in input order, and a heartbeat's plan
-- can lock them in index order. Without the shared order, a worker's completion and its own
-- heartbeat could each hold a row the other needs, and PostgreSQL rolled one back with 40P01.
CREATE OR REPLACE FUNCTION workhorse.fast_complete_many_v1(
  p_worker_id text, p_task_ids uuid[], p_fence_tokens bigint[], p_results jsonb[]
) RETURNS uuid[]
LANGUAGE plpgsql
SET plan_cache_mode = force_generic_plan
AS $$
DECLARE
  v_now timestamptz := clock_timestamp();
  v_accepted uuid[];
BEGIN
  IF EXISTS (
    SELECT 1
      FROM unnest(p_task_ids, p_results) AS input(task_id, result)
      JOIN workhorse.fast_task_runtime runtime ON runtime.task_id = input.task_id
     WHERE octet_length(COALESCE(input.result, 'null'::jsonb)::text) > runtime.result_max_bytes
  ) THEN
    RAISE EXCEPTION 'result exceeds its configured size limit';
  END IF;
  PERFORM 1 FROM (
    SELECT FROM workhorse.fast_task_runtime runtime
     WHERE runtime.task_id = ANY (p_task_ids) AND runtime.worker_id = p_worker_id
     ORDER BY runtime.task_id
       FOR UPDATE
  ) locked;
  WITH input AS (
    SELECT * FROM unnest(p_task_ids, p_fence_tokens, p_results)
      AS input(task_id, fence_token, result)
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

-- Extend a batch of fast-tier leases in one statement. Before the UPDATE, the function locks the
-- worker's rows in task ID order, the order fast_complete_many_v1 locks them in, so a heartbeat
-- and a batched completion of the same worker never wait on each other in a cycle.
CREATE OR REPLACE FUNCTION workhorse.fast_heartbeat_many_v1(
  p_worker_id text, p_task_ids uuid[], p_fence_tokens bigint[], p_lease_ms integer[]
) RETURNS TABLE (ordinal bigint, task_id uuid, status text)
LANGUAGE plpgsql
AS $$
#variable_conflict use_column
DECLARE
  v_now timestamptz := clock_timestamp();
BEGIN
  PERFORM 1 FROM (
    SELECT FROM workhorse.fast_task_runtime runtime
     WHERE runtime.task_id = ANY (p_task_ids) AND runtime.worker_id = p_worker_id
     ORDER BY runtime.task_id
       FOR NO KEY UPDATE
  ) locked;
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

CREATE OR REPLACE FUNCTION workhorse.heartbeat_many_v1(
  p_worker_id text, p_leases jsonb
) RETURNS TABLE (ordinal bigint, task_id uuid, status text)
LANGUAGE plpgsql
AS $$
DECLARE
  v_now timestamptz := clock_timestamp();
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
