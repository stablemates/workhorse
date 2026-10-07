-- workhorse-migration: {"kind":"additive"}

-- Close SQL integrity gaps in rate refill, rate CHECK constraints, dependency edges, and mixed
-- enqueue batches (SM-1165).

-- A synchronization that changed a rate refilled the time since the last charge at the new rate.
-- sync_rate_limit_policies_v1 and sync_budgets_v1 now refill each changed bucket to one clock
-- reading at the old rate, and the new policy applies from that reading.
--
-- A CHECK that evaluates to null passes, so an incomplete per-key or budget rate setting was
-- accepted. An additive step cannot replace a constraint, so a second constraint on each table
-- requires all three rate fields or none. An incomplete setting already stored is cleared first.
-- A budget that the clearing would leave without a limit is deleted, because a missing budget row
-- imposes no limit.
--
-- An update could change a dependency edge's endpoints or outcome policies without the insert
-- validation. A trigger now rejects such an update.
--
-- A debounce or throttle member made enqueue_many_v1 enqueue member by member, and each plain
-- member locked only its own prerequisites. lock_enqueue_prerequisites_internal_v1 now locks every
-- member's prerequisites first, in both batch paths.
--
-- run_task_now_v1 raised an internal error for a blocked task. It now reports not_scheduled.

UPDATE workhorse.rate_limit_policy
   SET per_key_limit = NULL, per_key_interval_ms = NULL, per_key_burst = NULL
 WHERE num_nulls(per_key_limit, per_key_interval_ms, per_key_burst) IN (1, 2);
ALTER TABLE workhorse.rate_limit_policy
  ADD CONSTRAINT rate_limit_policy_per_key_complete_check CHECK (
    num_nulls(per_key_limit, per_key_interval_ms, per_key_burst) IN (0, 3)
  );

DELETE FROM workhorse.budget
 WHERE max_active IS NULL AND num_nulls(rate_limit, rate_interval_ms, rate_burst) IN (1, 2);
UPDATE workhorse.budget
   SET rate_limit = NULL, rate_interval_ms = NULL, rate_burst = NULL
 WHERE num_nulls(rate_limit, rate_interval_ms, rate_burst) IN (1, 2);
ALTER TABLE workhorse.budget
  ADD CONSTRAINT budget_rate_complete_check CHECK (
    num_nulls(rate_limit, rate_interval_ms, rate_burst) IN (0, 3)
  );

-- Refill a queue's stored admission shards to p_now at the rate policy that synchronization is
-- about to replace. The refill uses the shares rebalance_admission_shards_v1 reads, keeps the latest
-- refill time, and leaves a full shard full. A rebalance at the same p_now under the new policy then
-- refills nothing, so time before p_now never earns tokens at the new rate. The function takes the
-- locks a rebalance takes, in the same order.
CREATE OR REPLACE FUNCTION workhorse.refill_admission_shards_internal_v1(
  p_queue_name text,
  p_rate_limit integer,
  p_rate_interval_ms integer,
  p_rate_burst integer,
  p_now timestamptz
) RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('workhorse:admission-shards:' || p_queue_name, 0));
  FOR v_shard IN 0..7 LOOP
    PERFORM pg_advisory_xact_lock(
      hashtextextended('workhorse:admission-shard:' || p_queue_name || ':' || v_shard, 0)
    );
  END LOOP;
  UPDATE workhorse.admission_shard shard_row
     SET tokens = LEAST(
           refilled.share::numeric,
           shard_row.tokens + GREATEST(
             0::numeric,
             extract(epoch FROM p_now - shard_row.refilled_at) * 1000
           ) * p_rate_limit::numeric * refilled.share
             / (p_rate_interval_ms::numeric * p_rate_burst)
         ),
         refilled_at = GREATEST(p_now, shard_row.refilled_at)
    FROM (
      SELECT stored.shard,
             workhorse.admission_share_v1(
               p_rate_burst, (count(*) OVER ())::integer,
               (row_number() OVER (ORDER BY stored.shard))::integer - 1
             ) AS share
        FROM workhorse.admission_shard stored
       WHERE stored.queue_name = p_queue_name
    ) refilled
   WHERE shard_row.queue_name = p_queue_name AND shard_row.shard = refilled.shard
     AND shard_row.tokens IS NOT NULL;
END;
$$;

-- Synchronize queue rate limits as deployment-owned desired state. A policy update keeps the tokens
-- a queue has accrued. For each changed queue, the synchronization reads the clock once. It refills
-- the queue's admission shards and per-key buckets to that time at the old rate, then applies the
-- new policy from that time. It clamps the shards' sum to the new burst and spreads it over the new
-- shards, so it never manufactures starts (ADR 0082). A per-key rule added to a queue without one
-- discards any stale per-key bucket, so each key starts full. A removed per-key rule leaves its
-- buckets for claims to discard.
CREATE OR REPLACE FUNCTION workhorse.sync_rate_limit_policies_v1(
  p_namespace text,
  p_definitions jsonb,
  p_prune boolean DEFAULT true
) RETURNS TABLE (
  namespace text,
  queue_name text,
  rate_limit integer,
  rate_interval_ms integer,
  rate_burst integer,
  per_key_limit integer,
  per_key_interval_ms integer,
  per_key_burst integer,
  updated_at timestamptz
)
LANGUAGE plpgsql
AS $$
DECLARE
  v_definition jsonb;
  v_rate jsonb;
  v_per_key jsonb;
  v_queue_name text;
  v_rate_limit numeric;
  v_rate_interval_ms numeric;
  v_rate_burst numeric;
  v_per_key_limit numeric;
  v_per_key_interval_ms numeric;
  v_per_key_burst numeric;
  v_seen text[] := '{}';
  v_notify_queues text[] := '{}';
  v_previous_policy workhorse.rate_limit_policy%ROWTYPE;
  v_previous jsonb := '{}';
  v_old jsonb;
  v_now timestamptz;
