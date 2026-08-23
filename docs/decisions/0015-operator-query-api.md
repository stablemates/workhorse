# ADR 0015: Dedicated operator query projection and bounded history reads

- **Status:** Accepted
- **Date:** 2026-08-03
- **Related:** [ADR 0001](0001-live-runtime-cold-outcome.md), [ADR 0011](0011-daily-retention-and-split-maintenance.md), [ADR 0014](0014-dead-letter-redrive.md)

## Context

Workhorse has authoritative point lookup, dashboard-specific SQL, and a failure-only dead-letter inbox, but no stable public contract for listing jobs across live and terminal states. Reading `job_runtime` and `job_outcome` directly would either couple operator traffic to dispatch relations or require a union whose pagination key can move while a job runs. Fetching payloads before selecting a bounded page can also detoast arbitrarily large values and disclose fields an operator surface does not need.

Lifecycle history is split between append-only `job_event` and `attempt_history` partitions. Operators need one ordered timeline, but retention can remove either history class independently and no cross-page snapshot protocol exists yet.

## Decision

Workhorse maintains a dedicated `job_query` projection in the same PostgreSQL transactions that create or change lifecycle state. The projection contains only bounded routing and lifecycle metadata. It does not contain payload, result, error, checkpoints, waits, or worker heartbeat fields. Runtime and outcome triggers update it for meaningful lifecycle transitions and cancellation requests; heartbeats do not churn it.

`list_jobs_v1` reads only this operator projection to select a bounded candidate page and joins immutable `job` rows afterward. Dedicated global, queue, type, and state creation-time indexes serve these reads. Claim, promotion, recovery, deadline, and timeout indexes remain unchanged and are not operator query paths.

Pages are ordered descending by immutable `(created_at, job_id)`. The cursor contains the exact PostgreSQL timestamp text, job identity, and a PostgreSQL-generated signature bound to the normalized filter and payload projection. Reusing a cursor with different filters or projection controls is rejected. Pagination is intentionally weakly consistent: jobs accepted after the first page may appear before its boundary, while concurrent state changes can make a row enter or leave a later filtered page. Snapshot pagination remains deferred to P0-06.

Listing filters are bounded to exact queue, exact type, lifecycle states, and a half-open creation-time range. Page size is capped at 1,000.

Payloads are omitted by default. A caller may request payload inclusion with a byte ceiling from 1 through 1,048,576 and at most 50 unique top-level redaction keys. PostgreSQL applies redaction before measuring and returning the value. A projected payload is classified as `included`, `too_large`, or `omitted`; oversized or unrequested values remain null. Candidate IDs are selected before the payload join, so only a bounded page can touch payload storage. These controls bound response disclosure and size, not stored payload size or detoasting cost for a requested page.

`list_job_timeline_v1` merges retained events and closed attempts into one latest-first cursor stream. The stable key is `(occurred_at, kind rank, record id)`. Timeline pages are also weakly consistent rather than a cross-call snapshot: concurrently appended or retired history can appear before the cursor boundary or disappear from later pages. Event details and attempt errors remain operator data and are not covered by payload redaction. Page size is capped at 1,000. An empty timeline can mean the job is unknown or its history has been retired; callers that need identity existence use `getJob` separately.

## Consequences

### Positive

- Operator pagination never scans or expands dispatch indexes.
- Immutable creation-time cursors avoid duplicates caused by heartbeat or state-update timestamps.
- Filter-bound cursors fail closed when accidentally reused with another query.
- Payload omission is the default, with server-side redaction and explicit byte bounds.
- Events and attempts share one deterministic public timeline contract.
- Dashboard, CLI, and future integrations can converge on one core read API.

### Negative

- Every meaningful lifecycle transition performs an additional projection write.
- Four operator indexes consume storage and add acceptance/transition maintenance cost.
- Requested payload projection still has to detoast and inspect each selected value.
- The page cap bounds returned rows and payload work, but metadata scan and sort work still depends on filter selectivity; broad operator queries remain isolated to `job_query` rather than claiming a constant database-work bound.
- Cross-page results are not a database snapshot and may reflect concurrent state changes.
- Retention can leave a known job with an empty or partial timeline.
- Schema version 15 remains a preproduction clean-install contract. Existing version 14 databases are rejected rather than upgraded in place.

## Rejected alternatives

### Query runtime and outcome directly

This mixes operator traffic with hot lifecycle relations, makes global ordering depend on mutable timestamps, and encourages adding broad indexes to dispatch tables.

### Store payload in the query projection

That duplicates potentially large immutable values, increases write and storage amplification, and makes omission or redaction easier to bypass accidentally.

### Redact only in TypeScript

The full payload would already have crossed the database boundary. PostgreSQL must apply omission, redaction, and byte classification before returning rows.

### Promise snapshot-consistent cursor pages

The current API does not hold a transaction or export a PostgreSQL snapshot across calls. Claiming snapshot consistency would be false until P0-06 defines the transaction and lifetime contract.

## Validation

Acceptance requires live PostgreSQL coverage for projection convergence, lifecycle transitions without heartbeat churn, every filter, same-timestamp cursor boundaries, exact final-page cursor behavior, filter/projection-bound cursor rejection, payload omission/redaction/size classification, scalar and array payloads, operator index plans, and merged event/attempt timelines including equal timestamps and retention gaps. A focused operational scenario must record page, payload, timeline, and projection/index evidence. Formatting, lint, typechecking, unit, integration, packed-package, and committed clean-checkout demo gates must pass before P2-01 is marked complete.
