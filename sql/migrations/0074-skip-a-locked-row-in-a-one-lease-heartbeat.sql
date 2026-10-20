-- workhorse-migration: {"kind":"additive"}

-- Skip a locked row in a one-lease heartbeat and report the lease as busy (SM-1461, ADR 0105).

-- heartbeat_v1 renews one lease. It locks the row with FOR NO KEY UPDATE and waits for a row that
-- another transaction locks, as heartbeat_many_v1 does. Migration 0073 gave the batch a successor,
-- heartbeat_many_v2, which skips a locked row and reports the lease as busy.
--
-- heartbeat_v2 takes the same input as heartbeat_v1 and checks it with the same messages. A null
-- task ID or fence token names no generation, so the function returns stale, as heartbeat_v1 does.
-- Every other call returns the status that heartbeat_many_v2 gives the one lease. Thus the lock
-- step, the clock sample after the lock step, the UPDATE filters, and the busy rule are the rules
-- of heartbeat_many_v2, on both tiers.
--
-- heartbeat_v1 does not change. A caller that does not know the busy status keeps calling it.
-- No change touches stored data.

CREATE OR REPLACE FUNCTION workhorse.heartbeat_v2(
  p_task_id uuid, p_worker_id text, p_fence_token bigint, p_lease_ms integer DEFAULT 30000
) RETURNS text
LANGUAGE plpgsql
AS $$
BEGIN
  IF p_worker_id IS NULL OR p_worker_id = '' THEN RAISE EXCEPTION 'worker_id must not be empty'; END IF;
  IF p_lease_ms IS NULL OR p_lease_ms NOT BETWEEN 100 AND 86400000 THEN
    RAISE EXCEPTION 'lease_ms must be between 100 and 86400000';
  END IF;
  IF p_task_id IS NULL OR p_fence_token IS NULL THEN RETURN 'stale'; END IF;
  RETURN (
    SELECT beat.status FROM workhorse.heartbeat_many_v2(
      p_worker_id,
      jsonb_build_array(jsonb_build_object(
        'taskId', p_task_id, 'fenceToken', p_fence_token, 'leaseMs', p_lease_ms
      ))
    ) beat
  );
END;
$$;
