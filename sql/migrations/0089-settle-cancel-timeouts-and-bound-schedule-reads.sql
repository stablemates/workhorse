-- workhorse-migration: {"kind":"additive"}

-- Correct three SQL defects that the 2026-10-28 schema audit found (SM-1866).

-- 1. The full-tier timeout scan of recover_expired_v1 locked an active attempt that carried a
--    cancellation request, but timeout_owned_v1 settled nothing for it. Each tick held those locks,
--    so the heartbeats of the owning worker reported busy, and the limit ended before the real
--    timeouts behind them. The scan now skips such a row while its lease is live and its deadline
--    is ahead, as fast_recover_expired_v1 does. If the deadline passed after the timeout, the scan
--    gives the row to terminalize_deadline_v1, which closes it canceled.
-- 2. dashboard_cron_v1 counted every retained occurrence of each schedule and read the maximum
--    fired_at before it limited the list to 50 schedules. It now limits the definitions first. For
--    each listed schedule, it counts at most 1,001 occurrences and reads the fire time of the
--    newest occurrence, each through an index that holds both schedule keys. occurrenceCount stops
--    at 1,000, and the new key occurrenceCountCapped is true when more than 1,000 occurrences are
--    retained. The function now sets jit, enable_seqscan, and enable_bitmapscan to off.
-- 3. prune_worker_registry_v1 deleted expired kept pauses with a CASE condition, so the planner
--    could not use worker_pause_tombstone_expires_idx and read the whole table. The comparison is
--    now a separate condition.
-- 4. The comment in create_history_day_v1 said that lifecycle transitions write attempt_history
--    first. tick_v1 and timeout_owned_v1 write task_event first (SM-1879). The comment
--    now states the real lock order and the lock_timeout that two callers set. Only the comment
--    changes, not the statements.
--
-- Each function keeps its name, its arguments, and its result type under ADR 0109. Changes 1 and 3
-- correct defects, and change 4 does not change behavior. Change 2 is a performance change: the
-- document gains one key, and a count above 1,000 stops at 1,000. No document states an exact count
-- above that value. lastFiredAt is now the fire time of the newest occurrence. It is earlier than
-- the latest fire only when an older occurrence fired later: across a daylight-saving gap, or by a
-- direct fire_schedule_v1 call. No change touches stored data, and the SDK floor does not change.

CREATE OR REPLACE FUNCTION workhorse.recover_expired_v1(
  p_limit integer DEFAULT 100, p_retry_delay_ms integer DEFAULT NULL
) RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  v_runtime workhorse.task_runtime%ROWTYPE;
  v_task workhorse.task%ROWTYPE;
  v_state text;
  v_run_at timestamptz;
  v_error jsonb := jsonb_build_object('name', 'LeaseExpired', 'message', 'worker lease expired');
  v_count integer := 0;
  v_retry record;
  v_retry_delay_ms bigint;
  v_retry_source text;
  v_envelope jsonb;
  v_expired_leases integer := 0;
  v_retried integer := 0;
  v_retry_dimensions jsonb := '[]'::jsonb;
  v_notify_queues text[] := '{}';
  v_notify_queue text;
  -- The three scans compare against one stable time so the deadline and timeout comparisons
  -- seek their partial indexes, and the three scans agree on which work is due.
  v_now timestamptz := clock_timestamp();
  v_limit integer := GREATEST(1, LEAST(p_limit, 10000));
  v_fast record;
  -- tick_v1 sets this when another tick ran the expired-lease scan within half an interval.
  v_skip_expired_leases boolean := COALESCE(
    NULLIF(current_setting('workhorse.recovery_skip_expired_leases', true), ''), 'false'
  )::boolean;
  v_scan_limit integer;
  v_scanned integer := 0;
