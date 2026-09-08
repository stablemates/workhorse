-- Additive dashboard read optimizations. Legacy functions remain callable.

CREATE OR REPLACE FUNCTION workhorse.dashboard_tasks_cursor_v1(p_input jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SET jit = off
AS $$
DECLARE
  v_backwards boolean := COALESCE(p_input->>'direction', 'next') = 'previous';
  v_priority boolean := COALESCE(p_input->>'sort', 'updated') = 'priority';
  v_order text;
  v_cursor text := 'true';
  v_comparison text;
  v_query text;
  v_result jsonb;
BEGIN
  -- Only fixed SQL fragments enter the query. Values stay in the bound JSON parameter.
  -- A custom plan can simplify absent filters and seek the terminal update-time index.
  v_order := CASE WHEN v_priority THEN 'priority ' || CASE WHEN v_backwards THEN 'ASC, ' ELSE 'DESC, ' END ELSE '' END
    || CASE WHEN v_backwards THEN 'updated_at ASC, id ASC' ELSE 'updated_at DESC, id DESC' END;
  v_comparison := CASE WHEN v_backwards THEN ' > ' ELSE ' < ' END;
  IF p_input->'cursor' IS NOT NULL AND p_input->'cursor' <> 'null'::jsonb THEN
    v_cursor := CASE WHEN v_priority THEN '(priority, updated_at, id)' ELSE '(updated_at, id)' END
      || v_comparison || '(' || CASE WHEN v_priority THEN '($1->''cursor''->>''priority'')::integer, ' ELSE '' END
      || '($1->''cursor''->>''updatedAt'')::timestamptz, ($1->''cursor''->>''id'')::uuid)';
  END IF;
  v_query := replace(replace($query$
WITH parameters AS NOT MATERIALIZED (
    SELECT COALESCE($1->>'count', 'none') AS count_mode,
           COALESCE($1->>'direction', 'next') = 'previous' AS backwards,
           ($1->'cursor'->>'id')::uuid AS cursor_id,
           ($1->'cursor'->>'updatedAt')::timestamptz AS cursor_updated_at,
           ($1->'cursor'->>'priority')::integer AS cursor_priority,
           COALESCE(NULLIF($1->>'filter', ''), 'all') AS filter,
           NULLIF($1->>'queue', '') AS queue_filter,
           NULLIF($1->>'worker', '') AS worker_filter,
           NULLIF($1->>'jobType', '') AS type_filter,
           NULLIF($1->>'priority', '')::integer AS priority_filter,
           COALESCE(ARRAY(SELECT jsonb_array_elements_text($1->'tags')), ARRAY[]::text[])
             AS tag_filter,
           NULLIF($1->>'search', '') AS search,
           CASE WHEN NULLIF($1->>'search', '') IS NULL THEN NULL ELSE
             '%' || replace(replace(replace(replace(
               $1->>'search', '!', '!!'), '%', '!%'), '_', '!_'), '*', '%') || '%'
           END AS search_filter,
           COALESCE(NULLIF($1->>'page', '')::integer, 1) AS page,
           COALESCE(NULLIF($1->>'pageSize', '')::integer, 50) AS page_size,
           COALESCE(NULLIF($1->>'sort', ''), 'updated') AS sort,
           COALESCE(($1->>'canCompleteHumanWait')::boolean, false)
             AS can_complete_human_wait
  ), task_rows AS NOT MATERIALIZED (
    SELECT r.job_id AS id, j.queue_name AS queue, j.job_type AS type, j.priority,
           r.state, r.current_attempt AS attempt, j.tags,
           r.worker_id AS current_worker_id, r.wait_name, r.updated_at
      FROM workhorse.dashboard_job_runtime_v1 r
      JOIN workhorse.dashboard_job_v1 j ON j.id = r.job_id
    UNION ALL
    SELECT o.job_id AS id, j.queue_name AS queue, j.job_type AS type, j.priority,
           o.state, o.current_attempt AS attempt, j.tags,
           NULL::text AS current_worker_id, NULL::text AS wait_name, o.updated_at
      FROM workhorse.dashboard_job_outcome_v1 o
      JOIN workhorse.dashboard_job_v1 j ON j.id = o.job_id
  ), filtered AS NOT MATERIALIZED (
    SELECT task_rows.* FROM task_rows CROSS JOIN parameters
     WHERE CASE parameters.filter
       WHEN 'blocked' THEN task_rows.state = 'blocked'
       WHEN 'waiting' THEN EXISTS (
         SELECT 1 FROM workhorse.dashboard_signal_wait_v1 signal_wait
          WHERE signal_wait.job_id = task_rows.id
         UNION ALL
         SELECT 1 FROM workhorse.dashboard_human_wait_v1 human_wait
          WHERE human_wait.job_id = task_rows.id
       )
       WHEN 'scheduled' THEN task_rows.state = 'scheduled'
       WHEN 'retried' THEN task_rows.attempt > 1
       WHEN 'queued' THEN task_rows.state = 'ready'
       WHEN 'running' THEN task_rows.state = 'active'
       WHEN 'completed' THEN task_rows.state = 'succeeded'
       WHEN 'discarded' THEN task_rows.state = 'failed'
       WHEN 'canceled' THEN task_rows.state = 'canceled'
       ELSE true
     END
       AND (parameters.queue_filter IS NULL OR task_rows.queue = parameters.queue_filter)
       AND (parameters.worker_filter IS NULL OR COALESCE(
         task_rows.current_worker_id,
         (
           SELECT wait.worker_id FROM workhorse.dashboard_job_wait_v1 wait
            WHERE wait.job_id = task_rows.id AND wait.wait_name = task_rows.wait_name
         ),
         (
           SELECT history.worker_id FROM workhorse.dashboard_attempt_history_v1 history
            WHERE history.job_id = task_rows.id
            ORDER BY history.attempt DESC LIMIT 1
         )
       ) = parameters.worker_filter)
       AND (parameters.type_filter IS NULL OR task_rows.type = parameters.type_filter)
       AND (parameters.priority_filter IS NULL OR task_rows.priority = parameters.priority_filter)
       AND (cardinality(parameters.tag_filter) = 0 OR task_rows.tags && parameters.tag_filter)
       AND (parameters.search_filter IS NULL
            OR task_rows.type ILIKE parameters.search_filter ESCAPE '!'
            OR task_rows.queue ILIKE parameters.search_filter ESCAPE '!'
            OR task_rows.id::text ILIKE parameters.search_filter ESCAPE '!')
  ), candidates AS MATERIALIZED (
    SELECT filtered.id, filtered.priority, filtered.updated_at, parameters.worker_filter
      FROM filtered CROSS JOIN parameters
     WHERE __cursor__
     ORDER BY __order__
     LIMIT (SELECT page_size + 1 FROM parameters)
  ), page_ids AS MATERIALIZED (
    SELECT candidates.* FROM candidates CROSS JOIN parameters
     ORDER BY __order__
     LIMIT (SELECT page_size FROM parameters)
  ), page AS (
    SELECT j.id, j.queue_name AS queue, j.job_type AS type, page_ids.priority,
           COALESCE(r.state, o.state) AS state,
           CASE WHEN r.state = 'blocked' THEN 'prerequisite_pending' END AS blocked_reason,
           COALESCE((
             SELECT jsonb_agg(dependency.prerequisite_job_id::text
                              ORDER BY dependency.prerequisite_job_id)
               FROM workhorse.dashboard_job_dependency_v1 dependency
              WHERE dependency.dependent_job_id = j.id AND dependency.released_at IS NULL
           ), '[]'::jsonb) AS prerequisite_job_ids,
           COALESCE(r.current_attempt, o.current_attempt) AS attempt,
           j.max_attempts, j.retry_policy, j.deadline_at, j.execution_timeout_ms, j.tags,
           COALESCE(r.run_at, o.run_at) AS run_at,
           r.worker_id AS current_worker_id,
           COALESCE(r.worker_id, durable_wait.worker_id, attempt_worker.worker_id) AS worker_id,
           o.finished_at, COALESCE(o.error, r.error) AS error, j.created_at,
           page_ids.updated_at,
           r.wait_name, r.cancel_requested_at, r.cancel_requested_by, r.cancel_reason,
           durable_wait.wake_at, durable_wait.mode AS wait_mode,
           signal_wait.deadline_at AS signal_wait_deadline_at,
           human_wait.token_name AS human_wait_name,
           human_wait.context AS human_wait_context,
           human_wait.deadline_at AS human_wait_deadline_at,
           enqueued_event.details AS enqueued_details
      FROM page_ids
      JOIN workhorse.dashboard_job_v1 j ON j.id = page_ids.id
      LEFT JOIN workhorse.dashboard_job_runtime_v1 r ON r.job_id = j.id
      LEFT JOIN workhorse.dashboard_job_outcome_v1 o ON o.job_id = j.id
      LEFT JOIN workhorse.dashboard_job_wait_v1 durable_wait
        ON durable_wait.job_id = j.id AND durable_wait.wait_name = r.wait_name
      LEFT JOIN workhorse.dashboard_signal_wait_v1 signal_wait
        ON signal_wait.job_id = j.id AND signal_wait.signal_name = r.wait_name
      LEFT JOIN workhorse.dashboard_human_wait_v1 human_wait
        ON human_wait.job_id = j.id AND human_wait.token_name = r.wait_name
      LEFT JOIN LATERAL (
        SELECT event.details FROM workhorse.dashboard_job_event_v1 event
         WHERE event.job_id = j.id AND event.event_type = 'enqueued'
         ORDER BY event.occurred_at, event.event_id LIMIT 1
      ) enqueued_event ON true
      LEFT JOIN LATERAL (
        SELECT history.worker_id FROM workhorse.dashboard_attempt_history_v1 history
         WHERE history.job_id = j.id ORDER BY history.attempt DESC LIMIT 1
      ) attempt_worker ON page_ids.worker_filter IS NOT NULL
  )
  SELECT jsonb_build_object(
    'capturedAt', workhorse.dashboard_iso_v1(clock_timestamp()),
    'canCompleteHumanWait', parameters.can_complete_human_wait,
    'filter', parameters.filter,
    'queue', parameters.queue_filter,
    'worker', parameters.worker_filter,
    'jobType', parameters.type_filter,
    'priority', parameters.priority_filter,
    'sort', parameters.sort,
    'tags', to_jsonb(parameters.tag_filter),
    'search', parameters.search,
    'page', parameters.page,
    'pageSize', parameters.page_size,
    'total', CASE WHEN parameters.count_mode = 'exact' THEN (SELECT count(*) FROM filtered) END,
    'nextCursor', CASE WHEN (parameters.backwards AND parameters.cursor_id IS NOT NULL)
      OR (NOT parameters.backwards AND (SELECT count(*) FROM candidates) > parameters.page_size)
      THEN (SELECT jsonb_build_object('id', id::text, 'priority', priority,
        'updatedAt', to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))
      FROM page_ids ORDER BY CASE WHEN parameters.sort = 'priority' THEN priority END ASC, updated_at ASC, id ASC LIMIT 1) END,
    'previousCursor', CASE WHEN (NOT parameters.backwards AND parameters.cursor_id IS NOT NULL)
      OR (parameters.backwards AND (SELECT count(*) FROM candidates) > parameters.page_size)
      THEN (SELECT jsonb_build_object('id', id::text, 'priority', priority,
        'updatedAt', to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))
      FROM page_ids ORDER BY CASE WHEN parameters.sort = 'priority' THEN priority END DESC, updated_at DESC, id DESC LIMIT 1) END,
    'jobs', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', id::text, 'queue', queue, 'type', type, 'priority', priority, 'state', state,
        'blockedReason', blocked_reason, 'prerequisiteJobIds', prerequisite_job_ids,
        'attempt', attempt, 'maxAttempts', max_attempts, 'retryPolicy', retry_policy,
        'deadlineAt', workhorse.dashboard_iso_v1(deadline_at),
        'executionTimeoutMs', execution_timeout_ms, 'tags', tags,
        'keyed', COALESCE(jsonb_typeof(enqueued_details->'idempotency') = 'object', false),
        'cancellation', CASE WHEN cancel_requested_at IS NULL THEN NULL ELSE jsonb_build_object(
          'requestedAt', workhorse.dashboard_iso_v1(cancel_requested_at),
          'requestedBy', NULLIF(cancel_requested_by, ''),
          'reason', NULLIF(cancel_reason, '')) END,
        'runAt', workhorse.dashboard_iso_v1(run_at), 'workerId', current_worker_id,
        'lastWorkerId', worker_id, 'finishedAt', workhorse.dashboard_iso_v1(finished_at),
        'errorMessage', error->>'message', 'createdAt', workhorse.dashboard_iso_v1(created_at),
        'updatedAt', workhorse.dashboard_iso_v1(updated_at), 'durability', NULL,
        'waitName', wait_name, 'wakeAt', workhorse.dashboard_iso_v1(wake_at),
        'wait', CASE WHEN wait_name IS NOT NULL AND wake_at IS NOT NULL AND wait_mode IS NOT NULL
          THEN jsonb_build_object('name', wait_name,
                                  'wakeAt', workhorse.dashboard_iso_v1(wake_at),
                                  'mode', wait_mode) END,
        'signalWait', CASE WHEN wait_name IS NOT NULL AND signal_wait_deadline_at IS NOT NULL
          THEN jsonb_build_object('name', wait_name,
                                  'deadlineAt',
                                  workhorse.dashboard_iso_v1(signal_wait_deadline_at)) END,
        'humanWait', CASE WHEN human_wait_name IS NOT NULL AND human_wait_deadline_at IS NOT NULL
          THEN jsonb_build_object('name', human_wait_name, 'context', human_wait_context,
                                  'deadlineAt',
                                  workhorse.dashboard_iso_v1(human_wait_deadline_at)) END
      ) ORDER BY CASE WHEN parameters.sort = 'priority' THEN priority END DESC,
                 updated_at DESC, id DESC)
        FROM page CROSS JOIN parameters
    ), '[]'::jsonb)
  ) FROM parameters;
