# Queries and timelines

> Inspect any job's state, list work with bounded payloads, replay lifecycle evidence, and ask the queue how it feels.

When something goes wrong at 2 a.m., you need answers from the queue itself: what state is this
job in, what happened to it, and is the system healthy? Workhorse answers all three from
PostgreSQL read models that stay separate from the dispatch path. You can page through millions
of terminal jobs without slowing a single worker's claim.

## Read one known job

`queue.getJob(jobId)` joins the job's immutable identity to its runtime or outcome row and
returns a `JobSnapshot` — or `null` when the identity is unknown or retired.

```ts
const snapshot = await queue.getJob(jobId);

if (snapshot) {
  console.log(snapshot.state, snapshot.currentAttempt, snapshot.result);
} else {
  console.log("no such job, or its identity was retired");
}
```

That `null` matters. A history query alone cannot distinguish "never existed" from "existed and
was cleaned up", so use `getJob` whenever existence is the question.

## List jobs with bounded payloads

`queue.listJobs(query)` filters by queue, type, states, tags, and creation time. It orders pages
newest-first by immutable creation keys and returns a signed cursor for the next call.

```ts
const page = await queue.listJobs({
  queue: "billing",
  states: ["active", "failed"],
  payload: {
    include: true,
    maxBytes: 4_096,
    redactKeys: ["cardNumber", "accessToken"],
  },
});

for (const job of page.items) {
  console.log(job.id, job.state, job.payloadStatus, job.payload);
}

if (page.nextCursor) {
  const next = await queue.listJobs({
    queue: "billing",
    states: ["active", "failed"],
    payload: { include: true, maxBytes: 4_096, redactKeys: ["cardNumber", "accessToken"] },
    cursor: page.nextCursor,
  });
}
```

Payloads are omitted by default because operator lists rarely need them. When you opt in,
PostgreSQL redacts the top-level keys you name, enforces the size ceiling, and marks each row's
`payloadStatus` as `included`, `omitted`, or `too_large`. Sensitive data never has to leave the
database just to render a list.

Two rules keep paging honest:

- A cursor is signed against the filters and payload projection that created it. Reusing it with
  a different query fails loudly instead of silently changing page membership.
- Pages are weakly consistent across calls. Jobs enqueued or transitioned between calls can shift
  later pages, so confirm any individual job with `getJob`.

## Reconstruct what happened

`queue.getJobTimeline(jobId, query)` merges retained `job_event` rows and closed
`attempt_history` rows into one newest-first stream, with its own cursor for long histories.

```ts
const timeline = await queue.getJobTimeline(jobId, { limit: 50 });

for (const entry of timeline.items) {
  if (entry.kind === "event") {
    console.log(entry.occurredAt, entry.eventType, entry.details);
  } else {
    console.log(entry.occurredAt, `attempt ${entry.attempt}`, entry.outcome);
  }
}
```

This is the durable answer to "why did attempt 3 retry?" — each closed attempt carries its
outcome, and each event carries its details. One caveat: history categories retire on independent
retention windows, so a known job can have a partial or empty timeline. Absence of timeline is
never proof of absence of the job.

For the other durable projections, `queue.getCheckpoint`, `listCheckpoints`, `getWait`,
`listWaits`, and `getProgress` expose checkpoints, durable waits, and progress without
interpreting them as lifecycle state.

## Ask the queue how it feels

`queue.health({ budgets })` reads every correctness-sensitive value in a single SQL statement, so
the snapshot describes one instant — reported as `capturedAt`. It then evaluates the snapshot
against budgets and returns a verdict.

```ts
const health = await queue.health({
  budgets: { rollupStalledLagMs: 5 * 60 * 1000 },
});

if (health.status.level !== "healthy") {
  for (const reason of health.status.reasons) {
    console.warn(reason.code, reason.observed);
  }
}
```

`status.level` is `healthy`, `degraded`, or `critical`. Each exceeded budget produces a reason
with a stable machine-readable `code` and the `observed` value, so automation branches on codes
instead of parsing prose. Exact counts live at the top level of `QueueHealth`; values that come
from PostgreSQL's own lagging statistics live under `observations`, where lag is expected.

The `workhorse-health` CLI runs the identical evaluation and exits non-zero on any exceeded
budget — ready for probes and cron checks. For continuous export instead of polling, see
`WorkhorseMetricsObserver` in [Maintenance and retention](/docs/maintenance).

## Next

- [Dashboard](/docs/dashboard) — the same read models, rendered for humans
- [Dead letters and redrive](/docs/dead-letters) — page terminal failures through their cold index
- [Operations](/docs/operations) — route each operational concern to its owner

---

Exact query fields, cursor binding, payload controls, and health measures:
[architecture reference](https://github.com/stablemates/workhorse/blob/main/docs/architecture.md#read-models-and-health).
