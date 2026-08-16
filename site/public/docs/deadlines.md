# Deadlines and timeouts

> Bound a job by wall-clock time, or bound one attempt's execution, with two independent clocks.

Workhorse has two ways to say "this has taken too long", and they answer different questions.
A deadline says the _result_ expires at a wall-clock moment — after that, the job is
pointless. An execution timeout says one _attempt_ may only run so long — after that, try
again. Mixing them up is the usual source of confusion, so this page keeps them apart.

## A deadline bounds the whole job

`EnqueueOptions.deadline` records an immutable absolute boundary. The clock never stops: it
runs while the job is queued, retrying, sleeping on a durable wait, and executing. Use it when
the result becomes useless at a known time, even if attempts remain.

```ts
await queue.enqueue("price.quote", { quoteId }, { deadline: quoteExpiresAt });
```

After the deadline passes, PostgreSQL refuses new claims for the job. If a handler is active,
the next heartbeat returns `deadline_exceeded` and the worker aborts `ctx.signal` with
`DeadlineExceededError`. Either way the job ends terminally — a deadline never schedules
another retry, because retrying expired work only delays admitting it failed.

Redriving a dead-lettered job clears the old deadline. Copying an expired business boundary
would make the new job fail on arrival.

## An execution timeout bounds one attempt

`EnqueueOptions.executionTimeoutMs` budgets _active execution_ within each logical attempt.
Use it when one run must stop consuming resources but a later attempt may still succeed — a
stuck HTTP call, a wedged subprocess.

```ts
await queue.enqueue("report.build", { reportId }, { executionTimeoutMs: 30_000, maxAttempts: 5 });
```

Only real execution spends the budget. If the handler suspends on a
[durable wait](/docs/durable-execution), the job holds no worker slot and the accounting
pauses — a job that sleeps for a day has used none of its execution budget. When the budget
runs out mid-execution, the heartbeat returns `timeout_exceeded` and the worker aborts with
`ExecutionTimeoutError`.

If attempts remain, PostgreSQL schedules another one under the normal
[retry rules](/docs/retries). Timeline evidence records the timeout path distinctly from an
ordinary thrown error, so an operator can tell "slow" apart from "broken".

The two compose naturally:

```ts
await queue.enqueue(
  "match.reminder",
  { matchId },
  {
    deadline: kickoffTime, // pointless after kickoff, whatever happens
    executionTimeoutMs: 30_000, // any single attempt is stuck after 30s
    maxAttempts: 5,
  },
);
```

Read that as: retry up to five times, give each attempt thirty seconds, and abandon the whole
thing at kickoff regardless of attempts left.

## Both clocks remain cooperative

Neither clock can interrupt JavaScript. The worker learns about an expired deadline or
exhausted budget from `heartbeat_v2`, then aborts the handler's signal — the same
[cooperative pattern as cancellation](/docs/cancellation), with a different reason class. A
handler that ignores the signal keeps running until its lease expires and recovery cleans up.

Fencing keeps the record consistent. Completion, failure, heartbeat, checkpoint, and wait
writes all carry the current fence, so a late write from a timed-out handler cannot replace a
transition that already committed.

Process shutdown is separate from all of this. A termination signal drains handlers while
maintaining their leases; it does not synthesize a deadline, timeout, or cancellation. If
long handlers make deploys noisy, split them into checkpointed stages rather than raising the
timeout.

## Next

- [Cancellation](/docs/cancellation) — stop work because an operator asked
- [Retries](/docs/retries) — schedule another attempt after a timeout
- [Durable execution](/docs/durable-execution) — split long work so no attempt needs long budgets

---

Exact clock calculations, limits, heartbeat statuses, and terminal behavior:
[architecture reference](https://github.com/stablemates/workhorse/blob/main/docs/architecture.md#deadlines-and-execution-timeouts).
