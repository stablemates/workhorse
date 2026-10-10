# How do I stop a repeated request from enqueueing a second task?

<!-- scenario-names: order-123 -->

A user double-clicks "Place order". Your API handler runs twice. Two tasks get enqueued, and the
customer gets two confirmation emails. Enqueue idempotency stops the second task from being created
at all.

## One order, two clicks, one task

**Example.** Order `7781` is placed. Your API handler enqueues a confirmation email with the
idempotency key `order-confirmation:7781`. The user double-clicks, so the handler runs twice.

1. **At 0 ms** the first request arrives. No task holds the key, so Workhorse creates a task and
   binds the key to it. The result is `accepted`, with a new `taskId`.
2. **At 40 ms** the second request arrives with the same key and the same content. Workhorse finds
   the binding and returns the same `taskId`. The outcome is `replayed`.

The second request created nothing: no task, no event, no notification. It only reported which task
already owns the key.

```ts
const result = await queue.enqueueWithResult(
  "send-order-confirmation",
  { orderId },
  { idempotency: { key: `order-confirmation:${orderId}` } },
);
```

PostgreSQL decides which request wins. Suppose two app servers send the request at the same moment.
PostgreSQL lets one of them bind the key, and the other waits for it. The waiting request then finds
the binding and replays it.

The key is yours to choose. Build it from something stable in your domain: an order id, an invoice
number, a webhook delivery id. A timestamp or a random value makes every request unique, so it
catches no duplicate.

<details>
<summary>Reference: options and replay</summary>

**`EnqueueOptions.idempotency`**

| Field   | Rule                                                                    |
| ------- | ----------------------------------------------------------------------- |
| `key`   | Required. 1 to 512 UTF-8 bytes.                                         |
| `scope` | Optional. 1 to 256 UTF-8 bytes. The default is `"default"`.             |
| `ttlMs` | Optional. An integer from 1 to 31,536,000,000 (365 days). Default 24 h. |

A request with `idempotency` cannot also set `debounce` or `throttle`.

**Binding.** The relation `enqueue_idempotency` has the primary key
`(idempotency_scope, idempotency_key_hash)`. Concurrent requests for one scope and key therefore
run one at a time.

**Replay.** An exact replay returns the bound task ID before any task, dependency, event, runtime,
FIFO-sequence, or notification side effect. It appends no event.

**No key.** A request without `idempotency` skips the relation and always creates a task.

