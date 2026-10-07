# Workhorse architecture: schema and SQL protocol

This page is part of the [Workhorse architecture reference](../architecture.md). It owns the schema
version, the migration plan and runner, and SQL protocol conformance.

Workhorse is a PostgreSQL-backed durable queue whose correctness-sensitive lifecycle transitions
live in versioned SQL functions. The TypeScript, Python, Go, and Rust `Queue`, `Admin`, and `Worker`
remain thin protocol clients.

## Schema versions and migrations

### Current version and baseline

The current schema version is 64 (`WORKHORSE_SCHEMA_VERSION`) and the migration baseline is 6
(`WORKHORSE_SCHEMA_BASELINE_VERSION`). `sql/releases/0006.sql` contains the baseline clean-install
artifact, which is the 0.2.0 schema.

The chain began at 1 and was pruned to this baseline when 0.1.x support was dropped
([ADR 0073](../decisions/0073-prune-the-migration-chain-to-the-0-2-0-baseline.md)). So
`applySchemaMigrationPlan` refuses an installed version below 6. Its message names Workhorse 0.2.1
as the last release that migrates one.

SQL protocol functions keep their independent `_vN` suffix. A schema migration does not rename a
function or reinterpret that suffix.

### Install, migrate, and contract

- `installSchema` reads `sql/schema.sql`. It accepts a fresh database or an already-current schema.
- `migrateSchema` applies `SCHEMA_MIGRATIONS` from `sql/migrations/` through the same path as
  `workhorse schema migrate`. It stops before the first step whose `kind` is `contract`, and reports
  that step in `MigrateSchemaResult.contractStop`.
- `contractSchema` applies the one contract step pending at the installed version through
  `workhorse schema contract`. That command requires `--yes`. It first names every worker still live
  on a retiring protocol.

The current migration plan has one contract step. `0025-add-a-fast-task-tier.sql` moves schema 24 to
25 and retires protocols 1 through 4. On an older installation, `migrateSchema` therefore stops at
schema 24, and `contractSchema` applies step 25. The additive steps 26 through 64 follow, so a
second `migrateSchema` run completes the plan.

Their files run from `0026` to `0065`. File number `0035` was reserved and never used. From `0036`
on, a file's number is therefore one above the version it produces.

Step 25 ships without the usual retention window, as
[ADR 0077](../decisions/0077-add-a-fast-task-tier-that-records-one-outcome-row-per-task.md) §6
records.

### Migration history and served protocols

A clean installation records `(6, 'baseline')` in `workhorse.schema_migration`, then one row per
later step.

`workhorse.protocol_version` records the served SQL protocol versions (currently exactly 5),
independently of that history. `readProtocolVersions` reads it and returns null when that table is
absent.

### The migration plan

`migrateSchema` delegates ordered execution to the internal `applySchemaMigrationPlan` function. Its
`SchemaMigrationPlan` has `baselineVersion`, `currentVersion`, `steps`, and `readStep` fields.

Each `SchemaMigrationStep` has `fromVersion`, `toVersion`, `file`, `description`, `kind`,
`execution`, and `retiresProtocolVersions` fields:

- `kind` is `additive` or `contract`.
- `retiresProtocolVersions` is required on a contract step and forbidden on an additive one.
- `execution` is `transactional` or `nontransactional`. It defaults to `transactional` when absent.

Every migration file opens with a `-- workhorse-migration: {"kind": ...}` declaration. The runner
requires that declaration to agree with its `SCHEMA_MIGRATIONS` entry on both `kind` and
`execution`.

### Transactional steps

The plan runner wraps every step file in one transactional script, in this order:

1. `BEGIN`.
2. The `pg_advisory_xact_lock(hashtext('workhorse:schema-migration'))` lock.
3. A guard that raises unless exactly one `workhorse.schema_version` row equals `fromVersion`.
4. The step body.
5. The bookkeeping that advances `workhorse.schema_version` and inserts the
   `workhorse.schema_migration` row.
6. `COMMIT`.

The runner rejects a body before execution when it contains any of these:

- `BEGIN`, `COMMIT`, `ROLLBACK`, or `START TRANSACTION`.
- A statement-ending `END` or `ABORT`.
- `PREPARE TRANSACTION`.

When a step fails, the runner reports one of two outcomes:

- If a concurrent migrator committed the same step, the failure is treated as that migrator's
  success.
- Any other failure rolls back atomically and reports
  `Workhorse migration <file> failed and was rolled back`.

Before reading the version back, the runner issues `ROLLBACK`. That ends the aborted transaction a
failed step leaves behind when the caller passed a single `Client` rather than a `Pool`.

### Nontransactional steps

A step declaring `execution: "nontransactional"` runs outside that script. That lets
`CREATE INDEX CONCURRENTLY` reach PostgreSQL outside a transaction block.

`splitSqlStatements` divides its body at semicolons outside strings, quoted identifiers, comments,
and dollar-quoted bodies. The runner sends the guard, then each statement, then the bookkeeping, as
separate queries. The guard is repeated inside the bookkeeping transaction behind the advisory lock.
`lock_timeout` is not set for such a step.

Nothing rolls back. A failure leaves the earlier statements applied at the starting version. It
reports `Workhorse migration <file> failed part-way and rolled nothing back`.

### Refused installations

Each of these fails without running a migration:

- An installed version below the baseline 6 or above the current 64.
- A version no step starts from.
- A `workhorse.schema_version` table without exactly one row.

`isMissingDatabaseRelationError` unwraps database errors through `databaseErrorCode`. It returns
true only for PostgreSQL SQLSTATE `3F000` (invalid schema name) or `42P01` (undefined table).

### Migration tests

`typescript/core/test/schema-migrations.test.ts` migrates every frozen artifact under
`sql/releases/`. It requires schema-only dump equality with a clean installation.

## SQL protocol conformance

### Manifest and compatibility fixture

`protocol/v1/manifest.json` declares fixture format 1 and SQL protocol 5. It accepts installed
schema versions 54 and newer inside the major line, and client protocol 5 only. Schema version 54
is the floor because earlier schemas treat the terminal failure override as an immediate retry.

`MINIMUM_SCHEMA_VERSION` carries `protocol/v1/manifest.json`'s `schema.minimumVersion`. That value
is derived rather than authored. It is the newest schema version that introduced an object this
release calls. `docs/schema-lifecycle.md` states how it is derived and what enforces it.

The manifest also pins `dashboard_signal_wait_v1` and `dashboard_human_wait_v1` as read contracts.
Their projections support public external-wait lists without exposing private tables.

`protocol/v1/compatibility.json` distinguishes an absent, older, current, or newer installed schema
from the client's protocol version. Every incompatible case requires refusal before a mutating
function runs.

### Governed surface

`protocol/v1/governed-surface.json` records the wider set. It lists every `workhorse.` function,
view, and column a supported release reads, with the internal helpers listed beside them.

`scripts/generate-sql-catalogues.ts` derives that file from these sources, then classifies a change
against it:

- the manifest's statement catalogue;
- the three dashboard backends;
- the published `dashboard_*_v1` views.

`pnpm sql-catalogues:check` fails a removed or retyped entry by name and passes an addition. The
generator may add to that file and may never drop from it. A migration that drops a function
therefore fails, even though `sql/schema/current.sql` drops it too.

### Scenario fixture

`protocol/v1/scenarios.json` executes raw versioned PostgreSQL functions and versioned dashboard
views. It covers enqueue, claim, heartbeat, completion, failure, cancellation, retry, checkpoint,
timer boundaries, coalescing, dependencies, child tasks, signals, and human decisions.

Its matching rules:

- Exact JSON surrounds typed placeholders for UUIDs, timestamps, and integers.
- Captured values preserve identity and fence relationships across later steps.
- Structured errors pin SQLSTATE, message, canonical JSON detail, and deterministic digests.

### Interpreter fixture

`protocol/v1/interpreter.json` pins the semantics of `$type`, `$ref`, normalization, capture reuse,
and structured-error matching without querying PostgreSQL. Each language executes it through its
own functions:

| Language   | Functions                                                                                                |
| ---------- | -------------------------------------------------------------------------------------------------------- |
| TypeScript | `materializeInterpreterValue`, `normalizeFixtureValue`, `assertFixtureValue`, `assertProtocolErrorValue` |
| Go         | `materializeInterpreterValue`, `normalizeProtocolValue`, `matchFixtureValue`, `matchProtocolErrorValue`  |
| Python     | `materialize_interpreter_value`, `normalize`, `assert_value`, `assert_error_value`                       |

### Runtime fixtures

`protocol/v1/runtime.json` defines worker behavior above the SQL protocol. The TypeScript suite runs
every fixture through `Worker`. Python, Go, and Rust runtimes must run the same fixtures.

| Fixture      | Pins                                                                                                                                                                                                 |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Batch        | Priority order, positional outcomes, retries, terminal failures, and independent attempt state.                                                                                                      |
| Suspension   | Durable-timer suspension, immediate worker-slot release, replay within one logical attempt, and reuse of completed checkpoints.                                                                      |
| Ownership    | Cooperative cancellation, database-authoritative deadline and execution-timeout settlement, lease-loss fencing, non-overlapping worker heartbeat batches, and graceful drain without further claims. |
| Poll cadence | The empty-claim backoff step.                                                                                                                                                                        |

In the poll-cadence fixture, `emptyPollsBeforeEnqueue` names the step under test. Each language
holds its worker at the end of every empty claim, so the enqueue lands on that step rather than on
whichever step the runner reached. `enqueueStallMs` then delays the enqueue past one whole step. An
executor that only counts empty polls therefore fails on every run instead of once under load.

### Durable replay conflicts

All five SDK workers settle durable replay conflicts through `fail_v1` with `p_retry_delay_ms = -1`.
Schema version 54 reserves that override for terminal failure, even when
`current_attempt < max_attempts`. Earlier schemas interpret the terminal override as an immediate
retry, so workers require schema version 54.

Both `fail_v1` and `fast_fail_v1` preserve the current attempt and write the usual failed outcome
and history. Ownership, cancellation, deadline, and execution-timeout checks still precede failure
settlement.

The retry-delay argument has these other meanings:

- NULL uses the persisted retry policy.
- Zero requests an immediate retry.
- Other negative values retain their legacy zero-delay behavior.

#### Conflict classes

The terminal classes are `CheckpointConflictError`, `WaitConflictError`, `ChildConflictError`, and
`HumanWaitConflictError`. `ChildConflictError` includes a changed child set.

- Go recognizes wrapped conflicts with `errors.As` and preserves their class names.
- Rust converts `Error::Conflict` for `Operation::Checkpoint`, `Sleep`, `RunChild`, `RunChildren`,
  and `WaitForHuman` into those named `HandlerError` values. Its generic error conversion requires
  an owned (`'static`) error so it can inspect the error chain. Conversion examines at most 16
  errors, including the root, so a cyclic source chain cannot block settlement.
- Rust marks the converted `HandlerError` with a private conflict flag, and `fail_with_state` reads
  that flag, not the name. A handler error built with `HandlerError::named("WaitConflictError", …)`
  therefore retries under the task's policy.
- Ruby uses `ConflictError`. Its message identifies the operation and retained name.

#### Settling a conflict

The worker skips its retry-delay callback for these errors, then records the conflict name in the
failure envelope. Only conflict settlement sends `-1`. A TypeScript `retryDelayMs` callback that
returns anything other than `undefined` or a safe integer from 0 through 2,147,483,647 throws before
`fail_v1`. Python and Ruby raise for a negative callback result, and Go replaces one with nil. Configured redaction still records `RedactedTaskError`, while terminal
classification happens before redaction.

Transient failures, lease loss, child-limit refusals, and already-waiting signal refusals keep their
existing settlement behavior. `protocol/v1/runtime.json` pins terminal conflicts and those retryable
controls in every SDK.

### Failure envelope

`protocol/v1/failures.json` pins the JSON error envelope a worker passes to `fail_v1`.

| Envelope   | Fields                                                                                                 |
| ---------- | ------------------------------------------------------------------------------------------------------ |
| Unredacted | Exactly `name`, `message`, and `stack`. `stack` is a string or null.                                   |
| Redacted   | Exactly `name` and `message`, holding `RedactedTaskError` and `Task handler failed; details redacted`. |

The redacted values are what `redact_error_details_v1` writes. An envelope a worker redacts locally
therefore cannot differ in shape from one PostgreSQL redacts.

#### Error names and stacks

Each language resolves `name` from its own error, and never from its type system.

- TypeScript reads `Error.name`. For a thrown non-`Error`, it records `NonErrorThrown` with a null
  stack.
- Python reads `type(error).__name__`. It always renders a stack through
  `traceback.format_exception`.
- Go has no name on an error. `handlerErrorName` preserves a wrapped durable conflict's class.
  Otherwise it takes the first of these:
  1. the result of `ErrorName()` on any error in the chain that implements `ErrorNamer`;
  2. the declared name of an exported concrete error type;
  3. `Error`.

In Go, `handlerErrorStack` reads `ErrorStack()` from any error in the chain that implements
`ErrorStacker`, and records null otherwise. `errors.As` walks the chain, so a wrapped error still
names and stacks the failure it reports. Both interface lookups ignore an empty string.

An error that names nothing is the one value the languages cannot share. Each language's base error
type names itself: TypeScript, Go, and Rust record `Error` and Python records `Exception`.
`failures.json` pins that per language rather than leaving it to drift.

