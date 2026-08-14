# How do I run urgent work first?

Set `EnqueueOptions.priority` when some ready jobs should start before others in the same queue. Existing callers keep FIFO behavior because Workhorse supplies the default.

Higher values run first. Jobs with the same value keep their FIFO order. Priority is strict, so a steady stream of urgent work can delay lower-priority jobs.

Workhorse does not age waiting jobs or reserve fair-share capacity across priorities. Use separate queues when lower-priority work needs a guaranteed chance to start.

PostgreSQL stores priority with the stable job identity. Delays, retries, durable waits, and manual promotion keep the same value.

Cancellation changes the job's state, but it does not change priority. Lookup and lifecycle history therefore keep showing the original value.

Redrive copies priority to the new job. Urgent failed work therefore does not become ordinary work.

Recurring definitions accept the same field on `ScheduleJobDefinition`. Every occurrence receives the stored priority when `fireSchedule` creates its job.

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
    job: {
      type: "invoice.scan",
      payload: null,
      priority: priorities.background,
    },
  },
]);
```

The dashboard shows non-default priority beside each task and the stored value in task details.

Priority changes order inside one queue only.

## Next

- [Retries](110-retries.md)
- [Deadlines and timeouts](140-deadlines-and-timeouts.md)
- [Concurrency policies](240-concurrency-policies.md)

[Exact priority limits and dispatch rules](../architecture.md)
