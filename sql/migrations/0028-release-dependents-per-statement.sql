-- workhorse-migration: {"kind":"additive"}

-- Release dependents set-based per statement and cheapen dependency validation at enqueue
-- (SM-916).

-- The outcome trigger ran once per inserted outcome row, and each run resolved one prerequisite's
-- dependents one edge at a time. It locked each edge before the dependent's runtime row, while a
-- dependent's own terminal transition locks its runtime row before it releases the dependent's
-- edges, so the two could wait for each other. The trigger now runs once per statement over the
-- statement's inserted outcomes. It calls resolve_dependents_many_v1, which locks every blocked
-- dependent's runtime row FOR NO KEY UPDATE in identity order before it touches any edge, then
-- resolves the edges, fails or cancels settled dependents, and releases the rest, each with one
-- statement. The outcomes that one level writes fire the trigger again, so a cascade advances one
-- dependency level per statement. resolve_dependents_v1 keeps its signature and delegates.

-- Validation walked the whole connected component, took one advisory lock per member, and
-- enumerated every upstream path for the cycle check. An enqueue only ever inserts edges whose
-- dependent has no dependents of its own, so no such edge can close a cycle. Validation now locks
-- both endpoints of every inserted edge FOR NO KEY UPDATE in identity order, and when no inserted
-- dependent is a prerequisite it skips the component locks and the cycle check. It then bounds the
-- transitive cap through the unresolved upstream cone of the new prerequisites instead of the
-- component. Every other shape keeps the full check. The caps and their errors are unchanged.

CREATE OR REPLACE FUNCTION workhorse.validate_task_dependencies_v1()
RETURNS trigger
LANGUAGE plpgsql
-- The recursive walks' row estimates overshoot jit_above_cost, and JIT compilation then costs more
-- than the walk. Each walk is an index probe per frontier row, so one generic plan serves every
-- firing.
SET jit = off
SET plan_cache_mode = force_generic_plan
AS $$
DECLARE
  v_component_task_id text;
  v_cycle uuid[];
  v_fan_out_root uuid;
  v_limit_task_id uuid;
  v_sinks boolean;
  v_exact_fan_out boolean := true;
  v_prerequisites uuid[];
  v_cone uuid[];
  v_walk uuid[];