BEGIN
  IF p_namespace IS NULL OR p_namespace = '' OR octet_length(p_namespace) > 256 THEN
    RAISE EXCEPTION 'rate-limit policy namespace must contain between 1 and 256 UTF-8 bytes';
  END IF;
  IF p_definitions IS NULL OR jsonb_typeof(p_definitions) <> 'array' THEN
    RAISE EXCEPTION 'rate-limit policy definitions must be a JSON array';
  END IF;
  IF jsonb_array_length(p_definitions) > 10000 THEN
    RAISE EXCEPTION 'rate-limit policy definitions exceed maximum size of 10000';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('workhorse:rate-limit-policies', 0));

  FOR v_definition IN SELECT value FROM jsonb_array_elements(p_definitions)
  LOOP
    IF jsonb_typeof(v_definition) <> 'object'
       OR v_definition - ARRAY['queue', 'rate', 'perKey'] <> '{}'::jsonb
       OR NOT (v_definition ? 'queue') OR NOT (v_definition ? 'rate')
       OR jsonb_typeof(v_definition->'queue') <> 'string'
       OR jsonb_typeof(v_definition->'rate') <> 'object'
       OR (v_definition ? 'perKey' AND v_definition->'perKey' <> 'null'::jsonb
         AND jsonb_typeof(v_definition->'perKey') <> 'object') THEN
      RAISE EXCEPTION 'each rate-limit policy requires queue and rate, with optional perKey';
    END IF;
    v_queue_name := v_definition->>'queue';
    v_rate := v_definition->'rate';
    v_per_key := v_definition->'perKey';
    IF v_queue_name = '' OR octet_length(v_queue_name) > 256 THEN
      RAISE EXCEPTION 'rate-limit policy queue must contain between 1 and 256 UTF-8 bytes';
    END IF;
    IF v_queue_name = ANY(v_seen) THEN
      RAISE EXCEPTION 'rate-limit policy queue names must be unique';
    END IF;
    IF v_rate - ARRAY['limit', 'intervalMs', 'burst'] <> '{}'::jsonb
       OR NOT (v_rate ?& ARRAY['limit', 'intervalMs', 'burst'])
       OR jsonb_typeof(v_rate->'limit') <> 'number'
       OR jsonb_typeof(v_rate->'intervalMs') <> 'number'
       OR jsonb_typeof(v_rate->'burst') <> 'number' THEN
      RAISE EXCEPTION 'rate requires numeric limit, intervalMs, and burst';
    END IF;
    IF v_per_key IS NOT NULL AND v_per_key <> 'null'::jsonb AND (
      v_per_key - ARRAY['limit', 'intervalMs', 'burst'] <> '{}'::jsonb
      OR NOT (v_per_key ?& ARRAY['limit', 'intervalMs', 'burst'])
      OR jsonb_typeof(v_per_key->'limit') <> 'number'
      OR jsonb_typeof(v_per_key->'intervalMs') <> 'number'
      OR jsonb_typeof(v_per_key->'burst') <> 'number'
    ) THEN
      RAISE EXCEPTION 'perKey requires numeric limit, intervalMs, and burst';
    END IF;
    v_rate_limit := (v_rate->>'limit')::numeric;
    v_rate_interval_ms := (v_rate->>'intervalMs')::numeric;
    v_rate_burst := (v_rate->>'burst')::numeric;
    v_per_key_limit := (v_per_key->>'limit')::numeric;
    v_per_key_interval_ms := (v_per_key->>'intervalMs')::numeric;
    v_per_key_burst := (v_per_key->>'burst')::numeric;
    IF v_rate_limit <> trunc(v_rate_limit) OR v_rate_limit NOT BETWEEN 1 AND 1000000
       OR v_rate_interval_ms <> trunc(v_rate_interval_ms)
       OR v_rate_interval_ms NOT BETWEEN 1 AND 86400000
       OR v_rate_burst <> trunc(v_rate_burst) OR v_rate_burst NOT BETWEEN 1 AND 1000000 THEN
      RAISE EXCEPTION 'rate values must be bounded positive integers';
    END IF;
    IF v_per_key_limit IS NOT NULL AND (
      v_per_key_limit <> trunc(v_per_key_limit) OR v_per_key_limit NOT BETWEEN 1 AND 1000000
      OR v_per_key_interval_ms <> trunc(v_per_key_interval_ms)
      OR v_per_key_interval_ms NOT BETWEEN 1 AND 86400000
      OR v_per_key_burst <> trunc(v_per_key_burst)
      OR v_per_key_burst NOT BETWEEN 1 AND 1000000
    ) THEN
      RAISE EXCEPTION 'perKey values must be bounded positive integers';
    END IF;
    v_seen := array_append(v_seen, v_queue_name);
    v_notify_queues := array_append(v_notify_queues, v_queue_name);
    PERFORM pg_advisory_xact_lock(
      hashtextextended('workhorse:rate-limit-policy:' || v_queue_name, 0)
    );
    IF cardinality(workhorse.lock_queue_tiers_v1(ARRAY[v_queue_name])) > 0 THEN
      PERFORM workhorse.reject_fast_feature_v1(v_queue_name, 'rate-limit policies');
    END IF;
    IF EXISTS (
      SELECT 1 FROM workhorse.rate_limit_policy policy
       WHERE policy.queue_name = v_queue_name AND policy.namespace <> p_namespace
    ) THEN
      RAISE EXCEPTION 'rate-limit policy queue is owned by another namespace';
    END IF;
    SELECT policy.* INTO v_previous_policy
      FROM workhorse.rate_limit_policy policy WHERE policy.queue_name = v_queue_name;
    IF FOUND THEN
      v_previous := v_previous || jsonb_build_object(v_queue_name, to_jsonb(v_previous_policy));
    END IF;
    INSERT INTO workhorse.rate_limit_policy AS policy(
      queue_name, namespace, rate_limit, rate_interval_ms, rate_burst,
      per_key_limit, per_key_interval_ms, per_key_burst, updated_at
    ) VALUES (
      v_queue_name, p_namespace, v_rate_limit::integer, v_rate_interval_ms::integer,
      v_rate_burst::integer, v_per_key_limit::integer, v_per_key_interval_ms::integer,
      v_per_key_burst::integer, clock_timestamp()
    )
    ON CONFLICT ON CONSTRAINT rate_limit_policy_pkey DO UPDATE SET
      rate_limit = EXCLUDED.rate_limit,
      rate_interval_ms = EXCLUDED.rate_interval_ms,
      rate_burst = EXCLUDED.rate_burst,
      per_key_limit = EXCLUDED.per_key_limit,
      per_key_interval_ms = EXCLUDED.per_key_interval_ms,
      per_key_burst = EXCLUDED.per_key_burst,
      updated_at = CASE WHEN
        (policy.rate_limit, policy.rate_interval_ms, policy.rate_burst,
         policy.per_key_limit, policy.per_key_interval_ms, policy.per_key_burst)
        IS DISTINCT FROM
        (EXCLUDED.rate_limit, EXCLUDED.rate_interval_ms, EXCLUDED.rate_burst,
         EXCLUDED.per_key_limit, EXCLUDED.per_key_interval_ms, EXCLUDED.per_key_burst)
        THEN EXCLUDED.updated_at ELSE policy.updated_at END;
  END LOOP;

  IF p_prune THEN
    FOR v_queue_name IN
      SELECT policy.queue_name FROM workhorse.rate_limit_policy policy
       WHERE policy.namespace = p_namespace AND NOT (policy.queue_name = ANY(v_seen))
       ORDER BY policy.queue_name
    LOOP
      v_notify_queues := array_append(v_notify_queues, v_queue_name);
      PERFORM pg_advisory_xact_lock(
        hashtextextended('workhorse:rate-limit-policy:' || v_queue_name, 0)
      );
    END LOOP;
    DELETE FROM workhorse.rate_limit_policy policy
     WHERE policy.namespace = p_namespace AND NOT (policy.queue_name = ANY(v_seen));
  END IF;

  FOR v_queue_name IN
    SELECT DISTINCT affected.queue_name
      FROM unnest(v_notify_queues) AS affected(queue_name)
     ORDER BY affected.queue_name
  LOOP
    v_now := clock_timestamp();
    v_old := v_previous->v_queue_name;
    IF v_old IS NOT NULL AND EXISTS (
      SELECT 1 FROM workhorse.rate_limit_policy policy
       WHERE policy.queue_name = v_queue_name
         AND (policy.rate_limit, policy.rate_interval_ms, policy.rate_burst)
             IS DISTINCT FROM ((v_old->>'rate_limit')::integer,
               (v_old->>'rate_interval_ms')::integer, (v_old->>'rate_burst')::integer)
    ) THEN
      PERFORM workhorse.refill_admission_shards_internal_v1(
        v_queue_name, (v_old->>'rate_limit')::integer, (v_old->>'rate_interval_ms')::integer,
        (v_old->>'rate_burst')::integer, v_now
      );
    END IF;
    IF v_old IS NOT NULL AND EXISTS (
      SELECT 1 FROM workhorse.rate_limit_policy policy
       WHERE policy.queue_name = v_queue_name AND policy.per_key_limit IS NOT NULL
         AND (policy.per_key_limit, policy.per_key_interval_ms, policy.per_key_burst)
             IS DISTINCT FROM ((v_old->>'per_key_limit')::integer,
               (v_old->>'per_key_interval_ms')::integer, (v_old->>'per_key_burst')::integer)
    ) THEN
      IF v_old->'per_key_limit' = 'null'::jsonb THEN
        DELETE FROM workhorse.rate_limit_bucket bucket
         WHERE bucket.queue_name = v_queue_name AND bucket.bucket_scope = 'key';
      ELSE
        UPDATE workhorse.rate_limit_bucket bucket
           SET tokens = LEAST(
                 (v_old->>'per_key_burst')::numeric,
                 bucket.tokens + GREATEST(
                   0::numeric,
                   extract(epoch FROM v_now - bucket.refilled_at) * 1000
                 ) * (v_old->>'per_key_limit')::numeric
                   / (v_old->>'per_key_interval_ms')::numeric
               ),
               refilled_at = GREATEST(v_now, bucket.refilled_at)
         WHERE bucket.queue_name = v_queue_name AND bucket.bucket_scope = 'key';
      END IF;
    END IF;
    PERFORM workhorse.rebalance_admission_shards_v1(v_queue_name, v_now);
    PERFORM pg_notify('workhorse_tasks', v_queue_name);
  END LOOP;
  RETURN QUERY
    SELECT policy.namespace, policy.queue_name, policy.rate_limit, policy.rate_interval_ms,
           policy.rate_burst, policy.per_key_limit, policy.per_key_interval_ms,
           policy.per_key_burst, policy.updated_at
      FROM workhorse.rate_limit_policy policy
     WHERE policy.namespace = p_namespace ORDER BY policy.queue_name;
END;
$$;

-- Reconcile one namespace's budgets. Mirrors sync_rate_limit_policies_v1: strict definition
-- shapes, cross-namespace ownership refusal, pruning by default, and a wake hint for queues that
-- hold ready work naming an affected budget. It takes each named or pruned budget's lock in name
-- order, the order a claim takes them, so a claim reads one definition from admission to charge.
CREATE OR REPLACE FUNCTION workhorse.sync_budgets_v1(
  p_namespace text,
  p_definitions jsonb,
  p_prune boolean DEFAULT true
) RETURNS TABLE (
  namespace text,
  budget_name text,
  max_active integer,
  rate_limit integer,
  rate_interval_ms integer,
  rate_burst integer,
  updated_at timestamptz
)
LANGUAGE plpgsql
AS $$
DECLARE
  v_definition jsonb;
  v_rate jsonb;
  v_budget_name text;
  v_max_active numeric;
  v_rate_limit numeric;
  v_rate_interval_ms numeric;
  v_rate_burst numeric;
  v_seen text[] := '{}';
  v_affected text[] := '{}';
  v_queue_name text;
  v_previous workhorse.budget%ROWTYPE;
  v_now timestamptz;
