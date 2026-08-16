# Keyed debounce

> Replace pending work under a stable key while updates continue arriving.

Debounce keeps one pending job with the latest accepted payload. PostgreSQL serializes concurrent
replacements, so every caller observes one stable job identity.

```ts
const result = await queue.enqueueWithResult(
  "search.reindex",
  { documentId, revision },
  {
    debounce: {
      key: documentId,
      scope: "search-index",
      windowMs: quietPeriodMs,
      schedule: "reset",
    },
  },
);
```

Choose `reset` to start a fresh quiet period after every replacement. Choose `preserve` when the
first request fixes the run time and later requests should update only the payload.

`result.outcome` is `accepted` for a new job and `replaced` for a pending update. Once a worker owns
the job, it becomes terminal, or its window elapses, PostgreSQL returns `non_replaceable` and keeps
the accepted payload unchanged.

Debounce cannot share a request with idempotency, throttle, or dependencies because each mechanism
assigns a different meaning to a repeated key or immutable edge.

## Next

- [Throttle](/docs/throttle) — reuse equivalent work without replacing it
- [Idempotent enqueue](/docs/idempotency) — replay an identical request
- [Job dependencies](/docs/job-dependencies) — keep accepted work blocked

---

Exact debounce outcomes, limits, and lifecycle events:
[architecture reference](https://github.com/stablemates/workhorse/blob/main/docs/architecture.md#keyed-debounce).
