# Dashboard server security review checklist

The TypeScript dashboard server (`@stablemates/workhorse-dashboard-server`) and the Python, Go,
Rust, Ruby, JVM, and .NET dashboard hosts serve `dashboard/v1` to a browser. Each one has an
authorization surface. This checklist is the review that runs against them. Walk each row for each
host. A row that names a TypeScript function applies to the code of each host that does the same
work. The checklist is committed so a later review reads rather than rediscovers, and so a reviewer
can say which rows they walked.

[ADR 0056](decisions/0056-set-the-1-0-0-exit-criteria.md) makes this review a `1.0.0` gate.
[ADR 0058](decisions/0058-fix-the-current-line-and-gate-floors-on-upstream-end-of-life.md)
confirms the gate and adds the re-walk trigger below.

## When to re-walk

A pull request that changes authentication, session or credential handling, the transport surface,
or `dashboard/v1` procedure dispatch re-walks the rows that cover what it touched, and says so in
the pull request. Naming the rows is the point: a reviewer reading the pull request has to be able
to tell which rows were considered and which were not.

Each row below names the rows' own trigger under **Re-walk when**, so an author can select rows
without reading the whole file.

## What a walk produces

A walk records a finding or an explicit "no finding" for every row. Findings that describe an
exploitable path stay in the private operations repository, under
`docs/reviews/<date>-dashboard-server/`. The checklist and the resolved summary are public.

Severity is CVSS v4.0, scored the way `SECURITY.md` scores a report. Every High is resolved before
the gate closes. Every Medium is resolved, or accepted in writing with a reason that says why the
exposure is acceptable rather than why the fix is inconvenient.

No third-party security audit of Workhorse has taken place. `SECURITY.md` states that, and every
review this file describes is a maintainer review.

## Row 1: authorization on every `dashboard/v1` procedure

Confirm that every procedure the surface declares is reachable only through the host's
authorization boundary, and that every procedure the surface marks `mutation` additionally requires
a writable operator.

- Enumerate the surface from `dashboard/v1/procedures.json`, not from memory. Count the procedures
  and count the mutations.
- Read `typescript/dashboard-server/src/server/router-authorization.test.ts`. It names one valid
  input per state-changing procedure, asserts that set equals the router's own mutation set, and
  drives each one against a read-only operator to assert `FORBIDDEN` before any query runs. A new
  mutation fails that suite until it is named there, so this row's work is confirming the suite
  still asserts what it claims rather than re-deriving the list.
- Confirm `mutationProcedure` applies the `mutationAuthorization` middleware before every mutation
  handler. The middleware refuses `context.operator.mode !== "writable"` with `FORBIDDEN` before
  controller or database work. Each handler still refuses the request when its controller is absent.
- Confirm `createDashboardHost` reaches `options.authorize` or `singleAdmin.authorize` before it
  dispatches any RPC, asset, or application request.
- Confirm the browser cannot choose its own attribution: `auditWithOccurredAt` must overwrite
  `audit.actor` with `context.authenticatedActor`.
- Confirm the application page lists a workspace only after `authorize(request, workspace)` grants
  it for that request. `authorizedWorkspaceLinks` builds the list per request, so a principal
  denied a workspace never sees its name or database labels.
- For each SDK host, compare its mutation set with the 18 mutations in `procedures.json`. Confirm
  that its authorization callback runs before each page, asset, and procedure. A host with one
  workspace must write no other workspace into its runtime configuration.

**Re-walk when** a procedure is added, removed, or changes its `mutation` classification; when
`mutationProcedure` or `mutationAuthorization` changes; when a controller becomes optional or
mandatory; when handler authorization moves; or when the runtime configuration gains a field that
describes another workspace.

## Row 2: payload and result redaction in the read surface

Confirm redaction happens in PostgreSQL, as [ADR 0035](decisions/0035-redact-dashboard-payloads-in-the-read-surface.md)
decided, and not in a TypeScript caller that can forget.

