# How do I replace work while updates continue to arrive?

<!-- scenario-names: doc-42 -->

Some work is important only in its latest version. For example, a search index must show the latest
text of a document. Keyed debounce keeps one pending task for each key. Each new request with that
key replaces the payload of the task, until the task starts.

## Replace a pending task while updates arrive

**Example.** A user edits document `doc-42`. Each edit sends a request to rebuild the search index
for `doc-42`. Each request uses the key `doc-42` and a window of 2 s.

1. At 0 s, the user saves revision 1. Workhorse creates a task that runs at 2 s. The outcome is
   `accepted`.
2. At 1 s, the user saves revision 2. Workhorse puts revision 2 in the pending task and moves its
   run time to 3 s. The outcome is `replaced`, with the same `taskId`.
3. At 2.5 s, the user saves revision 3. Workhorse replaces the payload again and moves the run time
   to 4.5 s.
4. Soon after 4.5 s, a worker indexes revision 3.

Three requests make one task, and the task uses the latest revision. Each request gets the same
`taskId`, so your app can follow the work with one ID.

To use debounce, give a `debounce` key and a window when you enqueue the task.

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

If two app servers send a request with the same key at the same time, PostgreSQL runs the requests
one at a time. Both requests get the same `taskId`. The payload of the second request stays in the
task.

<details>
<summary>Reference: options and results</summary>

**`EnqueueOptions.debounce`**

| Field      | Rule                                                        |
| ---------- | ----------------------------------------------------------- |
| `key`      | Required. 1 to 512 UTF-8 bytes.                             |
| `scope`    | Optional. 1 to 256 UTF-8 bytes. The default is `"default"`. |
| `windowMs` | Required. An integer from 1 to 31,536,000,000 (365 days).   |
| `schedule` | Required. `reset` or `preserve`.                            |

The key is unique in its scope.

**Start time.** PostgreSQL sets the first run time to `clock_timestamp() + windowMs`. The key window
ends at the run time. The two values move together.

**Results.** `enqueueWithResult` returns `{ taskId, outcome }`. A `non_replaceable` result also has
a `reason`.

| `outcome`         | When                                                         |
| ----------------- | ------------------------------------------------------------ |
| `accepted`        | No live task has this key. Workhorse creates a new task.     |
| `replaced`        | A pending task has this key. Workhorse replaces its payload. |
| `non_replaceable` | A task has this key, but Workhorse cannot replace the task.  |

**Concurrency.** `enqueue_debounce_v1` takes a transaction advisory lock on the scope and key.
Concurrent requests for one key run one at a time.

**Storage.** PostgreSQL stores a hash of the key. It does not store the raw key. Events show a
short preview and the first 12 hexadecimal characters of the key digest.

