-- workhorse-migration: {"kind":"additive"}

-- Bounded dashboard reads (SM-755).

-- Five dashboard read procedures cost what the whole task or history table holds rather than what
-- the page returns. The task and event listings counted every matching row on every request, the
-- facet lists read every task and every retained attempt, and task detail aggregated a task's
-- attempts, checkpoints, waits, and events without a bound while carrying checkpoint values that
-- may each hold a megabyte. Each request now pays for its page.

-- A caller asks for an exact count with "count": "exact". Without it the listings report the total
-- they can prove from one row past the page, which is what a pager needs, and the exact count stays
-- out of the plan. Task detail keeps its most recent rows per section and reports what it cut.
-- Human waits and task detail accept a health document the caller already read.

CREATE INDEX IF NOT EXISTS attempt_history_worker_idx
  ON workhorse.attempt_history (worker_id);

CREATE OR REPLACE VIEW workhorse.dashboard_task_query_v1 AS
  SELECT task_id, queue_name, task_type, created_at FROM workhorse.task_query;

CREATE OR REPLACE FUNCTION workhorse.dashboard_task_detail_limit_v1()
RETURNS integer
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT 200;
$$;

CREATE OR REPLACE FUNCTION workhorse.dashboard_task_event_limit_v1()
RETURNS integer
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT 1000;
$$;

CREATE OR REPLACE FUNCTION workhorse.dashboard_inline_value_bytes_v1()
RETURNS integer
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT 65536;
$$;

