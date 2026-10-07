-- workhorse-migration: {"kind":"additive"}

-- Bound the dashboard's worker and task listings and count the schedules past its cap (SM-1171).

-- dashboard_tasks_v1 and dashboard_tasks_cursor_v1 returned each pending human decision with its
-- whole context, which can hold 64 KiB and is sent on every poll. A row now carries the quick
-- action's label from dashboard_human_wait_quick_action_v1, and the task detail keeps the context.
--
-- dashboard_workers_v1 compared history with clock_timestamp() in its predicate. The planner cannot
-- prune partitions or use the occurred_at key with a volatile bound, so every Workers poll read all
-- retained attempt history. The function now reads the cutoff once into a variable.
--
-- dashboard_cron_v1 returns the first 50 schedules. It now also returns scheduleCount, so the page
-- can say how many it did not show.
--
-- No change touches stored data.

-- The quick action a listed task offers for its pending human decision. An application opts in
-- through `dashboard.quickAction` in the decision's context, with a non-empty string `label` and a
-- `result`. A listing is polled and the context can hold 64 KiB, so a row carries the label alone.
-- The task detail carries the full context, and the dashboard reads the result from there.
CREATE OR REPLACE FUNCTION workhorse.dashboard_human_wait_quick_action_v1(p_context jsonb)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  -- The whitespace set is JavaScript's String.prototype.trim set, so a label this function
  -- offers is one the dashboard accepts when it reads the full context.
  SELECT CASE
    WHEN jsonb_typeof(p_context #> '{dashboard,quickAction,label}') = 'string'
     AND p_context #> '{dashboard,quickAction}' ? 'result'
     AND label.trimmed <> ''
    THEN jsonb_build_object('label', left(label.trimmed, 200))
  END
    FROM (
      SELECT regexp_replace(
        p_context #>> '{dashboard,quickAction,label}',
        E'^[\t\n\x0b\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+|[\t\n\x0b\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+$', '', 'g'
      ) AS trimmed
    ) label;
$$;

CREATE OR REPLACE FUNCTION workhorse.dashboard_tasks_v1(p_input jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SET jit = off
AS $$
DECLARE
  v_scope text := '';
  v_scope_from text := 'FROM workhorse.dashboard_task_v1 j';
  v_query text;
  v_result jsonb;
BEGIN
  IF cardinality(workhorse.dashboard_tag_filter_v1(p_input->'tags')) > 0 THEN
    v_scope := $scope$task_scope AS (
    SELECT j.id FROM workhorse.dashboard_task_v1 j
     WHERE j.tags && workhorse.dashboard_tag_filter_v1($1->'tags')
  ), $scope$;
  ELSIF NULLIF(p_input->>'queue', '') IS NOT NULL
     OR NULLIF(p_input->>'taskType', '') IS NOT NULL THEN
    v_scope := $scope$task_scope AS (
    SELECT query_row.task_id AS id FROM workhorse.dashboard_task_query_v1 query_row
     WHERE (NULLIF($1->>'queue', '') IS NULL
            OR query_row.queue_name = NULLIF($1->>'queue', ''))
       AND (NULLIF($1->>'taskType', '') IS NULL
            OR query_row.task_type = NULLIF($1->>'taskType', ''))
  ), $scope$;
  END IF;
  IF v_scope <> '' THEN
    v_scope_from := 'FROM task_scope
      JOIN workhorse.dashboard_task_v1 j ON j.id = task_scope.id';
  END IF;
  v_query := replace(replace($query$
  WITH parameters AS (
    SELECT COALESCE(NULLIF($1->>'filter', ''), 'all') AS filter,
           NULLIF($1->>'queue', '') AS queue_filter,
           NULLIF($1->>'worker', '') AS worker_filter,
           NULLIF($1->>'taskType', '') AS type_filter,
           NULLIF($1->>'priority', '')::integer AS priority_filter,
           workhorse.dashboard_tag_filter_v1($1->'tags') AS tag_filter,
           NULLIF($1->>'search', '') AS search,
           CASE WHEN NULLIF($1->>'search', '') IS NULL THEN NULL ELSE
             '%' || replace(replace(replace(replace(
               $1->>'search', '!', '!!'), '%', '!%'), '_', '!_'), '*', '%') || '%'
           END AS search_filter,
           COALESCE(NULLIF($1->>'page', '')::integer, 1) AS page,
           COALESCE(NULLIF($1->>'pageSize', '')::integer, 50) AS page_size,
           COALESCE(NULLIF($1->>'sort', ''), 'updated') AS sort,
           COALESCE(NULLIF($1->>'count', ''), 'none') AS count_mode,
           COALESCE(($1->>'canCompleteHumanWait')::boolean, false)
             AS can_complete_human_wait
  ), __task_scope__task_rows AS (
    SELECT j.id, j.queue_name AS queue, j.task_type AS type, j.priority,
           COALESCE(r.state, o.state) AS state,
           COALESCE(r.current_attempt, o.current_attempt) AS attempt,
           j.tags, r.worker_id AS current_worker_id, r.wait_name,
           COALESCE(r.updated_at, o.updated_at, j.created_at) AS updated_at
      __scope_from__
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
           AND event.occurred_at >= j.created_at
           AND event.occurred_at <= statement_timestamp()
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
          THEN jsonb_build_object('name', human_wait_name,
                                  'quickAction',
                                  workhorse.dashboard_human_wait_quick_action_v1(human_wait_context),
                                  'deadlineAt',
                                  workhorse.dashboard_iso_v1(human_wait_deadline_at)) END
      ) ORDER BY CASE WHEN parameters.sort = 'priority' THEN priority END DESC,
                 updated_at DESC, id DESC)
        FROM page CROSS JOIN parameters
    ), '[]'::jsonb)
  ) FROM parameters;
