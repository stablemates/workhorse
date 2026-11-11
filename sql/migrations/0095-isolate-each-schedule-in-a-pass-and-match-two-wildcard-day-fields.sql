-- workhorse-migration: {"kind":"additive"}

-- Isolate each schedule definition in a schedule pass, refuse a definition that its fast-tier queue
-- cannot enqueue, and match each day when both day fields of a cron expression are wildcards.
--
-- fire_due_schedules_v2 evaluated every definition of the offered namespaces in one statement. If
-- one enqueue raised an error, the statement rolled back the fires and the positions of each
-- definition. No schedule of those namespaces fired, and the TypeScript and Go workers ended their
-- run. For example, a definition with a concurrency key on a fast-tier queue failed each pass. A
-- stored definition with a queue name above 256 UTF-8 bytes, which migration 0094 refuses at the
-- enqueue, failed each pass in the same way. The pass now runs each definition in a
-- subtransaction. If a definition raises an error, its fires and its occurrence locks roll back,
-- and the pass continues with the next definition. The pass writes the evaluation time, the
-- SQLSTATE, and the message to three new nullable columns: last_error_at, last_error_code, and
-- last_error_message. The position of that definition does not change. A later pass that moves the
-- position sets the three columns to null. An error of SQLSTATE class 40 or 57 still ends the pass.
--
-- sync_schedule_definitions_internal_v1 now refuses an enabled definition with a concurrency key
-- when its queue is on the fast tier now. The refusal is the SQLSTATE P1007 error of the enqueue.
-- A tier change after the synchronization is possible, and the pass then records the error.
--
-- cron_occurrences_v1 used only the day-of-week values when the day-of-month field was a wildcard.
-- A lone `?` in the day-of-week field adds no value, so `0 12 * * ?` matched no day, and its
-- synchronization failed at the 128-year horizon. If both day fields are wildcards, each day now
-- matches. The synchronization refused each such expression, so no stored definition changes.
--
-- dashboard_schedule_definition_v1 appends the three columns, and dashboard_cron_v1 returns them as
-- lastErrorAt, lastErrorCode, and lastErrorMessage on each application schedule.
--
-- Each function keeps its name, its arguments, and its result type under ADR 0109, and the view only
-- appends columns. The new columns have no default, so the migration rewrites no row. The SDK
-- floor does not change.

