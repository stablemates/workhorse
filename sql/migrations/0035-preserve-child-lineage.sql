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
  IF v_version NOT IN (34, 35) THEN
    RAISE EXCEPTION 'migration 0035 requires schema version 34, found %', v_version;
  END IF;
END;
$migration$;

ALTER TABLE workhorse.job_child
  DROP CONSTRAINT IF EXISTS job_child_parent_job_id_fkey;
ALTER TABLE workhorse.job_child
  ADD CONSTRAINT job_child_parent_job_id_fkey
  FOREIGN KEY (parent_job_id) REFERENCES workhorse.job(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS job_child_unjoined_idx
  ON workhorse.job_child (parent_job_id, child_job_id) WHERE joined_at IS NULL;
CREATE INDEX IF NOT EXISTS job_outcome_dependency_canceled_idx
  ON workhorse.job_outcome (job_id)
  WHERE state = 'canceled' AND error->>'name' = 'DependencyCanceled';

CREATE OR REPLACE VIEW workhorse.dashboard_job_redrive_v1 AS
  SELECT source_job_id, target_job_id, request_id_preview, request_id_digest, request_id_length,
         requested_by, reason, source_state, target_initial_state, requested_at
    FROM workhorse.job_redrive;

CREATE OR REPLACE FUNCTION workhorse.redrive_lineage_v1(
  p_job_id uuid,
  p_limit integer
) RETURNS TABLE (
  source_job_id uuid,
  target_job_id uuid,
  requested_by text,
  reason text,
  request_id_preview text,
  request_id_digest text,
  request_id_length integer,
  source_state text,
  target_initial_state text,
  requested_at timestamptz
)
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v_frontier uuid[] := ARRAY[p_job_id];
  v_seen_nodes uuid[] := ARRAY[p_job_id];
  v_seen_edges uuid[] := '{}'::uuid[];
  v_node uuid;
  v_neighbor uuid;
  v_edge record;
  v_count integer := 0;
BEGIN
  IF p_job_id IS NULL THEN RAISE EXCEPTION 'lineage job identity is required'; END IF;
  IF p_limit NOT BETWEEN 1 AND 1001 THEN
    RAISE EXCEPTION 'redrive lineage limit must be between 1 and 1001';
  END IF;

  WHILE cardinality(v_frontier) > 0 AND v_count < p_limit LOOP
    v_node := v_frontier[1];
    v_frontier := COALESCE(v_frontier[2:cardinality(v_frontier)], '{}'::uuid[]);
    FOR v_edge IN
      SELECT edge.*
        FROM workhorse.job_redrive edge
       WHERE (edge.source_job_id = v_node OR edge.target_job_id = v_node)
         AND NOT edge.target_job_id = ANY(v_seen_edges)
       ORDER BY edge.requested_at, edge.source_job_id, edge.target_job_id
       LIMIT p_limit - v_count
    LOOP
      v_seen_edges := array_append(v_seen_edges, v_edge.target_job_id);
      v_count := v_count + 1;
      v_neighbor := CASE WHEN v_edge.source_job_id = v_node
        THEN v_edge.target_job_id ELSE v_edge.source_job_id END;
      IF NOT v_neighbor = ANY(v_seen_nodes) THEN
        v_seen_nodes := array_append(v_seen_nodes, v_neighbor);
        v_frontier := array_append(v_frontier, v_neighbor);
      END IF;
    END LOOP;
  END LOOP;

  RETURN QUERY
    SELECT edge.source_job_id, edge.target_job_id, edge.requested_by, edge.reason,
           edge.request_id_preview, edge.request_id_digest, edge.request_id_length,
           edge.source_state, edge.target_initial_state, edge.requested_at
      FROM workhorse.job_redrive edge
     WHERE edge.target_job_id = ANY(v_seen_edges)
     ORDER BY array_position(v_seen_edges, edge.target_job_id);
END;
$$;

CREATE OR REPLACE FUNCTION workhorse.prune_terminal_jobs_v1(
  p_identity_before timestamptz, p_outcome_before timestamptz,
  p_history_before timestamptz, p_limit integer
) RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE v_count integer;
BEGIN
  IF p_identity_before IS NULL OR p_outcome_before IS NULL OR p_history_before IS NULL
     OR NOT isfinite(p_identity_before) OR NOT isfinite(p_outcome_before)
     OR NOT isfinite(p_history_before) THEN
    RAISE EXCEPTION 'identity, outcome, and history cutoffs are required';
  END IF;
  IF p_limit NOT BETWEEN 1 AND 100000 THEN RAISE EXCEPTION 'terminal job limit must be between 1 and 100000'; END IF;

  WITH candidate_window AS MATERIALIZED (
    SELECT job.id, outcome.finished_at
      FROM workhorse.job job
      JOIN workhorse.job_outcome outcome ON outcome.job_id = job.id
     WHERE job.created_at < p_identity_before
       AND outcome.finished_at < p_outcome_before
       AND outcome.history_through_at < p_history_before
       AND NOT EXISTS (SELECT 1 FROM workhorse.job_runtime runtime WHERE runtime.job_id = job.id)
     ORDER BY outcome.finished_at, job.id
     FOR UPDATE OF job SKIP LOCKED
     LIMIT LEAST(p_limit * 4, 100000)
  ), candidates AS (
    SELECT candidate.id
      FROM candidate_window candidate
     WHERE NOT EXISTS (
             SELECT 1 FROM workhorse.schedule_occurrence occurrence
              WHERE occurrence.job_id = candidate.id
           )
       AND NOT EXISTS (
             SELECT 1 FROM workhorse.enqueue_idempotency idempotency
              WHERE idempotency.job_id = candidate.id
           )
       AND NOT EXISTS (
             SELECT 1 FROM workhorse.job_redrive redrive
              WHERE redrive.source_job_id = candidate.id
           )
       AND NOT EXISTS (
             SELECT 1 FROM workhorse.job_dependency dependency
              WHERE dependency.prerequisite_job_id = candidate.id
           )
       AND NOT EXISTS (
             SELECT 1
               FROM workhorse.job_child edge
               JOIN workhorse.job child ON child.id = edge.child_job_id
               LEFT JOIN workhorse.job_outcome child_outcome
                 ON child_outcome.job_id = edge.child_job_id
              WHERE edge.parent_job_id = candidate.id
                AND (
                  child_outcome.job_id IS NULL
                  OR child.created_at >= p_identity_before
                  OR child_outcome.finished_at >= p_outcome_before
                  OR child_outcome.history_through_at >= p_history_before
                )
           )
     ORDER BY candidate.finished_at, candidate.id
     LIMIT p_limit
  )
  DELETE FROM workhorse.job job USING candidates WHERE job.id = candidates.id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

INSERT INTO workhorse.schema_migration(version, description)
VALUES (35, 'preserve child lineage through lifecycle changes')
ON CONFLICT (version) DO UPDATE SET description = EXCLUDED.description;

DELETE FROM workhorse.schema_version WHERE version = 34;
INSERT INTO workhorse.schema_version(version) VALUES (35) ON CONFLICT DO NOTHING;

COMMIT;
