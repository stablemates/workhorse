# Workhorse

Workhorse is a durable job queue for PostgreSQL, with TypeScript, Python, and Go workers on one SQL
protocol. This glossary names the product terms that public material and implementation work use
consistently.

## Language

**Durable job queue**:
The product category Workhorse claims: a job queue whose scheduling, retries, waits, and recovery
live in PostgreSQL.
_Avoid as the category_: Durable execution protocol, durable execution platform, workflow engine,
workflow system, task queue, background job framework

**Protocol**:
The versioned schema and SQL functions inside PostgreSQL that every Workhorse SDK calls, so three
languages share one behaviour.
_Avoid_: Durable execution protocol, wire protocol

**Durable execution**:
The feature family that lets a handler survive a crash: named checkpoints, durable waits, and
signals replayed from PostgreSQL. It is not a workflow runtime and persists no program stack.
_Avoid as the product category_: Durable workflows, durable functions

**Public beta**:
A usable 0.x Workhorse release for evaluation and early production adoption, without compatibility
or schema upgrade guarantees between minor releases.
_Avoid as a stability label_: Alpha, pre-release, validation MVP, validation release

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