ALTER TABLE workhorse.schedule_definition
  ADD COLUMN IF NOT EXISTS last_error_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_error_code text,
  ADD COLUMN IF NOT EXISTS last_error_message text;

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
  v_horizon_date date;
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
  v_now_second timestamptz := date_trunc('second', p_now);
  v_lower_wall timestamp;
  v_upper_wall timestamp;
  v_day_lower numeric;
  v_day_upper numeric;
  v_hour_second integer;
  v_minute_second integer;
  v_day_second integer;
  v_candidates timestamptz[] := '{}';
  v_candidate_count integer := 0;
  v_normalized_count integer := 0;
  v_resolved_count integer := 0;
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
  v_horizon_date := (v_end_date - interval '128 years')::date;

  -- Bound the wall-clock times that can resolve inside the window. A resolved instant equals its
  -- wall-clock time minus a UTC offset of the zone. That offset is in effect at the instant, or
  -- just before a daylight-saving gap that the wall-clock time falls into. Offsets stay within
  -- 16 hours of UTC, and a gap is shorter than 32 hours. Thus only the offsets near the two ends of
  -- the window can move a wall-clock time across an end. The probes are 8 hours apart and include
  -- both ends of each range, so they see every offset that stays in effect for 8 hours or more.
  -- The lower probes stop at now, because a later instant fails the window test. The bound only
  -- skips wall-clock times whose instants fail the window test below, so the result does not
  -- change. A position before the horizon needs no lower bound, because the walk starts at the
  -- horizon. A position after the end date needs none either, because the walk visits no day.
  IF isfinite(p_now) THEN
    SELECT (v_now_second AT TIME ZONE 'UTC') + max(
             (probe.instant AT TIME ZONE p_timezone) - (probe.instant AT TIME ZONE 'UTC')
           )
      INTO v_upper_wall
      FROM generate_series(-64, 0, 8) probe_hours
      CROSS JOIN LATERAL (
        SELECT v_now_second + make_interval(hours => probe_hours) AS instant
      ) probe;
  END IF;
  IF isfinite(p_last_occurrence_at)
     AND (p_last_occurrence_at AT TIME ZONE p_timezone)::date
       BETWEEN v_horizon_date AND v_end_date THEN
    SELECT (p_last_occurrence_at AT TIME ZONE 'UTC') + min(
             (probe.instant AT TIME ZONE p_timezone) - (probe.instant AT TIME ZONE 'UTC')
           )
      INTO v_lower_wall
      FROM generate_series(-32, 32, 8) probe_hours
      CROSS JOIN LATERAL (
        SELECT p_last_occurrence_at + LEAST(
                 make_interval(hours => probe_hours),
                 v_now_second - p_last_occurrence_at
               ) AS instant
      ) probe;
  END IF;

  IF p_last_occurrence_at IS NULL THEN
    v_start_date := v_horizon_date;
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
      -- A lone `?` adds no value to its field. Thus, if both day fields are wildcards, each day
      -- matches without a value test (SM-1947).
      v_day_match := CASE WHEN v_dom_wildcard AND v_dow_wildcard THEN true
        WHEN v_dom_wildcard THEN v_dow_match
        WHEN v_dow_wildcard THEN v_dom_match ELSE v_dom_match OR v_dow_match END;
      IF NOT v_day_match THEN CONTINUE; END IF;
      v_day_upper := COALESCE(extract(epoch FROM v_upper_wall - v_date::timestamp), 86400);
      FOR v_hour_index IN REVERSE array_upper(v_hours, 1)..array_lower(v_hours, 1) LOOP
        v_hour := v_hours[v_hour_index];
        v_hour_second := v_hour * 3600;
        CONTINUE WHEN v_hour_second > v_day_upper;
        FOR v_minute_index IN REVERSE array_upper(v_minutes, 1)..array_lower(v_minutes, 1) LOOP
          v_minute := v_minutes[v_minute_index];
          v_minute_second := v_hour_second + v_minute * 60;
          CONTINUE WHEN v_minute_second > v_day_upper;
          FOR v_second_index IN REVERSE array_upper(v_seconds, 1)..array_lower(v_seconds, 1) LOOP
            v_second := v_seconds[v_second_index];
            v_day_second := v_minute_second + v_second;
            CONTINUE WHEN v_day_second > v_day_upper;
            v_wall := v_date + make_interval(secs => v_day_second);
            v_occurrence := workhorse.resolve_cron_wall_clock_v1(v_wall, p_timezone);
            v_resolved_count := v_resolved_count + 1;
            IF v_occurrence <= v_now_second THEN
              RAISE DEBUG 'cron_occurrences_v1 resolved % wall-clock times', v_resolved_count;
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

  v_start_date := GREATEST((p_last_occurrence_at AT TIME ZONE p_timezone)::date, v_horizon_date);
  <<walk>>
  FOR v_day_offset IN 0..(v_end_date - v_start_date) LOOP
    v_date := v_start_date + v_day_offset;
    EXIT walk WHEN v_date::timestamp > v_upper_wall;
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
    v_day_match := CASE WHEN v_dom_wildcard AND v_dow_wildcard THEN true
      WHEN v_dom_wildcard THEN v_dow_match
      WHEN v_dow_wildcard THEN v_dom_match ELSE v_dom_match OR v_dow_match END;
    IF NOT v_day_match THEN CONTINUE; END IF;
    v_day_lower :=COALESCE(extract(epoch FROM v_lower_wall - v_date::timestamp), -1);
    v_day_upper := COALESCE(extract(epoch FROM v_upper_wall - v_date::timestamp), 86400);
    FOREACH v_hour IN ARRAY v_hours LOOP
      v_hour_second := v_hour * 3600;
      CONTINUE WHEN v_hour_second + 3599 < v_day_lower;
      EXIT walk WHEN v_hour_second > v_day_upper;
      FOREACH v_minute IN ARRAY v_minutes LOOP
        v_minute_second := v_hour_second + v_minute * 60;
        CONTINUE WHEN v_minute_second + 59 < v_day_lower;
        EXIT walk WHEN v_minute_second > v_day_upper;
        FOREACH v_second IN ARRAY v_seconds LOOP
          v_day_second := v_minute_second + v_second;
          CONTINUE WHEN v_day_second < v_day_lower;
          EXIT walk WHEN v_day_second > v_day_upper;
          v_wall := v_date + make_interval(secs => v_day_second);
          v_occurrence := workhorse.resolve_cron_wall_clock_v1(v_wall, p_timezone);
          v_resolved_count := v_resolved_count + 1;
          IF v_occurrence > p_last_occurrence_at AND v_occurrence <= v_now_second THEN
            v_candidates := array_append(v_candidates, v_occurrence);
            v_candidate_count := v_candidate_count + 1;
            -- Only a wall-clock time in a gap can share its instant with another wall-clock
            -- time, so each duplicate needs one normalized candidate. When the candidates
            -- without one reach the limit, the distinct instants reach it too.
            IF v_occurrence AT TIME ZONE p_timezone <> v_wall THEN
              v_normalized_count := v_normalized_count + 1;
            END IF;
            EXIT walk WHEN v_candidate_count - v_normalized_count >= p_limit;
          END IF;
        END LOOP;
      END LOOP;
    END LOOP;
  END LOOP;

  RAISE DEBUG 'cron_occurrences_v1 resolved % wall-clock times', v_resolved_count;
  -- Keep the first position of each instant, as a set operation, and return the instants in
  -- wall-clock order.
  RETURN QUERY
    SELECT candidate.instant
      FROM unnest(v_candidates) WITH ORDINALITY candidate(instant, ordinal)
     GROUP BY candidate.instant
     ORDER BY min(candidate.ordinal)
     LIMIT p_limit;
