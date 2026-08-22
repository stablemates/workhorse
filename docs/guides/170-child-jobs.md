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

Go handlers use `CreateChild` for one child and `CreateChildren` for a stable set. The set method
returns named `ChildResult` values in request order, so callers can preserve order without relying
on map iteration.

```go
results, err := handler.CreateChildren([]workhorse.ChildJobRequest{
	{Name: "fraud", Type: "orders.check-fraud", Payload: order},
	{Name: "inventory", Type: "orders.reserve", Payload: order},
})
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

Canceling an active child first requests cooperative cancellation. The parent remains blocked until
the child acknowledges it, then PostgreSQL cancels the parent once. Canceling a child that already
finished returns its terminal state and leaves the parent-child record unchanged.

Retry keeps the same parent identity, so it reuses the same child names, results, and join evidence.
Redrive creates a fresh parent identity instead. The dashboard shows the redrive link beside the
original child tree, and the fresh parent starts without copied child relationships.

Retention keeps the parent-child record while either side still needs it. A live child protects its
terminal parent, and cleanup removes the old tree only after every linked outcome has crossed its
configured evidence window.

`Queue.getJob` and `Queue.listJobs` expose `parentJobId` and `childJobIds`. Use
`Queue.getChildLineage(jobId)` for retained edges in either direction. The dashboard task detail
shows the same parent, child, name, type, and join state. Related ids open that task in the drawer.
For a parent, the detail also summarizes how many retained child results it has joined.

## Next

- [030-delivery-guarantees.md](030-delivery-guarantees.md) — make replayed parent work safe
- [120-cancellation.md](120-cancellation.md) — stop a waiting parent or active child
- [340-redrive.md](340-redrive.md) — why a fresh execution starts a new child tree

---

Exact child schema and lifecycle semantics:
[`architecture.md`](../architecture.md#job_child).