`HandlerPanicError` carries the stack captured where `callHandler` or `callBatchHandler` recovered
the panic. A Go panic therefore records the same three fields as a TypeScript or Python exception.

#### JSON number precision

JSON numbers are the other place the runtimes differ. PostgreSQL stores a `jsonb` number at full
precision.

- Python decodes a JSON integer as an unbounded `int`.
- TypeScript and Go decode it as an IEEE-754 double. An integer beyond 2^53 - 1 in magnitude arrives
  rounded, and no error is raised.
- Go's `decodeContractJSON` is the exception. Contract validation decodes with `json.Number`,
  because a schema bound must be checked against the stored value rather than against a double.
- Rust decodes through `serde_json` without `arbitrary_precision`. An integer stays exact within the
  signed and unsigned 64-bit ranges and becomes a double beyond them.

Workhorse does not reject a value past that bound, because PostgreSQL accepts it and some languages
read it correctly. `docs/parity.md` records the bound and tells a caller to send a larger identifier
as a string.

### Request and schedule fixtures

Both fixtures map public inputs to exact PostgreSQL JSON. The listed methods run every mapping.

| Fixture                      | Maps                  | TypeScript            | Python                      | Go                        |
| ---------------------------- | --------------------- | --------------------- | --------------------------- | ------------------------- |
| `protocol/v1/requests.json`  | Public enqueue inputs | `Queue.enqueueMany`   | `Queue.enqueue_with_result` | `Queue.EnqueueWithResult` |
| `protocol/v1/schedules.json` | Recurring definitions | `Queue.syncSchedules` | `Queue.sync_schedules`      | `Queue.SyncSchedules`     |

`manifest.fixtureCoverage` declares the complete identifier set for `requests`, `schedules`, and
`interpreter`. Each language compares the declaration with the file identifiers and with the
identifiers executed by its runner.

### Schema compatibility checks

The TypeScript, Go, and Python checks return the same five refusal codes:

- `schema-not-installed`
- `schema-too-old`
- `schema-too-new`
- `client-protocol-too-old`
- `client-protocol-too-new`

#### TypeScript

TypeScript `PROTOCOL_VERSION` is 5, and `MINIMUM_PROTOCOL_VERSION` and `MAXIMUM_PROTOCOL_VERSION`
are also 5.

`schemaCompatibilityRefusal(state, clientProtocolVersion)` in `typescript/core/src/schema.ts`
applies the tests in the order `protocol/v1/compatibility.json` fixes. It returns a
`SchemaCompatibilityRefusal` carrying a `code` and a `message`, or null. `clientProtocolVersion`
defaults to `PROTOCOL_VERSION`. A caller passes another version only to ask what a different client
would meet. The `code` strings are the same as Go's `CompatibilityCode` and Python's
`CompatibilityCode`.

`assertSchemaCompatible` reads the state with `readCompatibilityState`. It throws
`SchemaCompatibilityError` (exported from `typescript/core/src/errors.ts`) carrying that `code`, the
`installedVersion` it read, and the `expectedVersion` this build was compiled against.

- A missing relation becomes `schema-not-installed`.
- Any other query failure stays a plain `Error`, because an unreadable database is not a verdict
  about versions.

`typescript/core/test/schema-compatibility.test.ts` executes every case in
`protocol/v1/compatibility.json`. `typescript/core/test/schema-installation.test.ts` asserts the
thrown type and code against a real database in both directions.

#### Go

Go `ProtocolVersion` is 5. `CheckCompatibility` takes three inputs and returns
`*CompatibilityError`, whose `Code` is one of the five codes:

- an installed schema version;
- a client protocol version;
- the protocol versions the installed schema declares it serves.

It refuses a schema below `minimumSchemaVersion`. It applies no upper bound to the schema version,
because inside a major line a migration only adds. The upper bound comes from the served set
instead:

- A client protocol below the oldest served version is `schema-too-new`.
- A client protocol above the newest served version is `schema-too-old`.
- An empty served declaration enforces nothing.

`AssertSchemaCompatible` executes the `compatibility_state` statement on every call. That statement
returns both facts in one round trip as `kind`/`version` rows. The function translates SQLSTATE
`42P01` or `3F000` to `schema-not-installed`, and accepts exactly one `schema` row.

`AssertCompatible` remains as a deprecated Go alias for the rest of the `0.x` line and is removed in
`1.0.0`. `go/compatibility_test.go` executes every case in `protocol/v1/compatibility.json`.

### Conformance runner

`scripts/verify-sql-protocol.ts` interprets the language-neutral files. It reads
`workhorse.schema_version` and rejects incompatible schema or client protocol versions before a
scenario can mutate the database. The clean-install and forward-migration suites both run the
interpreter.

The suite pins every TypeScript function call's projection, casts, argument order, and arity. It
also pins each TypeScript view read's projection and ordering. A clean-schema, migration,
TypeScript-call, or fixture change therefore fails the same conformance command.

## Python SDK

### Distribution

The Python distribution is `stablemates-workhorse`, and its import package is `workhorse`. It
requires Python 3.12 or newer.

- The distribution depends on Psycopg 3.3 or newer and below 4.
- The `asyncpg` extra adds asyncpg 0.31 or newer and below 1.

### Public module surface

Every module under `python/src/workhorse/` whose path carries no leading underscore declares
`__all__`. That list is the module's supported surface.

`workhorse` re-exports 126 names. `types`, `errors`, `admin`, `client`, `worker`, `async_worker`,
`worker_process`, `compatibility`, `dashboard_v1`, and `workhorse.dashboard` each declare their own.

A name a private module owns reaches a public module only through an underscore-prefixed alias. So
`import workhorse.admin` no longer resolves `SQL_STATEMENTS`, `LIST_TASKS`, `MAX_PAGE_SIZE`, or
`TASK_STATES`. `import workhorse.errors` no longer resolves `translate_database_error`.

`python/tests/test_public_surface.py` asserts both rules for every public module. It also executes
the `workhorse` import lines in `docs/guides/`, `site/content/docs/`, and `python/README.md`.

### Queue clients

`python/src/workhorse/client.py` exports synchronous `Queue` for Psycopg. It also exports the
asynchronous `AsyncQueue.from_psycopg` and `AsyncQueue.from_asyncpg` constructors.

Python `Queue` accepts a caller-owned Psycopg connection. `AsyncQueue` accepts a caller-owned
Psycopg `AsyncConnection` or asyncpg `Connection`. The clients never call `commit`, `rollback`, or
`close`.

Both clients expose these methods:

| Methods                                                                       | SQL function                   |
| ----------------------------------------------------------------------------- | ------------------------------ |
| `enqueue`, `enqueue_with_result`, `enqueue_many`, `enqueue_many_with_results` | `enqueue_many_v1`              |
| `sync_schedules`                                                              | `sync_schedule_definitions_v2` |
| `cancel`                                                                      | `cancel_v1`                    |
| `send_signal`                                                                 | `send_signal_v1`               |
| `complete_human_wait`                                                         | `complete_human_wait_v1`       |

#### Row factories

`SyncExecutor` and `AsyncPsycopgExecutor` in `python/src/workhorse/_drivers.py` open every cursor
with `row_factory=tuple_row`. A caller's Psycopg connection may therefore carry `dict_row`,
`class_row`, or any other row factory.

The SDK leaves the connection's own `row_factory` unchanged. The caller's later queries keep their
configured row shape. `python/tests/test_row_factory.py` covers the clients, workers, `Admin`, and
the compatibility check for each of those factories.

#### Cancellation, signals, and human completion

Each method below has an asynchronous equivalent that returns the same result.

| Method                                                                               | Result                      | Status values                                                                      |
| ------------------------------------------------------------------------------------ | --------------------------- | ---------------------------------------------------------------------------------- |
| `Queue.cancel(task_id, *, requested_by=None, reason=None)`                           | `CancelResult`              | `canceled`, `cancel_requested`, `already_terminal`, `not_found`                    |
| `Queue.send_signal(task_id, name, payload, *, idempotency_key, requested_by)`        | `SignalDeliveryResult`      | `delivered`, `duplicate`, `not_waiting`, `already_delivered`, `stale`, `not_found` |
| `Queue.complete_human_wait(task_id, name, result, *, idempotency_key, requested_by)` | `HumanWaitCompletionResult` | `completed`, `duplicate`, `not_waiting`, `already_completed`, `stale`, `not_found` |

`CancelResult` contains the status, task identity, state, current attempt, request attribution,
reason, and terminal timestamp. `requested_by` is audit attribution and does not authorize the
caller.

`SignalDeliveryResult` contains its `status`, `task_id`, `name`, the retained `payload`,
`delivered_at`, and `delivered_by`. A changed request under one retained idempotency key raises
`SignalIdempotencyConflictError`.

`HumanWaitCompletionResult` contains its `status`, `task_id`, `name`, the retained result as
`payload`, `completed_at`, and `completed_by`. A changed completion under one retained idempotency
key raises `HumanWaitIdempotencyConflictError`.

#### Input limits and enqueue defaults

| Input                                              | Limit                                                   |
| -------------------------------------------------- | ------------------------------------------------------- |
| External-wait names                                | 1 through 200 characters without surrounding whitespace |
| `timeout_ms`                                       | 1 through 604,800,000                                   |
| Signal payloads, human contexts, and human results | At most 65,536 UTF-8 bytes when encoded                 |
| Delivery idempotency keys                          | 1 through 512 UTF-8 bytes                               |
| `requested_by`                                     | 1 through 200 characters                                |
| Enqueue batches                                    | At most 1,000 requests                                  |

| Enqueue setting           | Default                 |
| ------------------------- | ----------------------- |
| Priority                  | 0                       |
| Attempt budget            | 25                      |
| Payload and result limits | 1,048,576 bytes         |
| Idempotency retention     | 86,400,000 milliseconds |

#### Compatibility checks

Every non-empty Python mutation first executes
`SELECT version FROM workhorse.schema_version ORDER BY version`. `Queue` and `AsyncQueue` enqueue
through a per-queue cached check instead, so a warm enqueue issues only `enqueue_many_v1`.

`python/src/workhorse/_protocol.py` accepts schema version 54 or newer and client protocol 5. It
refuses an unreadable, missing, older, or newer schema before the mutating statement.

`python/src/workhorse/_statements.py` owns each statement in `STATEMENTS` with explicit Psycopg and
asyncpg parameter dialects.

- `assert_sync_compatible` and `assert_async_compatible` query on every call.
- `CachedCompatibilityCheck` and `AsyncCachedCompatibilityCheck` serve worker loops and producer
  enqueue. They cache the first answered result, success or `ProtocolCompatibilityError`.
- A driver error is not cached, so the next call queries again.

`python/src/workhorse/compatibility.py` publishes that check to applications:

- `assert_schema_compatible(connection)` for synchronous Psycopg;
- `assert_schema_compatible_psycopg(connection)` and `assert_schema_compatible_asyncpg(connection)`
  for the two asynchronous drivers.

Each wraps the caller-owned connection in the matching executor and reads
`workhorse.schema_version`. It raises `ProtocolCompatibilityError` without creating or changing a
database object.

#### Contract cache

After `sync_contracts`, each queue caches the `get_contract_definition_v1` row for a task type on
first enqueue. It refreshes that entry on a `contract_mismatch` row and retries once, as TypeScript
does. A second mismatch raises `RuntimeError`.

A cached row can also reject a payload that the current selection accepts, so `enqueue_many_v1`
never sees the request. When a cached row raises `TaskContractValidationError`,
`enqueue_many_with_results` rereads that task type's row once per call through the caller's
connection. It validates again, and the second result stands. A row read for the same enqueue is not
reread.

`enqueue_many_v1` checks the size limit after the version. A raised payload limit therefore arrives
through the `contract_mismatch` refresh.

### Synchronous worker

`python/src/workhorse/worker.py` exports `Worker` for a Psycopg `ConnectionPool` whose connections
use `autocommit=True`. It borrows one connection per statement and returns it afterwards.

`Worker.handle(type, handler)` registers a handler whose arguments are the JSON payload and
`HandlerContext`.

- `HandlerContext.task` is the `ClaimedTask` returned by `claim_v1`.
- `HandlerContext.cancellation` is a `CancellationToken` with `cancelled`, `reason`,
  `wait(timeout)`, and `raise_if_cancelled()`.

#### Worker options

| Option                        | Default                                       | Accepts                                                                                                                                            |
| ----------------------------- | --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `concurrency`                 | 1                                             | Integers from 1 through 100.                                                                                                                       |
| `lease_ms`                    | 30,000 milliseconds per claim                 | 100 through 86,400,000.                                                                                                                            |
| `heartbeat_ms`                | The greater of 100 or one third of `lease_ms` | Positive values less than `lease_ms`.                                                                                                              |
| `poll_ms`                     | 250                                           | Positive values.                                                                                                                                   |
| `maintenance_routine_poll_ms` | 60000                                         | Integers of at least 100. Bounds how often the worker offers the slow retention routines.                                                          |
| `retry_delay_ms`              | Unset                                         | A whole number of milliseconds, or a callable over the attempt and the claimed task. The callable returns `None` to leave the delay to the policy. |

`retry_delay_ms` reports one failed attempt's delay to `fail_v1` in place of the persisted retry
policy's choice.

`queue` selects one queue, while `queues` selects an ordered, de-duplicated set. If the caller
supplies both, `Worker` raises `ValueError`.

#### Claims and slots

