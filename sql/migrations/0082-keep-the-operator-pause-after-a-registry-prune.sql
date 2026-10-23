-- workhorse-migration: {"kind":"additive"}

-- Keep an operator pause when maintenance prunes the registration of a live instance (SM-1646).

-- An operator pauses worker instance w1. A network partition stops w1 from refreshing its
-- registration for 70 seconds, and maintenance prunes the stale row after one minute. Then w1
-- registers again. register_worker_v1 inserts a new row with paused = false, and w1 starts to claim
-- tasks. No operator ended the pause.
--
-- This step adds workhorse.worker_pause_tombstone. When prune_worker_registry_v1 removes a paused
-- row, it keeps the pause there with the instance ID and an expiry. If the same instance registers
-- again before the expiry, register_worker_v1 restores the pause. A new instance still starts
-- running. An operator resume, a deregistration of the instance, or the expiry removes the kept
-- pause. The expiry is one day or three registration intervals, whichever is longer.
--
-- prune_worker_registry_v1 also keeps each row for at least three of its own registration
-- intervals. Before this step, a worker with a registration interval above one minute could lose
-- its row between two healthy refreshes.
--
-- Registration, resume, deregistration, and pruning of one worker ID now take one transaction
-- advisory lock. Pruning only tries the lock and skips a busy worker ID, so it cannot deadlock.
--
-- No signature changes. No change touches stored data.

