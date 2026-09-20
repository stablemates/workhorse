-- workhorse-migration: {"kind":"additive"}

-- Schedule evaluation on the database clock, schema 19 (SM-815).
--
-- `fire_due_schedules_v2` advanced `last_evaluated_at` past every occurrence it looked at, including
-- one whose per-occurrence advisory lock another transaction held. `fire_schedule_v1` reports that
-- busy lock as a null task id, which is the same answer it gives for an occurrence already fired, so
-- a manual fire that rolled back left an occurrence nothing would ever enqueue. The pass now takes
-- the same lock itself before firing, stops at the first busy occurrence, and leaves the durable
-- position behind it.
--
-- The function also took the evaluation instant from the caller's clock. A worker whose clock ran
-- ahead fired occurrences early and moved `last_evaluated_at` forward; one that ran behind moved it
-- backwards. A null `p_now` now means `clock_timestamp()`, so budgets, rate limits, and schedules
-- all read one clock. Every SDK passes null.

CREATE OR REPLACE FUNCTION workhorse.fire_due_schedules_v2(
  p_namespaces text[],
  p_now timestamptz,
  p_catchup_limit integer,
  p_evaluation_window_ms bigint
) RETURNS TABLE(
  namespace text,
  schedule_name text,
  occurrence_at timestamptz,
  task_id uuid
)
LANGUAGE plpgsql
AS $$
DECLARE
  v_definition record;
  v_occurrence timestamptz;
  v_evaluation_start timestamptz;
  v_last_evaluated_at timestamptz;
  v_evaluated_count integer;
  v_deferred boolean;
  v_next_evaluated_at timestamptz;
  v_locked_namespaces text[] := '{}';
  v_skipped_namespaces text[] := '{}';
BEGIN
  IF p_namespaces IS NULL OR array_position(p_namespaces, '') IS NOT NULL THEN
    RAISE EXCEPTION 'schedule namespaces must contain non-empty names';
  END IF;
  p_now := COALESCE(p_now, clock_timestamp());
  IF p_catchup_limit NOT BETWEEN 1 AND 10000 THEN
    RAISE EXCEPTION 'schedule catch-up limit must be between 1 and 10000';
  END IF;
  IF p_evaluation_window_ms < 100 THEN
    RAISE EXCEPTION 'schedule evaluation window must be at least 100 milliseconds';
  END IF;

  FOR v_definition IN
    SELECT definition.namespace, definition.schedule_name, definition.cron_expression,
           definition.timezone, definition.revision, definition.catchup_policy,
           definition.last_evaluated_at,
           max(occurrence.occurrence_at) AS last_occurrence_at
      FROM workhorse.schedule_definition definition
      LEFT JOIN workhorse.schedule_occurrence occurrence
        ON occurrence.namespace = definition.namespace
       AND occurrence.schedule_name = definition.schedule_name
     WHERE definition.configured_enabled
       AND NOT definition.paused
       AND definition.namespace = ANY(p_namespaces)
     GROUP BY definition.namespace, definition.schedule_name, definition.cron_expression,
              definition.timezone, definition.revision, definition.catchup_policy,
              definition.last_evaluated_at
     ORDER BY definition.namespace, definition.schedule_name
  LOOP
    IF v_definition.namespace = ANY(v_skipped_namespaces) THEN CONTINUE; END IF;
    IF NOT v_definition.namespace = ANY(v_locked_namespaces) THEN
      IF pg_try_advisory_xact_lock(hashtextextended(
        'workhorse:schedule-namespace:' || v_definition.namespace,
        0
      )) THEN
        v_locked_namespaces := array_append(v_locked_namespaces, v_definition.namespace);
      ELSE
        v_skipped_namespaces := array_append(v_skipped_namespaces, v_definition.namespace);
        CONTINUE;
      END IF;
    END IF;

    v_evaluation_start := GREATEST(
      v_definition.last_evaluated_at,
      v_definition.last_occurrence_at
    );
    IF v_definition.catchup_policy = 'skip' THEN
      v_evaluation_start := GREATEST(
        v_evaluation_start,
        p_now - make_interval(secs => p_evaluation_window_ms::double precision / 1000)
      );
    END IF;
    v_evaluated_count := 0;
    v_last_evaluated_at := NULL;
    v_deferred := false;

    FOR v_occurrence IN
      SELECT evaluated.occurrence_at
        FROM workhorse.cron_occurrences_v1(
          v_definition.cron_expression,
          CASE WHEN v_definition.catchup_policy = 'latest'
            THEN NULL ELSE v_evaluation_start END,
          p_now,
          CASE WHEN v_definition.catchup_policy = 'latest'
            THEN 1 ELSE p_catchup_limit END,
          v_definition.timezone
        ) evaluated
       WHERE evaluated.occurrence_at > v_evaluation_start
    LOOP
      -- Another transaction holds this occurrence. It may still roll back, so this pass neither
      -- reports the occurrence nor evaluates anything after it, and the durable position below
      -- stays behind it. `fire_schedule_v1` takes the same lock again, which a transaction that
      -- already holds it always wins.
      IF NOT pg_try_advisory_xact_lock(hashtextextended(
        'workhorse:schedule:' || v_definition.namespace || ':' ||
        v_definition.schedule_name || ':' ||
        extract(epoch FROM date_trunc('second', v_occurrence))::bigint,
        0
      )) THEN
        v_deferred := true;
        EXIT;
      END IF;
      v_evaluated_count := v_evaluated_count + 1;
      v_last_evaluated_at := v_occurrence;
      namespace := v_definition.namespace;
      schedule_name := v_definition.schedule_name;
      occurrence_at := v_occurrence;
      task_id := workhorse.fire_schedule_v1(
        v_definition.namespace,
        v_definition.schedule_name,
        v_definition.revision,
        v_occurrence
      );
      RETURN NEXT;
    END LOOP;

    v_next_evaluated_at := CASE
      WHEN v_deferred THEN v_last_evaluated_at
      WHEN v_definition.catchup_policy = 'all'
        AND v_evaluated_count = p_catchup_limit
        AND v_last_evaluated_at IS NOT NULL
      THEN v_last_evaluated_at
      ELSE p_now
    END;
    -- A pass deferred before its first occurrence leaves the position alone, so it never waits on
    -- the row lock the transaction holding that occurrence already owns.
    IF v_next_evaluated_at IS DISTINCT FROM v_definition.last_evaluated_at
      AND v_next_evaluated_at IS NOT NULL THEN
      UPDATE workhorse.schedule_definition definition
         SET last_evaluated_at = v_next_evaluated_at
       WHERE definition.namespace = v_definition.namespace
         AND definition.schedule_name = v_definition.schedule_name
         AND definition.revision = v_definition.revision;
    END IF;
  END LOOP;
END;
$$;
