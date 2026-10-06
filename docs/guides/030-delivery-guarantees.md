# Can my task run more than once?

<!-- scenario-names: renderInvoice, sendEmail, charge, send-welcome-email -->

Workhorse guarantees **at-least-once** execution. Read that carefully: at least once, not exactly
once. This guide explains why a handler can run twice, and what to do about it.

## One email, sent twice

A `send-welcome-email` task asks a mail provider to send one email. The worker uses the default
lease of 30 seconds. This is what happens on a bad day.

1. **At 0 s — attempt 1.** Worker A claims the task and calls the handler. The handler asks the
   provider to send the email.
2. **At 1 s — the email goes out.** The provider accepts the request and sends the email.
3. **At 2 s — the crash.** Worker A's process dies before it records that the task succeeded.
   Nothing in the database knows the email was sent.
4. **At about 30 s — recovery.** The lease expires. Recovery, a regular background pass that
   returns tasks with expired leases, puts the task back for another attempt.
5. **Shortly after — attempt 2.** Worker B claims the task and calls the handler. The email goes out
   a second time.

No queue can close the gap between steps 2 and 3. The mail provider and your database are two
separate systems, and nothing makes them commit as one. A queue that promises exactly-once delivery
still needs an idempotent handler to keep that promise. Workhorse asks for that directly.

The gap has a second side. The process can also die after completion commits, but before the
worker sees the reply. The task then counts as succeeded, and the worker never learns it.

<details>
<summary>Reference: delivery semantics</summary>

Workhorse provides durable at-least-once execution. A process can die at either point:

1. after an external effect, but before completion commits;
2. after completion commits, but before the caller sees the response.

| Setting (TypeScript)    | Default   | Effect                                                                |
| ----------------------- | --------- | --------------------------------------------------------------------- |
| `leaseMs`               | 30,000 ms | How long a claim lasts without a heartbeat.                           |
| `maintenanceIntervalMs` | 1,000 ms  | How often each worker calls `tick_v1`, which recovers expired leases. |

- [Enqueue idempotency](210-enqueue-idempotency.md) makes repeated enqueue calls converge on one
  task. It does not make handler execution or external effects exactly once.
- Schedule occurrence deduplication prevents a duplicate enqueue for one occurrence. A scheduled
  task can still run more than once after a worker crash.
- For a non-idempotent effect, use provider idempotency keys or a transactional outbox or inbox.

More detail: [Task lifecycle: Delivery semantics](../architecture/lifecycle.md#delivery-semantics).

</details>

## What to do about it

**If repeating the work is harmless, do nothing.** Setting a flag, overwriting a cache, and
recalculating a total are all safe to run twice. Most tasks are like this.

**If repeating it is expensive or wrong,** you have two tools.

### Provider idempotency keys

Suppose the welcome-email handler sends the task id as an idempotency key. In attempt 2, the
provider sees a key it already accepted. It returns the first result and sends nothing.

Most payment and messaging APIs accept an idempotency key. If you send the same key twice, the
provider does the work once. Derive the key from something stable, such as the task id or your own
order id. Never derive it from a timestamp or a random value, because a retry would then send a new
key.

This is the strongest option, because the guarantee lives in the system that performs the effect.

### Checkpoints

A **checkpoint** saves the result of one handler step under a name. On a later attempt, the step
returns the saved result instead of running again.

```ts
const handler = async (payload, ctx) => {
  const charge = await ctx.checkpoint("charge", () => payments.charge(payload.amount));
  const pdf = await ctx.checkpoint("invoice", () => renderInvoice(charge.id));
  await sendEmail(payload.email, pdf);
};
```

This is what happens when invoice rendering fails once:

1. **Attempt 1.** `ctx.checkpoint("charge", …)` finds no saved value. It charges the card, and
   Workhorse saves the result under the name `charge`.
2. **Still attempt 1.** `ctx.checkpoint("invoice", …)` calls `renderInvoice`, which throws. Nothing
   is saved under `invoice`. The attempt fails, and Workhorse schedules a [retry](110-retries.md).
3. **Attempt 2.** The handler runs again from the top. `ctx.checkpoint("charge", …)` finds the saved
   value and returns it. The card is not charged again.
4. **Still attempt 2.** `renderInvoice` runs and succeeds, and its result is saved under `invoice`.
   The handler sends the email.

The `sendEmail` call has no checkpoint. It can repeat if a later step fails, so it needs its own
protection, such as a provider idempotency key.

The Python worker exposes the same boundary as `context.checkpoint`. In the synchronous worker the
operation is a regular callable. On replay, it returns the stored JSON value without calling the
operation again.

<details>
<summary>Reference: checkpoint API and rules</summary>

| SDK        | Call                                                             |
| ---------- | ---------------------------------------------------------------- |
| TypeScript | `HandlerContext.checkpoint(name, operation)`                     |
| Python     | `HandlerContext.checkpoint` and `AsyncHandlerContext.checkpoint` |
| Go         | `HandlerContext.Checkpoint`                                      |
| Rust       | `HandlerContext::checkpoint`                                     |

| Limit            | Value                                                        |
| ---------------- | ------------------------------------------------------------ |
| Checkpoint name  | 1 to 200 characters                                          |
| Checkpoint value | 1,048,576 bytes of PostgreSQL's canonical JSONB text (1 MiB) |

**`save_checkpoint_v1`**

- The primary key `(task_id, checkpoint_name)` makes each name immutable for the task.
- The function locks the exact active, unexpired worker and fence before it inserts. It returns
  `stale` if the lease expired, a cancellation was requested, or a deadline or execution timeout
  passed.
- An equal repeated save returns `existing`. A different value returns `conflict`. The worker
  then fails the task without a retry, whatever attempts remain.
- A new save appends a `checkpoint_saved` event.
- TypeScript `HandlerContext.checkpoint` reads an existing value before it runs user code.
  Overlapping calls for one name in one handler share the first call's result or error.
- A checkpoint has no separate retirement path. It is deleted only with its task.

More detail: [Data model: Key and write rules](../architecture/data-model.md#key-and-write-rules).

</details>

## The honest limit of checkpoints

In the story, the card charge succeeded and its checkpoint was saved. Now change one step.
Worker A's process dies after the provider charges the card, but before the `charge` checkpoint
commits. In attempt 2, `ctx.checkpoint("charge", …)` finds no saved value. It charges the card
again.

A checkpoint saves its value in a database transaction _after_ your code has run. A process can
die in between. So checkpoints shrink the window, but they do not close it. For anything dangerous
to repeat, combine a checkpoint with a provider idempotency key. The provider then charges the card
once, whichever attempt asks.

<details>
<summary>Reference: checkpoint window</summary>

- `save_checkpoint_v1` runs after the operation returns.
- A process can disappear after an external system commits but before the checkpoint transaction
  commits. The next attempt then runs the operation again.
- A checkpoint does not make external effects exactly once.

More detail: [Data model: Handler behavior](../architecture/data-model.md#handler-behavior).

</details>

## Rule of thumb

Assume every handler will run twice at some point, on some bad day. Design it so that nothing bad
happens when it does. That is the whole discipline.

## Next

- [020-leases-and-fences.md](020-leases-and-fences.md) — why a dead worker's task comes back
- [210-enqueue-idempotency.md](210-enqueue-idempotency.md) — stopping duplicate tasks being created
- [130-durable-waits.md](130-durable-waits.md) — the other reason a handler runs twice

---

Exact checkpoint limits and semantics:
[`architecture/data-model.md`](../architecture/data-model.md#task_checkpoint).
