import { dashboardTaskGroupEventLimit } from "../wire.js";

/**
 * The task group reads of `dashboard/v1` (ADR 0095), as SQL that every backend runs unchanged.
 *
 * The group list calls `dashboard_task_groups_v1`. The detail and the cancel are one statement each
 * over the task group functions. `spec/generate-bindings.ts` copies these texts into the Go,
 * Python, Rust, Ruby, and Java bindings, so the six backends send the same SQL and return the same
 * JSON.
 *
 * Each statement takes one parameter, `$1`, the procedure input as `jsonb`. It returns one row with
 * one `result` column.
 *
 * The statements call only functions and name no table. Each object that a dashboard statement
 * names becomes part of the governed SQL surface, so the task group tables stay outside it.
 */

/**
 * One time as the dashboard writes every time: UTC, with three fractional digits.
 *
 * This is the expression of `dashboard_iso_v1`, inline, so the statements do not depend on that
 * function. A null time stays null.
 */
function iso(expression: string): string {
  return `to_char((${expression}) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
}

/** The JSON of one `get_task_group_v1` row named `snapshot`, with the callbacks in a fixed order. */
const taskGroupJson = `jsonb_build_object(
    'id', snapshot.group_id,
    'state', snapshot.state,
    'result', snapshot.result,
    'counts', jsonb_build_object(
      'total', snapshot.total,
      'succeeded', snapshot.succeeded,
      'failed', snapshot.failed,
      'canceled', snapshot.canceled,
      'pending', snapshot.pending
    ),
    'createdAt', ${iso("snapshot.created_at")},
    'sealedAt', ${iso("snapshot.sealed_at")},
    'finishedAt', ${iso("snapshot.finished_at")},
    'canceledAt', ${iso("snapshot.canceled_at")},
    'canceledBy', snapshot.canceled_by,
    'cancelReason', snapshot.cancel_reason,
    'callbacks', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object(
               'kind', callback.kind,
               'taskId', snapshot.callbacks -> callback.name ->> 'taskId'
             ) ORDER BY callback.ordinal), '[]'::jsonb)
        FROM (VALUES
          (1, 'on_finish', 'onFinish'),
          (2, 'on_success', 'onSuccess'),
          (3, 'on_failure', 'onFailure')
        ) callback(ordinal, name, kind)
       WHERE snapshot.callbacks -> callback.name IS NOT NULL
    )
  )`;

/**
 * One page of task groups, newest first, through `dashboard_task_groups_v1`.
 *
 * The function reads the group list and returns the same group JSON as `get_task_group_v1`. The
 * dashboard reads task groups only through functions, so no dashboard statement reads a task group
 * table.
 */
export const dashboardTaskGroupsStatement = `SELECT workhorse.dashboard_task_groups_v1($1::jsonb) AS result`;

/**
 * One task group, one page of its member tasks after a position, and its newest events.
 *
 * The backend adds `canCancel` to the input, as other reads take `canManageWorkers`, so the page
 * offers the cancel action only where the mutation can succeed.
 *
 * `result` is null when the group does not exist. The member page reads one member more than it
 * returns, so `nextAfter` is null exactly on the last page.
 *
 * `list_newest_task_group_events_v1` returns the newest events first. The detail reads one event
 * more than `dashboardTaskGroupEventLimit` and carries the newest `dashboardTaskGroupEventLimit`, so
 * `eventsTruncated` is true exactly when the group has older events that the detail does not carry.
 */
export const dashboardTaskGroupDetailStatement = `WITH input AS (
  SELECT $1::jsonb AS document
), request AS (
  SELECT (input.document ->> 'id')::uuid AS group_id,
         COALESCE((input.document ->> 'after')::integer, 0) AS after_position,
         COALESCE((input.document ->> 'pageSize')::integer, 50) AS page_size,
         COALESCE((input.document ->> 'canCancel')::boolean, false) AS can_cancel
    FROM input
), members AS (
  SELECT member.*, row_number() OVER (ORDER BY member.member_position) AS ordinal
    FROM request
    CROSS JOIN LATERAL workhorse.list_task_group_members_v1(
      request.group_id, request.after_position, request.page_size + 1
    ) member
), events AS (
  SELECT event.*,
         row_number() OVER (ORDER BY event.occurred_at DESC, event.event_id DESC) AS ordinal
    FROM request
    CROSS JOIN LATERAL workhorse.list_newest_task_group_events_v1(
      request.group_id, ${dashboardTaskGroupEventLimit + 1}
    ) event
)
SELECT (
  SELECT jsonb_build_object(
    'group', ${taskGroupJson},
    'members', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object(
               'position', members.member_position,
               'taskId', members.task_id,
               'queue', members.queue_name,
               'taskType', members.task_type,
               'state', members.state,
               'outcome', members.outcome,
               'addedAt', ${iso("members.added_at")},
               'countedAt', ${iso("members.counted_at")}
             ) ORDER BY members.ordinal), '[]'::jsonb)
        FROM members
       WHERE members.ordinal <= request.page_size
    ),
    'nextAfter', (
      SELECT members.member_position
        FROM members
       WHERE members.ordinal = request.page_size
         AND EXISTS (SELECT 1 FROM members later WHERE later.ordinal > request.page_size)
    ),
    'events', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object(
               'id', events.event_id,
               'type', events.event_type,
               'details', events.details,
               'occurredAt', ${iso("events.occurred_at")}
             ) ORDER BY events.ordinal), '[]'::jsonb)
        FROM events
       WHERE events.ordinal <= ${dashboardTaskGroupEventLimit}
    ),
    'eventsTruncated', (SELECT count(*) FROM events) > ${dashboardTaskGroupEventLimit},
    'canCancel', request.can_cancel
  )
    FROM workhorse.get_task_group_v1(request.group_id) snapshot
) AS result
  FROM request`;

/**
 * Cancel one task group through `cancel_task_group_v1` and return its snapshot.
 *
 * The input carries `id`, `actor`, `reason`, and `requestId`. `result` is null when the group does
 * not exist. The TypeScript backend calls `Admin.cancelTaskGroup` instead, which runs the same
 * function.
 */
export const dashboardCancelTaskGroupStatement = `WITH input AS (
  SELECT $1::jsonb AS document
)
SELECT (
  SELECT ${taskGroupJson}
    FROM workhorse.cancel_task_group_v1(
      (input.document ->> 'id')::uuid,
      input.document ->> 'actor',
      input.document ->> 'reason',
      input.document ->> 'requestId'
    ) snapshot
) AS result
  FROM input`;