CREATE OR REPLACE FUNCTION workhorse.dashboard_tasks_v1(p_input jsonb)
RETURNS jsonb
LANGUAGE sql
AS $$
  WITH parameters AS (
    SELECT COALESCE(NULLIF(p_input->>'filter', ''), 'all') AS filter,
           NULLIF(p_input->>'queue', '') AS queue_filter,
           NULLIF(p_input->>'worker', '') AS worker_filter,
           NULLIF(p_input->>'taskType', '') AS type_filter,
           NULLIF(p_input->>'priority', '')::integer AS priority_filter,
           COALESCE(ARRAY(SELECT jsonb_array_elements_text(p_input->'tags')), ARRAY[]::text[])
             AS tag_filter,
           NULLIF(p_input->>'search', '') AS search,
           CASE WHEN NULLIF(p_input->>'search', '') IS NULL THEN NULL ELSE
             '%' || replace(replace(replace(replace(
               p_input->>'search', '!', '!!'), '%', '!%'), '_', '!_'), '*', '%') || '%'
           END AS search_filter,
           COALESCE(NULLIF(p_input->>'page', '')::integer, 1) AS page,
           COALESCE(NULLIF(p_input->>'pageSize', '')::integer, 50) AS page_size,
           COALESCE(NULLIF(p_input->>'sort', ''), 'updated') AS sort,
           COALESCE(NULLIF(p_input->>'count', ''), 'none') AS count_mode,
           COALESCE((p_input->>'canCompleteHumanWait')::boolean, false)
             AS can_complete_human_wait
  ), task_rows AS (
    SELECT j.id, j.queue_name AS queue, j.task_type AS type, j.priority,
           COALESCE(r.state, o.state) AS state,
           COALESCE(r.current_attempt, o.current_attempt) AS attempt,
           j.tags, r.worker_id AS current_worker_id, r.wait_name,
           COALESCE(r.updated_at, o.updated_at, j.created_at) AS updated_at
      FROM workhorse.dashboard_task_v1 j
      LEFT JOIN workhorse.dashboard_task_runtime_v1 r ON r.task_id = j.id
      LEFT JOIN workhorse.dashboard_task_outcome_v1 o ON o.task_id = j.id
  -- No materialization hint: one reference lets the limit reach the filter, and a request that
  -- asks for an exact count adds the second reference PostgreSQL materializes for.
  ), filtered AS (
    SELECT task_rows.* FROM task_rows CROSS JOIN parameters
     WHERE CASE parameters.filter
       WHEN 'blocked' THEN task_rows.state = 'blocked'
       WHEN 'waiting' THEN EXISTS (
         SELECT 1 FROM workhorse.dashboard_signal_wait_v1 signal_wait
          WHERE signal_wait.task_id = task_rows.id
         UNION ALL
         SELECT 1 FROM workhorse.dashboard_human_wait_v1 human_wait
          WHERE human_wait.task_id = task_rows.id
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
           SELECT wait.worker_id FROM workhorse.dashboard_task_wait_v1 wait
            WHERE wait.task_id = task_rows.id AND wait.wait_name = task_rows.wait_name
         ),
         (
           SELECT history.worker_id FROM workhorse.dashboard_attempt_history_v1 history
            WHERE history.task_id = task_rows.id
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
  -- Offset paging already reads every row up to the page, so counting those rows plus one costs
  -- nothing more and answers what a pager asks: the total when it is this small, and otherwise that
  -- one more page exists. The exact count over every matching task stays behind "count": "exact".
  ), candidate_ids AS MATERIALIZED (
    SELECT filtered.id, filtered.priority, filtered.updated_at, parameters.worker_filter
      FROM filtered CROSS JOIN parameters
     ORDER BY CASE WHEN parameters.sort = 'priority' THEN priority END DESC,
              updated_at DESC, id DESC
     LIMIT (SELECT page * page_size + 1 FROM parameters)
  ), page_ids AS MATERIALIZED (
    SELECT candidate_ids.* FROM candidate_ids CROSS JOIN parameters
     ORDER BY CASE WHEN parameters.sort = 'priority' THEN priority END DESC,
              updated_at DESC, id DESC
     LIMIT (SELECT page_size FROM parameters)
     OFFSET (SELECT (page - 1) * page_size FROM parameters)
  ), page AS (
    SELECT j.id, j.queue_name AS queue, j.task_type AS type, page_ids.priority,
           COALESCE(r.state, o.state) AS state,
           CASE WHEN r.state = 'blocked' THEN 'prerequisite_pending' END AS blocked_reason,
           COALESCE((
             SELECT jsonb_agg(dependency.prerequisite_task_id::text
                              ORDER BY dependency.prerequisite_task_id)
               FROM workhorse.dashboard_task_dependency_v1 dependency
              WHERE dependency.dependent_task_id = j.id AND dependency.released_at IS NULL
           ), '[]'::jsonb) AS prerequisite_task_ids,
           COALESCE(r.current_attempt, o.current_attempt) AS attempt,
           j.max_attempts, j.retry_policy, j.tags,
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
      JOIN workhorse.dashboard_task_v1 j ON j.id = page_ids.id
      LEFT JOIN workhorse.dashboard_task_runtime_v1 r ON r.task_id = j.id
      LEFT JOIN workhorse.dashboard_task_outcome_v1 o ON o.task_id = j.id
      LEFT JOIN workhorse.dashboard_task_wait_v1 durable_wait
        ON durable_wait.task_id = j.id AND durable_wait.wait_name = r.wait_name
      LEFT JOIN workhorse.dashboard_signal_wait_v1 signal_wait
        ON signal_wait.task_id = j.id AND signal_wait.signal_name = r.wait_name
      LEFT JOIN workhorse.dashboard_human_wait_v1 human_wait
        ON human_wait.task_id = j.id AND human_wait.token_name = r.wait_name
      LEFT JOIN LATERAL (
        SELECT event.details FROM workhorse.dashboard_task_event_v1 event
         WHERE event.task_id = j.id AND event.event_type = 'enqueued'
         ORDER BY event.occurred_at, event.event_id LIMIT 1
      ) enqueued_event ON true
      LEFT JOIN LATERAL (
        SELECT history.worker_id FROM workhorse.dashboard_attempt_history_v1 history
         WHERE history.task_id = j.id ORDER BY history.attempt DESC LIMIT 1
      ) attempt_worker ON page_ids.worker_filter IS NOT NULL
  )
  SELECT jsonb_build_object(
    'capturedAt', workhorse.dashboard_iso_v1(clock_timestamp()),
    'canCompleteHumanWait', parameters.can_complete_human_wait,
    'filter', parameters.filter,
    'queue', parameters.queue_filter,
    'worker', parameters.worker_filter,
    'taskType', parameters.type_filter,
    'priority', parameters.priority_filter,
    'sort', parameters.sort,
    'tags', to_jsonb(parameters.tag_filter),
    'search', parameters.search,
    'page', parameters.page,
    'pageSize', parameters.page_size,
    'count', parameters.count_mode,
    'hasMore', (SELECT count(*) FROM candidate_ids) > parameters.page * parameters.page_size,
    'total', CASE WHEN parameters.count_mode = 'exact' THEN (SELECT count(*) FROM filtered)
      ELSE (SELECT count(*) FROM candidate_ids) END,
    'tasks', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', id::text, 'queue', queue, 'type', type, 'priority', priority, 'state', state,
        'blockedReason', blocked_reason, 'prerequisiteTaskIds', prerequisite_task_ids,
        'attempt', attempt, 'maxAttempts', max_attempts, 'retryPolicy', retry_policy, 'tags', tags,
        'keyed', COALESCE(jsonb_typeof(enqueued_details->'idempotency') = 'object', false),
        'enqueueMode', CASE
          WHEN jsonb_typeof(enqueued_details->'debounce') = 'object' THEN 'debounce'
          WHEN jsonb_typeof(enqueued_details->'throttle') = 'object' THEN 'throttle'
          WHEN jsonb_typeof(enqueued_details->'idempotency') = 'object' THEN 'idempotency'
          ELSE NULL END,
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
$$;

CREATE OR REPLACE FUNCTION workhorse.dashboard_events_v1(p_input jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SET jit = off
AS $$
DECLARE
  v_from timestamptz := NULLIF(p_input->>'rangeStart', '')::timestamptz;
  v_to timestamptz := NULLIF(p_input->>'rangeEnd', '')::timestamptz;
  v_captured_at timestamptz := clock_timestamp();
BEGIN
  IF (v_from IS NULL) <> (v_to IS NULL) THEN
    RAISE EXCEPTION 'rangeStart and rangeEnd must be supplied together' USING ERRCODE = '22023';
  END IF;
  IF v_from IS NOT NULL AND v_from >= v_to THEN
    RAISE EXCEPTION 'rangeEnd must be later than rangeStart' USING ERRCODE = '22023';
  END IF;

  IF v_from IS NULL THEN
    v_to := v_captured_at;
    v_from := v_captured_at - make_interval(secs => CASE
      COALESCE(NULLIF(p_input->>'window', ''), '1h')
      WHEN '15m' THEN 900 WHEN '1h' THEN 3600 WHEN '6h' THEN 21600
      WHEN '24h' THEN 86400
    END);
  END IF;

  RETURN (
    WITH parameters AS (
      SELECT v_captured_at AS captured_at, v_from AS range_start, v_to AS range_end,
             COALESCE(NULLIF(p_input->>'window', ''), '1h') AS window,
             round(extract(epoch FROM v_to - v_from)) AS window_seconds,
             COALESCE(NULLIF(p_input->>'page', '')::integer, 1) AS page,
             COALESCE(NULLIF(p_input->>'pageSize', '')::integer, 50) AS page_size,
             COALESCE(NULLIF(p_input->>'count', ''), 'none') AS count_mode,
             COALESCE(NULLIF(p_input->>'kind', ''), 'all') AS kind,
             NULLIF(p_input->>'queue', '') AS queue_filter,
             NULLIF(p_input->>'taskType', '') AS type_filter,
             NULLIF(p_input->>'worker', '') AS worker_filter,
             NULLIF(trim(p_input->>'search'), '') AS search_filter,
             CASE WHEN jsonb_typeof(p_input->'types') = 'array'
                  THEN ARRAY(SELECT jsonb_array_elements_text(p_input->'types'))
                  ELSE ARRAY[]::text[] END AS event_types,
             NULLIF(p_input->>'taskId', '')::uuid AS task_id
    ), event_records AS NOT MATERIALIZED (
      SELECT event.*, COALESCE(event.details->>'worker_id', (
        SELECT history.worker_id FROM workhorse.dashboard_attempt_history_v1 history
         WHERE history.task_id = event.task_id AND history.attempt = event.attempt
         ORDER BY history.occurred_at DESC, history.attempt_id DESC LIMIT 1
      )) AS resolved_worker_id
        FROM workhorse.dashboard_task_event_v1 event
    ), event_feed AS (
      SELECT 'event'::text AS kind, event.event_id AS record_id, event.task_id,
             event.occurred_at, event.attempt, event.event_type AS type, event.details,
             event.resolved_worker_id AS worker_id, NULL::bigint AS fence_token,
             NULL::timestamptz AS started_at, NULL::timestamptz AS finished_at,
             NULL::jsonb AS error, 1 AS kind_rank
        FROM event_records event CROSS JOIN parameters
       WHERE parameters.kind <> 'attempt'
         AND event.occurred_at >= parameters.range_start
         AND event.occurred_at < parameters.range_end
         AND (parameters.task_id IS NULL OR event.task_id = parameters.task_id)
         AND (parameters.worker_filter IS NULL OR event.resolved_worker_id = parameters.worker_filter)
         AND (parameters.search_filter IS NULL
           OR strpos(lower(concat_ws(' ', event.task_id::text, event.event_type, event.resolved_worker_id, event.details::text)), lower(parameters.search_filter)) > 0
           OR EXISTS (SELECT 1 FROM workhorse.dashboard_task_v1 task WHERE task.id = event.task_id
             AND strpos(lower(concat_ws(' ', task.queue_name, task.task_type)), lower(parameters.search_filter)) > 0))
         AND (cardinality(parameters.event_types) = 0
              OR event.event_type = ANY (parameters.event_types))
         AND ((parameters.queue_filter IS NULL AND parameters.type_filter IS NULL) OR EXISTS (
           SELECT 1 FROM workhorse.dashboard_task_v1 task WHERE task.id = event.task_id
             AND (parameters.queue_filter IS NULL OR task.queue_name = parameters.queue_filter)
             AND (parameters.type_filter IS NULL OR task.task_type = parameters.type_filter)
         ))
       ORDER BY event.occurred_at DESC, event.event_id DESC
       LIMIT (SELECT page * page_size + 1 FROM parameters)
    ), attempt_feed AS (
      SELECT 'attempt'::text AS kind, history.attempt_id AS record_id, history.task_id,
             history.occurred_at, history.attempt, history.outcome AS type,
             NULL::jsonb AS details, history.worker_id, history.fence_token,
             history.started_at, history.finished_at, history.error, 0 AS kind_rank
        FROM workhorse.dashboard_attempt_history_v1 history CROSS JOIN parameters
       WHERE parameters.kind <> 'event'
         AND history.occurred_at >= parameters.range_start
         AND history.occurred_at < parameters.range_end
         AND (parameters.task_id IS NULL OR history.task_id = parameters.task_id)
         AND (parameters.worker_filter IS NULL OR history.worker_id = parameters.worker_filter)
         AND (parameters.search_filter IS NULL
           OR strpos(lower(concat_ws(' ', history.task_id::text, history.outcome, history.worker_id, history.error->>'message')), lower(parameters.search_filter)) > 0
           OR EXISTS (SELECT 1 FROM workhorse.dashboard_task_v1 task WHERE task.id = history.task_id
             AND strpos(lower(concat_ws(' ', task.queue_name, task.task_type)), lower(parameters.search_filter)) > 0))
         AND (cardinality(parameters.event_types) = 0
              OR history.outcome = ANY (parameters.event_types))
         AND ((parameters.queue_filter IS NULL AND parameters.type_filter IS NULL) OR EXISTS (
           SELECT 1 FROM workhorse.dashboard_task_v1 task WHERE task.id = history.task_id
             AND (parameters.queue_filter IS NULL OR task.queue_name = parameters.queue_filter)
             AND (parameters.type_filter IS NULL OR task.task_type = parameters.type_filter)
         ))
       ORDER BY history.occurred_at DESC, history.attempt_id DESC
       LIMIT (SELECT page * page_size + 1 FROM parameters)
    ), merged AS MATERIALIZED (
      SELECT * FROM event_feed UNION ALL SELECT * FROM attempt_feed
    -- Offset paging already merges every row up to the page, so counting those rows plus one costs
    -- nothing more and answers what a pager asks: the total when it is this small, and otherwise
    -- that one more page exists. The exact count over the window stays behind "count": "exact".
    ), candidates AS MATERIALIZED (
      SELECT merged.* FROM merged
       ORDER BY occurred_at DESC, kind_rank DESC, record_id DESC
       LIMIT (SELECT page * page_size + 1 FROM parameters)
    ), event_page AS MATERIALIZED (
      SELECT candidates.* FROM candidates
       ORDER BY occurred_at DESC, kind_rank DESC, record_id DESC
       LIMIT (SELECT page_size FROM parameters)
      OFFSET (SELECT (page - 1) * page_size FROM parameters)
    -- The exact count filters both source tables a second time. A one-time filter on the request's
    -- count mode keeps that second pass out of the plan for every request that did not ask for it.
    ), total AS (
      SELECT count(*) AS count FROM (
        SELECT event.event_id
          FROM event_records event CROSS JOIN parameters
         WHERE parameters.kind <> 'attempt'
           AND event.occurred_at >= parameters.range_start
           AND event.occurred_at < parameters.range_end
           AND (parameters.task_id IS NULL OR event.task_id = parameters.task_id)
           AND (parameters.worker_filter IS NULL OR event.resolved_worker_id = parameters.worker_filter)
           AND (parameters.search_filter IS NULL
             OR strpos(lower(concat_ws(' ', event.task_id::text, event.event_type, event.resolved_worker_id, event.details::text)), lower(parameters.search_filter)) > 0
             OR EXISTS (SELECT 1 FROM workhorse.dashboard_task_v1 task WHERE task.id = event.task_id
               AND strpos(lower(concat_ws(' ', task.queue_name, task.task_type)), lower(parameters.search_filter)) > 0))
           AND (cardinality(parameters.event_types) = 0
                OR event.event_type = ANY (parameters.event_types))
           AND ((parameters.queue_filter IS NULL AND parameters.type_filter IS NULL) OR EXISTS (
             SELECT 1 FROM workhorse.dashboard_task_v1 task WHERE task.id = event.task_id
               AND (parameters.queue_filter IS NULL OR task.queue_name = parameters.queue_filter)
               AND (parameters.type_filter IS NULL OR task.task_type = parameters.type_filter)
           ))
        UNION ALL
        SELECT history.attempt_id
          FROM workhorse.dashboard_attempt_history_v1 history CROSS JOIN parameters
         WHERE parameters.kind <> 'event'
           AND history.occurred_at >= parameters.range_start
           AND history.occurred_at < parameters.range_end
           AND (parameters.task_id IS NULL OR history.task_id = parameters.task_id)
           AND (parameters.worker_filter IS NULL OR history.worker_id = parameters.worker_filter)
           AND (parameters.search_filter IS NULL
             OR strpos(lower(concat_ws(' ', history.task_id::text, history.outcome, history.worker_id, history.error->>'message')), lower(parameters.search_filter)) > 0
             OR EXISTS (SELECT 1 FROM workhorse.dashboard_task_v1 task WHERE task.id = history.task_id
               AND strpos(lower(concat_ws(' ', task.queue_name, task.task_type)), lower(parameters.search_filter)) > 0))
           AND (cardinality(parameters.event_types) = 0
                OR history.outcome = ANY (parameters.event_types))
           AND ((parameters.queue_filter IS NULL AND parameters.type_filter IS NULL) OR EXISTS (
             SELECT 1 FROM workhorse.dashboard_task_v1 task WHERE task.id = history.task_id
               AND (parameters.queue_filter IS NULL OR task.queue_name = parameters.queue_filter)
               AND (parameters.type_filter IS NULL OR task.task_type = parameters.type_filter)
           ))
      ) records
       WHERE (SELECT count_mode FROM parameters) = 'exact'
    )
    SELECT jsonb_build_object(
      'capturedAt', workhorse.dashboard_iso_v1(parameters.captured_at),
      'window', parameters.window, 'windowSeconds', parameters.window_seconds,
      'rangeStart', workhorse.dashboard_iso_v1(parameters.range_start),
      'rangeEnd', workhorse.dashboard_iso_v1(parameters.range_end),
      'page', parameters.page, 'pageSize', parameters.page_size,
      'count', parameters.count_mode,
      'hasMore', (SELECT count(*) FROM candidates) > parameters.page * parameters.page_size,
      'total', CASE WHEN parameters.count_mode = 'exact' THEN (SELECT count FROM total)
        ELSE (SELECT count(*) FROM candidates) END,
      'retention', jsonb_build_object(
        'taskEventDays', retention.task_event_retention_days,
        'attemptHistoryDays', retention.attempt_history_retention_days),
      'events', COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'id', event_page.kind || ':' || event_page.record_id::text,
          'kind', event_page.kind, 'recordId', event_page.record_id::text,
          'taskId', event_page.task_id::text, 'queue', task.queue_name,
          'taskType', task.task_type,
          'occurredAt', workhorse.dashboard_iso_v1(event_page.occurred_at),
          'attempt', event_page.attempt, 'type', event_page.type,
          'details', event_page.details, 'workerId', event_page.worker_id,
          'fenceToken', event_page.fence_token::text,
          'durationMs', CASE WHEN event_page.started_at IS NULL
                                  OR event_page.finished_at IS NULL THEN NULL
                             ELSE round(extract(epoch FROM event_page.finished_at
                                                          - event_page.started_at) * 1000) END,
          'errorMessage', event_page.error->>'message')
          ORDER BY event_page.occurred_at DESC, event_page.kind_rank DESC,
                   event_page.record_id DESC)
          FROM event_page
          LEFT JOIN workhorse.dashboard_task_v1 task ON task.id = event_page.task_id
      ), '[]'::jsonb))
      FROM parameters CROSS JOIN workhorse.dashboard_retention_policy_v1 retention
     WHERE retention.singleton
  );
