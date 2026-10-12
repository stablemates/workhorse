# Task groups

A task group is a set of full-tier tasks that Workhorse tracks as one unit. A member task is a task
in a task group. When the group is sealed and every member task is finished, Workhorse enqueues the
callback tasks of the group. [ADR 0095](../decisions/0095-add-task-groups-with-completion-callbacks.md)
records the decision. Migration 0066 adds the tables and functions, and schema version 65 carries
them. [ADR 0096](../decisions/0096-count-task-group-outcomes-in-counter-shards.md) replaces the single
group counter with counter shards. Migration 0067 adds them, and schema version 66 carries them.

## Lifecycle

A group has one of three states in `task_group.state`:

1. `open`: the group accepts new member tasks.
2. `sealed`: the group accepts new member tasks only from a running member task. A canceled group
   is `sealed` until it finishes, and it accepts no task.
3. `finished`: every member task is finished. Workhorse enqueued the callbacks in the transaction
   that set this state.

`create_task_group_v1` creates an `open` group. `seal_task_group_v1` changes `open` to `sealed`.
If no member task is pending at the seal, the same call changes the group to `finished`. A seal of
a `sealed` or `finished` group changes nothing. An `open` group never expires.

`seal_task_group_v1` calls `seal_task_group_internal_v1` and returns the snapshot of
`get_task_group_v1`. The internal function locks the group row. If the group is `open`, it sets
`sealed` and `sealed_at`, and it writes the `sealed` event with the member count. Then it calls
`finish_task_group_internal_v1`, which finishes the group only when no shard is pending.

A member task is finished when Workhorse writes its `task_outcome` row: `succeeded`, `failed`, or
`canceled`. A retry writes no outcome, so a retry never counts a member task. A purge is the one
exception: it deletes a member task that is not terminal, and it records `canceled` on the
membership row without a `task_outcome` row.

The result in `task_group.result` is `succeeded` when every member task succeeded, and `failed`
otherwise. An empty group finishes with the result `succeeded`.

## Order of group changes

Five changes can change the members or the state of a group: an add, a seal, a cancel, a member
outcome, and a purge of a member task. The `task_group` row orders the add, the seal, the cancel,
and the finish. The table below also lists the delete of a finished group, the drift repair, and the
finish itself. Only
`finish_task_group_internal_v1` changes a group from `sealed` to `finished`, and it enqueues the
callbacks in the same transaction. Thus each callback is enqueued one time.

Every change takes its locks in one order: first the runtime rows of tasks, then shard rows in the
order `(group_id, shard)`, then group rows in identity order.

| Change                     | Shard rows                                                 | Group row                                        |
| -------------------------- | ---------------------------------------------------------- | ------------------------------------------------ |
| Add                        | All shard rows of the group, after the prerequisites       | Always                                           |
| Seal                       | Read without a lock                                        | Always                                           |
| Cancel                     | All shard rows, after the runtime rows of the live members | Always                                           |
| Member outcome or purge    | The shard rows of the members, at the apply step           | Only when the pending count of a shard becomes 0 |
| Delete of a finished group | All shard rows, with `SKIP LOCKED`                         | Always, with `SKIP LOCKED`                       |
| Drift repair               | All shard rows                                             | Always                                           |
| Finish                     | Read without a lock                                        | The caller holds the lock                        |

The finish condition is: the group is `sealed`, and `task_group.pending_shard_count` is 0.
Workhorse changes `pending_shard_count` only while it holds the group row lock. An add increases it
for each shard whose pending count changes from 0. An apply step decreases it for each shard whose
pending count changes to 0. A drift repair sets it from the shard rows. If a seal and the last
shard to reach 0 occur at the same time, the group row lock puts them in order, and the change that
comes second finishes the group. Each change that decreases `pending_shard_count` writes the group
row. Thus a second change at the `REPEATABLE READ` or `SERIALIZABLE` level gets a serialization
failure, and it cannot finish from an old snapshot.

After the seal, a running member task can still add tasks. That member is not terminal, so its
shard is pending and the group cannot finish first.

