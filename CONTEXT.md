# Workhorse

Workhorse is a durable task queue for PostgreSQL, with TypeScript, Python, and Go workers on one SQL
protocol. This glossary names the product terms that public material and implementation work use
consistently.

## Language

**Durable task queue**:
The product category Workhorse claims: a task queue whose scheduling, retries, waits, and recovery
live in PostgreSQL.
_Avoid as the category_: Durable execution protocol, durable execution platform, workflow engine,
workflow system, job queue, background job framework

**Task**:
The unit of work Workhorse enqueues, claims, retries, and records: one row in `workhorse.task`,
with an identity that survives retries, waits, and worker changes.
_Avoid_: Job, message, work item, activity

**Handler**:
The function a worker runs for a task type. A handler restarts from the top after a retry, a
crash, or a durable wait.
_Avoid_: Processor, job function, activity, task function

**Checkpoint**:
The named durable step inside one handler run whose stored result a later run replays instead of
recomputing.
_Avoid_: Step, sub-task, memoized call

**Routine**:
A scheduled maintenance activity a worker offers to PostgreSQL, such as the tick, history
partitions, history retention, and terminal storage. A routine is not a task and never has a
handler.
_Avoid_: Maintenance task, background task, cron job

**Protocol**:
The versioned schema and SQL functions inside PostgreSQL that every Workhorse SDK calls, so three
languages share one behaviour.
_Avoid_: Durable execution protocol, wire protocol

**Durable execution**:
The feature family that lets a handler survive a crash: named checkpoints, durable waits, and
signals replayed from PostgreSQL. It is not a workflow runtime and persists no program stack.
_Avoid as the product category_: Durable workflows, durable functions

**Public beta**:
A usable 0.x Workhorse release for evaluation and early production adoption. A minor release may
change behaviour, but it upgrades an installed database rather than replacing it. The label retires
at 1.0.0, where **stable** replaces it.
_Avoid as a stability label_: Alpha, pre-release, validation MVP, validation release

**Stable**:
A Workhorse release at 1.0.0 or above, whose governed surfaces change only as SemVer allows.
It is the absence of a qualifier, not a tier above one.
_Avoid as a stability label_: GA, general availability, production-ready, battle-tested

**Governed surface**:
One of the seven artifacts SemVer covers: the SQL protocol and schema, the TypeScript, Python, and
Go APIs, the `workhorse` CLI, the `dashboard/v1` wire contract, and the OpenTelemetry instrument,
span, and attribute names. Everything else is internal and may change in any release.
_Avoid_: Public API, public interface, stable API

**Supported runtime**:
A runtime version in the support matrix. The weekly CI run exercises every declared combination. A
regression on one of these is a release blocker.

**Smoke-tested runtime**:
A runtime exercised only by CI's `runtime-smoke` lane. The lane runs one enqueue, claim, and
complete round-trip on each change and promises nothing beyond that.

**Contract step**:
The one migration that removes rather than adds: it drops superseded functions and narrows the
protocols the installed schema serves. A release ships it; the operator applies it with
`workhorse schema contract` once their fleet has moved, so no release ever performs it for them.
_Avoid_: Cleanup migration, breaking migration, down migration

**Release train**:
The staged publication of Python, npm, and Go artifacts from one source commit within one
controlled release window.
_Avoid_: Simultaneous release, coordinated release

**Telemetry provider**:
The single process-wide destination for Workhorse traces, metrics, logs, and queue observations.
If none is registered, Workhorse discards those signals without changing queue behaviour.

**OpenTelemetry adapter**:
The free integration that translates Workhorse telemetry signals into OpenTelemetry signals.
It does not own Workhorse's signal names or meanings.
