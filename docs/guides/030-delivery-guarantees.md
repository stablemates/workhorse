# Your job can run more than once

Workhorse guarantees **at-least-once** execution. Read that carefully: at least once, not
exactly once. This guide explains why, and what to do about it.

## Why it happens

Your handler sends an email. The email goes out. Then, before the worker can record that the
job succeeded, the process is killed.

Nothing in the database knows the email was sent. The lease expires, recovery puts the job
back, another worker picks it up, and the email goes out a second time.

There is no way to close that gap. The email provider and your database are two separate
systems, and nothing can make two systems commit as one. Any queue that claims exactly-once
delivery is either lying, or quietly requiring your handler to be idempotent — which is the
same thing Workhorse asks of you, just less honestly.

## What to do about it

**If repeating the work is harmless, do nothing.** Setting a flag, overwriting a cache,
recalculating a total — run it twice, no harm done. Most jobs are like this.

**If repeating it is expensive or wrong,** you have two tools.

### Provider idempotency keys

Most payment and messaging APIs accept an idempotency key. Send the same key twice and the
provider does the work once. Derive the key from something stable — the job id, or your own
order id — not from a timestamp or a random value.

This is the strongest option, because the guarantee lives in the system that actually
performs the effect.

### Checkpoints

For multi-step handlers, wrap each step in
`HandlerContext.checkpoint(name, operation)`. The first time through, it runs your code and
saves the result under that name. On a retry, it finds the saved value and returns it
without running the step again.

```ts
const handler = async (payload, ctx) => {
  const charge = await ctx.checkpoint("charge", () => payments.charge(payload.amount));
  const pdf = await ctx.checkpoint("invoice", () => renderInvoice(charge.id));
  await sendEmail(payload.email, pdf);
};
```

If this fails while rendering the invoice, the retry reuses the saved `charge` result
instead of charging the card again.

The synchronous Python worker exposes the same boundary as `context.checkpoint`. Its operation is
a regular callable, and replay returns the stored JSON value without calling it again.

## The honest limit of checkpoints

A checkpoint saves its value in a database transaction _after_ your code has run. If the
process dies in between — the card was charged, the checkpoint wasn't saved — the retry
charges the card again.

Checkpoints shrink the window. They don't close it. For anything genuinely dangerous to
repeat, combine them with a provider idempotency key, and let the provider be the thing
that says no.

## Rule of thumb

Assume every handler will run twice at some point, on some bad day. Design so that when it
does, nothing bad happens. That's the whole discipline.

## Next

- [020-leases-and-fences.md](020-leases-and-fences.md) — why a dead worker's job comes back
- [210-enqueue-idempotency.md](210-enqueue-idempotency.md) — stopping duplicate jobs being created
- [130-durable-waits.md](130-durable-waits.md) — the other reason a handler runs twice

---

Exact checkpoint limits and semantics:
[`architecture.md`](../architecture.md#job_checkpoint).
