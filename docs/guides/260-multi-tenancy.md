# How do I run several tenants on one Workhorse?

A tenant is a customer, team, or account whose work you must keep fair and bounded, and sometimes
apart. Workhorse offers two ways to do that, and the difference is who enforces the boundary.

With _isolated tenancy_, each tenant has its own database, and PostgreSQL enforces the boundary.
With _shared tenancy_, tenants share one database, and every task carries its tenant as metadata
that the application keeps consistent. Pick isolated tenancy when a tenant's rows may not sit in
the same tables as another's. Pick shared tenancy when you have many tenants that need fair share
and per-tenant limits rather than data separation.

## Isolated tenancy: one database per tenant

Install the schema into one database per tenant and point one worker fleet at each. Tasks, queues,
schedules, policies, budgets, retention, and the dashboard are separate because the databases are.
Nothing in the schema has to know about tenants.

The cost is operational. Each database upgrades on its own, so `workhorse schema migrate` runs
once per tenant on a deploy. Each fleet holds its own connections, and each worker binds to one
database. Telemetry is separate too: the process resource attributes name the tenant, one fleet at
a time.

## Shared tenancy: the tenant rides on the task

In a shared database the tenant is not a column. It is the same identifier written to three enqueue
options that Workhorse already enforces:

- `concurrencyKey` gives the tenant fair share inside a queue. A concurrency policy with
  `maxActivePerKey` caps how many of one tenant's tasks run at once, and a rate policy with
  `perKey` gives each tenant its own token bucket.
- `budget` caps one tenant's work across every queue. Synchronize one budget per tenant with
  `Queue.syncBudgets`, and each task names its tenant's budget.
- A `tenant:` tag makes the tenant filterable. `Admin.listTasks`, dead-letter listing, redrive
  filters, and the dashboard task list accept a tag filter, so an operator can see one tenant's
  work at a glance.

```ts
const tenant = "acme";

await queue.syncConcurrencyPolicies("workers", [
  { queue: "reports", maxActive: fleetCapacity, maxActivePerKey: perTenantCapacity },
]);
await queue.syncBudgets("workers", [{ name: tenant, maxActive: tenantCap }]);

await queue.enqueue(
  "report.generate",
  { month: "2026-08" },
  { queue: "reports", concurrencyKey: tenant, budget: tenant, tags: [`tenant:${tenant}`] },
);
```

Go applications set `ConcurrencyKey`, `Budget`, and `Tags` on `EnqueueOptions` and synchronize
with `Queue.SyncBudgets`. Python applications set `concurrency_key`, `budget`, and `tags` and
synchronize with `Queue.sync_budgets` or `AsyncQueue.sync_budgets`.

A queue is a dispatch lane, not a tenant. Tenants share queues, and the key and budget keep them
fair. A queue per tenant works for a handful of tenants, but it multiplies health rows, worker queue
lists, and policy rows without adding any isolation.

A recurring schedule names its tenant through the `concurrencyKey` in its task definition. Schedule
definitions do not carry tags or a budget yet, so a scheduled task has fair share but no
cross-queue cap until the handler enqueues follow-up work with the full set.

## What shared tenancy does not do

The boundary is a convention your application keeps. Nothing rejects a task whose key, tag, and
budget disagree.

Retention is per installation. Every tenant's history ages under the same windows. A tenant that
needs its own windows needs its own database.

Operator access is not tenant-scoped. An administrator sees every tenant's tasks, and an authorized
cancel, redrive, or purge acts on any task. A tag filter narrows a view; it does not enforce a
boundary. Workhorse will scope operator actions to a tenant once it has an authenticated principal
to scope them to, and the limitations page tracks that gap.

Metrics never carry the tenant. Queue and task type bound the cardinality of every counter and
histogram, and a tag or key would let tenant count multiply the series. A handler that wants the
tenant on its own spans reads it from the payload.

## Dispatch cost does not grow with tenant count

Workhorse counts a tenant's active tasks through a partial index on the key, and a budget's active
tasks through a partial index on the budget name, so admitting one task never scans the other
tenants. When the tenants at the head of a queue are all at capacity, `claim_v1` passes over them
inside a bounded window and admits the next tenant's work. The tenant cardinality benchmark loads
one queue with a widening ladder of tenant counts and shows claim latency flat across it.

## Next

- [240-concurrency-policies.md](240-concurrency-policies.md) — fair share inside a queue and a cap across queues
- [250-rate-limits.md](250-rate-limits.md) — one token bucket per tenant
- [330-retention.md](330-retention.md) — the installation-wide windows shared tenants live under

---

Exact limits on keys, tags, budgets, and the admission window, plus the benchmark evidence:
[`architecture.md`](../architecture.md#tenancy).
