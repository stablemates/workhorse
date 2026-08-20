-- Let one worker advertise and serve several queues while preserving the version 1 SQL call.

ALTER TABLE workhorse.worker_registry ADD COLUMN queue_names text[];
UPDATE workhorse.worker_registry SET queue_names = ARRAY[queue_name];
ALTER TABLE workhorse.worker_registry
  ALTER COLUMN queue_names SET NOT NULL,
  ADD CHECK (
    cardinality(queue_names) >= 1
    AND array_position(queue_names, NULL) IS NULL
    AND array_position(queue_names, '') IS NULL
  );

CREATE OR REPLACE FUNCTION workhorse.register_worker_v2(
  p_worker_id text,
  p_instance_id uuid,
  p_hostname text,
  p_pid integer,
  p_queue_names text[],
  p_concurrency integer,
  p_lease_ms integer,
  p_heartbeat_ms integer,
  p_poll_ms integer,
  p_maintenance_interval_ms integer,
  p_maintenance_task_poll_ms integer,
  p_registry_interval_ms integer,
  p_active_slots integer,
  p_draining boolean
)
RETURNS boolean
LANGUAGE plpgsql
AS $$
DECLARE
  v_paused boolean;
BEGIN
  IF p_worker_id IS NULL OR p_worker_id = '' THEN
    RAISE EXCEPTION 'worker_id must not be empty';
  END IF;
  IF p_instance_id IS NULL THEN
    RAISE EXCEPTION 'instance_id must not be null';
  END IF;
  IF p_queue_names IS NULL OR cardinality(p_queue_names) = 0
     OR EXISTS (SELECT 1 FROM unnest(p_queue_names) queue_name WHERE queue_name IS NULL OR queue_name = '')
     OR cardinality(p_queue_names) <> (SELECT count(DISTINCT queue_name) FROM unnest(p_queue_names) queue_name) THEN
    RAISE EXCEPTION 'queue_names must contain distinct non-empty names';
  END IF;
  IF p_hostname IS NULL OR p_hostname = '' THEN
    RAISE EXCEPTION 'hostname must not be empty';
  END IF;
  IF p_pid IS NULL OR p_pid <= 0 THEN
    RAISE EXCEPTION 'pid must be positive';
  END IF;

  INSERT INTO workhorse.worker_registry AS registry
    (worker_id, instance_id, hostname, pid, queue_names, queue_name, concurrency, lease_ms, heartbeat_ms,
     poll_ms, maintenance_interval_ms, maintenance_task_poll_ms, registry_interval_ms,
     active_slots, draining)
  VALUES (p_worker_id, p_instance_id, p_hostname, p_pid, p_queue_names, p_queue_names[1], p_concurrency,
          p_lease_ms, p_heartbeat_ms, p_poll_ms, p_maintenance_interval_ms,
          p_maintenance_task_poll_ms, p_registry_interval_ms,
          COALESCE(p_active_slots, 0), COALESCE(p_draining, false))
  ON CONFLICT (worker_id) DO UPDATE
    SET instance_id = EXCLUDED.instance_id,
        hostname = EXCLUDED.hostname,
        pid = EXCLUDED.pid,
        queue_names = EXCLUDED.queue_names,
        queue_name = EXCLUDED.queue_name,
        concurrency = EXCLUDED.concurrency,
        lease_ms = EXCLUDED.lease_ms,
        heartbeat_ms = EXCLUDED.heartbeat_ms,
        poll_ms = EXCLUDED.poll_ms,
        maintenance_interval_ms = EXCLUDED.maintenance_interval_ms,
        maintenance_task_poll_ms = EXCLUDED.maintenance_task_poll_ms,
        registry_interval_ms = EXCLUDED.registry_interval_ms,
        active_slots = EXCLUDED.active_slots,
        draining = EXCLUDED.draining,
        last_heartbeat_at = clock_timestamp(),
        -- A new incarnation of this worker id is a different process, so it starts running and
        -- inherits no operator decision made about the process it replaced.
        started_at = CASE
          WHEN registry.instance_id = EXCLUDED.instance_id THEN registry.started_at
          ELSE clock_timestamp()
        END,
        paused = CASE
          WHEN registry.instance_id = EXCLUDED.instance_id THEN registry.paused
          ELSE false
        END,
        paused_by = CASE
          WHEN registry.instance_id = EXCLUDED.instance_id THEN registry.paused_by
          ELSE NULL
        END,
        paused_reason = CASE
          WHEN registry.instance_id = EXCLUDED.instance_id THEN registry.paused_reason
          ELSE NULL
        END,
        paused_at = CASE
          WHEN registry.instance_id = EXCLUDED.instance_id THEN registry.paused_at
          ELSE NULL
        END
  RETURNING registry.paused INTO v_paused;

  RETURN v_paused;
END;
$$;

CREATE OR REPLACE FUNCTION workhorse.register_worker_v1(
  p_worker_id text,
  p_instance_id uuid,
  p_hostname text,
  p_pid integer,
  p_queue_name text,
  p_concurrency integer,
  p_lease_ms integer,
  p_heartbeat_ms integer,
  p_poll_ms integer,
  p_maintenance_interval_ms integer,
  p_maintenance_task_poll_ms integer,
  p_registry_interval_ms integer,
  p_active_slots integer,
  p_draining boolean
)
RETURNS boolean
LANGUAGE sql
AS $$
  SELECT workhorse.register_worker_v2(
    p_worker_id, p_instance_id, p_hostname, p_pid, ARRAY[p_queue_name], p_concurrency,
    p_lease_ms, p_heartbeat_ms, p_poll_ms, p_maintenance_interval_ms,
    p_maintenance_task_poll_ms, p_registry_interval_ms, p_active_slots, p_draining
  )
$$;

CREATE OR REPLACE VIEW workhorse.dashboard_worker_registry_v1 AS
  SELECT worker_id, hostname, pid, queue_name, concurrency, lease_ms, heartbeat_ms, poll_ms,
         maintenance_interval_ms, maintenance_task_poll_ms, registry_interval_ms, active_slots,
         draining, paused, started_at, last_heartbeat_at, queue_names FROM workhorse.worker_registry;
