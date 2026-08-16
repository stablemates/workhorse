# Keyed throttle

> Accept one equivalent job during a busy window and coalesce later triggers into it.

Throttle keeps an acceptance window in PostgreSQL. The first request creates a job; an equivalent
request before the window closes returns the same identity with a `coalesced` outcome.

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

The retained job may be waiting, active, or finished. Execution state does not reopen the
acceptance window. A changed payload, queue, priority, schedule, retry policy, or window conflicts
because silently discarding changed work would hide caller intent.

After the window closes, the key can accept a new job. One request cannot combine throttle with
idempotency, debounce, or dependencies. The dashboard shows a safe key digest, the window, and the
number of absorbed requests without exposing the raw key.

## Next

- [Debounce](/docs/debounce) — replace pending payloads during a quiet period
- [Idempotent enqueue](/docs/idempotency) — replay one stable request
- [Rate limits](/docs/rate-limits) — control how quickly accepted jobs start

---

Exact throttle outcomes, limits, and lifecycle events:
[architecture reference](https://github.com/stablemates/workhorse/blob/main/docs/architecture.md#keyed-throttle).