## Count a member outcome

A member outcome is counted in two steps in the transaction that writes the outcome:

1. **Record.** The statement trigger `task_outcome_settle_task_groups_insert` on `task_outcome`
   runs `settle_task_group_outcomes_v1()`. This trigger function reads the new outcomes of member
   tasks from the transition table `new_outcomes`, and it calls
   `record_task_group_outcomes_internal_v1`. The record function locks the membership rows whose
   `outcome` is null, in `task_id` order. It adds those members to the list of the transaction, and
   then it writes the outcome on each membership row. Only one change can write the outcome of a
   member, so a member is counted one time. This step locks no shard row and no group row.
2. **Apply.** The deferred constraint trigger `task_group_member_apply_outcomes` on
   `task_group_member` fires `AFTER UPDATE OF outcome` when `outcome` changes from null. It is
   `DEFERRABLE INITIALLY DEFERRED`, so it runs at commit. Its function,
   `apply_task_group_outcomes_v1()`, calls `apply_task_group_outcomes_internal_v1(NULL)` on the
   first firing, which applies the whole list and clears it. Each later firing finds an empty list
   and returns.

The list is the transaction-local setting `workhorse.task_group_outcomes`, written with
`set_config(..., true)` and read through `listed_task_group_outcomes_internal_v1`. It holds member
task identities only. PostgreSQL restores it when a savepoint rolls back, together with the
membership rows of that savepoint, and it discards it when the transaction ends.

`apply_task_group_outcomes_internal_v1(p_group_ids uuid[])` applies the listed members of the given
groups, or of every group when `p_group_ids` is null, and removes them from the list. In order, it:

1. Reads the outcome of each listed member from its membership row. It ignores a member with no
   outcome, and it counts a member that the list names two times one time.
2. Locks the shard rows of those members in the order `(group_id, shard)`, and adds the outcomes.
   If a shard drifted and the new sums would exceed its `total_count`, the shard keeps its counts,
   so the member outcome does not fail. The drift listing reports that shard.
3. Locks the group rows of the shards whose pending count became 0, in identity order.
4. Decreases `pending_shard_count` by the number of such shards, but never below 0. It finishes a
   group that is `sealed` with `pending_shard_count` 0.

Some changes must see the new counts before they return. An add and a purge call
`count_task_group_outcomes_internal_v1`, which records and then applies the members of their own
groups at once. A cancel applies the members of its group after every 100 calls to `cancel_v1` and
at the end. A drift repair does not apply: it sets the shard counts from the membership rows and
removes the members of its group from the list. Thus an outcome that the transaction recorded
before the repair is in the repaired counts one time.

If a caller runs `SET CONSTRAINTS ALL IMMEDIATE`, the apply trigger fires at the end of each
statement that records an outcome, inside the record step. The record step lists the members before
it writes their outcomes, so that firing finds them. Two apply passes in one transaction can lock
shard rows out of order. If two such transactions deadlock, PostgreSQL rolls back one of them, and
no count is lost or counted two times.

`cancel_task_group_v1` and `purge_queue_internal_v1` lock the runtime rows of the member tasks
before the shard rows, in the order that completion locks them.

## Tables

### `task_group`

| Column                                                 | Rule                                                                   |
| ------------------------------------------------------ | ---------------------------------------------------------------------- |
| `id uuid`                                              | Primary key; default `uuid_v7_v1()`                                    |
| `state text`                                           | `open`, `sealed`, or `finished`; default `open`                        |
| `result text`                                          | `succeeded` or `failed`; set only when `finished`                      |
| `total_count integer`                                  | 0 through 100,000; 0 until the group is `finished`                     |
| `succeeded_count`, `failed_count`, `canceled_count`    | Non-negative; their sum is at most `total_count`; 0 until `finished`   |
| `on_finish`, `on_success`, `on_failure jsonb`          | The callback enqueue requests; each is a JSON object or null           |
| `created_at`, `sealed_at`, `finished_at`, `updated_at` | `sealed_at` is set from `sealed` on; `finished_at` only when finished  |
| `canceled_at`, `canceled_by`, `cancel_reason`          | All set or all null; actor 1 through 200 characters; reason 1 to 2,000 |
| `shard_count smallint`                                 | N, the number of shard rows; set at the create and never changed       |
| `pending_shard_count integer`                          | The shards with a pending count above 0; 0 through `shard_count`       |

