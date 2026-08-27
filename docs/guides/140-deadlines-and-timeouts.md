# Deadlines and timeouts: two different clocks

Workhorse has two ways to say "this has taken too long", and they mean different things.
Mixing them up is the usual source of confusion.

## A deadline covers the whole job

`deadline` is a wall-clock moment after which the job is pointless. It is an actual instant,
such as the cutoff for a delivery run, rather than an execution budget.

The clock never stops. It keeps running while the job is queued, while it's retrying, while
it's asleep on a timer, and while it's executing. When that moment passes, the job is
finished as failed, even if it had attempts left. No new attempt is started.

Use it for work that expires: a reminder that's useless after the event, a price quote that
goes stale, a batch that must land before a cutoff.

## A timeout covers one attempt

`executionTimeoutMs` is a budget for a single attempt's _active execution_. It's about how
long your handler may run, not about when the job must be done by.

Only real execution spends the budget. If your handler goes to sleep on a
[durable wait](130-durable-waits.md), the lease is released and the accounting pauses — a
job that sleeps for a day hasn't used a day of its execution budget.

When the budget runs out, the attempt is closed as timed out and the normal retry rules
apply: another attempt if the budget allows, terminal failure if not. So a timeout usually
means "try again", while a deadline always means "stop".

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

Read that as: bound each attempt by the configured execution budget, and abandon the whole
job at kickoff regardless of how many attempts remain.

## How long should a handler run?

Aim to finish well inside the deployment's drain period. When a rolling deploy restarts a
worker, it waits a bounded time for handlers to drain. Handlers that routinely exceed that
period get killed mid-flight and recovered, which works but is noisy.

For genuinely long work, don't ask for a bigger timeout. Split it: idempotent stages, named
checkpoints between them, and durable waits where you're just waiting. That turns one long
handler into shorter stages, and each is individually restartable.

## What you get on timeout

Your handler's `signal` aborts, the same as for cancellation, but with a different reason.
Same rules apply: JavaScript isn't forcibly stopped, so a handler that ignores the signal
keeps running until the lease expires and recovery cleans up.

## Next

- [130-durable-waits.md](130-durable-waits.md) — why sleeping doesn't spend the budget
- [110-retries.md](110-retries.md) — what happens after a timed-out attempt
- [120-cancellation.md](120-cancellation.md) — the other reason your signal aborts

---

Exact evidence written on each path:
[`architecture.md`](../architecture.md#deadlines-and-execution-timeouts).
