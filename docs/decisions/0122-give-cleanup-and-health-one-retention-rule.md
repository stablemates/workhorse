# ADR 0122: Give cleanup and health one retention rule

- **Status:** Accepted
- **Date:** 2026-11-11
- **Issues:** SM-1935, SM-1936, SM-1852, SM-1990, SM-1992; amended for SM-2019, SM-2020, SM-2021,
  SM-2022, SM-2023, and SM-2024
- **Related:** [ADR 0007](0007-automated-retention.md),
  [ADR 0118](0118-isolate-each-schedule-definition-in-a-schedule-pass.md),
  [ADR 0011](0011-daily-retention-and-split-maintenance.md),
  [ADR 0095](0095-add-task-groups-with-completion-callbacks.md),
  [ADR 0109](0109-keep-a-function-suffix-when-a-body-change-stays-compatible.md)

## Context

Terminal cleanup deletes a finished task when the task is past its row windows, history retention
has passed its history, and no other row needs it. Queue health reports `retention-lag` when a row
that cleanup can delete waits longer than `row_retention_lag_ms`. The two sides kept separate
copies of the rule, and the copies did not agree.

**Example.** A service enqueues each task with an enqueue key that expires after 30 days. The task
window is 14 days. Cleanup locked the oldest terminal tasks, up to four times its limit, and only
then removed each task that a key keeps. When the keyed tasks filled that window, each pass deleted
nothing and locked the same rows again (SM-1935). At the same time, health counted each keyed task
as lag from its window, although cleanup keeps it on purpose (SM-1852).

Three more defects were in the same code:

1. The health cutoffs read `clock_timestamp()`. That function is volatile, so PostgreSQL tested the
   cutoff in a filter on each index row. When nothing was eligible, each health poll read every task
   and every terminal outcome (SM-1936).
2. A held history watermark made the health walks read each aged row behind it. The member read of
   finished task groups joined each member of each finished group (SM-1990).
3. Each cutoff computed N days as `make_interval(days => N)`. PostgreSQL steps those days in the
   session TimeZone. Across a daylight-saving change, N days are then one hour longer or shorter
   than N times 24 hours, so cleanup and the lag differed by one hour between sessions.

## Decision

### One rule for the rows that a hold keeps

A terminal row is eligible when it is past its task identity and terminal outcome windows, history
retention has passed its history (`history_through_at < history_retained_before`), and no reference
keeps it. Cleanup and health classify each reference in the same way:

| Reference                                             | Cleanup         | Health                                    |
| ----------------------------------------------------- | --------------- | ----------------------------------------- |
| A redrive source that has a target                    | Keeps the row   | Skips the row                             |
| A member of a task group that has not finished        | Keeps the row   | Skips the row                             |
| A member of a task group that finished                | Deletes the row | Counts from the group finish              |
| A prerequisite with a dependent that is not terminal  | Keeps the row   | Skips the row                             |
| A dependency edge whose dependent is terminal         | Keeps the row   | Counts from the dependent finish          |
| A child that is not terminal or not yet eligible      | Keeps the row   | Skips the row                             |
| A child that is eligible                              | Deletes the row | Counts from the instant the child was due |
| A schedule occurrence inside its window, or no window | Keeps the row   | Skips the row                             |
| A schedule occurrence that expired                    | Keeps the row   | Counts from the history pass after expiry |
| An enqueue key that has not expired                   | Keeps the row   | Skips the row                             |
| An enqueue key that expired                           | Keeps the row   | Counts from the expiry                    |
| A runtime row                                         | Keeps the row   | Counts the row                            |
| A `task_event` or `attempt_history` row               | Keeps the row   | Counts the row                            |

A row that health skips is a hold on purpose. A row that health counts while cleanup keeps it shows
that cleanup or history retention is late to remove the reference. The key phase of the next
cleanup pass deletes an expired key, the released-edge phase deletes an edge to a terminal
dependent, and the next scheduled history pass deletes an expired occurrence. A runtime row with an
outcome breaks the state model, so health does not hide it.

One SQL function holds the cleanup rule. `terminal_row_kept_internal_v1` is the health hold
`terminal_row_held_internal_v1` with every schedule occurrence, every enqueue key, and every
dependency edge as prerequisite as a hold, plus a runtime row or a history row.

