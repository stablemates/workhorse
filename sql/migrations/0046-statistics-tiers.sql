-- Add mergeable wait sketches and derive hour/day summaries from the existing minute tier.

ALTER TABLE workhorse.job_stat_bucket
  ADD COLUMN wait_sketch jsonb NOT NULL DEFAULT '{}'::jsonb
  CHECK (jsonb_typeof(wait_sketch) = 'object');

CREATE TABLE workhorse.job_stat_bucket_hour (
  bucket_start timestamptz NOT NULL CHECK (isfinite(bucket_start)),
  queue_name text NOT NULL CHECK (queue_name <> ''),
  job_type text NOT NULL CHECK (job_type <> ''),
  enqueued bigint NOT NULL DEFAULT 0 CHECK (enqueued >= 0),
  job_succeeded bigint NOT NULL DEFAULT 0 CHECK (job_succeeded >= 0),
  job_failed bigint NOT NULL DEFAULT 0 CHECK (job_failed >= 0),
  job_canceled bigint NOT NULL DEFAULT 0 CHECK (job_canceled >= 0),
  attempt_succeeded bigint NOT NULL DEFAULT 0 CHECK (attempt_succeeded >= 0),
  attempt_failed bigint NOT NULL DEFAULT 0 CHECK (attempt_failed >= 0),
  attempt_retry bigint NOT NULL DEFAULT 0 CHECK (attempt_retry >= 0),
  attempt_lease_expired bigint NOT NULL DEFAULT 0 CHECK (attempt_lease_expired >= 0),
  attempt_canceled bigint NOT NULL DEFAULT 0 CHECK (attempt_canceled >= 0),
  attempt_other bigint NOT NULL DEFAULT 0 CHECK (attempt_other >= 0),
  attempt_duration_ms numeric NOT NULL DEFAULT 0 CHECK (attempt_duration_ms >= 0),
  wait_sketch jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(wait_sketch) = 'object'),
  last_attempt_at timestamptz,
  last_error text CHECK (last_error IS NULL OR char_length(last_error) <= 500),
  last_error_at timestamptz,
  PRIMARY KEY (bucket_start, queue_name, job_type)
);

CREATE TABLE workhorse.job_stat_bucket_day (
  LIKE workhorse.job_stat_bucket_hour INCLUDING DEFAULTS INCLUDING CONSTRAINTS INCLUDING INDEXES
);

ALTER TABLE workhorse.job_stat_state
  ADD COLUMN hourly_rolled_up_through timestamptz,
  ADD COLUMN daily_rolled_up_through timestamptz;

DROP FUNCTION workhorse.rollup_stats_v1(boolean, timestamptz, integer);
DROP FUNCTION workhorse.stat_buckets_v1(timestamptz, timestamptz);
DROP FUNCTION workhorse.aggregate_stats_v1(timestamptz, timestamptz, integer);

CREATE OR REPLACE FUNCTION workhorse.stat_sketch_index_v1(p_value_ms double precision)
RETURNS integer
LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT
AS $$
  SELECT floor(ln(1 + GREATEST(p_value_ms, 0)) / ln(1.02))::integer
$$;

CREATE OR REPLACE FUNCTION workhorse.stat_sketch_merge_v1(p_sketches jsonb[])
RETURNS jsonb
LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $$
  SELECT COALESCE(jsonb_object_agg(bin, total ORDER BY bin::integer), '{}'::jsonb)
    FROM (
      SELECT entry.key AS bin, sum(entry.value::bigint) AS total
        FROM unnest(COALESCE(p_sketches, '{}'::jsonb[])) sketch
        CROSS JOIN LATERAL jsonb_each_text(sketch) entry
       GROUP BY entry.key
    ) merged
$$;

CREATE OR REPLACE FUNCTION workhorse.stat_sketch_percentile_v1(
  p_sketch jsonb, p_percentile double precision
) RETURNS double precision
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE
AS $$
DECLARE v_total bigint;
DECLARE v_target bigint;
DECLARE v_seen bigint := 0;
DECLARE v_bin integer;
DECLARE v_count bigint; BEGIN
  IF p_percentile IS NULL OR p_percentile = 'NaN'::double precision
     OR p_percentile < 0 OR p_percentile > 1 THEN
    RAISE EXCEPTION 'percentile must be between 0 and 1';
  END IF;
  SELECT COALESCE(sum(value::bigint), 0) INTO v_total
    FROM jsonb_each_text(COALESCE(p_sketch, '{}'::jsonb));
  IF v_total = 0 THEN RETURN NULL; END IF;
  v_target := GREATEST(1, ceil(p_percentile * v_total)::bigint);
  FOR v_bin, v_count IN
    SELECT key::integer, value::bigint
      FROM jsonb_each_text(p_sketch)
     ORDER BY key::integer
  LOOP
    v_seen := v_seen + v_count;
    IF v_seen >= v_target THEN
      RETURN power(1.02, v_bin + 0.5) - 1;
    END IF;
  END LOOP;
  RETURN NULL;
