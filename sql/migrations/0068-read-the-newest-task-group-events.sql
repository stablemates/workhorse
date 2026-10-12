-- workhorse-migration: {"kind":"additive"}

-- Read the newest task group events (SM-1254).

-- list_task_group_events_v1 returns the oldest events of a group first, at most 1,000. The
-- dashboard detail shows the newest 100 events, so for a group with more than 1,000 events it
-- showed the newest of the oldest 1,000. list_newest_task_group_events_v1 returns the newest events
-- first. It reads task_group_event_group_time_idx backward, so it reads only the rows it returns.
-- list_task_group_events_v1 does not change.
--
-- No change touches stored data.

CREATE OR REPLACE FUNCTION workhorse.list_newest_task_group_events_v1(
  p_group_id uuid, p_limit integer
) RETURNS TABLE (event_id uuid, event_type text, details jsonb, occurred_at timestamptz)
LANGUAGE plpgsql
STABLE
AS $$
BEGIN
  IF p_group_id IS NULL THEN RAISE EXCEPTION 'task group identity is required'; END IF;
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION 'task group event limit must be between 1 and 1000';
  END IF;
  RETURN QUERY
    SELECT event.event_id, event.event_type, event.details, event.occurred_at
      FROM workhorse.task_group_event event
     WHERE event.group_id = p_group_id
     ORDER BY event.occurred_at DESC, event.event_id DESC
     LIMIT p_limit;
END;
$$;
