# How do I run a job after other jobs finish?

Dependencies keep work out of dispatch until every prerequisite satisfies its declared policy.
Use them when downstream work would be invalid or wasteful before its inputs finish.

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

For fan-in, pass a `dependencies` object with every stable prerequisite id and policies for failed
and canceled prerequisites:

```ts
const publishId = await queue.enqueue("release.publish", { release });
const indexId = await queue.enqueue("release.index", { release });

await queue.enqueue(
  "release.announce",
  { release },
  {
    dependencies: {
      prerequisiteJobIds: [publishId, indexId],
      onSuccess: "release",
      onFailure: "fail",
      onCancellation: "cancel",
    },
  },
);
```

## While the prerequisite is running

The dependent has the `blocked` state. It has a durable `job_runtime` row, but claim and promotion
cannot see it because blocked work is absent from their indexes.

`Queue.getJob` and `Queue.listJobs` return its `prerequisiteJobIds` and `dependencyPolicy`. They also return
`blockedReason: "prerequisite_pending"` while it remains blocked.

Use `Queue.getDependencyLineage(jobId)` when you need both directions. It returns edges where the
job is a prerequisite or a dependent, including each policy, resolution, and release time. The
result says when more edges exist beyond the bounded response.

## When the prerequisite succeeds

PostgreSQL records each success and satisfies its edge in the same database transaction. The
dependent stays blocked while any edge remains unsatisfied. A
dependent whose requested `runAt` has arrived becomes ready. A future dependent becomes scheduled
and follows ordinary promotion later.

The release appends `dependency_released`. Repeated completion cannot append another release or
place the dependent into dispatch again.

If the prerequisite already succeeded before enqueue, PostgreSQL records the edge as released and
accepts the dependent directly into its ordinary ready or scheduled state.

## Failure and cancellation

`onSuccess`, `onFailure`, and `onCancellation` each accept `release`, `cancel`, or `fail`.
`release` satisfies the edge. After every edge resolves, PostgreSQL applies `fail` before `cancel`
before `release`, so concurrent outcomes cannot change the result.

PostgreSQL applies the same policy when a prerequisite is already terminal at enqueue. If several
terminal outcomes disagree, `fail` wins over `cancel`, which makes the result independent of input
order.

You can cancel a blocked dependent through `Queue.cancel`. PostgreSQL removes its runtime without
changing the prerequisite.

## Operating dependencies

The dashboard task detail shows prerequisites and dependents with the policy and retained release
evidence. This lets an operator explain why work remains blocked or why PostgreSQL released,
canceled, or failed it.

`Queue.health()` reports blocked jobs, pending edges, and retained failures selected by dependency
policy. OpenTelemetry exports the same pressure by queue without job ids, prerequisite ids, or
other unbounded labels.

Retention keeps a prerequisite identity while a dependent edge still needs it. Once the dependent
identity expires, PostgreSQL can remove the edge and later remove the prerequisite, so lineage
never outlives the identities it explains.

## Next

- [150-priority.md](150-priority.md) — how released work competes for dispatch
- [170-child-jobs.md](170-child-jobs.md) — how a handler delegates and joins durable work
- [210-enqueue-idempotency.md](210-enqueue-idempotency.md) — how repeated enqueue requests behave

---

Exact dependency schema and lifecycle semantics:
[`architecture.md`](../architecture.md#job_dependency).
