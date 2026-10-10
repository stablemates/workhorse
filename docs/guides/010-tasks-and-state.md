# What is a task, and which tables hold it?

<!-- scenario-names: media, resize-image -->

A **task** is one unit of work that Workhorse accepted: a queue, a type, a payload, and the rules
for running it. A task is not one row. Its core lives in three tables, and the split explains much
of the rest of the system.

## One task, from enqueue to outcome

**Example.** An application enqueues a `resize-image` task on the `media` queue. A worker runs it
once, and it succeeds. This is what each table holds along the way.

1. **Enqueue.** Workhorse inserts a `task` row with a new id and the accepted definition. In the
   same transaction it inserts a `task_runtime` row in state `ready`. No `task_outcome` row exists.
2. **Claim.** A worker claims the task. The same `task_runtime` row changes to `active`, and it now
   names the worker that owns it. The `task` row does not change.
3. **Completion.** The handler returns. In one transaction, Workhorse deletes the `task_runtime`
   row and inserts a `task_outcome` row with state `succeeded` and the result.
4. **Afterwards.** The `task` row and the `task_outcome` row stay. Nothing updates either again.

Each table has one purpose:

- **`task`** holds the stable id and the accepted definition: queue, type, payload, attempt budget,
  and policy. A pending [keyed debounce](215-debounce.md) may replace that definition while keeping
  the id. Once the task starts or becomes non-replaceable, Workhorse freezes the definition.
- **`task_runtime`** holds what changes while the task is alive. That is its state, its current
  attempt, and the worker that owns it, if any. One row is updated many times.
- **`task_outcome`** holds the final answer: succeeded, failed, or canceled, with the result or the
  error. Workhorse writes it once, at the end, and never updates it.

A live task has one of four states. It is `scheduled` until a future time, `ready` to run,
`active` while a worker owns it, or `blocked` while it waits on
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

## The rule that ties them together

In the story, the task had a `task_runtime` row until completion, and a `task_outcome` row after
it. At no committed moment did it have both, or neither.

That is the rule. After any committed change, a task has **exactly one** of `task_runtime` and
`task_outcome`. So finishing a task is not an update. It is a delete and an insert in one
transaction. No reader can see a task that looks both alive and finished, or neither.

The architecture reference calls this rule "lifecycle exclusivity".

A task on a [fast-tier queue](305-fast-tier.md) keeps the same rule. It uses two leaner tables in
place of `task_runtime` and `task_outcome`, and it writes history only when its queue opts in.

<details>
<summary>Reference: lifecycle exclusivity</summary>

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

## Why bother

Workers search `task_runtime` every time they claim work. They ask: what is ready to run in this
queue?

In the story, the `resize-image` row left `task_runtime` at completion. So that table holds only
live work: scheduled, blocked, ready, or running. Finished tasks are not in the table that the
search reads.

The split keeps completed history out of the ready scan. Its goal is for dispatch cost to scale with
live work, not with all work the queue has ever processed. Other factors still affect claim
latency. They include the current backlog, policy checks, database load, and index health.

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

## Where the history goes

In the story, the finished task kept its `task` and `task_outcome` rows. Workhorse also recorded
what happened on the way. The enqueue, the claim, and the success each left an event. The one
attempt left one closed-attempt row.

Two append-only tables hold that record. `task_event` keeps every lifecycle event. `attempt_history`
keeps one row for every attempt that closed. They are separate from the three core tables, so they
can grow without slowing dispatch. A retention routine removes old rows on its own schedule. Each
history row has a UUID that stays stable when you export history or combine history from several
Workhorse installations.

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

- [020-leases-and-fences.md](020-leases-and-fences.md) — how a worker takes ownership of a task
- [030-delivery-guarantees.md](030-delivery-guarantees.md) — why a task can run twice
- [330-retention.md](330-retention.md) — how the history tables get cleaned up

---

Exact columns, constraints, and indexes: [`architecture/data-model.md`](../architecture/data-model.md#data-model).
