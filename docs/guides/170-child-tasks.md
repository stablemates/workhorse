# How do I run and join a child task?

<!-- scenario-names: orders.checkout, fraud, inventory, charge, payment, ord-9, payments, payments.charge -->

A child task is a task that a handler creates and then waits for. The task that creates it is the
parent. Use a child task when a handler must give durable work to another task and use its result.

While the parent waits, it gives up its [lease](020-leases-and-fences.md). A lease is the right of
one worker to run a task. Thus, the parent does not use a worker slot while its child runs.

## Run one child task from a handler

**Example.** A checkout handler for order `ord-9` must charge a card before it can finish. The
charge runs as its own task on the `payments` queue, so a payments worker can do it.

1. Worker A claims the `orders.checkout` task for `ord-9`. The handler calls
   `HandlerContext.runChild` with the name `charge`, the type `payments.charge`, and a payload.
2. In one transaction, Workhorse creates the child, links it to the parent, and moves the parent to
   `blocked`. The handler stops, and worker A has a free slot.
3. A payments worker claims the child and charges the card. The child succeeds with a receipt.
4. The success of the child releases the parent. Worker B claims the parent with a new
   [fence token](020-leases-and-fences.md).
5. Worker B runs the handler again from the start. The `runChild` call has the same name and
   request, so it returns the stored receipt and creates no task.

```ts
worker.handle<{ id: string }>("orders.checkout", async (order, ctx) => {
  const charge = await ctx.runChild<{ orderId: string }, { receiptId: string }>(
    "charge",
    "payments.charge",
    { orderId: order.id },
    { queue: "payments" },
  );

  return { receiptId: charge.receiptId };
});
```

Thus, `runChild` gives the parent only the result of a successful child. If the child fails,
Workhorse fails the parent. If the child is canceled, Workhorse cancels the parent. The wait does
not use an attempt of the parent.

A parent can own only one child that `runChild` creates. If a handler must give more than one piece
of work to children, use a child set. The next section describes child sets.

<details>
<summary>Reference: one child</summary>

**SDK calls**

| SDK        | Call                                                           |
| ---------- | -------------------------------------------------------------- |
| TypeScript | `HandlerContext.runChild(name, type, payload, options)`        |
| Python     | `HandlerContext.run_child(name, type, payload, options)`       |
| Go         | `HandlerContext.RunChild(name, taskType, payload, options...)` |
| Rust       | `HandlerContext::run_child(name, task_type, payload, options)` |
| Ruby       | `run_child(name, task_type, payload, **enqueue_options)`       |

**`create_child_v2(parent_task_id, worker_id, fence_token, child_name, request)`**

1. Locks and validates the exact active, unexpired parent generation.
2. Calls `enqueue_many_v1` and inserts `task_child`.
3. Adds a `task_dependency` edge from parent to child: success `release`, failure `fail`,
   cancellation `cancel`.
4. Moves the parent from `active` to `blocked` and clears its owner, in the same transaction.

A rollback removes the child, the link, the dependency, the events, and the suspension.

**Rules**

- A child name holds 1 to 200 characters.
- A parent identity owns at most one child created by `runChild`.
- A child request cannot use `idempotency`, `debounce`, `throttle`, `prerequisiteTaskId`, or
  `dependencies`.
- A handler on a fast-tier queue cannot run children. A child request cannot name a fast-tier
  queue.
- The suspension does not consume the parent's logical attempt.

**Events.** `child_created` on the parent, `parent_linked` on the child, and the first
`child_joined` on the parent.

