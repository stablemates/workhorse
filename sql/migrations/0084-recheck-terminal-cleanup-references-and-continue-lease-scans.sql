-- workhorse-migration: {"kind":"additive"}

-- Recheck the references of terminal cleanup after its row locks, and continue the expired-lease
-- scan while a backlog remains (SM-1665).

-- Terminal cleanup chose its candidates and locked them in one statement. That statement checked
-- the references of a candidate with its own snapshot, which is older than the row lock. If an
-- enqueue committed a dependency on a terminal prerequisite between the snapshot and the lock, the
-- delete failed the ON DELETE RESTRICT check of task_dependency. The terminal_tasks phase then
-- rolled back every batch of the pass. After this step, prune_full_terminal_tasks_internal_v1
-- locks the candidate window in one statement and rechecks every reference in a second
-- statement. At read committed, the second statement uses a snapshot taken after the locks, so it
-- sees the new dependency, keeps that prerequisite, and deletes the rest of the batch. At
-- repeatable read or serializable, the second statement uses the transaction snapshot, and the
-- phase keeps its error. Workers run maintenance at read committed, because the claim functions
-- refuse other isolation levels since migration 0048.
--
-- A recovery pass recorded a completed expired-lease scan even when the scan filled its share of
-- the limit. Ticks within half the shortest live maintenance interval then skipped the scan, so a
-- backlog of expired leases drained at one batch per half interval. After this step,
-- recover_expired_v1 reports a completed scan only when the scan returns fewer rows than its share
-- of the limit, and tick_v1 records only that scan. While a backlog remains, every tick scans.
--
-- No signature, result column, or documented guarantee changes.

-- One full-tier batch of terminal cleanup. It reports whether it deleted nothing while its locked
-- candidate window held a prerequisite that a dependency edge protects.
--
-- The first statement locks the candidate window. The second statement rechecks every reference
-- of the locked rows and deletes the rest. At read committed, the second statement reads a
-- snapshot taken after the locks. A reference that committed after the first snapshot, such as a
-- dependency edge or a redrive, is visible there, so its row stays, and a later pass checks it
-- again (SM-1665). An insert of such a reference takes FOR KEY SHARE on the task row through its
-- foreign key. That lock conflicts with FOR UPDATE, so no new reference commits after the lock.
-- In one statement, the check used the snapshot from before the lock, and the ON DELETE RESTRICT
-- check of task_dependency then failed the whole terminal_tasks phase.
CREATE OR REPLACE FUNCTION workhorse.prune_full_terminal_tasks_internal_v1(
  p_identity_before timestamptz, p_outcome_before timestamptz,
  p_history_before timestamptz, p_limit integer
) RETURNS TABLE (pruned integer, dependency_starved boolean)
LANGUAGE plpgsql
AS $$
DECLARE v_locked uuid[];
BEGIN
  IF p_limit < 1 THEN
    pruned := 0;
    dependency_starved := NULL;
    RETURN NEXT;
    RETURN;
  END IF;
  SELECT COALESCE(array_agg(locked.id ORDER BY locked.finished_at, locked.id), '{}'::uuid[])
    INTO v_locked
    FROM (
      SELECT task.id, outcome.finished_at
        FROM workhorse.task task
        JOIN workhorse.task_outcome outcome ON outcome.task_id = task.id
       WHERE task.created_at < p_identity_before
         AND outcome.finished_at < p_outcome_before
         AND outcome.history_through_at < p_history_before
         AND NOT EXISTS (
               SELECT 1 FROM workhorse.task_runtime runtime WHERE runtime.task_id = task.id
             )
         AND NOT EXISTS (SELECT 1 FROM workhorse.task_event event WHERE event.task_id = task.id)
         AND NOT EXISTS (
               SELECT 1 FROM workhorse.attempt_history attempt WHERE attempt.task_id = task.id
             )
         -- A redrive source waits for its younger target, so it stays out of the window.
         -- Otherwise a window of sources would hide the targets that release them, and no pass
         -- would progress.
         AND NOT EXISTS (
               SELECT 1 FROM workhorse.task_redrive redrive WHERE redrive.source_task_id = task.id
             )
         -- A group that is not finished needs its member outcomes when it finishes (ADR 0095).
         AND NOT EXISTS (
               SELECT 1
                 FROM workhorse.task_group_member member
                 JOIN workhorse.task_group task_group ON task_group.id = member.group_id
                WHERE member.task_id = task.id AND task_group.state <> 'finished'
             )
       ORDER BY outcome.finished_at, task.id
       FOR UPDATE OF task SKIP LOCKED
       LIMIT LEAST(p_limit * 4, 100000)
    ) locked;
  WITH candidate_window AS MATERIALIZED (
    SELECT task.id, outcome.finished_at
      FROM unnest(v_locked) AS locked(id)
      JOIN workhorse.task task ON task.id = locked.id
      JOIN workhorse.task_outcome outcome ON outcome.task_id = task.id
     WHERE task.created_at < p_identity_before
       AND outcome.finished_at < p_outcome_before
       AND outcome.history_through_at < p_history_before
       -- The window filters again, now with a snapshot taken after the locks.
       AND NOT EXISTS (SELECT 1 FROM workhorse.task_runtime runtime WHERE runtime.task_id = task.id)
       AND NOT EXISTS (SELECT 1 FROM workhorse.task_event event WHERE event.task_id = task.id)
       AND NOT EXISTS (
             SELECT 1 FROM workhorse.attempt_history attempt WHERE attempt.task_id = task.id
           )
       AND NOT EXISTS (
             SELECT 1 FROM workhorse.task_redrive redrive WHERE redrive.source_task_id = task.id
           )
       AND NOT EXISTS (
             SELECT 1
               FROM workhorse.task_group_member member
               JOIN workhorse.task_group task_group ON task_group.id = member.group_id
              WHERE member.task_id = task.id AND task_group.state <> 'finished'
           )
  ), candidates AS (
    SELECT candidate.id
      FROM candidate_window candidate
     WHERE NOT EXISTS (
             SELECT 1 FROM workhorse.schedule_occurrence occurrence
              WHERE occurrence.task_id = candidate.id
           )
       AND NOT EXISTS (
             SELECT 1 FROM workhorse.enqueue_idempotency idempotency
              WHERE idempotency.task_id = candidate.id
           )
       AND NOT EXISTS (
             SELECT 1 FROM workhorse.task_dependency dependency
              WHERE dependency.prerequisite_task_id = candidate.id
           )
       AND NOT EXISTS (
             SELECT 1
               FROM workhorse.task_child edge
               JOIN workhorse.task child ON child.id = edge.child_task_id
               LEFT JOIN workhorse.task_outcome child_outcome
                 ON child_outcome.task_id = edge.child_task_id
              WHERE edge.parent_task_id = candidate.id
                AND (
                  child_outcome.task_id IS NULL
                  OR child.created_at >= p_identity_before
                  OR child_outcome.finished_at >= p_outcome_before
                  OR child_outcome.history_through_at >= p_history_before
                )
           )
     ORDER BY candidate.finished_at, candidate.id
     LIMIT p_limit
  ), deleted AS (
    DELETE FROM workhorse.task task USING candidates WHERE task.id = candidates.id
    RETURNING task.id
  ), result AS (
    SELECT count(*)::integer AS pruned,
           count(*) = 0 AND EXISTS (
             SELECT 1
               FROM candidate_window candidate
               JOIN workhorse.task_dependency dependency
                 ON dependency.prerequisite_task_id = candidate.id
           ) AS dependency_starved
      FROM deleted
  )
  SELECT result.pruned, result.dependency_starved INTO STRICT pruned, dependency_starved
    FROM result;
  RETURN NEXT;