END;
$$;

CREATE OR REPLACE FUNCTION workhorse.sync_schedule_definitions_internal_v1(
  p_namespace text, p_definitions jsonb, p_prune boolean DEFAULT true
) RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  IF COALESCE(p_namespace, '') = '' THEN RAISE EXCEPTION 'namespace must not be empty'; END IF;
  IF p_definitions IS NULL OR jsonb_typeof(p_definitions) <> 'array' THEN
    RAISE EXCEPTION 'schedule definitions must be a JSON array';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_definitions) definition
     WHERE COALESCE(definition->>'name', '') = ''
        OR COALESCE(definition->>'schedule', '') = ''
        OR COALESCE(definition->>'queue', '') = ''
        OR COALESCE(definition->>'type', '') = ''
        OR COALESCE((definition->>'maxAttempts')::integer, 25) NOT BETWEEN 1 AND 100
        OR COALESCE((definition->>'priority')::numeric, 0) <> trunc(COALESCE((definition->>'priority')::numeric, 0))
        OR COALESCE((definition->>'priority')::numeric, 0) NOT BETWEEN 0 AND 100
        OR (definition->>'concurrencyKey' IS NOT NULL AND (
          definition->>'concurrencyKey' = '' OR octet_length(definition->>'concurrencyKey') > 256
        ))
  ) THEN
    RAISE EXCEPTION 'each schedule requires non-empty name/schedule/queue/type and maxAttempts between 1 and 100';
  END IF;
  -- Each fire enqueues through enqueue_batch_v1, which refuses a longer queue name. A pass of
  -- fire_due_schedules_v2 then fails for every schedule, so the deployment refuses the name here.
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_definitions) definition
     WHERE octet_length(definition->>'queue') > 256
  ) THEN
    RAISE EXCEPTION 'schedule queue name must contain at most 256 UTF-8 bytes';
  END IF;
  -- Each fire enqueues on the current tier of the queue. A concurrency key is the only fast-tier
  -- feature that a definition can carry, so an enabled definition with a key on a fast-tier queue
  -- fails each fire. The synchronization refuses it with the error of the enqueue (SM-1927). A tier
  -- change after the synchronization is possible, and the pass then records the error on the row.
  PERFORM workhorse.reject_fast_feature_v1(definition.value->>'queue', 'concurrency keys')
     FROM jsonb_array_elements(p_definitions) WITH ORDINALITY definition(value, ordinal)
     JOIN workhorse.queue_control control ON control.queue_name = definition.value->>'queue'
    WHERE control.tier = 'fast'
      AND definition.value->>'concurrencyKey' IS NOT NULL
      AND COALESCE((definition.value->>'enabled')::boolean, true)
    ORDER BY definition.ordinal
    LIMIT 1;
  IF EXISTS (
    SELECT 1
      FROM jsonb_array_elements(p_definitions) definition
     WHERE NOT EXISTS (
       SELECT 1 FROM pg_timezone_names timezone
        WHERE timezone.name = COALESCE(definition->>'timezone', 'UTC')
     )
  ) THEN
    RAISE EXCEPTION 'each schedule timezone must be a valid IANA timezone name';
  END IF;
  PERFORM workhorse.cron_occurrences_v1(
    definition->>'schedule', NULL, date_trunc('second', clock_timestamp()), 1,
    COALESCE(definition->>'timezone', 'UTC')
  ) FROM jsonb_array_elements(p_definitions) definition;
  PERFORM workhorse.normalize_retry_policy_v1(definition->'retryPolicy')
    FROM jsonb_array_elements(p_definitions) definition WHERE definition ? 'retryPolicy';
  IF (
    SELECT count(*) FROM jsonb_array_elements(p_definitions)
  ) <> (
    SELECT count(DISTINCT definition->>'name') FROM jsonb_array_elements(p_definitions) definition
  ) THEN
    RAISE EXCEPTION 'schedule names must be unique within a namespace';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('workhorse:schedules:' || p_namespace, 0));

  INSERT INTO workhorse.schedule_definition AS existing(
    namespace, schedule_name, cron_expression, timezone, queue_name, task_type, concurrency_key, priority, payload,
    contract_version, payload_max_bytes, result_max_bytes, payload_redact_keys, result_redact_keys,
    max_attempts, retry_policy, configured_enabled
  )
  SELECT p_namespace, definition->>'name', definition->>'schedule',
         COALESCE(definition->>'timezone', 'UTC'), definition->>'queue',
         definition->>'type', definition->>'concurrencyKey',
         COALESCE((definition->>'priority')::integer, 0),
         COALESCE(definition->'payload', 'null'::jsonb),
         definition->>'contractVersion',
         COALESCE((definition->>'payloadMaxBytes')::integer, 1048576),
         COALESCE((definition->>'resultMaxBytes')::integer, 1048576),
         ARRAY(SELECT redact_key FROM jsonb_array_elements_text(
           COALESCE(definition->'sensitivePayloadKeys', '[]'::jsonb)
         ) AS payload_keys(redact_key) ORDER BY redact_key COLLATE "C"),
         ARRAY(SELECT redact_key FROM jsonb_array_elements_text(
           COALESCE(definition->'sensitiveResultKeys', '[]'::jsonb)
         ) AS result_keys(redact_key) ORDER BY redact_key COLLATE "C"),
         COALESCE((definition->>'maxAttempts')::integer, 25),
         workhorse.normalize_retry_policy_v1(definition->'retryPolicy'),
         COALESCE((definition->>'enabled')::boolean, true)
    FROM jsonb_array_elements(p_definitions) definition
  ON CONFLICT (namespace, schedule_name) DO UPDATE
    SET revision = existing.revision + CASE WHEN ROW(
          existing.cron_expression, existing.timezone, existing.queue_name, existing.task_type,
          existing.concurrency_key, existing.priority, existing.payload,
          existing.contract_version, existing.payload_max_bytes, existing.result_max_bytes,
          existing.payload_redact_keys, existing.result_redact_keys,
          existing.max_attempts, existing.retry_policy, existing.configured_enabled
        ) IS DISTINCT FROM ROW(
          EXCLUDED.cron_expression, EXCLUDED.timezone, EXCLUDED.queue_name, EXCLUDED.task_type,
          EXCLUDED.concurrency_key, EXCLUDED.priority, EXCLUDED.payload,
          EXCLUDED.contract_version, EXCLUDED.payload_max_bytes, EXCLUDED.result_max_bytes,
          EXCLUDED.payload_redact_keys, EXCLUDED.result_redact_keys,
          EXCLUDED.max_attempts, EXCLUDED.retry_policy, EXCLUDED.configured_enabled
        ) THEN 1 ELSE 0 END,
        cron_expression = EXCLUDED.cron_expression,
        timezone = EXCLUDED.timezone,
        queue_name = EXCLUDED.queue_name,
        task_type = EXCLUDED.task_type,
        concurrency_key = EXCLUDED.concurrency_key,
        priority = EXCLUDED.priority,
        payload = EXCLUDED.payload,
        contract_version = EXCLUDED.contract_version,
        payload_max_bytes = EXCLUDED.payload_max_bytes,
        result_max_bytes = EXCLUDED.result_max_bytes,
        payload_redact_keys = EXCLUDED.payload_redact_keys,
        result_redact_keys = EXCLUDED.result_redact_keys,
        max_attempts = EXCLUDED.max_attempts,
        retry_policy = EXCLUDED.retry_policy,
        configured_enabled = EXCLUDED.configured_enabled,
        updated_at = clock_timestamp();

  IF p_prune THEN
    UPDATE workhorse.schedule_definition definition
       SET configured_enabled = false, revision = definition.revision + 1, updated_at = clock_timestamp()
     WHERE definition.namespace = p_namespace
       AND definition.configured_enabled
       AND NOT EXISTS (
         SELECT 1 FROM jsonb_array_elements(p_definitions) desired
          WHERE desired->>'name' = definition.schedule_name
       );
  END IF;
