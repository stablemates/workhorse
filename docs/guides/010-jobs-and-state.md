# What a job is, and the three tables it lives in

A job in Workhorse is not one row. It's spread across three tables, and understanding why
makes most of the rest of the system obvious.

## The three tables

**`job`** holds the things that never change: the id, which queue it's on, its type, the
payload, how many attempts it's allowed. Written once, when you enqueue. Never updated.

**`job_runtime`** holds the things that change while the job is alive: what state it's in
(`scheduled`, `ready`, or `active`), which attempt it's on, and — if something is running
it — which worker owns it. One row, updated many times.

**`job_outcome`** holds the final answer: succeeded, failed, or canceled, with the result or
the error. Written once, at the end. Never updated after that.

## The rule that ties them together

After any committed change, a job has **exactly one** of `job_runtime` and `job_outcome`.
Never both. Never neither.

So "finishing a job" isn't an update — it's a delete and an insert in the same transaction.
The runtime row is removed and the outcome row appears, atomically. There's no instant where
a job looks both alive and finished, and no instant where it looks like neither.

This is why you'll see the reference talk about "lifecycle exclusivity". That's the rule.

## Why bother

Because `job_runtime` is the table the dispatcher searches. It asks "what's ready to run in
this queue?" many times a second.

When a job finishes, its row leaves that table completely. So the table only ever holds work
that is genuinely live — scheduled, ready, or running. The cost of finding the next job
depends on how much work is outstanding, not on how much work the system has ever done.

A queue that has processed ten million jobs dispatches exactly as fast as one that has
processed ten. That's the whole point of the split, and it's the property most simple queue
designs lose after a few months in production, because they keep finished jobs in the same
table they search.

## Where the history goes

Finished jobs don't vanish. Two append-only tables, `job_event` and `attempt_history`,
record what happened — every state change, every attempt that closed. They're separate from
the three tables above precisely so they can grow without slowing anything down, and they're
cleaned up on their own schedule.

## Next

- [020-leases-and-fences.md](020-leases-and-fences.md) — how a worker takes ownership of a job
- [030-delivery-guarantees.md](030-delivery-guarantees.md) — why a job can run twice
- [330-retention.md](330-retention.md) — how the history tables get cleaned up

---

Exact columns, constraints, and indexes: [`architecture.md`](../architecture.md#data-model).
