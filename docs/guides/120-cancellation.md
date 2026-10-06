# What happens when I cancel a task?

<!-- scenario-names: export-report, import-rows -->

You cannot forcibly stop running JavaScript. No call outside a handler can stop a loop inside it.
Everything about how cancellation works in Workhorse follows from that one fact.

## If the task hasn't started

An `export-report` task is scheduled to run in 10 minutes. At 2 minutes, an operator cancels it.

1. The application calls `queue.cancel(taskId)`. `cancel_v1` locks the task's runtime row.
2. The task is `scheduled`, so no worker holds it. Workhorse deletes the runtime row and writes a
   `canceled` outcome in the same transaction.
3. The call returns the status `canceled`. Nothing ever ran, so Workhorse records no attempt.

A task in `ready` settles the same way. So does a task that is
[waiting on a timer](130-durable-waits.md), because no worker holds it either. One difference: if
the wait began partway through an attempt, Workhorse closes that attempt as canceled. The record
then keeps the work that had already started.

A task held by [dependencies](160-task-dependencies.md) also settles at once. Workhorse releases its
dependency edges in the same transaction, so they stop holding their prerequisites.

<details>
<summary>Reference: immediate cancellation</summary>

**`cancel_v1(p_task_id, p_requested_by, p_reason)`**

| Input         | Rule                             |
| ------------- | -------------------------------- |
| `requestedBy` | Optional. 1 to 200 characters.   |
| `reason`      | Optional. 1 to 2,000 characters. |

For a `ready`, `scheduled`, or `blocked` runtime, one transaction:

1. deletes the runtime row;
2. inserts a `canceled` outcome that carries the cancellation envelope;
3. inserts one `canceled` attempt-history row, only when the attempt had started before a durable
   wait;
4. appends a `canceled` event with `source = immediate`.

A never-started task gets fence token zero and no attempt row.

The outcome insert fires `task_outcome_resolve_dependencies_insert`. It marks every pending edge
into the canceled task as released, with resolution `release`.

| Status             | Meaning                                   |
| ------------------ | ----------------------------------------- |
| `canceled`         | The task is canceled now, or was already. |
| `cancel_requested` | The task is active. See the next section. |
| `already_terminal` | The task already succeeded or failed.     |
| `not_found`        | No task has this id.                      |

