# How do I process several tasks together?

Use `Worker.handleBatch` when a downstream system accepts several items in one call, such as a bulk email API or a multi-row insert.
Go names this method `Worker.HandleBatch`, while Python names it `Worker.handle_batch`.
Each task keeps its own lease and durable identity while it waits for the shared invocation.

Producers do not change. The application enqueues one ordinary task per unit of work, and the producer cannot tell that a batch handler will run it.

```ts
await queue.enqueue("email.send", { to: "person@example.com" });
```

The worker forms each group. It claims each task through the normal claim path, then holds the claimed tasks of one queue and task type in a group inside its own process. A group never spans two worker processes. `Queue.enqueueMany` writes several tasks in one transaction, but it does not decide which tasks share a group.

`BatchHandlerOptions.maxSize` caps the group. `BatchHandlerOptions.lingerMs` lets a partial group wait briefly for peers, then dispatches it even when no notification arrives.

Workhorse claims tasks through the normal priority path. A batch contains one queue and one task type.

Its items arrive in priority order.

The handler receives `BatchHandlerItem` values. Each item includes the original payload and its own `BatchHandlerContext`, so checkpoints, progress, cancellation, and fencing remain attached to the correct task.

A batch callback must return one outcome for every member, so one member cannot suspend and replay independently. `BatchHandlerContext` therefore omits timer waits, signals, human decisions, and child joins. Use an ordinary `Handler` when a task needs those boundaries.

Return one `BatchHandlerOutcome` for each item in the same order. A successful outcome carries that task's result. A failed outcome carries the error for that task's retry policy.

Python handlers return the same statuses as mappings. They register `max_size` and `linger_ms` as
keyword arguments, and receive `BatchHandlerItem` values with a `BatchHandlerContext`.

Go handlers return `BatchSucceeded` or `BatchFailed` values. They register `MaxSize` and `Linger`
through `BatchHandlerOptions`, and each item's context exposes cancellation, checkpoints, and
latest-value progress.

Python batch contexts use `get_progress` and `set_progress`. Go batch contexts use `GetProgress`
and `SetProgress`, so every member reports through its own fence.

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

Batch capacity cannot exceed the worker's task concurrency because every member still occupies one active slot. Full groups dispatch immediately, while partial groups dispatch when their linger ends.

Workhorse admits each task against the queue's policies before it enters the group. Priority, queue limits, keyed limits, and rate limits can therefore leave a partial batch waiting for its linger.

Cancellation, timeouts, lost leases, and shutdown remain per-task decisions. One member can be canceled or lose its fence while peers complete normally.

The saving lives in the handler's downstream call: one bulk request replaces one request per task. The worker still claims, heartbeats, and completes every member separately, so the queue itself does no less work. If the downstream system has no bulk operation, an ordinary `Handler` is simpler and avoids the linger wait.

Batching also has costs. A partial group waits for its linger, so a task can start later when traffic is light. A shared callback failure fails every member. A member cannot suspend, because the shared callback owes every member an outcome.

Workhorse records each shared invocation before the callback starts. The task drawer shows that a
task ran in a batch and links its peers. If the shared callback fails, the drawer groups that
failure across the members instead of guessing from their individual errors.

## Next

- [310-workers.md](310-workers.md) — the process that owns batch capacity
- [150-priority.md](150-priority.md) — how PostgreSQL orders members before batching
- [020-leases-and-fences.md](020-leases-and-fences.md) — why each member keeps separate ownership

---

Exact batch-handler limits and lifecycle rules:
[`architecture/lifecycle.md`](../architecture/lifecycle.md#worker-concurrency-and-lifecycle).
