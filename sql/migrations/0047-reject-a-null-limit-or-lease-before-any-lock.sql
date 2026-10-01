-- workhorse-migration: {"kind":"additive"}

-- Reject a NULL limit or lease before any lock (SM-1002).

-- Schema version 45 validated these arguments with `IF p_limit NOT BETWEEN ...`. That condition is
-- NULL for a NULL argument, so the check passed. A NULL limit then reached `LIMIT`, which
-- PostgreSQL reads as no limit: a raw claim_many_v1 call with a NULL limit leased every claimable
-- task in the queue. A NULL lease reached the expiry arithmetic after the claim had locked rows,
-- and only the runtime state-shape constraint stopped it.
--
-- Each function below now rejects a NULL limit, lease, catch-up limit, or bucket count with the
-- error a value outside its range already raised. complete_many_and_claim_v1 already did so.
-- Arguments that are intentionally nullable keep their behavior.

CREATE OR REPLACE FUNCTION workhorse.redrive_lineage_v1(
  p_task_id uuid,
  p_limit integer
) RETURNS TABLE (
  source_task_id uuid,
  target_task_id uuid,
  requested_by text,
  reason text,
  request_id_preview text,
  request_id_digest text,
  request_id_length integer,
  source_state text,
  target_initial_state text,
  requested_at timestamptz
)
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v_frontier uuid[] := ARRAY[p_task_id];
  v_seen_nodes uuid[] := ARRAY[p_task_id];
  v_seen_edges uuid[] := '{}'::uuid[];
  v_node uuid;
  v_neighbor uuid;
  v_edge record;
  v_count integer := 0;
BEGIN
  IF p_task_id IS NULL THEN RAISE EXCEPTION 'lineage task identity is required'; END IF;
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 1001 THEN
    RAISE EXCEPTION 'redrive lineage limit must be between 1 and 1001';
  END IF;

  WHILE cardinality(v_frontier) > 0 AND v_count < p_limit LOOP
    v_node := v_frontier[1];
    v_frontier := COALESCE(v_frontier[2:cardinality(v_frontier)], '{}'::uuid[]);
    FOR v_edge IN
      SELECT edge.*
        FROM workhorse.task_redrive edge
       WHERE (edge.source_task_id = v_node OR edge.target_task_id = v_node)
         AND NOT edge.target_task_id = ANY(v_seen_edges)
       ORDER BY edge.requested_at, edge.source_task_id, edge.target_task_id
       LIMIT p_limit - v_count
    LOOP
      v_seen_edges := array_append(v_seen_edges, v_edge.target_task_id);
      v_count := v_count + 1;
      v_neighbor := CASE WHEN v_edge.source_task_id = v_node
        THEN v_edge.target_task_id ELSE v_edge.source_task_id END;
      IF NOT v_neighbor = ANY(v_seen_nodes) THEN
        v_seen_nodes := array_append(v_seen_nodes, v_neighbor);
        v_frontier := array_append(v_frontier, v_neighbor);
      END IF;
    END LOOP;
  END LOOP;

  RETURN QUERY
    SELECT edge.source_task_id, edge.target_task_id, edge.requested_by, edge.reason,
           edge.request_id_preview, edge.request_id_digest, edge.request_id_length,
           edge.source_state, edge.target_initial_state, edge.requested_at
      FROM workhorse.task_redrive edge
     WHERE edge.target_task_id = ANY(v_seen_edges)
     ORDER BY array_position(v_seen_edges, edge.target_task_id);
END;
$$;

CREATE OR REPLACE FUNCTION workhorse.cron_occurrences_v1(
  p_expression text,
  p_last_occurrence_at timestamptz,
  p_now timestamptz,
  p_limit integer,
  p_timezone text
) RETURNS TABLE(occurrence_at timestamptz)
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
AS $$
DECLARE
  v_expression text := workhorse.expand_cron_macro_v1(p_expression);
  v_fields text[] := regexp_split_to_array(v_expression, '\s+');
  v_field_count integer;
  v_seconds integer[];
  v_minutes integer[];
  v_hours integer[];
  v_months integer[];
  v_dom_field text;
  v_dow_field text;
  v_dom_tokens text[] := '{}';
  v_dow_tokens text[] := '{}';
  v_dom_values integer[] := '{}';
  v_dow_values integer[] := '{}';
  v_last_weekdays integer[] := '{}';
  v_nth_weekdays text[] := '{}';
  v_token text;
  v_match text[];
  v_dom_wildcard boolean := false;
  v_dom_last boolean := false;
  v_dow_wildcard boolean := false;
  v_date date;
  v_day_offset integer;
  v_start_date date;
  v_end_date date;
  v_day_of_month integer;
  v_day_of_week integer;
  v_dom_match boolean;
  v_dow_match boolean;
  v_day_match boolean;
  v_hour integer;
  v_minute integer;
  v_second integer;
  v_wall timestamp;
  v_occurrence timestamptz;
  v_seen_occurrences timestamptz[] := '{}';
  v_returned integer := 0;
  v_hour_index integer;
  v_minute_index integer;
  v_second_index integer;
  v_weekday integer;
  v_ordinal integer;
BEGIN
  IF COALESCE(btrim(p_expression), '') = '' THEN RAISE EXCEPTION 'cron expression must not be empty'; END IF;
  IF p_now IS NULL THEN RAISE EXCEPTION 'cron evaluation time is required'; END IF;
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 10000 THEN RAISE EXCEPTION 'cron catch-up limit must be between 1 and 10000'; END IF;
  IF COALESCE(p_timezone, '') = '' THEN RAISE EXCEPTION 'schedule timezone must not be empty'; END IF;
  -- Force PostgreSQL to validate the IANA name even when no occurrence is returned.
  PERFORM p_now AT TIME ZONE p_timezone;

  v_field_count := array_length(v_fields, 1);
  IF v_field_count NOT IN (5, 6) THEN
    RAISE EXCEPTION 'invalid cron expression %', p_expression;
  END IF;
  FOR v_ordinal IN 1..v_field_count LOOP
    v_fields[v_ordinal] := workhorse.expand_hashed_cron_field_v1(
      v_fields[v_ordinal], p_expression, v_ordinal - 1,
      CASE
        WHEN v_field_count = 6 AND v_ordinal IN (1, 2, 3, 6) THEN 0
        WHEN v_field_count = 6 THEN 1
        WHEN v_ordinal IN (1, 2, 5) THEN 0
        ELSE 1
      END,
      CASE
        WHEN v_field_count = 6 AND v_ordinal IN (1, 2) THEN 59
        WHEN v_field_count = 6 AND v_ordinal = 3 THEN 23
        WHEN v_field_count = 6 AND v_ordinal = 4 THEN 31
        WHEN v_field_count = 6 AND v_ordinal = 5 THEN 12
        WHEN v_field_count = 6 AND v_ordinal = 6 THEN 6
        WHEN v_field_count = 5 AND v_ordinal = 1 THEN 59
        WHEN v_field_count = 5 AND v_ordinal = 2 THEN 23
        WHEN v_field_count = 5 AND v_ordinal = 3 THEN 31
        WHEN v_field_count = 5 AND v_ordinal = 4 THEN 12
        ELSE 6
      END
    );
  END LOOP;

  IF v_field_count = 6 THEN
    v_seconds := workhorse.cron_field_values_v1(v_fields[1], 0, 59);
    v_minutes := workhorse.cron_field_values_v1(v_fields[2], 0, 59);
    v_hours := workhorse.cron_field_values_v1(v_fields[3], 0, 23);
    v_dom_field := v_fields[4];
    v_months := workhorse.cron_field_values_v1(v_fields[5], 1, 12,
      ARRAY['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC']);
    v_dow_field := v_fields[6];
  ELSE
    v_seconds := ARRAY[0];
    v_minutes := workhorse.cron_field_values_v1(v_fields[1], 0, 59);
    v_hours := workhorse.cron_field_values_v1(v_fields[2], 0, 23);
    v_dom_field := v_fields[3];
    v_months := workhorse.cron_field_values_v1(v_fields[4], 1, 12,
      ARRAY['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC']);
    v_dow_field := v_fields[5];
  END IF;

  v_dom_wildcard := v_dom_field IN ('*', '?');
  FOREACH v_token IN ARRAY string_to_array(v_dom_field, ',') LOOP
    IF upper(v_token) = 'L' THEN v_dom_last := true; CONTINUE; END IF;
    IF v_token = '?' THEN
      IF array_length(string_to_array(v_dom_field, ','), 1) <> 1 THEN RAISE EXCEPTION '? must occupy a cron field'; END IF;
      CONTINUE;
    END IF;
    v_dom_tokens := array_append(v_dom_tokens, v_token);
  END LOOP;
  IF array_length(v_dom_tokens, 1) IS NOT NULL THEN
    v_dom_values := workhorse.cron_field_values_v1(array_to_string(v_dom_tokens, ','), 1, 31);
  END IF;

  v_dow_wildcard := v_dow_field IN ('*', '?');
  FOREACH v_token IN ARRAY string_to_array(v_dow_field, ',') LOOP
    IF v_token = '?' THEN
      IF array_length(string_to_array(v_dow_field, ','), 1) <> 1 THEN RAISE EXCEPTION '? must occupy a cron field'; END IF;
      CONTINUE;
    END IF;
    v_match := regexp_match(upper(v_token), '^(SUN|MON|TUE|WED|THU|FRI|SAT|[0-7])L$');
    IF v_match IS NOT NULL THEN
      v_weekday := CASE v_match[1]
        WHEN 'SUN' THEN 0 WHEN 'MON' THEN 1 WHEN 'TUE' THEN 2 WHEN 'WED' THEN 3
        WHEN 'THU' THEN 4 WHEN 'FRI' THEN 5 WHEN 'SAT' THEN 6 ELSE v_match[1]::integer % 7 END;
      v_last_weekdays := array_append(v_last_weekdays, v_weekday);
      CONTINUE;
    END IF;
    v_match := regexp_match(upper(v_token), '^(SUN|MON|TUE|WED|THU|FRI|SAT|[0-7])#([1-5])$');
    IF v_match IS NOT NULL THEN
      v_weekday := CASE v_match[1]
        WHEN 'SUN' THEN 0 WHEN 'MON' THEN 1 WHEN 'TUE' THEN 2 WHEN 'WED' THEN 3
        WHEN 'THU' THEN 4 WHEN 'FRI' THEN 5 WHEN 'SAT' THEN 6 ELSE v_match[1]::integer % 7 END;
      v_nth_weekdays := array_append(v_nth_weekdays, v_weekday::text || ':' || v_match[2]);
      CONTINUE;
    END IF;
    v_dow_tokens := array_append(v_dow_tokens, v_token);
  END LOOP;
  IF array_length(v_dow_tokens, 1) IS NOT NULL THEN
    v_dow_values := workhorse.cron_field_values_v1(array_to_string(v_dow_tokens, ','), 0, 6,
      ARRAY['SUN','MON','TUE','WED','THU','FRI','SAT'], true);
  END IF;

  v_end_date := (p_now AT TIME ZONE p_timezone)::date;
  IF p_last_occurrence_at IS NULL THEN
    v_start_date := (v_end_date - interval '128 years')::date;
    FOR v_day_offset IN 0..(v_end_date - v_start_date) LOOP
      v_date := v_end_date - v_day_offset;
      IF NOT extract(month FROM v_date)::integer = ANY(v_months) THEN CONTINUE; END IF;
      v_day_of_month := extract(day FROM v_date)::integer;
      v_day_of_week := extract(dow FROM v_date)::integer;
      v_dom_match := v_day_of_month = ANY(v_dom_values)
        OR (v_dom_last AND extract(month FROM v_date + 1) <> extract(month FROM v_date));
      v_dow_match := v_day_of_week = ANY(v_dow_values)
        OR (v_day_of_week = ANY(v_last_weekdays) AND extract(month FROM v_date + 7) <> extract(month FROM v_date));
      FOREACH v_token IN ARRAY v_nth_weekdays LOOP
        v_weekday := split_part(v_token, ':', 1)::integer;
        v_ordinal := split_part(v_token, ':', 2)::integer;
        v_dow_match := v_dow_match OR (
          v_day_of_week = v_weekday AND ((v_day_of_month - 1) / 7 + 1) = v_ordinal
        );
      END LOOP;
      v_day_match := CASE WHEN v_dom_wildcard THEN v_dow_match
        WHEN v_dow_wildcard THEN v_dom_match ELSE v_dom_match OR v_dow_match END;
      IF NOT v_day_match THEN CONTINUE; END IF;
      FOR v_hour_index IN REVERSE array_upper(v_hours, 1)..array_lower(v_hours, 1) LOOP
        v_hour := v_hours[v_hour_index];
        FOR v_minute_index IN REVERSE array_upper(v_minutes, 1)..array_lower(v_minutes, 1) LOOP
          v_minute := v_minutes[v_minute_index];
          FOR v_second_index IN REVERSE array_upper(v_seconds, 1)..array_lower(v_seconds, 1) LOOP
            v_second := v_seconds[v_second_index];
            v_wall := v_date + make_interval(hours => v_hour, mins => v_minute, secs => v_second);
            v_occurrence := workhorse.resolve_cron_wall_clock_v1(v_wall, p_timezone);
            IF v_occurrence <= date_trunc('second', p_now) THEN
              occurrence_at := v_occurrence;
              RETURN NEXT;
              RETURN;
            END IF;
          END LOOP;
        END LOOP;
      END LOOP;
    END LOOP;
    RAISE EXCEPTION 'cron occurrence search exceeded the 128-year horizon';
  END IF;

  v_start_date := GREATEST(
    (p_last_occurrence_at AT TIME ZONE p_timezone)::date,
    (v_end_date - interval '128 years')::date
  );
  FOR v_day_offset IN 0..(v_end_date - v_start_date) LOOP
    v_date := v_start_date + v_day_offset;
    IF NOT extract(month FROM v_date)::integer = ANY(v_months) THEN CONTINUE; END IF;
    v_day_of_month := extract(day FROM v_date)::integer;
    v_day_of_week := extract(dow FROM v_date)::integer;
    v_dom_match := v_day_of_month = ANY(v_dom_values)
      OR (v_dom_last AND extract(month FROM v_date + 1) <> extract(month FROM v_date));
    v_dow_match := v_day_of_week = ANY(v_dow_values)
      OR (v_day_of_week = ANY(v_last_weekdays) AND extract(month FROM v_date + 7) <> extract(month FROM v_date));
    FOREACH v_token IN ARRAY v_nth_weekdays LOOP
      v_weekday := split_part(v_token, ':', 1)::integer;
      v_ordinal := split_part(v_token, ':', 2)::integer;
      v_dow_match := v_dow_match OR (
        v_day_of_week = v_weekday AND ((v_day_of_month - 1) / 7 + 1) = v_ordinal
      );
    END LOOP;
    v_day_match := CASE WHEN v_dom_wildcard THEN v_dow_match
      WHEN v_dow_wildcard THEN v_dom_match ELSE v_dom_match OR v_dow_match END;
    IF NOT v_day_match THEN CONTINUE; END IF;
    FOREACH v_hour IN ARRAY v_hours LOOP
      FOREACH v_minute IN ARRAY v_minutes LOOP
        FOREACH v_second IN ARRAY v_seconds LOOP
          v_wall := v_date + make_interval(hours => v_hour, mins => v_minute, secs => v_second);
          v_occurrence := workhorse.resolve_cron_wall_clock_v1(v_wall, p_timezone);
          IF v_occurrence > p_last_occurrence_at
             AND v_occurrence <= date_trunc('second', p_now)
             AND NOT v_occurrence = ANY(v_seen_occurrences) THEN
            occurrence_at := v_occurrence;
            v_seen_occurrences := array_append(v_seen_occurrences, v_occurrence);
            RETURN NEXT;
            v_returned := v_returned + 1;
            IF v_returned >= p_limit THEN RETURN; END IF;
          END IF;
        END LOOP;
      END LOOP;
    END LOOP;
  END LOOP;
