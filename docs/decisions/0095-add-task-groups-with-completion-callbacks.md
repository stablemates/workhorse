# ADR 0095: Add task groups with completion callbacks

- **Status:** Accepted
- **Date:** 2026-10-11
- **Related:** [ADR 0030](0030-distinguish-suspensions-gates-and-child-joins.md),
  [ADR 0051](0051-lead-with-durable-job-queue.md),
  [ADR 0055](0055-the-1-0-0-schema-boundary-adds-no-migration.md),
  [ADR 0075](0075-shape-the-ruby-sdk-as-one-gem-with-an-active-job-adapter.md),
  [ADR 0077](0077-add-a-fast-task-tier-that-records-one-outcome-row-per-task.md)
- **Issue:** SM-1205. The peer research is SM-1201.

## Context

An application often enqueues many tasks and must do one more action when all of them finish. For
example, it imports 20,000 rows as 20,000 tasks and then sends one report.

Workhorse has two tools that join tasks, and each tool has a limit of 100 tasks:

- Dependency fan-in. A dependent task waits for a maximum of 100 prerequisites.
- `ctx.runChildren`. A parent task waits for a maximum of 100 child tasks.

The limit of 100 is correct for these tools. Each dependency edge takes row locks at enqueue, needs
cycle and cascade checks, and makes a failure cascade in the outcome transaction. A join of 20,000
tasks needs none of these costs. It needs one counter that decreases when each task becomes
terminal.

Many peer task queues have a feature that tracks a group of tasks and enqueues a callback when the
group finishes. The task queues for Ruby on Rails give it to users at no cost. SM-1201 compares
how 19 peer systems do this. Most of them agree on the semantics.

## Decision

Workhorse adds the **task group**. A task group is a set of full-tier tasks that Workhorse tracks
as one unit. A **member task** is a task in a task group. `CONTEXT.md` defines both terms.

### Scope

A task group is a task-queue feature under ADR 0051. It is not a workflow layer, and it does not
decide SM-891. A task group has no graph and no order between its members. The member handlers
share no application state.
Workhorse does not change the limits on dependencies and child tasks.

### When a member task is finished

A member task is finished when Workhorse writes its `workhorse.task_outcome` row: `succeeded`,
`failed`, or `canceled`. Workhorse writes that row one time, when the task becomes terminal. A
retry writes no outcome, so a retry never counts a task two times. Some outcomes have no retry,
for example a dependency rejection or a missed deadline. Workhorse decreases the group counter in
the same transaction.

### Order of group changes

Five changes affect a group: add, seal, cancel, a member outcome, and a purge of member tasks. Each
change locks the group row before it reads or changes the counter. Only the change from `sealed` to
`finished` enqueues the callbacks, so the callbacks run one time.

A seal and the last member outcome can occur at the same time. The lock puts them in order, and the
change that comes second finishes the group. After the seal, a running member task can still add
tasks. That member is not terminal, so the counter is 1 or more, and the group cannot finish first.

### Callbacks

A task group has a maximum of three callbacks. Each callback runs one time, after the last member
task is finished:

| Callback    | Runs when                                                                   |
| ----------- | --------------------------------------------------------------------------- |
| `onFinish`  | Every member task is finished.                                              |
| `onSuccess` | Every member task is finished and every member task `succeeded`.            |
| `onFailure` | Every member task is finished and one or more member tasks did not succeed. |

A `canceled` member task counts as "not succeeded". No callback runs at the first failure, and no
callback runs when each member task has run one time.

A callback is an ordinary enqueue request: queue, task type, payload, and options. The caller gives
it when it creates the group. Workhorse enqueues the callback task in the transaction that finishes
the group. The callback task can be on any queue, the fast tier included. It is not a member task.
Its payload is the payload that the caller gave. Its handler reads the group ID and the counts
through `ctx.taskGroup`. The group does not collect the results of its member tasks.

If a callback request has enqueue idempotency, debounce, or throttle options, Workhorse rejects the
create call. With these options, the enqueue could return a task that already exists, and the
callback would not run for this group. Workhorse does not need them, because it enqueues each
callback one time. A redrive of a callback task creates an ordinary task with no group link.

### Lifecycle

1. The caller creates the group. The group is `open`.
2. The caller adds tasks to the group. It can add tasks in one or more transactions.
3. The caller seals the group. The group is `sealed`.
4. When every member task is finished, Workhorse enqueues the callbacks. The group is `finished`,
   with the result `succeeded` or `failed`.

If the group has no member tasks when the caller seals it, the group finishes at once. The SDK
block form creates, adds, and seals in one transaction. After the seal, only a running member task
can add tasks to its group, through its handler context. If a caller adds a task to a finished or
canceled group, Workhorse rejects the add. An open group never expires.

### Membership rules

- A task is a member of one group at most.
- A task becomes a member only when it is enqueued. A caller cannot add a task that already exists.
- Member tasks can be on different queues and can have different task types.
- If a task is on a fast-tier queue, Workhorse rejects it as a member with `P1007`.
- A task that redrive creates is not a member, even if its source task was a member.
- If enqueue idempotency would return a task that already exists, Workhorse rejects the add. An
  idempotent retry of the same add to the same group returns the existing member task.
