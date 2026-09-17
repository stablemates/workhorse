-- workhorse-migration: {"kind":"additive"}

-- Composed task-list scope (SM-783).

-- SM-757 gave `dashboard_tasks_v1` a `task_scope` CTE with three branches, so a request naming a
-- tag, a queue, or a task type prunes on an index before the runtime and outcome joins read a row.
-- A request naming none of the three took the third branch, which selects every task id and joins
-- it back to the same projection. PostgreSQL cannot eliminate that self-join: at 200,000 tasks it
-- hashed the whole table against itself and spilled to temp files, on the first page an operator
-- opens.

-- The procedure is now PL/pgSQL and composes its scope, the way `dashboard_tasks_cursor_v1`
-- already does. A tag filter emits the branch that seeks `task_tags_gin_idx`, a queue or task-type
-- filter emits the branch that seeks the routing projection's index, and a request that names none
-- of them emits no scope at all, so the projection is read once as it was before SM-757. Only
-- fixed SQL fragments enter the query; values stay in the bound JSON parameter.

-- The wire document is unchanged.

-- Which tasks a request can reach, named before the runtime and outcome joins read a row. A tag
-- filter seeks `task_tags_gin_idx`, and a queue or task-type filter seeks the routing projection's
-- index. A request that names none of the three reaches every task, and composing the scope here
-- rather than branching on it in SQL means such a request carries no scope at all: the projection
-- is read once, as it was before SM-757, instead of joining every task id back to itself. Only
-- fixed SQL fragments enter the query; values stay in the bound JSON parameter, so the planner
-- still sees each filter as a value it can seek. The scope chooses which index drives and nothing
-- more, so `filtered` below applies every predicate and a request naming both a tag and a queue
-- seeks the tag index and filters on the queue rather than losing either one (SM-783).
CREATE OR REPLACE FUNCTION workhorse.dashboard_tasks_v1(p_input jsonb)
RETURNS jsonb
LANGUAGE plpgsql
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
$query$, '__task_scope__', v_scope), '__scope_from__', v_scope_from);
  EXECUTE v_query INTO v_result USING p_input;
  RETURN v_result;
END;
$$;
