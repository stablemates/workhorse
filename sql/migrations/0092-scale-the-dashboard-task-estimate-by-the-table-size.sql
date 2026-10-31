-- workhorse-migration: {"kind":"additive"}

-- Scale the dashboard task estimate by the current size of the task table.
--
-- dashboard_task_estimate_v1 returned pg_class.reltuples of workhorse.task as stored. A bulk enqueue
-- after the last ANALYZE adds rows, but reltuples keeps the old count until autoanalyze runs. Thus
-- dashboard_task_counts_v1 and dashboard_queues_v1 saw a small estimate and took their exact
-- branches. The exact counts read joins every task row, so its cost grows with the table.
--
-- The estimate now scales the stored rows per page by the current number of pages, as the planner
-- does. If no stored density exists, it uses a density from the column widths, as the planner does.
-- Unlike the planner, it also uses the column widths when the stored row count is 0.
-- The function changes from STABLE to VOLATILE, because pg_relation_size can change inside one
-- statement. dashboard_task_counts_v1 changes only the comment above its threshold.
--
-- Each function keeps its name, its arguments, and its result type under ADR 0109. The migration
-- changes no stored rows, and the SDK floor does not change.

-- The number of task rows, estimated as the planner estimates a table. ANALYZE and VACUUM store
-- reltuples and relpages. A bulk insert after them adds pages but leaves both values. Thus the
-- estimate scales the stored rows per page by the current number of pages. If no stored density
-- exists, it divides the free page space by the row width. That is the case if reltuples is -1, if
-- relpages is 0, or if reltuples is 0. An ANALYZE after a DELETE of every task stores 0 rows on the
-- old pages, and a density of 0 would keep the estimate at 0 after a refill. The width of a column
-- is its average width from the last ANALYZE, or else the length of its type, with 32 bytes for a
-- variable-length type. The function is volatile, because the current number of pages can change
-- inside one statement.
CREATE OR REPLACE FUNCTION workhorse.dashboard_task_estimate_v1()
RETURNS TABLE (estimate bigint)
LANGUAGE sql
VOLATILE
PARALLEL SAFE
AS $$
  SELECT CASE
           WHEN size.pages = 0 THEN 0
           WHEN class.reltuples > 0 AND class.relpages > 0
             THEN round(class.reltuples::numeric / class.relpages * size.pages)::bigint
           ELSE size.pages * GREATEST(1, (size.block_size - 24) / (28 + (
             SELECT sum(COALESCE(
                      NULLIF(stats.avg_width, 0),
                      CASE WHEN attribute.attlen > 0 THEN attribute.attlen ELSE 32 END
                    ))::integer
               FROM pg_attribute attribute
               LEFT JOIN pg_stats stats
                 ON stats.schemaname = 'workhorse' AND stats.tablename = 'task'
                AND stats.attname = attribute.attname AND NOT stats.inherited
              WHERE attribute.attrelid = class.oid AND attribute.attnum > 0
                AND NOT attribute.attisdropped
           )))
         END
    FROM pg_class class
   CROSS JOIN LATERAL (
     SELECT current_setting('block_size')::integer AS block_size,
            pg_relation_size(class.oid) / current_setting('block_size')::integer AS pages
   ) size
   WHERE class.oid = 'workhorse.task'::regclass;
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
  -- The estimate follows the current size of task, so a bulk insert before ANALYZE still selects
  -- the estimate branch.
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