- Confirm `workhorse.dashboard_task_v1` projects
  `workhorse.redact_top_level_keys_v1(payload, payload_redact_keys)` rather than `payload`.
- Confirm `workhorse.dashboard_task_outcome_v1` projects no `result` column, and that
  `workhorse.dashboard_task_result_v1` is the only way to read one.
- Confirm no dashboard read reaches a raw `workhorse.task` or `workhorse.task_outcome` column.
- Check `taskValue` as well as `taskDetail`. The payload and result redaction keys do not apply to
  checkpoint values, progress values, or human-wait context.
  [Redaction scope](architecture/dashboard.md#redaction-scope) documents that scope.

**Re-walk when** a `dashboard_*_v1` view or function changes its projection, or when a new read
reaches a payload, a result, or a handler-supplied value.

## Row 3: statement parameterization

Confirm every statement the server issues binds its values.

- Confirm `typescript/dashboard-server/src/server/read-model.ts` passes each read's arguments as a
  single bound `jsonb` parameter to a `workhorse.dashboard_*_v1` function.
- Confirm no call site interpolates a value into `sql` as text. The tag in
  `typescript/dashboard-server/src/server/sql.ts` splices only a nested `DashboardSql` fragment,
  and treats any other value as a bind parameter.
- Confirm the tag still identifies a fragment by the module-private `FRAGMENT` symbol it brands its
  own results with, rather than by the `text` and `values` keys. A structural test would splice any
  object that carries those two keys, so a procedure input admitting an arbitrary object would
  become statement text. `sql.test.ts` asserts that a plain `{ text, values }` object is bound,
  both as a parameter and nested inside `sql.join`.

**Re-walk when** a read stops using a versioned function, when the `sql` tag changes, or when a
procedure input gains a free-form object that a read consumes.

## Row 4: error and stack-trace leakage to the browser

Confirm an error body reveals nothing about container paths or package internals.

- Confirm an unexpected throw inside a procedure reaches the browser as oRPC's generic
  `INTERNAL_SERVER_ERROR`. oRPC's `toORPCError` keeps the original error as a non-serialized
  `cause`, so verify the version in `pnpm-lock.yaml` still does.
- Confirm every deliberate `ORPCError` message is one the maintainers wrote.
- Confirm every dashboard read that projects a persisted worker error honours
  `redactErrorStacks`. Both `taskDetail` and `eventDetail` project
  `workhorse.attempt_history.error`, and a host that withholds stacks from one has to withhold
  them from the other.
- Confirm the standalone listener sets `redactErrorStacks` whenever it is remotely reachable,
  unless the operator passed `--reveal-error-stacks`.
- Each SDK host has a stack-withholding option: `redact_error_stacks` (Python, Rust, Ruby),
  `RedactErrorStacks` (Go, .NET), and `redactErrorStacks` (JVM). Confirm that it covers task detail,
  event detail, the event feed, and event search, and that request input cannot change it.
- Confirm that an error answer carries a message only when the host or the application wrote it
  for the browser. [Error answers](architecture/dashboard.md#error-answers) states the rule for each
  host:
  - The refusals of the host keep their message: input validation, the JSON parser, and the fixed
    refusals.
  - Only these error types carry a message to the browser on purpose, with their status, code,
    message, and data: `ORPCError` (TypeScript), `RPCError` (Go),
    `RpcError` (Rust and Ruby), `Error::InvalidArgument` in `ProcedureError::Client` (Rust), and
    `DashboardRpcException` (JVM and .NET). The Python host has no such type for an application.
  - Each other exception from a procedure answers 500 `INTERNAL_SERVER_ERROR` with
    `Internal server error`. This includes a `ValueError` (Python), an `ArgumentError` or a
    `JSON::ParserError` (Ruby), and an `IllegalArgumentException` (JVM) from an application
    procedure. In a built-in procedure of the Python, Ruby, JVM, and .NET hosts, an argument error
    keeps its 400 message only when Workhorse code raised it.
  - If the reader of the request body fails in the Go or Rust host, the host answers 400
    `BAD_REQUEST` with the fixed message that the TypeScript server gives for a body that it
    cannot decode.
  - If the .NET `Authorize` callback throws, the backend logs the exception and answers 500. This
    includes a cancellation that the client did not cause. In the TypeScript, Python, Ruby, Go, and
    JVM hosts, an exception from `authorize` goes to the web framework, and the host writes no
    answer for it.

  These tests hold the rule:

  | Host       | Test                                                                                                                                                                                                                                                                                                                                                              |
  | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | TypeScript | `typescript/dashboard-server/test/error-answers.test.ts`, `answers an unexpected procedure error with the fixed 500 envelope` and `answers a body that it cannot decode with a fixed 400 message`                                                                                                                                                                 |
  | Python     | `python/tests/test_dashboard_host.py`, `test_an_application_value_error_gets_the_fixed_500_answer`, `test_a_driver_value_error_in_a_built_in_procedure_gets_the_fixed_500_answer`, and `test_the_host_keeps_the_message_of_its_own_input_errors`                                                                                                                  |
  | Go         | `go/dashboard/host_test.go`, `TestHandlerAnswersAnUnexpectedProcedureErrorWithAFixed500` and `TestHandlerAnswersAnUnreadableBodyWithAFixedMessage`                                                                                                                                                                                                                |
  | Rust       | `rust/tests/dashboard_http.rs`, `an_unexpected_procedure_error_gets_the_fixed_500_answer` and `a_body_that_cannot_be_read_gets_a_fixed_message`                                                                                                                                                                                                                   |
  | Ruby       | `ruby/spec/unit/dashboard_spec.rb`, `answers 500 without detail and logs the error when application code raises an ArgumentError`, `answers 500 without detail when a driver raises an ArgumentError in a built-in procedure`, and `keeps the message of its own input errors and of a deliberate RPC error`                                                      |
  | JVM        | `jvm/workhorse/src/test/java/run/workhorse/dashboard/DashboardServletTest.java`, `answersAnApplicationIllegalArgumentExceptionWith500AndNoDetail`, `answersADriverIllegalArgumentExceptionInABuiltInProcedureWith500`, and `answersProcedureErrorsWithTheRpcEnvelope`                                                                                             |
  | .NET       | `dotnet/tests/Workhorse.AspNetCore.Tests/AuthorizationTests.cs`, `AnswersAnAuthorizerCancellationThatTheRequestDidNotCauseWith500AndNoDetail` and `EndsARequestThatTheClientCanceledDuringAuthorizationWithNoAnswer`; `DashboardHostTests.cs`, `AnswersProcedureErrorsWithTheRpcEnvelopeAndNoDetail`; `ErrorOriginTests.cs`, `KnowsAnArgumentExceptionOfALibrary` |

- Confirm the schema-compatibility `503` body carries only version information in all seven hosts.
  A compatibility verdict answers with its message. Any other failure answers with the fixed
  "Unable to verify Workhorse schema compatibility because the database query failed." and is
  logged on the server, never returned. Each host has a test that drives a driver error that
  names a database address. The test asserts that the address stays out of the body:

  | Host       | Test                                                                                                                                                 |
  | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
  | TypeScript | `typescript/dashboard-server/test/rpc-logging.test.ts`, `logs a failed compatibility query and answers without its detail`                           |
  | Python     | `python/tests/test_dashboard_host.py`, `test_dashboard_host_hides_an_unexpected_compatibility_failure`                                               |
  | Go         | `go/dashboard/host_test.go`, `TestHandlerHidesAnUnexpectedCompatibilityFailure`                                                                      |
  | Rust       | `rust/src/dashboard/mod.rs`, `reports_only_a_compatibility_verdict`                                                                                  |
  | Ruby       | `ruby/spec/unit/dashboard_spec.rb`, `answers 503 with a generic message and logs an unexpected compatibility failure`                                |
  | JVM        | `jvm/workhorse/src/test/java/run/workhorse/dashboard/DashboardServletTest.java`, `answers503WithAGenericBodyAndLogsAnUnexpectedCompatibilityFailure` |
  | .NET       | `dotnet/tests/Workhorse.AspNetCore.Tests/DashboardHostTests.cs`, `Answers503WithAGenericBodyAndLogsTheDriverError`                                   |

**Re-walk when** a read starts projecting a persisted error, when `redactErrorStacks` changes
shape, when a host's compatibility check changes what it returns, when a host changes how it
answers a procedure exception or a body that it cannot read, or when the oRPC major version moves.

## Row 5: CSRF, CORS, and browser response headers

Confirm a cross-origin page can neither read the dashboard nor drive a mutation through a
browser's ambient credentials.

- Confirm the host sends no `Access-Control-Allow-Origin` and no other CORS header, so no
  cross-origin page reads a response.
- Confirm `rejectCrossOriginMutation` refuses a mutation whose `Origin` is absent, unparseable, or
  a different origin. Absent must fail closed. Confirm the single-admin logout applies the same
  check, so a cross-origin request cannot end a session. Confirm the single-admin login applies
  it too, before it reads the body or reserves a throttle slot, so a cross-origin form cannot fill
  the failure window of the administrator's address.
- Confirm each backend refuses a page, an asset, or a read procedure whose `Origin` names another
  origin, with 403, and serves a request without `Origin`. A host CORS policy can wrap an embedded
  host, so the first bullet does not hold for every embedding. The `cross-origin-read` conformance
  scenario and the unit tests of each backend hold this rule (ADR 0029, SM-1675).
- Confirm `isDashboardMutation` classifies exactly the paths oRPC dispatches. oRPC matches the raw
  pathname against an exact tree of `encodeURIComponent`-encoded segments; the classifier joins
  the same segments after dropping empty ones. Any path the classifier reads more loosely than
  oRPC must be one oRPC refuses to dispatch. oRPC removes one leading and one trailing slash
  before its exact lookup.
- Each SDK host uses the same procedure name for mutation classification and for dispatch.
  Confirm that an encoded variant or a doubled-slash variant of a procedure path either does not
  dispatch, or gets the same authorization, Origin, and read-only checks as the procedure that it
  selects.
- Confirm a standalone TCP listener without a public origin answers 421 to a `Host` other than
  its bound loopback address and port, before login or authorization runs. Confirm the Python, Go,
  Rust, Ruby, JVM, and .NET hosts refuse an unlisted `Host` the same way when their allowed hosts
  are set (`allowed_hosts`, `AllowedHosts`, or `allowedHosts`), and that
  `dashboard/v1/conformance.json` still carries the `foreign-host-rejection` scenario the verifier
  requires. The SDK hosts have no `publicOrigin` option. An embedder that authorizes by network
  position must set the allowed hosts or validate `Host` itself.
- Confirm the session cookie keeps its `__Host-` prefix, `HttpOnly`, `Secure`, and
  `SameSite=Strict`.
- Confirm the standalone listener states a Content Security Policy, `X-Content-Type-Options`,
  `Referrer-Policy`, `X-Frame-Options`, and `X-Robots-Tag` on every response. An embedded host
  owns its own response headers, because a second policy on the dashboard's responses would
  intersect with the application's; `typescript/dashboard-server/README.md` states the policy an
  embedder copies. An embedded SDK host sets no Content Security Policy and no nonce. The packaged
  document has two inline boot scripts, so the page policy of an embedder must allow them.
- Confirm `script-src` has no `'unsafe-inline'` in the standalone and the demo policies. Confirm
  each page gets a new nonce, that each inline script of the page carries it, and that the page
  policy names it. Confirm the built pages have no other inline script and no inline event handler.
- Confirm an embedder whose `authorize` accepts a request by network position sets `allowedHosts`
  or `publicOrigin`. Without both, a rebound host name passes the Origin check.

**Re-walk when** the mount adds a header, when the Host check, the Origin check, the page policy,
or the mutation classifier changes, when the packaged document adds an inline script, when the cookie attributes change, or when the oRPC path matcher changes.

## Row 6: what the standalone credential mode enforces

Confirm the CLI's single-administrator mode is the boundary it claims to be.

- Confirm `WORKHORSE_DASHBOARD_PASSWORD_HASH` is a `scrypt-v1` hash and never a password, that
  each variable has a `_FILE` form, and that setting both forms is an error.
- Confirm `scrypt-v1` still uses `N=16384`. That cost is a deliberate choice, because the login
  throttle and the derivation limit slow online guessing. Do not report it as a finding.
  [Credentials](architecture/dashboard.md#credentials) records the decision.
- Confirm a partial credential configuration fails rather than serving unauthenticated.
- Confirm the unauthenticated development bypass is refused on any listener that is not loopback
  or a Unix socket, and that an authenticated remote listener requires an explicit HTTPS
  `publicOrigin`.
- Confirm the login endpoint rejects an oversized or malformed declared length before reading. If
  the request declares no length, confirm the endpoint counts stream bytes, retains no more than
  the bound, and cancels the stream when it crosses that bound. Confirm the endpoint also requires
  `application/x-www-form-urlencoded`, throttles failures in a fixed window, reserves throttle
  capacity before `scrypt` yields, and returns one generic failure for a wrong username and a wrong
  password alike.
- Confirm `loginThrottleKey` keys the failure window by `DashboardRequestContext.clientAddress`,
  and that `dashboardNodeMiddleware` fills it from the socket by default. Confirm the tracked-client
  table is bounded, and that `MAX_CONCURRENT_PASSWORD_HASHES` refuses a submission before it
  reserves anything.
  [ADR 0093](decisions/0093-key-single-admin-login-throttling-by-transport-peer.md) records this
  identity model.
- Confirm `forwardedClientAddress` reads `Forwarded` or `X-Forwarded-For` only when the socket peer
  matches `trustedProxies`, which is empty by default. Confirm it keeps the peer when both headers
  arrive or a `Forwarded` quoted string never closes, and takes the rightmost hop that is not a
  trusted proxy. Confirm `trustedProxyCheck`
  refuses a malformed entry, a `/0` prefix, and a range with host bits set, and that a Unix socket
  listener refuses a non-empty list.
  [ADR 0094](decisions/0094-read-the-login-throttle-client-through-trusted-proxies.md) records these
  rules.
- Confirm every RPC request body is bounded, whether or not it declares its length. The TypeScript
  server bounds it at 128 KiB before a procedure is matched. The Python, Ruby, and JVM hosts refuse
  a larger or malformed declared length with `413` before reading, and read at most one byte past
  2 MiB otherwise. The .NET host refuses a larger declared length with `413` before reading, and
  stops reading at 2 MiB otherwise. The Go and Rust hosts stop reading at 2 MiB and answer 400. An
  SDK host can refuse an unknown procedure before it reads the body.
- Confirm the Python, Rust, Ruby, JVM, and .NET hosts answer 400 for a request envelope that is
  not a JSON object, on each procedure. The Go host answers 400 for an array, a string, a number,
  or a boolean, and reads `null` as no input. The TypeScript server answers 400 for `null`, and
  reads an array or another scalar as no input. In those two hosts the input schema of the
  procedure then decides. The `tasks-envelope-not-an-object` conformance exchange holds the 400
  answer for an array on `tasks` in all seven hosts.
- Confirm sessions are server-side, bounded in count, bounded in lifetime, minted only at a
  successful login, and deleted at logout and at expiry.
- Confirm a rotated previous password and every session created with it end at the configured
  cutoff.

**Re-walk when** credential resolution, the login handler, the throttle key, the session store,
an SDK host's body reader, or the listener guards change. [ADR 0032](decisions/0032-keep-single-admin-authentication-process-local.md) owns
why this mode is process-local.

## Row 7: dependency advisories

Confirm the published npm closure carries no unresolved advisory, and that every remaining
advisory is either outside the closure or accepted with a reason and a review date.

- Run `pnpm npm:vuln`, which runs `pnpm audit --prod` and fails on any advisory
  `scripts/npm-advisory-acceptances.json` does not accept. A green run means every advisory in the
  tree already carries a written reason.
- Read that file rather than the raw audit. The reviewer's task is to judge the reasons, not to
  rediscover the advisories: confirm each entry still describes the tree, and that no entry accepts
  a path inside the published closure on grounds that have expired.
- For a path inside the closure, prefer a lockfile bump, then a declared-range bump. When the
  advisory is unreachable through Workhorse's own code, say why in the entry rather than leaving
  the row silent.

`python:vuln`, `go:vuln`, `rust:vuln`, `ruby:vuln`, `jvm:vuln`, and `dotnet:vuln` cover the other six
lines. The .NET scan has no acceptance list. This row covers npm.
[`docs/dependency-advisories.md`](dependency-advisories.md) owns the policy the seven commands share.

**Re-walk when** a published package gains a dependency, or when `pnpm npm:vuln` fails.

## Row 8: static asset serving

Confirm the asset route serves only packaged files.

- Confirm `createStaticAssetCache(...).serve` resolves its relative path, requires the result to
  stay under `assets/`, and refuses a traversal. A URL pathname is not percent-decoded before this
  check, which is what keeps an encoded traversal from becoming one.
- Confirm no reserved route segment can be shadowed by a workspace name.
- In an SDK host, confirm that an asset name is an exact key in the packaged archive map, after
  the path decoding of the server, and that the host refuses a `..` segment. A host with one
  workspace has no reserved-name shadowing.

**Re-walk when** the asset route, the mount-path normalizer, or the reserved-name set changes.

## Row 9: served document and runtime configuration

Confirm the host treats the served HTML document as a security boundary. `renderDashboardHtml`
serializes `DashboardRuntimeConfig` with `JSON.stringify`, escapes every `<` in the serialized
value as `\u003c`, and substitutes it into the script placeholder through a callback. Host-owned
browser module URLs are HTML-attribute escaped, and their tags are also substituted through a
callback. Dollar patterns in either value remain data rather than replacement syntax. The packaged
document therefore cannot be closed by caller-shaped runtime values, and a module URL cannot add
attributes or markup.

Any exploitable walkthrough remains in the private operations review under
`docs/reviews/2026-09-22-dashboard-server/`; this public row records the review outcome and fix.

- Confirm both the production host and development transform call `renderDashboardHtml` rather than
  implementing their own replacements.
- Confirm both placeholders occur in `dashboard/app/browser/index.html`. Confirm
  `typescript/dashboard-server/test/html.test.ts` exercises that packaged template with
  caller-shaped values containing script delimiters, replacement markers, and attribute
  metacharacters.
- Confirm the Python, Go, Rust, Ruby, JVM, and .NET hosts, which write the runtime configuration
  themselves, escape every `<` in it. A principal's actor is caller-shaped. Each host's tests render
  an actor containing `</script>` and assert that the serialized value cannot close its script
  element.
- Confirm each host inserts both values as literal text. The JVM uses `Matcher.quoteReplacement`,
  Ruby uses a replacement block, and Go, Python, Rust, and .NET use literal replacement. Confirm each
  host's tests render the packaged template with `</script>`, dollar replacement markers, and the
  attribute characters of a module URL.

**Re-walk when** `DashboardRuntimeConfig` gains a field, `renderDashboardHtml` changes its
serialization, escaping, or placeholder replacement, the packaged `index.html` changes either
placeholder, or a host adds another caller-shaped value to the document.

---

The precise current behavior of every identifier named here lives in
[`architecture.md`](architecture.md).