END;
$$;

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
  IF p_catchup_limit IS NULL OR p_catchup_limit NOT BETWEEN 1 AND 10000 THEN
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

CREATE OR REPLACE FUNCTION workhorse.prune_schedule_occurrences_v1(
  p_before timestamptz, p_limit integer DEFAULT 10000
) RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  v_count integer;
BEGIN
  IF p_before IS NULL THEN RAISE EXCEPTION 'occurrence retention cutoff is required'; END IF;
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 1000000 THEN
    RAISE EXCEPTION 'occurrence prune limit must be between 1 and 1000000';
  END IF;

  WITH victims AS MATERIALIZED (
    SELECT occurrence.ctid
      FROM workhorse.schedule_occurrence occurrence
     WHERE occurrence.occurrence_at < p_before
     ORDER BY occurrence.occurrence_at
     LIMIT p_limit
     FOR UPDATE SKIP LOCKED
  )
  DELETE FROM workhorse.schedule_occurrence occurrence
   USING victims
   WHERE occurrence.ctid = victims.ctid;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

CREATE OR REPLACE FUNCTION workhorse.list_dead_letters_v1(
  p_filter jsonb DEFAULT '{}'::jsonb,
  p_limit integer DEFAULT 100,
  p_cursor_finished_at timestamptz DEFAULT NULL,
  p_cursor_task_id uuid DEFAULT NULL
) RETURNS TABLE (
  task_id uuid, queue_name text, task_type text, concurrency_key text, priority integer,
  payload jsonb, tags text[],
  current_attempt integer, max_attempts integer, retry_policy jsonb,
  deadline_at timestamptz, execution_timeout_ms bigint, error jsonb,
  finished_at timestamptz, redrive_count integer, has_more boolean,
  cursor_finished_at text
)
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v_filter jsonb := COALESCE(p_filter, '{}'::jsonb);
  v_tags text[];
  v_finished_after timestamptz;
  v_finished_before timestamptz;
