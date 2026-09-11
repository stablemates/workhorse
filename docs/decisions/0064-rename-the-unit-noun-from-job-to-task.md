# ADR 0064: Rename the unit noun from "job" to "task"

- **Status:** Accepted
- **Date:** 2026-09-11
- **Related:** SM-35, SM-715, [ADR 0042](0042-publish-the-first-public-beta.md),
  [ADR 0054](0054-define-what-1-0-0-promises.md)
- **Amends:** [ADR 0011](0011-daily-retention-and-split-maintenance.md) (the maintenance
  vocabulary), [ADR 0051](0051-lead-with-durable-job-queue.md) (the category noun),
  [ADR 0053](0053-start-migrations-at-0-1-0-and-keep-them-additive.md) (the 0.1.0 baseline
  freeze)

## Context

Workhorse used two nouns for the unit of work. The SQL protocol, the three SDKs, the CLI, the
OpenTelemetry names, `CONTEXT.md`, and the guides said "job". The dashboard, most of the
`dashboard/v1` wire contract, the site hero, and the dashboard-facing sentences in several guides
said "task". ADR 0051 fixed the category noun as "durable job queue" and recorded the unit noun as
unsettled. SM-35 owned the decision.

"Task" also carried a second meaning. ADR 0011 named the three scheduled maintenance activities
"maintenance tasks", and that word reached `maintenanceTaskPollMs`, `maintenance_state.task_name`,
the `background_tasks` maintenance loop, and the cron page of the dashboard. `AGENTS.md` asks that
each term have one meaning.

A survey of twenty-five peers, recorded in the operations repository, found the field split.
Postgres-native queues say "job". Celery, its Python descendants, and the durable-execution
projects closest to Workhorse's architecture say "task". Neither word is more precise once the
function has its own name, and Workhorse already calls the function a handler. The maintainer's
preference was "task" for how it reads across the unit's lifetime: a task waits for approval, a task
is blocked on its children, a task survives a crash.

No production installation exists. The only live database is the demo, which is reinstalled. The
published 0.1.x packages are not carried forward by anyone this project has agreed to support.

## Decision

**The unit noun is task, everywhere.** The row in `workhorse.task` is a task. The function a worker
runs for a task type is a **handler**. The named durable step inside one handler run is a
**checkpoint**. A scheduled maintenance activity is a **routine**. "Job" leaves the product
vocabulary; `CONTEXT.md` lists it under the terms to avoid.

**The category line changes with the noun.** Every outbound surface repeats:

> A durable task queue for PostgreSQL, with TypeScript, Python, and Go workers on one SQL protocol.

The short form is "A durable task queue for PostgreSQL." Everything else ADR 0051 decided stands:
the protocol clause, the hero exemption, the three supporting claims, the primary audience, and the
rule that "durable execution" names the feature family and never the category. This is a change of
noun, not of positioning.

**The rename reaches every governed surface at once.** The schema, the SQL function and parameter
names, the `protocol/v1` catalogue, the three SDK APIs, the `workhorse` CLI, the `dashboard/v1`
wire contract, and the OpenTelemetry instrument, span, and attribute names all move in one change.
The `pg_notify` channel `workhorse_jobs` becomes `workhorse_tasks`. The substituted error name
`RedactedJobError` becomes `RedactedTaskError`. The instruments `workhorse.jobs.*` become
`workhorse.tasks.*`, the span events and attributes `workhorse.job.*` become `workhorse.task.*`,
and the unit `{job}` becomes `{task}`. Maintenance identifiers rename first, so "task" never holds
two meanings in one commit.

**The 0.1.0 baseline is re-cut once more.** ADR 0053 froze `sql/releases/0001.sql` at publication
and allowed a re-cut only while no database was carried forward. That condition still holds in
fact, though not by date, so this decision re-cuts the baseline in place rather than shipping the
rename as a migration. `protocol/v1/governed-surface.json` and `dashboard/v1/governed-surface.json`
are rewritten with `--accept-breaking`. For `dashboard/v1` this is a one-time exception to the rule
in `docs/compatibility.md` that a break creates `dashboard/v2`: no consumer outside this repository
speaks the contract yet, and a second directory would document a contract nobody used. `api/go.txt`
records every renamed Go export against the pinned beta tag.

**The change ships as 0.1.4.** ADR 0042 promises that a 0.x minor release may break the schema and
says nothing about a patch. This patch does. The changelogs state that a 0.1.x database must be
dropped and reinstalled, and that no migration exists between 0.1.3 and 0.1.4.

**Two guide slugs and two site URLs change.** `010-jobs-and-state`, `160-job-dependencies`, and
`170-child-jobs` keep their numbers and change the words after them. `/docs/job-dependencies` and
`/docs/child-jobs` answer with a permanent redirect from `site/nginx.conf`.

**History keeps its words.** Accepted decision records, benchmark analyses and results, recorded
agent-eval sessions, and dated changelog entries are not rewritten. `sql/benchmark-conventional.sql`
models a conventional job queue for comparison and keeps that name. Foreign uses of the word, such
as CI jobs and competitor terminology, are untouched.

## Considered options

- **Keep "job" and finish the dashboard rename toward it.** The smaller change, and the word of the
  Postgres queue neighbourhood. Rejected because the maintainer's preference was the other word and
  the cost was symmetric with no installation to protect.
- **Keep both, with "task" as the operator-facing word.** Rejected because it makes the glossary
  fight the wire contract forever and violates the one-meaning rule.
- **Ship `dashboard/v2` and a schema migration.** Rejected because both would document a
  compatibility path for consumers who do not exist.

## Consequences

The dashboard's existing "task" vocabulary becomes the whole product's. `dashboard_job_detail_v1`
joins `dashboard_tasks_v1` under one prefix. `HandlerContext.task` is the most-touched identifier
in every guide and example. The Python SDK exports no bare `Task` class, so `asyncio.Task` cannot
collide with it in a wildcard import. `go/deprecated.go`, which aliased pre-rename Go names, is
deleted rather than extended.

Saved dashboards, alerts, and queries built on `workhorse.jobs.*` or `workhorse.job.*` stop
matching. The SigNoz dashboard definition in `docs/signoz/` moves with the names.

Execution is SM-715. The research note that informed the decision lives in the operations
repository as `docs/research/2026-09-11-unit-noun-and-durable-execution-position.md`.
