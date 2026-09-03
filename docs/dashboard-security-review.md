# Dashboard server security review checklist

`@stablemates/workhorse-dashboard-server` is the only Workhorse component that serves HTTP to a
browser, and the only one with an authorization surface. This checklist is the review that runs
against it. It is committed so a later review reads rather than rediscovers, and so a reviewer can
say which rows they walked.

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
- For each mutation, confirm `typescript/dashboard-server/src/server/router.ts` refuses it when
  `context.operator.mode !== "writable"`, and refuses it when the controller that performs it is
  absent.
- Confirm `createDashboardHost` reaches `options.authorize` or `singleAdmin.authorize` before it
  dispatches any RPC, asset, or application request.
- Confirm the browser cannot choose its own attribution: `auditWithOccurredAt` must overwrite
  `audit.actor` with `context.authenticatedActor`.

**Re-walk when** a procedure is added, removed, or changes its `mutation` classification; when a
controller becomes optional or mandatory; or when the authorization call moves.

## Row 2: payload and result redaction in the read surface

Confirm redaction happens in PostgreSQL, as [ADR 0035](decisions/0035-redact-dashboard-payloads-in-the-read-surface.md)
decided, and not in a TypeScript caller that can forget.

- Confirm `workhorse.dashboard_job_v1` projects
  `workhorse.redact_top_level_keys_v1(payload, payload_redact_keys)` rather than `payload`.
- Confirm `workhorse.dashboard_job_outcome_v1` projects no `result` column, and that
  `workhorse.dashboard_job_result_v1` is the only way to read one.
- Confirm no dashboard read reaches a raw `workhorse.job` or `workhorse.job_outcome` column.

**Re-walk when** a `dashboard_*_v1` view or function changes its projection, or when a new read
reaches a payload, a result, or a handler-supplied value.

## Row 3: statement parameterization

Confirm every statement the server issues binds its values.

- Confirm `typescript/dashboard-server/src/server/read-model.ts` passes each read's arguments as a
  single bound `jsonb` parameter to a `workhorse.dashboard_*_v1` function.
- Confirm no call site interpolates a value into `sql` as text. The tag in
  `typescript/dashboard-server/src/server/sql.ts` splices only a nested `DashboardSql` fragment,
  and treats any other value as a bind parameter.
- Confirm no procedure input that admits an arbitrary object reaches the `sql` tag as a parameter.
  The tag identifies a fragment structurally, by `text` and `values`, so an object that carries
  those two keys would be spliced as SQL rather than bound.

**Re-walk when** a read stops using a versioned function, when the `sql` tag changes, or when a
procedure input gains a free-form object that a read consumes.

## Row 4: error and stack-trace leakage to the browser

Confirm an error body reveals nothing about container paths or package internals.

- Confirm an unexpected throw inside a procedure reaches the browser as oRPC's generic
  `INTERNAL_SERVER_ERROR`. oRPC's `toORPCError` keeps the original error as a non-serialized
  `cause`, so verify the version in `pnpm-lock.yaml` still does.
- Confirm every deliberate `ORPCError` message is one the maintainers wrote.
- Confirm every dashboard read that projects a persisted worker error honours
  `redactErrorStacks`. Both `jobDetail` and `eventDetail` project
  `workhorse.attempt_history.error`, and a host that withholds stacks from one has to withhold
  them from the other.
- Confirm the schema-compatibility `503` body carries only version information.

**Re-walk when** a read starts projecting a persisted error, when `redactErrorStacks` changes
shape, or when the oRPC major version moves.

## Row 5: CSRF, CORS, and browser response headers

Confirm a cross-origin page can neither read the dashboard nor drive a mutation through a
browser's ambient credentials.

- Confirm the host sends no `Access-Control-Allow-Origin` and no other CORS header, so no
  cross-origin page reads a response.
- Confirm `rejectCrossOriginMutation` refuses a mutation whose `Origin` is absent, unparseable, or
  a different origin. Absent must fail closed.
- Confirm `isDashboardMutation` classifies exactly the paths oRPC dispatches. oRPC matches the raw
  pathname against an exact tree of `encodeURIComponent`-encoded segments; the classifier joins
  the same segments after dropping empty ones. Any path the classifier reads more loosely than
  oRPC must be one oRPC refuses to dispatch.
- Confirm the session cookie keeps its `__Host-` prefix, `HttpOnly`, `Secure`, and
  `SameSite=Strict`.
- Confirm the standalone listener states a Content Security Policy, `X-Content-Type-Options`,
  `Referrer-Policy`, `X-Frame-Options`, and `X-Robots-Tag` on every response. An embedded host
  owns its own response headers, because a second policy on the dashboard's responses would
  intersect with the application's; `typescript/dashboard-server/README.md` states the policy an
  embedder copies.

**Re-walk when** the mount adds a header, when the Origin check or the mutation classifier
changes, when the cookie attributes change, or when the oRPC path matcher changes.

## Row 6: what the standalone credential mode enforces

Confirm the CLI's single-administrator mode is the boundary it claims to be.

- Confirm `WORKHORSE_DASHBOARD_PASSWORD_HASH` is a `scrypt-v1` hash and never a password, that
  each variable has a `_FILE` form, and that setting both forms is an error.
- Confirm a partial credential configuration fails rather than serving unauthenticated.
- Confirm the unauthenticated development bypass is refused on any listener that is not loopback
  or a Unix socket, and that an authenticated remote listener requires an explicit HTTPS
  `publicOrigin`.
- Confirm the login endpoint bounds its body, requires
  `application/x-www-form-urlencoded`, throttles failures in a fixed window, reserves throttle
  capacity before `scrypt` yields, and returns one generic failure for a wrong username and a
  wrong password alike.
- Confirm sessions are server-side, bounded in count, bounded in lifetime, minted only at a
  successful login, and deleted at logout and at expiry.
- Confirm a rotated previous password and every session created with it end at the configured
  cutoff.

**Re-walk when** credential resolution, the login handler, the session store, or the listener
guards change. [ADR 0032](decisions/0032-keep-single-admin-authentication-process-local.md) owns
why this mode is process-local.

## Row 7: dependency advisories

Confirm the published npm closure carries no unresolved High advisory, and that every remaining
advisory is either outside the closure or accepted with a reason.

- Run `pnpm audit --prod` and read every High and Critical.
- For each one, resolve its path to a package. A path through `site`, the root `vite`, or an
  example's dev dependency is outside the published closure; say so and move on.
- For a path inside the closure, prefer a lockfile bump. When the advisory is unreachable through
  Workhorse's own code, say why in the review record rather than leaving the row silent.

`python:vuln` and `go:vuln` cover the other two lines. This row covers npm.

**Re-walk when** a published package gains a dependency, or when `pnpm audit --prod` reports a new
High inside the closure.

## Row 8: static asset serving

Confirm the asset route serves only packaged files.

- Confirm `serveAsset` resolves its relative path, requires the result to stay under `assets/`,
  and refuses a traversal. A URL pathname is not percent-decoded before this check, which is what
  keeps an encoded traversal from becoming one.
- Confirm no reserved route segment can be shadowed by a workspace name.

**Re-walk when** the asset route, the mount-path normalizer, or the reserved-name set changes.

---

The precise current behavior of every identifier named here lives in
[`architecture.md`](architecture.md).
