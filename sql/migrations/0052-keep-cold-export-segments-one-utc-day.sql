-- workhorse-migration: {"kind":"additive"}

-- Keep cold-export segments exactly one UTC day long whatever the session TimeZone is (SM-1000).

-- Schema version 50 ended a cold-export segment at its start plus interval '1 day'. PostgreSQL adds
-- a day interval to a timestamptz as a calendar day in the session TimeZone. In a session with
-- daylight saving, the segment that crossed a transition lasted 23 or 25 hours. Every later segment
-- then started off UTC midnight until the opposite transition, so two segments could share a UTC
-- date and the date-derived object key of ADR 0068.
--
-- claim_cold_export_segment_v1 now steps a fixed 24 hours. stat_buckets_v1 steps its day boundary
-- the same way. Two new checks require a dataset watermark at UTC midnight, and a segment that
-- starts at UTC midnight and lasts exactly 86,400 seconds. They add to the existing checks.
--
-- Stop every cold exporter before this upgrade, and wait until its object and manifest uploads have
-- finished. Keep the cold-export policy enabled, so retention keeps waiting for the export. The
-- repair below fences a stale exporter out of the ledger. It cannot cancel an upload that is still
-- in flight, and that upload writes the object key of the corrected day.
--
-- Existing rows that break the checks are repaired before the checks validate. The repair holds
-- the history-retention and terminal-storage maintenance locks, so no retention pass that read the
-- old watermark deletes history while the repair decides what to export again. It also locks the
-- cold-export policy and ledger, so no exporter claims or completes a segment meanwhile:
--
-- * A dataset with a complete segment off UTC midnight or of the wrong length rewinds its watermark
--   to the UTC day the earliest such segment started in. Two such segments could share that day's
--   object key, so the later one overwrote the earlier one's object. The rewind stops at the oldest
--   day retention still holds, and the migration raises a warning naming the days it cannot
--   re-export. Retention reads the watermark, so it holds the rewound days until the export copies
--   them again.
-- * Retention also removes part of a day, so the rewind also stops after the last complete segment
--   whose range now holds fewer rows than it archived. Exporting such a day again would replace its
--   object with fewer rows. When that segment ends off UTC midnight, the watermark moves up to the
--   next UTC midnight instead of down, and the same warning names the days it skips.
-- * A complete segment of the wrong length that starts at a UTC midnight on or after the rewound
--   watermark returns to exporting as one UTC day. Its attempt count increases, so the exporter
--   that wrote the damaged object cannot complete it again. A warning reports these per dataset.
-- * An exporting segment that starts at UTC midnight but has the wrong length is extended to 24
--   hours. Its attempt count increases and its lease ends, so the exporter that held the shorter
--   range cannot complete it. The next claim exports the whole day.
-- * Any other segment off UTC midnight or of the wrong length is deleted. A complete one's archive
--   object stays in the bucket, but the ledger no longer names it. The export never returns to a
--   deleted day before the rewound watermark, so no claim recreates it. The migration raises a
--   warning with the number of deleted rows and their range for each dataset.
-- * Any other dataset watermark off UTC midnight is rounded down to the UTC midnight before it.
--   The export resumes there and re-exports the source rows of that day that retention still
--   holds. Rows retention removed before the upgrade cannot be exported again.

