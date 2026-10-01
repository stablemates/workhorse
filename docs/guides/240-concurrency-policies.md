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

When a task leaves a full queue, a full key, or a full [admission shard](#many-workers-at-one-cap), PostgreSQL wakes workers listening for that queue. Any other release wakes no worker, because no claim was waiting on it. Polling remains the correctness fallback if a notification is lost.

An expiring lease changes no row, so it wakes no worker. A claim can use that capacity at once, but a worker whose claim found the queue full keeps sleeping. That worker finds the capacity at its next poll, or when maintenance recovers the expired lease. Recovery is a release from a full queue, so it wakes waiting workers.

## Many workers at one cap

A queue cap is one number that every claim must respect. If every claim locked that number, claims of the queue would run one at a time, however many workers the fleet has.

Workhorse splits a queue's cap into shares, one for each admission shard. The shares add up to the cap, and each active lease counts against one shard. A claim locks a shard, spends that shard's share, and borrows other shards only when its own share runs short. It borrows only a shard that no other claim holds. Two claims that hold different shards therefore admit at the same time.

A claim that holds some shards can see room on a shard it does not hold. It never spends that room, because another claim may be spending it now. The total stays within the cap, so sharding never admits past it. A claim that stops short for that reason wakes another worker, which finds the room once the other claim commits.

Workhorse keeps no shard for a queue without a queue-wide rule. A queue with a per-key rule keeps one shard, because its keyed admission must see the whole queue. `Queue.syncConcurrencyPolicies` and `Queue.syncRateLimitPolicies` rebuild a queue's shards each time they run, so the shares always match the current policy.

A release from a full shard wakes workers even when other shards have room. The releasing transaction cannot see a claim that has not committed, and that claim may have filled the other shards.

## Claiming at read committed

Admission must see every lease that another claim has committed. Otherwise two claims could each count room that only one of them may take.

A claim takes its locks first and counts active leases after them. At read committed, PostgreSQL reads that count from a snapshot taken after the locks, so the count includes any claim that committed while this one waited. Under repeatable read or serializable, the count reads the transaction's snapshot instead. That snapshot can predate the wait, so two claims could both admit past a shared cap.

Workhorse therefore refuses a claim at those levels. `claim_v1`, `claim_many_v1`, and `complete_many_and_claim_v1` raise SQLSTATE `0A000` before they take a lock unless the transaction runs at read committed. PostgreSQL runs read uncommitted as read committed, so Workhorse accepts it too. Read committed is the PostgreSQL default. Check the level when a claim runs inside a transaction you own, such as one passed to a provider's `forTransaction`.

## Avoiding a blocked queue

If one key is full, `claim_v1` can admit later ready work for another key. It searches a bounded [priority-ordered window](150-priority.md), so admission cost cannot grow with an unlimited saturated prefix.

`Queue.health()` reports bounded policy summaries, including active capacity, blocked ready work, and saturated-key counts. OpenTelemetry exports queue-level policy gauges without raw key values.

Nothing records the policy a task ran under. A task keeps the `concurrencyKey` it was enqueued with, so that key stays true forever. Its queue's limits can change at any time. The dashboard therefore labels the limits beside a finished task as the queue's current policy rather than as history.

## Sharing one budget across queues

A policy limits one queue. When several queues call the same downstream resource, give them a named budget instead of merging them, so each queue keeps its own priority order, pause control, and health row.

`Queue.syncBudgets` stores budgets in PostgreSQL the way policies are stored, and `Queue.listBudgets` reads them back. Go applications use `Queue.SyncBudgets` and `Queue.ListBudgets`. Python applications use `Queue.sync_budgets` or `AsyncQueue.sync_budgets`, and `Queue.list_budgets` or `AsyncQueue.list_budgets`. The namespace owns its budgets and prunes omitted ones unless you disable pruning.

A synchronization waits for every claim that is admitting work against a budget it changes or prunes. A claim therefore checks room and charges the rate under one definition, and a new definition applies from the next claim.

A task names its budget when it is enqueued, with the `budget` option beside `concurrencyKey`. The budget is an extra check: the task must still pass its queue's own policy. A budget can cap active tasks, cap the start rate, or both. It has no per-key limit, because keys stay queue-scoped. A task that names a budget nobody synchronized is not limited by it.

```ts
await queue.syncBudgets("workers", [{ name: "vendor-api", maxActive: 4 }]);

await queue.enqueue("invoice.sync", { id: 1 }, { queue: "billing", budget: "vendor-api" });
await queue.enqueue("contact.sync", { id: 2 }, { queue: "crm", budget: "vendor-api" });
```

Capacity follows leases here too. An expired lease returns budget capacity, and a release wakes every queue holding ready work that names the budget. `claim_v1` passes over a saturated budget inside the same bounded window it uses for keys, so other work in the queue keeps flowing.

A worker that asks for several tasks can receive fewer than every cap allows. Workhorse admits the batch in rounds, and each round ranks every ready task within its key and within its budget. A task that has both a limited key and a limited budget can take a key rank and still miss its budget rank. The round then leaves another task of that key waiting, although the key had room for it. Workhorse never admits past a cap, and a later round or claim takes the waiting task.

`Queue.health()` reports each budget's active count, blocked ready work, and whether it is saturated under `budgetPolicies`, and `Queue.budgetStatuses` returns the same observation on its own. The budget name is the only label the OpenTelemetry gauges carry.

## Next

- [020-leases-and-fences.md](020-leases-and-fences.md) — why capacity can return safely after expiry
- [250-rate-limits.md](250-rate-limits.md) — how quickly new work may begin
- [310-workers.md](310-workers.md) — how process-local slots differ from fleet-wide admission

---

Exact limits, SQL functions, indexes, and admission semantics:
[`architecture.md`](../architecture.md#concurrency_policy).
