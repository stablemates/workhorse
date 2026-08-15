# How do I run and join a child job?

A child job lets one handler delegate durable work and consume its result later. The parent gives
up its lease while waiting, so it does not occupy a worker slot.

## Run the child from a handler

Call `HandlerContext.runChild` with a stable name, job type, payload, and optional enqueue settings:

```ts
worker.handle("orders.checkout", async (order, ctx) => {
  const charge = await ctx.runChild<{ orderId: string }, { receiptId: string }>(
    "charge",
    "payments.charge",
    { orderId: order.id },
    { queue: "payments" },
  );

  return { receiptId: charge.receiptId };
});
```

PostgreSQL creates the child and moves the parent to `blocked` in the same transaction. The parent
leaves the active index, and the child enters its ordinary queue.

The handler stops at `runChild`. When the child succeeds, PostgreSQL releases the parent and a
worker claims it with a new fence. Workhorse restarts the handler from its entry point.

The repeated `runChild` call recognizes the same name and request. It returns the child result
instead of creating another job.

Use `HandlerContext.runChildren` when the delegated work can run in parallel. It creates the named
set in one transaction and returns successful results under the same names:

```ts
const results = await ctx.runChildren<{
  fraud: { accepted: boolean };
  inventory: { reserved: boolean };
}>([
  { name: "fraud", type: "orders.check-fraud", payload: { orderId } },
  { name: "inventory", type: "orders.reserve", payload: { orderId } },
]);
```

An empty set returns immediately. A non-empty set suspends the parent once, and PostgreSQL releases
it only after every child reaches a terminal state. The set joins only when every child succeeds.

## Keep work before the child replay-safe

Code before `runChild` runs again after the parent resumes. Use ordinary idempotency or
`HandlerContext.checkpoint` when repeating that work would cause an unwanted external effect.

Changing a child name, payload, type, option, or set membership on replay raises
`ChildConflictError`. Exceeding the bounded child set raises `ChildLimitExceededError`. If the
joined object exceeds the parent's result contract, `ChildResultLimitExceededError` rejects it.

## Failure, cancellation, and lookup

If any child fails, PostgreSQL fails the parent after the set settles. If any child is canceled,
PostgreSQL cancels the parent unless another child failure takes precedence.

Canceling a blocked parent leaves the child independent. A later child outcome cannot return that
terminal parent to dispatch.

`Queue.getJob` and `Queue.listJobs` expose `parentJobId` and `childJobIds`. Use
`Queue.getChildLineage(jobId)` for retained edges in either direction. The dashboard task detail
shows the same parent, child, name, type, and join state.

## Next

- [030-delivery-guarantees.md](030-delivery-guarantees.md) — make replayed parent work safe
- [120-cancellation.md](120-cancellation.md) — stop a waiting parent or active child
- [160-job-dependencies.md](160-job-dependencies.md) — the release policy behind child completion

---

Exact child schema and lifecycle semantics:
[`architecture.md`](../architecture.md#job_child).
