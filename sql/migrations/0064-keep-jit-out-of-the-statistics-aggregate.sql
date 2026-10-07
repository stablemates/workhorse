-- workhorse-migration: {"kind":"additive"}

-- Keep JIT out of the statistics aggregate (SM-1193).

-- aggregate_stats_v1 cannot estimate how few fast rows a window materializes. For a window that
-- starts in the past, such as a catch-up rollup pass or the live tail of a lagging rollup, the
-- planner expects about a thousand times the rows it reads. The plan's cost then crosses
-- jit_above_cost, and often jit_optimize_above_cost and jit_inline_above_cost. On 100,000 ready rows
-- and 400,000 fast outcomes, a three-bucket rollup pass took about 1 s with JIT and 34 ms without.
-- The function now disables JIT for itself. The setting applies whoever calls it, so it covers
-- rollup_stats_v1 and the live tail in stat_buckets_v1.
--
-- A function with a setting is never inlined. rollup_stats_v1 and direct callers therefore plan the
-- body on its own; stat_buckets_v1 passes a subquery argument and never inlined it. The body,
-- signature, and result are unchanged, and no change touches stored data.

ALTER FUNCTION workhorse.aggregate_stats_v1(timestamptz, timestamptz, integer) SET jit = off;