DO $$
DECLARE v_damage record;
DECLARE v_dropped record;
DECLARE v_datasets text[] := ARRAY[]::text[];
DECLARE v_targets timestamptz[] := ARRAY[]::timestamptz[];
DECLARE v_watermark timestamptz;
DECLARE v_watermark_ceiling timestamptz;
DECLARE v_held timestamptz;
DECLARE v_damaged timestamptz;
DECLARE v_oldest timestamptz;
DECLARE v_target timestamptz;
DECLARE v_next_end timestamptz;
BEGIN
  -- History retention and terminal-storage pruning, which deletes fast-tier outcomes, read the
  -- watermark this repair may rewind. Their locks keep a pass that sampled the old watermark from
  -- deleting the history a rewound day still needs. Both passes try the locks and skip while held.
  PERFORM pg_advisory_xact_lock(hashtextextended('workhorse:maintenance:history-retention', 0));
  PERFORM pg_advisory_xact_lock(hashtextextended('workhorse:maintenance:terminal-storage', 0));
  -- Locking the ledger before the damage search keeps an exporter from completing a damaged
  -- segment, or claiming the next one, between the search and the repair. The ALTER TABLE below
  -- needs these locks anyway. Taken now, an exporter waits for the table instead of holding it while
  -- it waits for a dataset row, which would deadlock with that ALTER. The policy row comes first,
  -- as in set_cold_export_policy_v1, which locks it before the dataset rows.
  PERFORM FROM workhorse.cold_export_policy policy WHERE policy.singleton FOR UPDATE;
  LOCK TABLE workhorse.cold_export_dataset, workhorse.cold_export_segment IN ACCESS EXCLUSIVE MODE;

  -- A damaged complete segment may have overwritten the object of the UTC day it started in, and
  -- every later damaged day is suspect too. Export resumes at the first of those days that
  -- retention still holds, and retention, which reads the watermark, now waits for that export.
  FOR v_damage IN
    SELECT segment.dataset, min(segment.segment_start) AS first_start
      FROM workhorse.cold_export_segment segment
     WHERE segment.status = 'complete'
       AND (segment.segment_start
              <> date_trunc('day', segment.segment_start AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
            OR extract(epoch FROM segment.segment_end - segment.segment_start) <> 86400)
     GROUP BY segment.dataset
     ORDER BY segment.dataset
  LOOP
    SELECT exported.exported_through INTO v_watermark
      FROM workhorse.cold_export_dataset exported
     WHERE exported.dataset = v_damage.dataset
       FOR UPDATE;
    CONTINUE WHEN NOT FOUND;
    v_watermark_ceiling := date_trunc('day', (v_watermark - interval '1 microsecond')
      AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' + interval '24 hours';
    v_watermark := date_trunc('day', v_watermark AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';
    v_damaged := date_trunc('day', v_damage.first_start AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';
    v_oldest := workhorse.cold_export_oldest_history_day_internal_v1(v_damage.dataset);
    v_target := LEAST(v_watermark, GREATEST(v_damaged, COALESCE(v_oldest, v_watermark)));
    -- Exporting a day again rewrites its object. Retention may have removed part of a day, because
    -- fast-tier outcomes leave row by row, so the oldest surviving row does not prove the day is
    -- whole. A complete segment whose range now holds fewer rows than it archived proves the
    -- opposite. Export resumes at the first UTC midnight after the last such segment, so it never
    -- replaces an object with fewer rows. Earlier objects stay in the bucket as they are.
    SELECT date_trunc('day', (max(segment.segment_end) - interval '1 microsecond')
             AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' + interval '24 hours'
      INTO v_held
      FROM workhorse.cold_export_segment segment
     WHERE segment.dataset = v_damage.dataset
       AND segment.status = 'complete'
       AND segment.segment_start >= v_damaged
       AND COALESCE(segment.row_count, 0) > CASE segment.dataset
             WHEN 'task_event' THEN (
               SELECT count(*) FROM workhorse.task_event history
                WHERE history.occurred_at >= segment.segment_start
                  AND history.occurred_at < segment.segment_end)
             WHEN 'attempt_history' THEN (
               SELECT count(*) FROM workhorse.attempt_history history
                WHERE history.occurred_at >= segment.segment_start
                  AND history.occurred_at < segment.segment_end)
             ELSE (
               SELECT count(*) FROM workhorse.fast_task_outcome outcome
                WHERE outcome.finished_at >= segment.segment_start
                  AND outcome.finished_at < segment.segment_end)
           END;
    IF v_held > v_target THEN
      v_target := LEAST(v_held, v_watermark_ceiling);
    END IF;
    IF v_oldest IS NULL OR v_oldest > v_damaged OR v_target > v_damaged THEN
      RAISE WARNING 'cold export of % cannot re-export the days from % up to %: retention already removed some of their history, so their archive objects may hold another day''s rows',
        v_damage.dataset, v_damaged AT TIME ZONE 'UTC',
        GREATEST(v_target, LEAST(COALESCE(v_oldest, v_watermark), v_watermark))
          AT TIME ZONE 'UTC';
    END IF;
    v_datasets := v_datasets || v_damage.dataset;
    v_targets := v_targets || v_target;
  END LOOP;

  -- A segment off UTC midnight cannot become one UTC day, so it goes. So does a damaged complete
  -- day before the rewound watermark: the export never returns there, so no claim recreates it.
  FOR v_dropped IN
    WITH rewound AS (
      SELECT rewound.dataset, rewound.target
        FROM unnest(v_datasets, v_targets) AS rewound(dataset, target)
    ), deleted AS (
      DELETE FROM workhorse.cold_export_segment segment
       WHERE segment.segment_start
               <> date_trunc('day', segment.segment_start AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
          OR (segment.status = 'complete'
              AND extract(epoch FROM segment.segment_end - segment.segment_start) <> 86400
              AND NOT COALESCE(
                    (SELECT segment.segment_start >= rewound.target
                       FROM rewound WHERE rewound.dataset = segment.dataset),
                    false))
      RETURNING segment.dataset, segment.segment_start, segment.segment_end, segment.status
    )
    SELECT deleted.dataset,
           count(*) FILTER (WHERE deleted.status = 'complete') AS complete,
           count(*) FILTER (WHERE deleted.status = 'exporting') AS exporting,
           min(deleted.segment_start) AS first_start,
           max(deleted.segment_end) AS last_end
      FROM deleted
     GROUP BY deleted.dataset
     ORDER BY deleted.dataset
  LOOP
    RAISE WARNING 'cold export of % dropped % complete and % exporting segments between % and % that were not one UTC day; their archive objects stay in the bucket',
      v_dropped.dataset, v_dropped.complete, v_dropped.exporting,
      v_dropped.first_start AT TIME ZONE 'UTC', v_dropped.last_end AT TIME ZONE 'UTC';
  END LOOP;

  -- A damaged complete day at or after the rewound watermark keeps its row and its attempt count.
  -- It returns to exporting as one UTC day with the count raised, so a delayed completion from the
  -- exporter that wrote the damaged object no longer matches the fence.
  FOR v_dropped IN
    WITH requeued AS (
      UPDATE workhorse.cold_export_segment segment
         SET status = 'exporting',
             segment_end = segment.segment_start + interval '24 hours',
             attempts = segment.attempts + 1,
             exporter_id = NULL,
             lease_expires_at = NULL,
             object_key = NULL,
             manifest_key = NULL,
             checksum_sha256 = NULL,
             byte_length = NULL,
             row_count = NULL,
             last_error = NULL,
             completed_at = NULL,
             updated_at = clock_timestamp()
       WHERE segment.status = 'complete'
         AND extract(epoch FROM segment.segment_end - segment.segment_start) <> 86400
      RETURNING segment.dataset, segment.segment_start
    )
    SELECT requeued.dataset, count(*) AS requeued, min(requeued.segment_start) AS first_start,
           max(requeued.segment_start) + interval '24 hours' AS last_end
      FROM requeued
     GROUP BY requeued.dataset
     ORDER BY requeued.dataset
  LOOP
    RAISE WARNING 'cold export of % queued % complete segments between % and % that were not one UTC day to export again as whole UTC days',
      v_dropped.dataset, v_dropped.requeued,
      v_dropped.first_start AT TIME ZONE 'UTC', v_dropped.last_end AT TIME ZONE 'UTC';
  END LOOP;

  FOR v_damage IN
    SELECT rewound.dataset, rewound.target
      FROM unnest(v_datasets, v_targets) AS rewound(dataset, target)
  LOOP
    v_target := v_damage.target;
    SELECT date_trunc('day', exported.exported_through AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
      INTO v_watermark
      FROM workhorse.cold_export_dataset exported
     WHERE exported.dataset = v_damage.dataset;
    -- Step over days that still hold a complete one-day segment, as completing a segment would.
    LOOP
      SELECT segment.segment_end INTO v_next_end
        FROM workhorse.cold_export_segment segment
       WHERE segment.dataset = v_damage.dataset
         AND segment.segment_start = v_target
         AND segment.status = 'complete';
      EXIT WHEN NOT FOUND OR v_target >= v_watermark;
      v_target := v_next_end;
    END LOOP;
    UPDATE workhorse.cold_export_dataset exported
       SET exported_through = v_target, updated_at = clock_timestamp()
     WHERE exported.dataset = v_damage.dataset
       AND exported.exported_through <> v_target;
  END LOOP;
END;
$$;

UPDATE workhorse.cold_export_segment segment
   SET segment_end = segment.segment_start + interval '24 hours',
       attempts = segment.attempts + 1,
       lease_expires_at = NULL,
       updated_at = clock_timestamp()
 WHERE segment.status = 'exporting'
   AND extract(epoch FROM segment.segment_end - segment.segment_start) <> 86400;

UPDATE workhorse.cold_export_dataset exported
   SET exported_through
         = date_trunc('day', exported.exported_through AT TIME ZONE 'UTC') AT TIME ZONE 'UTC',
       updated_at = clock_timestamp()
 WHERE exported.exported_through
       <> date_trunc('day', exported.exported_through AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';

ALTER TABLE workhorse.cold_export_dataset
  ADD CONSTRAINT cold_export_dataset_utc_midnight_check CHECK (
    exported_through = date_trunc('day', exported_through AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
  ) NOT VALID;
ALTER TABLE workhorse.cold_export_dataset VALIDATE CONSTRAINT cold_export_dataset_utc_midnight_check;

ALTER TABLE workhorse.cold_export_segment
  ADD CONSTRAINT cold_export_segment_utc_day_check CHECK (
    segment_start = date_trunc('day', segment_start AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
    AND extract(epoch FROM segment_end - segment_start) = 86400
  ) NOT VALID;
ALTER TABLE workhorse.cold_export_segment VALIDATE CONSTRAINT cold_export_segment_utc_day_check;

-- Statistics for [p_from, p_to) stitched from materialized buckets and a live tail. Callers never
-- need to know where the rollup watermark sits: everything below it is read, everything above it is
-- derived from the few minutes of raw history a rollup pass has not closed yet. A day boundary steps
-- a fixed 24 hours, so a session TimeZone with daylight saving cannot move it off UTC midnight.
CREATE OR REPLACE FUNCTION workhorse.stat_buckets_v1(
  p_from timestamptz, p_to timestamptz
) RETURNS TABLE (
  bucket_start timestamptz, queue_name text, task_type text, enqueued bigint,
  task_succeeded bigint, task_failed bigint, task_canceled bigint,
  attempt_succeeded bigint, attempt_failed bigint, attempt_retry bigint,
  attempt_lease_expired bigint, attempt_canceled bigint, attempt_other bigint,
  attempt_duration_ms numeric, wait_sketch jsonb,
  last_attempt_at timestamptz, last_error text, last_error_at timestamptz
)
LANGUAGE sql STABLE
AS $$
  WITH selected AS (
    SELECT workhorse.stat_window_tier_v1(p_from, p_to) AS tier
  ), boundary AS (
    SELECT selected.tier IN ('hour', 'day') AS use_hour,
           selected.tier = 'day' AS use_day,
           CASE WHEN p_from = date_bin('1 hour', p_from, timestamp '2000-01-01' AT TIME ZONE 'UTC')
             THEN p_from ELSE date_bin('1 hour', p_from,
               timestamp '2000-01-01' AT TIME ZONE 'UTC') + interval '1 hour' END AS hour_start,
           date_bin('1 hour', p_to, timestamp '2000-01-01' AT TIME ZONE 'UTC') AS hour_end,
           CASE WHEN p_from = date_bin('1 day', p_from, timestamp '2000-01-01' AT TIME ZONE 'UTC')
             THEN p_from ELSE date_bin('1 day', p_from,
               timestamp '2000-01-01' AT TIME ZONE 'UTC') + interval '24 hours' END AS day_start,
           date_bin('1 day', p_to, timestamp '2000-01-01' AT TIME ZONE 'UTC') AS day_end,
           (SELECT state.rolled_up_through FROM workhorse.task_stat_state state WHERE singleton)
             AS minute_watermark
      FROM selected
  ), stored AS (
    SELECT bucket.bucket_start, bucket.queue_name, bucket.task_type,
           bucket.enqueued::bigint, bucket.task_succeeded::bigint, bucket.task_failed::bigint,
           bucket.task_canceled::bigint, bucket.attempt_succeeded::bigint,
           bucket.attempt_failed::bigint, bucket.attempt_retry::bigint,
           bucket.attempt_lease_expired::bigint, bucket.attempt_canceled::bigint,
           bucket.attempt_other::bigint, bucket.attempt_duration_ms::numeric,
           bucket.wait_sketch, bucket.last_attempt_at, bucket.last_error, bucket.last_error_at
      FROM workhorse.task_stat_bucket bucket, boundary
     WHERE bucket.bucket_start >= p_from
       AND bucket.bucket_start < LEAST(p_to, boundary.minute_watermark)
       AND (
         NOT boundary.use_hour
         OR bucket.bucket_start < boundary.hour_start
         OR bucket.bucket_start >= boundary.hour_end
       )
    UNION ALL
    SELECT bucket.bucket_start, bucket.queue_name, bucket.task_type,
           bucket.enqueued, bucket.task_succeeded, bucket.task_failed, bucket.task_canceled,
           bucket.attempt_succeeded, bucket.attempt_failed, bucket.attempt_retry,
           bucket.attempt_lease_expired, bucket.attempt_canceled, bucket.attempt_other,
           bucket.attempt_duration_ms, bucket.wait_sketch,
           bucket.last_attempt_at, bucket.last_error, bucket.last_error_at
      FROM workhorse.task_stat_bucket_hour bucket, boundary
     WHERE boundary.use_hour
       AND bucket.bucket_start >= boundary.hour_start AND bucket.bucket_start < boundary.hour_end
       AND (
         NOT boundary.use_day
         OR bucket.bucket_start < boundary.day_start
         OR bucket.bucket_start >= boundary.day_end
       )
    UNION ALL
    SELECT bucket.bucket_start, bucket.queue_name, bucket.task_type,
           bucket.enqueued, bucket.task_succeeded, bucket.task_failed, bucket.task_canceled,
           bucket.attempt_succeeded, bucket.attempt_failed, bucket.attempt_retry,
           bucket.attempt_lease_expired, bucket.attempt_canceled, bucket.attempt_other,
           bucket.attempt_duration_ms, bucket.wait_sketch,
           bucket.last_attempt_at, bucket.last_error, bucket.last_error_at
      FROM workhorse.task_stat_bucket_day bucket, boundary
     WHERE boundary.use_day
       AND bucket.bucket_start >= boundary.day_start AND bucket.bucket_start < boundary.day_end
  )
  SELECT * FROM stored
  UNION ALL
  SELECT live.bucket_start, live.queue_name, live.task_type, live.enqueued::bigint,
         live.task_succeeded::bigint, live.task_failed::bigint, live.task_canceled::bigint,
         live.attempt_succeeded::bigint, live.attempt_failed::bigint, live.attempt_retry::bigint,
         live.attempt_lease_expired::bigint, live.attempt_canceled::bigint,
         live.attempt_other::bigint, live.attempt_duration_ms::numeric, live.wait_sketch,
         live.last_attempt_at, live.last_error, live.last_error_at
    FROM workhorse.aggregate_stats_v1(
           GREATEST(p_from, (
             SELECT state.rolled_up_through FROM workhorse.task_stat_state state WHERE state.singleton
           )),
           p_to
         ) live
   WHERE p_to > (
           SELECT state.rolled_up_through FROM workhorse.task_stat_state state WHERE state.singleton
         )
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
  SELECT exported.exported_through INTO v_exported_through
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
  IF FOUND THEN
    IF v_segment.lease_expires_at IS NOT NULL AND v_segment.lease_expires_at > p_now THEN
      RETURN;
    END IF;
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
    -- A fixed 24 hours, not '1 day': timestamptz plus a day interval steps a calendar day in the
    -- session TimeZone, which is 23 or 25 hours across a daylight-saving transition.
    IF v_exported_through + interval '24 hours' > v_limit THEN RETURN; END IF;
    INSERT INTO workhorse.cold_export_segment(
      dataset, segment_start, segment_end, status, attempts, exporter_id, lease_expires_at,
      started_at
    ) VALUES (
      p_dataset, v_exported_through, v_exported_through + interval '24 hours', 'exporting', 1,
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
