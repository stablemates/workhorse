-- workhorse-migration: {"kind":"additive"}

-- Skip a locked row in a heartbeat and report the lease as busy (SM-1443, ADR 0105).

-- heartbeat_many_v1 locks the rows of a worker with FOR NO KEY UPDATE and waits for a row that
-- another transaction locks. If a settlement holds the row, the heartbeat waits. After the
-- settlement commits, the heartbeat finds the lease stale but keeps the row lock until its own
-- transaction ends, so a claim, which uses SKIP LOCKED, skips the ready task. A mixed batch also
-- called the blocking heartbeat_v1 for each lease.
--
-- heartbeat_many_v2 takes the same input. It locks with FOR NO KEY UPDATE SKIP LOCKED on both
-- tiers and reads the clock after both lock steps. Each UPDATE changes only a row that the
-- function locked, and it keeps the worker, fence, and active-state filters. A lease whose row it
-- did not lock, and whose active generation a plain read still shows, gets the status busy: no
-- renewal and no ownership verdict. Any other lease that no UPDATE matched is stale, as in v1.
-- SKIP LOCKED does not skip every wait: a row whose newer version another transaction locks can
-- still make the lock step wait (ADR 0081), so the server timeouts of a bounded round stay.
--
-- heartbeat_many_v1 does not change. A worker that does not know the busy status keeps calling it.
-- No change touches stored data.

CREATE OR REPLACE FUNCTION workhorse.heartbeat_many_v2(
  p_worker_id text, p_leases jsonb
) RETURNS TABLE (ordinal bigint, task_id uuid, status text)
LANGUAGE plpgsql
AS $$
#variable_conflict use_column
DECLARE
  v_now timestamptz;
  v_task_ids uuid[];
  v_fast_locked uuid[];
  v_full_locked uuid[];
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
  v_task_ids := ARRAY(SELECT (item->>'taskId')::uuid FROM jsonb_array_elements(p_leases) item);
  -- Lock each tier in task ID order and skip a row that another transaction locks. A task that
  -- moved between the tiers since the worker claimed it is in neither locked set.
  SELECT COALESCE(array_agg(locked.task_id), '{}') INTO v_fast_locked FROM (
    SELECT fast.task_id FROM workhorse.fast_task_runtime fast
     WHERE fast.task_id = ANY (v_task_ids) AND fast.worker_id = p_worker_id
     ORDER BY fast.task_id
       FOR NO KEY UPDATE SKIP LOCKED
  ) locked;
  SELECT COALESCE(array_agg(locked.task_id), '{}') INTO v_full_locked FROM (
    SELECT runtime.task_id FROM workhorse.task_runtime runtime
     WHERE runtime.task_id = ANY (v_task_ids) AND runtime.worker_id = p_worker_id
     ORDER BY runtime.task_id
       FOR NO KEY UPDATE SKIP LOCKED
  ) locked;
  -- Sample time only after both lock steps, so a renewed lease starts from the time it was granted.
  v_now := clock_timestamp();
  RETURN QUERY
  WITH leases AS MATERIALIZED (
    SELECT item.ordinality AS ordinal,
           (item.value->>'taskId')::uuid AS task_id,
           (item.value->>'fenceToken')::bigint AS fence_token,
           (item.value->>'leaseMs')::integer AS lease_ms
      FROM jsonb_array_elements(p_leases) WITH ORDINALITY AS item(value, ordinality)
  ), targets AS (
    -- One target for each named generation. A lease named twice gets one renewal, with the
    -- longer duration, and each of its input entries gets that result.
    SELECT lease.task_id, lease.fence_token, max(lease.lease_ms) AS lease_ms
      FROM leases lease
     GROUP BY lease.task_id, lease.fence_token
  ), fast_heartbeated AS (
    UPDATE workhorse.fast_task_runtime runtime
       SET expires_at = CASE
             WHEN runtime.cancel_requested_at IS NULL
               AND (runtime.deadline_at IS NULL OR runtime.deadline_at > v_now)
               AND (runtime.attempt_timeout_at IS NULL OR runtime.attempt_timeout_at > v_now)
               AND runtime.expires_at > v_now
             THEN v_now + lease.lease_ms * interval '1 millisecond'
             ELSE runtime.expires_at END
      FROM targets lease
     WHERE runtime.task_id = ANY (v_fast_locked)
       AND runtime.task_id = lease.task_id AND runtime.state = 'active'
       AND runtime.worker_id = p_worker_id AND runtime.fence_token = lease.fence_token
    RETURNING runtime.task_id, lease.fence_token,
      CASE
        WHEN runtime.cancel_requested_at IS NOT NULL THEN 'cancel_requested'
        WHEN runtime.deadline_at IS NOT NULL AND runtime.deadline_at <= v_now THEN 'deadline_exceeded'
        WHEN runtime.attempt_timeout_at IS NOT NULL AND runtime.attempt_timeout_at <= v_now THEN 'timeout_exceeded'
        WHEN runtime.expires_at <= v_now THEN 'stale'
        ELSE 'accepted'
      END AS status
  ), full_heartbeated AS (
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
      FROM targets lease
     WHERE runtime.task_id = ANY (v_full_locked)
       AND runtime.task_id = lease.task_id AND runtime.state = 'active'
       AND runtime.worker_id = p_worker_id AND runtime.fence_token = lease.fence_token
    RETURNING runtime.task_id, lease.fence_token,
      CASE
        WHEN runtime.cancel_requested_at IS NOT NULL THEN 'cancel_requested'
        WHEN runtime.deadline_at IS NOT NULL AND runtime.deadline_at <= v_now THEN 'deadline_exceeded'
        WHEN runtime.attempt_timeout_at IS NOT NULL AND runtime.attempt_timeout_at <= v_now THEN 'timeout_exceeded'
        WHEN runtime.expires_at <= v_now THEN 'stale'
        ELSE 'accepted'
      END AS status
  ), heartbeated AS (
    SELECT * FROM fast_heartbeated UNION ALL SELECT * FROM full_heartbeated
  )
  SELECT lease.ordinal, lease.task_id,
         CASE
           WHEN heartbeated.status IS NOT NULL THEN heartbeated.status
           -- The function did not lock the row, and the snapshot of this statement still shows the
           -- generation active. Another transaction holds the row. This is no ownership verdict.
           WHEN lease.task_id <> ALL (v_fast_locked) AND lease.task_id <> ALL (v_full_locked)
             AND (
               EXISTS (
                 SELECT 1 FROM workhorse.fast_task_runtime fast
                  WHERE fast.task_id = lease.task_id AND fast.state = 'active'
                    AND fast.worker_id = p_worker_id AND fast.fence_token = lease.fence_token
               )
               OR EXISTS (
                 SELECT 1 FROM workhorse.task_runtime runtime
                  WHERE runtime.task_id = lease.task_id AND runtime.state = 'active'
                    AND runtime.worker_id = p_worker_id AND runtime.fence_token = lease.fence_token
               )
             )
           THEN 'busy'
           ELSE 'stale'
         END
    FROM leases lease
    LEFT JOIN heartbeated
      ON heartbeated.task_id = lease.task_id AND heartbeated.fence_token = lease.fence_token
   ORDER BY lease.ordinal;
END;
$$;