The dispatcher refills slots with overlapping batched `claim_many_v1` calls. It follows the rules
that
[ADR 0076](../decisions/0076-keep-overlapping-batched-claims-in-flight-to-fill-worker-slots.md)
sets for every SDK, described under the TypeScript worker's claim passes.

Each claimed task starts one handler thread. A handler that finishes releases its slot and wakes the
dispatcher.

#### Dispatch sweeps and maintenance

`Worker.run_once()` and `Worker.run()` use a cached compatibility check.

A dispatch sweep runs `tick_v1(100, 100)` when `maintenance_interval_ms` has elapsed since the last
tick. The tick promotes due retries and durable waits. It also recovers expired leases with the
persisted retry policy. A sweep between ticks issues no `promote_v1` or
`recover_expired_telemetry_v1`; it only claims.

Every claim attempt advances the round-robin queue index. The sweep stops after every queue returns
empty without an intervening claim.

#### Heartbeats

One worker heartbeat timer submits every active lease through `heartbeat_many_v1`. It schedules the
next batch only after the prior call returns.

Unless `shared_heartbeats` is set, the worker reserves one pool connection for heartbeat rounds on
first need. A saturated pool therefore cannot delay lease renewal.

- A Psycopg heartbeat connection must use `autocommit=True`.
- After a failed round, the worker returns that connection to the pool and reserves a fresh one.
- The worker releases the connection when the run returns.
- With `shared_heartbeats`, each round borrows a pool connection like any other statement.

`AsyncWorker` reserves its heartbeat connection from its async pool through
`_open_heartbeat_executor` with the same lifecycle.

#### Ownership statuses and expiration

`heartbeat_many_v1` statuses cancel the matching token with these errors:

| Status              | Error                        |
| ------------------- | ---------------------------- |
| `cancel_requested`  | `CancellationRequestedError` |
| `deadline_exceeded` | `DeadlineExceededError`      |
| `timeout_exceeded`  | `ExecutionTimeoutError`      |
| `stale`             | `StaleLeaseError`            |

A local timer also calls `expire_owned_v1` at the earlier of `deadline_at` and
`attempt_timeout_at`. If PostgreSQL returns `not_due`, the thread retries after 5 milliseconds. It
does not abandon the live attempt.

#### Attempt outcome arbiter

One locked attempt-outcome arbiter accepts the first lifecycle outcome.

- Cancellation calls `acknowledge_cancel_v1` under the claimed worker and fence, even if the handler
  catches the signal and returns.
- Deadline and timeout transitions remain owned by `expire_owned_v1`.
- Lease loss raises `StaleLeaseError` and prevents completion or failure.

Supervision stays active through result preparation and the final fenced write. After settlement
finishes or the attempt exits exceptionally, the outer `finally` in
`_execute_claimed_task_within_span` cleans up:

1. It removes the heartbeat registration.
2. It signals the expiration thread to stop.
3. It joins that thread.

A lost lease ends only that attempt. The handler outcome records `lease_lost`, and `run()` and
`run_once()` keep dispatching because lease recovery owns the task.

A handler that raises a `BaseException` such as `SystemExit` still stops the heartbeat and joins the
expiration thread. The lease then lapses for recovery, and the process can exit. Each durable wait
raises a new suspension instance, so a suspended handler's frames are released with its task.

#### Failure settlement

Ordinary handler failures pass a JSON error envelope to `fail_v1` with the configured retry
override. PostgreSQL then selects `ready`, `scheduled`, or `failed` from the persisted attempt
budget and retry policy. `_error_envelope` builds that envelope in the shape
`protocol/v1/failures.json` pins.

#### Run, pause, and stop

- `run_once()` refills freed slots until one empty queue sweep, drains every claimed task, and
  returns whether the pass ran a handler. A sweep whose claims were all of unhandled types counts as
  empty. A pass that only released therefore ends the fill and reports no progress.
- `run()` repeats sweeps until `stop()` is called.
- `pause()` stops new claims without stopping active handlers.
- `resume()` wakes the dispatcher.
- `stop()` also wakes the dispatcher. It makes `run()` return only after every active handler
  settles.

#### Notifications and polling

`Worker._run_loop()` clears the wake event before a sweep. A completion or state change during an
in-flight empty claim therefore stays latched for the following wait.

`run()` starts one daemon listener thread, `_TaskNotificationListener`. It borrows one autocommit
connection from the pool through `_psycopg_pool_notification_factory` and holds it while it listens.
The listener executes `LISTEN workhorse_tasks` and wakes for a configured queue or `*`.

The wait between empty sweeps depends on the listener:

- While the listener is connected, the worker uses a 5,000 millisecond fallback.
- Before the listener connects or after it disconnects, the worker uses the 250 millisecond polling
  default.
- An explicit `poll_ms` replaces both defaults.

The listener reconnects after errors with 10 percent jitter around exponential delays from 100 to
5,000 milliseconds. Each successful `LISTEN` resets the delay and wakes the worker.

The optional `on_notification_error` callback receives setup, connection, read, and close failures.
Listener failure never stops dispatch. `stop()` waits at most 200 milliseconds for the listener
thread, so a blocked pool checkout cannot prevent the worker from draining.

### Python handler context

#### Checkpoints

Python `HandlerContext.checkpoint(name, operation)` loads `task_checkpoint` lazily once per
activation. It coalesces concurrent calls by name and calls `save_checkpoint_v1` under the active
worker and fence. `get_checkpoint(name)` reads the same activation cache.

The method raises `CheckpointLeaseLostError` for `stale` and `CheckpointConflictError` for
`conflict`.

#### Progress

Python `HandlerContext.get_progress()` loads `task_progress` once per activation.
`set_progress(value)` calls `update_progress_v1` with the active worker and fence, then replaces the
activation cache. It returns `TaskProgress`.

- Status `stale` raises `ProgressLeaseLostError`.
- Status `rate_limited` raises `ProgressRateLimitError` with `retry_after_ms`.

#### Timers

`HandlerContext.sleep(name, duration_ms)` and `sleep_until(name, wake_at)` call `schedule_wait_v1`.
`get_wait(name)` loads `task_wait` lazily once per activation.

Status `scheduled` suspends the attempt:

1. It submits `suspended_for_wait` to the attempt arbiter.
2. It cancels the local token with a private `BaseException` sentinel.
3. It stops the heartbeat.
4. It skips completion or failure settlement.

The post-handler arbiter check preserves suspension if handler code catches that sentinel. Status
`elapsed` returns normally. The methods raise `WaitLeaseLostError`, `WaitConflictError`, or
`WaitLimitExceededError` for their matching protocol statuses.

#### Signal waits

`HandlerContext.wait_for_signal(name, *, timeout_ms=None)` calls `wait_for_signal_v1`.

- Status `waiting` submits `suspended_for_wait` through the same private sentinel and lifecycle
  arbiter as a timer.
- Status `delivered` returns the retained `payload`.
- Concurrent same-name calls share one `Future`.

| Status            | Error                          |
| ----------------- | ------------------------------ |
| `stale`           | `SignalWaitLeaseLostError`     |
| `already_waiting` | `SignalWaitConflictError`      |
| `limit_exceeded`  | `SignalWaitLimitExceededError` |

#### Human waits

`HandlerContext.wait_for_human(name, context, *, timeout_ms=None)` encodes the JSON context and
calls `wait_for_human_v1`.

- Status `waiting` suspends through the same arbiter.
- Status `completed` returns the retained `result`.
- Concurrent same-name calls share one `Future` only when their canonical encoded contexts match. A
  different in-flight or retained context raises `HumanWaitConflictError`.

| Status            | Error                          |
| ----------------- | ------------------------------ |
| `stale`           | `HumanWaitLeaseLostError`      |
| `already_waiting` | `HumanWaitAlreadyWaitingError` |
| `limit_exceeded`  | `HumanWaitLimitExceededError`  |

PostgreSQL caps each task at 1,000 signal names and 1,000 human-decision names.

#### Child tasks

`HandlerContext.run_child(name, type, payload, options=None)` accepts child names from 1 through 200
characters. It encodes `EnqueueOptions` without keyed modes or dependencies and calls
`create_child_v2`. An omitted child queue is `default`.

- Status `created` submits `suspended_for_child` to the attempt arbiter.
- Status `completed` returns the retained result.
- Concurrent calls with one name share a `Future` only when their canonical requests match.
- The method raises `ChildLeaseLostError`, `ChildConflictError`, or `ChildLimitExceededError` for
  `stale`, `conflict`, or `limit_exceeded`.

`HandlerContext.run_children(children)` accepts at most 100 unique `ChildTaskRequest.name` values.
It calls `create_children_v1` with mode `settled`.

- An empty sequence returns `{}` without suspension.
- Status `created` submits `suspended_for_child`.
- Status `completed` returns `dict[str, ChildOutcome]` in request insertion order. `ChildOutcome` is
  the tagged union `ChildSucceeded | ChildFailed | ChildCanceled`.

`run_children_all(children)` passes mode `all_success` and returns successful results as
`dict[str, Json]`. It propagates a failed or canceled child to the parent.

The methods map `stale`, `conflict`, `limit_exceeded`, and `result_too_large` to the corresponding
child errors. `ChildResultLimitExceededError` retains `result_bytes` and `result_limit_bytes`.

#### Contracted children

A contracted Python child carries the current contract that `get_contract_definition_v1` returns,
because a child write has no stale-contract retry. The stamp includes the version,
`payload_max_bytes`, `result_max_bytes`, and the sensitive payload and result keys. Every child
method validates each payload first and raises `TaskContractValidationError` before it writes.

PostgreSQL compares a replayed request with the accepted one, contract stamp included. On
`conflict`, the context therefore reads each existing child's `contract_version` through
`task_child` and `get_task`. It retries once with those versions stamped. When the current contract
rejects a replayed payload, the context builds the request again under those versions before it
writes.

The `AsyncHandlerContext` methods share this path.

### Python batch handlers

`Worker.handle_batch(type, handler, *, max_size, linger_ms)` registers a synchronous Python batch
handler.

- `max_size` accepts integers from 1 through 100 and cannot exceed `Worker.concurrency`.
- `linger_ms` accepts integers from 0 through 60,000.

Each task occupies one worker slot while it waits for a full group or the linger deadline. The
coordinator groups one type and queue. It then orders the selected members by descending
`ClaimedTask.priority` and worker claim order.

Each task occupies its own handler thread, so the dispatcher stamps a claim sequence before that
thread starts. The coordinator ranks by that sequence, not by the order threads reach it.

#### Items and outcomes

The handler receives a sequence of `BatchHandlerItem` values. Each item contains `payload` and a
`BatchHandlerContext` with `task`, `cancellation`, `get_checkpoint`, `checkpoint`, `get_progress`,
and `set_progress`.

`BatchHandlerContext` has no `sleep` or `sleep_until` methods, so one member cannot suspend the
shared invocation.

The handler returns one `BatchHandlerOutcome` mapping per item:

- Status `succeeded` requires `result`.
- Status `failed` requires an `Exception` under `error`.

These fail every member: a thrown exception, a non-sequence return, the wrong outcome count, or an
invalid mapping.

#### Evidence and settlement

Before invocation, the coordinator calls `record_batch_dispatch_v1` with the ordered task IDs,
attempts, fence tokens, and worker ID. A shared callback failure also calls
`record_batch_failure_v1`. Evidence writes are best effort and never replace per-member settlement.

Every handler thread retains its own outcome arbiter, cancellation token, fence token, retry budget,
completion call, and failure call.

### Asynchronous worker

`python/src/workhorse/async_worker.py` exports two factories:

- `AsyncWorker.from_psycopg`, which takes a Psycopg `AsyncConnectionPool`;
- `AsyncWorker.from_asyncpg`, which takes an asyncpg `Pool`.

Each wraps the pool in `_PooledAsyncPsycopgExecutor` or `_PooledAsyncpgExecutor`. That executor
borrows one connection per statement and returns it afterwards.

`_AsyncExecutorBridge` schedules each call on the run loop without a lock. Concurrent statements run
on separate pooled connections. The bridge passes the resulting rows into the same `Worker`
lifecycle core.

The asyncpg executor decodes the JSON text of every SDK-read JSON column. That includes the
`children` array that `create_children_v1` returns, so both drivers join a child set.

#### Pool connections

- Unless `shared_heartbeats` is set, `_open_heartbeat_executor` reserves one pool connection for
  heartbeat rounds for the whole run.
- The listener holds another pool connection while it listens.
- Psycopg connections must use `autocommit=True`. If a Psycopg heartbeat or listener connection
  lacks it, the worker raises `ValueError`.

#### Factory options

Both factories accept `queue`, `queues`, `worker_id`, `concurrency`, `poll_ms`, `lease_ms`,
`heartbeat_ms`, `maintenance_interval_ms`, `maintenance_routine_poll_ms`, `registry_interval_ms`,
`retry_delay_ms`, `schedule_namespaces`, and `schedule_catchup_limit`. These take the same
validation and limits as `Worker`.

They also accept `shared_heartbeats` and the `on_notification_error` and `on_registration_error`
callbacks. Neither factory accepts a connection factory, because the worker takes its heartbeat and
listener connections from the pool.

`registry_interval_ms` defaults to 5,000. It accepts `0` to disable registration, or a non-boolean
integer of at least 100 milliseconds.

#### Async handler context

Async handlers run on the run loop and receive `AsyncHandlerContext`. Its durability methods are
awaitable views of the same `_HandlerDurability` instance. Row mapping, attempt arbitration, batch
grouping, error settlement, telemetry, and drain therefore have no second async implementation.