END;
$$;

-- Preserve every retained v45 window before the tier-aware reader can select coarse rows. Raw
-- events may have shorter retention than minute statistics, so waits are rebuilt where their
-- source remains and the other measures always derive from the retained minute rows.
WITH wait_bins AS (
  SELECT date_bin('1 minute', claimed.occurred_at,
                  timestamp with time zone '2000-01-01') AS bucket_start,
         job.queue_name, job.job_type,
         workhorse.stat_sketch_index_v1(
           extract(epoch FROM claimed.occurred_at - enqueued.occurred_at) * 1000
         ) AS bin,
         count(*)::bigint AS samples
    FROM workhorse.job_event claimed
    JOIN workhorse.job_event enqueued ON enqueued.job_id = claimed.job_id
     AND enqueued.event_type = 'enqueued'
     AND enqueued.occurred_at <= claimed.occurred_at
    JOIN workhorse.job job ON job.id = claimed.job_id
   WHERE claimed.event_type = 'claimed' AND claimed.attempt = 1
     AND claimed.occurred_at >= (SELECT min(bucket_start) FROM workhorse.job_stat_bucket)
     AND claimed.occurred_at < (
       SELECT max(bucket_start) + interval '1 minute' FROM workhorse.job_stat_bucket
     )
   GROUP BY 1, 2, 3, 4
), waits AS (
  SELECT bucket_start, queue_name, job_type,
         jsonb_object_agg(bin::text, samples ORDER BY bin) AS wait_sketch
    FROM wait_bins
   GROUP BY 1, 2, 3
)
UPDATE workhorse.job_stat_bucket bucket
   SET wait_sketch = waits.wait_sketch
  FROM waits
 WHERE bucket.bucket_start = waits.bucket_start
   AND bucket.queue_name = waits.queue_name
   AND bucket.job_type = waits.job_type;

INSERT INTO workhorse.job_stat_bucket_hour (
  bucket_start, queue_name, job_type, enqueued,
  job_succeeded, job_failed, job_canceled,
  attempt_succeeded, attempt_failed, attempt_retry,
  attempt_lease_expired, attempt_canceled, attempt_other,
  attempt_duration_ms, wait_sketch, last_attempt_at, last_error, last_error_at
)
SELECT date_bin('1 hour', bucket.bucket_start, timestamp with time zone '2000-01-01'),
       bucket.queue_name, bucket.job_type,
       sum(bucket.enqueued), sum(bucket.job_succeeded), sum(bucket.job_failed),
       sum(bucket.job_canceled), sum(bucket.attempt_succeeded),
       sum(bucket.attempt_failed), sum(bucket.attempt_retry),
       sum(bucket.attempt_lease_expired), sum(bucket.attempt_canceled),
       sum(bucket.attempt_other), sum(bucket.attempt_duration_ms),
       workhorse.stat_sketch_merge_v1(array_agg(bucket.wait_sketch)),
       max(bucket.last_attempt_at),
       (array_agg(bucket.last_error ORDER BY bucket.last_error_at DESC NULLS LAST)
         FILTER (WHERE bucket.last_error IS NOT NULL))[1],
       max(bucket.last_error_at)
  FROM workhorse.job_stat_bucket bucket
 WHERE bucket.bucket_start < (
   SELECT date_bin('1 hour', rolled_up_through, timestamp with time zone '2000-01-01')
     FROM workhorse.job_stat_state WHERE singleton
 )
 GROUP BY 1, 2, 3;

INSERT INTO workhorse.job_stat_bucket_day (
  bucket_start, queue_name, job_type, enqueued,
  job_succeeded, job_failed, job_canceled,
  attempt_succeeded, attempt_failed, attempt_retry,
  attempt_lease_expired, attempt_canceled, attempt_other,
  attempt_duration_ms, wait_sketch, last_attempt_at, last_error, last_error_at
)
SELECT date_bin('1 day', bucket.bucket_start, timestamp with time zone '2000-01-01'),
       bucket.queue_name, bucket.job_type,
       sum(bucket.enqueued), sum(bucket.job_succeeded), sum(bucket.job_failed),
       sum(bucket.job_canceled), sum(bucket.attempt_succeeded),
       sum(bucket.attempt_failed), sum(bucket.attempt_retry),
       sum(bucket.attempt_lease_expired), sum(bucket.attempt_canceled),
       sum(bucket.attempt_other), sum(bucket.attempt_duration_ms),
       workhorse.stat_sketch_merge_v1(array_agg(bucket.wait_sketch)),
       max(bucket.last_attempt_at),
       (array_agg(bucket.last_error ORDER BY bucket.last_error_at DESC NULLS LAST)
         FILTER (WHERE bucket.last_error IS NOT NULL))[1],
       max(bucket.last_error_at)
  FROM workhorse.job_stat_bucket_hour bucket
 WHERE bucket.bucket_start < (
   SELECT date_bin('1 day', rolled_up_through, timestamp with time zone '2000-01-01')
     FROM workhorse.job_stat_state WHERE singleton
 )
 GROUP BY 1, 2, 3;