CREATE TABLE IF NOT EXISTS workhorse.worker_pause_tombstone (
  worker_id text PRIMARY KEY CHECK (worker_id <> ''),
  instance_id uuid NOT NULL,
  paused_by text CHECK (paused_by IS NULL OR paused_by <> ''),
  paused_reason text CHECK (paused_reason IS NULL OR paused_reason <> ''),
  paused_request_id_preview text,
  paused_request_id_digest text CHECK (
    paused_request_id_digest IS NULL OR char_length(paused_request_id_digest) = 12
  ),
  paused_request_id_length integer CHECK (
    paused_request_id_length IS NULL OR paused_request_id_length BETWEEN 1 AND 512
  ),
  paused_at timestamptz,
  pruned_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS worker_pause_tombstone_expires_idx
  ON workhorse.worker_pause_tombstone (expires_at);

CREATE OR REPLACE FUNCTION workhorse.register_worker_v1(
  p_worker_id text,
  p_instance_id uuid,
  p_hostname text,
  p_pid integer,
  p_queue_names text[],
  p_schedule_namespaces text[],
  p_concurrency integer,
  p_lease_ms integer,
  p_heartbeat_ms integer,
  p_poll_ms integer,
  p_maintenance_interval_ms integer,
  p_maintenance_routine_poll_ms integer,
  p_registry_interval_ms integer,
  p_active_slots integer,
  p_draining boolean,
  p_client_protocol_version integer,
  p_sdk_language text,
  p_sdk_version text
)
RETURNS boolean
LANGUAGE plpgsql
AS $$
DECLARE
  v_paused boolean;
  v_tombstone workhorse.worker_pause_tombstone%ROWTYPE;
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
  IF p_schedule_namespaces IS NULL
     OR EXISTS (
       SELECT 1 FROM unnest(p_schedule_namespaces) namespace
        WHERE namespace IS NULL OR namespace = ''
     )
     OR cardinality(p_schedule_namespaces) <>
       (SELECT count(DISTINCT namespace) FROM unnest(p_schedule_namespaces) namespace) THEN
    RAISE EXCEPTION 'schedule_namespaces must contain distinct non-empty names';
  END IF;
  IF p_hostname IS NULL OR p_hostname = '' THEN
    RAISE EXCEPTION 'hostname must not be empty';
  END IF;
  IF p_pid IS NULL OR p_pid <= 0 THEN
    RAISE EXCEPTION 'pid must be positive';
  END IF;
  -- A worker that reports nothing is expected and registers unchanged. A worker that reports a
  -- value has to mean it, because an operator reads these to decide whether to drop a protocol.
  IF p_client_protocol_version IS NOT NULL AND p_client_protocol_version < 1 THEN
    RAISE EXCEPTION 'client_protocol_version must be positive when supplied';
  END IF;
  IF p_sdk_language IS NOT NULL AND (p_sdk_language = '' OR char_length(p_sdk_language) > 40) THEN
    RAISE EXCEPTION 'sdk_language must be 1 to 40 characters when supplied';
  END IF;
  IF p_sdk_version IS NOT NULL AND (p_sdk_version = '' OR char_length(p_sdk_version) > 64) THEN
    RAISE EXCEPTION 'sdk_version must be 1 to 64 characters when supplied';
  END IF;

  -- Registration, resume, deregistration, and pruning of one worker ID run one at a time. Without
  -- this lock, a resume could miss the uncommitted row of a registration that restores a kept
  -- pause, and the worker would stay paused after the resume.
  PERFORM pg_advisory_xact_lock(hashtextextended('workhorse:worker-registry:' || p_worker_id, 0));

  INSERT INTO workhorse.worker_registry AS registry
    (worker_id, instance_id, hostname, pid, queue_names, schedule_namespaces, queue_name,
     concurrency, lease_ms, heartbeat_ms,
     poll_ms, maintenance_interval_ms, maintenance_routine_poll_ms, registry_interval_ms,
     active_slots, draining, client_protocol_version, sdk_language, sdk_version)
  VALUES (p_worker_id, p_instance_id, p_hostname, p_pid, p_queue_names, p_schedule_namespaces,
          p_queue_names[1], p_concurrency,
          p_lease_ms, p_heartbeat_ms, p_poll_ms, p_maintenance_interval_ms,
          p_maintenance_routine_poll_ms, p_registry_interval_ms,
          COALESCE(p_active_slots, 0), COALESCE(p_draining, false),
          p_client_protocol_version, p_sdk_language, p_sdk_version)
  ON CONFLICT (worker_id) DO UPDATE
    SET instance_id = EXCLUDED.instance_id,
        hostname = EXCLUDED.hostname,
        pid = EXCLUDED.pid,
        queue_names = EXCLUDED.queue_names,
        schedule_namespaces = EXCLUDED.schedule_namespaces,
        queue_name = EXCLUDED.queue_name,
        concurrency = EXCLUDED.concurrency,
        lease_ms = EXCLUDED.lease_ms,
        heartbeat_ms = EXCLUDED.heartbeat_ms,
        poll_ms = EXCLUDED.poll_ms,
        maintenance_interval_ms = EXCLUDED.maintenance_interval_ms,
        maintenance_routine_poll_ms = EXCLUDED.maintenance_routine_poll_ms,
        registry_interval_ms = EXCLUDED.registry_interval_ms,
        active_slots = EXCLUDED.active_slots,
        draining = EXCLUDED.draining,
        -- Overwritten rather than merged, so a downgraded worker stops claiming the build it no
        -- longer runs. What this refresh reported is the whole truth about this process.
        client_protocol_version = EXCLUDED.client_protocol_version,
        sdk_language = EXCLUDED.sdk_language,
        sdk_version = EXCLUDED.sdk_version,
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
        paused_request_id_preview = CASE
          WHEN registry.instance_id = EXCLUDED.instance_id THEN registry.paused_request_id_preview
          ELSE NULL
        END,
        paused_request_id_digest = CASE
          WHEN registry.instance_id = EXCLUDED.instance_id THEN registry.paused_request_id_digest
          ELSE NULL
        END,
        paused_request_id_length = CASE
          WHEN registry.instance_id = EXCLUDED.instance_id THEN registry.paused_request_id_length
          ELSE NULL
        END,
        paused_at = CASE
          WHEN registry.instance_id = EXCLUDED.instance_id THEN registry.paused_at
          ELSE NULL
        END
  RETURNING registry.paused INTO v_paused;

  -- Maintenance can prune the row of a live instance that missed its refreshes. A kept pause of
  -- this instance comes back with the new row. A kept pause of another instance ends, because a
  -- new instance starts running. This statement runs after the upsert, so it also sees a kept
  -- pause that a concurrent prune committed while the upsert waited for the row lock.
  DELETE FROM workhorse.worker_pause_tombstone tombstone
   WHERE tombstone.worker_id = p_worker_id
  RETURNING tombstone.* INTO v_tombstone;
  IF FOUND AND v_tombstone.instance_id = p_instance_id
     AND v_tombstone.expires_at > clock_timestamp() THEN
    UPDATE workhorse.worker_registry registry
       SET paused = true,
           paused_by = v_tombstone.paused_by,
           paused_reason = v_tombstone.paused_reason,
           paused_request_id_preview = v_tombstone.paused_request_id_preview,
           paused_request_id_digest = v_tombstone.paused_request_id_digest,
           paused_request_id_length = v_tombstone.paused_request_id_length,
           paused_at = v_tombstone.paused_at
     WHERE registry.worker_id = p_worker_id
       AND registry.instance_id = p_instance_id;
    v_paused := true;
  END IF;

  RETURN v_paused;
END;
$$;

CREATE OR REPLACE FUNCTION workhorse.deregister_worker_v1(p_worker_id text)
RETURNS boolean
LANGUAGE plpgsql
AS $$
DECLARE
  v_deleted integer;
BEGIN
  IF p_worker_id IS NULL OR p_worker_id = '' THEN
    RAISE EXCEPTION 'worker_id must not be empty';
  END IF;
  -- The same lock as register_worker_v1, so a deregistration cannot interleave with a registration.
  PERFORM pg_advisory_xact_lock(hashtextextended('workhorse:worker-registry:' || p_worker_id, 0));
  DELETE FROM workhorse.worker_registry WHERE worker_id = p_worker_id;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  DELETE FROM workhorse.worker_pause_tombstone WHERE worker_id = p_worker_id;
  RETURN v_deleted > 0;
END;
$$;

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
  -- The same lock as register_worker_v1, so a deregistration cannot interleave with a registration.
  PERFORM pg_advisory_xact_lock(hashtextextended('workhorse:worker-registry:' || p_worker_id, 0));
  DELETE FROM workhorse.worker_registry
   WHERE worker_id = p_worker_id
     AND instance_id = p_instance_id;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  -- The instance ends, so its kept pause ends too. A kept pause of another instance stays.
  DELETE FROM workhorse.worker_pause_tombstone
   WHERE worker_id = p_worker_id
     AND instance_id = p_instance_id;
  RETURN v_deleted > 0;
END;
$$;

CREATE OR REPLACE FUNCTION workhorse.set_worker_paused_internal_v1(
  p_worker_id text,
  p_paused boolean,
  p_requested_by text DEFAULT NULL,
  p_reason text DEFAULT NULL
)
RETURNS TABLE (
  worker_id text,
  paused boolean,
  paused_by text,
  paused_reason text,
  paused_at timestamptz,
  last_heartbeat_at timestamptz
)
LANGUAGE plpgsql
AS $$
BEGIN
  IF p_worker_id IS NULL OR p_worker_id = '' THEN
    RAISE EXCEPTION 'worker_id must not be empty';
  END IF;
  IF p_paused IS NULL THEN
    RAISE EXCEPTION 'paused must not be null';
  END IF;

  -- The same lock as register_worker_v1. A resume thus sees the row that a concurrent registration
  -- writes, also when that registration restores a kept pause.
  PERFORM pg_advisory_xact_lock(hashtextextended('workhorse:worker-registry:' || p_worker_id, 0));

  RETURN QUERY
  UPDATE workhorse.worker_registry AS registry
     SET paused = p_paused,
         paused_by = CASE WHEN p_paused THEN NULLIF(p_requested_by, '') ELSE NULL END,
         paused_reason = CASE WHEN p_paused THEN NULLIF(p_reason, '') ELSE NULL END,
         paused_at = CASE WHEN p_paused THEN clock_timestamp() ELSE NULL END
   WHERE registry.worker_id = p_worker_id
  RETURNING registry.worker_id, registry.paused, registry.paused_by, registry.paused_reason,
            registry.paused_at, registry.last_heartbeat_at;

  -- A resume also ends a pause that maintenance kept after it pruned the registration.
  IF NOT p_paused THEN
    DELETE FROM workhorse.worker_pause_tombstone tombstone
     WHERE tombstone.worker_id = p_worker_id;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION workhorse.prune_worker_registry_v1(
  p_max_age interval DEFAULT interval '1 day'
)
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  v_now timestamptz := clock_timestamp();
  v_count integer;
BEGIN
  WITH pruned AS (
    DELETE FROM workhorse.worker_registry registry
     WHERE registry.last_heartbeat_at < v_now - interval '1 minute'
       -- The CASE takes the lock of a worker ID only for a stale row. A try-lock skips a worker
       -- whose registration, resume, or deregistration runs now, and it cannot deadlock.
       AND CASE
         WHEN registry.last_heartbeat_at < v_now - GREATEST(
           p_max_age,
           interval '1 minute',
           make_interval(secs => registry.registry_interval_ms::bigint * 3 / 1000.0)
         )
         THEN pg_try_advisory_xact_lock(
           hashtextextended('workhorse:worker-registry:' || registry.worker_id, 0)
         )
         ELSE false
       END
    RETURNING registry.*
  ), kept AS (
    INSERT INTO workhorse.worker_pause_tombstone AS tombstone
      (worker_id, instance_id, paused_by, paused_reason, paused_request_id_preview,
       paused_request_id_digest, paused_request_id_length, paused_at, pruned_at, expires_at)
    SELECT pruned.worker_id, pruned.instance_id, pruned.paused_by, pruned.paused_reason,
           pruned.paused_request_id_preview, pruned.paused_request_id_digest,
           pruned.paused_request_id_length, pruned.paused_at, v_now,
           v_now + GREATEST(
             interval '1 day',
             make_interval(secs => pruned.registry_interval_ms::bigint * 3 / 1000.0)
           )
      FROM pruned
     WHERE pruned.paused
    ON CONFLICT (worker_id) DO UPDATE
      SET instance_id = EXCLUDED.instance_id,
          paused_by = EXCLUDED.paused_by,
          paused_reason = EXCLUDED.paused_reason,
          paused_request_id_preview = EXCLUDED.paused_request_id_preview,
          paused_request_id_digest = EXCLUDED.paused_request_id_digest,
          paused_request_id_length = EXCLUDED.paused_request_id_length,
          paused_at = EXCLUDED.paused_at,
          pruned_at = EXCLUDED.pruned_at,
          expires_at = EXCLUDED.expires_at
  )
  SELECT count(*)::integer INTO v_count FROM pruned;

  DELETE FROM workhorse.worker_pause_tombstone tombstone
   WHERE CASE
     WHEN tombstone.expires_at <= v_now
     THEN pg_try_advisory_xact_lock(
       hashtextextended('workhorse:worker-registry:' || tombstone.worker_id, 0)
     )
     ELSE false
   END;

  RETURN v_count;
END;
$$;
