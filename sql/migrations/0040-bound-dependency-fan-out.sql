BEGIN;

SELECT pg_advisory_xact_lock(hashtextextended('workhorse:schema-migration', 0));
SELECT pg_advisory_xact_lock(hashtextextended('workhorse:job-dependency-graph', 0));

DO $migration$
DECLARE
  v_version integer;
  v_version_rows integer;
  v_prerequisite_job_id uuid;
  v_dependent_count bigint;
BEGIN
  SELECT count(*)::integer, min(version) INTO v_version_rows, v_version
    FROM workhorse.schema_version;
  IF v_version_rows <> 1 THEN
    RAISE EXCEPTION 'workhorse.schema_version must contain exactly one row';
  END IF;
  IF v_version NOT IN (39, 40) THEN
    RAISE EXCEPTION 'migration 0040 requires schema version 39, found %', v_version;
  END IF;

  IF v_version = 39 THEN
    SELECT dependency.prerequisite_job_id, count(*)
      INTO v_prerequisite_job_id, v_dependent_count
      FROM workhorse.job_dependency dependency
     GROUP BY dependency.prerequisite_job_id
    HAVING count(*) > 100
     ORDER BY dependency.prerequisite_job_id
     LIMIT 1;
    IF FOUND THEN
      RAISE EXCEPTION
        'migration 0040 cannot bound prerequisite % with % retained dependent jobs',
        v_prerequisite_job_id, v_dependent_count;
    END IF;

    WITH RECURSIVE reachable(prerequisite_job_id, dependent_job_id) AS (
      SELECT dependency.prerequisite_job_id, dependency.dependent_job_id
        FROM workhorse.job_dependency dependency
       WHERE dependency.released_at IS NULL
      UNION
      SELECT reachable.prerequisite_job_id, dependency.dependent_job_id
        FROM reachable
        JOIN workhorse.job_dependency dependency
          ON dependency.prerequisite_job_id = reachable.dependent_job_id
         AND dependency.released_at IS NULL
    )
    SELECT reachable.prerequisite_job_id, count(*)
      INTO v_prerequisite_job_id, v_dependent_count
      FROM reachable
     GROUP BY reachable.prerequisite_job_id
    HAVING count(*) > 100
     ORDER BY reachable.prerequisite_job_id
     LIMIT 1;
    IF FOUND THEN
      RAISE EXCEPTION
        'migration 0040 cannot bound prerequisite % with % unresolved transitive dependent jobs',
        v_prerequisite_job_id, v_dependent_count;
    END IF;
  END IF;
END;
$migration$;

CREATE INDEX IF NOT EXISTS job_dependency_prerequisite_idx
  ON workhorse.job_dependency (prerequisite_job_id, dependent_job_id);
CREATE INDEX IF NOT EXISTS job_dependency_dependent_pending_idx
  ON workhorse.job_dependency (dependent_job_id, prerequisite_job_id)
  WHERE released_at IS NULL;
CREATE INDEX IF NOT EXISTS job_runtime_blocked_queue_idx
  ON workhorse.job_runtime (queue_name, job_id) WHERE state = 'blocked';

CREATE OR REPLACE FUNCTION workhorse.validate_job_dependency_v1()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_cycle uuid[];
  v_fan_out_root uuid;
