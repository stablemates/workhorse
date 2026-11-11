# ADR 0120: Let a stop before a TypeScript worker call end the next call

- **Status:** Accepted
- **Date:** 2026-11-10
- **Amends:** [ADR 0078](0078-start-a-long-running-workers-first-claim-beside-its-startup-maintenance-pass.md)
  (rule 5, a run that is already stopping when it starts)
- **Issues:** SM-1970

## Context

A TypeScript `Worker` has three entry points. `run()` starts the long-running loop, `runOnce()` runs
one pass, and `stop()` ends the work. Rule 5 of ADR 0078 says: "A run that is already stopping when
it starts makes no maintenance offer." The rule did not say when a run is already stopping.

The two entry points read an earlier `stop()` in two ways:

- `run()` forgot a `stop()` that came before the call. The run registered, claimed, and ran until a
  later `stop()`.
- `runOnce()` read a flag that `stop()` set. After an earlier `stop()`, the pass claimed nothing and
  returned `false`. Only `run()` cleared the flag, so each later `runOnce()` also returned `false`.

**Example.** A supervisor builds a worker and calls
`process.once("SIGTERM", () => worker.stop())`. Then it waits for an asynchronous setup step.

1. SIGTERM arrives during the setup step, and `stop()` runs.
2. The supervisor calls `await worker.run()`.
3. The worker claims tasks and runs until the platform kills the process.
4. Lease recovery charges the attempt of each task that was in flight.

## Decision

One rule applies to `run()` and to `runOnce()`. A call is active from the time the caller makes it
until its promise settles. That time includes the wait for an earlier call to end.

1. **A stop when no call is active.** A `stop()` that comes when no call is active ends the next
   `run()` or `runOnce()` call at once. That call registers nothing, makes no maintenance offer, and
   claims nothing. `run()` resolves, and `runOnce()` resolves `false`.
2. **The stop is used up.** The call that rule 1 ends uses the stop. The call after it starts
   normally.
3. **A stop during a call.** A `stop()` that comes while a call is active ends each active call,
   also a call that still waits to start. It does not reach a call that the caller makes later.

Thus a run that is already stopping when it starts, as rule 5 of ADR 0078 says, is a run that rule 1
or rule 3 ends before its startup. Such a run makes no maintenance offer, as before.

The doc comments of `run`, `runOnce`, and `stop`, and `docs/guides/310-workers.md`, state the rule.

## Consequences

- The supervisor of the example ends at step 2. Its `run()` resolves at once, and no attempt is in
  flight when the process ends.
- A `runOnce()` after a stopped run or a stopped pass starts normally. Before this decision, each
  later `runOnce()` returned `false` until a `run()` cleared the flag.
- A worker that a caller stops while it is idle and then never runs again keeps the unused stop. No
  call reads it.
- `runWorkerProcess` calls `stop()` only after it calls `run()` on each worker, so its behavior does
  not change.
- The rule is for TypeScript. The other six SDKs keep their own entry points. This record does not
  make the rule a parity rule.
