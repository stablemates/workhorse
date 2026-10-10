# How do I run and join a child task?

<!-- scenario-names: orders.checkout, fraud, inventory, payment, ord-9, payments, payments.charge -->

A child task lets one handler hand durable work to another task and use its result later. The
parent gives up its lease while it waits, so it does not occupy a worker slot.

## Run the child from a handler

> **Example.** A checkout handler for order `ord-9` must charge a card before it can finish. The
> charge runs as its own task, on the `payments` queue, so a payments worker can handle it.
>
> 1. **The call.** Worker A claims the `orders.checkout` task for `ord-9`. The handler calls
>    `HandlerContext.runChild` with the name `charge`, the type `payments.charge`, and a payload.
> 2. **The handoff.** In one transaction, PostgreSQL creates the child task, links it to the parent
>    under the name `charge`, and moves the parent to `blocked`. The parent loses its owner, and the
>    child enters the `payments` queue. The handler stops at `runChild`, and worker A's slot is
>    free.
> 3. **The child runs.** A payments worker claims the child and charges the card. The child succeeds
>    with a receipt.
> 4. **The release.** The child's success releases the parent. Worker B claims the parent with a new
>    [fence token](020-leases-and-fences.md).
> 5. **The replay.** Worker B calls the handler from its entry point. The repeated `runChild` call
>    sees the same name and the same request. It returns the stored receipt instead of creating
>    another task, and the handler returns.

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

The wait does not use up an attempt of the parent. `runChild` passes the parent on only a
successful child. If the child fails, Workhorse fails the parent. If the child is canceled,
Workhorse cancels the parent.

A parent can own one child created by `runChild`. Use a child set, described next, when one handler
delegates more than one piece of work.

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

## Run several children at once

The checkout handler now checks fraud and reserves inventory before it accepts `ord-9`. The two
checks do not depend on each other, so they can run at the same time.

1. **The call.** The handler calls `HandlerContext.runChildren` with two named requests, `fraud`
   and `inventory`. PostgreSQL creates both children in one transaction and blocks the parent once.
2. **At 2 s** the inventory child succeeds. The fraud child is still running, so the parent stays
   blocked.
3. **At 5 s** the fraud child fails. Both children have now ended, so PostgreSQL releases the
   parent.
4. **The replay.** A worker runs the handler from the top. `runChildren` returns a tagged outcome
   under each name: `fraud` has the status `failed` with its error, and `inventory` has the status
   `succeeded` with its result. The handler reads the failure and rejects the order.

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

A failed or canceled child stays in the returned set, so the parent decides its own result.

Go handlers use `RunChild` for one child and `RunChildren` for a stable set. The set method returns
named `ChildResult` values in request order. Each result contains a `ChildSucceeded`, `ChildFailed`,
or `ChildCanceled` outcome, so a type switch covers every terminal state.

```go
results, err := handler.RunChildren([]workhorse.ChildTaskRequest{
	{Name: "fraud", Type: "orders.check-fraud", Payload: order},
	{Name: "inventory", Type: "orders.reserve", Payload: order},
})
```

Rust handlers pass `ChildTaskRequest` values to `run_children`. The set method returns a map from
each name to a `ChildOutcome`. Its `Succeeded`, `Failed`, and `Canceled` variants cover every
terminal state.

```rust
let results = context
    .run_children(vec![
        ChildTaskRequest::new("fraud", "orders.check-fraud", &order)?,
        ChildTaskRequest::new("inventory", "orders.reserve", &order)?,
    ])
    .await?;

if let Some(ChildOutcome::Failed(error)) = results.get("fraud") {
    return Ok(json!({ "accepted": false, "reason": error.message }));
}
```

Ruby handlers pass `ChildTaskRequest` values to `run_children`. The set method returns a Hash from
each name to a `ChildOutcome`, whose `status` is `:succeeded`, `:failed`, or `:canceled`.