$query$, '__task_scope__', v_scope), '__scope_from__', v_scope_from);
  EXECUTE v_query INTO v_result USING p_input;
  RETURN v_result;
END;
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
  v_scope text := '';
  v_query text;
  v_result jsonb;
BEGIN
  -- Only fixed SQL fragments enter the query. Values stay in the bound JSON parameter.
  -- A custom plan can simplify absent filters and seek the terminal update-time index.
  -- A queue or task-type filter joins the routing projection so its index prunes before the
  -- ordering walk reads a task. Absent both, no join enters the query and the walk stays on the
  -- update-time indexes, which already return the page in order.
  IF NULLIF(p_input->>'queue', '') IS NOT NULL OR NULLIF(p_input->>'taskType', '') IS NOT NULL THEN
    v_scope := $scope$      JOIN (
        SELECT query_row.task_id FROM workhorse.dashboard_task_query_v1 query_row
         WHERE (NULLIF($1->>'queue', '') IS NULL
                OR query_row.queue_name = NULLIF($1->>'queue', ''))
           AND (NULLIF($1->>'taskType', '') IS NULL
                OR query_row.task_type = NULLIF($1->>'taskType', ''))
      ) task_scope ON task_scope.task_id = __scope_task__$scope$;
  END IF;
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
           workhorse.dashboard_tag_filter_v1($1->'tags') AS tag_filter,
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
__runtime_scope__
    UNION ALL
    SELECT o.task_id AS id, j.queue_name AS queue, j.task_type AS type, j.priority,
           o.state, o.current_attempt AS attempt, j.tags,
           NULL::text AS current_worker_id, NULL::text AS wait_name, o.updated_at
      FROM workhorse.dashboard_task_outcome_v1 o
      JOIN workhorse.dashboard_task_v1 j ON j.id = o.task_id
__outcome_scope__
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
           AND event.occurred_at >= j.created_at
           AND event.occurred_at <= statement_timestamp()
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
          THEN jsonb_build_object('name', human_wait_name,
                                  'quickAction',
                                  workhorse.dashboard_human_wait_quick_action_v1(human_wait_context),
                                  'deadlineAt',
                                  workhorse.dashboard_iso_v1(human_wait_deadline_at)) END
      ) ORDER BY CASE WHEN parameters.sort = 'priority' THEN priority END DESC,
                 updated_at DESC, id DESC)
        FROM page CROSS JOIN parameters
    ), '[]'::jsonb)
  ) FROM parameters;
$query$, '__cursor__', v_cursor), '__order__', v_order);
  v_query := replace(v_query, '__runtime_scope__', replace(v_scope, '__scope_task__', 'r.task_id'));
  v_query := replace(v_query, '__outcome_scope__', replace(v_scope, '__scope_task__', 'o.task_id'));
  EXECUTE v_query INTO v_result USING p_input;
  RETURN v_result;
END;
$$;


-- The recent-history cutoff is read once into a variable. In the predicate, clock_timestamp() is
-- volatile, so the planner can neither prune history partitions nor use the occurred_at key with
-- it, and the read scanned every retained partition. A variable reaches the planner as a value.
CREATE OR REPLACE FUNCTION workhorse.dashboard_workers_v1(p_input jsonb)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_captured_at timestamptz := clock_timestamp();
  v_since timestamptz := v_captured_at - interval '1 hour';
