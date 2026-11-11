-- workhorse-migration: {"kind":"additive"}

-- Give out a cold export day only after its snapshot frontier, keep statistics rows until the
-- coarser tier uses them, and keep a held history retention pass due.
--
-- History rows get their time when they are written, but other sessions see them only after their
-- transaction commits. claim_cold_export_segment_v1 gave out a day when the day had ended and the
-- rollup had passed it. A transaction that wrote into the day and committed later added a row
-- below exported_through that no export object holds, and retention later deleted it (SM-1928).
-- The claim now waits for a snapshot frontier (ADR 0121). The first claim that finds the server
-- clock at least cold_export_frontier_margin_ms_v1() (60 s) past the end of the next day takes a
-- new transaction ID and stores it in two new nullable columns of cold_export_dataset:
-- frontier_day_end and frontier_xid. The claim gives out the day only when
-- pg_snapshot_xmin(pg_current_snapshot()) is at or after frontier_xid. A claim in a transaction
-- that already has a transaction ID records no frontier. The server clock decides, not p_now. A
-- re-lease of an exporting segment passes the same frontier.
--
-- A segment that is exporting when this migration runs was given out without a frontier. The
-- migration fences it as migration 0052 does: it increments attempts and clears the lease. A
-- completion or failure from before the migration then fails, and the next claim gives out the
-- day again after its frontier.
--
-- send_signal_v1 and complete_human_wait_v1, when no wait row exists, and record_batch_event_v1
-- now take the transaction ID before their event insert. In those paths the event could be the
-- first write of the transaction, so the event read its time before the transaction had an ID.
--
-- rollup_stats_v1 deleted each minute row older than its retention, also a row that a catch-up
-- pass had just written and the hour tier had not used yet (SM-1978). Retention now keeps each
-- minute row from the first hour that the next pass can rebuild, and each hour row from the first
-- day that it can rebuild.
--
-- retain_history_v1 judged completion against the cutoffs after the rollup and export clamps. A
-- pass that a clamp held back recorded succeeded and was not due again until the next local date
-- (SM-1979). It now judges completion against the policy cutoffs, so such a pass records
-- incomplete and runs again on the next offer.
--
-- Each function keeps its name, its arguments, and its result type under ADR 0109. The new
-- columns have no default, so the migration rewrites no row for them. It updates only the
-- cold_export_segment rows that are exporting. The new function cold_export_frontier_margin_ms_v1
-- only adds. The SDK floor does not change.

ALTER TABLE workhorse.cold_export_dataset
  ADD COLUMN IF NOT EXISTS frontier_day_end timestamptz,
  ADD COLUMN IF NOT EXISTS frontier_xid xid8;

UPDATE workhorse.cold_export_segment segment
   SET attempts = segment.attempts + 1,
       lease_expires_at = NULL,
       updated_at = clock_timestamp()
 WHERE segment.status = 'exporting';

CREATE OR REPLACE FUNCTION workhorse.cold_export_frontier_margin_ms_v1()
RETURNS integer
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT 60000;
$$;

CREATE OR REPLACE FUNCTION workhorse.claim_cold_export_segment_v1(
  p_dataset text,
  p_exporter_id text,
  p_lease_ms integer,
  p_now timestamptz DEFAULT clock_timestamp()
) RETURNS TABLE (
  dataset text,
  segment_start timestamptz,
  segment_end timestamptz,
  attempts integer,
  exportable_through timestamptz
)
LANGUAGE plpgsql
AS $$
DECLARE v_enabled boolean;
DECLARE v_exported_through timestamptz;
DECLARE v_limit timestamptz;
DECLARE v_segment workhorse.cold_export_segment%ROWTYPE;
DECLARE v_fresh boolean;
DECLARE v_clock timestamptz;
DECLARE v_xid xid8;
DECLARE v_day_end timestamptz;
DECLARE v_frontier_day_end timestamptz;
DECLARE v_frontier_xid xid8;
DECLARE v_release boolean;
BEGIN
  IF p_dataset NOT IN ('task_event', 'attempt_history', 'fast_task_outcome') THEN
    RAISE EXCEPTION 'cold export dataset must be task_event, attempt_history or fast_task_outcome';
  END IF;
  IF p_exporter_id IS NULL OR p_exporter_id = '' OR octet_length(p_exporter_id) > 256 THEN
    RAISE EXCEPTION 'cold export exporter id must contain 1 through 256 bytes';
  END IF;
  IF p_lease_ms IS NULL OR p_lease_ms NOT BETWEEN 1000 AND 86400000 THEN
    RAISE EXCEPTION 'cold export lease must be between 1000 and 86400000 milliseconds';
  END IF;
  IF p_now IS NULL OR NOT isfinite(p_now) THEN RAISE EXCEPTION 'claim time is required'; END IF;
  SELECT policy.enabled INTO v_enabled
    FROM workhorse.cold_export_policy policy WHERE policy.singleton;
  IF NOT COALESCE(v_enabled, false) THEN RETURN; END IF;
  -- Read the clock before the transaction gets its ID: the row lock below assigns one anyway, and
  -- an ID assigned after this reading is greater than each ID assigned before it.
  v_fresh := pg_current_xact_id_if_assigned() IS NULL;
  v_clock := clock_timestamp();
  v_xid := pg_current_xact_id();
  SELECT exported.exported_through, exported.frontier_day_end, exported.frontier_xid
    INTO v_exported_through, v_frontier_day_end, v_frontier_xid
    FROM workhorse.cold_export_dataset exported
   WHERE exported.dataset = p_dataset
     FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  v_limit := workhorse.cold_export_exportable_through_internal_v1(p_now);

  SELECT * INTO v_segment
    FROM workhorse.cold_export_segment segment
   WHERE segment.dataset = p_dataset AND segment.status = 'exporting'
   ORDER BY segment.segment_start
   LIMIT 1
     FOR UPDATE;
  v_release := FOUND;
  IF v_release THEN
    IF v_segment.lease_expires_at IS NOT NULL AND v_segment.lease_expires_at > p_now THEN
      RETURN;
    END IF;
    v_day_end := v_segment.segment_end;
  ELSE
    -- A fixed 24 hours, not '1 day': timestamptz plus a day interval steps a calendar day in the
    -- session TimeZone, which is 23 or 25 hours across a daylight-saving transition.
    v_day_end := v_exported_through + interval '24 hours';
    IF v_day_end > v_limit THEN RETURN; END IF;
  END IF;
  -- A re-leased day passes the same frontier as a new day. A day given out after its frontier
  -- passed finds the frontier again, and a segment from before migration 0096 waits for one.
  -- A stored frontier above the new ID of this claim cannot come from this server, for example
  -- after a restore from a dump onto another server, so the claim records a new one.
  IF v_frontier_day_end IS DISTINCT FROM v_day_end OR v_frontier_xid > v_xid THEN
    IF NOT v_fresh OR v_clock < v_day_end + make_interval(
      secs => workhorse.cold_export_frontier_margin_ms_v1() / 1000.0
    ) THEN
      RETURN;
    END IF;
    UPDATE workhorse.cold_export_dataset exported
       SET frontier_day_end = v_day_end, frontier_xid = v_xid
     WHERE exported.dataset = p_dataset;
    v_frontier_xid := v_xid;
  END IF;
  -- The update above commits with this call, so a later claim finds the frontier.
  IF pg_snapshot_xmin(pg_current_snapshot()) < v_frontier_xid THEN RETURN; END IF;
  IF v_release THEN
    UPDATE workhorse.cold_export_segment segment
       SET attempts = segment.attempts + 1,
           exporter_id = p_exporter_id,
           lease_expires_at = p_now + make_interval(secs => p_lease_ms / 1000.0),
           started_at = p_now,
           updated_at = clock_timestamp()
     WHERE segment.dataset = v_segment.dataset
       AND segment.segment_start = v_segment.segment_start
    RETURNING * INTO v_segment;
  ELSE
    INSERT INTO workhorse.cold_export_segment(
      dataset, segment_start, segment_end, status, attempts, exporter_id, lease_expires_at,
      started_at
    ) VALUES (
      p_dataset, v_exported_through, v_day_end, 'exporting', 1,
      p_exporter_id, p_now + make_interval(secs => p_lease_ms / 1000.0), p_now
    )
    RETURNING * INTO v_segment;
  END IF;
  dataset := v_segment.dataset;
  segment_start := v_segment.segment_start;
  segment_end := v_segment.segment_end;
  attempts := v_segment.attempts;
  exportable_through := v_limit;
  RETURN NEXT;
