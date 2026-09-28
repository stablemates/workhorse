-- workhorse-migration: {"kind":"additive"}

-- Report each queue's tier and history settings in the dashboard (SM-945).

-- dashboard_queues_v1 already joins dashboard_queue_control_v1 for the pause flag. Each queue row
-- now also carries tier, recordAttempts, and recordClaims from the same row. A queue without a
-- control row reports the defaults: the full tier with both history settings off. The keys are
-- new, so a client built against the earlier result keeps working (ADR 0057).

CREATE OR REPLACE FUNCTION workhorse.dashboard_queues_v1(p_input jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SET jit = off
AS $$
DECLARE
  v_approximate boolean;
  v_health jsonb;
  v_queues jsonb := '[]'::jsonb;
  v_row record;
  v_plan jsonb;
  v_state text;
  v_estimate integer;
  v_succeeded integer;
  v_failed integer;
  v_canceled integer;
  v_concurrency jsonb;
  v_rate_limit jsonb;
BEGIN
  SELECT estimate >= 50000 INTO v_approximate
    FROM workhorse.dashboard_task_estimate_v1();
  v_health := COALESCE(p_input->'health', workhorse.queue_health_v1());

  FOR v_row IN
    WITH RECURSIVE task_queues(queue_name) AS (
      SELECT min(queue_name) FROM workhorse.dashboard_task_query_v1
      UNION ALL
      SELECT (
        SELECT min(query_row.queue_name)
          FROM workhorse.dashboard_task_query_v1 query_row
         WHERE query_row.queue_name > task_queues.queue_name
      ) FROM task_queues WHERE task_queues.queue_name IS NOT NULL
    ), known_queues AS (
      SELECT queue_name FROM task_queues WHERE queue_name IS NOT NULL
      UNION SELECT queue_name FROM workhorse.dashboard_queue_control_v1
      UNION SELECT queue_name FROM workhorse.dashboard_concurrency_policy_v1
      UNION SELECT queue_name FROM workhorse.dashboard_rate_limit_policy_v1
    ), live_counts AS (
      SELECT queue_name,
             count(*) FILTER (WHERE state = 'scheduled')::integer AS scheduled,
             count(*) FILTER (WHERE state = 'ready')::integer AS ready,
             count(*) FILTER (WHERE state = 'active')::integer AS active
        FROM workhorse.dashboard_task_runtime_v1 GROUP BY queue_name
    ), terminal_counts AS (
      SELECT task.queue_name,
             count(*) FILTER (WHERE outcome.state = 'succeeded')::integer AS succeeded,
             count(*) FILTER (WHERE outcome.state = 'failed')::integer AS failed,
             count(*) FILTER (WHERE outcome.state = 'canceled')::integer AS canceled
        FROM workhorse.dashboard_task_outcome_v1 outcome
        JOIN workhorse.dashboard_task_v1 task ON task.id = outcome.task_id
       WHERE NOT v_approximate GROUP BY task.queue_name
    )
    SELECT known.queue_name AS queue, COALESCE(control.paused, false) AS paused,
           COALESCE(control.tier, 'full') AS tier,
           COALESCE(control.record_attempts, false) AS record_attempts,
           COALESCE(control.record_claims, false) AS record_claims,
           COALESCE(live.scheduled, 0)::integer AS scheduled,
           COALESCE(live.ready, 0)::integer AS ready,
           COALESCE(live.active, 0)::integer AS active,
           COALESCE(terminal.succeeded, 0)::integer AS succeeded,
           COALESCE(terminal.failed, 0)::integer AS failed,
           COALESCE(terminal.canceled, 0)::integer AS canceled
      FROM known_queues known
      LEFT JOIN workhorse.dashboard_queue_control_v1 control USING (queue_name)
      LEFT JOIN live_counts live USING (queue_name)
      LEFT JOIN terminal_counts terminal USING (queue_name)
     ORDER BY known.queue_name
  LOOP
    v_succeeded := v_row.succeeded;
    v_failed := v_row.failed;
    v_canceled := v_row.canceled;
    IF v_approximate THEN
      FOREACH v_state IN ARRAY ARRAY['succeeded', 'failed', 'canceled'] LOOP
        EXECUTE 'EXPLAIN (FORMAT JSON) SELECT 1 '
                'FROM workhorse.dashboard_task_outcome_v1 outcome '
                'JOIN workhorse.dashboard_task_v1 task ON task.id=outcome.task_id '
                'WHERE task.queue_name=$1 AND outcome.state=$2'
          INTO v_plan USING v_row.queue, v_state;
        v_estimate := GREATEST(0, round((v_plan->0->'Plan'->>'Plan Rows')::numeric));
        CASE v_state
          WHEN 'succeeded' THEN v_succeeded := v_estimate;
          WHEN 'failed' THEN v_failed := v_estimate;
          WHEN 'canceled' THEN v_canceled := v_estimate;
        END CASE;
      END LOOP;
    END IF;

    SELECT jsonb_build_object(
             'namespace', policy->>'namespace',
             'maxActive', (policy->>'max_active')::integer,
             'utilizationKnown', true,
             'active', (policy->>'active')::integer,
             'available', GREATEST(0, (policy->>'max_active')::integer -
                                       (policy->>'active')::integer),
             'blockedReady', (policy->>'blocked_ready')::integer,
             'maxActivePerKey', (policy->>'max_active_per_key')::integer,
             'saturatedKeys', (policy->>'saturated_keys')::integer,
             'highestKeyActive', (policy->>'highest_key_active')::integer)
      INTO v_concurrency
      FROM jsonb_array_elements(v_health->'concurrency_policies') policy
     WHERE policy->>'queue_name' = v_row.queue;
    SELECT jsonb_build_object(
             'namespace', policy->>'namespace',
             'rate', jsonb_build_object('limit', (policy->>'rate_limit')::integer,
               'intervalMs', (policy->>'rate_interval_ms')::integer,
               'burst', (policy->>'rate_burst')::integer),
             'perKey', CASE WHEN policy->'per_key_limit' = 'null'::jsonb THEN NULL
               ELSE jsonb_build_object('limit', (policy->>'per_key_limit')::integer,
                 'intervalMs', (policy->>'per_key_interval_ms')::integer,
                 'burst', (policy->>'per_key_burst')::integer) END,
             'availableTokens', (policy->>'available_tokens')::numeric,
             'throttledReady', (policy->>'throttled_ready')::integer,
             'throttledKeys', (policy->>'throttled_keys')::integer,
             'nextEligibleAt',
             workhorse.dashboard_iso_v1((policy->>'next_eligible_at')::timestamptz))
      INTO v_rate_limit
      FROM jsonb_array_elements(v_health->'rate_limit_policies') policy
     WHERE policy->>'queue_name' = v_row.queue;

    v_queues := v_queues || jsonb_build_array(jsonb_build_object(
      'queue', v_row.queue, 'paused', v_row.paused, 'scheduled', v_row.scheduled,
      'ready', v_row.ready, 'active', v_row.active, 'succeeded', v_succeeded,
      'failed', v_failed, 'canceled', v_canceled,
      'terminalCountsApproximate', v_approximate,
      'concurrencyPolicy', v_concurrency, 'rateLimitPolicy', v_rate_limit,
      'tier', v_row.tier, 'recordAttempts', v_row.record_attempts,
      'recordClaims', v_row.record_claims));
  END LOOP;

  RETURN jsonb_build_object(
    'capturedAt', workhorse.dashboard_iso_v1(clock_timestamp()), 'queues', v_queues,
    'concurrencyPoliciesCapped', EXISTS (
      SELECT 1 FROM jsonb_array_elements(v_health->'concurrency_policies') policy
       WHERE (policy->>'capped')::boolean),
    'rateLimitPoliciesCapped', EXISTS (
      SELECT 1 FROM jsonb_array_elements(v_health->'rate_limit_policies') policy
       WHERE (policy->>'policy_set_capped')::boolean OR (policy->>'sample_capped')::boolean))
    || workhorse.dashboard_budgets_v1(v_health);
END;
$$;