END;
$$;

CREATE OR REPLACE FUNCTION workhorse.dashboard_task_facets_v1(p_input jsonb)
RETURNS jsonb
LANGUAGE sql
AS $$
  WITH RECURSIVE configured_workers AS (
    SELECT jsonb_array_elements_text(
             CASE WHEN jsonb_typeof(p_input->'configuredWorkers') = 'array'
                  THEN p_input->'configuredWorkers' END
           ) AS worker
  ), queue_scan AS (
    SELECT (SELECT min(queue_name) FROM workhorse.dashboard_task_query_v1) AS value
    UNION ALL
    SELECT (SELECT min(query_row.queue_name) FROM workhorse.dashboard_task_query_v1 query_row
             WHERE query_row.queue_name > queue_scan.value)
      FROM queue_scan WHERE queue_scan.value IS NOT NULL
  ), type_scan AS (
    SELECT (SELECT min(task_type) FROM workhorse.dashboard_task_query_v1) AS value
    UNION ALL
    SELECT (SELECT min(query_row.task_type) FROM workhorse.dashboard_task_query_v1 query_row
             WHERE query_row.task_type > type_scan.value)
      FROM type_scan WHERE type_scan.value IS NOT NULL
  ), history_worker_scan AS (
    SELECT (SELECT min(worker_id) FROM workhorse.dashboard_attempt_history_v1) AS value
    UNION ALL
    SELECT (SELECT min(history.worker_id) FROM workhorse.dashboard_attempt_history_v1 history
             WHERE history.worker_id > history_worker_scan.value)
      FROM history_worker_scan WHERE history_worker_scan.value IS NOT NULL
  ), queue_values AS (
    (SELECT value FROM queue_scan WHERE value IS NOT NULL LIMIT 1000)
    UNION SELECT queue_name FROM workhorse.dashboard_queue_control_v1
  ), worker_values AS (
    SELECT worker AS value FROM configured_workers
    UNION SELECT worker_id FROM workhorse.dashboard_worker_registry_v1
    UNION SELECT worker_id FROM workhorse.dashboard_task_runtime_v1 WHERE worker_id IS NOT NULL
    UNION (SELECT value FROM history_worker_scan WHERE value IS NOT NULL LIMIT 1000)
  ), type_values AS (
    SELECT value FROM type_scan WHERE value IS NOT NULL LIMIT 1000
  ), tag_values AS (
    SELECT DISTINCT unnest(tags) AS value FROM workhorse.dashboard_task_v1
  )
  SELECT jsonb_build_object(
    'queues', COALESCE((
      SELECT jsonb_agg(value ORDER BY value) FROM queue_values WHERE value IS NOT NULL
    ), '[]'::jsonb),
    'workers', COALESCE((
      SELECT jsonb_agg(value ORDER BY value) FROM worker_values WHERE value IS NOT NULL
    ), '[]'::jsonb),
    'taskTypes', COALESCE((
      SELECT jsonb_agg(value ORDER BY value) FROM type_values
    ), '[]'::jsonb),
    'tags', COALESCE((
      SELECT jsonb_agg(value ORDER BY value) FROM tag_values
    ), '[]'::jsonb));
