# ADR 0096: Count task group outcomes in counter shards

- **Status:** Proposed
- **Date:** 2026-10-11
- **Amends:** [ADR 0095](0095-add-task-groups-with-completion-callbacks.md). This ADR replaces its
  single group counter and the counter rules in "Order of group changes".
- **Related:** [ADR 0053](0053-start-migrations-at-0-1-0-and-keep-them-additive.md)
- **Issue:** SM-1244. The measurement is SM-1232. SM-1245 implements this ADR.

## Context

ADR 0095 gives each task group one counter row, the `task_group` row. When a member task becomes
terminal, Workhorse locks that row and changes the counts in the same transaction. Thus every member
outcome of one group waits for the same row lock.

SM-1232 measured one sealed group of 100,000 member tasks, with 4, 16, and 32 workers of 8 slots
each. The run with a group completed tasks at a small part of the rate of the run without a group.
More workers made the run with a group slower, because almost every worker slot waited for the group
row. The exact results are in SM-1232, not in this repository.

The maintainer decided to add counter shards before the task group release. The design must keep
the guarantees of ADR 0095:

- Workhorse counts each member outcome one time.
- Only the change from `sealed` to `finished` enqueues the callbacks, so each callback runs one time.
- A seal and the last member outcome can occur at the same time, and the group still finishes.

The task group feature is not in a published release. Migration 0066 is on `main`, so the change is
a new additive migration.

## Decision

Workhorse counts the outcomes of member tasks in **counter shards**. A counter shard is one row that
holds the counts of a fixed part of the member tasks of one group. A member outcome locks only its
shard. The group row stays the one row that orders the add, the seal, the cancel, and the finish.

### Shard rows

A new table `task_group_shard` holds the counter shards. It has one row for each shard of each
group:

| Column                                              | Rule                                                     |
| --------------------------------------------------- | -------------------------------------------------------- |
| `group_id uuid`                                     | References `task_group.id` `ON DELETE CASCADE`           |
| `shard smallint`                                    | 0 through N − 1; the primary key is `(group_id, shard)`  |
| `total_count integer`                               | The number of member tasks in the shard                  |
| `succeeded_count`, `failed_count`, `canceled_count` | The counted outcomes; their sum is at most `total_count` |

The pending count of a shard is `total_count` minus the three outcome counts.

The `task_group` row gets two columns:

- `shard_count smallint`: N for this group. Workhorse sets it when it creates the group and never
  changes it.
- `pending_shard_count integer`: the number of shards of the group whose pending count is more than 0.

`create_task_group_v1` inserts all N shard rows in the transaction that creates the group. A shard
row exists for the full life of its group.

### How a member task selects its shard

A member task uses the shard `(position − 1) mod N`. `position` is the existing column
`task_group_member.position`: the ordinal of the member in its group, from 1. The position never
changes, so a member task never moves to a different shard.

Workhorse enqueues the members of an add in position order, and workers claim tasks of one queue in
about the same order. Thus the member tasks that run at the same time usually have consecutive
positions. N consecutive positions select N different shards, and position N + 1 selects the first
shard again. Thus the concurrent outcomes spread evenly across the N rows.

### What a member outcome locks

Workhorse counts a member outcome in two steps in the transaction that writes the outcome. The first
step claims the count. In the usual outcome path, the second step changes the shard rows when the
transaction commits.

1. **Record.** The statement trigger on `task_outcome` finds the new outcomes of member tasks. It
   records the outcome on each membership row whose outcome is still null. This step locks only the
   membership rows, so a member is counted one time. The trigger adds the member tasks to a list
   for the transaction.
2. **Apply.** A deferred constraint trigger on `task_group_member` runs when the transaction
   commits. Its first firing applies every member task in the list of the transaction, and it then
   clears the list. The later firings find an empty list and do nothing.

The list is a transaction-local setting, which the trigger writes with `set_config(..., true)`.
PostgreSQL restores the setting when a savepoint rolls back, and it discards the setting when the
transaction ends. Thus a rolled-back savepoint removes its entries from the list and its outcomes
from the membership rows together. PostgreSQL also discards the deferred trigger events of that
savepoint.

The list gives only the member tasks. The membership rows give the outcomes. The apply step does
these actions in order:

1. It locks the shard rows of the listed members, in the order `(group_id, shard)`.
2. It reads the recorded outcome of each listed member from its membership row. It ignores a
   member that has no recorded outcome, and it counts a member that the list names two times
   one time.
3. It adds these outcomes to the shard rows.
4. If the pending count of a shard became 0, it locks the group rows of those shards, in identity
   order.
