# ADR 0114: Read a zero execution timeout as no timeout

- **Status:** Accepted
- **Date:** 2026-10-24
- **Related:** [ADR 0111](0111-define-one-retry-delay-override-range.md)
- **Issue:** SM-1714, from SM-1668 (PAR-20)

## Context

An execution timeout limits the active time of one attempt of a task. A caller sets it in the
enqueue options of each SDK. The same options also set it for a batch enqueue and for a child task.
The timeout is optional, and a task without one has no time limit. PostgreSQL stores
`execution_timeout_ms` as an integer from 1 through 31,536,000,000. `enqueue_many_v1` refuses a
fraction or a value outside that range.

A project review of 2026-10-22 found that the seven SDKs read an explicit 0 in different ways:

- TypeScript and Python sent 0 to PostgreSQL, so the enqueue failed.
- Go, Rust, Ruby, the JVM, and .NET sent no value, so the task had no timeout.
- The Go option is an `int`. Its zero value is the same as an omitted option, so Go cannot tell
  them apart.
- Ruby, the JVM, and .NET take a duration. They round it to the nearest millisecond, half up, and
  then read 0 as no timeout. Thus a positive value below 0.5 ms removed the timeout without a
  warning. Ruby also read a small negative value, such as -0.0004 s, as no timeout.

Thus one task definition got a timeout, no timeout, or a refusal, depending on the SDK that
enqueued it.

## Decision

**An explicit 0 means no timeout in every SDK. A value that is not 0 must round to 1 ms or more.**

1. An omitted timeout (`undefined`, `None`, `nil`, `null`, or the Go zero value) sends no value to
   PostgreSQL. The task has no timeout.
2. An explicit 0 is the same as an omitted timeout. The SDK sends no value to PostgreSQL. This
   matches Go, which cannot tell the two apart.
3. TypeScript, Python, Go, and Rust take integer milliseconds. They send any other value to
   PostgreSQL, which refuses a fraction or a value outside 1 through 31,536,000,000 ms.
4. Ruby, the JVM, and .NET take a duration. They round it to the nearest millisecond, half up, as
   ADR 0111 does for a retry delay. Then they check the range 1 through 31,536,000,000 ms before
   any statement.
5. A duration that is not 0 and rounds to 0 ms is refused with the usual argument error of the
   SDK. Thus 0.4 ms is refused, and 0.5 ms becomes 1 ms. A negative duration is refused, also one
   that rounds to 0.

The SDK refuses a duration below the precision and does not round it up to 1 ms. This follows ADR
0111, which refuses a negative retry delay that rounds to 0 and does not clamp it. A
sub-millisecond timeout is almost always a unit mistake, for example milliseconds passed to a Ruby
option that takes seconds. A refusal shows that mistake. A silent 1 ms timeout hides it, and every
attempt then times out.

## Consequences

- TypeScript and Python accept 0 and enqueue a task with no timeout. Before this change, PostgreSQL
  refused the enqueue. Each changelog states this behavior change.
- Ruby, the JVM, and .NET refuse a nonzero duration that rounds to 0 ms, which before this change
  removed the timeout. Ruby also refuses a small negative value. Each changelog states this change.
- Go and Rust do not change.
- The shared request fixtures `zero-execution-timeout-request`,
  `minimum-execution-timeout-request`, and `maximum-execution-timeout-request` hold 0, 1, and
  31,536,000,000 ms. All seven SDKs run them. Ruby, the JVM, and .NET also test a value that rounds
  to 0 ms.
- `docs/parity.md` publishes the rule as one row.
- The SQL functions do not change. A direct `enqueue_many_v1` call with 0 is still refused.
