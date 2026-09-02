# SQL protocol conformance fixtures

`v1/manifest.json` identifies the fixture format, SQL protocol, compatible schema, supported client
range, required capabilities, and TypeScript contract sources. A client must read compatibility
metadata and refuse mutations before it executes a fixture when either version is outside the
declared range.

`v1/scenarios.json` is an ordered list of raw PostgreSQL calls. Each step supplies SQL, positional
parameters, canonical result rows, optional captured values, and optional structured error fields.
Objects containing only `$ref` reuse a captured value. Objects containing only `$type` accept a
dynamic PostgreSQL value of `uuid`, `timestamp`, `integer`, or `string` while all surrounding JSON
remains exact.

`v1/interpreter.json` tests the independent fixture interpreters without involving PostgreSQL. It
pins matcher acceptance and rejection, normalized values, reuse of captured values, and structured
error matching. TypeScript, Python, and Go must execute every interpreter fixture.

The scenarios also pin database-owned maintenance orchestration. Every language executes
`run_maintenance_v1` and verifies the ordered slow phase list, so a worker SDK cannot claim
retention participation while depending on another language's process.

`v1/runtime.json` defines behavior that every language worker supplies above the SQL protocol. Its
fixtures pin batch ordering and settlement as well as durable-wait suspension, slot release,
single-logical-attempt replay, and checkpoint reuse when a handler restarts. They also pin
cooperative cancellation, deadline and execution-timeout settlement against the database clock,
lease-loss fencing, serialized worker-level heartbeat batches, and graceful drain without further claims.
Its poll-cadence fixture pins the empty-claim backoff step, and every language holds its worker at
the end of each empty claim so the step in force at the enqueue is the fixture's, not the runner's.

`v1/requests.json` maps public enqueue inputs to the exact JSON request sent to PostgreSQL. The
TypeScript suite executes these mappings through `Queue`, so serialization changes fail alongside
SQL projection, cast, argument-order, and arity changes.

`v1/schedules.json` maps recurring schedule definitions to the exact desired-state JSON sent to
PostgreSQL. TypeScript, Python, and Go execute every mapping through their public queue clients, so
their defaults and field names cannot drift apart.

`manifest.fixtureCoverage` lists every fixture identifier from `requests.json`, `schedules.json`,
and `interpreter.json`. Each language compares that declaration with both the file contents and the
identifiers its runner executed, so adding or skipping a fixture fails conformance.

`v1/cron.md` defines the cron dialect, IANA wall-clock rules, and bounded catch-up contract.
`v1/cron-occurrences.json` executes that contract through PostgreSQL, including sparse dates,
macros, special day fields, hashed offsets, and daylight-saving transitions. TypeScript runs this
fixture against `cron_occurrences_v1`. Python and Go need no separate consumers because every
worker calls `fire_due_schedules_v1`, which delegates occurrence calculation to that same function.

`v1/contracts.json` makes the restricted JSON Schema profile executable. TypeScript, Python, and
Go compile every accepted document and reject the same remote references, dynamic applicators,
unevaluated applicators, and custom keywords before validating the shared instances.

The TypeScript verifier lives in `scripts/verify-sql-protocol.ts`. It checks compatibility before
calling versioned PostgreSQL functions, so another language can implement the same small
interpreter without inheriting TypeScript behavior. The TypeScript suite separately runs the
runtime fixture through `Worker`. Run `pnpm test:protocol` to verify both fixture kinds against a
clean install and the SQL scenarios against a database migrated from the supported baseline.

PostgreSQL owns accepted JSON values, lifecycle transitions, idempotency, retries, waits, fencing,
and structured database errors. A language runtime owns local validation, handler dispatch,
concurrency, heartbeats, polling or notifications, cancellation delivery, telemetry, and graceful
shutdown.