More detail: [Task lifecycle: Inactive work](../architecture/lifecycle.md#inactive-work) and [Task lifecycle: Cancellation](../architecture/lifecycle.md#cancellation).

</details>

## If a handler is running right now

Worker A runs an `import-rows` task. The handler loops over many rows. The worker uses the default
lease of 30 seconds, so it sends a heartbeat every 10 seconds.

1. **At 0 s — the claim.** Worker A claims the task, and the handler starts its loop.
2. **At 12 s — the request.** An operator calls `queue.cancel(taskId, { requestedBy, reason })`.
   `cancel_v1` cannot stop the handler. So it records the request on the runtime row, with who asked
   and why, and emits a `cancel_requested` event. The call returns `cancel_requested`. The task stays
   `active`.
3. **At 20 s — the heartbeat.** Worker A's next heartbeat comes back `cancel_requested`. Workhorse
   no longer renews the lease. The worker stops heartbeating and aborts the handler's `AbortSignal`
   with a `CancellationRequestedError`.
4. **At about 20 s — the handler stops.** Before the next row, the handler sees that the signal
   aborted. It returns.
5. **Right after — the acknowledgement.** The worker confirms the cancellation with its worker id and
   fence token. Workhorse writes the `canceled` outcome and closes the attempt as canceled.

Step 4 is yours. Suppose the handler ignores the signal and keeps going. Nothing stops it. The last
accepted heartbeat was at 10 s, so the lease expires at about 40 s. Recovery then finishes the
cancellation instead of retrying the task.

Once a cancellation is requested, the task ends canceled. If the handler returns, throws, or calls
complete, Workhorse refuses the completion or failure, and the worker confirms the cancellation. If
the handler runs past its lease, recovery confirms it. So the cancellation always lands, but your
code decides how quickly.

<details>
<summary>Reference: cooperative cancellation</summary>

1. **Request.** The first `cancel_v1` on an `active` runtime stores `cancel_requested_at`,
   `cancel_requested_by`, and `cancel_reason`. It appends one `cancel_requested` event. A repeat
   keeps the first metadata and appends nothing.
2. **Delivery.** `heartbeat_v1` and `heartbeat_many_v1` return `cancel_requested` and leave
   `expires_at` unchanged. The worker aborts the handler signal with `CancellationRequestedError`.
3. **Acknowledgement.** `acknowledge_cancel_v1(task_id, worker_id, fence_token)` accepts only the
   exact unexpired worker and fence. It writes one `canceled` outcome, one attempt-history row, and
   one `canceled` event with `source = acknowledged`.
4. **Recovery.** If the lease expires first, `recover_expired_v1` writes the same records with
   `source = recovered`, instead of a retry.

`complete_v1` and `fail_v1` reject a runtime that carries a cancellation request.

| Default (TypeScript) | Value                             |
| -------------------- | --------------------------------- |
| `leaseMs`            | 30,000 ms                         |
| `heartbeatMs`        | `max(100, floor(leaseMs / 3))` ms |

More detail: [Task lifecycle: Active work](../architecture/lifecycle.md#active-work) and [Task lifecycle: Worker options](../architecture/lifecycle.md#worker-options).

</details>

## What this means for handlers

Watch the `AbortSignal`. Pass it to your HTTP calls. Check it between steps of a long loop. When it
fires, stop starting new work and return. Do not start an API call you are about to abandon.

```ts
const handler = async (payload, ctx) => {
  for (const row of payload.rows) {
    if (ctx.signal.aborted) return; // stop between items
    await fetch(url, { body: row, signal: ctx.signal }); // and mid-request
  }
};
```

In the story, the rows imported before 20 s stay imported. Effects you already started are still
[at-least-once](030-delivery-guarantees.md). Cancellation undoes nothing. It only stops more from
happening. If you need to roll back, write that compensation logic yourself.

## Who wins a race

Worker A's handler for an `import-rows` task returns. At almost the same moment, an operator cancels
the task. Both writes need the same row lock, so one of them gets it first.

- **The cancellation is first.** It records the request. The completion then finds the request and
  is refused. The worker confirms the cancellation, and the task ends canceled.
- **The completion is first.** The task succeeds. The cancellation finds the outcome and reports
  `already_terminal`, with state `succeeded`.

Either way, the answer is consistent. A late write cannot bring back a finished task. Repeating
either request creates no duplicate events or outcomes.

<details>
<summary>Reference: races with terminal transitions</summary>

- `cancel_v1` locks the sole runtime row. That serializes it with completion, failure, checkpoint,
  wait, heartbeat, and recovery.
- The first transaction to commit wins.
- After cancellation commits, a stale completion, failure, checkpoint, wait, heartbeat, or
  acknowledgement cannot recreate the runtime or overwrite the outcome.
- After success or failure commits, `cancel_v1` returns `already_terminal` with that state.
- Repeated terminal requests do not duplicate events, outcomes, or attempt history.

More detail: [Task lifecycle: Races with terminal transitions](../architecture/lifecycle.md#races-with-terminal-transitions).

</details>

## One thing it is not

Go back to the `import-rows` task. Your app lets support staff cancel imports, but only for their
own team.

1. **At 12 s** a support user from another team presses cancel. Your app passes their name as
   `requestedBy` and calls `queue.cancel`.
2. **Right after** Workhorse records the request with that name and returns `cancel_requested`. It
   never asks whether that user may cancel the task.

`requestedBy` is recorded for the audit trail. Workhorse does **not** check whether that person was
allowed to cancel the task. Check permissions in your application before you call cancel.

<details>
<summary>Reference: cancellation attribution</summary>

- `requestedBy` is optional and holds 1 to 200 characters.
- An active task stores it in `cancel_requested_by`. The `canceled` outcome carries it in the
  cancellation envelope.
- `requestedBy` is audit attribution only. `cancel_v1` performs no authorization check.
  Authorization belongs to the calling application or operator layer.

More detail: [Task lifecycle: Active work](../architecture/lifecycle.md#active-work) and [Task lifecycle: Cancellation](../architecture/lifecycle.md#cancellation).

</details>

## Next

- [130-durable-waits.md](130-durable-waits.md) — cancelling a task that's asleep
- [140-deadlines-and-timeouts.md](140-deadlines-and-timeouts.md) — the other reason your signal aborts
- [310-workers.md](310-workers.md) — pausing a worker, which is cooperative in the same way

---

Exact transitions and race guarantees:
[`architecture/lifecycle.md`](../architecture/lifecycle.md#cancellation).
