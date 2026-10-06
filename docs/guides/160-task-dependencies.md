# How do I run a task after other tasks finish?

<!-- scenario-names: release.publish, release.index, reports.build, reports.export, publish, contacts.import, contacts.notify -->

Dependencies keep work out of dispatch until every prerequisite satisfies its declared policy.
Use them when downstream work would be invalid or wasteful before its inputs finish.

## One import, one notification

Your app imports a contact list and then notifies the user. The notification must not go out
before the import is done.

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

1. **At 0 s** the app enqueues `contacts.import` and keeps its stable task id. The import task is
   ready.
2. **At 0 s** the app enqueues `contacts.notify` and names the import as its prerequisite. The
   import has not finished, so the notification task is `blocked`. No worker can claim it.
3. **At 1 s** a worker claims the import and runs it.
4. **At 3 min** the import succeeds. In the same transaction that records the success, Workhorse
   resolves the edge between the two tasks with `release`. The notification has no other
   prerequisite, so Workhorse makes it ready.
5. **Shortly after** a worker claims the notification and sends it.

PostgreSQL validates both tasks and creates the dependency inside the enqueue transaction. If the
transaction rolls back, the task and its dependency both disappear.

The older `prerequisiteTaskId` shorthand is deprecated, because it hides the terminal policies. Put
the prerequisite ids in `EnqueueOptions.dependencies` instead.

If the import had already succeeded before step 2, Workhorse would record the edge as released at
once. The notification would skip `blocked` and start in its ordinary ready or scheduled state.

<details>
<summary>Reference: declaring dependencies</summary>

**`EnqueueOptions.dependencies`**

| Field                 | Rule                                             |
| --------------------- | ------------------------------------------------ |
| `prerequisiteTaskIds` | Required. 1 to 100 unique ids of existing tasks. |
| `onSuccess`           | Required. `release`, `cancel`, or `fail`.        |
| `onFailure`           | Required. `release`, `cancel`, or `fail`.        |
| `onCancellation`      | Required. `release`, `cancel`, or `fail`.        |

- The deprecated `prerequisiteTaskId` names one prerequisite with `onSuccess: "release"`,
  `onFailure: "fail"`, and `onCancellation: "cancel"`. One request cannot set both fields.
- `enqueue_batch_v1` raises `prerequisite task does not exist` for an unknown id.
- It locks every prerequisite `FOR KEY SHARE` in the caller's transaction. A concurrent terminal
  transition of a prerequisite therefore sees the new edge.
- A live prerequisite makes a `blocked` runtime row and appends `dependency_blocked`.
- A prerequisite that already succeeded releases the edge at once when `onSuccess` is `release`,
  with `dependency_released.details.reason` `prerequisite_already_succeeded`. A `fail` or `cancel`
  success policy rejects the dependent instead.
- Debounce, throttle, and [fast-tier queues](305-fast-tier.md) reject dependencies.

