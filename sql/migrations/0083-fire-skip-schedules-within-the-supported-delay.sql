-- workhorse-migration: {"kind":"additive"}

-- Fire `skip` schedules within the supported delay, and lock the namespace before the history read
-- (SM-1644, SM-1647).

-- One worker runs schedules with the default maintenance interval of 1 second. A pass evaluates the
-- schedules, and then other maintenance phases run. The worker waits one full interval after the
-- pass ends, so the next pass starts more than 1 second after the previous one. Before this step,
-- `skip` fired only occurrences newer than `now - evaluation_window_ms`. An occurrence in the extra
-- time never fired, and nothing recorded the miss.
--
-- After this step, `skip` continues from the durable position `last_evaluated_at`, as `latest` and
-- `all` do. It fires each occurrence that is not older than the supported delay,
-- GREATEST(60 seconds, 2 x evaluation_window_ms). It skips only older occurrences. The pass records
-- each skip on the definition row: `last_skipped_at` is the pass time, `last_skipped_count` is the
-- number of skipped occurrences (at most 10,000), and `last_skipped_through` is the newest skipped
-- occurrence.
--
-- Before this step, the pass read the newest occurrence of each definition with an aggregate over
-- all retained occurrence rows, before it tried the namespace lock. A pass that lost the lock read
-- that history for nothing. After this step, the pass tries every namespace lock first. It reads one
-- occurrence row for each definition in a namespace that it holds, through
-- schedule_occurrence_time_idx.
--
-- No signature changes. The new columns are null on existing rows. They carry no CHECK, so the
-- ALTER does not scan schedule_definition under its ACCESS EXCLUSIVE lock. fire_due_schedules_v2 is
-- the only writer, and it writes the three columns together.

ALTER TABLE workhorse.schedule_definition
  ADD COLUMN IF NOT EXISTS last_skipped_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_skipped_count integer,
  ADD COLUMN IF NOT EXISTS last_skipped_through timestamptz;

-- Fire the due occurrences of every enabled schedule in the offered namespaces. The pass takes the
-- namespace locks first, so a pass that loses a namespace reads none of its occurrence history
-- (SM-1647). Each definition then continues from its durable position. `skip` fires each occurrence
-- that is not older than the supported delay, GREATEST(60 s, 2 x evaluation window), and records
-- the older occurrences it skips on the definition row (SM-1644).
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
  v_namespace text;
  v_occurrence timestamptz;
  v_evaluation_start timestamptz;
  v_last_evaluated_at timestamptz;
  v_evaluated_count integer;
  v_deferred boolean;
  v_next_evaluated_at timestamptz;
  v_locked_namespaces text[] := '{}';
  v_skip_before timestamptz;
  v_skipped_count integer;
  v_skipped_through timestamptz;
