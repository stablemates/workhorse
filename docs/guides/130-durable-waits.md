# How does a task wait without holding a worker?

<!-- scenario-names: place, placeOrder -->

Some tasks need to pause: before a reminder, before polling an external system again, or until a
known time. A durable wait pauses the task without keeping a worker busy, however long the pause
lasts.

The naive way is to sleep inside the handler. That wastes capacity. A worker runs a limited number
of tasks at once, and a sleeping handler holds one of those slots while it does nothing.

## One order, one wait, two workers

> **Example.** A handler places an order, waits two hours for payment to settle, and then confirms
> the order.

```ts
const handler = async (payload, ctx) => {
  // runs twice — once now, once after the wait — so it must be checkpointed
  const order = await ctx.checkpoint("place", () => placeOrder(payload));

  await ctx.sleep("settle", settlementDelayMs); // slot is released here

  await confirm(order.id);
};
```

This is what happens:

1. At 14:00 worker A claims the task and calls the handler. The `place` checkpoint places the order,
   and Workhorse saves the result under the name `place`.
2. The handler calls `ctx.sleep("settle", …)`. Workhorse records a wait named `settle` that ends at
   16:00. It takes the task away from worker A and marks it `scheduled` for 16:00. The handler stops
   there, and worker A's slot is free for other tasks.
3. Between 14:00 and 16:00, no worker holds the task. Worker A can even be replaced by a new
   deployment.
4. At 16:00 the task is due. Promotion, a regular background pass that moves due tasks to
   `ready`, makes it ready, and worker B claims it.
5. Worker B calls the handler **from the beginning**. The `place` checkpoint finds the saved result
   and returns it, so no second order is placed. The `settle` wait has already ended, so
   `ctx.sleep` returns at once. The handler confirms the order.

Waits are named. The name tells Workhorse, on the second pass, that `settle` has already ended and
the handler should continue past it.

<details>
<summary>Reference: wait API and limits</summary>

| SDK                                               | Duration                   | Absolute time                |
| ------------------------------------------------- | -------------------------- | ---------------------------- |
| TypeScript `HandlerContext`                       | `sleep(name, durationMs)`  | `sleepUntil(name, wakeAt)`   |
| Python `HandlerContext` and `AsyncHandlerContext` | `sleep(name, duration_ms)` | `sleep_until(name, wake_at)` |

| Limit                                      | Value                                                |
| ------------------------------------------ | ---------------------------------------------------- |
| Wait name                                  | 1 to 200 characters                                  |
| Duration, or first absolute target horizon | 31,536,000,000 ms (365 days), `MAX_WAIT_DURATION_MS` |

**`schedule_wait_v1` cases**

| Case                            | Result                                                                                         |
| ------------------------------- | ---------------------------------------------------------------------------------------------- |
| First target in the future      | Inserts `task_wait`. Sets the task to `scheduled`. Clears the owner. Appends `wait_scheduled`. |
| First target already past       | Records the wait. The task stays `active`. The call returns at once.                           |
| Same relative wait on replay    | Returns the first stored target, even if the duration changed.                                 |
| Changed absolute target or mode | Conflict. See "When a replay conflicts with saved results".                                    |
| Replay reaches an ended wait    | Appends `wait_replayed`. The call returns at once.                                             |

Promotion appends `wait_elapsed` when it makes a waiting task ready.

A [fast-tier queue](305-fast-tier.md) rejects durable waits. That tier keeps no durable execution
state.