BEGIN
  -- Any concurrent edge insert that touches one of these tasks takes the same lock, so the checks
  -- below see every committed edge that names an endpoint. Key-share locks, which enqueue and
  -- foreign key checks take, do not conflict with this lock.
  PERFORM 1 FROM workhorse.task task
   WHERE task.id IN (
     SELECT inserted.dependent_task_id FROM inserted_dependencies inserted
     UNION
     SELECT inserted.prerequisite_task_id FROM inserted_dependencies inserted
   )
   ORDER BY task.id FOR NO KEY UPDATE;
  -- A cycle through a new edge needs a path from its prerequisite back to its dependent, and the
  -- last edge of that path names the dependent as a prerequisite. Enqueue always inserts such
  -- sinks, because every dependent it inserts is new.
  v_sinks := NOT EXISTS (
    SELECT 1 FROM workhorse.task_dependency dependency
     WHERE dependency.prerequisite_task_id IN (
       SELECT inserted.dependent_task_id FROM inserted_dependencies inserted
     )
  );
  IF NOT v_sinks THEN
    -- Lock every task in each pre-existing component touched by this statement in canonical order.
    -- Transactions which mutate disconnected components proceed independently. Mutations which
    -- overlap a component share a lock even when a concurrent commit has just merged its root.
    FOR v_component_task_id IN
      WITH RECURSIVE inserted_tasks(task_id) AS (
        SELECT inserted.dependent_task_id FROM inserted_dependencies inserted
        UNION
        SELECT inserted.prerequisite_task_id FROM inserted_dependencies inserted
      ), component(seed_task_id, task_id) AS (
        SELECT inserted_tasks.task_id, inserted_tasks.task_id FROM inserted_tasks
        UNION
        SELECT component.seed_task_id, neighbor.task_id
          FROM component
          CROSS JOIN LATERAL (
            SELECT dependency.prerequisite_task_id AS task_id
              FROM workhorse.task_dependency dependency
             WHERE dependency.dependent_task_id = component.task_id
               AND NOT EXISTS (
                 SELECT 1 FROM inserted_dependencies inserted
                  WHERE inserted.dependent_task_id = dependency.dependent_task_id
                    AND inserted.prerequisite_task_id = dependency.prerequisite_task_id
               )
            UNION
            SELECT dependency.dependent_task_id
              FROM workhorse.task_dependency dependency
             WHERE dependency.prerequisite_task_id = component.task_id
               AND NOT EXISTS (
                 SELECT 1 FROM inserted_dependencies inserted
                  WHERE inserted.dependent_task_id = dependency.dependent_task_id
                    AND inserted.prerequisite_task_id = dependency.prerequisite_task_id
               )
          ) neighbor
      )
      SELECT DISTINCT component.task_id::text
        FROM component
       ORDER BY component.task_id::text
    LOOP
      PERFORM pg_advisory_xact_lock(hashtextextended(
        'workhorse:task-dependency-component-task:' || v_component_task_id,
        0
      ));
    END LOOP;

    WITH RECURSIVE reachable(dependent_task_id, task_id, path) AS (
      SELECT inserted.dependent_task_id,
             inserted.prerequisite_task_id,
             ARRAY[inserted.dependent_task_id, inserted.prerequisite_task_id]
        FROM inserted_dependencies inserted
      UNION ALL
      SELECT reachable.dependent_task_id,
             edge.prerequisite_task_id,
             reachable.path || edge.prerequisite_task_id
        FROM reachable
        JOIN workhorse.task_dependency edge ON edge.dependent_task_id = reachable.task_id
       WHERE (
         edge.prerequisite_task_id = reachable.dependent_task_id
         OR NOT edge.prerequisite_task_id = ANY(reachable.path)
       )
         AND reachable.task_id <> reachable.dependent_task_id
    )
    SELECT reachable.path INTO v_cycle
      FROM reachable
     WHERE reachable.task_id = reachable.dependent_task_id
     ORDER BY cardinality(reachable.path)
     LIMIT 1;
    IF v_cycle IS NOT NULL THEN
      RAISE EXCEPTION USING
        ERRCODE = 'P1003',
        MESSAGE = 'dependency cycle rejected',
        DETAIL = jsonb_build_object(
          'dependentTaskId', v_cycle[1],
          'prerequisiteTaskId', v_cycle[2],
          'cycleTaskIds', to_jsonb(v_cycle[1:101]),
          'truncated', cardinality(v_cycle) > 101
        )::text;
    END IF;
  END IF;
  SELECT dependency.dependent_task_id INTO v_limit_task_id
      FROM workhorse.task_dependency dependency
      JOIN (
        SELECT DISTINCT inserted.dependent_task_id FROM inserted_dependencies inserted
         WHERE inserted.released_at IS NULL
      ) touched USING (dependent_task_id)
     WHERE dependency.released_at IS NULL
     GROUP BY dependency.dependent_task_id
    HAVING count(*) > 100
     ORDER BY dependency.dependent_task_id
     LIMIT 1;
  IF v_limit_task_id IS NOT NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P1005',
      MESSAGE = 'a task accepts at most 100 prerequisite dependencies',
      DETAIL = jsonb_build_object(
        'taskId', v_limit_task_id,
        'limit', 'prerequisites',
        'max', 100
      )::text;
  END IF;
  SELECT dependency.prerequisite_task_id INTO v_limit_task_id
      FROM workhorse.task_dependency dependency
      JOIN (
        SELECT DISTINCT inserted.prerequisite_task_id FROM inserted_dependencies inserted
      ) touched USING (prerequisite_task_id)
     GROUP BY dependency.prerequisite_task_id
    HAVING count(*) > 100
     ORDER BY dependency.prerequisite_task_id
     LIMIT 1;
  IF v_limit_task_id IS NOT NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P1005',
      MESSAGE = 'a task accepts at most 100 dependent tasks',
      DETAIL = jsonb_build_object(
        'taskId', v_limit_task_id,
        'limit', 'dependents',
        'max', 100
      )::text;
  END IF;
  SELECT array_agg(DISTINCT inserted.prerequisite_task_id) INTO v_prerequisites
    FROM inserted_dependencies inserted
   WHERE inserted.released_at IS NULL;
  IF v_prerequisites IS NOT NULL THEN
    IF v_sinks THEN
      -- New sinks change only the transitive counts of their prerequisites' unresolved upstream
      -- cone. Lock the cone with the component keys, then walk it again: a writer that grew the
      -- cone before the locks were granted is visible to the next walk, and its new members are
      -- locked in turn. Every walk step is a LATERAL index probe fenced by OFFSET 0, so the plan
      -- stays a nested loop over the frontier even when statistics lag a fast-growing graph.
      v_cone := '{}';
      LOOP
        WITH RECURSIVE cone(task_id) AS (
          SELECT unnest(v_prerequisites)
          UNION
          SELECT upstream.task_id
            FROM cone
            CROSS JOIN LATERAL (
              SELECT dependency.prerequisite_task_id AS task_id
                FROM workhorse.task_dependency dependency
               WHERE dependency.dependent_task_id = cone.task_id
                 AND dependency.released_at IS NULL
              OFFSET 0
            ) upstream
        )
        SELECT array_agg(cone.task_id ORDER BY cone.task_id::text) INTO v_walk
          FROM cone
         WHERE cone.task_id <> ALL(v_cone);
        EXIT WHEN v_walk IS NULL;
        FOREACH v_component_task_id IN ARRAY v_walk::text[] LOOP
          PERFORM pg_advisory_xact_lock(hashtextextended(
            'workhorse:task-dependency-component-task:' || v_component_task_id,
            0
          ));
        END LOOP;
        v_cone := v_cone || v_walk;
      END LOOP;
      -- A task's transitive dependents include those of every task below it, so the largest count
      -- in the cone belongs to a cone source. The union of the sources' dependents bounds every
      -- source's own count, so one walk that stops above the cap settles the common case. Only a
      -- union above the cap counts each source separately.
      SELECT array_agg(cone.task_id) INTO v_cone
        FROM unnest(v_cone) AS cone(task_id)
       WHERE NOT EXISTS (
         SELECT 1 FROM workhorse.task_dependency dependency
          WHERE dependency.dependent_task_id = cone.task_id
            AND dependency.released_at IS NULL
       );
      v_exact_fan_out := (
        WITH RECURSIVE reachable(task_id) AS (
          SELECT downstream.task_id
            FROM unnest(v_cone) AS source(task_id)
            CROSS JOIN LATERAL (
              SELECT dependency.dependent_task_id AS task_id
                FROM workhorse.task_dependency dependency
               WHERE dependency.prerequisite_task_id = source.task_id
                 AND dependency.released_at IS NULL
              OFFSET 0
            ) downstream
          UNION
          SELECT downstream.task_id
            FROM reachable
            CROSS JOIN LATERAL (
              SELECT dependency.dependent_task_id AS task_id
                FROM workhorse.task_dependency dependency
               WHERE dependency.prerequisite_task_id = reachable.task_id
                 AND dependency.released_at IS NULL
              OFFSET 0
            ) downstream
        )
        SELECT count(*) FROM (SELECT 1 FROM reachable LIMIT 101) bounded
      ) > 100 AND EXISTS (
        SELECT 1
          FROM unnest(v_cone) AS source(task_id)
         WHERE (
           WITH RECURSIVE reachable(task_id) AS (
             SELECT dependency.dependent_task_id
               FROM workhorse.task_dependency dependency
              WHERE dependency.prerequisite_task_id = source.task_id
                AND dependency.released_at IS NULL
             UNION
             SELECT downstream.task_id
               FROM reachable
               CROSS JOIN LATERAL (
                 SELECT dependency.dependent_task_id AS task_id
                   FROM workhorse.task_dependency dependency
                  WHERE dependency.prerequisite_task_id = reachable.task_id
                    AND dependency.released_at IS NULL
                 OFFSET 0
               ) downstream
           )
           SELECT count(*) FROM (SELECT 1 FROM reachable LIMIT 101) bounded
         ) > 100
      );
    END IF;
    -- The exact check names the same task whichever path reached it.
    IF v_exact_fan_out THEN
      WITH RECURSIVE affected(root_task_id) AS (
        SELECT unnest(v_prerequisites)
        UNION
        SELECT dependency.prerequisite_task_id
          FROM affected
          JOIN workhorse.task_dependency dependency
            ON dependency.dependent_task_id = affected.root_task_id
           AND dependency.released_at IS NULL
      ), reachable(root_task_id, dependent_task_id) AS (
        SELECT affected.root_task_id, dependency.dependent_task_id
          FROM affected
          JOIN workhorse.task_dependency dependency
            ON dependency.prerequisite_task_id = affected.root_task_id
           AND dependency.released_at IS NULL
        UNION
        SELECT reachable.root_task_id, dependency.dependent_task_id
          FROM reachable
          JOIN workhorse.task_dependency dependency
            ON dependency.prerequisite_task_id = reachable.dependent_task_id
           AND dependency.released_at IS NULL
      )
      SELECT reachable.root_task_id INTO v_fan_out_root
        FROM reachable
       GROUP BY reachable.root_task_id
      HAVING count(*) > 100
       ORDER BY reachable.root_task_id
       LIMIT 1;
      IF v_fan_out_root IS NOT NULL THEN
        RAISE EXCEPTION USING
          ERRCODE = 'P1005',
          MESSAGE = 'a task accepts at most 100 unresolved transitive dependent tasks',
          DETAIL = jsonb_build_object(
            'taskId', v_fan_out_root,
            'limit', 'unresolved_dependents',
            'max', 100
          )::text;
      END IF;
    END IF;
  END IF;
  IF EXISTS (
    SELECT dependency.dependent_task_id
      FROM workhorse.task_dependency dependency
      JOIN (
        SELECT DISTINCT inserted.dependent_task_id FROM inserted_dependencies inserted
         WHERE inserted.released_at IS NULL
      ) touched USING (dependent_task_id)
     WHERE dependency.released_at IS NULL
     GROUP BY dependency.dependent_task_id
    HAVING count(DISTINCT (
      dependency.on_success,
      dependency.on_failure,
      dependency.on_cancellation
    )) > 1
  ) THEN
    RAISE EXCEPTION 'every dependency edge for one task must use the same outcome policies';
  END IF;
  RETURN NULL;
