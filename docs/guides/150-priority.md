# How do I run urgent work first?

Set `EnqueueOptions.priority` when some ready tasks should start before others in the same queue.
Existing callers keep FIFO behavior because Workhorse supplies the default.

## How dispatch uses priority

PostgreSQL considers higher values first when a worker asks for ready work. Tasks with the same value
keep their FIFO order, so priority changes which class leads without reordering peers.

Priority is strict. A steady stream of urgent work can delay lower-priority tasks because Workhorse
does not age waiting tasks or reserve capacity across priorities.

If ordinary work must always make progress, put it on a separate queue and give that queue its own
workers or capacity policy. Priority only chooses among tasks that compete inside one queue.

## Priority follows the work

PostgreSQL stores priority with the stable task identity. Delays, retries, durable waits, and manual
promotion keep the same value because those transitions continue the same task.

Cancellation changes the task's state without changing its priority. Lookup and lifecycle history
therefore keep showing the value that controlled dispatch.

Redrive creates a new task but copies the source priority. Urgent failed work therefore does not
become ordinary work when an operator sends it through the queue again.

## Set priority at enqueue

```ts
await queue.enqueue(
  "invoice.remind",
  { invoiceId },
  {
    priority: priorities.urgent,
  },
);

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

Recurring definitions accept the same field on `ScheduledTask`. Every occurrence receives
the stored priority when `fireSchedule` creates its task.

The dashboard can sort tasks with the highest priority first. It also shows non-default priority
beside each task and the stored value in task details.

The System page groups each queue's ready work by priority and shows the oldest task in each group.
This makes a lower-priority group that is waiting behind urgent work visible to an operator.

Priority does not bypass queue pauses, concurrency policies, rate limits, or other admission rules.
It orders the tasks that PostgreSQL may admit after those rules apply.

## Next

- [110-retries.md](110-retries.md) — how another attempt keeps the same priority
- [140-deadlines-and-timeouts.md](140-deadlines-and-timeouts.md) — when time can end work before dispatch
- [240-concurrency-policies.md](240-concurrency-policies.md) — how capacity limits interact with ordering

---

Exact priority limits and dispatch rules:
[`architecture.md`](../architecture.md#claim).
