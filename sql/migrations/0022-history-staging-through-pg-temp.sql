-- workhorse-migration: {"kind":"additive"}

-- History-day staging resolves through pg_temp, schema 22 (SM-792).
--
-- `create_history_day_v1` stages the fallback rows of a day in a temporary table, then reads that
-- table back into the new partition and drops it. It named that table without a schema, so the
-- calling session's `search_path` decided which table it meant. A session that searches a writable
-- schema before `pg_temp` could hold a table of the same name there, and the function would copy
-- that table's rows into the partition and drop it instead of its own staging table.
--
-- Every reference to a staging table now writes `pg_temp`, which names the session's own temporary
-- schema whatever the `search_path` says.

CREATE OR REPLACE FUNCTION workhorse.create_history_day_v1(p_day date)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  v_start timestamptz := p_day::timestamp AT TIME ZONE 'UTC';
  v_end timestamptz := (p_day + 1)::timestamp AT TIME ZONE 'UTC';
  v_suffix text := to_char(p_day, 'YYYYMMDD');
  v_event_partition text := 'task_event_' || v_suffix;
  v_attempt_partition text := 'attempt_history_' || v_suffix;
  v_event_staging text := 'workhorse_task_event_' || v_suffix;
  v_attempt_staging text := 'workhorse_attempt_history_' || v_suffix;
  v_event_exists boolean;
  v_attempt_exists boolean;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('workhorse:history-day:' || p_day, 0));
  v_event_exists := to_regclass(format('workhorse.%I', v_event_partition)) IS NOT NULL;
  v_attempt_exists := to_regclass(format('workhorse.%I', v_attempt_partition)) IS NOT NULL;
  IF v_event_exists AND v_attempt_exists THEN RETURN; END IF;

  -- Lifecycle transitions insert attempt history before task events. Take the partitioned-parent
  -- locks in that order before either CREATE TABLE can acquire them implicitly, otherwise a
  -- transition and paired partition creation can each hold the relation the other needs.
  LOCK TABLE ONLY workhorse.attempt_history IN ACCESS EXCLUSIVE MODE;
  LOCK TABLE ONLY workhorse.task_event IN ACCESS EXCLUSIVE MODE;
  LOCK TABLE workhorse.attempt_history_default IN ACCESS EXCLUSIVE MODE;
  LOCK TABLE workhorse.task_event_default IN ACCESS EXCLUSIVE MODE;
  IF NOT v_event_exists THEN
    EXECUTE format(
      'CREATE TEMP TABLE pg_temp.%I ON COMMIT DROP AS SELECT * FROM workhorse.task_event_default WHERE occurred_at >= %L AND occurred_at < %L',
      v_event_staging, v_start, v_end);
    DELETE FROM workhorse.task_event_default WHERE occurred_at >= v_start AND occurred_at < v_end;
    EXECUTE format(
      'CREATE TABLE workhorse.%I PARTITION OF workhorse.task_event FOR VALUES FROM (%L) TO (%L)',
      v_event_partition, v_start, v_end);
    EXECUTE format(
      'INSERT INTO workhorse.%I (event_id, task_id, attempt, event_type, details, occurred_at) SELECT event_id, task_id, attempt, event_type, details, occurred_at FROM pg_temp.%I',
      v_event_partition, v_event_staging);
    EXECUTE format('DROP TABLE pg_temp.%I', v_event_staging);
  END IF;

  IF NOT v_attempt_exists THEN
    EXECUTE format(
      'CREATE TEMP TABLE pg_temp.%I ON COMMIT DROP AS SELECT * FROM workhorse.attempt_history_default WHERE occurred_at >= %L AND occurred_at < %L',
      v_attempt_staging, v_start, v_end);
    DELETE FROM workhorse.attempt_history_default WHERE occurred_at >= v_start AND occurred_at < v_end;
    EXECUTE format(
      'CREATE TABLE workhorse.%I PARTITION OF workhorse.attempt_history FOR VALUES FROM (%L) TO (%L)',
      v_attempt_partition, v_start, v_end);
    EXECUTE format(
      'INSERT INTO workhorse.%I (attempt_id, task_id, attempt, fence_token, worker_id, outcome, started_at, claimed_at, finished_at, error, occurred_at) SELECT attempt_id, task_id, attempt, fence_token, worker_id, outcome, started_at, claimed_at, finished_at, error, occurred_at FROM pg_temp.%I',
      v_attempt_partition, v_attempt_staging);
    EXECUTE format('DROP TABLE pg_temp.%I', v_attempt_staging);
  END IF;
END;
$$;