$$;

CREATE OR REPLACE FUNCTION workhorse.dashboard_human_waits_v1(p_input jsonb)
RETURNS jsonb
LANGUAGE sql
AS $$
  WITH parameters AS (
    SELECT COALESCE((p_input->>'canComplete')::boolean, false) AS can_complete,
           COALESCE((p_input->>'canSignal')::boolean, false) AS can_signal
  -- The caller may hand in the health document it already read for this request. Computing one is
  -- a pass over live state, and the dashboard reads it from several procedures per page.
  ), health AS (
    SELECT COALESCE(p_input->'health', workhorse.queue_health_v1()) AS value
  ), diagnostics AS (
    SELECT jsonb_build_object(
      'pendingSignals', (value->>'pending_signal_waits')::integer,
      'pendingHumanDecisions', (value->>'pending_human_waits')::integer,
      'overdue', (value->>'overdue_external_waits')::integer,
      'oldestPendingAgeMs', (value->>'oldest_external_wait_age_ms')::double precision,
      'rejectedDeliveries', (value->>'rejected_wait_deliveries')::integer,
      'capped', (value->>'external_wait_counts_capped')::boolean
    ) AS value FROM health
  ), waits AS (
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'taskId', task_id::text, 'queue', queue_name, 'taskType', task_type,
      'name', token_name, 'context', context, 'attempt', attempt,
      'createdAt', workhorse.dashboard_iso_v1(created_at),
      'deadlineAt', workhorse.dashboard_iso_v1(deadline_at)
    ) ORDER BY created_at, task_id, token_name), '[]'::jsonb) AS value
      FROM (
        SELECT * FROM workhorse.dashboard_human_wait_v1
         ORDER BY created_at, task_id, token_name LIMIT 50
      ) bounded
  ), signal_waits AS (
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'taskId', task_id::text, 'queue', queue_name, 'taskType', task_type,
      'name', signal_name, 'attempt', attempt,
      'createdAt', workhorse.dashboard_iso_v1(created_at),
      'deadlineAt', workhorse.dashboard_iso_v1(deadline_at)
    ) ORDER BY created_at, task_id, signal_name), '[]'::jsonb) AS value
      FROM (
        SELECT * FROM workhorse.dashboard_signal_wait_v1
         ORDER BY created_at, task_id, signal_name LIMIT 50
      ) bounded
  )
  SELECT jsonb_build_object(
    'capturedAt', workhorse.dashboard_iso_v1(clock_timestamp()),
    'canComplete', parameters.can_complete,
    'canSignal', parameters.can_signal,
    'diagnostics', diagnostics.value,
    'waits', waits.value,
    'signalWaits', signal_waits.value
  )
    FROM parameters CROSS JOIN diagnostics CROSS JOIN waits CROSS JOIN signal_waits;
