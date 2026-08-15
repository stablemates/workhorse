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
  IF v_version NOT IN (32, 33) THEN
    RAISE EXCEPTION 'migration 0033 requires schema version 32, found %', v_version;
  END IF;
END;
$migration$;


-- One immutable named child for the first child-job protocol. The child owns edge lifetime, while
-- the restricted parent reference keeps retained lineage explainable until the child is pruned.
CREATE TABLE IF NOT EXISTS workhorse.job_child (
  parent_job_id uuid NOT NULL REFERENCES workhorse.job(id) ON DELETE RESTRICT,
  child_job_id uuid NOT NULL UNIQUE REFERENCES workhorse.job(id) ON DELETE CASCADE,
  child_name text NOT NULL CHECK (child_name <> '' AND char_length(child_name) <= 200),
  request_fingerprint jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  joined_at timestamptz,
  PRIMARY KEY (parent_job_id, child_name),
  CHECK (parent_job_id <> child_job_id),
  CHECK (joined_at IS NULL OR joined_at >= created_at)
);
CREATE UNIQUE INDEX IF NOT EXISTS job_child_parent_one_idx
  ON workhorse.job_child (parent_job_id);

CREATE OR REPLACE FUNCTION workhorse.create_child_v1(
  p_parent_job_id uuid,
  p_worker_id text,
  p_fence_token bigint,
  p_child_name text,
  p_request jsonb
) RETURNS TABLE (
  status text,
  child_job_id uuid,
  child_type text,
  created_at timestamptz,
  joined_at timestamptz,
  result jsonb
)
LANGUAGE plpgsql
AS $$
DECLARE
  v_runtime workhorse.job_runtime%ROWTYPE;
  v_edge workhorse.job_child%ROWTYPE;
  v_enqueue record;
  v_outcome workhorse.job_outcome%ROWTYPE;
  v_now timestamptz;