`AsyncWorker.handle(type, handler)` receives `(Json, AsyncHandlerContext)`. The context exposes
these awaitable methods:

- `get_checkpoint(name)`, `get_wait(name)`, and `checkpoint(name, operation)`;
- `sleep(name, duration_ms)` and `sleep_until(name, wake_at)`;
- `get_progress()` and `set_progress(value)`;
- `wait_for_signal(name, *, timeout_ms)` and `wait_for_human(name, context, *, timeout_ms)`;
- `run_child(name, type, payload, options)`, `run_children(children)`, and
  `run_children_all(children)`.

`AsyncCancellationToken.wait(timeout)` is awaitable. `cancelled`, `reason`, and
`raise_if_cancelled()` match `CancellationToken`.

#### Cancelling an awaitable call

Each awaitable context method runs its synchronous call on a bridge thread. That thread cannot be
interrupted. A cancelled caller therefore waits for the call to return before it re-raises
`asyncio.CancelledError`. `_await_bridge_call` then retrieves the call's own outcome, so the loop
never reports it as unretrieved. The caller's cancellation wins over that outcome.

#### Cancelling a checkpoint

`AsyncHandlerContext.checkpoint(name, operation)` calls `operation` inside the task it tracks. It
does so in the same loop step that checks for cancellation.

A cancellation that arrives before the tracked task returns stops the operation:

- A cancelled `checkpoint` either stops that task before `operation` is called, or cancels it while
  the awaitable runs. That includes an `asyncio.Task` that `operation` returned.
- `checkpoint` waits for the task's cleanup.
- If `operation` absorbs the cancellation and returns a value, the tracked task raises
  `asyncio.CancelledError` instead.

Either way, `checkpoint` stores no row in `workhorse.task_checkpoint`, so a later attempt runs the
operation again.

A cancellation that arrives after the tracked task returns does not stop the save. The synchronous
core sends `save_checkpoint_v1` once `operation` returns. `_await_bridge_call` waits for that bridge
call before it re-raises. Once the save is already under way, the caller receives
`asyncio.CancelledError` while the row may commit. A later attempt then replays its value without
calling `operation`.

`save_checkpoint_v1` checks the runtime row's worker, fence, lease expiry, deadline, attempt
timeout, and `cancel_requested_at`. The caller's asyncio cancellation is not one of its conditions.
A cancelled await therefore never proves that no checkpoint exists, and it does not undo the
operation's effects on other systems.

`checkpoint` copies the caller's `contextvars` context, and the event loop creates the tracked task
in that copy. Context variables and the current OpenTelemetry span reach `operation`. Its own
changes stay inside it, as they would in a task the handler created.

#### Running and stopping

`AsyncWorker.handle_batch(type, handler, *, max_size, linger_ms)` uses the same limits as
`Worker.handle_batch`. `run_once()`, `run()`, `pause()`, `resume()`, `is_paused()`, and `stop()`
match their synchronous names and return contracts. `AsyncWorker.run_once()`, `run()`, `pause()`,
`resume()`, and `stop()` preserve those contracts.

Cancelling the task that awaits `run_once()` or `run()` calls `stop()`. `_run_inner` re-raises
`CancelledError` only after the shared core drains. A later cancellation also waits for that drain.
The bridge threads therefore stay open, and a concurrent run call still fails until the core
returns.

`run()` also waits through later cancellations for its notification listener to release its
connection. Only then does it close the bridge threads and clear `_running`.

#### Async batch handlers

`AsyncWorker.handle_batch` accepts an async callback and supplies `AsyncBatchHandlerItem` values.
The shared coordinator still owns group selection, priority order, evidence writes, and per-member
settlement.

`AsyncBatchHandlerContext.get_progress()` and `set_progress(value)` are awaitable, like its
checkpoint methods. These operations run on the application loop while the shared durability core
owns replay and persistence.

#### Async notifications

`AsyncWorker.run()` listens through `AsyncWorker._listen`, which borrows one connection from the
async pool and holds it in an asyncio task. `AsyncWorker` disables the core worker's Psycopg
listener thread.

- A Psycopg listener connection must use `autocommit=True` and reads the asynchronous `notifies`
  iterator.
- asyncpg uses `add_listener` and `remove_listener`.

Both filter `workhorse_tasks` payloads to the configured queues or `*`, and wake the shared
dispatcher. Both report listener errors to `on_notification_error` and reconnect with the same
jittered backoff.

When `run()` returns, it cancels the listener task. asyncpg calls `remove_listener` on every exit,
including that cancellation, so the pool never receives a connection with a callback.
`on_notification_error` receives a failed `remove_listener`. The connection still returns to the
pool, whose reset discards the `LISTEN`.

`AsyncWorker` never closes the pool it was given.

### Python worker processes

Python `run_worker_process(worker, *, shutdown_timeout_ms, force_exit)` installs `SIGINT` and
`SIGTERM` handlers around `Worker.run()`.

Each handler writes its signal number to a nonblocking self-pipe. A control thread reads the pipe.
Lock acquisition, log emission, timer creation, and thread creation therefore happen outside the
main thread's signal handler.

- The first signal starts the shutdown deadline and calls `Worker.stop()` on a separate thread. The
  deadline defaults to 25,000 milliseconds and accepts integers from 1 through 3,600,000.
- If the worker drains before the deadline, the function restores the previous handlers and returns.
- A second signal calls `force_exit` with 128 plus its signal number. That produces 130 for `SIGINT`
  and 143 for `SIGTERM`.
- An expired deadline calls `force_exit(1)`.

A fatal worker error starts the same deadline. `Worker` reports the first fatal error of a run
through `_report_fatal_error` when it observes it, before `_drain_active_threads` waits. That
covers a claim error, a maintenance error, a failed execution or settlement, and a failure of the
run loop itself. The process runner arms the deadline once, whether a signal or a fatal error comes
first. If the active handlers settle in time, the runner cancels the deadline and raises the
error, so the process exits unsuccessfully. Otherwise the deadline calls `force_exit(1)`.

The default `force_exit` is `os._exit`. Hard termination therefore leaves active leases for
`recover_expired_telemetry_v1`.

### Python tests

`python/tests/test_driver_integration.py` verifies commit and rollback visibility through
independent connections.

`python/tests/test_protocol_conformance.py` executes every `protocol/v1/scenarios.json` step. It
verifies compatibility fixtures, canonical rows, captures, SQLSTATE values, messages, and JSON
details.

`python/tests/test_release.py` derives the Python and PostgreSQL support lists from
`python/pyproject.toml` and `typescript/core/src/support.ts`. It requires the active interpreter and
connected PostgreSQL server to belong to those lists.

A session fixture builds the `py3-none-any` wheel and source distribution. It installs each artifact
in clean environments three ways: bare, with the compatibility `psycopg` extra, and with the
`asyncpg` extra.

- The lifecycle example runs from the bare wheel. It executes retry, checkpoint, timer, child,
  signal, and human-wait boundaries.
- The async example runs from the source distribution with the `asyncpg` extra. It commits enqueue
  through Psycopg `AsyncConnection` and asyncpg `Connection`.

`python/tests/test_worker_process.py` runs `python/examples/dedicated_worker.py` from the same wheel
and delivers `SIGTERM` through `run_worker_process`.

## Go SDK

### Module and executors

The Go module is `github.com/stablemates/workhorse/go` and requires Go 1.25 or newer. It requires
pgx v5.11.0 as a minimum rather than a pin. Minimal version selection lets a consumer choose a
higher pgx v5, which is expected to work and is not tested.

`Executor.Query(context.Context, string, ...any) ([]Row, error)` returns rows keyed by PostgreSQL
column name.

- `PGXQueryer` accepts `pgx.Tx`, `*pgx.Conn`, and `*pgxpool.Pool` through `NewPGXExecutor`.
- `SQLQueryer` accepts `*sql.Tx`, `*sql.Conn`, and `*sql.DB` through `NewSQLExecutor`.

Both adapters close the result rows they open. They never commit, roll back, or close a
caller-owned transaction, connection, pool, or database.

### Queue

The Go module exports `NewQueue(executor, defaultQueue)`, `Queue.Enqueue`,
`Queue.EnqueueWithResult`, `Queue.EnqueueMany`, `Queue.EnqueueManyWithResults`, and
`Queue.SyncSchedules`. It also exports `Queue.Cancel`, `Queue.SendSignal`, and
`Queue.CompleteHumanWait` for application-driven lifecycle input.

The single-item enqueue methods accept zero or one variadic `EnqueueOptions` value.
`EnqueueRequest.Options` carries the same value for batch calls.

#### Enqueue options

`EnqueueOptions` contains `Queue`, `Priority`, `ConcurrencyKey`, `RunAt`, `Deadline`,
`ExecutionTimeoutMS`, `MaxAttempts`, `RetryPolicy`, `Tags`, `Idempotency`, `Debounce`, `Throttle`,
and `Dependencies`.

- `Idempotency` contains `Key`, `Scope`, and `TTLMS`.
- `Debounce` adds `WindowMS` and `Schedule`.
- `Throttle` adds `WindowMS`.
- `Dependencies` contains sorted `PrerequisiteTaskIDs` plus `OnSuccess`, `OnFailure`, and
  `OnCancellation` terminal policies.

#### Enqueue validation

Each non-empty call serializes and validates every request first. Only then does it run
`AssertSchemaCompatible` through the caller-owned `Executor`. Validation rejects these requests:

- multiple keyed modes;
- priority outside 0 through 100;
- negative `MaxAttempts`;
- a debounce combined with `RunAt`;
- debounce or throttle combined with `Dependencies`;
- prerequisite lists that are empty, duplicated, or larger than `MaxTaskDependencies` at 100.

PostgreSQL validates every remaining value.

#### Enqueue defaults

The queue then calls `enqueue_many_v1`. `MaxEnqueueBatchSize` is 1,000.

| Field                                                                                                  | Zero value serializes as                             |
| ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------- |
| `Queue`                                                                                                | The queue default                                    |
| `Priority`                                                                                             | 0                                                    |
| `MaxAttempts`                                                                                          | 25                                                   |
| `Idempotency.TTLMS`                                                                                    | 86,400,000 milliseconds                              |
| `Scope`                                                                                                | `default`                                            |
| `ConcurrencyKey`, `ExecutionTimeoutMS`, `Deadline`, `RetryPolicy`, `Dependencies`, keyed-mode pointers | Absent or `null`, according to the protocol contract |
| `Tags`                                                                                                 | An empty array                                       |

`payloadMaxBytes` and `resultMaxBytes` are 1,048,576. `sensitivePayloadKeys` and
`sensitiveResultKeys` are empty arrays. `runAt` is the current UTC timestamp unless the caller
supplies `RunAt` or a keyed mode selects PostgreSQL's default.

#### Enqueue results and errors

`EnqueueResult` preserves PostgreSQL's ordered task ID, outcome, and optional non-replaceable
reason. The queue never commits, rolls back, or closes the pgx or `database/sql` resource behind the
executor.

An incomplete, duplicate, or out-of-range ordinal returns `ErrInvalidEnqueueResult`. These SQLSTATEs
return typed errors with typed detail structs and matching sentinel errors:

| SQLSTATE | Error                             |
| -------- | --------------------------------- |
| `P1001`  | `EnqueueIdempotencyConflictError` |
| `P1003`  | `DependencyCycleError`            |
| `P1005`  | `DependencyLimitExceededError`    |

The three `EnqueueNonReplaceableReason` constants carry the enum prefix every other Go constant
group carries: `NonReplaceableIncompatibleKeyMode`, `NonReplaceableNotPending`, and
`NonReplaceableWindowElapsed`. `IncompatibleKeyMode`, `NotPending`, and `WindowElapsedPending`
remain as deprecated Go aliases of the same values for the rest of the `0.x` line. They are removed
in `1.0.0`.

#### Compatibility and contract cache

`NewCachedCompatibilityCheck` returns a `CachedCompatibilityCheck`. Its `Assert` caches the first
answered result: success or a `*CompatibilityError`. A database error is not cached, so the next
call queries again. Each `Queue` holds one for its enqueue path.

After `SyncContracts`, the queue caches each task type's `get_contract_definition_v1` row on first
enqueue. It refreshes that entry on a `contract_mismatch` row and retries once, as TypeScript does.
A second mismatch returns `ErrContractPolicyChanged`. A warm enqueue therefore issues only
`enqueue_many_v1`.

A cached definition can also reject a payload that an operator override now accepts. Then
`enqueue_many_v1` never sees that request. When a cached definition returns
`*TaskContractValidationError`, `applyPayloadContracts` reloads that task type's definition once
per enqueue and validates again. It reloads through the queue's `Executor`, which is the caller's
transaction when the queue wraps one. The second result stands.

Later requests of that type in the same enqueue use the definition that enqueue read, because a
concurrent enqueue can store an older one in the shared cache.

Go has no enqueue-side size check, because `enqueue_many_v1` reports a stale version before it
applies `payload_max_bytes`. Child-task creation and `SyncSchedules` read the current definition on
every call.

#### Cancellation

`Queue.Cancel(ctx, taskID, CancellationRequest)` invokes `cancel_v1` and returns `CancelResult`.
`CancellationRequest.RequestedBy` and `CancellationRequest.Reason` are optional audit metadata.
`RequestedBy` does not authorize the caller.

