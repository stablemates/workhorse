# Enqueueing the same job twice by accident

A user double-clicks "Place order". Your API handler runs twice. Two jobs get enqueued, and
the customer gets two confirmation emails.

Enqueue idempotency stops the second job from being created at all.

## How it works

Attach a key when you enqueue. If a job with that key already exists, you get the existing
job's id back instead of a new job.

```ts
const jobId = await queue.enqueue(
  "send-order-confirmation",
  { orderId },
  { idempotency: { key: `order-confirmation:${orderId}` } },
);
```

Call that twice with the same `orderId` and you get the same job id twice. The second call
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

## Keys expire

Each key is retained for a while and then released — a day, by default, and configurable per
request. That's deliberate: keys are for catching accidental duplicates within a short
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
