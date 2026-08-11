# How do I limit work across the whole worker fleet?

Worker slots limit one process. A concurrency policy limits dispatch across every worker that shares the database.

Use a policy when downstream capacity belongs to the application rather than one worker process. Common examples include a database connection budget or a tenant API limit.

## A durable dispatch budget

`Queue.syncConcurrencyPolicies` stores desired policies in PostgreSQL. Workers do not need matching in-memory configuration because `claim_v2` reads the policy during admission.

Each policy limits one queue. It can also limit jobs that share a `concurrencyKey` inside that queue. The same key text in another queue is independent.

Keyless jobs consume queue capacity but do not consume keyed capacity. A null per-key limit disables keyed admission while retaining the queue limit.

```ts
const queue = new Queue(pool);
const queueBudget = deploymentConfig.mailConcurrency;
const tenantBudget = deploymentConfig.tenantConcurrency;

await queue.syncConcurrencyPolicies("workers", [
  {
    queue: "mail",
    maxActive: queueBudget,
    maxActivePerKey: tenantBudget,
  },
]);

await queue.enqueue(
  "mail.send",
  { messageId: "welcome" },
  { queue: "mail", concurrencyKey: "tenant-a" },
);
```

The namespace owns the queues it synchronizes. PostgreSQL rejects another namespace that tries to replace that ownership. Omitted policies are removed unless you disable pruning.

## Capacity follows leases

The policy counts active jobs whose leases have not expired. If a worker disappears, capacity returns when its lease expires even before maintenance recovers the row.

This makes the policy a dispatch budget, not a mutex. A stale handler can overlap its replacement after lease expiry. Fence tokens still prevent that stale generation from recording a result.

When a job releases capacity normally, PostgreSQL wakes workers listening for that queue. Polling remains the correctness fallback if a notification is lost.

## Avoiding a blocked queue

If one key is full, `claim_v2` can admit later ready work for another key. It searches a bounded FIFO window, so admission cost cannot grow with an unlimited saturated prefix.

`Queue.health()` reports bounded policy summaries, including active capacity, blocked ready work, and saturated-key counts. OpenTelemetry exports queue-level policy gauges without raw key values.

Nothing records the policy a job ran under. A job keeps the `concurrencyKey` it was enqueued with, so that key stays true forever. Its queue's limits can change at any time. The dashboard therefore labels the limits beside a finished task as the queue's current policy rather than as history.

## Next

- [020-leases-and-fences.md](020-leases-and-fences.md) — why capacity can return safely after expiry
- [250-rate-limits.md](250-rate-limits.md) — how quickly new work may begin
- [310-workers.md](310-workers.md) — how process-local slots differ from fleet-wide admission

---

Exact limits, SQL functions, indexes, and admission semantics:
[`architecture.md`](../architecture.md#concurrency_policy).
