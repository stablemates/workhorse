# How do I wait for an external signal?

<!-- scenario-names: ord-381, review-77, review-service, review-78 -->

Some tasks need a decision or event that arrives from another process. A signal wait releases the
worker slot until an application or authenticated operator supplies a named JSON payload.

## One order, one approval

> **Example.** A task publishes order `ord-381`, but only after an external review service approves
> it. The handler asks for a signal named `approval`. The review service answers some hours later.

```ts
const approval = await ctx.waitForSignal<{ approved: boolean }>("approval");

if (approval.approved) await publishOrder();
```

1. **At 0 s** worker A claims the task and calls the handler. The handler reaches
   `ctx.waitForSignal("approval")`. Workhorse records a signal wait named `approval` and takes the
   task away from worker A. No worker can claim the task now. The handler stops there, and worker
   A's slot is free for other tasks.
2. **Between 0 s and 3 h** no worker holds the task. Worker A can even be replaced by a new
   deployment.
3. **At 3 h** the review service calls `Queue.sendSignal` for the task, with the name `approval` and
   the payload `{ "approved": true }`. In one transaction, Workhorse stores the payload, makes the
   task ready, and notifies workers.
4. **Shortly after** worker B claims the task and calls the handler **from the beginning**. The
   handler reaches `ctx.waitForSignal("approval")` again. This time the call returns the stored
   payload at once, and the handler publishes the order.

The handler restarts from its entry point, not from the middle. So code before the wait runs again.
Wrap earlier effects in a [checkpoint](030-delivery-guarantees.md) or make them idempotent. The
[durable waits guide](130-durable-waits.md) owns that replay rule.

The wait does not use up an attempt. Worker B's claim gets a new
[fence token](020-leases-and-fences.md), but it continues the same logical attempt. The stored
payload also survives later retries. If the handler fails after step 4 and retries, the `approval`
wait returns the same payload again.

Go handlers call `HandlerContext.WaitForSignal` with the same stable name. They can pass
`ExternalWaitOptions` when the wait needs a shorter lifetime.

<details>
<summary>Reference: declaring a signal wait</summary>

| SDK        | Handler call                                                 |
| ---------- | ------------------------------------------------------------ |
| TypeScript | `HandlerContext.waitForSignal(name, { timeoutMs })`          |
| Python     | `wait_for_signal(name, *, timeout_ms=None)`                  |
| Go         | `HandlerContext.WaitForSignal(name, ...ExternalWaitOptions)` |

| Limit                               | Value                                              |
| ----------------------------------- | -------------------------------------------------- |
| `MAX_EXTERNAL_WAIT_NAME_CHARACTERS` | 200 characters. No leading or trailing whitespace. |
| `MAX_EXTERNAL_WAITS_PER_TASK`       | 1,000 signal names per task                        |

**`wait_for_signal_v1` results**

| Status            | Meaning                                                                                          | TypeScript and Go result       |
| ----------------- | ------------------------------------------------------------------------------------------------ | ------------------------------ |
| `waiting`         | Inserts `task_signal_wait`, clears the owner, parks the task. Appends `signal_waiting`.          | The handler suspends.          |
| `delivered`       | The wait already has a payload. Appends `signal_replayed`.                                       | Returns the stored payload.    |
| `already_waiting` | The same wait is already pending.                                                                | `SignalWaitConflictError`      |
| `stale`           | The lease, fence, deadline, or execution timeout no longer holds, or cancellation was requested. | `SignalWaitLeaseLostError`     |
| `limit_exceeded`  | The task already holds the maximum number of signal names.                                       | `SignalWaitLimitExceededError` |

- The wait keeps the logical attempt open. It writes no failure, completion, or attempt-history
  row, and does not increment `current_attempt`.
- The parked runtime row is `scheduled`, outside the ready and active indexes, with `wait_name` set.
- A [fast-tier queue](305-fast-tier.md) rejects signal waits with `FastTierUnsupportedError`.