`task_group_state_shape_check` requires that an `open` group has no seal, finish, result, or
cancel, and that a `finished` group has counts that add up to `total_count`.
`task_group_unfinished_counts_check` requires that the four counts are 0 while the group is not
`finished`. The finish writes the sums of the shard rows to them. `task_group_shards_check`
requires `shard_count >= 1` and `pending_shard_count BETWEEN 0 AND shard_count`.

| Index                     | Columns             | Predicate            |
| ------------------------- | ------------------- | -------------------- |
| `task_group_created_idx`  | `(created_at, id)`  |                      |
| `task_group_sealed_idx`   | `(sealed_at, id)`   | `state = 'sealed'`   |
| `task_group_finished_idx` | `(finished_at, id)` | `state = 'finished'` |

### `task_group_member`

One row for each member task.

| Column                   | Rule                                                                    |
| ------------------------ | ----------------------------------------------------------------------- |
| `task_id uuid`           | Primary key, so a task is a member of one group at most; no foreign key |
| `group_id uuid`          | References `task_group.id` `ON DELETE CASCADE`                          |
| `position integer`       | 1 through 100,000; unique in its group; the order of the add            |
| `outcome text`           | The counted outcome: `succeeded`, `failed`, `canceled`, or null         |
| `added_at`, `counted_at` | `counted_at` is null exactly when `outcome` is null                     |

`task_id` has no foreign key. A purge deletes a member task that is not terminal, and the row then
keeps the `canceled` outcome that the purge counted. `task_group_member_pending_idx` indexes
`(group_id, task_id)` where `outcome IS NULL`.

### `task_group_shard`

One row for each counter shard of each group (ADR 0096). `create_task_group_v1` inserts all
`shard_count` rows, so a shard row exists for the full life of its group. A member task uses the
shard `(position - 1) % shard_count`.

| Column                                              | Rule                                              |
| --------------------------------------------------- | ------------------------------------------------- |
| `group_id uuid`                                     | References `task_group.id` `ON DELETE CASCADE`    |
| `shard smallint`                                    | 0 or more; the primary key is `(group_id, shard)` |
| `total_count integer`                               | Non-negative; the member tasks of the shard       |
| `succeeded_count`, `failed_count`, `canceled_count` | Non-negative; their sum is at most `total_count`  |

The pending count of a shard is `total_count` minus the three outcome counts.

### `task_group_callback`

One row for each callback task that a finished group enqueued: `task_id` (primary key), `group_id`
(`ON DELETE CASCADE`), `kind` (`on_finish`, `on_success`, or `on_failure`), and `enqueued_at`. The
pair `(group_id, kind)` is unique. A callback task is not a member task.

### `task_group_event`

The group history: `event_id` (primary key, `uuid_v7_v1()`), `group_id` (`ON DELETE CASCADE`),
`event_type`, `details jsonb`, and `occurred_at`. `task_group_event_group_time_idx` indexes
`(group_id, occurred_at, event_id)`.

| Event type          | Written by                             | Details                                                      |
| ------------------- | -------------------------------------- | ------------------------------------------------------------ |
| `created`           | `create_task_group_v1`                 | `callbacks`: the requested callback names                    |
| `sealed`            | A seal, or a cancel of an `open` group | `total`                                                      |
| `canceled`          | `cancel_task_group_v1`                 | Actor, reason, request ID preview, digest, length, `members` |
| `finished`          | `finish_task_group_internal_v1`        | `result`, `total`, `succeeded`, `failed`, `canceled`         |
| `callback_enqueued` | `finish_task_group_internal_v1`        | `kind`, `taskId`                                             |
| `callback_failed`   | `finish_task_group_internal_v1`        | `kind`, `code`, `message`                                    |
| `counter_repaired`  | `repair_task_group_internal_v1`        | The audit, `recorded` and `counted` counts, `shards`         |

