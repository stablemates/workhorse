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
  IF v_version NOT IN (31, 32) THEN
    RAISE EXCEPTION 'migration 0032 requires schema version 31, found %', v_version;
  END IF;
END;
$migration$;

CREATE INDEX IF NOT EXISTS job_outcome_dependency_failed_idx
  ON workhorse.job_outcome (job_id)
  WHERE state = 'failed' AND error->>'name' = 'DependencyFailed';

INSERT INTO workhorse.schema_migration(version, description)
VALUES (32, 'index dependency failure operations')
ON CONFLICT DO NOTHING;

DELETE FROM workhorse.schema_version WHERE version = 31;
INSERT INTO workhorse.schema_version(version) VALUES (32) ON CONFLICT DO NOTHING;

COMMIT;
