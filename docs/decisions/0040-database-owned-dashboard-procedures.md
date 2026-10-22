# ADR 0040: Put dashboard procedures in PostgreSQL

- **Status:** Accepted
- **Date:** 2026-08-24
- **Builds on:** [ADR 0029](0029-embeddable-dashboard-backends.md)
- **Related:** [ADR 0027](0027-keep-versioned-dashboard-views.md), [ADR 0037](0037-keep-dashboard-presentation-policy-in-the-spa.md)

## Context

The dashboard wire contract is shared, but TypeScript, Python, and Go each assembled its response
with separate SQL. Conformance tests pinned the output while leaving the queries free to diverge.
The `queues` implementations had already chosen different exact and estimated count paths.

Every new procedure required three implementations. A schema change also required three reviews
to prove that each query preserved the same joins, filtering, and redaction.

## Decision

PostgreSQL owns each database-backed dashboard procedure through a versioned function named
`workhorse.dashboard_<procedure>_v1(p_input jsonb) RETURNS jsonb`. A backend validates the
versioned input, adds process-owned capability flags when required, calls the function, and returns
the decoded document.

The migration starts with `dashboard_queues_v1`, where drift already existed, and
`dashboard_tasks_v1`, which had the largest duplicated query. The remaining read procedures move
in this order: task counts and facets; activity and events; job detail and waits; workers and cron;
then system and settings. Mutations already use shared lifecycle functions and move only when a
database function can return the complete wire document without absorbing host authorization.

The database function owns filtering, ordering, redaction, count selection, and JSON field names.
The SPA retains presentation policy under ADR 0037. A host may enrich the returned document only
from an explicit application callback; TypeScript's `DashboardDurabilityProjector` is the current
exception because PostgreSQL cannot execute application code.

`pnpm check` and the pre-commit hook run `dashboard-spec:check`. Generated Go and Python
bindings can no longer drift until the full test suite happens to run.

## Consequences

Each migrated procedure has one SQL implementation, and every SDK becomes a transport adapter for
that procedure. A query fix lands once and reaches all embedding languages with the schema.

PostgreSQL now builds the wire JSON, so its function version must change when a response contract
changes incompatibly. The conformance suites remain the acceptance test for every backend.

The database performs JSON projection work that previously ran in the host. This cost replaces
three implementations and keeps large intermediate row sets inside PostgreSQL.

## Amendment: the retention preview has a dashboard function (2026-10-22)

`previewRetentionPolicy` was the one database-backed dashboard procedure without a function. Each
host merged the candidate definition, sent a shared statement that read the tables directly, and
capped the counts in its own code. That conflicted with this ADR and with ADRs 0027 and 0029.
SM-1478 records this amendment. The procedure moves to PostgreSQL because the SQL was already
shared, so one function gives one implementation at a small cost.

1. Migration 0076 moves the schema from 74 to 75 and adds
   `dashboard_retention_preview_v1(p_input jsonb) RETURNS jsonb`. The function owns the merge, the
   counts, and the cap. An absent setting keeps its effective value, and an explicit null disables
   its category.
2. All six hosts call the function, and the `internal` statement `retention_policy_preview` leaves
   the manifest. The `dashboard/v1` output does not change.
3. Every SDK statement catalogue names the function, so the SDK schema floor rises from 73 to 75.
   A process from an earlier release keeps its own statement, which reads tables that the migration
   does not change.
