# ADR 0112: Define the poll wait order and the worker interval range

- **Status:** Accepted
- **Date:** 2026-10-23
- **Related:** [ADR 0011](0011-daily-retention-and-split-maintenance.md),
  [ADR 0017](0017-durable-worker-registry.md),
  [ADR 0072](0072-converge-the-worker-runtime-defaults.md)
- **Issue:** SM-1668 (PAR-09), SM-1778 (amendment)

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

## Amendment: one explicit poll interval range (2026-10-25)

The decision above left the explicit poll interval with a range of its own in each SDK. TypeScript
accepted `pollMs: 0` and waited 1 ms. Go read zero as the default and accepted a value below 1 ms.
Rust did not check `poll_interval`, so a value near `Duration::MAX` could overflow the jitter or the
`Instant` arithmetic of the wait. Python and Ruby had no upper limit. SM-1778 records this
amendment, and the maintainer chose the rule on 2026-10-25.

1. Every SDK accepts an explicit poll interval from 1 through 2,147,483,647 ms. The upper limit is
   the PostgreSQL `integer` maximum, so the worker can write the value to `worker_registry.poll_ms`.
   Each SDK refuses another value at construction with its usual argument error.
2. TypeScript, Python, Ruby, Rust, the JVM, and .NET refuse zero. An unset option (`undefined`,
   `None`, `nil`, or `null`) keeps the default.
3. Go reads a zero `PollInterval` as the default, because it cannot tell zero from an unset option.
   Go refuses a negative value.
4. Go and Rust refuse a value that is not a whole number of milliseconds, as they do for the other
   intervals. Ruby, the JVM, and .NET round to the nearest millisecond before the check.

Rejected options:

- Zero as a 1 ms wait in every SDK. It hides a configuration mistake, and Go cannot follow it.
- Zero as the default in every SDK. An existing TypeScript `pollMs: 0` would change from 1 ms to
  250 ms without an error. The other SDKs already have a separate way to say "not set".

Consequences:

- TypeScript `pollMs: 0` fails at construction. `pollMs: 1` gives the same wait.
- Rust refuses zero and a value that is not a whole number of milliseconds. Go refuses a nonzero
  value that is not a whole number of milliseconds. Go, Rust, Python, and Ruby refuse a value above
  2,147,483,647 ms. Each SDK changelog states the change.
- The JVM and .NET do not change.
- Each SDK has focused cases for zero, 1 ms, the limit, and one above it.