More detail: [Data model: runChild lifecycle](../architecture/data-model.md#runchild-lifecycle) and [Data model: Columns and constraints](../architecture/data-model.md#columns-and-constraints).

</details>

## Run several children at the same time

**Example.** The checkout handler for `ord-9` must also check for fraud and reserve inventory. The
two checks do not depend on each other, so they can run at the same time.

1. The handler calls `HandlerContext.runChildren` with two named requests, `fraud` and `inventory`.
   Workhorse creates both children in one transaction and blocks the parent one time.
2. At 2 s, the `inventory` child succeeds. The `fraud` child still runs, so the parent stays
   blocked.
3. At 5 s, the `fraud` child fails. Both children have ended, so Workhorse releases the parent.
4. A worker runs the handler again from the start. `runChildren` returns one outcome for each name.
5. The outcome of `fraud` has the status `failed`, so the handler rejects the order.

```ts
const results = await ctx.runChildren<{
  fraud: { accepted: boolean };
  inventory: { reserved: boolean };
}>([
  { name: "fraud", type: "orders.check-fraud", payload: { orderId } },
  { name: "inventory", type: "orders.reserve", payload: { orderId } },
]);

if (results.fraud.status === "failed") {
  return { accepted: false, reason: results.fraud.error };
}
```

Thus, a failed or canceled child stays in the returned set, and the parent decides its own result.
Workhorse releases the parent only after every child in the set ends. A set blocks the parent one
time. If the set is empty, `runChildren` returns at once and does not block the parent.

Each outcome has one of three statuses: `succeeded` with a result, `failed` with an error, or
`canceled` with an error. Each SDK gives the outcomes its own types.

<details>
<summary>Reference: child sets and join modes</summary>

**SDK calls**

| SDK        | Every outcome (`settled`)       | All must succeed (`all_success`)          |
| ---------- | ------------------------------- | ----------------------------------------- |
| TypeScript | `runChildren`                   | `runChildrenAll`                          |
| Python     | `run_children`                  | `run_children_all`                        |
| Go         | `RunChildren` → `[]ChildResult` | `RunChildrenAll` → `[]ChildSuccessResult` |
| Rust       | `run_children`                  | `run_children_all`                        |
| Ruby       | `run_children`                  | `run_children_all`                        |

**Outcome types in mode `settled`**

| SDK        | Request            | Returned value                               | Outcome values                                                                |
| ---------- | ------------------ | -------------------------------------------- | ----------------------------------------------------------------------------- |
| TypeScript | `ChildTaskRequest` | An object from each name to a `ChildOutcome` | `{ status, result }` or `{ status, error }`                                   |
| Python     | `ChildTaskRequest` | A dict from each name to a `ChildOutcome`    | `ChildSucceeded`, `ChildFailed`, or `ChildCanceled`                           |
| Go         | `ChildTaskRequest` | Named `ChildResult` values in request order  | `ChildSucceeded`, `ChildFailed`, or `ChildCanceled`; a type switch covers all |
| Rust       | `ChildTaskRequest` | A map from each name to a `ChildOutcome`     | The `Succeeded`, `Failed`, and `Canceled` variants                            |
| Ruby       | `ChildTaskRequest` | A Hash from each name to a `ChildOutcome`    | `status` is `:succeeded`, `:failed`, or `:canceled`                           |

Every set method keeps the declared names.

**`create_children_v1(parent_task_id, worker_id, fence_token, children, mode)`**

- Accepts 0 to 100 requests with unique names. Each name holds 1 to 200 characters.
- Zero children return `{}` without suspension, in either mode.
- A non-empty first call creates every child and edge, then blocks the parent.
- Replay requires the exact names, normalized requests, and mode. It returns only after every child
  reaches a terminal state.
- A parent uses either one `runChild` child or one child set, not both.

**Join modes**

| Mode          | Edge policies (success, failure, cancellation) | Result                                       |
| ------------- | ---------------------------------------------- | -------------------------------------------- |
| `settled`     | `release`, `release`, `release`                | Keyed by child name; one outcome per child   |
| `all_success` | `release`, `fail`, `cancel`                    | Raw successful results under the child names |

In mode `settled`, each value is exactly one of:

- `{ status: "succeeded", result }`
- `{ status: "failed", error }`
- `{ status: "canceled", error }`

The error is the bounded terminal evidence from `task_outcome.error`.

**Result size.** The joined object may not exceed the parent's `result_max_bytes`, which defaults
to 1,048,576 bytes. An oversized join returns `result_too_large` and raises
`ChildResultLimitExceededError`.

**Events.** `children_created` and `children_joined` each append once per set.

More detail: [Data model: Join modes](../architecture/data-model.md#join-modes), [Data model: Creating a child set](../architecture/data-model.md#creating-a-child-set), and [Data model: Columns and constraints](../architecture/data-model.md#columns-and-constraints).

</details>

## Require every child to succeed

Use `runChildrenAll`, `run_children_all`, or `RunChildrenAll` when every child must succeed. This
call does not return a failed or canceled outcome to the handler.

**Example.** The checkout handler for `ord-9` calls `runChildrenAll` with `fraud` and `inventory`.

1. At 2 s, the `inventory` child succeeds.
2. At 5 s, the `fraud` child fails.
3. Workhorse fails the parent. The handler does not run again.

Thus, a failed child fails the parent, and a canceled child cancels the parent. If one child fails
and another child is canceled, the failure has priority. If every child succeeds, the call returns
the result of each child under its name.

<details>
<summary>Reference: all children must succeed</summary>

- Mode `all_success` uses the edge policies `release`, `fail`, and `cancel`.
- The parent ends with the outcome `DependencyFailed` or `DependencyCanceled`. Workhorse deletes
  its runtime row, so the handler does not run again.
- In mode `all_success`, failure takes precedence over cancellation when more than one child is
  rejected.

More detail: [Data model: Join modes](../architecture/data-model.md#join-modes) and [Data model: Settlement](../architecture/data-model.md#settlement).

</details>

## Make the code before the child safe to repeat

**Example.** The checkout handler sends the email "We are processing your order" before it calls
`runChild`.

1. Worker A runs the handler. The handler sends the email and calls `runChild`.
2. The child succeeds, and worker B claims the parent.
3. Worker B runs the handler from the start. The handler sends the email again.

Thus, the code before `runChild` runs again after the parent continues. If a repeat causes an
unwanted external effect, make that code idempotent. As an alternative, put that code in
`HandlerContext.checkpoint`.

## Keep child names stable across deployments

**Example.** The `ord-9` parent is blocked on its child `charge`.

1. A deployment renames the child `charge` to `payment` in the handler code.
2. The child succeeds, and a worker claims the parent with the new code.
3. The handler asks for `payment`, but Workhorse stored `charge`. Workhorse raises a conflict error.
4. The worker fails the parent and does not retry it.

Thus, a parent cannot continue if a deployment renames its child while the parent is blocked. The error
message names the stored child and the requested child. [Durable waits](130-durable-waits.md)
describe the same rule for every replay conflict.

The rule applies to the full request. If a replay changes the name, payload, type, option, or set
members of a child, Workhorse raises a conflict error. Keep child names stable while parents still
wait for their results.

A different case gives a different error. If one handler run joins `charge` and then asks for a
second name, Workhorse raises a limit error. Workhorse also raises a limit error for a set with too
many children. If a joined object is larger than the result limit of the parent, Workhorse raises
an error. Thus, a child tree or a stored result cannot grow without a limit.

<details>
<summary>Reference: replay errors</summary>

**Renamed single child.** `create_child_v2` returns `stored_child_name` with its status.

| Requested name differs, and…                                 | Status           |
| ------------------------------------------------------------ | ---------------- |
| `task_child.last_seen_fence_token` is not the parent's fence | `conflict`       |
| `task_child.last_seen_fence_token` equals the parent's fence | `limit_exceeded` |

A resumed handler has a new fence, so a renamed replay is a conflict. Each SDK's conflict message
names the stored and the requested child.

**Errors**

| Meaning                 | TypeScript, Python, Go          | Rust                              | Ruby                            |
| ----------------------- | ------------------------------- | --------------------------------- | ------------------------------- |
| Changed replay          | `ChildConflictError`            | `Error::Conflict`                 | `ConflictError`                 |
| Child limit             | `ChildLimitExceededError`       | `Error::LimitExceeded`            | `LimitExceededError`            |
| Joined result too large | `ChildResultLimitExceededError` | `Error::ChildResultLimitExceeded` | `ChildResultLimitExceededError` |
| Stale parent ownership  | `ChildLeaseLostError`           | `Error::LeaseLost`                | `LeaseLostError`                |

`ChildConflictError` is a terminal replay conflict. The worker fails the parent through `fail_v1`
and keeps the current attempt. A child-limit refusal follows the parent's retry policy.

More detail: [Data model: Renamed replay of a single child](../architecture/data-model.md#renamed-replay-of-a-single-child) and [Data model: Cancellation and errors](../architecture/data-model.md#cancellation-and-errors).

</details>

## Find the parent and the children of a task

**Example.** The `fraud` child of order `ord-9` failed. An operator sees the `inventory` child in
the task list and wants to find the checkout that created it.

1. The tool of the operator calls `Admin.getTask` on the `inventory` child. Its `parentTaskId`
   names the `orders.checkout` task for `ord-9`.
2. The tool reads that parent with `Admin.getTask`. Its `childTaskIds` name the `fraud` child and
   the `inventory` child.
3. The tool calls `Admin.getChildLineage(taskId)` on the parent. Each returned record has the
   terminal state of the child, so the operator sees that `fraud` failed.

Thus, `Admin.getTask` and `Admin.listTasks` give the `parentTaskId` of a task and the
`childTaskIds` of a parent. `Admin.getChildLineage(taskId)` gives the stored links in the two
directions.

The task detail of the dashboard shows the same parent, children, names, types, and join state. A
related task ID opens that task in the drawer. For a parent, the detail also shows how many stored
child results the parent has joined.

<details>
<summary>Reference: lineage reads</summary>

| Read                                   | Returns                                                                                                                                       |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `Admin.getTask`, `Admin.listTasks`     | `parentTaskId` and sorted `childTaskIds`                                                                                                      |
| `Admin.getChildLineage(taskId, limit)` | At most 1,000 edges in either direction, with a truncation flag. Each record has the child's terminal state and bounded error when available. |
| `readDashboardTaskDetail`              | Reads at most 102 child rows and returns at most 101.                                                                                         |
| `dashboard_task_child_v1`              | The same lineage for the dashboard.                                                                                                           |

A task can own 100 children and be one parent's child, so the dashboard detail holds its complete
direct lineage.

`Queue.health().children` reports `waitingParents`, `pendingChildren`, `unjoinedResults`,
`failedParents`, `canceledParents`, and `capped`.

More detail: [Data model: Lineage reads](../architecture/data-model.md#lineage-reads) and [Data model: Child health](../architecture/data-model.md#child-health).

</details>

## Cancel a parent or a child

**Example.** An operator cancels the `inventory` child while the `ord-9` parent waits for its set.

1. The child is active, so Workhorse records a cancellation request.
2. The worker of the child gets the request with its next heartbeat and signals the handler.
3. The handler of the child stops, and the child ends as `canceled`. Until then, the parent stays
   blocked.
4. With `runChildren`, Workhorse releases the parent. The set gives the cancellation as the outcome
   of `inventory`.
5. With `runChildrenAll`, Workhorse cancels the parent.

Thus, the join mode of the parent decides what a canceled child does to the parent. If the child
has already ended, the cancellation returns its terminal state. The link between parent and child
does not change.

If an operator cancels a blocked parent, the parent ends, but its child continues to run. A later
outcome of the child cannot return that parent to the queue. [Cancellation](120-cancellation.md)
explains how a cancellation request reaches a handler.

<details>
<summary>Reference: cancellation</summary>

| Canceled task           | Effect                                                                |
| ----------------------- | --------------------------------------------------------------------- |
| Blocked parent          | The parent ends `canceled`. The child is not canceled.                |
| Active child            | `cancel_requested`, then `acknowledge_cancel_v1` creates the outcome. |
| Child that has finished | Returns the existing terminal state. Nothing else changes.            |

A child's `canceled` outcome follows its edge policy: `release` for `settled`, `cancel` for
`all_success` and for `runChild`.

More detail: [Data model: Cancellation and errors](../architecture/data-model.md#cancellation-and-errors).

</details>

## Retry or redrive a parent

**Example.** The `ord-9` parent joins its receipt and then throws an error in later code.

1. Workhorse schedules a retry. The parent keeps its identity.
2. The retried handler gets the same receipt from `runChild`. Workhorse creates no second charge
   task.
3. The parent fails again and has no attempts left.
4. An operator [redrives](340-redrive.md) the parent. Workhorse creates a new parent identity
   without the child links.
5. The `runChild` call of the new parent creates a new child.

Thus, a retry keeps the child names, results, and join records of the parent. A redrive starts a
new set of children. The dashboard shows the redrive link next to the original parent and its
children.

Workhorse keeps the records of a parent and its children while either side still needs them. A
child that still runs keeps its ended parent. Workhorse deletes the records only after every linked
outcome is older than its configured retention period.

<details>
<summary>Reference: retry, redrive, and retention</summary>

- A retry or a duplicate dependency wakeup reuses the same edges and results. It appends no
  further join event.
- `redrive_v1` creates a fresh ready task. It never copies child lineage, checkpoints, waits,
  signal deliveries, attempts, or results.
- The parent owns edge lifetime. `prune_terminal_tasks_v1` refuses to prune it while any linked
  child is live or has not crossed the identity, outcome, and history cutoffs.
- Parent deletion removes the dependency and child edges together. A later pass can then reclaim
  the children.

More detail: [Data model: Retention](../architecture/data-model.md#retention).

</details>

## Check the payload of a child against its payload contract

A child type can have a payload contract, as any other task type can. The SDK treats a child
request as an enqueue. It stamps the child with the current contract of its type and checks the
payload first.

If the payload does not match the payload contract, the SDK raises a validation error. Workhorse
creates no child. For example, if `payments.charge` requires an `orderId` string and the handler
gives a number, the call fails. [Payload contracts](230-payload-contracts.md) explain versions and
stamping.

<details>
<summary>Reference: contract validation of child requests</summary>

| SDK                    | Error                         |
| ---------------------- | ----------------------------- |
| TypeScript, Python, Go | `TaskContractValidationError` |
| Ruby                   | `ContractValidationError`     |
| Rust                   | `Error::ContractValidation`   |

TypeScript `runChild`, `runChildren`, and `runChildrenAll` validate and stamp each child's current
contract through `EnqueueContractsModule.taskAcceptance`.

More detail: [Data model: Contract versions on replay](../architecture/data-model.md#contract-versions-on-replay).

</details>

## Join a child after its payload contract changes

**Example.** The `ord-9` parent is blocked on `charge`. Then a deployment adds a new payload
contract version for `payments.charge`.

1. The parent continues. Its handler builds the same request under the new current version.
2. PostgreSQL compares the request with the accepted request. The versions differ, so PostgreSQL
   reports a conflict.
3. The SDK reads the version of each existing child. It builds the request again under those
   versions and tries one more time.
4. The new request matches, and the handler joins the existing child without a conflict error.

Thus, a new payload contract version does not stop a blocked parent. If the new version rejects the
replayed payload, the SDK also builds the request under the accepted versions before it writes. A
changed payload or child set still causes a conflict error. Python applies this rule to
`HandlerContext` and to `AsyncHandlerContext`.

<details>
<summary>Reference: replay under accepted versions</summary>

- On `conflict`, the module reads each existing child's `contract_version` through `task_child`
  and `get_task`. It retries once if the rebuilt request differs.
- A stored null version keeps the child uncontracted.
- The rebuild restores both size limits and both sensitive-key lists.
- If the rebuild also rejects the payload, the original validation error remains.
- PostgreSQL still compares the complete request. A changed payload, type, option, set membership,
  or join mode remains a `ChildConflictError`.

More detail: [Data model: Contract versions on replay](../architecture/data-model.md#contract-versions-on-replay).

</details>

## Next

- [030-delivery-guarantees.md](030-delivery-guarantees.md) — make replayed parent work safe
- [120-cancellation.md](120-cancellation.md) — stop a waiting parent or active child
- [340-redrive.md](340-redrive.md) — why a fresh execution starts a new child tree

---

Exact child schema and lifecycle semantics:
[`architecture/data-model.md`](../architecture/data-model.md#task_child).