UPDATE workhorse.job_stat_state
   SET hourly_rolled_up_through = date_bin(
         '1 hour', rolled_up_through, timestamp with time zone '2000-01-01'
       ),
       daily_rolled_up_through = date_bin(
         '1 day', rolled_up_through, timestamp with time zone '2000-01-01'
       );
ALTER TABLE workhorse.job_stat_state
  ALTER COLUMN hourly_rolled_up_through SET NOT NULL,
  ALTER COLUMN daily_rolled_up_through SET NOT NULL,
  ADD CHECK (isfinite(hourly_rolled_up_through)),
  ADD CHECK (isfinite(daily_rolled_up_through));

CREATE OR REPLACE FUNCTION workhorse.stat_window_tier_v1(
  p_from timestamptz, p_to timestamptz
) RETURNS text
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE
AS $$ BEGIN
  IF p_from IS NULL OR p_to IS NULL OR NOT isfinite(p_from) OR NOT isfinite(p_to)
     OR p_to <= p_from THEN
    RAISE EXCEPTION 'statistics window must have finite increasing bounds';
  END IF;
  IF p_to - p_from >= interval '90 days' THEN
    IF p_from <> date_bin('1 day', p_from, timestamp with time zone '2000-01-01') THEN
      RAISE EXCEPTION 'statistics windows of at least 90 days require a day-aligned lower bound';
    END IF;
    RETURN 'day';
  END IF;
  IF p_to - p_from >= interval '2 days' THEN
    IF p_from <> date_bin('1 hour', p_from, timestamp with time zone '2000-01-01') THEN
      RAISE EXCEPTION 'statistics windows of at least 2 days require an hour-aligned lower bound';
    END IF;
    RETURN 'hour';
  END IF;
  IF p_from <> date_bin('1 minute', p_from, timestamp with time zone '2000-01-01') THEN
    RAISE EXCEPTION 'statistics windows require a minute-aligned lower bound';
  END IF;
  RETURN 'minute';
END;
$$;

