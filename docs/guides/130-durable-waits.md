# Waiting without holding a worker hostage

Some jobs need to pause. Wait an hour before sending a reminder. Poll an external system
that takes a while. Sleep until tomorrow morning.

The naive way is to sit in the handler. That's terrible: your worker has a fixed number of
slots, and a sleeping handler occupies one for the whole hour while doing nothing.

## What a durable wait does instead

A named wait releases the job entirely. The lease is dropped, the job goes back to
`scheduled` with a wake time, and the worker slot is immediately free for other work.

Later, the job becomes ready again, some worker claims it, and it carries on. Nothing was
sitting idle in between. You could wait a month this way and consume no worker capacity at
all.

## The catch: your handler restarts from the top

This is the part that surprises people, so get it clear.

When the job resumes, your handler function is called **again, from the beginning**. It is
not resumed mid-function — there is no saved call stack, because the process that was
running it is long gone, possibly deployed over twice since.

So a handler with a wait in the middle runs its opening section twice: once before the wait,
once after. Which means:

> Everything before a wait must be safe to run again.

Make it idempotent, or wrap it in a [checkpoint](030-delivery-guarantees.md) so the second
pass reuses the saved result instead of redoing the work.

```ts
const handler = async (payload, ctx) => {
  // runs twice — once now, once after the wait — so it must be checkpointed
  const order = await ctx.checkpoint("place", () => placeOrder(payload));

  await ctx.sleep("settle", 60 * 60 * 1000); // slot is released here

  await confirm(order.id);
};
```

Waits are named. The name is how Workhorse knows, on the second pass, that `settle` has
already elapsed and execution should continue past it.

When execution reaches a wait that has already elapsed, it's recorded as already done and
the handler continues straight past it. That's how the code after the wait finally runs.

Don't catch the control signal thrown by `ctx.sleep()` or `ctx.sleepUntil()`. If a handler catches
it and returns, the worker still honors the recorded wait. It also warns that the signal was
swallowed. Any side effects after the catch have already happened and can't be undone.

## Waiting is not failing

A wait does **not** consume an attempt. The attempt counter stays exactly where it was.

This is deliberate: waiting is a normal part of the job doing its work, not a sign anything
went wrong. A job that sleeps five times and then succeeds has used one attempt, not six.
When it resumes it gets a new fence token — a new claim always does — but it's still the
same logical attempt.

## When it wakes up

"Wake at 09:00" means "become eligible to run at 09:00". A worker still has to be free to
pick it up, and the promotion pass runs on an interval. In practice that's seconds, not
milliseconds.

Don't build anything that needs precise timing on top of this. It's a durable sleep, not a
real-time scheduler.

## Next

- [030-delivery-guarantees.md](030-delivery-guarantees.md) — checkpoints, which waits depend on
- [140-deadlines-and-timeouts.md](140-deadlines-and-timeouts.md) — why sleeping doesn't spend the budget
- [110-retries.md](110-retries.md) — how a wait differs from a retry

---

Exact wait semantics, limits, and replay rules:
[`architecture.md`](../architecture.md#durable-timer-suspension).