BEGIN
  -- Serialize graph mutations so two transactions cannot create opposite edges from snapshots that
  -- cannot see each other. Ordinary lifecycle resolution never needs this lock.
  PERFORM pg_advisory_xact_lock(hashtextextended('workhorse:job-dependency-graph', 0));
  IF NEW.dependent_job_id = NEW.prerequisite_job_id THEN
    v_cycle := ARRAY[NEW.dependent_job_id, NEW.prerequisite_job_id];
  ELSE
    WITH RECURSIVE reachable(job_id, path) AS (
      SELECT NEW.prerequisite_job_id, ARRAY[NEW.dependent_job_id, NEW.prerequisite_job_id]
      UNION ALL
      SELECT edge.prerequisite_job_id, reachable.path || edge.prerequisite_job_id
        FROM reachable
        JOIN workhorse.job_dependency edge ON edge.dependent_job_id = reachable.job_id
       WHERE (
         edge.prerequisite_job_id = NEW.dependent_job_id
         OR NOT edge.prerequisite_job_id = ANY(reachable.path)
       )
         AND reachable.job_id <> NEW.dependent_job_id
    )
    SELECT path INTO v_cycle FROM reachable
     WHERE job_id = NEW.dependent_job_id
     ORDER BY cardinality(path)
     LIMIT 1;
  END IF;
  IF v_cycle IS NOT NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P1002',
      MESSAGE = 'dependency cycle rejected',
      DETAIL = jsonb_build_object(
        'dependentJobId', NEW.dependent_job_id,
        'prerequisiteJobId', NEW.prerequisite_job_id,
        'cycleJobIds', to_jsonb(v_cycle[1:101]),
        'truncated', cardinality(v_cycle) > 101
      )::text;
  END IF;
  IF (
    SELECT count(*) FROM workhorse.job_dependency dependency
     WHERE dependency.dependent_job_id = NEW.dependent_job_id
  ) >= 100 THEN
    RAISE EXCEPTION 'a job accepts at most 100 prerequisite dependencies';
  END IF;
  IF (
    SELECT count(*) FROM workhorse.job_dependency dependency
     WHERE dependency.prerequisite_job_id = NEW.prerequisite_job_id
  ) >= 100 THEN
    RAISE EXCEPTION 'a job accepts at most 100 dependent jobs';
  END IF;
  IF NEW.released_at IS NULL THEN
    WITH RECURSIVE graph(prerequisite_job_id, dependent_job_id) AS (
      SELECT dependency.prerequisite_job_id, dependency.dependent_job_id
        FROM workhorse.job_dependency dependency
       WHERE dependency.released_at IS NULL
      UNION
      SELECT NEW.prerequisite_job_id, NEW.dependent_job_id
    ), affected(root_job_id) AS (
      SELECT NEW.prerequisite_job_id
      UNION
      SELECT graph.prerequisite_job_id
        FROM affected
        JOIN graph ON graph.dependent_job_id = affected.root_job_id
    ), reachable(root_job_id, dependent_job_id) AS (
      SELECT affected.root_job_id, graph.dependent_job_id
        FROM affected
        JOIN graph ON graph.prerequisite_job_id = affected.root_job_id
      UNION
      SELECT reachable.root_job_id, graph.dependent_job_id
        FROM reachable
        JOIN graph ON graph.prerequisite_job_id = reachable.dependent_job_id
    )
    SELECT reachable.root_job_id INTO v_fan_out_root
      FROM reachable
     GROUP BY reachable.root_job_id
    HAVING count(*) > 100
     ORDER BY reachable.root_job_id
     LIMIT 1;
    IF v_fan_out_root IS NOT NULL THEN
      RAISE EXCEPTION
        'a job accepts at most 100 unresolved transitive dependent jobs';
    END IF;
  END IF;
  IF EXISTS (
    SELECT 1 FROM workhorse.job_dependency dependency
     WHERE dependency.dependent_job_id = NEW.dependent_job_id
       AND (
         dependency.on_success <> NEW.on_success
         OR dependency.on_failure <> NEW.on_failure
         OR dependency.on_cancellation <> NEW.on_cancellation
       )
  ) THEN
    RAISE EXCEPTION 'every dependency edge for one job must use the same outcome policies';
  END IF;
  RETURN NEW;
END;
$$;

INSERT INTO workhorse.schema_migration(version, description)
VALUES (40, 'bound dependency fan-out and index dependency health')
ON CONFLICT DO NOTHING;

DELETE FROM workhorse.schema_version WHERE version = 39;
INSERT INTO workhorse.schema_version(version) VALUES (40) ON CONFLICT DO NOTHING;

COMMIT;
