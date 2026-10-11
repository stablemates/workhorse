# Can my task run more than once?

<!-- scenario-names: renderInvoice, sendEmail, charge, send-welcome-email -->

Workhorse runs each task **at least one time**. It does not promise to run a task exactly one time.
Thus, your handler can run two times for one task. This guide tells why, and how to make a second
run safe.

## Expect a second run after a crash

**Example.** A `send-welcome-email` task asks a mail provider to send one email. The worker uses the
default lease of 30 s.

1. At 0 s, worker A claims the task. The handler asks the provider to send the email.
2. At 1 s, the provider sends the email.
3. At 2 s, the process of worker A stops before it records that the task succeeded.
4. At about 30 s, the lease expires. A worker finds the expired lease and makes the task ready
   again.
5. Soon after, worker B claims the task. The handler asks the provider again, and the provider sends
   a second email.

No queue can prevent this problem. The mail provider and your database are two different systems.
They cannot commit as one transaction. A queue that promises exactly-once delivery also needs a
handler that is safe to run again. Workhorse states this requirement directly.

The problem has a second form. The process can also stop after the completion commits, but before
the worker gets the reply. The task is then `succeeded`, but the worker does not know it.

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

More detail: [Task lifecycle: Delivery semantics](../architecture/lifecycle.md#delivery-semantics) and [Task lifecycle: Worker options](../architecture/lifecycle.md#worker-options).

</details>

## Decide if a second run is a problem

If a second run of the work causes no damage, do nothing. For example, it is safe to set a flag
again, write a cache again, or calculate a total again. Most tasks are of this type.

If a second run is expensive or wrong, use one of the two procedures that follow.

## Give the provider an idempotency key

Many payment and email services accept an idempotency key. If they get the same key two times, they
do the work one time. This is the strongest protection, because the system that does the work keeps
the guarantee.

In the example, the handler sends the task ID as the idempotency key. In attempt 2, the provider
finds a key that it accepted before. It returns the first result and does not send a second email.

```ts
worker.handle("send-welcome-email", async (payload: { email: string }, ctx) => {
  await mail.send({ to: payload.email, idempotencyKey: `welcome:${ctx.task.id}` });
});
```

Make the key from a value that does not change between attempts, such as the task ID or your order
number. Do not use a timestamp or a random value. A retry then sends a new key, and the provider
cannot find the duplicate.

## Skip completed code with a checkpoint

A **checkpoint** is a named part of handler code. Workhorse stores its result for the task. A later
run of the task gets the stored result and does not run that code again.

**Example.** An invoice handler charges a card, renders an invoice, and sends it by email. It puts
the first two calls in checkpoints. The invoice renderer fails one time.

1. In attempt 1, the `charge` checkpoint finds no stored value. It charges the card, and Workhorse
   stores the result.
2. Still in attempt 1, `renderInvoice` throws an error. Workhorse stores nothing under `invoice`,
   and schedules a [retry](110-retries.md).
3. In attempt 2, the handler starts again from the top. The `charge` checkpoint returns the stored
   value. The card is not charged again.
4. Still in attempt 2, `renderInvoice` succeeds. Workhorse stores its result, and the handler calls
   `sendEmail`.

```ts
worker.handle("invoice.send", async (payload: { amount: number; email: string }, ctx) => {
  const charge = await ctx.checkpoint("charge", () => payments.charge(payload.amount));
  const pdf = await ctx.checkpoint("invoice", () => renderInvoice(charge.id));
  await sendEmail(payload.email, pdf);
});
```

The code in a checkpoint runs until Workhorse stores its result. After that, each later attempt gets
the stored result. The `sendEmail` call has no checkpoint. It can run again if a later step fails,
so it needs its own protection, such as a provider idempotency key.

The Python worker has the same checkpoint as `context.checkpoint`. In the synchronous worker, the
operation is a usual callable. On a later attempt, the checkpoint returns the stored JSON value and
does not call the operation.

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

More detail: [Data model: Key and write rules](../architecture/data-model.md#key-and-write-rules) and [Data model: Size and lifetime](../architecture/data-model.md#size-and-lifetime).

</details>

## Protect an external call that a checkpoint cannot protect

A checkpoint stores its value in a database transaction after your code runs. The process can stop
between these two events.

**Example.** The invoice handler runs again, but the process stops at a different time.

1. In attempt 1, the `charge` checkpoint charges the card.
2. The process stops before Workhorse stores the result of `charge`.
3. In attempt 2, the `charge` checkpoint finds no stored value. It charges the card a second time.

Thus, a checkpoint makes the risk smaller, but it does not remove it. If a second run of an
operation causes damage, use a checkpoint and a provider idempotency key together. The provider then
charges the card only one time, for all attempts.

<details>
<summary>Reference: checkpoint window</summary>

- `save_checkpoint_v1` runs after the operation returns.
- A process can disappear after an external system commits but before the checkpoint transaction
  commits. The next attempt then runs the operation again.
- A checkpoint does not make external effects exactly once.

More detail: [Data model: Handler behavior](../architecture/data-model.md#handler-behavior).

</details>

## What this means for you

Expect that each handler runs two times on some day. Write it so that a second run causes no damage.

## Next

- [020-leases-and-fences.md](020-leases-and-fences.md) — why the task of a stopped worker runs again
- [210-enqueue-idempotency.md](210-enqueue-idempotency.md) — how to prevent duplicate tasks
- [130-durable-waits.md](130-durable-waits.md) — another reason that a handler runs again

---

Exact checkpoint limits and semantics:
[`architecture/data-model.md`](../architecture/data-model.md#task_checkpoint).