More detail: [Task lifecycle: Scheduling a timer wait](../architecture/lifecycle.md#scheduling-a-timer-wait).

</details>

## The catch: your handler restarts from the top

Go back to the order. Worker A ran the first part at 14:00, and worker B runs the rest at 16:00.

1. **At 16:00** worker B calls the handler. It does not start at the line after `ctx.sleep`. It
   starts at the first line.
2. **Right after** the handler reaches the `place` checkpoint again. The checkpoint returns the
   saved order, so `placeOrder` does not run a second time.
3. **Then** the handler reaches `ctx.sleep("settle", …)`. The wait has ended, so the call returns at
   once, and the handler confirms the order.

This is the part that surprises people. When the task continues, Workhorse calls your handler
**again, from the beginning**. It does not continue in the middle of the function. There is no saved
call stack: the process that ran the first part may be gone, and a newer deployment may run the
second part.

So the code before a wait runs again after the wait. That means:

> Everything before a wait must be safe to run again.

Make that code idempotent, or wrap it in a [checkpoint](030-delivery-guarantees.md), as `place` is
in the example. The second pass then reuses the saved result instead of doing the work again.

Do not catch the control signal that `ctx.sleep` or `ctx.sleepUntil` throws to stop the handler. If
a handler catches it and returns, the worker still honors the recorded wait, and it logs a warning
that the signal was swallowed. But any side effects after the catch have already happened, and
nothing can undo them.

<details>
<summary>Reference: suspension and a swallowed signal</summary>

At suspension, the worker:

1. aborts the cooperative signal of the handler;
2. leaves the handler through private control flow;
3. stops the heartbeat of the task;
4. frees the slot for another claim.

If the handler catches the signal and returns, the worker applies the recorded suspension. It emits
`workhorse.handler.signal_swallowed` at warning severity, with
`workhorse.handler.outcome = suspended`.

More detail: [Task lifecycle: Worker suspension](../architecture/lifecycle.md#worker-suspension).

</details>

## Waiting is not failing

Go back to the order.

1. **At 14:00** worker A claims the task for attempt 1.
2. **At 14:00, a moment later,** the handler calls `ctx.sleep`. Worker A gives up the task. Nothing
   failed, and Workhorse schedules no retry.
3. **At 16:00** worker B claims the task. The attempt counter still reads 1. Worker B's claim
   carries a new [fence token](020-leases-and-fences.md).

The task paused for two hours, but it did not fail and it did not retry. A wait does **not** use up
an attempt. The attempt counter stays where it was.

This is deliberate. Waiting is a normal part of the task's work, not a sign that something went
wrong. A task that sleeps many times stays in the same logical attempt. Each wake is a new claim
with a new fence token, but the attempt is the same.

<details>
<summary>Reference: attempt and fence</summary>

- A suspension calls neither failure nor completion.
- A suspension does not increment `current_attempt`.
- A suspension writes no attempt-history row.
- Each wake makes the same attempt claimable under a new fence token.

More detail: [Task lifecycle: Durable timer suspension](../architecture/lifecycle.md#durable-timer-suspension).

</details>

## When it wakes up

Go back to the order. The story said worker B claimed the task "at 16:00". This is what happens
around that moment.

1. **At 16:00** the `settle` wait ends. The task becomes eligible, but it is still `scheduled`.
2. **A moment later** promotion runs on its regular interval and makes the task `ready`.
3. **Then** worker B has a free slot and claims the task.

So the wake time means "becomes eligible at 16:00". The task starts shortly after 16:00, not
exactly at 16:00. Promotion runs on a regular interval, and a worker must have a free slot.

Do not build anything that needs precise timing on top of this. A durable wait is a sleep that
survives restarts, not a real-time scheduler.

<details>
<summary>Reference: wake latency</summary>

- Each worker calls `tick_v1` once per `maintenanceIntervalMs`. The TypeScript default is 1,000 ms.
  Each tick promotes a bounded batch of due tasks.
- Promotion makes the task eligible. A free worker slot is then needed to claim it.
- Workhorse gives no exact wall-clock guarantee.
- Queue health reports the number of sleeping and overdue waits, and the next durable wake target.

More detail: [Task lifecycle: Maintenance cadence](../architecture/lifecycle.md#maintenance-cadence).

</details>

## When a replay conflicts with saved results

Suppose a deployment changes the handler while the task waits. On the second pass, the `settle`
wait now asks for a different absolute time than the one Workhorse stored. Retrying the same handler
cannot fix that. So Workhorse fails the task at that point, instead of
retrying it. It keeps the current attempt and records which kind of conflict happened, so an
operator can see it. Configured redaction still hides error details.

Other errors keep their usual rules. Transient errors and child-limit refusals still follow the
task's retry policy. Lease loss keeps its ownership rules. A refused signal wait that is already
waiting keeps its existing behavior.

<details>
<summary>Reference: conflict classes</summary>

Workhorse fails the task on the first conflict with saved evidence in one of these:

- a checkpoint value;
- a timer target;
- a child request;
- a child set;
- a human-decision context.

The failure keeps the current attempt. Operator reads show the conflict class.

More detail: [Task lifecycle: Durable timer suspension](../architecture/lifecycle.md#durable-timer-suspension).

</details>

## Next

- [030-delivery-guarantees.md](030-delivery-guarantees.md) — checkpoints, which waits depend on
- [140-deadlines-and-timeouts.md](140-deadlines-and-timeouts.md) — why sleeping doesn't spend the budget
- [110-retries.md](110-retries.md) — how a wait differs from a retry

---

Exact wait semantics, limits, and replay rules:
[`architecture/lifecycle.md`](../architecture/lifecycle.md#durable-timer-suspension).
