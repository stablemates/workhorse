# ADR 0099: Report a released-only single pass as no progress

- **Status:** Accepted
- **Date:** 2026-10-12
- **Related:** [ADR 0072](0072-converge-the-worker-runtime-defaults.md),
  [ADR 0076](0076-keep-overlapping-batched-claims-in-flight-to-fill-worker-slots.md)
- **Issue:** SM-1259. SM-1247 gave the continuous loop its release wait.

## Context

The single-pass call is TypeScript `runOnce()`, Python `run_once()`, Go `Worker.RunOnce`, Rust
`Worker::run_once`, and Ruby `run_once`. It returns a boolean. A caller can call it in a loop, for
example in a test or a script.

A worker can claim a task that it has no handler for. The worker then releases the task through
`release_owned_v1`, and the task is `ready` again. Before this ADR, the SDKs did not report a pass
that released every task that it claimed in the same way:

| SDK                        | Result of the released-only pass | Next call                                              |
| -------------------------- | -------------------------------- | ------------------------------------------------------ |
| TypeScript                 | `true`                           | Returns `false` without a claim until `pollMs` elapses |
| Python, Go, Rust, and Ruby | `false`                          | Claims again at once                                   |

Thus a caller that loops on the single-pass call got a different result and a different wait in
each SDK. SM-1247 gave the continuous loop one bound, the release wait. That wait needs the state of
the loop, and the single-pass call keeps no loop.

## Decision

If a single-pass call released every task that it claimed, the call returns `false` in all five
SDKs. The call returns `true` only if a handler ran.

The worker keeps no state between single-pass calls for this case. The next call claims at once. If
the task is first in its queue, the worker claims it and releases it again.

The `false` result is the wait rule. A caller that loops on the single-pass call must wait after
`false`, as it does after a pass that claimed no task.

Only TypeScript changes. `runOnce()` no longer keeps `previousPassWorked` and `lastClaimAt`, and it
no longer declines to claim inside `pollMs`. That check also applied after a pass that claimed no
task. It is removed for that case too, because Python, Go, Rust, and Ruby keep no state there
either.

## Consequences

- The result of the single-pass call means the same in all five SDKs: whether a handler ran.
- A TypeScript caller that calls `runOnce()` again at once after `false` claims again. Before, that
  call returned `false` without a claim inside `pollMs`. This applies after an empty pass and after
  a released-only pass. A loop that does not wait after `false`
  can claim and release a task that it cannot run many times each second.
- `pollMs` no longer changes the single-pass call. The worker still reports it to the worker
  registry, and the continuous loop uses it.
- The shared runtime fixture `missing-handler-releases-the-task-with-its-attempt-intact` checks both
  calls. The first call returns `false`. The second call also returns `false`, and it writes a
  second `released` event.

## Rejected alternatives

### The TypeScript gate in all five SDKs

Each worker would remember its last claim and decline to claim inside the poll interval after a
pass that made no progress. A loop that does not wait would then claim at most once in each poll
interval. But the single-pass call would keep state between calls, and a call could return `false`
without a claim. A test that enqueues a task after a released-only pass would then see `false` and
no claim. Four SDKs would change instead of one.

### `true` for a released-only pass

The pass did claim a task. But the caller cannot tell a pass that ran a handler from a pass that
only released. A loop that stops on `false` would then not stop while a task that it cannot run is
first in the queue.
