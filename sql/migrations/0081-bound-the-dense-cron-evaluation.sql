-- workhorse-migration: {"kind":"additive"}

-- Bound the dense cron evaluation to the wall-clock times near its window (SM-1643).

-- Before this step, cron_occurrences_v1 resolved every hour, minute, and second that the fields
-- allow on each matching day of the window. It also resolved the times before the durable position
-- and after now. For an every-second expression, each schedule pass resolved 86,400 wall-clock
-- times. Each accepted
-- occurrence was also compared with all earlier accepted occurrences, so a catch-up at the limit
-- of 10,000 did a quadratic number of comparisons.
--
-- The function now samples the UTC offsets of the zone near the durable position and near now.
-- These offsets bound the wall-clock times whose instants can fall inside the window, and the
-- walk skips the other times. The walk collects the candidates in wall-clock order and stops when
-- the limit is certain. One GROUP BY then keeps the first position of each instant.
--
-- The signature, the gap and fold rules, the result order, and the results do not change. No
-- change touches stored data.

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
      v_day_match := CASE WHEN v_dom_wildcard THEN v_dow_match
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
    v_day_match := CASE WHEN v_dom_wildcard THEN v_dow_match
      WHEN v_dow_wildcard THEN v_dom_match ELSE v_dom_match OR v_dow_match END;
    IF NOT v_day_match THEN CONTINUE; END IF;
    v_day_lower := COALESCE(extract(epoch FROM v_lower_wall - v_date::timestamp), -1);
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
