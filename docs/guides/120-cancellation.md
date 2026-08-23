# Cancelling a job is a request, not a kill

You cannot forcibly stop running JavaScript. There's no `Thread.kill` — if a handler is in
the middle of a loop, nothing outside it can make it stop. Everything about how cancellation
works in Workhorse follows from that one fact.

## If the job hasn't started

This is the easy case. A job sitting in `ready` or `scheduled` isn't running anywhere, so
`cancel_v1` just finishes it on the spot: the runtime row is deleted and a `canceled`
outcome is written. Nothing ever executed, so there's no attempt history to record.

A job that's [waiting on a timer](130-durable-waits.md) also settles on the spot — no worker
holds it. One difference: if the wait began partway through an attempt, that attempt is closed
as canceled, so the record keeps the work that had already started.

## If a handler is running right now

Here `cancel_v1` cannot stop anything. So it does the only thing it can: it writes down that
someone asked.

1. The request is recorded on the runtime row, with who asked and why, and a
   `cancel_requested` event is emitted.
2. The worker's next heartbeat comes back saying "cancellation requested".
3. The worker aborts your handler's `AbortSignal` with a `CancellationRequestedError`.
4. Your handler notices, stops, and returns.
5. The worker confirms, and the canceled outcome is written.

Step 4 is yours. If your handler ignores the signal and keeps going, nothing stops it. The
job stays active until its lease expires, and recovery then finalises the cancellation
instead of retrying it. So the cancellation always lands eventually — but how quickly is up
to your code.

## What this means for handlers

Watch the `AbortSignal`. Pass it to your HTTP calls. Check it between steps of a long loop.
When it fires, stop starting new work and return — don't start a new API call you're about
to abandon.

```ts
const handler = async (payload, ctx) => {
  for (const row of payload.rows) {
    if (ctx.signal.aborted) return; // stop between items
    await fetch(url, { body: row, signal: ctx.signal }); // and mid-request
  }
};
```

Effects you already started are still at-least-once. Cancellation doesn't undo anything; it
just stops more from happening. If you need to roll back, that's compensation logic you
write yourself.

## Who wins a race

Suppose a cancellation and a completion arrive at almost the same moment. Both need the same
row lock, so one gets there first and that one wins:

- Cancel first? The later completion is refused. It can't resurrect the job.
- Complete first? The cancellation reports the job already succeeded.

Either way the answer is consistent, and repeating the request doesn't create duplicate
events or outcomes.

## One thing it is not

`requestedBy` is recorded for the audit trail. Workhorse does **not** check whether that
person was allowed to cancel the job. Permission checks belong in your application, before
you call cancel.

## Next

- [130-durable-waits.md](130-durable-waits.md) — cancelling a job that's asleep
- [140-deadlines-and-timeouts.md](140-deadlines-and-timeouts.md) — the other reason your signal aborts
- [310-workers.md](310-workers.md) — pausing a worker, which is cooperative in the same way

---

Exact transitions and race guarantees:
[`architecture.md`](../architecture.md#cancellation).