END;
$$;

CREATE OR REPLACE FUNCTION workhorse.record_batch_event_v1(
  p_event_type text,
  p_batch_id uuid,
  p_task_ids uuid[],
  p_attempts integer[],
  p_fence_tokens bigint[],
  p_worker_id text
) RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  v_size integer := cardinality(p_task_ids);
  v_members jsonb;
  v_existing integer;
  v_matching integer;
  v_requested integer;
  v_authorized integer;
BEGIN
  IF p_event_type NOT IN ('batch_dispatched', 'batch_failed') THEN
    RAISE EXCEPTION 'unsupported batch event type';
  END IF;
  IF p_batch_id IS NULL THEN RAISE EXCEPTION 'batch_id must not be null'; END IF;
  IF p_worker_id IS NULL OR p_worker_id = '' THEN
    RAISE EXCEPTION 'worker_id must not be empty';
  END IF;
  IF v_size IS NULL OR v_size NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'batch size must be between 1 and 100';
  END IF;
  IF cardinality(p_attempts) <> v_size OR cardinality(p_fence_tokens) <> v_size THEN
    RAISE EXCEPTION 'batch member arrays must have equal lengths';
  END IF;
  IF array_position(p_task_ids, NULL) IS NOT NULL
     OR array_position(p_attempts, NULL) IS NOT NULL
     OR array_position(p_fence_tokens, NULL) IS NOT NULL THEN
    RAISE EXCEPTION 'batch member arrays must not contain nulls';
  END IF;
  IF EXISTS (
    SELECT 1 FROM unnest(p_task_ids) member(task_id)
     GROUP BY member.task_id HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'batch task ids must be unique';
  END IF;

  SELECT jsonb_agg(
           jsonb_build_object('task_id', member.task_id, 'attempt', member.attempt)
           ORDER BY member.ordinal
         )
    INTO v_members
    FROM unnest(p_task_ids, p_attempts) WITH ORDINALITY
      AS member(task_id, attempt, ordinal);

  PERFORM pg_advisory_xact_lock(hashtextextended(p_batch_id::text, 0));
  SELECT count(*)::integer
    INTO v_existing
    FROM workhorse.task_event event
   WHERE event.event_type IN ('batch_dispatched', 'batch_failed')
     AND event.details->>'batch_id' = p_batch_id::text;
  IF v_existing > 0 THEN
    SELECT count(*)::integer
      INTO v_matching
      FROM unnest(p_task_ids, p_attempts, p_fence_tokens) AS member(task_id, attempt, fence_token)
      JOIN workhorse.task_event event
        ON event.task_id = member.task_id
       AND event.attempt = member.attempt
       AND event.event_type IN ('batch_dispatched', 'batch_failed')
       AND event.details = jsonb_build_object(
         'batch_id', p_batch_id,
         'size', v_size,
         'members', v_members,
         'worker_id', p_worker_id,
         'fence_token', member.fence_token::text
       );
    IF v_matching <> v_existing THEN
      RAISE EXCEPTION 'batch id already records different evidence';
    END IF;
    SELECT count(*)::integer
      INTO v_requested
      FROM workhorse.task_event event
     WHERE event.event_type = p_event_type
       AND event.details->>'batch_id' = p_batch_id::text;
    IF v_requested = v_size THEN RETURN v_size; END IF;
    IF v_requested <> 0 THEN
      RAISE EXCEPTION 'batch event records an incomplete member set';
    END IF;
  END IF;

  SELECT count(*)::integer
    INTO v_authorized
    FROM unnest(p_task_ids, p_attempts, p_fence_tokens) AS member(task_id, attempt, fence_token)
   WHERE EXISTS (
     SELECT 1
       FROM workhorse.task_event claim
      WHERE claim.task_id = member.task_id
        AND claim.attempt = member.attempt
        AND claim.event_type = 'claimed'
        AND claim.details->>'worker_id' = p_worker_id
        AND claim.details->>'fence_token' = member.fence_token::text
   ) OR EXISTS (
     -- A fast-tier queue may record no claims, so its live lease is the evidence instead.
     SELECT 1
       FROM workhorse.fast_task_runtime fast
      WHERE fast.task_id = member.task_id AND fast.state = 'active'
        AND fast.attempt = member.attempt AND fast.worker_id = p_worker_id
        AND fast.fence_token = member.fence_token
   );
  IF v_authorized <> v_size THEN
    RAISE EXCEPTION 'batch members must match retained claims';
  END IF;

  -- The events can be the first write of the transaction. Take the transaction ID before they
  -- read their time, as the cold export frontier needs (ADR 0121).
  PERFORM pg_current_xact_id();
  INSERT INTO workhorse.task_event(task_id, attempt, event_type, details)
    SELECT member.task_id, member.attempt, p_event_type,
           jsonb_build_object(
             'batch_id', p_batch_id,
             'size', v_size,
             'members', v_members,
             'worker_id', p_worker_id,
             'fence_token', member.fence_token::text
           )
      FROM unnest(p_task_ids, p_attempts, p_fence_tokens) WITH ORDINALITY
        AS member(task_id, attempt, fence_token, ordinal)
     ORDER BY member.ordinal;
  RETURN v_size;
END;
$$;

CREATE OR REPLACE FUNCTION workhorse.send_signal_v1(
  p_task_id uuid,
  p_signal_name text,
  p_payload jsonb,
  p_idempotency_key text,
  p_requested_by text
) RETURNS TABLE (
  status text,
  payload jsonb,
  delivered_at timestamptz,
  delivered_by text
)
LANGUAGE plpgsql
AS $$
DECLARE
  v_wait workhorse.task_signal_wait%ROWTYPE;
  v_runtime workhorse.task_runtime%ROWTYPE;
  v_key_hash bytea;
  v_key_digest text;
  v_fingerprint jsonb;
  v_now timestamptz;
  v_reason text;
BEGIN
  IF p_signal_name IS NULL OR p_signal_name = '' OR char_length(p_signal_name) > 200 THEN
    RAISE EXCEPTION 'signal_name must contain between 1 and 200 characters';
  END IF;
  IF p_signal_name <> btrim(p_signal_name) THEN
    RAISE EXCEPTION 'signal_name must not have leading or trailing whitespace';
  END IF;
  IF p_payload IS NULL THEN
    RAISE EXCEPTION 'signal payload must be JSON, including JSON null when appropriate';
  END IF;
  IF octet_length(p_payload::text) > 65536 THEN
    RAISE EXCEPTION 'signal payload must be at most 65536 bytes';
  END IF;
  IF p_idempotency_key IS NULL OR octet_length(p_idempotency_key) NOT BETWEEN 1 AND 512 THEN
    RAISE EXCEPTION 'signal idempotency key must contain between 1 and 512 UTF-8 bytes';
  END IF;
  IF p_requested_by IS NULL OR p_requested_by = '' OR char_length(p_requested_by) > 200 THEN
    RAISE EXCEPTION 'signal requested_by must contain between 1 and 200 characters';
  END IF;

  v_key_hash := workhorse.idempotency_key_hash_v1(
    'signal:' || p_task_id::text || ':' || p_signal_name, p_idempotency_key
  );
  v_key_digest := left(encode(v_key_hash, 'hex'), 12);
  v_fingerprint := jsonb_build_object('payload', p_payload, 'requestedBy', p_requested_by);
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'workhorse:signal:' || p_task_id::text || ':' || p_signal_name, 0
  ));

  IF NOT EXISTS (SELECT 1 FROM workhorse.task WHERE id = p_task_id) THEN
    RETURN QUERY VALUES ('not_found'::text, NULL::jsonb, NULL::timestamptz, NULL::text);
    RETURN;
  END IF;
  SELECT * INTO v_wait
    FROM workhorse.task_signal_wait stored
   WHERE stored.task_id = p_task_id AND stored.signal_name = p_signal_name
   FOR UPDATE;
  IF NOT FOUND THEN
    -- No row lock was taken, so the event can be the first write of the transaction. Take the
    -- transaction ID before the event reads its time, as the cold export frontier needs (ADR 0121).
    PERFORM pg_current_xact_id();
    INSERT INTO workhorse.task_event(task_id, event_type, details)
      VALUES (
        p_task_id, 'signal_rejected',
        jsonb_build_object(
          'name', p_signal_name, 'reason', 'not_waiting', 'requested_by', p_requested_by,
          'idempotency_key_digest', v_key_digest
        )
      );
    RETURN QUERY VALUES ('not_waiting'::text, NULL::jsonb, NULL::timestamptz, NULL::text);
    RETURN;
  END IF;

  IF v_wait.delivered_at IS NOT NULL THEN
    IF v_wait.idempotency_key_hash = v_key_hash THEN
      IF v_wait.request_fingerprint IS DISTINCT FROM v_fingerprint THEN
        v_reason := 'idempotency_conflict';
        status := 'conflict';
      ELSE
        RETURN QUERY VALUES (
          'duplicate'::text, v_wait.payload, v_wait.delivered_at, v_wait.delivered_by
        );
        RETURN;
      END IF;
    ELSE
      v_reason := 'already_delivered';
      status := 'already_delivered';
    END IF;
    INSERT INTO workhorse.task_event(task_id, attempt, event_type, details)
      VALUES (
        p_task_id, v_wait.attempt, 'signal_rejected',
        jsonb_build_object(
          'name', p_signal_name, 'reason', v_reason, 'requested_by', p_requested_by,
          'idempotency_key_digest', v_key_digest
        )
      );
    RETURN QUERY VALUES (status, v_wait.payload, v_wait.delivered_at, v_wait.delivered_by);
    RETURN;
  END IF;

  SELECT * INTO v_runtime
    FROM workhorse.task_runtime runtime
   WHERE runtime.task_id = p_task_id
     AND runtime.state = 'scheduled'
     AND runtime.wait_name = p_signal_name
     AND runtime.current_attempt = v_wait.attempt
   FOR UPDATE;
  v_now := clock_timestamp();
  IF NOT FOUND OR (v_runtime.deadline_at IS NOT NULL AND v_runtime.deadline_at <= v_now) THEN
    INSERT INTO workhorse.task_event(task_id, attempt, event_type, details)
      VALUES (
        p_task_id, v_wait.attempt, 'signal_rejected',
        jsonb_build_object(
          'name', p_signal_name, 'reason', 'stale', 'requested_by', p_requested_by,
          'idempotency_key_digest', v_key_digest
        )
      );
    RETURN QUERY VALUES ('stale'::text, NULL::jsonb, NULL::timestamptz, NULL::text);
    RETURN;
  END IF;

  UPDATE workhorse.task_signal_wait stored
     SET payload = p_payload, idempotency_key_hash = v_key_hash,
         request_fingerprint = v_fingerprint, delivered_by = p_requested_by, delivered_at = v_now
   WHERE stored.task_id = p_task_id AND stored.signal_name = p_signal_name
   RETURNING * INTO v_wait;
  UPDATE workhorse.task_runtime runtime
     SET state = 'ready', run_at = v_now, ready_at = v_now,
         sequence = nextval('workhorse.ready_sequence_seq'), wait_name = NULL,
         deadline_at = (SELECT task.deadline_at FROM workhorse.task task WHERE task.id = p_task_id),
         updated_at = v_now
   WHERE runtime.task_id = p_task_id;
  INSERT INTO workhorse.task_event(task_id, attempt, event_type, details)
    VALUES (
      p_task_id, v_wait.attempt, 'signal_received',
      jsonb_build_object(
        'name', p_signal_name, 'requested_by', p_requested_by,
        'idempotency_key_digest', v_key_digest, 'payload_bytes', octet_length(p_payload::text)
      )
    );
  PERFORM pg_notify('workhorse_tasks', v_runtime.queue_name);
  RETURN QUERY VALUES ('delivered'::text, v_wait.payload, v_wait.delivered_at, v_wait.delivered_by);