## Create and callbacks

`create_task_group_v1(p_callbacks jsonb DEFAULT '{}', p_requests jsonb DEFAULT '[]', p_seal boolean
DEFAULT false)` returns `(group_id, ordinal, task_id, outcome, reason)`:

1. It checks that `p_callbacks` is an object with only `onFinish`, `onSuccess`, and `onFailure`.
2. It rejects a callback request with `idempotency`, `debounce`, or `throttle`. With these options,
   the enqueue could return a task that already exists.
3. It enqueues each callback request one time in a subtransaction, then rolls the subtransaction
   back. Thus a callback request that cannot enqueue fails the create, not the last member outcome.
4. If a member request or a callback request names a task type whose current contract version
   differs, it returns one `contract_mismatch` row with a null group and creates nothing. The
   TypeScript client then reloads the contracts and serializes the requests and callbacks again.
5. It creates the group with `shard_count` from `task_group_shard_count_v1()`, inserts its shard
   rows and its `created` event, adds `p_requests` in adds of at most 1,000, and seals the group if
   `p_seal` is true.

The function returns one row for each request. Without requests, it returns one row whose ordinal,
task, and outcome are null. The TypeScript block form `Queue.taskGroup` uses one call with
`p_seal = true`, so it creates, adds, and seals in one transaction.

`finish_task_group_internal_v1` enqueues `on_finish`, then `on_success` or `on_failure` as the
result selects, through `enqueue_batch_v1`. Each callback enqueue runs in a subtransaction. If it
fails with a SQLSTATE that does not start with `40` or `57`, the function writes a `callback_failed` event
and the transaction that wrote the last member outcome continues. A callback can be on any queue,
the fast tier included. Its payload is the payload the caller gave.

## Add

`add_task_group_members_v1(p_group_id uuid, p_requests jsonb, p_member_task_id uuid DEFAULT NULL,
p_worker_id text DEFAULT NULL, p_fence_token bigint DEFAULT NULL)` returns the rows of
`enqueue_many_v1`: `(ordinal, task_id, outcome, reason)`. In order, it:

1. Rejects more than 1,000 requests, and any request with `debounce` or `throttle`.
2. Locks the prerequisites of the requests through `lock_enqueue_prerequisites_internal_v1`, then
   all shard rows of the group, then the group row. Completion, cancellation, and purge lock a
   runtime row before the shard and group rows, so an add that names a member as a prerequisite
   takes the same order. An unknown group raises an error.
3. Refuses the add with `P1008` when the group is canceled or finished, when the member arguments
   do not name an `active` member of this group with that worker and fence token, or when the group
   is sealed and no member arguments are given.
4. Rejects a request on a fast-tier queue with `P1007` and feature `task groups`.
5. Enqueues the requests through `enqueue_many_v1`. On a contract mismatch it returns that row and
   adds nothing.
6. Rejects with `P1010` a `replayed` row whose task is not already a member of this group, or a task
   this call enqueued. Thus an idempotent retry of the same add returns the existing member.
7. Rejects with `P1009` an add that takes the member count above 100,000. The member count is the
   sum of the shard `total_count` values, read while the add holds all shard rows and the group row.
8. Inserts the membership rows at the next positions, increases the `total_count` of their shards,
   and increases `pending_shard_count` for each shard whose pending count was 0. Then it counts the
   outcomes that the enqueue already wrote, for example for a deadline in the past.

A task becomes a member only when this function enqueues it. A child task, a dependent task, or a
redrive target of a member task is not a member.

`Queue.addToTaskGroup` adds to an `open` group. `ctx.taskGroup.add` in a handler passes the member
arguments of its own attempt.

## Errors

