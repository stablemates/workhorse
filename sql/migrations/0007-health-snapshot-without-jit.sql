-- workhorse-migration: {"kind":"additive"}

-- Health snapshot without JIT (SM-758).

-- The health snapshot reads every correctness-sensitive value in one statement, so its plan carries
-- hundreds of expressions. Once a queue holds tens of thousands of ready rows the plan's estimated
-- cost crosses `jit_inline_above_cost` and `jit_optimize_above_cost`, and LLVM spends about two
-- seconds compiling a statement that executes in tens of milliseconds. The four dashboard reads
-- that embed the snapshot pay the same compilation. Each function now disables JIT for itself, the
-- way `dashboard_activity_v1`, `dashboard_events_v1`, and `dashboard_tasks_cursor_v1` already do.

ALTER FUNCTION workhorse.queue_health_v1(timestamptz) SET jit = off;
ALTER FUNCTION workhorse.dashboard_human_waits_v1(jsonb) SET jit = off;
ALTER FUNCTION workhorse.dashboard_queues_v1(jsonb) SET jit = off;
ALTER FUNCTION workhorse.dashboard_settings_v1(jsonb) SET jit = off;
ALTER FUNCTION workhorse.dashboard_system_v1(jsonb) SET jit = off;
