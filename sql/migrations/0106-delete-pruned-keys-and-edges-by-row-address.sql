-- workhorse-migration: {"kind":"additive"}

-- Delete the expired keys and released edges of a cleanup pass by their row address (issue 1263).
--
-- prune_enqueue_idempotency_v1 and prune_released_dependencies_v1 lock their candidate rows through
-- the expiry and release indexes, then deleted them with a join on the key columns. A long-lived
-- session runs these functions with a generic plan, which cannot see the phase limit. That plan
-- joined a sequential scan of the whole enqueue_idempotency or task_dependency table to the rows to
-- delete, also when the limit was 1. Thus each call read the whole reference table. PostgreSQL 16
-- and 18 both chose that plan.
--
-- Each candidate now keeps the ctid of the row that it locks. The lock statement collects the ctid
-- of each removable row, and a second statement deletes the rows with ctid = ANY. PostgreSQL plans
-- that condition as a TID scan. A scan stays only for a batch that is a large part of its table,
-- or for a very small table, because the scan then costs less. The row lock keeps each ctid until
-- the delete, because no other transaction can update or delete a locked row.
--
-- The delete must be a separate statement. If an update of a candidate row commits after the
-- snapshot of the lock statement, the lock gives the ctid of the new row version. The snapshot of
-- that statement cannot see that version, so a delete in the same statement removed nothing. The
-- delete statement takes a later snapshot, which sees it. The result does not change. Only the
-- bodies change, so the functions keep their suffix (ADR 0109). No stored data changes.

CREATE OR REPLACE FUNCTION workhorse.prune_released_dependencies_v1(p_limit integer)
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE v_count integer;
DECLARE v_rows tid[];
BEGIN
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100000 THEN
    RAISE EXCEPTION 'released dependency limit must be between 1 and 100000';
  END IF;
  WITH candidates AS MATERIALIZED (
    SELECT dependency.ctid AS row_address, dependency.dependent_task_id,
           dependency.prerequisite_task_id, outcome.finished_at AS dependent_finished_at
      FROM workhorse.task_dependency dependency
      JOIN workhorse.task_outcome outcome ON outcome.task_id = dependency.dependent_task_id
     WHERE dependency.released_at IS NOT NULL
     ORDER BY dependency.released_at,
              dependency.dependent_task_id,
              dependency.prerequisite_task_id
       FOR UPDATE OF dependency SKIP LOCKED
     LIMIT p_limit
  ), blocked AS MATERIALIZED (
    -- The prerequisites whose outcome needs the write but another transaction locks.
    SELECT workhorse.record_terminal_hold_ends_internal_v1(
             array_agg(candidates.prerequisite_task_id), array_agg(candidates.dependent_finished_at),
             false
           ) AS task_ids
      FROM candidates
  ), removable AS MATERIALIZED (
    -- One window by prerequisite marks the edges of a blocked task, so no row searches the array.
    SELECT marked.row_address
      FROM (
        SELECT side.row_address, side.edge,
               bool_or(side.blocked) OVER (PARTITION BY side.prerequisite_task_id) AS blocked
          FROM (
            SELECT candidates.row_address, candidates.prerequisite_task_id, true AS edge,
                   false AS blocked
              FROM candidates
            UNION ALL
            SELECT NULL::tid, held.task_id, false, true
              FROM blocked CROSS JOIN unnest(blocked.task_ids) AS held(task_id)
          ) side
      ) marked
     WHERE marked.edge AND NOT marked.blocked
  )
  SELECT COALESCE(array_agg(removable.row_address), '{}'::tid[]) INTO v_rows FROM removable;
  -- The delete finds the locked edges by ctid, so its reads grow with the batch, not with the
  -- table. A join on the key let a generic plan read the whole table. The lock keeps each ctid
  -- until the delete. The delete is a separate statement. An update can commit after the snapshot
  -- of the lock statement. The lock then gives the ctid of the new row version, and only a later
  -- snapshot sees that version.
  IF cardinality(v_rows) = 0 THEN
    RETURN 0;
  END IF;
  DELETE FROM workhorse.task_dependency dependency WHERE dependency.ctid = ANY(v_rows);
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

