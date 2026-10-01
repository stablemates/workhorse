-- workhorse-migration: {"kind":"additive"}

-- Serialize schedule synchronization with the schedule tick (SM-1075).

-- Schema version 51 let sync_schedule_definitions_v2 upsert a namespace's definitions in the order
-- the caller listed them, under the workhorse:schedules:<namespace> lock that only synchronizations
-- take. fire_due_schedules_v2 holds workhorse:schedule-namespace:<namespace> instead, and moves each
-- definition's evaluation position in name order. A synchronization that listed b before a could
-- lock b while a tick locked a, and each then waited on the other's row until PostgreSQL aborted one
-- with SQLSTATE 40P01.
--
-- sync_schedule_definitions_v2 now takes the workhorse:schedule-namespace:<namespace> lock before
-- it reads or changes a definition. A tick only tries that lock and passes over a namespace whose
-- lock is held, so it never waits on a synchronization. A synchronization waits for a running tick
-- to commit. The lock also keeps a tick from moving a definition between the synchronization's read
-- of the previous definitions and its writes.

CREATE OR REPLACE FUNCTION workhorse.sync_schedule_definitions_v2(
  p_namespace text, p_definitions jsonb, p_prune boolean DEFAULT true
) RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  v_previous jsonb;
BEGIN
  -- A tick holds this lock while it moves its namespace's definition rows. Taking it before any
  -- row means a tick never waits on this synchronization, and a running tick finishes first.
  PERFORM pg_advisory_xact_lock(hashtextextended('workhorse:schedule-namespace:' || p_namespace, 0));

  IF COALESCE(p_namespace, '') = '' THEN RAISE EXCEPTION 'namespace must not be empty'; END IF;
  IF p_definitions IS NULL OR jsonb_typeof(p_definitions) <> 'array' THEN
    RAISE EXCEPTION 'schedule definitions must be a JSON array';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_definitions) definition
     WHERE COALESCE(definition->>'catchupPolicy', 'skip') NOT IN ('skip', 'latest', 'all')
  ) THEN
    RAISE EXCEPTION 'schedule catch-up policy must be skip, latest, or all';
  END IF;

  SELECT COALESCE(jsonb_object_agg(
    definition.schedule_name,
    jsonb_build_object(
      'revision', definition.revision,
      'cronExpression', definition.cron_expression,
      'timezone', definition.timezone,
      'configuredEnabled', definition.configured_enabled,
      'catchupPolicy', definition.catchup_policy
    )
  ), '{}'::jsonb)
  INTO v_previous
  FROM workhorse.schedule_definition definition
  WHERE definition.namespace = p_namespace;

  PERFORM workhorse.sync_schedule_definitions_internal_v1(p_namespace, p_definitions, p_prune);

  UPDATE workhorse.schedule_definition definition
     SET revision = definition.revision + CASE
           WHEN v_previous ? definition.schedule_name
             AND definition.revision = (v_previous->definition.schedule_name->>'revision')::bigint
             AND definition.catchup_policy IS DISTINCT FROM
               COALESCE(desired.value->>'catchupPolicy', 'skip')
           THEN 1 ELSE 0
         END,
         last_evaluated_at = CASE
           WHEN NOT (v_previous ? definition.schedule_name)
             OR (v_previous->definition.schedule_name->>'cronExpression') IS DISTINCT FROM
               definition.cron_expression
             OR (v_previous->definition.schedule_name->>'timezone') IS DISTINCT FROM
               definition.timezone
             OR (v_previous->definition.schedule_name->>'catchupPolicy') IS DISTINCT FROM
               COALESCE(desired.value->>'catchupPolicy', 'skip')
             OR (
               NOT (v_previous->definition.schedule_name->>'configuredEnabled')::boolean
               AND definition.configured_enabled
               AND COALESCE(desired.value->>'catchupPolicy', 'skip') = 'skip'
             )
           THEN date_trunc('second', clock_timestamp()) - interval '1 microsecond'
           ELSE definition.last_evaluated_at
         END,
         catchup_policy = COALESCE(desired.value->>'catchupPolicy', 'skip')
    FROM jsonb_array_elements(p_definitions) desired(value)
   WHERE definition.namespace = p_namespace
     AND definition.schedule_name = desired.value->>'name';
END;
$$;
