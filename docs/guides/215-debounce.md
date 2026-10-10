# How do I replace work while updates keep arriving?

<!-- scenario-names: doc-42 -->

Some work only matters in its latest version. Keyed debounce keeps one pending task per key and lets
each new request replace that task's payload until the task runs.

## One document, three edits, one task

**Example.** A user edits document `doc-42`. Your app wants to rebuild the search index for it, but
only once the user stops typing. So every edit sends the same request: rebuild `doc-42`, with key
`doc-42` and a quiet period of two seconds.

1. **At 0 s** the user saves revision 1. Workhorse creates a task and schedules it for 2 s. The
   result is `accepted`, with a new `taskId`.
2. **At 1 s** the user saves revision 2. A task for `doc-42` is still waiting, so Workhorse replaces
   its payload with revision 2. The quiet period starts again, so the task now runs at 3 s. The
   result is `replaced`, with the same `taskId`.
3. **At 2.5 s** the user saves revision 3. Workhorse replaces the payload again and moves the run
   time to 4.5 s.
4. **At 4.5 s** the user has stopped typing, and the task is due. Shortly after, promotion, a
   regular background pass that moves due tasks to `ready`, makes it ready. A worker picks it up
   and indexes revision 3.

Three requests produced one task and one rebuild, and the rebuild used the latest revision. Every
request got the same `taskId` back, so your app can track the work without knowing about the
replacements.

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

PostgreSQL decides each replacement. If two app servers send a request for `doc-42` at the same
moment, the database handles them one after the other. Both get the same `taskId`, and the later
request's payload wins.

<details>
<summary>Reference: options and results</summary>

**`EnqueueOptions.debounce`**

| Field      | Rule                                                        |
| ---------- | ----------------------------------------------------------- |
| `key`      | Required. 1 to 512 UTF-8 bytes.                             |
| `scope`    | Optional. 1 to 256 UTF-8 bytes. The default is `"default"`. |
| `windowMs` | Required. An integer from 1 to 31,536,000,000 (365 days).   |
| `schedule` | Required. `reset` or `preserve`.                            |

The key is unique within its scope.

**Start time.** PostgreSQL sets the first run time to `clock_timestamp() + windowMs`. The key window
ends at the run time. Both move together.

**Results.** `enqueueWithResult` returns `{ taskId, outcome }`. A `non_replaceable` result also has
a `reason`.

| `outcome`         | When                                                         |
| ----------------- | ------------------------------------------------------------ |
| `accepted`        | No live task has this key. Workhorse creates a new task.     |
| `replaced`        | A pending task has this key. Workhorse replaced its payload. |
| `non_replaceable` | A task has this key, but Workhorse cannot replace it.        |

**Concurrency.** `enqueue_debounce_v1` takes a transaction advisory lock on the scope and key.
Concurrent requests for one key run one at a time.

**Storage.** PostgreSQL stores a hash of the key, never the raw key. Events show a short preview and
the first 12 hexadecimal characters of the key digest.

More detail: [Task lifecycle: Keyed debounce](../architecture/lifecycle.md#keyed-debounce).

</details>

## Reset or preserve the schedule

In the example, every edit started the quiet period again. That is `schedule: "reset"`. A user who
never stops typing never gets a rebuild, so pick `reset` when you want the work to run only after
the requests stop.

Now replay the first two edits with `schedule: "preserve"`:

1. **At 0 s** revision 1 creates the task and schedules it for 2 s.
2. **At 1 s** revision 2 replaces the payload. The run time stays at 2 s.
3. **At 2 s** the task is due. Shortly after, a worker indexes revision 2.

With `schedule: "preserve"`, the first request fixes the run time. Later requests only replace the
payload, so the task runs with whichever revision arrived last before its run time. Pick `preserve`
when the work must run by a known time, even while requests keep arriving.

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

## Replacement stops when processing starts

Go back to the example. At 5 s the indexer is rebuilding `doc-42` with revision 3, and the user
saves revision 4. The running task cannot take a new payload, because a worker is already using the
old one. The quiet period for that task is over. So Workhorse treats revision 4 as new work and
creates a second task, with a new `taskId`, that waits its own quiet period.

A request is refused, with the outcome `non_replaceable`, in a narrower case: a task for the key
still exists but cannot be changed. Workhorse then drops the new payload and returns the existing
task's `taskId`. The existing task keeps its payload. The result's `reason` says why:

- **`not_pending`.** The quiet period is still open, but the task can no longer be replaced. It has
  started, it is waiting durably, it is backing off before a retry, or it has ended, for example
  because someone canceled it.
- **`window_elapsed_pending`.** The quiet period is over, but no worker has started the task yet.
  This also covers a task that waits durably or backs off before a retry after its quiet period.
  Workhorse refuses a new task here. Otherwise a late request would put a second live task beside
  work that is already overdue.
- **`incompatible_key_mode`.** The key is in use for enqueue idempotency or throttle, not
  debounce.

Two operator actions end a key early. After an operator purges the queue, the same key accepts a
fresh task. After an operator runs a debounced task now, its quiet period ends, so the next request
with that key creates a new task.

<details>
<summary>Reference: replacement conditions and refusals</summary>

**Replacement.** PostgreSQL replaces the pending task only when all of these are true:

1. The key window is still open.
2. The key was created by debounce.
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

**Operator actions**

- A queue purge deletes the key before the task. The next request is `accepted`.
- `run_task_now_v1` deletes the key of the released task. The next request is `accepted` as a new
  task.

More detail: [Task lifecycle: Rejection](../architecture/lifecycle.md#rejection).

</details>

## Debounce is not idempotency

Suppose the request for `doc-42` also sets an
[enqueue idempotency](210-enqueue-idempotency.md) key. At 0 s your app sends it. The SDK rejects the
request before it sends a query, and no task exists.

Debounce and enqueue idempotency solve different problems.
Idempotency replays an equivalent request and rejects a changed one. Debounce deliberately accepts a
changed payload while one task stays pending. So one request cannot use both.

A debounced task also cannot declare the deprecated `prerequisiteTaskId` or `dependencies`.
Replacement changes the accepted task, but dependency edges must stay stable after acceptance. Use a
regular [dependent task](160-task-dependencies.md) when dispatch must wait for other work.

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

## Next

- [210-enqueue-idempotency.md](210-enqueue-idempotency.md) — replaying an identical request safely
- [220-schedules.md](220-schedules.md) — recurring work from calendar rules
- [010-tasks-and-state.md](010-tasks-and-state.md) — the states that decide replacement eligibility

---

Exact SQL functions, limits, outcomes, and lifecycle events:
[`architecture/lifecycle.md`](../architecture/lifecycle.md#keyed-debounce).
