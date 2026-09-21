-- workhorse-migration: {"kind":"additive"}

-- A canceled dependent releases its own edges (SM-816).

-- An edge released when its prerequisite reached a terminal outcome, and only then. A dependent
-- canceled while it was still blocked therefore left every edge pending. A pending edge is not a
-- prune candidate, and `prerequisite_task_id` restricts deletion, so that abandoned edge held its
-- prerequisite's task identity against retention for as long as the dependent identity survived.
-- Queue health reported the symptom as `retentionPruneStarved`.

-- The outcome trigger now releases the pending edges the terminal task itself waited on, before it
-- resolves the dependents that waited on the terminal task. Every path that writes a terminal
-- outcome is covered by that one trigger, so a deadline that lands on blocked work settles its
-- edges exactly as a cancellation does. A task whose edges all resolved before it reached dispatch
-- has nothing pending, so the new statement matches no row on the ordinary path.

-- Release the pending edges a terminal task itself waited on. The edge resolves as `release`
-- because no prerequisite outcome chose an action for it: the dependent was already terminal when
-- the edge stopped controlling dispatch, so the resolution changes nothing about the dependent.
-- Releasing here changes no dispatch state; it only makes the edge eligible for
-- workhorse.prune_released_dependencies_v1.
CREATE OR REPLACE FUNCTION workhorse.release_own_dependencies_v1(p_dependent_task_id uuid)
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE v_count integer;
BEGIN
  UPDATE workhorse.task_dependency dependency
     SET released_at = clock_timestamp(), resolution = 'release'
   WHERE dependency.dependent_task_id = p_dependent_task_id
     AND dependency.released_at IS NULL;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

CREATE OR REPLACE FUNCTION workhorse.resolve_task_outcome_dependencies_v1()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM workhorse.release_own_dependencies_v1(NEW.task_id);
  PERFORM workhorse.resolve_dependents_v1(NEW.task_id, NEW.state);
  RETURN NEW;
END;
$$;

-- Edges abandoned before this step keep their prerequisites pinned, so release the ones whose
-- dependent is already terminal. `dependent_task_id` cascades, so an abandoned edge disappears
-- when its dependent's identity is purged; the statement therefore touches only edges inside the
-- retention window rather than the whole relation. Rerunning it matches nothing.
UPDATE workhorse.task_dependency dependency
   SET released_at = clock_timestamp(), resolution = 'release'
  FROM workhorse.task_outcome outcome
 WHERE outcome.task_id = dependency.dependent_task_id
   AND dependency.released_at IS NULL;
