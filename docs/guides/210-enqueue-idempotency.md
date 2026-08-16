# Enqueueing the same job twice by accident

A user double-clicks "Place order". Your API handler runs twice. Two jobs get enqueued, and
the customer gets two confirmation emails.

Enqueue idempotency stops the second job from being created at all.

## How it works

Attach a key when you enqueue. If a job with that key already exists, you get the existing
job's id back instead of a new job.

```ts
const result = await queue.enqueueWithResult(
  "send-order-confirmation",
  { orderId },
  { idempotency: { key: `order-confirmation:${orderId}` } },
);
```

Call that twice with the same `orderId` and you get the same `result.jobId` twice. The second call
creates nothing: no job, no event, no notification. It just tells you which job already
owns that key.

The key is yours to choose, and it should come from something stable in your domain — an
order id, an invoice number, a webhook delivery id. Never a timestamp or a random value,
which would defeat the whole thing.

## Scopes keep keys apart

Two unrelated features might both want the key `order-123`. Pass a `scope` to keep them in
separate namespaces:

```ts
{ idempotency: { key: `order-${orderId}`, scope: "confirmation-email" } }
```

Omit it and you land in a shared default scope, which is fine for keys that already carry
their own prefix.

## Reading the enqueue outcome

`Queue.enqueueWithResult` returns an `EnqueueResult`. Its `jobId` identifies the retained job, while
its `outcome` field is an `EnqueueOutcome` that explains what PostgreSQL did with this request.

- `accepted` means PostgreSQL created a new job.
- `replayed` means an idempotency key found an equivalent retained job.
- `replaced` means [debounce](215-debounce.md) updated a pending job.
- `non_replaceable` means debounce retained a job that could no longer accept an update.
- `coalesced` means [throttle](217-throttle.md) reused the job for its active window.

Use `Queue.enqueue` when the stable job id is enough. It returns the same `jobId` and hides the
outcome. Use `Queue.enqueueWithResult` when logs, metrics, or application behavior need the reason.

## Keys expire

Each key is retained for a configurable period and then released. That's deliberate: keys are for
catching accidental duplicates within a short
window, not for permanently reserving a name. Once a key expires, the same key can create a
new job.

## Sending different data under the same key

Workhorse records a fingerprint of what you enqueued — the queue, type, payload, tags,
attempt budget, retry policy. If you reuse a key with _different_ content, that's not a
duplicate, it's a mistake, so you get a conflict error rather than either job silently
winning.

Sending genuinely identical content is the normal replay case and just returns the existing
id.

## Your raw key is never stored

Only a hash of it goes into the database. Errors and the dashboard show a short preview and
a digest, not the key itself. So it's safe to build keys out of internal identifiers without
worrying about them showing up on an operator's screen.

## What this does not do

It stops duplicate _jobs_. It does not make your handler run exactly once — that's still
[at-least-once](030-delivery-guarantees.md), and one job can still execute twice after a
crash. These are different problems and you often need both fixes.

## Next

- [030-delivery-guarantees.md](030-delivery-guarantees.md) — the other half of the problem
- [220-schedules.md](220-schedules.md) — the same idea applied to cron firings
- [010-jobs-and-state.md](010-jobs-and-state.md) — what a job actually is

---

Exact fingerprint contents, limits, and conflict shape:
[`architecture.md`](../architecture.md#enqueue_idempotency).
