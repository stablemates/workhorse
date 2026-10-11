# How do I run urgent work first?

<!-- scenario-names: overdue-invoices, cust-8, cust-9, billing -->

Some tasks in a queue are more urgent than others. For example, a reminder for an overdue invoice
must not wait behind routine reminders. Priority lets an urgent ready task start before the other
ready tasks in its queue. If you do not set a priority, the tasks of a queue start in FIFO order,
which is the order in which they became ready.

## Run an urgent task first

**Example.** Queue `billing` sends invoice reminders. Fifty ordinary reminders are ready at the
default priority. All worker slots run earlier reminders.

1. At 0 s, the fifty ordinary reminders wait in the order in which they became ready.
2. At 2 s, your app enqueues a reminder for an overdue invoice with an urgent priority. The
   reminder is ready immediately.
3. At 3 s, a worker slot becomes free, and the worker asks for work. The worker gets the urgent
   reminder, not the oldest ordinary reminder.
4. At 4 s, another slot becomes free. No urgent reminder is ready, so the worker gets the oldest
   ordinary reminder.

To set a priority, give `EnqueueOptions.priority` when you enqueue the task.

```ts
await queue.enqueue(
  "invoice.remind",
  { invoiceId },
  {
    priority: priorities.urgent,
  },
);
```

When a worker asks for work, PostgreSQL gives it the ready task with the highest priority. Tasks
with the same priority keep their FIFO order. Thus, priority does not change the order of tasks that
have the same value.

Priority sets the order of ready tasks only. In step 1, the earlier reminders continue to run. A
task with a future `runAt` waits until that time, and then its priority applies.

The priority values in the example belong to your application, not to Workhorse. Workhorse accepts
any integer in the allowed range.

<details>
<summary>Reference: priority values and claim order</summary>

| Option                    | Rule                                                       |
| ------------------------- | ---------------------------------------------------------- |
| `EnqueueOptions.priority` | An integer from 0 to 100 (`MAX_TASK_PRIORITY`). Default 0. |

Higher values dispatch first. Claim orders ready rows by:

1. `priority`, descending;
2. `sequence`, the FIFO ready sequence, ascending;
3. `task_id`.

`task_runtime_ready_idx` on `(queue_name, priority DESC, sequence, task_id) WHERE state = 'ready'`
serves that order. A task with a future `runAt` is `scheduled`, not `ready`, so claim does not read
it until promotion makes it ready.

