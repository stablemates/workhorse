# Dashboard wire contract, version 1

This directory is the language-neutral contract a backend implements to embed the Workhorse
dashboard (ADR 0029). The React application in `dashboard/app` is the only frontend; a backend
serves its bundle and answers its RPC procedures. The TypeScript server in
`typescript/dashboard-server` is the first implementation bound by this contract.

The committed artifacts are the authority and the oRPC router in
`typescript/dashboard-server/src/server/router.ts` is the generator, the same relation
`sql/schema/current.sql` has to the migrations. `pnpm dashboard-spec:generate` regenerates the
artifacts; `pnpm dashboard-spec:check` and `typescript/dashboard-server/test/dashboard-spec.test.ts`
fail when the router and the artifacts disagree. A router change that alters these files is a
reviewed contract change. A change that breaks an existing client requires a new `dashboard/v2`
directory; this directory then only receives compatible corrections.

## Artifacts

- `manifest.json` identifies the format, the transport envelope, the authentication and CSRF
  expectations, and every procedure with its mutation flag.
- `procedures.json` gives each procedure its URL path, mutation flag, request-input JSON Schema,
  and response JSON Schema (2020-12). Shared wire types live under `$defs`. An `input` of `null`
  means the procedure accepts an empty request envelope; an `output` of `null` means it produces
  no result and answers `{}`. Its `html` member fixes the two template placeholders and the
  runtime-configuration schema that every backend inserts into `index.html`.
- `conformance.json` carries the executable HTTP conformance fixtures described under
  [Conformance](#conformance).
- `bundle/bundle.json` identifies the static archive for this contract's `readSurfaceVersion` and
  records its SHA-256 digest. The archive contains the compiled application under `app/` and the
  shared single-admin page as `login.html`.

`pnpm dashboard-bindings:generate` reads `procedures.json` and writes the Go and Python request
validators and wire types. `pnpm dashboard-bindings:check` fails when either committed binding is
stale. The dashboard spec commands run the matching bindings command, so one generation command
updates the router artifact and both language bindings in order.

`pnpm dashboard-bundle:generate` rebuilds the application, writes the deterministic tracked
archive, and fetches it into the Go module and Python package. `pnpm dashboard-bundle:check`
rebuilds and compares all three copies. `pnpm dashboard-bundle:fetch` materializes the committed
archive without rebuilding the application, which is the language release-build seam.

## Transport

Every procedure is one HTTP endpoint: `POST {basePath}/rpc/dashboard/{procedure}` with
`content-type: application/json`. `{basePath}` is the dashboard mount path — `/workhorse` by
default, empty when the dashboard owns the host root (`normalizeDashboardPath` in
`typescript/dashboard-server/src/server/host.ts`). Other HTTP methods answer status 405.

The body is an oRPC RPC envelope. A request carries the validated input under `json`; a success
response carries the result under `json`:

```json
{ "json": { "id": "5c1f…", "audit": { "actor": "…", "reason": "…", "requestId": "…" } } }
```

Every type in this contract is plain JSON, so the envelope's optional `meta` array (which oRPC
uses to restore non-JSON values such as dates or maps) is never required: a backend may ignore an
incoming `meta` and must not need one on responses. A procedure whose `output` is `null` answers
`{}` with status 200.

A failed call answers the error envelope with a matching HTTP status:

```json
{ "json": { "defined": false, "code": "NOT_FOUND", "status": 404, "message": "Task not found" } }
```

Codes the reference implementation uses: `BAD_REQUEST` (400, malformed envelope or input rejected
by the request schema), `FORBIDDEN` (403, mutation on a read-only dashboard), `NOT_FOUND` (404,
`eventDetail`, `jobDetail`, `runTaskNow`, `cancelTask`, `signalTask`, `completeHumanWait`),
`METHOD_NOT_SUPPORTED` (405), and `INTERNAL_SERVER_ERROR` (500). Input constraints beyond JSON
Schema — for example `enqueueTest` requiring `feature` when `kind` is `"feature"` — are enforced
server-side and answer `BAD_REQUEST`.

## Request handling order

The reference host processes every owned request in this order; a conforming backend must not
reorder authorization behind procedure execution:

1. **Authorization.** Every dashboard, RPC, and asset request is authorized by the host
   application (or by built-in single-admin sessions). An unauthenticated request answers 401,
   an unauthorized one 403.
2. **Schema compatibility.** An incompatible installed Workhorse schema answers 503 with
   `{ "error": "…" }`.
3. **Same-origin check.** A procedure flagged `mutation` requires an `Origin` header whose origin
   equals the request URL's origin; a missing, mismatched, or unparsable `Origin` answers 403
   with `{ "error": "A same-origin mutation request is required" }` before the procedure runs.
   This is the dashboard's CSRF protection; it relies on the browser sending `Origin` on
   cross-origin POSTs and assumes cookie-authenticated deployments stay same-origin.
4. **Input validation**, then the procedure.

Mutations additionally require the backend to be writable: a read-only backend answers
`FORBIDDEN` for every `mutation: true` procedure. Audit attribution (`audit.actor`) is
server-assigned from the authenticated principal; the client-supplied value is ignored.

## Serving the application

Besides RPC, a backend serves three surfaces under `{basePath}`:

