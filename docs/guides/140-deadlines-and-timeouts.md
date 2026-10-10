# What is the difference between a deadline and a timeout?

<!-- scenario-names: send-match-reminder -->

Workhorse has two ways to say "this has taken too long", and they mean different things. A
deadline ends the whole task at a fixed moment. A timeout ends one attempt that ran too long.
Mixing them up is the usual source of confusion.

## A deadline covers the whole task

> **Example.** A `send-match-reminder` task must reach fans before kickoff at 20:00. It is enqueued
> at 18:00 with `deadline` set to 20:00 and an exponential retry policy.
>
> 1. **At 18:00 — attempt 1.** The push provider is down, and the handler throws. The retry policy
>    schedules attempt 2.
> 2. **Until 19:40 — more failures.** Attempts 2 and 3 fail the same way. Each wait is longer than
>    the one before, so attempt 4 is scheduled for 20:05.
> 3. **At 20:00 — the deadline passes.** The task is `scheduled`, and no worker holds it. The clock
>    keeps running anyway.
> 4. **Shortly after 20:00 — the end.** A worker's regular maintenance pass finds the passed
>    deadline. Workhorse finishes the task as failed, with evidence that the deadline caused it.
>    Attempt 4 never runs, even though the attempt budget had room for it.

`deadline` is a wall-clock moment after which the task is pointless. It is an actual instant, such
as the cutoff for a delivery run, not an execution budget.

Its clock never stops. It keeps running while the task is queued, retrying, asleep on a timer, and
executing. When the moment passes, Workhorse finishes the task as failed, even if attempts remain.
It starts no new attempt.

Use a deadline for work that expires: a reminder that is useless after the event, a price quote
that goes stale, or a batch that must land before a cutoff.

<details>
<summary>Reference: deadline</summary>

| SDK        | Option                          | Rule                        |
| ---------- | ------------------------------- | --------------------------- |
| TypeScript | `EnqueueOptions.deadline: Date` | A finite absolute timestamp |
| Python     | `deadline: datetime`            | A finite absolute timestamp |

The deadline is optional. Workhorse stores it as `deadline_at`.

| Where the task is                  | What settles a passed deadline                                                                  |
| ---------------------------------- | ----------------------------------------------------------------------------------------------- |
| Enqueued with a past deadline      | `enqueue_batch_v1` settles it in the same call.                                                 |
| `ready`, `scheduled`, or `blocked` | Claim skips it. `recover_expired_v1`, from each worker's `tick_v1`, settles a bounded batch.    |
| `active`                           | The owning worker's local timer calls `expire_owned_v1`. Heartbeats return `deadline_exceeded`. |

`terminalize_deadline_v1` writes:

- a `failed` outcome with a deadline error envelope;
- a `deadline_exceeded` attempt-history row, only when an attempt had started;
- a `deadline_exceeded` event whose `started` field says whether an attempt had started.

If a cancellation was requested first, it writes a `canceled` outcome instead, with event
`source = deadline_reaper`.