More detail: [Data model: Priority, payload reads, and retry policy](../architecture/data-model.md#priority-payload-reads-and-retry-policy).

</details>

## Set priority on a recurring schedule

A recurring schedule can create tasks at a set priority. For example, an hourly `overdue-invoices`
schedule can create scan tasks at a background priority.

To set the priority, give `ScheduledTask.priority` when you sync the schedule. Each hour, Workhorse
creates a scan task with that stored priority.

```ts
await queue.syncSchedules("billing", [
  {
    name: "overdue-invoices",
    schedule: schedules.hourly,
    task: {
      type: "invoice.scan",
      payload: null,
      priority: priorities.background,
    },
  },
]);
```

<details>
<summary>Reference: where priority is accepted</summary>

| Surface                   | Field                                               | Rule                |
| ------------------------- | --------------------------------------------------- | ------------------- |
| `Queue.enqueue` and batch | `EnqueueOptions.priority`                           | 0 to 100, default 0 |
| Recurring schedules       | `ScheduledTask.priority`                            | 0 to 100, default 0 |
| Go                        | `EnqueueOptions.Priority`, `ScheduledTask.Priority` | 0 to 100, default 0 |

- `enqueue_batch_v1` rejects the whole batch when the priority of any member is outside the range.
- `fire_schedule_v1` copies the stored priority of the definition into each occurrence task.
  `Queue.fireSchedule` and the schedule tick both use it.

More detail: [Task lifecycle: Batch validation](../architecture/lifecycle.md#batch-validation).

</details>

## Keep urgent work from starving ordinary work

Priority is strict. If urgent tasks arrive faster than the workers complete them, the ordinary
tasks in the same queue do not start.

**Example.** Queue `billing` has fifty ordinary reminders that are ready. From 10 s, your app
enqueues one urgent reminder each second. The workers complete fewer than one reminder each second.

1. At 11 s, a worker slot becomes free. An urgent reminder is ready, so the worker gets it.
2. At 12 s, a slot becomes free again. The worker gets the next urgent reminder.
3. While urgent reminders continue to arrive, the fifty ordinary reminders do not start.

Workhorse does not increase the priority of a task that waits. It does not keep capacity for lower
priorities.

If ordinary work must always continue, put it in a separate queue. Give that queue its own workers
or its own [concurrency policy](240-concurrency-policies.md). Priority sets the order of tasks in one
queue only.

<details>
<summary>Reference: starvation</summary>

- Priority dispatch has no aging or fair-share control.
- A sustained stream of higher-priority ready work can starve lower-priority rows in the same queue.

More detail: [Task lifecycle: Admission policies](../architecture/lifecycle.md#admission-policies).

</details>

## Use priority with concurrency policies and rate limits

Priority does not bypass the admission rules of a queue. An admission rule decides if a ready task
can start now. Queue pauses, concurrency policies, [rate limits](250-rate-limits.md), and budgets
are admission rules.

**Example.** Queue `billing` has a [concurrency policy](240-concurrency-policies.md) that lets two
tasks for one customer run at the same time. Two reminders for customer `cust-8` run now.

1. At 0 s, an urgent reminder for `cust-8` becomes ready. An ordinary reminder for `cust-9` is also
   ready.
2. At 1 s, a worker asks for work. The urgent reminder is first, but `cust-8` has no free capacity.
3. Workhorse skips the urgent reminder, and the worker gets the ordinary reminder for `cust-9`.
4. At 20 s, one of the `cust-8` reminders completes. The next worker that asks for work gets the
   urgent reminder.

Priority sets the order of the tasks that the admission rules let start. If a rule holds back a
task, the task stays ready and keeps its place.

<details>
<summary>Reference: priority and the policy window</summary>

- With concurrency-key or rate-key limits, `claim_policy_batch_v1` inspects at most the first 100
  ready rows. It orders them by priority descending, FIFO sequence, and task identity.
- It selects the earliest candidate whose key has concurrency capacity and a rate token.
- Saturated or throttled candidates remain ready, so later admissible work can proceed.
- Budget checks run inside the same 100-row priority window.

More detail: [Task lifecycle: Key limits and the policy window](../architecture/lifecycle.md#key-limits-and-the-policy-window).

</details>

## Keep urgent work urgent after a retry

Workhorse stores the priority with the task. A task keeps its priority when it moves between states.

**Example.** The urgent reminder from the first section fails on its first attempt, because the
mail provider is down.

1. At 3 s, the attempt fails. Workhorse schedules a [retry](110-retries.md). The task keeps its
   urgent priority.
2. At 33 s, the retry is due, and Workhorse makes the task ready again.
3. The task is still urgent, so it starts before the ordinary reminders. It starts after the urgent
   reminders that became ready before it.

A delay, a retry, a [durable wait](130-durable-waits.md), and an operator request to run the task
now keep the same priority. These transitions continue the same task.

[Cancellation](120-cancellation.md) changes the state of the task, but not its priority. Thus, task
lookup and the task history show the priority that controlled dispatch.

[Redrive](340-redrive.md) creates a new task with the priority of the source task. Thus, failed
urgent work stays urgent when an operator sends it through the queue again.

<details>
<summary>Reference: priority across transitions</summary>

- `task.priority` holds the accepted value. `task_runtime.priority` copies it so claim can stay on
  the ready index.
- Retry, recovery, durable waits, and promotion keep the value while they move the same row between
  live states.
- Promotion, a retry, an accepted signal delivery, and `run_task_now_v1` each assign a new value
  from `ready_sequence_seq` when they make the task ready.
- `run_task_now_v1` does not change the priority.
- A pending [debounce](215-debounce.md) replacement replaces both values in one transaction.
- `redrive_v1` copies queue, type, priority, payload, and the other accepted settings into the new
  task.

More detail: [Data model: Priority and attempts](../architecture/data-model.md#priority-and-attempts) and [Data model: Running a task now](../architecture/data-model.md#running-a-task-now).

</details>

## Find starved work in the dashboard

The dashboard shows the priority of tasks, so an operator can find work that waits too long.

The System page groups the ready tasks of each queue by priority. It shows the age of the oldest
task in each group. For example, the oldest urgent task in `billing` is a few seconds old. The
oldest ordinary task is ten minutes old. This shows that urgent work starves the ordinary work.

The task list can sort tasks with the highest priority first. Each task row shows a priority above
the default. Task details show the stored priority.

<details>
<summary>Reference: dashboard priority surfaces</summary>

- The task list accepts a `priority` filter from 0 to 100 and a `sort` of `updated` or `priority`.
  The default sort is `updated`.
- The `priority` sort orders by priority descending, then `updated_at` descending, then task
  identity descending.
- A task row shows the priority as `P<n>` when it is above the default.
- `dashboard_system_v1` groups ready rows by `queue_name` and `priority`. Each
  `DashboardSystemQueueRow.priorityBacklog` entry returns `priority`, `ready`, and `oldestReadyMs`,
  ordered by priority descending.

More detail: [Task lifecycle: System page](../architecture/lifecycle.md#system-page) and [Dashboard: Task listing](../architecture/dashboard.md#task-listing).

</details>

## Next

- [110-retries.md](110-retries.md) — how a retry keeps the same priority
- [140-deadlines-and-timeouts.md](140-deadlines-and-timeouts.md) — how time can end work before
  dispatch
- [240-concurrency-policies.md](240-concurrency-policies.md) — how capacity limits change the order

---

Exact priority limits and dispatch rules:
[`architecture/lifecycle.md`](../architecture/lifecycle.md#claim).