`CancelResult` returns the status, task identity, state, current attempt, retained request metadata,
and terminal timestamp.

#### Schedules

`Queue.SyncSchedules(ctx, namespace, definitions, options...)` accepts `[]ScheduleDefinition` and
zero or one `SyncSchedulesOptions`.

- `ScheduleDefinition` contains `Name`, `Schedule`, `Task`, and an optional `Enabled`. Nil enables
  the definition.
- `ScheduledTask` contains `Type`, `Payload`, `Queue`, `Priority`, `ConcurrencyKey`, `MaxAttempts`,
  and `RetryPolicy`.
- An omitted option prunes by default. `SyncSchedulesOptions{Prune: false}` preserves definitions
  omitted from the desired set.

Every call serializes the full set and checks compatibility. It then invokes
`sync_schedule_definitions_v2` through the caller-owned `Executor`.

Before that write, `applyScheduleContracts` reads each task type's current contract through
`get_contract_definition_v1`, once per distinct type. It reads PostgreSQL instead of the queue's
contract cache, because `fire_schedule_v1` never checks `contract_policy`. A payload that fails the
schema returns `TaskContractValidationError` and writes nothing.

Scheduled task serialization:

- A zero `ScheduledTask.Queue` uses the queue default.
- `Priority` accepts 0 through 100.
- A zero `MaxAttempts` becomes 25.
- A zero `ConcurrencyKey` and `RetryPolicy` serialize as `null`.
- `Enabled` serializes as true when its pointer is nil.

A type with a current contract serializes its `contractVersion`, `payloadMaxBytes`,
`resultMaxBytes`, `sensitivePayloadKeys`, and `sensitiveResultKeys`. Without one, `contractVersion`
is `null`. `payloadMaxBytes` and `resultMaxBytes` are then 1048576, and `sensitivePayloadKeys` and
`sensitiveResultKeys` are empty arrays.

### Go worker

`NewWorker(pool, options)` accepts a caller-owned `*pgxpool.Pool`.

`Worker.Handle(type, handler)` registers a
`Handler(context.Context, any, *HandlerContext) (any, error)`.
`go/worker.go` defines `Handler` as `func(context.Context, any, *HandlerContext) (any, error)`.
`HandlerContext.Task` retains the `ClaimedTask`.

`Worker.Run` and `Worker.RunOnce` share one execution permit. Concurrent calls serialize, so they
cannot multiply the concurrency budget or race the queue cursor.

#### Queue selection

- `WorkerOptions.Queue` selects one queue and defaults to `default`.
- `WorkerOptions.Queues` selects several queues.
- Supplying both returns an error.
- Every queue name must be non-empty.
- Duplicate names collapse to their first occurrence.

#### Worker options

| Option                                     | Default                                                        | Accepts                                                            |
| ------------------------------------------ | -------------------------------------------------------------- | ------------------------------------------------------------------ |
| `WorkerOptions.WorkerID`                   | Host name, process ID, and a random suffix                     |                                                                    |
| `WorkerOptions.Concurrency`                | 1                                                              | Integers from 1 through 100                                        |
| `WorkerOptions.LeaseDuration`              | 30,000 milliseconds                                            | Whole-millisecond values from 100 through 86,400,000               |
| `WorkerOptions.PollInterval`               | 5,000 milliseconds, or 250 milliseconds with `PollingOnly`     |                                                                    |
| `WorkerOptions.HeartbeatInterval`          | One third of `LeaseDuration`, truncated to a whole millisecond | Positive values shorter than the lease                             |
| `WorkerOptions.MaintenanceInterval`        | 1,000 milliseconds                                             | Positive whole-millisecond values                                  |
| `WorkerOptions.MaintenanceRoutineInterval` | 60,000 milliseconds                                            | Positive whole-millisecond values                                  |
| `WorkerOptions.RetryDelay`                 | Unset                                                          | `func(attempt int, task ClaimedTask)` returning a `*time.Duration` |
| `WorkerOptions.RegistryInterval`           | 5,000 milliseconds                                             | Whole-millisecond values of at least 100                           |
| `WorkerOptions.ScheduleNamespaces`         | Empty                                                          | Non-empty names; duplicates after the first are removed            |
| `WorkerOptions.ScheduleCatchupLimit`       | 100                                                            | Integers from 1 through 10,000                                     |
| `WorkerOptions.ShutdownGracePeriod`        | 25,000 milliseconds                                            | Positive whole-millisecond values                                  |
| `WorkerOptions.PollingOnly`                | False                                                          |                                                                    |
| `WorkerOptions.Logger`                     | `slog.Default()`                                               | A `*slog.Logger`                                                   |

The `PollInterval` defaults match the TypeScript and Python defaults recorded in
[ADR 0072](../decisions/0072-converge-the-worker-runtime-defaults.md).

Option behavior:

- One buffered semaphore owns the `Concurrency` budget across every configured queue.
- `MaintenanceRoutineInterval` bounds how often the worker offers the slow retention routines.
- `RetryDelay` reports one failed attempt's delay. It returns nil to leave the delay to the
  persisted retry policy.
- `WorkerOptions.DisableRegistry` prevents registration and remote pause delivery.
- `WorkerOptions.OnRegistrationError` observes a failed refresh without stopping dispatch.
- An empty `ScheduleNamespaces` list disables schedule evaluation.

#### Shutdown grace period

`ShutdownGracePeriod` bounds the drain. The drain starts when `Run` observes its context end or a
lifecycle error, before `Run` waits for an in-flight claim.

When the period expires, `Run` acts in this order:

1. It cancels every handler still executing.
2. It allows 250 milliseconds for those handlers to unwind.
3. It stops renewing the leases of whatever still runs.
4. It returns an error matching `ErrShutdownIncomplete`, naming how many it abandoned.

`settleAfterShutdown` settles the task of a handler that returns once the stop has come. It writes
on a context free of the stop and bounded by the 250 millisecond unwind period:

- A handler that returns a value completes its task through `complete_v1`, as the Rust worker
  does. This holds whether the handler returned before or after its cancellation. A fast-tier
  completion runs alone, outside its cohort's batch, so it claims no replacement task.
- A handler that returns an error after that cancellation charges no attempt. Its task goes to
  `release_owned_v1`.
- A value the task cannot store also goes to `release_owned_v1`, so the next attempt meets the same
  check.

Both writes are fenced. When PostgreSQL rejects the completion, `reconcileRejectedSettlement`
acknowledges a cancellation request or settles an expiry within the same window. When a write or
that reconciliation fails, the worker logs the failure and lease recovery settles the task. The
handler span of a task completed or released this way carries no error status. A `HandlerPanicError` keeps its usual settlement. `execute`
reads the handler context's cancellation as the handler returns. A handler that failed before the
stop keeps its usual settlement. A handler cancelled for another cause, such as a cancellation
request, keeps that cause's settlement. `RunOnce` treats the end of its caller's context the same
way.

`recover_expired_telemetry_v1` recovers the tasks of abandoned handlers once the leases expire. The abandoned goroutines
keep running inside the caller's process and may still use the pool.

After the period expires, `drainExecutions` does not report an execution error that matches
`context.Canceled`, because the deadline caused it. An error it settled earlier is still returned.

The same deadline cancels each shutdown statement that waits for a pooled connection:

- an in-flight claim;
- a fused completion claim;
- the draining registration refresh.

A claim the deadline cancels leaves any lease it committed to expire. `deregister_worker_v1` then
gets at most 1,000 milliseconds, so handlers that hold every pool connection cannot keep `Run` from
returning.

#### One pass with `RunOnce`

`Worker.RunOnce` proceeds in this order:

1. It calls `tick_v1(100, 100)`, which promotes due scheduled rows and recovers expired leases. The
   claim path issues no separate `promote_v1`.
2. It evaluates every configured schedule namespace before claiming, whether or not the tick skipped.
3. It checks configured queues in round-robin order until one `claim_many_v1(..., 1, ...)` succeeds
   or every queue is empty.
4. It executes at most one matching handler outside a transaction.
5. It calls `complete_v1` or `fail_v1` under the returned fence. When no handler is registered for
   the claimed type, it calls `release_owned_v1` instead.

It reports whether the pass ran a handler, so a pass that only released reports no progress.

#### Claims with `Run`

`Worker.Run` fills free semaphore slots with `claim_many_v1`. Each successful claim starts one
handler goroutine. The queue cursor advances after every claim attempt, so a busy queue cannot
prevent another configured queue from being checked.

An empty sweep waits for `PollInterval` or a matching PostgreSQL notification, whichever arrives
first.

- Without an active listener, empty waits double through 5,000 milliseconds with ±10% jitter.
- When the worker's last claim found nothing, a notification waits a random 0 through 50
  milliseconds before the next claim.
- A worker whose last claim found work claims without that wait.

#### Notifications

If the pool permits at least two connections, `Worker.Run` acquires one dedicated connection and
executes `LISTEN workhorse_tasks`. A payload equal to a configured queue name or `*` wakes the claim
loop. The listener also wakes the loop after connecting, so polling covers work committed during a
connection gap.

Listener failure never stops dispatch. The worker logs a warning through `WorkerOptions.Logger` and
continues polling. It reconnects after an exponential delay from 100 milliseconds through 5,000
milliseconds.

A pool limited to one connection logs once and uses polling without starting the listener.

PgBouncer transaction mode cannot preserve the session that owns `LISTEN`. For that deployment,
`WorkerOptions.PollingOnly` disables the listener and logs the polling fallback.

On clean shutdown, the listener allows up to 1,000 milliseconds for `UNLISTEN workhorse_tasks`
before returning its connection to the pool. The last worker to leave stops the listener, and its
logger receives a failed `UNLISTEN`.

#### Context cancellation

Cancelling the `Run` context stops new claims and the maintenance loop. An in-flight claim may still
land and joins the drain.

Active handlers retain a context without the caller's cancellation during `ShutdownGracePeriod`.
When that period expires, `Run` cancels every remaining handler context. `Run` waits for each
claimed handler goroutine until the unwind window ends. It then abandons the rest as described for
`ShutdownGracePeriod`.

#### Heartbeats

While handlers run, one worker heartbeat goroutine serializes `heartbeat_many_v1` calls. It uses a
dedicated connection shared by workers on the pool.

- Each call includes every active task's ID, fence token, and lease duration.
- Heartbeat batches never overlap.
- Each round has a heartbeat-interval timeout.
- Failed rounds destroy the connection and retry without cancelling handlers.
- A local watchdog cancels a handler after one lease without an accepted renewal.

#### Ownership and expiration

The earlier of `deadline_at` and `attempt_timeout_at` cancels the handler context. The supervisor
then retries `expire_owned_telemetry_v1` while PostgreSQL returns `not_due`, within its 1,000
millisecond clock-skew budget.

The supervisor leaves the heartbeat batch before it calls `expire_owned_telemetry_v1`. The heartbeat
goroutine delivers each ownership result without blocking. A slow expiration therefore cannot stall
heartbeats for other tasks. If the supervisor settles expiration, `execute` records the outcome
without repeating the fenced transition.

- `cancel_requested` cancels the context and settles through `acknowledge_cancel_v1`.
- `stale` cancels it without another fenced write.

`context.Cause` returns `CancellationRequestedError`, `DeadlineExceededError`,
`ExecutionTimeoutError`, or `LeaseLostError`.

#### Connections and maintenance

`Worker.Run` borrows a pool connection for each claim or settlement query. No connection remains
checked out while a handler runs. Heartbeat, maintenance, claim, and settlement queries serialize
safely when the pool has one connection.

A separate maintenance goroutine calls `tick_v1(100, 100)` immediately, then repeats on every
`MaintenanceInterval`. Handler duration and claim throughput do not delay it.

A phase error that `tick_v1` returns as data is logged at warn level with
`workhorse.maintenance.phase`. The next tick retries the phase. It stops neither `Run` nor
`RunOnce`.

#### Failure settlement and panics

An ordinary handler error passes a JSON envelope and the configured retry override to `fail_v1`.
PostgreSQL then selects retry timing and attempt exhaustion. `handlerErrorEnvelope` builds that
envelope in the shape `protocol/v1/failures.json` pins.

These end that attempt with the `lease_lost` handler outcome:

- a `stale` heartbeat;
- a rejected completion;
- a `stale` failure;
- an expiration that PostgreSQL still reports as `not_due` after the clock-skew budget, which also
  logs a warning.

`Run` and `RunOnce` keep dispatching, because lease recovery already owns the task.

`callHandler` recovers a panic into a `HandlerPanicError`. Its message is
`handler for <type> panicked: <value>`, and its `ErrorStack()` returns the stack captured at
recovery. The worker passes that error through the same `fail_v1` path, waits for the ownership
supervisor, and keeps the dispatch loop alive.

### Go handler context

#### Checkpoints

`HandlerContext.Checkpoint(name, operation)` reads the exact `task_checkpoint` row before it runs
`operation`. It coalesces same-name calls within one activation. It calls `save_checkpoint_v1` under
the active worker and fence.

- Names contain 1 through 200 Unicode code points.
- A nil operation is rejected before any query.
- Status `stale` returns `CheckpointLeaseLostError`, which unwraps to `ErrLeaseLost`.
- Status `conflict` returns `CheckpointConflictError`.

#### Progress

Go `HandlerContext.GetProgress()` loads `task_progress` once per activation. `SetProgress(value)`
calls `update_progress_v1` with the active worker and fence, then replaces the activation cache. It
returns `*TaskProgress`.

