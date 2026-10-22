-- workhorse-migration: {"kind":"additive"}

-- Fence the worker deregistration by instance (SM-1589, SM-1581).

-- deregister_worker_v1 deletes the registry row by worker ID only. A worker stops, and its stop
-- path is slow. The same worker ID starts again and writes a new row with a new instance_id. Then
-- the late deregistration of the old run deletes the row of the new run, and with it the operator
-- pause state. Each SDK guarded against this in its own code.
--
-- deregister_worker_v2 deletes the row only while it still names the instance of the caller.
-- worker_registry.instance_id already identifies one run of a worker, and register_worker_v1
-- replaces it when a new run registers. A stale deregistration thus deletes nothing and returns
-- false.
--
-- deregister_worker_v1 does not change, so a released SDK keeps its behavior. The function adds no
-- table and no index. No change touches stored data.

CREATE OR REPLACE FUNCTION workhorse.deregister_worker_v2(p_worker_id text, p_instance_id uuid)
RETURNS boolean
LANGUAGE plpgsql
AS $$
DECLARE
  v_deleted integer;
BEGIN
  IF p_worker_id IS NULL OR p_worker_id = '' THEN
    RAISE EXCEPTION 'worker_id must not be empty';
  END IF;
  IF p_instance_id IS NULL THEN
    RAISE EXCEPTION 'instance_id must not be null';
  END IF;
  DELETE FROM workhorse.worker_registry
   WHERE worker_id = p_worker_id
     AND instance_id = p_instance_id;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted > 0;
END;
$$;
