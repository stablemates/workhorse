# What happens when I cancel a task?

<!-- scenario-names: order.upload -->

Cancellation ends a task that your app does not need. A call from outside a handler cannot stop
JavaScript code that runs in the handler. Thus, Workhorse cancels a task at once only if no worker
holds it. If a handler runs, Workhorse asks the handler to stop, and the handler decides when it
stops.

## Cancel a task that has not started

**Example.** An `order.upload` task sends the files of an order to a customer. The task is scheduled
to run in 10 min. At 2 min, the customer withdraws the order.

1. Your app calls `queue.cancel` with the ID of the task and the reason.
2. The task is `scheduled`, so no worker holds it. Workhorse cancels the task at once.
3. The call returns the status `canceled`. No attempt started, so Workhorse records no attempt.

Thus, if no worker holds a task, cancellation ends the task in one step.

```ts
const result = await queue.cancel(taskId, {
  requestedBy: actor.email,
  reason: "customer withdrew the order",
});
```

A `ready` task is canceled in the same way. A task in a [durable wait](130-durable-waits.md) is also
canceled at once, because no worker holds it. If the wait started during an attempt, Workhorse
closes that attempt as canceled. A task that never started gets no attempt history.

A task that waits for its [dependencies](160-task-dependencies.md) is also canceled at once.
Workhorse releases its dependency edges in the same transaction. Thus, the edges stop holding the
tasks that it waited for.

If a [schedule](220-schedules.md) created the task, cancellation ends only that task. The schedule
stays enabled and creates its next task as usual.

Each SDK uses the same cancellation function in PostgreSQL. Thus, cancellation has the same result
in each language.

<details>
<summary>Reference: immediate cancellation</summary>

**`cancel_v1(p_task_id, p_requested_by, p_reason)`**

| Input         | Rule                             |
| ------------- | -------------------------------- |
| `requestedBy` | Optional. 1 to 200 characters.   |
| `reason`      | Optional. 1 to 2,000 characters. |

`cancel_v1` locks the runtime row of the task. For a `ready`, `scheduled`, or `blocked` runtime, one
transaction:

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

Canceling one task that a recurring schedule created does not disable the schedule definition or
change its revision. The next occurrence enqueues independently.

More detail: [Task lifecycle: Inactive work](../architecture/lifecycle.md#inactive-work), [Task lifecycle: Cancellation](../architecture/lifecycle.md#cancellation), and [Task lifecycle: Races with terminal transitions](../architecture/lifecycle.md#races-with-terminal-transitions).

</details>

## Stop a handler that runs

**Example.** Worker A runs the `order.upload` task. The handler uploads many parts in a loop. The
worker uses the default lease and heartbeat interval, so it sends a heartbeat each 10 s.

1. At 0 s, worker A claims the task, and the handler starts its loop.
2. At 12 s, an operator cancels the task. Workhorse records the request and returns
   `cancel_requested`. The task stays `active`.
3. At 20 s, the next heartbeat of worker A returns `cancel_requested`. The worker aborts
   `ctx.signal`.
4. Before the next part, the handler sees the aborted signal and stops.
5. The worker confirms the cancellation. Workhorse writes the `canceled` outcome and closes the
   attempt as canceled.

Thus, Workhorse asks the handler to stop, and the handler decides when it stops.

If the handler does not obey the signal, nothing stops the handler. Workhorse does not extend the
lease after the request. In the example, the last accepted heartbeat was at 10 s. Thus, the lease
expires at about 40 s. Then recovery cancels the task, and Workhorse does not schedule another
attempt.

After a cancellation request, the task always ends `canceled`. If the handler returns, throws an
error, or completes the task, Workhorse refuses the completion or the failure. Then the worker
confirms the cancellation. If the handler runs after its lease expires, recovery confirms the
cancellation. Your handler code decides how quickly the cancellation occurs.

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

## Make the handler obey the signal

Pass `ctx.signal` to each API that accepts an `AbortSignal`. Check the signal between units of
work. If the signal is aborted, start no new work and throw `ctx.signal.reason`. Do not start an API
call that you then cannot use.

```ts
for (const part of payload.parts) {
  if (ctx.signal.aborted) throw ctx.signal.reason;
  await uploadPart(part, { signal: ctx.signal });
}
```

If the handler throws `ctx.signal.reason`, the worker confirms the cancellation. The same signal is
also aborted for a [deadline or an execution timeout](140-deadlines-and-timeouts.md). Each case has
a different reason. Thus, one pattern stops the handler in all three cases.

Cancellation does not undo effects that the handler started. In the example, the parts that the
handler uploaded before 20 s stay uploaded. These effects are
[at-least-once](030-delivery-guarantees.md). Make each effect safe if it occurs more than one time.
If you must reverse an effect, write the code that reverses it.

## Know which result wins a race

**Example.** The handler of worker A for the `order.upload` task returns. At almost the same time,
an operator cancels the task. Both writes need the lock on the same runtime row. One write gets the
lock first.

- If the cancellation is first, Workhorse records the request. Then Workhorse refuses the
  completion. The worker confirms the cancellation, and the task ends `canceled`.
- If the completion is first, the task succeeds. The cancellation finds the outcome and returns
  `already_terminal`. The result also gives the final state, `succeeded`.

Thus, the first write that commits wins. A late write cannot change a task that ended. If you
cancel a task again, Workhorse returns the request or the outcome that exists. Workhorse does not
make duplicate events or outcomes.

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

## Check permissions before you cancel

**Example.** Your app lets support staff cancel uploads, but only for their own team.

1. At 12 s, a support user from a different team cancels the `order.upload` task. Your app gives the
   name of the user as `requestedBy` and calls `queue.cancel`.
2. Workhorse records the request with that name and returns `cancel_requested`. Workhorse does not
   check if that user can cancel the task.

Thus, `requestedBy` and `reason` are only a record for the audit. Workhorse does not check
permissions. Your app must check the permissions of the user before it calls `queue.cancel`.

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

- [130-durable-waits.md](130-durable-waits.md) — cancel a task that is in a durable wait
- [140-deadlines-and-timeouts.md](140-deadlines-and-timeouts.md) — the other reasons that abort the
  signal
- [310-workers.md](310-workers.md) — pause a worker, which also does not stop a running handler

---

Exact transitions and race guarantees:
[`architecture/lifecycle.md`](../architecture/lifecycle.md#cancellation).