BEGIN
  IF p_namespace IS NULL OR p_namespace = '' OR octet_length(p_namespace) > 256 THEN
    RAISE EXCEPTION 'budget namespace must contain between 1 and 256 UTF-8 bytes';
  END IF;
  IF p_definitions IS NULL OR jsonb_typeof(p_definitions) <> 'array' THEN
    RAISE EXCEPTION 'budget definitions must be a JSON array';
  END IF;
  IF jsonb_array_length(p_definitions) > 10000 THEN
    RAISE EXCEPTION 'budget definitions exceed maximum size of 10000';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('workhorse:budgets', 0));
  -- Lock every budget this call can write or prune before reading any definition. Name order
  -- matches the claims, which take these locks in name order too, so the two cannot deadlock.
  FOR v_budget_name IN
    SELECT affected.budget_name
      FROM (
        SELECT definition.value->>'name' AS budget_name
          FROM jsonb_array_elements(p_definitions) definition
         WHERE jsonb_typeof(definition.value) = 'object'
           AND jsonb_typeof(definition.value->'name') = 'string'
        UNION
        SELECT budget.budget_name
          FROM workhorse.budget budget
         WHERE p_prune AND budget.namespace = p_namespace
      ) affected
     ORDER BY affected.budget_name
  LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended('workhorse:budget:' || v_budget_name, 0));
  END LOOP;

  FOR v_definition IN SELECT value FROM jsonb_array_elements(p_definitions)
  LOOP
    IF jsonb_typeof(v_definition) <> 'object'
       OR v_definition - ARRAY['name', 'maxActive', 'rate'] <> '{}'::jsonb
       OR NOT (v_definition ? 'name')
       OR jsonb_typeof(v_definition->'name') <> 'string'
       OR (v_definition ? 'maxActive'
         AND v_definition->'maxActive' <> 'null'::jsonb
         AND jsonb_typeof(v_definition->'maxActive') <> 'number')
       OR (v_definition ? 'rate'
         AND v_definition->'rate' <> 'null'::jsonb
         AND jsonb_typeof(v_definition->'rate') <> 'object') THEN
      RAISE EXCEPTION 'each budget requires name, with optional maxActive and rate';
    END IF;
    v_budget_name := v_definition->>'name';
    v_max_active := (v_definition->>'maxActive')::numeric;
    v_rate := CASE WHEN v_definition->'rate' = 'null'::jsonb THEN NULL
      ELSE v_definition->'rate' END;
    IF v_budget_name = '' OR octet_length(v_budget_name) > 256 THEN
      RAISE EXCEPTION 'budget name must contain between 1 and 256 UTF-8 bytes';
    END IF;
    IF v_budget_name = ANY(v_seen) THEN
      RAISE EXCEPTION 'budget names must be unique';
    END IF;
    IF v_max_active IS NULL AND v_rate IS NULL THEN
      RAISE EXCEPTION 'each budget requires maxActive, rate, or both';
    END IF;
    IF v_max_active IS NOT NULL AND (
      v_max_active <> trunc(v_max_active) OR v_max_active NOT BETWEEN 1 AND 1000000
    ) THEN
      RAISE EXCEPTION 'budget maxActive must be an integer between 1 and 1000000';
    END IF;
    IF v_rate IS NOT NULL THEN
      IF v_rate - ARRAY['limit', 'intervalMs', 'burst'] <> '{}'::jsonb
         OR NOT (v_rate ?& ARRAY['limit', 'intervalMs', 'burst'])
         OR jsonb_typeof(v_rate->'limit') <> 'number'
         OR jsonb_typeof(v_rate->'intervalMs') <> 'number'
         OR jsonb_typeof(v_rate->'burst') <> 'number' THEN
        RAISE EXCEPTION 'budget rate requires limit, intervalMs, and burst';
      END IF;
      v_rate_limit := (v_rate->>'limit')::numeric;
      v_rate_interval_ms := (v_rate->>'intervalMs')::numeric;
      v_rate_burst := (v_rate->>'burst')::numeric;
      IF v_rate_limit <> trunc(v_rate_limit) OR v_rate_limit NOT BETWEEN 1 AND 1000000
         OR v_rate_interval_ms <> trunc(v_rate_interval_ms)
         OR v_rate_interval_ms NOT BETWEEN 1 AND 86400000
         OR v_rate_burst <> trunc(v_rate_burst) OR v_rate_burst NOT BETWEEN 1 AND 1000000 THEN
        RAISE EXCEPTION 'budget rate values must be bounded positive integers';
      END IF;
    ELSE
      v_rate_limit := NULL;
      v_rate_interval_ms := NULL;
      v_rate_burst := NULL;
    END IF;
    v_seen := array_append(v_seen, v_budget_name);
    v_affected := array_append(v_affected, v_budget_name);
    IF EXISTS (
      SELECT 1 FROM workhorse.budget budget
       WHERE budget.budget_name = v_budget_name AND budget.namespace <> p_namespace
    ) THEN
      RAISE EXCEPTION 'budget is owned by another namespace';
    END IF;
    -- Refill the bucket to now at the old rate before a new rate applies. A rate added to a
    -- budget without one discards any stale bucket, so the budget starts full. A removed rate
    -- leaves its bucket unread.
    SELECT budget.* INTO v_previous
      FROM workhorse.budget budget WHERE budget.budget_name = v_budget_name;
    IF FOUND AND v_rate_limit IS NOT NULL
       AND (v_previous.rate_limit, v_previous.rate_interval_ms, v_previous.rate_burst)
       IS DISTINCT FROM (v_rate_limit::integer, v_rate_interval_ms::integer, v_rate_burst::integer)
    THEN
      v_now := clock_timestamp();
      IF v_previous.rate_limit IS NULL THEN
        DELETE FROM workhorse.budget_bucket bucket WHERE bucket.budget_name = v_budget_name;
      ELSE
        UPDATE workhorse.budget_bucket bucket
           SET tokens = LEAST(
                 v_previous.rate_burst::numeric,
                 bucket.tokens + GREATEST(
                   0::numeric,
                   extract(epoch FROM v_now - bucket.refilled_at) * 1000
                 ) * v_previous.rate_limit::numeric / v_previous.rate_interval_ms::numeric
               ),
               refilled_at = GREATEST(v_now, bucket.refilled_at)
         WHERE bucket.budget_name = v_budget_name;
      END IF;
    END IF;
    INSERT INTO workhorse.budget AS budget(
      budget_name, namespace, max_active, rate_limit, rate_interval_ms, rate_burst, updated_at
    ) VALUES (
      v_budget_name, p_namespace, v_max_active::integer, v_rate_limit::integer,
      v_rate_interval_ms::integer, v_rate_burst::integer, clock_timestamp()
    )
    ON CONFLICT ON CONSTRAINT budget_pkey DO UPDATE SET
      max_active = EXCLUDED.max_active,
      rate_limit = EXCLUDED.rate_limit,
      rate_interval_ms = EXCLUDED.rate_interval_ms,
      rate_burst = EXCLUDED.rate_burst,
      updated_at = CASE
        WHEN budget.max_active IS DISTINCT FROM EXCLUDED.max_active
          OR budget.rate_limit IS DISTINCT FROM EXCLUDED.rate_limit
          OR budget.rate_interval_ms IS DISTINCT FROM EXCLUDED.rate_interval_ms
          OR budget.rate_burst IS DISTINCT FROM EXCLUDED.rate_burst
        THEN EXCLUDED.updated_at ELSE budget.updated_at
      END;
  END LOOP;

  IF p_prune THEN
    v_affected := v_affected || ARRAY(
      SELECT budget.budget_name
        FROM workhorse.budget budget
       WHERE budget.namespace = p_namespace AND NOT (budget.budget_name = ANY(v_seen))
       ORDER BY budget.budget_name
    );
    DELETE FROM workhorse.budget budget
     WHERE budget.namespace = p_namespace AND NOT (budget.budget_name = ANY(v_seen));
  END IF;

  FOR v_queue_name IN
    SELECT DISTINCT runtime.queue_name
      FROM workhorse.task_runtime runtime
     WHERE runtime.state = 'ready' AND runtime.budget_name = ANY(v_affected)
     ORDER BY runtime.queue_name
     LIMIT 100
  LOOP
    PERFORM pg_notify('workhorse_tasks', v_queue_name);
  END LOOP;

  RETURN QUERY
    SELECT budget.namespace, budget.budget_name, budget.max_active, budget.rate_limit,
           budget.rate_interval_ms, budget.rate_burst, budget.updated_at
      FROM workhorse.budget budget
     WHERE budget.namespace = p_namespace
     ORDER BY budget.budget_name;
END;
$$;

-- The insert triggers validate an edge's endpoints and outcome policies, and the dependent's cached
-- prerequisite counters count the edge as inserted. An update may only release the edge, so an
-- update that changes an endpoint or an outcome policy is rejected rather than revalidated.
CREATE OR REPLACE FUNCTION workhorse.reject_task_dependency_change_v1()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION USING
    ERRCODE = '55000',
    MESSAGE = 'dependency edge endpoints and outcome policies cannot change after insertion',
    DETAIL = jsonb_build_object(
      'dependentTaskId', OLD.dependent_task_id,
      'prerequisiteTaskId', OLD.prerequisite_task_id
    )::text;
END;
$$;

CREATE OR REPLACE TRIGGER task_dependency_reject_change
  BEFORE UPDATE OF dependent_task_id, prerequisite_task_id, on_success, on_failure, on_cancellation
  ON workhorse.task_dependency
  FOR EACH ROW
  WHEN (
    (OLD.dependent_task_id, OLD.prerequisite_task_id, OLD.on_success, OLD.on_failure,
     OLD.on_cancellation)
    IS DISTINCT FROM
    (NEW.dependent_task_id, NEW.prerequisite_task_id, NEW.on_success, NEW.on_failure,
     NEW.on_cancellation)
  )
  EXECUTE FUNCTION workhorse.reject_task_dependency_change_v1();

-- Lock the prerequisites of every request in one enqueue batch before the batch inserts anything.
--
-- Every terminal transition deletes the runtime row before it records the outcome that resolves
-- dependents. Holding the runtime row makes that transition wait until the batch's edges commit, so
-- its resolver sees them. A transition that committed first has already deleted the row, and the
-- batch's outcome reads see its outcome. Key-share locks do not block the non-key updates that
-- claims and heartbeats make.
--
-- The locks are taken in identity order. A resolver locks the dependents it deletes in the same
-- order, so neither can hold a row the other waits for. Locking request by request let one request
-- hold a row that a resolver was about to delete while the next request waited on a row that
-- resolver had already locked. The runtime rows are locked before the task rows, in the order
-- completion and purge lock them. A value that is not a UUID is left to the per-request
-- validation, which raises its usual error. Every new task identity is random, so no request can
-- name a task the batch creates.
CREATE OR REPLACE FUNCTION workhorse.lock_enqueue_prerequisites_internal_v1(p_requests jsonb)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  v_prerequisite_task_ids uuid[];
BEGIN
  v_prerequisite_task_ids := ARRAY(
    SELECT DISTINCT prerequisite.value::uuid
      FROM jsonb_array_elements(p_requests) input(request)
      CROSS JOIN LATERAL (
        SELECT input.request->>'prerequisiteTaskId' AS value
         WHERE jsonb_typeof(input.request->'prerequisiteTaskId') = 'string'
        UNION ALL
        SELECT item.value
          FROM jsonb_array_elements_text(
            CASE WHEN jsonb_typeof(input.request->'dependencies') = 'object'
                  AND jsonb_typeof(input.request->'dependencies'->'prerequisiteTaskIds') = 'array'
              THEN input.request->'dependencies'->'prerequisiteTaskIds' ELSE '[]'::jsonb END
          ) item(value)
      ) prerequisite
     WHERE prerequisite.value ~* '^(\{[0-9a-f]{4}(-?[0-9a-f]{4}){7}\}|[0-9a-f]{4}(-?[0-9a-f]{4}){7})$'
  );
  IF cardinality(v_prerequisite_task_ids) > 0 THEN
    PERFORM 1 FROM workhorse.task_runtime runtime
     WHERE runtime.task_id = ANY(v_prerequisite_task_ids)
     ORDER BY runtime.task_id FOR KEY SHARE;
    PERFORM 1 FROM workhorse.task prerequisite
     WHERE prerequisite.id = ANY(v_prerequisite_task_ids)
     ORDER BY prerequisite.id FOR KEY SHARE;
  END IF;
END;
$$;

-- The core batch insert path. Accept up to 1,000 tasks atomically. Scoped idempotency keys are
-- resolved in ordinal order through their unique index before any durable task side effects. Exact
-- replays return the original identity; material mismatches abort the whole statement with SQLSTATE
-- P1001.
--
-- Clients call workhorse.enqueue_many_v1 instead. This function is the shared implementation
-- underneath it, enqueue_v1, enqueue_debounce_v1, and enqueue_throttle_v1, and it reports plain
-- acceptance rather than the coalescing outcomes those callers map.
CREATE OR REPLACE FUNCTION workhorse.enqueue_batch_v1(p_requests jsonb)
RETURNS TABLE (ordinal integer, task_id uuid, accepted boolean)
LANGUAGE plpgsql
AS $$
DECLARE
  v_count integer;
  v_now timestamptz := clock_timestamp();
  v_request jsonb;
  v_lock record;
  v_ordinal integer;
  v_queue_name text;
  v_task_type text;
  v_concurrency_key text;
  v_budget_name text;
  v_priority numeric;
  v_payload jsonb;
  v_contract_version text;
  v_payload_max_bytes numeric;
  v_result_max_bytes numeric;
  v_payload_redact_keys text[];
  v_result_redact_keys text[];
  v_trace_context jsonb;
  v_tags text[];
  v_run_at timestamptz;
  v_max_attempts integer;
  v_retry_policy jsonb;
  v_deadline_at timestamptz;
  v_execution_timeout_ms numeric;
  v_dependencies jsonb;
  v_prerequisite_task_ids uuid[];
  v_prerequisite_task_id uuid;
  v_on_success text;
  v_on_failure text;
  v_on_cancellation text;
  v_pending_prerequisites integer;
  v_pending_edges integer;
  v_terminal_prerequisite_id uuid;
  v_terminal_prerequisite_state text;
  v_terminal_action text;
  v_state text;
  v_idempotency jsonb;
  v_key text;
  v_scope text;
  v_key_hash bytea;
  v_key_preview text;
  v_key_digest text;
  v_key_length integer;
  v_ttl_ms numeric;
  v_expires_at timestamptz;
  v_fingerprint jsonb;
  v_fingerprint_tags text[];
  v_request_digest text;
  v_conflicting_fields text[];
  v_proposed_task_id uuid;
  v_existing workhorse.enqueue_idempotency%ROWTYPE;
  v_is_new boolean;
  v_is_keyed boolean;
  v_ready_queues text[] := '{}';
  v_notify_queue text;
  v_fast_queues text[];
  v_is_fast boolean;
  v_fast_feature text;
  v_fast_task workhorse.task;
  v_fast_tasks workhorse.task[] := '{}';
  v_fast_runtime workhorse.fast_task_runtime;
  v_fast_runtimes workhorse.fast_task_runtime[] := '{}';
  v_fast_past_deadline uuid[] := '{}';
  v_fast_task_id uuid;
  v_full_task workhorse.task;
  v_full_tasks workhorse.task[] := '{}';
  v_full_runtime workhorse.task_runtime;
  v_full_runtimes workhorse.task_runtime[] := '{}';
  v_full_enqueued_details jsonb[] := '{}';
  v_full_past_deadline uuid[] := '{}';
  v_edge workhorse.task_dependency;
  v_edges workhorse.task_dependency[] := '{}';
  v_full_task_id uuid;