- Status `stale` returns `ProgressLeaseLostError`, which unwraps to `ErrLeaseLost`.
- Status `rate_limited` returns `ProgressRateLimitError` with `RetryAfter`.

#### Timers

Go `HandlerContext.Sleep(name, duration)` accepts whole-millisecond `time.Duration` values from 1
millisecond through 365 days. `SleepUntil(name, wakeAt)` accepts a nonzero `time.Time` no more than
365 days in the future. Both call `schedule_wait_v1`.

Status `scheduled` records an internal suspension before returning the private sentinel error.
`Worker.execute` then releases the slot and uses that sentinel to cancel the handler's standard
context. It skips failure and completion even if the handler swallows the error.

- Status `elapsed` returns nil.
- Concurrent calls with one name share one in-flight result.
- Status `stale` returns `WaitLeaseLostError`, which unwraps to `ErrLeaseLost`.
- `conflict` and `limit_exceeded` return `WaitConflictError` and `WaitLimitExceededError`.

#### Child tasks

Go `HandlerContext.RunChild(name, taskType, payload, options ...EnqueueOptions)` accepts one
optional `EnqueueOptions` value. A child name contains 1 through 200 Unicode code points.

- The method rejects idempotency, debounce, throttle, and dependencies before it calls
  `create_child_v2`.
- The default child queue is `default`.
- Status `created` records the private child suspension and cancels the handler context.
- Status `completed` returns the retained result.
- Concurrent calls with one name share one result only when their canonical requests match.

Go `HandlerContext.RunChildren(children)` accepts at most 100 unique `ChildTaskRequest.Name` values.
It calls `create_children_v1` with mode `settled`.

- Status `created` uses the same suspension path.
- Status `completed` reads the ordered `children` array and returns `[]ChildResult` in request
  order. Each `ChildResult.Outcome` is `ChildSucceeded`, `ChildFailed`, or `ChildCanceled`.

`HandlerContext.RunChildrenAll(children)` passes mode `all_success` and returns
`[]ChildSuccessResult`. It propagates a failed or canceled child to the parent. An empty slice
returns an empty result without suspension.

`ChildLeaseLostError`, `ChildConflictError`, `ChildLimitExceededError`, and
`ChildResultLimitExceededError` map the corresponding protocol statuses. The result-limit error
retains `ResultBytes` and `ResultLimitBytes`.

The `Create`-prefixed spelling of each of these three methods remains as a deprecated Go alias for
the rest of the `0.x` line and is removed in `1.0.0`. `go/CHANGELOG.md` pairs every old Go name with
its replacement.

#### Contracted children

A contracted Go child carries the current contract that `get_contract_definition_v1` returns,
because a child write has no stale-contract retry. The method validates the payload first and
returns `TaskContractValidationError` before it writes.

PostgreSQL compares a replayed request with the accepted one, contract stamp included. On
`conflict`, the context therefore reads each existing child's `contract_version` through
`task_child` and `get_task`. It retries once with those versions stamped. When the current contract
rejects a replayed payload, the context builds the request again under those versions before it
writes.

### Go batch handlers

`Worker.HandleBatch(taskType, options, handler)` registers the Go `BatchHandler` for one task type.

- `BatchHandlerOptions.MaxSize` accepts 1 through 100 and cannot exceed `WorkerOptions.Concurrency`.
- `BatchHandlerOptions.Linger` accepts whole millisecond durations from zero through 60 seconds.

The process-local coordinator groups one queue and task type. It then orders members by descending
`ClaimedTask.Priority` and arrival order.

The Go callback receives `[]BatchHandlerItem` and returns `[]BatchHandlerOutcome` in the same order.
Each item contains `Payload` and a `BatchHandlerContext` with `Task`, the standard cancellation
`Context`, `Checkpoint`, `GetProgress`, and `SetProgress`. The batch context omits `Sleep` and
`SleepUntil`, so one member cannot suspend the shared invocation.

- `BatchSucceeded{Result: value}` completes one member.
- `BatchFailed{Error: err}` submits that member's failure through its own retry budget.
- These fail every member: a panic, a wrong outcome count, a nil outcome, or `BatchFailed` with a
  nil error.

Before the callback, the Go coordinator calls `record_batch_dispatch_v1` with one generated UUID and
the ordered tasks. If the callback fails as a group, it calls `record_batch_failure_v1` with the
same members. Both evidence writes are best effort.

Each ordinary Go execution path still owns the member's heartbeat, cancellation context, fence
token, completion, and failure settlement.

### Go process signals

The Go SDK installs no process signal handlers. Applications pass a context from
`signal.NotifyContext` for `SIGINT` and `SIGTERM` to `Worker.Run`. Cancellation stops claims and
begins the configured drain.

`go/worker_process_test.go` builds `go/testdata/process-worker` as a separate executable.

- One test sends `SIGTERM` while a handler is active and verifies a zero exit after settlement.
- A second test sends `SIGKILL` and waits for the lease to expire. It then starts another executable
  and verifies one recovery on attempt two.

### Go release tests

`go/release_test.go` derives the minimum Go and pgx versions from `go/go.mod`. It derives the
PostgreSQL matrix from `support.json` and checks the connected lane against that matrix. It also
requires the README example to match `go/examples/quickstart/main.go` verbatim. It then builds every
example through an external module.

Its consumer test writes a separate module with a local `replace` directive and imports
`github.com/stablemates/workhorse/go`. It commits an enqueue through `pgx.Tx`. The external module
constructs `Worker`, registers `Handle`, and settles the task through `RunOnce`.

The queue integration tests also enqueue through `*pgxpool.Pool` and `*sql.Tx` with the pgx stdlib
driver.

## Ruby SDK

### Worker construction

Ruby `Stablemates::Workhorse::Worker.new(pool, ...)` takes a `ConnectionPool` or any object whose
`with` yields a `PG::Connection`. It refuses a bare `PG::Connection`.

Without `shared_heartbeats: true`, it requires an Integer pool `size` of at least 3. A missing or
non-integer `size` is therefore refused too. Every worker built on one pool shares one
`Worker::Heartbeat`, which holds one pool connection while it has members.

| Option           | Default                                                 | Accepts                       |
| ---------------- | ------------------------------------------------------- | ----------------------------- |
| `concurrency`    |                                                         | Integers from 1 through 100   |
| `lease`          | 30 seconds                                              | 0.1 through 86,400 seconds    |
| `heartbeat`      | The larger of 100 milliseconds and a third of the lease | Values shorter than the lease |
| `shutdown_grace` | 25 seconds                                              | 0 through 86,400 seconds      |

