# How do I limit work across the whole worker fleet?

<!-- scenario-names: export, tenant-a, tenant-b, mail, billing, crm, vendor-api, invoice.sync, contact.sync -->

Worker slots limit one process. A concurrency policy limits dispatch across every worker that
shares the database.

Use a policy when downstream capacity belongs to the application rather than one worker process.
Common examples include a database connection budget or a tenant API limit.

## A durable dispatch budget

The queue `mail` sends email through a provider that allows ten open connections, and at most three
for any one tenant. Four workers run with plenty of free slots between them. The deployment stores
a policy for `mail`: ten active tasks, and three per `concurrencyKey`.

1. **At 0 s** the queue holds six ready tasks for `tenant-a`, four for `tenant-b`, and two keyless
   tasks.
2. **At once** the workers claim. Workhorse admits three `tenant-a` tasks, three `tenant-b` tasks,
   and both keyless tasks. Eight tasks are active.
3. **Still at 0 s** the queue has room for two more, but every remaining task belongs to a full
   key. They stay ready, however many worker slots are free.
4. **At 4 s** one `tenant-a` task completes. Its key now has room, so Workhorse admits the next
   `tenant-a` task.

The policy held because PostgreSQL decided each admission, not the workers.
`Queue.syncConcurrencyPolicies` stores desired policies in PostgreSQL. Workers do not need matching
in-memory configuration, because `claim_v1` reads the policy during admission.
`Queue.listConcurrencyPolicies` returns the persisted policy rows.

Go applications use `Queue.SyncConcurrencyPolicies` through their caller-owned executor.
`Queue.ListConcurrencyPolicies` returns the same persisted policy rows.

Python applications use `Queue.sync_concurrency_policies` or `AsyncQueue.sync_concurrency_policies`
through their caller-owned connection. `Queue.list_concurrency_policies` and
`AsyncQueue.list_concurrency_policies` return the persisted policy rows.

Each policy limits one queue. It can also limit tasks that share a `concurrencyKey` inside that
queue. The same key text in another queue is independent.

Keyless tasks consume queue capacity but do not consume keyed capacity. A null per-key limit
disables keyed admission while retaining the queue limit.

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

The namespace owns the queues it synchronizes. PostgreSQL rejects another namespace that tries to
replace that ownership. Omitted policies are removed unless you disable pruning.

<details>
<summary>Reference: policy definitions and synchronization</summary>

**`ConcurrencyPolicyDefinition`**

| Field             | Rule                                                              |
| ----------------- | ----------------------------------------------------------------- |
| `queue`           | Required. 1 to 256 UTF-8 bytes. Unique within one call.           |
| `maxActive`       | Required. An integer from 1 to 1,000,000.                         |
| `maxActivePerKey` | Optional. An integer from 1 to `maxActive`, or null for no limit. |

`EnqueueOptions.concurrencyKey` is 1 to 256 UTF-8 bytes. It is queue-scoped.

**Synchronization.** `sync_concurrency_policies_v1(namespace, definitions, prune)` reconciles one
namespace atomically.

| SDK        | Synchronize                                                               | List                                                                      |
| ---------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| TypeScript | `Queue.syncConcurrencyPolicies(namespace, definitions, { prune })`        | `Queue.listConcurrencyPolicies(queueNames)`                               |
| Python     | `Queue.sync_concurrency_policies`, `AsyncQueue.sync_concurrency_policies` | `Queue.list_concurrency_policies`, `AsyncQueue.list_concurrency_policies` |
| Go         | `Queue.SyncConcurrencyPolicies(ctx, namespace, definitions, options...)`  | `Queue.ListConcurrencyPolicies(ctx, queueNames)`                          |

- One call accepts at most 10,000 definitions.
- The function rejects a queue owned by another namespace.
- Pruning is on by default. With pruning, an empty set removes every policy the namespace owns.
  TypeScript `{ prune: false }`, Python `prune=False`, and Go `SyncPolicyOptions{Prune: false}`
  keep omitted rows.
- A fast-tier queue rejects a concurrency policy.
- An empty or omitted list filter returns every policy, ordered by `queue_name`.
- `Queue.concurrencyPolicies` is a deprecated TypeScript alias, removed in `1.0.0`.

