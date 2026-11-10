# ADR 0117: Let the shutdown cancellation decide the settlement in the unwind window

- **Status:** Accepted
- **Date:** 2026-11-10
- **Amends:** [ADR 0116](0116-give-back-a-task-at-the-end-of-the-shutdown-grace-in-every-sdk.md)
  (rule 4, a handler that fails in the unwind window)
- **Issues:** SM-1933, SM-1943

## Context

At the end of the shutdown grace, each worker cancels the handlers that still run. Each handler
then gets a 250 ms unwind window. Rule 4 of ADR 0116 says: "If a handler fails in the window, or
its result cannot be stored, the worker releases the task through `release_owned_v1`. The task
keeps its `current_attempt`."

**Example.** A deploy stops a worker. The worker cancels a handler at the end of the grace. The
cleanup of the handler then throws a timeout error in the unwind window.

An analysis of 2026-11-10 found that the seven SDKs settled that task in three ways:

- Go, TypeScript, and Python released the task, so the task kept its attempt.
- Rust released the task for a handler error. It failed the attempt through `fail_v1` for a result
  above `result_max_bytes` and for a result that its result contract refused.
- Ruby, the JVM, and .NET released the task only if the error was the shutdown cancellation itself.
  The JVM also released it for an I/O error that the drain interrupt caused. Each other error, and
  each result that the task could not store, went to `fail_v1`. Thus a task on its last attempt
  failed because its worker stopped.

The architecture page recorded the narrow rule of the three SDKs. ADR 0116 and `docs/parity.md`
recorded the wide rule.

A handler panic was a second difference. Rust failed the attempt with the panic. Go left the task
`active` until its lease expired, so lease recovery charged the attempt as `LeaseExpired`. No
attempt record then held the panic message or its stack (SM-1943).

## Decision

All seven SDKs follow the rule of ADR 0116, rule 4. The shutdown cancellation decides the
settlement, not the type of the error:

1. After the worker sends the shutdown cancellation, each handler failure releases the task through
   `release_owned_v1`. The task keeps its `current_attempt`.
2. After that cancellation, a result that the task cannot store also releases the task. This
   includes a result above `result_max_bytes`, a result that its result contract refuses, and a
   result that holds a NUL character. The next attempt meets the same check.
3. A handler that returns a value that the task can store completes the task, as before.

Two limits apply:

- The rule applies only after the cancellation. A failure that a handler returns before the worker
  sends the shutdown cancellation keeps its usual settlement. Each worker reads the cancellation
  when the handler returns, so a stop that comes later cannot change that settlement. A batch
  member reads it when the batch handler returns, before the worker writes the batch evidence. The
  member also keeps the failure of the batch handler, so the attempt record holds that error and
  not the cancellation.
- If the Go worker reads such a failure only after the deadline, `failAfterShutdown` writes it
  through `fail_v1` in the unwind window. The same applies to a value that the handler returned
  before the cancellation and that the task cannot store. Before this decision, Go wrote nothing,
  and lease recovery charged the attempt later as `LeaseExpired`.
- A handler panic in Go or Rust fails the attempt through the failure path, with
  `HandlerPanicError` in Go and `HandlerPanic` in Rust. A panic is a defect of the handler, not an
  answer to the cancellation. Go keeps the panic message and its stack in the attempt record. Rust
  keeps the message only, because `HandlerError::from_panic` captures no stack. Go writes that
  failure on the unwind context that `settleAfterShutdown` uses. The panic is the one exception to
  the release rule.

A handler that does not return in the window stays with lease recovery, as ADR 0116 says.

## Consequences

- A deploy does not charge an attempt to a task whose handler fails in the unwind window, in any
  SDK.
- Ruby, the JVM, and .NET no longer need a rule per language for "the shutdown cancellation". The
  JVM rules for an I/O error that the drain interrupt causes (SM-1889, SM-1890) are now cases of
  this rule, and the worker no longer reads the type or the message of that error.
- A handler that converts the cancellation into an error of its own no longer loses its attempt.
  A handler that fails for a real defect in the window also keeps its attempt. The next attempt
  runs the handler again.
- The JVM no longer has `interruptedIo` or the batch mark of SM-1890. The worker does not read the
  type or the message of an interrupted I/O error, because the cancellation decides.
- `protocol/v1/runtime.json` holds a `shutdown-cancellation` case for each of these results: the
  cancellation error, a value, an error of the handler's own, an oversized result, and a panic in
  Go and Rust. The fixtures no longer have a `drain` behavior. The TypeScript and Python runners
  call the abort of their process runner, so all seven runners test the unwind window. A fixture
  names each SDK that runs it in `shutdownBehavior`.
