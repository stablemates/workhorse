# ADR 0112: Define the poll wait order and the worker interval range

- **Status:** Accepted
- **Date:** 2026-10-23
- **Related:** [ADR 0011](0011-daily-retention-and-split-maintenance.md),
  [ADR 0017](0017-durable-worker-registry.md),
  [ADR 0072](0072-converge-the-worker-runtime-defaults.md)
- **Issue:** SM-1668 (PAR-09)

## Context

ADR 0072 gives the seven SDK workers the same defaults: a 5,000 ms claim poll while the `LISTEN`
subscription is live, a 250 ms poll that doubles toward 5,000 ms without one, a 1,000 ms
maintenance tick, a 60,000 ms routine offer, and a 5,000 ms registry refresh. It does not state
what happens when a caller sets one of these values.

A project review of 2026-10-22 found two differences:

- **Poll wait.** All seven SDKs take the base, double it for each empty claim while no
  subscription is live, cap it at 5,000 ms, and then apply ±10% jitter. TypeScript also capped an
  explicit `pollMs` while the subscription was live. The other six SDKs waited the explicit value.
  Thus an explicit poll of 30 s waited about 5 s in TypeScript and about 30 s elsewhere.
- **Interval range.** `register_worker_v1` takes the maintenance, routine, and registry intervals
  as PostgreSQL `integer` values, and the `worker_registry` checks refuse a value below 100 ms.
  TypeScript, the JVM, and .NET accepted 100 through 2,147,483,647 ms. Go and Rust accepted a tick
  or routine interval from 1 ms. They ran at that cadence, but they wrote 100 ms to the registry,
  and the expired-lease scan spacing read that value. Python, Go, Rust, and Ruby had no upper
  limit. Above 2,147,483,647 ms, each registration failed in Python, Go, and Ruby, and Rust wrote
  2,147,483,647 ms.

## Decision

**The poll wait has one order in every SDK.**

1. The base is the explicit poll interval. Without one, the base is 5,000 ms with a live
   subscription and 250 ms without one.
2. With a live subscription, a notification wakes the worker. The wait is the base, without
   backoff and without the cap. Thus an explicit poll interval is the caller's fallback interval.
3. Without a live subscription, the base doubles for each empty claim after the first, and the
   result is capped at 5,000 ms. The cap also applies to an explicit poll interval.
4. The ±10% jitter applies after the cap, and the wait is at least 1 ms.
5. An SDK that refreshes the registry from its dispatch loop cuts the jittered wait to the registry
   interval while registration is on. Python, Ruby, the JVM, and .NET do this. TypeScript, Go, and
   Rust refresh on their own timers. The TypeScript worker also bounds the wait at the Node timer
   maximum, 2,147,483,647 ms.

**The maintenance tick, the routine offer, and the registry refresh intervals accept 100 through
2,147,483,647 ms in every SDK.** Each SDK refuses another value at construction with its usual
argument error. The duration SDKs check whole milliseconds as they do today. Each SDK keeps its
way to turn registration off: `registryIntervalMs: 0` in TypeScript, `registry_interval_ms=0` in
Python, and a separate flag in Go, Rust, Ruby, the JVM, and .NET. Go reads a zero duration as the
default, because it cannot tell zero from an unset option.

The poll interval range and the shutdown grace range stay as they are. `docs/parity.md` states
them for each SDK.

## Consequences

- TypeScript waits an explicit `pollMs` above 5,000 ms while its subscription is live. A caller
  who set a long `pollMs` to send fewer idle claims now gets that interval.
- Go and Rust refuse a tick or routine interval below 100 ms. Python, Go, Rust, and Ruby refuse an
  interval above 2,147,483,647 ms. A caller who passed such a value gets an error at construction.
  Each SDK changelog states the change.
- The registry row records the interval that the worker uses, so the expired-lease scan spacing
  reads the real cadence.
- Each SDK has focused cases for the poll wait order and for 99 ms, 100 ms, the limit, and one
  above it.
- The SQL functions do not change.
