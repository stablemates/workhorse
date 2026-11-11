# ADR 0116: Give back a task at the end of the shutdown grace in every SDK

- **Status:** Accepted
- **Date:** 2026-11-05
- **Amends:** [ADR 0072](0072-converge-the-worker-runtime-defaults.md) (the action after the
  shutdown deadline)
- **Amended by:** [ADR 0117](0117-let-the-shutdown-cancellation-decide-the-settlement-in-the-unwind-window.md)
  (the shutdown cancellation, not the type of the error, decides rule 4; a panic fails the attempt)
- **Issue:** SM-1919

## Context

A deploy stops a worker while a long task runs. The shutdown grace is 25,000 ms, so a task that
runs for minutes does not finish in it.

Go, Rust, Ruby, the JVM, and .NET cancel the handlers at the end of the grace and give them a
250 ms window to unwind. If a handler fails in that window, the worker releases its task through
`release_owned_v1`, and the task keeps its attempt. If a handler returns a value, the worker
completes the task. Go `settleAfterShutdown` states the rule.

The TypeScript and Python process runners exited the process at the end of the grace. The handler
saw no cancellation. Its lease expired, and lease recovery charged the attempt as `lease_expired`.
If the task had no more attempts, it failed with `LeaseExpired`.

ADR 0072 called the action after the deadline "the one accepted exception", and `docs/parity.md`
said that PostgreSQL saw the same result either way. That was not correct. In the five other SDKs,
a handler that reacts to the cancellation keeps its attempt. In TypeScript and Python, every task
that still ran lost an attempt. An application that deploys often thus failed long tasks only
because of its deploys.

## Decision

At the end of the shutdown grace, all seven SDKs do the same thing to PostgreSQL:

1. The worker cancels each handler that still runs. In TypeScript and Python, the process runner
   sends that cancellation before the process exits. The heartbeat keeps the lease alive.
2. The handlers get a 250 ms window to unwind.
3. If a handler returns a value in the window, the worker completes the task.
4. If a handler fails in the window, or its result cannot be stored, the worker releases the task
   through `release_owned_v1`. The task keeps its `current_attempt`.
5. A task that still waits for its batch leaves the batch, and the worker releases it.

A handler that does not return in the window stays with lease recovery, as before.

What comes after the window still differs, and ADR 0072 keeps that part. A TypeScript or Python
process runner exits its process with code 1. A Go, Rust, Ruby, JVM, or .NET `Worker` abandons the
handlers that still run and returns its shutdown-incomplete error to the caller.

The TypeScript abort reason is a `WorkerShutdownError`, and the Python cancellation reason is a
`_WorkerShutdownError`. Neither SDK exports the class. A handler reads the abort signal or the
cancellation token, as it does for every other cancellation.

## Consequences

- A deploy no longer charges an attempt to a task whose handler reacts to the cancellation.
- A handler must still return in 250 ms. A handler that cannot stop at a safe point in that time
  loses its attempt, as before.
- The worker writes the completion or the release while the process runner waits. If the write
  fails, the worker logs `workhorse.worker.shutdown_settlement_failed`, and lease recovery settles
  the task.
- `docs/parity.md` states one shutdown behavior for PostgreSQL in all seven SDKs. The exit of the
  process is the only difference.