END;
$$;

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
    FOR v_runtime IN
      SELECT runtime.* FROM workhorse.task_runtime runtime
       WHERE runtime.state = 'active' AND runtime.attempt_timeout_at IS NOT NULL
         AND runtime.attempt_timeout_at <= v_now
         AND (
           runtime.deadline_at IS NULL
           OR runtime.deadline_at > v_now
           OR runtime.attempt_timeout_at < runtime.deadline_at
         )
       ORDER BY runtime.attempt_timeout_at, runtime.task_id FOR UPDATE SKIP LOCKED
       LIMIT GREATEST(0, v_limit - v_count)
    LOOP
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

CREATE OR REPLACE FUNCTION workhorse.tick_v1(
  p_promote_limit integer DEFAULT 1000, p_recover_limit integer DEFAULT 1000
) RETURNS TABLE (
  phase text, rows_affected integer, duration_ms integer, skipped_lock boolean, error jsonb,
  expired_leases integer, retried integer, retry_dimensions jsonb
)
LANGUAGE plpgsql
AS $$
DECLARE
  v_started_at timestamptz;
  v_tick_started_at timestamptz;
  v_tick_completed_at timestamptz;
  v_had_error boolean := false;
  v_rows_affected integer := 0;
  v_phases jsonb := '[]'::jsonb;
  v_gate_ms integer;
  v_lease_recovery_started_at timestamptz;
  v_scan_leases boolean;
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtextextended('workhorse:tick', 0)) THEN
    RETURN QUERY VALUES
      ('promote'::text, 0, 0, true, NULL::jsonb, 0, 0, '[]'::jsonb),
      ('recover'::text, 0, 0, true, NULL::jsonb, 0, 0, '[]'::jsonb);
    RETURN;
  END IF;

  v_tick_started_at := clock_timestamp();
  -- Every worker ticks once per interval, and the lock stops only overlapping ticks. Promotion and
  -- the deadline and timeout scans seek indexes, so a tick that finds nothing due costs little. The
  -- expired-lease scan reads every active lease, because an index on expires_at would cost every
  -- heartbeat its HOT update. That scan therefore runs only when no tick ran it within half the
  -- shortest maintenance interval of the live registered workers. The scan still runs at least
  -- once per interval of the worker that ticks most often. A worker is live while its last
  -- heartbeat is within its own lease, as in worker_client_protocols_v1. With no live
  -- registration, as for a direct caller, every tick runs the scan.
  SELECT min(registry.maintenance_interval_ms) INTO v_gate_ms
    FROM workhorse.worker_registry registry
   WHERE registry.last_heartbeat_at
         >= clock_timestamp() - make_interval(secs => registry.lease_ms / 1000.0);
  SELECT state.lease_recovery_started_at INTO v_lease_recovery_started_at
    FROM workhorse.maintenance_state state
   WHERE state.routine_name = 'tick';
  v_scan_leases := NOT COALESCE(
    v_lease_recovery_started_at <= v_tick_started_at
      AND v_lease_recovery_started_at
        > v_tick_started_at - make_interval(secs => v_gate_ms / 2000.0),
    false
  );
  UPDATE workhorse.maintenance_state
     SET last_started_at = v_tick_started_at, updated_at = v_tick_started_at
   WHERE routine_name = 'tick';

  phase := 'promote';
  rows_affected := 0;
  skipped_lock := false;
  error := NULL;
  expired_leases := 0;
  retried := 0;
  retry_dimensions := '[]'::jsonb;
  v_started_at := clock_timestamp();
  BEGIN
    rows_affected := workhorse.promote_v1(p_promote_limit);
  EXCEPTION WHEN OTHERS THEN
    error := jsonb_build_object('code', SQLSTATE, 'message', SQLERRM);
    v_had_error := true;
  END;
  duration_ms := GREATEST(
    0, round(extract(epoch FROM clock_timestamp() - v_started_at) * 1000)::integer
  );
  v_rows_affected := v_rows_affected + rows_affected;
  v_phases := v_phases || jsonb_build_array(jsonb_build_object(
    'phase', phase, 'rowsAffected', rows_affected, 'durationMs', duration_ms,
    'error', error
  ));
  RETURN NEXT;

  phase := 'recover';
  rows_affected := 0;
  error := NULL;
  v_started_at := clock_timestamp();
  PERFORM set_config('workhorse.recovery_skip_expired_leases', (NOT v_scan_leases)::text, true);
  BEGIN
    SELECT recovery.rows_affected, recovery.expired_leases, recovery.retried,
           recovery.retry_dimensions
      INTO rows_affected, expired_leases, retried, retry_dimensions
      FROM workhorse.recover_expired_telemetry_v1(p_recover_limit) recovery;
  EXCEPTION WHEN OTHERS THEN
    error := jsonb_build_object('code', SQLSTATE, 'message', SQLERRM);
    v_had_error := true;
  END;
  PERFORM set_config('workhorse.recovery_skip_expired_leases', 'false', true);
  -- Only a completed scan spaces the next one. Recovery skips the scan when deadline, timeout, or
  -- fast-tier work fills its limit. A scan that fills the rest of the limit leaves a backlog, so
  -- the next tick scans again. A failed phase rolls the scan back with this setting.
  IF error IS NULL
     AND current_setting('workhorse.recovery_scanned_expired_leases', true) = 'true' THEN
    UPDATE workhorse.maintenance_state
       SET lease_recovery_started_at = v_tick_started_at
     WHERE routine_name = 'tick';
  END IF;
  duration_ms := GREATEST(
    0, round(extract(epoch FROM clock_timestamp() - v_started_at) * 1000)::integer
  );
  v_rows_affected := v_rows_affected + rows_affected;
  v_phases := v_phases || jsonb_build_array(jsonb_build_object(
    'phase', phase, 'rowsAffected', rows_affected, 'durationMs', duration_ms,
    'error', error, 'expiredLeases', expired_leases, 'retried', retried
  ));
  RETURN NEXT;

  v_tick_completed_at := clock_timestamp();
  IF NOT v_had_error THEN
    UPDATE workhorse.maintenance_state
       SET last_completed_at = v_tick_completed_at, updated_at = v_tick_completed_at
     WHERE routine_name = 'tick';
  END IF;
  IF v_had_error OR (
    v_rows_affected > 0
    AND NOT EXISTS (
      SELECT 1
        FROM workhorse.maintenance_run recent
       WHERE recent.routine_name = 'tick'
         AND recent.outcome = 'succeeded'
         AND recent.started_at > v_tick_started_at - interval '1 minute'
    )
  ) THEN
    PERFORM workhorse.record_maintenance_run_internal_v1(
      'tick', v_tick_started_at, v_tick_completed_at,
      CASE WHEN v_had_error THEN 'failed' ELSE 'succeeded' END,
      v_rows_affected, v_phases
    );
  END IF;
END;
$$;