A row is due at the latest of three instants. These are the end of its row window, the scheduled
history pass that releases its history, and the end of each hold that ended. Row lag counts from the
earliest due instant of an eligible row.

The task group hold, the child hold, and the window conditions use the same SQL conditions on both
sides. `integration-retention-maintenance.test.ts` ("row retention holds") writes one row for each
reference and checks the health lag and the cleanup result together, so a change on one side only
fails that test.

### The phases record when a key hold or an edge hold ended

The key phase deletes an expired enqueue key, and the released-edge phase deletes an edge whose
dependent is terminal. Each runs before the terminal phase of the same pass. If the terminal phase
then cannot delete the task, for example because another transaction locks it, the reference is
gone. Health could then count the task only from its windows, which can be days before the key
expired.

The new nullable column `task_outcome.held_until` keeps that instant. In the statement that deletes
the reference, the key phase writes the latest expiry of the deleted keys of the task. The
released-edge phase writes the latest finish of the dependents of its deleted edges.

One function states when a hold end counts: `terminal_hold_end_internal_v1(hold_end, window_end)`.
It gives the hold end when the hold ends after the end of the row window of one lag, that is, the
retention anchor of the row plus the window of that lag. Otherwise it gives null. The identity lag
uses `created_at` plus the identity window, and the outcome lag uses `finished_at` plus the outcome
window. A phase writes the value when the function gives it for either lag. Health adds the result
of the same function for its lag to the due instant of a row. Thus a key that expires inside the
identity window but after the outcome window still moves the outcome lag. Round 5 found that the
earlier filter, "after both windows", dropped that case.

A reference that went before migration 0097 left no value, so such a row has a null `held_until`,
and its due instant starts from its windows, as on `main`. A fast-tier outcome has no `held_until`,
because the cold export writes each `fast_task_outcome` row whole. Since the amendment of
2026-11-12, the end of a fast-tier hold goes to `terminal_hold_end`, so a fast task counts from the
end of its hold too.

Both phases take the reference rows and the outcome rows with SKIP LOCKED, so they never wait. A
phase deletes the reference of a task that needs the write only in the statement that holds the
lock on its outcome and writes it. If another transaction holds the outcome, the reference stays
for a later pass, and its lock ends when the pass commits. Health then counts the task from the
expiry of the reference that is still present, which is correct. The reference stays only while
that other transaction holds the outcome, so the next pass after that transaction ends deletes it.
A reference whose task needs no write, or has no `task_outcome` row, goes as on `main`, with no
outcome lock. Round 5 showed that the earlier rule lost the hold end for good: the reference went
while the outcome kept no value.

Each phase looks up the outcome and the task of each candidate reference by primary key, with one
lookup for each reference. It locks the outcomes with `task_id = ANY`. Thus a generic plan and a
custom plan read a number of rows that the phase limit bounds, not the size of the tables. A pass
therefore still runs for about one second plus one batch.

The written outcome stays locked until the pass commits. A redrive of that task takes the outcome
`FOR SHARE`, so it waits until the pass commits. An enqueue that writes a key that the pass deleted
or kept waits in the same way, as it does on `main`. A claim, a completion, and a dependency release
touch no row that the phases lock. The locks keep their order: the reference row, then the outcome.

### Each statement that removes a held reference saves the end of its hold

The key phase and the released-edge phase are not the only statements that remove a reference
that a health gate skips. The first review of the pull request found that an enqueue that reuses an
expired key deleted it with no write. A cleanup batch that deleted a child lost the end of the hold
on the parent in the same way. Each such statement now calls one function before the removal:
`save_terminal_hold_ends_internal_v1(task_ids, hold_ends)`. It writes `held_until` only when
`terminal_hold_end_internal_v1` gives the end for one lag and the stored value is earlier. A task
with no `task_outcome` row needs no write. A statement that removes the reference and the held task
together needs no write either.

The function looks up each task and outcome by primary key. It takes each outcome that needs the
write with `FOR NO KEY UPDATE SKIP LOCKED`, so it never waits, and it returns the tasks whose
outcome another transaction holds. A maintenance statement then keeps the references of those
tasks for a later pass. The kept reference still holds the task, so health counts the task from
it, and the reference goes in the next pass after that other transaction ends. An application or
operator statement continues without the write.

