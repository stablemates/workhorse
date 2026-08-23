# ADR 0037: Keep dashboard presentation policy in the SPA

- **Status:** Accepted
- **Date:** 2026-08-22
- **Builds on:** [ADR 0029](0029-embeddable-dashboard-backends.md)

## Context

The dashboard wire contract is implemented by each language backend, while the React application is shared.
The TypeScript backend still generated English health checks, settings recommendations, maintenance schedule descriptions, retention labels, storage groups, and retry labels.
It also capped activity groups, classified worker status, and ordered queues by a display risk score.

Porting those rules into every backend would make the same SPA behave differently by host language.
Backend-generated sentences would also prevent the SPA from changing wording or adding localization without changing the wire contract.

## Decision

Dashboard backends return machine-readable codes, measurements, timestamps, and persisted data.
The SPA owns every English sentence and display label derived from those values.

The activity legend cap, worker status ladder, and queue risk order are presentation decisions.
They change only which values the current view emphasizes, not the underlying queue state, so the SPA owns them too.
PostgreSQL remains authoritative for health severity, retention lag, maintenance eligibility, and every threshold that changes an operational verdict.

The version 1 wire contract returns raw health reasons, recommendation inputs, maintenance task state, numeric retry bounds, worker heartbeat timestamps, uncapped activity groups, and unsorted queue rows.
It does not return fabricated system schedule rows, recommendation summaries, health check sentences, retention labels, storage labels or groups, retry labels, worker display status, or queue display order.

## Consequences

Go, Python, TypeScript, and future backends can delegate the same raw read model without copying UI policy.
The shared SPA renders the same wording and ordering regardless of the backend language.

Presentation changes no longer require a wire revision when the underlying codes and measurements stay stable.
A change to health severity or another operational decision still belongs in PostgreSQL and its versioned protocol.

## Validation

The generated dashboard schema must contain no derived sentence fields from these policies.
SPA unit tests pin wording, grouping, schedule projection, worker classification, retry labels, and queue ordering.
Dashboard conformance fixtures pin the raw response shapes.
