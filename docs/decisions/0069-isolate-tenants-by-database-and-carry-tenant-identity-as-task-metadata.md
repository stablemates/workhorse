# ADR 0069: Isolate tenants by database and carry tenant identity as task metadata

- **Status:** Accepted
- **Date:** 2026-09-16
- **Related:** SM-7, SM-10, [ADR 0053](0053-start-migrations-at-0-1-0-and-keep-them-additive.md),
  [ADR 0054](0054-define-what-1-0-0-promises.md),
  [ADR 0067](0067-add-named-budgets-that-span-queues.md)

## Context

SM-7 asks Workhorse to define tenant identity and isolation across tasks, queues, schedules, and
telemetry; to scope concurrency, rate, and retention policies to a tenant; to prevent cross-tenant
reads and operator actions; and to measure index and planning behavior at high tenant cardinality.

The schema has no tenant object. It has four fields that applications already use to describe one:

- `task.concurrency_key` is a queue-scoped admission key. A concurrency policy caps active tasks
  per key, and a rate policy gives each key its own token bucket.
- `task.tags` holds at most 20 strings. A GIN index serves the `&&` and `@>` filters that
  `Admin.listTasks`, dead-letter listing, redrive filters, and the dashboard task list accept. The
  documentation already shows `tenant:acme` as the example tag.
- `task.budget_name` names one budget (ADR 0067). A budget caps active tasks or start rate across
  every queue, so it is the only mechanism that can cap one tenant's total work.
- `namespace` on schedules, policies, and budgets records which deployment owns a row. It is not a
  tenant: one deployment usually serves every tenant.

Everything else in the installation is shared. `retention_policy` is a singleton. The dashboard
has one administrator role, and `docs/features.md` records that SSO, RBAC, and multi-tenancy are
not supported. OpenTelemetry metrics forbid tags and keys as attributes because their cardinality is
data-controlled.

SM-10, which would add roles and an authenticated principal to administrative calls, is in the
backlog. Without a principal, "prevent cross-tenant reads and operator actions" has nothing to
decide against.

Three shapes were considered.

**A first-class `tenant_id` column** on `task`, `task_runtime`, `task_outcome`, both history
tables, schedules, policies, and budgets, enforced by row-level security keyed on a session
setting. It touches every governed surface: the SQL protocol, three SDKs, the `dashboard/v1`
contract, and telemetry names. Every dispatch index would gain a leading column or a duplicate
partial index. `claim_v1` claims by queue across tenants, so a worker would have to run under a
session that sees every tenant, which makes the policy only as strong as the connection's owner.
That is the same boundary a separate database already provides, with more code and a contract step
to make the column mandatory.

**One database per tenant.** PostgreSQL enforces the boundary. Tasks, queues, schedules, policies,
budgets, retention, the dashboard, backups, and connection credentials are separate because they
live in separate databases. Nothing new is built. The cost is one worker fleet, one schema upgrade,
and one connection budget per tenant.

**Tenant as task metadata in one database.** The application writes the same tenant identifier
into the concurrency key, a `tenant:` tag, and a budget name. Existing mechanisms then give fair
share, a per-tenant cap across queues, and filterable reads. The boundary is a convention the
application keeps, not one PostgreSQL enforces.

## Decision

**Workhorse offers two tenancy tiers and names them.** _Isolated tenancy_ is one database per
tenant. It is the only boundary Workhorse enforces, and it is the answer for a tenant whose data may
not share tables with another's. _Shared tenancy_ is one database whose tasks carry the tenant as
metadata. It is the answer for many small tenants that need fair share and per-tenant limits, not
data separation.

**Shared tenancy adds no schema.** The tenant identifier rides on three existing task fields, and
the recommended convention writes the same identifier to all three: `concurrencyKey` for fair
share within a queue, `budget` for a cap across queues, and a `tenant:<id>` tag for reads. A
first-class column is not added, because every limit SM-7 asks for is already enforced by one of
those fields, and the one property they cannot provide needs a principal model this decision does
not own.

**A queue is a dispatch lane, not a tenant.** Tenants share queues. A tenant's fair share comes from
`maxActivePerKey` and `perKey` rate limits on the queue, and its total cap comes from a budget named
after it. A queue per tenant is permitted for a handful of tenants, but it multiplies health rows,
worker queue lists, and policy rows without adding isolation, so the guides do not recommend it.

**Schedules carry the tenant through the task they enqueue.** A schedule definition keeps its
`concurrencyKey`, so a recurring per-tenant schedule names the tenant there. Schedule definitions
carry neither tags nor a budget in this release; adding both is additive and follows ADR 0067's
note. A schedule namespace remains deployment ownership.

**Telemetry never carries the tenant as a metric attribute.** Metric cardinality stays bounded by
queue and task type. In isolated tenancy the process resource attributes identify the tenant, one
worker fleet at a time. In shared tenancy a handler that needs the tenant on its own spans reads
it from the payload; Workhorse's spans carry task identity and type, not the key or tags.

**Retention is per installation.** A tenant that needs its own retention windows needs isolated
tenancy. Per-tenant retention in a shared database would need the tenant on every history row and
on the pruning routines, and the column decision above rules that out for now.

**Cross-tenant reads and operator actions are not prevented in shared tenancy.** Tag filters on
`Admin.listTasks` and the dashboard are conveniences: an administrator sees every tenant, and an
authorized `cancel`, `redrive`, `purgeQueue`, or `runTaskNow` acts on any task. Enforcing a
tenant scope needs the authenticated principal SM-10 introduces, so that work is recorded as a
follow-up that SM-10 blocks, and the limitations page states the gap.

**The cardinality benchmark is `pnpm benchmark:tenant-cardinality`.** It loads one queue with
tasks for 100 through 100,000 tenants, each tenant carrying a key, a tag, and in the budgeted
profile its own budget. The first 40 tenants sit at capacity at the head of the queue so every
claim passes over 80 saturated rows inside the 100-row window. It measures `claim_v1`, the tag
filter, the per-key and per-budget active counts, `budget_status_v1`, and `queue_health_v1`, and
records plan node types and relation sizes. The result is interpreted in
[`docs/benchmarks/2026-09-16-tenant-cardinality-analysis.md`](../benchmarks/2026-09-16-tenant-cardinality-analysis.md).

## Consequences

- An operator chooses a tier by reading one guide, and both tiers work on the installed schema.
  No migration, protocol version, or SDK change ships with this decision.
- Shared tenancy keeps dispatch cost independent of tenant count. Admission counts one key or one
  budget through a partial index, and the ready window is bounded at 100 rows regardless of how
  many tenants wait behind it.
- The application owns the convention. Nothing rejects a task whose key, tag, and budget disagree,
  and nothing stops a read from crossing tenants. Both are stated plainly in the guide and the
  limitations page rather than implied.
- When SM-10 lands a principal, tenant-scoped reads and actions can be built on the `tenant:` tag
  and the key without a schema change, because the tenant identifier is already on every task.
- A first-class tenant column stays possible. It would be additive under ADR 0053 and would
  supersede the tag convention rather than conflict with it.
