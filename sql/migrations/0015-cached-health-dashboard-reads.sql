-- workhorse-migration: {"kind":"additive"}

-- Reuse cached health documents in dashboard reads and bound their remaining work (SM-796).

-- The runtime relation already owns priority. Exposing it lets the system read aggregate the
-- priority backlog without joining every ready row back to the larger task projection.
CREATE OR REPLACE VIEW workhorse.dashboard_task_runtime_v1 AS
  SELECT task_id, queue_name, state, current_attempt, fence_token, run_at, ready_at, worker_id,
         acquired_at, heartbeat_at, expires_at, attempt_timeout_at, wait_name, attempt_started_at,
         cancel_requested_at, cancel_requested_by, cancel_reason, error, updated_at, priority
    FROM workhorse.task_runtime;

-- These procedure bodies are large governed read documents. Rewrite only the measured internal
-- expressions so the migration preserves the byte-identical definitions shared with a clean
-- installation. Each guard makes drift fail the migration instead of silently leaving old work.
DO $migration$
DECLARE
  v_definition text;
  v_changed text;
BEGIN
  SELECT pg_get_functiondef('workhorse.dashboard_queues_v1(jsonb)'::regprocedure)
    INTO v_definition;
  v_changed := replace(v_definition,
    '  v_health := workhorse.queue_health_v1();',
    '  v_health := COALESCE(p_input->''health'', workhorse.queue_health_v1());');
  v_changed := replace(v_changed,
    '    WITH known_queues AS (
      SELECT queue_name FROM workhorse.dashboard_task_v1',
    '    WITH RECURSIVE task_queues(queue_name) AS (
      SELECT min(queue_name) FROM workhorse.dashboard_task_query_v1
      UNION ALL
      SELECT (
        SELECT min(query_row.queue_name)
          FROM workhorse.dashboard_task_query_v1 query_row
         WHERE query_row.queue_name > task_queues.queue_name
      ) FROM task_queues WHERE task_queues.queue_name IS NOT NULL
    ), known_queues AS (
      SELECT queue_name FROM task_queues WHERE queue_name IS NOT NULL');
  IF v_changed = v_definition THEN
    RAISE EXCEPTION 'dashboard_queues_v1 did not match the schema 14 definition';
  END IF;
  EXECUTE v_changed;

  SELECT pg_get_functiondef('workhorse.dashboard_settings_v1(jsonb)'::regprocedure)
    INTO v_definition;
  v_changed := replace(v_definition,
    '    SELECT workhorse.queue_health_v1() AS document',
    '    SELECT COALESCE(p_input->''health'', workhorse.queue_health_v1()) AS document');
  IF v_changed = v_definition THEN
    RAISE EXCEPTION 'dashboard_settings_v1 did not match the schema 14 definition';
  END IF;
  EXECUTE v_changed;

  SELECT pg_get_functiondef('workhorse.dashboard_system_v1(jsonb)'::regprocedure)
    INTO v_definition;
  v_changed := replace(v_definition,
    '  v_health := workhorse.queue_health_v1();',
    '  v_health := COALESCE(p_input->''health'', workhorse.queue_health_v1());');
  v_changed := replace(v_changed,
    '  ), priorities AS (
    SELECT runtime.queue_name, task.priority, count(*)::integer AS ready,',
    '  ), priorities AS MATERIALIZED (
    SELECT runtime.queue_name, runtime.priority, count(*)::integer AS ready,');
  v_changed := replace(v_changed,
    '      FROM workhorse.dashboard_task_runtime_v1 runtime
      JOIN workhorse.dashboard_task_v1 task ON task.id = runtime.task_id
     WHERE runtime.state = ''ready''
     GROUP BY runtime.queue_name, task.priority',
    '      FROM workhorse.dashboard_task_runtime_v1 runtime
     WHERE runtime.state = ''ready''
     GROUP BY runtime.queue_name, runtime.priority');
  IF v_changed = v_definition THEN
    RAISE EXCEPTION 'dashboard_system_v1 did not match the schema 14 definition';
  END IF;
  EXECUTE v_changed;
END;
$migration$;
