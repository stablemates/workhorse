# Rate limits

> Synchronize PostgreSQL-owned queue and keyed token buckets across every worker.

An external API allows sixty calls a minute. A concurrency policy cannot enforce that: it limits
how much work runs at once, and sixty jobs that each finish in a hundred milliseconds sail through
a `maxActive` of five. A rate-limit policy governs the other axis — how quickly work starts —
with a token bucket that PostgreSQL owns, so every worker process draws from the same budget no
matter how many you run.

## Synchronize desired policy

Like concurrency policies, rate limits are desired state, declared per namespace and reconciled
on deploy.

```ts
await queue.syncRateLimitPolicies("workers", [
  {
    queue: "provider-api",
    rate: { limit: 60, intervalMs: 60_000, burst: 10 },
    perKey: { limit: 5, intervalMs: 60_000, burst: 2 },
  },
]);
```

Reading the `rate` bucket: time refills tokens at `limit` per `intervalMs` — sixty starts per
minute — and each job start consumes one token. `burst` caps how many tokens survive an idle
period, so a quiet hour buys at most ten immediate starts, not a flood.

`perKey` is optional. When set, every non-null `concurrencyKey` gets its own independent bucket —
here, five starts per minute with a burst of two. One customer exhausting its bucket waits for its
own refill while another customer's job starts. A keyless job draws from the queue bucket only.
Omitted policies are pruned by default, and another namespace cannot replace a queue this
namespace owns.

## PostgreSQL owns the clock

The claim transaction consumes tokens, and PostgreSQL supplies the refill time. Application clock
skew cannot mint capacity, and two competing workers cannot spend the same token — the same
property that makes claims safe makes throttling exact.

Tokens are never refunded. The budget measures starts: a job that succeeds, fails, waits, or loses
its lease keeps its token spent, and every retry start consumes a fresh one. Size the limit for
attempts, not for jobs.

## Observe throttling

```ts
const statuses = await queue.rateLimitStatuses();
// availableTokens, throttledReady, throttledKeys, nextEligibleAt per policy
```

Each status reports available queue tokens, bounded throttled-ready depth, the count of throttled
keys, and the earliest sampled eligibility time — enough to tell "waiting for a token" apart from
"nothing to run". `queue.health()` includes the same summary, and OpenTelemetry exports
queue-level configured rate, tokens, throttle depth, and eligibility delay.

The dashboard's Queues page keeps concurrency and start rate in separate columns, so an
active-work cap stays visually distinct from a ready job waiting for its next token.

## Next

- [Concurrency policies](/docs/concurrency-policies) — limit simultaneous active work
- [Retries](/docs/retries) — every retry start consumes a token
- [Operations](/docs/operations) — inspect throttled queue pressure

---

Exact SQL functions, limits, storage, and refill semantics:
[architecture reference](https://github.com/stablemates/workhorse/blob/main/docs/architecture.md#rate_limit_policy-and-rate_limit_bucket).
