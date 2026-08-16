# How do I process several jobs together?

Use `Worker.handleBatch` when one application call can process several jobs of the same type more efficiently. Each job keeps its own lease and durable identity while it waits for the shared invocation.

`BatchHandlerOptions.maxSize` caps the group. `BatchHandlerOptions.lingerMs` lets a partial group wait briefly for peers, then dispatches it even when no notification arrives.

Workhorse claims jobs through the normal priority path. A batch contains one queue and one job type.

Its items arrive in priority order.

The handler receives `BatchHandlerItem` values. Each item includes the original payload and its own `BatchHandlerContext`, so checkpoints, progress, cancellation, and fencing remain attached to the correct job.

A batch callback must return one outcome for every member, so one member cannot suspend and replay independently. `BatchHandlerContext` therefore omits timer waits, signals, human decisions, and child joins. Use an ordinary `Handler` when a job needs those boundaries.

Return one `BatchHandlerOutcome` for each item in the same order. A successful outcome carries that job's result. A failed outcome carries the error for that job's retry policy.

If the handler itself throws or returns an invalid outcome list, Workhorse submits the failure for every member. Each member still uses its own fence and retry budget.

```ts
new Worker(queue, { concurrency: workerCapacity }).handleBatch(
  "email.send",
  {
    maxSize: batching.maxSize,
    lingerMs: batching.lingerMs,
  },
  async (items) => {
    const deliveries = await emailProvider.sendMany(items.map((item) => item.payload));
    return deliveries.map((delivery) =>
      delivery.error
        ? { status: "failed", error: delivery.error }
        : {
            status: "succeeded",
            result: { providerId: delivery.id },
          },
    );
  },
);
```

Batch capacity cannot exceed the worker's job concurrency because every member still occupies one active slot. Full groups dispatch immediately, while partial groups dispatch when their linger ends.

PostgreSQL admits jobs one at a time before they enter the group. Priority, queue limits, keyed limits, and rate limits can therefore leave a partial batch waiting for its linger.

Cancellation, timeouts, lost leases, and shutdown remain per-job decisions. One member can be canceled or lose its fence while peers complete normally.

## Next

- [Workers](310-workers.md)
- [Priority](150-priority.md)
- [Leases and fences](020-leases-and-fences.md)

[Exact batch-handler limits and lifecycle rules](../architecture.md)
