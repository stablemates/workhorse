# How do I limit work across the whole worker fleet?

Worker slots limit one process. A concurrency policy limits dispatch across every worker that shares the database.

Use a policy when downstream capacity belongs to the application rather than one worker process. Common examples include a database connection budget or a tenant API limit.

## A durable dispatch budget

`Queue.syncConcurrencyPolicies` stores desired policies in PostgreSQL. Workers do not need matching in-memory configuration because `claim_v1` reads the policy during admission. `Queue.listConcurrencyPolicies` returns the persisted policy rows.

Go applications use `Queue.SyncConcurrencyPolicies` through their caller-owned executor. `Queue.ListConcurrencyPolicies` returns the same persisted policy rows.

Python applications use `Queue.sync_concurrency_policies` or `AsyncQueue.sync_concurrency_policies` through their caller-owned connection. `Queue.list_concurrency_policies` and `AsyncQueue.list_concurrency_policies` return the persisted policy rows.

Each policy limits one queue. It can also limit tasks that share a `concurrencyKey` inside that queue. The same key text in another queue is independent.

Keyless tasks consume queue capacity but do not consume keyed capacity. A null per-key limit disables keyed admission while retaining the queue limit.

```ts
const queue = new Queue(pool);
const queueBudget = deploymentConfig.mailConcurrency;
const tenantBudget = deploymentConfig.tenantConcurrency;

await queue.syncConcurrencyPolicies("workers", [
  {
    queue: "mail",
    maxActive: queueBudget,
    maxActivePerKey: tenantBudget,
  },
]);

await queue.enqueue(
  "mail.send",
  { messageId: "welcome" },
  { queue: "mail", concurrencyKey: "tenant-a" },
);
```

The namespace owns the queues it synchronizes. PostgreSQL rejects another namespace that tries to replace that ownership. Omitted policies are removed unless you disable pruning.

## Capacity follows leases

The policy counts active tasks whose leases have not expired. If a worker disappears, capacity returns when its lease expires even before maintenance recovers the row.

This makes the policy a dispatch budget, not a mutex. A stale handler can overlap its replacement after lease expiry. Fence tokens still prevent that stale generation from recording a result.

When a task leaves a full queue or a full key, PostgreSQL wakes workers listening for that queue. A release below every cap wakes no worker, because no claim was waiting on it. Polling remains the correctness fallback if a notification is lost.

## Avoiding a blocked queue

If one key is full, `claim_v1` can admit later ready work for another key. It searches a bounded [priority-ordered window](150-priority.md), so admission cost cannot grow with an unlimited saturated prefix.

`Queue.health()` reports bounded policy summaries, including active capacity, blocked ready work, and saturated-key counts. OpenTelemetry exports queue-level policy gauges without raw key values.

Nothing records the policy a task ran under. A task keeps the `concurrencyKey` it was enqueued with, so that key stays true forever. Its queue's limits can change at any time. The dashboard therefore labels the limits beside a finished task as the queue's current policy rather than as history.

## Sharing one budget across queues

A policy limits one queue. When several queues call the same downstream resource, give them a named budget instead of merging them, so each queue keeps its own priority order, pause control, and health row.

`Queue.syncBudgets` stores budgets in PostgreSQL the way policies are stored, and `Queue.listBudgets` reads them back. Go applications use `Queue.SyncBudgets` and `Queue.ListBudgets`. Python applications use `Queue.sync_budgets` or `AsyncQueue.sync_budgets`, and `Queue.list_budgets` or `AsyncQueue.list_budgets`. The namespace owns its budgets and prunes omitted ones unless you disable pruning.

A task names its budget when it is enqueued, with the `budget` option beside `concurrencyKey`. The budget is an extra check: the task must still pass its queue's own policy. A budget can cap active tasks, cap the start rate, or both. It has no per-key limit, because keys stay queue-scoped. A task that names a budget nobody synchronized is not limited by it.

```ts
await queue.syncBudgets("workers", [{ name: "vendor-api", maxActive: 4 }]);

await queue.enqueue("invoice.sync", { id: 1 }, { queue: "billing", budget: "vendor-api" });
await queue.enqueue("contact.sync", { id: 2 }, { queue: "crm", budget: "vendor-api" });
```

Capacity follows leases here too. An expired lease returns budget capacity, and a release wakes every queue holding ready work that names the budget. `claim_v1` passes over a saturated budget inside the same bounded window it uses for keys, so other work in the queue keeps flowing.

`Queue.health()` reports each budget's active count, blocked ready work, and whether it is saturated under `budgetPolicies`, and `Queue.budgetStatuses` returns the same observation on its own. The budget name is the only label the OpenTelemetry gauges carry.

## Next

- [020-leases-and-fences.md](020-leases-and-fences.md) — why capacity can return safely after expiry
- [250-rate-limits.md](250-rate-limits.md) — how quickly new work may begin
- [310-workers.md](310-workers.md) — how process-local slots differ from fleet-wide admission

---

Exact limits, SQL functions, indexes, and admission semantics:
[`architecture.md`](../architecture.md#concurrency_policy).
