# How do I run a task after other tasks finish?

Dependencies keep work out of dispatch until every prerequisite satisfies its declared policy.
Use them when downstream work would be invalid or wasteful before its inputs finish.

## Declare the prerequisite

First enqueue the prerequisite and keep its stable task id. Put that id in
`EnqueueOptions.dependencies` when you enqueue the dependent. The older `prerequisiteTaskId`
shorthand is deprecated because it hides the terminal policies:

```ts
const importId = await queue.enqueue("contacts.import", { source: "upload" });

const notifyId = await queue.enqueue(
  "contacts.notify",
  { importId },
  {
    dependencies: {
      prerequisiteTaskIds: [importId],
      onSuccess: "release",
      onFailure: "fail",
      onCancellation: "cancel",
    },
  },
);
```

PostgreSQL validates both tasks and creates the dependency inside the enqueue transaction. If the
transaction rolls back, the task and its dependency both disappear.

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
      prerequisiteTaskIds: [publishId, indexId],
      onSuccess: "release",
      onFailure: "fail",
      onCancellation: "cancel",
    },
  },
);
```

## While the prerequisite is running

The dependent has the `blocked` state. It has a durable `task_runtime` row, but claim and promotion
cannot see it because blocked work is absent from their indexes.

`Admin.getTask` and `Admin.listTasks` return its `prerequisiteTaskIds` and `dependencyPolicy`. They also return
`blockedReason: "prerequisite_pending"` while it remains blocked.

Use `Admin.getDependencyLineage(taskId)` when you need both directions. It returns edges where the
task is a prerequisite or a dependent, including each policy, resolution, and release time. The
result says when more edges exist beyond a caller-selected response limit. Each task accepts a
bounded number of prerequisites and dependents, so the default response covers its complete direct
lineage without a continuation cursor.

PostgreSQL rejects a new edge when its prerequisite already owns the maximum number of retained
dependents. This keeps the direct work of settling that prerequisite bounded inside the worker's
transaction. PostgreSQL also bounds the unresolved downstream graph, so failure and cancellation
cannot cascade through unlimited work in that transaction.

## When the prerequisite succeeds

PostgreSQL records each success and satisfies its edge in the same database transaction. The
dependent stays blocked while any edge remains unsatisfied.

To decide that without rereading every edge, Workhorse keeps a counter on the blocked dependent.
The `pending_prerequisites` column counts its unresolved edges. Settling an edge decrements it in
the same statement that resolves the edge. The dependent leaves `blocked` once no unresolved edge
remains, so a wide fan-in costs the same per prerequisite as a single edge.

The counter must agree with the edges. Before a dependent leaves `blocked`, Workhorse checks that
no edge is still unresolved. If a resolution would drive the counter below zero, or to zero with an
edge unresolved, Workhorse recounts that dependent's edges instead. A dependent flagged as rejected
without a rejecting edge gets the same recount. A drifted counter therefore neither fails the
prerequisite's completion nor releases the dependent early. Workhorse records each correction as a
`dependency_counter_repaired` event.

An operator can also look for drift on demand. `Admin.listDependencyDrift` lists blocked dependents
whose counter or flag disagrees with their edges, with the action a repair would take. It writes
nothing. `Admin.repairDependencyDrift` recounts those dependents and settles each one whose edges
have all resolved. It requires an actor, a reason, and a request id, and each repair event records
them. `workhorse admin repair-dependencies` runs the same pair, with `--dry-run` for the read.

A dependent whose requested `runAt` has arrived becomes ready. A future dependent becomes scheduled
and follows ordinary promotion later.

The release appends `dependency_released`. Repeated completion cannot append another release or
place the dependent into dispatch again.

If the prerequisite already succeeded before enqueue, PostgreSQL records the edge as released and
accepts the dependent directly into its ordinary ready or scheduled state.

## Failure and cancellation

`onSuccess`, `onFailure`, and `onCancellation` each accept `release`, `cancel`, or `fail`.
`release` satisfies the edge. After every edge resolves, PostgreSQL applies `fail` before `cancel`
before `release`, so concurrent outcomes cannot change the result.
A resolved edge whose policy says `fail` or `cancel` sets the dependent's `dependency_rejected`
flag. The final verdict then reads that flag instead of scanning the edges for a rejection.

PostgreSQL applies the same policy when a prerequisite is already terminal at enqueue. If several
terminal outcomes disagree, `fail` wins over `cancel`, which makes the result independent of input
order.

You can cancel a blocked dependent through `Queue.cancel`. PostgreSQL removes its runtime without
changing the prerequisite. Workhorse also marks the dependent's own edges released, because a
dependent that will never run is no longer waiting. The prerequisite keeps running. Its identity
stops being held for a dependent that abandoned it.

## Operating dependencies

The dashboard task detail shows prerequisites and dependents with the policy and retained release
evidence. This lets an operator explain why work remains blocked or why PostgreSQL released,
canceled, or failed it.

The dashboard's `Blocked` filter lists blocked tasks with `blockedReason` and unresolved
`prerequisiteTaskIds`. Related ids in the task detail open that task without closing the drawer.

`Queue.health()` reports blocked tasks, pending edges, retained failures, and whether dependency
edges stopped the latest retention pass from deleting tasks. OpenTelemetry exports queue pressure
without task ids, prerequisite ids, or other unbounded labels.

Retention keeps a prerequisite identity while a dependent edge still controls dispatch. Once that
edge resolves and the dependent finishes, maintenance removes the edge before pruning eligible task
identities. The dependency lineage can therefore disappear while either terminal task remains.

If an edge would create a cycle or exceed a graph bound, `Queue` throws `DependencyCycleError` or
`DependencyLimitExceededError`. Callers can handle those failures without matching database text.

## Next

- [150-priority.md](150-priority.md) — how released work competes for dispatch
- [170-child-tasks.md](170-child-tasks.md) — how a handler delegates and joins durable work
- [210-enqueue-idempotency.md](210-enqueue-idempotency.md) — how repeated enqueue requests behave

---

Exact dependency schema and lifecycle semantics:
[`architecture.md`](../architecture.md#task_dependency).