END;
$$;

-- Fire the due occurrences of every enabled schedule in the offered namespaces. The pass takes the
-- namespace locks first, so a pass that loses a namespace reads none of its occurrence history
-- (SM-1647). Each definition then continues from its durable position. `skip` fires each occurrence
-- that is not older than the supported delay, GREATEST(60 s, 2 x evaluation window), and records
-- the older occurrences it skips on the definition row (SM-1644).
--
-- Each definition runs in a subtransaction, as each phase of tick_v1 does (SM-1927). If the
-- evaluation or a fire of one definition raises an error, its fires and its occurrence locks roll
-- back. The pass then records the error on the definition row, keeps its position, and continues
-- with the next definition. An error of SQLSTATE class 40 (a serialization failure or a deadlock)
-- or 57 (a cancel, a statement timeout, or a shutdown) ends the pass, as before. A row that
-- RETURN NEXT adds stays in the result after a rollback, so the pass collects the rows of a
-- definition and returns them only after its subtransaction ends without an error. The position
-- update stays outside the subtransaction, so a definition with no due occurrence writes in the
-- main transaction and its subtransaction gets no transaction ID.
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
  v_fired_occurrences timestamptz[];
  v_fired_task_ids uuid[];
  v_fired_index integer;
  v_error_code text;
  v_error_message text;
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
    v_skipped_count := 0;
    v_skipped_through := NULL;
    v_evaluated_count := 0;
    v_last_evaluated_at := NULL;
    v_deferred := false;
    v_fired_occurrences := '{}';
    v_fired_task_ids := '{}';
    v_error_code := NULL;
    v_error_message := NULL;

    BEGIN
      v_evaluation_start := GREATEST(
        v_definition.last_evaluated_at,
        v_definition.last_occurrence_at
      );
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
          'workhorse:schedule-occurrence:' || jsonb_build_array(
            v_definition.namespace,
            v_definition.schedule_name,
            extract(epoch FROM date_trunc('second', v_occurrence))::bigint
          )::text,
          0
        )) THEN
          v_deferred := true;
          EXIT;
        END IF;
        v_evaluated_count := v_evaluated_count + 1;
        v_last_evaluated_at := v_occurrence;
        v_fired_occurrences := array_append(v_fired_occurrences, v_occurrence);
        v_fired_task_ids := array_append(v_fired_task_ids, workhorse.fire_schedule_v1(
          v_definition.namespace,
          v_definition.schedule_name,
          v_definition.revision,
          v_occurrence
        ));
      END LOOP;
    EXCEPTION WHEN OTHERS THEN
      IF left(SQLSTATE, 2) IN ('40', '57') THEN
        RAISE;
      END IF;
      v_error_code := SQLSTATE;
      v_error_message := left(SQLERRM, 1000);
    END;

    IF v_error_code IS NOT NULL THEN
      -- The position and the skip record stay, so the next pass evaluates the same occurrences.
      -- The error can be a lock timeout on this row, which another fire holds. This update runs
      -- outside the subtransaction, so it must not wait: it skips a locked row, and a later pass
      -- records the error.
      UPDATE workhorse.schedule_definition definition
         SET last_error_at = p_now,
             last_error_code = v_error_code,
             last_error_message = v_error_message
       WHERE (definition.namespace, definition.schedule_name) IN (
         SELECT unlocked.namespace, unlocked.schedule_name
           FROM workhorse.schedule_definition unlocked
          WHERE unlocked.namespace = v_definition.namespace
            AND unlocked.schedule_name = v_definition.schedule_name
            AND unlocked.revision = v_definition.revision
            FOR UPDATE SKIP LOCKED
       );
      CONTINUE;
    END IF;

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
    -- A pass deferred before its first occurrence leaves the position, the skip record, and the
    -- error record alone, so it never waits on the row lock the transaction holding that
    -- occurrence already owns. The next pass records the same skip. The update runs outside the
    -- subtransaction, so it skips a row that another transaction locks. A fire in this pass already
    -- holds the row lock, so the update skips only a definition that fired nothing, and the next
    -- pass evaluates the same occurrences.
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
             END,
             last_error_at = NULL,
             last_error_code = NULL,
             last_error_message = NULL
       WHERE (definition.namespace, definition.schedule_name) IN (
         SELECT unlocked.namespace, unlocked.schedule_name
           FROM workhorse.schedule_definition unlocked
          WHERE unlocked.namespace = v_definition.namespace
            AND unlocked.schedule_name = v_definition.schedule_name
            AND unlocked.revision = v_definition.revision
            FOR UPDATE SKIP LOCKED
       );
    END IF;

    FOR v_fired_index IN 1..cardinality(v_fired_occurrences) LOOP
      namespace := v_definition.namespace;
      schedule_name := v_definition.schedule_name;
      occurrence_at := v_fired_occurrences[v_fired_index];
      task_id := v_fired_task_ids[v_fired_index];
      RETURN NEXT;
    END LOOP;
  END LOOP;