5. It decreases `pending_shard_count` by 1 for each such shard. If the group is `sealed` and
   `pending_shard_count` is 0, it finishes the group.

The apply step takes all shard and group locks of the transaction in one sorted pass. Thus the lock
order does not depend on the order of the statements in the transaction. It also does not depend on
nested statements. For example, a dependency cascade writes the outcomes of the dependent tasks in a
nested statement, before the outer statement trigger runs.

In the usual outcome path, the apply step also holds a shard row lock for a shorter time. The lock
starts at the commit, not at the outcome statement.

A member outcome that leaves its shard with a pending count above 0 does not lock the group row.
If no task joins a sealed group, each shard with members reaches 0 one time. Thus the outcome path
locks the group row at most N times. An add can make a shard pending again, so a shard of an open
group can reach 0 again.

Some changes must see the new counts before they return. An add, a cancel, and a purge call the
apply step directly for the member tasks of their own groups. The direct call removes those members
from the list, so the deferred firing does not apply them again. An add and a cancel already hold
the shard rows and the group row of their group, so the direct call takes no new lock.

A drift repair does not use the apply step. It sets the shard counts from the membership rows, and
it removes the members of its group from the list. Thus an outcome that the transaction recorded
before the repair is in the repaired counts one time.

If a caller runs `SET CONSTRAINTS ALL IMMEDIATE`, PostgreSQL runs the apply step at that point.
The outcomes after that point apply at the commit, in a second pass. Two passes in one transaction
can lock shard rows out of order. If two such transactions deadlock, PostgreSQL detects it and
rolls back one of them. No count is then lost or counted two times.

### When Workhorse locks the group row

| Change                     | Locks the group row                                 |
| -------------------------- | --------------------------------------------------- |
| Add                        | Always. It checks the member limit under this lock. |
| Seal                       | Always.                                             |
| Cancel                     | Always.                                             |
| Member outcome or purge    | Only when the pending count of a shard becomes 0.   |
| Delete of a finished group | Always.                                             |
| Drift repair               | Always.                                             |
| Finish                     | The caller holds the lock.                          |

Every change takes its locks in one order. First it locks the runtime rows of tasks. Then it locks
shard rows in the order `(group_id, shard)`. Then it locks group rows in identity order. A change that can change shard rows while
it holds the group row locks those shard rows first:

- An add locks the prerequisites of its requests, then all N shard rows of its group, then the group
  row. It must lock all N rows, because it reads the member count of the group from the shard rows.
  The positions of the new members and the member limit depend on that count. An add of 1,000
  members selects every shard anyway when N is 1,000 or less.
- A cancel locks the runtime rows of the pending members, then all N shard rows, then the group row.
  The member outcomes that the cancel writes then find their shard rows already locked.
- A drift repair locks all N shard rows, then the group row.
- The `task_groups` phase of the `terminal_storage` routine deletes a finished group. It locks all
  N shard rows, then the group row, and it skips a group if one of these rows is locked. The delete
  cascades to the shard rows. Without this order, the cascade locks the shard rows after the group
  row, and an add to that group can deadlock with the delete.

The seal and the finish lock only the group row, because they do not change a shard row. They read
the shard rows without a row lock. Thus they never wait for a shard row while they hold the group
row.

The apply step gives this order to all member outcomes of one transaction. ADR 0095 locked the
group rows of different groups in statement order. The apply step also removes that case.

### How the seal and the finish stay ordered

The finish condition is: the group is `sealed`, and `pending_shard_count` is 0. Workhorse changes
`pending_shard_count` only while it holds the group row lock:

- The add increases it for each shard whose pending count changes from 0 to more than 0.
- A member outcome decreases it for each shard whose pending count changes to 0.
- A drift repair sets it from the shard rows.

The seal reads `pending_shard_count` under the group row lock. If it is 0, the seal finishes the
group. Thus the seal and the last shard to reach 0 meet on the group row:

1. If the seal comes first, it sees `pending_shard_count` 1 or more and does not finish. The last
   outcome then sees `sealed` and 0, and finishes the group.
2. If the last outcome comes first, it sees `open` and does not finish. The seal then sees 0, and
   finishes the group.

Each change that decreases `pending_shard_count` writes the group row. Thus a second change at the
REPEATABLE READ or SERIALIZABLE isolation level gets a serialization failure, as with the single
counter row. It cannot finish from an old snapshot, and it cannot miss the finish.

After the seal, a running member task can still add tasks. That member task is not terminal, so its
shard is pending and `pending_shard_count` is 1 or more. The group cannot finish before the add.

The finish holds the group row lock. It reads the shard rows without a row lock, adds their counts,
and writes the sums to the four counts on the group row. Then it selects the result and enqueues the
callbacks as ADR 0095 states. The read without a lock is correct for these reasons:

