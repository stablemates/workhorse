BEGIN;

SELECT pg_advisory_xact_lock(hashtextextended('workhorse:schema-migration', 0));

DO $migration$
DECLARE
  v_version integer;
  v_version_rows integer;
BEGIN
  SELECT count(*)::integer, min(version) INTO v_version_rows, v_version
    FROM workhorse.schema_version;

  IF v_version_rows <> 1 THEN
    RAISE EXCEPTION 'workhorse.schema_version must contain exactly one row';
  END IF;
  IF v_version = 25 THEN
    RETURN;
  END IF;
  IF v_version <> 24 THEN
    RAISE EXCEPTION 'migration 0025 requires schema version 24, found %', v_version;
  END IF;

  CREATE OR REPLACE FUNCTION workhorse.fire_schedule_v1(
    p_namespace text,
    p_schedule_name text,
    p_expected_revision bigint,
    p_occurrence_at timestamptz DEFAULT date_trunc('second', clock_timestamp())
  ) RETURNS uuid
  LANGUAGE plpgsql
  AS $function$
DECLARE
  v_definition workhorse.schedule_definition%ROWTYPE;
  v_job_id uuid;
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtextextended(
    'workhorse:schedule:' || p_namespace || ':' || p_schedule_name || ':' ||
    extract(epoch FROM date_trunc('second', p_occurrence_at))::bigint,
    0
  )) THEN
    RETURN NULL;
  END IF;

  SELECT * INTO v_definition
    FROM workhorse.schedule_definition definition
   WHERE definition.namespace = p_namespace
     AND definition.schedule_name = p_schedule_name
     AND definition.enabled
     AND definition.revision = p_expected_revision
   FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;

  INSERT INTO workhorse.schedule_occurrence(namespace, schedule_name, occurrence_at)
    VALUES (p_namespace, p_schedule_name, date_trunc('second', p_occurrence_at))
  ON CONFLICT DO NOTHING
  RETURNING job_id INTO v_job_id;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  v_job_id := workhorse.enqueue_v1(
    v_definition.queue_name,
    v_definition.job_type,
    v_definition.payload,
    clock_timestamp(),
    v_definition.max_attempts,
    '{}',
    v_definition.retry_policy,
    v_definition.contract_version,
    v_definition.payload_max_bytes,
    v_definition.result_max_bytes,
    v_definition.payload_redact_keys,
    v_definition.result_redact_keys,
    v_definition.concurrency_key
  );
  UPDATE workhorse.schedule_occurrence occurrence
     SET job_id = v_job_id
   WHERE occurrence.namespace = p_namespace
     AND occurrence.schedule_name = p_schedule_name
     AND occurrence.occurrence_at = date_trunc('second', p_occurrence_at);
  RETURN v_job_id;
END;
$function$;

  INSERT INTO workhorse.schema_migration(version, description) VALUES
    (25, 'make schedule occurrence replay a no-op');

  DELETE FROM workhorse.schema_version;
  INSERT INTO workhorse.schema_version(version) VALUES (25);
END;
$migration$;

COMMIT;