BEGIN
  IF p_namespaces IS NULL OR array_position(p_namespaces, '') IS NOT NULL THEN
    RAISE EXCEPTION 'schedule namespaces must contain non-empty names';
  END IF;
  p_now := COALESCE(p_now, clock_timestamp());
  IF p_catchup_limit IS NULL OR p_catchup_limit NOT BETWEEN 1 AND 10000 THEN
    RAISE EXCEPTION 'schedule catch-up limit must be between 1 and 10000';
  END IF;
  IF p_evaluation_window_ms < 100 THEN
    RAISE EXCEPTION 'schedule evaluation window must be at least 100 milliseconds';
  END IF;
  -- The supported delay is the longest gap between two passes that `skip` still fires in full.
  -- A later occurrence is never older than it.
  v_skip_before := p_now - GREATEST(
    interval '60 seconds',
    make_interval(secs => p_evaluation_window_ms::double precision * 2 / 1000)
  );

  -- Try each namespace lock before any read of schedule_occurrence. A namespace that another pass
  -- holds costs this pass one lock attempt and no history read.
  FOR v_namespace IN
    SELECT DISTINCT definition.namespace
      FROM workhorse.schedule_definition definition
     WHERE definition.configured_enabled
       AND NOT definition.paused
       AND definition.namespace = ANY(p_namespaces)
     ORDER BY definition.namespace
  LOOP
    IF pg_try_advisory_xact_lock(hashtextextended(
      'workhorse:schedule-namespace:' || v_namespace,
      0
    )) THEN
      v_locked_namespaces := array_append(v_locked_namespaces, v_namespace);
    END IF;
  END LOOP;
  IF cardinality(v_locked_namespaces) = 0 THEN RETURN; END IF;

  FOR v_definition IN
    SELECT definition.namespace, definition.schedule_name, definition.cron_expression,
           definition.timezone, definition.revision, definition.catchup_policy,
           definition.last_evaluated_at,
           (
             SELECT occurrence.occurrence_at
               FROM workhorse.schedule_occurrence occurrence
              WHERE occurrence.namespace = definition.namespace
                AND occurrence.schedule_name = definition.schedule_name
              ORDER BY occurrence.occurrence_at DESC
              LIMIT 1
           ) AS last_occurrence_at
      FROM workhorse.schedule_definition definition
     WHERE definition.configured_enabled
       AND NOT definition.paused
       AND definition.namespace = ANY(v_locked_namespaces)
     ORDER BY definition.namespace, definition.schedule_name
  LOOP
    v_evaluation_start := GREATEST(
      v_definition.last_evaluated_at,
      v_definition.last_occurrence_at
    );
    v_skipped_count := 0;
    v_skipped_through := NULL;
    IF v_definition.catchup_policy = 'skip' AND v_evaluation_start < v_skip_before THEN
      -- Count the occurrences older than the supported delay, up to 10,000, and find the newest
      -- of them. The pass fires only the occurrences after it.
      SELECT count(*)::integer, max(skipped.occurrence_at)
        INTO v_skipped_count, v_skipped_through
        FROM workhorse.cron_occurrences_v1(
          v_definition.cron_expression,
          v_evaluation_start,
          v_skip_before - interval '1 microsecond',
          10000,
          v_definition.timezone
        ) skipped;
      IF v_skipped_count = 10000 THEN
        SELECT newest.occurrence_at INTO v_skipped_through
          FROM workhorse.cron_occurrences_v1(
            v_definition.cron_expression,
            NULL,
            v_skip_before - interval '1 microsecond',
            1,
            v_definition.timezone
          ) newest;
      END IF;
      IF v_skipped_count > 0 THEN
        v_evaluation_start := v_skipped_through;
      END IF;
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

    -- A `skip` or `all` pass that reaches the catch-up limit advances only through its last
    -- occurrence, so the next pass fires the rest.
    v_next_evaluated_at := CASE
      WHEN v_deferred THEN v_last_evaluated_at
      WHEN v_definition.catchup_policy IN ('skip', 'all')
        AND v_evaluated_count = p_catchup_limit
        AND v_last_evaluated_at IS NOT NULL
      THEN v_last_evaluated_at
      ELSE p_now
    END;
    -- A pass deferred before its first occurrence leaves the position and the skip record alone, so
    -- it never waits on the row lock the transaction holding that occurrence already owns. The next
    -- pass records the same skip.
    IF v_next_evaluated_at IS DISTINCT FROM v_definition.last_evaluated_at
      AND v_next_evaluated_at IS NOT NULL THEN
      UPDATE workhorse.schedule_definition definition
         SET last_evaluated_at = v_next_evaluated_at,
             last_skipped_at = CASE
               WHEN v_skipped_count > 0 THEN p_now ELSE definition.last_skipped_at
             END,
             last_skipped_count = CASE
               WHEN v_skipped_count > 0 THEN v_skipped_count ELSE definition.last_skipped_count
             END,
             last_skipped_through = CASE
               WHEN v_skipped_count > 0 THEN v_skipped_through
               ELSE definition.last_skipped_through
             END
       WHERE definition.namespace = v_definition.namespace
         AND definition.schedule_name = v_definition.schedule_name
         AND definition.revision = v_definition.revision;
    END IF;
  END LOOP;
END;
$$;