- Workhorse rejects debounce and throttle options on an add to a group.
- A member task can have prerequisites, child tasks, a delayed start, and durable waits. A child
  task or a dependent task of a member task is not a member.

### Operations

- `Admin.cancelTaskGroup` seals an open group, so no task can join it after the call, not even
  from a running member task. Then it cancels every member task that is not terminal. It takes an
  actor, a reason, and a request ID. The canceled member tasks count as "not succeeded", so the
  group finishes as usual and `onFinish` and `onFailure` run. If the group is already finished, the
  call changes nothing and returns the current state.
- If `Admin.purgeQueue` deletes a member task that is not terminal, the member counts as
  `canceled`. The purge decreases the group counter in the same transaction, so the group can
  finish. A purge thus gives the same result as `cancelTaskGroup` for the purged members.
- `Admin.listTaskGroupDrift` and `Admin.repairTaskGroupDrift` find and repair a group counter that
  does not agree with the member outcomes.
- A maintenance phase finds a sealed group whose member tasks are all finished but whose callbacks
  are not enqueued, and repairs it.
- The `terminal_storage` routine deletes a finished group and its membership rows after its
  callback tasks are terminal. It uses the retention period of terminal tasks. It never deletes an
  open group.
- The `terminal_storage` routine does not delete a member task while its group is not finished. A
  sealed group can wait longer than the retention period, and it needs its member outcomes when it
  finishes. A redrive of a member task or a callback task does not extend the retention of a
  finished group.

### Limits

| Limit                     | Value                                                                  |
| ------------------------- | ---------------------------------------------------------------------- |
| Member tasks in one group | 100,000. The hot-group benchmark can change this value before release. |
| Tasks in one add call     | 1,000, the same as bulk enqueue.                                       |
| Callbacks of each kind    | 1                                                                      |
| Callback payload          | The payload limits of every task.                                      |

Workhorse checks the member limit while the add holds the group row lock, so two adds at the same
time cannot go above it.

A task group cannot contain another task group. This ADR adds no column for nesting. A later
migration can add one.

### Visibility

- `getTaskGroup(id)` returns the state, the result, the counts (`total`, `succeeded`, `failed`,
  `canceled`, `pending`), and the times.
- `listTaskGroupMembers(id, page)` returns the member tasks one page at a time.
- `Queue` and `Admin` both have these two calls.
- Workhorse writes a history event when a group is created, sealed, finished, or canceled, when it
  enqueues a callback, and when it repairs a counter.
- The dashboard has a list of groups and a detail page for each group. Both show a progress bar
  from the counts. The detail page also shows the member tasks, the callback tasks, and the events.

### SDKs and release

All five SDKs get the feature. The Ruby SDK uses the block form and the callback names
`on_finish`, `on_success`, and `on_failure`, which Rails users already know.

ADR 0055 does not let 1.0.0 add a migration, so the feature must ship in a 0.x release. It ships in
the first 0.x release in which the SQL, all five SDKs, the dashboard, and the documentation are
complete. The migration can merge into `main` before that release, because migrations only add.

## Consequences

- An application can join more than 100 tasks without a change to the dependency or child limits.
- A group counter can become incorrect. The admin calls and the maintenance phase repair it, so a
  group that does not finish is visible and can be repaired.
- One counter row for each group can become a contention point when many member tasks finish at
  the same time. The hot-group benchmark measures this before the release. Workhorse adds counter
  shards only if the benchmark shows that they are necessary.
- A group with a member task that never becomes terminal never finishes. For example, a member
  task that waits for a prerequisite that never finishes stops its group. The documentation must
  say this.
- The word "batch" keeps its two current meanings: batch handlers and bulk enqueue. The batch
  handler documentation stops using "group" and "member" for the tasks in one dispatch.
- No progress chart over time is in the first release. It needs snapshots of the counts at
  intervals, which is new storage.

## Rejected alternatives

### Increase the dependency or child limit

The limit of 100 controls costs that grow with each edge. A larger limit makes each enqueue and
each outcome transaction slower, and a group does not need edges.

### Name the feature "batch"

Peer systems use "batch", so users know the word. But Workhorse already uses "batch" for batch
handlers, and `ctx.batchId` identifies one batch-handler dispatch. A task can be in a batch-handler
dispatch and in a group at the same time. The word would then have two meanings in one handler.

### Run the failure callback at the first failure

Some peers do this. Then a group can run its failure callback while member tasks still run, and a
second callback runs at the end. One callback after the last member task is easier to reason
about. A handler that must react at once can do so when it fails. A later ADR can add a
first-failure callback without a change to these three callbacks.

### Run a callback when each member task has run one time

This needs a counter for each attempt. It has no clear meaning for a member task that waits a long
time before its first run. Only peers that store their state in Redis, and one other peer, offer
it.

### Make a deduplicated task a member

A task would then join a group after it was enqueued, which breaks the membership rules. Silently
skipping the task would let a group finish without the work that the caller expects.

### Collect member results for the callbacks

The group would need a size limit for the collected results, and a large group would write one
very large row. The callback can read each member task through `listTaskGroupMembers`.

### Add a column for nested groups now

A column that no feature uses is a promise that Workhorse must keep after 1.0.0. A later migration
can add a nullable column at no cost.
