-- workhorse-migration: {"kind":"additive"}

-- task_runtime keeps its active indexes lean (SM-821).

-- task_runtime is the one relation every claim, heartbeat, and completion writes, and it holds
-- only live tasks: a task leaves it the moment it reaches a terminal state. The default autovacuum
-- trigger is a fraction of the live row count, so it is set by the backlog rather than by the work
-- passing through it. A queue holding two thousand tasks waits for four hundred and fifty dead
-- tuples; one holding half a million waits for a hundred thousand, which a steady claim rate
-- reaches long after the table needed the pass.

-- The scale factor moves to one percent, which makes the trigger track the churn rather than the
-- resident size, and the cost delay moves to zero so a pass over a table this small finishes in
-- one uninterrupted run instead of sleeping between page batches. Both are storage parameters on
-- the table. No column, index, function, or constraint changes, and nothing any supported release
-- reads or writes is reinterpreted.

-- What this step does not do is shrink an index. Vacuum returns index space for reuse and never
-- returns it to the operating system, and both indexes predicated on state = 'ready' are keyed by
-- a value that only increases, so their pages are refilled slowly. Measured on PostgreSQL 18 with
-- the backlog held at two thousand tasks, claims grew task_runtime_ready_idx from 17 pages to a
-- steady 559 under the defaults, a full manual VACUUM afterwards returned no pages, and
-- REINDEX CONCURRENTLY returned the index to 17. Reindexing is an operator's decision on an
-- operator's schedule rather than a migration's, and docs/architecture.md records it.

-- ALTER TABLE ... SET takes SHARE UPDATE EXCLUSIVE, which no claim, heartbeat, or completion
-- blocks on, so this step needs no separate non-transactional class.
ALTER TABLE workhorse.task_runtime SET (
  autovacuum_vacuum_scale_factor = 0.01,
  autovacuum_vacuum_cost_delay = 0
);