- Every shard has a pending count of 0, so no member outcome can change a shard row.
- Only an add can make a shard pending again, and an add needs the group row lock.
- Each change that brought a shard to 0 also wrote the group row. Thus the finish reads after that
  change committed, at every isolation level.

### Counts on the group row

The member count of a group is the sum of the shard `total_count` values. The add reads it while it
holds all N shard rows, so no other add or outcome can change it during the read. The add checks
the member limit against this count, and it gives the new members the next positions.

The group row keeps `total_count`, `succeeded_count`, `failed_count`, and `canceled_count`.
Workhorse writes them only when the group finishes. While the group is not finished, the four
counts are 0. A new check constraint requires this. `task_group_state_shape_check` still requires
that a finished group has counts that add up to `total_count`.

`get_task_group_v1`, `task_group_for_task_v1`, and `seal_task_group_v1` keep their result columns.
For a group that is not finished, they add the counts of its N shard rows in one statement, without
a lock. For a finished group, they read the group row.

### How Workhorse chooses N

N is 32 for every new group. The function `task_group_shard_count_v1()` returns the value, and
`create_task_group_v1` records it in `shard_count`.

- The SM-1232 scenario with 16 workers has 128 worker slots. With 32 shards, about 4 slots share a
  shard. With 32 workers, about 8 slots share a shard.
- To reach the target below, the shards together must complete at least half the rate of the run
  without a group. If each shard completes outcomes at the rate that the single row reached, 32
  shards give that rate with a margin.
- Each group has N shard rows, even a group of 1 member task. 32 small rows are an acceptable cost
  for each group. 64 rows double that cost and add no measured value.

N is not a caller option. A caller cannot know the contention of its group, and the option would
put a storage detail into five SDKs.

The group row records N, so a later migration can change N for new groups. An existing group keeps
its N.

### Drift listing and drift repair

`list_task_group_drift_v1` keeps its arguments and its result columns, with one row for each group.
For each group that is not finished, it calculates the expected counts of each shard from the
membership rows. As ADR 0095 states, it uses the counted outcome of a member. If there is none, it
uses the `task_outcome` state. If the task row is gone, it uses `canceled`. A group drifts when one of these conditions is true:

- The counts of a shard differ from the expected counts. The expected `total_count` of a shard is
  the number of its membership rows.
- `pending_shard_count` differs from the number of shards with a pending count above 0.
- The group is `sealed`, and no member task is pending.

`repair_task_group_drift_v1` keeps its arguments and its result columns. For each listed group,
`repair_task_group_internal_v1`:

1. Locks all N shard rows, then the group row.
2. Records the missing member outcomes on the membership rows.
3. Sets the counts of each shard from its membership rows. It does not add to the current counts.
   It removes the members of the group from the list of the transaction.
4. Sets `pending_shard_count` from the shard rows.
5. Writes a `counter_repaired` event. Its details add the shards that changed.
6. Finishes the group if it is `sealed` and `pending_shard_count` is 0.

The `task_groups` phase of the `terminal_storage` routine does not change. It repairs a sealed group
with no live pending member through the same function.

### How the migration moves the counts of existing groups

The task group feature is not released, but a database on `main` can have groups. The new
migration is additive. It drops and renames nothing. In one transaction, it:

1. Locks `task_group` in `EXCLUSIVE` mode. A member outcome, an add, a seal, or a cancel that runs
   under the migration 0066 functions then waits for the migration.
2. Creates `task_group_shard` and adds `shard_count` and `pending_shard_count` to `task_group`.
3. Gives every existing group N = 32 and inserts its 32 shard rows.
4. Counts the membership rows of each shard: the members, and the counted outcome of each member.
   The membership rows are the source, because they record each counted member outcome. The group
   counters cannot be divided into shards.
5. Sets `pending_shard_count` from the shard rows.
6. Sets the four counts to 0 on each group that is not finished, and adds the check constraint that
   requires this. A finished group keeps its counts.
7. Replaces the functions and the trigger with the shard versions.

A member outcome or an add that started under the migration 0066 functions can continue after the
migration. It then changes a count on the row of a group that is not finished. The check constraint
rejects that change, and the transaction rolls back as a whole. Thus no count is lost or counted
two times, and no member joins without its shard count.

A seal or a cancel that started under the migration 0066 functions does not change the counts on
the group row. The member outcomes of such a cancel go through the shard version of the trigger,
and they apply to the shard rows at its commit. That cancel locks the group row before the shard
rows. If it deadlocks with a member outcome, PostgreSQL rolls back one of the two transactions. Its
finish calls the shard version of the finish function.