More detail: [Task lifecycle: Deadlines and execution timeouts](../architecture/lifecycle.md#deadlines-and-execution-timeouts).

</details>

## A timeout covers one attempt

The same reminder task also sets an execution timeout of two minutes.

1. **At 0 s — attempt 1.** A worker claims the task. The handler calls the push provider, and the
   call hangs.
2. **At 2 min — the timeout.** The attempt has used its whole budget. The worker aborts the
   handler's signal. Workhorse closes attempt 1 as timed out.
3. **Right after — the retry.** Attempt 1 was below the budget, so the normal
   [retry rules](110-retries.md) schedule attempt 2. Attempt 2 starts with a fresh two minutes.

`executionTimeoutMs` is a budget for the _active execution_ of a single attempt. It limits how long
your handler may run, not when the task must be done.

Only real execution spends the budget. Suppose a handler runs for one minute and then sleeps for a
day on a [durable wait](130-durable-waits.md). The wait releases the lease, and the accounting
pauses. After the wake, the same attempt has one minute of budget left, not zero.

When the budget runs out, Workhorse closes the attempt as timed out and applies the normal retry
rules. The task gets another attempt if the budget allows, and fails if not. So a timeout usually
means "try again", while a deadline always means "stop".

<details>
<summary>Reference: execution timeout</summary>

| SDK        | Option                              | Rule                                   |
| ---------- | ----------------------------------- | -------------------------------------- |
| TypeScript | `EnqueueOptions.executionTimeoutMs` | An integer from 1 to 31,536,000,000 ms |
| Python     | `execution_timeout_ms`              | An integer from 1 to 31,536,000,000 ms |

The timeout is optional.

**Accounting**

- Each claim sets `attempt_timeout_at` to the claim time plus `execution_timeout_ms` minus
  `execution_used_ms`.
- A timer wait, a signal wait, a child suspension, or an owned release adds the active time to
  `execution_used_ms`. It clears `attempt_timeout_at`.
- A retry resets `execution_used_ms` to zero.

**`timeout_owned_v1`**

- It writes a `timeout` attempt-history row and an `execution_timed_out` event. The event names
  the next state.
- With attempts left, `retry_delay_v1` selects the delay. With no policy, the delay is 0.
- With no attempts left, it writes a `failed` outcome.
- A pending cancellation request wins. The function then changes nothing.

When the deadline and the timeout have both passed, the earlier one settles the attempt. On a tie,
the deadline wins.

More detail: [Task lifecycle: Deadlines and execution timeouts](../architecture/lifecycle.md#deadlines-and-execution-timeouts) and [Data model: Retry delay selection](../architecture/data-model.md#retry-delay-selection).

</details>

## In practice

```ts
await queue.enqueue(
  "send-match-reminder",
  { matchId },
  {
    deadline: kickoffTime, // pointless after kickoff, whatever happens
    executionTimeoutMs: attemptTimeoutMs,
    maxAttempts: attemptBudget,
  },
);
```

Read that as: bound each attempt by the configured execution budget, and abandon the whole task at
kickoff, however many attempts remain.

## How long should a handler run?

Go back to the reminder task from the timeout story. Its attempt is stuck in a hung call.

1. **At 30 s** a rolling deploy stops the worker process. The worker claims no new work and waits
   for its running handlers to finish.
2. **Until the drain period ends** the reminder handler is still in its hung call.
3. **When the drain period ends** the process exits with the handler still running.
4. **Later** the attempt's lease expires, and recovery returns the task.

That works, but it is noisy. A rolling deploy waits only a bounded time for running handlers. A
handler still running when that period ends is cut off, and its task comes back through recovery.

So aim to finish well inside the deployment's drain period. For long work, do not ask for a bigger
timeout. Split it into idempotent stages, with named [checkpoints](030-delivery-guarantees.md)
between them and durable waits where the handler only waits. Each shorter stage can then restart on
its own.

<details>
<summary>Reference: handler duration</summary>

- Ordinary handlers should complete within 110 seconds. That leaves rolling deployments practical
  drain headroom.
- The recommendation is not a database limit, because deployment grace periods vary.
- On the first `SIGINT` or `SIGTERM`, a worker process stops claiming. Active handlers and their
  heartbeats continue.
- `shutdownTimeoutMs` bounds that drain. The default is 25,000 ms. A missed deadline exits the
  process with code 1.
- Hard termination leaves active leases for ordinary expiry recovery.
- Set execution timeouts deliberately rather than relying on an unbounded handler.

More detail: [Task lifecycle: Deadlines and execution timeouts](../architecture/lifecycle.md#deadlines-and-execution-timeouts) and [Operations and CLI: Shutdown deadline and failure](../architecture/operations.md#shutdown-deadline-and-failure).

</details>

## What you get on timeout

In the timeout story, worker A's handler was stuck in a hung call at 2 min. This is what the worker
did:

1. At `attempt_timeout_at`, the worker's local timer fired. The worker called `expire_owned_v1` with
   its worker id and fence token.
2. PostgreSQL closed the attempt and applied its retry decision in that call. Ordinary timeout
   settlement does not wait for the lease to expire. If PostgreSQL had answered `not_due`, the
   handler would have kept running and the worker would have asked again.
3. The worker then aborted the handler's `signal`, the same signal that
   [cancellation](120-cancellation.md) uses, but with a different reason.

JavaScript is not forcibly stopped. Suppose the hung call returns at 3 min and the handler tries to
complete. The attempt is already closed, so that late write cannot land.

<details>
<summary>Reference: local timers and abort reasons</summary>

The worker sets one local timer at the earlier of `deadline_at` and `attempt_timeout_at`.

| Boundary          | Abort reason (TypeScript)                | `expire_owned_v1` status |
| ----------------- | ---------------------------------------- | ------------------------ |
| Deadline          | `DeadlineExceededError(taskId)`          | `deadline_exceeded`      |
| Execution timeout | `ExecutionTimeoutError(taskId, attempt)` | `timeout_exceeded`       |

`expire_owned_v1(p_task_id, p_worker_id, p_fence_token)` returns one of `not_due`,
`cancel_requested`, `deadline_exceeded`, `timeout_exceeded`, or `stale`.

- The completed transition fences every late completion, failure, heartbeat, checkpoint, or wait
  write.
- Heartbeats and bounded maintenance remain fallbacks for process loss and races.
- Races between cancellation, completion, deadline, timeout, and lease expiry are row-lock ordered.
  The first transaction to commit wins.

More detail: [Task lifecycle: Local timers](../architecture/lifecycle.md#local-timers).

</details>

## Next

- [130-durable-waits.md](130-durable-waits.md) — why sleeping doesn't spend the budget
- [110-retries.md](110-retries.md) — what happens after a timed-out attempt
- [120-cancellation.md](120-cancellation.md) — the other reason your signal aborts

---

Exact evidence written on each path:
[`architecture/lifecycle.md`](../architecture/lifecycle.md#deadlines-and-execution-timeouts).
