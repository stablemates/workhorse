-- workhorse-migration: {"kind":"additive"}

-- Bin each filtered activity row once instead of range-joining every row to every bucket (SM-795).
-- Worker history is joined only after the state, tag, and queue filters have removed rows.
-- The generic JSON input underestimates the group size, so prefer a spill-capable hash aggregate
-- over a disk sort of every matching task.

CREATE OR REPLACE FUNCTION workhorse.dashboard_activity_v1(p_input jsonb)
RETURNS jsonb
LANGUAGE sql
SET jit = off
SET enable_sort = off
AS $$
  WITH parameters AS (
    SELECT clock_timestamp() AS captured_at,
           COALESCE(NULLIF(p_input->>'filter', ''), 'all') AS filter,
           COALESCE(NULLIF(p_input->>'period', ''), '1h') AS period,
           COALESCE(NULLIF(p_input->>'groupBy', ''), 'task') AS group_by,
           COALESCE(ARRAY(
             SELECT jsonb_array_elements_text(
               CASE WHEN jsonb_typeof(p_input->'tags') = 'array'
                    THEN p_input->'tags' ELSE '[]'::jsonb END
             )
           ), ARRAY[]::text[]) AS tags,
           NULLIF(p_input->>'queue', '') AS queue_filter,
           NULLIF(p_input->>'worker', '') AS worker_filter
  ), windowed AS (
    SELECT parameters.*,
           CASE period
             WHEN '15m' THEN 900 WHEN '1h' THEN 3600 WHEN '6h' THEN 21600
             WHEN '24h' THEN 86400 WHEN '7d' THEN 604800
           END AS window_seconds,
           CASE period
             WHEN '15m' THEN 30 WHEN '1h' THEN 120 WHEN '6h' THEN 600
             WHEN '24h' THEN 3600 WHEN '7d' THEN 21600
           END AS bucket_seconds
      FROM parameters
  ), candidate AS (
    SELECT runtime.task_id, runtime.state, runtime.current_attempt AS attempt,
           runtime.updated_at, runtime.wait_name, runtime.worker_id
      FROM workhorse.dashboard_task_runtime_v1 runtime CROSS JOIN windowed
     WHERE runtime.updated_at >= windowed.captured_at
                                 - make_interval(secs => windowed.window_seconds)
    UNION ALL
    SELECT outcome.task_id, outcome.state, outcome.current_attempt AS attempt,
           outcome.updated_at, NULL::text AS wait_name, NULL::text AS worker_id
      FROM workhorse.dashboard_task_outcome_v1 outcome CROSS JOIN windowed
     WHERE outcome.updated_at >= windowed.captured_at
                                 - make_interval(secs => windowed.window_seconds)
  ), filtered_candidates AS NOT MATERIALIZED (
    SELECT candidate.*
      FROM candidate
      CROSS JOIN windowed
     WHERE CASE windowed.filter
       WHEN 'blocked' THEN candidate.state = 'blocked'
       WHEN 'waiting' THEN candidate.state = 'scheduled' AND candidate.wait_name IS NOT NULL
         AND EXISTS (
           SELECT 1 FROM workhorse.dashboard_signal_wait_v1 signal_wait
            WHERE signal_wait.task_id = candidate.task_id
           UNION ALL
           SELECT 1 FROM workhorse.dashboard_human_wait_v1 human_wait
            WHERE human_wait.task_id = candidate.task_id
         )
       WHEN 'scheduled' THEN candidate.state = 'scheduled'
       WHEN 'retried' THEN candidate.attempt > 1
       WHEN 'queued' THEN candidate.state = 'ready'
       WHEN 'running' THEN candidate.state = 'active'
       WHEN 'completed' THEN candidate.state = 'succeeded'
       WHEN 'discarded' THEN candidate.state = 'failed'
       WHEN 'canceled' THEN candidate.state = 'canceled'
       ELSE true
     END
  ), filtered_tasks AS NOT MATERIALIZED (
    SELECT filtered_candidates.*, NULL::text AS queue_name, NULL::text AS task_type
      FROM filtered_candidates CROSS JOIN windowed
     WHERE windowed.group_by NOT IN ('queue', 'task')
       AND cardinality(windowed.tags) = 0
       AND windowed.queue_filter IS NULL
    UNION ALL
    SELECT filtered_candidates.*, task.queue_name, task.task_type
      FROM filtered_candidates
      CROSS JOIN windowed
      JOIN workhorse.dashboard_task_v1 task ON task.id = filtered_candidates.task_id
     WHERE (windowed.group_by IN ('queue', 'task')
            OR cardinality(windowed.tags) > 0
            OR windowed.queue_filter IS NOT NULL)
       AND (cardinality(windowed.tags) = 0 OR task.tags && windowed.tags)
       AND (windowed.queue_filter IS NULL OR task.queue_name = windowed.queue_filter)
  ), attempt_workers AS NOT MATERIALIZED (
    -- One immutable history row records each closed attempt, so this key resolves at most one
    -- worker without a per-task lookup across every partition.
    SELECT history.task_id, history.attempt, history.worker_id
      FROM workhorse.dashboard_attempt_history_v1 history
      CROSS JOIN windowed
     WHERE windowed.group_by = 'worker' OR windowed.worker_filter IS NOT NULL
  ), grouped_activity AS (
    SELECT date_bin(make_interval(secs => windowed.bucket_seconds), filtered_tasks.updated_at,
                    timestamp '2000-01-01' AT TIME ZONE 'UTC') AS bucket_start,
           CASE windowed.group_by
             WHEN 'queue' THEN filtered_tasks.queue_name
             WHEN 'task' THEN filtered_tasks.task_type
             WHEN 'status' THEN filtered_tasks.state
           END AS group_key,
           count(*)::integer AS count
      FROM filtered_tasks CROSS JOIN windowed
     WHERE windowed.group_by <> 'worker' AND windowed.worker_filter IS NULL
     GROUP BY 1, 2
    UNION ALL
    SELECT date_bin(make_interval(secs => windowed.bucket_seconds), filtered_tasks.updated_at,
                    timestamp '2000-01-01' AT TIME ZONE 'UTC') AS bucket_start,
           CASE windowed.group_by
             WHEN 'queue' THEN filtered_tasks.queue_name
             WHEN 'task' THEN filtered_tasks.task_type
             WHEN 'status' THEN filtered_tasks.state
             WHEN 'worker' THEN COALESCE(filtered_tasks.worker_id,
                                         attempt_workers.worker_id, 'unassigned')
           END AS group_key,
           count(*)::integer AS count
      FROM filtered_tasks
      CROSS JOIN windowed
      LEFT JOIN attempt_workers ON attempt_workers.task_id = filtered_tasks.task_id
                               AND attempt_workers.attempt = filtered_tasks.attempt
     WHERE (windowed.group_by = 'worker' OR windowed.worker_filter IS NOT NULL)
       AND (windowed.worker_filter IS NULL
            OR COALESCE(filtered_tasks.worker_id, attempt_workers.worker_id, 'unassigned')
               = windowed.worker_filter)
     GROUP BY 1, 2
  ), buckets AS (
    SELECT generate_series(
             date_bin(make_interval(secs => windowed.bucket_seconds),
                      windowed.captured_at - make_interval(secs => windowed.window_seconds),
                      timestamp '2000-01-01' AT TIME ZONE 'UTC')
               + make_interval(secs => windowed.bucket_seconds),
             date_bin(make_interval(secs => windowed.bucket_seconds), windowed.captured_at,
                      timestamp '2000-01-01' AT TIME ZONE 'UTC'),
             make_interval(secs => windowed.bucket_seconds)
           ) AS bucket_start
      FROM windowed
  ), activity_groups AS (
    SELECT DISTINCT group_key FROM grouped_activity WHERE group_key IS NOT NULL
  ), activity_buckets AS (
    SELECT buckets.bucket_start,
           COALESCE(jsonb_object_agg(grouped_activity.group_key, grouped_activity.count)
                    FILTER (WHERE grouped_activity.group_key IS NOT NULL), '{}'::jsonb) AS counts
      FROM buckets
      LEFT JOIN grouped_activity ON grouped_activity.bucket_start = buckets.bucket_start
     GROUP BY buckets.bucket_start
  )
  SELECT jsonb_build_object(
    'capturedAt', workhorse.dashboard_iso_v1(windowed.captured_at),
    'filter', windowed.filter, 'period', windowed.period, 'groupBy', windowed.group_by,
    'bucketSeconds', windowed.bucket_seconds,
    'groups', COALESCE((
      SELECT jsonb_agg(group_key ORDER BY group_key) FROM activity_groups
    ), '[]'::jsonb),
    'buckets', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'bucketStart', workhorse.dashboard_iso_v1(bucket_start), 'counts', counts)
               ORDER BY bucket_start)
        FROM activity_buckets
    ), '[]'::jsonb))
    FROM windowed;
$$;
