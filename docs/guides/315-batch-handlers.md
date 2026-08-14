# How do I process several jobs together?

Use `Worker.handleBatch` when one application call can process several jobs of the same type more efficiently. Each job keeps its own lease and durable identity while it waits for the shared invocation.

`BatchHandlerOptions.maxSize` caps the group. `BatchHandlerOptions.lingerMs` lets a partial group wait briefly for peers, then dispatches it even when no notification arrives.

Workhorse claims jobs through the normal priority path. A batch contains one queue and one job type.

Its items arrive in priority order.

The handler receives `BatchHandlerItem` values. Each item includes the original payload and its own `HandlerContext`, so checkpoints, progress, waits, cancellation, and fencing remain attached to the correct job.

Return one result for each item in the same order. If the handler throws or returns the wrong number of results, Workhorse submits the same failure through every member's fenced lifecycle.

```ts
new Worker(queue, { concurrency: workerCapacity }).handleBatch(
  "email.send",
  {
    maxSize: batching.maxSize,
    lingerMs: batching.lingerMs,
  },
  async (items) => {
    const deliveries = await emailProvider.sendMany(items.map((item) => item.payload));
    return deliveries.map((delivery) => ({ providerId: delivery.id }));
  },
);
```

Batch capacity cannot exceed the worker's job concurrency because every member still occupies one active slot. Full groups dispatch immediately, while partial groups dispatch when their linger ends.

## Next

- [Workers](310-workers.md)
- [Priority](150-priority.md)
- [Leases and fences](020-leases-and-fences.md)

[Exact batch-handler limits and lifecycle rules](../architecture.md)