BEGIN
  IF jsonb_typeof(v_filter) <> 'object'
     OR v_filter - ARRAY['queue', 'type', 'tags', 'errorName', 'finishedAfter', 'finishedBefore']
        <> '{}'::jsonb THEN
    RAISE EXCEPTION 'dead-letter filter must be an object containing only queue, type, tags, errorName, finishedAfter, and finishedBefore';
  END IF;
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION 'dead-letter limit must be between 1 and 1000';
  END IF;
  IF (p_cursor_finished_at IS NULL) <> (p_cursor_task_id IS NULL) THEN
    RAISE EXCEPTION 'dead-letter cursor requires both finished_at and task_id';
  END IF;
  IF p_cursor_finished_at IS NOT NULL AND NOT isfinite(p_cursor_finished_at) THEN
    RAISE EXCEPTION 'dead-letter cursor finished_at must be finite';
  END IF;
  IF v_filter ? 'queue' AND (
       jsonb_typeof(v_filter->'queue') <> 'string' OR v_filter->>'queue' = ''
     ) THEN RAISE EXCEPTION 'dead-letter queue filter must be a non-empty string'; END IF;
  IF v_filter ? 'type' AND (
       jsonb_typeof(v_filter->'type') <> 'string' OR v_filter->>'type' = ''
     ) THEN RAISE EXCEPTION 'dead-letter type filter must be a non-empty string'; END IF;
  IF v_filter ? 'errorName' AND (
       jsonb_typeof(v_filter->'errorName') <> 'string' OR v_filter->>'errorName' = ''
     ) THEN RAISE EXCEPTION 'dead-letter errorName filter must be a non-empty string'; END IF;
  IF v_filter ? 'tags' THEN
    IF jsonb_typeof(v_filter->'tags') <> 'array' THEN
      RAISE EXCEPTION 'dead-letter tags filter must be an array';
    END IF;
    SELECT COALESCE(array_agg(value), '{}') INTO v_tags
      FROM jsonb_array_elements_text(v_filter->'tags') tag(value);
    IF NOT workhorse.valid_tags_v1(v_tags) THEN
      RAISE EXCEPTION 'dead-letter tags filter must contain at most 20 non-empty tags of at most 100 characters';
    END IF;
  END IF;
  IF v_filter ? 'finishedAfter' THEN
    IF jsonb_typeof(v_filter->'finishedAfter') <> 'string' THEN
      RAISE EXCEPTION 'dead-letter finishedAfter filter must be a timestamp string';
    END IF;
    v_finished_after := (v_filter->>'finishedAfter')::timestamptz;
    IF NOT isfinite(v_finished_after) THEN RAISE EXCEPTION 'dead-letter finishedAfter must be finite'; END IF;
  END IF;
  IF v_filter ? 'finishedBefore' THEN
    IF jsonb_typeof(v_filter->'finishedBefore') <> 'string' THEN
      RAISE EXCEPTION 'dead-letter finishedBefore filter must be a timestamp string';
    END IF;
    v_finished_before := (v_filter->>'finishedBefore')::timestamptz;
    IF NOT isfinite(v_finished_before) THEN RAISE EXCEPTION 'dead-letter finishedBefore must be finite'; END IF;
  END IF;
  IF v_finished_after IS NOT NULL AND v_finished_before IS NOT NULL
     AND v_finished_after >= v_finished_before THEN
    RAISE EXCEPTION 'dead-letter finishedAfter must be earlier than finishedBefore';
  END IF;

  RETURN QUERY
  WITH candidates AS MATERIALIZED (
    SELECT task.id, task.queue_name, task.task_type, task.concurrency_key, task.priority,
           workhorse.redact_top_level_keys_v1(task.payload, task.payload_redact_keys) AS payload,
           task.tags,
           outcome.current_attempt, task.max_attempts, task.retry_policy,
           task.deadline_at, task.execution_timeout_ms, outcome.error,
           outcome.finished_at,
           (SELECT count(*)::integer FROM workhorse.task_redrive redrive
             WHERE redrive.source_task_id = task.id) AS redrive_count
      FROM (
        SELECT full_outcome.task_id, full_outcome.current_attempt, full_outcome.error,
               full_outcome.finished_at
          FROM workhorse.task_outcome full_outcome
         WHERE full_outcome.state = 'failed'
        UNION ALL
        SELECT fast_outcome.task_id, fast_outcome.attempt, fast_outcome.error,
               fast_outcome.finished_at
          FROM workhorse.fast_task_outcome fast_outcome
         WHERE fast_outcome.state = 'failed'
      ) outcome
      JOIN workhorse.task task ON task.id = outcome.task_id
     WHERE true
       AND (NOT (v_filter ? 'queue') OR task.queue_name = v_filter->>'queue')
       AND (NOT (v_filter ? 'type') OR task.task_type = v_filter->>'type')
       AND (v_tags IS NULL OR task.tags @> v_tags)
       AND (NOT (v_filter ? 'errorName') OR outcome.error->>'name' = v_filter->>'errorName')
       AND (v_finished_after IS NULL OR outcome.finished_at >= v_finished_after)
       AND (v_finished_before IS NULL OR outcome.finished_at < v_finished_before)
       AND (p_cursor_finished_at IS NULL OR
            (outcome.finished_at, outcome.task_id) < (p_cursor_finished_at, p_cursor_task_id))
     ORDER BY outcome.finished_at DESC, outcome.task_id DESC
     LIMIT p_limit + 1
  )
  SELECT candidate.id, candidate.queue_name, candidate.task_type, candidate.concurrency_key,
         candidate.priority, candidate.payload, candidate.tags,
         candidate.current_attempt, candidate.max_attempts, candidate.retry_policy,
         candidate.deadline_at, candidate.execution_timeout_ms, candidate.error,
         candidate.finished_at, candidate.redrive_count,
         (SELECT count(*) FROM candidates) > p_limit,
         to_char(candidate.finished_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
    FROM candidates candidate
   ORDER BY candidate.finished_at DESC, candidate.id DESC
   LIMIT p_limit;
END;
$$;

CREATE OR REPLACE FUNCTION workhorse.redrive_many_v1(
  p_filter jsonb,
  p_limit integer,
  p_dry_run boolean,
  p_requested_by text,
  p_reason text,
  p_request_id text,
  p_cursor_finished_at timestamptz DEFAULT NULL,
  p_cursor_task_id uuid DEFAULT NULL
) RETURNS TABLE (
  ordinal integer, status text, source_task_id uuid, target_task_id uuid,
  source_state text, target_state text, requested_at timestamptz,
  source_finished_at_cursor text, has_more boolean
)
LANGUAGE plpgsql
AS $$
DECLARE
  v_filter jsonb := COALESCE(p_filter, '{}'::jsonb);
  v_tags text[];
  v_finished_after timestamptz;
  v_finished_before timestamptz;
  v_candidate record;
BEGIN
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION 'bulk redrive limit must be between 1 and 1000';
  END IF;
  IF (p_cursor_finished_at IS NULL) <> (p_cursor_task_id IS NULL) THEN
    RAISE EXCEPTION 'bulk redrive cursor requires both finished_at and task_id';
  END IF;
  IF p_cursor_finished_at IS NOT NULL AND NOT isfinite(p_cursor_finished_at) THEN
    RAISE EXCEPTION 'bulk redrive cursor finished_at must be finite';
  END IF;
  IF p_dry_run IS NULL THEN RAISE EXCEPTION 'bulk redrive dry_run is required'; END IF;
  -- Validate attribution even for an empty selection and dry runs.
  IF p_requested_by IS NULL OR p_requested_by = '' OR char_length(p_requested_by) > 200 THEN
    RAISE EXCEPTION 'requested_by must contain between 1 and 200 characters';
  END IF;
  IF p_reason IS NULL OR p_reason = '' OR char_length(p_reason) > 2000 THEN
    RAISE EXCEPTION 'reason must contain between 1 and 2000 characters';
  END IF;
  IF p_request_id IS NULL OR p_request_id = '' OR octet_length(p_request_id) > 512 THEN
    RAISE EXCEPTION 'request_id must contain between 1 and 512 UTF-8 bytes';
  END IF;
  IF jsonb_typeof(v_filter) <> 'object'
     OR v_filter - ARRAY['queue', 'type', 'tags', 'errorName', 'finishedAfter', 'finishedBefore']
        <> '{}'::jsonb THEN
    RAISE EXCEPTION 'bulk redrive filter must be an object containing only queue, type, tags, errorName, finishedAfter, and finishedBefore';
  END IF;
  IF v_filter ? 'queue' AND (
       jsonb_typeof(v_filter->'queue') <> 'string' OR v_filter->>'queue' = ''
     ) THEN RAISE EXCEPTION 'bulk redrive queue filter must be a non-empty string'; END IF;
  IF v_filter ? 'type' AND (
       jsonb_typeof(v_filter->'type') <> 'string' OR v_filter->>'type' = ''
     ) THEN RAISE EXCEPTION 'bulk redrive type filter must be a non-empty string'; END IF;
  IF v_filter ? 'errorName' AND (
       jsonb_typeof(v_filter->'errorName') <> 'string' OR v_filter->>'errorName' = ''
     ) THEN RAISE EXCEPTION 'bulk redrive errorName filter must be a non-empty string'; END IF;
  IF v_filter ? 'tags' THEN
    IF jsonb_typeof(v_filter->'tags') <> 'array' THEN
      RAISE EXCEPTION 'bulk redrive tags filter must be an array';
    END IF;
    SELECT COALESCE(array_agg(value), '{}') INTO v_tags
      FROM jsonb_array_elements_text(v_filter->'tags') tag(value);
    IF NOT workhorse.valid_tags_v1(v_tags) THEN
      RAISE EXCEPTION 'bulk redrive tags filter must contain at most 20 non-empty tags of at most 100 characters';
    END IF;
  END IF;
  IF v_filter ? 'finishedAfter' THEN
    IF jsonb_typeof(v_filter->'finishedAfter') <> 'string' THEN
      RAISE EXCEPTION 'bulk redrive finishedAfter filter must be a timestamp string';
    END IF;
    v_finished_after := (v_filter->>'finishedAfter')::timestamptz;
    IF NOT isfinite(v_finished_after) THEN RAISE EXCEPTION 'bulk redrive finishedAfter must be finite'; END IF;
  END IF;
  IF v_filter ? 'finishedBefore' THEN
    IF jsonb_typeof(v_filter->'finishedBefore') <> 'string' THEN
      RAISE EXCEPTION 'bulk redrive finishedBefore filter must be a timestamp string';
    END IF;
    v_finished_before := (v_filter->>'finishedBefore')::timestamptz;
    IF NOT isfinite(v_finished_before) THEN RAISE EXCEPTION 'bulk redrive finishedBefore must be finite'; END IF;
  END IF;
  IF v_finished_after IS NOT NULL AND v_finished_before IS NOT NULL
     AND v_finished_after >= v_finished_before THEN
    RAISE EXCEPTION 'bulk redrive finishedAfter must be earlier than finishedBefore';
  END IF;

  ordinal := 0;
  FOR v_candidate IN
    WITH candidates AS MATERIALIZED (
      SELECT outcome.task_id, outcome.finished_at
        FROM (
          SELECT full_outcome.task_id, full_outcome.finished_at, full_outcome.error
            FROM workhorse.task_outcome full_outcome
           WHERE full_outcome.state = 'failed'
          UNION ALL
          SELECT fast_outcome.task_id, fast_outcome.finished_at, fast_outcome.error
            FROM workhorse.fast_task_outcome fast_outcome
           WHERE fast_outcome.state = 'failed'
        ) outcome
        JOIN workhorse.task task ON task.id = outcome.task_id
       WHERE true
         AND (NOT (v_filter ? 'queue') OR task.queue_name = v_filter->>'queue')
         AND (NOT (v_filter ? 'type') OR task.task_type = v_filter->>'type')
         AND (v_tags IS NULL OR task.tags @> v_tags)
         AND (NOT (v_filter ? 'errorName') OR outcome.error->>'name' = v_filter->>'errorName')
         AND (v_finished_after IS NULL OR outcome.finished_at >= v_finished_after)
         AND (v_finished_before IS NULL OR outcome.finished_at < v_finished_before)
         AND (p_cursor_finished_at IS NULL OR
              (outcome.finished_at, outcome.task_id) > (p_cursor_finished_at, p_cursor_task_id))
       ORDER BY outcome.finished_at, outcome.task_id
       LIMIT p_limit + 1
    )
    SELECT candidate.task_id, candidate.finished_at,
           (SELECT count(*) FROM candidates) > p_limit AS has_more
      FROM candidates candidate
     ORDER BY candidate.finished_at, candidate.task_id
     LIMIT p_limit
  LOOP
    ordinal := ordinal + 1;
    IF p_dry_run THEN
      status := 'eligible';
      source_task_id := v_candidate.task_id;
      target_task_id := NULL;
      source_state := 'failed';
      target_state := NULL;
      requested_at := NULL;
      source_finished_at_cursor := to_char(
        v_candidate.finished_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
      );
      has_more := v_candidate.has_more;
      RETURN NEXT;
    ELSE
      RETURN QUERY
      SELECT ordinal, result.status, result.source_task_id, result.target_task_id,
             result.source_state, result.target_state, result.requested_at,
             to_char(
               v_candidate.finished_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
             ),
             v_candidate.has_more
        FROM workhorse.redrive_v1(
          v_candidate.task_id, p_requested_by, p_reason, p_request_id
        ) result;
    END IF;
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION workhorse.claim_policy_batch_v1(
  p_queue_name text,
  p_worker_id text,
  p_limit integer,
  p_lease_ms integer,
  p_wait_for_budgets boolean
) RETURNS TABLE (
  task_id uuid, task_type text, priority integer, payload jsonb, contract_version text, result_max_bytes integer,
  redact_error_details boolean,
  trace_context jsonb,
  attempt integer, max_attempts integer,
  retry_policy jsonb, deadline_at timestamptz, execution_timeout_ms bigint,
  attempt_timeout_at timestamptz, fence_token bigint, lease_expires_at timestamptz
)
LANGUAGE plpgsql
SET plan_cache_mode = force_generic_plan
AS $$
DECLARE
  v_claimed integer;
  v_policy workhorse.concurrency_policy%ROWTYPE;
  v_rate_policy workhorse.rate_limit_policy%ROWTYPE;
  v_budget_name text;
  v_budget_names text[] := '{}';
  v_first_round boolean := true;
  v_now timestamptz;
  v_expires timestamptz;
  v_room integer;
  v_take integer;
  v_queue_capped boolean;
  v_window integer;
  v_mixed boolean;
  v_fit integer;
  v_picked uuid[];
  v_fences bigint[];
  v_ids uuid[];
  v_keys text[];
  v_budgets text[];
  v_total integer := 0;
  v_direct boolean;
  v_index integer;
  v_shards integer;
  v_home integer;
  v_shard integer;
  v_held integer[] := '{}';
  v_rebalanced boolean := false;
  v_skipped boolean := false;
  v_short boolean := false;
  v_capped_out boolean := false;
  v_shard_room integer[];
  v_shard_tokens numeric[];
  v_conc_room integer;
  v_rate_room integer;
  v_all_room integer;
  v_all_tokens integer;
  v_want integer;
  v_gain_room integer;
  v_gain_tokens numeric;
  v_slots integer[];
  v_left integer;
  v_part integer;
  v_rest numeric;
  v_charge numeric;
  v_charged integer[];
  v_charges numeric[];
BEGIN
  IF p_worker_id IS NULL OR p_worker_id = '' THEN RAISE EXCEPTION 'worker_id must not be empty'; END IF;
  IF p_lease_ms IS NULL OR p_lease_ms NOT BETWEEN 100 AND 86400000 THEN
    RAISE EXCEPTION 'lease_ms must be between 100 and 86400000';
  END IF;
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'limit must be between 1 and 100';
  END IF;
  -- Shared queue locks allow claims to overlap while holding every deployment synchronization of
  -- this queue's policies, and the rebalance it performs, back until this claim commits.
  PERFORM pg_advisory_xact_lock_shared(
    hashtextextended('workhorse:concurrency-policy:' || p_queue_name, 0)
  );
  PERFORM pg_advisory_xact_lock_shared(
    hashtextextended('workhorse:rate-limit-policy:' || p_queue_name, 0)
  );
  SELECT policy.* INTO v_policy
    FROM workhorse.concurrency_policy policy WHERE policy.queue_name = p_queue_name;
  SELECT policy.* INTO v_rate_policy
    FROM workhorse.rate_limit_policy policy WHERE policy.queue_name = p_queue_name;
  v_shards := workhorse.admission_shard_count_v1(
    v_policy.max_active, v_policy.max_active_per_key, v_rate_policy.rate_burst,
    v_rate_policy.per_key_limit
  );
  v_home := CASE WHEN v_shards > 0 THEN pg_backend_pid() % v_shards END;
  -- A queue whose shard rows do not match its policies has not been rebalanced since a policy
  -- changed outside deployment synchronization. The rebalance leaves this claim holding every shard.
  -- A queue with no policy has no shards, and its stored rows are left alone.
  IF v_shards > 0 AND NOT EXISTS (
    SELECT 1 FROM workhorse.admission_shard stored
     WHERE stored.queue_name = p_queue_name
    HAVING count(*) = v_shards AND max(stored.shard) = v_shards - 1
  ) THEN
    PERFORM workhorse.rebalance_admission_shards_v1(p_queue_name, clock_timestamp());
    v_rebalanced := true;
    v_held := ARRAY(SELECT generate_series(0, v_shards - 1));
  END IF;

  LOOP
    -- Lock each budget the window can name, in name order, before reading the clock. Only a first
    -- round that holds no shard may wait; any other round takes only the locks it can get at once.
    -- A queue with no ready row that names a budget skips the sample.
    IF EXISTS (
      SELECT 1 FROM workhorse.task_runtime runtime
       WHERE runtime.state = 'ready' AND runtime.queue_name = p_queue_name
         AND runtime.budget_name IS NOT NULL
    ) THEN
      FOR v_budget_name IN
        SELECT DISTINCT sample.budget_name
          FROM (
            SELECT runtime.budget_name
              FROM workhorse.task_runtime runtime
             WHERE runtime.state = 'ready' AND runtime.queue_name = p_queue_name
             ORDER BY runtime.priority DESC, runtime.sequence, runtime.task_id
             LIMIT 100
          ) sample
         WHERE sample.budget_name IS NOT NULL
         ORDER BY sample.budget_name
      LOOP
        CONTINUE WHEN v_budget_name = ANY(v_budget_names);
        IF v_first_round AND p_wait_for_budgets AND NOT v_rebalanced THEN
          PERFORM pg_advisory_xact_lock(hashtextextended('workhorse:budget:' || v_budget_name, 0));
        ELSIF NOT pg_try_advisory_xact_lock(
          hashtextextended('workhorse:budget:' || v_budget_name, 0)
        ) THEN
          CONTINUE;
        END IF;
        v_budget_names := v_budget_names || v_budget_name;
      END LOOP;
    END IF;

    IF v_first_round AND NOT v_rebalanced AND v_shards > 0 THEN
      -- Take the first shard that is free, starting at home. When every shard is busy, wait for the
      -- home shard, or give up when this claim may not wait.
      FOR v_index IN 0..v_shards - 1 LOOP
        v_shard := (v_home + v_index) % v_shards;
        IF pg_try_advisory_xact_lock(
          hashtextextended('workhorse:admission-shard:' || p_queue_name || ':' || v_shard, 0)
        ) THEN
          v_held := ARRAY[v_shard];
          EXIT;
        END IF;
      END LOOP;
      IF cardinality(v_held) = 0 THEN
        IF NOT p_wait_for_budgets THEN
          v_skipped := true;
          v_short := true;
          v_capped_out := true;
          EXIT;
        END IF;
        PERFORM pg_advisory_xact_lock(
          hashtextextended('workhorse:admission-shard:' || p_queue_name || ':' || v_home, 0)
        );
        v_held := ARRAY[v_home];
      END IF;
    END IF;
    v_now := clock_timestamp();
    v_expires := v_now + make_interval(secs => p_lease_ms::double precision / 1000.0);

    IF v_first_round THEN
      WITH oldest_key_buckets AS MATERIALIZED (
        SELECT bucket.bucket_key, bucket.tokens, bucket.refilled_at
          FROM workhorse.rate_limit_bucket bucket
         WHERE bucket.queue_name = p_queue_name AND bucket.bucket_scope = 'key'
         ORDER BY bucket.refilled_at, bucket.bucket_key
         FOR UPDATE SKIP LOCKED
         LIMIT 100
      ), full_key_buckets AS (
        SELECT oldest.bucket_key
          FROM oldest_key_buckets oldest
         WHERE v_rate_policy.per_key_limit IS NULL OR LEAST(
           v_rate_policy.per_key_burst::numeric,
           oldest.tokens + GREATEST(
             0::numeric,
             extract(epoch FROM v_now - oldest.refilled_at) * 1000
           ) * v_rate_policy.per_key_limit::numeric / v_rate_policy.per_key_interval_ms::numeric
         ) >= v_rate_policy.per_key_burst
      )
      DELETE FROM workhorse.rate_limit_bucket bucket
       USING full_key_buckets refilled
       WHERE bucket.queue_name = p_queue_name AND bucket.bucket_scope = 'key'
         AND bucket.bucket_key = refilled.bucket_key;
    END IF;
    v_first_round := false;

    -- Read every shard's room and refilled tokens. A shard's room is its share of max_active less
    -- its unexpired active leases, and a null value means no rule limits it. The held room adds the
    -- overdraft of every shard this claim does not hold. When the held shards cannot cover what the
    -- whole queue could start, borrow the shards that have capacity and are free now, then read again.
    -- A queue with no shards has no queue-wide rule, so its room stays null.
    v_room := NULL;
    v_short := false;
    FOR v_index IN 1..2 LOOP
      EXIT WHEN v_shards = 0;
      WITH shard AS (
        SELECT slot.shard,
               CASE WHEN v_policy.queue_name IS NOT NULL THEN
                 workhorse.admission_share_v1(v_policy.max_active, v_shards, slot.shard)
                   - COALESCE(active.leases, 0)
               END AS room,
               CASE WHEN v_rate_policy.queue_name IS NOT NULL THEN LEAST(
                 workhorse.admission_share_v1(v_rate_policy.rate_burst, v_shards, slot.shard)::numeric,
                 COALESCE(
                   stored.tokens + GREATEST(
                     0::numeric,
                     extract(epoch FROM v_now - stored.refilled_at) * 1000
                   ) * v_rate_policy.rate_limit::numeric
                     * workhorse.admission_share_v1(v_rate_policy.rate_burst, v_shards, slot.shard)
                     / (v_rate_policy.rate_interval_ms::numeric * v_rate_policy.rate_burst),
                   workhorse.admission_share_v1(v_rate_policy.rate_burst, v_shards, slot.shard)::numeric
                 )
               ) END AS tokens,
               slot.shard = ANY(v_held) AS held
          FROM generate_series(0, v_shards - 1) AS slot(shard)
          LEFT JOIN (
            SELECT COALESCE(active.admission_shard, 0) % v_shards AS shard,
                   count(*)::integer AS leases
              FROM workhorse.task_runtime active
             WHERE active.state = 'active' AND active.queue_name = p_queue_name
               AND active.expires_at > v_now
             GROUP BY 1
          ) active ON active.shard = slot.shard
          LEFT JOIN workhorse.admission_shard stored
            ON stored.queue_name = p_queue_name AND stored.shard = slot.shard
      )
      SELECT array_agg(shard.room ORDER BY shard.shard),
             array_agg(shard.tokens ORDER BY shard.shard),
             -- GREATEST and LEAST skip a null, so a queue with no concurrency policy tests for it.
             CASE WHEN v_policy.queue_name IS NOT NULL THEN LEAST(
               sum(GREATEST(shard.room, 0)) FILTER (WHERE shard.held),
               sum(shard.room) FILTER (WHERE shard.held)
                 + COALESCE(sum(LEAST(shard.room, 0)) FILTER (WHERE NOT shard.held), 0)
             ) END::integer,
             floor(sum(shard.tokens) FILTER (WHERE shard.held))::integer,
             sum(shard.room)::integer,
             floor(sum(shard.tokens))::integer
        INTO v_shard_room, v_shard_tokens, v_conc_room, v_rate_room, v_all_room, v_all_tokens
        FROM shard;
      v_room := LEAST(v_conc_room, v_rate_room);
      v_want := LEAST(p_limit - v_total, v_all_room, v_all_tokens);
      v_short := v_room < v_want;
      EXIT WHEN v_index = 2 OR NOT v_short OR cardinality(v_held) = v_shards;
      v_gain_room := 0;
      v_gain_tokens := 0;
      FOR v_offset IN 0..v_shards - 1 LOOP
        v_shard := (v_home + v_offset) % v_shards;
        CONTINUE WHEN v_shard = ANY(v_held)
          OR COALESCE(v_shard_room[v_shard + 1], 1) <= 0
          OR COALESCE(v_shard_tokens[v_shard + 1], 1) <= 0;
        IF pg_try_advisory_xact_lock(
          hashtextextended('workhorse:admission-shard:' || p_queue_name || ':' || v_shard, 0)
        ) THEN
          v_held := v_held || v_shard;
          v_gain_room := v_gain_room + COALESCE(v_shard_room[v_shard + 1], 0);
          v_gain_tokens := v_gain_tokens + COALESCE(v_shard_tokens[v_shard + 1], 0);
          EXIT WHEN (v_conc_room IS NULL OR v_conc_room + v_gain_room >= v_want)
            AND (v_rate_room IS NULL OR v_rate_room + v_gain_tokens >= v_want);
        ELSE
          v_skipped := true;
        END IF;
      END LOOP;
    END LOOP;

    v_take := p_limit - v_total;
    v_queue_capped := false;
    IF v_room <= v_take THEN v_take := v_room; v_queue_capped := true; END IF;
    IF v_take <= 0 THEN
      v_capped_out := true;
      EXIT;
    END IF;

    v_direct := v_policy.max_active_per_key IS NULL AND v_rate_policy.per_key_limit IS NULL
      AND cardinality(v_budget_names) = 0;
    IF v_direct THEN
      -- No per-key rule and no budget lock, so no rule passes over a row, and the first ready rows
      -- this claim can lock are the rows it takes. As in claim_one_v1, a row that names a budget
      -- holds the line, and the rows after it stay ready.
      SELECT array_agg(line.task_id ORDER BY line.priority DESC, line.sequence, line.task_id)
        INTO v_picked
        FROM (
          SELECT locked.task_id, locked.priority, locked.sequence,
                 bool_or(locked.budget_name IS NOT NULL) OVER (
                   ORDER BY locked.priority DESC, locked.sequence, locked.task_id
                 ) AS reached_budget
            FROM (
              SELECT runtime.task_id, runtime.budget_name, runtime.priority, runtime.sequence
                FROM workhorse.task_runtime runtime
                JOIN workhorse.task task ON task.id = runtime.task_id
               WHERE runtime.state = 'ready' AND runtime.queue_name = p_queue_name
                 AND (runtime.deadline_at IS NULL OR runtime.deadline_at > v_now)
                 AND (task.execution_timeout_ms IS NULL
                   OR runtime.execution_used_ms < task.execution_timeout_ms)
                 AND NOT EXISTS (
                   SELECT 1 FROM workhorse.queue_control control
                    WHERE control.queue_name = p_queue_name AND control.paused
                 )
               ORDER BY runtime.priority DESC, runtime.sequence, runtime.task_id
               FOR NO KEY UPDATE OF runtime SKIP LOCKED
               LIMIT v_take
            ) locked
        ) line
       WHERE NOT line.reached_budget;
    ELSE
      -- The window reads without locking, and only the admitted rows are locked (SM-801). A null
      -- room means no rule limits that key or budget.
      WITH ready_window AS MATERIALIZED (
        SELECT runtime.task_id, runtime.concurrency_key, runtime.budget_name, runtime.priority,
               runtime.sequence
          FROM workhorse.task_runtime runtime
          JOIN workhorse.task task ON task.id = runtime.task_id
         WHERE runtime.state = 'ready' AND runtime.queue_name = p_queue_name
           AND (runtime.deadline_at IS NULL OR runtime.deadline_at > v_now)
           AND (task.execution_timeout_ms IS NULL
             OR runtime.execution_used_ms < task.execution_timeout_ms)
           AND NOT EXISTS (
             SELECT 1 FROM workhorse.queue_control control
              WHERE control.queue_name = p_queue_name AND control.paused
           )
         ORDER BY runtime.priority DESC, runtime.sequence, runtime.task_id
         LIMIT 100
      ), key_room AS (
        SELECT keys.concurrency_key, LEAST(
          CASE WHEN v_policy.max_active_per_key IS NOT NULL THEN
            v_policy.max_active_per_key - (
              SELECT count(*)::integer
                FROM workhorse.task_runtime active
               WHERE active.state = 'active'
                 AND active.queue_name = p_queue_name
                 AND active.concurrency_key = keys.concurrency_key
                 AND active.expires_at > v_now
            )
          END,
          CASE WHEN v_rate_policy.per_key_limit IS NOT NULL THEN floor(LEAST(
            v_rate_policy.per_key_burst::numeric,
            COALESCE(
              bucket.tokens + GREATEST(
                0::numeric,
                extract(epoch FROM v_now - bucket.refilled_at) * 1000
              ) * v_rate_policy.per_key_limit::numeric / v_rate_policy.per_key_interval_ms::numeric,
              v_rate_policy.per_key_burst::numeric
            )
          ))::integer END
        ) AS room
          FROM (
            SELECT DISTINCT ready.concurrency_key FROM ready_window ready
             WHERE ready.concurrency_key IS NOT NULL
          ) keys
          LEFT JOIN workhorse.rate_limit_bucket bucket
            ON bucket.queue_name = p_queue_name AND bucket.bucket_scope = 'key'
           AND bucket.bucket_key = keys.concurrency_key
      ), budget_room AS (
        -- A budget this claim never locked has no room, whether or not it exists.
        SELECT names.budget_name, CASE
          WHEN NOT (names.budget_name = ANY(v_budget_names)) THEN 0
          WHEN budget.budget_name IS NULL THEN NULL
          ELSE LEAST(
            budget.max_active - (
              SELECT count(*)::integer
                FROM workhorse.task_runtime active
               WHERE active.state = 'active'
                 AND active.budget_name = names.budget_name
                 AND active.expires_at > v_now
            ),
            CASE WHEN budget.rate_limit IS NOT NULL THEN floor(LEAST(
              budget.rate_burst::numeric,
              COALESCE(
                bucket.tokens + GREATEST(
                  0::numeric,
                  extract(epoch FROM v_now - bucket.refilled_at) * 1000
                ) * budget.rate_limit::numeric / budget.rate_interval_ms::numeric,
                budget.rate_burst::numeric
              )
            ))::integer END
          )
        END AS room
          FROM (
            SELECT DISTINCT ready.budget_name FROM ready_window ready
             WHERE ready.budget_name IS NOT NULL
          ) names
          LEFT JOIN workhorse.budget budget ON budget.budget_name = names.budget_name
          LEFT JOIN workhorse.budget_bucket bucket ON bucket.budget_name = names.budget_name
      ), eligible AS (
        SELECT ready.task_id, ready.concurrency_key, ready.budget_name, ready.priority,
               ready.sequence, key_room.room AS key_room, budget_room.room AS budget_room
          FROM ready_window ready
          LEFT JOIN key_room ON key_room.concurrency_key = ready.concurrency_key
          LEFT JOIN budget_room ON budget_room.budget_name = ready.budget_name
         WHERE COALESCE(key_room.room, 1) >= 1 AND COALESCE(budget_room.room, 1) >= 1
      ), ranked AS (
        SELECT eligible.*,
               row_number() OVER (
                 PARTITION BY eligible.concurrency_key
                 ORDER BY eligible.priority DESC, eligible.sequence, eligible.task_id
               ) AS key_rank,
               row_number() OVER (
                 PARTITION BY eligible.budget_name
                 ORDER BY eligible.priority DESC, eligible.sequence, eligible.task_id
               ) AS budget_rank
          FROM eligible
      ), picked AS (
        SELECT runtime.task_id, ranked.priority, ranked.sequence
          FROM ranked
          JOIN workhorse.task_runtime runtime ON runtime.task_id = ranked.task_id
         WHERE runtime.state = 'ready'
           AND (ranked.key_room IS NULL OR ranked.key_rank <= ranked.key_room)
           AND (ranked.budget_room IS NULL OR ranked.budget_rank <= ranked.budget_room)
         ORDER BY ranked.priority DESC, ranked.sequence, ranked.task_id
         FOR NO KEY UPDATE OF runtime SKIP LOCKED
         LIMIT v_take
      )
      SELECT (SELECT array_agg(picked.task_id ORDER BY picked.priority DESC, picked.sequence,
                               picked.task_id)
                FROM picked),
             (SELECT count(*)::integer FROM ready_window),
             (SELECT COALESCE(bool_or(eligible.key_room IS NOT NULL
                                      AND eligible.budget_room IS NOT NULL), false)
                FROM eligible),
             (SELECT count(*)::integer FROM ranked
               WHERE (ranked.key_room IS NULL OR ranked.key_rank <= ranked.key_room)
                 AND (ranked.budget_room IS NULL OR ranked.budget_rank <= ranked.budget_room))
        INTO v_picked, v_window, v_mixed, v_fit;
    END IF;
    v_claimed := COALESCE(cardinality(v_picked), 0);
    EXIT WHEN v_claimed = 0;

    -- Spread the picked rows over the held shards' room. A queue with no concurrency policy puts
    -- them all on the first held shard, because only the rate bucket limits it.
    v_slots := '{}';
    v_left := v_claimed;
    FOREACH v_shard IN ARRAY v_held LOOP
      EXIT WHEN v_left = 0;
      v_part := CASE WHEN v_policy.queue_name IS NULL THEN v_left
        ELSE LEAST(v_left, GREATEST(v_shard_room[v_shard + 1], 0)) END;
      CONTINUE WHEN v_part = 0;
      v_slots := v_slots || array_fill(v_shard, ARRAY[v_part]);
      v_left := v_left - v_part;
    END LOOP;

    SELECT array_agg(fence ORDER BY fence) INTO v_fences
      FROM (
        SELECT nextval('workhorse.fence_token_seq') AS fence
          FROM generate_series(1, v_claimed)
      ) allocated;
    WITH activated AS (
      UPDATE workhorse.task_runtime runtime
         SET state = 'active', fence_token = v_fences[array_position(v_picked, runtime.task_id)],
             worker_id = p_worker_id,
             acquired_at = v_now, heartbeat_at = v_now, expires_at = v_expires,
             ready_at = NULL, sequence = NULL, wait_name = NULL,
             attempt_started_at = COALESCE(runtime.attempt_started_at, v_now),
             attempt_timeout_at = CASE
               WHEN task.execution_timeout_ms IS NULL THEN NULL
               ELSE v_now + make_interval(secs =>
                 (task.execution_timeout_ms - runtime.execution_used_ms)::double precision / 1000.0)
             END,
             error = NULL, updated_at = v_now,
             admission_shard = v_slots[array_position(v_picked, runtime.task_id)]
        FROM workhorse.task task
       WHERE runtime.task_id = ANY(v_picked) AND runtime.state = 'ready'
         AND task.id = runtime.task_id
         AND (runtime.deadline_at IS NULL OR runtime.deadline_at > v_now)
      RETURNING runtime.task_id, runtime.current_attempt, runtime.fence_token,
                runtime.concurrency_key, runtime.budget_name
    ), events AS (
      INSERT INTO workhorse.task_event(task_id, attempt, event_type, details)
      SELECT activated.task_id, activated.current_attempt, 'claimed',
             jsonb_build_object(
               'worker_id', p_worker_id, 'fence_token', activated.fence_token::text,
               'expires_at', v_expires
             )
        FROM activated
       ORDER BY activated.fence_token
    )
    SELECT array_agg(activated.task_id ORDER BY activated.fence_token),
           array_agg(activated.concurrency_key ORDER BY activated.fence_token),
           array_agg(activated.budget_name ORDER BY activated.fence_token)
      INTO v_ids, v_keys, v_budgets
      FROM activated;
    v_claimed := COALESCE(cardinality(v_ids), 0);

    -- Charge each bucket once for the starts this round admitted. The queue charge falls on the
    -- held shards in order, and each shard gives at most the tokens it holds. A missing bucket
    -- starts full, as in rate_limit_bucket_v1 and budget_bucket_v1, and refill never runs from a
    -- clock ahead of this claim.
    IF v_claimed > 0 AND v_rate_policy.queue_name IS NOT NULL THEN
      v_rest := v_claimed;
      v_charged := '{}';
      v_charges := '{}';
      FOREACH v_shard IN ARRAY v_held LOOP
        EXIT WHEN v_rest <= 0;
        v_charge := LEAST(v_shard_tokens[v_shard + 1], v_rest);
        CONTINUE WHEN v_charge <= 0;
        v_charged := v_charged || v_shard;
        v_charges := v_charges || (v_shard_tokens[v_shard + 1] - v_charge);
        v_rest := v_rest - v_charge;
      END LOOP;
      INSERT INTO workhorse.admission_shard AS shard_row(queue_name, shard, tokens, refilled_at)
      SELECT p_queue_name, charged.shard, charged.tokens, v_now
        FROM unnest(v_charged, v_charges) AS charged(shard, tokens)
      ON CONFLICT (queue_name, shard) DO UPDATE
         SET tokens = EXCLUDED.tokens,
             refilled_at = GREATEST(v_now, shard_row.refilled_at);
    END IF;
    IF v_claimed > 0 AND v_rate_policy.per_key_limit IS NOT NULL THEN
      INSERT INTO workhorse.rate_limit_bucket(
        queue_name, bucket_scope, bucket_key, tokens, refilled_at
      )
      SELECT DISTINCT p_queue_name, 'key', claimed.bucket_key, v_rate_policy.per_key_burst, v_now
        FROM unnest(v_keys) AS claimed(bucket_key)
       WHERE claimed.bucket_key IS NOT NULL
      ON CONFLICT DO NOTHING;
      UPDATE workhorse.rate_limit_bucket bucket
         SET tokens = LEAST(
               v_rate_policy.per_key_burst::numeric,
               bucket.tokens + GREATEST(
                 0::numeric,
                 extract(epoch FROM v_now - bucket.refilled_at) * 1000
               ) * v_rate_policy.per_key_limit::numeric / v_rate_policy.per_key_interval_ms::numeric
             ) - started.starts,
             refilled_at = GREATEST(v_now, bucket.refilled_at)
        FROM (
          SELECT claimed.bucket_key, count(*)::integer AS starts
            FROM unnest(v_keys) AS claimed(bucket_key)
           WHERE claimed.bucket_key IS NOT NULL
           GROUP BY claimed.bucket_key
        ) started
       WHERE bucket.queue_name = p_queue_name AND bucket.bucket_scope = 'key'
         AND bucket.bucket_key = started.bucket_key;
    END IF;
    IF v_claimed > 0 AND EXISTS (
      SELECT 1 FROM unnest(v_budgets) AS claimed(budget_name) WHERE claimed.budget_name IS NOT NULL
    ) THEN
      INSERT INTO workhorse.budget_bucket(budget_name, tokens, refilled_at)
      SELECT budget.budget_name, budget.rate_burst, v_now
        FROM workhorse.budget budget
       WHERE budget.rate_limit IS NOT NULL AND budget.budget_name = ANY(v_budgets)
      ON CONFLICT DO NOTHING;
      UPDATE workhorse.budget_bucket bucket
         SET tokens = LEAST(
               budget.rate_burst::numeric,
               bucket.tokens + GREATEST(
                 0::numeric,
                 extract(epoch FROM v_now - bucket.refilled_at) * 1000
               ) * budget.rate_limit::numeric / budget.rate_interval_ms::numeric
             ) - started.starts,
             refilled_at = GREATEST(v_now, bucket.refilled_at)
        FROM workhorse.budget budget, (
          SELECT claimed.budget_name, count(*)::integer AS starts
            FROM unnest(v_budgets) AS claimed(budget_name)
           WHERE claimed.budget_name IS NOT NULL
           GROUP BY claimed.budget_name
        ) started
       WHERE budget.budget_name = started.budget_name AND budget.rate_limit IS NOT NULL
         AND bucket.budget_name = started.budget_name;
    END IF;

    RETURN QUERY
      SELECT task.id, task.task_type, task.priority, task.payload, task.contract_version,
             task.result_max_bytes,
             cardinality(task.payload_redact_keys) > 0 OR cardinality(task.result_redact_keys) > 0,
             task.trace_context,
             runtime.current_attempt, task.max_attempts,
             task.retry_policy, task.deadline_at, task.execution_timeout_ms,
             runtime.attempt_timeout_at, runtime.fence_token, runtime.expires_at
        FROM unnest(v_ids) WITH ORDINALITY AS claimed(task_id, ordinality)
        JOIN workhorse.task task ON task.id = claimed.task_id
        JOIN workhorse.task_runtime runtime ON runtime.task_id = claimed.task_id
       ORDER BY claimed.ordinality;
    v_total := v_total + v_claimed;
    v_capped_out := v_queue_capped AND v_claimed >= v_take;
    -- A round stops the batch when it fills the limit or the held room. A direct round always stops
    -- it, because a short one found no further row it could take. A window round also stops the
    -- batch when its window held every ready row, no row had both a limited key and a limited
    -- budget, and it activated every row that fit.
    EXIT WHEN v_direct OR v_total >= p_limit OR v_capped_out
      OR (v_window < 100 AND NOT v_mixed AND v_claimed >= v_fit);
  END LOOP;
  -- Capacity this claim could not reach sat in a shard another claim held. Wake a worker for it,
  -- so a queue never waits with room for longer than one claim round.
  IF v_skipped AND v_short AND v_capped_out THEN
    PERFORM pg_notify('workhorse_tasks', p_queue_name);
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION workhorse.claim_one_v1(
  p_queue_name text,
  p_worker_id text,
  p_lease_ms integer,
  p_wait_for_budgets boolean
) RETURNS TABLE (
  task_id uuid, task_type text, priority integer, payload jsonb, contract_version text, result_max_bytes integer,
  redact_error_details boolean,
  trace_context jsonb,
  attempt integer, max_attempts integer,
  retry_policy jsonb, deadline_at timestamptz, execution_timeout_ms bigint,
  attempt_timeout_at timestamptz, fence_token bigint, lease_expires_at timestamptz
)
LANGUAGE plpgsql
AS $$
DECLARE
  v_runtime workhorse.task_runtime%ROWTYPE;
  v_budget_name text;
  v_budget_names text[] := '{}';
  v_task_id uuid;
  v_candidate_budget text;
  v_fence bigint;
  v_now timestamptz;
  v_expires timestamptz;
  v_control workhorse.queue_control%ROWTYPE;
BEGIN
  IF p_worker_id IS NULL OR p_worker_id = '' THEN RAISE EXCEPTION 'worker_id must not be empty'; END IF;
  IF p_lease_ms IS NULL OR p_lease_ms NOT BETWEEN 100 AND 86400000 THEN
    RAISE EXCEPTION 'lease_ms must be between 100 and 86400000';
  END IF;
  SELECT * INTO v_control FROM workhorse.queue_control control
   WHERE control.queue_name = p_queue_name;
  IF FOUND AND v_control.tier = 'fast' THEN
    IF NOT v_control.paused THEN
      RETURN QUERY SELECT * FROM workhorse.fast_claim_v1(
        p_queue_name, p_worker_id, 1, p_lease_ms, v_control.record_claims
      );
    END IF;
    RETURN;
  END IF;
  -- Shared queue locks allow unrelated claims to overlap while serializing first policy creation
  -- and pruning against deployment synchronization for this queue. A queue with a policy admits
  -- through its admission shards.
  PERFORM pg_advisory_xact_lock_shared(
    hashtextextended('workhorse:concurrency-policy:' || p_queue_name, 0)
  );
  PERFORM pg_advisory_xact_lock_shared(
    hashtextextended('workhorse:rate-limit-policy:' || p_queue_name, 0)
  );
  IF EXISTS (
    SELECT 1 FROM workhorse.concurrency_policy policy WHERE policy.queue_name = p_queue_name
  ) OR EXISTS (
    SELECT 1 FROM workhorse.rate_limit_policy policy WHERE policy.queue_name = p_queue_name
  ) THEN
    RETURN QUERY SELECT * FROM workhorse.claim_policy_batch_v1(
      p_queue_name, p_worker_id, 1, p_lease_ms, p_wait_for_budgets
    );
    RETURN;
  END IF;
  -- Budget admission counts across queues. Lock each budget the priority window can name, in name
  -- order, before reading the clock. The window may still reach a row whose budget committed after
  -- this sample; that row is not admitted, because its lock was never taken in order.
  FOR v_budget_name IN
    SELECT DISTINCT sample.budget_name
      FROM (
        SELECT runtime.budget_name
          FROM workhorse.task_runtime runtime
         WHERE runtime.state = 'ready' AND runtime.queue_name = p_queue_name
         ORDER BY runtime.priority DESC, runtime.sequence, runtime.task_id
         LIMIT 100
      ) sample
     WHERE sample.budget_name IS NOT NULL
     ORDER BY sample.budget_name
  LOOP
    IF p_wait_for_budgets THEN
      PERFORM pg_advisory_xact_lock(hashtextextended('workhorse:budget:' || v_budget_name, 0));
    ELSIF NOT pg_try_advisory_xact_lock(
      hashtextextended('workhorse:budget:' || v_budget_name, 0)
    ) THEN
      CONTINUE;
    END IF;
    v_budget_names := v_budget_names || v_budget_name;
  END LOOP;
  v_now := clock_timestamp();
  v_expires := v_now + make_interval(secs => p_lease_ms::double precision / 1000.0);
  v_fence := nextval('workhorse.fence_token_seq');
  IF cardinality(v_budget_names) = 0 THEN
    -- No admission rule passes over a row here, so the first ready row this claim can lock is the
    -- row it takes. SKIP LOCKED walks past rows other claims already hold. A row whose budget
    -- committed after this claim sampled its budget names holds the line rather than being passed
    -- over, because reading past it has no bound.
    SELECT runtime.task_id, runtime.budget_name INTO v_task_id, v_candidate_budget
      FROM workhorse.task_runtime runtime
      JOIN workhorse.task task ON task.id = runtime.task_id
     WHERE runtime.state = 'ready' AND runtime.queue_name = p_queue_name
       AND (runtime.deadline_at IS NULL OR runtime.deadline_at > v_now)
       AND (task.execution_timeout_ms IS NULL
         OR runtime.execution_used_ms < task.execution_timeout_ms)
       AND NOT EXISTS (
         SELECT 1 FROM workhorse.queue_control control
          WHERE control.queue_name = p_queue_name AND control.paused
       )
     ORDER BY runtime.priority DESC, runtime.sequence, runtime.task_id
     FOR NO KEY UPDATE OF runtime SKIP LOCKED
     LIMIT 1;
    IF v_candidate_budget IS NOT NULL THEN RETURN; END IF;
  ELSE
    -- A budget can pass over a row, so the window reads without locking and only the chosen
    -- candidate is locked. A claim that admits nothing leaves every sampled row unlocked.
    WITH ready_window AS MATERIALIZED (
      SELECT runtime.task_id, runtime.concurrency_key, runtime.budget_name, runtime.priority,
             runtime.sequence
        FROM workhorse.task_runtime runtime
        JOIN workhorse.task task ON task.id = runtime.task_id
       WHERE runtime.state = 'ready' AND runtime.queue_name = p_queue_name
         AND (runtime.deadline_at IS NULL OR runtime.deadline_at > v_now)
         AND (task.execution_timeout_ms IS NULL
           OR runtime.execution_used_ms < task.execution_timeout_ms)
         AND NOT EXISTS (
           SELECT 1 FROM workhorse.queue_control control
            WHERE control.queue_name = p_queue_name AND control.paused
         )
       ORDER BY runtime.priority DESC, runtime.sequence, runtime.task_id
       LIMIT 100
    ), admissible AS (
      SELECT ready.task_id, ready.priority, ready.sequence
        FROM ready_window ready
       WHERE CASE
           WHEN ready.budget_name IS NULL THEN true
           WHEN ready.budget_name = ANY(v_budget_names)
             THEN workhorse.budget_admission_v1(ready.budget_name, v_now)
           ELSE false
         END
    )
    SELECT runtime.task_id INTO v_task_id
      FROM admissible
      JOIN workhorse.task_runtime runtime ON runtime.task_id = admissible.task_id
     WHERE runtime.state = 'ready'
     ORDER BY admissible.priority DESC, admissible.sequence, admissible.task_id
     FOR NO KEY UPDATE OF runtime SKIP LOCKED
     LIMIT 1;
  END IF;
  IF v_task_id IS NULL THEN RETURN; END IF;

  UPDATE workhorse.task_runtime runtime
     SET state = 'active', fence_token = v_fence, worker_id = p_worker_id,
         acquired_at = v_now, heartbeat_at = v_now, expires_at = v_expires,
         ready_at = NULL, sequence = NULL, wait_name = NULL,
         attempt_started_at = COALESCE(runtime.attempt_started_at, v_now),
         attempt_timeout_at = CASE
           WHEN task.execution_timeout_ms IS NULL THEN NULL
           ELSE v_now + make_interval(secs =>
             (task.execution_timeout_ms - runtime.execution_used_ms)::double precision / 1000.0)
         END,
         error = NULL, updated_at = v_now
    FROM workhorse.task task
   WHERE runtime.task_id = v_task_id AND runtime.state = 'ready' AND task.id = runtime.task_id
     AND (runtime.deadline_at IS NULL OR runtime.deadline_at > v_now)
  RETURNING runtime.* INTO v_runtime;
  IF NOT FOUND THEN RETURN; END IF;

  IF v_runtime.budget_name IS NOT NULL THEN
    PERFORM * FROM workhorse.budget_bucket_v1(v_runtime.budget_name, v_now, true);
  END IF;

  INSERT INTO workhorse.task_event(task_id, attempt, event_type, details)
    VALUES (v_runtime.task_id, v_runtime.current_attempt, 'claimed',
      jsonb_build_object('worker_id', p_worker_id, 'fence_token', v_fence::text, 'expires_at', v_expires));
  RETURN QUERY
    SELECT task.id, task.task_type, task.priority, task.payload, task.contract_version, task.result_max_bytes,
           cardinality(task.payload_redact_keys) > 0 OR cardinality(task.result_redact_keys) > 0,
           task.trace_context,
           v_runtime.current_attempt, task.max_attempts,
           task.retry_policy, task.deadline_at, task.execution_timeout_ms,
           v_runtime.attempt_timeout_at, v_fence, v_expires
      FROM workhorse.task task WHERE task.id = v_runtime.task_id;
END;
$$;

CREATE OR REPLACE FUNCTION workhorse.claim_many_v1(
  p_queue_name text,
  p_worker_id text,
  p_limit integer,
  p_lease_ms integer DEFAULT 30000
) RETURNS TABLE (
  task_id uuid, task_type text, priority integer, payload jsonb, contract_version text, result_max_bytes integer,
  redact_error_details boolean,
  trace_context jsonb,
  attempt integer, max_attempts integer,
  retry_policy jsonb, deadline_at timestamptz, execution_timeout_ms bigint,
  attempt_timeout_at timestamptz, fence_token bigint, lease_expires_at timestamptz
)
LANGUAGE plpgsql
SET plan_cache_mode = force_generic_plan
AS $$
DECLARE
  v_control workhorse.queue_control%ROWTYPE;
BEGIN
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'limit must be between 1 and 100';
  END IF;
  -- A fast-tier queue has no admission policy to apply row by row, so it claims the whole batch in
  -- one statement.
  SELECT * INTO v_control FROM workhorse.queue_control control
   WHERE control.queue_name = p_queue_name;
  IF FOUND AND v_control.tier = 'fast' THEN
    IF p_worker_id IS NULL OR p_worker_id = '' THEN
      RAISE EXCEPTION 'worker_id must not be empty';
    END IF;
    IF p_lease_ms IS NULL OR p_lease_ms NOT BETWEEN 100 AND 86400000 THEN
      RAISE EXCEPTION 'lease_ms must be between 100 and 86400000';
    END IF;
    IF NOT v_control.paused THEN
      RETURN QUERY SELECT * FROM workhorse.fast_claim_v1(
        p_queue_name, p_worker_id, p_limit, p_lease_ms, v_control.record_claims
      );
    END IF;
    RETURN;
  END IF;
  RETURN QUERY SELECT * FROM workhorse.claim_policy_batch_v1(
    p_queue_name, p_worker_id, p_limit, p_lease_ms, true
  );
END;
$$;

CREATE OR REPLACE FUNCTION workhorse.heartbeat_v1(
  p_task_id uuid, p_worker_id text, p_fence_token bigint, p_lease_ms integer DEFAULT 30000
) RETURNS text
LANGUAGE plpgsql
AS $$
DECLARE
  v_now timestamptz := clock_timestamp();
  v_status text;
BEGIN
  IF p_worker_id IS NULL OR p_worker_id = '' THEN RAISE EXCEPTION 'worker_id must not be empty'; END IF;
  IF p_lease_ms IS NULL OR p_lease_ms NOT BETWEEN 100 AND 86400000 THEN
    RAISE EXCEPTION 'lease_ms must be between 100 and 86400000';
  END IF;
  IF EXISTS (SELECT 1 FROM workhorse.fast_task_runtime fast WHERE fast.task_id = p_task_id) THEN
    RETURN (SELECT beat.status FROM workhorse.fast_heartbeat_many_v1(
      p_worker_id, ARRAY[p_task_id], ARRAY[p_fence_token], ARRAY[p_lease_ms]
    ) beat);
  END IF;
  UPDATE workhorse.task_runtime r
     SET heartbeat_at = CASE
           WHEN r.cancel_requested_at IS NULL
             AND (r.deadline_at IS NULL OR r.deadline_at > v_now)
             AND (r.attempt_timeout_at IS NULL OR r.attempt_timeout_at > v_now)
             AND r.expires_at > v_now THEN v_now
           ELSE r.heartbeat_at END,
         expires_at = CASE
           WHEN r.cancel_requested_at IS NULL
             AND (r.deadline_at IS NULL OR r.deadline_at > v_now)
             AND (r.attempt_timeout_at IS NULL OR r.attempt_timeout_at > v_now)
             AND r.expires_at > v_now
           THEN v_now + make_interval(secs => p_lease_ms::double precision / 1000.0)
           ELSE r.expires_at END,
         updated_at = CASE
           WHEN r.cancel_requested_at IS NULL
             AND (r.deadline_at IS NULL OR r.deadline_at > v_now)
             AND (r.attempt_timeout_at IS NULL OR r.attempt_timeout_at > v_now)
             AND r.expires_at > v_now THEN v_now
           ELSE r.updated_at END
   WHERE r.task_id = p_task_id AND r.state = 'active' AND r.worker_id = p_worker_id
     AND r.fence_token = p_fence_token
  RETURNING CASE
    WHEN r.cancel_requested_at IS NOT NULL THEN 'cancel_requested'
    WHEN r.deadline_at IS NOT NULL AND r.deadline_at <= v_now THEN 'deadline_exceeded'
    WHEN r.attempt_timeout_at IS NOT NULL AND r.attempt_timeout_at <= v_now THEN 'timeout_exceeded'
    WHEN r.expires_at <= v_now THEN 'stale'
    ELSE 'accepted'
  END INTO v_status;
  RETURN COALESCE(v_status, 'stale');
END;
$$;

CREATE OR REPLACE FUNCTION workhorse.retire_history_partitions_v1(
  p_parent text, p_before timestamptz, p_limit integer
) RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  v_partition record;
  v_count integer := 0;
  v_previous_lock_timeout text;
BEGIN
  IF p_parent NOT IN ('task_event', 'attempt_history') THEN
    RAISE EXCEPTION 'history parent must be task_event or attempt_history';
  END IF;
  IF p_before IS NULL OR NOT isfinite(p_before) THEN RAISE EXCEPTION 'retention cutoff is required'; END IF;
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 52 THEN RAISE EXCEPTION 'partition limit must be between 1 and 52'; END IF;

  FOR v_partition IN
    SELECT child_namespace.nspname AS schema_name, child.relname,
           ((regexp_match(
             pg_get_expr(child.relpartbound, child.oid),
             'TO \(''([^'']+)''\)'
           ))[1])::timestamptz AS upper_bound
      FROM pg_inherits inheritance
      JOIN pg_class parent ON parent.oid = inheritance.inhparent
      JOIN pg_namespace namespace ON namespace.oid = parent.relnamespace
      JOIN pg_class child ON child.oid = inheritance.inhrelid
      JOIN pg_namespace child_namespace ON child_namespace.oid = child.relnamespace
     WHERE namespace.nspname = 'workhorse'
       AND parent.relname = p_parent
       AND child.relname <> p_parent || '_default'
       AND ((regexp_match(
             pg_get_expr(child.relpartbound, child.oid),
             'TO \(''([^'']+)''\)'
           ))[1])::timestamptz <= p_before
       AND ((regexp_match(
             pg_get_expr(child.relpartbound, child.oid),
             'TO \(''([^'']+)''\)'
           ))[1])::timestamptz <= (
             date_trunc('day', clock_timestamp() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
           )
     ORDER BY upper_bound, child.relname
     LIMIT p_limit
  LOOP
    IF NOT pg_try_advisory_xact_lock(hashtextextended(
      'workhorse:history-day:' || ((v_partition.upper_bound AT TIME ZONE 'UTC')::date - 1),
      0
    )) THEN
      CONTINUE;
    END IF;
    v_previous_lock_timeout := current_setting('lock_timeout');
    PERFORM set_config('lock_timeout', '250ms', true);
    BEGIN
      EXECUTE format(
        'DROP TABLE IF EXISTS %I.%I', v_partition.schema_name, v_partition.relname
      );
      v_count := v_count + 1;
    EXCEPTION
      WHEN lock_not_available THEN NULL;
      WHEN OTHERS THEN
        PERFORM set_config('lock_timeout', v_previous_lock_timeout, true);
        RAISE;
    END;
    PERFORM set_config('lock_timeout', v_previous_lock_timeout, true);
  END LOOP;
  RETURN v_count;
END;
$$;

CREATE OR REPLACE FUNCTION workhorse.prune_default_history_v1(
  p_parent text, p_before timestamptz, p_limit integer
) RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE v_count integer;
BEGIN
  IF p_before IS NULL OR NOT isfinite(p_before) THEN RAISE EXCEPTION 'retention cutoff is required'; END IF;
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 1000000 THEN RAISE EXCEPTION 'row limit must be between 1 and 1000000'; END IF;
  IF p_parent = 'task_event' THEN
    WITH candidates AS (
      SELECT ctid FROM workhorse.task_event_default
       WHERE occurred_at < p_before ORDER BY occurred_at, event_id
       FOR UPDATE SKIP LOCKED LIMIT p_limit
    )
    DELETE FROM workhorse.task_event_default history USING candidates
     WHERE history.ctid = candidates.ctid;
  ELSIF p_parent = 'attempt_history' THEN
    WITH candidates AS (
      SELECT ctid FROM workhorse.attempt_history_default
       WHERE occurred_at < p_before ORDER BY occurred_at, attempt_id
       FOR UPDATE SKIP LOCKED LIMIT p_limit
    )
    DELETE FROM workhorse.attempt_history_default history USING candidates
     WHERE history.ctid = candidates.ctid;
  ELSE
    RAISE EXCEPTION 'history parent must be task_event or attempt_history';
  END IF;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

CREATE OR REPLACE FUNCTION workhorse.prune_terminal_tasks_v1(
  p_identity_before timestamptz, p_outcome_before timestamptz,
  p_history_before timestamptz, p_limit integer
) RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  v_count integer;
  v_fast_count integer;
  v_fast_before timestamptz := p_history_before;
BEGIN
  IF p_identity_before IS NULL OR p_outcome_before IS NULL OR p_history_before IS NULL
     OR NOT isfinite(p_identity_before) OR NOT isfinite(p_outcome_before)
     OR NOT isfinite(p_history_before) THEN
    RAISE EXCEPTION 'identity, outcome, and history cutoffs are required';
  END IF;
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100000 THEN RAISE EXCEPTION 'terminal task limit must be between 1 and 100000'; END IF;

  WITH candidate_window AS MATERIALIZED (
    SELECT task.id, outcome.finished_at
      FROM workhorse.task task
      JOIN workhorse.task_outcome outcome ON outcome.task_id = task.id
     WHERE task.created_at < p_identity_before
       AND outcome.finished_at < p_outcome_before
       AND outcome.history_through_at < p_history_before
       AND NOT EXISTS (SELECT 1 FROM workhorse.task_runtime runtime WHERE runtime.task_id = task.id)
       AND NOT EXISTS (SELECT 1 FROM workhorse.task_event event WHERE event.task_id = task.id)
       AND NOT EXISTS (
             SELECT 1 FROM workhorse.attempt_history attempt WHERE attempt.task_id = task.id
           )
     ORDER BY outcome.finished_at, task.id
     FOR UPDATE OF task SKIP LOCKED
     LIMIT LEAST(p_limit * 4, 100000)
  ), candidates AS (
    SELECT candidate.id
      FROM candidate_window candidate
     WHERE NOT EXISTS (
             SELECT 1 FROM workhorse.schedule_occurrence occurrence
              WHERE occurrence.task_id = candidate.id
           )
       AND NOT EXISTS (
             SELECT 1 FROM workhorse.enqueue_idempotency idempotency
              WHERE idempotency.task_id = candidate.id
           )
       AND NOT EXISTS (
             SELECT 1 FROM workhorse.task_redrive redrive
              WHERE redrive.source_task_id = candidate.id
           )
       AND NOT EXISTS (
             SELECT 1 FROM workhorse.task_dependency dependency
              WHERE dependency.prerequisite_task_id = candidate.id
           )
       AND NOT EXISTS (
             SELECT 1
               FROM workhorse.task_child edge
               JOIN workhorse.task child ON child.id = edge.child_task_id
               LEFT JOIN workhorse.task_outcome child_outcome
                 ON child_outcome.task_id = edge.child_task_id
              WHERE edge.parent_task_id = candidate.id
                AND (
                  child_outcome.task_id IS NULL
                  OR child.created_at >= p_identity_before
                  OR child_outcome.finished_at >= p_outcome_before
                  OR child_outcome.history_through_at >= p_history_before
                )
           )
     ORDER BY candidate.finished_at, candidate.id
     LIMIT p_limit
  ), deleted AS (
    DELETE FROM workhorse.task task USING candidates WHERE task.id = candidates.id
    RETURNING task.id
  ), result AS (
    SELECT count(*)::integer AS pruned,
           count(*) = 0 AND EXISTS (
             SELECT 1
               FROM candidate_window candidate
               JOIN workhorse.task_dependency dependency
                 ON dependency.prerequisite_task_id = candidate.id
           ) AS dependency_starved
      FROM deleted
  ), recorded AS (
    UPDATE workhorse.maintenance_state state
       SET terminal_prune_dependency_starved = result.dependency_starved,
           updated_at = clock_timestamp()
      FROM result
     WHERE state.routine_name = 'terminal_storage'
    RETURNING result.pruned
  )
  SELECT pruned INTO STRICT v_count FROM recorded;

  -- Fast-tier outcomes share the batch. No fast task is a prerequisite or a child, and its history
  -- rows exist only when the queue opted in, so their absence stands in for history_through_at.
  -- The outcome row is the task's archived history, so while cold export is on it also waits for
  -- the fast_task_outcome export to pass its close time.
  IF EXISTS (SELECT 1 FROM workhorse.cold_export_policy policy WHERE policy.singleton AND policy.enabled) THEN
    SELECT LEAST(v_fast_before, COALESCE(
             (SELECT exported.exported_through FROM workhorse.cold_export_dataset exported
               WHERE exported.dataset = 'fast_task_outcome'),
             timestamp '2000-01-01' AT TIME ZONE 'UTC'))
      INTO v_fast_before;
  END IF;
  IF v_count < p_limit THEN
    WITH candidates AS MATERIALIZED (
      SELECT task.id
        FROM workhorse.fast_task_outcome outcome
        JOIN workhorse.task task ON task.id = outcome.task_id
       WHERE outcome.finished_at < p_outcome_before
         AND outcome.finished_at < v_fast_before
         AND task.created_at < p_identity_before
         AND NOT EXISTS (SELECT 1 FROM workhorse.task_event event WHERE event.task_id = task.id)
         AND NOT EXISTS (
               SELECT 1 FROM workhorse.attempt_history attempt WHERE attempt.task_id = task.id
             )
         AND NOT EXISTS (
               SELECT 1 FROM workhorse.schedule_occurrence occurrence
                WHERE occurrence.task_id = task.id
             )
         AND NOT EXISTS (
               SELECT 1 FROM workhorse.enqueue_idempotency idempotency
                WHERE idempotency.task_id = task.id
             )
         AND NOT EXISTS (
               SELECT 1 FROM workhorse.task_redrive redrive
                WHERE redrive.source_task_id = task.id
             )
       ORDER BY outcome.finished_at, outcome.task_id
       FOR UPDATE OF task SKIP LOCKED
       LIMIT p_limit - v_count
    )
    DELETE FROM workhorse.task task USING candidates WHERE task.id = candidates.id;
    GET DIAGNOSTICS v_fast_count = ROW_COUNT;
    v_count := v_count + v_fast_count;
  END IF;
  RETURN v_count;
END;
$$;

CREATE OR REPLACE FUNCTION workhorse.prune_released_dependencies_v1(p_limit integer)
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE v_count integer;
BEGIN
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100000 THEN
    RAISE EXCEPTION 'released dependency limit must be between 1 and 100000';
  END IF;
  WITH candidates AS MATERIALIZED (
    SELECT dependency.dependent_task_id, dependency.prerequisite_task_id
      FROM workhorse.task_dependency dependency
      JOIN workhorse.task_outcome outcome ON outcome.task_id = dependency.dependent_task_id
     WHERE dependency.released_at IS NOT NULL
     ORDER BY dependency.released_at,
              dependency.dependent_task_id,
              dependency.prerequisite_task_id
       FOR UPDATE OF dependency SKIP LOCKED
     LIMIT p_limit
  )
  DELETE FROM workhorse.task_dependency dependency USING candidates
   WHERE dependency.dependent_task_id = candidates.dependent_task_id
     AND dependency.prerequisite_task_id = candidates.prerequisite_task_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

CREATE OR REPLACE FUNCTION workhorse.prune_enqueue_idempotency_v1(
  p_before timestamptz, p_limit integer
) RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE v_count integer;
DECLARE v_purge_count integer := 0;
DECLARE v_purge_retention_days integer;
BEGIN
  IF p_before IS NULL OR NOT isfinite(p_before) THEN
    RAISE EXCEPTION 'idempotency cutoff is required';
  END IF;
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100000 THEN
    RAISE EXCEPTION 'idempotency prune limit must be between 1 and 100000';
  END IF;
  WITH candidates AS MATERIALIZED (
    SELECT idempotency_scope, idempotency_key_hash
      FROM workhorse.enqueue_idempotency
     WHERE expires_at <= p_before
     ORDER BY expires_at, idempotency_scope, idempotency_key_hash
     FOR UPDATE SKIP LOCKED
     LIMIT p_limit
  )
  DELETE FROM workhorse.enqueue_idempotency idempotency USING candidates
   WHERE idempotency.idempotency_scope = candidates.idempotency_scope
     AND idempotency.idempotency_key_hash = candidates.idempotency_key_hash;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  SELECT task_identity_retention_days INTO v_purge_retention_days
    FROM workhorse.retention_policy WHERE singleton;
  IF v_purge_retention_days IS NOT NULL THEN
    WITH candidates AS MATERIALIZED (
      SELECT request_id_hash
        FROM workhorse.queue_purge_request
       WHERE requested_at < p_before - make_interval(days => v_purge_retention_days)
       ORDER BY requested_at, request_id_hash
       FOR UPDATE SKIP LOCKED
       LIMIT p_limit
    )
    DELETE FROM workhorse.queue_purge_request request USING candidates
     WHERE request.request_id_hash = candidates.request_id_hash;
    GET DIAGNOSTICS v_purge_count = ROW_COUNT;
  END IF;
  RETURN v_count + v_purge_count;
END;
$$;

CREATE OR REPLACE FUNCTION workhorse.rollup_stats_v1(
  p_force boolean DEFAULT false,
  p_now timestamptz DEFAULT clock_timestamp(),
  p_max_buckets integer DEFAULT 240
) RETURNS TABLE (
  phase text, rows_affected integer, duration_ms integer, skipped_lock boolean, error jsonb
)
LANGUAGE plpgsql
AS $$
DECLARE v_started_at timestamptz;
DECLARE v_state workhorse.task_stat_state%ROWTYPE;
DECLARE v_policy workhorse.retention_policy%ROWTYPE;
DECLARE v_maintenance workhorse.maintenance_policy%ROWTYPE;
DECLARE v_from timestamptz;
DECLARE v_to timestamptz;
DECLARE v_closed timestamptz;
DECLARE v_hour_from timestamptz;
DECLARE v_hour_to timestamptz;
DECLARE v_day_from timestamptz;
DECLARE v_day_to timestamptz;
DECLARE v_inserted integer; BEGIN
  IF p_now IS NULL OR NOT isfinite(p_now) THEN RAISE EXCEPTION 'maintenance time is required'; END IF;
  IF p_max_buckets IS NULL OR p_max_buckets NOT BETWEEN 1 AND 100000 THEN
    RAISE EXCEPTION 'bucket limit must be between 1 and 100000';
  END IF;
  IF NOT pg_try_advisory_xact_lock(hashtextextended('workhorse:maintenance:stat-rollup', 0)) THEN
    RETURN QUERY VALUES
      ('stat_rollup'::text, 0, 0, true, NULL::jsonb),
      ('stat_retention'::text, 0, 0, true, NULL::jsonb);
    RETURN;
  END IF;
  SELECT * INTO STRICT v_maintenance FROM workhorse.maintenance_policy WHERE singleton;
  SELECT * INTO STRICT v_state FROM workhorse.task_stat_state WHERE singleton FOR UPDATE;
  SELECT * INTO STRICT v_policy FROM workhorse.retention_policy WHERE singleton;
  -- The cadence, recompute window, and group limit are maintenance policy, not caller options:
  -- a fleet shares one statistics contract, and a zero interval opts the whole fleet out while
  -- holding history retention at the current watermark. Force bypasses the cadence gate only.
  IF NOT p_force AND (
    v_maintenance.statistics_rollup_interval_ms = 0
    OR (v_state.last_run_at IS NOT NULL AND v_state.last_run_at > p_now - make_interval(
      secs => v_maintenance.statistics_rollup_interval_ms / 1000.0
    ))
  ) THEN
    RETURN;
  END IF;

  phase := 'stat_rollup';
  rows_affected := 0;
  skipped_lock := false;
  error := NULL;
  v_started_at := clock_timestamp(); BEGIN
    v_closed := date_bin('1 minute', p_now, timestamp '2000-01-01' AT TIME ZONE 'UTC');
    v_from := LEAST(
      v_state.rolled_up_through
        - make_interval(mins => v_maintenance.statistics_recompute_buckets),
      v_closed
    );
    -- Catching up after an outage advances in bounded passes rather than in one long transaction.
    v_to := LEAST(v_closed, v_from + make_interval(mins => p_max_buckets));
    IF v_to > v_from THEN
      DELETE FROM workhorse.task_stat_bucket
       WHERE bucket_start >= v_from AND bucket_start < v_to;
      INSERT INTO workhorse.task_stat_bucket (
        bucket_start, queue_name, task_type, enqueued,
        task_succeeded, task_failed, task_canceled,
        attempt_succeeded, attempt_failed, attempt_retry,
        attempt_lease_expired, attempt_canceled, attempt_other,
        attempt_duration_ms, wait_sketch, last_attempt_at, last_error, last_error_at
      )
      SELECT * FROM workhorse.aggregate_stats_v1(v_from, v_to, v_maintenance.statistics_group_limit);
      GET DIAGNOSTICS rows_affected = ROW_COUNT;

      v_hour_from := LEAST(
        v_state.hourly_rolled_up_through,
        date_bin('1 hour', v_from, timestamp '2000-01-01' AT TIME ZONE 'UTC')
      );
      v_hour_to := date_bin('1 hour', v_to, timestamp '2000-01-01' AT TIME ZONE 'UTC');
      IF v_hour_to > v_hour_from THEN
        DELETE FROM workhorse.task_stat_bucket_hour
         WHERE bucket_start >= v_hour_from AND bucket_start < v_hour_to;
        INSERT INTO workhorse.task_stat_bucket_hour (
          bucket_start, queue_name, task_type, enqueued,
          task_succeeded, task_failed, task_canceled,
          attempt_succeeded, attempt_failed, attempt_retry,
          attempt_lease_expired, attempt_canceled, attempt_other,
          attempt_duration_ms, wait_sketch, last_attempt_at, last_error, last_error_at
        )
        SELECT date_bin('1 hour', bucket.bucket_start,
                        timestamp '2000-01-01' AT TIME ZONE 'UTC'),
               bucket.queue_name, bucket.task_type,
               sum(bucket.enqueued), sum(bucket.task_succeeded), sum(bucket.task_failed),
               sum(bucket.task_canceled), sum(bucket.attempt_succeeded),
               sum(bucket.attempt_failed), sum(bucket.attempt_retry),
               sum(bucket.attempt_lease_expired), sum(bucket.attempt_canceled),
               sum(bucket.attempt_other), sum(bucket.attempt_duration_ms),
               workhorse.stat_sketch_merge_v1(array_agg(bucket.wait_sketch)),
               max(bucket.last_attempt_at),
               (array_agg(bucket.last_error ORDER BY bucket.last_error_at DESC NULLS LAST)
                 FILTER (WHERE bucket.last_error IS NOT NULL))[1],
               max(bucket.last_error_at)
          FROM workhorse.task_stat_bucket bucket
         WHERE bucket.bucket_start >= v_hour_from AND bucket.bucket_start < v_hour_to
         GROUP BY 1, 2, 3;
        GET DIAGNOSTICS v_inserted = ROW_COUNT;
        rows_affected := rows_affected + v_inserted;
      ELSE
        v_hour_to := v_state.hourly_rolled_up_through;
      END IF;

      v_day_from := LEAST(
        v_state.daily_rolled_up_through,
        date_bin('1 day', v_hour_from, timestamp '2000-01-01' AT TIME ZONE 'UTC')
      );
      v_day_to := date_bin('1 day', v_hour_to, timestamp '2000-01-01' AT TIME ZONE 'UTC');
      IF v_day_to > v_day_from THEN
        DELETE FROM workhorse.task_stat_bucket_day
         WHERE bucket_start >= v_day_from AND bucket_start < v_day_to;
        INSERT INTO workhorse.task_stat_bucket_day (
          bucket_start, queue_name, task_type, enqueued,
          task_succeeded, task_failed, task_canceled,
          attempt_succeeded, attempt_failed, attempt_retry,
          attempt_lease_expired, attempt_canceled, attempt_other,
          attempt_duration_ms, wait_sketch, last_attempt_at, last_error, last_error_at
        )
        SELECT date_bin('1 day', bucket.bucket_start,
                        timestamp '2000-01-01' AT TIME ZONE 'UTC'),
               bucket.queue_name, bucket.task_type,
               sum(bucket.enqueued), sum(bucket.task_succeeded), sum(bucket.task_failed),
               sum(bucket.task_canceled), sum(bucket.attempt_succeeded),
               sum(bucket.attempt_failed), sum(bucket.attempt_retry),
               sum(bucket.attempt_lease_expired), sum(bucket.attempt_canceled),
               sum(bucket.attempt_other), sum(bucket.attempt_duration_ms),
               workhorse.stat_sketch_merge_v1(array_agg(bucket.wait_sketch)),
               max(bucket.last_attempt_at),
               (array_agg(bucket.last_error ORDER BY bucket.last_error_at DESC NULLS LAST)
                 FILTER (WHERE bucket.last_error IS NOT NULL))[1],
               max(bucket.last_error_at)
          FROM workhorse.task_stat_bucket_hour bucket
         WHERE bucket.bucket_start >= v_day_from AND bucket.bucket_start < v_day_to
         GROUP BY 1, 2, 3;
        GET DIAGNOSTICS v_inserted = ROW_COUNT;
        rows_affected := rows_affected + v_inserted;
      ELSE
        v_day_to := v_state.daily_rolled_up_through;
      END IF;

      UPDATE workhorse.task_stat_state
         SET rolled_up_through = v_to,
             hourly_rolled_up_through = GREATEST(hourly_rolled_up_through, v_hour_to),
             daily_rolled_up_through = GREATEST(daily_rolled_up_through, v_day_to),
             last_run_at = p_now, updated_at = clock_timestamp()
       WHERE singleton;
    ELSE
      UPDATE workhorse.task_stat_state
         SET last_run_at = p_now, updated_at = clock_timestamp()
       WHERE singleton;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    error := jsonb_build_object('code', SQLSTATE, 'message', SQLERRM);
  END;
  duration_ms := GREATEST(
    0, round(extract(epoch FROM clock_timestamp() - v_started_at) * 1000)::integer
  );
  RETURN NEXT;

  -- Bucket retention is bounded per pass like every other retained category. Shortening the policy
  -- makes the next pass eligible to delete months of buckets at once, and an unbounded statement
  -- there would hold a long lock on the relation every operator window reads.
  phase := 'stat_retention';
  rows_affected := 0;
  error := NULL;
  v_started_at := clock_timestamp(); BEGIN
    WITH expired AS (
      SELECT bucket.ctid
        FROM workhorse.task_stat_bucket bucket
       WHERE bucket.bucket_start < p_now - make_interval(
         days => LEAST(COALESCE(v_policy.statistics_retention_days, 2), 2)
       )
       ORDER BY bucket.bucket_start
         FOR UPDATE SKIP LOCKED
       LIMIT v_policy.statistics_rows_per_pass
    )
    DELETE FROM workhorse.task_stat_bucket bucket USING expired
     WHERE bucket.ctid = expired.ctid;
    GET DIAGNOSTICS rows_affected = ROW_COUNT;

    WITH expired AS (
      SELECT bucket.ctid
        FROM workhorse.task_stat_bucket_hour bucket
       WHERE bucket.bucket_start < p_now - make_interval(
         days => LEAST(COALESCE(v_policy.statistics_retention_days, 90), 90)
       )
       ORDER BY bucket.bucket_start
         FOR UPDATE SKIP LOCKED
       LIMIT v_policy.statistics_rows_per_pass
    )
    DELETE FROM workhorse.task_stat_bucket_hour bucket USING expired
     WHERE bucket.ctid = expired.ctid;
    GET DIAGNOSTICS v_inserted = ROW_COUNT;
    rows_affected := rows_affected + v_inserted;

    IF v_policy.statistics_retention_days IS NOT NULL THEN
      WITH expired AS (
        SELECT bucket.ctid
          FROM workhorse.task_stat_bucket_day bucket
         WHERE bucket.bucket_start < p_now
               - make_interval(days => v_policy.statistics_retention_days)
         ORDER BY bucket.bucket_start
           FOR UPDATE SKIP LOCKED
         LIMIT v_policy.statistics_rows_per_pass
      )
      DELETE FROM workhorse.task_stat_bucket_day bucket USING expired
       WHERE bucket.ctid = expired.ctid;
      GET DIAGNOSTICS v_inserted = ROW_COUNT;
      rows_affected := rows_affected + v_inserted;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    error := jsonb_build_object('code', SQLSTATE, 'message', SQLERRM);
  END;
  duration_ms := GREATEST(
    0, round(extract(epoch FROM clock_timestamp() - v_started_at) * 1000)::integer
  );
  RETURN NEXT;
END;
$$;
