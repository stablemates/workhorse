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

`v1/runtime.json` defines behavior that every language worker supplies above the SQL protocol. Its
batch fixture pins priority order, positional outcomes, retries, terminal failures, and independent
attempt state for jobs with separate fence tokens.

`v1/requests.json` maps public enqueue inputs to the exact JSON request sent to PostgreSQL. The
TypeScript suite executes these mappings through `Queue`, so serialization changes fail alongside
SQL projection, cast, argument-order, and arity changes.

The TypeScript verifier lives in `scripts/verify-sql-protocol.ts`. It checks compatibility before
calling versioned PostgreSQL functions, so another language can implement the same small
interpreter without inheriting TypeScript behavior. The TypeScript suite separately runs the
runtime fixture through `Worker`. Run `pnpm test:protocol` to verify both fixture kinds against a
clean install and the SQL scenarios against a database migrated from the supported baseline.

PostgreSQL owns accepted JSON values, lifecycle transitions, idempotency, retries, waits, fencing,
and structured database errors. A language runtime owns local validation, handler dispatch,
concurrency, heartbeats, polling or notifications, cancellation delivery, telemetry, and graceful
shutdown.
