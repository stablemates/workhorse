# ADR 0027: Keep versioned dashboard views

- **Status:** Accepted
- **Date:** 2026-08-12
- **Amended by:** [ADR 0057](0057-retain-superseded-functions-and-contract-on-the-operators-schedule.md)

## Context

The dashboard used to query core tables directly. Schema version 26 introduced `dashboard_*_v1`
views and moved the dashboard read model onto them. The views give core a versioned compatibility
boundary, but they are useful only if PostgreSQL can still push filters and joins into the private
tables.

The fallback choices were versioned SQL functions or pinned direct SQL. SQL functions can own an
entire query, but that makes each dashboard query part of the schema API. Pinned direct SQL keeps
the old plans, but a core schema change still requires a coordinated dashboard release.

## Measurement

`typescript/core/benchmarks/dashboard-read-surface.ts` recreates the dedicated benchmark database, installs the
current schema, and loads 100,000 jobs. The dataset contains 20,000 live runtime rows, 80,000
terminal outcomes, 200,000 events, 80,000 attempt rows, 2,000 waits, and 10,000 checkpoints.
PostgreSQL analyzes every relation before measurement.

The benchmark mirrors four production query shapes from `server/read-model.ts`:

- The task page joins identity, runtime, outcome, wait, checkpoint, event, and attempt data. It
  applies queue, tag, and search filters before sorting and pagination.
- The activity chart starts from recently updated runtime and outcome rows. It performs the worker
  lookup, task filters, time buckets, and grouped counts used by the dashboard.
- The event feed bounds and sorts each partitioned history source before a materialized merge. It
  applies the job lookup, final pagination, duration projection, and result ordering.
- The event total counts the same filtered window directly from both partitioned history sources.

Each shape runs as direct table SQL, through the shipped `dashboard_*_v1` views, and through a
candidate versioned SQL function. The benchmark executes two discarded warmups and seven measured
`EXPLAIN (ANALYZE, BUFFERS, WAL, FORMAT JSON)` repetitions per strategy. It rotates strategy order
to reduce cache-order bias. It also hashes the returned rows before plan measurement.

All twelve result sets matched. For every query shape, the views and functions produced the same
planner cost, node sequence, base relations, and indexes as direct SQL.

| Query              | Direct mean | View mean | Function mean | Direct/view/function cost |
| ------------------ | ----------: | --------: | ------------: | ------------------------: |
| Task page          |    18.38 ms |  18.29 ms |      18.37 ms |                  6,808.53 |
| Activity buckets   |    22.42 ms |  21.73 ms |      21.75 ms |                  6,563.49 |
| Event feed page    |     0.65 ms |   0.64 ms |       0.64 ms |                  1,312.96 |
| Event window count |     8.67 ms |   9.07 ms |       8.64 ms |                  4,192.56 |

The full plans, environment, execution order, samples, buffers, and result hashes are in
`docs/benchmarks/results/2026-08-12-dashboard-read-surface.json`. This is one PostgreSQL 18.4 run
on a warm local database. The plan equivalence supports the decision; the timing samples are a
cross-check, not a latency claim.

## Decision

Keep the `dashboard_*_v1` views as the dashboard read boundary.

The loaded plans show no predicate-pushdown or index-selection regression. Views preserve the
existing query structure while letting core keep private table changes behind stable projections.
Versioned functions add no plan benefit in this run, so they should be reserved for reads that
need server-owned parameters, policy, or a shape PostgreSQL cannot preserve through a view.

## Consequences

- The dashboard continues to query only the versioned views and the existing
  `dashboard_job_estimate_v1()` function.
- Core may change private tables without a dashboard release when the versioned projections remain
  compatible.
- A future view that adds aggregation, security barriers, or expressions around filtered columns
  must rerun this benchmark because those changes can prevent planner inlining.
- The dashboard package remains pinned to the compatible pre-release line until schema capability
  negotiation replaces exact-version compatibility.

## Rejected alternatives

### Replace the views with versioned SQL functions

The candidate functions inlined to the same plans and ran within the same timing range. They would
make more SQL signatures part of the core API without improving these reads.

### Return to pinned direct SQL

Direct SQL produced the same loaded plans, so it gives up independent release cadence without a
measured performance benefit.

## Validation

Run `pnpm benchmark:dashboard-read-surface` against the checkout's dedicated benchmark database.
The run must preserve result hashes, raw plans, buffer counts, execution samples, and rotated order
for all three strategies.
