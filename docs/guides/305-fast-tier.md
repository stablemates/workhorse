# When should a queue use the fast tier?

Some queues run short, simple handlers at high volume: send an email, resize an image, call a
webhook. The fast tier lets such a queue skip the bookkeeping that only durable execution needs.
You choose it per queue, and you give up a defined set of features in return.

## Every task pays for durable execution

A task on an ordinary queue can checkpoint, sleep, wait for a signal, or spawn children. To make
that possible, Workhorse records every step. A claim, a completion, and a retry each update the
task's runtime row, append an event, and write an attempt row. That record is what lets a task
suspend for days and resume on another worker.

Most handlers never suspend. They start, run for a moment, and finish. On those queues the event
and attempt writes buy nothing, yet every task still pays for them. At high volume that cost
dominates the database's work.

A queue's tier decides whether its tasks pay that cost. A **full-tier** queue keeps the complete record
and supports every feature. A **fast-tier** queue keeps only what dispatch and outcomes need.

## What a fast-tier task keeps

A fast-tier task lives in a single row of `fast_task_runtime` while it is live. When it closes,
Workhorse deletes that row and writes a single row to `fast_task_outcome`. It writes no
`task_event` rows and no `attempt_history` rows unless the queue asks for them.

The core guarantees do not change. A claim still takes a lease and a fence, so a stale worker still
cannot overwrite a newer attempt ([leases and fences](020-leases-and-fences.md)).

Failed attempts are not lost. The runtime row carries a short list of recent errors, and the
outcome keeps it. When the list is full, Workhorse drops the oldest entry and counts the drop, so
a reader knows the list is incomplete. When a lease, timeout, or deadline closes a task instead of
the handler, the outcome's `closed_as` names that boundary.

## Which features each tier has

The fast tier drops features that need durable execution or per-task coordination state. The
table lists each feature, and says why the fast tier lacks it where it does.

| Feature                                                           | Full   | Fast              | Why the fast tier does not have it                                                                                                         |
| ----------------------------------------------------------------- | ------ | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Leases, fences, and heartbeats                                    | Yes    | Yes               |                                                                                                                                            |
| Priority and delayed runs                                         | Yes    | Yes               |                                                                                                                                            |
| Retry policies, `maxAttempts`, deadlines, and execution timeouts  | Yes    | Yes               |                                                                                                                                            |
| Idempotency keys                                                  | Yes    | Yes               |                                                                                                                                            |
| Cancellation, pause, purge, run-now, and redrive                  | Yes    | Yes               |                                                                                                                                            |
| Combined completion and next claim                                | No     | TypeScript worker |                                                                                                                                            |
| `claimed` events and attempt history                              | Always | Opt-in per queue  | Each write is part of the cost the tier removes.                                                                                           |
| Checkpoints                                                       | Yes    | No                | A checkpoint is durable execution state, which a fast-tier task never keeps.                                                               |
| Progress                                                          | Yes    | No                | A progress write checks the attempt against a `task_runtime` row. A fast-tier task has none.                                               |
| Durable sleeps, signal waits, and human waits                     | Yes    | No                | A wait suspends the task. A fast-tier task is only ready or active, so it cannot suspend.                                                  |
| Task dependencies, in either direction                            | Yes    | No                | A fast-tier task cannot wait blocked on a prerequisite. A finished fast-tier task never releases its dependents.                           |
| Child tasks, as parent or child                                   | Yes    | No                | A parent waits for its children, and a fast-tier task cannot wait. A fast-tier child never releases its parent.                            |
| Concurrency keys, budgets, and concurrency or rate-limit policies | Yes    | No                | The full claim admits one task at a time against each policy. The fast claim takes a whole batch in one statement, with no admission step. |
| Debounce                                                          | Yes    | No                | While its window is open, debounce rewrites the pending task's `task_runtime` row. No fast-tier path rewrites a pending row.               |
| Throttle                                                          | Yes    | No                | No reason is settled yet. Throttle only decides whether enqueue accepts a request.                                                         |

The full tier has no combined completion and claim yet. Only the fast tier's version has been
measured.

If a producer asks a fast-tier queue for a feature it lacks, PostgreSQL rejects the request with
`P1007`. Every SDK surfaces it as `FastTierUnsupportedError`, naming the queue and the feature.
Adding a concurrency or rate-limit policy to a fast-tier queue fails the same way.

A handler on a fast-tier queue gets the same error from its handler context. The context rejects
the call before it reaches PostgreSQL. That rejection is an ordinary handler failure, so the task's
retry policy applies.

The rule of thumb is simple. If a handler only computes and returns, the fast tier fits. If it
ever needs to pause and come back, keep the queue full-tier.

## Workers need no configuration

The tier belongs to the queue, never to a worker or a task. A worker discovers it on its own. It
tries a fast claim, and a `P1007` answer tells it the queue is full-tier. The worker then claims the
ordinary way and checks again later.

A worker that believes the wrong tier is still safe. PostgreSQL routes every claim by the queue's
current tier, so a stale belief costs a round trip, not correctness.

On a fast-tier queue, the TypeScript worker also combines a completion with the next claim. One
statement closes the finished tasks and hands their slots new work, which saves a round trip per
task.

Combining has a cost. Handlers that finish together wait together for that one statement, and
their slots idle during the round trip. The TypeScript worker therefore splits a busy worker's
slots into cohorts. Each cohort combines only its own completions, so one cohort's handlers run
while another cohort waits on PostgreSQL. A worker with more slots gets more cohorts, up to a cap.
Each cohort wants its own pooled connection, so on a small pool the worker picks fewer. The
`cohorts` option overrides that count when the database is far away or short of CPU.

## History is opt-in

Without history, the dashboard still shows every fast-tier task. It derives the timeline and the
attempt list from the runtime and outcome rows. It cannot show detail the tier never wrote. An
attempt older than the error list keeps is gone, and only the final claim has an event.

Two switches restore that detail per queue. `Admin.setQueueHistory` sets them:

- `recordAttempts` writes an `attempt_history` row for each closed attempt, in place of the error
  list entry.
- `recordClaims` writes a `claimed` event for each claim.

Each switch brings back part of the cost the tier removed. Turn one on when you need the evidence,
not by default.

## Switching tier needs an empty queue

`Admin.setQueueTier` moves a queue between tiers. Every queue starts full-tier, so nothing changes
until an operator moves one.

Workhorse refuses the switch while the queue holds a live task in either tier. A task never
changes tables mid-flight, so the refusal is what keeps each task's record in one place. Stop
the producers, let the workers drain the queue, then switch. Moving to the fast tier also fails while a concurrency or
rate-limit policy still names the queue.

Finished tasks stay where they closed. A queue that switched tier keeps its old outcomes readable,
and retention and cold export handle both tables.

## What this means for you

- Choose the fast tier for high-volume queues whose handlers never suspend.
- Expect `FastTierUnsupportedError` wherever code asks a fast-tier queue for a durable feature.
- Turn history on only for the evidence you need.
- Drain a queue before you switch its tier.

## Next

- [010-tasks-and-state.md](010-tasks-and-state.md) — the full-tier task record the fast tier trims
- [130-durable-waits.md](130-durable-waits.md) — the durable execution a fast-tier queue gives up
- [310-workers.md](310-workers.md) — the process that claims from both tiers

---

Exact tables, rejections, and recovery rules of the fast tier:
[`architecture.md`](../architecture.md#fast-tier).