| SQLSTATE | Error text                                                                   | `DETAIL`                                 | TypeScript error                   |
| -------- | ---------------------------------------------------------------------------- | ---------------------------------------- | ---------------------------------- |
| `P1008`  | `the task group does not accept tasks`                                       | `{ groupId, state, reason }`             | `TaskGroupClosedError`             |
| `P1009`  | `a task group accepts at most 100000 member tasks`                           | `{ groupId, limit, total, requested }`   | `TaskGroupLimitExceededError`      |
| `P1010`  | `enqueue idempotency returned a task that is not a member of the task group` | `{ groupId, taskId, ordinal, memberOf }` | `TaskGroupMembershipConflictError` |

The `P1008` reason is `sealed`, `finished`, `canceled`, or `not_running_member`.

## Cancel

`cancel_task_group_v1(p_group_id, p_requested_by, p_reason, p_request_id)` returns the group
snapshot, or no row for an unknown group:

1. It locks the runtime rows of the pending member tasks, then all shard rows, then the group row.
2. If the group is `finished`, it returns the snapshot and changes nothing.
3. It seals an `open` group and records the cancel columns. No task can join a canceled group, not
   even from a running member task.
4. It calls `cancel_v1` for each pending member task. A queued member task becomes `canceled` at
   once. An active member task gets a cancel request, and its outcome follows. The cancel applies
   the recorded outcomes of its group after every 100 members and at the end.
5. It writes the `canceled` event and finishes the group if no member task is pending.

