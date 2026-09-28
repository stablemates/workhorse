-- workhorse-migration: {"kind":"additive"}

-- Serialize the concurrency capacity notification with claims (SM-940).

-- notify_concurrency_capacity_v1 publishes a queue only when a release leaves it full. It counted
-- the queue's active rows without waiting for a claim that had not committed. A claim could take
-- the last slot while a release was open, and the release then counted the queue as not full and
-- stayed silent. A claim that found the queue full before the release committed waited for the
-- fallback poll. The trigger now takes the policy row FOR KEY SHARE before it counts. Every claim
-- holds that row FOR UPDATE, so the count sees each claim's leases. Releases do not wait for each
-- other. The function signature and both triggers are unchanged.

CREATE OR REPLACE FUNCTION workhorse.notify_concurrency_capacity_v1()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_policy workhorse.concurrency_policy%ROWTYPE;
BEGIN
  IF OLD.state <> 'active' OR (TG_OP <> 'DELETE' AND NEW.state = 'active') THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  -- A claim holds the policy row FOR UPDATE until it commits. Waiting for it here means the count
  -- below sees every lease a committed or open claim took, so a claim that fills the queue while
  -- this release is open cannot hide the cap. KEY SHARE does not conflict with another release, and
  -- the count runs under a snapshot taken after the wait.
  SELECT * INTO v_policy FROM workhorse.concurrency_policy policy
   WHERE policy.queue_name = OLD.queue_name
   FOR KEY SHARE;
  -- Only a release from a full queue or key can unblock a waiting claim. Every other release would
  -- wake a worker that no cap held back, and a woken worker delays its claim. This runs before the
  -- row changes, so the first row a statement releases from a full queue still counts itself. A
  -- concurrent release that has not committed still counts as active, so it cannot hide the cap.
  -- A claim counts only unexpired leases, but this count includes expired ones. It therefore counts
  -- every lease a claim may have counted when it found the queue full: a lease that expired after
  -- that claim must not hide the cap from this release.
  IF FOUND AND (
       (SELECT count(*) FROM (
          SELECT 1 FROM workhorse.task_runtime active
           WHERE active.queue_name = OLD.queue_name AND active.state = 'active'
           LIMIT v_policy.max_active
        ) capped) = v_policy.max_active
       OR (
         v_policy.max_active_per_key IS NOT NULL AND OLD.concurrency_key IS NOT NULL
         AND (SELECT count(*) FROM (
                SELECT 1 FROM workhorse.task_runtime active
                 WHERE active.queue_name = OLD.queue_name
                   AND active.concurrency_key = OLD.concurrency_key
                   AND active.state = 'active'
                 LIMIT v_policy.max_active_per_key
              ) capped) = v_policy.max_active_per_key
       )
     ) THEN
    PERFORM pg_notify('workhorse_tasks', OLD.queue_name);
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

CREATE OR REPLACE TRIGGER task_runtime_concurrency_capacity_update
BEFORE UPDATE OF state ON workhorse.task_runtime
FOR EACH ROW EXECUTE FUNCTION workhorse.notify_concurrency_capacity_v1();

CREATE OR REPLACE TRIGGER task_runtime_concurrency_capacity_delete
BEFORE DELETE ON workhorse.task_runtime
FOR EACH ROW EXECUTE FUNCTION workhorse.notify_concurrency_capacity_v1();
