-- workhorse-migration: {"kind":"additive"}

-- Floor the expired-lease scan gate and count one admission shard through an index.
--
-- tick_v1 runs the expired-lease scan of the full tier only when no tick ran it within half the
-- shortest maintenance_interval_ms of the live registered workers. The scan reads every active
-- lease. One worker at 100 ms thus made the fleet run the scan every 50 ms, and its ticks held the
-- tick lock for almost all the time (SM-1960). The gate interval now has a floor of 1,000 ms, the
-- default maintenance interval of each SDK. A fleet at the default or above scans as before. A
-- shorter interval still makes that worker tick more often, but the scan runs at most once in
-- 500 ms. A tick with no live registered worker still runs the scan every time.
--
-- notify_concurrency_capacity_v1 counted the active leases of one admission shard with the filter
-- COALESCE(admission_shard, 0) % v_shards = v_shard, which no index serves. The count thus read
-- each active lease of the queue (SM-1991). The count now reads disjoint parts that match the same
-- rows. With one shard, the part is the whole queue. With more shards, the parts are the stored
-- shards 0 to 7 that map to the shard (at most 4, each an equality with a scalar), a null shard for
-- shard 0, and a value below 0 or above 7 that maps to the shard. Each part is an equality or a
-- range on (queue_name, admission_shard), which the index of the next step serves.
--
-- This step changes only the two function bodies. The signatures and the answers do not change.
-- The functions give the same answers before the next step builds the index, only more slowly.

CREATE OR REPLACE FUNCTION workhorse.notify_concurrency_capacity_v1()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_policy workhorse.concurrency_policy%ROWTYPE;
  v_rate_policy workhorse.rate_limit_policy%ROWTYPE;
  v_shards integer;
  v_shard integer;
  v_share integer;
  v_members smallint[];