END;
$$;

CREATE OR REPLACE FUNCTION workhorse.rollup_stats_v1(
  p_force boolean DEFAULT false,
  p_now timestamptz DEFAULT clock_timestamp(),
  p_max_buckets integer DEFAULT 240
) RETURNS TABLE (
  phase text, rows_affected integer, duration_ms integer, skipped_lock boolean, error jsonb
)
LANGUAGE plpgsql
AS $$
DECLARE v_started_at timestamptz;
DECLARE v_state workhorse.task_stat_state%ROWTYPE;
DECLARE v_policy workhorse.retention_policy%ROWTYPE;
DECLARE v_maintenance workhorse.maintenance_policy%ROWTYPE;
DECLARE v_from timestamptz;
DECLARE v_to timestamptz;
DECLARE v_closed timestamptz;
DECLARE v_hour_from timestamptz;
DECLARE v_hour_to timestamptz;
DECLARE v_day_from timestamptz;
DECLARE v_day_to timestamptz;
DECLARE v_keep_minutes_from timestamptz;
DECLARE v_keep_hours_from timestamptz;
DECLARE v_inserted integer; BEGIN
  IF p_now IS NULL OR NOT isfinite(p_now) THEN RAISE EXCEPTION 'maintenance time is required'; END IF;
  IF p_max_buckets IS NULL OR p_max_buckets NOT BETWEEN 1 AND 100000 THEN
    RAISE EXCEPTION 'bucket limit must be between 1 and 100000';
  END IF;
  IF NOT pg_try_advisory_xact_lock(hashtextextended('workhorse:maintenance:stat-rollup', 0)) THEN
    RETURN QUERY VALUES
      ('stat_rollup'::text, 0, 0, true, NULL::jsonb),
      ('stat_retention'::text, 0, 0, true, NULL::jsonb);
    RETURN;
  END IF;
  SELECT * INTO STRICT v_maintenance FROM workhorse.maintenance_policy WHERE singleton;
  SELECT * INTO STRICT v_state FROM workhorse.task_stat_state WHERE singleton FOR UPDATE;
  SELECT * INTO STRICT v_policy FROM workhorse.retention_policy WHERE singleton;
  -- The cadence, recompute window, and group limit are maintenance policy, not caller options:
  -- a fleet shares one statistics contract, and a zero interval opts the whole fleet out while
  -- holding history retention at the current watermark. Force bypasses the cadence gate only.
  IF NOT p_force AND (
    v_maintenance.statistics_rollup_interval_ms = 0
    OR (v_state.last_run_at IS NOT NULL AND v_state.last_run_at > p_now - make_interval(
      secs => v_maintenance.statistics_rollup_interval_ms / 1000.0
    ))
  ) THEN
    RETURN;
  END IF;

  phase := 'stat_rollup';
  rows_affected := 0;
  skipped_lock := false;
  error := NULL;
  v_started_at := clock_timestamp(); BEGIN
    v_closed := date_bin('1 minute', p_now, timestamp '2000-01-01' AT TIME ZONE 'UTC');
    v_from := LEAST(
      v_state.rolled_up_through
        - make_interval(mins => v_maintenance.statistics_recompute_buckets),
      v_closed
    );
    -- Catching up after an outage advances in bounded passes rather than in one long transaction.
    v_to := LEAST(v_closed, v_from + make_interval(mins => p_max_buckets));
    IF v_to > v_from THEN
      DELETE FROM workhorse.task_stat_bucket
       WHERE bucket_start >= v_from AND bucket_start < v_to;
      INSERT INTO workhorse.task_stat_bucket (
        bucket_start, queue_name, task_type, enqueued,
        task_succeeded, task_failed, task_canceled,
        attempt_succeeded, attempt_failed, attempt_retry,
        attempt_lease_expired, attempt_canceled, attempt_other,
        attempt_duration_ms, wait_sketch, last_attempt_at, last_error, last_error_at
      )
      SELECT * FROM workhorse.aggregate_stats_v1(v_from, v_to, v_maintenance.statistics_group_limit);
      GET DIAGNOSTICS rows_affected = ROW_COUNT;

      v_hour_from := LEAST(
        v_state.hourly_rolled_up_through,
        date_bin('1 hour', v_from, timestamp '2000-01-01' AT TIME ZONE 'UTC')
      );
      v_hour_to := date_bin('1 hour', v_to, timestamp '2000-01-01' AT TIME ZONE 'UTC');
      IF v_hour_to > v_hour_from THEN
        DELETE FROM workhorse.task_stat_bucket_hour
         WHERE bucket_start >= v_hour_from AND bucket_start < v_hour_to;
        INSERT INTO workhorse.task_stat_bucket_hour (
          bucket_start, queue_name, task_type, enqueued,
          task_succeeded, task_failed, task_canceled,
          attempt_succeeded, attempt_failed, attempt_retry,
          attempt_lease_expired, attempt_canceled, attempt_other,
          attempt_duration_ms, wait_sketch, last_attempt_at, last_error, last_error_at
        )
        SELECT date_bin('1 hour', bucket.bucket_start,
                        timestamp '2000-01-01' AT TIME ZONE 'UTC'),
               bucket.queue_name, bucket.task_type,
               sum(bucket.enqueued), sum(bucket.task_succeeded), sum(bucket.task_failed),
               sum(bucket.task_canceled), sum(bucket.attempt_succeeded),
               sum(bucket.attempt_failed), sum(bucket.attempt_retry),
               sum(bucket.attempt_lease_expired), sum(bucket.attempt_canceled),
               sum(bucket.attempt_other), sum(bucket.attempt_duration_ms),
               workhorse.stat_sketch_merge_v1(array_agg(bucket.wait_sketch)),
               max(bucket.last_attempt_at),
               (array_agg(bucket.last_error ORDER BY bucket.last_error_at DESC NULLS LAST)
                 FILTER (WHERE bucket.last_error IS NOT NULL))[1],
               max(bucket.last_error_at)
          FROM workhorse.task_stat_bucket bucket
         WHERE bucket.bucket_start >= v_hour_from AND bucket.bucket_start < v_hour_to
         GROUP BY 1, 2, 3;
        GET DIAGNOSTICS v_inserted = ROW_COUNT;
        rows_affected := rows_affected + v_inserted;
      ELSE
        v_hour_to := v_state.hourly_rolled_up_through;
      END IF;

      v_day_from := LEAST(
        v_state.daily_rolled_up_through,
        date_bin('1 day', v_hour_from, timestamp '2000-01-01' AT TIME ZONE 'UTC')
      );
      v_day_to := date_bin('1 day', v_hour_to, timestamp '2000-01-01' AT TIME ZONE 'UTC');
      IF v_day_to > v_day_from THEN
        DELETE FROM workhorse.task_stat_bucket_day
         WHERE bucket_start >= v_day_from AND bucket_start < v_day_to;
        INSERT INTO workhorse.task_stat_bucket_day (
          bucket_start, queue_name, task_type, enqueued,
          task_succeeded, task_failed, task_canceled,
          attempt_succeeded, attempt_failed, attempt_retry,
          attempt_lease_expired, attempt_canceled, attempt_other,
          attempt_duration_ms, wait_sketch, last_attempt_at, last_error, last_error_at
        )
        SELECT date_bin('1 day', bucket.bucket_start,
                        timestamp '2000-01-01' AT TIME ZONE 'UTC'),
               bucket.queue_name, bucket.task_type,
               sum(bucket.enqueued), sum(bucket.task_succeeded), sum(bucket.task_failed),
               sum(bucket.task_canceled), sum(bucket.attempt_succeeded),
               sum(bucket.attempt_failed), sum(bucket.attempt_retry),
               sum(bucket.attempt_lease_expired), sum(bucket.attempt_canceled),
               sum(bucket.attempt_other), sum(bucket.attempt_duration_ms),
               workhorse.stat_sketch_merge_v1(array_agg(bucket.wait_sketch)),
               max(bucket.last_attempt_at),
               (array_agg(bucket.last_error ORDER BY bucket.last_error_at DESC NULLS LAST)
                 FILTER (WHERE bucket.last_error IS NOT NULL))[1],
               max(bucket.last_error_at)
          FROM workhorse.task_stat_bucket_hour bucket
         WHERE bucket.bucket_start >= v_day_from AND bucket.bucket_start < v_day_to
         GROUP BY 1, 2, 3;
        GET DIAGNOSTICS v_inserted = ROW_COUNT;
        rows_affected := rows_affected + v_inserted;
      ELSE
        v_day_to := v_state.daily_rolled_up_through;
      END IF;

      UPDATE workhorse.task_stat_state
         SET rolled_up_through = v_to,
             hourly_rolled_up_through = GREATEST(hourly_rolled_up_through, v_hour_to),
             daily_rolled_up_through = GREATEST(daily_rolled_up_through, v_day_to),
             last_run_at = p_now, updated_at = clock_timestamp()
       WHERE singleton;
    ELSE
      UPDATE workhorse.task_stat_state
         SET last_run_at = p_now, updated_at = clock_timestamp()
       WHERE singleton;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    error := jsonb_build_object('code', SQLSTATE, 'message', SQLERRM);
  END;
  duration_ms := GREATEST(
    0, round(extract(epoch FROM clock_timestamp() - v_started_at) * 1000)::integer
  );
  RETURN NEXT;

  -- Bucket retention is bounded per pass like every other retained category. Shortening the policy
  -- makes the next pass eligible to delete months of buckets at once, and an unbounded statement
  -- there would hold a long lock on the relation every operator window reads.
  --
  -- A coarser tier is built only from the finer rows that remain. After a long stop, a catch-up
  -- pass writes minute rows older than their retention, and the hour tier uses them only up to the
  -- last complete hour of the pass. The next pass also rebuilds the hour and the day that hold the
  -- start of its recompute window. Retention therefore keeps each minute row from the first hour
  -- that the next pass can rebuild, and each hour row from the first day that it can rebuild
  -- (SM-1978). In a normal pass those bounds are far newer than the retention cutoffs, so the same
  -- rows are deleted.
  phase := 'stat_retention';
  rows_affected := 0;
  error := NULL;
  v_started_at := clock_timestamp(); BEGIN
    SELECT * INTO STRICT v_state FROM workhorse.task_stat_state WHERE singleton;
    -- The same bounds as v_hour_from and v_day_from of the next pass.
    v_keep_minutes_from := LEAST(
      v_state.hourly_rolled_up_through,
      date_bin('1 hour',
               v_state.rolled_up_through
                 - make_interval(mins => v_maintenance.statistics_recompute_buckets),
               timestamp '2000-01-01' AT TIME ZONE 'UTC')
    );
    v_keep_hours_from := LEAST(
      v_state.daily_rolled_up_through,
      date_bin('1 day', v_keep_minutes_from, timestamp '2000-01-01' AT TIME ZONE 'UTC')
    );
    WITH expired AS (
      SELECT bucket.ctid
        FROM workhorse.task_stat_bucket bucket
       WHERE bucket.bucket_start < p_now - make_interval(
         days => LEAST(COALESCE(v_policy.statistics_retention_days, 2), 2)
       )
         AND bucket.bucket_start < v_keep_minutes_from
       ORDER BY bucket.bucket_start
         FOR UPDATE SKIP LOCKED
       LIMIT v_policy.statistics_rows_per_pass
    )
    DELETE FROM workhorse.task_stat_bucket bucket USING expired
     WHERE bucket.ctid = expired.ctid;
    GET DIAGNOSTICS rows_affected = ROW_COUNT;

    WITH expired AS (
      SELECT bucket.ctid
        FROM workhorse.task_stat_bucket_hour bucket
       WHERE bucket.bucket_start < p_now - make_interval(
         days => LEAST(COALESCE(v_policy.statistics_retention_days, 90), 90)
       )
         AND bucket.bucket_start < v_keep_hours_from
       ORDER BY bucket.bucket_start
         FOR UPDATE SKIP LOCKED
       LIMIT v_policy.statistics_rows_per_pass
    )
    DELETE FROM workhorse.task_stat_bucket_hour bucket USING expired
     WHERE bucket.ctid = expired.ctid;
    GET DIAGNOSTICS v_inserted = ROW_COUNT;
    rows_affected := rows_affected + v_inserted;

    IF v_policy.statistics_retention_days IS NOT NULL THEN
      WITH expired AS (
        SELECT bucket.ctid
          FROM workhorse.task_stat_bucket_day bucket
         WHERE bucket.bucket_start < p_now
               - make_interval(days => v_policy.statistics_retention_days)
         ORDER BY bucket.bucket_start
           FOR UPDATE SKIP LOCKED
         LIMIT v_policy.statistics_rows_per_pass
      )
      DELETE FROM workhorse.task_stat_bucket_day bucket USING expired
       WHERE bucket.ctid = expired.ctid;
      GET DIAGNOSTICS v_inserted = ROW_COUNT;
      rows_affected := rows_affected + v_inserted;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    error := jsonb_build_object('code', SQLSTATE, 'message', SQLERRM);
  END;
  duration_ms := GREATEST(
    0, round(extract(epoch FROM clock_timestamp() - v_started_at) * 1000)::integer
  );
  RETURN NEXT;