More detail: [Data model: Declaring a signal wait](../architecture/data-model.md#declaring-a-signal-wait).

</details>

## Delivery happens once

Go back to step 3. The review service sends the signal with the idempotency key `review-77` and the
actor `review-service`. Then several things go wrong at once.

1. **At 3 h** Workhorse accepts the delivery and resumes the task. The response is lost on the
   network.
2. **At 3 h + 5 s** the review service retries with the same key and the same payload. Workhorse
   returns `duplicate` with the stored payload. The task does not resume a second time.
3. **At 3 h + 1 min** a second reviewer sends `{ "approved": false }` with the key `review-78`.
   The wait already has a payload, so Workhorse returns `already_delivered` with the first payload.
   The first delivery wins.

Had the service reused the key `review-77` with a different payload or actor, Workhorse would have
refused it with a conflict error. A key names one request, so it cannot carry a changed one.

Delivery is idempotent at the state transition. Only the first accepted delivery resumes the task.
Workhorse also does not buffer a delivery that arrives too early. A signal sent before the handler
reaches `waitForSignal` returns `not_waiting`. The caller may retry after the handler declares the
wait.

Go applications call `Queue.SendSignal` with `ExternalWaitDelivery`. The result reports the status
and the stored payload. A changed request under a stored key returns a typed conflict error.

<details>
<summary>Reference: delivery request and statuses</summary>

**Request.** `Queue.sendSignal(taskId, name, payload, { idempotencyKey, requestedBy })`.

| Bound                                     | Limit                                         |
| ----------------------------------------- | --------------------------------------------- |
| `MAX_EXTERNAL_WAIT_VALUE_BYTES`           | Payload: 65,536 bytes of canonical JSONB text |
| `MAX_EXTERNAL_WAIT_IDEMPOTENCY_KEY_BYTES` | Key: 1 to 512 UTF-8 bytes                     |
| `MAX_EXTERNAL_WAIT_ACTOR_CHARACTERS`      | `requestedBy`: 1 to 200 characters            |

**`send_signal_v1` statuses**

| Status              | When                                                          | Dispatch state      |
| ------------------- | ------------------------------------------------------------- | ------------------- |
| `delivered`         | The wait is pending and owns the parked task.                 | Task becomes ready. |
| `duplicate`         | Same key, same payload and actor as the stored delivery.      | Unchanged.          |
| `already_delivered` | Another key, after a delivery was accepted.                   | Unchanged.          |
| `not_waiting`       | No wait with this name exists yet.                            | Unchanged.          |
| `stale`             | The wait no longer owns the task, or its deadline has passed. | Unchanged.          |
| `not_found`         | No task has this identity.                                    | Unchanged.          |

A same-key request with a changed payload or actor raises `SignalIdempotencyConflictError` in
TypeScript and Go.

- `send_signal_v1` takes the same advisory lock as `wait_for_signal_v1`, so delivery serializes
  with declaration and with competing deliveries.
- An accepted delivery gives the task a fresh FIFO sequence, restores the accepted task deadline,
  and sends `NOTIFY workhorse_tasks`.
- PostgreSQL stores only a SHA-256 hash of the key and a request fingerprint.
- `signal_received` and `signal_rejected` events record the actor and the first 12 hexadecimal
  characters of the key digest, never the raw key or payload. A rejection records its reason.

More detail: [Data model: Delivering a signal](../architecture/data-model.md#delivering-a-signal).

</details>

## An operator can answer from the dashboard

Suppose the review service is down. An operator opens the dashboard's `Waiting` task list and finds
the task for `ord-381`, marked as waiting for `approval`. In the task drawer, the operator enters
`{ "approved": true }` and sends it. The task resumes exactly as in step 3.

The dashboard counts pending external waits on its system page. Its delivery uses the same queue
operation as `Queue.sendSignal`. But its server replaces any browser-supplied attribution with the
host's audit actor. That is the signed-in operator whenever the host names one.
[370-dashboard-authentication.md](370-dashboard-authentication.md)
explains which actor each host records.

`requestedBy` is attribution only, not authorization. An application that calls `Queue.sendSignal`
must establish authorization before it calls the core API.

<details>
<summary>Reference: dashboard surfaces</summary>

- `/tasks?filter=waiting` marks open signal and human-decision waits.
- Task rows expose `signalWait` as `{ name, deadlineAt }`. Task detail returns `canSignal`.
- The task drawer calls the `dashboard.signalTask` procedure. It derives `requestedBy` from the
  host's audit actor: the authenticated principal, or the configured audit actor when the host
  authorized without one.
- `dashboard.humanWaits` returns the first default page of signal waits and human waits, plus the
  `QueueHealth.externalWaits` diagnostics.

More detail: [Data model: Dashboard waits](../architecture/data-model.md#dashboard-waits).

</details>

## Operator tools can list open waits

Go back to order `ord-381`. While its task waits on `approval`, an operator wants to see every open
signal wait.

1. **At 1 h** the operator's custom tool calls `Admin.listSignalWaits`. The first page holds the
   oldest open waits. One row names the task for `ord-381`, its queue, its task type, the signal
   name `approval`, the attempt, the creation time, and the effective deadline.
2. **Right after** the page returns `nextCursor`. The tool passes it back and reads the next page.
3. **Later** the review service delivers `approval`. The next listing no longer shows that wait.

A row never exposes a delivered payload. The tool keeps passing `nextCursor` back, so no wait beyond
the page bound stays hidden.

<details>
<summary>Reference: listing signal waits</summary>

`Admin.listSignalWaits({ limit, cursor })` returns a `SignalWaitPage`.

| Field        | Rule                                                                         |
| ------------ | ---------------------------------------------------------------------------- |
| `limit`      | 1 to 1,000 (`MAX_EXTERNAL_WAIT_LIST_SIZE`). Default 100.                     |
| Order        | Ascending `createdAt`, then `taskId`, then `name`.                           |
| `SignalWait` | `taskId`, `queue`, `taskType`, `name`, `attempt`, `createdAt`, `deadlineAt`. |
| `nextCursor` | `{ createdAt, taskId, name }` when another page exists, otherwise null.      |

`dashboard_signal_wait_v1` owns the SQL projection. It excludes delivered and stale waits.

More detail: [Data model: Listing signal waits](../architecture/data-model.md#listing-signal-waits).

</details>

## An unanswered wait still closes

This time the handler waits with a shorter lifetime: `ctx.waitForSignal("approval", { timeoutMs })`,
with a timeout of one day.

1. **At 0 s** the task parks on `approval`. Its boundary closes at 1 day.
2. **At 1 day** nobody has answered. Shortly after, a regular background pass fails the task with a
   deadline error. Workhorse starts no further attempt, because replay cannot continue without a
   payload.
3. **At 1 day + 10 min** the review service finally sends the signal. Workhorse returns `stale`
   and leaves the failed task as it is.

When the handler names no `timeoutMs`, Workhorse applies its longest supported wait instead. An
earlier task [deadline](140-deadlines-and-timeouts.md) wins over either. Choose a `timeoutMs` your
application can act on. The default is long enough that a wait can outlive the event it awaited.

[Cancellation](120-cancellation.md) also closes the wait, so a late delivery returns `stale`. The
signal row follows the parent task's safe [retention](330-retention.md).

<details>
<summary>Reference: timeout, deadline, and retention</summary>

| Value                            | Rule                                                     |
| -------------------------------- | -------------------------------------------------------- |
| `timeoutMs`                      | Optional. An integer from 1 to 604,800,000 ms (7 days).  |
| Default                          | `MAX_EXTERNAL_WAIT_TIMEOUT_MS`, 604,800,000 ms (7 days). |
| Go `ExternalWaitOptions.Timeout` | Zero or a whole-millisecond duration up to 7 days.       |

- The boundary is `LEAST(task deadline, declaration time + COALESCE(timeoutMs, 604800000) ms)`.
  `task_signal_wait.timeout_at` stores it.
- While the task waits, `task_runtime.deadline_at` holds that boundary. An accepted delivery
  restores the accepted task deadline.
- On expiry, `recover_expired_v1` calls `terminalize_deadline_v1`. The task fails with
  `DeadlineExceeded`, keeps its original attempt attribution, and never resumes without a payload.
- Until then, an overdue wait adds the critical `overdue-external-waits` health reason.
- Cancellation of a waiting task deletes the runtime row at once. Every later delivery returns
  `stale`.
- Signal rows have no retention window of their own. They are removed only with the parent `task`.

More detail: [Data model: Timeout and deadline](../architecture/data-model.md#timeout-and-deadline).

</details>

## Next

- [130-durable-waits.md](130-durable-waits.md) — pause until a time instead of an external event
- [030-delivery-guarantees.md](030-delivery-guarantees.md) — make replayed work safe
- [120-cancellation.md](120-cancellation.md) — close work that should no longer wait

---

Exact signal bounds, statuses, and SQL transitions:
[`architecture/lifecycle.md`](../architecture/lifecycle.md#durable-signal-suspension).
