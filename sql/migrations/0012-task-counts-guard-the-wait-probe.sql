-- workhorse-migration: {"kind":"additive"}

-- Task counts guard the wait probe (SM-794).

-- dashboard_task_counts_v1 ran an EXISTS against both wait views for every live row to count the
-- waiting filter, and the dashboard calls it on every poll. Both views join task_runtime on
-- state = 'scheduled' and a matching wait_name, so a row without that shape can never match. Both
-- branches of the counts read, and the waiting filter of dashboard_activity_v1, now test that
-- predicate first and probe the views only for rows that pass it. The counts read also disables
-- JIT for itself, the way the other dashboard reads do.

CREATE OR REPLACE FUNCTION workhorse.dashboard_activity_v1(p_input jsonb)
RETURNS jsonb
LANGUAGE sql
SET jit = off
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
    SELECT runtime.task_id FROM workhorse.dashboard_task_runtime_v1 runtime CROSS JOIN windowed
     WHERE runtime.updated_at >= windowed.captured_at
                                 - make_interval(secs => windowed.window_seconds)
    UNION
    SELECT outcome.task_id FROM workhorse.dashboard_task_outcome_v1 outcome CROSS JOIN windowed
     WHERE outcome.updated_at >= windowed.captured_at
                                 - make_interval(secs => windowed.window_seconds)
  ), task_inputs AS MATERIALIZED (
    SELECT candidate.task_id, windowed.group_by, task.queue_name, task.task_type,
           COALESCE(runtime.state, outcome.state) AS state,
           COALESCE(runtime.current_attempt, outcome.current_attempt) AS attempt,
           COALESCE(runtime.updated_at, outcome.updated_at) AS updated_at,
           runtime.wait_name,
           task.tags,
           CASE WHEN windowed.group_by = 'worker' OR windowed.worker_filter IS NOT NULL
             THEN COALESCE(runtime.worker_id, (
               SELECT history.worker_id FROM workhorse.dashboard_attempt_history_v1 history
                WHERE history.task_id = candidate.task_id
                ORDER BY history.attempt DESC LIMIT 1
             ), 'unassigned')
           END AS worker_id
      FROM candidate
      CROSS JOIN windowed
      JOIN workhorse.dashboard_task_v1 task ON task.id = candidate.task_id
      LEFT JOIN workhorse.dashboard_task_runtime_v1 runtime
        ON runtime.task_id = candidate.task_id
      LEFT JOIN workhorse.dashboard_task_outcome_v1 outcome
        ON outcome.task_id = candidate.task_id
  ), tasks AS (
    SELECT CASE windowed.group_by
             WHEN 'queue' THEN task_inputs.queue_name
             WHEN 'task' THEN task_inputs.task_type
             WHEN 'status' THEN task_inputs.state
             WHEN 'worker' THEN task_inputs.worker_id
           END AS group_key,
           task_inputs.state,
           -- Both wait views require this predicate; see dashboard_task_counts_v1.
           task_inputs.state = 'scheduled' AND task_inputs.wait_name IS NOT NULL AND EXISTS (
             SELECT 1 FROM workhorse.dashboard_signal_wait_v1 signal_wait
              WHERE signal_wait.task_id = task_inputs.task_id
             UNION ALL
             SELECT 1 FROM workhorse.dashboard_human_wait_v1 human_wait
              WHERE human_wait.task_id = task_inputs.task_id
           ) AS external_wait,
           task_inputs.attempt, task_inputs.updated_at, task_inputs.tags,
           task_inputs.queue_name AS queue, task_inputs.worker_id
      FROM task_inputs
      CROSS JOIN windowed
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
  ), activity_rows AS (
    SELECT buckets.bucket_start, tasks.group_key,
           count(tasks.updated_at)::integer AS count
      FROM buckets CROSS JOIN windowed
      LEFT JOIN tasks
        ON tasks.updated_at >= buckets.bucket_start
       AND tasks.updated_at < buckets.bucket_start
                              + make_interval(secs => windowed.bucket_seconds)
       AND CASE windowed.filter
         WHEN 'blocked' THEN tasks.state = 'blocked'
         WHEN 'waiting' THEN tasks.external_wait
         WHEN 'scheduled' THEN tasks.state = 'scheduled'
         WHEN 'retried' THEN tasks.attempt > 1
         WHEN 'queued' THEN tasks.state = 'ready'
         WHEN 'running' THEN tasks.state = 'active'
         WHEN 'completed' THEN tasks.state = 'succeeded'
         WHEN 'discarded' THEN tasks.state = 'failed'
         WHEN 'canceled' THEN tasks.state = 'canceled'
         ELSE true
       END
       AND (cardinality(windowed.tags) = 0 OR tasks.tags && windowed.tags)
       AND (windowed.queue_filter IS NULL OR tasks.queue = windowed.queue_filter)
       AND (windowed.worker_filter IS NULL OR tasks.worker_id = windowed.worker_filter)
     GROUP BY buckets.bucket_start, tasks.group_key
  ), activity_groups AS (
    SELECT DISTINCT group_key FROM activity_rows WHERE group_key IS NOT NULL
  ), activity_buckets AS (
    SELECT bucket_start,
           COALESCE(jsonb_object_agg(group_key, count)
                    FILTER (WHERE group_key IS NOT NULL), '{}'::jsonb) AS counts
      FROM activity_rows GROUP BY bucket_start
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

CREATE OR REPLACE FUNCTION workhorse.dashboard_task_counts_v1(p_input jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SET jit = off
AS $$
DECLARE
  v_estimate bigint;
  v_live record;
  v_state text;
  v_plan jsonb;
  v_completed integer;
  v_discarded integer;
  v_canceled integer;
  v_retried_terminal integer;
BEGIN
  SELECT estimate INTO v_estimate FROM workhorse.dashboard_task_estimate_v1();
  -- reltuples is -1 until the first vacuum/analyze; treat unknown as small.
  IF v_estimate < 50000 THEN
    RETURN (
      WITH tasks AS (
        SELECT COALESCE(r.state, o.state) AS state,
               -- Both wait views require this predicate, so the guard only skips probes that
               -- could never match.
               r.state = 'scheduled' AND r.wait_name IS NOT NULL AND EXISTS (
                 SELECT 1 FROM workhorse.dashboard_signal_wait_v1 signal_wait
                  WHERE signal_wait.task_id = j.id
                 UNION ALL
                 SELECT 1 FROM workhorse.dashboard_human_wait_v1 human_wait
                  WHERE human_wait.task_id = j.id
               ) AS external_wait,
               COALESCE(r.current_attempt, o.current_attempt) AS attempt
          FROM workhorse.dashboard_task_v1 j
          LEFT JOIN workhorse.dashboard_task_runtime_v1 r ON r.task_id = j.id
          LEFT JOIN workhorse.dashboard_task_outcome_v1 o ON o.task_id = j.id
      )
      SELECT jsonb_build_object(
        'all', count(*)::integer,
        'blocked', count(*) FILTER (WHERE state = 'blocked')::integer,
        'waiting', count(*) FILTER (WHERE external_wait)::integer,
        'scheduled', count(*) FILTER (WHERE state = 'scheduled')::integer,
        'retried', count(*) FILTER (WHERE attempt > 1)::integer,
        'queued', count(*) FILTER (WHERE state = 'ready')::integer,
        'running', count(*) FILTER (WHERE state = 'active')::integer,
        'completed', count(*) FILTER (WHERE state = 'succeeded')::integer,
        'discarded', count(*) FILTER (WHERE state = 'failed')::integer,
        'canceled', count(*) FILTER (WHERE state = 'canceled')::integer)
        FROM tasks
    );
  END IF;

  -- task_runtime stays small by design (live tasks only), so live states are always counted
  -- exactly; task and task_outcome grow without bound and switch to planner estimates.
  SELECT count(*) FILTER (WHERE state = 'blocked')::integer AS blocked,
         count(*) FILTER (WHERE state = 'scheduled' AND wait_name IS NOT NULL AND EXISTS (
           SELECT 1 FROM workhorse.dashboard_signal_wait_v1 signal_wait
            WHERE signal_wait.task_id = runtime.task_id
           UNION ALL
           SELECT 1 FROM workhorse.dashboard_human_wait_v1 human_wait
            WHERE human_wait.task_id = runtime.task_id
         ))::integer AS waiting,
         count(*) FILTER (WHERE state = 'scheduled')::integer AS scheduled,
         count(*) FILTER (WHERE state = 'ready')::integer AS queued,
         count(*) FILTER (WHERE state = 'active')::integer AS running,
         count(*) FILTER (WHERE current_attempt > 1)::integer AS retried
    INTO v_live
    FROM workhorse.dashboard_task_runtime_v1 runtime;

  FOREACH v_state IN ARRAY ARRAY['succeeded', 'failed', 'canceled'] LOOP
    EXECUTE 'EXPLAIN (FORMAT JSON) SELECT 1 '
            'FROM workhorse.dashboard_task_outcome_v1 WHERE state=$1'
      INTO v_plan USING v_state;
    CASE v_state
      WHEN 'succeeded' THEN
        v_completed := GREATEST(0, round((v_plan->0->'Plan'->>'Plan Rows')::numeric));
      WHEN 'failed' THEN
        v_discarded := GREATEST(0, round((v_plan->0->'Plan'->>'Plan Rows')::numeric));
      WHEN 'canceled' THEN
        v_canceled := GREATEST(0, round((v_plan->0->'Plan'->>'Plan Rows')::numeric));
    END CASE;
  END LOOP;
  EXECUTE 'EXPLAIN (FORMAT JSON) SELECT 1 '
          'FROM workhorse.dashboard_task_outcome_v1 WHERE current_attempt>1'
    INTO v_plan;
  v_retried_terminal := GREATEST(0, round((v_plan->0->'Plan'->>'Plan Rows')::numeric));

  RETURN jsonb_build_object(
    'all', v_estimate, 'blocked', v_live.blocked, 'waiting', v_live.waiting,
    'scheduled', v_live.scheduled, 'retried', v_live.retried + v_retried_terminal,
    'queued', v_live.queued, 'running', v_live.running, 'completed', v_completed,
    'discarded', v_discarded, 'canceled', v_canceled);
END;
$$;
