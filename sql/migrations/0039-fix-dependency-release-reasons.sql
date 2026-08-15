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
  IF v_version NOT IN (38, 39) THEN
    RAISE EXCEPTION 'migration 0039 requires schema version 38, found %', v_version;
  END IF;
END;
$migration$;

-- Resolve every pending edge in the same transaction that materializes a prerequisite outcome.
-- Dependents lock in identity order, so concurrent fan-in outcomes serialize at the one state
-- transition boundary without repeating terminal evidence, FIFO allocation, or notifications.
CREATE OR REPLACE FUNCTION workhorse.resolve_dependents_v1(
  p_prerequisite_job_id uuid, p_prerequisite_state text
)
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  v_dependency workhorse.job_dependency%ROWTYPE;
  v_runtime workhorse.job_runtime%ROWTYPE;
  v_now timestamptz := clock_timestamp();
  v_count integer := 0;
  v_action text;
  v_final_action text;
  v_final_prerequisite_job_id uuid;
  v_final_prerequisite_state text;
  v_error jsonb;
BEGIN
  IF p_prerequisite_state NOT IN ('succeeded', 'failed', 'canceled') THEN
    RAISE EXCEPTION 'prerequisite state must be succeeded, failed, or canceled';
  END IF;
  FOR v_dependency IN
    SELECT dependency.* FROM workhorse.job_dependency dependency
     WHERE dependency.prerequisite_job_id = p_prerequisite_job_id
       AND dependency.released_at IS NULL
     ORDER BY dependency.dependent_job_id FOR UPDATE
  LOOP
    SELECT * INTO v_runtime FROM workhorse.job_runtime runtime
     WHERE runtime.job_id = v_dependency.dependent_job_id FOR UPDATE;
    IF NOT FOUND OR v_runtime.state <> 'blocked' THEN CONTINUE; END IF;
    v_action := CASE p_prerequisite_state
      WHEN 'succeeded' THEN v_dependency.on_success
      WHEN 'failed' THEN v_dependency.on_failure
      WHEN 'canceled' THEN v_dependency.on_cancellation
    END;
    UPDATE workhorse.job_dependency dependency
       SET released_at = v_now, resolution = v_action
     WHERE dependency.dependent_job_id = v_dependency.dependent_job_id
       AND dependency.prerequisite_job_id = p_prerequisite_job_id
       AND dependency.released_at IS NULL;
    IF EXISTS (
      SELECT 1 FROM workhorse.job_dependency dependency
       WHERE dependency.dependent_job_id = v_dependency.dependent_job_id
         AND dependency.released_at IS NULL
    ) THEN CONTINUE; END IF;
    SELECT dependency.resolution, dependency.prerequisite_job_id, outcome.state
      INTO STRICT v_final_action, v_final_prerequisite_job_id, v_final_prerequisite_state
      FROM workhorse.job_dependency dependency
      JOIN workhorse.job_outcome outcome ON outcome.job_id = dependency.prerequisite_job_id
     WHERE dependency.dependent_job_id = v_dependency.dependent_job_id
     ORDER BY CASE dependency.resolution WHEN 'fail' THEN 0 WHEN 'cancel' THEN 1 ELSE 2 END,
              dependency.prerequisite_job_id
     LIMIT 1;
    IF v_final_action IN ('fail', 'cancel') THEN
      v_error := jsonb_build_object(
        'name', CASE WHEN v_final_action = 'fail' THEN 'DependencyFailed' ELSE 'DependencyCanceled' END,
        'message', CASE WHEN v_final_action = 'fail'
          THEN 'a prerequisite reached a terminal outcome rejected by dependency policy'
          ELSE 'a prerequisite reached a terminal outcome that canceled its dependent' END,
        'prerequisite_job_id', v_final_prerequisite_job_id,
        'prerequisite_state', v_final_prerequisite_state,
        'policy_action', v_final_action
      );
      DELETE FROM workhorse.job_runtime runtime
       WHERE runtime.job_id = v_dependency.dependent_job_id AND runtime.state = 'blocked';
      IF NOT FOUND THEN CONTINUE; END IF;
      INSERT INTO workhorse.job_outcome(
        job_id, state, current_attempt, fence_token, run_at, error, finished_at, updated_at
      ) VALUES (
        v_dependency.dependent_job_id,
        CASE WHEN v_final_action = 'fail' THEN 'failed' ELSE 'canceled' END,
        v_runtime.current_attempt, 0, v_runtime.run_at, v_error, v_now, v_now
      );
      INSERT INTO workhorse.job_event(job_id, event_type, details)
        VALUES (
          v_dependency.dependent_job_id,
          CASE WHEN v_final_action = 'fail' THEN 'dependency_failed' ELSE 'dependency_canceled' END,
          v_error
        );
      v_count := v_count + 1;
      CONTINUE;
    END IF;
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
        'reason', CASE p_prerequisite_state
          WHEN 'succeeded' THEN 'prerequisite_succeeded'
          WHEN 'failed' THEN 'prerequisite_failed_policy'
          WHEN 'canceled' THEN 'prerequisite_canceled_policy'
        END
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

INSERT INTO workhorse.schema_migration(version, description)
VALUES (39, 'fix dependency release event reasons')
ON CONFLICT (version) DO UPDATE SET description = EXCLUDED.description;

DELETE FROM workhorse.schema_version WHERE version = 38;
INSERT INTO workhorse.schema_version(version) VALUES (39) ON CONFLICT DO NOTHING;

COMMIT;
