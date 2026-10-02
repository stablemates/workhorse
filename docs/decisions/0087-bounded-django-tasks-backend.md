# ADR 0087: Keep the Django Tasks backend bounded by atomic acceptance

- **Status:** Proposed
- **Date:** 2026-10-02
- **Related:** SM-1119, [ADR 0070](0070-publish-the-verified-sqlalchemy-transaction-accessor.md),
  [ADR 0075](0075-shape-the-ruby-sdk-as-one-gem-with-an-active-job-adapter.md)

## Context

Django Tasks separates submission from execution. Applications want to retain decorated tasks
without losing joint commit and rollback with business data.

Django's initial `TaskResult` does not prove commit. Complete result fidelity would require a
durable mapping of attempts, errors, worker identities and return values across processes.

## Decision

Ship `workhorse.django` inside the existing Python distribution, behind its `django` extra.
The base import never imports Django. The extra supports Django 6.1.1 through the 6.1 line;
the maintained fixture pins Django 6.1.1 and Psycopg 3.3.6.

Extract SM-1110's exact `enqueue_in_atomic()` seam into this module. The recipe and Tasks backend
share one guard. Django retains transaction, savepoint, thread and connection ownership.
Both require the explicitly configured database alias's atomic block, including standalone submissions.
Neither installs an `on_commit()` substitute or opens a competing connection.

`WorkhorseTaskBackend` persists a versioned JSON envelope with backend, queue, task path and arguments.
`TASK_PATHS` allowlists decorated module-level synchronous tasks. A dedicated worker resolves those
configured paths at startup. A submitted envelope can select only a task already in that registry.

Return a genuine initial `READY` Django `TaskResult`, with the Workhorse task ID and normalized
arguments. Never cache results. Django result retrieval and refresh remain unsupported after execution.
Workers discard handler return values rather than presenting partial Django result fidelity.

Allow queue and backend overrides when the selected backend's configuration validates them.
`MAX_ATTEMPTS` belongs to the backend and defaults to 25. Workhorse controls retries and final failure;
the decorated callable has no retry API or Django attempt context.
Priority, defer, coroutine tasks and Django context remain unsupported. All corresponding backend
capability flags stay false. Native Workhorse handlers retain the richer APIs.

Inherited asynchronous submission uses Django's thread-sensitive synchronous adapter. It does not
provide asynchronous transactions. Callers wrap the whole synchronous atomic operation.

## Consequences

A task ID can disappear after rollback, including rollback of a released savepoint's outer block.
Applications cannot refresh the initial Django result to determine later execution status.
Workhorse's native operator surfaces remain authoritative for execution and attempts.

The installed module avoids a second package and duplicated transaction guards. Supporting durable
Django results later requires a separate design and cross-process proof, not a capability flag change.
