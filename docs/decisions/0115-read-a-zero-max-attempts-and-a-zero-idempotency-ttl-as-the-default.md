# ADR 0115: Read a zero max attempts and a zero idempotency TTL as the default

- **Status:** Accepted
- **Date:** 2026-10-28
- **Related:** [ADR 0111](0111-define-one-retry-delay-override-range.md),
  [ADR 0114](0114-read-a-zero-execution-timeout-as-no-timeout.md)
- **Issue:** SM-1857

## Context

Two enqueue options have a default. The attempt limit sets how many attempts a task can use. Its
default is 25. The idempotency TTL sets how long PostgreSQL keeps an idempotency key. Its default
is 24 hours, 86,400,000 ms. A caller sets both in the enqueue options of each SDK. The attempt limit
also applies to a child task and to the task of a schedule.

PostgreSQL stores `max_attempts` as an integer from 1 through 100. `enqueue_many_v1` refuses an
idempotency `ttlMs` that is not an integer from 1 through 31,536,000,000.

A parity audit of 2026-10-28 found that the seven SDKs read an explicit 0 in different ways:

- Go, Rust, Ruby, the JVM, and .NET read 0 as the default for both options.
- Python refused an attempt limit of 0 before the enqueue statement. TypeScript sent 0 to
  PostgreSQL, so the enqueue failed.
- TypeScript and Python sent an idempotency TTL of 0 to PostgreSQL, so the enqueue failed.
- The Go options are `int` fields. Their zero value is the same as an omitted option, so Go cannot
  tell them apart.
- Ruby, the JVM, and .NET take the TTL as a duration. They round it to the nearest millisecond,
  half up, and then read 0 as the default. Thus a positive TTL below 0.5 ms selected the 24 hour
  default without a warning. Ruby also read a small negative value, such as -0.4 ms, as the
  default.
- TypeScript, Python, Go, and Rust sent an attempt limit above 100 to PostgreSQL. Ruby, the JVM,
  and .NET refused it before the statement that writes the task.

Thus one task definition got the default, a refusal, or a database error, depending on the SDK
that enqueued it.

## Decision

**An explicit 0 selects the default in every SDK. A value that is not 0 must be in the range of the
option.**

1. An omitted attempt limit and an explicit 0 both give 25 attempts. This applies to an enqueue, a
   child task, and the task of a schedule.
2. Every SDK refuses an attempt limit outside 1 through 100, other than 0, with the usual argument
   error of the SDK. The refusal comes before the statement that writes the task.
3. An omitted idempotency TTL and an explicit 0 both give a TTL of 86,400,000 ms.
4. TypeScript, Python, Go, and Rust take the TTL in integer milliseconds. They send any other value
   to PostgreSQL, which refuses a fraction or a value outside 1 through 31,536,000,000 ms.
5. Ruby, the JVM, and .NET take the TTL as a duration. They round it to the nearest millisecond,
   half up, as ADR 0111 does for a retry delay. A duration that is not 0 and rounds to 0 ms is
   refused, also a negative one. Thus 0.4 ms is refused, and 0.5 ms becomes 1 ms.

The rule follows the Go reading, because Go cannot tell 0 from an omitted option. The refusal of a
sub-millisecond TTL follows ADR 0114. A sub-millisecond TTL is almost always a unit mistake, for
example milliseconds passed to a Ruby option that takes seconds. A refusal shows that mistake. A
silent 24 hour TTL hides it.

## Consequences

- TypeScript and Python accept an attempt limit of 0 and enqueue a task with 25 attempts. Before
  this change, TypeScript got a database error and Python refused the value.
- TypeScript and Python accept an idempotency TTL of 0 and keep the key for 24 hours. Before this
  change, PostgreSQL refused the enqueue.
- TypeScript, Python, Go, and Rust refuse an attempt limit above 100 before the statement that
  writes the task. Before this change, PostgreSQL refused it. TypeScript also refuses a negative
  value or a fraction there.
- Ruby, the JVM, and .NET refuse a nonzero TTL that rounds to 0 ms. Before this change, that TTL
  selected the default. Ruby also refuses a small negative value.
- Each changelog states its change.
- The shared request fixtures `zero-max-attempts-request` and `zero-idempotency-ttl-request` hold
  the two zero values. All seven SDKs run them.
- `docs/parity.md` publishes each rule as one row.
- The SQL functions do not change. A direct `enqueue_many_v1` call with 0 is still refused.