BEGIN
  PERFORM set_config('workhorse.recovery_scanned_expired_leases', 'false', true);
  PERFORM set_config('workhorse.recovery_expired_leases', '0', true);
  PERFORM set_config('workhorse.recovery_retried', '0', true);
  PERFORM set_config('workhorse.recovery_retry_dimensions', '[]', true);
  -- Fast-tier rows share this call's limit and counters, so one recovery pass covers both tiers.
  SELECT * INTO STRICT v_fast
    FROM workhorse.fast_recover_expired_v1(v_limit, p_retry_delay_ms, v_now);
  v_count := v_fast.recovered;
  v_expired_leases := v_fast.expired_leases;
  v_retried := v_fast.retried;
  v_retry_dimensions := v_fast.retry_dimensions;
  v_notify_queues := v_fast.queues;
  FOR v_runtime IN
    SELECT runtime.* FROM workhorse.task_runtime runtime
     WHERE runtime.deadline_at IS NOT NULL AND runtime.deadline_at <= v_now
       AND (
         runtime.state <> 'active'
         OR runtime.attempt_timeout_at IS NULL
         OR runtime.attempt_timeout_at > v_now
         OR runtime.deadline_at <= runtime.attempt_timeout_at
       )
     ORDER BY runtime.deadline_at, runtime.task_id FOR UPDATE SKIP LOCKED
     LIMIT GREATEST(0, v_limit - v_count)
  LOOP
    IF workhorse.terminalize_deadline_v1(v_runtime.task_id) THEN
      v_count := v_count + 1;
      v_notify_queues := array_append(v_notify_queues, v_runtime.queue_name);
    END IF;
  END LOOP;

  IF v_count < v_limit THEN
    -- A pending cancellation wins over the timeout, so timeout_owned_v1 settles nothing for it.
    -- The scan skips such a row while its lease is live and its deadline is ahead, as the fast
    -- tier does: a lock that settles nothing makes the heartbeat of its worker busy, and it uses
    -- the limit that real timeouts behind it need (SM-1866).
    FOR v_runtime IN
      SELECT runtime.* FROM workhorse.task_runtime runtime
       WHERE runtime.state = 'active' AND runtime.attempt_timeout_at IS NOT NULL
         AND runtime.attempt_timeout_at <= v_now
         AND (
           runtime.deadline_at IS NULL
           OR runtime.deadline_at > v_now
           OR runtime.attempt_timeout_at < runtime.deadline_at
         )
         AND (runtime.cancel_requested_at IS NULL OR runtime.deadline_at <= v_now)
       ORDER BY runtime.attempt_timeout_at, runtime.task_id FOR UPDATE SKIP LOCKED
       LIMIT GREATEST(0, v_limit - v_count)
    LOOP
      -- The deadline of this row passed after its timeout. The pending cancellation then closes
      -- the task, as terminalize_deadline_v1 does for each cancellation behind a passed deadline.
      IF v_runtime.cancel_requested_at IS NOT NULL THEN
        IF workhorse.terminalize_deadline_v1(v_runtime.task_id) THEN
          v_count := v_count + 1;
          v_notify_queues := array_append(v_notify_queues, v_runtime.queue_name);
        END IF;
        CONTINUE;
      END IF;
      SELECT * INTO STRICT v_task FROM workhorse.task task WHERE task.id = v_runtime.task_id;
      IF workhorse.timeout_owned_v1(
        v_runtime.task_id, v_runtime.worker_id, v_runtime.fence_token
      ) THEN
        v_count := v_count + 1;
        v_notify_queues := array_append(v_notify_queues, v_task.queue_name);
        IF v_runtime.current_attempt < v_task.max_attempts THEN
          v_retried := v_retried + 1;
          v_retry_dimensions := v_retry_dimensions || jsonb_build_array(jsonb_build_object(
            'queue', v_task.queue_name, 'type', v_task.task_type
          ));
        END IF;
      END IF;
    END LOOP;
  END IF;

  IF v_count >= v_limit THEN
    PERFORM set_config('workhorse.recovery_expired_leases', v_expired_leases::text, true);
    PERFORM set_config('workhorse.recovery_retried', v_retried::text, true);
    PERFORM set_config('workhorse.recovery_retry_dimensions', v_retry_dimensions::text, true);
    FOR v_notify_queue IN
      SELECT DISTINCT affected.queue_name
        FROM unnest(v_notify_queues) AS affected(queue_name)
       ORDER BY affected.queue_name
    LOOP
      PERFORM pg_notify('workhorse_tasks', v_notify_queue);
    END LOOP;
    RETURN v_count;
  END IF;

  -- tick_v1 records only a scan that returned fewer rows than its share of the limit. An early
  -- return above, or a scan that fills its share, leaves expired leases behind, so it never spaces
  -- the next scan (SM-1665).
  v_scan_limit := v_limit - v_count;
  FOR v_runtime IN
    SELECT r.* FROM workhorse.task_runtime r
     WHERE NOT v_skip_expired_leases
       AND r.state = 'active' AND r.expires_at <= v_now
       AND (
         r.cancel_requested_at IS NOT NULL
         OR r.deadline_at IS NULL OR r.deadline_at > v_now
       )
       AND (
         r.cancel_requested_at IS NOT NULL
         OR r.attempt_timeout_at IS NULL OR r.attempt_timeout_at > v_now
       )
     ORDER BY r.expires_at, r.task_id FOR UPDATE SKIP LOCKED
     LIMIT v_scan_limit
  LOOP
    v_scanned := v_scanned + 1;
    SELECT * INTO STRICT v_task FROM workhorse.task j WHERE j.id = v_runtime.task_id;
    IF v_runtime.cancel_requested_at IS NOT NULL THEN
      v_envelope := workhorse.cancellation_envelope_v1(
        v_runtime.cancel_requested_at, v_runtime.cancel_requested_by, v_runtime.cancel_reason
      );
      DELETE FROM workhorse.task_runtime r
       WHERE r.task_id = v_runtime.task_id AND r.state = 'active'
         AND r.fence_token = v_runtime.fence_token AND r.expires_at <= clock_timestamp()
         AND r.cancel_requested_at IS NOT NULL;
      IF NOT FOUND THEN CONTINUE; END IF;
      INSERT INTO workhorse.task_outcome(
        task_id, state, current_attempt, fence_token, run_at, error, history_through_at
      )
        VALUES (
          v_runtime.task_id, 'canceled', v_runtime.current_attempt, v_runtime.fence_token,
          v_runtime.run_at, v_envelope, clock_timestamp()
        );
      INSERT INTO workhorse.attempt_history(
        task_id, attempt, fence_token, worker_id, outcome, started_at, claimed_at, error
      ) VALUES (
        v_runtime.task_id, v_runtime.current_attempt, v_runtime.fence_token,
        v_runtime.worker_id, 'canceled', v_runtime.attempt_started_at,
        v_runtime.acquired_at, v_envelope
      );
      INSERT INTO workhorse.task_event(task_id, attempt, event_type, details)
        VALUES (
          v_runtime.task_id,
          v_runtime.current_attempt,
          'canceled',
          jsonb_build_object(
            'requested_at', v_runtime.cancel_requested_at,
            'requested_by', v_runtime.cancel_requested_by,
            'reason', v_runtime.cancel_reason,
            'fence_token', v_runtime.fence_token::text,
            'source', 'recovered'
          )
        );
      v_count := v_count + 1;
      v_expired_leases := v_expired_leases + 1;
      v_notify_queues := array_append(v_notify_queues, v_task.queue_name);
      CONTINUE;
    END IF;
    IF v_runtime.current_attempt < v_task.max_attempts THEN
      SELECT * INTO STRICT v_retry FROM workhorse.retry_delay_v1(
        v_runtime.task_id, v_runtime.current_attempt, v_task.retry_policy,
        v_runtime.previous_retry_delay_ms, p_retry_delay_ms, 'lease-recovery-immediate'
      );
      v_retry_delay_ms := v_retry.delay_ms;
      v_retry_source := v_retry.source;
      v_run_at := clock_timestamp() + make_interval(secs => v_retry_delay_ms::double precision / 1000.0);
      v_state := CASE WHEN v_retry_delay_ms <= 0 THEN 'ready' ELSE 'scheduled' END;
      UPDATE workhorse.task_runtime r
         SET state = v_state, current_attempt = r.current_attempt + 1, fence_token = 0,
             run_at = v_run_at,
             ready_at = CASE WHEN v_state = 'ready' THEN clock_timestamp() END,
             sequence = CASE WHEN v_state = 'ready' THEN nextval('workhorse.ready_sequence_seq') END,
             worker_id = NULL, acquired_at = NULL, heartbeat_at = NULL, expires_at = NULL,
             wait_name = NULL, attempt_started_at = NULL, execution_used_ms = 0,
             attempt_timeout_at = NULL,
             previous_retry_delay_ms = v_retry.next_previous_retry_delay_ms,
             error = v_error, updated_at = clock_timestamp()
       WHERE r.task_id = v_runtime.task_id AND r.state = 'active'
         AND r.fence_token = v_runtime.fence_token AND r.expires_at <= clock_timestamp();
      IF NOT FOUND THEN CONTINUE; END IF;
      v_retried := v_retried + 1;
      v_retry_dimensions := v_retry_dimensions || jsonb_build_array(jsonb_build_object(
        'queue', v_task.queue_name, 'type', v_task.task_type
      ));
    ELSE
      v_state := 'failed';
      v_retry_delay_ms := NULL;
      v_retry_source := 'terminal';
      DELETE FROM workhorse.task_runtime r
       WHERE r.task_id = v_runtime.task_id AND r.state = 'active'
         AND r.fence_token = v_runtime.fence_token AND r.expires_at <= clock_timestamp();
      IF NOT FOUND THEN CONTINUE; END IF;
      INSERT INTO workhorse.task_outcome(
        task_id, state, current_attempt, fence_token, run_at, error, history_through_at
      ) VALUES (
        v_runtime.task_id, 'failed', v_runtime.current_attempt, v_runtime.fence_token,
        v_runtime.run_at, v_error, clock_timestamp()
      );
    END IF;
    INSERT INTO workhorse.attempt_history(
      task_id, attempt, fence_token, worker_id, outcome, started_at, claimed_at, error
    )
      VALUES (v_runtime.task_id, v_runtime.current_attempt, v_runtime.fence_token, v_runtime.worker_id,
        'lease_expired', v_runtime.attempt_started_at, v_runtime.acquired_at, v_error);
    INSERT INTO workhorse.task_event(task_id, attempt, event_type, details)
      VALUES (v_runtime.task_id, v_runtime.current_attempt, 'lease_expired',
        jsonb_build_object('fence_token', v_runtime.fence_token::text, 'next_state', v_state,
          'retry_policy', v_task.retry_policy, 'retry_delay_ms', v_retry_delay_ms,
          'retry_delay_source', v_retry_source));
    v_count := v_count + 1;
    v_expired_leases := v_expired_leases + 1;
    v_notify_queues := array_append(v_notify_queues, v_task.queue_name);
  END LOOP;
  PERFORM set_config(
    'workhorse.recovery_scanned_expired_leases',
    (NOT v_skip_expired_leases AND v_scanned < v_scan_limit)::text, true
  );
  PERFORM set_config('workhorse.recovery_expired_leases', v_expired_leases::text, true);
  PERFORM set_config('workhorse.recovery_retried', v_retried::text, true);
  PERFORM set_config('workhorse.recovery_retry_dimensions', v_retry_dimensions::text, true);
  FOR v_notify_queue IN
    SELECT DISTINCT affected.queue_name
      FROM unnest(v_notify_queues) AS affected(queue_name)
     ORDER BY affected.queue_name
  LOOP
    PERFORM pg_notify('workhorse_tasks', v_notify_queue);
  END LOOP;
  RETURN v_count;
