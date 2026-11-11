-- workhorse-migration: {"kind":"additive","execution":"nontransactional"}

-- Index the active leases of each admission shard (SM-1991).
--
-- notify_concurrency_capacity_v1 counts the active leases of one admission shard of a queue. Since
-- the previous step, each part of that count is an equality or a range on
-- (queue_name, admission_shard). task_runtime_active_queue_shard_idx serves each part, so the
-- count reads only the entries of one shard. A heartbeat changes no column of the index, so it
-- stays a HOT update. A claim writes one more index entry.
--
-- The step is non-transactional, so the index build does not block writes to task_runtime. The
-- build reads the whole table, so on a large task_runtime it can take a long time. Each statement
-- is idempotent, so a rerun after a failure part-way applies the step again.
--
-- A failed build leaves an invalid task_runtime_active_queue_shard_idx, and IF NOT EXISTS would
-- then skip the build. The first statement therefore stops the step while an invalid index of
-- that name exists. The last statement stops it if the index is missing or not valid after the
-- build, for example when a peer migrator failed its own build. Drop the index with
-- DROP INDEX CONCURRENTLY IF EXISTS workhorse.task_runtime_active_queue_shard_idx, then run the
-- migration again, as docs/schema-lifecycle.md states. No change touches stored data.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM pg_index entry
     WHERE entry.indexrelid = to_regclass('workhorse.task_runtime_active_queue_shard_idx')
       AND NOT (entry.indisvalid AND entry.indisready)
  ) THEN
    RAISE EXCEPTION USING
      MESSAGE = 'workhorse.task_runtime_active_queue_shard_idx is invalid after an earlier failed '
        || 'build. Run DROP INDEX CONCURRENTLY IF EXISTS '
        || 'workhorse.task_runtime_active_queue_shard_idx, then run the migration again.',
      ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
END;
$$;

CREATE INDEX CONCURRENTLY IF NOT EXISTS task_runtime_active_queue_shard_idx
  ON workhorse.task_runtime (queue_name, admission_shard)
  WHERE state = 'active';

-- A peer migrator can start its own build after the first check and fail. IF NOT EXISTS then
-- skips the build above, so the step checks again before the bookkeeping records it.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_index entry
     WHERE entry.indexrelid = to_regclass('workhorse.task_runtime_active_queue_shard_idx')
       AND entry.indisvalid AND entry.indisready
  ) THEN
    RAISE EXCEPTION USING
      MESSAGE = 'workhorse.task_runtime_active_queue_shard_idx is missing or invalid after its '
        || 'build. Run DROP INDEX CONCURRENTLY IF EXISTS '
        || 'workhorse.task_runtime_active_queue_shard_idx, then run the migration again.',
      ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
END;
$$;