BEGIN
  IF p_child_name IS NULL OR p_child_name = '' OR char_length(p_child_name) > 200 THEN
    RAISE EXCEPTION 'child_name must contain between 1 and 200 characters';
  END IF;
  IF p_request IS NULL OR jsonb_typeof(p_request) <> 'object' THEN
    RAISE EXCEPTION 'child request must be a JSON object';
  END IF;
  IF p_request ?| ARRAY['idempotency', 'debounce', 'throttle']
     OR COALESCE(p_request->'prerequisiteJobId', 'null'::jsonb) <> 'null'::jsonb
     OR COALESCE(p_request->'dependencies', 'null'::jsonb) <> 'null'::jsonb THEN
    RAISE EXCEPTION 'child jobs cannot use coalescing or dependency enqueue options';
  END IF;

  SELECT * INTO v_runtime
    FROM workhorse.job_runtime runtime
   WHERE runtime.job_id = p_parent_job_id
     AND runtime.state = 'active'
     AND runtime.worker_id = p_worker_id
     AND runtime.fence_token = p_fence_token
   FOR UPDATE;
  v_now := clock_timestamp();
  IF NOT FOUND OR v_runtime.expires_at <= v_now
     OR (v_runtime.deadline_at IS NOT NULL AND v_runtime.deadline_at <= v_now)
     OR (v_runtime.attempt_timeout_at IS NOT NULL AND v_runtime.attempt_timeout_at <= v_now)
     OR v_runtime.cancel_requested_at IS NOT NULL THEN
    RETURN QUERY VALUES (
      'stale'::text, NULL::uuid, NULL::text, NULL::timestamptz,
      NULL::timestamptz, NULL::jsonb
    );
    RETURN;
  END IF;

  SELECT * INTO v_edge
    FROM workhorse.job_child edge
   WHERE edge.parent_job_id = p_parent_job_id
   FOR UPDATE;
  IF FOUND THEN
    IF v_edge.child_name <> p_child_name THEN
      RETURN QUERY VALUES (
        'limit_exceeded'::text, v_edge.child_job_id,
        (SELECT job_type FROM workhorse.job WHERE id = v_edge.child_job_id),
        v_edge.created_at, v_edge.joined_at, NULL::jsonb
      );
      RETURN;
    END IF;
    IF v_edge.request_fingerprint <> p_request THEN
      RETURN QUERY VALUES (
        'conflict'::text, v_edge.child_job_id,
        (SELECT job_type FROM workhorse.job WHERE id = v_edge.child_job_id),
        v_edge.created_at, v_edge.joined_at, NULL::jsonb
      );
      RETURN;
    END IF;
    SELECT * INTO v_outcome FROM workhorse.job_outcome outcome
     WHERE outcome.job_id = v_edge.child_job_id;
    IF NOT FOUND OR v_outcome.state <> 'succeeded' THEN
      RETURN QUERY VALUES (
        'stale'::text, v_edge.child_job_id,
        (SELECT job_type FROM workhorse.job WHERE id = v_edge.child_job_id),
        v_edge.created_at, v_edge.joined_at, NULL::jsonb
      );
      RETURN;
    END IF;
    IF v_edge.joined_at IS NULL THEN
      UPDATE workhorse.job_child edge SET joined_at = v_now
       WHERE edge.parent_job_id = p_parent_job_id
       RETURNING * INTO v_edge;
      INSERT INTO workhorse.job_event(job_id, attempt, event_type, details)
        VALUES (
          p_parent_job_id, v_runtime.current_attempt, 'child_joined',
          jsonb_build_object(
            'name', p_child_name,
            'child_job_id', v_edge.child_job_id,
            'fence_token', p_fence_token::text
          )
        );
    END IF;
    RETURN QUERY VALUES (
      'completed'::text, v_edge.child_job_id,
      (SELECT job_type FROM workhorse.job WHERE id = v_edge.child_job_id),
      v_edge.created_at, v_edge.joined_at, v_outcome.result
    );
    RETURN;
  END IF;

  IF EXISTS (SELECT 1 FROM workhorse.job_child edge WHERE edge.parent_job_id = p_parent_job_id) THEN
    RETURN QUERY VALUES (
      'limit_exceeded'::text, NULL::uuid, NULL::text, NULL::timestamptz,
      NULL::timestamptz, NULL::jsonb
    );
    RETURN;
  END IF;

  BEGIN
    SELECT * INTO v_enqueue FROM workhorse.enqueue_many_v2(jsonb_build_array(p_request));
    IF v_enqueue.outcome <> 'accepted' THEN
      RAISE EXCEPTION 'child enqueue must create one new job';
    END IF;
    INSERT INTO workhorse.job_child(
      parent_job_id, child_job_id, child_name, request_fingerprint, created_at
    ) VALUES (
      p_parent_job_id, v_enqueue.job_id, p_child_name, p_request, v_now
    ) RETURNING * INTO v_edge;
    INSERT INTO workhorse.job_dependency(
      dependent_job_id, prerequisite_job_id, on_success, on_failure, on_cancellation, created_at
    ) VALUES (
      p_parent_job_id, v_enqueue.job_id, 'release', 'fail', 'cancel', v_now
    );

    UPDATE workhorse.job_runtime runtime
       SET state = 'blocked', fence_token = 0, ready_at = NULL, sequence = NULL,
           worker_id = NULL, acquired_at = NULL, heartbeat_at = NULL, expires_at = NULL,
           wait_name = NULL, attempt_started_at = NULL,
           execution_used_ms = LEAST(
             31536000000,
             runtime.execution_used_ms + GREATEST(
               0, floor(extract(epoch FROM v_now - runtime.acquired_at) * 1000)::bigint
             )
           ),
           attempt_timeout_at = NULL, error = NULL, updated_at = v_now
     WHERE runtime.job_id = p_parent_job_id
       AND runtime.state = 'active'
       AND runtime.worker_id = p_worker_id
       AND runtime.fence_token = p_fence_token
       AND runtime.expires_at > clock_timestamp()
       AND (runtime.deadline_at IS NULL OR runtime.deadline_at > clock_timestamp())
       AND (runtime.attempt_timeout_at IS NULL OR runtime.attempt_timeout_at > clock_timestamp());
    IF NOT FOUND THEN
      RAISE EXCEPTION USING
        ERRCODE = 'P1004',
        MESSAGE = 'child creation lost the parent lease';
    END IF;

    INSERT INTO workhorse.job_event(job_id, attempt, event_type, details)
      VALUES (
        p_parent_job_id, v_runtime.current_attempt, 'child_created',
        jsonb_build_object(
          'name', p_child_name,
          'child_job_id', v_edge.child_job_id,
          'fence_token', p_fence_token::text
        )
      );
    INSERT INTO workhorse.job_event(job_id, event_type, details)
      VALUES (
        v_edge.child_job_id, 'parent_linked',
        jsonb_build_object('parent_job_id', p_parent_job_id, 'name', p_child_name)
      );
    RETURN QUERY VALUES (
      'created'::text, v_edge.child_job_id, p_request->>'type', v_edge.created_at,
      NULL::timestamptz, NULL::jsonb
    );
  EXCEPTION
    WHEN SQLSTATE 'P1004' THEN
      RETURN QUERY VALUES (
        'stale'::text, NULL::uuid, NULL::text, NULL::timestamptz,
        NULL::timestamptz, NULL::jsonb
      );
  END;
END;
$$;


CREATE OR REPLACE VIEW workhorse.dashboard_job_child_v1 AS
  SELECT parent_job_id, child_job_id, child_name, created_at, joined_at
    FROM workhorse.job_child;


INSERT INTO workhorse.schema_migration(version, description)
VALUES (33, 'add single linked child jobs')
ON CONFLICT DO NOTHING;

DELETE FROM workhorse.schema_version WHERE version = 32;
INSERT INTO workhorse.schema_version(version) VALUES (33) ON CONFLICT DO NOTHING;

COMMIT;