-- Derive per-minute statistics from raw history for [p_from, p_to). This is the single definition
-- of what a bucket means: workhorse.rollup_stats_v1 materializes it for closed minutes, and
-- workhorse.stat_buckets_v1 evaluates it live for the minutes a rollup has not reached yet.
--
-- Sources are bucketed by the timestamp each grain is stamped with when it lands: enqueue events
-- and closed attempts by occurred_at, which is also the history partition key, and terminal jobs by
-- finished_at. Bucketing by anything the row does not carry would make recomputation non-idempotent.
CREATE OR REPLACE FUNCTION workhorse.aggregate_stats_v1(
  p_from timestamptz, p_to timestamptz, p_group_limit integer DEFAULT 200
) RETURNS TABLE (
  bucket_start timestamptz, queue_name text, job_type text, enqueued integer,
  job_succeeded integer, job_failed integer, job_canceled integer,
  attempt_succeeded integer, attempt_failed integer, attempt_retry integer,
  attempt_lease_expired integer, attempt_canceled integer, attempt_other integer,
  attempt_duration_ms bigint,
  wait_sketch jsonb,
  last_attempt_at timestamptz, last_error text, last_error_at timestamptz
)
LANGUAGE sql STABLE
AS $$
  WITH enqueue_source AS (
    SELECT date_bin('1 minute', event.occurred_at, timestamp with time zone '2000-01-01') AS bucket,
           job.queue_name AS queue, job.job_type AS type,
           count(*)::integer AS enqueued
      FROM workhorse.job_event event
      JOIN workhorse.job job ON job.id = event.job_id
     WHERE event.event_type = 'enqueued'
       AND event.occurred_at >= p_from AND event.occurred_at < p_to
     GROUP BY 1, 2, 3
  ), attempt_source AS (
    SELECT date_bin('1 minute', history.occurred_at, timestamp with time zone '2000-01-01') AS bucket,
           job.queue_name AS queue, job.job_type AS type,
           count(*) FILTER (WHERE history.outcome = 'succeeded')::integer AS attempt_succeeded,
           count(*) FILTER (WHERE history.outcome = 'failed')::integer AS attempt_failed,
           count(*) FILTER (WHERE history.outcome = 'retry')::integer AS attempt_retry,
           count(*) FILTER (WHERE history.outcome = 'lease_expired')::integer AS attempt_lease_expired,
           count(*) FILTER (WHERE history.outcome = 'canceled')::integer AS attempt_canceled,
           count(*) FILTER (
             WHERE history.outcome IN ('deadline_exceeded', 'timeout')
           )::integer AS attempt_other,
           COALESCE(sum(GREATEST(
             0, round(extract(epoch FROM history.finished_at - history.started_at) * 1000)
           )), 0)::bigint AS attempt_duration_ms,
           max(history.finished_at) AS last_attempt_at,
           (array_agg(
              left(COALESCE(
                history.error->>'message', history.error->>'code', history.error::text
              ), 500)
              ORDER BY history.finished_at DESC, history.attempt_id DESC
            ) FILTER (WHERE history.error IS NOT NULL))[1] AS last_error,
           max(history.finished_at) FILTER (WHERE history.error IS NOT NULL) AS last_error_at
      FROM workhorse.attempt_history history
      JOIN workhorse.job job ON job.id = history.job_id
     WHERE history.occurred_at >= p_from AND history.occurred_at < p_to
     GROUP BY 1, 2, 3
  ), wait_bin_source AS (
    SELECT date_bin('1 minute', claimed.occurred_at,
                    timestamp with time zone '2000-01-01') AS bucket,
           job.queue_name AS queue, job.job_type AS type,
           workhorse.stat_sketch_index_v1(
             extract(epoch FROM claimed.occurred_at - enqueued.occurred_at) * 1000
           ) AS bin,
           count(*)::bigint AS samples
      FROM workhorse.job_event claimed
      JOIN workhorse.job_event enqueued ON enqueued.job_id = claimed.job_id
       AND enqueued.event_type = 'enqueued'
       AND enqueued.occurred_at <= claimed.occurred_at
      JOIN workhorse.job job ON job.id = claimed.job_id
     WHERE claimed.event_type = 'claimed' AND claimed.attempt = 1
       AND claimed.occurred_at >= p_from AND claimed.occurred_at < p_to
     GROUP BY 1, 2, 3, 4
  ), wait_source AS (
    SELECT bucket, queue, type,
           jsonb_object_agg(bin::text, samples ORDER BY bin) AS wait_sketch
      FROM wait_bin_source
     GROUP BY 1, 2, 3
  ), outcome_source AS (
    SELECT date_bin('1 minute', outcome.finished_at, timestamp with time zone '2000-01-01') AS bucket,
           job.queue_name AS queue, job.job_type AS type,
           count(*) FILTER (WHERE outcome.state = 'succeeded')::integer AS job_succeeded,
           count(*) FILTER (WHERE outcome.state = 'failed')::integer AS job_failed,
           count(*) FILTER (WHERE outcome.state = 'canceled')::integer AS job_canceled
      FROM workhorse.job_outcome outcome
      JOIN workhorse.job job ON job.id = outcome.job_id
     WHERE outcome.finished_at >= p_from AND outcome.finished_at < p_to
     GROUP BY 1, 2, 3
  ), measure AS (
    SELECT source.bucket, source.queue, source.type, source.enqueued,
           0 AS job_succeeded, 0 AS job_failed, 0 AS job_canceled,
           0 AS attempt_succeeded, 0 AS attempt_failed, 0 AS attempt_retry,
           0 AS attempt_lease_expired, 0 AS attempt_canceled, 0 AS attempt_other,
           0::bigint AS attempt_duration_ms,
           '{}'::jsonb AS wait_sketch,
           NULL::timestamptz AS last_attempt_at, NULL::text AS last_error,
           NULL::timestamptz AS last_error_at
      FROM enqueue_source source
     UNION ALL
    SELECT source.bucket, source.queue, source.type, 0,
           0, 0, 0,
           source.attempt_succeeded, source.attempt_failed, source.attempt_retry,
           source.attempt_lease_expired, source.attempt_canceled, source.attempt_other,
           source.attempt_duration_ms,
           '{}'::jsonb,
           source.last_attempt_at, source.last_error, source.last_error_at
      FROM attempt_source source
     UNION ALL
    SELECT source.bucket, source.queue, source.type, 0,
           0, 0, 0,
           0, 0, 0,
           0, 0, 0,
           0::bigint,
           source.wait_sketch,
           NULL::timestamptz, NULL::text, NULL::timestamptz
      FROM wait_source source
     UNION ALL
    SELECT source.bucket, source.queue, source.type, 0,
           source.job_succeeded, source.job_failed, source.job_canceled,
           0, 0, 0,
           0, 0, 0,
           0::bigint,
           '{}'::jsonb,
           NULL::timestamptz, NULL::text, NULL::timestamptz
      FROM outcome_source source
  ), total AS (
    SELECT measure.bucket, measure.queue, measure.type,
           sum(measure.enqueued)::integer AS enqueued,
           sum(measure.job_succeeded)::integer AS job_succeeded,
           sum(measure.job_failed)::integer AS job_failed,
           sum(measure.job_canceled)::integer AS job_canceled,
           sum(measure.attempt_succeeded)::integer AS attempt_succeeded,
           sum(measure.attempt_failed)::integer AS attempt_failed,
           sum(measure.attempt_retry)::integer AS attempt_retry,
           sum(measure.attempt_lease_expired)::integer AS attempt_lease_expired,
           sum(measure.attempt_canceled)::integer AS attempt_canceled,
           sum(measure.attempt_other)::integer AS attempt_other,
           sum(measure.attempt_duration_ms)::bigint AS attempt_duration_ms,
           workhorse.stat_sketch_merge_v1(array_agg(measure.wait_sketch)) AS wait_sketch,
           max(measure.last_attempt_at) AS last_attempt_at,
           (array_agg(measure.last_error ORDER BY measure.last_error_at DESC NULLS LAST)
             FILTER (WHERE measure.last_error IS NOT NULL))[1] AS last_error,
           max(measure.last_error_at) AS last_error_at
      FROM measure
     GROUP BY 1, 2, 3
  ), fold AS (
    SELECT total.bucket, total.queue, total.type,
           CASE
             WHEN row_number() OVER (
               PARTITION BY total.bucket
               ORDER BY total.enqueued + total.attempt_succeeded + total.attempt_failed
                        + total.attempt_retry + total.attempt_lease_expired
                        + total.attempt_canceled + total.attempt_other DESC,
                        total.queue, total.type
             ) <= p_group_limit
             THEN total.type
             ELSE workhorse.stat_overflow_type_v1()
           END AS fold_type
      FROM total
  ), folded AS (
    SELECT total.bucket, total.queue, fold.fold_type,
           sum(total.enqueued)::integer AS enqueued,
           sum(total.job_succeeded)::integer AS job_succeeded,
           sum(total.job_failed)::integer AS job_failed,
           sum(total.job_canceled)::integer AS job_canceled,
           sum(total.attempt_succeeded)::integer AS attempt_succeeded,
           sum(total.attempt_failed)::integer AS attempt_failed,
           sum(total.attempt_retry)::integer AS attempt_retry,
           sum(total.attempt_lease_expired)::integer AS attempt_lease_expired,
           sum(total.attempt_canceled)::integer AS attempt_canceled,
           sum(total.attempt_other)::integer AS attempt_other,
           sum(total.attempt_duration_ms)::bigint AS attempt_duration_ms,
           workhorse.stat_sketch_merge_v1(array_agg(total.wait_sketch)) AS wait_sketch,
           max(total.last_attempt_at) AS last_attempt_at,
           (array_agg(total.last_error ORDER BY total.last_error_at DESC NULLS LAST)
             FILTER (WHERE total.last_error IS NOT NULL))[1] AS last_error,
           max(total.last_error_at) AS last_error_at
      FROM total
      JOIN fold ON fold.bucket = total.bucket AND fold.queue = total.queue
                AND fold.type = total.type
     GROUP BY 1, 2, 3
  )
  SELECT folded.bucket, folded.queue, folded.fold_type, folded.enqueued,
         folded.job_succeeded, folded.job_failed, folded.job_canceled,
         folded.attempt_succeeded, folded.attempt_failed, folded.attempt_retry,
         folded.attempt_lease_expired, folded.attempt_canceled, folded.attempt_other,
         folded.attempt_duration_ms,
         folded.wait_sketch,
         folded.last_attempt_at, folded.last_error, folded.last_error_at
    FROM folded