END;
$$;

CREATE OR REPLACE FUNCTION workhorse.retain_history_v1(
  p_force boolean DEFAULT false,
  p_now timestamptz DEFAULT clock_timestamp()
) RETURNS TABLE (
  phase text, rows_affected integer, duration_ms integer, skipped_lock boolean, error jsonb
)
LANGUAGE plpgsql
AS $$
DECLARE v_started_at timestamptz;
DECLARE v_policy workhorse.retention_policy%ROWTYPE;
DECLARE v_maintenance workhorse.maintenance_policy%ROWTYPE;
DECLARE v_state workhorse.maintenance_state%ROWTYPE;
DECLARE v_local_now timestamp;
DECLARE v_event_before timestamptz;
DECLARE v_attempt_before timestamptz;
DECLARE v_event_target timestamptz;
DECLARE v_attempt_target timestamptz;
DECLARE v_occurrence_before timestamptz;
DECLARE v_safe_before timestamptz;
DECLARE v_rolled_up_through timestamptz;
DECLARE v_cold_export_enabled boolean;
DECLARE v_event_exported_through timestamptz;
DECLARE v_attempt_exported_through timestamptz;
DECLARE v_success boolean := true;
DECLARE v_complete boolean := false;
DECLARE v_run_started_at timestamptz;
DECLARE v_run_completed_at timestamptz;
DECLARE v_rows_affected integer := 0;
DECLARE v_phases jsonb := '[]'::jsonb;
BEGIN
  IF p_now IS NULL OR NOT isfinite(p_now) THEN RAISE EXCEPTION 'maintenance time is required'; END IF;
  IF NOT pg_try_advisory_xact_lock(
    hashtextextended('workhorse:maintenance:history-retention', 0)
  ) THEN
    RETURN QUERY VALUES
      ('event_retention'::text, 0, 0, true, NULL::jsonb),
      ('attempt_retention'::text, 0, 0, true, NULL::jsonb),
      ('schedule_occurrences'::text, 0, 0, true, NULL::jsonb);
    RETURN;
  END IF;
  SELECT * INTO STRICT v_policy FROM workhorse.retention_policy WHERE singleton;
  SELECT * INTO STRICT v_maintenance FROM workhorse.maintenance_policy WHERE singleton;
  SELECT * INTO STRICT v_state FROM workhorse.maintenance_state
   WHERE routine_name = 'history_retention' FOR UPDATE;
  v_local_now := p_now AT TIME ZONE v_maintenance.timezone;
  IF NOT p_force AND (
    v_local_now::time(0) < v_maintenance.history_retention_local_time
    OR v_state.last_completed_local_date >= v_local_now::date
  ) THEN
    RETURN;
  END IF;
  v_run_started_at := clock_timestamp();
  UPDATE workhorse.maintenance_state SET last_started_at = p_now, updated_at = clock_timestamp()
   WHERE routine_name = 'history_retention';
  v_event_before := date_trunc('day', p_now AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
    - make_interval(days => COALESCE(v_policy.task_event_retention_days, 0));
  v_attempt_before := date_trunc('day', p_now AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
    - make_interval(days => COALESCE(v_policy.attempt_history_retention_days, 0));
  v_occurrence_before := p_now
    - make_interval(days => COALESCE(v_policy.schedule_occurrence_retention_days, 0));
  -- The policy cutoffs before any clamp. A pass is complete only when no history before them
  -- remains, so a pass that a clamp holds back records incomplete and stays due (SM-1979).
  v_event_target := v_event_before;
  v_attempt_target := v_attempt_before;
  -- Raw history is the only input a statistics bucket can be rebuilt from. Deleting past the rollup
  -- watermark would create a permanent hole in long-window operator views, so a stalled rollup
  -- holds history instead: the cutoff waits, retention reports itself incomplete and runs again on
  -- the next offer, and the growing retention lag is what surfaces on the health page.
  SELECT state.rolled_up_through INTO v_rolled_up_through
    FROM workhorse.task_stat_state state WHERE state.singleton;
  IF v_rolled_up_through IS NOT NULL THEN
    v_event_before := LEAST(v_event_before, v_rolled_up_through);
    v_attempt_before := LEAST(v_attempt_before, v_rolled_up_through);
  END IF;
  -- A completed cold export is the second interlock, and only while export is enabled. Deleting a
  -- day that no export covers would leave the archive permanently incomplete, so an exporter that
  -- falls behind holds history the same way a stalled rollup does and surfaces the same way.
  SELECT policy.enabled INTO v_cold_export_enabled
    FROM workhorse.cold_export_policy policy WHERE policy.singleton;
  IF COALESCE(v_cold_export_enabled, false) THEN
    SELECT exported.exported_through INTO v_event_exported_through
      FROM workhorse.cold_export_dataset exported WHERE exported.dataset = 'task_event';
    SELECT exported.exported_through INTO v_attempt_exported_through
      FROM workhorse.cold_export_dataset exported WHERE exported.dataset = 'attempt_history';
    v_event_before := LEAST(
      v_event_before,
      COALESCE(v_event_exported_through, timestamp '2000-01-01' AT TIME ZONE 'UTC')
    );
    v_attempt_before := LEAST(
      v_attempt_before,
      COALESCE(v_attempt_exported_through, timestamp '2000-01-01' AT TIME ZONE 'UTC')
    );
  END IF;

  phase := 'event_retention';
  rows_affected := 0;
  skipped_lock := false;
  error := NULL;
  v_started_at := clock_timestamp();
  BEGIN
    IF v_policy.task_event_retention_days IS NOT NULL THEN
      rows_affected := workhorse.retire_history_partitions_v1(
        'task_event', v_event_before, v_policy.history_partitions_per_pass
      );
      rows_affected := rows_affected + workhorse.prune_default_history_v1(
        'task_event', v_event_before, v_policy.default_partition_rows_per_pass
      );
    END IF;
  EXCEPTION WHEN OTHERS THEN
    error := jsonb_build_object('code', SQLSTATE, 'message', SQLERRM);
    v_success := false;
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

  phase := 'attempt_retention';
  rows_affected := 0;
  error := NULL;
  v_started_at := clock_timestamp();
  BEGIN
    IF v_policy.attempt_history_retention_days IS NOT NULL THEN
      rows_affected := workhorse.retire_history_partitions_v1(
        'attempt_history', v_attempt_before, v_policy.history_partitions_per_pass
      );
      rows_affected := rows_affected + workhorse.prune_default_history_v1(
        'attempt_history', v_attempt_before, v_policy.default_partition_rows_per_pass
      );
    END IF;
  EXCEPTION WHEN OTHERS THEN
    error := jsonb_build_object('code', SQLSTATE, 'message', SQLERRM);
    v_success := false;
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

  phase := 'schedule_occurrences';
  rows_affected := 0;
  error := NULL;
  v_started_at := clock_timestamp();
  BEGIN
    IF v_policy.schedule_occurrence_retention_days IS NOT NULL THEN
      rows_affected := workhorse.prune_schedule_occurrences_v1(
        v_occurrence_before,
        v_policy.occurrence_rows_per_pass
      );
    END IF;
  EXCEPTION WHEN OTHERS THEN
    error := jsonb_build_object('code', SQLSTATE, 'message', SQLERRM);
    v_success := false;
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

  IF v_success THEN
    v_complete := (
      v_policy.task_event_retention_days IS NULL
      OR workhorse.history_retention_complete_v1('task_event', v_event_target)
    ) AND (
      v_policy.attempt_history_retention_days IS NULL
      OR workhorse.history_retention_complete_v1('attempt_history', v_attempt_target)
    ) AND (
      v_policy.schedule_occurrence_retention_days IS NULL
      OR NOT EXISTS (
        SELECT 1 FROM workhorse.schedule_occurrence
         WHERE occurrence_at < v_occurrence_before
      )
    );
    IF v_complete THEN
      v_safe_before := LEAST(v_event_before, v_attempt_before);
      UPDATE workhorse.maintenance_state
         SET last_completed_at = p_now,
             last_completed_local_date = v_local_now::date,
             history_retained_before = GREATEST(history_retained_before, v_safe_before),
             updated_at = clock_timestamp()
      WHERE routine_name = 'history_retention';
    END IF;
  END IF;
  v_run_completed_at := clock_timestamp();
  PERFORM workhorse.record_maintenance_run_internal_v1(
    'history_retention', v_run_started_at, v_run_completed_at,
    CASE WHEN NOT v_success THEN 'failed'
         WHEN v_complete THEN 'succeeded'
         ELSE 'incomplete' END,
    v_rows_affected, v_phases
  );
END;
$$;

CREATE OR REPLACE FUNCTION workhorse.complete_human_wait_v1(
  p_task_id uuid,
  p_token_name text,
  p_result jsonb,
  p_idempotency_key text,
  p_completed_by text
) RETURNS TABLE (
  status text,
  result jsonb,
  completed_at timestamptz,
  completed_by text
)
LANGUAGE plpgsql
AS $$
DECLARE
  v_wait workhorse.task_human_wait%ROWTYPE;
  v_runtime workhorse.task_runtime%ROWTYPE;
  v_key_hash bytea;
  v_key_digest text;
  v_fingerprint jsonb;
  v_now timestamptz;
  v_reason text;
BEGIN
  IF p_token_name IS NULL OR p_token_name = '' OR char_length(p_token_name) > 200 THEN
    RAISE EXCEPTION 'token_name must contain between 1 and 200 characters';
  END IF;
  IF p_token_name <> btrim(p_token_name) THEN
    RAISE EXCEPTION 'token_name must not have leading or trailing whitespace';
  END IF;
  IF p_result IS NULL OR octet_length(p_result::text) > 65536 THEN
    RAISE EXCEPTION 'human wait result must be JSON and at most 65536 bytes';
  END IF;
  IF p_idempotency_key IS NULL OR octet_length(p_idempotency_key) NOT BETWEEN 1 AND 512 THEN
    RAISE EXCEPTION 'human wait idempotency key must contain between 1 and 512 UTF-8 bytes';
  END IF;
  IF p_completed_by IS NULL OR p_completed_by = '' OR char_length(p_completed_by) > 200 THEN
    RAISE EXCEPTION 'human wait completed_by must contain between 1 and 200 characters';
  END IF;

  v_key_hash := workhorse.idempotency_key_hash_v1(
    'human-wait:' || p_task_id::text || ':' || p_token_name, p_idempotency_key
  );
  v_key_digest := left(encode(v_key_hash, 'hex'), 12);
  v_fingerprint := jsonb_build_object('result', p_result, 'completedBy', p_completed_by);
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'workhorse:human-wait:' || p_task_id::text || ':' || p_token_name, 0
  ));

  IF NOT EXISTS (SELECT 1 FROM workhorse.task WHERE id = p_task_id) THEN
    RETURN QUERY VALUES ('not_found'::text, NULL::jsonb, NULL::timestamptz, NULL::text);
    RETURN;
  END IF;
  SELECT * INTO v_wait
    FROM workhorse.task_human_wait stored
   WHERE stored.task_id = p_task_id AND stored.token_name = p_token_name
   FOR UPDATE;
  IF NOT FOUND THEN
    -- No row lock was taken, so the event can be the first write of the transaction. Take the
    -- transaction ID before the event reads its time, as the cold export frontier needs (ADR 0121).
    PERFORM pg_current_xact_id();
    INSERT INTO workhorse.task_event(task_id, event_type, details)
      VALUES (
        p_task_id, 'human_wait_rejected',
        jsonb_build_object(
          'name', p_token_name, 'reason', 'not_waiting', 'completed_by', p_completed_by,
          'idempotency_key_digest', v_key_digest
        )
      );
    RETURN QUERY VALUES ('not_waiting'::text, NULL::jsonb, NULL::timestamptz, NULL::text);
    RETURN;
  END IF;

  IF v_wait.completed_at IS NOT NULL THEN
    IF v_wait.idempotency_key_hash = v_key_hash THEN
      IF v_wait.request_fingerprint IS DISTINCT FROM v_fingerprint THEN
        v_reason := 'idempotency_conflict';
        status := 'conflict';
      ELSE
        RETURN QUERY VALUES (
          'duplicate'::text, v_wait.result, v_wait.completed_at, v_wait.completed_by
        );
        RETURN;
      END IF;
    ELSE
      v_reason := 'already_completed';
      status := 'already_completed';
    END IF;
    INSERT INTO workhorse.task_event(task_id, attempt, event_type, details)
      VALUES (
        p_task_id, v_wait.attempt, 'human_wait_rejected',
        jsonb_build_object(
          'name', p_token_name, 'reason', v_reason, 'completed_by', p_completed_by,
          'idempotency_key_digest', v_key_digest
        )
      );
    RETURN QUERY VALUES (status, v_wait.result, v_wait.completed_at, v_wait.completed_by);
    RETURN;
  END IF;

  SELECT * INTO v_runtime
    FROM workhorse.task_runtime runtime
   WHERE runtime.task_id = p_task_id
     AND runtime.state = 'scheduled'
     AND runtime.wait_name = p_token_name
     AND runtime.current_attempt = v_wait.attempt
   FOR UPDATE;
  v_now := clock_timestamp();
  IF NOT FOUND OR (v_runtime.deadline_at IS NOT NULL AND v_runtime.deadline_at <= v_now) THEN
    INSERT INTO workhorse.task_event(task_id, attempt, event_type, details)
      VALUES (
        p_task_id, v_wait.attempt, 'human_wait_rejected',
        jsonb_build_object(
          'name', p_token_name, 'reason', 'stale', 'completed_by', p_completed_by,
          'idempotency_key_digest', v_key_digest
        )
      );
    RETURN QUERY VALUES ('stale'::text, NULL::jsonb, NULL::timestamptz, NULL::text);
    RETURN;
  END IF;

  UPDATE workhorse.task_human_wait stored
     SET result = p_result, idempotency_key_hash = v_key_hash,
         request_fingerprint = v_fingerprint, completed_by = p_completed_by, completed_at = v_now
   WHERE stored.task_id = p_task_id AND stored.token_name = p_token_name
   RETURNING * INTO v_wait;
  UPDATE workhorse.task_runtime runtime
     SET state = 'ready', run_at = v_now, ready_at = v_now,
         sequence = nextval('workhorse.ready_sequence_seq'), wait_name = NULL,
         deadline_at = (SELECT task.deadline_at FROM workhorse.task task WHERE task.id = p_task_id),
         updated_at = v_now
   WHERE runtime.task_id = p_task_id;
  INSERT INTO workhorse.task_event(task_id, attempt, event_type, details)
    VALUES (
      p_task_id, v_wait.attempt, 'human_wait_completed',
      jsonb_build_object(
        'name', p_token_name, 'completed_by', p_completed_by,
        'idempotency_key_digest', v_key_digest, 'result_bytes', octet_length(p_result::text)
      )
    );
  PERFORM pg_notify('workhorse_tasks', v_runtime.queue_name);
  RETURN QUERY VALUES ('completed'::text, v_wait.result, v_wait.completed_at, v_wait.completed_by);
END;
$$;