END;
$$;

-- The planner estimates one schedule as 1 / n_distinct(schedule_name) of schedule_occurrence. With
-- few schedules, some scans then look cheap: a sequential scan, a bitmap scan, or a scan of
-- schedule_occurrence_retention_idx in time order. Each of them reads the rows of every schedule
-- (SM-1866). The settings remove the first two, and the occurrence reads below remove the third.
-- The worker registry count still needs a sequential scan. On PostgreSQL 15 through 17, its
-- disabled cost would start JIT compilation on each poll, so jit is off too.
CREATE OR REPLACE FUNCTION workhorse.dashboard_cron_v1(p_input jsonb)
RETURNS jsonb
LANGUAGE sql
SET jit = off
SET enable_seqscan = off
SET enable_bitmapscan = off
AS $$
  -- The page lists 50 schedules. Each listed schedule then reads at most 1,001 occurrences for its
  -- count and one occurrence for its last fire, so a busy schedule cannot make the poll read every
  -- retained occurrence (SM-1866).
  WITH listed AS (
    SELECT definition.namespace, definition.schedule_name, definition.cron_expression,
           definition.queue_name, definition.task_type, definition.priority,
           definition.catchup_policy,
           definition.configured_enabled, definition.paused, definition.paused_by,
           definition.paused_reason, definition.paused_at,
           definition.revision, definition.updated_at,
           definition.last_skipped_at, definition.last_skipped_count,
           definition.last_skipped_through
      FROM workhorse.dashboard_schedule_definition_v1 definition
     ORDER BY definition.namespace, definition.schedule_name
     LIMIT 50
  ), schedule_rows AS (
    SELECT listed.*,
           counted.occurrence_count,
           latest.fired_at AS last_fired_at,
           (SELECT count(*)::integer
              FROM workhorse.dashboard_worker_registry_v1 registry
             WHERE listed.namespace = ANY(registry.schedule_namespaces)
               AND registry.last_heartbeat_at >= clock_timestamp() - interval '30 seconds')
             AS evaluator_count
      FROM listed
      -- The count has no sort order, so the planner builds no full scan of the retention index.
      -- Only an index that holds both schedule keys then serves the conditions.
      CROSS JOIN LATERAL (
        SELECT count(*)::integer AS occurrence_count
          FROM (
            SELECT 1 FROM workhorse.dashboard_schedule_occurrence_v1 occurrence
             WHERE occurrence.namespace = listed.namespace
               AND occurrence.schedule_name = listed.schedule_name
             LIMIT 1001
          ) bounded
      ) counted
      -- The newest occurrence usually carries the latest fire time. Two cases fire an older
      -- occurrence later: an evaluator fires in wall-clock order, which goes back in UTC across a
      -- daylight-saving gap, and a direct fire_schedule_v1 call can fire any second. Then
      -- lastFiredAt is earlier than the latest fire. The range condition keeps schedule_name in
      -- the sort order.
      -- An equality would drop it, and the retention index could then give the order. Only the
      -- primary key gives this order without a sort. The range follows the namespace equality, so
      -- it also bounds the scan when the schedule has no occurrence.
      LEFT JOIN LATERAL (
        SELECT occurrence.fired_at FROM workhorse.dashboard_schedule_occurrence_v1 occurrence
         WHERE occurrence.namespace = listed.namespace
           AND occurrence.schedule_name >= listed.schedule_name
           AND occurrence.schedule_name <= listed.schedule_name
         ORDER BY occurrence.schedule_name DESC, occurrence.occurrence_at DESC
         LIMIT 1
      ) latest ON true
  ), schedules AS (
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'kind', 'user',
      'identity', jsonb_build_object(
        'kind', 'user', 'namespace', namespace, 'name', schedule_name),
      'namespace', namespace, 'name', schedule_name, 'cron', cron_expression,
      'queue', queue_name, 'type', task_type, 'priority', priority,
      'catchupPolicy', catchup_policy,
      'configuredEnabled', configured_enabled, 'paused', paused,
      'pausedBy', paused_by, 'pausedReason', paused_reason,
      'pausedAt', workhorse.dashboard_iso_v1(paused_at),
      'active', configured_enabled AND NOT paused, 'revision', revision::text,
      'updatedAt', workhorse.dashboard_iso_v1(updated_at),
      'occurrenceCount', LEAST(occurrence_count, 1000),
      'lastFiredAt', workhorse.dashboard_iso_v1(last_fired_at),
      'evaluatorCount', evaluator_count,
      'lastSkippedAt', workhorse.dashboard_iso_v1(last_skipped_at),
      'lastSkippedCount', last_skipped_count,
      'lastSkippedThrough', workhorse.dashboard_iso_v1(last_skipped_through),
      'occurrenceCountCapped', occurrence_count > 1000
    ) ORDER BY namespace, schedule_name), '[]'::jsonb) AS value FROM schedule_rows
  ), policy AS (
    SELECT * FROM workhorse.dashboard_maintenance_policy_v1 WHERE singleton
  ), routines AS (
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'routine', state.routine_name,
      'lastStartedAt', workhorse.dashboard_iso_v1(state.last_started_at),
      'lastCompletedAt', workhorse.dashboard_iso_v1(state.last_completed_at),
      'due', CASE state.routine_name
        WHEN 'tick' THEN state.last_completed_at IS NULL
          OR state.last_completed_at <= clock_timestamp()
            - make_interval(secs => COALESCE(
                (p_input #>> '{maintenanceLoops,tickIntervalMs}')::numeric,
                1000
              ) / 1000.0)
        WHEN 'history_partitions' THEN state.last_completed_at IS NULL
          OR state.last_completed_at <= clock_timestamp()
            - make_interval(secs => policy.partition_preparation_interval_ms / 1000.0)
        -- A recorded backlog makes the follow-up pass due as prune_terminal_storage_v1 gates it.
        WHEN 'terminal_storage' THEN state.last_completed_at IS NULL
          OR state.last_completed_at <= clock_timestamp()
            - make_interval(secs => CASE WHEN state.terminal_cleanup_backlog_since IS NULL
                THEN policy.terminal_cleanup_interval_ms
                ELSE LEAST(policy.terminal_cleanup_interval_ms,
                  workhorse.terminal_cleanup_follow_up_delay_ms_v1()) END / 1000.0)
        WHEN 'history_retention' THEN
          (clock_timestamp() AT TIME ZONE policy.timezone)::time
            >= policy.history_retention_local_time
          AND (state.last_completed_local_date IS NULL
            OR state.last_completed_local_date
              < (clock_timestamp() AT TIME ZONE policy.timezone)::date)
        ELSE false END,
      'incomplete', state.last_started_at IS NOT NULL
        AND (state.last_completed_at IS NULL
          OR state.last_started_at > state.last_completed_at),
      'recordedRunCount', (
        SELECT count(*)::integer
          FROM workhorse.dashboard_maintenance_run_v1 counted
         WHERE counted.routine_name = state.routine_name
      ),
      'runs', COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'id', recent.run_id::text,
          'startedAt', workhorse.dashboard_iso_v1(recent.started_at),
          'completedAt', workhorse.dashboard_iso_v1(recent.completed_at),
          'durationMs', GREATEST(0, round(extract(epoch FROM
            recent.completed_at - recent.started_at) * 1000)::integer),
          'outcome', recent.outcome,
          'rowsAffected', recent.rows_affected,
          'phases', recent.phases
        ) ORDER BY recent.started_at DESC, recent.run_id DESC)
          FROM (
            SELECT run.* FROM workhorse.dashboard_maintenance_run_v1 run
             WHERE run.routine_name = state.routine_name
             ORDER BY run.started_at DESC, run.run_id DESC
             LIMIT 5
          ) recent
      ), '[]'::jsonb)
    ) ORDER BY state.routine_name), '[]'::jsonb) AS value
      FROM workhorse.dashboard_maintenance_state_v1 state
      CROSS JOIN policy
     WHERE state.routine_name IN ('tick', 'history_partitions', 'history_retention', 'terminal_storage')
  )
  SELECT jsonb_build_object(
    'capturedAt', workhorse.dashboard_iso_v1(clock_timestamp()),
    'schedules', schedules.value,
    -- The listing stops at 50 schedules, so the count tells the page how many it did not show.
    'scheduleCount', (
      SELECT count(*)::integer FROM workhorse.dashboard_schedule_definition_v1
    ),
    'maintenance', jsonb_build_object(
      'cadences', COALESCE(p_input->'maintenanceLoops', '{}'::jsonb),
      'policy', jsonb_build_object(
        'timezone', policy.timezone,
        'partitionPreparationIntervalMs', policy.partition_preparation_interval_ms,
        'terminalCleanupIntervalMs', policy.terminal_cleanup_interval_ms,
        'historyRetentionLocalTime', left(policy.history_retention_local_time::text, 5),
        'updatedAt', workhorse.dashboard_iso_v1(policy.updated_at)),
      'routines', routines.value))
    FROM policy CROSS JOIN schedules CROSS JOIN routines;
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

  -- The expiry comparison stays a separate condition, so the scan seeks
  -- worker_pause_tombstone_expires_idx and tries the lock only for the expired rows that the index
  -- returns. A CASE hid the comparison from the planner and read the whole table (SM-1866). On a
  -- sequential scan, PostgreSQL tests the cheaper comparison first, so it also tries the lock only
  -- for an expired row.
  DELETE FROM workhorse.worker_pause_tombstone tombstone
   WHERE tombstone.expires_at <= v_now
     AND pg_try_advisory_xact_lock(
       hashtextextended('workhorse:worker-registry:' || tombstone.worker_id, 0)
     );

  RETURN v_count;
