BEGIN;

SELECT pg_advisory_xact_lock(hashtextextended('workhorse:schema-migration', 0));

DO $migration$
DECLARE
  v_version integer;
  v_version_rows integer;
BEGIN
  SELECT count(*)::integer, min(version) INTO v_version_rows, v_version
    FROM workhorse.schema_version;
  IF v_version_rows <> 1 THEN
    RAISE EXCEPTION 'workhorse.schema_version must contain exactly one row';
  END IF;
  IF v_version NOT IN (28, 29) THEN
    RAISE EXCEPTION 'migration 0029 requires schema version 28, found %', v_version;
  END IF;
END;
$migration$;

ALTER TABLE workhorse.enqueue_idempotency
  DROP CONSTRAINT IF EXISTS enqueue_idempotency_coalescing_mode_check;
ALTER TABLE workhorse.enqueue_idempotency
  ADD CONSTRAINT enqueue_idempotency_coalescing_mode_check
  CHECK (coalescing_mode IN ('idempotency', 'debounce', 'throttle'));

CREATE OR REPLACE FUNCTION workhorse.enqueue_throttle_v1(p_request jsonb)
RETURNS TABLE (job_id uuid, outcome text)
LANGUAGE plpgsql
AS $$
DECLARE
  v_now timestamptz;
  v_throttle jsonb := p_request->'throttle';
  v_key text;
  v_scope text;
  v_key_hash bytea;
  v_window_ms numeric;
  v_existing record;
  v_normalized jsonb;
  v_row record;
BEGIN
  IF p_request IS NULL OR jsonb_typeof(p_request) <> 'object'
     OR v_throttle IS NULL OR jsonb_typeof(v_throttle) <> 'object'
     OR v_throttle - ARRAY['key', 'scope', 'windowMs'] <> '{}'::jsonb
     OR NOT (v_throttle ?& ARRAY['key', 'windowMs'])
     OR jsonb_typeof(v_throttle->'key') <> 'string'
     OR (v_throttle ? 'scope' AND jsonb_typeof(v_throttle->'scope') <> 'string')
     OR jsonb_typeof(v_throttle->'windowMs') <> 'number' THEN
    RAISE EXCEPTION 'throttle requires key, windowMs, and only an optional scope';
  END IF;
  IF p_request ? 'idempotency' OR p_request ? 'debounce' THEN
    RAISE EXCEPTION 'enqueue requests cannot combine idempotency, debounce, or throttle';
  END IF;

  v_key := v_throttle->>'key';
  v_scope := COALESCE(v_throttle->>'scope', 'default');
  v_window_ms := (v_throttle->>'windowMs')::numeric;
  IF v_key = '' OR octet_length(v_key) > 512 THEN
    RAISE EXCEPTION 'throttle key must contain between 1 and 512 UTF-8 bytes';
  END IF;
  IF v_scope = '' OR octet_length(v_scope) > 256 THEN
    RAISE EXCEPTION 'throttle scope must contain between 1 and 256 UTF-8 bytes';
  END IF;
  IF v_window_ms <> trunc(v_window_ms) OR v_window_ms NOT BETWEEN 1 AND 31536000000 THEN
    RAISE EXCEPTION 'throttle windowMs must be an integer between 1 and 31536000000';
  END IF;

  v_key_hash := workhorse.idempotency_key_hash_v1(v_scope, v_key);
  PERFORM pg_advisory_xact_lock(hashtextextended(v_scope || chr(31) || v_key, 0));
  v_now := clock_timestamp();
  SELECT identity.job_id, identity.expires_at, identity.coalescing_mode
    INTO v_existing
    FROM workhorse.enqueue_idempotency identity
   WHERE identity.idempotency_scope = v_scope
     AND identity.idempotency_key_hash = v_key_hash
   FOR UPDATE OF identity;
  IF FOUND AND v_existing.expires_at > v_now
     AND v_existing.coalescing_mode <> 'throttle' THEN
    RAISE EXCEPTION 'throttle key is retained for incompatible coalescing mode';
  END IF;

  v_normalized := (p_request - 'throttle') || jsonb_build_object(
    'idempotency', jsonb_build_object('key', v_key, 'scope', v_scope, 'ttlMs', v_window_ms)
  );
  SELECT * INTO v_row FROM workhorse.enqueue_many_v1(jsonb_build_array(v_normalized));
  IF v_row.accepted THEN
    UPDATE workhorse.enqueue_idempotency SET coalescing_mode = 'throttle'
    WHERE idempotency_scope = v_scope AND idempotency_key_hash = v_key_hash;
  END IF;
  job_id := v_row.job_id;
  outcome := CASE WHEN v_row.accepted THEN 'accepted' ELSE 'coalesced' END;
  RETURN NEXT;
END;
$$;

CREATE OR REPLACE FUNCTION workhorse.enqueue_many_v2(p_requests jsonb)
RETURNS TABLE (ordinal integer, job_id uuid, outcome text)
LANGUAGE plpgsql
AS $$
DECLARE
  v_request jsonb;
  v_ordinal integer;
  v_row record;
  v_lock record;
  v_error_message text;
  v_error_detail text;
BEGIN
  IF p_requests IS NULL OR jsonb_typeof(p_requests) <> 'array' THEN
    RAISE EXCEPTION 'requests must be a JSON array';
  END IF;
  IF jsonb_array_length(p_requests) > 1000 THEN
    RAISE EXCEPTION 'enqueue batch exceeds maximum size of 1000';
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

  IF NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_requests) input(request)
     WHERE request ? 'debounce' OR request ? 'throttle'
  ) THEN
    RETURN QUERY
      SELECT result.ordinal, result.job_id,
             CASE WHEN result.accepted THEN 'accepted' ELSE 'replayed' END
        FROM workhorse.enqueue_many_v1(p_requests) result ORDER BY result.ordinal;
    RETURN;
  END IF;

  FOR v_request, v_ordinal IN
    SELECT request, ordinality::integer
      FROM jsonb_array_elements(p_requests) WITH ORDINALITY input(request, ordinality)
     ORDER BY ordinality
  LOOP
    IF v_request ? 'debounce' THEN
      SELECT * INTO v_row FROM workhorse.enqueue_debounce_v1(v_request);
      ordinal := v_ordinal;
      job_id := v_row.job_id;
      outcome := v_row.outcome;
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
      job_id := v_row.job_id;
      outcome := v_row.outcome;
    ELSE
      BEGIN
        SELECT * INTO v_row FROM workhorse.enqueue_many_v1(jsonb_build_array(v_request));
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
      job_id := v_row.job_id;
      outcome := CASE WHEN v_row.accepted THEN 'accepted' ELSE 'replayed' END;
    END IF;
    RETURN NEXT;
  END LOOP;
END;
$$;

INSERT INTO workhorse.schema_migration(version, description)
VALUES (29, 'add keyed throttle enqueue')
ON CONFLICT DO NOTHING;

DELETE FROM workhorse.schema_version WHERE version = 28;
INSERT INTO workhorse.schema_version(version) VALUES (29) ON CONFLICT DO NOTHING;

COMMIT;