CREATE OR REPLACE FUNCTION workhorse.prune_enqueue_idempotency_v1(
  p_before timestamptz, p_limit integer
) RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE v_count integer := 0;
DECLARE v_rows tid[];
DECLARE v_purge_count integer := 0;
DECLARE v_purge_retention_days integer;
BEGIN
  IF p_before IS NULL OR NOT isfinite(p_before) THEN
    RAISE EXCEPTION 'idempotency cutoff is required';
  END IF;
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100000 THEN
    RAISE EXCEPTION 'idempotency prune limit must be between 1 and 100000';
  END IF;
  WITH candidates AS MATERIALIZED (
    SELECT idempotency.ctid AS row_address, idempotency.task_id, idempotency.expires_at
      FROM workhorse.enqueue_idempotency idempotency
     WHERE idempotency.expires_at <= p_before
       AND NOT (
         idempotency.coalescing_mode = 'debounce'
         AND EXISTS (
           SELECT 1 FROM workhorse.task_runtime runtime
            WHERE runtime.task_id = idempotency.task_id
              AND runtime.state IN ('ready', 'scheduled')
         )
       )
     ORDER BY idempotency.expires_at, idempotency.idempotency_scope,
              idempotency.idempotency_key_hash
     FOR UPDATE OF idempotency SKIP LOCKED
     LIMIT p_limit
  ), blocked AS MATERIALIZED (
    -- The tasks whose outcome needs the write but another transaction locks.
    SELECT workhorse.record_terminal_hold_ends_internal_v1(
             array_agg(candidates.task_id), array_agg(candidates.expires_at), false
           ) AS task_ids
      FROM candidates
  ), removable AS MATERIALIZED (
    -- One window by task marks the keys of a blocked task, so no row searches the array.
    SELECT marked.row_address
      FROM (
        SELECT side.row_address, side.key,
               bool_or(side.blocked) OVER (PARTITION BY side.task_id) AS blocked
          FROM (
            SELECT candidates.row_address, candidates.task_id, true AS key, false AS blocked
              FROM candidates
            UNION ALL
            SELECT NULL::tid, held.task_id, false, true
              FROM blocked CROSS JOIN unnest(blocked.task_ids) AS held(task_id)
          ) side
      ) marked
     WHERE marked.key AND NOT marked.blocked
  )
  SELECT COALESCE(array_agg(removable.row_address), '{}'::tid[]) INTO v_rows FROM removable;
  -- The delete finds the locked keys by ctid, so its reads grow with the batch, not with the
  -- table. A join on the key let a generic plan read the whole table. The lock keeps each ctid
  -- until the delete. The delete is a separate statement. An update can commit after the snapshot
  -- of the lock statement. The lock then gives the ctid of the new row version, and only a later
  -- snapshot sees that version.
  IF cardinality(v_rows) > 0 THEN
    DELETE FROM workhorse.enqueue_idempotency idempotency WHERE idempotency.ctid = ANY(v_rows);
    GET DIAGNOSTICS v_count = ROW_COUNT;
  END IF;
  SELECT task_identity_retention_days INTO v_purge_retention_days
    FROM workhorse.retention_policy WHERE singleton;
  IF v_purge_retention_days IS NOT NULL THEN
    WITH candidates AS MATERIALIZED (
      SELECT request_id_hash
        FROM workhorse.queue_purge_request
       WHERE requested_at < p_before - make_interval(hours => 24 * v_purge_retention_days)
       ORDER BY requested_at, request_id_hash
       FOR UPDATE SKIP LOCKED
       LIMIT p_limit
    )
    DELETE FROM workhorse.queue_purge_request request USING candidates
     WHERE request.request_id_hash = candidates.request_id_hash;
    GET DIAGNOSTICS v_purge_count = ROW_COUNT;
  END IF;
  RETURN v_count + v_purge_count;
END;
$$;