$$;

CREATE OR REPLACE FUNCTION workhorse.dashboard_task_detail_v1(p_input jsonb)
RETURNS jsonb
LANGUAGE sql
AS $$
  WITH parameters AS (
    SELECT (p_input->>'id')::uuid AS task_id,
           COALESCE((p_input->>'canSignal')::boolean, false) AS can_signal
  ), task AS (
    SELECT j.id, j.queue_name AS queue, j.task_type AS type, j.priority, j.payload,
           j.max_attempts, j.retry_policy, j.deadline_at, j.execution_timeout_ms,
           j.concurrency_key, j.created_at, j.tags,
           runtime.state AS runtime_state, runtime.current_attempt AS runtime_attempt,
           runtime.run_at, runtime.ready_at, runtime.worker_id,
           runtime.fence_token::text AS fence_token, runtime.acquired_at,
           runtime.heartbeat_at, runtime.expires_at, runtime.wait_name,
           runtime.attempt_started_at, runtime.attempt_timeout_at,
           runtime.cancel_requested_at, runtime.cancel_requested_by, runtime.cancel_reason,
           runtime.error AS runtime_error,
           outcome.state AS outcome_state, outcome.current_attempt AS outcome_attempt,
           outcome.finished_at, workhorse.dashboard_task_result_v1(j.id) AS result,
           outcome.error AS outcome_error,
           progress.progress_value, progress.revision::text AS progress_revision,
           progress.attempt AS progress_attempt,
           progress.fence_token::text AS progress_fence_token,
           progress.worker_id AS progress_worker_id,
           progress.created_at AS progress_created_at,
           progress.updated_at AS progress_updated_at,
           signal_wait.deadline_at AS signal_wait_deadline_at
      FROM parameters
      JOIN workhorse.dashboard_task_v1 j ON j.id = parameters.task_id
      LEFT JOIN workhorse.dashboard_task_runtime_v1 runtime ON runtime.task_id = j.id
      LEFT JOIN workhorse.dashboard_task_outcome_v1 outcome ON outcome.task_id = j.id
      LEFT JOIN workhorse.dashboard_task_progress_v1 progress ON progress.task_id = j.id
      LEFT JOIN workhorse.dashboard_signal_wait_v1 signal_wait
        ON signal_wait.task_id = j.id AND signal_wait.signal_name = runtime.wait_name
  ), identity AS (
    SELECT jsonb_build_object(
      'id', task.id::text, 'queue', task.queue, 'type', task.type, 'priority', task.priority,
      'state', COALESCE(task.outcome_state, task.runtime_state, 'unknown'),
      'createdAt', workhorse.dashboard_iso_v1(task.created_at),
      'retryPolicy', task.retry_policy, 'maxAttempts', task.max_attempts,
      'deadlineAt', workhorse.dashboard_iso_v1(task.deadline_at),
      'executionTimeoutMs', task.execution_timeout_ms,
      'concurrencyKey', task.concurrency_key,
      'prerequisiteTaskId', CASE WHEN count(dependency.*) = 1
        THEN (array_agg(dependency.prerequisite_task_id))[1]::text END,
      'prerequisiteTaskIds', COALESCE(jsonb_agg(dependency.prerequisite_task_id::text
        ORDER BY dependency.prerequisite_task_id)
        FILTER (WHERE dependency.prerequisite_task_id IS NOT NULL), '[]'::jsonb),
      'dependencyPolicy', CASE WHEN count(dependency.*) > 0 THEN jsonb_build_object(
        'onSuccess', min(dependency.on_success),
        'onFailure', min(dependency.on_failure),
        'onCancellation', min(dependency.on_cancellation)) END,
      'dependencyReleasedAt', CASE WHEN bool_and(dependency.released_at IS NOT NULL)
        THEN workhorse.dashboard_iso_v1(max(dependency.released_at)) END,
      'blockedReason', CASE WHEN task.runtime_state = 'blocked' AND count(dependency.*) > 0
        THEN 'prerequisite_pending' END
    ) AS value
      FROM task
      LEFT JOIN workhorse.dashboard_task_dependency_v1 dependency
        ON dependency.dependent_task_id = task.id
     GROUP BY task.id, task.queue, task.type, task.priority, task.outcome_state, task.runtime_state,
              task.created_at, task.retry_policy, task.max_attempts, task.deadline_at,
              task.execution_timeout_ms, task.concurrency_key
  ), dependency_lineage AS (
    SELECT jsonb_build_object(
      'records', COALESCE(jsonb_agg(jsonb_build_object(
        'dependentTaskId', dependent_task_id::text,
        'prerequisiteTaskId', prerequisite_task_id::text,
        'onSuccess', on_success, 'onFailure', on_failure,
        'onCancellation', on_cancellation,
        'createdAt', workhorse.dashboard_iso_v1(created_at),
        'releasedAt', workhorse.dashboard_iso_v1(released_at), 'resolution', resolution
      ) ORDER BY dependent_task_id, prerequisite_task_id) FILTER (WHERE ordinal <= 100),
        '[]'::jsonb),
      'truncated', count(*) > 100
    ) AS value
      FROM (
        SELECT dependency.*, row_number() OVER (
          ORDER BY dependent_task_id, prerequisite_task_id) AS ordinal
          FROM parameters
          JOIN workhorse.dashboard_task_dependency_v1 dependency
            ON dependency.dependent_task_id = parameters.task_id
            OR dependency.prerequisite_task_id = parameters.task_id
         ORDER BY dependent_task_id, prerequisite_task_id LIMIT 101
      ) bounded
  ), child_lineage AS (
    SELECT jsonb_build_object(
      'records', COALESCE(jsonb_agg(jsonb_build_object(
        'parentTaskId', parent_task_id::text, 'childTaskId', child_task_id::text,
        'name', child_name, 'type', child_type,
        'createdAt', workhorse.dashboard_iso_v1(created_at),
        'joinedAt', workhorse.dashboard_iso_v1(joined_at),
        'outcomeState', outcome_state, 'error', outcome_error
      ) ORDER BY created_at, parent_task_id, child_task_id) FILTER (WHERE ordinal <= 101),
        '[]'::jsonb),
      'truncated', count(*) > 101
    ) AS value
      FROM (
        SELECT edge.*, child.task_type AS child_type, outcome.state AS outcome_state,
               outcome.error AS outcome_error,
               row_number() OVER (ORDER BY edge.created_at, edge.parent_task_id,
                                            edge.child_task_id) AS ordinal
          FROM parameters
          JOIN workhorse.dashboard_task_child_v1 edge
            ON edge.parent_task_id = parameters.task_id OR edge.child_task_id = parameters.task_id
          JOIN workhorse.dashboard_task_v1 child ON child.id = edge.child_task_id
          LEFT JOIN workhorse.dashboard_task_outcome_v1 outcome ON outcome.task_id = edge.child_task_id
         ORDER BY edge.created_at, edge.parent_task_id, edge.child_task_id LIMIT 102
      ) bounded
  ), redrive_lineage AS (
    SELECT jsonb_build_object(
      'records', COALESCE(jsonb_agg(jsonb_build_object(
        'sourceTaskId', source_task_id::text, 'targetTaskId', target_task_id::text,
        'requestedBy', requested_by, 'reason', reason,
        'requestIdPreview', request_id_preview, 'requestIdDigest', request_id_digest,
        'requestIdLength', request_id_length, 'sourceState', source_state,
        'targetInitialState', target_initial_state,
        'requestedAt', workhorse.dashboard_iso_v1(requested_at)
      ) ORDER BY ordinal) FILTER (WHERE ordinal <= 100), '[]'::jsonb),
      'truncated', count(*) > 100
    ) AS value
      FROM (
        SELECT lineage.*
          FROM parameters
          CROSS JOIN LATERAL workhorse.redrive_lineage_v1(parameters.task_id, 101)
            WITH ORDINALITY AS lineage(
              source_task_id, target_task_id, requested_by, reason, request_id_preview,
              request_id_digest, request_id_length, source_state, target_initial_state,
              requested_at, ordinal
            )
      ) bounded
  ), concurrency_policy AS (
    SELECT CASE WHEN policy.queue_name IS NULL THEN NULL ELSE jsonb_build_object(
      'namespace', policy.namespace, 'maxActive', policy.max_active,
      'utilizationKnown', measured.value IS NOT NULL,
      'active', COALESCE((measured.value->>'active')::integer, 0),
      'available', COALESCE(GREATEST(0, policy.max_active -
        (measured.value->>'active')::integer), 0),
      'blockedReady', COALESCE((measured.value->>'blocked_ready')::integer, 0),
      'maxActivePerKey', policy.max_active_per_key,
      'saturatedKeys', COALESCE((measured.value->>'saturated_keys')::integer, 0),
      'highestKeyActive', COALESCE((measured.value->>'highest_key_active')::integer, 0)
    ) END AS value
      FROM task
      LEFT JOIN workhorse.dashboard_concurrency_policy_v1 policy
        ON policy.queue_name = task.queue
      LEFT JOIN LATERAL (
        SELECT item AS value
          FROM jsonb_array_elements(CASE WHEN task.runtime_state IS NULL THEN '[]'::jsonb
            ELSE COALESCE(p_input->'health', workhorse.queue_health_v1())->'concurrency_policies'
            END) item
         WHERE item->>'queue_name' = task.queue
      ) measured ON true
  ), signal_wait AS (
    SELECT CASE WHEN wait_name IS NOT NULL AND signal_wait_deadline_at IS NOT NULL
      THEN jsonb_build_object('name', wait_name, 'deadlineAt',
        workhorse.dashboard_iso_v1(signal_wait_deadline_at)) END AS value FROM task
  ), progress AS (
    SELECT CASE WHEN progress_revision IS NOT NULL THEN jsonb_build_object(
      'value', progress_value, 'revision', progress_revision, 'attempt', progress_attempt,
      'fenceToken', progress_fence_token, 'workerId', progress_worker_id,
      'createdAt', workhorse.dashboard_iso_v1(progress_created_at),
      'updatedAt', workhorse.dashboard_iso_v1(progress_updated_at)) END AS value FROM task
  ), current_state AS (
    SELECT jsonb_build_object(
      'runtime', CASE WHEN runtime_state IS NOT NULL THEN jsonb_build_object(
        'state', runtime_state, 'attempt', runtime_attempt,
        'runAt', workhorse.dashboard_iso_v1(run_at),
        'readyAt', workhorse.dashboard_iso_v1(ready_at), 'workerId', worker_id,
        'fenceToken', fence_token, 'acquiredAt', workhorse.dashboard_iso_v1(acquired_at),
        'heartbeatAt', workhorse.dashboard_iso_v1(heartbeat_at),
        'expiresAt', workhorse.dashboard_iso_v1(expires_at), 'waitName', wait_name,
        'attemptStartedAt', workhorse.dashboard_iso_v1(attempt_started_at),
        'attemptTimeoutAt', workhorse.dashboard_iso_v1(attempt_timeout_at),
        'cancellation', CASE WHEN cancel_requested_at IS NOT NULL THEN jsonb_build_object(
          'requestedAt', workhorse.dashboard_iso_v1(cancel_requested_at),
          'requestedBy', NULLIF(cancel_requested_by, ''),
          'reason', NULLIF(cancel_reason, '')) END,
        'error', runtime_error) END,
      'outcome', CASE WHEN outcome_state IS NOT NULL THEN jsonb_build_object(
        'state', outcome_state, 'attempt', outcome_attempt,
        'finishedAt', workhorse.dashboard_iso_v1(finished_at),
        'result', result, 'error', outcome_error) END,
      -- The result appears under the outcome alone. A result exists only once a task finishes, so
      -- a second copy beside it doubled what a megabyte result costs to open and named no new fact.
      'error', COALESCE(outcome_error, runtime_error)
    ) AS value FROM task
  ), batch_executions AS (
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'id', batch_id, 'attempt', selected_attempt,
      'dispatchedAt', workhorse.dashboard_iso_v1(dispatched_at),
      'batchWideFailure', batch_wide_failure, 'members', members
    ) ORDER BY dispatched_at, batch_id), '[]'::jsonb) AS value
      FROM (
        SELECT batch_id, selected_attempt, dispatched_at, batch_wide_failure,
               jsonb_agg(jsonb_build_object(
                 'id', member_task_id, 'type', task_type, 'attempt', attempt,
                 'outcome', outcome, 'error', error) ORDER BY ordinal) AS members
          FROM (
            SELECT dispatch.details->>'batch_id' AS batch_id,
                   dispatch.attempt AS selected_attempt,
                   dispatch.occurred_at AS dispatched_at,
                   EXISTS (
                     SELECT 1 FROM workhorse.dashboard_task_event_v1 failure
                      WHERE failure.task_id = dispatch.task_id
                        AND failure.attempt = dispatch.attempt
                        AND failure.event_type = 'batch_failed'
                        AND failure.details->>'batch_id' = dispatch.details->>'batch_id'
                   ) AS batch_wide_failure,
                   member.ordinal, member.value->>'task_id' AS member_task_id,
                   COALESCE(member_task.task_type, selected_task.task_type) AS task_type,
                   (member.value->>'attempt')::integer AS attempt,
                   history.outcome, history.error
              FROM parameters
              JOIN workhorse.dashboard_task_event_v1 dispatch
                ON dispatch.task_id = parameters.task_id AND dispatch.event_type = 'batch_dispatched'
              CROSS JOIN LATERAL jsonb_array_elements(dispatch.details->'members')
                WITH ORDINALITY AS member(value, ordinal)
              JOIN workhorse.dashboard_task_v1 selected_task ON selected_task.id = dispatch.task_id
              LEFT JOIN workhorse.dashboard_task_v1 member_task
                ON member_task.id = (member.value->>'task_id')::uuid
              LEFT JOIN workhorse.dashboard_attempt_history_v1 history
                ON history.task_id = (member.value->>'task_id')::uuid
               AND history.attempt = (member.value->>'attempt')::integer
          ) batch_rows
         GROUP BY batch_id, selected_attempt, dispatched_at, batch_wide_failure
      ) executions
  -- Each history section keeps its most recent rows and reports that it was cut. A task that
  -- retried for days would otherwise put its whole recorded life into one drawer, and the event
  -- feed filtered by this task identity is where the rest of it stays readable.
  ), attempts AS (
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'attempt', attempt, 'workerId', worker_id, 'outcome', outcome,
      'startedAt', workhorse.dashboard_iso_v1(started_at),
      'claimedAt', workhorse.dashboard_iso_v1(claimed_at),
      'finishedAt', workhorse.dashboard_iso_v1(finished_at),
      'durationMs', extract(epoch FROM finished_at - claimed_at) * 1000,
      'executionMs', extract(epoch FROM finished_at - claimed_at) * 1000,
      'elapsedMs', extract(epoch FROM finished_at - started_at) * 1000,
      'error', error) ORDER BY attempt, attempt_id)
      FILTER (WHERE ordinal <= workhorse.dashboard_task_detail_limit_v1()), '[]'::jsonb) AS value,
      count(*) > workhorse.dashboard_task_detail_limit_v1() AS truncated
      FROM (
        SELECT recent.*, row_number() OVER (ORDER BY recent.attempt DESC, recent.attempt_id DESC)
                 AS ordinal
          FROM (
            SELECT history.* FROM parameters
              JOIN workhorse.dashboard_attempt_history_v1 history
                ON history.task_id = parameters.task_id
             ORDER BY history.attempt DESC, history.attempt_id DESC
             LIMIT workhorse.dashboard_task_detail_limit_v1() + 1
          ) recent
      ) bounded
  ), checkpoints AS (
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'name', checkpoint_name,
      'value', CASE WHEN value_bytes <= workhorse.dashboard_inline_value_bytes_v1()
                    THEN checkpoint_value END,
      'valueBytes', value_bytes,
      'valueOmitted', value_bytes > workhorse.dashboard_inline_value_bytes_v1(),
      'attempt', attempt,
      'fenceToken', fence_token::text, 'workerId', worker_id,
      'createdAt', workhorse.dashboard_iso_v1(created_at)
    ) ORDER BY created_at, checkpoint_name)
      FILTER (WHERE ordinal <= workhorse.dashboard_task_detail_limit_v1()), '[]'::jsonb) AS value,
      count(*) > workhorse.dashboard_task_detail_limit_v1() AS truncated
      FROM (
        SELECT recent.*,
               row_number() OVER (ORDER BY recent.created_at DESC, recent.checkpoint_name DESC)
                 AS ordinal
          FROM (
            SELECT checkpoint.*,
                   octet_length(checkpoint.checkpoint_value::text) AS value_bytes
              FROM parameters
              JOIN workhorse.dashboard_task_checkpoint_v1 checkpoint
                ON checkpoint.task_id = parameters.task_id
             ORDER BY checkpoint.created_at DESC, checkpoint.checkpoint_name DESC
             LIMIT workhorse.dashboard_task_detail_limit_v1() + 1
          ) recent
      ) bounded
  ), waits AS (
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'name', wait_name, 'mode', mode, 'durationMs', duration_ms,
      'requestedWakeAt', workhorse.dashboard_iso_v1(requested_wake_at),
      'wakeAt', workhorse.dashboard_iso_v1(wake_at), 'attempt', attempt,
      'fenceToken', fence_token::text, 'workerId', worker_id,
      'createdAt', workhorse.dashboard_iso_v1(created_at)
    ) ORDER BY created_at, wait_name)
      FILTER (WHERE ordinal <= workhorse.dashboard_task_detail_limit_v1()), '[]'::jsonb) AS value,
      count(*) > workhorse.dashboard_task_detail_limit_v1() AS truncated
      FROM (
        SELECT recent.*,
               row_number() OVER (ORDER BY recent.created_at DESC, recent.wait_name DESC) AS ordinal
          FROM (
            SELECT wait_record.* FROM parameters
              JOIN workhorse.dashboard_task_wait_v1 wait_record
                ON wait_record.task_id = parameters.task_id
             ORDER BY wait_record.created_at DESC, wait_record.wait_name DESC
             LIMIT workhorse.dashboard_task_detail_limit_v1() + 1
          ) recent
      ) bounded
  ), events AS (
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'id', event_id::text, 'attempt', attempt, 'type', event_type,
      'details', details, 'occurredAt', workhorse.dashboard_iso_v1(occurred_at)
    ) ORDER BY occurred_at, event_id)
      FILTER (WHERE ordinal <= workhorse.dashboard_task_event_limit_v1()), '[]'::jsonb) AS value,
      count(*) > workhorse.dashboard_task_event_limit_v1() AS truncated
      FROM (
        SELECT recent.*,
               row_number() OVER (ORDER BY recent.occurred_at DESC, recent.event_id DESC) AS ordinal
          FROM (
            SELECT event_record.* FROM parameters
              JOIN workhorse.dashboard_task_event_v1 event_record
                ON event_record.task_id = parameters.task_id
             ORDER BY event_record.occurred_at DESC, event_record.event_id DESC
             LIMIT workhorse.dashboard_task_event_limit_v1() + 1
          ) recent
      ) bounded
  )
  SELECT jsonb_build_object(
    'tags', task.tags,
    'canCompleteHumanWait', COALESCE((p_input->>'canCompleteHumanWait')::boolean, false),
    'humanWait', (SELECT jsonb_build_object(
      'name', wait.token_name, 'context', wait.context,
      'deadlineAt', workhorse.dashboard_iso_v1(wait.deadline_at))
      FROM workhorse.dashboard_human_wait_v1 wait WHERE wait.task_id = task.id),
    'identity', identity.value,
    'dependencyLineage', dependency_lineage.value,
    'childLineage', child_lineage.value,
    'redriveLineage', redrive_lineage.value,
    'concurrencyPolicy', concurrency_policy.value,
    'signalWait', signal_wait.value,
    'canSignal', parameters.can_signal,
    'payload', task.payload,
    'progress', progress.value,
    'durability', NULL,
    'current', current_state.value,
    'batchExecutions', batch_executions.value,
    'attempts', attempts.value,
    'checkpoints', checkpoints.value,
    'waits', waits.value,
    'events', events.value,
    'truncated', jsonb_build_object(
      'attempts', attempts.truncated, 'checkpoints', checkpoints.truncated,
      'waits', waits.truncated, 'events', events.truncated)
  )
    FROM parameters
    JOIN task ON true
    JOIN identity ON true
    JOIN dependency_lineage ON true
    JOIN child_lineage ON true
    JOIN redrive_lineage ON true
    JOIN concurrency_policy ON true
    JOIN signal_wait ON true
    JOIN progress ON true
    JOIN current_state ON true
    JOIN batch_executions ON true
    JOIN attempts ON true
    JOIN checkpoints ON true
    JOIN waits ON true
    JOIN events ON true;
