# What is a task, and which tables hold it?

<!-- scenario-names: media, resize-image -->

A **task** is one unit of work that Workhorse accepted. It has a queue, a type, a payload, and the
rules to run it. Workhorse keeps a task in three tables, not in one row. If you know what each table
holds, you can predict much of the behavior of Workhorse.

## Follow a task from enqueue to outcome

**Example.** An application enqueues a `resize-image` task on the `media` queue. A worker runs the
task one time, and the task succeeds.

1. Workhorse inserts a `task` row with a new ID and the accepted definition. In the same
   transaction, it inserts a `task_runtime` row in the state `ready`.
2. A worker claims the task. The `task_runtime` row changes to `active` and names the worker. The
   `task` row does not change.
3. The handler returns. In one transaction, Workhorse deletes the `task_runtime` row and inserts a
   `task_outcome` row with the state `succeeded` and the result.
4. The `task` row and the `task_outcome` row stay. Workhorse does not update them again.

Each table has one purpose:

- **`task`** holds the stable ID and the accepted definition: queue, type, payload, attempt budget,
  and policy. A pending [keyed debounce](215-debounce.md) can replace the definition and keep the
  ID. When the task starts or becomes non-replaceable, Workhorse freezes the definition.
- **`task_runtime`** holds the data that changes while the task is live. This data is the state, the
  current attempt, and the worker that owns the task. Workhorse updates this row many times.
- **`task_outcome`** holds the final result: `succeeded`, `failed`, or `canceled`, with the result
  or the error. Workhorse writes this row one time, at the end, and does not update it.

A live task has one of four states. It is `scheduled` until a future time, or `ready` to run. It is
`active` while a worker owns it, or `blocked` while it waits for
[prerequisite tasks](160-task-dependencies.md).

<details>
<summary>Reference: core tables and states</summary>

| Table          | Holds                                | Writes                                            |
| -------------- | ------------------------------------ | ------------------------------------------------- |
| `task`         | Stable identity, accepted definition | `id` and `created_at` never change.               |
| `task_runtime` | Live lifecycle state                 | The only mutable lifecycle relation.              |
| `task_outcome` | Terminal state                       | Inserted once. Its semantic columns never change. |

| Table          | Allowed `state` values                    |
| -------------- | ----------------------------------------- |
| `task_runtime` | `blocked`, `scheduled`, `ready`, `active` |
| `task_outcome` | `succeeded`, `failed`, `canceled`         |

| Outcome     | Semantic column                   |
| ----------- | --------------------------------- |
| `succeeded` | `result`                          |
| `failed`    | `error`                           |
| `canceled`  | The bounded cancellation envelope |

- `enqueue_debounce_v1` may update the definition of a pending debounced task. Dispatch, a
  terminal state, or an elapsed replacement window makes it non-replaceable.
- A check constraint on `task_runtime` keeps state-specific fields apart. For example, only an
  `active` row carries a worker, a lease expiry, and a positive fence token.
- Other relations share the same identity. `task_query` is the operator projection.
  `task_checkpoint`, `task_progress`, and `task_wait` hold durable execution state.

More detail: [Data model: State-specific fields](../architecture/data-model.md#state-specific-fields).

</details>

## Tell a live task from a finished task

In the example, the task had a `task_runtime` row until it succeeded. After that, it had a
`task_outcome` row. At no time did a committed change give it both rows, or no row.

This is a rule for each task. After each committed change, a task has exactly one of the rows
`task_runtime` and `task_outcome`. Thus, Workhorse does not finish a task with an update. It deletes
one row and inserts the other row in one transaction. A reader never sees a task that is both live
and finished, or neither.

A task on a [fast-tier queue](305-fast-tier.md) obeys the same rule. It uses two smaller tables in
place of `task_runtime` and `task_outcome`. It writes history only when its queue enables history.

<details>
<summary>Reference: lifecycle exclusivity</summary>

The architecture reference calls this rule "lifecycle exclusivity".

- For every accepted task, exactly one of `task_runtime` and `task_outcome` exists after a committed
  transition.
- SQL functions preserve the rule atomically. Completion, terminal failure, and cancellation delete
  runtime and insert the outcome in one transaction.
- The same transaction closes any attempt and appends the terminal event. All of it commits or
  rolls back together.
- A fast-tier task uses `fast_task_runtime` and `fast_task_outcome`. It writes `attempt_history` or
  a `claimed` `task_event` only when its queue sets `record_attempts` or `record_claims`.

More detail: [Data model: Data model](../architecture/data-model.md#data-model).

</details>

## Keep a large history from slowing claims

Each time a worker claims work, it searches `task_runtime` for ready tasks in its queue. Workhorse
removes the row of a task from `task_runtime` when the task finishes. Thus, this table holds only
live work: tasks that are scheduled, blocked, ready, or active.

This split keeps finished tasks out of the search for ready tasks. The goal is that the cost of a
claim depends on live work, not on all the work that the queue processed before. Other factors also
change the time of a claim. They include the number of ready tasks, policy checks, the database load,
and the health of the indexes.

<details>
<summary>Reference: dispatch indexes</summary>

| Index                             | Predicate             | Serves                                                      |
| --------------------------------- | --------------------- | ----------------------------------------------------------- |
| `task_runtime_ready_idx`          | `state = 'ready'`     | Claims, by `(queue_name, priority DESC, sequence, task_id)` |
| `task_runtime_scheduled_idx`      | `state = 'scheduled'` | Due promotion, by `(run_at, task_id)`                       |
| `task_runtime_expired_active_idx` | `state = 'active'`    | Recovery candidates, by `task_id`                           |

- A `blocked` row is in no dispatch index.
- Terminal tasks occupy no dispatch index.
- `task_runtime` uses fillfactor 70, because heartbeats and lifecycle updates change rows often.

More detail: [Data model: Dispatch indexes](../architecture/data-model.md#dispatch-indexes).

</details>

## Find out what happened to a task

In the example, the finished task kept its `task` row and its `task_outcome` row. Workhorse also
recorded each event of the task. The enqueue, the claim, and the success each added an event. The
one attempt added one row for a closed attempt.

Two append-only tables hold this history. `task_event` keeps each lifecycle event. `attempt_history`
keeps one row for each attempt that closed. These tables are separate from the three core tables, so
they can grow and not slow claims. A retention routine deletes old rows on its own schedule. Each
history row has a UUID. The UUID does not change when you export history or combine the history of
many Workhorse installations.

<details>
<summary>Reference: history relations</summary>

| Relation          | Holds                                                                                                       |
| ----------------- | ----------------------------------------------------------------------------------------------------------- |
| `task_event`      | The append-only lifecycle audit, for example `enqueued`, `claimed`, and `succeeded`.                        |
| `attempt_history` | One immutable row per closed attempt: retry, lease expiry, success, terminal failure, started cancellation. |

- A timer suspension emits events but closes no attempt.
- Both relations use UTC-daily range partitions with default fallbacks.
- `task_event.event_id` and `attempt_history.attempt_id` are UUIDv7 values from `uuid_v7_v1()`. The
  UUID is the portable identity in an export store.
- `retain_history_v1` runs from `run_maintenance_v1`, once per local date.

More detail: [Data model: History](../architecture/data-model.md#history).

</details>

## Next

- [020-leases-and-fences.md](020-leases-and-fences.md) — how a worker gets ownership of a task
- [030-delivery-guarantees.md](030-delivery-guarantees.md) — why a task can run two times
- [330-retention.md](330-retention.md) — how Workhorse deletes old history

---

Exact columns, constraints, and indexes: [`architecture/data-model.md`](../architecture/data-model.md#data-model).
