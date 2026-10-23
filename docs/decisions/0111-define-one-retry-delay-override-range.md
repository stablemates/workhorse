# ADR 0111: Define one retry delay override range

- **Status:** Accepted
- **Date:** 2026-10-23
- **Related:** [ADR 0008](0008-persisted-retry-policies.md),
  [ADR 0072](0072-converge-the-worker-runtime-defaults.md)
- **Issue:** SM-1668 (PAR-06), after SM-1654 and SM-1669 (TS-03)

## Context

Each SDK worker has a retry delay override. It replaces the delay that the persisted retry policy
chooses for one failed attempt. ADR 0072 requires the override in every SDK, and ADR 0008 gives it
precedence over the policy. Neither record states which values the override accepts.

The worker sends the override to `fail_v1` as a PostgreSQL `integer`. `fail_v1` reads `-1` as the
terminal sentinel of a durable replay conflict. `retry_delay_v1` changes any other negative value
to 0.

A project review of 2026-10-22 found that the seven SDKs check the value in different ways:

- TypeScript and the JVM refuse a value outside 0 through 2,147,483,647 ms before `fail_v1`.
  SM-1654 added the TypeScript constructor check, and SM-1669 (TS-03) documents the callback check.
- Rust and .NET clamp a large value to 2,147,483,647 ms. .NET also clamps a negative value to 0.
- Go changes a negative value to "no override", so the policy applies. Go and Python do not check
  the upper limit, and the `fail_v1` write fails.
- Go and Rust truncate a fraction of a millisecond. .NET rounds it to even. The JVM rounds it half
  up. Ruby rounds half up after it converts the value to a Float, so an exact `Rational` of 500.5 ms
  becomes 500 ms. Ruby also accepts a negative value that rounds to 0.

Thus one callback can give a different retry time, or a different failure, in each SDK.

## Decision

**All seven SDKs accept one range and refuse every value outside it.**

1. An absent override (`undefined`, `None`, `nil`, or `null`) uses the persisted retry policy.
2. The accepted range is 0 through 2,147,483,647 ms, the PostgreSQL `integer` maximum. Zero is
   accepted and retries the task at once.
3. A negative value is refused, also a value that rounds to 0.
4. TypeScript and Python take integer milliseconds and refuse any other number. Go, Rust, Ruby,
   the JVM, and .NET take a duration. They round it to the nearest millisecond, half up, and then
   check the range. Thus 2,147,483,647.4 ms is accepted as the limit, and 2,147,483,647.5 ms is
   refused.
5. A fixed value is refused at construction. TypeScript, Python, and Ruby accept a fixed value.
   A callback result is refused after the callback returns and before `fail_v1`, so the failure
   write does not occur.
6. No SDK clamps a value.

After a refusal, each SDK raises its usual argument error. The error leaves the failure settlement
on the same path as a failed `fail_v1` write.

## Consequences

- Go now refuses a negative duration instead of using the policy. Go, Rust, and .NET refuse a
  value above the limit instead of failing the write or clamping. Go and Rust round instead of
  truncating, and .NET rounds half up instead of to even. Python refuses a value above the limit
  before `fail_v1`, and it checks a fixed value at construction. Ruby refuses a small negative
  value, and it converts Integer, Rational, and BigDecimal seconds exactly. Each SDK changelog
  states its change.
- A jitter function that computes a duration does not need to round it first.
- `docs/parity.md` publishes the range as one row, and each SDK has focused cases for the limit,
  one above it, a negative value, zero, and a fractional millisecond.
- The SQL functions do not change. `retry_delay_v1` still changes a negative override to 0 for
  callers outside the SDK workers, such as a direct `fail_v1` call.
