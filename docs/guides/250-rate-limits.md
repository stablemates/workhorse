# How do I control how quickly work starts?

Rate limits protect an external service from a burst of task starts. PostgreSQL owns the budget, so
every worker process observes the same answer.

A concurrency policy limits how much work runs at once. A rate-limit policy controls how quickly
new work begins, even when earlier work finishes immediately.

Workhorse uses a token bucket for each governed queue. Time refills tokens at the sustained rate,
and each task start consumes one token. The burst value controls how many tokens survive an idle
period.

You can also configure an independent bucket for each concurrency key. This lets one customer wait
for its own refill while another customer's task starts. A task without a key uses only the queue
bucket.

Deploy rate policies as desired state:

```ts
await queue.syncRateLimitPolicies("billing-workers", [
  {
    queue: "provider-api",
    rate: {
      limit: startsPerWindow,
      intervalMs: windowDurationMs,
      burst: idleBurst,
    },
    perKey: {
      limit: customerStartsPerWindow,
      intervalMs: customerWindowDurationMs,
      burst: customerIdleBurst,
    },
  },
]);
```

Use the same queue name when you enqueue, and use `concurrencyKey` for the caller whose traffic
needs an independent budget. The key remains part of the accepted job identity and also participates
in concurrency admission when that policy is enabled.

Workers do not refund tokens when a task succeeds, fails, waits, or loses its lease. The budget
measures starts, so a retry consumes a token just like its first attempt.

`Queue.rateLimitStatuses` shows available queue tokens, throttled ready work, and the next time a
sampled task can start. The dashboard presents those facts separately from active concurrency.

## Next

- [How do I stop one customer from consuming every worker?](240-concurrency-policies.md)
- [What happens when a task fails?](110-retries.md)
- [How do workers claim tasks safely?](020-leases-and-fences.md)

[Architecture reference](../architecture.md#rate_limit_policy-and-rate_limit_bucket).
