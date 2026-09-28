-- workhorse-migration: {"kind":"additive"}

-- Plan dependency release once per session (SM-950).

-- resolve_dependents_many_v1 runs once per completing statement that settles a prerequisite. Its
-- lock, edge-release, counter, and release statements take arrays. PL/pgSQL planned each of them
-- again on every call: a custom plan sees a one-element array and costs less than the generic
-- plan, which assumes a default array size, so the plan cache never switched. Planning the four
-- statements cost more than running them, and a singly released task paid it on every
-- complete_v1. On a fan-in, sibling completers waited on the dependent's row for the whole call,
-- planning included.
--
-- Every statement reaches task_runtime and task_dependency through a primary key or a pending-edge
-- index that the arrays drive, so the generic plan probes by key at any table size. The function
-- now keeps that plan for the session. Its body, signature, and result are unchanged.
ALTER FUNCTION workhorse.resolve_dependents_many_v1(uuid[], text[])
  SET plan_cache_mode = force_generic_plan;