BEGIN
  IF p_requests IS NULL OR jsonb_typeof(p_requests) <> 'array' THEN
    RAISE EXCEPTION 'requests must be a JSON array';
  END IF;
  v_count := jsonb_array_length(p_requests);
  IF v_count > 1000 THEN
    RAISE EXCEPTION 'enqueue batch exceeds maximum size of 1000';
  END IF;

  -- Validate key identities before locking so malformed requests fail predictably, then acquire every
  -- batch key in one deterministic order. This prevents reverse-order overlapping batches from
  -- deadlocking while still serializing new and retained keys through the transaction boundary.
  FOR v_request IN SELECT value FROM jsonb_array_elements(p_requests)
  LOOP
    v_idempotency := v_request->'idempotency';
    IF v_idempotency IS NULL OR v_idempotency = 'null'::jsonb THEN CONTINUE; END IF;
    IF jsonb_typeof(v_idempotency) <> 'object'
       OR v_idempotency - ARRAY['key', 'scope', 'ttlMs'] <> '{}'::jsonb
       OR NOT (v_idempotency ? 'key')
       OR jsonb_typeof(v_idempotency->'key') <> 'string'
       OR (v_idempotency ? 'scope' AND jsonb_typeof(v_idempotency->'scope') <> 'string')
       OR (v_idempotency ? 'ttlMs' AND jsonb_typeof(v_idempotency->'ttlMs') <> 'number') THEN
      RAISE EXCEPTION 'idempotency requires a string key and only optional string scope and numeric ttlMs';
    END IF;
    v_key := v_idempotency->>'key';
    v_scope := COALESCE(v_idempotency->>'scope', 'default');
    v_ttl_ms := COALESCE((v_idempotency->>'ttlMs')::numeric, 86400000);
    IF v_key = '' OR octet_length(v_key) > 512 THEN
      RAISE EXCEPTION 'idempotency key must contain between 1 and 512 UTF-8 bytes';
    END IF;
    IF v_scope = '' OR octet_length(v_scope) > 256 THEN
      RAISE EXCEPTION 'idempotency scope must contain between 1 and 256 UTF-8 bytes';
    END IF;
    IF v_ttl_ms <> trunc(v_ttl_ms) OR v_ttl_ms NOT BETWEEN 1 AND 31536000000 THEN
      RAISE EXCEPTION 'idempotency ttlMs must be an integer between 1 and 31536000000';
    END IF;
  END LOOP;
  FOR v_lock IN
    SELECT locks.scope, locks.key
      FROM (
        SELECT DISTINCT COALESCE(idempotency->>'scope', 'default') AS scope,
               idempotency->>'key' AS key
          FROM jsonb_array_elements(p_requests) AS input(request)
          CROSS JOIN LATERAL (SELECT request->'idempotency' AS idempotency) parsed
         WHERE idempotency IS NOT NULL AND idempotency <> 'null'::jsonb
      ) locks
     ORDER BY locks.scope COLLATE "C", locks.key COLLATE "C"
  LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended(v_lock.scope || chr(31) || v_lock.key, 0));
  END LOOP;

  -- A queue's tier can change only while it holds no live task. The shared tier lock keeps the
  -- tier read here valid until this batch commits, so set_queue_tier_v1 cannot switch a queue
  -- between that read and the insert of its first task.
  v_fast_queues := workhorse.lock_queue_tiers_v1(ARRAY(
    SELECT DISTINCT request->>'queue'
      FROM jsonb_array_elements(p_requests) input(request)
     WHERE COALESCE(request->>'queue', '') <> ''
  ));

  PERFORM workhorse.lock_enqueue_prerequisites_internal_v1(p_requests);

  FOR v_request, v_ordinal IN
    SELECT request, ordinality::integer
      FROM jsonb_array_elements(p_requests) WITH ORDINALITY input(request, ordinality)
     ORDER BY ordinality
  LOOP
    v_queue_name := v_request->>'queue';
    v_task_type := v_request->>'type';
    v_concurrency_key := v_request->>'concurrencyKey';
    v_budget_name := v_request->>'budget';
    v_priority := COALESCE((v_request->>'priority')::numeric, 0);
    v_payload := COALESCE(v_request->'payload', 'null'::jsonb);
    v_contract_version := v_request->>'contractVersion';
    v_payload_max_bytes := COALESCE((v_request->>'payloadMaxBytes')::numeric, 1048576);
    v_result_max_bytes := COALESCE((v_request->>'resultMaxBytes')::numeric, 1048576);
    IF v_contract_version IS NOT NULL
       AND char_length(v_contract_version) NOT BETWEEN 1 AND 100 THEN
      RAISE EXCEPTION 'contractVersion must contain 1 to 100 characters';
    END IF;
    IF v_payload_max_bytes <> trunc(v_payload_max_bytes)
       OR v_payload_max_bytes NOT BETWEEN 1 AND 16777216
       OR v_result_max_bytes <> trunc(v_result_max_bytes)
       OR v_result_max_bytes NOT BETWEEN 1 AND 16777216 THEN
      RAISE EXCEPTION 'payloadMaxBytes and resultMaxBytes must be integers between 1 and 16777216';
    END IF;
    IF octet_length(v_payload::text) > v_payload_max_bytes THEN
      RAISE EXCEPTION 'payload exceeds its configured size limit';
    END IF;
    IF jsonb_typeof(COALESCE(v_request->'sensitivePayloadKeys', '[]'::jsonb)) <> 'array'
       OR jsonb_array_length(COALESCE(v_request->'sensitivePayloadKeys', '[]'::jsonb)) > 50
       OR jsonb_typeof(COALESCE(v_request->'sensitiveResultKeys', '[]'::jsonb)) <> 'array'
       OR jsonb_array_length(COALESCE(v_request->'sensitiveResultKeys', '[]'::jsonb)) > 50
       OR EXISTS (
         SELECT 1
           FROM jsonb_array_elements(
             COALESCE(v_request->'sensitivePayloadKeys', '[]'::jsonb) ||
             COALESCE(v_request->'sensitiveResultKeys', '[]'::jsonb)
           ) key
          WHERE jsonb_typeof(key) <> 'string'
             OR char_length(key #>> '{}') NOT BETWEEN 1 AND 200
       ) THEN
      RAISE EXCEPTION 'sensitive payload and result keys must contain at most 50 strings of 1 to 200 characters';
    END IF;
    v_payload_redact_keys := ARRAY(
      SELECT key
        FROM jsonb_array_elements_text(
          COALESCE(v_request->'sensitivePayloadKeys', '[]'::jsonb)
        ) key
       ORDER BY key COLLATE "C"
    );
    v_result_redact_keys := ARRAY(
      SELECT key
        FROM jsonb_array_elements_text(
          COALESCE(v_request->'sensitiveResultKeys', '[]'::jsonb)
        ) key
       ORDER BY key COLLATE "C"
    );
    IF cardinality(v_payload_redact_keys) <> (
         SELECT count(DISTINCT key) FROM unnest(v_payload_redact_keys) key
       ) OR cardinality(v_result_redact_keys) <> (
         SELECT count(DISTINCT key) FROM unnest(v_result_redact_keys) key
       ) THEN
      RAISE EXCEPTION 'sensitive payload and result keys must contain unique values';
    END IF;
    v_trace_context := v_request->'traceContext';
    IF v_concurrency_key IS NOT NULL AND (
      v_concurrency_key = '' OR octet_length(v_concurrency_key) > 256
    ) THEN
      RAISE EXCEPTION 'concurrencyKey must contain between 1 and 256 UTF-8 bytes';
    END IF;
    IF v_budget_name IS NOT NULL AND (
      v_budget_name = '' OR octet_length(v_budget_name) > 256
    ) THEN
      RAISE EXCEPTION 'budget must contain between 1 and 256 UTF-8 bytes';
    END IF;
    IF v_priority <> trunc(v_priority) OR v_priority NOT BETWEEN 0 AND 100 THEN
      RAISE EXCEPTION 'priority must be an integer between 0 and 100';
    END IF;
    IF COALESCE(v_queue_name, '') = '' OR COALESCE(v_task_type, '') = ''
       OR jsonb_typeof(COALESCE(v_request->'tags', '[]'::jsonb)) <> 'array'
       OR jsonb_array_length(COALESCE(v_request->'tags', '[]'::jsonb)) > 20
       OR EXISTS (
         SELECT 1 FROM jsonb_array_elements(COALESCE(v_request->'tags', '[]'::jsonb)) tag
          WHERE jsonb_typeof(tag) <> 'string' OR tag #>> '{}' = ''
             OR char_length(tag #>> '{}') > 100
       ) THEN
      RAISE EXCEPTION 'each request requires non-empty queue/type, maxAttempts between 1 and 100, and at most 20 non-empty tags of at most 100 characters';
    END IF;
    v_tags := ARRAY(
      SELECT jsonb_array_elements_text(COALESCE(v_request->'tags', '[]'::jsonb))
    );
    IF NOT workhorse.valid_trace_context_v1(v_trace_context) THEN
      RAISE EXCEPTION 'traceContext must contain a string traceparent, optional string tracestate, and at most 1024 UTF-8 bytes';
    END IF;
    v_max_attempts := COALESCE((v_request->>'maxAttempts')::integer, 25);
    IF v_max_attempts NOT BETWEEN 1 AND 100 THEN
      RAISE EXCEPTION 'each request requires non-empty queue/type, maxAttempts between 1 and 100, and at most 20 non-empty tags of at most 100 characters';
    END IF;
    v_retry_policy := workhorse.normalize_retry_policy_v1(v_request->'retryPolicy');
    v_run_at := COALESCE((v_request->>'runAt')::timestamptz, v_now);
    IF NOT isfinite(v_run_at) THEN RAISE EXCEPTION 'runAt must be finite'; END IF;
    v_deadline_at := (v_request->>'deadline')::timestamptz;
    IF v_deadline_at IS NOT NULL AND NOT isfinite(v_deadline_at) THEN
      RAISE EXCEPTION 'deadline must be a finite absolute timestamp';
    END IF;
    v_execution_timeout_ms := (v_request->>'executionTimeoutMs')::numeric;
    IF v_execution_timeout_ms IS NOT NULL AND (
      v_execution_timeout_ms <> trunc(v_execution_timeout_ms)
      OR v_execution_timeout_ms NOT BETWEEN 1 AND 31536000000
    ) THEN
      RAISE EXCEPTION 'executionTimeoutMs must be an integer between 1 and 31536000000';
    END IF;
    IF v_request ? 'prerequisiteTaskId'
       AND v_request->'prerequisiteTaskId' <> 'null'::jsonb
       AND jsonb_typeof(v_request->'prerequisiteTaskId') <> 'string' THEN
      RAISE EXCEPTION 'prerequisiteTaskId must be a UUID string or null';
    END IF;
    v_dependencies := v_request->'dependencies';
    IF v_request->>'prerequisiteTaskId' IS NOT NULL
       AND v_dependencies IS NOT NULL AND v_dependencies <> 'null'::jsonb THEN
      RAISE EXCEPTION 'prerequisiteTaskId and dependencies cannot be combined';
    END IF;
    IF v_dependencies IS NOT NULL AND v_dependencies <> 'null'::jsonb THEN
      IF jsonb_typeof(v_dependencies) <> 'object'
         OR v_dependencies - ARRAY['prerequisiteTaskIds', 'onSuccess', 'onFailure', 'onCancellation'] <> '{}'::jsonb
         OR jsonb_typeof(v_dependencies->'prerequisiteTaskIds') <> 'array'
         OR jsonb_array_length(v_dependencies->'prerequisiteTaskIds') NOT BETWEEN 1 AND 100
         OR v_dependencies->>'onSuccess' NOT IN ('release', 'cancel', 'fail')
         OR v_dependencies->>'onFailure' NOT IN ('release', 'cancel', 'fail')
         OR v_dependencies->>'onCancellation' NOT IN ('release', 'cancel', 'fail')
         OR EXISTS (
           SELECT 1 FROM jsonb_array_elements(v_dependencies->'prerequisiteTaskIds') item
            WHERE jsonb_typeof(item) <> 'string'
         ) THEN
        RAISE EXCEPTION 'dependencies requires 1 to 100 UUID strings and release, cancel, or fail outcome policies';
      END IF;
      v_prerequisite_task_ids := ARRAY(
        SELECT value::uuid
          FROM jsonb_array_elements_text(v_dependencies->'prerequisiteTaskIds') value
         ORDER BY value::uuid
      );
      v_on_success := v_dependencies->>'onSuccess';
      v_on_failure := v_dependencies->>'onFailure';
      v_on_cancellation := v_dependencies->>'onCancellation';
    ELSIF v_request->>'prerequisiteTaskId' IS NOT NULL THEN
      v_prerequisite_task_ids := ARRAY[(v_request->>'prerequisiteTaskId')::uuid];
      v_on_success := 'release';
      v_on_failure := 'fail';
      v_on_cancellation := 'cancel';
    ELSE
      v_prerequisite_task_ids := '{}';
      v_on_success := 'release';
      v_on_failure := 'fail';
      v_on_cancellation := 'cancel';
    END IF;
    v_is_fast := v_queue_name = ANY(v_fast_queues);
    IF v_is_fast THEN
      v_fast_feature := CASE
        WHEN v_concurrency_key IS NOT NULL THEN 'concurrency keys'
        WHEN v_budget_name IS NOT NULL THEN 'budgets'
        WHEN v_dependencies IS NOT NULL AND v_dependencies <> 'null'::jsonb THEN 'dependencies'
        WHEN cardinality(v_prerequisite_task_ids) > 0 THEN 'prerequisite tasks'
      END;
      IF v_fast_feature IS NOT NULL THEN
        PERFORM workhorse.reject_fast_feature_v1(v_queue_name, v_fast_feature, v_ordinal);
      END IF;
    END IF;
    v_prerequisite_task_id := CASE
      WHEN v_dependencies IS NULL OR v_dependencies = 'null'::jsonb
        THEN NULLIF(v_request->>'prerequisiteTaskId', '')::uuid
      ELSE NULL
    END;
    -- Most requests carry no prerequisite. The prerequisite lock, the existence check and both
    -- outcome scans answer nothing for an empty set, so a request without prerequisites states
    -- their answers directly and reaches the buffer without touching dependency relations.
    IF cardinality(v_prerequisite_task_ids) > 0 THEN
      IF cardinality(v_prerequisite_task_ids) <> (
        SELECT count(DISTINCT prerequisite_id) FROM unnest(v_prerequisite_task_ids) prerequisite_id
      ) THEN
        RAISE EXCEPTION 'dependency prerequisiteTaskIds must be unique';
      END IF;
      -- The batch already holds these rows, so locking them again waits for nothing. The lock
      -- still counts the prerequisites that exist, and it covers a spelling of a UUID that the
      -- batch pattern missed.
      PERFORM 1 FROM workhorse.task_runtime runtime
       WHERE runtime.task_id = ANY(v_prerequisite_task_ids)
       ORDER BY runtime.task_id FOR KEY SHARE;
      PERFORM 1 FROM workhorse.task prerequisite
       WHERE prerequisite.id = ANY(v_prerequisite_task_ids)
       ORDER BY prerequisite.id FOR KEY SHARE;
      GET DIAGNOSTICS v_pending_prerequisites = ROW_COUNT;
      IF v_pending_prerequisites <> cardinality(v_prerequisite_task_ids) THEN
        RAISE EXCEPTION 'prerequisite task does not exist';
      END IF;
      -- A fast-tier task never resolves dependents when it finishes, so a dependent on it would
      -- stay blocked forever.
      SELECT prerequisite_id INTO v_fast_task_id
        FROM unnest(v_prerequisite_task_ids) prerequisite_id
       WHERE EXISTS (
               SELECT 1 FROM workhorse.fast_task_runtime runtime
                WHERE runtime.task_id = prerequisite_id
             ) OR EXISTS (
               SELECT 1 FROM workhorse.fast_task_outcome outcome
                WHERE outcome.task_id = prerequisite_id
             )
       LIMIT 1;
      IF FOUND THEN
        RAISE EXCEPTION USING
          ERRCODE = 'P1007',
          MESSAGE = format('fast-tier task %s cannot be a prerequisite', v_fast_task_id),
          DETAIL = jsonb_build_object(
            'feature', 'dependencies', 'taskId', v_fast_task_id, 'ordinal', v_ordinal
          )::text;
      END IF;
      -- An edge starts pending unless its prerequisite is terminal and its policy releases. The
      -- dependent's counter starts at that count and falls as the pending edges resolve.
      SELECT count(*) FILTER (WHERE outcome.task_id IS NULL)::integer,
             count(*) FILTER (
               WHERE outcome.task_id IS NULL OR CASE outcome.state
                 WHEN 'succeeded' THEN v_on_success
                 WHEN 'failed' THEN v_on_failure
                 WHEN 'canceled' THEN v_on_cancellation
               END <> 'release'
             )::integer
        INTO v_pending_prerequisites, v_pending_edges
        FROM unnest(v_prerequisite_task_ids) prerequisite_id
        LEFT JOIN workhorse.task_outcome outcome ON outcome.task_id = prerequisite_id;
      SELECT outcome.task_id, outcome.state, action.policy_action
        INTO v_terminal_prerequisite_id, v_terminal_prerequisite_state, v_terminal_action
        FROM workhorse.task_outcome outcome
        CROSS JOIN LATERAL (
          SELECT CASE outcome.state
            WHEN 'succeeded' THEN v_on_success
            WHEN 'failed' THEN v_on_failure
            WHEN 'canceled' THEN v_on_cancellation
            ELSE 'release'
          END AS policy_action
        ) action
       WHERE outcome.task_id = ANY(v_prerequisite_task_ids)
         AND action.policy_action IN ('fail', 'cancel')
       ORDER BY CASE action.policy_action WHEN 'fail' THEN 0 ELSE 1 END, outcome.task_id
       LIMIT 1;
    ELSE
      v_pending_prerequisites := 0;
      v_pending_edges := 0;
      v_terminal_prerequisite_id := NULL;
      v_terminal_prerequisite_state := NULL;
      v_terminal_action := NULL;
    END IF;
    v_state := CASE
      WHEN v_terminal_action IS NOT NULL THEN 'blocked'
      WHEN v_pending_prerequisites > 0 THEN 'blocked'
      WHEN v_run_at <= v_now THEN 'ready'
      ELSE 'scheduled'
    END;
    v_idempotency := v_request->'idempotency';
    v_is_new := true;
    v_is_keyed := false;
    v_key_hash := NULL;
    v_key_preview := NULL;
    v_key_digest := NULL;
    v_key_length := NULL;
    v_expires_at := NULL;
    v_request_digest := NULL;

    IF v_idempotency IS NOT NULL AND v_idempotency <> 'null'::jsonb THEN
      IF jsonb_typeof(v_idempotency) <> 'object'
         OR v_idempotency - ARRAY['key', 'scope', 'ttlMs'] <> '{}'::jsonb
         OR NOT (v_idempotency ? 'key')
         OR jsonb_typeof(v_idempotency->'key') <> 'string'
         OR (v_idempotency ? 'scope' AND jsonb_typeof(v_idempotency->'scope') <> 'string')
         OR (v_idempotency ? 'ttlMs' AND jsonb_typeof(v_idempotency->'ttlMs') <> 'number') THEN
        RAISE EXCEPTION 'idempotency requires a string key and only optional string scope and numeric ttlMs';
      END IF;
      v_is_keyed := true;
      v_key := v_idempotency->>'key';
      v_scope := COALESCE(v_idempotency->>'scope', 'default');
      v_ttl_ms := COALESCE((v_idempotency->>'ttlMs')::numeric, 86400000);
      IF v_key = '' OR octet_length(v_key) > 512 THEN
        RAISE EXCEPTION 'idempotency key must contain between 1 and 512 UTF-8 bytes';
      END IF;
      IF v_scope = '' OR octet_length(v_scope) > 256 THEN
        RAISE EXCEPTION 'idempotency scope must contain between 1 and 256 UTF-8 bytes';
      END IF;
      IF v_ttl_ms <> trunc(v_ttl_ms) OR v_ttl_ms NOT BETWEEN 1 AND 31536000000 THEN
        RAISE EXCEPTION 'idempotency ttlMs must be an integer between 1 and 31536000000';
      END IF;
      v_key_hash := workhorse.idempotency_key_hash_v1(v_scope, v_key);
      v_key_digest := left(encode(v_key_hash, 'hex'), 12);
      v_key_length := char_length(v_key);
      v_key_preview := CASE
        WHEN v_key_length <= 4 THEN repeat('•', v_key_length)
        WHEN v_key_length <= 8 THEN left(v_key, 2) || '…' || right(v_key, 2)
        ELSE left(v_key, 8) || '…' || right(v_key, 4)
      END;
      v_expires_at := v_now + v_ttl_ms * interval '1 millisecond';
      v_fingerprint_tags := ARRAY(
        SELECT unique_tags.tag
          FROM (SELECT DISTINCT tag FROM unnest(v_tags) tag) unique_tags
         ORDER BY unique_tags.tag COLLATE "C"
      );
      v_fingerprint := jsonb_build_object(
        'queue', v_queue_name,
        'type', v_task_type,
        'payload', v_payload,
        'priority', v_priority,
        'concurrencyKey', to_jsonb(v_concurrency_key),
        'contractVersion', to_jsonb(v_contract_version),
        'payloadMaxBytes', v_payload_max_bytes,
        'resultMaxBytes', v_result_max_bytes,
        'sensitivePayloadKeys', to_jsonb(v_payload_redact_keys),
        'sensitiveResultKeys', to_jsonb(v_result_redact_keys),
        'tags', to_jsonb(v_fingerprint_tags),
        'runAt', CASE
          WHEN v_request->>'runAt' IS NULL THEN 'null'::jsonb ELSE to_jsonb(v_run_at)
        END,
        'deadline', to_jsonb(v_deadline_at),
        'executionTimeoutMs', to_jsonb(v_execution_timeout_ms),
        'maxAttempts', v_max_attempts,
        'retryPolicy', v_retry_policy,
        'prerequisiteTaskId', to_jsonb(v_prerequisite_task_id),
        'dependencies', CASE WHEN v_dependencies IS NULL OR v_dependencies = 'null'::jsonb
          THEN 'null'::jsonb ELSE
          jsonb_build_object(
            'prerequisiteTaskIds', to_jsonb(v_prerequisite_task_ids),
            'onSuccess', v_on_success,
            'onFailure', v_on_failure,
            'onCancellation', v_on_cancellation
          ) END,
        'ttlMs', v_ttl_ms
      ) || CASE WHEN v_budget_name IS NULL THEN '{}'::jsonb
           ELSE jsonb_build_object('budget', v_budget_name) END;
      v_request_digest := workhorse.sha256_hex_v1(v_fingerprint::text);

      LOOP
        v_proposed_task_id := gen_random_uuid();
        INSERT INTO workhorse.enqueue_idempotency AS existing(
          idempotency_scope, idempotency_key_hash, request_fingerprint, task_id, expires_at
        ) VALUES (
          v_scope, v_key_hash, v_fingerprint, v_proposed_task_id, v_expires_at
        )
        ON CONFLICT (idempotency_scope, idempotency_key_hash) DO UPDATE
          SET idempotency_key_hash = existing.idempotency_key_hash
        RETURNING existing.* INTO v_existing;

        IF v_existing.task_id = v_proposed_task_id THEN
          task_id := v_proposed_task_id;
          EXIT;
        END IF;
        IF v_existing.expires_at <= v_now THEN
          DELETE FROM workhorse.enqueue_idempotency AS expired
           WHERE expired.idempotency_scope = v_scope
             AND expired.idempotency_key_hash = v_key_hash
             AND expired.task_id = v_existing.task_id AND expired.expires_at <= v_now;
          CONTINUE;
        END IF;
        IF v_existing.request_fingerprint <> v_fingerprint THEN
          SELECT COALESCE(array_agg(field ORDER BY field COLLATE "C"), '{}')
            INTO v_conflicting_fields
            FROM jsonb_object_keys(v_fingerprint) field
           WHERE v_existing.request_fingerprint->field IS DISTINCT FROM v_fingerprint->field;
          RAISE EXCEPTION USING
            ERRCODE = 'P1001',
            MESSAGE = 'enqueue idempotency conflict with a retained request',
            DETAIL = jsonb_build_object(
              'scope', v_scope,
              'keyPreview', v_key_preview,
              'keyDigest', v_key_digest,
              'keyLength', v_key_length,
              'existingTaskId', v_existing.task_id,
              'ordinal', v_ordinal,
              'conflictingFields', to_jsonb(v_conflicting_fields),
              'storedRequestDigest', workhorse.sha256_hex_v1(v_existing.request_fingerprint::text),
              'rejectedRequestDigest', v_request_digest
            )::text;
        END IF;
        task_id := v_existing.task_id;
        v_is_new := false;
        EXIT;
      END LOOP;
    ELSE
      task_id := gen_random_uuid();
    END IF;

    IF v_is_new AND v_is_fast THEN
      -- Fast-tier rows are collected here and written after the loop, one statement per table.
      v_fast_task.id := task_id;
      v_fast_task.queue_name := v_queue_name;
      v_fast_task.task_type := v_task_type;
      v_fast_task.concurrency_key := NULL;
      v_fast_task.payload := v_payload;
      v_fast_task.contract_version := v_contract_version;
      v_fast_task.payload_max_bytes := v_payload_max_bytes::integer;
      v_fast_task.result_max_bytes := v_result_max_bytes::integer;
      v_fast_task.payload_redact_keys := v_payload_redact_keys;
      v_fast_task.result_redact_keys := v_result_redact_keys;
      v_fast_task.trace_context := v_trace_context;
      v_fast_task.tags := v_tags;
      v_fast_task.max_attempts := v_max_attempts;
      v_fast_task.retry_policy := v_retry_policy;
      v_fast_task.deadline_at := v_deadline_at;
      v_fast_task.execution_timeout_ms := v_execution_timeout_ms::bigint;
      v_fast_task.created_at := v_now;
      v_fast_task.priority := v_priority::integer;
      v_fast_task.budget_name := NULL;
      v_fast_tasks := array_append(v_fast_tasks, v_fast_task);

      v_fast_runtime := NULL;
      v_fast_runtime.task_id := task_id;
      v_fast_runtime.queue_name := v_queue_name;
      v_fast_runtime.task_type := v_task_type;
      v_fast_runtime.state := 'ready';
      v_fast_runtime.priority := v_priority::integer;
      v_fast_runtime.run_at := v_run_at;
      v_fast_runtime.sequence := nextval('workhorse.ready_sequence_seq');
      v_fast_runtime.payload := v_payload;
      v_fast_runtime.contract_version := v_contract_version;
      v_fast_runtime.result_max_bytes := v_result_max_bytes::integer;
      v_fast_runtime.redact := cardinality(v_payload_redact_keys) > 0
        OR cardinality(v_result_redact_keys) > 0;
      v_fast_runtime.trace_context := v_trace_context;
      v_fast_runtime.retry_policy := v_retry_policy;
      v_fast_runtime.max_attempts := v_max_attempts;
      v_fast_runtime.attempt := 1;
      v_fast_runtime.fence_token := 0;
      v_fast_runtime.deadline_at := v_deadline_at;
      v_fast_runtime.execution_timeout_ms := v_execution_timeout_ms::bigint;
      v_fast_runtime.errors := '[]'::jsonb;
      v_fast_runtime.errors_dropped := 0;
      v_fast_runtime.enqueued_at := v_now;
      v_fast_runtimes := array_append(v_fast_runtimes, v_fast_runtime);

      IF v_deadline_at IS NOT NULL AND v_deadline_at <= v_now THEN
        v_fast_past_deadline := array_append(v_fast_past_deadline, task_id);
      ELSIF v_run_at <= v_now AND NOT v_queue_name = ANY(v_ready_queues) THEN
        v_ready_queues := array_append(v_ready_queues, v_queue_name);
      END IF;
    ELSIF v_is_new THEN
      -- Full-tier rows are collected here and written after the loop, one statement per table.
      -- A prerequisite exists before this batch starts, because the batch generates every new task
      -- identity, so no check or lock above needs a buffered row.
      v_full_task := NULL;
      v_full_task.id := task_id;
      v_full_task.queue_name := v_queue_name;
      v_full_task.task_type := v_task_type;
      v_full_task.concurrency_key := v_concurrency_key;
      v_full_task.priority := v_priority::integer;
      v_full_task.payload := v_payload;
      v_full_task.contract_version := v_contract_version;
      v_full_task.payload_max_bytes := v_payload_max_bytes::integer;
      v_full_task.result_max_bytes := v_result_max_bytes::integer;
      v_full_task.payload_redact_keys := v_payload_redact_keys;
      v_full_task.result_redact_keys := v_result_redact_keys;
      v_full_task.trace_context := v_trace_context;
      v_full_task.tags := v_tags;
      v_full_task.max_attempts := v_max_attempts;
      v_full_task.retry_policy := v_retry_policy;
      v_full_task.deadline_at := v_deadline_at;
      v_full_task.execution_timeout_ms := v_execution_timeout_ms::bigint;
      v_full_task.budget_name := v_budget_name;
      v_full_tasks := array_append(v_full_tasks, v_full_task);

      v_full_runtime := NULL;
      v_full_runtime.task_id := task_id;
      v_full_runtime.queue_name := v_queue_name;
      v_full_runtime.concurrency_key := v_concurrency_key;
      v_full_runtime.priority := v_priority::integer;
      v_full_runtime.state := v_state;
      v_full_runtime.current_attempt := 1;
      v_full_runtime.run_at := v_run_at;
      v_full_runtime.ready_at := CASE WHEN v_state = 'ready' THEN v_now END;
      v_full_runtime.sequence := CASE WHEN v_state = 'ready'
        THEN nextval('workhorse.ready_sequence_seq') END;
      v_full_runtime.deadline_at := v_deadline_at;
      v_full_runtime.budget_name := v_budget_name;
      v_full_runtime.pending_prerequisites := v_pending_edges;
      v_full_runtime.dependency_rejected := false;
      v_full_runtimes := array_append(v_full_runtimes, v_full_runtime);

      FOREACH v_prerequisite_task_id IN ARRAY v_prerequisite_task_ids LOOP
        v_edge := NULL;
        v_edge.dependent_task_id := task_id;
        v_edge.prerequisite_task_id := v_prerequisite_task_id;
        v_edge.on_success := v_on_success;
        v_edge.on_failure := v_on_failure;
        v_edge.on_cancellation := v_on_cancellation;
        v_edges := array_append(v_edges, v_edge);
      END LOOP;

      v_full_enqueued_details := array_append(v_full_enqueued_details,
        jsonb_build_object(
          'state', v_state,
          'priority', v_priority,
          'run_at', v_run_at,
          'deadline_at', v_deadline_at,
          'execution_timeout_ms', v_execution_timeout_ms
        ) ||
        CASE WHEN v_is_keyed THEN jsonb_build_object(
          'idempotency', jsonb_build_object(
            'scope', v_scope,
            'key_preview', v_key_preview,
            'key_digest', v_key_digest,
            'key_length', v_key_length,
            'ttl_ms', v_ttl_ms,
            'expires_at', v_expires_at,
            'request_digest', v_request_digest
          )
        ) ELSE '{}'::jsonb END
      );
      IF v_deadline_at IS NOT NULL AND v_deadline_at <= v_now THEN
        v_full_past_deadline := array_append(v_full_past_deadline, task_id);
      ELSIF v_state = 'ready' AND NOT v_queue_name = ANY(v_ready_queues) THEN
        v_ready_queues := array_append(v_ready_queues, v_queue_name);
      END IF;
    END IF;
    ordinal := v_ordinal;
    accepted := v_is_new;
    RETURN NEXT;
  END LOOP;

  -- The buffered writes keep each task's evidence in the order the one-row writes produced: its
  -- dependency events, the resolution of any terminal prerequisite, `enqueued`, then an expired
  -- deadline. Omitted columns keep their per-row defaults, so created_at, updated_at and the event
  -- identity advance with each row.
  IF cardinality(v_full_tasks) > 0 THEN
    INSERT INTO workhorse.task(
      id, queue_name, task_type, concurrency_key, priority, payload, contract_version,
      payload_max_bytes, result_max_bytes,
      payload_redact_keys, result_redact_keys, trace_context, tags, max_attempts, retry_policy,
      deadline_at, execution_timeout_ms, budget_name
    )
    SELECT buffered.id, buffered.queue_name, buffered.task_type, buffered.concurrency_key,
           buffered.priority, buffered.payload, buffered.contract_version,
           buffered.payload_max_bytes, buffered.result_max_bytes,
           buffered.payload_redact_keys, buffered.result_redact_keys, buffered.trace_context,
           buffered.tags, buffered.max_attempts, buffered.retry_policy,
           buffered.deadline_at, buffered.execution_timeout_ms, buffered.budget_name
      FROM unnest(v_full_tasks) WITH ORDINALITY buffered
     ORDER BY buffered.ordinality;
    INSERT INTO workhorse.task_runtime(
      task_id, queue_name, concurrency_key, priority, state, current_attempt, run_at, ready_at,
      sequence, deadline_at, budget_name, pending_prerequisites, dependency_rejected
    )
    SELECT buffered.task_id, buffered.queue_name, buffered.concurrency_key, buffered.priority,
           buffered.state, buffered.current_attempt, buffered.run_at, buffered.ready_at,
           buffered.sequence, buffered.deadline_at, buffered.budget_name,
           buffered.pending_prerequisites, buffered.dependency_rejected
      FROM unnest(v_full_runtimes) WITH ORDINALITY buffered
     ORDER BY buffered.ordinality;
    -- A batch without prerequisites has no edge to write and no dependent to resolve. Running the
    -- insert anyway would fire the statement trigger on `task_dependency`, and that trigger walks
    -- the dependency graph recursively for a transition that cannot have occurred.
    IF cardinality(v_edges) > 0 THEN
      WITH edges AS MATERIALIZED (
        SELECT edge.dependent_task_id, edge.prerequisite_task_id, edge.on_success,
               edge.on_failure, edge.on_cancellation, edge.ordinality, outcome.state,
               outcome.state IS NOT NULL AND (
                 (outcome.state = 'succeeded' AND edge.on_success = 'release')
                 OR (outcome.state = 'failed' AND edge.on_failure = 'release')
                 OR (outcome.state = 'canceled' AND edge.on_cancellation = 'release')
               ) AS releases_immediately
          FROM unnest(v_edges) WITH ORDINALITY edge
          LEFT JOIN workhorse.task_outcome outcome
            ON outcome.task_id = edge.prerequisite_task_id
      ), inserted_edges AS (
        INSERT INTO workhorse.task_dependency(
          dependent_task_id, prerequisite_task_id, on_success, on_failure, on_cancellation,
          created_at, released_at, resolution
        )
        SELECT edges.dependent_task_id, edges.prerequisite_task_id,
               edges.on_success, edges.on_failure, edges.on_cancellation, v_now,
               CASE WHEN edges.releases_immediately THEN v_now END,
               CASE WHEN edges.releases_immediately THEN 'release' END
          FROM edges
         ORDER BY edges.ordinality
        RETURNING dependent_task_id, prerequisite_task_id
      )
      INSERT INTO workhorse.task_event(task_id, event_type, details)
      SELECT edges.dependent_task_id,
             CASE WHEN edges.releases_immediately
               THEN 'dependency_released' ELSE 'dependency_blocked' END,
             jsonb_build_object(
               'prerequisite_task_id', edges.prerequisite_task_id,
               'state', runtime.state,
               'reason', CASE
                 WHEN NOT edges.releases_immediately THEN 'prerequisite_pending'
                 WHEN edges.state = 'succeeded' THEN 'prerequisite_already_succeeded'
                 ELSE 'prerequisite_terminal_policy'
               END
             )
        FROM edges
        JOIN inserted_edges USING (dependent_task_id, prerequisite_task_id)
        JOIN unnest(v_full_runtimes) runtime ON runtime.task_id = edges.dependent_task_id
       ORDER BY edges.ordinality;
      -- One resolver call resolves the pending edges to every terminal prerequisite in the batch. A
      -- dependent's fate depends only on the resolutions of its edges, so it matches the fate that
      -- one call per dependent produced.
      PERFORM workhorse.resolve_dependents_many_v1(terminal.task_ids, terminal.states)
         FROM (
           SELECT array_agg(outcome.task_id ORDER BY outcome.task_id) AS task_ids,
                  array_agg(outcome.state ORDER BY outcome.task_id) AS states
             FROM workhorse.task_outcome outcome
            WHERE outcome.task_id IN (
              SELECT edge.prerequisite_task_id FROM unnest(v_edges) edge
            )
         ) terminal
        WHERE terminal.task_ids IS NOT NULL;
    END IF;
    INSERT INTO workhorse.task_event(task_id, event_type, details)
    SELECT buffered.id, 'enqueued', event.details
      FROM unnest(v_full_tasks) WITH ORDINALITY buffered
      JOIN unnest(v_full_enqueued_details) WITH ORDINALITY event(details, ordinality)
        ON event.ordinality = buffered.ordinality
     ORDER BY buffered.ordinality;
    FOREACH v_full_task_id IN ARRAY v_full_past_deadline LOOP
      PERFORM workhorse.terminalize_deadline_v1(v_full_task_id);
    END LOOP;
  END IF;

  IF cardinality(v_fast_tasks) > 0 THEN
    INSERT INTO workhorse.task SELECT * FROM unnest(v_fast_tasks);
    INSERT INTO workhorse.fast_task_runtime SELECT * FROM unnest(v_fast_runtimes);
    FOREACH v_fast_task_id IN ARRAY v_fast_past_deadline LOOP
      PERFORM workhorse.fast_terminalize_deadline_v1(v_fast_task_id);
    END LOOP;
  END IF;

  FOREACH v_notify_queue IN ARRAY v_ready_queues LOOP
    PERFORM pg_notify('workhorse_tasks', v_notify_queue);
  END LOOP;
END;
$$;

-- The client batch entry point. Adds keyed debounce and throttle handling over
-- workhorse.enqueue_batch_v1 and reports one coalescing outcome per member.
CREATE OR REPLACE FUNCTION workhorse.enqueue_many_v1(p_requests jsonb)
RETURNS TABLE (ordinal integer, task_id uuid, outcome text, reason text)
LANGUAGE plpgsql
AS $$
DECLARE
  v_request jsonb;
  v_ordinal integer;
  v_row record;
  v_lock record;
  v_error_message text;
  v_error_detail text;
  v_contract_mismatch jsonb;
  v_fast_queue text;
  v_fast_feature text;
BEGIN
  IF p_requests IS NULL OR jsonb_typeof(p_requests) <> 'array' THEN
    RAISE EXCEPTION 'requests must be a JSON array';
  END IF;
  IF jsonb_array_length(p_requests) > 1000 THEN
    RAISE EXCEPTION 'enqueue batch exceeds maximum size of 1000';
  END IF;

  SELECT jsonb_build_object(
           'taskTypes', jsonb_agg(mismatch.task_type ORDER BY mismatch.task_type COLLATE "C")
         )
    INTO v_contract_mismatch
    FROM (
      SELECT DISTINCT request->>'type' AS task_type
        FROM jsonb_array_elements(p_requests) input(request)
        JOIN workhorse.contract_policy policy ON policy.task_type = request->>'type'
       WHERE request ? 'contractVersion'
         AND request->>'contractVersion' IS DISTINCT FROM policy.current_version
  ) mismatch;
  IF jsonb_typeof(v_contract_mismatch->'taskTypes') = 'array' THEN
    ordinal := 0;
    task_id := NULL;
    outcome := 'contract_mismatch';
    reason := v_contract_mismatch::text;
    RETURN NEXT;
    RETURN;
  END IF;

  IF EXISTS (
    SELECT 1
      FROM jsonb_array_elements(p_requests) input(request)
     WHERE (request ? 'idempotency')::integer
         + (request ? 'debounce')::integer
         + (request ? 'throttle')::integer > 1
  ) THEN
    RAISE EXCEPTION 'enqueue requests cannot combine idempotency, debounce, or throttle';
  END IF;

  IF EXISTS (
    SELECT keyed.scope, keyed.key
      FROM (
        SELECT COALESCE(request->'idempotency'->>'scope', 'default') AS scope,
               request->'idempotency'->>'key' AS key, 'idempotency' AS mode
          FROM jsonb_array_elements(p_requests) input(request) WHERE request ? 'idempotency'
        UNION ALL
        SELECT COALESCE(request->'debounce'->>'scope', 'default') AS scope,
               request->'debounce'->>'key' AS key, 'debounce' AS mode
          FROM jsonb_array_elements(p_requests) input(request) WHERE request ? 'debounce'
        UNION ALL
        SELECT COALESCE(request->'throttle'->>'scope', 'default') AS scope,
               request->'throttle'->>'key' AS key, 'throttle' AS mode
          FROM jsonb_array_elements(p_requests) input(request) WHERE request ? 'throttle'
      ) keyed
     WHERE keyed.key IS NOT NULL
     GROUP BY keyed.scope, keyed.key
    HAVING count(DISTINCT keyed.mode) > 1
  ) THEN
    RAISE EXCEPTION 'one enqueue batch cannot reuse a scoped key across incompatible coalescing modes';
  END IF;

  FOR v_lock IN
    SELECT ordered.scope, ordered.key
      FROM (
        SELECT DISTINCT keyed.scope COLLATE "C" AS scope, keyed.key COLLATE "C" AS key
          FROM (
        SELECT COALESCE(request->'debounce'->>'scope', 'default') AS scope,
               request->'debounce'->>'key' AS key
          FROM jsonb_array_elements(p_requests) input(request) WHERE request ? 'debounce'
        UNION ALL
        SELECT COALESCE(request->'throttle'->>'scope', 'default') AS scope,
               request->'throttle'->>'key' AS key
          FROM jsonb_array_elements(p_requests) input(request) WHERE request ? 'throttle'
        UNION ALL
        SELECT COALESCE(request->'idempotency'->>'scope', 'default') AS scope,
               request->'idempotency'->>'key' AS key
          FROM jsonb_array_elements(p_requests) input(request) WHERE request ? 'idempotency'
          ) keyed
         WHERE keyed.key IS NOT NULL
      ) ordered
     ORDER BY ordered.scope, ordered.key
  LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended(v_lock.scope || chr(31) || v_lock.key, 0));
  END LOOP;

  IF EXISTS (
    SELECT 1
      FROM jsonb_array_elements(p_requests) input(request)
      JOIN workhorse.enqueue_idempotency identity
        ON identity.idempotency_scope = COALESCE(request->'idempotency'->>'scope', 'default')
       AND identity.idempotency_key_hash = workhorse.idempotency_key_hash_v1(
             COALESCE(request->'idempotency'->>'scope', 'default'),
             request->'idempotency'->>'key'
           )
     WHERE request ? 'idempotency'
       AND jsonb_typeof(request->'idempotency') = 'object'
       AND jsonb_typeof(request->'idempotency'->'key') = 'string'
       AND identity.expires_at > clock_timestamp()
       AND identity.coalescing_mode <> 'idempotency'
  ) THEN
    RAISE EXCEPTION 'idempotency key is retained for incompatible coalescing mode';
  END IF;

  -- Report a coalescing request on a fast-tier queue with its ordinal before any request runs.
  SELECT input.request->>'queue',
         CASE WHEN input.request ? 'debounce' THEN 'debounce' ELSE 'throttle' END,
         input.ordinality::integer
    INTO v_fast_queue, v_fast_feature, v_ordinal
    FROM jsonb_array_elements(p_requests) WITH ORDINALITY input(request, ordinality)
   WHERE (input.request ? 'debounce' OR input.request ? 'throttle')
     AND input.request->>'queue' = ANY(workhorse.lock_queue_tiers_v1(ARRAY(
       SELECT DISTINCT candidate->>'queue'
         FROM jsonb_array_elements(p_requests) candidate
        WHERE candidate ? 'debounce' OR candidate ? 'throttle'
     )))
   ORDER BY input.ordinality
   LIMIT 1;
  IF FOUND THEN
    PERFORM workhorse.reject_fast_feature_v1(v_fast_queue, v_fast_feature, v_ordinal);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_requests) input(request)
     WHERE request ? 'debounce' OR request ? 'throttle'
  ) THEN
    RETURN QUERY
      SELECT result.ordinal, result.task_id,
             CASE WHEN result.accepted THEN 'accepted' ELSE 'replayed' END,
             NULL::text
        FROM workhorse.enqueue_batch_v1(p_requests) result ORDER BY result.ordinal;
    RETURN;
  END IF;

  -- A debounce or throttle member makes the batch enqueue member by member. Each plain member
  -- would then lock only its own prerequisites, so lock every member's prerequisites first.
  PERFORM workhorse.lock_enqueue_prerequisites_internal_v1(p_requests);

  FOR v_request, v_ordinal IN
    SELECT request, ordinality::integer
      FROM jsonb_array_elements(p_requests) WITH ORDINALITY input(request, ordinality)
     ORDER BY ordinality
  LOOP
    IF v_request ? 'debounce' THEN
      SELECT * INTO v_row FROM workhorse.enqueue_debounce_v1(v_request);
      ordinal := v_ordinal;
      task_id := v_row.task_id;
      outcome := v_row.outcome;
      reason := CASE WHEN outcome = 'non_replaceable' THEN (
        SELECT event.details->>'reason'
          FROM workhorse.task_event event
         WHERE event.task_id = v_row.task_id
           AND event.event_type = 'debounce_rejected'
         ORDER BY event.occurred_at DESC, event.event_id DESC
         LIMIT 1
      ) ELSE NULL END;
    ELSIF v_request ? 'throttle' THEN
      BEGIN
        SELECT * INTO v_row FROM workhorse.enqueue_throttle_v1(v_request);
      EXCEPTION WHEN SQLSTATE 'P1001' THEN
        GET STACKED DIAGNOSTICS
          v_error_message = MESSAGE_TEXT,
          v_error_detail = PG_EXCEPTION_DETAIL;
        RAISE EXCEPTION USING
          ERRCODE = 'P1001',
          MESSAGE = v_error_message,
          DETAIL = (v_error_detail::jsonb || jsonb_build_object('ordinal', v_ordinal))::text;
      END;
      ordinal := v_ordinal;
      task_id := v_row.task_id;
      outcome := v_row.outcome;
      reason := NULL;
    ELSE
      BEGIN
        SELECT * INTO v_row FROM workhorse.enqueue_batch_v1(jsonb_build_array(v_request));
      EXCEPTION WHEN SQLSTATE 'P1001' THEN
        GET STACKED DIAGNOSTICS
          v_error_message = MESSAGE_TEXT,
          v_error_detail = PG_EXCEPTION_DETAIL;
        RAISE EXCEPTION USING
          ERRCODE = 'P1001',
          MESSAGE = v_error_message,
          DETAIL = (v_error_detail::jsonb || jsonb_build_object('ordinal', v_ordinal))::text;
      END;
      ordinal := v_ordinal;
      task_id := v_row.task_id;
      outcome := CASE WHEN v_row.accepted THEN 'accepted' ELSE 'replayed' END;
      reason := NULL;
    END IF;
    RETURN NEXT;
  END LOOP;
