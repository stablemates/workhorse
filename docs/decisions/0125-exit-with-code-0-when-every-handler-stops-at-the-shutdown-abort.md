# ADR 0125: Exit with code 0 when every handler stops at the shutdown abort

- **Status:** Accepted
- **Date:** 2026-11-18
- **Amends:** [ADR 0116](0116-give-back-a-task-at-the-end-of-the-shutdown-grace-in-every-sdk.md)
  and [ADR 0012](0012-dedicated-worker-processes.md) (the exit code after a missed deadline in the
  TypeScript and Python process runners)
- **Issue:** SM-2073

## Context

At the end of the shutdown grace, `runWorkerProcess` aborts the signal of each handler that still
runs and waits one unwind window. Python's `run_worker_process` cancels the token of each handler
the same way. ADR 0116 kept the exit that came after that window: code 1 in both runners.

A worker that runs long tasks therefore exited with code 1 at almost every deploy. Its handlers
watched `context.signal` and stopped at a checkpoint. Each task was released or completed in the
window, and another worker claimed it again. Nothing was lost. The container still showed a failed
exit, and the logs showed an `error` line. An operator could not tell that case from a real failure.

The other SDKs already tell the two cases apart. Ruby's `run_worker_process` exits with code 0 when
every handler stopped in the window. A Go, Rust, Ruby, JVM, or .NET `Worker` reports
`ShutdownIncomplete` only for a handler that still runs after the window. Only the two process
runners turned a clean stop into a failed exit.

The SDKs did not agree on a completion or release write that fails in the window. The Ruby, Rust,
JVM, and .NET workers report that error from the stop. The TypeScript, Python, and Go workers only
logged it. Outside shutdown, a failed settlement write ends the run with an error in every SDK.

Each runner already knows which case it is in. In TypeScript, `completed` resolves only after every
worker drained and the adapter closed without an error. In Python, `_run_continuously` returns
without an error only after the drain.

## Decision

**After a signal shutdown, the TypeScript and Python process runners exit with code 0 if the drain
completes in the unwind window, and with code 1 otherwise.** Every SDK then calls the same stop
clean.

1. In TypeScript, the end of the grace logs at `info` after a signal. The runner then aborts the
   handlers and waits the window.
2. If `completed` resolves in the window, the TypeScript runner logs at `info` how many handlers it
   aborted and exits with code 0. If `_run_continuously` returns in the window, the Python runner
   calls `force_exit(0)`.
3. If the window ends first, or the drain ends with an error, the runner exits with code 1. The
   TypeScript runner logs at `error`.
4. A settlement write that runs after the abort and fails makes the stop fail in every SDK. This
   covers the completion, the release, and the failure write of a handler that panicked, or that
   failed before the abort and whose write the stop moved into the unwind window. A write that is
   already in flight when the abort cancels it stays part of the unwind. The TypeScript, Python,
   and Go workers give the error to the run, as the Ruby, Rust, JVM, and .NET workers already do.
   `Worker.run()` rejects in TypeScript and raises in Python, and Go `Run` returns the error. The
   runners then exit with code 1. A lost lease is not such an error. Lease recovery settles the
   task.
   - The Go worker logs `workhorse.worker.shutdown_settlement_failed` for each such write.
   - The TypeScript and Python workers log it for a failed completion after the abort, and for a
     failed release of a handler that stopped at the abort. A failure write that fails ends the run
     without that record, as it does outside shutdown.
5. A shutdown that a worker failure started exits with code 1, also when every handler stops in the
   window.
6. A second signal keeps code 130 or 143. An unwind window that ends after it calls no second exit.
7. If the grace ends during startup, the TypeScript runner waits for the startup and then the drain
   in the same window, and aborts the handlers of the runtime once it exists.
8. `completed` includes the adapter close. An adapter that closes slower than the window thus exits
   with code 1 in TypeScript, as before, even if every handler stopped.

## Consequences

- A deploy that cuts a long task short exits with code 0 when the handler honours the abort signal.
  A supervisor restarts the container only for a real failure.
- An exit with code 1 now means a handler did not stop in time, the drain failed, or a worker
  failed. A handler that ignores the signal still exits with code 1, and lease recovery still
  settles its task.
- A failed completion or release write in the window gives code 1. The task then waits for lease
  recovery and is charged an attempt, so the stop was not clean.
- Go `Run` now returns an error that it only logged before. A caller that exits on that error now
  fails the stop, as it does for the same write outside shutdown.

Rejected options:

- Exit with code 0 after every missed deadline. A handler that ignored the abort would hide behind
  a clean exit, and lease recovery would charge its attempt later.
- Keep a failed write after the abort as a log record only. Then three SDKs would call a stop clean
  that four SDKs call failed, and the same write outside shutdown would still end the run.
- Add a `warn` level to `WorkerProcessLogger`. That changes a public interface for one line, and
  `info` already separates the clean case from `error`.
