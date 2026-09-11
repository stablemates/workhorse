# What a task is, and the three tables it lives in

A task in Workhorse is not one row. It's spread across three tables, and understanding why
makes most of the rest of the system obvious.

## The three tables

**`task`** holds the stable id and the definition Workhorse accepted: queue, type, payload,
attempt budget, and policy. A pending [keyed debounce](215-debounce.md) may replace that
definition while keeping the id. Once the task starts or becomes non-replaceable, the accepted
definition freezes.

**`task_runtime`** holds the things that change while the task is alive: what state it's in
(`scheduled`, `blocked`, `ready`, or `active`), which attempt it's on, and — if something is
running it — which worker owns it. One row, updated many times. A task is `blocked` while it
waits on [prerequisite tasks](160-task-dependencies.md).

**`task_outcome`** holds the final answer: succeeded, failed, or canceled, with the result or
the error. Written once, at the end. Never updated after that.

## The rule that ties them together

After any committed change, a task has **exactly one** of `task_runtime` and `task_outcome`.
Never both. Never neither.

So "finishing a task" isn't an update — it's a delete and an insert in the same transaction.
The runtime row is removed and the outcome row appears, atomically. There's no instant where
a task looks both alive and finished, and no instant where it looks like neither.

This is why you'll see the reference talk about "lifecycle exclusivity". That's the rule.

## Why bother

Because `task_runtime` is the table the dispatcher searches. It asks "what's ready to run in
this queue?" many times a second.

When a task finishes, its row leaves that table completely. So the table only ever holds work
that is genuinely live — scheduled, blocked, ready, or running. The cost of finding the next task
depends on how much work is outstanding, not on how much work the system has ever done.

The split keeps completed history out of the ready scan. Its objective is for dispatch cost to scale
with live work instead of all work the queue has processed. Other factors still affect claim
latency, including the current backlog, policy checks, database load, and index health.

## Where the history goes

Finished tasks don't vanish. Two append-only tables, `task_event` and `attempt_history`,
record what happened — every state change, every attempt that closed. They're separate from
the three tables above precisely so they can grow without slowing anything down, and they're
cleaned up on their own schedule. Each history row has a UUID that stays stable when you archive
or combine history from different Workhorse installations.

## Next

- [020-leases-and-fences.md](020-leases-and-fences.md) — how a worker takes ownership of a task
- [030-delivery-guarantees.md](030-delivery-guarantees.md) — why a task can run twice
- [330-retention.md](330-retention.md) — how the history tables get cleaned up

---

Exact columns, constraints, and indexes: [`architecture.md`](../architecture.md#data-model).