Durations are finite Numeric seconds. `cohorts` splits the slots for fast-tier dispatch, as
[Workers on a fast-tier queue](fast-tier.md#workers-on-a-fast-tier-queue) describes.

#### Handler threads

Handlers run on a `Concurrent::ThreadPoolExecutor` with no queue. It keeps `concurrency` threads and
allows up to twice that many. A task a fast-tier completion claimed starts while the completing
handler's thread still returns.

The worker claims only for free slots and within `DispatchSlots#thread_room`, the executor threads
neither running nor reserved. A fused claim asks for at most that room. Handovers in a row therefore
cannot outrun the executor, and a claimed task never waits for a thread.

### Running and stopping

`Worker#run` blocks until `Worker#stop`, and `Worker#run_once` claims and runs one batch. A handler
registered with `Worker#handle` receives the payload and a `HandlerContext`, which carries `task`
and `cancellation`.

`CancellationToken#reason` is one of `:requested`, `:deadline_exceeded`, `:execution_timeout`,
`:lease_lost`, `:suspended`, or `:shutdown`. Only the first reason sticks. The worker never
interrupts a handler thread with `Thread#raise`, `Thread#kill`, or `Timeout`.

After `stop`, the worker shuts down in this order:

1. It claims nothing new.
2. It waits up to `shutdown_grace` for running handlers.
3. It cancels the rest with `:shutdown` and waits a 250 millisecond unwind window.
4. It abandons a handler still running after that window with its lease, and `run` raises
   `ShutdownIncompleteError`.

A handler that raises the `CancelledError` of its `:shutdown` cancellation charges no attempt. The
error may arrive directly, as `check!` raises it, or as the cause of another error. The worker also
requires its own token to carry `:shutdown`, so an error the application builds charges its attempt.
`run_handler` hands the task to `release_owned_v1` instead of `fail_v1`, as it does for a task
without a handler. Any other error keeps its usual settlement, even after the cancellation.

### Ruby handler context

Ruby `HandlerContext` in `ruby/lib/stablemates/workhorse/context.rb` also carries the durable calls.

| Call                                                                            | Behavior                                                                                                                          |
| ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `get_checkpoint(name)`                                                          | Returns the stored `TaskCheckpoint`, or `nil` when none exists.                                                                   |
| `checkpoint(name) { ... }`                                                      | Returns the stored value, or runs the block once and saves its result through `save_checkpoint_v1`.                               |
| `set_progress(value)`                                                           | Calls `update_progress_v1` and returns the stored `TaskProgress`.                                                                 |
| `get_progress`                                                                  | Returns the latest `TaskProgress`, or `nil` before any report.                                                                    |
| `sleep(name, seconds)`                                                          | Accepts 1 millisecond through 365 days. Calls `schedule_wait_v1`.                                                                 |
| `sleep_until(name, time)`                                                       | Accepts a `Time` at most 365 days ahead. Calls `schedule_wait_v1`.                                                                |
| `wait_for_signal(name, timeout:)` and `wait_for_human(name, context, timeout:)` | Take an optional timeout from 1 millisecond through 7 days.                                                                       |
| `run_child(name, task_type, payload, **options)`                                | Takes the `Queue#enqueue` keywords less the coalescing and dependency options, and calls `create_child_v2`.                       |
| `run_children(children)` and `run_children_all(children)`                       | Take at most 100 `ChildTaskRequest` values with unique names, and call `create_children_v1` with mode `settled` or `all_success`. |

`run_children` maps each name to a `ChildOutcome`, and `run_children_all` maps each name to its
result. An omitted child queue is the worker's first queue.

#### Progress ordering

When progress writes overlap, the context keeps the highest `revision` PostgreSQL acknowledged,
whatever order the writes return in. A throttled report raises `ProgressRateLimitedError`, whose
`retry_after` is in seconds.

#### Argument validation

- A checkpoint or wait name is a String of 1 through 200 characters. An invalid name raises
  `ArgumentError` before the block runs or any statement.
- Signal and human wait names contain 1 through 200 characters without surrounding whitespace.
- The human context encodes to at most 65,536 bytes of JSON.
- A `timeout` other than nil must be a count of seconds, or the wait raises `ArgumentError` before
  any write.

#### Children and contracts

A contracted child carries the current contract that `get_contract_definition_v1` returns, because a
child write has no stale-contract retry. PostgreSQL compares a replayed request with the accepted
one, contract stamp included. On `conflict`, the context therefore reads each existing child's
`contract_version` through `task_child` and `get_task`. It retries once with those versions stamped.
When the current contract rejects a replayed payload, the context builds the request again under
those versions before it writes.

A parent holds one individual child or one child set.

- `run_child` under a second name, or after a child set, raises `LimitExceededError`.
- A child set after an individual child raises `ConflictError`.
- A child set of more than 100 children raises `LimitExceededError` before any write.
- A joined result over the set's byte limit makes `create_children_v1` return `result_too_large`,
  which raises `ChildResultLimitExceededError`.

#### Errors

| Status or condition | Error                   |
| ------------------- | ----------------------- |
| `stale`             | `LeaseLostError`        |
| `conflict`          | `ConflictError`         |
| `already_waiting`   | `AlreadyWaitingError`   |
| `limit_exceeded`    | `LimitExceededError`    |
| Undefined status    | `UnexpectedStatusError` |

Before each durable write, the context checks the token. It raises `LeaseLostError` once the token
carries `:lease_lost`, and `CancelledError` for any other reason. Reads and checkpoint replays
return without that check.

#### Concurrent calls with one name

Concurrent calls with one name share the first call's write, keyed as follows. A mismatched key
raises `ConflictError`.

- A checkpoint shares by name alone.
- A relative sleep shares whatever its duration. An absolute sleep shares only the same wake time.
- A signal wait shares by name alone, so the first call's timeout wins.
- A human wait shares the same context, compared as canonical JSON, and the first call's timeout
  wins.
- A child or child set shares its canonical request, and a child set also shares its mode.

#### Suspension

A `scheduled` wait, a `waiting` signal or human wait, and a `created` child submit
`suspended_for_wait` or `suspended_for_child` to the attempt arbiter. The context records the
release before its log call. The call always raises `HandlerContext::Suspension`, even when that log
raises.

Only a winning submission cancels the token with `:suspended`. That class descends from `Exception`,
so a bare `rescue` does not catch it.

The fenced write already released the task. The worker therefore ends the attempt without failing
or completing it. That holds even when a heartbeat that found the task released won the arbiter with
`lease_expired` first. The attempt's telemetry then reports the suspension, not a lost lease.

When the handler swallows the suspension and returns, the worker ignores the return and logs
`workhorse.handler.signal_swallowed`.

### Ruby batch handlers

`Worker#handle_batch(type, max_size:, linger:, &handler)` registers a batch handler.

- `max_size` accepts integers from 1 through 100 and cannot exceed `concurrency`.
- `linger` accepts a Numeric count of seconds from 0 through 60, rounded to whole milliseconds.

#### Grouping

Each claimed task occupies its own handler thread and slot while it waits in the type's
`BatchCoordinator`. That coordinator keeps one waiting list per queue.

- A full group dispatches at once.
- Otherwise the first member's linger deadline dispatches every group ahead of the waiting member,
  and then its own.
- The coordinator orders members by descending `ClaimedTask#priority`, then by the claim order
  dispatch stamped in `admit`.

When `drain` begins, it calls `BatchCoordinator#flush!`. From then on a waiting member stops
lingering once `Worker#batch_arrivals_complete?` finds every admitted task of its type and queue in
the coordinator. It rechecks every 50 ms.

#### Items and outcomes

The block is called as `handler.call(items)`, with one `BatchHandlerItem` per member in that order.
Each item holds the member's `payload` and its own `BatchHandlerContext` in
`ruby/lib/stablemates/workhorse/batch_context.rb`.

That context wraps the member's `HandlerContext` and exposes only `task`, `cancellation`,
`get_checkpoint`, `checkpoint`, `get_progress`, and `set_progress`. Each write is fenced on that
member's lease, and each cancellation is that member's own token. A member's checkpoint replays
whatever batch a retry puts it in.

The block returns one Hash per item in the same order: `{status: :succeeded, result:}` or
`{status: :failed, error:}` with an `Exception`.

- A raised error, a non-Array return, a wrong count, or an invalid outcome fails every member.
- An error outside `StandardError`, raised or returned, fails its members with a `RuntimeError` that
  names it.
- Every member still settles under its own lease and fence.

#### Evidence and metrics

The coordinator records `record_batch_dispatch_v1` before the call and `record_batch_failure_v1`
after a whole-batch failure. A failed evidence write logs `workhorse.handler.batch_evidence_failed`
and never decides an outcome. Each dispatch records the `workhorse.handler.batch.size` and
`workhorse.handler.batch.linger` histograms.

### Rails integration

When `Rails.application.executor` exists, the Ruby worker runs each handler inside
`Rails.application.executor.wrap`.

When `ActiveRecord::Base` is loaded and its `connection_pool.size` is below `concurrency`, `run`
logs `workhorse.worker.active_record_pool_too_small`. A worker without a `logger` writes that
warning to standard error instead.

### Ruby worker processes

Ruby `Stablemates::Workhorse.run_worker_process(worker)` traps `TERM` and `INT` around
`Worker#run`. Each trap writes its signal number to a self-pipe, and a relay thread reads it. Locks
and logging therefore stay outside trap context.

- The first signal calls `Worker#stop`.
- A second signal calls `Kernel.exit!` with 128 plus its signal number.
- The process exits 0 when `run` returns.
- When `run` raises, the helper writes the error class and message to standard error and exits 1.

The helper reads the worker's stop version before it installs the traps. A signal that arrives
before the run loop starts therefore still stops it.

Ruby `Stablemates::Workhorse.run_worker_processes(processes:, shutdown_grace: 25, &build_worker)`
forks `processes` children, from 1 through 64. Each child calls the block to build its own `Worker`
and pool, then runs it through `run_worker_process`. A child ends with `Kernel.exit!`, so the
`at_exit` handlers it inherited never close the parent's connections.

- The supervisor reaps children every 100 milliseconds.
- It restarts a child that exits while the supervisor is not stopping. When that child lived less
  than one second, the restart follows a one second delay.
- It forwards `TERM` and `INT` to every child. A second signal is forwarded again, so the children
  exit at once.
- Children still running `shutdown_grace` seconds after the first signal receive `SIGKILL`.

The method returns after every child has exited. It raises `NotImplementedError` on a platform
without `Process.fork`.

### Active Job adapter

Ruby `ActiveJob::QueueAdapters::StablematesWorkhorseAdapter` is the Active Job adapter that
`config.active_job.queue_adapter = :stablemates_workhorse` selects.

`require "stablemates/workhorse"` registers an `ActiveSupport.on_load(:active_job)` hook that loads
it. Loading it under Active Job older than 8.0 raises `LoadError`.

`StablematesWorkhorseAdapter.new(executor = nil)` enqueues through
`ActiveRecordExecutor.new(ActiveRecord::Base)` when `executor` is nil. An enqueue then joins the
caller's Active Record transaction when `enqueue_after_transaction_commit` is false.

`enqueue_all` enqueues in atomic chunks of `MAX_ENQUEUE_BATCH_SIZE`. It sets `enqueue_error` and
skips a job whose priority it refuses, and returns how many jobs it enqueued. It clears each job's
`enqueue_error` first, so a job reports only the error of the current call.

#### Default and typed jobs

A job class without a task type is a default job. Its task type is `active_job`, and its payload is
`job.serialize`.

A class that includes `Stablemates::Workhorse::ActiveJob::Options` and calls
`workhorse_options task_type:` is a typed job. Its only argument must be one JSON `Hash` with String
keys, and that `Hash` is the task payload. Any other argument raises `ArgumentError` before a
statement runs. A payload key such as `_aj_globalid` stays a plain key.

`workhorse_options` accepts these keys and raises `ArgumentError` for any other key when the class
loads:

| Key               | Accepts                                                         |
| ----------------- | --------------------------------------------------------------- |
| `task_type`       | A non-empty String of at most 256 bytes other than `active_job` |
| `max_attempts`    | An Integer from 1 through 100                                   |
| `tags`            | At most 18 Strings of 1 to 100 characters                       |
| `concurrency_key` | A non-empty String, or a callable that receives the job         |

#### Enqueue mapping

- The adapter prepends the tags `active_job:<class name>` and `active_job_id:<job_id>`. It omits the
  class-name tag when it is longer than 100 characters.
- `queue_as` sets the task queue.
- `set(wait:)` and `set(wait_until:)` set `run_at`.
- A priority other than nil or an Integer from 0 through 100 raises `ActiveJob::EnqueueError`, which
  Active Job records as `enqueue_error`.

#### Handlers

`Stablemates::Workhorse::ActiveJob.handle(worker, jobs: [])` registers the `active_job` handler and
one handler for each typed class in `jobs`. It raises `ArgumentError` for a listed class without a
task type, and for two classes that declare the same task type.

The default handler calls `ActiveJob::Base.execute` with `provider_job_id` set to the task ID.

- `retry_on` enqueues a new task and completes the current one.
- `discard_on` completes it.
- An exception Active Job re-raises fails the attempt under the task's retry policy.

The typed handler builds the job from the payload and sets `executions` to the attempt number minus

1. It calls `perform_now` inside the `execute` callbacks. Its `job_id` comes from the
   `active_job_id:` tag, or the task ID for a task another SDK enqueued. A typed job's `retry_job`
   raises `ArgumentError`, which fails the attempt without a second task.

`StablematesWorkhorseAdapter#stopping?` returns `Worker#stopping?` for the worker running the
current job. An Active Job continuation therefore stops at a step boundary and resumes as a new
task.

## Rust SDK

### Crate and executors

The Rust crate is `workhorse` in `rust/`, requires Rust 1.89 or newer, and runs on Tokio over
`tokio-postgres` 0.7 and `deadpool-postgres` 0.14.
[ADR 0074](../decisions/0074-shape-the-rust-sdk-as-one-python-shaped-crate.md) records its shape.

The sealed `Executor` trait covers `tokio_postgres::Client`, `tokio_postgres::Transaction`,
`deadpool_postgres::Pool`, `deadpool_postgres::Object`, `deadpool_postgres::Transaction`, and a
reference to any of them.

- A `Pool` executor borrows one connection per statement. When the caller drops a statement before
  it returns, the executor discards that connection rather than return it to the pool
  mid-statement.
- A transaction executor makes every call part of the caller's transaction.
- The client never commits, rolls back, or closes what the caller owns.

The crate exports `MIN_SCHEMA_VERSION` and `MAX_SCHEMA_VERSION` from
`rust/src/sql_catalogue_generated.rs`. They bound the schemas it accepts.

### Queue

`Queue::new(executor, default_queue)` constructs the client. `Queue::connect(url, default_queue)`
opens a `tokio_postgres::Client` without TLS.

`Queue` runs `Queue::assert_compatible` before its first mutation. The check caches a refusal and
retries after a driver error.

`Queue` exposes `enqueue`, `enqueue_many`, `cancel`, `send_signal`, `complete_human_wait`, `health`,
`sync_schedules`, `sync_contracts`, `sync_concurrency_policies`, `sync_rate_limit_policies`,
`sync_budgets`, and the matching policy and budget list methods.

| Input                               | Limit                                      |
| ----------------------------------- | ------------------------------------------ |
| `EnqueueOptions.max_attempts`       | Defaults to 25. Zero selects that default. |
| `enqueue_many`                      | At most 1,000 requests                     |
| Task dependencies                   | 1 through 100 unique prerequisite task IDs |
| Signal payload or human-wait result | At most 65,536 bytes of JSON               |

### Enqueue transport foundation

`EnqueueClient::new(default_queue)` is the enqueue-only transport foundation in
[ADR 0086](../decisions/0086-separate-rust-enqueue-preparation-from-mutable-transports.md).
It owns compatibility, preparation, validation, contracts, bounded refresh and result ordering.
`Queue` delegates `assert_compatible`, `enqueue`, `enqueue_many` and `sync_contracts` to that owner.
`EnqueueTransport::query(&mut self, EnqueueQuery)` returns a `Send` future and requires no `Sync`
or static transaction ownership. Each query exposes generated SQL, JSONB/nullable-text binds,
and required named result columns. Results use typed integers, text, text arrays, JSONB and UUIDs;
SQL null differs from a missing column. The core rejects wrong types, unknown outcomes, invalid
reasons, missing results and duplicate or out-of-range ordinals. Contract mismatches use a singleton
row with ordinal zero and a null task ID, and trigger at most one enqueue retry.
`Error::database(sqlstate, detail, source)` preserves structured driver diagnostics. The core maps
`P1001`, `P1003`, `P1005` and `P1007` to existing enqueue errors without message parsing.
Unknown errors retain their diagnostics and original source; the shipped driver retains
`Error::Postgres`. Clients must keep caches within one logical database and schema.
Adapters use the exact caller-owned connection, never a fallback pool connection, and expose no
transaction lifecycle operation. Dropping a future releases its Rust borrow, not necessarily the
server-side statement. The caller controls driver cancellation and transaction recovery.

#### SQLx enqueue transport

The optional `sqlx` feature implements `EnqueueTransport` for SQLx `Transaction<'_, Postgres>` in
`rust/src/sqlx_transport.rs`. It pins released SQLx 0.8.6 and re-exports it as `workhorse::sqlx`.
The dependency disables defaults and enables only `postgres`, `json`, `uuid` and `runtime-tokio`.
Applications select TLS features; Workhorse selects no TLS backend.
SQLx 0.9.0 requires Rust 1.94.0, beyond Workhorse's pinned Rust 1.89 toolchain.
[ADR 0088](../decisions/0088-borrow-sqlx-transactions-for-rust-enqueue.md) supplements ADR 0074's feature list.

Call `EnqueueClient` methods with `&mut transaction`.
The implementation binds `EnqueueBind::Json` as JSONB and `EnqueueBind::Text` as nullable text.
It executes `fetch_all(&mut **self)` on that transaction's exact connection.
It decodes required columns as native nullable `i32`, `String`, `Vec<String>`, JSON and UUID values.
SQLx type errors retain their original source; Workhorse validates nullability and result semantics centrally.
`PgDatabaseError::code()` and `detail()` feed the shared structured error translator.
No pool, connection acquisition, detached operation or transaction lifecycle method belongs to the transport.

`sqlx_postgres` proves matching backend PID and transaction ID through an enqueue trigger.
It also proves observer invisibility, joint commit/rollback, nested SQLx savepoints, contract sync/refresh,
ordered replayed batches, timestamp JSON serialization, native decoding and structured error parity.
Compile proofs require `Send` borrowed futures and reject overlapping use and commit during enqueue.
Dropping a SQLx query future releases the borrow but does not cancel the PostgreSQL statement.
The caller must roll back an uncertain operation.
After server cancellation, SQLSTATE `57014` leaves the transaction aborted with `25P02` until caller recovery.
The tests cancel through an independent PostgreSQL observer and recover with a caller-owned savepoint.
After rolling back contract changes, use a fresh client or synchronize the actual contracts again.

This feature supports enqueue only, not `Queue`, `Admin`, workers, durable contexts or dashboard drivers.
The sealed runtime executor and deadpool/tokio-postgres worker requirements remain unchanged.
SeaORM, Diesel, non-PostgreSQL SQLx drivers and other SQLx versions are outside the verified transport scope.
CI collects `sqlx_postgres` once through the existing all-features Rust suite on main-targeted pull requests.
The package check builds and runs an SQLx-enabled consumer against the unpacked crate, then tests the default consumer.

### Admin

`Admin::new(executor)` and `Admin::connect(url)` expose `list_tasks`, `get_task`,
`get_task_timeline`, `list_dead_letters`, `redrive`, `redrive_many`, `get_checkpoint`,
`list_checkpoints`, `get_progress`, `get_wait`, `list_waits`, `list_signal_waits`,
`list_human_waits`, `list_workers`, `set_worker_paused`, `pause_queue`, `resume_queue`, and
`purge_queue`.

| Input                     | Default      | Accepts                                        |
| ------------------------- | ------------ | ---------------------------------------------- |
| Page limit                | 100          | 1 through 1,000                                |
| Payload view              | 16,384 bytes | 1 through 1,048,576; at most 50 redaction keys |
| `AdminAudit` `actor`      |              | 1 through 200 characters                       |
| `AdminAudit` `reason`     |              | 1 through 2000 characters                      |
| `AdminAudit` `request_id` |              | 1 through 512 UTF-8 bytes                      |

### Rust worker

`Worker::new(pool, options)` accepts a caller-owned `deadpool_postgres::Pool`. It validates
`WorkerOptions` before it returns. `WorkerOptions::default()` gives the ADR 0072 values.

| Option                         | Default                                                             | Accepts                                                                 |
| ------------------------------ | ------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `WorkerOptions.queues`         | `["default"]`                                                       | Drops empty names and later duplicates; must keep one name              |
| `worker_id`                    | Host name, process ID, and a random suffix                          |                                                                         |
| `concurrency`                  | 1                                                                   | 1 through 100                                                           |
| `lease_duration`               | 30 seconds                                                          | Whole milliseconds from 100 milliseconds through 24 hours               |
| `heartbeat_interval`           | One third of the lease, truncated to a whole millisecond            | Positive values shorter than the lease                                  |
| `poll_interval`                | 5 seconds when the worker expects a listener, else 250 milliseconds |                                                                         |
| `maintenance_interval`         | 1 second                                                            | Positive whole milliseconds                                             |
| `maintenance_routine_interval` | 60 seconds                                                          | Positive whole milliseconds                                             |
| `registry_interval`            | 5 seconds                                                           | Whole milliseconds of at least 100                                      |
| `schedule_namespaces`          | Empty                                                               | Rejects empty names; drops later duplicates                             |
| `schedule_catchup_limit`       | 100                                                                 | 1 through 10,000                                                        |
| `shutdown_grace_period`        | 25 seconds                                                          | Positive whole milliseconds                                             |
| `retry_delay`                  |                                                                     | Overrides one failed attempt's delay; `None` keeps the persisted policy |

The worker expects a listener only when all of these hold:

- `listen_config` is set;
- `polling_only` is false;
- the pool permits at least two connections.

`Worker::new` rejects a pool whose maximum size is below 3, because heartbeats reserve one
connection beside one claim and one settlement. `shared_heartbeats` opts out and sends heartbeat
rounds through the shared pool.

#### Heartbeat fencing

The Rust worker snapshots each heartbeat member's task ID and fence token before calling
`heartbeat_many_v1`. `Inner::deliver_heartbeats` in `rust/src/worker/heartbeat.rs` applies a result
only while the registered member still has that fence token.

A parent may suspend and resume under a new fence while the old round is in flight. The old result
cannot renew or cancel that new claim.

#### Handlers and batches

`Worker::handle` registers a typed handler for one task type and replaces any earlier one. A payload
that fails to decode fails the attempt through the task's retry policy.

`Worker::handle_batch` takes `BatchOptions`.

- Its `max_size` accepts 1 through 100 and must not exceed the worker's concurrency.
- Its `linger` accepts whole milliseconds from zero through 60 seconds.
- Both methods panic on an empty task type, and `handle_batch` panics on invalid options.

The member whose arrival fills or lingers out a batch runs its callback inside its own execution, as
Go does. That member keeps its slot until the callback returns, even when the member is cancelled.
The shutdown drain counts it the same way.

A member that waits for its batch holds a `Registration` guard in `rust/src/worker/batch.rs`.
Dropping the execution, for example by dropping `run` or `run_once`, drops the guard. That removes
the member from its queue at once. The worker keeps its batch coordinator, so a later batch on the
same worker never receives the abandoned member. A guard whose member a callback already took finds
nothing to remove.

A batch coordinator holds only a weak reference to its worker. Dropping the last `Worker` handle
therefore frees the worker, its handlers, and whatever they captured. A batch that dispatches after
that rejects each member with `BatchAbandoned` without calling the handler.

#### Panics

The worker calls each handler and batch callback inside the future it catches unwinds on. A panic
before the callback returns its future is therefore caught like one while that future is polled.

A caught panic fails the attempt with `HandlerPanic` and one of these messages:

- `handler for <type> panicked: <detail>`;
- `batch handler for <type> panicked: <detail>`, for every member of a batch.

A batch panic also calls `record_batch_failure_v1`.

`Worker::run(shutdown)` and `Worker::run_once` share one execution permit.

#### Shutdown

When `shutdown` resolves, `Worker::run` stops claiming and drains within `shutdown_grace_period`.
The deadline is fixed when `dispatch` in `rust/src/worker/dispatch.rs` observes `shutdown`. Claims
still in flight, the draining `register_worker_v1` refresh, and running handlers all spend from it.

- Plain claims and fused claims settle together.
- A claim still pending at the deadline is dropped. Any task it claimed stays leased until lease
  recovery reclaims it.
- Tasks from claims that returned in time still run, even when another claim stalls.
- Handlers still running when grace ends see `CancelReason::Shutdown` and get 250 milliseconds to
  unwind. A handler that returns an error after that cancellation charges no attempt: the worker
  hands its task to `release_owned_v1`. A handler panic still fails the attempt, and a handler that
  returns a value still completes.
- `run` abandons any that outlive that window and returns `Error::ShutdownIncomplete`. Their leases
  expire, and lease recovery reclaims the tasks.

#### Cleanup window

These steps share a cleanup window: stopping the registry loop and the listener, then
`deregister_worker_v1` and the release of the reserved heartbeat connection. That window ends 1
second after the later of the deadline and the end of the drain.

- `run` aborts a loop still running at that point and logs a deregistration that has not returned.
- A statement either bound cuts off discards its pooled connection, and so does a claim the
  deadline drops.
- Aborting the listener also aborts the task that drives its connection, so that connection closes.
- A heartbeat round still holding the reserved connection then releases it when the round ends.
- The registry row then ages out through `prune_worker_registry_v1`.

#### Notifications and process signals

The notification listener reconnects after an exponential delay from 100 milliseconds through 5
seconds. It allows 1 second for `UNLISTEN` on clean shutdown.

`run_worker_process(&worker)` in `rust/src/worker/process.rs` installs `SIGINT` and `SIGTERM`
handlers, or waits for Ctrl-C on other platforms. It passes that signal as the shutdown future. It
never exits the process, so the caller chooses the exit code.

### Rust handler context

`HandlerContext` in `rust/src/context.rs`, `rust/src/waits.rs`, and `rust/src/children.rs` gives
each handler its durable calls over the worker's pool. Every checkpoint, wait, and child name
contains 1 through 200 characters.

| Call                                                | Behavior                                                                                                                                     |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `checkpoint(name, op)`                              | Returns the stored value, or runs `op` once and saves its result.                                                                            |
| `set_progress`                                      | Replaces the latest progress. A throttled report returns `Error::ProgressRateLimited` with its retry delay.                                  |
| `get_progress`                                      | Returns `None` before any report.                                                                                                            |
| `sleep`                                             | Accepts whole milliseconds from 1 millisecond through 365 days.                                                                              |
| `sleep_until`                                       | Accepts a wake time at most 365 days ahead.                                                                                                  |
| `wait_for_signal` and `wait_for_human`              | Take an optional timeout of whole milliseconds from 1 millisecond through 7 days. The human context encodes to at most 65,536 bytes of JSON. |
| `run_child`, `run_children`, and `run_children_all` | Accept at most 100 children with unique names.                                                                                               |

`run_children` maps each name to a `ChildOutcome`, and `run_children_all` fails unless every child
succeeds.

#### Contracted children

A contracted child carries the current contract that `get_contract_definition_v1` returns, because a
child write has no stale-contract retry. The context validates each child payload first and returns
`Error::ContractValidation` before any write.

PostgreSQL compares a replayed request with the accepted one, contract stamp included. On
`conflict`, the context therefore reads each existing child's `contract_version` through
`task_child` and `get_task`. It retries once with those versions stamped. When the current contract
rejects a replayed payload, the context builds the request again under those versions before it
writes.

#### Errors and suspension

- An oversized child result returns `Error::ChildResultLimitExceeded`.
- A refused durable call returns `Error::Conflict`, `Error::LimitExceeded`, `Error::AlreadyWaiting`,
  or `Error::LeaseLost`.
- A suspending call returns `Error::Suspended`. PostgreSQL has already settled that task, so the
  worker ignores the handler's return.

### Dashboard feature

The `dashboard` feature adds `rust/src/dashboard/`. `dashboard::handler(DashboardOptions)` returns a
`tower::Service` over a caller-owned executor. `dashboard::authorize` adapts an async closure that
returns an `Authorization`.

### Rust examples

- `rust/examples/` holds the runnable quickstart, transaction, dedicated-worker, and orchestration
  programs.
- `rust/examples/docs.rs` holds the `// docs:start` regions the site embeds.
- `rust/examples/landing.rs` holds the `landing-*` regions behind the landing page's Rust tabs.
- `rust/examples/agent_playbook.rs` is the whole-file region behind the agent playbook.
- `rust/examples/sqlx_transaction.rs` owns the `sqlx-transaction` region and requires the `sqlx` feature.

`pnpm rust:clippy` compiles every example with `--all-targets`.

`site/scripts/check-language-examples.ts` requires two things. Each Rust fence in
`site/content/docs/` and `docs/guides/`, and each Rust snippet in `site/lib/landing-snippets.ts`,
must equal one region. Every region must back at least one of them.

## Documentation and release checks

### README alignment

`scripts/readme-alignment.test.ts` derives SDK support sentences from `support.json` and the Go pgx
claim from `go/go.mod`. It derives the Rust claim from `rust-version` in `rust/Cargo.toml`.

It requires the TypeScript, Python, Go, and Rust README code blocks to be verbatim excerpts of their
release-tested quickstart files. `pnpm check` runs this focused test before the repository test
suite.

### TypeScript documentation examples

`scripts/typescript-doc-examples.test.ts` compiles the TypeScript `ts` fences with `strict: true`.
It covers both READMEs, the site introduction, and the child-task guide. It resolves
`@stablemates/workhorse` to `typescript/core/src/index.ts` and declares application helpers in a
typed harness.

The TypeScript quickstart is `typescript/examples/quickstart.ts`. The packed consumer type-checks it
under the same strict settings before running it.

### Install commands

`support.json` also owns the install commands under its `install` key:

| Key            | Command                                                               |
| -------------- | --------------------------------------------------------------------- |
| `node`         | `npm install @stablemates/workhorse`                                  |
| `python`       | `pip install stablemates-workhorse`                                   |
| `go`           | `go get github.com/stablemates/workhorse/go`                          |
| `rust`         | `cargo add workhorse`                                                 |
| `schema`       | `npm exec --no -- workhorse schema install`                           |
| `schemaPinned` | `npx --package @stablemates/workhorse@0.6.1 workhorse schema install` |

The four language commands carry no version. The two schema commands are the deployment tool rather
than an adoption step. Their version must equal the SDK the application depends on:

- `schema` achieves that by resolving the binary from the project's own `node_modules`, which `--no`
  requires and never installs.
- `schemaPinned` achieves it by naming the version, for a project that has no `node_modules`.

`scripts/install-commands.test.ts` requires each command verbatim on the surfaces that introduce the
product:

| Surface                                                                                                                       | Commands                                                                                             |
| ----------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `README.md` and `typescript/core/README.md`                                                                                   | `node` and `schema`                                                                                  |
| The `dashboard`, `dashboard-server`, `drizzle`, `knex`, `kysely`, `otel`, `prisma`, and `typeorm` READMEs under `typescript/` | `node`                                                                                               |
| `python/README.md`                                                                                                            | `python` and `schemaPinned`                                                                          |
| `go/README.md`                                                                                                                | `go` and `schemaPinned`                                                                              |
| `go/examples/README.md`                                                                                                       | `go`                                                                                                 |
| `rust/README.md`                                                                                                              | `rust` and `schemaPinned`                                                                            |
| `site/content/docs/installation.mdx`, `quickstart.mdx`, and `for-ai-agents.mdx`                                               | The four language commands and both schema commands; `installation.mdx` also states `schemaDownload` |
| `site/content/docs/api.mdx`                                                                                                   | Both schema commands                                                                                 |

`typescript/dashboard-contract/README.md` is exempt because it installs a type-only development
dependency. The test fails when a published package gains a README that is neither governed nor
exempt.

Three sweeps cover every tracked Markdown and MDX file outside `docs/decisions/`:

1. No install command other than a `workhorse schema` command may name a version.
2. `install.schemaPinned` must name exactly the version in `typescript/core/package.json`, while
   `install.schema` names none.
3. No file may run the `workhorse` binary through `npx` without `--package`. Outside a project that
   already depends on `@stablemates/workhorse`, `npx` resolves that form to an unrelated package.

## PostgreSQL and runtime responsibilities

PostgreSQL owns canonical JSONB values, enqueue outcomes, claim selection, leases, fence tokens,
retry timing, lifecycle transitions, checkpoints, waits, dependency resolution, child lineage,
signal delivery, human completion, and structured SQL errors.

Each language runtime has these duties:

- It validates local arguments, registers handlers, bounds concurrency, and sends heartbeats.
- It attaches polling or notifications and delivers cancellation locally.
- It emits telemetry, maps errors, and drains during shutdown.

Batch handlers remain a runtime feature assembled from tasks with separate fence tokens.

This page is the precise reference. For the ideas it assumes — leases and fence tokens,
at-least-once delivery, cooperative cancellation, the runtime/outcome split — start with
[`guides/000-start-here.md`](../guides/000-start-here.md).