| Gate                                     | Reference             | Statement that can remove it                                                                                                                               | Hold end that it saves                           | If the outcome is locked | Test                                                                                                                       |
| ---------------------------------------- | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ | ------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| An enqueue key that has not expired      | `enqueue_idempotency` | `prune_enqueue_idempotency_v1`, the key phase                                                                                                              | The latest `expires_at` of the task              | The key stays            | "keeps a key for a later pass while another transaction holds its outcome"                                                 |
|                                          |                       | `enqueue_batch_v1`, when an enqueue reuses an expired key. `enqueue_v1`, `enqueue_many_v1`, `enqueue_debounce_v1`, and `enqueue_throttle_v1` go through it | `expires_at`                                     | The enqueue continues    | "an enqueue that reuses an expired key saves the expiry on the old task" and "... does not wait for a held outcome"        |
| A schedule occurrence inside its window  | `schedule_occurrence` | `prune_schedule_occurrences_v1`, in the history pass                                                                                                       | The scheduled history pass after the window ends | The occurrence stays     | "the occurrence cleanup saves the end of the occurrence hold" and "... keeps an occurrence ..."                            |
| A prerequisite of a live dependent       | `task_dependency`     | `prune_released_dependencies_v1`, the released-edge phase                                                                                                  | The finish of the dependent                      | The edge stays           | "keeps an edge for a later pass while another transaction holds its outcome"                                               |
|                                          |                       | The cleanup batch, when it deletes the dependent and the edge cascades                                                                                     | The finish of the dependent                      | The dependent stays      | "a cleanup batch that deletes a dependent saves its finish on the prerequisite"                                            |
|                                          |                       | `purge_queue_internal_v1`, when it deletes a pending dependent                                                                                             | The purge                                        | The purge continues      | "a queue purge that deletes a pending dependent saves the end on the prerequisite"                                         |
| A parent of a child that is not eligible | `task_child`          | The cleanup batch, when it deletes the child and the edge cascades                                                                                         | The instant when the child became eligible       | The child stays          | "a cleanup batch that deletes a child saves its eligibility on the parent" and "... keeps a child ..."                     |
|                                          |                       | `purge_queue_internal_v1`, when it deletes a pending child                                                                                                 | The purge                                        | The purge continues      | "a queue purge that deletes a pending child saves the end on the parent"                                                   |
| A redrive source with a target           | `task_redrive`        | The cleanup batch, when it deletes a target and the edge cascades                                                                                          | The batch                                        | The target stays         | "a cleanup batch that deletes the last target saves the end on the redrive source"                                         |
|                                          |                       | `purge_queue_internal_v1`, when it deletes a pending target on either tier                                                                                 | The purge                                        | The purge continues      | "a queue purge that deletes a pending target saves the end on the redrive source" and "... a pending fast-tier target ..." |
| A member of an unfinished task group     | `task_group_member`   | `maintain_task_groups_v1`, when it deletes a finished group and the membership cascades                                                                    | The finish of the group                          | The group stays          | "the deletion of a finished group saves its finish on the member that stays" and "keeps a finished group ..."              |

The search covered each `DELETE` and each `UPDATE` that changes a reference on these five tables and
on `task_group_member`, and each cascade from a deleted task. Three statements need no write.
`run_task_now_v1` and the purge delete the keys of pending tasks only, and a pending task has no
outcome. `fire_schedule_v1` only gives a new occurrence its task. The other updates of
`task_dependency`, `task_child`, `task_group_member`, and `enqueue_idempotency` mark a release, a
join, an outcome, or a new expiry, and they remove no hold.

Each removed target saves the end on its source, also when another target remains. A cleanup batch
and a purge can each remove one of two targets at the same time, and each then sees the other
target, so a rule for the last target only lost the end. While a target remains, health skips the
source, and a later removal saves a later end. A cleanup batch that keeps a candidate also computes
the holds again, because the kept task stays and holds the candidates that remain. Each repeat keeps
at least one more candidate, so the loop ends after at most `p_limit` repeats. Each repeat handles
at most `p_limit` candidates and their references. In the worst case a batch therefore does work in
the order of `p_limit` squared lookups. That case needs a chain of kept candidates in which each
held task has an outcome that another transaction locks. A verification round found both cases.

