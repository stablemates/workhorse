# How do I control how quickly work starts?

<!-- scenario-names: acme, globex, invoices, refunds, payments, webhooks, provider, provider-api -->

A rate limit protects an external service from too many task starts. For example, a payment
provider can accept sixty requests each minute. A [concurrency policy](240-concurrency-policies.md)
cannot enforce this limit, because it limits only the tasks that run at the same time. A rate-limit
policy sets how quickly new tasks start, even when each task ends quickly. PostgreSQL stores the
state of each limit, so all worker processes see the same state.

## Limit how quickly a queue starts tasks

**Example.** Queue `provider-api` calls a payment provider that accepts about sixty new requests
each minute. The rate-limit policy of the queue adds sixty tokens each minute. It keeps a maximum of
ten tokens after an idle period. Each task start uses one token. This is a token bucket: time adds
tokens to the bucket at the rate, and the burst sets the maximum number of tokens.

1. Before 0 s, the queue is idle for one hour. The bucket holds only ten tokens, because the burst
   limits it.
2. At 0 s, your app enqueues 50 tasks. Workers start ten tasks immediately and use all ten tokens.
3. After 0 s, the other 40 tasks stay `ready`. PostgreSQL adds one token each second, and each
   token lets a worker start one more task.
4. At about 0.2 s, eight of the first ten tasks end. A task that ends gives back no token, so the
   next start still waits for the next token.
5. At about 40 s, the last of the 50 tasks starts. After the first ten, no more than one task
   started each second.

The bucket counts starts, not running tasks. A task that succeeds, fails, waits, or loses its lease
gets no token back. A retry is a new start, so it uses a token too. Set the limit for attempts, not
for tasks.

PostgreSQL calculates each refill from its own clock. If the clock of a worker is fast, the worker
cannot create tokens. The claim transaction uses the token, so two workers cannot use the same
token.

To set a rate limit, synchronize a rate-limit policy for the queue.

```ts
await queue.syncRateLimitPolicies("workers", [
  {
    queue: "provider-api",
    rate: { limit: 60, intervalMs: 60_000, burst: 10 },
    perKey: { limit: 5, intervalMs: 60_000, burst: 2 },
  },
]);
```

The `rate` bucket adds `limit` tokens in each `intervalMs`. `burst` sets the maximum number of
tokens after an idle period. Thus, a quiet hour gives a limited number of immediate starts.
`perKey` is optional. It adds one bucket for each key, as the next section shows.

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