The migration moves counts, and it does not repair drift. A member that has a `task_outcome` row
but no counted outcome stays pending in its shard, as it stayed pending in the group counter before.
The migration also does not finish a group. The drift listing reports such a group. The
`task_groups` phase repairs a sealed group with no live pending member at its next run, and then the
group finishes.

### The dashboard read

The same migration adds `dashboard_task_groups_v1(p_input jsonb)`. It returns one `dashboard/v1`
document with a page of task groups. Each group has its state, its result, its counts with
`pending`, and its times. The function adds the shard counts for a group that is not finished, as
`get_task_group_v1` does. SM-1237 defines the wire procedure, its filters, and its page size.

The dashboard reads task groups only through functions. Workhorse adds no `dashboard_*_v1` view of
`task_group`, `task_group_member`, or `task_group_shard`. Thus these tables do not become a governed
dashboard read, and a later migration can change the shard layout.

### Target and member limit

The target applies to the SM-1232 scenario with 16 workers. In that scenario, the run with a group
must reach at least 50% of the throughput of the same run without a group. SM-1245 runs the scenario again on its change and
records the result in Linear.

The limit of 100,000 member tasks for each group stays only if the shard design meets the target.
If it does not meet the target, the release does not ship the limit of 100,000. Then a new ADR
lowers the limit or changes the design before the task group release.

## Consequences

- A member outcome waits only for the outcomes of its own shard. The group row is no longer locked
  by each member outcome.
- Each group has N shard rows from its creation. A small group pays for 32 rows.
- A read of a group that is not finished adds N rows. A read of a finished group reads one row.
- The four counts on the group row are 0 until the group finishes. Code that reads the counts must use
  the read functions, not the `task_group` columns.
- In the usual outcome path, the shard counts change when the transaction commits. Before the
  commit, a read in the same transaction shows the recorded outcome on the membership row, but not
  yet in the shard counts.
- An add and a cancel lock all N shard rows. While they run, the member outcomes of the group wait.
  This is the same wait as with the single row, and an add or a cancel is much less frequent than a
  member outcome.
- The order of members in a shard depends on the claim order. If a queue claims members in a
  different order, for example by priority, more concurrent outcomes can select the same shard.
  They are still divided across N rows.

## Rejected alternatives

### Keep one counter row

SM-1232 measured it. The run with a group reached a small part of the rate of the run without a
group, and more workers made it slower.

### Select the shard by a hash of the task identity

A hash selects shards at random, so two concurrent member outcomes select the same shard more
often than with consecutive positions. The position is already stored, and it gives an even spread
for the members that run at the same time.

### Lock the group row without a change, and add the shard rows at the seal and at the finish

In this alternative, an outcome that brings a shard to 0 only locks the group row. Then it reads all
shard rows to decide on the finish. At READ COMMITTED, each statement reads after the lock, so the
read is correct. At REPEATABLE READ, the read uses the snapshot of the transaction. Two outcomes can
bring the last two shards to 0, and each can read the other shard as pending. Then neither finishes
the group. `pending_shard_count` writes the group row, so the second change gets a serialization
failure instead.

### Create a shard row when its first member arrives

An add would insert the shard rows that its positions need. Two adds that run at the same time can
then lock different sets of shard rows before the group row. The second add would lock a new shard
row after the group row. A member outcome on that shard locks the shard row before the group row.
The two transactions could deadlock.

### Choose N from the size of the group at creation

An open group grows after its creation, and a sealed group grows when a running member adds tasks.
The size at creation does not show how many member tasks run at the same time.

### Let the caller choose N

A caller cannot know the contention of its group. The option would put a storage detail into the
API of five SDKs, and a governed surface would then keep it.

### Count pending members from the membership rows

Each member outcome would check for pending members with the pending index, under the group row
lock. That keeps the single hot row. The index also keeps dead entries for counted members, so the
check becomes slower as the group drains.

### Change the shard rows in each outcome statement

In this alternative, the statement trigger locks and changes the shard rows at once. Each statement
sorts its own locks, but a transaction keeps its locks until the commit. Two transactions that
write member outcomes in two statements can then lock two shards in opposite orders. A dependency
cascade does this inside one completion, because it writes the dependent outcomes in a nested
statement. With one counter row, both statements locked the same row, so this case could not occur.

### Count asynchronously

A member outcome would append a row to a log, and a routine would add the log to the counters. The
finish would then wait for the routine, so the callbacks would start later. The log is another table
that grows with each outcome and that retention must clean.

### Use an advisory lock in place of the group row lock

An advisory lock on the group serializes the outcomes in the same way as the row lock. It does not
divide the contention.
