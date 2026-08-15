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
  IF v_version NOT IN (29, 30) THEN
    RAISE EXCEPTION 'migration 0030 requires schema version 29, found %', v_version;
  END IF;
END;
$migration$;

CREATE TABLE IF NOT EXISTS workhorse.job_dependency (
  dependent_job_id uuid PRIMARY KEY REFERENCES workhorse.job(id) ON DELETE CASCADE,
  prerequisite_job_id uuid NOT NULL REFERENCES workhorse.job(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  released_at timestamptz,
  CHECK (dependent_job_id <> prerequisite_job_id),
  CHECK (released_at IS NULL OR released_at >= created_at)
);
CREATE INDEX IF NOT EXISTS job_dependency_prerequisite_pending_idx
  ON workhorse.job_dependency (prerequisite_job_id, dependent_job_id)
  WHERE released_at IS NULL;

ALTER TABLE workhorse.job_runtime DROP CONSTRAINT job_runtime_state_check;
ALTER TABLE workhorse.job_runtime ADD CONSTRAINT job_runtime_state_check
  CHECK (state IN ('blocked', 'scheduled', 'ready', 'active'));

DO $constraints$
DECLARE
  v_constraint record;
BEGIN
  FOR v_constraint IN
    SELECT constraint_row.conname
      FROM pg_constraint constraint_row
     WHERE constraint_row.conrelid = 'workhorse.job_runtime'::regclass
       AND constraint_row.contype = 'c'
       AND pg_get_constraintdef(constraint_row.oid) LIKE '%state = ''scheduled''%'
       AND pg_get_constraintdef(constraint_row.oid) LIKE '%state = ''ready''%'
       AND pg_get_constraintdef(constraint_row.oid) LIKE '%state = ''active''%'
  LOOP
    EXECUTE format('ALTER TABLE workhorse.job_runtime DROP CONSTRAINT %I', v_constraint.conname);
  END LOOP;
END;
$constraints$;

ALTER TABLE workhorse.job_runtime ADD CONSTRAINT job_runtime_state_shape_check CHECK (
  (state = 'blocked' AND ready_at IS NULL AND sequence IS NULL AND worker_id IS NULL
    AND acquired_at IS NULL AND heartbeat_at IS NULL AND expires_at IS NULL
    AND attempt_timeout_at IS NULL AND fence_token = 0
    AND wait_name IS NULL AND attempt_started_at IS NULL)
  OR
  (state = 'scheduled' AND ready_at IS NULL AND sequence IS NULL AND worker_id IS NULL
    AND acquired_at IS NULL AND heartbeat_at IS NULL AND expires_at IS NULL
    AND attempt_timeout_at IS NULL AND fence_token = 0
    AND ((wait_name IS NULL AND attempt_started_at IS NULL)
      OR (wait_name IS NOT NULL AND attempt_started_at IS NOT NULL)))
  OR
  (state = 'ready' AND ready_at IS NOT NULL AND sequence IS NOT NULL AND worker_id IS NULL
    AND acquired_at IS NULL AND heartbeat_at IS NULL AND expires_at IS NULL
    AND attempt_timeout_at IS NULL AND fence_token = 0 AND wait_name IS NULL)
  OR
  (state = 'active' AND ready_at IS NULL AND sequence IS NULL AND worker_id IS NOT NULL
    AND acquired_at IS NOT NULL AND heartbeat_at IS NOT NULL AND expires_at IS NOT NULL
    AND fence_token > 0 AND wait_name IS NULL AND attempt_started_at IS NOT NULL)
);

ALTER TABLE workhorse.job_query DROP CONSTRAINT job_query_state_check;
ALTER TABLE workhorse.job_query ADD CONSTRAINT job_query_state_check CHECK (
  state IN ('blocked', 'scheduled', 'ready', 'active', 'succeeded', 'failed', 'canceled')
);

DO $functions$
DECLARE
  v_definition text;
  v_changed text;
BEGIN
  SELECT pg_get_functiondef('workhorse.enqueue_many_v1(jsonb)'::regprocedure)
    INTO v_definition;
  IF strpos(v_definition, 'v_prerequisite_job_id uuid') = 0 THEN
    v_changed := replace(v_definition,
    '  v_execution_timeout_ms numeric;',
    '  v_execution_timeout_ms numeric;
  v_prerequisite_job_id uuid;
  v_prerequisite_succeeded boolean;');
  v_changed := replace(v_changed,
    '    v_state := CASE WHEN v_run_at <= v_now THEN ''ready'' ELSE ''scheduled'' END;',
    '    IF v_request ? ''prerequisiteJobId''
       AND v_request->''prerequisiteJobId'' <> ''null''::jsonb
       AND jsonb_typeof(v_request->''prerequisiteJobId'') <> ''string'' THEN
      RAISE EXCEPTION ''prerequisiteJobId must be a UUID string or null'';
    END IF;
    v_prerequisite_job_id := NULLIF(v_request->>''prerequisiteJobId'', '''')::uuid;
    v_prerequisite_succeeded := false;
    IF v_prerequisite_job_id IS NOT NULL THEN
      PERFORM 1 FROM workhorse.job prerequisite
       WHERE prerequisite.id = v_prerequisite_job_id FOR UPDATE;
      IF NOT FOUND THEN RAISE EXCEPTION ''prerequisite job does not exist''; END IF;
      SELECT outcome.state = ''succeeded'' INTO v_prerequisite_succeeded
        FROM workhorse.job_outcome outcome
       WHERE outcome.job_id = v_prerequisite_job_id;
      IF NOT FOUND THEN
        v_prerequisite_succeeded := false;
      ELSIF NOT v_prerequisite_succeeded THEN
        RAISE EXCEPTION ''prerequisite job is already terminal without success'';
      END IF;
    END IF;
    v_state := CASE
      WHEN v_prerequisite_job_id IS NOT NULL AND NOT v_prerequisite_succeeded THEN ''blocked''
      WHEN v_run_at <= v_now THEN ''ready''
      ELSE ''scheduled''
    END;');
  v_changed := replace(v_changed,
    '        ''retryPolicy'', v_retry_policy,
        ''ttlMs'', v_ttl_ms',
    '        ''retryPolicy'', v_retry_policy,
        ''prerequisiteJobId'', to_jsonb(v_prerequisite_job_id),
        ''ttlMs'', v_ttl_ms');
  v_changed := replace(v_changed,
    '      INSERT INTO workhorse.job_event(job_id, event_type, details)
        VALUES (',
    '      IF v_prerequisite_job_id IS NOT NULL THEN
        INSERT INTO workhorse.job_dependency(
          dependent_job_id, prerequisite_job_id, created_at, released_at
        ) VALUES (
          job_id, v_prerequisite_job_id, v_now,
          CASE WHEN v_prerequisite_succeeded THEN v_now END
        );
        INSERT INTO workhorse.job_event(job_id, event_type, details)
          VALUES (
            job_id,
            CASE WHEN v_prerequisite_succeeded
              THEN ''dependency_released'' ELSE ''dependency_blocked'' END,
            jsonb_build_object(
              ''prerequisite_job_id'', v_prerequisite_job_id,
              ''state'', v_state,
              ''reason'', CASE WHEN v_prerequisite_succeeded
                THEN ''prerequisite_already_succeeded'' ELSE ''prerequisite_pending'' END
            )
          );
      END IF;
      INSERT INTO workhorse.job_event(job_id, event_type, details)
        VALUES (');
    IF v_changed = v_definition THEN
      RAISE EXCEPTION 'migration 0030 could not update enqueue_many_v1';
    END IF;
    EXECUTE v_changed;
  END IF;

  SELECT pg_get_functiondef('workhorse.purge_queue_v1(text)'::regprocedure)
    INTO v_definition;
  v_changed := replace(v_definition,
    'runtime.state IN (''ready'', ''scheduled'')',
    'runtime.state IN (''blocked'', ''ready'', ''scheduled'')');
  IF v_changed <> v_definition THEN
    EXECUTE v_changed;
  END IF;

  SELECT pg_get_functiondef(
    'workhorse.list_jobs_v2(jsonb,integer,timestamp with time zone,uuid,text,jsonb)'::regprocedure
  ) INTO v_definition;
  IF strpos(v_definition, '''blocked'', ''scheduled''') = 0 THEN
    v_changed := replace(v_definition,
      '''scheduled'', ''ready'', ''active'', ''succeeded'', ''failed'', ''canceled''',
      '''blocked'', ''scheduled'', ''ready'', ''active'', ''succeeded'', ''failed'', ''canceled''');
    IF v_changed <> v_definition THEN
      EXECUTE v_changed;
    END IF;
  END IF;

  SELECT pg_get_functiondef(
    'workhorse.prune_terminal_jobs_v1(timestamp with time zone,timestamp with time zone,timestamp with time zone,integer)'::regprocedure
  ) INTO v_definition;
  IF strpos(v_definition, 'dependency.prerequisite_job_id = candidate.id') = 0 THEN
    v_changed := replace(v_definition,
      '       AND NOT EXISTS (
             SELECT 1 FROM workhorse.job_redrive redrive
              WHERE redrive.source_job_id = candidate.id
           )',
      '       AND NOT EXISTS (
             SELECT 1 FROM workhorse.job_redrive redrive
              WHERE redrive.source_job_id = candidate.id
           )
       AND NOT EXISTS (
             SELECT 1 FROM workhorse.job_dependency dependency
              WHERE dependency.prerequisite_job_id = candidate.id
           )');
    IF v_changed = v_definition THEN
      RAISE EXCEPTION 'migration 0030 could not update prune_terminal_jobs_v1';
    END IF;
    EXECUTE v_changed;
  END IF;
END;
$functions$;

CREATE OR REPLACE FUNCTION workhorse.release_dependents_v1(p_prerequisite_job_id uuid)
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  v_dependency workhorse.job_dependency%ROWTYPE;
  v_runtime workhorse.job_runtime%ROWTYPE;
  v_now timestamptz := clock_timestamp();
  v_count integer := 0;
BEGIN
  FOR v_dependency IN
    SELECT dependency.* FROM workhorse.job_dependency dependency
     WHERE dependency.prerequisite_job_id = p_prerequisite_job_id
       AND dependency.released_at IS NULL
     ORDER BY dependency.dependent_job_id FOR UPDATE
  LOOP
    UPDATE workhorse.job_dependency dependency SET released_at = v_now
     WHERE dependency.dependent_job_id = v_dependency.dependent_job_id
       AND dependency.released_at IS NULL;
    UPDATE workhorse.job_runtime runtime
       SET state = CASE WHEN runtime.run_at <= v_now THEN 'ready' ELSE 'scheduled' END,
           ready_at = CASE WHEN runtime.run_at <= v_now THEN v_now END,
           sequence = CASE WHEN runtime.run_at <= v_now
             THEN nextval('workhorse.ready_sequence_seq') END,
           updated_at = v_now
     WHERE runtime.job_id = v_dependency.dependent_job_id AND runtime.state = 'blocked'
    RETURNING * INTO v_runtime;
    IF NOT FOUND THEN CONTINUE; END IF;
    INSERT INTO workhorse.job_event(job_id, event_type, details)
      VALUES (v_runtime.job_id, 'dependency_released', jsonb_build_object(
        'prerequisite_job_id', p_prerequisite_job_id, 'state', v_runtime.state,
        'reason', 'prerequisite_succeeded'
      ));
    v_count := v_count + 1;
    IF v_runtime.deadline_at IS NOT NULL AND v_runtime.deadline_at <= v_now THEN
      PERFORM workhorse.terminalize_deadline_v1(v_runtime.job_id);
    ELSIF v_runtime.state = 'ready' THEN
      PERFORM pg_notify('workhorse_jobs', v_runtime.queue_name);
    END IF;
  END LOOP;
  RETURN v_count;
END;
$$;

DO $complete$
DECLARE
  v_definition text;
  v_changed text;
BEGIN
  SELECT pg_get_functiondef(
    'workhorse.complete_v1(uuid,text,bigint,jsonb)'::regprocedure
  ) INTO v_definition;
  v_changed := replace(v_definition, 'FOR UPDATE OF runtime;', 'FOR UPDATE OF runtime, job;');
  IF v_changed <> v_definition THEN
    EXECUTE v_changed;
    v_definition := v_changed;
  END IF;
  IF strpos(v_definition, 'release_dependents_v1(p_job_id)') = 0 THEN
    v_changed := replace(v_definition,
    '  RETURN true;
END;',
    '  PERFORM workhorse.release_dependents_v1(p_job_id);
  RETURN true;
END;');
    IF v_changed = v_definition THEN
      RAISE EXCEPTION 'migration 0030 could not update complete_v1';
    END IF;
    EXECUTE v_changed;
  END IF;
END;
$complete$;

CREATE OR REPLACE VIEW workhorse.dashboard_job_dependency_v1 AS
  SELECT dependent_job_id, prerequisite_job_id, created_at, released_at
    FROM workhorse.job_dependency;

INSERT INTO workhorse.schema_migration(version, description)
VALUES (30, 'add one-prerequisite job dependencies')
ON CONFLICT DO NOTHING;

DELETE FROM workhorse.schema_version WHERE version = 29;
INSERT INTO workhorse.schema_version(version) VALUES (30) ON CONFLICT DO NOTHING;

COMMIT;