More detail: [Data model: Consumption and cleanup](../architecture/data-model.md#consumption-and-cleanup), [Data model: Policy columns](../architecture/data-model.md#policy-columns), and [Data model: Bucket state](../architecture/data-model.md#bucket-state).

</details>

## Give each customer its own bucket

**Example.** Queue `provider-api` serves two customers, `acme` and `globex`. Each enqueue sets
`concurrencyKey` to the customer. The `perKey` bucket of the policy lets each customer start five
tasks each minute, with a burst of two.

1. At 0 s, `acme` enqueues 20 tasks. Two tasks start immediately and use all tokens in the `acme`
   bucket.
2. At 6 s, `globex` enqueues one task. Eighteen `acme` tasks wait before it.
3. Soon after, a worker claims a task. It skips the `acme` tasks, because the `acme` bucket has no
   whole token.
4. The `globex` bucket is full, and the queue bucket has a token, so the `globex` task starts.
5. At 12 s, the `acme` bucket has one new token, so one more `acme` task starts.

The tasks of `acme` wait for the tokens of `acme`, and they do not delay `globex`. A task without a
key uses only the queue bucket.

A start needs a token from two buckets: the queue bucket and the bucket of its key. The skipped
`acme` tasks stay `ready`, so later tasks can start. A claim looks at only a limited number of ready
tasks, in priority order. If a task waits behind more tasks than that limit, it waits until the
claim can see it.

The same `concurrencyKey` also counts toward the key limit of a
[concurrency policy](240-concurrency-policies.md), if the queue has one. The key stays part of the
accepted task.

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

More detail: [Task lifecycle: Key limits and the policy window](../architecture/lifecycle.md#key-limits-and-the-policy-window) and [Data model: Concurrency key](../architecture/data-model.md#concurrency-key).

</details>

## Deploy the rate-limit policies

**Example.** The `payments` service owns the rate-limit policies of `provider-api` and `webhooks` in
its namespace.

1. At the first deploy, the service synchronizes the two policies. Workhorse creates them.
2. Later, the provider increases its limit, and the service stops sending webhooks.
3. At the second deploy, the service synchronizes only `provider-api`, with the new rate. Workhorse
   updates that policy and removes the `webhooks` policy and its buckets.
4. The time before the second deploy adds tokens at the old rate. The new rate applies from the
   deploy.
5. At the third deploy, the service synchronizes `webhooks` again. Workhorse creates the policy
   again, and its bucket starts full.

Rate-limit policies are desired state: the full list of policies that the deployment wants. Your
deployment declares each policy that its namespace owns. The call makes the database match that
list. It adds new policies, updates changed policies, and by default removes the policies that the
list does not contain. Another namespace cannot replace a queue that this namespace owns.

In TypeScript, use `Queue.syncRateLimitPolicies`. `Queue.listRateLimitPolicies` returns the stored
definitions.

In Go, use `Queue.SyncRateLimitPolicies` through the executor that your application owns.
`Queue.ListRateLimitPolicies` returns the stored definitions.

In Python, use `Queue.sync_rate_limit_policies` or `AsyncQueue.sync_rate_limit_policies` through the
connection that your application owns. `Queue.list_rate_limit_policies` and
`AsyncQueue.list_rate_limit_policies` return the stored definitions.

Use the same queue name when you enqueue. If the traffic of a caller needs its own bucket, set
`concurrencyKey` to that caller.

If you delete a policy, Workhorse deletes its buckets. Thus, a policy that you create again starts
with a full burst.

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
- For each queue whose rate changed, the call reads `clock_timestamp()` one time. It refills the
  shards and key buckets of the queue to that reading at the old rate. The new rate applies from
  that reading.
- Deleting a policy cascades to its `rate_limit_bucket` rows.
- A listing has no implicit result cap. An omitted or empty list of names reads every policy.
- A fast-tier queue rejects a rate-limit policy with `P1007`.

More detail: [Data model: Synchronization](../architecture/data-model.md#synchronization-1).

</details>

## See which tasks wait for tokens

**Example.** At 10 s, about 30 tasks of `provider-api` still wait for tokens.

1. An operator calls `Queue.rateLimitStatuses`.
2. The status shows no available tokens, a sampled count of ready tasks that wait for tokens, and a
   next start in about one second.
3. The health of the queue reports `rate-limit-throttled`. The dashboard shows it as an expected
   `Throttling` check, not as a failure.
4. At about 40 s, the last task starts. The status shows no waiting tasks, and the check clears.

`Queue.rateLimitStatuses` shows the available queue tokens and the ready tasks that wait for tokens.
It also shows the number of keys that wait and the next time that a sampled task can start. These
facts show the difference between a task that waits for a token and a queue with no work.
`Queue.health()` includes the same summary.

If ready tasks wait for tokens, queue health reports a degraded reason. The dashboard shows this
reason as a neutral `Throttling` check. The Queues page of the dashboard shows the concurrency and
the start rate in separate columns.

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
- The Queues page of the dashboard shows concurrency and start rate in separate columns.
- OpenTelemetry exports configured starts per second, available queue tokens, throttled ready
  depth, and next-eligibility delay. Queue name is the only policy dimension.

More detail: [Data model: Status and telemetry](../architecture/data-model.md#status-and-telemetry).

</details>

## Share one bucket across queues

**Example.** Queues `invoices` and `refunds` call the same provider, and the limit of the provider
applies to the two queues. A rate-limit policy on one queue cannot see the starts of the other
queue. Thus, you synchronize one budget, `provider`, with a `rate`, through `Queue.syncBudgets`. A
budget is a named limit that tasks in any queue can use. Each task in the two queues sets
`budget: "provider"`.

1. An `invoices` task starts and uses one token from the `provider` bucket.
2. A `refunds` task starts and uses the next token from the same bucket.
3. When the bucket is empty, the ready tasks in the two queues wait for the next token.

PostgreSQL refills a budget in the same way as a queue bucket. A task names its budget with the
`budget` enqueue option. The budget is an extra check, in addition to the rate-limit policy of each
queue. It has no bucket for each key. If a task names a budget that has no definition, the task
starts without a budget limit.

`Queue.budgetStatuses` shows the available tokens of the budget and the sampled ready tasks that
wait for it. `Queue.health()` shows the same facts.

<details>
<summary>Reference: budgets with a rate</summary>

- A `budget` row has a nullable `max_active` and a nullable `rate_limit`, `rate_interval_ms`, and
  `rate_burst`. The three rate columns are all set or all null, with the bounds of
  `rate_limit_policy`. At least one limit is required.
- `Queue.syncBudgets(namespace, definitions, { prune })` wraps `sync_budgets_v1`. A definition
  contains only `name`, optional `maxActive`, and optional `rate`.
- A changed budget rate refills `budget_bucket` to one `clock_timestamp()` reading at the old rate.
  The new rate applies from that reading.
- `budget_name` is 1 to 256 UTF-8 bytes.
- `budget_bucket` holds one row per budget with the refill arithmetic of `rate_limit_bucket_v1`.
  Deleting a budget cascades to its bucket.
- A claim probes `budget_bucket_v1(budget_name, now, false)` without consuming. After its runtime
  update selects a candidate, `budget_bucket_v1(budget_name, now, true)` consumes one token.
- `Queue.budgetStatuses(budgetNames)` reports at most 100 budgets. Each row carries
  `availableTokens`, null without a rate, and `blockedReady`, zero unless the budget is saturated.
- `QueueHealth.budgetPolicies` carries the same rows.

More detail: [Data model: Synchronization](../architecture/data-model.md#synchronization-2), [Data model: Counting and charging](../architecture/data-model.md#counting-and-charging), [Data model: Naming a budget on a task](../architecture/data-model.md#naming-a-budget-on-a-task), and [Data model: Status and telemetry](../architecture/data-model.md#status-and-telemetry-1).

</details>

## Share one bucket between many workers

Many workers can claim tasks from one queue at the same time. If each claim locked one shared
balance, the claims would run one at a time. Thus, Workhorse divides the queue bucket into shares.
An admission shard is one part of the queue limit. Each share belongs to one
[admission shard](240-concurrency-policies.md#run-many-workers-against-one-limit), and each shard
refills its own share.

Each claim uses tokens only from the shards that it holds, so the queue cannot use more tokens than
it has. Claims that hold different shards start tasks at the same time. The shares add up to the
rate and the burst of the queue.

A `perKey` bucket must see the full queue. Thus, a policy with `perKey` keeps one shard, and its
claims run one at a time.

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

More detail: [Data model: Shard count](../architecture/data-model.md#shard-count) and [Data model: Bucket state](../architecture/data-model.md#bucket-state).

</details>

## Next

- [How do I stop one customer from consuming every worker?](240-concurrency-policies.md)
- [What happens when a task fails?](110-retries.md)
- [How do workers claim tasks safely?](020-leases-and-fences.md)

[Architecture reference](../architecture/data-model.md#rate_limit_policy-and-rate_limit_bucket).
