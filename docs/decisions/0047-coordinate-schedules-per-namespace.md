# ADR 0047: Coordinate schedule evaluation per namespace

- **Status:** Accepted
- **Date:** 2026-08-26
- **Amends:** [ADR 0003](0003-worker-owned-scheduler.md), [ADR 0025](0025-worker-schedule-cadence.md)

## Context

Workers can offer different schedule namespace sets. Schedule evaluation still depended on the
global `tick_v1` advisory-lock winner, so a live worker could not evaluate its namespaces when a
worker with another set won the tick. The worker registry and dashboard now expose namespace
availability, which makes that coupling both visible and incorrect.

## Decision

Every worker calls `fire_due_schedules_v1` for its configured namespaces on its maintenance cadence,
whether or not it owns the `tick_v1` lock. PostgreSQL takes a transaction advisory lock for each
namespace before it evaluates definitions. Workers that offer the same namespace compete for that
lock, while workers that offer different namespaces progress independently. The durable occurrence
key remains the final duplicate barrier.

## Consequences

A namespace can make progress while any worker offering it remains live. Fleets may split namespace
ownership without relying on fairness from the global maintenance lock. Each worker still offers one
bounded scheduling query per cadence, and PostgreSQL skips duplicate namespace evaluation before it
calculates occurrences.