END;
$$;

-- Resolve every pending edge from a set of prerequisites that reached terminal outcomes in the
-- same statement. The resolver locks the runtime row of every blocked dependent in identity order
-- before it touches any edge. A dependent's own terminal transition also holds its runtime row
-- before it releases the dependent's edges, so the two cannot wait for each other. The lock does
-- not conflict with the key-share lock an enqueue takes on a prerequisite's runtime row. Only the
-- delete of a dependent that fails or is canceled waits for such an enqueue, and that enqueue
-- waits for nothing the resolver holds.
CREATE OR REPLACE FUNCTION workhorse.resolve_dependents_many_v1(
  p_prerequisite_task_ids uuid[], p_prerequisite_states text[]
)
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  v_now timestamptz := clock_timestamp();
  v_dependents uuid[];
  v_settled_task_ids uuid[];
  v_settled_actions text[];
  v_final_prerequisite_task_ids uuid[];
  v_final_prerequisite_states text[];
  v_releasing_prerequisite_task_ids uuid[];
  v_releasing_prerequisite_states text[];
  v_terminated integer;
  v_released integer;
  v_deadline_task_ids uuid[];
  v_queue_names text[];
  v_task_id uuid;
  v_queue_name text;
BEGIN
  IF cardinality(p_prerequisite_task_ids) IS DISTINCT FROM cardinality(p_prerequisite_states) THEN
    RAISE EXCEPTION 'prerequisite identities and states must have the same length';
  END IF;
  IF EXISTS (
    SELECT 1 FROM unnest(p_prerequisite_states) prerequisite(state)
     WHERE prerequisite.state IS NULL
        OR prerequisite.state NOT IN ('succeeded', 'failed', 'canceled')
  ) THEN
    RAISE EXCEPTION 'prerequisite state must be succeeded, failed, or canceled';
  END IF;
  SELECT array_agg(locked.task_id ORDER BY locked.task_id) INTO v_dependents
    FROM (
      SELECT runtime.task_id
        FROM workhorse.task_runtime runtime
       WHERE runtime.task_id IN (
               SELECT dependency.dependent_task_id
                 FROM workhorse.task_dependency dependency
                WHERE dependency.prerequisite_task_id = ANY(p_prerequisite_task_ids)
                  AND dependency.released_at IS NULL
             )
         AND runtime.state = 'blocked'
       ORDER BY runtime.task_id
         FOR NO KEY UPDATE OF runtime
    ) locked;
  IF v_dependents IS NULL THEN
    RETURN 0;
  END IF;

  UPDATE workhorse.task_dependency dependency
     SET released_at = v_now,
         resolution = CASE prerequisite.state
           WHEN 'succeeded' THEN dependency.on_success
           WHEN 'failed' THEN dependency.on_failure
           ELSE dependency.on_cancellation
         END
    FROM unnest(p_prerequisite_task_ids, p_prerequisite_states) prerequisite(task_id, state)
   WHERE dependency.prerequisite_task_id = prerequisite.task_id
     AND dependency.dependent_task_id = ANY(v_dependents)
     AND dependency.released_at IS NULL;

  -- A dependent settles once no edge stays pending. Its fate is the first resolution in the order
  -- fail, cancel, release, with ties broken by prerequisite identity. A release names the
  -- smallest prerequisite in this call that resolved one of the dependent's edges.
  SELECT array_agg(final.dependent_task_id ORDER BY final.dependent_task_id),
         array_agg(final.resolution ORDER BY final.dependent_task_id),
         array_agg(final.prerequisite_task_id ORDER BY final.dependent_task_id),
         array_agg(final.state ORDER BY final.dependent_task_id),
         array_agg(releasing.task_id ORDER BY final.dependent_task_id),
         array_agg(releasing.state ORDER BY final.dependent_task_id)
    INTO v_settled_task_ids, v_settled_actions, v_final_prerequisite_task_ids,
         v_final_prerequisite_states, v_releasing_prerequisite_task_ids,
         v_releasing_prerequisite_states
    FROM (
      SELECT DISTINCT ON (dependency.dependent_task_id)
             dependency.dependent_task_id, dependency.resolution,
             dependency.prerequisite_task_id, outcome.state
        FROM workhorse.task_dependency dependency
        JOIN workhorse.task_outcome outcome ON outcome.task_id = dependency.prerequisite_task_id
       WHERE dependency.dependent_task_id = ANY(v_dependents)
         AND NOT EXISTS (
           SELECT 1 FROM workhorse.task_dependency pending
            WHERE pending.dependent_task_id = dependency.dependent_task_id
              AND pending.released_at IS NULL
         )
       ORDER BY dependency.dependent_task_id,
                CASE dependency.resolution WHEN 'fail' THEN 0 WHEN 'cancel' THEN 1 ELSE 2 END,
                dependency.prerequisite_task_id
    ) final
    CROSS JOIN LATERAL (
      SELECT prerequisite.task_id, prerequisite.state
        FROM unnest(p_prerequisite_task_ids, p_prerequisite_states) prerequisite(task_id, state)
        JOIN workhorse.task_dependency resolved
          ON resolved.dependent_task_id = final.dependent_task_id
         AND resolved.prerequisite_task_id = prerequisite.task_id
       ORDER BY prerequisite.task_id
       LIMIT 1
    ) releasing;
  IF v_settled_task_ids IS NULL THEN
    RETURN 0;
  END IF;

  -- The terminal outcomes are this statement's last write, so their trigger resolves the next
  -- level after this level's evidence exists.
  WITH settled AS (
    SELECT settled.task_id,
           CASE WHEN settled.action = 'fail' THEN 'failed' ELSE 'canceled' END AS state,
           CASE WHEN settled.action = 'fail'
             THEN 'dependency_failed' ELSE 'dependency_canceled' END AS event_type,
           jsonb_build_object(
             'name', CASE WHEN settled.action = 'fail'
               THEN 'DependencyFailed' ELSE 'DependencyCanceled' END,
             'message', CASE WHEN settled.action = 'fail'
               THEN 'a prerequisite reached a terminal outcome rejected by dependency policy'
               ELSE 'a prerequisite reached a terminal outcome that canceled its dependent' END,
             'prerequisite_task_id', settled.prerequisite_task_id,
             'prerequisite_state', settled.prerequisite_state,
             'policy_action', settled.action
           ) AS error
      FROM unnest(
        v_settled_task_ids, v_settled_actions, v_final_prerequisite_task_ids,
        v_final_prerequisite_states
      ) settled(task_id, action, prerequisite_task_id, prerequisite_state)
     WHERE settled.action IN ('fail', 'cancel')
  ), removed AS (
    DELETE FROM workhorse.task_runtime runtime
     USING settled
     WHERE runtime.task_id = settled.task_id
       AND runtime.state = 'blocked'
    RETURNING runtime.task_id, runtime.current_attempt, runtime.run_at
  ), events AS (
    INSERT INTO workhorse.task_event(task_id, event_type, details)
    SELECT removed.task_id, settled.event_type, settled.error
      FROM removed
      JOIN settled USING (task_id)
     ORDER BY removed.task_id
  )
  INSERT INTO workhorse.task_outcome(
    task_id, state, current_attempt, fence_token, run_at, error, finished_at, updated_at,
    history_through_at
  )
  SELECT removed.task_id, settled.state, removed.current_attempt, 0, removed.run_at,
         settled.error, v_now, v_now, v_now
    FROM removed
    JOIN settled USING (task_id)
   ORDER BY removed.task_id;
  GET DIAGNOSTICS v_terminated = ROW_COUNT;

  -- Ready dependents take FIFO sequence numbers in identity order.
  WITH releasing AS (
    SELECT settled.task_id, settled.prerequisite_task_id, settled.prerequisite_state
      FROM unnest(
        v_settled_task_ids, v_settled_actions, v_releasing_prerequisite_task_ids,
        v_releasing_prerequisite_states
      ) settled(task_id, action, prerequisite_task_id, prerequisite_state)
     WHERE settled.action = 'release'
  ), ready AS (
    SELECT ordered.task_id, nextval('workhorse.ready_sequence_seq') AS sequence
      FROM (
        SELECT runtime.task_id
          FROM workhorse.task_runtime runtime
          JOIN releasing USING (task_id)
         WHERE runtime.run_at <= v_now
         ORDER BY runtime.task_id
        OFFSET 0
      ) ordered
  ), released AS (
    UPDATE workhorse.task_runtime runtime
       SET state = CASE WHEN ready.task_id IS NULL THEN 'scheduled' ELSE 'ready' END,
           ready_at = CASE WHEN ready.task_id IS NOT NULL THEN v_now END,
           sequence = ready.sequence,
           updated_at = v_now
      FROM releasing
      LEFT JOIN ready ON ready.task_id = releasing.task_id
     WHERE runtime.task_id = releasing.task_id
       AND runtime.state = 'blocked'
    RETURNING runtime.task_id, runtime.state, runtime.queue_name, runtime.deadline_at
  ), events AS (
    INSERT INTO workhorse.task_event(task_id, event_type, details)
    SELECT released.task_id, 'dependency_released', jsonb_build_object(
             'prerequisite_task_id', releasing.prerequisite_task_id,
             'state', released.state,
             'reason', CASE releasing.prerequisite_state
               WHEN 'succeeded' THEN 'prerequisite_succeeded'
               WHEN 'failed' THEN 'prerequisite_failed_policy'
               WHEN 'canceled' THEN 'prerequisite_canceled_policy'
             END
           )
      FROM released
      JOIN releasing USING (task_id)
     ORDER BY released.task_id
  )
  SELECT count(*),
         array_agg(released.task_id ORDER BY released.task_id)
           FILTER (WHERE released.deadline_at <= v_now),
         array_agg(DISTINCT released.queue_name ORDER BY released.queue_name)
           FILTER (
             WHERE released.state = 'ready'
               AND (released.deadline_at IS NULL OR released.deadline_at > v_now)
           )
    INTO v_released, v_deadline_task_ids, v_queue_names
    FROM released;
  FOREACH v_task_id IN ARRAY coalesce(v_deadline_task_ids, '{}') LOOP
    PERFORM workhorse.terminalize_deadline_v1(v_task_id);
  END LOOP;
  FOREACH v_queue_name IN ARRAY coalesce(v_queue_names, '{}') LOOP
    PERFORM pg_notify('workhorse_tasks', v_queue_name);
  END LOOP;
  RETURN v_terminated + v_released;