An enqueue is an application path, so it must not wait and must not change the lock order. It
writes only in the branch that deletes an expired key, after it holds the key row, as the key
phase does. An enqueue with a new key or with no key runs the same statements as on `main` and
reads no `task_outcome` row ("an enqueue with a new key or no key reads no outcome row"). If another
transaction holds the outcome of the old task, the enqueue does not wait. Since the amendment of
2026-11-12, it saves the end in `terminal_hold_end` instead, so health still counts the task from
that end.

### Cleanup locks only rows that it can delete, in bounded slices

The batch tests each row of its slice with one lookup of its task and one call of
`terminal_row_kept_internal_v1`. It then locks at most `p_limit` rows, each a row that the batch can
delete, with `task.id = ANY`, so a generic plan cannot scan a whole table. A kept row therefore does
not take the place of a row that the batch can delete. The batch deletes no key and no edge.

A later statement rechecks the locked rows with a snapshot from after the locks (SM-1665). A row
that a reference joined between the slice read and the lock fails that check and keeps its lock
until the pass commits. The batch also keeps a candidate that holds a task whose outcome another
transaction locks, as the table above states, and that lock ends when the pass commits too. These
are the two cases in which the batch locks a row that it does not delete.
The `dependency_starved` probe also takes `FOR KEY SHARE` on the pinned prerequisites of a batch
that deleted nothing, which blocks only a delete of those tasks until the pass commits.

A test of each reference alone does not bound the work. If millions of kept rows come first, a lock
statement that walks from the oldest row reads all of them in each batch. Each full and fast batch
therefore examines one slice of the outcome retention index:
`terminal_prune_slice_rows_internal_v1(p_limit)` rows, four times the limit, at least 1,000 and at
most 100,000. The floor keeps a small limit from making many tiny batches.

Each tier has two walks, with positions in the new table `terminal_prune_position`:

- The main walk goes round the rows past the cutoffs. It starts after its position, and if fewer
  rows follow, it continues from the oldest row up to its position.
- The sweep walk takes the batch after each main batch that deleted rows, while the main walk has a
  position. It starts after its own position and stops at the position of the main walk. A sweep
  batch that locks its limit stores its last locked row, also in a short slice. A sweep batch that
  does not fill and reaches the main position starts the sweep again from the oldest row. Round 1
  of the pull request review found that a filled short slice started the sweep again, so the sweep
  read the rows before that slice once more for each batch.

The main position follows these rules:

- A batch that locks its limit stores its last locked row.
- A batch that examines a whole slice stores the end of the slice.
- A batch whose slice held every row past the cutoffs removes the position.
- A batch that deletes nothing also records where its run of empty batches began. When a later empty
  batch comes round to that point, the walk examined every row past the cutoffs, and the position
  goes.

A row whose hold ended behind the main position goes in a sweep batch. A main batch that deleted
rows makes the next batch of the tier a sweep batch. Each sweep batch either locks its limit L, or
examines a whole slice of S rows, or reaches the main position without filling and starts again
from the oldest row. Let R be the number of rows that the sweep examines before it reaches the row, and E the
number of rows that sweep batches lock before it. The row then goes within
2 * (ceil(R / S) + ceil(E / L) + 2) batches of its tier, also while each batch of the main walk
fills. R is at most the rows from the sweep position to the main position, plus the rows that the
main walk passes in that time, plus the rows from the oldest row to the row. When the main batches
delete nothing, no sweep batch runs, and the main walk goes round and reaches the row itself.
Cleanup does not delete in strict age order.

**Example.** The schedule of round 5 has limit 1, six old rows behind the main position, and one
new eligible row for each call. For the sixth old row, R is 6, E is 5, and S is 1,000, so the
bound is 16 batches. The review measured 11 calls, and each call runs one full-tier batch.

A stored position holds only a `finished_at` and a `task_id`, so a restore keeps it usable. A
position whose rows went makes the next slice start at the next row, or wrap. A pass that an error
stops rolls the positions back with its phase. Passes run one at a time, and each
`prune_terminal_tasks_v1` call holds the `terminal_storage` row of `maintenance_state`, so batches
write the positions one at a time.

The bounds are these:

