# Waiting without holding a worker hostage

Some jobs need to pause before sending a reminder, polling an external system again, or
continuing at a known time.

The naive way is to sit in the handler. That's terrible: your worker has a bounded set of
slots, and a sleeping handler occupies one while doing nothing.

## What a durable wait does instead

A named wait releases the job entirely. The lease is dropped, the job goes back to
`scheduled` with a wake time, and the worker slot is immediately free for other work.

Later, the job becomes ready again, some worker claims it, and it carries on. Nothing sits
idle in between, however long the wait lasts.

The synchronous Python worker uses `context.sleep` for a duration and `context.sleep_until` for a
wake time. Both release the slot and replay the handler without consuming the attempt.

## The catch: your handler restarts from the top

This is the part that surprises people, so get it clear.

When the job resumes, your handler function is called **again, from the beginning**. It is
not resumed mid-function — there is no saved call stack, because the process that was
running it is long gone and may have been replaced by a newer deployment.

So a handler with a wait in the middle runs its opening section again after the wait. Which
means:

> Everything before a wait must be safe to run again.

Make it idempotent, or wrap it in a [checkpoint](030-delivery-guarantees.md) so the second
pass reuses the saved result instead of redoing the work.

```ts
const handler = async (payload, ctx) => {
  // runs twice — once now, once after the wait — so it must be checkpointed
  const order = await ctx.checkpoint("place", () => placeOrder(payload));

  await ctx.sleep("settle", settlementDelayMs); // slot is released here

  await confirm(order.id);
};
```

Waits are named. The name is how Workhorse knows, on the second pass, that `settle` has
already elapsed and execution should continue past it.

When execution reaches a wait that has already elapsed, it's recorded as already done and
the handler continues straight past it. That's how the code after the wait finally runs.

Don't catch the control signal thrown by `ctx.sleep` or `ctx.sleepUntil`. If a handler catches
it and returns, the worker still honors the recorded wait. It also warns that the signal was
swallowed. Any side effects after the catch have already happened and can't be undone.

## Waiting is not failing

A wait does **not** consume an attempt. The attempt counter stays where it was.

This is deliberate: waiting is a normal part of the job doing its work, not a sign anything
went wrong. Repeated sleeps remain part of the same logical attempt. A resumed job gets a
new fence token because it has a new claim.

## When it wakes up

"Wake at the requested time" means "become eligible then". A worker still has to be free to
pick it up, and the promotion pass runs on an interval.

Don't build anything that needs precise timing on top of this. It's a durable sleep, not a
real-time scheduler.

## Next

- [030-delivery-guarantees.md](030-delivery-guarantees.md) — checkpoints, which waits depend on
- [140-deadlines-and-timeouts.md](140-deadlines-and-timeouts.md) — why sleeping doesn't spend the budget
- [110-retries.md](110-retries.md) — how a wait differs from a retry

---

Exact wait semantics, limits, and replay rules:
[`architecture.md`](../architecture.md#durable-timer-suspension).
