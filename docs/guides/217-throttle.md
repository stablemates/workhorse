# How do I limit duplicate work during a busy window?

A digest sender may receive many equivalent triggers close together. It needs one accepted job for
that period, while later triggers should reuse the same durable identity.

Keyed throttle keeps the acceptance window in PostgreSQL. The first request creates the job. An
equivalent request before the window closes returns that job with a `coalesced` outcome.

```ts
const result = await queue.enqueueWithResult(
  "email.digest",
  { accountId },
  {
    throttle: {
      key: accountId,
      scope: "digest",
      windowMs: digestWindowMs,
    },
  },
);
```

The retained job may be waiting, active, or finished. Throttle controls whether PostgreSQL accepts
another identity, so execution state does not reopen the window.

The repeated request must remain equivalent. A changed payload, queue, priority, schedule, retry
policy, or window is a conflict because silently dropping changed work would hide caller intent.

After the window closes, the same key can accept a new job. Purging pending work also releases its
key. One request cannot combine throttle with
[enqueue idempotency](210-enqueue-idempotency.md) or [debounce](215-debounce.md), because each mode
gives a repeated key a different meaning.

A throttled job cannot declare `prerequisiteJobId` or `dependencies`. Use a regular
[dependent job](160-job-dependencies.md) when dispatch must wait for other work.

## Next

- [210-enqueue-idempotency.md](210-enqueue-idempotency.md) — replaying an identical request safely
- [215-debounce.md](215-debounce.md) — replacing pending work while updates keep arriving
- [250-rate-limits.md](250-rate-limits.md) — controlling how quickly accepted jobs may start

---

Exact SQL functions, limits, outcomes, and lifecycle rules:
[`architecture.md`](../architecture.md#keyed-throttle).