$query$, '__cursor__', v_cursor), '__order__', v_order);
  EXECUTE v_query INTO v_result USING p_input;
  RETURN v_result;
END;
$$;

CREATE OR REPLACE FUNCTION workhorse.dashboard_system_v2(p_input jsonb)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_now timestamptz := clock_timestamp();
  v_window text := COALESCE(p_input->>'window', '1h');
  v_seconds integer;
  v_minutes double precision;
  v_health jsonb;
  v_outcomes jsonb;
  v_summary jsonb;
  v_wait jsonb;
  v_runtime record;
  v_retry_buckets jsonb;
  v_queues jsonb;
  v_retry_types jsonb;
  v_failing_types jsonb;
  v_categories jsonb;
  v_max_lag jsonb;
  v_oldest_retained jsonb;
  v_retention jsonb;
  v_relations jsonb;
  v_storage jsonb;
  v_total_storage_bytes bigint;
  v_partitions jsonb;
  v_current_error_rate double precision;
  v_previous_error_rate double precision;
BEGIN
  v_seconds := CASE v_window WHEN '15m' THEN 900 WHEN '24h' THEN 86400 ELSE 3600 END;
  v_minutes := v_seconds::double precision / 60;
  v_health := workhorse.queue_health_v1();

  WITH current_stats AS MATERIALIZED (SELECT * FROM workhorse.stat_buckets_v1(
        date_bin('1 minute', v_now, timestamp with time zone '2000-01-01')
          - make_interval(secs => v_seconds) + interval '1 minute',
        v_now
      ) stat)
  SELECT
    (
WITH buckets AS (
    SELECT generate_series(
      date_bin('1 minute', v_now, timestamp with time zone '2000-01-01')
        - make_interval(secs => v_seconds) + interval '1 minute',
      date_bin('1 minute', v_now, timestamp with time zone '2000-01-01'),
      interval '1 minute'
    ) AS bucket_start
  ), rolled AS (
    SELECT stat.bucket_start,
           sum(stat.enqueued)::integer AS enqueued,
           sum(stat.attempt_succeeded)::integer AS succeeded,
           sum(stat.attempt_failed)::integer AS failed,
           sum(stat.attempt_retry)::integer AS retry,
           sum(stat.attempt_lease_expired)::integer AS lease_expired,
           sum(stat.attempt_canceled)::integer AS canceled
      FROM current_stats stat
     GROUP BY stat.bucket_start
  ), rows AS (
    SELECT buckets.bucket_start,
           COALESCE(rolled.enqueued, 0)::integer AS enqueued,
           COALESCE(rolled.succeeded, 0)::integer AS succeeded,
           COALESCE(rolled.failed, 0)::integer AS failed,
           COALESCE(rolled.retry, 0)::integer AS retry,
           COALESCE(rolled.lease_expired, 0)::integer AS lease_expired,
           COALESCE(rolled.canceled, 0)::integer AS canceled
      FROM buckets LEFT JOIN rolled USING (bucket_start)
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'bucketStart', workhorse.dashboard_iso_v1(bucket_start),
           'enqueued', enqueued, 'succeeded', succeeded, 'failed', failed,
           'retry', retry, 'leaseExpired', lease_expired, 'canceled', canceled
         ) ORDER BY bucket_start), '[]'::jsonb) FROM rows
    ),
    (
SELECT to_jsonb(result) FROM (
WITH current_window AS (
    SELECT COALESCE(sum(stat.enqueued), 0)::integer AS enqueued,
           COALESCE(sum(stat.attempt_succeeded + stat.attempt_failed
             + stat.attempt_canceled), 0)::integer AS completed,
           COALESCE(sum(stat.attempt_succeeded + stat.attempt_failed + stat.attempt_retry
             + stat.attempt_lease_expired + stat.attempt_canceled + stat.attempt_other),
             0)::integer AS attempts,
           COALESCE(sum(stat.attempt_failed + stat.attempt_retry
             + stat.attempt_lease_expired + stat.attempt_other), 0)::integer AS errors,
           COALESCE(sum(stat.attempt_lease_expired), 0)::integer AS recovered
      FROM current_stats stat
  ), previous_window AS (
    SELECT COALESCE(sum(stat.attempt_succeeded + stat.attempt_failed + stat.attempt_retry
             + stat.attempt_lease_expired + stat.attempt_canceled + stat.attempt_other),
             0)::integer AS attempts,
           COALESCE(sum(stat.attempt_failed + stat.attempt_retry
             + stat.attempt_lease_expired + stat.attempt_other), 0)::integer AS errors
      FROM workhorse.stat_buckets_v1(
        date_bin('1 minute', v_now, timestamp with time zone '2000-01-01')
          - make_interval(secs => v_seconds * 2) + interval '1 minute',
        date_bin('1 minute', v_now, timestamp with time zone '2000-01-01')
          - make_interval(secs => v_seconds) + interval '1 minute'
      ) stat
  )
  SELECT current_window.*, previous_window.attempts AS previous_attempts,
         previous_window.errors AS previous_errors FROM current_window CROSS JOIN previous_window
) result
    ),
    (
SELECT to_jsonb(result) FROM (
WITH merged AS (
    SELECT workhorse.stat_sketch_merge_v1(array_agg(stat.wait_sketch)) AS sketch
      FROM current_stats stat
  )
  SELECT workhorse.stat_sketch_percentile_v1(sketch, 0.50) AS p50,
         workhorse.stat_sketch_percentile_v1(sketch, 0.95) AS p95,
         workhorse.stat_sketch_percentile_v1(sketch, 0.99) AS p99 FROM merged
) result
    ),
    (
WITH rolled AS (
    SELECT stat.queue_name,
           COALESCE(sum(stat.enqueued), 0)::integer AS enqueued,
           COALESCE(sum(stat.attempt_succeeded + stat.attempt_failed
             + stat.attempt_canceled), 0)::integer AS completed
      FROM current_stats stat
     GROUP BY stat.queue_name
  ), queue_names AS (
    SELECT queue_name FROM workhorse.dashboard_job_runtime_v1
    UNION SELECT queue_name FROM workhorse.dashboard_queue_control_v1
    UNION SELECT queue_name FROM workhorse.dashboard_concurrency_policy_v1
    UNION SELECT queue_name FROM workhorse.dashboard_rate_limit_policy_v1
    UNION SELECT queue_name FROM rolled
  ), runtime AS (
    SELECT queue_name,
           count(*) FILTER (WHERE state = 'ready')::integer AS ready,
           (extract(epoch FROM v_now
             - min(ready_at) FILTER (WHERE state = 'ready')) * 1000)::text AS oldest_ready_ms,
           count(*) FILTER (WHERE state = 'scheduled'
             AND run_at <= v_now + interval '5 minutes')::integer AS due_soon,
           count(*) FILTER (WHERE state = 'active')::integer AS active,
           count(*) FILTER (WHERE state = 'scheduled'
             AND current_attempt > 1)::integer AS retrying
      FROM workhorse.dashboard_job_runtime_v1 GROUP BY queue_name
  ), priorities AS (
    SELECT runtime.queue_name, job.priority, count(*)::integer AS ready,
           (extract(epoch FROM v_now - min(runtime.ready_at)) * 1000)::text
             AS oldest_ready_ms
      FROM workhorse.dashboard_job_runtime_v1 runtime
      JOIN workhorse.dashboard_job_v1 job ON job.id = runtime.job_id
     WHERE runtime.state = 'ready'
     GROUP BY runtime.queue_name, job.priority
  ), rows AS (
    SELECT queue_names.queue_name AS queue, COALESCE(control.paused, false) AS paused,
           COALESCE(runtime.ready, 0)::integer AS ready, runtime.oldest_ready_ms,
           COALESCE(runtime.due_soon, 0)::integer AS due_soon,
           COALESCE(runtime.active, 0)::integer AS active,
           COALESCE(runtime.retrying, 0)::integer AS retrying,
           COALESCE(rolled.enqueued, 0)::integer AS enqueued,
           COALESCE(rolled.completed, 0)::integer AS completed
      FROM queue_names
      LEFT JOIN workhorse.dashboard_queue_control_v1 control USING (queue_name)
      LEFT JOIN runtime USING (queue_name)
      LEFT JOIN rolled USING (queue_name)
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'queue', rows.queue,
           'paused', rows.paused,
           'ready', rows.ready,
           'oldestReadyMs', rows.oldest_ready_ms,
           'priorityBacklog', COALESCE((
             SELECT jsonb_agg(jsonb_build_object(
                      'priority', priority, 'ready', ready,
                      'oldestReadyMs', oldest_ready_ms
                    ) ORDER BY priority DESC)
               FROM priorities WHERE priorities.queue_name = rows.queue
           ), '[]'::jsonb),
           'dueSoon', rows.due_soon,
           'active', rows.active,
           'retrying', rows.retrying,
           'enqueuedPerMinute', rows.enqueued / v_minutes,
           'completedPerMinute', rows.completed / v_minutes,
           'concurrencyPolicy', (
             SELECT jsonb_build_object(
               'namespace', policy->>'namespace',
               'maxActive', (policy->>'max_active')::integer,
               'utilizationKnown', true,
               'active', (policy->>'active')::integer,
               'available', GREATEST(0, (policy->>'max_active')::integer
                 - (policy->>'active')::integer),
               'blockedReady', (policy->>'blocked_ready')::integer,
               'maxActivePerKey', (policy->>'max_active_per_key')::integer,
               'saturatedKeys', (policy->>'saturated_keys')::integer,
               'highestKeyActive', (policy->>'highest_key_active')::integer
             ) FROM jsonb_array_elements(v_health->'concurrency_policies') policy
               WHERE policy->>'queue_name' = rows.queue
           ),
           'rateLimitPolicy', (
             SELECT jsonb_build_object(
               'namespace', policy->>'namespace',
               'rate', jsonb_build_object(
                 'limit', (policy->>'rate_limit')::integer,
                 'intervalMs', (policy->>'rate_interval_ms')::integer,
                 'burst', (policy->>'rate_burst')::integer),
               'perKey', CASE WHEN policy->'per_key_limit' = 'null'::jsonb THEN NULL
                 ELSE jsonb_build_object(
                   'limit', (policy->>'per_key_limit')::integer,
                   'intervalMs', (policy->>'per_key_interval_ms')::integer,
                   'burst', (policy->>'per_key_burst')::integer) END,
               'availableTokens', (policy->>'available_tokens')::numeric,
               'throttledReady', (policy->>'throttled_ready')::integer,
               'throttledKeys', (policy->>'throttled_keys')::integer,
               'nextEligibleAt', workhorse.dashboard_iso_v1(
                 (policy->>'next_eligible_at')::timestamptz)
             ) FROM jsonb_array_elements(v_health->'rate_limit_policies') policy
               WHERE policy->>'queue_name' = rows.queue
           )
         ) ORDER BY rows.queue), '[]'::jsonb) FROM rows
    ),
    (
WITH rows AS (
    SELECT stat.queue_name AS queue, stat.job_type AS type,
           sum(stat.attempt_succeeded + stat.attempt_failed + stat.attempt_retry
             + stat.attempt_lease_expired + stat.attempt_canceled
             + stat.attempt_other)::integer AS attempts,
           sum(stat.attempt_failed + stat.attempt_retry
             + stat.attempt_lease_expired + stat.attempt_other)::integer AS errors,
           sum(stat.attempt_failed)::integer AS terminal_failures,
           (array_agg(stat.last_error ORDER BY stat.last_error_at DESC NULLS LAST)
             FILTER (WHERE stat.last_error IS NOT NULL))[1] AS last_error,
           max(stat.last_attempt_at) AS last_seen_at
      FROM current_stats stat
     GROUP BY stat.queue_name, stat.job_type
    HAVING sum(stat.attempt_failed + stat.attempt_retry
      + stat.attempt_lease_expired + stat.attempt_other) > 0
     ORDER BY errors DESC, last_seen_at DESC
     LIMIT 8
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'queue', queue, 'type', type, 'attempts', attempts,
           'errorRate', CASE WHEN attempts = 0 THEN 0 ELSE errors::double precision / attempts END,
           'terminalFailures', terminal_failures, 'lastError', last_error,
           'lastSeenAt', workhorse.dashboard_iso_v1(last_seen_at)
         ) ORDER BY errors DESC, last_seen_at DESC), '[]'::jsonb) FROM rows
    )
  INTO v_outcomes, v_summary, v_wait, v_queues, v_failing_types;








  SELECT count(*) FILTER (WHERE state = 'ready')::integer AS ready,
         (extract(epoch FROM v_now
           - min(ready_at) FILTER (WHERE state = 'ready')) * 1000)::text AS oldest_ready_ms,
         count(*) FILTER (WHERE state = 'scheduled' AND current_attempt > 1)::integer AS backoff,
         count(*) FILTER (WHERE state = 'scheduled' AND current_attempt > 1
           AND run_at <= v_now + interval '5 minutes')::integer AS due_soon,
         count(*) FILTER (WHERE state = 'active')::integer AS active,
         count(*) FILTER (WHERE state = 'active'
           AND expires_at <= v_now)::integer AS expired,
         count(*) FILTER (WHERE state = 'active' AND expires_at > v_now
           AND expires_at <= v_now + interval '30 seconds')::integer AS expiring_soon,
         count(*) FILTER (WHERE state = 'scheduled'
           AND run_at < v_now - interval '10 seconds')::integer AS due_but_unpromoted
    INTO v_runtime FROM workhorse.dashboard_job_runtime_v1;

  WITH bounds(upper_bound_ms, ordering) AS (
    VALUES (60000, 1), (300000, 2), (900000, 3), (3600000, 4), (NULL::integer, 5)
  ), counts AS (
    SELECT CASE
             WHEN run_at <= v_now + interval '1 minute' THEN 60000
             WHEN run_at <= v_now + interval '5 minutes' THEN 300000
             WHEN run_at <= v_now + interval '15 minutes' THEN 900000
             WHEN run_at <= v_now + interval '1 hour' THEN 3600000
             ELSE NULL
           END AS upper_bound_ms,
           count(*)::integer AS count
      FROM workhorse.dashboard_job_runtime_v1
     WHERE state = 'scheduled' AND current_attempt > 1
     GROUP BY 1
  )
  SELECT jsonb_agg(jsonb_build_object(
           'upperBoundMs', bounds.upper_bound_ms, 'count', COALESCE(counts.count, 0)
         ) ORDER BY bounds.ordering)
    INTO v_retry_buckets
    FROM bounds LEFT JOIN counts ON counts.upper_bound_ms IS NOT DISTINCT FROM bounds.upper_bound_ms;



  WITH rows AS (
    SELECT job.queue_name AS queue, job.job_type AS type, count(*)::integer AS count
      FROM workhorse.dashboard_job_runtime_v1 runtime
      JOIN workhorse.dashboard_job_v1 job ON job.id = runtime.job_id
     WHERE runtime.state = 'scheduled' AND runtime.current_attempt > 1
     GROUP BY job.queue_name, job.job_type
     ORDER BY count DESC, job.queue_name, job.job_type
     LIMIT 3
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'queue', queue, 'type', type, 'count', count
         ) ORDER BY count DESC, queue, type), '[]'::jsonb)
    INTO v_retry_types FROM rows;



  v_categories := jsonb_build_array(
    jsonb_build_object('category', 'jobIdentity',
      'retentionDays', (v_health->>'job_identity_retention_days')::integer,
      'lagMs', (v_health->>'job_identity_lag_ms')::numeric,
      'oldestRetainedAt', workhorse.dashboard_iso_v1(
        (v_health->>'oldest_job_identity_at')::timestamptz), 'prunedByPartition', false),
    jsonb_build_object('category', 'terminalOutcome',
      'retentionDays', (v_health->>'terminal_outcome_retention_days')::integer,
      'lagMs', (v_health->>'terminal_outcome_lag_ms')::numeric,
      'oldestRetainedAt', workhorse.dashboard_iso_v1(
        (v_health->>'oldest_terminal_outcome_at')::timestamptz), 'prunedByPartition', false),
    jsonb_build_object('category', 'jobEvents',
      'retentionDays', (v_health->>'job_event_retention_days')::integer,
      'lagMs', (v_health->>'job_event_lag_ms')::numeric,
      'oldestRetainedAt', workhorse.dashboard_iso_v1(
        (v_health->>'oldest_job_event_at')::timestamptz), 'prunedByPartition', true),
    jsonb_build_object('category', 'attemptHistory',
      'retentionDays', (v_health->>'attempt_history_retention_days')::integer,
      'lagMs', (v_health->>'attempt_history_lag_ms')::numeric,
      'oldestRetainedAt', workhorse.dashboard_iso_v1(
        (v_health->>'oldest_attempt_history_at')::timestamptz), 'prunedByPartition', true),
    jsonb_build_object('category', 'scheduleOccurrences',
      'retentionDays', (v_health->>'schedule_occurrence_retention_days')::integer,
      'lagMs', (v_health->>'schedule_occurrence_lag_ms')::numeric,
      'oldestRetainedAt', workhorse.dashboard_iso_v1(
        (v_health->>'oldest_schedule_occurrence_at')::timestamptz), 'prunedByPartition', false),
    jsonb_build_object('category', 'statistics',
      'retentionDays', (v_health->>'statistics_retention_days')::integer,
      'lagMs', (v_health->>'statistics_lag_ms')::numeric,
      'oldestRetainedAt', workhorse.dashboard_iso_v1(
        (v_health->>'oldest_statistics_at')::timestamptz), 'prunedByPartition', false)
  );

  SELECT value INTO v_max_lag
    FROM jsonb_array_elements(v_categories) value
   WHERE (value->>'lagMs')::numeric > 0
   ORDER BY (value->>'lagMs')::numeric DESC LIMIT 1;
  SELECT value INTO v_oldest_retained
    FROM jsonb_array_elements(v_categories) value
   WHERE value->>'oldestRetainedAt' IS NOT NULL
   ORDER BY value->>'oldestRetainedAt' LIMIT 1;

  v_retention := jsonb_build_object(
    'policyUpdatedAt', workhorse.dashboard_iso_v1((v_health->>'updated_at')::timestamptz),
    'categories', v_categories,
    'maxLagMs', (v_max_lag->>'lagMs')::numeric,
    'maxLagCategory', v_max_lag->>'category',
    'oldestRetainedAt', v_oldest_retained->>'oldestRetainedAt',
    'oldestRetainedCategory', v_oldest_retained->>'category',
    'eligibleHistoryPartitions', jsonb_build_object(
      'jobEvents', (v_health->>'eligible_event_partitions')::integer,
      'attemptHistory', (v_health->>'eligible_attempt_partitions')::integer),
    'defaultHistoryRows', jsonb_build_object(
      'jobEvents', (v_health->>'default_event_rows')::integer,
      'attemptHistory', (v_health->>'default_attempt_rows')::integer),
    'defaultHistoryRowsCapped', jsonb_build_object(
      'jobEvents', (v_health->>'default_event_rows_capped')::boolean,
      'attemptHistory', (v_health->>'default_attempt_rows_capped')::boolean)
  );

  WITH names(relation, ordering) AS (
    VALUES ('job', 1), ('job_outcome', 2), ('job_runtime', 3), ('job_query', 4),
           ('job_event', 5), ('attempt_history', 6), ('schedule_occurrence', 7),
           ('job_stat_bucket', 8), ('job_stat_bucket_hour', 9), ('job_stat_bucket_day', 10)
  ), observations AS (
    SELECT value FROM jsonb_array_elements(v_health->'observations'->'relations') value
  ), rows AS (
    SELECT names.ordering, names.relation,
           COALESCE((observations.value->>'total_bytes')::bigint, 0) AS total_bytes,
           COALESCE((observations.value->>'table_bytes')::bigint, 0) AS table_bytes,
           COALESCE((observations.value->>'index_bytes')::bigint, 0) AS index_bytes,
           COALESCE((observations.value->>'live_tuples')::bigint, 0) AS live_tuples,
           COALESCE((observations.value->>'dead_tuples')::bigint, 0) AS dead_tuples,
           COALESCE((observations.value->>'partitions')::integer, 0) AS partitions,
           COALESCE(observations.value->>'last_autovacuum',
                    observations.value->>'last_vacuum') AS last_vacuum_at
      FROM names LEFT JOIN observations ON observations.value->>'relation' = names.relation
  )
  SELECT jsonb_agg(jsonb_build_object(
           'relation', relation, 'totalBytes', total_bytes, 'tableBytes', table_bytes,
           'indexBytes', index_bytes, 'rows', live_tuples, 'deadRows', dead_tuples,
           'partitions', partitions,
           'lastVacuumAt', workhorse.dashboard_iso_v1(last_vacuum_at::timestamptz)
         ) ORDER BY total_bytes DESC, ordering), sum(total_bytes)
    INTO v_relations, v_total_storage_bytes FROM rows;

  v_storage := jsonb_build_object(
    'rollup', jsonb_build_object(
      'rolledUpThrough', workhorse.dashboard_iso_v1(
        (v_health->>'rolled_up_through')::timestamptz),
      'lagMs', (v_health->>'rollup_lag_ms')::numeric,
      'lastRunAt', workhorse.dashboard_iso_v1((v_health->>'last_run_at')::timestamptz),
      'buckets', (v_health->>'buckets')::integer,
      'oldestBucketAt', workhorse.dashboard_iso_v1(
        (v_health->>'oldest_statistics_at')::timestamptz),
      'newestBucketAt', workhorse.dashboard_iso_v1((v_health->>'newest_bucket_at')::timestamptz),
      'stalled', EXISTS (
        SELECT 1 FROM jsonb_array_elements(v_health->'status'->'reasons') reason
         WHERE reason->>'code' = 'rollup-stalled'
      )
    ),
    'relations', v_relations,
    'totalBytes', v_total_storage_bytes
  );

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'day', value->>'day',
           'startsAt', workhorse.dashboard_iso_v1((value->>'starts_at')::timestamptz),
           'eventExists', (value->>'has_job_events')::boolean,
           'attemptExists', (value->>'has_attempt_history')::boolean
         ) ORDER BY value->>'day'), '[]'::jsonb)
    INTO v_partitions FROM jsonb_array_elements(v_health->'history_partition_days') value;

  v_current_error_rate := CASE WHEN (v_summary->>'attempts')::integer = 0 THEN 0
    ELSE (v_summary->>'errors')::integer::double precision / (v_summary->>'attempts')::integer END;
  v_previous_error_rate := CASE WHEN (v_summary->>'previous_attempts')::integer = 0 THEN 0
    ELSE (v_summary->>'previous_errors')::integer::double precision / (v_summary->>'previous_attempts')::integer END;

  RETURN jsonb_build_object(
    'capturedAt', workhorse.dashboard_iso_v1(v_now),
    'window', v_window,
    'windowSeconds', v_seconds,
    'status', v_health->'status',
    'pausedQueues', COALESCE((
      SELECT jsonb_agg(value->'queue' ORDER BY value->>'queue')
        FROM jsonb_array_elements(v_queues) value WHERE (value->>'paused')::boolean
    ), '[]'::jsonb),
    'kpis', jsonb_build_object(
      'drain', jsonb_build_object(
        'enqueuedPerMinute', (v_summary->>'enqueued')::integer / v_minutes,
        'completedPerMinute', (v_summary->>'completed')::integer / v_minutes,
        'netPerMinute', ((v_summary->>'completed')::integer - (v_summary->>'enqueued')::integer) / v_minutes),
      'backlog', jsonb_build_object(
        'ready', v_runtime.ready, 'oldestReadyMs', v_runtime.oldest_ready_ms),
      'errorRate', jsonb_build_object(
        'current', v_current_error_rate, 'previous', v_previous_error_rate,
        'delta', v_current_error_rate - v_previous_error_rate),
      'queueWait', jsonb_build_object(
        'p50Ms', (v_wait->>'p50')::double precision, 'p95Ms', (v_wait->>'p95')::double precision, 'p99Ms', (v_wait->>'p99')::double precision),
      'retry', jsonb_build_object(
        'backoff', v_runtime.backoff, 'dueSoon', v_runtime.due_soon,
        'buckets', v_retry_buckets),
      'lease', jsonb_build_object(
        'active', v_runtime.active, 'expired', v_runtime.expired,
        'expiringSoon', v_runtime.expiring_soon, 'recovered', (v_summary->>'recovered')::integer),
      'dependencies', jsonb_build_object(
        'blockedJobs', (v_health->>'dependency_blocked_jobs')::integer,
        'pendingEdges', (v_health->>'dependency_pending_edges')::integer,
        'failedResolutions', (v_health->>'dependency_failed_resolutions')::integer,
        'retentionPruneStarved', (v_health->>'dependency_retention_prune_starved')::boolean,
        'capped', (v_health->>'dependency_counts_capped')::boolean),
      'children', jsonb_build_object(
        'waitingParents', (v_health->>'child_waiting_parents')::integer,
        'pendingChildren', (v_health->>'child_pending_children')::integer,
        'unjoinedResults', (v_health->>'child_unjoined_results')::integer,
        'failedParents', (v_health->>'child_failed_parents')::integer,
        'canceledParents', (v_health->>'child_canceled_parents')::integer,
        'capped', (v_health->>'child_counts_capped')::boolean),
      'externalWaits', jsonb_build_object(
        'pendingSignals', (v_health->>'pending_signal_waits')::integer,
        'pendingHumanDecisions', (v_health->>'pending_human_waits')::integer,
        'overdue', (v_health->>'overdue_external_waits')::integer,
        'oldestPendingAgeMs', (v_health->>'oldest_external_wait_age_ms')::numeric,
        'rejectedDeliveries', (v_health->>'rejected_wait_deliveries')::integer,
        'capped', (v_health->>'external_wait_counts_capped')::boolean),
      'deadline', jsonb_build_object(
        'pending', (v_health->>'pending_deadlines')::integer,
        'overdue', (v_health->>'overdue_deadlines')::integer,
        'dueWithinMinute', (v_health->>'deadlines_due_within_minute')::integer,
        'earliestAt', workhorse.dashboard_iso_v1(
          (v_health->>'earliest_deadline_at')::timestamptz),
        'activeTimeouts', (v_health->>'active_execution_timeouts')::integer,
        'overdueTimeouts', (v_health->>'overdue_execution_timeouts')::integer)
    ),
    'outcomes', v_outcomes,
    'queues', v_queues,
    'concurrencyPoliciesCapped', EXISTS (
      SELECT 1 FROM jsonb_array_elements(v_health->'concurrency_policies') policy
       WHERE (policy->>'capped')::boolean),
    'rateLimitPoliciesCapped', EXISTS (
      SELECT 1 FROM jsonb_array_elements(v_health->'rate_limit_policies') policy
       WHERE (policy->>'policy_set_capped')::boolean OR (policy->>'sample_capped')::boolean),
    'retryStorm', jsonb_build_object('buckets', v_retry_buckets, 'topTypes', v_retry_types),
    'failingTypes', v_failing_types,
    'integrity', jsonb_build_object(
      'dueButUnpromoted', v_runtime.due_but_unpromoted,
      'partitions', v_partitions,
      'defaultEventRows', (v_health->>'default_event_rows')::integer,
      'defaultAttemptRows', (v_health->>'default_attempt_rows')::integer,
      'retention', v_retention,
      'storage', v_storage)
  );
END;
$$;