More detail: [Data model: Synchronization](../architecture/data-model.md#synchronization).

</details>

## Capacity follows leases

Worker W3 holds three active `tenant-a` leases when its machine loses power. Nothing tells the
database.

1. **Until the leases expire** the three tasks still count as active. `tenant-a` stays full.
2. **When the leases expire** PostgreSQL stops counting them. A claim can use that capacity at once,
   even before recovery returns the rows to the queue.
3. **Shortly after**, recovery, a regular background pass that returns expired tasks to the queue,
   releases the rows. That release wakes the workers waiting on `mail`.

The policy counts active tasks whose leases have not expired. This makes the policy a dispatch
budget, not a mutex. If W3 was only frozen, its stale handler can overlap its replacement after
lease expiry. [Fence tokens](020-leases-and-fences.md) still prevent that stale generation from
recording a result.

When a task leaves a full queue, a full key, or a full
[admission shard](#many-workers-at-one-cap), PostgreSQL wakes workers listening for that queue. Any
other release wakes no worker, because no claim was waiting on it. Polling remains the correctness
fallback if a notification is lost.

An expiring lease changes no row, so it wakes no worker. In step 2, a worker whose claim found the
queue full keeps sleeping. That worker finds the capacity at its next poll, or when recovery
releases the expired lease. Recovery is a release from a full queue, so it wakes waiting workers.

<details>
<summary>Reference: capacity and release notifications</summary>

**Counting.** Admission counts only active rows whose `expires_at` is later than now, through
`task_runtime_active_queue_key_expiry_idx`.

**Notification.** `notify_concurrency_capacity_v1` runs when a governed runtime leaves `active` or
is deleted. Completion, failure, retry release, cancellation, durable wait, and recovery all count.
It publishes the queue on `workhorse_tasks` when any of these holds:

1. The row's admission shard has its share of active rows.
2. The queue's active rows reach `max_active`.
3. The row's `concurrency_key` has `max_active_per_key` active rows.

The count includes expired leases and releases that have not committed. A release that cannot take
its shard's lock at once publishes without counting.

**Lease expiry.** Neither `notify_concurrency_capacity_v1` nor `notify_budget_capacity_v1` runs when
a lease expires. `recover_expired_v1` releases the expired row on a later maintenance tick, and that
release publishes the queue.

More detail: [Task lifecycle: Capacity release notifications](../architecture/lifecycle.md#capacity-release-notifications).

</details>

## Many workers at one cap

The queue `export` has a cap of forty active tasks and no per-key rule. Workhorse splits the cap
into eight shares of five, one per admission shard. Workers A and B claim at the same moment.

1. Worker A locks shard 2. Worker B locks shard 5. Neither waits for the other.
2. Worker A wants ten tasks. Its shard has room for five, so A borrows shard 3, which no other
   claim holds. A admits ten tasks.
3. Worker B also wants ten. B never spends room on shards 2 or 3, because A holds them. B borrows
   shard 6, which is free, and admits ten tasks.
4. Both claims commit. Twenty tasks started at the same time, and the total stayed within forty.

A queue cap is one number that every claim must respect. If every claim locked that number, claims
of the queue would run one at a time, however many workers the fleet has.

Workhorse splits a queue's cap into shares, one for each admission shard. The shares add up to the
cap, and each active lease counts against one shard. A claim locks a shard, spends that shard's
share, and borrows other shards only when its own share runs short. It borrows only a shard that no
other claim holds. Two claims that hold different shards therefore admit at the same time.

A claim that holds some shards can see room on a shard it does not hold. It never spends that room,
because another claim may be spending it now. The total stays within the cap, so sharding never
admits past it. A claim that stops short for that reason wakes another worker, which finds the room
once the other claim commits.

Workhorse keeps no shard for a queue without a queue-wide rule. A queue with a per-key rule keeps
one shard, because its keyed admission must see the whole queue. `Queue.syncConcurrencyPolicies` and
`Queue.syncRateLimitPolicies` rebuild a queue's shards each time they run, so the shares always
match the current policy.

A release from a full shard wakes workers even when other shards have room. The releasing
transaction cannot see a claim that has not committed, and that claim may have filled the other
shards.

<details>
<summary>Reference: admission shards</summary>

**Shard count.** `admission_shard_count_v1(max_active, max_active_per_key, rate_burst,
per_key_limit)` returns:

| Queue policy                                 | Shards                                              |
| -------------------------------------------- | --------------------------------------------------- |
| Neither `max_active` nor a rate policy       | 0                                                   |
| `max_active_per_key` or a per-key rate limit | 1                                                   |
| Otherwise                                    | `LEAST(8, max_active, rate_burst)`, ignoring a null |

**Shares.** `admission_share_v1(total, shards, shard)` returns `total / shards`, plus 1 for each
shard below `total % shards`. The shares sum to the total.

**Home shard.** A claim starts at shard `pg_backend_pid() % shards`. It takes the first shard lock it
can get at once. When every shard is held, it waits for its home shard.

**Rebalancing.** `rebalance_admission_shards_v1` rebuilds a queue's rows. Both policy
synchronizations call it for every queue they change or prune. A claim calls it when the stored rows
do not match the policy.

More detail: [Data model: admission_shard](../architecture/data-model.md#admission_shard).

</details>

## Claiming at read committed

Go back to the queue `mail`. An application claims `mail` tasks inside its own transaction, which
it opened at repeatable read.

1. **First try.** Workhorse checks the transaction's isolation level before it takes any lock. The
   level is repeatable read, so Workhorse refuses the claim with an error.
2. **Second try.** The application opens a new transaction at read committed and claims again.
3. **Admission.** The claim takes its locks, counts the active leases, and admits tasks that fit
   the policy.

Admission must see every lease that another claim has committed. Otherwise two claims could each
count room that only one of them may take.

A claim takes its locks first and counts active leases after them. At read committed, PostgreSQL
reads that count from a snapshot taken after the locks. So the count includes any claim that
committed while this one waited. Under repeatable read or serializable, the count reads the
transaction's snapshot instead. That snapshot can predate the wait, so two claims could both admit
past a shared cap.

Workhorse therefore refuses a claim at those levels. Read committed is the PostgreSQL default.
Check the level when a claim runs inside a transaction you own, such as one passed to a provider's
`forTransaction`.

<details>
<summary>Reference: isolation check</summary>

- `claim_v1`, `claim_many_v1`, and `complete_many_and_claim_v1` raise SQLSTATE `0A000` before any
  lock unless `transaction_isolation` is `read committed` or `read uncommitted`.
- PostgreSQL runs `read uncommitted` as read committed, so Workhorse accepts it.

More detail: [Task lifecycle: Isolation requirement](../architecture/lifecycle.md#isolation-requirement).

</details>

## Avoiding a blocked queue

`tenant-a` is full, and fifty more `tenant-a` tasks wait at the head of `mail`. Behind them sits one
`tenant-b` task. A worker claims. Workhorse passes over the `tenant-a` tasks, which stay ready, and
admits the `tenant-b` task.

If one key is full, `claim_v1` can admit later ready work for another key. It searches a bounded
[priority-ordered window](150-priority.md), so admission cost cannot grow with an unlimited
saturated prefix. A task beyond the window waits until the window moves.

`Queue.health()` reports bounded policy summaries, including active capacity, blocked ready work,
and saturated-key counts. OpenTelemetry exports queue-level policy gauges without raw key values.

Nothing records the policy a task ran under. A task keeps the `concurrencyKey` it was enqueued with,
so that key stays true forever. Its queue's limits can change at any time. The dashboard therefore
labels the limits beside a finished task as the queue's current policy rather than as history.

<details>
<summary>Reference: policy window and health</summary>

**Window.** With a per-key rule or a named budget, a claim inspects at most the first 100 ready
rows. It orders them
by priority descending, FIFO sequence, and task identity. It admits the earliest rows whose key has
room. Passed-over rows stay ready and unlocked.

**`QueueHealth.concurrencyPolicies`.** Each entry has `namespace`, `queue`, `maxActive`, `active`,
`available`, `blockedReady`, `maxActivePerKey`, `saturatedKeys`, and `highestKeyActive`. `capped`
marks a bounded result.

**OpenTelemetry gauges.** `workhorse.queue.concurrency.limit`, `workhorse.queue.concurrency.active`,
and `workhorse.queue.concurrency.blocked_ready`.

**Dashboard.** Beside a finished task, the limits carry the label `queue policy now`.

More detail: [Task lifecycle: Key limits and the policy window](../architecture/lifecycle.md#key-limits-and-the-policy-window).

</details>

## Sharing one budget across queues

The queues `billing` and `crm` both call one vendor API, which allows four concurrent calls. Each
queue has its own policy. The deployment also stores a budget named `vendor-api` with four active
tasks.

1. **At 0 s** `billing` starts three `invoice.sync` tasks that name `vendor-api`.
2. **At 1 s** `crm` has two `contact.sync` tasks ready. Its own policy has room, but the budget has
   room for one. Workhorse admits one task, and the other stays ready.
3. **At 3 s** one `invoice.sync` task completes. The release wakes `crm`, and its waiting task
   starts.

A policy limits one queue. When several queues call the same downstream resource, give them a named
budget instead of merging them. Each queue then keeps its own priority order, pause control, and
health row.

`Queue.syncBudgets` stores budgets in PostgreSQL the way policies are stored, and
`Queue.listBudgets` reads them back. Go applications use `Queue.SyncBudgets` and
`Queue.ListBudgets`. Python applications use `Queue.sync_budgets` or `AsyncQueue.sync_budgets`, and
`Queue.list_budgets` or `AsyncQueue.list_budgets`. The namespace owns its budgets and prunes omitted
ones unless you disable pruning.

A synchronization waits for every claim that is admitting work against a budget it changes or
prunes. A claim therefore checks room and charges the rate under one definition, and a new
definition applies from the next claim.

A task names its budget when it is enqueued, with the `budget` option beside `concurrencyKey`. The
budget is an extra check: the task must still pass its queue's own policy. A budget can cap active
tasks, cap the start rate, or both. It has no per-key limit, because keys stay queue-scoped. A task
that names a budget nobody synchronized is not limited by it.

```ts
await queue.syncBudgets("workers", [{ name: "vendor-api", maxActive: 4 }]);

await queue.enqueue("invoice.sync", { id: 1 }, { queue: "billing", budget: "vendor-api" });
await queue.enqueue("contact.sync", { id: 2 }, { queue: "crm", budget: "vendor-api" });
```

Capacity follows leases here too. An expired lease returns budget capacity, and a release wakes
every queue holding ready work that names the budget. `claim_v1` passes over a saturated budget
inside the same bounded window it uses for keys, so other work in the queue keeps flowing.

A worker that asks for several tasks can receive fewer than every cap allows. Workhorse admits the
batch in rounds, and each round ranks every ready task within its key and within its budget. A task
that has both a limited key and a limited budget can take a key rank and still miss its budget rank.
The round then leaves another task of that key waiting, although the key had room for it. Workhorse
never admits past a cap, and a later round or claim takes the waiting task.

`Queue.health()` reports each budget's active count, blocked ready work, and whether it is saturated
under `budgetPolicies`. `Queue.budgetStatuses` returns the same observation on its own. The budget
name is the only label the OpenTelemetry gauges carry.

<details>
<summary>Reference: budgets</summary>

**`BudgetDefinition`**

| Field       | Rule                                                                 |
| ----------- | -------------------------------------------------------------------- |
| `name`      | Required. 1 to 256 UTF-8 bytes.                                      |
| `maxActive` | Optional. An integer from 1 to 1,000,000. Counts across every queue. |
| `rate`      | Optional. A `RateLimit` of `limit`, `intervalMs`, and `burst`.       |

At least one of `maxActive` and `rate` is required. One call accepts at most 10,000 names.
`EnqueueOptions.budget` is 1 to 256 UTF-8 bytes.

**Synchronization.** `sync_budgets_v1` takes `workhorse:budgets`, then `workhorse:budget:<name>`
for every name it defines or can prune, in name order. A claim holds the per-budget lock from
admission to the bucket charge.

**Claim.** A claim locks the budgets named by the first 100 ready rows, in name order. Only the
first round of a batch waits for a budget lock. A budget the claim did not lock has no room for it.

**Release.** `notify_budget_capacity_v1` wakes at most 100 waiting queues per release.

**Status.** `budget_status_v1` reports at most 100 budgets. Each row has `active`,
`availableTokens`, `saturated`, `blockedReady`, `nextEligibleAt`, `sampleCapped`, and
`budgetSetCapped`.

**OpenTelemetry**, with `workhorse.budget.name` as the only dimension:
`workhorse.budget.concurrency.limit`, `workhorse.budget.concurrency.active`,
`workhorse.budget.rate_limit.configured`, `workhorse.budget.rate_limit.available_tokens`,
`workhorse.budget.blocked_ready`, and `workhorse.budget.next_eligible_delay`.

More detail: [Data model: budget and budget_bucket](../architecture/data-model.md#budget-and-budget_bucket).

</details>

## Next

- [020-leases-and-fences.md](020-leases-and-fences.md) — why capacity can return safely after expiry
- [250-rate-limits.md](250-rate-limits.md) — how quickly new work may begin
- [310-workers.md](310-workers.md) — how process-local slots differ from fleet-wide admission

---

Exact limits, SQL functions, indexes, and admission semantics:
[`architecture/data-model.md`](../architecture/data-model.md#concurrency_policy).