- One tier batch examines at most one slice and deletes at most its share of `p_limit`. A released
  redrive source counts in that share.
- One `prune_terminal_tasks_v1` call runs at most three tier batches and deletes at most `p_limit`.
- The `terminal_tasks` phase of one pass repeats calls while a call deletes `p_limit` or a main
  position remains, and it starts no call after one second. One pass therefore runs for about one
  second plus one call.
- A pass that ends with a full batch, or that deleted rows and ends with a main position, records
  `terminal_cleanup_backlog_since`, and the follow-up pass is due five seconds later. A pass that
  deletes nothing records no backlog, also when it walks many kept rows.
- This change adds no subtransaction. A pass enters the four phase subtransactions of
  `prune_terminal_storage_v1`, as on `main`, plus those of `maintain_task_groups_v1`.

When a batch deletes the last target of a redrive source and has room, the full and the fast batch
lock and delete that source too. The batch then continues down the chain: each round takes the
sources that the previous round released. A round deletes at least one row or ends the loop, so a
batch runs at most `p_limit` rounds, and each statement of a round handles at most `p_limit` rows.
Round 5 found that a batch stopped after two rounds, so the first task of the chain A, B, C stayed
with no backlog. Health cannot see the instant when a target was deleted, because the
`task_redrive` row cascades away with the target. A source can still wait when the batch has no room
left. Then the next batch of the pass deletes it. After the one-second limit of the phase, the
follow-up pass five seconds later deletes it.

A batch that deletes nothing reports `dependency_starved` when a dependency edge keeps a prerequisite
of its slice that passes each cutoff, as the earlier lock window did. A row inside a window only
waits for it, so it does not count. The third Greptile review found that the probe read the whole
slice, so a row inside its identity window set `retentionPruneStarved`. The probe uses the rows that
the batch already tested against the cutoffs, so it reads no more rows. It skips a row that another
transaction locks, as the earlier lock window did. A
pass reports the flag when it deleted nothing and any of its batches saw such a pin, because each
batch examines another slice.

### Rejected designs for the cleanup batch

- **The batch deletes an expired key or a released edge with its task.** The batch had to lock rows
  of another table. Review rounds 2 to 4 found a deadlock with an enqueue, kept locks on references
  of rows that the batch left, and a subtransaction for each batch that overflowed the cache of 64
  subtransactions of a backend.
- **The key phase leaves the key of a task that cleanup can delete.** The skipped keys made the walk
  of the key phase grow, and the expiry was still lost when the terminal batch could not reach the
  task.
- **Only the main walk, without the sweep.** While each batch fills, the main walk never wraps, so a
  row whose hold ended behind it could stay for an unbounded number of passes.

### Health reads one clock value and bounds its walks

`queue_health_v1` reads `clock_timestamp()` one time and gives the value to the internal function
`terminal_retention_boundaries_internal_v1`. That function walks `task_created_retention_idx` and
the two outcome retention indexes in order. Each walk compares with that value in its index
condition. Each walk also stops at `history_retained_before`, because Workhorse writes
`history_through_at` at or after `finished_at`, and a task finishes after it is created.

The due instants do not follow the order of the rows. Each walk therefore keeps the earliest due
instant that it finds. A row later in the walk is due at or after the end of its own window. Its
history is not earlier than its anchor, so the row is also due at or after the history pass that
releases its anchor. Both bounds grow with the anchor. The walk stops at the first row whose bound
is not earlier than the earliest due instant, because no later row can be earlier. A member that is
not due cannot hide an overdue row behind it. The rows that one history pass releases together share
one bound, so the walk reads the first of them only.

The walk is a recursive query. Each step reads the next index row in order and then tests it with
one probe for each hold, through `terminal_row_held_internal_v1`, and computes its due instant
through `terminal_row_due_at_internal_v1`. The planner cannot change such a step into a scan of the
whole range with a sort, also with a generic plan. Each walk reads the held rows past their windows
and the eligible rows whose bound is earlier than the earliest due instant. It does not read the
rows inside their windows, the rows behind a held watermark, or the members of finished groups
inside their windows. `queue_health_v1` keeps `SET jit = off` and the `LIMIT 1` planner facts on its
singleton reads.

### Each health walk has a hard cap