- `{basePath}` exactly answers a 302 redirect to `{basePath}/tasks`.
- `{basePath}/assets/*` serves the built bundle's files with immutable caching.
- Every other owned path answers the bundle's `index.html` with two placeholders filled
  (`renderDashboardHtml` in `typescript/dashboard-server/src/server/html.ts`): the runtime
  configuration script `window.workhorseDashboard = { basePath, rpcUrl, auditActor,
authentication, demoTools, workspaces, workspace }` (`DashboardRuntimeConfig`), and optional
  host-owned module tags. `authentication` is null when the host owns authorization; otherwise it
  names the mounted `loginUrl` and `logoutUrl`, and the application redirects there when RPC
  answers 401.

The archive also carries `login.html` with `<!--__WORKHORSE_LOGIN_ERROR__-->` as its only runtime
placeholder. A backend replaces it with either an empty string or the generic invalid-credential
paragraph; session and password verification remain language-specific.

`dashboard/app` keeps its build-time dependency on `@workhorse-js/dashboard-server` because the
Vite development transform invokes the reference server's `renderDashboardHtml`. The compiled
archive contains no server module, so Go and Python consumers have no Node.js dependency.

A backend configured with named workspaces serves each one as its own instance of this contract:
`{basePath}` above is then the workspace mount `{path}/{workspace}` (`DashboardHostOptions.workspaces`
in `typescript/dashboard-server/src/server/host.ts`), the mount path itself answers a 302 redirect
to the default workspace's `/tasks`, and a first path segment naming no workspace answers 404 with
`{ "error": "Unknown dashboard workspace" }`. The runtime configuration's `workspaces` array lists
every `{ name, url }` pair and `workspace` names the one being served; both are empty (`[]` and
`null`) in single-workspace mode.

Reads behind these procedures go through the versioned `dashboard_*_v1` SQL views and mutations
go through the shared versioned SQL functions, so a backend implements transport, sessions, and
delegation — never a second read model. `docs/architecture.md` names the views and functions.

Responses contain persisted data, measurements, timestamps, and machine-readable codes rather
than display prose. The shared SPA owns English wording, labels, fabricated maintenance schedule
rows, activity grouping, worker display status, and display ordering, as decided by ADR 0037.

## Conformance

`conformance.json` is the executable half of this contract, analogous to
`protocol/v1/scenarios.json`: golden HTTP exchanges against a seeded database that every backend
must answer byte-for-byte in structure. `scripts/verify-dashboard-conformance.ts` executes the
file and is the authority on its semantics;
`typescript/dashboard-server/test/conformance.test.ts` runs it against the TypeScript server, the
reference implementation that must pass it. A foreign backend passes the same file by
implementing the verifier's small transport interface (route one `Request` into the backend in
either deployment mode) or by porting the verifier, as `python/tests/test_protocol_conformance.py`
ports the SQL protocol runner.

The file's `scenarios` run strictly in order against one freshly installed schema
(`sql/schema/current.sql`), sharing a single capture namespace:

- A `seed` step executes one SQL statement — the same versioned `workhorse.*_v1` functions the
  SQL protocol fixtures pin — asserts its rows when `expect` is present, and can `capture` values
  (job ids, fence tokens) by row pointer for later `$ref` citations.
- An `exchange` posts one literal oRPC envelope from `request` (after `$ref` resolution) to
  `POST {basePath}/rpc/dashboard/{procedure}` and asserts the exact response `status` and `body`.
  `mode` selects the writable or read-only deployment (default `"writable"`), `origin` sends the
  harness origin, the mismatched `crossOrigin`, or no Origin header (default `"same"`), and
  `method` overrides POST for the 405 fixture.

Expected bodies are exact: every key must appear and no other key may. Two escape hatches keep
them portable: `{"$ref": "name"}` must equal a captured value, and `{"$type": "..."}` accepts any
value of that shape (`uuid`, `timestamp`, `string`, `integer`, `number`, `boolean`, or `any`)
where the concrete value is inherently nondeterministic — generated identifiers, clock-derived
timestamps, durations, and time-bucketed series.

The fixtures must cover every procedure in `manifest.json` with a successful exchange, every
mutation with both a cross-origin rejection and a read-only `FORBIDDEN` exchange, and the 400,
404, and 405 error envelopes; the verifier fails the run when any of that coverage is missing.

The `harness` block is part of the contract for the backend under test: authorize every request
as `authenticatedActor` (the fixtures pin server-assigned attribution to it), report
`environment`, mount at `basePath` on `origin`, and configure `configuredWorkers` and
`maintenanceLoops` as given. Two members of the writable deployment have no shared SQL function
and must be supplied by the harness exactly as the reference harness
(`typescript/dashboard-server/test/support/conformance-harness.ts`) does: an `enqueueTest`
operator that enqueues one `conformance.demo-{kind}` job on the `conformance-demo` queue, and a
`setScheduleEnabled` controller that flips `workhorse.schedule_definition.enabled`.

`pnpm dashboard-conformance:generate` regenerates every exchange's `expect` block by replaying
the file twice against the reference server on two fresh databases: values identical across both
runs commit literally, differing values become `$type` matchers, and each exchange's `coerce`
map (generator input, ignored by verification) forces matchers onto values that are stable
within one machine but environment- or time-dependent. A diff in this file is a contract change
and is reviewed like one.
