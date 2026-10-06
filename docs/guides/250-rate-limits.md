# How do I control how quickly work starts?

<!-- scenario-names: acme, globex, invoices, refunds, payments, webhooks, provider, provider-api -->

Rate limits protect an external service from a burst of task starts. PostgreSQL owns the budget, so
every worker process observes the same answer.

A concurrency policy limits how much work runs at once. A rate-limit policy controls how quickly
new work begins, even when earlier work finishes immediately.

## One provider, fifty tasks, ten starts a second

Queue `provider-api` calls a payment provider that accepts about ten new requests per second. The
queue's rate-limit policy adds ten tokens per second and keeps at most five after an idle period.
Each task start consumes one token. This is a token bucket: time refills it at the sustained rate,
and the burst value caps how many tokens it holds.

1. **Before 0 s** the queue has been idle for a minute. The bucket refilled, but it holds only five
   tokens, because the burst caps it.
2. **At 0 s** your app enqueues 50 tasks. Workers claim five at once and spend all five tokens.
3. **From 0 s on** the other 45 tasks stay `ready`. PostgreSQL refills a token every tenth of a
   second, and each refilled token lets a claim start one more task.
4. **At about 0.2 s** three of the first five tasks finish. Finishing returns no token, so the
   next start still waits for the next refill.
5. **At about 4.5 s** the last of the 50 tasks has started. After the first five, starts never ran
   faster than ten per second.

The bucket measures starts, not work in progress. A task that succeeds, fails, waits, or loses its
lease gets no refund. A retry is a new start, so it consumes a token just like the first attempt.

PostgreSQL computes every refill from its own clock. A worker whose clock runs ahead cannot create
tokens.

```ts
await queue.syncRateLimitPolicies("billing-workers", [
  {
    queue: "provider-api",
    rate: {
      limit: startsPerWindow,
      intervalMs: windowDurationMs,
      burst: idleBurst,
    },
    perKey: {
      limit: customerStartsPerWindow,
      intervalMs: customerWindowDurationMs,
      burst: customerIdleBurst,
    },
  },
]);
```

<details>
<summary>Reference: bucket fields, refill, and consumption</summary>

**`RateLimit`**, used for `rate` and `perKey`

| Field        | Column                                    | Rule                                         |
| ------------ | ----------------------------------------- | -------------------------------------------- |
| `limit`      | `rate_limit`, `per_key_limit`             | Tokens added per interval. 1 to 1,000,000.   |
| `intervalMs` | `rate_interval_ms`, `per_key_interval_ms` | 1 to 86,400,000 ms (one day).                |
| `burst`      | `rate_burst`, `per_key_burst`             | Tokens kept after idle time. 1 to 1,000,000. |

The three `perKey` columns are all set or all null.

**Refill.** `rate_limit_bucket_v1` refills a bucket in these steps:

1. It computes the elapsed time from `clock_timestamp()`.
2. It clamps a negative elapsed time to zero.
3. It adds `elapsed_ms * limit / interval_ms`.
4. It caps the result at `burst`.

A start needs one whole token.

**Consumption.**

- One admitted start consumes one token in the claim transaction.
- Completion, failure, cancellation, durable suspension, and lease expiry never refund a token.
- A queue without a `rate_limit_policy` row has no start limit.