More detail: [Data model: Declaring dependencies at enqueue](../architecture/data-model.md#declaring-dependencies-at-enqueue).

</details>

## While a prerequisite is running

Go back to step 3. The notification task waits in the `blocked` state. It has a durable
`task_runtime` row, but claim and promotion cannot see it. Promotion is a regular background pass
that moves due tasks to `ready`. Blocked work is absent from the indexes that claim and promotion
read.

An operator who asks why the notification has not run gets an answer. `Admin.getTask` and
`Admin.listTasks` return its `prerequisiteTaskIds` and `dependencyPolicy`. They also return
`blockedReason: "prerequisite_pending"` while it remains blocked.

`Admin.getDependencyLineage(taskId)` reads both directions. It returns the edges where the task is a
prerequisite or a dependent, with each policy, resolution, and release time. The result says when
more edges exist beyond a caller-selected response limit. Each task accepts a bounded number of
prerequisites and dependents, so the default response covers its complete direct lineage without a
continuation cursor.

<details>
<summary>Reference: blocked state and lineage</summary>

- A blocked row stays in `task_runtime` with `state = 'blocked'`. `task_runtime_ready_idx` and the
  scheduled index exclude it.
- Task records from `Admin.getTask` and `Admin.listTasks` carry `prerequisiteTaskIds`,
  `dependencyPolicy`, and `blockedReason`.
- `Admin.getDependencyLineage(taskId, limit)` returns `{ records, truncated }`. `limit` defaults to
  1,000 (`MAX_TASK_QUERY_PAGE_SIZE`), above the 200 direct edges one task can hold.
- Each record has `dependentTaskId`, `prerequisiteTaskId`, `onSuccess`, `onFailure`,
  `onCancellation`, `createdAt`, `releasedAt`, and `resolution`.

More detail: [Data model: Columns and bounds](../architecture/data-model.md#columns-and-bounds).

</details>

## Waiting for several prerequisites

A release goes out only after it is both published and indexed. The announcement names both tasks
as prerequisites. This shape is a fan-in.

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

1. **At 0 s** the announcement is blocked with two unresolved edges.
2. **At 1 min** `release.publish` succeeds. Workhorse resolves that edge with `release`. One edge is
   still unresolved, so the announcement stays blocked.
3. **At 2 min** `release.index` succeeds. Its edge resolves too. No edge is left, so Workhorse
   makes the announcement ready and appends `dependency_released`.

To decide that without rereading every edge, Workhorse keeps a counter on the blocked dependent.
The `pending_prerequisites` column counts its unresolved edges. Settling an edge decrements it in
the same statement that resolves the edge. The dependent leaves `blocked` once no unresolved edge
remains. A wide fan-in therefore costs the same per prerequisite as a single edge.

A dependent whose requested `runAt` has arrived becomes ready. A future dependent becomes scheduled
and follows ordinary promotion later. Repeated completion cannot append another release or place
the dependent into dispatch again.

<details>
<summary>Reference: resolution and release</summary>

The outcome trigger `task_outcome_resolve_dependencies_insert` calls
`resolve_dependents_many_v1` in the transaction that inserts the prerequisite's outcome.

| Counter and rejection   | Resolver action                                  |
| ----------------------- | ------------------------------------------------ |
| Above zero              | Stays blocked. One runtime update, no edge scan. |
| Zero, no rejection      | Released to ready or scheduled.                  |
| Zero, after a rejection | Fails or is canceled. See the next section.      |

- A release allocates a ready sequence, appends `dependency_released`, and sends one
  `NOTIFY workhorse_tasks` per queue that gained ready work.
- The resolver materializes an already-passed deadline for each released task.

| `dependency_released.details.reason` | When                                                               |
| ------------------------------------ | ------------------------------------------------------------------ |
| `prerequisite_succeeded`             | After success, when `onSuccess` selects `release`                  |
| `prerequisite_failed_policy`         | `onFailure` selects `release`                                      |
| `prerequisite_canceled_policy`       | `onCancellation` selects `release`                                 |
| `prerequisite_already_succeeded`     | At enqueue, after success, when `onSuccess` selects `release`      |
| `prerequisite_terminal_policy`       | At enqueue, after a failure or cancellation that selects `release` |
| `dependency_counter_repaired`        | A recount found no pending edge                                    |

More detail: [Data model: Resolver counters](../architecture/data-model.md#resolver-counters).

</details>

## When a prerequisite fails or is canceled

Take the release again, with `onFailure: "fail"`. This time the index build breaks.

1. **At 1 min** `release.index` fails for good after its last retry. Its edge resolves with the
   policy `fail`. Workhorse marks the announcement as rejected, through its `dependency_rejected`
   flag. One edge is still unresolved, so the announcement stays blocked.
2. **At 2 min** `release.publish` succeeds, and its edge resolves with `release`.
3. No edge is left. The flag says the announcement was rejected, so Workhorse settles it. It reads
   the rejecting edges to pick the outcome, preferring `fail` over `cancel`. The `release.index`
   edge says `fail`, so Workhorse fails the announcement. It never ran.

`onSuccess`, `onFailure`, and `onCancellation` each accept `release`, `cancel`, or `fail`. `release`
satisfies the edge. After every edge resolves, Workhorse applies `fail` before `cancel` before
`release`. So the order in which concurrent outcomes arrive cannot change the result.

PostgreSQL applies the same policy when a prerequisite is already terminal at enqueue. If several
terminal outcomes disagree, `fail` wins over `cancel`, which makes the result independent of input
order.

<details>
<summary>Reference: rejected dependents</summary>

- An edge resolves with `on_success`, `on_failure`, or `on_cancellation`, matching the
  prerequisite's terminal state.
- A `fail` or `cancel` resolution sets `task_runtime.dependency_rejected`.
- At zero unresolved edges, the resolver reads only the `fail` and `cancel` edges. It chooses
  `fail` before `cancel`, then the lowest prerequisite identity.
- `settle_dependents_v1` deletes the runtime row and appends `dependency_failed` or
  `dependency_canceled`. It inserts a terminal outcome with the error `DependencyFailed` or
  `DependencyCanceled`.

More detail: [Data model: Settlement](../architecture/data-model.md#settlement).

</details>

## Canceling a blocked dependent

The announcement from the first fan-in is still blocked when the team decides not to announce.

1. **At 30 s** an operator cancels the announcement through `Queue.cancel`. Workhorse removes its
   runtime row. The announcement ends as canceled.
2. Workhorse marks the announcement's own edges released, because a dependent that will never run is
   no longer waiting.
3. `release.publish` and `release.index` keep running. Their identities stop being held for a
   dependent that abandoned them.

Canceling a dependent never changes its prerequisites.

<details>
<summary>Reference: dependent cancellation</summary>

- `cancel_v1` deletes a blocked runtime row and inserts one `canceled` outcome at once. Work that
  never started emits no attempt history.
- The outcome trigger first sets `released_at` and a `release` resolution on every pending edge
  that enters the canceled task. `release_own_dependencies_v1(task_id)` is the one-task form.
- Deadline materialization of a blocked dependent takes the same path.

More detail: [Data model: Outcome trigger](../architecture/data-model.md#outcome-trigger).

</details>

## The graph has bounds

Task `reports.build` rebuilds a nightly report. Throughout the day, each export request enqueues a
`reports.export` task that depends on it.

1. **During the day** export requests add dependents to `reports.build`, one edge each.
2. **At the 101st request** `reports.build` already owns the maximum number of dependent edges.
   PostgreSQL refuses the new edge, and `Queue` throws `DependencyLimitExceededError`.
3. **At night** `reports.build` runs, and the waiting exports run and finish. Maintenance then
   removes their released edges, and `reports.build` accepts dependents again.

Each task accepts a bounded number of prerequisites and dependents. PostgreSQL counts the retained
dependents of a prerequisite, not only the unresolved ones. This keeps the direct work of settling
that prerequisite bounded inside the worker's transaction. PostgreSQL also bounds the unresolved
downstream graph, so failure and cancellation cannot cascade through unlimited work in that
transaction.

If an edge would create a cycle or exceed a graph bound, `Queue` throws `DependencyCycleError` or
`DependencyLimitExceededError`. Callers can handle those failures without matching database text.

<details>
<summary>Reference: edge bounds and errors</summary>

| Bound                                                                                        | Limit | `limit` value           |
| -------------------------------------------------------------------------------------------- | ----- | ----------------------- |
| Unresolved prerequisite edges into one dependent                                             | 100   | `prerequisites`         |
| Retained dependent edges out of one prerequisite                                             | 100   | `dependents`            |
| Distinct dependents one prerequisite reaches through unresolved edges, direct and transitive | 100   | `unresolved_dependents` |

- PostgreSQL raises these with SQLSTATE `P1005`. `DependencyLimitExceededError` carries `taskId`,
  `limit`, and `max`.
- One request names at most 100 prerequisites (`MAX_TASK_DEPENDENCIES`). The TypeScript SDK
  rejects a longer list with a `RangeError` before it queries.
- `DependencyCycleError` carries `dependentTaskId`, `prerequisiteTaskId`, `cycleTaskIds`, and
  `truncated`.
- `prune_released_dependencies_v1` removes a released edge once its dependent has a terminal
  outcome.

More detail: [Data model: Columns and bounds](../architecture/data-model.md#columns-and-bounds).

</details>

## When the counter disagrees with the edges

The counter must agree with the edges. Before a dependent leaves `blocked`, Workhorse checks that no
edge is still unresolved.

Suppose a fault left the announcement's counter at 1 while two edges were unresolved. `publish`
succeeds and would drive the counter to zero with an edge still unresolved. Workhorse recounts the
announcement's edges instead. It stores the counter 1, keeps the announcement blocked, and records a
`dependency_counter_repaired` event.

The same recount happens if a resolution would drive the counter below zero. A dependent flagged as
rejected without a rejecting edge gets the same recount. A drifted counter therefore neither fails
the prerequisite's completion nor releases the dependent early.

An operator can also look for drift on demand. `Admin.listDependencyDrift` lists blocked dependents
whose counter or flag disagrees with their edges, with the action a repair would take. It writes
nothing. `Admin.repairDependencyDrift` recounts those dependents and settles each one whose edges
have all resolved. It requires an actor, a reason, and a request id, and each repair event records
them. `workhorse admin repair-dependencies` runs the same pair, with `--dry-run` for the read.

<details>
<summary>Reference: counter repair</summary>

**Automatic.** The resolver recounts a dependent when its counter is smaller than the edges the call
resolved, or equal to them while a pending edge remains. The event's `details.source` is
`resolver`. `settle_dependents_v1` recounts a rejected dependent with no rejecting edge, with
`source` `settlement`.

**On demand**

| Surface                                     | Effect                                                                             |
| ------------------------------------------- | ---------------------------------------------------------------------------------- |
| `Admin.listDependencyDrift(limit)`          | Reads drifted rows and the planned action: `recounted`, `rejected`, or `released`. |
| `Admin.repairDependencyDrift(audit, limit)` | Recounts under lock and settles rows with no pending edge.                         |
| `workhorse admin repair-dependencies`       | `--dry-run` reads. Without it, requires `--reason`, `--env`, and confirmation.     |

- `limit` defaults to 1,000 and accepts 1 to 100,000 (`MAX_DEPENDENCY_DRIFT_LIMIT`).
- The repair requires `requested_by` of 1 to 200 characters, `reason` of 1 to 2,000 characters,
  and `request_id` of 1 to 512 UTF-8 bytes.
- The request id correlates the repair. It is not an idempotency key.
- No maintenance pass calls either function. `queue_health_v1` does not report drift.

More detail: [Data model: Governed drift repair (schema version 40)](../architecture/data-model.md#governed-drift-repair-schema-version-40).

</details>

## Operating dependencies

Go back to the release announcement, at 1 min, after `release.index` failed for good.

1. An operator opens the dashboard's `Blocked` filter. The announcement is listed, with its blocked
   reason and the one prerequisite still unresolved, `release.publish`.
2. The operator opens the announcement. Its detail shows both edges: `release.index` resolved with
   `fail`, and `release.publish` still pending.
3. After `release.publish` succeeds, Workhorse fails the announcement. Later, maintenance removes
   the resolved edges, and retention may then prune either task's identity.

The dashboard task detail shows prerequisites and dependents with the policy and stored release
evidence. An operator can see why work remains blocked, or why PostgreSQL released, canceled, or
failed it.

The dashboard's `Blocked` filter lists blocked tasks with `blockedReason` and unresolved
`prerequisiteTaskIds`. Related ids in the task detail open that task without closing the drawer.

`Queue.health()` reports blocked tasks, pending edges, stored dependency failures, and whether
dependency edges stopped the latest retention pass from deleting tasks. OpenTelemetry exports queue
pressure without task ids, prerequisite ids, or other unbounded labels.

Retention keeps a prerequisite identity while a dependent edge still controls dispatch. Once that
edge resolves and the dependent finishes, maintenance removes the edge before pruning eligible task
identities. The dependency lineage can therefore disappear while either terminal task remains.

<details>
<summary>Reference: health, telemetry, and retention</summary>

**`Queue.health().dependencies`:** `blockedTasks`, `pendingEdges`, `failedResolutions`,
`retentionPruneStarved`, and `capped`. Each count scans at most 10,001 rows and reports at most
10,000. `capped` marks a lower bound.

**Metrics:** `workhorse.queue.dependencies.blocked`, `workhorse.queue.dependencies.pending_edges`,
`workhorse.queue.dependencies.failed_resolutions`, and `workhorse.queue.dependencies.capped`, by
queue.

**Retention**

- `prerequisite_task_id` restricts deletion, so retention cannot strand blocked work.
- `prune_released_dependencies_v1` deletes at most 100,000 released edges per call whose dependent
  has a terminal outcome.
- Released-edge compaction runs before terminal-task pruning in the same pass.

More detail: [Data model: Dependency health](../architecture/data-model.md#dependency-health).

</details>

## Next

- [150-priority.md](150-priority.md) — how released work competes for dispatch
- [170-child-tasks.md](170-child-tasks.md) — how a handler delegates and joins durable work
- [210-enqueue-idempotency.md](210-enqueue-idempotency.md) — how repeated enqueue requests behave

---

Exact dependency schema and lifecycle semantics:
[`architecture/data-model.md`](../architecture/data-model.md#task_dependency).