```ruby
outcomes = context.run_children([
  Stablemates::Workhorse::ChildTaskRequest.new(name: "fraud", task_type: "orders.check-fraud", payload: order),
  Stablemates::Workhorse::ChildTaskRequest.new(name: "inventory", task_type: "orders.reserve", payload: order)
])

fraud = outcomes.fetch("fraud")
if fraud.status == :failed
  {"accepted" => false, "reason" => fraud.error["message"]}
else
  {"accepted" => true}
end
```

An empty set returns at once and does not suspend the parent. A non-empty set suspends the parent
once. PostgreSQL releases the parent only after every child reaches a terminal state.

Use `runChildrenAll`, `run_children_all`, or `RunChildrenAll` when every child must succeed. That
operation propagates outcomes. In the example, the failed fraud check would fail the parent
instead of returning an outcome. A canceled child cancels the parent, unless another child failed:
a failure takes precedence.

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

The error is the bounded terminal evidence from `task_outcome.error`. In mode `all_success`,
failure takes precedence over cancellation when more than one child is rejected.

**Result size.** The joined object may not exceed the parent's `result_max_bytes`, which defaults
to 1,048,576 bytes. An oversized join returns `result_too_large` and raises
`ChildResultLimitExceededError`.

**Events.** `children_created` and `children_joined` each append once per set.