More detail: [Task lifecycle: Keyed debounce](../architecture/lifecycle.md#keyed-debounce).

</details>

## Choose to reset or preserve the run time

The `schedule` option sets what a replacement does to the run time. In the first example, each
edit moves the run time. That is `schedule: "reset"`. If the user never stops typing, the task
never runs. Use `reset` if the work must run only after the requests stop.

**Example.** The first two edits of `doc-42` use `schedule: "preserve"`.

1. At 0 s, the user saves revision 1. Workhorse creates a task that runs at 2 s.
2. At 1 s, the user saves revision 2. Workhorse replaces the payload. The run time stays at 2 s.
3. Soon after 2 s, a worker indexes revision 2.

With `preserve`, the first request sets the run time. Later requests replace only the payload. The
task runs with the last revision that arrives before its run time. Use `preserve` if the work must
run by a known time while requests continue to arrive.

<details>
<summary>Reference: schedule policies</summary>

| `schedule` | Run time on replacement        | Key window on replacement |
| ---------- | ------------------------------ | ------------------------- |
| `reset`    | `clock_timestamp() + windowMs` | Ends at the new run time. |
| `preserve` | Unchanged                      | Unchanged.                |

Each replacement keeps the task ID and the attempt number. It appends a `debounced` event. The event
records the key preview and digest, the schedule policy, the window, the new expiry, and the digests
of the old and new requests.

More detail: [Task lifecycle: Replacement](../architecture/lifecycle.md#replacement).

</details>

## Handle updates after the task starts

Workhorse can replace the payload only while the task is pending. A worker uses the payload of a
running task, so Workhorse cannot change it.

**Example.** The task for `doc-42` holds revision 3. Its window closed at 4.5 s.

1. At 4.6 s, a worker starts the task.
2. At 5 s, the user saves revision 4.
3. Workhorse creates a second task for revision 4, with a new `taskId`. The outcome is `accepted`.
4. If no other edit arrives, a worker runs the second task soon after 7 s.

After the window closes and the task starts, Workhorse treats a new request as new work.

In other cases, a task for the key exists, but Workhorse cannot replace it. Then the outcome is
`non_replaceable`. Workhorse discards the new payload and returns the `taskId` of the existing task.
The existing task does not change. The `reason` of the result tells why. The reason is stable.
Thus, your app can tell a change of the task state from an incompatible request:

- **`not_pending`.** The window is open, but the task is not pending. The task started, is in a
  durable wait, waits for a retry, or ended. For example, an operator canceled it.
- **`window_elapsed_pending`.** The window is closed, but no worker started the task. This reason
  also applies to a task that is in a durable wait or waits for a retry after its window. Workhorse
  does not create a new task in this case. Otherwise, a late request can add a second live task
  next to work that is already late.
- **`incompatible_key_mode`.** The key is in use for enqueue idempotency or throttle, not for
  debounce.

<details>
<summary>Reference: replacement conditions and refusals</summary>

**Replacement.** PostgreSQL replaces the pending task only when all of these conditions are true:

1. The key window is still open.
2. Debounce created the key.
3. The task is `scheduled` or `ready`.
4. `attempt_started_at` and `wait_name` are null.
5. `current_attempt` is 1.

**Decision table**

| Key window | Task state                          | Result                                      |
| ---------- | ----------------------------------- | ------------------------------------------- |
| Open       | Pending, never started              | `replaced`                                  |
| Open       | Started, waiting, retrying, ended   | `non_replaceable`, `not_pending`            |
| Open       | Key held by idempotency or throttle | `non_replaceable`, `incompatible_key_mode`  |
| Ended      | `ready` or `scheduled`              | `non_replaceable`, `window_elapsed_pending` |
| Ended      | `active` or ended                   | `accepted`, new task                        |

A refusal appends a `debounce_rejected` event with the same reason. PostgreSQL discards the new
payload. The accepted task does not change.

More detail: [Task lifecycle: Rejection](../architecture/lifecycle.md#rejection).

</details>

## Use one keyed mode in each request

A keyed mode is enqueue idempotency, debounce, or throttle. One request cannot use debounce with
[enqueue idempotency](210-enqueue-idempotency.md) or with [throttle](217-throttle.md). If a request
sets two keyed modes, the SDK rejects it before it sends a query. Workhorse creates no task.

Each keyed mode gives a repeated key a different meaning. Idempotency returns the same task for an
equal request and rejects a changed request. Debounce accepts a changed payload while one task
stays pending.

A debounced task also cannot set `dependencies` or the deprecated `prerequisiteTaskId`. A
replacement changes the accepted task, but the dependencies of a task must not change after
acceptance. If the task must wait for other work, use a regular
[dependent task](160-task-dependencies.md).

<details>
<summary>Reference: options that cannot be combined with debounce</summary>

A request with `debounce` cannot also set:

- `idempotency`;
- `throttle`;
- `runAt`, because the debounce window sets the run time;
- `prerequisiteTaskId`;
- `dependencies`.

The SDK rejects these combinations before it sends a query. `enqueue_debounce_v1` rejects them for
direct SQL calls. A fast-tier queue rejects debounce.

More detail: [Task lifecycle: Keyed debounce](../architecture/lifecycle.md#keyed-debounce).

</details>

## Release a key before its window ends

Usually, a key is free again when its window closes. Two operator actions release a key earlier. If
an operator purges the queue, the next request with the key creates a new task. If an operator runs
a debounced task now, from the dashboard or with `Admin.runTaskNow`, its window ends. The next
request with that key creates a new task.

<details>
<summary>Reference: operator actions</summary>

- A queue purge deletes the key before the task. The next request is `accepted`.
- `run_task_now_v1` deletes the key of the released task. The next request is `accepted` as a new
  task.

More detail: [Task lifecycle: Fresh acceptance](../architecture/lifecycle.md#fresh-acceptance).

</details>

## Next

- [210-enqueue-idempotency.md](210-enqueue-idempotency.md) — return the same task for a repeated
  request
- [220-schedules.md](220-schedules.md) — run recurring work from calendar rules
- [010-tasks-and-state.md](010-tasks-and-state.md) — the states that decide if Workhorse can
  replace a task

---

Exact SQL functions, limits, outcomes, and lifecycle events:
[`architecture/lifecycle.md`](../architecture/lifecycle.md#keyed-debounce).
