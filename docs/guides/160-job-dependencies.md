# How do I run a job after another job succeeds?

A dependency keeps work out of dispatch until its prerequisite succeeds. Use it when the second
job would be invalid or wasteful before the first job finishes.

## Declare the prerequisite

First enqueue the prerequisite and keep its stable job id. Pass that id as
`EnqueueOptions.prerequisiteJobId` when you enqueue the dependent:

```ts
const importId = await queue.enqueue("contacts.import", { source: "upload" });

const notifyId = await queue.enqueue(
  "contacts.notify",
  { importId },
  { prerequisiteJobId: importId },
);
```

PostgreSQL validates both jobs and creates the dependency inside the enqueue transaction. If the
transaction rolls back, the job and its dependency both disappear.

## While the prerequisite is running

The dependent has the `blocked` state. It has a durable `job_runtime` row, but claim and promotion
cannot see it because blocked work is absent from their indexes.

`Queue.getJob` and `Queue.listJobs` return its `prerequisiteJobId`. They also return
`blockedReason: "prerequisite_pending"` while it remains blocked.

## When the prerequisite succeeds

`complete_v1` records success and releases every dependent in the same database transaction. A
dependent whose requested `runAt` has arrived becomes ready. A future dependent becomes scheduled
and follows ordinary promotion later.

The release appends `dependency_released`. Repeated completion cannot append another release or
place the dependent into dispatch again.

If the prerequisite already succeeded before enqueue, PostgreSQL records the edge as released and
accepts the dependent directly into its ordinary ready or scheduled state.

## Failure and cancellation

This first dependency contract releases only after success. Enqueue rejects a prerequisite that is
already failed or canceled, while a prerequisite that becomes terminal later leaves its dependent
blocked. Terminal policies belong to the fan-in dependency contract rather than this success-only
edge.

You can cancel a blocked dependent through `Queue.cancel`. PostgreSQL removes its runtime without
changing the prerequisite.

## Next

- [150-priority.md](150-priority.md) — how released work competes for dispatch
- [210-enqueue-idempotency.md](210-enqueue-idempotency.md) — how repeated enqueue requests behave
- [330-retention.md](330-retention.md) — why the prerequisite identity stays retained

---

Exact dependency schema and lifecycle semantics:
[`architecture.md`](../architecture.md#job_dependency).
