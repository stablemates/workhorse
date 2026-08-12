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
  IF v_version = 24 THEN
    RETURN;
  END IF;
  IF v_version <> 23 THEN
    RAISE EXCEPTION 'migration 0024 requires schema version 23, found %', v_version;
  END IF;

  CREATE TABLE workhorse.schema_migration (
    version integer PRIMARY KEY,
    description text NOT NULL CHECK (description <> ''),
    applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
  );

  INSERT INTO workhorse.schema_migration(version, description) VALUES
    (23, 'forward migration baseline'),
    (24, 'add schema migration ledger');

  DELETE FROM workhorse.schema_version;
  INSERT INTO workhorse.schema_version(version) VALUES (24);
END;
$migration$;

COMMIT;
