# Tenant cardinality

Claim latency did not grow with tenant count. One queue carrying work for 100 through 100,000
tenants admitted a task in 2.2 to 4.4 ms at the median, with every claim first passing over 80
ready rows whose tenants were at capacity. Per-tenant admission counts stayed on the two partial
indexes at three buffer hits each. The costs that did grow were a deployment cost, one budget
synchronization per tenant, and two shared read surfaces that scale with total task rows rather
than with tenants.

## Method

`pnpm benchmark:tenant-cardinality` rebuilt the dedicated benchmark database once per rung and
profile. Each rung loaded one queue, `tenant-work`, with two ready tasks per tenant for 100,
1,000, 10,000, and 100,000 tenants. Every task carried the tenant as its `concurrency_key`, a
`tenant:<id>` tag, and in the **budgeted** profile a `budget_name` equal to the tenant, with one
budget synchronized per tenant. The **keyed** profile omitted budgets. The queue had a concurrency
policy with `maxActivePerKey` of 2 and a rate policy with a per-key bucket. Each tenant also had a
full per-key rate bucket row, as it would after starting work once.

The first 40 tenants held two active leases each, and their ready rows sat at the head of the
queue, so every `claim_v1` call had to pass over 80 saturated rows inside its 100-row window
before admitting tenant 40's work. The benchmark checked that the first admitted payload belonged
to tenant 40 on every rung.

Each rung measured 25 `claim_v1` calls after 2 warmups, then 10 samples after 2 warmups of the
dashboard task list filtered by one tenant's tag, a raw `tags &&` count, the per-key active count
that admission runs, `queue_health_v1`, and in the budgeted profile `budget_status_v1` over 100
budgets and `budget_admission_v1`. It recorded `EXPLAIN (ANALYZE, BUFFERS)` node types and relation
sizes. PostgreSQL 18.6 ran with 128 MB `shared_buffers` and 4 MB `work_mem`.

The complete machine-readable result is
[`2026-09-16-tenant-cardinality.json`](results/2026-09-16-tenant-cardinality.json).

## Results

### Claim admission

| Tenants | Keyed p50 | Keyed p95 | Budgeted p50 | Budgeted p95 |
| ------: | --------: | --------: | -----------: | -----------: |
|     100 |   2.15 ms |   3.19 ms |      3.71 ms |      4.67 ms |
|   1,000 |   3.50 ms |   4.14 ms |      3.91 ms |      5.03 ms |
|  10,000 |   3.23 ms |   4.70 ms |      4.15 ms |      5.30 ms |
| 100,000 |   3.49 ms |   4.62 ms |      4.37 ms |      5.76 ms |

The per-key active count ran as an `Index Scan` on `task_runtime_active_queue_key_expiry_idx` and
the per-budget count as an `Index Scan` on `task_runtime_active_budget_expiry_idx`, each touching
three shared buffers at every rung. The ready window ran as a `Nested Loop` over
`task_runtime_ready_idx` and `task_pkey` from 1,000 tenants upward, reading 321 to 500 buffers, and
as a sequential scan only at 100 tenants where the table fit in a few pages. Both partial active
indexes stayed at one 8 KiB page because only 80 rows were active.

The budgeted profile cost 0.4 to 1.6 ms more per claim. That is the `workhorse:budgets` advisory
lock plus one `budget_admission_v1` call for each of the 80 passed-over rows, and it did not grow
with tenant count.

Each claim also pruned 100 full per-key rate buckets, oldest first. The bucket table therefore
shrank by exactly 2,700 rows over 27 claims at every rung, from 100,000 to 97,300 rows at the top,
and the 100,000-row table with its primary key occupied 15.6 MB.

### Reads and deployment

| Tenants | Dashboard tasks by tag p50 | `tags &&` count p50 | `queue_health_v1` p50 | Budget sync |
| ------: | -------------------------: | ------------------: | --------------------: | ----------: |
|     100 |                    1.21 ms |             0.18 ms |                182 ms |        8 ms |
|   1,000 |                    1.66 ms |             0.45 ms |                189 ms |       42 ms |
|  10,000 |                    9.12 ms |             2.83 ms |              2,511 ms |    1,119 ms |
| 100,000 |                   93.85 ms |             3.71 ms |              2,698 ms |   13,112 ms |

The raw tag filter used a `Bitmap Index Scan` on `task_tags_gin_idx` from 1,000 tenants upward
and stayed under 4 ms at 200,000 task rows. The dashboard task list with the same tag filter grew
from 1 ms to 94 ms across the ladder. Its cost tracks total task rows: the function materializes
the joined task, runtime, and outcome projection before the tag predicate applies, so one tenant's
page pays for every task in the installation.

`queue_health_v1` took 2.5 seconds once the queue held 20,000 ready rows and 2.7 seconds at
200,000, in both profiles. Its cost tracks ready depth up to its documented sampling caps, not
tenant count, and the 100-budget cap kept `budget_status_v1` at 2.3 to 2.6 ms with 100,000 budgets
defined.

Synchronizing one budget per tenant cost about 130 microseconds per budget through
`sync_budgets_v1` in chunks of 10,000, so 100,000 tenant budgets took 13.1 seconds at deploy time.
The `budget` table and its primary key occupied 12.4 MB at that size, and
`task_runtime_ready_budget_idx` added 8.5 MB over the 200,000 ready rows.

## Decision

Keep the tenant as task metadata (ADR 0069). Admission cost is a function of the bounded window and
the policy shape, not of how many tenants share the queue, so a shared database can carry tens of
thousands of tenants without a tenant column or tenant-leading indexes.

Two observations are worth their own tickets rather than a tenancy change. The dashboard task
list's tag filter pays for the whole task projection before it filters, which is a read-surface
cost at any tenant count. The health snapshot's cost rises with ready depth, which the caps already
bound but which an operator running a deep backlog will notice.

Per-tenant budgets are the one mechanism whose cost is linear in tenants, and it lands at deploy
time rather than on the claim path. An installation with more than a few thousand tenants should
prefer per-key limits for fair share and reserve budgets for tenants that need a cross-queue cap.