$$;

-- Statistics for [p_from, p_to) stitched from materialized buckets and a live tail. Callers never
-- need to know where the rollup watermark sits: everything below it is read, everything above it is
-- derived from the few minutes of raw history a rollup pass has not closed yet.
CREATE OR REPLACE FUNCTION workhorse.stat_buckets_v1(
  p_from timestamptz, p_to timestamptz
) RETURNS TABLE (
  bucket_start timestamptz, queue_name text, job_type text, enqueued bigint,
  job_succeeded bigint, job_failed bigint, job_canceled bigint,
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
           CASE WHEN p_from = date_bin('1 hour', p_from, timestamp with time zone '2000-01-01')
             THEN p_from ELSE date_bin('1 hour', p_from,
               timestamp with time zone '2000-01-01') + interval '1 hour' END AS hour_start,
           date_bin('1 hour', p_to, timestamp with time zone '2000-01-01') AS hour_end,
           CASE WHEN p_from = date_bin('1 day', p_from, timestamp with time zone '2000-01-01')
             THEN p_from ELSE date_bin('1 day', p_from,
               timestamp with time zone '2000-01-01') + interval '1 day' END AS day_start,
           date_bin('1 day', p_to, timestamp with time zone '2000-01-01') AS day_end,
           (SELECT state.rolled_up_through FROM workhorse.job_stat_state state WHERE singleton)
             AS minute_watermark
      FROM selected
  ), stored AS (
    SELECT bucket.bucket_start, bucket.queue_name, bucket.job_type,
           bucket.enqueued::bigint, bucket.job_succeeded::bigint, bucket.job_failed::bigint,
           bucket.job_canceled::bigint, bucket.attempt_succeeded::bigint,
           bucket.attempt_failed::bigint, bucket.attempt_retry::bigint,
           bucket.attempt_lease_expired::bigint, bucket.attempt_canceled::bigint,
           bucket.attempt_other::bigint, bucket.attempt_duration_ms::numeric,
           bucket.wait_sketch, bucket.last_attempt_at, bucket.last_error, bucket.last_error_at
      FROM workhorse.job_stat_bucket bucket, boundary
     WHERE bucket.bucket_start >= p_from
       AND bucket.bucket_start < LEAST(p_to, boundary.minute_watermark)
       AND (
         NOT boundary.use_hour
         OR bucket.bucket_start < boundary.hour_start
         OR bucket.bucket_start >= boundary.hour_end
       )
    UNION ALL
    SELECT bucket.bucket_start, bucket.queue_name, bucket.job_type,
           bucket.enqueued, bucket.job_succeeded, bucket.job_failed, bucket.job_canceled,
           bucket.attempt_succeeded, bucket.attempt_failed, bucket.attempt_retry,
           bucket.attempt_lease_expired, bucket.attempt_canceled, bucket.attempt_other,
           bucket.attempt_duration_ms, bucket.wait_sketch,
           bucket.last_attempt_at, bucket.last_error, bucket.last_error_at
      FROM workhorse.job_stat_bucket_hour bucket, boundary
     WHERE boundary.use_hour
       AND bucket.bucket_start >= boundary.hour_start AND bucket.bucket_start < boundary.hour_end
       AND (
         NOT boundary.use_day
         OR bucket.bucket_start < boundary.day_start
         OR bucket.bucket_start >= boundary.day_end
       )
    UNION ALL
    SELECT bucket.bucket_start, bucket.queue_name, bucket.job_type,
           bucket.enqueued, bucket.job_succeeded, bucket.job_failed, bucket.job_canceled,
           bucket.attempt_succeeded, bucket.attempt_failed, bucket.attempt_retry,
           bucket.attempt_lease_expired, bucket.attempt_canceled, bucket.attempt_other,
           bucket.attempt_duration_ms, bucket.wait_sketch,
           bucket.last_attempt_at, bucket.last_error, bucket.last_error_at
      FROM workhorse.job_stat_bucket_day bucket, boundary
     WHERE boundary.use_day
       AND bucket.bucket_start >= boundary.day_start AND bucket.bucket_start < boundary.day_end
  )
  SELECT * FROM stored
  UNION ALL
  SELECT live.bucket_start, live.queue_name, live.job_type, live.enqueued::bigint,
         live.job_succeeded::bigint, live.job_failed::bigint, live.job_canceled::bigint,
         live.attempt_succeeded::bigint, live.attempt_failed::bigint, live.attempt_retry::bigint,
         live.attempt_lease_expired::bigint, live.attempt_canceled::bigint,
         live.attempt_other::bigint, live.attempt_duration_ms::numeric, live.wait_sketch,
         live.last_attempt_at, live.last_error, live.last_error_at
    FROM workhorse.aggregate_stats_v1(
           GREATEST(p_from, (
             SELECT state.rolled_up_through FROM workhorse.job_stat_state state WHERE state.singleton
           )),
           p_to
         ) live
   WHERE p_to > (
           SELECT state.rolled_up_through FROM workhorse.job_stat_state state WHERE state.singleton
         )