Health is polled often, and the cost of the snapshot must follow the live work. Without a cap, a
walk reads each held row before the first eligible row. A deployment whose enqueue keys live longer
than the task window can hold millions of them. Each walk therefore examines at most
`terminal_retention_walk_rows_internal_v1()` index rows, 1,000. The cap is a constant in the SQL, so
a poll reads at most 1,000 rows of each retention index for the walks, whatever the held rows.

A walk that reaches the cap with no eligible row reports no boundary, so its row lag is null. A walk
that found an eligible row before the cap reports the earliest due instant among the rows that it
examined, so its lag is a lower bound. Behind more held rows than the cap, `retention-lag` cannot
see a late cleanup. `terminal-cleanup-backlog` reports it instead: a cleanup that deletes rows but
cannot finish them in a pass records `terminal_cleanup_backlog_since`, and the reason fires when
that backlog outlasts `terminal_cleanup_backlog_ms`. Since the amendment of 2026-11-12,
`terminal-cleanup-stalled` reports a terminal cleanup that does not run at all, also behind the cap.
`maintenance-failing` reports a cleanup that runs and fails.

### A retention window of N days is N times 24 hours

Each retention cutoff and each due instant uses `make_interval(hours => 24 * N)`. The result does
not depend on the session TimeZone. A window then has one fixed length, so the order by anchor is
the order by window expiry, and the walks need no sort.

These functions change: `queue_health_v1`, `retain_history_v1`, `prune_terminal_storage_v1`,
`sync_retention_policy_v1`, `override_retention_policy_v1` (the watermark reset),
`prune_enqueue_idempotency_v1` (the retention of queue purge requests), `rollup_stats_v1` (the
minute, hour, and day tiers), and `dashboard_retention_preview_v1`. In a UTC session their results
do not change.

These stay:

- The install seed of `history_retained_before` uses `interval '14 days'`. It runs one time, and the
  first history pass replaces the value.
- The `p_rejected_since` default of `queue_health_v1` uses `interval '1 day'`. It is not a retention
  window.
- Day arithmetic on a `timestamp` without time zone, such as the start of the next UTC day, is
  independent of the session TimeZone.
- `claim_cold_export_segment_v1` already uses `interval '24 hours'`.

The scheduled history pass stays a local time in `maintenance_policy.timezone`. That is a time of
day, not a window.

### Two reasons for maintenance and schedules that fail

`run_maintenance_v1` records each failed phase in `maintenance_run` and continues, and a schedule
pass stores the error of a failed definition and continues ([ADR
0118](0118-isolate-each-schedule-definition-in-a-schedule-pass.md)). If the failure leaves no data
that another reason tests, the verdict stayed healthy. Two degraded reasons now report them
(SM-1992):

- `maintenance-failing`, once for each routine whose newest three recorded runs failed and started
  after the last completion of the routine. `observed` is the count of newest runs that failed one
  after another after that completion, at most 50, and `budget` is 2, so one or two failed runs do
  not change the verdict. A run that succeeds or is incomplete ends the count, and a completion of
  the routine clears the reason. The tick records a successful run only when it changes a task, so
  the count starts at `maintenance_state.last_completed_at`. The second Greptile review found that a
  count across an idle success brought earlier failures back. The reason carries `routine`.
- `schedule-failing`, when at least one enabled schedule definition that is not paused has a stored
  `last_error_at`. The next pass that fires the definition clears the error, so one failed pass
  raises the reason at once. `observed` is the count of such definitions, at most 10,000, and
  `budget` is 0. One capped read gives `failing_schedule_definitions` and
  `failing_schedule_definitions_capped`. `schedule_definition` has no index on the failure
  condition, so the read examines the definitions in turn until it found 10,001 that fail. A
  partial index on that existing table needs `CREATE INDEX CONCURRENTLY`, which a transactional
  step cannot run, so this change does not add it.

No reason reads `oldestTransactionAgeMs`. A long transaction of any application in the database
changes that value and holds back vacuum of the Workhorse tables. It is not a Workhorse fault. A
reason would change the verdict for work that Workhorse does not own. An operator reads it in
`observations.oldestTransactionAgeMs` of the snapshot.

