-- Record what each registering worker is, not only where it runs.
--
-- `workhorse schema contract` may only remove a superseded function once no worker still speaks the
-- protocol it serves, and `workhorse.worker_registry` held nothing that could answer that
-- ([ADR 0057](../../docs/decisions/0057-retain-superseded-functions-and-contract-on-the-operators-schedule.md)).
-- The same three columns answer the everyday question a rolling deploy raises, which is which build
-- one worker is running.
--
-- Every column is nullable and `register_worker_v1` is retained, so a fleet part-way through a
-- rollout keeps registering with no coordination.

ALTER TABLE workhorse.worker_registry
  ADD COLUMN client_protocol_version integer CHECK (
    client_protocol_version IS NULL OR client_protocol_version >= 1
  ),
  ADD COLUMN sdk_language text CHECK (
    sdk_language IS NULL OR (sdk_language <> '' AND char_length(sdk_language) <= 40)
  ),
  ADD COLUMN sdk_version text CHECK (
    sdk_version IS NULL OR (sdk_version <> '' AND char_length(sdk_version) <= 64)
  );

-- Announce or refresh one worker registration and read back the operator-requested pause flag.
--
-- This is intentionally a single round trip: the worker pushes the runtime state it owns and pulls
-- the pause decision PostgreSQL owns.
--
-- Operator pause is deliberately **process-scoped**. A heartbeat from the same instance preserves
-- the flag; a new instance of the same worker id clears it, so a restarted or replaced worker
-- always comes back running. The durable lever for "stop processing this work" is queue pause,
-- which is keyed by queue name and unaffected by worker lifecycles. Keeping the two distinct means
-- a pause can never become a forgotten flag that silently idles a worker after a later deployment.
--
-- The last three arguments are what the process is rather than what it is doing, and every one of
-- them may be NULL: a worker built before they existed keeps registering, and its row says so.
CREATE OR REPLACE FUNCTION workhorse.register_worker_v2(
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
  p_maintenance_task_poll_ms integer,
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

  INSERT INTO workhorse.worker_registry AS registry
    (worker_id, instance_id, hostname, pid, queue_names, schedule_namespaces, queue_name,
     concurrency, lease_ms, heartbeat_ms,
     poll_ms, maintenance_interval_ms, maintenance_task_poll_ms, registry_interval_ms,
     active_slots, draining, client_protocol_version, sdk_language, sdk_version)
  VALUES (p_worker_id, p_instance_id, p_hostname, p_pid, p_queue_names, p_schedule_namespaces,
          p_queue_names[1], p_concurrency,
          p_lease_ms, p_heartbeat_ms, p_poll_ms, p_maintenance_interval_ms,
          p_maintenance_task_poll_ms, p_registry_interval_ms,
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
        maintenance_task_poll_ms = EXCLUDED.maintenance_task_poll_ms,
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

  RETURN v_paused;
END;
$$;

-- Version 1 of the same call, retained for workers built before the client identity columns
-- existed ([ADR 0053](../../docs/decisions/0053-start-migrations-at-0-1-0-and-keep-them-additive.md)).
-- It reports no protocol or SDK, which is a fact about the caller and is stored as such: a worker
-- that has been downgraded stops claiming the build it no longer runs.
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
  p_maintenance_task_poll_ms integer,
  p_registry_interval_ms integer,
  p_active_slots integer,
  p_draining boolean
)
RETURNS boolean
LANGUAGE sql
AS $$
  SELECT workhorse.register_worker_v2(
    p_worker_id, p_instance_id, p_hostname, p_pid, p_queue_names, p_schedule_namespaces,
    p_concurrency, p_lease_ms, p_heartbeat_ms, p_poll_ms, p_maintenance_interval_ms,
    p_maintenance_task_poll_ms, p_registry_interval_ms, p_active_slots, p_draining,
    NULL::integer, NULL::text, NULL::text);
$$;

-- Which client protocol versions the visible fleet is still speaking.
--
-- `workhorse schema contract` removes superseded functions and narrows
-- `workhorse.protocol_version`, which stops every process that speaks a removed protocol. Before an
-- operator does that, they need to know whether anything still speaks the one being retired.
--
-- Liveness is each worker's own lease rather than a fixed window, because a worker configured with
-- a long lease is not late until that lease says so. A worker that reported no protocol version is
-- counted under NULL: it is a build old enough to predate the column, so it is exactly the
-- population an operator must not assume away.
--
-- This is evidence, not an inventory. Producers never register, so the absence of a protocol here
-- does not prove the absence of a caller speaking it.
CREATE OR REPLACE FUNCTION workhorse.worker_client_protocols_v1()
RETURNS TABLE (client_protocol_version integer, workers integer)
LANGUAGE sql
STABLE
AS $$
  SELECT registry.client_protocol_version, count(*)::integer AS workers
    FROM workhorse.worker_registry registry
   WHERE registry.last_heartbeat_at
         >= clock_timestamp() - make_interval(secs => registry.lease_ms / 1000.0)
   GROUP BY registry.client_protocol_version
   ORDER BY registry.client_protocol_version NULLS LAST;
$$;

CREATE OR REPLACE VIEW workhorse.dashboard_worker_registry_v1 AS
  SELECT worker_id, hostname, pid, queue_name, concurrency, lease_ms, heartbeat_ms, poll_ms,
         maintenance_interval_ms, maintenance_task_poll_ms, registry_interval_ms, active_slots,
         draining, paused, started_at, last_heartbeat_at, queue_names, schedule_namespaces,
         client_protocol_version, sdk_language, sdk_version
    FROM workhorse.worker_registry;

CREATE OR REPLACE FUNCTION workhorse.dashboard_workers_v1(p_input jsonb)
RETURNS jsonb
LANGUAGE sql
AS $$
  WITH configured_workers AS (
    SELECT jsonb_array_elements_text(
             CASE WHEN jsonb_typeof(p_input->'configuredWorkers') = 'array'
                  THEN p_input->'configuredWorkers' END
           ) AS id
  ), fleet AS (
    SELECT worker_id AS id FROM workhorse.dashboard_worker_registry_v1
    UNION SELECT id FROM configured_workers
  ), active AS (
    SELECT worker_id AS id, count(*)::integer AS active_jobs, max(acquired_at) AS last_seen_at
      FROM workhorse.dashboard_job_runtime_v1
     WHERE state = 'active' AND worker_id IN (SELECT id FROM fleet)
     GROUP BY worker_id
  ), recent_history AS (
    SELECT worker_id AS id, count(*)::integer AS completed_attempts,
           count(*) FILTER (WHERE outcome = 'failed')::integer AS failed_attempts,
           avg(extract(epoch FROM finished_at - claimed_at) * 1000)::double precision
             AS average_execution_ms,
           max(finished_at) AS last_seen_at
      FROM workhorse.dashboard_attempt_history_v1
     WHERE occurred_at >= clock_timestamp() - interval '1 hour'
       AND finished_at >= clock_timestamp() - interval '1 hour'
       AND worker_id IN (SELECT id FROM fleet)
     GROUP BY worker_id
  ), workers AS (
    SELECT fleet.id, registry.worker_id IS NOT NULL AS registered,
           registry.hostname, registry.pid, registry.queue_names, registry.schedule_namespaces,
           registry.concurrency,
           registry.active_slots, registry.draining, registry.paused, registry.started_at,
           registry.last_heartbeat_at, registry.sdk_language, registry.sdk_version,
           COALESCE(active.active_jobs, 0)::integer AS active_jobs,
           COALESCE(recent_history.completed_attempts, 0)::integer AS completed_attempts,
           COALESCE(recent_history.failed_attempts, 0)::integer AS failed_attempts,
           recent_history.average_execution_ms,
           GREATEST(active.last_seen_at, recent_history.last_seen_at,
                    registry.last_heartbeat_at) AS last_seen_at
      FROM fleet
      LEFT JOIN workhorse.dashboard_worker_registry_v1 registry
        ON registry.worker_id = fleet.id
      LEFT JOIN active ON active.id = fleet.id
      LEFT JOIN recent_history ON recent_history.id = fleet.id
  )
  SELECT jsonb_build_object(
    'capturedAt', workhorse.dashboard_iso_v1(clock_timestamp()),
    'canManageWorkers', COALESCE((p_input->>'canManageWorkers')::boolean, false),
    'workers', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', id, 'queues', COALESCE(to_jsonb(queue_names), '[]'::jsonb),
        'scheduleNamespaces', COALESCE(to_jsonb(schedule_namespaces), '[]'::jsonb),
        'hostname', hostname, 'pid', pid, 'activeJobs', active_jobs,
        'concurrency', concurrency, 'activeSlots', active_slots,
        'draining', COALESCE(draining, false), 'completedAttempts', completed_attempts,
        'failedAttempts', failed_attempts, 'averageExecutionMs', average_execution_ms,
        'lastSeenAt', workhorse.dashboard_iso_v1(last_seen_at),
        'startedAt', workhorse.dashboard_iso_v1(started_at), 'registered', registered,
        'lastHeartbeatAt', workhorse.dashboard_iso_v1(last_heartbeat_at),
        'paused', COALESCE(paused, false),
        'sdkLanguage', sdk_language, 'sdkVersion', sdk_version
      ) ORDER BY id) FROM workers
    ), '[]'::jsonb));
$$;