BEGIN
  IF OLD.state <> 'active' OR (TG_OP <> 'DELETE' AND NEW.state = 'active') THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  SELECT * INTO v_policy FROM workhorse.concurrency_policy policy
   WHERE policy.queue_name = OLD.queue_name;
  IF NOT FOUND THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  SELECT * INTO v_rate_policy FROM workhorse.rate_limit_policy policy
   WHERE policy.queue_name = OLD.queue_name;
  v_shards := workhorse.admission_shard_count_v1(
    v_policy.max_active, v_policy.max_active_per_key, v_rate_policy.rate_burst,
    v_rate_policy.per_key_limit
  );
  v_shard := COALESCE(OLD.admission_shard, 0) % v_shards;
  v_share := workhorse.admission_share_v1(v_policy.max_active, v_shards, v_shard);
  -- A claim holds its shard's lock until it commits. A claim that is still open may have filled
  -- this shard, and the count below cannot see its leases. This release therefore notifies unless
  -- it can hold the shard in share mode at once. It never waits, and a claim that wants the shard
  -- after this point waits for this release to commit and then sees it.
  IF NOT pg_try_advisory_xact_lock_shared(
    hashtextextended('workhorse:admission-shard:' || OLD.queue_name || ':' || v_shard, 0)
  ) THEN
    PERFORM pg_notify('workhorse_tasks', OLD.queue_name);
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  -- A synchronization can change the shard count between the first read and the lock. The shard
  -- this release computed may then not be the one a claim counts it in, so the release notifies.
  SELECT * INTO v_policy FROM workhorse.concurrency_policy policy
   WHERE policy.queue_name = OLD.queue_name;
  SELECT * INTO v_rate_policy FROM workhorse.rate_limit_policy policy
   WHERE policy.queue_name = OLD.queue_name;
  IF v_policy.queue_name IS NULL OR workhorse.admission_shard_count_v1(
       v_policy.max_active, v_policy.max_active_per_key, v_rate_policy.rate_burst,
       v_rate_policy.per_key_limit
     ) <> v_shards THEN
    PERFORM pg_notify('workhorse_tasks', OLD.queue_name);
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  -- Only a release from a full shard, queue, or key can unblock a waiting claim. Every other release
  -- would wake a worker that no cap held back, and a woken worker delays its claim. This runs before
  -- the row changes, so the first row a statement releases from a full shard still counts itself. A
  -- concurrent release that has not committed still counts as active, so it cannot hide the cap.
  -- A claim counts only unexpired leases, but this count includes expired ones. It therefore counts
  -- every lease a claim may have counted when it found the shard full: a lease that expired after
  -- that claim must not hide the cap from this release.
  --
  -- A lease counts in the shard COALESCE(admission_shard, 0) % v_shards. A claim stores a shard
  -- below 8, because a queue has at most 8 shards, but a stored value can be from an earlier shard
  -- count. The shard count therefore reads disjoint parts, each an equality or a range on
  -- task_runtime_active_queue_shard_idx (SM-1991), and the LIMIT on the whole union stops the read
  -- at the share. With one shard, every active lease of the queue counts. With more shards, the
  -- parts are the stored values 0 to 7 that map to this shard (at most 4, in v_members), a null
  -- value for shard 0, and any value below 0 or above 7 that maps to this shard. Each row thus
  -- matches the same shard as the modulo above. A missing member is null and matches no row. In a
  -- database that only Workhorse writes, the last two parts each cost one index probe. Each part
  -- compares with a scalar, so a generic plan also uses the index. Without the index, the parts
  -- give the same answer, only more slowly.
  v_members := ARRAY(
    SELECT member::smallint FROM generate_series(0, 7) member WHERE member % v_shards = v_shard
  );
  IF (SELECT count(*) FROM (
        SELECT 1 FROM workhorse.task_runtime active
         WHERE v_shards = 1
           AND active.queue_name = OLD.queue_name AND active.state = 'active'
        UNION ALL
        SELECT 1 FROM workhorse.task_runtime active
         WHERE v_shards > 1
           AND active.queue_name = OLD.queue_name AND active.state = 'active'
           AND active.admission_shard = v_members[1]
        UNION ALL
        SELECT 1 FROM workhorse.task_runtime active
         WHERE v_shards > 1
           AND active.queue_name = OLD.queue_name AND active.state = 'active'
           AND active.admission_shard = v_members[2]
        UNION ALL
        SELECT 1 FROM workhorse.task_runtime active
         WHERE v_shards > 1
           AND active.queue_name = OLD.queue_name AND active.state = 'active'
           AND active.admission_shard = v_members[3]
        UNION ALL
        SELECT 1 FROM workhorse.task_runtime active
         WHERE v_shards > 1
           AND active.queue_name = OLD.queue_name AND active.state = 'active'
           AND active.admission_shard = v_members[4]
        UNION ALL
        SELECT 1 FROM workhorse.task_runtime active
         WHERE v_shards > 1 AND v_shard = 0
           AND active.queue_name = OLD.queue_name AND active.state = 'active'
           AND active.admission_shard IS NULL
        UNION ALL
        SELECT 1 FROM workhorse.task_runtime active
         WHERE v_shards > 1
           AND active.queue_name = OLD.queue_name AND active.state = 'active'
           AND active.admission_shard < 0 AND active.admission_shard % v_shards = v_shard
        UNION ALL
        SELECT 1 FROM workhorse.task_runtime active
         WHERE v_shards > 1
           AND active.queue_name = OLD.queue_name AND active.state = 'active'
           AND active.admission_shard > 7 AND active.admission_shard % v_shards = v_shard
        LIMIT v_share
      ) capped) = v_share
     OR (SELECT count(*) FROM (
           SELECT 1 FROM workhorse.task_runtime active
            WHERE active.queue_name = OLD.queue_name AND active.state = 'active'
            LIMIT v_policy.max_active
         ) capped) = v_policy.max_active
     OR (
       v_policy.max_active_per_key IS NOT NULL AND OLD.concurrency_key IS NOT NULL
       AND (SELECT count(*) FROM (
              SELECT 1 FROM workhorse.task_runtime active
               WHERE active.queue_name = OLD.queue_name
                 AND active.concurrency_key = OLD.concurrency_key
                 AND active.state = 'active'
               LIMIT v_policy.max_active_per_key
            ) capped) = v_policy.max_active_per_key
     ) THEN
    PERFORM pg_notify('workhorse_tasks', OLD.queue_name);
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
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
  -- gate interval. The gate interval is the shortest maintenance interval of the live registered
  -- workers, but never less than 1,000 ms, the default maintenance interval of each SDK (SM-1960).
  -- Thus one worker with a short interval cannot make the scan run more often than once in 500 ms,
  -- and a fleet whose shortest interval is longer scans as before. A tick of any caller records
  -- its scan, also a tick of an unregistered worker, so it can reset the spacing. Thus a lease
  -- waits at most half the gate interval plus one interval of the fastest registered worker,
  -- not one gate interval. A worker is live while its last heartbeat is within its own lease, as
  -- in worker_client_protocols_v1. With no live registration, as for a direct caller, every tick
  -- runs the scan.
  SELECT min(registry.maintenance_interval_ms) INTO v_gate_ms
    FROM workhorse.worker_registry registry
   WHERE registry.last_heartbeat_at
         >= clock_timestamp() - make_interval(secs => registry.lease_ms / 1000.0);
  -- GREATEST ignores a null, so the floor applies only when a live worker sets a gate.
  IF v_gate_ms IS NOT NULL THEN
    v_gate_ms := GREATEST(v_gate_ms, 1000);
  END IF;
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
