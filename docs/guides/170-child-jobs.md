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

## Keep work before the child replay-safe

Code before `runChild` runs again after the parent resumes. Use ordinary idempotency or
`HandlerContext.checkpoint` when repeating that work would cause an unwanted external effect.

Changing the child payload, type, or options under the same name raises `ChildConflictError`.
Exceeding the bounded child set raises `ChildLimitExceededError`. Fan-out and multi-result joining
are separate capabilities.

## Failure, cancellation, and lookup

If the child fails, PostgreSQL fails the parent through its dependency policy. If the child is
canceled, PostgreSQL cancels the parent.

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
