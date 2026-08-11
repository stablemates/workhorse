# How do I control how quickly work starts?

Worker slots cap simultaneous handlers. A rate-limit policy controls how quickly jobs enter those slots across every worker that shares the database.

Use a rate limit when an external service accepts a steady request pace or a bounded burst. Use a [concurrency policy](240-concurrency-policies.md) when the scarce resource is simultaneous work.

## PostgreSQL owns the bucket

`Queue.syncRateLimitPolicies` stores desired token buckets in PostgreSQL. A worker needs no matching process configuration because `claim_v2` consumes a token while it acquires the job.

```ts
const serviceRate = deploymentConfig.serviceRate;

await queue.syncRateLimitPolicies("workers", [
  {
    queue: "mail",
    limit: serviceRate.limit,
    intervalMs: serviceRate.intervalMs,
    burst: serviceRate.burst,
  },
]);
```

The namespace owns each queue it synchronizes. PostgreSQL rejects another namespace that tries to replace it. Omitted policies are removed unless the caller disables pruning.

PostgreSQL uses its own clock and refills continuously. A process restart cannot reset the bucket, and competing workers cannot spend the same token.

## Queue scope and key scope

A queue-scoped bucket controls every job in that queue together. A key-scoped policy gives each `concurrencyKey` an independent bucket inside the queue.

Key scope is useful when tenants share a queue but each tenant has its own upstream allowance. Keyless jobs share one keyless bucket, and the same key in another queue remains independent.

If one key runs out of tokens, `claim_v2` can admit later work for another key. It searches a bounded FIFO window, so an unlimited blocked prefix cannot turn one claim into an unlimited scan.

## Admission happens again after failure

A token pays for one transition from ready to active. If a handler fails and retries, or a worker disappears and recovery returns the job to ready, the next attempt needs another token.

The token is part of the claim transaction. PostgreSQL returns it if the transaction rolls back, but it remains spent after a committed claim even if the worker crashes.

Workers sleep between empty claims, so ready but throttled work does not create a tight loop. Polling eventually observes a refill because no notification occurs merely when time passes.

`Queue.health()` and the dashboard report bounded throttled depth, effective refill throughput, and the next eligibility time. OpenTelemetry exports the same queue-level pressure without raw key values.

## Next

- [240-concurrency-policies.md](240-concurrency-policies.md) — limit simultaneous work across the fleet
- [310-workers.md](310-workers.md) — understand slots, polling, and worker shutdown
- [350-observability.md](350-observability.md) — export queue pressure without unbounded labels

---

Exact bounds, SQL functions, bucket columns, and cleanup semantics:
[`architecture.md`](../architecture.md#rate_limit_policy-and-rate_limit_bucket).
