# ADR 0035: Redact dashboard payloads and results in the versioned read surface

- **Status:** Accepted
- **Date:** 2026-08-22
- **Related:** [ADR 0015](0015-operator-query-api.md), [ADR 0027](0027-keep-versioned-dashboard-views.md), [ADR 0029](0029-embeddable-dashboard-backends.md)

## Context

ADR 0015 decided that operator reads redact in PostgreSQL rather than in TypeScript, because a
payload redacted in the application has already crossed the database boundary. The operator query
path honours that: `list_jobs_v1` and the dead-letter query apply
`workhorse.redact_top_level_keys_v1` in SQL.

The dashboard did not. `dashboard_job_v1` projected raw `payload` beside `payload_redact_keys`, and
`dashboard_job_outcome_v1` projected raw `result`, leaving redaction to whichever query happened to
remember it. `readDashboardJobDetail` remembered. `readDashboardTasks` did not: it selected
`j.payload` straight into the `tasks` response, `DashboardJobRow` carried it on the wire, and the
task list in the SPA offered a copy button for it. An operator who marked a payload key sensitive
saw it redacted on the task detail page and in full on the list behind it.

The shape of the views is what made that easy to get wrong. The redaction keys live on
`workhorse.job`, so `dashboard_job_outcome_v1.result` and its keys were in different views, and
every consumer had to know an unwritten join convention to redact correctly.

ADR 0029 then committed to per-language dashboard backends reading these same views. A convention
that one of two TypeScript queries already forgot is not a convention three more implementations
will honour.

## Decision

Move redaction into the versioned read surface, so no backend decides it.

- `dashboard_job_v1.payload` becomes
  `workhorse.redact_top_level_keys_v1(payload, payload_redact_keys)`. Both key columns stay
  projected, so the dashboard can report how many keys were withheld without receiving their
  values. This is a scalar expression over columns the view already selects.
- `dashboard_job_outcome_v1` **stops projecting `result` at all**, and a new versioned function
  `workhorse.dashboard_job_result_v1(job_id)` returns the redacted result for one job.
  `readDashboardJobDetail` calls it; nothing else reads a result.
- `readDashboardJobDetail` drops its own wrapping of both columns, because the read surface now
  owns the decision.

The second point is where measurement changed the design. The obvious shape was to redact `result`
in the view, joining `workhorse.job` for its keys. That join is unconditional, so the task list and
the activity chart — neither of which reads a result — would have paid for it on every query. The
benchmark showed exactly that: `task-page` and `activity-buckets` both lost plan equivalence with
direct SQL. Removing `result` from the view and answering it with a function restores equivalence
and leaves those two paths cheaper than a projection that carries a column they discard.

ADR 0027 reserves versioned functions for "reads that need server-owned parameters, policy, or a
shape PostgreSQL cannot preserve through a view". A redacted result is all three.

There is no live database, so this is an in-place edit of the `_v1` views rather than a `_v2`.
[ADR 0034](0034-reset-the-pre-release-schema-baseline.md) records why that is available.

## Consequences

- A dashboard backend in any language gets redaction by reading the view. Forgetting is no longer
  possible, because the raw column is not reachable through the versioned surface.
- `dashboard/v1` response bodies change for any fixture with redaction keys set, which is a
  reviewed wire change and regenerates the conformance file.
- `dashboard_job_outcome_v1` loses a column. Any future reader that wants a result calls the
  function, which is the point: the expensive, policy-bearing read is opt-in.
- The benchmark itself had to be corrected. It swaps only the relation between its direct-SQL,
  view, and function arms, so once the view redacted and the direct arm did not, the two were no
  longer the same query and the reported plan difference was just the missing redaction. The
  direct-SQL arm now applies the same redaction, and the comparison is meaningful again. A future
  view change that alters a projected value must extend the direct arm the same way, or the
  benchmark will report a regression that is not there.
- An application that legitimately needs the unredacted value still reads it through the core tables
  or through `create_children_v1`, which returns child results to a parent handler. Redaction is an
  operator-surface decision, not storage.

## Rejected alternatives

### Fix `readDashboardTasks` and leave the views alone

One line, and it restores correctness today. It leaves the trap: the next query, in any language,
selects the raw column and reintroduces the leak, and nothing fails when it does.

### Add separate `dashboard_job_redacted_v1` views

Keeps the raw projections for a caller that needs them. Nothing in the dashboard is that caller,
and two views differing only in safety is an invitation to read the wrong one.

### Denormalize the redaction keys onto `job_outcome`

Avoids the join entirely. It duplicates policy state that `workhorse.job` owns, and would need a
write path keeping the copies consistent, to save a primary-key join.

### Redact `result` in the view anyway and accept the plan change

Measured and rejected. Two of the four benchmarked query families lost plan equivalence with direct
SQL, and neither of them reads a result. Paying that on the task list to serve the task drawer is
the wrong trade.

## Validation

The `tasks` and `jobDetail` procedures return the same redacted payload for a job with
`payload_redact_keys` set, and neither response carries a redacted key. The `dashboard/v1`
conformance fixtures regenerate and pass. `pnpm benchmark:dashboard-read-surface` reproduces the
planner cost, node sequence, base relations, and indexes recorded in
`docs/benchmarks/results/2026-08-12-dashboard-read-surface.json`. The run for this change is
`docs/benchmarks/results/2026-08-22-dashboard-read-surface.json`: all four families report
`equivalentResults`, `viewPlanMatchesDirect`, and `functionPlanMatchesDirect`, and the verdict
remains `views`.