The canceled member tasks count as not succeeded, so `onFinish` and `onFailure` run.
`Admin.cancelTaskGroup(groupId, { actor, reason, requestId })` calls it. `workhorse admin
cancel-task-group` calls `Admin.cancelTaskGroup`, as
[Operations and CLI: Task group cancel](operations.md#task-group-cancel) describes.

## Purge

`purge_queue_internal_v1` deletes the tasks of a queue that are not terminal. Before the deletes it
reads the member tasks among them. After the deletes, it counts each of them as `canceled` through
`count_task_group_outcomes_internal_v1` in the same transaction, which records and applies them at
once. Thus the group can finish, and a
callback that it enqueues on the purged queue stays.

## Drift and repair

`list_task_group_drift_v1(p_limit integer)` reads groups that are not finished, in identity order,
with `p_limit` from 1 through 10,000. For each member it takes the counted outcome, else the
`task_outcome` state, else `canceled` when the task row is gone. It calculates the expected counts
of each shard from its membership rows. A group drifts when one of these conditions is true:

- The counts of a shard differ from its expected counts, or a shard row is missing.
- `pending_shard_count` differs from the number of shard rows with a pending count above 0.
- The group is sealed, and no member is pending.

The `recorded_*` columns are the sums of the shard rows. The `action` is `finished` for a sealed
group with no pending member, and `recounted` otherwise.

`repair_task_group_drift_v1(p_limit, p_requested_by, p_reason, p_request_id)` repairs each listed
group through `repair_task_group_internal_v1`. In order, that function:

1. Locks all shard rows of the group, then the group row.
2. Records the missing member outcomes on the membership rows. It skips a membership row that
   another transaction holds with `SKIP LOCKED`, and counts that member as pending. That
   transaction is recording the member, and it applies the member at its commit.
3. Removes the members of the group from the list of the transaction.
4. Sets the counts of each changed shard from its membership rows. It does not add to the current
   counts.
5. Sets `pending_shard_count` from the shard counts.
6. Writes a `counter_repaired` event. `shards` lists each changed shard with its `recorded` and
   `counted` counts.
7. Finishes a sealed group whose `pending_shard_count` is 0.

It returns `(group_id, recorded_pending, pending, action)`, or no row when the group needed no
change. `Admin.listTaskGroupDrift` and `Admin.repairTaskGroupDrift` call these functions.

The finish also checks that the shard sums show no pending member. If `pending_shard_count` drifted
to 0 while a shard is pending, the group stays `sealed`, and the drift listing reports it.

## Maintenance

The `terminal_storage` routine reports the `task_groups` phase after `terminal_tasks`. The phase
calls `maintain_task_groups_v1(p_outcome_before, p_limit)` with the cutoff of
`terminal_outcome_retention_days` and the limit `terminal_task_prune_limit`:

1. It selects at most `p_limit` sealed groups that have no pending member with a live runtime row,
   oldest `sealed_at` first, and repairs them in identity order. A healthy sealed group stops the
   probe at its first live member.
2. If `terminal_outcome_retention_days` is set, it deletes at most `p_limit` finished groups whose
   `finished_at` is before the cutoff and whose callback tasks have no live runtime row in either
   tier. For each group, it locks all shard rows, then the group row, with `SKIP LOCKED`, and it
   skips the group if one of these rows is locked. The delete cascades to the shard, membership,
   callback, and event rows.

A callback task that a purge deleted has no runtime row, so it counts as terminal. A purge deletes
it without an outcome, and no later change can make it run.

`rows_affected` is the sum of the repaired and deleted groups. The routine never deletes an `open`
or `sealed` group. A redrive of a member task or a callback task does not extend the retention of
a finished group.

Terminal-task pruning keeps a member task while its group is not finished.
[Terminal-task pruning](lifecycle.md#terminal-task-pruning) states the other conditions.

## Reads

| Function                                                   | Returns                                                                                    |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `get_task_group_v1(p_group_id)`                            | The snapshot: state, result, counts with `pending`, times, cancel columns, and `callbacks` |
| `dashboard_task_groups_v1(p_input jsonb)`                  | One `dashboard/v1` page of groups, newest first, each with the snapshot fields             |
| `task_group_for_task_v1(p_task_id)`                        | `role` (`member` or `callback`), `callback_kind`, and the snapshot of the group of a task  |
| `list_task_group_members_v1(p_group_id, p_after, p_limit)` | Members after a position, at most 1,000, with the live task state and the counted outcome  |
| `list_task_group_events_v1(p_group_id, p_limit)`           | At most 1,000 events in time order                                                         |
| `list_newest_task_group_events_v1(p_group_id, p_limit)`    | At most 1,000 events, newest first                                                         |

For a group that is not finished, the counts are the sums of its shard rows, read in one statement
without a lock. For a finished group, they are the counts on its row. `task_group_for_task_v1` and
`seal_task_group_v1` return the snapshot of `get_task_group_v1`.

`callbacks` is a JSON object with one key for each requested callback, such as
`{"on_finish": {"taskId": null}}`. `taskId` is set when the finished group enqueued that callback.

`dashboard_task_groups_v1` takes `state` (`all`, `open`, `sealed`, or `finished`; default `all`),
`page` (1 through 1,000; default 1), and `pageSize` (1 through 100; default 50). It returns `state`,
`page`, `pageSize`, `hasMore`, and `groups`. Each group has `id`, `state`, `result`, `counts`
(`total`, `succeeded`, `failed`, `canceled`, `pending`), `createdAt`, `sealedAt`, `finishedAt`,
`canceledAt`, `canceledBy`, `cancelReason`, and `callbacks`, a list of `{ kind, taskId }` in the
order `onFinish`, `onSuccess`, `onFailure`. It reads one group more than it returns, so `hasMore`
costs no count of the whole table. The dashboard reads task groups only through functions, so the
task group tables are not a governed dashboard read. The dashboard detail of a group reads its
newest 101 events through `list_newest_task_group_events_v1`, shows 100, and sets `eventsTruncated`
when the group has older events.

`Queue` and `Admin` both have `getTaskGroup` and `listTaskGroupMembers`. `Admin` also has
`listTaskGroupEvents`. `workhorse admin task-groups` and `workhorse admin task-group` make the reads of
the dashboard list and detail, as [Operations and CLI: Task groups](operations.md#task-groups)
describes. A handler reads the group of its task through `ctx.taskGroup.get()`, which
calls `task_group_for_task_v1` one time for each handler activation.

## SDK calls

Each SDK calls the functions above through its `Queue`, its `Admin`, and its handler context.

| Operation          | TypeScript                    | Python                          | Go                              | Rust                               | Ruby                            |
| ------------------ | ----------------------------- | ------------------------------- | ------------------------------- | ---------------------------------- | ------------------------------- |
| Create open        | `Queue.createTaskGroup`       | `Queue.create_task_group`       | `Queue.CreateTaskGroup`         | `Queue::create_task_group`         | `Queue#create_task_group`       |
| Create and seal    | `Queue.taskGroup`             | `Queue.task_group`              | `Queue.TaskGroup`               | `Queue::task_group`                | `Queue#task_group`              |
| Add to open group  | `Queue.addToTaskGroup`        | `Queue.add_to_task_group`       | `Queue.AddToTaskGroup`          | `Queue::add_to_task_group`         | `Queue#add_to_task_group`       |
| Seal               | `Queue.sealTaskGroup`         | `Queue.seal_task_group`         | `Queue.SealTaskGroup`           | `Queue::seal_task_group`           | `Queue#seal_task_group`         |
| Group of a task    | `Queue.findTaskGroup`         | `Queue.find_task_group`         | `Queue.FindTaskGroup`           | `Queue::find_task_group`           | `Queue#find_task_group`         |
| Read in a handler  | `ctx.taskGroup.get()`         | `context.task_group.get()`      | `HandlerContext.GetTaskGroup`   | `HandlerContext::task_group().get` | `context.task_group.get`        |
| Add from a handler | `ctx.taskGroup.add(requests)` | `context.task_group.add(...)`   | `HandlerContext.AddToTaskGroup` | `HandlerContext::task_group().add` | `context.task_group.add(...)`   |
| Cancel             | `Admin.cancelTaskGroup`       | `Admin.cancel_task_group`       | `Admin.CancelTaskGroup`         | `Admin::cancel_task_group`         | `Admin#cancel_task_group`       |
| Drift              | `Admin.listTaskGroupDrift`    | `Admin.list_task_group_drift`   | `Admin.ListTaskGroupDrift`      | `Admin::list_task_group_drift`     | `Admin#list_task_group_drift`   |
| Repair             | `Admin.repairTaskGroupDrift`  | `Admin.repair_task_group_drift` | `Admin.RepairTaskGroupDrift`    | `Admin::repair_task_group_drift`   | `Admin#repair_task_group_drift` |

`Queue` and `Admin` in every SDK also have the get and member-list reads. `Admin` also has the
event read. Python `AsyncQueue` has the same calls as `Queue`.

The callbacks are `onFinish`, `onSuccess`, and `onFailure` in TypeScript. Go uses `OnFinish`,
`OnSuccess`, and `OnFailure`. Python, Rust, and Ruby use `on_finish`, `on_success`, and
`on_failure`.

The block form takes a builder function in TypeScript and Go. Python uses a `with` block, and Ruby
uses a block. In Rust, `Queue::task_group` takes a list of requests in place of a block.

The SDKs map the refusals of an add to these errors:

| SQLSTATE | TypeScript, Python, Ruby           | Go                                                                                | Rust                                 |
| -------- | ---------------------------------- | --------------------------------------------------------------------------------- | ------------------------------------ |
| `P1007`  | `FastTierUnsupportedError`         | `*FastTierUnsupportedError`                                                       | `Error::FastTierUnsupported`         |
| `P1008`  | `TaskGroupClosedError`             | `*TaskGroupClosedError`, which wraps `ErrTaskGroupClosed`                         | `Error::TaskGroupClosed`             |
| `P1009`  | `TaskGroupLimitExceededError`      | `*TaskGroupLimitExceededError`, which wraps `ErrTaskGroupLimitExceeded`           | `Error::TaskGroupLimitExceeded`      |
| `P1010`  | `TaskGroupMembershipConflictError` | `*TaskGroupMembershipConflictError`, which wraps `ErrTaskGroupMembershipConflict` | `Error::TaskGroupMembershipConflict` |

### Queue of a request with no queue

An add through `Queue` sends a request with no queue to the default queue of that `Queue`. An add
from a handler sends a request with no queue to the queue of the member task that adds it, in every
SDK. The queue list of the worker and the `defaultQueue` of a TypeScript `Queue` do not change it.
A request that names a queue keeps that queue. [ADR
0097](../decisions/0097-put-work-that-a-handler-creates-on-the-queue-of-its-task.md) records the
rule.

| SDK        | Where the SDK sets the queue of a handler add request with no queue               |
| ---------- | --------------------------------------------------------------------------------- |
| TypeScript | `TaskGroups.addAsMember` in `typescript/core/src/queue/task-groups.ts`            |
| Python     | `add_to_task_group` of the handler context in `python/src/workhorse/worker.py`    |
| Go         | `HandlerContext.AddToTaskGroup` in `go/task_groups.go`, from `handler.Task.Queue` |
| Rust       | `HandlerContext::new` in `rust/src/context.rs`, from `task.queue`                 |
| Ruby       | `Queue#add_to_task_group_as_member` in `ruby/lib/stablemates/workhorse/queue.rb`  |

A child task request with no queue follows the same rule: the child goes to the queue of the parent
task. [Data model: Queue of a child request with no
queue](data-model.md#queue-of-a-child-request-with-no-queue) describes it.

### Batch handlers

A task in a batch can be a member task. An add does not suspend a task, so the batch context of
every SDK gives each task in the batch the task group calls of that task:

| SDK        | Task group calls in the batch context                                       |
| ---------- | --------------------------------------------------------------------------- |
| TypeScript | `BatchHandlerContext.taskGroup`                                             |
| Python     | `BatchHandlerContext.task_group` and `AsyncBatchHandlerContext.task_group`  |
| Go         | `BatchHandlerContext.GetTaskGroup` and `BatchHandlerContext.AddToTaskGroup` |
| Rust       | `BatchHandlerContext::task_group`                                           |
| Ruby       | `BatchHandlerContext#task_group`                                            |

Each batch context uses the `HandlerContext` of its task. Thus the read and the add of a task in the
batch behave as they do in an ordinary handler. The read calls `task_group_for_task_v1` one time for
each activation. The add sends the member task, the worker, and the fence token of that task, so
PostgreSQL refuses it with `P1008` and the reason `not_running_member` after the lease of that task
ends. A request with no queue goes to the queue of that task in the batch.

### Active Job

`Stablemates::Workhorse::ActiveJob.task_group(on_finish:, on_success:, on_failure:, queue:)` creates,
adds, and seals a group in one statement through the `Queue#task_group` block form:

1. Each Active Job instance that the block enqueues through the Workhorse adapter, with
   `perform_later` or `perform_all_later`, becomes a member task. The adapter enqueues them when the
   block returns.
2. If the block raises, the adapter enqueues nothing.
3. Each callback is an Active Job instance, an `EnqueueRequest`, or `nil`.
4. `queue:` defaults to the queue of the Workhorse adapter that `ActiveJob::Base` uses.
5. If the block enqueues, through the Workhorse adapter, an Active Job instance that sets `enqueue_after_transaction_commit` to
   `true`, the call raises `ArgumentError` before Rails defers it. Rails would enqueue it after the
   transaction commits, so outside the group.

`Stablemates::Workhorse::ActiveJob.current_task_group` returns the `TaskGroupLink` of the Active
Job instance that runs now. It raises `ArgumentError` outside an Active Job instance that a
Workhorse worker runs. A running Active Job instance can read its group, but a `perform_later` in it
does not add to the group.

## Limits

| Limit                              | Value                                                              |
| ---------------------------------- | ------------------------------------------------------------------ |
| Member tasks in one group          | 100,000 (`task_group_member_limit_v1()`, `MAX_TASK_GROUP_MEMBERS`) |
| Counter shards of a new group      | 32 (`task_group_shard_count_v1()`)                                 |
| Tasks in one add call              | 1,000                                                              |
| Callbacks of each kind             | 1                                                                  |
| Members or events in one read      | 1,000 (`MAX_TASK_GROUP_PAGE_SIZE`)                                 |
| Groups in one drift read or repair | 10,000 (`MAX_TASK_GROUP_DRIFT_LIMIT`)                              |

A task group cannot contain another task group. No column supports nesting.
