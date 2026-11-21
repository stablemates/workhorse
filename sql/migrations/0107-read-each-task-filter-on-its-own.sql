-- workhorse-migration: {"kind":"additive"}

-- Read the values of one task filter on its own, and read the workers of the fast tier once.
--
-- dashboard_task_facets_v1 found the workers of the attempt history with one index seek for each
-- distinct worker through dashboard_attempt_history_v1. That view also derives the attempts of the
-- fast tier from fast_task_runtime and fast_task_outcome, and no index there holds the worker.
-- Thus each seek read each fast-tier row, and expanded its errors, once for each worker. On
-- 200,000 fast-tier outcomes of 300 workers the read took 21 seconds, and the 15-second read bound
-- of the dashboard host ended it. The dashboard then showed no value in any task filter.
--
-- The seek now reads only attempt_history, which has an index on worker_id in each partition. The
-- fast tier is read once: the worker of each fast_task_runtime and fast_task_outcome row, and the
-- worker of each earlier attempt that their errors record. The list keeps each worker that it
-- gave before. The 1,000-value bound now applies to the full-tier history only. On the data above
-- the read takes 0.14 seconds, and its cost grows with the number of fast-tier rows, not with that
-- number times the number of workers.
--
-- The input gets the optional key facet: queues, workers, taskTypes, or tags. With it, the
-- function reads only that list and returns an empty array for each other list, so each filter of
-- the Tasks page loads on its own. Without it, the function returns all four lists as before. A
-- schema at version 105 or earlier ignores the key and returns all four lists, which a caller
-- also accepts. The output shape does not change, so the function keeps its suffix (ADR 0109).
-- No stored data changes.

CREATE OR REPLACE FUNCTION workhorse.dashboard_task_facets_v1(p_input jsonb)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_facet text := NULLIF(p_input->>'facet', '');
  v_queues jsonb := '[]'::jsonb;
  v_workers jsonb := '[]'::jsonb;
  v_task_types jsonb := '[]'::jsonb;
  v_tags jsonb := '[]'::jsonb;
BEGIN
  IF v_facet IS NULL OR v_facet = 'queues' THEN
    WITH RECURSIVE queue_scan AS (
      SELECT (SELECT min(queue_name) FROM workhorse.dashboard_task_query_v1) AS value
      UNION ALL
      SELECT (SELECT min(query_row.queue_name) FROM workhorse.dashboard_task_query_v1 query_row
               WHERE query_row.queue_name > queue_scan.value)
        FROM queue_scan WHERE queue_scan.value IS NOT NULL
    ), queue_values AS (
      (SELECT value FROM queue_scan WHERE value IS NOT NULL LIMIT 1000)
      UNION SELECT queue_name FROM workhorse.dashboard_queue_control_v1
    )
    SELECT COALESCE(jsonb_agg(value ORDER BY value), '[]'::jsonb) INTO v_queues
      FROM queue_values WHERE value IS NOT NULL;
  END IF;

  IF v_facet IS NULL OR v_facet = 'workers' THEN
    -- attempt_history has an index on worker_id in each partition, so the scan costs one index
    -- seek for each distinct worker. The fast tier keeps no such index, and a seek for each worker
    -- through dashboard_attempt_history_v1 read each fast-tier row once for each worker. The fast
    -- tier is thus read once: the worker of each runtime and outcome row, and the worker of each
    -- earlier attempt that its errors record. The list keeps each worker that the view gave.
    WITH RECURSIVE configured_workers AS (
      SELECT jsonb_array_elements_text(
               CASE WHEN jsonb_typeof(p_input->'configuredWorkers') = 'array'
                    THEN p_input->'configuredWorkers' END
             ) AS worker
    ), history_worker_scan AS (
      SELECT (SELECT min(worker_id) FROM workhorse.attempt_history) AS value
      UNION ALL
      SELECT (SELECT min(history.worker_id) FROM workhorse.attempt_history history
               WHERE history.worker_id > history_worker_scan.value)
        FROM history_worker_scan WHERE history_worker_scan.value IS NOT NULL
    ), fast_rows AS MATERIALIZED (
      SELECT worker_id, errors FROM workhorse.fast_task_runtime
      UNION ALL
      SELECT worker_id, errors FROM workhorse.fast_task_outcome
    ), worker_values AS (
      SELECT worker AS value FROM configured_workers
      UNION SELECT worker_id FROM workhorse.dashboard_worker_registry_v1
      UNION SELECT worker_id FROM workhorse.task_runtime WHERE worker_id IS NOT NULL
      UNION (SELECT value FROM history_worker_scan WHERE value IS NOT NULL LIMIT 1000)
      UNION SELECT worker_id FROM fast_rows WHERE worker_id IS NOT NULL
      UNION SELECT entry->>'worker_id'
              FROM fast_rows CROSS JOIN LATERAL jsonb_array_elements(fast_rows.errors) AS entry
             WHERE fast_rows.errors <> '[]'::jsonb AND jsonb_typeof(entry) = 'object'
    )
    SELECT COALESCE(jsonb_agg(value ORDER BY value), '[]'::jsonb) INTO v_workers
      FROM worker_values WHERE value IS NOT NULL;
  END IF;

  IF v_facet IS NULL OR v_facet = 'taskTypes' THEN
    WITH RECURSIVE type_scan AS (
      SELECT (SELECT min(task_type) FROM workhorse.dashboard_task_query_v1) AS value
      UNION ALL
      SELECT (SELECT min(query_row.task_type) FROM workhorse.dashboard_task_query_v1 query_row
               WHERE query_row.task_type > type_scan.value)
        FROM type_scan WHERE type_scan.value IS NOT NULL
    )
    SELECT COALESCE(jsonb_agg(value ORDER BY value), '[]'::jsonb) INTO v_task_types
      FROM (SELECT value FROM type_scan WHERE value IS NOT NULL LIMIT 1000) type_values;
  END IF;

  IF v_facet IS NULL OR v_facet = 'tags' THEN
    WITH tag_tasks AS MATERIALIZED (
      SELECT tags FROM workhorse.dashboard_task_v1
       ORDER BY created_at DESC, id DESC
       LIMIT 10000
    ), tag_values AS (
      SELECT DISTINCT tag.value
        FROM tag_tasks
        CROSS JOIN LATERAL unnest(tag_tasks.tags) AS tag(value)
       LIMIT 1000
    )
    SELECT COALESCE(jsonb_agg(value ORDER BY value), '[]'::jsonb) INTO v_tags FROM tag_values;
  END IF;

  RETURN jsonb_build_object(
    'queues', v_queues, 'workers', v_workers, 'taskTypes', v_task_types, 'tags', v_tags);
END;
$$;
