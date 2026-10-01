-- workhorse-migration: {"kind":"additive"}

-- Serialize budget synchronization with claims (SM-1037).

-- Schema version 48 let sync_budgets_v1 hold only the global workhorse:budgets lock while it
-- changed or pruned a definition. A claim holds the per-budget workhorse:budget:<name> lock
-- instead, and reads the definition twice: once to admit a start and once to charge the token
-- bucket. A sync that lowered the burst between those reads made the charge drive tokens below
-- zero. CHECK (tokens >= 0) then rolled the whole claim back with SQLSTATE 23514.
--
-- sync_budgets_v1 now also takes the workhorse:budget:<name> lock of every budget it names or
-- prunes, in name order, before it reads a definition. Claims take the same locks in name order,
-- so a sync waits for a claim that holds a budget, and the two cannot deadlock.

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
