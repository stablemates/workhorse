# ADR 0029: Embed the dashboard through per-language backends

- **Status:** Accepted
- **Date:** 2026-08-15
- **Related:** [ADR 0018](0018-framework-neutral-dashboard-host.md), [ADR 0023](0023-language-sdks-and-http-boundaries.md), [ADR 0027](0027-keep-versioned-dashboard-views.md), [ADR 0028](0028-flat-per-language-repository-layout.md)
- **Supersedes in part:** the ADR 0023 clause "Python and Go do not embed or reimplement it"

## Context

ADR 0023 restricted Python and Go to the standalone dashboard because porting the dashboard and
its read model into every language would create operator products that drift independently. The
conditions behind that judgment have changed. The dashboard reads now go through the core-owned
versioned SQL views (ADR 0027), the operator mutations run through extracted shared controllers,
and the standalone deployment gained built-in authentication. The remaining language-specific
surface is small: serve the browser application, expose its RPC endpoints, and delegate identity
to the host.

Embedding matters to applications that already run an admin surface. An embedded dashboard shares
the host's origin and authentication and adds no separate service. JavaScript applications have
this today; ADR 0023 denied it to every other language.

## Decision

The React single-page application is the only dashboard frontend. It is built once, published as
a static bundle with documented mount-path conventions, and shipped by every language SDK.

A language SDK may embed the dashboard by implementing its backend against a versioned wire
specification, `dashboard/v1`, kept beside `protocol/v1` and enforced by HTTP-level conformance
fixtures. The committed specification artifact is the authority; the TypeScript server is the
first implementation bound by it, in the same way `sql/schema/current.sql` binds the migrations
that generate it. Backends do not reimplement the read model: reads stay on the versioned SQL
views, and mutations stay on the shared SQL functions, so a per-language backend is transport,
session handling, and delegation.

Drift, the reason ADR 0023 prohibited embedding, is answered by contract rather than prohibition:
a backend that passes the `dashboard/v1` conformance fixtures serves the same product.

Two prerequisites gate freezing the specification: the mutation list must be derived from one
source instead of hand-maintained, and every dashboard read — including signal and human-wait
listings — must go through the versioned read surface. The specification's transport and
generation mechanism is chosen when the specification is written.

The standalone dashboard remains the supported administration path for deployments that do not
embed, unchanged from ADR 0023.

## Consequences

- Every language can offer the embedding convenience JavaScript applications already have,
  without forking the operator UX.
- The dashboard package splits into the shared browser application and a TypeScript backend
  demoted to reference implementation (layout per ADR 0028).
- The private RPC transport stops being private once specified; changes to it become versioned
  contract changes with review, not silent regeneration.
- Python and Go embedded backends ship only when the shared conformance runner proves every
  procedure, error envelope, cross-origin rejection, and read-only mutation rejection.