A dashboard package older than schema 96 does not know the two codes, so its System page does not
show them. It skips a code that it does not know, as it did for `terminal-cleanup-backlog` before
migration 0063, so it shows what it showed before. The level of the verdict stays correct for each
client.

### No health reason for an old task group

Health adds no reason for a task group that stays unfinished for a long time. A group can stay open
or sealed for any length of time by design, for example while an application adds members over
days. Maintenance repairs a sealed group with no live pending member, and the dashboard shows the
state of each group.

## Consequences

- A kept row no longer stops the deletion of other rows, and health no longer reports `retention-lag`
  for a row that cleanup keeps on purpose.
- A health poll reads at most 1,000 rows of each retention index for its walks. One cleanup batch
  examines at most one slice for each tier. Neither grows with the rows that cleanup keeps.
- Behind more than 1,000 held rows, row lag is null, and only the terminal cleanup backlog reports a
  late cleanup.
- Cleanup no longer deletes in strict age order.
- Near a daylight-saving change, an operator in a session TimeZone with daylight saving sees a lag
  one hour less or more than before. It is now the same value as in a UTC session.
- The migration replaces function bodies, adds thirteen internal functions, the table
  `terminal_prune_position`, and the nullable column `task_outcome.held_until`. It rewrites no row.

## Amendment: keep each hold end and do not read held rows again (2026-11-12)

Pull request 1240 left six follow-ups. This amendment closes them with migration 0104 (schema
version 103). The rules above stay: a cleanup batch deletes no key and no edge that a hold keeps,
and each path that removes a hold records its end. No path waits for a lock that it did not wait for
before.

### A hold end that `held_until` cannot take goes to `terminal_hold_end`

**Example.** A redrive holds the outcome of task A `FOR SHARE`. An enqueue reuses the expired key
of A. Before this amendment, the enqueue removed the key and dropped the end of the hold, and
health counted A from its windows until cleanup deleted it (SM-2022). A fast-tier task had the same
result after the key phase, because `fast_task_outcome` has no `held_until` (SM-2024).

`save_terminal_hold_ends_internal_v1` now writes an end to `task_outcome.held_until` when it locks
the outcome. Otherwise it inserts a row of the new table `terminal_hold_end`: for a full-tier
outcome that another transaction locks, and for each fast-tier task. That table has no unique key
on the task and no foreign key, so the insert takes no row lock and never waits. A maintenance
statement still keeps its reference while the outcome is locked. An enqueue and a purge remove the
reference, as before, and the end stays in the table.

The rule that each path records the end of the hold that it removes now reads:

- A path that holds the outcome lock records the end in `task_outcome.held_until`.
- In each other case, the end goes to a row of `terminal_hold_end`: a fast-tier task, and an
  enqueue or a purge that meets an outcome that another transaction locks. A maintenance statement
  that meets a locked outcome keeps its reference instead, so the reference still holds the task.
- A row of `terminal_hold_end` stays until the cleanup batch that deletes its task deletes it too.

One reader reads the end: `terminal_row_due_at_internal_v1`, which gives queue health the due
instant of a row, reads the latest end in both places. It is the only statement that reads the end
to decide a lag. `record_terminal_hold_ends_internal_v1` also reads `held_until`, but only to skip a
write that would not move the stored end.
Cleanup tests references and windows and does not read the end. No dashboard read selects the
column, the cold export does not export `task_outcome`, and no SDK reads it. Thus no reader misses
an end that is only in `terminal_hold_end`.

An earlier version of this change copied each full-tier row to `held_until` in each cleanup call.
The fourth review found that the copy held the outcome lock until the pass committed, so a redrive
of that task waited for the pass. One more copy gave no reader anything, so the copy is gone. The
second review had found that the copy, when it went through the save function, dropped an end that
longer windows made irrelevant. `fast_task_outcome` and its cold export rows do not change. A second column on
`fast_task_outcome` would change each exported row, so this amendment does not add one.

### Each array test of the hold code is one sort or one hash