END;
$$;

CREATE OR REPLACE FUNCTION workhorse.create_history_day_v1(p_day date)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  v_start timestamptz := p_day::timestamp AT TIME ZONE 'UTC';
  v_end timestamptz := (p_day + 1)::timestamp AT TIME ZONE 'UTC';
  v_suffix text := to_char(p_day::timestamp, 'YYYYMMDD');
  v_event_partition text := 'task_event_' || v_suffix;
  v_attempt_partition text := 'attempt_history_' || v_suffix;
  v_event_staging text := 'workhorse_task_event_' || v_suffix;
  v_attempt_staging text := 'workhorse_attempt_history_' || v_suffix;
  v_event_exists boolean;
  v_attempt_exists boolean;
BEGIN
  -- The cast to timestamp keeps the session TimeZone out of to_char, and to_char keeps the
  -- session DateStyle out of the day text (SM-1665).
  PERFORM pg_advisory_xact_lock(
    hashtextextended('workhorse:history-day:' || to_char(p_day::timestamp, 'YYYY-MM-DD'), 0)
  );
  v_event_exists := to_regclass(format('workhorse.%I', v_event_partition)) IS NOT NULL;
  v_attempt_exists := to_regclass(format('workhorse.%I', v_attempt_partition)) IS NOT NULL;
  IF v_event_exists AND v_attempt_exists THEN RETURN; END IF;

  -- Take both partitioned-parent locks before either CREATE TABLE takes them implicitly, so two
  -- calls of this function for different days lock the parents in one order. Some lifecycle
  -- writers take them in the other order. In one transaction, tick_v1 writes task_event through
  -- promote_v1 and later writes attempt_history through recover_expired_telemetry_v1.
  -- timeout_owned_v1 also writes task_event before attempt_history. Thus this function can hold
  -- attempt_history and wait for task_event while such a writer waits for attempt_history.
  -- prepare_history_partitions_v1 sets lock_timeout to 250 ms and defers the day. The demo history
  -- seed sets lock_timeout to 250 ms and retries its transaction on 55P03 or 40P01 (SM-1879). A
  -- direct call with no lock_timeout waits until PostgreSQL detects the deadlock.
  LOCK TABLE ONLY workhorse.attempt_history IN ACCESS EXCLUSIVE MODE;
  LOCK TABLE ONLY workhorse.task_event IN ACCESS EXCLUSIVE MODE;
  LOCK TABLE workhorse.attempt_history_default IN ACCESS EXCLUSIVE MODE;
  LOCK TABLE workhorse.task_event_default IN ACCESS EXCLUSIVE MODE;
  IF NOT v_event_exists THEN
    EXECUTE format(
      'CREATE TEMP TABLE pg_temp.%I ON COMMIT DROP AS SELECT * FROM workhorse.task_event_default WHERE occurred_at >= %L AND occurred_at < %L',
      v_event_staging, v_start, v_end);
    DELETE FROM workhorse.task_event_default WHERE occurred_at >= v_start AND occurred_at < v_end;
    EXECUTE format(
      'CREATE TABLE workhorse.%I PARTITION OF workhorse.task_event FOR VALUES FROM (%L) TO (%L)',
      v_event_partition, v_start, v_end);
    EXECUTE format(
      'INSERT INTO workhorse.%I (event_id, task_id, attempt, event_type, details, occurred_at) SELECT event_id, task_id, attempt, event_type, details, occurred_at FROM pg_temp.%I',
      v_event_partition, v_event_staging);
    EXECUTE format('DROP TABLE pg_temp.%I', v_event_staging);
  END IF;

  IF NOT v_attempt_exists THEN
    EXECUTE format(
      'CREATE TEMP TABLE pg_temp.%I ON COMMIT DROP AS SELECT * FROM workhorse.attempt_history_default WHERE occurred_at >= %L AND occurred_at < %L',
      v_attempt_staging, v_start, v_end);
    DELETE FROM workhorse.attempt_history_default WHERE occurred_at >= v_start AND occurred_at < v_end;
    EXECUTE format(
      'CREATE TABLE workhorse.%I PARTITION OF workhorse.attempt_history FOR VALUES FROM (%L) TO (%L)',
      v_attempt_partition, v_start, v_end);
    EXECUTE format(
      'INSERT INTO workhorse.%I (attempt_id, task_id, attempt, fence_token, worker_id, outcome, started_at, claimed_at, finished_at, error, occurred_at) SELECT attempt_id, task_id, attempt, fence_token, worker_id, outcome, started_at, claimed_at, finished_at, error, occurred_at FROM pg_temp.%I',
      v_attempt_partition, v_attempt_staging);
    EXECUTE format('DROP TABLE pg_temp.%I', v_attempt_staging);
  END IF;
END;
$$;