END;
$$;

CREATE OR REPLACE FUNCTION workhorse.resolve_dependents_v1(
  p_prerequisite_task_id uuid, p_prerequisite_state text
)
RETURNS integer
LANGUAGE plpgsql
AS $$
BEGIN
  IF p_prerequisite_state NOT IN ('succeeded', 'failed', 'canceled') THEN
    RAISE EXCEPTION 'prerequisite state must be succeeded, failed, or canceled';
  END IF;
  RETURN workhorse.resolve_dependents_many_v1(
    ARRAY[p_prerequisite_task_id], ARRAY[p_prerequisite_state]
  );
END;
$$;

-- One firing per statement resolves every outcome the statement inserted. It first releases the
-- still-pending edges that enter each new terminal task, then resolves the edges that leave it.
CREATE OR REPLACE FUNCTION workhorse.resolve_task_outcome_dependencies_v1()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_task_ids uuid[];
  v_states text[];
BEGIN
  UPDATE workhorse.task_dependency dependency
     SET released_at = clock_timestamp(), resolution = 'release'
   WHERE dependency.dependent_task_id IN (SELECT outcome.task_id FROM new_outcomes outcome)
     AND dependency.released_at IS NULL;
  SELECT array_agg(outcome.task_id ORDER BY outcome.task_id),
         array_agg(outcome.state ORDER BY outcome.task_id)
    INTO v_task_ids, v_states
    FROM new_outcomes outcome;
  IF v_task_ids IS NOT NULL THEN
    PERFORM workhorse.resolve_dependents_many_v1(v_task_ids, v_states);
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS task_outcome_resolve_dependencies_insert ON workhorse.task_outcome;
CREATE TRIGGER task_outcome_resolve_dependencies_insert
  AFTER INSERT ON workhorse.task_outcome
  REFERENCING NEW TABLE AS new_outcomes
  FOR EACH STATEMENT EXECUTE FUNCTION workhorse.resolve_task_outcome_dependencies_v1();