More detail: [Data model: Join modes](../architecture/data-model.md#join-modes), [Data model: Creating a child set](../architecture/data-model.md#creating-a-child-set), and [Data model: Columns and constraints](../architecture/data-model.md#columns-and-constraints).

</details>

## Keep work before the child replay-safe

Suppose the checkout handler emails the customer "We are processing your order" before it calls
`runChild`. The parent resumes after the charge, and the handler runs from the top. The customer
gets a second email.

Code before `runChild` runs again after the parent resumes. Make it idempotent, or wrap it in
`HandlerContext.checkpoint`, when repeating it would cause an unwanted external effect.

Child names must stay stable too. Suppose a deployment renames `charge` to `payment` while the
`ord-9` parent is blocked. When the parent resumes, the new code asks for `payment`, but Workhorse
stored `charge`. Workhorse raises a conflict that names the stored and the requested child. That
diagnosis points at handler code that changed under a suspended parent. Workhorse then fails the
parent instead of retrying it, as [durable waits](130-durable-waits.md) describes for every replay
conflict.

A different case gives a different error. If the same handler run first joins `charge` and then
asks for a second name, Workhorse raises the child-limit error. Keep child names stable across
deployments while parents still need their results.

The same rule covers the rest of the request. Changing a child's name, payload, type, option, or set
membership on replay raises `ChildConflictError`. A set over the bound raises
`ChildLimitExceededError`. A joined object over the parent's result limit raises
`ChildResultLimitExceededError`.

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

More detail: [Data model: Renamed replay of a single child](../architecture/data-model.md#renamed-replay-of-a-single-child).

</details>

## Validate a contracted child

A child type can declare a payload contract like any other task type. Suppose `payments.charge`
requires an `orderId` string, and a handler passes a number. The context validates the payload
and raises a validation error before PostgreSQL creates any child.

Every context treats a child request like an enqueue. It stamps the child with the type's current
contract and validates the payload first.

A replay can meet a newer contract. Suppose `ord-9`'s parent is blocked on `charge` when a deploy
moves `payments.charge` to a new contract version.

1. The parent resumes and builds the same request under the new current version.
2. PostgreSQL compares it with the accepted request, sees a different version, and reports a
   conflict.
3. The context reads the version each existing child was accepted under. It rebuilds the request
   under those versions and tries once more.
4. The rebuilt request matches, and the replay joins the existing child instead of raising
   `ChildConflictError`.

The new contract may also reject the replayed payload outright. The context then rebuilds the
request under the accepted versions before it writes anything.

A changed payload or child set still conflicts. Python applies this to both `HandlerContext` and
`AsyncHandlerContext`. [Payload contracts](230-payload-contracts.md) explains versions and stamping.

<details>
<summary>Reference: contracts on child requests</summary>

**Validation errors**

| SDK                    | Error                         |
| ---------------------- | ----------------------------- |
| TypeScript, Python, Go | `TaskContractValidationError` |
| Ruby                   | `ContractValidationError`     |
| Rust                   | `Error::ContractValidation`   |

**Replay under accepted versions**

- On `conflict`, the module reads each existing child's `contract_version` through `task_child`
  and `get_task`. It retries once if the rebuilt request differs.
- A stored null version keeps the child uncontracted.
- The rebuild restores both size limits and both sensitive-key lists.
- If the rebuild also rejects the payload, the original validation error remains.
- PostgreSQL still compares the complete request. A changed payload, type, option, set membership,
  or join mode remains a `ChildConflictError`.

More detail: [Data model: Contract versions on replay](../architecture/data-model.md#contract-versions-on-replay).

</details>

## Cancel a parent or a child

An operator cancels the `inventory` child while the `ord-9` parent waits on its set.

1. **The request.** The child is active, so Workhorse records a cancellation request. The child's
   worker learns about it through its next heartbeat and signals the handler.
2. **The wait.** The parent stays blocked until the child acknowledges the request.
3. **The acknowledgement.** The child's handler stops, and the child ends as `canceled`.
4. **The join.** With `runChildren`, PostgreSQL releases the parent, and the set returns the
   cancellation as the outcome of `inventory`. With `runChildrenAll`, Workhorse cancels the parent
   instead.

Canceling a child that already finished returns its terminal state. The parent-child record does
not change.

Canceling a blocked parent works the other way. The parent ends, but its child keeps running
independently. A later child outcome cannot return that terminal parent to dispatch.
[Cancellation](120-cancellation.md) explains the cooperative request.

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

## Retry, redrive, and retention

Suppose the `ord-9` parent joins its receipt and then throws on a later step. The parent retries.
It keeps the same identity, so the retried handler reuses the same child names, results, and join
evidence. No second charge task appears.

Now suppose the parent runs out of attempts, and an operator [redrives](340-redrive.md) it. Redrive
creates a fresh parent identity. The fresh parent starts without copied child relationships, so its
`runChild` call creates a new child. The dashboard shows the redrive link beside the original child
tree.

Retention keeps the parent-child record while either side still needs it. A live child protects its
terminal parent. Cleanup removes the old tree only after every linked outcome has crossed its
configured evidence window.

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

## Find a task's parent and children

Go back to order `ord-9` after its `fraud` child failed. An operator sees the `inventory` child in
the task list and wants to know which checkout created it.

1. The operator's tool calls `Admin.getTask` on the `inventory` child. Its `parentTaskId` names the
   `orders.checkout` task for `ord-9`.
2. The tool reads that parent with `Admin.getTask`. Its `childTaskIds` list both the `fraud` child
   and the `inventory` child.
3. The tool calls `Admin.getChildLineage(taskId)` on the parent. Each returned edge carries the
   child's terminal state, so the operator sees that `fraud` failed.

`Admin.getTask` returns a task's `parentTaskId`, and the parent's own record lists its
`childTaskIds`. `Admin.getChildLineage(taskId)` returns the retained edges in either direction.

The dashboard task detail shows the same parent, child, name, type, and join state. Related ids open
that task in the drawer. For a parent, the detail also summarizes how many retained child results it
has joined.

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

More detail: [Data model: Lineage reads](../architecture/data-model.md#lineage-reads).

</details>

## Next

- [030-delivery-guarantees.md](030-delivery-guarantees.md) — make replayed parent work safe
- [120-cancellation.md](120-cancellation.md) — stop a waiting parent or active child
- [340-redrive.md](340-redrive.md) — why a fresh execution starts a new child tree

---

Exact child schema and lifecycle semantics:
[`architecture/data-model.md`](../architecture/data-model.md#task_child).