$$;

CREATE OR REPLACE FUNCTION workhorse.dashboard_checkpoint_value_v1(p_input jsonb)
RETURNS jsonb
LANGUAGE sql
AS $$
  SELECT jsonb_build_object(
    'name', checkpoint.checkpoint_name,
    'value', checkpoint.checkpoint_value,
    'valueBytes', octet_length(checkpoint.checkpoint_value::text),
    'attempt', checkpoint.attempt,
    'fenceToken', checkpoint.fence_token::text,
    'workerId', checkpoint.worker_id,
    'createdAt', workhorse.dashboard_iso_v1(checkpoint.created_at))
    FROM workhorse.dashboard_task_checkpoint_v1 checkpoint
   WHERE checkpoint.task_id = (p_input->>'id')::uuid
     AND checkpoint.checkpoint_name = p_input->>'name';
$$;

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
           NULLIF($1->>'taskType', '') AS type_filter,
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
    SELECT r.task_id AS id, j.queue_name AS queue, j.task_type AS type, j.priority,
           r.state, r.current_attempt AS attempt, j.tags,
           r.worker_id AS current_worker_id, r.wait_name, r.updated_at
      FROM workhorse.dashboard_task_runtime_v1 r
      JOIN workhorse.dashboard_task_v1 j ON j.id = r.task_id
    UNION ALL
    SELECT o.task_id AS id, j.queue_name AS queue, j.task_type AS type, j.priority,
           o.state, o.current_attempt AS attempt, j.tags,
           NULL::text AS current_worker_id, NULL::text AS wait_name, o.updated_at
      FROM workhorse.dashboard_task_outcome_v1 o
      JOIN workhorse.dashboard_task_v1 j ON j.id = o.task_id
  ), filtered AS NOT MATERIALIZED (
    SELECT task_rows.* FROM task_rows CROSS JOIN parameters
     WHERE CASE parameters.filter
       WHEN 'blocked' THEN task_rows.state = 'blocked'
       WHEN 'waiting' THEN EXISTS (
         SELECT 1 FROM workhorse.dashboard_signal_wait_v1 signal_wait
          WHERE signal_wait.task_id = task_rows.id
         UNION ALL
         SELECT 1 FROM workhorse.dashboard_human_wait_v1 human_wait
          WHERE human_wait.task_id = task_rows.id
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
           SELECT wait.worker_id FROM workhorse.dashboard_task_wait_v1 wait
            WHERE wait.task_id = task_rows.id AND wait.wait_name = task_rows.wait_name
         ),
         (
           SELECT history.worker_id FROM workhorse.dashboard_attempt_history_v1 history
            WHERE history.task_id = task_rows.id
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
    SELECT j.id, j.queue_name AS queue, j.task_type AS type, page_ids.priority,
           COALESCE(r.state, o.state) AS state,
           CASE WHEN r.state = 'blocked' THEN 'prerequisite_pending' END AS blocked_reason,
           COALESCE((
             SELECT jsonb_agg(dependency.prerequisite_task_id::text
                              ORDER BY dependency.prerequisite_task_id)
               FROM workhorse.dashboard_task_dependency_v1 dependency
              WHERE dependency.dependent_task_id = j.id AND dependency.released_at IS NULL
           ), '[]'::jsonb) AS prerequisite_task_ids,
           COALESCE(r.current_attempt, o.current_attempt) AS attempt,
           j.max_attempts, j.retry_policy, j.tags,
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
      JOIN workhorse.dashboard_task_v1 j ON j.id = page_ids.id
      LEFT JOIN workhorse.dashboard_task_runtime_v1 r ON r.task_id = j.id
      LEFT JOIN workhorse.dashboard_task_outcome_v1 o ON o.task_id = j.id
      LEFT JOIN workhorse.dashboard_task_wait_v1 durable_wait
        ON durable_wait.task_id = j.id AND durable_wait.wait_name = r.wait_name
      LEFT JOIN workhorse.dashboard_signal_wait_v1 signal_wait
        ON signal_wait.task_id = j.id AND signal_wait.signal_name = r.wait_name
      LEFT JOIN workhorse.dashboard_human_wait_v1 human_wait
        ON human_wait.task_id = j.id AND human_wait.token_name = r.wait_name
      LEFT JOIN LATERAL (
        SELECT event.details FROM workhorse.dashboard_task_event_v1 event
         WHERE event.task_id = j.id AND event.event_type = 'enqueued'
         ORDER BY event.occurred_at, event.event_id LIMIT 1
      ) enqueued_event ON true
      LEFT JOIN LATERAL (
        SELECT history.worker_id FROM workhorse.dashboard_attempt_history_v1 history
         WHERE history.task_id = j.id ORDER BY history.attempt DESC LIMIT 1
      ) attempt_worker ON page_ids.worker_filter IS NOT NULL
  )
  SELECT jsonb_build_object(
    'capturedAt', workhorse.dashboard_iso_v1(clock_timestamp()),
    'canCompleteHumanWait', parameters.can_complete_human_wait,
    'filter', parameters.filter,
    'queue', parameters.queue_filter,
    'worker', parameters.worker_filter,
    'taskType', parameters.type_filter,
    'priority', parameters.priority_filter,
    'sort', parameters.sort,
    'tags', to_jsonb(parameters.tag_filter),
    'search', parameters.search,
    'page', parameters.page,
    'pageSize', parameters.page_size,
    'count', parameters.count_mode,
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
    'tasks', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', id::text, 'queue', queue, 'type', type, 'priority', priority, 'state', state,
        'blockedReason', blocked_reason, 'prerequisiteTaskIds', prerequisite_task_ids,
        'attempt', attempt, 'maxAttempts', max_attempts, 'retryPolicy', retry_policy, 'tags', tags,
        'keyed', COALESCE(jsonb_typeof(enqueued_details->'idempotency') = 'object', false),
        'enqueueMode', CASE
          WHEN jsonb_typeof(enqueued_details->'debounce') = 'object' THEN 'debounce'
          WHEN jsonb_typeof(enqueued_details->'throttle') = 'object' THEN 'throttle'
          WHEN jsonb_typeof(enqueued_details->'idempotency') = 'object' THEN 'idempotency'
          ELSE NULL END,
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