More detail: [Data model: Fingerprint and replay](../architecture/data-model.md#fingerprint-and-replay) and [Data model: Key and limits](../architecture/data-model.md#key-and-limits).

</details>

## Scopes keep keys apart

Two features each build the key `order-123`. One sends the confirmation email, and the other
updates the warehouse. Neither passes a scope.

1. **At 0 ms** the email feature enqueues with the key `order-123`. No task holds the key, so the
   result is `accepted`.
2. **At 5 ms** the warehouse feature enqueues with the same key, but a different task type and
   payload. Both requests share the default scope. Workhorse finds the binding, sees a different
   request, and raises a conflict error. The warehouse feature gets no task.

Pass a `scope` to keep them in separate namespaces:

```ts
{ idempotency: { key: `order-${orderId}`, scope: "confirmation-email" } }
```

A key is unique within its scope. If you omit the scope, the request uses a shared default scope.
That suits keys that already carry their own prefix.

<details>
<summary>Reference: scope and key hash</summary>

- The default scope is `"default"`.
- `idempotency_key_hash` is the full SHA-256 of the scope and key ownership input.
- Debounce and throttle keys share the same relation and the same scopes. A key in use by one mode
  is not free for another. The keyed modes are mutually exclusive on one request.

More detail: [Data model: Key and limits](../architecture/data-model.md#key-and-limits).

</details>

## Reading the enqueue outcome

In the story, both clicks got the same `taskId`. Only the outcome told them apart: `accepted` for
the first click and `replayed` for the second. Log the outcome when you want to count duplicates.

`Queue.enqueueWithResult` returns an `EnqueueResult`. Its `taskId` identifies the task that
Workhorse kept. Its `outcome` explains what PostgreSQL did with this request. Three of the outcomes
belong to other keyed modes: [debounce](215-debounce.md) and [throttle](217-throttle.md).

Use `Queue.enqueue` when the task ID is enough. It returns the same `taskId` and hides the outcome.
Use `Queue.enqueueWithResult` when logs, metrics, or application behavior need the reason.

<details>
<summary>Reference: enqueue outcomes</summary>

`enqueueWithResult` returns an `EnqueueResult`: `{ taskId, outcome }`, where `outcome` is an
`EnqueueOutcome`. A `non_replaceable` result also has a `reason`.

| `outcome`         | Mode        | Meaning                                                 |
| ----------------- | ----------- | ------------------------------------------------------- |
| `accepted`        | Any         | PostgreSQL created a new task.                          |
| `replayed`        | Idempotency | The key found an equivalent retained request.           |
| `replaced`        | Debounce    | PostgreSQL updated a pending task.                      |
| `non_replaceable` | Debounce    | PostgreSQL kept a task that could not accept an update. |
| `coalesced`       | Throttle    | PostgreSQL reused the task for its active window.       |

A `non_replaceable` result's `reason` is `incompatible_key_mode`, `not_pending`, or
`window_elapsed_pending`.

`Queue.enqueueManyWithResults` returns one result per request. `Queue.enqueue` and
`Queue.enqueueMany` return only the task IDs.

More detail: [Task lifecycle: Enqueue results](../architecture/lifecycle.md#enqueue-results).

</details>

## Keys expire

The order key used the default retention window. Here is what happens to it over a day.

1. **At 0 h** the first request is `accepted`. The binding expires at 24 h.
2. **At 1 min** a worker sends the email, and the task succeeds.
3. **At 3 h** a client retries the request. The task has finished, but the binding is still alive,
   so the request is `replayed` with the original `taskId`.
4. **At 25 h** the same request arrives again. The binding has expired, so Workhorse creates a new
   task and binds the key to it.

A replay does not extend the window. The expiry is fixed when the key is first bound. Keys catch
accidental duplicates within a bounded period. They do not reserve a name forever.

<details>
<summary>Reference: expiry and release</summary>

- The default `ttlMs` is 86,400,000 ms (24 hours).
- At acceptance, PostgreSQL sets `expires_at` to `clock_timestamp() + ttlMs`. A replay leaves it
  unchanged.
- The next request for an expired key deletes the old binding and creates a new task.
- Maintenance runs `prune_enqueue_idempotency_v1` to delete expired bindings in bounded batches.
- Housekeeping keeps a finished task's identity while a binding still points at it.
- A queue purge deletes the bindings of the `blocked`, `ready`, and `scheduled` tasks it removes.

More detail: [Data model: Key exposure and expiry](../architecture/data-model.md#key-exposure-and-expiry) and [Data model: Key and limits](../architecture/data-model.md#key-and-limits).

</details>

## Sending different data under the same key

Go back to order `7781`.

1. **At 0 ms** the first request is `accepted`. Workhorse records a fingerprint of that request.
2. **At 2 s** a client sends the request again, but a bug changed the payload. The key is the same,
   the content is not.
3. **Right after** Workhorse compares the request with the stored fingerprint. The payload differs,
   so Workhorse raises a conflict error. The task from 0 ms keeps its payload, and no second task
   exists.

That is not a duplicate; it is a mistake. So Workhorse raises a conflict error, and neither request
silently wins.

Workhorse records a fingerprint of the accepted request: the queue, the type, the payload, the tags,
the attempt budget, the retry policy, and more. A later request with the same key must match it. An
identical request is the normal replay case and returns the existing `taskId`.

The conflict aborts the whole statement. If you enqueue inside your own transaction, the transaction
fails too. The error lists which fields differ.

<details>
<summary>Reference: fingerprint and conflict</summary>

**Fingerprint fields.** These are also the values of `conflictingFields`:

`queue`, `type`, `payload`, `priority`, `concurrencyKey`, `budget`, `contractVersion`,
`payloadMaxBytes`, `resultMaxBytes`, `sensitivePayloadKeys`, `sensitiveResultKeys`, `tags`, `runAt`,
`deadline`, `executionTimeoutMs`, `maxAttempts`, `retryPolicy`, `prerequisiteTaskId`,
`dependencies`, `ttlMs`.

- Tags are deduplicated and sorted, so their order does not matter.
- The retry policy and dependencies are normalized before comparison.
- An omitted `runAt` stays omitted. It does not capture the time of the request.

**Conflict.** PostgreSQL raises SQLSTATE `P1001`. The TypeScript client throws
`EnqueueIdempotencyConflictError` with these details:

| Field                   | Content                                          |
| ----------------------- | ------------------------------------------------ |
| `scope`                 | The scope.                                       |
| `keyPreview`            | A short preview of the key.                      |
| `keyDigest`             | The first 12 hexadecimal characters of the hash. |
| `keyLength`             | The key length in characters.                    |
| `existingTaskId`        | The task the key is bound to.                    |
| `ordinal`               | The request's position in its batch, from 1.     |
| `conflictingFields`     | The fingerprint fields that differ.              |
| `storedRequestDigest`   | SHA-256 of the stored fingerprint.               |
| `rejectedRequestDigest` | SHA-256 of the rejected fingerprint.             |

More detail: [Data model: Fingerprint and replay](../architecture/data-model.md#fingerprint-and-replay).

</details>

## Your raw key is never stored

Go back to order `7781`.

1. **At 0 ms** Workhorse binds the key `order-confirmation:7781`. It stores a hash of the key, not
   the key itself.
2. **Later** an operator opens the task in the dashboard. Its `enqueued` event shows a short preview
   of the key and a digest.

Workhorse stores only a hash of the key. Errors, events, and the dashboard show a short preview and
a digest, not the key itself. So you can build keys from internal identifiers without exposing them
on an operator's screen.

<details>
<summary>Reference: key preview and digest</summary>

| Key length      | Preview                          |
| --------------- | -------------------------------- |
| 1 to 4 chars    | One `•` per character.           |
| 5 to 8 chars    | First 2 characters, `…`, last 2. |
| 9 chars or more | First 8 characters, `…`, last 4. |

The digest is the first 12 hexadecimal characters of `idempotency_key_hash`. The initial `enqueued`
event, UI projections, and errors expose only the preview and the digest.

More detail: [Data model: Key exposure and expiry](../architecture/data-model.md#key-exposure-and-expiry).

</details>

## What this does not do

Idempotency stops duplicate _tasks_. It does not make your handler run exactly once. Execution is
still [at-least-once](030-delivery-guarantees.md), so one task can run twice after a crash. These
are different problems, and you often need both fixes.

## Next

- [030-delivery-guarantees.md](030-delivery-guarantees.md) — the other half of the problem
- [220-schedules.md](220-schedules.md) — the same idea applied to cron firings
- [010-tasks-and-state.md](010-tasks-and-state.md) — what a task actually is

---

Exact fingerprint contents, limits, and conflict shape:
[`architecture/data-model.md`](../architecture/data-model.md#enqueue_idempotency).