More detail: [Data model: Consumption and cleanup](../architecture/data-model.md#consumption-and-cleanup).

</details>

## One bucket per customer

Queue `provider-api` serves two customers, `acme` and `globex`. Each enqueue sets `concurrencyKey`
to the customer. The policy's `perKey` bucket allows each customer one start per second, with a
burst of two.

1. **At 0 s** `acme` enqueues 20 tasks. Two start at once and empty the `acme` bucket.
2. **At 0.5 s** `globex` enqueues one task. It sits behind 18 waiting `acme` tasks.
3. **At 0.5 s** a worker claims. The claim passes over the `acme` tasks, because the `acme` bucket
   holds no whole token. The `globex` bucket is full, and the queue bucket has a token, so the
   `globex` task starts.
4. **At 1 s** the `acme` bucket has refilled one token, so one more `acme` task starts.

`acme` waits for its own refill, and its backlog does not hold `globex` back. A task without a key
uses only the queue bucket.

A start needs a token from both buckets: the queue bucket and its key's bucket. The skipped `acme`
tasks stay `ready`, so later work can still start. The claim inspects only a bounded window of the
oldest ready tasks. A task that sits behind more waiting tasks than that window holds waits until
the window reaches it.

The same `concurrencyKey` also counts toward a [concurrency policy](240-concurrency-policies.md)
key limit when the queue has one. The key stays part of the accepted task.

<details>
<summary>Reference: keyed buckets and the policy window</summary>

- A `perKey` policy gives every non-null `task.concurrency_key` an independent bucket within its
  queue.
- `concurrency_key` is 1 to 256 UTF-8 bytes.
- `claim_policy_batch_v1` inspects at most the first 100 ready rows. It orders them by priority
  descending, FIFO sequence, and task identity.
- It selects candidates whose key has concurrency capacity and a rate token.
- The claim consumes the queue token and the key token only after its runtime update selects the
  candidate.
- A claim that admits nothing enters the worker's bounded empty-claim wait.

**Bucket rows.**

- A key bucket that has never started a task has no row and counts as full.
- `rate_limit_bucket` gains a row for a key only when that key consumes a token.
- Each claim inspects the oldest 100 key buckets of its queue. It removes those that have fully
  refilled.

More detail: [Task lifecycle: Key limits and the policy window](../architecture/lifecycle.md#key-limits-and-the-policy-window).

</details>

## Many claims at one bucket

Eight workers claim from `provider-api` at the same moment, and the policy has no `perKey` bucket.
If every claim had to lock one shared balance, the claims would run one at a time. So Workhorse
splits the queue bucket into shares, one per
[admission shard](240-concurrency-policies.md#many-workers-at-one-cap). Each claim spends from the
shards it holds, and claims that hold different shards start tasks at the same time. The shares add
up to the queue's rate and burst.

A `perKey` bucket must see the whole queue. A policy with `perKey` therefore keeps one shard, and
its claims take turns.

<details>
<summary>Reference: shard count and shares</summary>

`admission_shard_count_v1(max_active, max_active_per_key, rate_burst, per_key_limit)` returns:

| Policies on the queue                       | Shards                                                  |
| ------------------------------------------- | ------------------------------------------------------- |
| No `max_active` and no rate policy          | 0                                                       |
| `max_active_per_key` or `per_key_limit` set | 1                                                       |
| Otherwise                                   | `LEAST(8, max_active, rate_burst)`, ignoring a null one |

- `admission_share_v1(total, shards, shard)` gives each shard `total / shards`, plus 1 for each
  shard below `total % shards`.
- A shard holds at most its share of `rate_burst`.
- A shard refills at `rate_limit * share / (rate_interval_ms * rate_burst)` tokens per ms.
- Since schema version 43, a `rate_limit_bucket` row with `bucket_scope` `queue` is inert.

More detail: [Data model: Shard count](../architecture/data-model.md#shard-count).

</details>

## Deploying the policies

The `payments` service owns the rate policies for `provider-api` and `webhooks`, under its own
namespace.

1. **First deploy.** The service synchronizes both policies. Workhorse creates them.
2. **Second deploy.** The provider raised its limit, and the service stopped sending webhooks. The
   service synchronizes only `provider-api`, with the new rate. Workhorse updates that policy and
   removes the `webhooks` policy and its buckets.
3. **Third deploy.** Webhooks come back. Workhorse creates the `webhooks` policy again, and it
   starts with a full burst.

Rate policies are desired state. Your deployment declares every policy its namespace owns, and the
call makes the database match. It adds new policies, updates changed ones, and by default removes
the ones you left out.

TypeScript applications use `Queue.syncRateLimitPolicies`. `Queue.listRateLimitPolicies` returns the persisted definitions.

Go applications use `Queue.SyncRateLimitPolicies` through their caller-owned executor. `Queue.ListRateLimitPolicies` returns the persisted definitions.

Python applications use `Queue.sync_rate_limit_policies` or `AsyncQueue.sync_rate_limit_policies` through their caller-owned connection. `Queue.list_rate_limit_policies` and `AsyncQueue.list_rate_limit_policies` return the persisted definitions.

Use the same queue name when you enqueue. Set `concurrencyKey` for the caller whose traffic needs an
independent budget.

Deleting a policy deletes its buckets. A policy you create again therefore starts with a full
burst.

<details>
<summary>Reference: synchronization and listing</summary>

| SDK        | Synchronize                                                                                        | List                                                                        |
| ---------- | -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| TypeScript | `Queue.syncRateLimitPolicies(namespace, definitions, { prune })`                                   | `Queue.listRateLimitPolicies(queueNames)`                                   |
| Python     | `Queue.sync_rate_limit_policies(namespace, definitions, prune=True)`, and the same on `AsyncQueue` | `Queue.list_rate_limit_policies(queue_names)`, and the same on `AsyncQueue` |
| Go         | `Queue.SyncRateLimitPolicies(ctx, namespace, definitions, options...)`                             | `Queue.ListRateLimitPolicies(ctx, queueNames)`                              |

- All three wrap `sync_rate_limit_policies_v1(namespace, definitions, prune)`.
- A definition contains only `queue`, `rate`, and optional `perKey`.
- One call accepts at most 10,000 unique queues.
- The call rejects a queue that another namespace owns.
- Pruning is on by default. It removes the namespace's policies that the call omits.
- The call rebalances the admission shards of every queue it changes.
- Deleting a policy cascades to its `rate_limit_bucket` rows.
- A listing has no implicit result cap. An omitted or empty list of names reads every policy.
- A fast-tier queue rejects a rate-limit policy with `P1007`.

More detail: [Data model: Synchronization](../architecture/data-model.md#synchronization-1).

</details>

## Seeing who waits for tokens

Go back to `provider-api` at 1 s, with about 35 tasks still waiting for tokens.

1. An operator calls `Queue.rateLimitStatuses`. The status shows no available tokens, a sampled
   count of ready tasks that wait for tokens, and a next start about a tenth of a second away.
2. The queue's health reports `rate-limit-throttled`. The dashboard lists it as an expected
   `Throttling` check, not as a failure.
3. At about 4.5 s the last task starts. The status shows no waiting tasks, and the check clears.

`Queue.rateLimitStatuses` shows the available queue tokens, the throttled ready work, and the next
time a sampled task can start. The dashboard presents those facts separately from active
concurrency. Queue health reports throttled ready work as a degraded reason, and the dashboard
presents it as a neutral `Throttling` check.

<details>
<summary>Reference: status fields and caps</summary>

`Queue.rateLimitStatuses(queueNames)` returns one `RateLimitStatus` per policy:

| Field             | Meaning                                                 |
| ----------------- | ------------------------------------------------------- |
| `availableTokens` | Refilled queue tokens, summed over the admission shards |
| `throttledReady`  | Sampled ready rows waiting for tokens                   |
| `throttledKeys`   | Distinct sampled keys waiting for tokens                |
| `nextEligibleAt`  | The earliest sampled time a waiting task can start      |
| `sampleCapped`    | More ready rows existed than the sample reads           |
| `policySetCapped` | More policies existed than the call observes            |

- The call observes at most 100 policies, and the oldest 100 ready rows per policy.
- `QueueHealth.rateLimitPolicies` carries the same observations and sets `capped` when either limit
  applies.
- `rate-limit-throttled` is a degraded health reason code. The dashboard labels it `Throttling`.
- OpenTelemetry exports configured starts per second, available queue tokens, throttled ready
  depth, and next-eligibility delay. Queue name is the only policy dimension.

More detail: [Data model: Status and telemetry](../architecture/data-model.md#status-and-telemetry).

</details>

## One bucket across queues

Queues `invoices` and `refunds` both call the same provider, and the provider's limit covers both.
A rate policy on each queue cannot see the other's starts. So you synchronize one named budget,
`provider`, with a `rate`, through `Queue.syncBudgets`. Each task in either queue sets
`budget: "provider"`.

1. An `invoices` task starts and draws one token from the `provider` bucket.
2. A `refunds` task starts and draws the next token from the same bucket.
3. When the bucket is empty, ready tasks in both queues wait for its refill.

PostgreSQL refills a budget the way it refills a queue bucket. The budget is an extra check beside
each queue's own rate policy, and it has no per-key bucket. A task that names a budget with no
definition starts freely.

`Queue.budgetStatuses` shows the budget's refilled tokens and how much sampled ready work waits on
it. The same facts appear in `Queue.health()`.

<details>
<summary>Reference: budgets with a rate</summary>

- A `budget` row has a nullable `max_active` and a nullable `rate_limit`, `rate_interval_ms`, and
  `rate_burst`. The three rate columns are all set or all null, with the bounds of
  `rate_limit_policy`. At least one limit is required.
- `Queue.syncBudgets(namespace, definitions, { prune })` wraps `sync_budgets_v1`. A definition
  contains only `name`, optional `maxActive`, and optional `rate`.
- `budget_name` is 1 to 256 UTF-8 bytes.
- `budget_bucket` holds one row per budget with the refill arithmetic of `rate_limit_bucket_v1`.
  Deleting a budget cascades to its bucket.
- A claim probes `budget_bucket_v1(budget_name, now, false)` without consuming. After its runtime
  update selects a candidate, `budget_bucket_v1(budget_name, now, true)` consumes one token.
- `Queue.budgetStatuses(budgetNames)` reports at most 100 budgets. Each row carries
  `availableTokens`, null without a rate, and `blockedReady`, zero unless the budget is saturated.
- `QueueHealth.budgetPolicies` carries the same rows.

More detail: [Data model: Counting and charging](../architecture/data-model.md#counting-and-charging).

</details>

## Next

- [How do I stop one customer from consuming every worker?](240-concurrency-policies.md)
- [What happens when a task fails?](110-retries.md)
- [How do workers claim tasks safely?](020-leases-and-fences.md)

[Architecture reference](../architecture/data-model.md#rate_limit_policy-and-rate_limit_bucket).