END;
$$;

CREATE OR REPLACE VIEW workhorse.dashboard_schedule_definition_v1 AS
  SELECT namespace, schedule_name, cron_expression, timezone, queue_name, task_type,
         configured_enabled, paused, paused_by, paused_reason, paused_at, revision,
         updated_at, priority, catchup_policy, last_skipped_at, last_skipped_count,
         last_skipped_through, last_error_at, last_error_code, last_error_message
    FROM workhorse.schedule_definition;

-- The planner estimates one schedule as 1 / n_distinct(schedule_name) of schedule_occurrence. With
-- few schedules, some scans then look cheap: a sequential scan, a bitmap scan, or a scan of
-- schedule_occurrence_retention_idx in time order. Each of them reads the rows of every schedule
-- (SM-1866). The settings remove the first two, and the occurrence reads below remove the third.
-- The worker registry count still needs a sequential scan. On PostgreSQL 15 through 17, its
-- disabled cost would start JIT compilation on each poll, so jit is off too.
CREATE OR REPLACE FUNCTION workhorse.dashboard_cron_v1(p_input jsonb)
RETURNS jsonb
LANGUAGE sql
SET jit = off
SET enable_seqscan = off
SET enable_bitmapscan = off
AS $$
  -- The page lists 50 schedules. Each listed schedule then reads at most 1,001 occurrences for its
  -- count and one occurrence for its last fire, so a busy schedule cannot make the poll read every
  -- retained occurrence (SM-1866).
  WITH listed AS (
    SELECT definition.namespace, definition.schedule_name, definition.cron_expression,
           definition.queue_name, definition.task_type, definition.priority,
           definition.catchup_policy,
           definition.configured_enabled, definition.paused, definition.paused_by,
           definition.paused_reason, definition.paused_at,
           definition.revision, definition.updated_at,
           definition.last_skipped_at, definition.last_skipped_count,
           definition.last_skipped_through,
           definition.last_error_at, definition.last_error_code, definition.last_error_message
      FROM workhorse.dashboard_schedule_definition_v1 definition
     ORDER BY definition.namespace, definition.schedule_name
     LIMIT 50
  ), schedule_rows AS (
    SELECT listed.*,
           counted.occurrence_count,
           latest.fired_at AS last_fired_at,
           (SELECT count(*)::integer
              FROM workhorse.dashboard_worker_registry_v1 registry
             WHERE listed.namespace = ANY(registry.schedule_namespaces)
               AND registry.last_heartbeat_at >= clock_timestamp() - interval '30 seconds')
             AS evaluator_count
      FROM listed
      -- The count has no sort order, so the planner builds no full scan of the retention index.
      -- Only an index that holds both schedule keys then serves the conditions.
      CROSS JOIN LATERAL (
        SELECT count(*)::integer AS occurrence_count
          FROM (
            SELECT 1 FROM workhorse.dashboard_schedule_occurrence_v1 occurrence
             WHERE occurrence.namespace = listed.namespace
               AND occurrence.schedule_name = listed.schedule_name
             LIMIT 1001
          ) bounded
      ) counted
      -- The newest occurrence usually carries the latest fire time. Two cases fire an older
      -- occurrence later: an evaluator fires in wall-clock order, which goes back in UTC across a
      -- daylight-saving gap, and a direct fire_schedule_v1 call can fire any second. Then
      -- lastFiredAt is earlier than the latest fire. The range condition keeps schedule_name in
      -- the sort order.
      -- An equality would drop it, and the retention index could then give the order. Only the
      -- primary key gives this order without a sort. The range follows the namespace equality, so
      -- it also bounds the scan when the schedule has no occurrence.
      LEFT JOIN LATERAL (
        SELECT occurrence.fired_at FROM workhorse.dashboard_schedule_occurrence_v1 occurrence
         WHERE occurrence.namespace = listed.namespace
           AND occurrence.schedule_name >= listed.schedule_name
           AND occurrence.schedule_name <= listed.schedule_name
         ORDER BY occurrence.schedule_name DESC, occurrence.occurrence_at DESC
         LIMIT 1
      ) latest ON true
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
      'occurrenceCount', LEAST(occurrence_count, 1000),
      'lastFiredAt', workhorse.dashboard_iso_v1(last_fired_at),
      'evaluatorCount', evaluator_count,
      'lastSkippedAt', workhorse.dashboard_iso_v1(last_skipped_at),
      'lastSkippedCount', last_skipped_count,
      'lastSkippedThrough', workhorse.dashboard_iso_v1(last_skipped_through),
      'lastErrorAt', workhorse.dashboard_iso_v1(last_error_at),
      'lastErrorCode', last_error_code,
      'lastErrorMessage', last_error_message,
      'occurrenceCountCapped', occurrence_count > 1000
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
        -- A recorded backlog makes the follow-up pass due as prune_terminal_storage_v1 gates it.
        WHEN 'terminal_storage' THEN state.last_completed_at IS NULL
          OR state.last_completed_at <= clock_timestamp()
            - make_interval(secs => CASE WHEN state.terminal_cleanup_backlog_since IS NULL
                THEN policy.terminal_cleanup_interval_ms
                ELSE LEAST(policy.terminal_cleanup_interval_ms,
                  workhorse.terminal_cleanup_follow_up_delay_ms_v1()) END / 1000.0)
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