END;
$$;

-- Audited operator release. The request identity is recorded only when the call
-- changes the task, and the raw request id never enters retained history. A release also ends a
-- live debounce window: the released definition runs now, and the next same-key request starts a
-- new task.
CREATE OR REPLACE FUNCTION workhorse.run_task_now_v1(
  p_task_id uuid,
  p_requested_by text,
  p_reason text,
  p_request_id text
)
RETURNS TABLE(status text, state text, run_at timestamptz)
LANGUAGE plpgsql
AS $$
DECLARE
  v_runtime workhorse.task_runtime%ROWTYPE;
  v_outcome workhorse.task_outcome%ROWTYPE;
  v_fast_runtime workhorse.fast_task_runtime%ROWTYPE;
  v_now timestamptz := clock_timestamp();
  v_request_id_hash bytea;
  v_request_id_length integer;
  v_request_id_preview text;
BEGIN
  IF p_requested_by IS NULL OR p_requested_by = '' OR char_length(p_requested_by) > 200 THEN
    RAISE EXCEPTION 'requested_by must contain between 1 and 200 characters';
  END IF;
  IF p_reason IS NULL OR p_reason = '' OR char_length(p_reason) > 2000 THEN
    RAISE EXCEPTION 'reason must contain between 1 and 2000 characters';
  END IF;
  IF p_request_id IS NULL OR p_request_id = '' OR octet_length(p_request_id) > 512 THEN
    RAISE EXCEPTION 'request_id must contain between 1 and 512 UTF-8 bytes';
  END IF;
  v_request_id_hash := sha256(convert_to(p_request_id, 'UTF8'));
  v_request_id_length := char_length(p_request_id);
  v_request_id_preview := CASE
    WHEN v_request_id_length <= 4 THEN repeat('•', v_request_id_length)
    WHEN v_request_id_length <= 8 THEN left(p_request_id, 2) || '…' || right(p_request_id, 2)
    ELSE left(p_request_id, 8) || '…' || right(p_request_id, 4)
  END;

  SELECT * INTO v_runtime
    FROM workhorse.task_runtime runtime
   WHERE runtime.task_id = p_task_id
   FOR UPDATE;

  IF FOUND THEN
    IF v_runtime.state IN ('ready', 'active') THEN
      RETURN QUERY VALUES ('already_ready'::text, v_runtime.state, v_runtime.run_at);
      RETURN;
    END IF;
    IF v_runtime.wait_name IS NOT NULL OR v_runtime.attempt_started_at IS NOT NULL THEN
      RETURN QUERY VALUES ('waiting'::text, v_runtime.state, v_runtime.run_at);
      RETURN;
    END IF;
    -- A blocked task waits for its prerequisites, not for its run time, so there is nothing to
    -- release.
    IF v_runtime.state = 'blocked' THEN
      RETURN QUERY VALUES ('not_scheduled'::text, v_runtime.state, v_runtime.run_at);
      RETURN;
    END IF;

    UPDATE workhorse.task_runtime runtime
       SET state = 'ready', run_at = v_now, ready_at = v_now,
           sequence = nextval('workhorse.ready_sequence_seq'), updated_at = v_now
     WHERE runtime.task_id = p_task_id AND runtime.state = 'scheduled'
    RETURNING * INTO v_runtime;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'locked scheduled task % changed state unexpectedly', p_task_id;
    END IF;
    DELETE FROM workhorse.enqueue_idempotency identity
     WHERE identity.task_id = p_task_id AND identity.coalescing_mode = 'debounce';

    INSERT INTO workhorse.task_event(task_id, attempt, event_type, details)
      VALUES (
        p_task_id,
        v_runtime.current_attempt,
        'promoted',
        jsonb_build_object(
          'reason', 'manual',
          'requested_by', p_requested_by,
          'request_reason', p_reason,
          'request_id_preview', v_request_id_preview,
          'request_id_digest', left(encode(v_request_id_hash, 'hex'), 12),
          'request_id_length', v_request_id_length
        )
      );
    PERFORM pg_notify('workhorse_tasks', v_runtime.queue_name);
    RETURN QUERY VALUES ('released'::text, v_runtime.state, v_runtime.run_at);
    RETURN;
  END IF;

  -- A delayed fast-tier task is ready with a future run_at, so running it now moves run_at to now.
  SELECT * INTO v_fast_runtime
    FROM workhorse.fast_task_runtime runtime
   WHERE runtime.task_id = p_task_id
   FOR UPDATE;
  IF FOUND THEN
    IF v_fast_runtime.state = 'active' OR v_fast_runtime.run_at <= v_now THEN
      RETURN QUERY VALUES ('already_ready'::text, v_fast_runtime.state, v_fast_runtime.run_at);
      RETURN;
    END IF;
    UPDATE workhorse.fast_task_runtime runtime
       SET run_at = v_now, sequence = nextval('workhorse.ready_sequence_seq')
     WHERE runtime.task_id = p_task_id;
    PERFORM pg_notify('workhorse_tasks', v_fast_runtime.queue_name);
    RETURN QUERY VALUES ('released'::text, 'ready'::text, v_now);
    RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM workhorse.fast_task_outcome outcome WHERE outcome.task_id = p_task_id) THEN
    RETURN QUERY SELECT 'not_scheduled'::text, outcome.state, NULL::timestamptz
      FROM workhorse.fast_task_outcome outcome WHERE outcome.task_id = p_task_id;
    RETURN;
  END IF;

  SELECT * INTO v_outcome
    FROM workhorse.task_outcome outcome
   WHERE outcome.task_id = p_task_id;
  IF FOUND THEN
    RETURN QUERY VALUES ('not_scheduled'::text, v_outcome.state, v_outcome.run_at);
    RETURN;
  END IF;

  IF EXISTS (SELECT 1 FROM workhorse.task task WHERE task.id = p_task_id) THEN
    RETURN QUERY VALUES ('not_scheduled'::text, NULL::text, NULL::timestamptz);
  ELSE
    RETURN QUERY VALUES ('not_found'::text, NULL::text, NULL::timestamptz);
  END IF;
END;
$$;
