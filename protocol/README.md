# SQL protocol conformance fixtures

`v1/manifest.json` identifies the fixture format, SQL protocol, compatible schema, supported client
range, required capabilities, and TypeScript contract sources. A client must read compatibility
metadata and refuse mutations before it executes a fixture when either version is outside the
declared range.

`v1/governed-surface.json` records the SQL surface a supported release reads: every governed
function with its argument and result types, every governed view and table with its governed
columns, and the internal helpers listed beside them. `scripts/generate-sql-catalogues.ts` derives
it from `v1/manifest.json`, the three dashboard backends, and the published `dashboard_*_v1` views,
then classifies a change against it. The generator adds to the file and never drops from it, so
`pnpm sql-catalogues:check` fails a removed or retyped entry by name and passes an addition. See
[What SemVer governs](../docs/versioning.md#the-governed-sql-surface) for the membership rule.

`v1/scenarios.json` is an ordered list of raw PostgreSQL calls. Each step supplies SQL, positional
parameters, canonical result rows, optional captured values, and optional structured error fields.
A structured error pins `code`, `message`, and optionally `detail` and `hint`. SQLSTATE `P1001` to
`P1010`, apart from `P1004`, carry their fields as a JSON object in DETAIL, and DETAIL stays
authoritative. From schema version 77, each also sets HINT to the same JSON text, because Npgsql
hides DETAIL by default. A runner parses an expected `hint` as JSON and matches it as it matches
`detail`.
Objects containing only `$ref` reuse a captured value. Objects containing only `$type` accept a
dynamic PostgreSQL value of `uuid`, `timestamp`, `integer`, or `string` while all surrounding JSON
remains exact.
All seven SDKs execute every scenario: TypeScript, Python, Go, Rust, Ruby, the JVM, and .NET. The
dashboard conformance tests do not read this file. They read `dashboard/v1/conformance.json`.

`v1/compatibility.json` is the language-neutral refusal table. Each case gives an installed schema
version, a client protocol version, the protocol versions the schema serves, and whether the client
must accept the schema. All seven SDKs execute every case.

`v1/interpreter.json` tests the independent fixture interpreters without involving PostgreSQL. It
pins matcher acceptance and rejection, normalized values, reuse of captured values, and structured
error matching. All seven SDKs execute every interpreter fixture.

The scenarios also pin database-owned maintenance orchestration. The `retention-maintenance`
scenario calls `run_maintenance_v1` and verifies the ordered slow phase list. Every SDK executes it,
so a worker SDK cannot claim retention participation while depending on another language's process.

The Rust and Ruby runners record a fixture that needs PostgreSQL as skipped when
`DATABASE_URL_TEST` is not set. The other runners need the database. The Rust, Ruby, JVM, and .NET
runners each keep an `expected-unsupported.json` list of the fixtures they cannot pass yet, each
with the Issue that owns the gap. All four lists are empty now.

`v1/runtime.json` defines behavior that every language worker supplies above the SQL protocol. Its
fixtures pin batch ordering and settlement as well as durable-wait suspension, slot release,
single-logical-attempt replay, and checkpoint reuse when a handler restarts. They also pin
cooperative cancellation, deadline and execution-timeout settlement against the database clock,
lease-loss fencing, serialized worker-level heartbeat batches, and graceful drain without further claims.
Its refused-completion fixture pins what a worker does when PostgreSQL refuses a completion write.
A due deadline or attempt timeout fails the task before the run returns, and a cancellation request
cancels it. A moved fence leaves the task active for lease recovery.
Its poll-cadence fixture pins the empty-claim backoff step, and every language holds its worker at
the end of each empty claim so the step in force at the enqueue is the fixture's, not the runner's.
Its subscription-recovery fixture holds the `LISTEN` of a worker that can listen. It checks that
the worker polls at the polling-only base until the subscription is live, and at the notification
base after that. Then it ends the live listener session and checks that the worker claims at once
and polls at the polling-only base again.

Its release-wait fixture runs a listening worker that has no handler for its one ready task, with
a 1,000 ms poll interval. Each runner reads the gap between two `released` events, which PostgreSQL
stamps in the release statement. Every worker starts its release wait when its claim returns, and
then releases the task on a handler thread or task. So a release that starts late makes the next
gap shorter than the wait.

The shortest wait is 900 ms, and the fixture requires at least 800 ms. The margin is for this
measurement. With a live subscription and no registry cap, the focused poll-wait cases of each SDK
check that the wait is at least 0.9 times the poll interval
([ADR 0112](../docs/decisions/0112-define-the-poll-wait-order-and-the-worker-interval-range.md)).

Its budget-admission fixture pins that `max_active` holds across queues. A claim is parked on its
queue's token-bucket row after it samples its ready rows. A budgeted task then commits on that
queue, and a claim of the same budget on another queue stays open until the parked claim either
returns or waits for the budget's lock.
All seven SDKs execute every runtime fixture through their own worker, with two deliberate
exceptions. The Python async worker runs only the fixture kinds in `ASYNC_RUNTIME_FIXTURE_KINDS`,
and the Python sync worker runs every kind. Rust runs the `trace-propagation` fixture only with the
`opentelemetry` feature, which `pnpm rust:integration` turns on.

Every claim call requires read committed isolation. Admission counts active leases after it takes
its locks, so a transaction snapshot from before the lock wait could miss a concurrent lease.
`claim_v1`, `claim_many_v1`, and `complete_many_and_claim_v1` therefore raise SQLSTATE `0A000`
under repeatable read or serializable. A client issues each claim as its own statement at the
session's read committed default, or in a transaction that runs at read committed.

`v1/requests.json` maps public enqueue inputs to the exact JSON request sent to PostgreSQL. All
seven SDKs execute these mappings through their public queue clients, so serialization changes fail
alongside SQL projection, cast, argument-order, and arity changes.

`v1/schedules.json` maps recurring schedule definitions to the exact desired-state JSON sent to
PostgreSQL. All seven SDKs execute every mapping through their public queue clients, so their
defaults and field names cannot drift apart.

`manifest.fixtureCoverage` lists every fixture identifier from `requests.json`, `schedules.json`,
and `interpreter.json`. TypeScript, Python, and Go compare that declaration with both the file
contents and the identifiers their runners executed, so adding or skipping a fixture fails
conformance. The Rust, Ruby, JVM, and .NET runners do not read `fixtureCoverage`. They compare each
fixture of every category file with the fixtures they ran and with their `expected-unsupported.json`
list. A fixture that did not run fails, and so does a listed fixture that passes.

`v1/cron.md` defines the cron dialect, IANA wall-clock rules, and schedule catch-up policies.
`v1/cron-occurrences.json` executes that contract through PostgreSQL, including sparse dates,
macros, special day fields, hashed offsets, and daylight-saving transitions. TypeScript, Rust, Ruby,
the JVM, and .NET run this fixture against `cron_occurrences_v1`. Python and Go deliberately do not
read it, because every worker calls `fire_due_schedules_v2`, which delegates occurrence calculation
to that same function.

`v1/failures.json` pins the JSON error envelope a worker passes to `fail_v2`. It fixes the field
set, the exact values local redaction writes, and the name each language records for an error that
names nothing. All seven SDKs execute every fixture through their own envelope builders, so an
operator who groups dead letters by name reads one field rather than seven dialects of it. Each SDK
replaces a NUL character and an unpaired surrogate with U+FFFD before it sends the envelope, because
PostgreSQL `jsonb` stores neither. A fixture message can be an array of parts, so a lone surrogate
does not need a JSON escape that a strict parser refuses.
The envelope carries `name`, `message`, and a `stack` that is null when the error supplies none. A
redacted envelope carries only `name` and `message`, which is what `redact_error_details_v1`
writes, so a worker that redacts locally cannot produce a different shape from PostgreSQL.

`envelope.limits` gives the UTF-8 byte limit of `name`, `message`, and `stack`. After the
replacement, each SDK cuts a longer field at a code point boundary and adds `truncated: true`, as
`bound_error_envelope_v1` does in `fail_v2`. A message part `{"repeat": text, "count": n}` is the
text n times, so a fixture can give a long message, and an expected message can use the same parts.
The fixtures put a two-byte, a three-byte, and a four-byte character at the limit of the message.

`v1/contracts.json` makes the restricted JSON Schema profile executable. All seven SDKs compile
every accepted document and reject the same remote references, dynamic applicators, unevaluated
applicators, and custom keywords before validating the shared instances. An instance can give its
value as JSON text in `json`, so each runner reads it through its own value path.
`minLength` and `maxLength` count Unicode code points. Thus a string with one character outside the
Basic Multilingual Plane has length 1 in every SDK, also when JSON text gives it as a surrogate pair.

An instance with `needs` set to `exactFraction`, `exactInteger`, or `exactBigInteger` runs only in
the SDKs that can hold that kind of number exactly (ADR 0039). Go, the JVM, and .NET run every
instance. Python and Ruby skip `exactFraction`. Rust skips `exactFraction` and `exactBigInteger`.
TypeScript skips all three kinds.

`v1/checkpoint-fingerprints.json` holds the vectors of the checkpoint input fingerprint (ADR
0098). The fingerprint is the SHA-256 digest of the RFC 8785 text of an input. Each vector has an
input as JSON text and one outcome: the canonical text and its digest, or a refusal. The vectors
cover key order by UTF-16 code units, escapes, the escape of U+FFFD, control characters, number
forms, exponent limits, the 2^53 - 1 integer limit, and lone surrogates.

A refusal names its class: `loneSurrogate`, `nonFinite`, or `unsafeNumber`. An SDK can refuse an
input when its JSON decoder reads the text or when it computes the fingerprint.

Some `unsafeNumber` vectors also have `roundedDigest`. The exact value of such a number is more
than 2^53 - 1 in magnitude, but its nearest double is not, as with `9007199254740991.25`. ADR 0098
applies the limit to the value that the SDK gets, and a decoded double cannot show the rounding.
Thus the outcome depends on how the test decodes the input, and each test states its mode in code:

- Go and .NET keep the exact number text, as a `json.RawMessage` and a `JsonDocument` token. They
  refuse the vector.
- TypeScript, Python, Ruby, Rust, and the JVM decode each number to a double first. They give
  `roundedDigest`, the digest of that double. The JVM SDK refuses a `BigDecimal` above the limit,
  and a separate JVM test covers that path.

The unit tests of all seven SDKs read this file directly, and no SDK keeps a copy of the vectors.
The Rust, Ruby, JVM, and .NET conformance runners list the file as metadata, because they do not
execute it.

The TypeScript verifier lives in `scripts/verify-sql-protocol.ts`. It checks compatibility before
calling versioned PostgreSQL functions, so another language can implement the same small
interpreter without inheriting TypeScript behavior. The TypeScript suite separately runs the
runtime fixture through `Worker`. Run `pnpm test:protocol` to verify both fixture kinds against a
clean install and the SQL scenarios against a database migrated from the supported baseline.

PostgreSQL owns accepted JSON values, lifecycle transitions, idempotency, retries, waits, fencing,
and structured database errors. A language runtime owns local validation, handler dispatch,
concurrency, heartbeats, polling or notifications, cancellation delivery, telemetry, and graceful
shutdown.

## Durable-script fixtures

A `durable-script` fixture runs a handler through its handler context to a terminal state, and it
checks the stored rows after each part. The handler runs the operations of `script` in order. Each
operation that has a `key` puts its value under that key in the result of the handler.

| Operation                | What the handler does                                                          |
| ------------------------ | ------------------------------------------------------------------------------ |
| `checkpoint`             | Saves `value` under `name`, with `input` if the operation has one.             |
| `sleep`                  | Starts the timer `name` for `durationMs`.                                      |
| `sleepUntil`             | Starts the timer `name` until the time in the payload field `wakeAtField`.     |
| `waitForSignal`          | Waits for the signal `name`.                                                   |
| `waitForHuman`           | Waits for the human decision `name` with `context`.                            |
| `runChild`               | Runs the child `name` on `childQueue`, with the times in the payload fields.   |
| `runChildren`            | Runs the children as one set and gives `{ status, result }` for each name.     |
| `catchSuspension`        | Runs `step` and catches each error. After a catch, it returns `{ key: true }`. |
| `overlappingCheckpoints` | Starts a second checkpoint call with one name while the first one runs.        |

The child handler returns `{ "echo": payload }`. For `overlappingCheckpoints`, the operation of a
call returns `{ "operation": n }`, and `n` counts the operations. The first operation waits for a
second operation for at most `overlapWindowMs`, and the second call starts after the first
operation starts. If the second call does not join the call in flight and reads the checkpoint
before the window ends, it runs the operation again, and the fixture sees `n = 2`. A second call
that reads after the window ends gets the stored value, so the window limits what the fixture can
see. No SDK has a hook at the join, so the fixture cannot make the overlap certain. A correct SDK
passes also when the window ends.

The runner then runs the steps in order. `$1` in each statement is the task ID.

| Step      | What the runner does                                                                          |
| --------- | --------------------------------------------------------------------------------------------- |
| `run`     | Runs the task worker, or the child worker for `worker: "child"`, until a claim finds no task. |
| `sql`     | Runs the statement, for example to deliver a signal or to move a timer to the past.           |
| `expect`  | Compares the JSON of the `observe` query, and the counters that the step names.               |
| `handOff` | Ends the first phase of a cross-SDK run. The counters start again at zero.                    |

A `run` step does not count claims, because `runOnce` can claim more than one task in some SDKs.
The children go to `childQueue`, so a run of the task worker ends when the parent task suspends.
The counters are `handlerRuns`, `checkpointOperations`, `caughtSuspensions`, `completedScripts`,
and `returnedSuspendingCalls`. A run that suspends must stop at the suspending call, so that call
does not return and the run does not reach the end of the script:

- `completedScripts` counts the handler runs that reach the end of the script.
- `returnedSuspendingCalls` counts the `sleep`, `sleepUntil`, `waitForSignal`, `waitForHuman`,
  `runChild`, and `runChildren` calls that return. A runner counts a `runChildren` call before it
  reads the outcomes, so a call that returns a wrong value still counts.

PostgreSQL refuses each write of an attempt after the attempt suspends, and it records nothing for
the refusal. Thus no fixture can see a worker that sends a completion after a caught suspension.
The worker tests of TypeScript and Python check the `workhorse.handler.signal_swallowed` warning
of that case. Ruby, the JVM, and .NET emit the warning, but their tests do not check it. The Go and
Rust workers do not emit it.

An `expect` step can give `errorNames`, the error name of each SDK. Before the comparison, the
runner puts the name of its SDK into `errorName` of the expected value. Thus one fixture can check
the failure envelope of each SDK.

Five fixtures run the child limit refusals through real child calls (SM-2025, SM-2028). Each
refusal ends the task at attempt 1 with the limit error of the SDK:

| Fixture                                                         | The handler                                                  |
| --------------------------------------------------------------- | ------------------------------------------------------------ |
| `durable-second-child-set-ends-the-task`                        | Joins a child set, then asks for a set with another name     |
| `durable-same-child-set-twice-joins-it-twice`                   | Joins a child set, then asks for the same set, and completes |
| `durable-second-single-child-ends-the-task`                     | Joins a child, then asks for a child with another name       |
| `durable-child-set-of-more-than-100-children-ends-the-task`     | Asks for a set of 101 children                               |
| `durable-child-join-larger-than-the-result-limit-ends-the-task` | Joins a set whose results are larger than `result_max_bytes` |

Each expected result is the rule that the architecture pages state:

- A signal wait and a human wait suspend the attempt, and the replay returns the stored value
  ([Durable signal suspension](../docs/architecture/lifecycle.md#durable-signal-suspension) and
  [Human decision suspension](../docs/architecture/lifecycle.md#human-decision-suspension)).
- A `runChild` join and a `runChildren` join block the parent until each child ends. The replay
  returns the result of each child.
- A handler that catches the suspension and returns still suspends the task
  ([Worker suspension](../docs/architecture/lifecycle.md#worker-suspension)).
- Overlapping checkpoint calls with one name run the operation one time and share its value
  ([`task_checkpoint`](../docs/architecture/data-model.md#handler-behavior)).
- A child limit refusal and a child join that is too large end the task with no retry
  ([Durable replay conflicts](../docs/architecture/schema-and-protocol.md#durable-replay-conflicts)).

### Cross-SDK replay

A fixture with a `handOff` step can run in two SDKs. SDK A runs the steps before `handOff`, so it
runs the task to its first suspension. SDK B runs the steps after it, so it replays the task to the
end. `scripts/cross-sdk-replay.ts` creates the database, runs the two phases, and then reads the
rows of the last `expect` step again. A runner skips its phase entry point when the harness did not
start it, so the harness does not trust the exit status alone.

Each runner has one entry point for its phases. It reads `WORKHORSE_CROSS_SDK_PHASE` (`suspend` or
`replay`), `WORKHORSE_CROSS_SDK_FIXTURE`, and `WORKHORSE_CROSS_SDK_DATABASE_URL`.

| SDK        | Entry point                                                                                |
| ---------- | ------------------------------------------------------------------------------------------ |
| TypeScript | `runDurableScriptPhase` in `typescript/core/test/support/durable-script.ts`                |
| Python     | `test_cross_sdk_durable_script_phase` in `python/tests/test_worker_runtime_conformance.py` |
| Go         | `TestCrossSDKDurableScriptPhase` in `go/durable_script_conformance_test.go`                |
| Rust       | `cross_sdk_durable_script_phase` in `rust/tests/protocol_conformance.rs`                   |
| Ruby       | The cross-SDK example in `ruby/spec/conformance/protocol_conformance_spec.rb`              |
| JVM        | `CrossSdkPhaseTest` in `jvm/workhorse/src/test/java/run/workhorse/conformance/`            |
| .NET       | `CrossSdkPhaseTests` in `dotnet/tests/Workhorse.Tests/Conformance/`                        |

Run `pnpm test:cross-sdk` for the pairs of `CROSS_SDK_PAIRS`: TypeScript to Go and Go to
TypeScript. The Go CI job runs them. Add `--pair <a>:<b>` to run another pair, with the SDK names
`typescript`, `python`, `go`, `rust`, `ruby`, `java`, and `csharp`. A pair needs the toolchain of
each SDK.

Three cross-SDK fixtures run one script with the same payload. They differ in the rows that SDK A
stores before `handOff`, which SDK B then replays:

| Fixture                                                         | SDK A stores before `handOff`                    |
| --------------------------------------------------------------- | ------------------------------------------------ |
| `durable-script-replays-in-another-sdk`                         | The checkpoint and the timer                     |
| `durable-script-replays-a-pending-child-request-in-another-sdk` | Also the child request, and SDK B runs the child |
| `durable-script-replays-a-pending-human-wait-in-another-sdk`    | Also the child result and the pending human wait |

The script gives each value the forms that differ between languages: number forms, key order, text
outside the Basic Multilingual Plane, time zone offsets, and fractional seconds. Its checkpoint
input has a fixed fingerprint, so both SDKs must compute the same digest. Its child `deadline` and
`runAt` have microsecond digits.

The absolute timer of the script has microsecond digits. TypeScript, Ruby, the JVM, and .NET send
a timer target with milliseconds, and Python, Go, and Rust send microseconds. Each SDK calls
`schedule_wait_v2`, which compares the stored target and the sent target at millisecond precision
and stores the target as sent. Thus a pair of a millisecond SDK and a microsecond SDK replays the
target with no conflict, and a different millisecond is still a `WaitConflictError` (SM-1945). The
`payloadSql` of each of the three fixtures holds the setting `'microseconds'`. Rust sends a time
before the year 2000 with digits below the microsecond as the next microsecond. The script does not
use such a time.

## Supported host load

The runtime fixtures set time limits, so a very slow host can fail a fixture without a defect in
Workhorse. If the 1-minute load average of the host is at most 2 for each CPU core, Workhorse
supports the conformance run. On a 32-core host, that limit is a load average of 64. Above the limit,
Workhorse does not support the run, and a failed fixture in it is not evidence of a defect.

A test run in this repository whose result counts as evidence must start below a 1-minute load
average of 60. For example, a run that counts how often a test fails must start below that load.

## Rust integration lane

The Rust integration harness lives in the canonical Cargo workspace rooted at `Cargo.toml`.
`rust/tests/protocol_conformance.rs` executes every fixture kind through the Rust adapters, as the
Go and Python lanes do. The contract fixtures and the runtime kinds that read private worker state
run in the unit tests of the crate (`rust/tests/crate_private`). Fixtures the Rust lane cannot pass yet appear on
`rust/tests/conformance/expected-unsupported.json`, each with the Issue that owns the gap. The runner
fails when an unlisted fixture does not pass, and when a listed fixture passes.

Run `pnpm rust:conformance:check` for generated evidence and `pnpm rust:release-check` for the
pinned-toolchain, crate-package, and clean-project consumer checks.

`fail_v1` reserves the delay override `-1` for terminal failure from schema version 54 onward.
It preserves the current attempt even when retry budget remains. NULL, zero, and every other
value retain their retry semantics. Ownership, cancellation, and expiration checks still run first.
The replay-conflict runtime fixture checks that all SDKs select this override for deterministic
conflicts and for child limit and child result limit errors (SM-2025). It also checks that they
keep the error names, and that a transient error and an occupied signal wait stay retryable.
In its `checkpoint-input` case, the handler saves a checkpoint with one input and then calls the
same checkpoint with another input. Thus each SDK raises its own typed checkpoint input conflict.