The hold code computed set differences with `NOT x = ANY(array)` (SM-2023). That test searches the
array once for each row. PostgreSQL hashes a constant array, so a custom plan stayed linear, but a
generic plan, which a long-lived session uses, does not hash a parameter array. A save at the
largest limit then made about five billion comparisons while the key phase held its locks. Each
such test is now a grouping, a window, or `EXCEPT` over the batch:
`terminal_deleted_holds_internal_v1`, `terminal_tasks_free_of_internal_v1`, the windows of the key
phase, the released-edge phase, and the occurrence cleanup, and three statements of the purge. The
update of `held_until` reads each end from one JSON object and finds its rows with `task_id = ANY`
through the primary key. A join of the outcome with the array of ends let the planner scan
`task_outcome` under a generic plan, so it is not used.

A count that does not depend on the speed of the host cannot show a comparison inside an
expression. The test "tests no array once for each row in the hold code" therefore checks the
function bodies, and "reads rows in proportion to the limit in the key phase" checks the rows that
the key phase reads at two limits, beside 4,000 rows that it must not read.

### Each health walk starts after the held rows that a poll passed

Each walk read up to 1,000 held rows again on each poll (SM-2021). A poll now stores, in
`terminal_retention_walk_start`, the last row of a run of rows at the start of each walk and the
earliest instant when a row of the run can become eligible. A row keeps the run only when each
reason that it waits for ends at a known instant: a row window, an enqueue key, or a schedule
occurrence. No statement removes an unexpired key or an occurrence inside its window from a terminal
task, and a new terminal row has a later anchor. Thus no row behind the stored point can become
eligible before that instant, and the walk keeps the earliest due instant. A hold that ends at an
event, a row that waits for history retention, or a task with no outcome ends the run. The walk
uses the stored run only before that instant and while both row windows, the occurrence window, and
the history watermark are the same, so each walk starts from the oldest row at least once a day.
The first review found that a shorter row window made a row of the run eligible while the walk
still started after it.

`queue_health_v1` writes the table only at read committed, in a writable transaction, and only when
it gets an advisory lock at once. A poll therefore waits for no lock, and a poll on a standby or in a
read-only transaction, as the JVM dashboard reads, stores nothing. The first review found that a
poll at repeatable read failed with SQLSTATE `40001` when another poll had changed the row after
its snapshot, so such a poll stores nothing too. The review also found that the read-only dashboard
role, which has `SELECT` only, failed with SQLSTATE `42501`. A poll now writes only when its role has
`INSERT` and `UPDATE` on the table. Event holds are not stored, because many
statements end them. A walk behind many such rows still reads up to its cap on each poll.

### A health reason for a cleanup that does not run

`terminal-cleanup-stalled` (SM-2019) fires when terminal cleanup did not complete a pass for longer
than `row_retention_lag_ms` plus `terminal_cleanup_interval_ms` while terminal rows exist. After a
first completion, the reason counts from the last completion while a terminal outcome exists. It
reads only the oldest terminal outcome, which the snapshot reads for its document anyway. The second
review found that a sample of the first rows of each index missed an old eligible row behind rows
that the reads skip. Before a first completion, the reason counts from the earliest instant when one
terminal row passed both of its row windows, among the first five rows of each retention index, so
a new database without maintenance does not report it. The first review found that a value that
combined the oldest creation of one task with the oldest finish of another fired the reason while
no row had passed both windows. A pass
completes also when it deletes nothing, so the reason reports a cleanup that does not run. It reads
no walk. The budget reuses the row retention budget, because the reason reports the lag that
`retention-lag` cannot see behind the cap. A new policy column would change the policy functions of
each SDK. The interval in the budget keeps a long `terminal_cleanup_interval_ms` from firing it.

### The read of failing schedules stays without an index

The amendment measured the read of `failing_schedule_definitions` (SM-2020). At 10,000 definitions
with a few failing ones, the read is one sequential scan of 251 table pages, all in shared buffers.
The schedule pass reads the definitions of each offered namespace in the same way. The read grows
in proportion to the definitions. A partial index needs a step outside a transaction. The question
returns when a deployment holds about 100,000 definitions, a scan of about 2,500 pages for each
poll.

### Consequences of the amendment

- A health poll can write one row of `terminal_retention_walk_start`. It writes only when the value
  changes.
- `terminal_retention_boundaries_internal_v2` replaces `terminal_retention_boundaries_internal_v1`
  in `queue_health_v1`. The earlier function stays, and no function calls it.
- A dashboard package of an earlier release does not know `terminal-cleanup-stalled`, so it skips
  the code, as for the earlier codes.