BEGIN
  RETURN (
    WITH configured_workers AS (
      SELECT jsonb_array_elements_text(
               CASE WHEN jsonb_typeof(p_input->'configuredWorkers') = 'array'
                    THEN p_input->'configuredWorkers' END
             ) AS id
    ), fleet AS (
      SELECT worker_id AS id FROM workhorse.dashboard_worker_registry_v1
      UNION SELECT id FROM configured_workers
    ), active AS (
      SELECT worker_id AS id, count(*)::integer AS active_tasks, max(acquired_at) AS last_seen_at
        FROM workhorse.dashboard_task_runtime_v1
       WHERE state = 'active' AND worker_id IN (SELECT id FROM fleet)
       GROUP BY worker_id
    ), recent_history AS (
      SELECT worker_id AS id, count(*)::integer AS completed_attempts,
             count(*) FILTER (WHERE outcome = 'failed')::integer AS failed_attempts,
             avg(extract(epoch FROM finished_at - claimed_at) * 1000)::double precision
               AS average_execution_ms,
             max(finished_at) AS last_seen_at
        FROM workhorse.dashboard_attempt_history_v1
       WHERE occurred_at >= v_since
         AND finished_at >= v_since
         AND worker_id IN (SELECT id FROM fleet)
       GROUP BY worker_id
    ), workers AS (
      SELECT fleet.id, registry.worker_id IS NOT NULL AS registered,
             registry.hostname, registry.pid, registry.queue_names, registry.schedule_namespaces,
             registry.concurrency,
             registry.active_slots, registry.draining, registry.paused, registry.started_at,
             registry.last_heartbeat_at, registry.sdk_language, registry.sdk_version,
             COALESCE(active.active_tasks, 0)::integer AS active_tasks,
             COALESCE(recent_history.completed_attempts, 0)::integer AS completed_attempts,
             COALESCE(recent_history.failed_attempts, 0)::integer AS failed_attempts,
             recent_history.average_execution_ms,
             GREATEST(active.last_seen_at, recent_history.last_seen_at,
                      registry.last_heartbeat_at) AS last_seen_at
        FROM fleet
        LEFT JOIN workhorse.dashboard_worker_registry_v1 registry
          ON registry.worker_id = fleet.id
        LEFT JOIN active ON active.id = fleet.id
        LEFT JOIN recent_history ON recent_history.id = fleet.id
    )
    SELECT jsonb_build_object(
      'capturedAt', workhorse.dashboard_iso_v1(v_captured_at),
      'canManageWorkers', COALESCE((p_input->>'canManageWorkers')::boolean, false),
      'workers', COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'id', id, 'queues', COALESCE(to_jsonb(queue_names), '[]'::jsonb),
          'scheduleNamespaces', COALESCE(to_jsonb(schedule_namespaces), '[]'::jsonb),
          'hostname', hostname, 'pid', pid, 'activeTasks', active_tasks,
          'concurrency', concurrency, 'activeSlots', active_slots,
          'draining', COALESCE(draining, false), 'completedAttempts', completed_attempts,
          'failedAttempts', failed_attempts, 'averageExecutionMs', average_execution_ms,
          'lastSeenAt', workhorse.dashboard_iso_v1(last_seen_at),
          'startedAt', workhorse.dashboard_iso_v1(started_at), 'registered', registered,
          'lastHeartbeatAt', workhorse.dashboard_iso_v1(last_heartbeat_at),
          'paused', COALESCE(paused, false),
          'sdkLanguage', sdk_language, 'sdkVersion', sdk_version
        ) ORDER BY id) FROM workers
      ), '[]'::jsonb))
  );
END;
$$;

CREATE OR REPLACE FUNCTION workhorse.dashboard_cron_v1(p_input jsonb)
RETURNS jsonb
LANGUAGE sql
AS $$
  WITH schedule_rows AS (
    SELECT definition.namespace, definition.schedule_name, definition.cron_expression,
           definition.queue_name, definition.task_type, definition.priority,
           definition.catchup_policy,
           definition.configured_enabled, definition.paused, definition.paused_by,
           definition.paused_reason, definition.paused_at,
           definition.revision, definition.updated_at,
           count(occurrence.occurrence_at)::integer AS occurrence_count,
           max(occurrence.fired_at) AS last_fired_at,
           (SELECT count(*)::integer
              FROM workhorse.dashboard_worker_registry_v1 registry
             WHERE definition.namespace = ANY(registry.schedule_namespaces)
               AND registry.last_heartbeat_at >= clock_timestamp() - interval '30 seconds')
             AS evaluator_count
      FROM workhorse.dashboard_schedule_definition_v1 definition
      LEFT JOIN workhorse.dashboard_schedule_occurrence_v1 occurrence
        ON occurrence.namespace = definition.namespace
       AND occurrence.schedule_name = definition.schedule_name
     GROUP BY definition.namespace, definition.schedule_name, definition.cron_expression,
              definition.queue_name, definition.task_type, definition.priority,
              definition.catchup_policy,
              definition.configured_enabled, definition.paused, definition.paused_by,
              definition.paused_reason, definition.paused_at,
              definition.revision, definition.updated_at
     ORDER BY definition.namespace, definition.schedule_name
     LIMIT 50
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
      'occurrenceCount', occurrence_count,
      'lastFiredAt', workhorse.dashboard_iso_v1(last_fired_at),
      'evaluatorCount', evaluator_count
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
        WHEN 'terminal_storage' THEN state.last_completed_at IS NULL
          OR state.last_completed_at <= clock_timestamp()
            - make_interval(secs => policy.terminal_cleanup_interval_ms / 1000.0)
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

