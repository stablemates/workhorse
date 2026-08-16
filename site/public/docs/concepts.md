# Core concepts

> The mental model behind every job — identity, live state, ownership, delivery, and evidence.

Most queue bugs are really model bugs: you assumed a job runs once, or that a dead worker's writes
stop mattering, or that finished jobs slow down the queue. This page gives you the model that makes
Workhorse's behavior predictable — where a job lives, who may touch it, and what remains afterward.

## A job is three kinds of row

Workhorse splits every job across three relations, one per kind of fact.

`job` stores immutable identity: queue, type, payload, attempt budget, and policy. PostgreSQL
writes this row when it accepts the job and never changes its semantic fields.

`job_runtime` is the live row. It exists only while the job is `scheduled`, `ready`, or `active`,
and it is the only mutable lifecycle relation — workers and SQL functions change it as the job
becomes eligible, gains an owner, or returns for another attempt.

`job_outcome` is the terminal row. When the job becomes `succeeded`, `failed`, or `canceled`,
PostgreSQL deletes the runtime row and inserts the outcome in the same transaction.

A committed job therefore has one runtime row or one outcome row, never both. No reader can observe
a job as live and terminal at the same time, and terminal jobs leave the indexes workers search —
which is why a million finished jobs do not slow the next claim.

## The six states

```
scheduled ──▶ ready ──▶ active ──▶ succeeded
                ▲          │  └───▶ failed
                └──(retry)─┘  └───▶ canceled
```

- `scheduled`: the job has a future `runAt`, a retry delay, or a durable sleep in progress.
- `ready`: the job is eligible and waiting for a worker slot, in queue-local FIFO order.
- `active`: one worker owns the job under a lease and is running its handler.
- `succeeded`, `failed`, `canceled`: terminal. Result, error, or cancellation envelope is stored.

`Queue.getJob` returns a snapshot with `state`, `currentAttempt`, `result`, and `error`, whichever
side of the split the job is on.

```ts
const job = await queue.getJob(jobId);
console.log(job?.state, job?.currentAttempt, job?.result);
```

## Who owns active work

When a `Worker` has a free slot, it calls the `claim_v2` SQL function. PostgreSQL checks any queue
policy, then records the worker ID, a lease expiry, and a fence token on `job_runtime`. The worker
sends heartbeats through `heartbeat_v2` while the handler runs.

If heartbeats stop, recovery closes the old attempt and makes the job eligible again. Every
semantic write carries the worker ID and fence token, so a stale worker cannot complete, fail, or
change a job after a newer worker has claimed it — the full mechanics live in
[Workers](/docs/workers).

## Why a handler can run twice

The handler runs outside the transaction that grants ownership. A process can finish an external
effect — the email sent, the card charged — and die before PostgreSQL records success. Recovery
cannot tell that apart from a crash before the effect, so it must run the handler again.

That is at-least-once delivery, and it shapes how you write handlers:

- If a stage must not repeat within a job, wrap it in `HandlerContext.checkpoint`. A completed
  checkpoint replays its stored result on the next run instead of executing again.
- If an external call must not repeat across systems, give the provider a stable idempotency key.
  Checkpoints narrow the duplicate window; only the provider can close it.

```ts
worker.handle("invoice.send", async (payload: { invoiceId: string }, ctx) => {
  return ctx.checkpoint("send", () =>
    emailProvider.send({ idempotencyKey: `invoice:${payload.invoiceId}` }),
  );
});
```

[Durable execution](/docs/durable-execution) covers checkpoints, durable sleeps, and their rules.

## Where history goes

Execution leaves append-only evidence, kept off the dispatch path so audits never compete with
claims.

`job_event` records every lifecycle change; `attempt_history` records how each logical attempt
closed. `Queue.getJobTimeline` merges both into one cursor stream, so you can answer "what happened
to job X" from SQL-backed records rather than log lines.

`job_query` is a separate bounded projection for operator reads. `Queue.listJobs` and the dashboard
page through it across all states without adding broad indexes to `job_runtime`. Both history
relations are partitioned by day and retired by retention policy, independently of live dispatch.

## Next

- [Workers](/docs/workers) — leases, fence tokens, and how a process claims jobs
- [Retries](/docs/retries) — what happens after an attempt fails
- [Durable execution](/docs/durable-execution) — preserve completed work across another run

---

Exact relations, constraints, states, and indexes:
[architecture reference](https://github.com/stablemates/workhorse/blob/main/docs/architecture.md#data-model).