$$;

-- Materialize closed minutes and advance the watermark. Only fully elapsed minutes are rolled up,
-- and the pass rewrites the last few of them each time: a transaction that commits its history row
-- after its own minute closed is absorbed by the rewrite instead of being lost. Rewriting is safe
-- because a bucket is a pure function of the raw history in its minute.
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
DECLARE v_state workhorse.job_stat_state%ROWTYPE;
DECLARE v_policy workhorse.retention_policy%ROWTYPE;
DECLARE v_maintenance workhorse.maintenance_policy%ROWTYPE;
DECLARE v_from timestamptz;
DECLARE v_to timestamptz;
DECLARE v_closed timestamptz;
DECLARE v_hour_from timestamptz;
DECLARE v_hour_to timestamptz;
DECLARE v_day_from timestamptz;
DECLARE v_day_to timestamptz;
DECLARE v_inserted integer; BEGIN
  IF p_now IS NULL OR NOT isfinite(p_now) THEN RAISE EXCEPTION 'maintenance time is required'; END IF;
  IF p_max_buckets NOT BETWEEN 1 AND 100000 THEN
    RAISE EXCEPTION 'bucket limit must be between 1 and 100000';
  END IF;
  IF NOT pg_try_advisory_xact_lock(hashtextextended('workhorse:maintenance:stat-rollup', 0)) THEN
    RETURN QUERY VALUES
      ('stat_rollup'::text, 0, 0, true, NULL::jsonb),
      ('stat_retention'::text, 0, 0, true, NULL::jsonb);
    RETURN;
  END IF;
  SELECT * INTO STRICT v_maintenance FROM workhorse.maintenance_policy WHERE singleton;
  SELECT * INTO STRICT v_state FROM workhorse.job_stat_state WHERE singleton FOR UPDATE;
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
    v_closed := date_bin('1 minute', p_now, timestamp with time zone '2000-01-01');
    v_from := LEAST(
      v_state.rolled_up_through
        - make_interval(mins => v_maintenance.statistics_recompute_buckets),
      v_closed
    );
    -- Catching up after an outage advances in bounded passes rather than in one long transaction.
    v_to := LEAST(v_closed, v_from + make_interval(mins => p_max_buckets));
    IF v_to > v_from THEN
      DELETE FROM workhorse.job_stat_bucket
       WHERE bucket_start >= v_from AND bucket_start < v_to;
      INSERT INTO workhorse.job_stat_bucket (
        bucket_start, queue_name, job_type, enqueued,
        job_succeeded, job_failed, job_canceled,
        attempt_succeeded, attempt_failed, attempt_retry,
        attempt_lease_expired, attempt_canceled, attempt_other,
        attempt_duration_ms, wait_sketch, last_attempt_at, last_error, last_error_at
      )
      SELECT * FROM workhorse.aggregate_stats_v1(v_from, v_to, v_maintenance.statistics_group_limit);
      GET DIAGNOSTICS rows_affected = ROW_COUNT;

      v_hour_from := LEAST(
        v_state.hourly_rolled_up_through,
        date_bin('1 hour', v_from, timestamp with time zone '2000-01-01')
      );
      v_hour_to := date_bin('1 hour', v_to, timestamp with time zone '2000-01-01');
      IF v_hour_to > v_hour_from THEN
        DELETE FROM workhorse.job_stat_bucket_hour
         WHERE bucket_start >= v_hour_from AND bucket_start < v_hour_to;
        INSERT INTO workhorse.job_stat_bucket_hour (
          bucket_start, queue_name, job_type, enqueued,
          job_succeeded, job_failed, job_canceled,
          attempt_succeeded, attempt_failed, attempt_retry,
          attempt_lease_expired, attempt_canceled, attempt_other,
          attempt_duration_ms, wait_sketch, last_attempt_at, last_error, last_error_at
        )
        SELECT date_bin('1 hour', bucket.bucket_start,
                        timestamp with time zone '2000-01-01'),
               bucket.queue_name, bucket.job_type,
               sum(bucket.enqueued), sum(bucket.job_succeeded), sum(bucket.job_failed),
               sum(bucket.job_canceled), sum(bucket.attempt_succeeded),
               sum(bucket.attempt_failed), sum(bucket.attempt_retry),
               sum(bucket.attempt_lease_expired), sum(bucket.attempt_canceled),
               sum(bucket.attempt_other), sum(bucket.attempt_duration_ms),
               workhorse.stat_sketch_merge_v1(array_agg(bucket.wait_sketch)),
               max(bucket.last_attempt_at),
               (array_agg(bucket.last_error ORDER BY bucket.last_error_at DESC NULLS LAST)
                 FILTER (WHERE bucket.last_error IS NOT NULL))[1],
               max(bucket.last_error_at)
          FROM workhorse.job_stat_bucket bucket
         WHERE bucket.bucket_start >= v_hour_from AND bucket.bucket_start < v_hour_to
         GROUP BY 1, 2, 3;
        GET DIAGNOSTICS v_inserted = ROW_COUNT;
        rows_affected := rows_affected + v_inserted;
      ELSE
        v_hour_to := v_state.hourly_rolled_up_through;
      END IF;

      v_day_from := LEAST(
        v_state.daily_rolled_up_through,
        date_bin('1 day', v_hour_from, timestamp with time zone '2000-01-01')
      );
      v_day_to := date_bin('1 day', v_hour_to, timestamp with time zone '2000-01-01');
      IF v_day_to > v_day_from THEN
        DELETE FROM workhorse.job_stat_bucket_day
         WHERE bucket_start >= v_day_from AND bucket_start < v_day_to;
        INSERT INTO workhorse.job_stat_bucket_day (
          bucket_start, queue_name, job_type, enqueued,
          job_succeeded, job_failed, job_canceled,
          attempt_succeeded, attempt_failed, attempt_retry,
          attempt_lease_expired, attempt_canceled, attempt_other,
          attempt_duration_ms, wait_sketch, last_attempt_at, last_error, last_error_at
        )
        SELECT date_bin('1 day', bucket.bucket_start,
                        timestamp with time zone '2000-01-01'),
               bucket.queue_name, bucket.job_type,
               sum(bucket.enqueued), sum(bucket.job_succeeded), sum(bucket.job_failed),
               sum(bucket.job_canceled), sum(bucket.attempt_succeeded),
               sum(bucket.attempt_failed), sum(bucket.attempt_retry),
               sum(bucket.attempt_lease_expired), sum(bucket.attempt_canceled),
               sum(bucket.attempt_other), sum(bucket.attempt_duration_ms),
               workhorse.stat_sketch_merge_v1(array_agg(bucket.wait_sketch)),
               max(bucket.last_attempt_at),
               (array_agg(bucket.last_error ORDER BY bucket.last_error_at DESC NULLS LAST)
                 FILTER (WHERE bucket.last_error IS NOT NULL))[1],
               max(bucket.last_error_at)
          FROM workhorse.job_stat_bucket_hour bucket
         WHERE bucket.bucket_start >= v_day_from AND bucket.bucket_start < v_day_to
         GROUP BY 1, 2, 3;
        GET DIAGNOSTICS v_inserted = ROW_COUNT;
        rows_affected := rows_affected + v_inserted;
      ELSE
        v_day_to := v_state.daily_rolled_up_through;
      END IF;

      UPDATE workhorse.job_stat_state
         SET rolled_up_through = v_to,
             hourly_rolled_up_through = GREATEST(hourly_rolled_up_through, v_hour_to),
             daily_rolled_up_through = GREATEST(daily_rolled_up_through, v_day_to),
             last_run_at = p_now, updated_at = clock_timestamp()
       WHERE singleton;
    ELSE
      UPDATE workhorse.job_stat_state
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
  phase := 'stat_retention';
  rows_affected := 0;
  error := NULL;
  v_started_at := clock_timestamp(); BEGIN
    WITH expired AS (
      SELECT bucket.ctid
        FROM workhorse.job_stat_bucket bucket
       WHERE bucket.bucket_start < p_now - make_interval(
         days => LEAST(COALESCE(v_policy.statistics_retention_days, 2), 2)
       )
       ORDER BY bucket.bucket_start
         FOR UPDATE SKIP LOCKED
       LIMIT v_policy.statistics_rows_per_pass
    )
    DELETE FROM workhorse.job_stat_bucket bucket USING expired
     WHERE bucket.ctid = expired.ctid;
    GET DIAGNOSTICS rows_affected = ROW_COUNT;

    WITH expired AS (
      SELECT bucket.ctid
        FROM workhorse.job_stat_bucket_hour bucket
       WHERE bucket.bucket_start < p_now - make_interval(
         days => LEAST(COALESCE(v_policy.statistics_retention_days, 90), 90)
       )
       ORDER BY bucket.bucket_start
         FOR UPDATE SKIP LOCKED
       LIMIT v_policy.statistics_rows_per_pass
    )
    DELETE FROM workhorse.job_stat_bucket_hour bucket USING expired
     WHERE bucket.ctid = expired.ctid;
    GET DIAGNOSTICS v_inserted = ROW_COUNT;
    rows_affected := rows_affected + v_inserted;

    IF v_policy.statistics_retention_days IS NOT NULL THEN
      WITH expired AS (
        SELECT bucket.ctid
          FROM workhorse.job_stat_bucket_day bucket
         WHERE bucket.bucket_start < p_now
               - make_interval(days => v_policy.statistics_retention_days)
         ORDER BY bucket.bucket_start
           FOR UPDATE SKIP LOCKED
         LIMIT v_policy.statistics_rows_per_pass
      )
      DELETE FROM workhorse.job_stat_bucket_day bucket USING expired
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
