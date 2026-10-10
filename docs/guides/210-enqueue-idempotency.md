# How do I stop a repeated request from enqueueing a second task?

<!-- scenario-names: order-123 -->

Sometimes your application sends the same enqueue request two times. For example, a user clicks a
button two times, or a webhook provider sends the same event again. Enqueue idempotency makes sure
that Workhorse creates only one task for these requests. The second request gets the task that the
first request created.

## Prevent a duplicate task

**Example.** Invoice `7781` is ready for capture. Your API endpoint enqueues the task type
`invoice.capture` with the idempotency key `capture:7781` in the scope `invoice-capture`. The user
clicks two times, so the endpoint runs two times. Workhorse creates the task for the first request.
For the second request, Workhorse creates nothing and returns the same `taskId`.

```ts
const taskId = await queue.enqueue(
  "invoice.capture",
  { invoiceId },
  {
    queue: "billing",
    idempotency: { key: `capture:${invoiceId}`, scope: "invoice-capture" },
  },
);
```

To choose a key, use the identity of the operation that must occur one time. For example, use the
invoice number or the webhook delivery ID. Do not use a timestamp or a random value. These values
are different for each request, so Workhorse cannot find a duplicate.

If two app servers send the same request at the same time, PostgreSQL lets one request bind the
key. The other request waits. Then it gets the same task.

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

## Keep the keys of different features apart

A key is unique in its scope. If you do not give a scope, Workhorse uses the scope `default`.

For example, the email feature and the warehouse feature both use the key `order-123` for different
tasks. Both use the scope `default`. Thus, the second request gets a conflict error, and Workhorse
does not create its task.

To prevent this, give each feature its own `scope`. Use the scope `default` only if each key
already contains the name of its feature.

<details>
<summary>Reference: scope and key hash</summary>

- The default scope is `"default"`.
- `idempotency_key_hash` is the full SHA-256 of the scope and key ownership input.
- Debounce and throttle keys share the same relation and the same scopes. A key in use by one mode
  is not free for another. The keyed modes are mutually exclusive on one request.

More detail: [Data model: Key and limits](../architecture/data-model.md#key-and-limits).

</details>

## Find out if a request was a duplicate

`Queue.enqueue` returns only the task ID. To find out if Workhorse created a new task, use
`Queue.enqueueWithResult`. Its `outcome` is `accepted` for a new task and `replayed` for a duplicate
request. The other outcomes are for [debounce](215-debounce.md) and [throttle](217-throttle.md).

```ts
const result = await queue.enqueueWithResult(
  "invoice.capture",
  { invoiceId },
  { idempotency: { key, scope: "invoice-capture" } },
);
```

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

## Set how long a key stays active

Each key has a time limit. `ttlMs` sets this limit.

- Before the time limit, a repeated request gets the original task. This is also true after the task
  is complete.
- After the time limit, the same request creates a new task.

A repeated request does not make the time limit longer. Set `ttlMs` to the longest time in which a
client can repeat a request. For example, use the redelivery period of your webhook provider.

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

## Do not use one key for different data

Workhorse records the first request: its queue, its task type, its payload, and its options. Each
later request with the same key must be the same. If the payload or an option is different,
Workhorse raises a conflict error. The original task does not change, and Workhorse does not create
a second task.

The conflict error stops the full enqueue statement. If you enqueue in your own transaction, the
transaction fails too. The error shows the existing task and the fields that are different.

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

## Keep keys private

Workhorse does not store the key. It stores a hash of the key. Events, errors, and the dashboard
show only a short preview and a digest of the key. Thus, you can make a key from an internal
identifier, and the people who look at the dashboard do not see its full value.

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

## Make the handler safe to run again

Enqueue idempotency prevents duplicate tasks. It does not make sure that a task runs only one time.
Workhorse runs each task [at least one time](030-delivery-guarantees.md). If a worker stops during an attempt,
another worker runs the same task after the [lease](020-leases-and-fences.md) expires.

If a repeated external action can cause a problem, give the external system its own idempotency key.
Use the task ID or a business ID. `HandlerContext.checkpoint` can also skip a part of the handler
that is complete. But a crash can occur after the external action and before the checkpoint. Then
the action can occur again. Only the idempotency key of the external system prevents this.

## Next

- [030-delivery-guarantees.md](030-delivery-guarantees.md) — the other half of the problem
- [220-schedules.md](220-schedules.md) — the same idea applied to cron firings
- [010-tasks-and-state.md](010-tasks-and-state.md) — what a task actually is

---

Exact fingerprint contents, limits, and conflict shape:
[`architecture/data-model.md`](../architecture/data-model.md#enqueue_idempotency).
