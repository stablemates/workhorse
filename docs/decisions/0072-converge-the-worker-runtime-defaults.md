# ADR 0072: Converge the worker runtime defaults across the three SDKs

- **Status:** Accepted
- **Date:** 2026-09-20
- **Related:** [ADR 0011](0011-daily-retention-and-split-maintenance.md), [ADR 0054](0054-define-what-1-0-0-promises.md)

## Context

[SM-817](https://linear.app/stablemates/issue/SM-817) added a runtime-defaults table to
`docs/parity.md` and bound every published value to the source line that sets it. The table made
visible what the capability rows could not: three SDKs agreed on every capability and still polled,
offered maintenance, and shut down differently when a caller configured nothing.

The capability tables answer whether a language can do something. Nothing answered what a language
does by default, so each divergence entered the same way. Someone tuned one SDK, the other two kept
their own numbers, and no artifact compared them. An operator running two languages learned the
difference from an incident.

Two of the divergences were defects rather than preferences.

- Python and Go offered the slow retention routines on every one-second tick. ADR 0011 decided that
  workers poll routine eligibility every minute, because PostgreSQL owns the global due decision.
  Only TypeScript kept that cadence, so the other two sent sixty times the intended rate of
  `run_maintenance` calls per worker.
- Go's shutdown grace period had no outcome. It cancelled the handlers that outlived it and then
  waited without a second deadline, so a handler that ignored its context blocked `Worker.Run`
  forever and the platform reached `SIGKILL` first.

Go's 30 second grace was also the value most likely to be cut off mid-drain, because it equals the
default `terminationGracePeriodSeconds` of a Kubernetes pod.

## Decision

**A runtime default differs between the SDKs only where the host language forces it.** Where a
language forces a difference, `docs/parity.md` names it and this record explains it. Every other
row publishes one value.

The four divergent rows resolve as follows.

1. **Claim poll interval.** All three wait the 5000 ms ceiling between empty claims while a `LISTEN`
   subscription is live, and start at 250 ms with exponential backoff toward that ceiling when they
   cannot subscribe. Go moves to both. Its previous flat 1000 ms sent five times the idle claim
   traffic in the deployment shape most installations run.
2. **Maintenance routine offer interval.** All three offer the slow routines every 60000 ms, which
   restores ADR 0011. Python and Go gain the option that gates it.
3. **Shutdown grace.** All three bound the drain at 25000 ms.
4. **Handler retry delay override.** All three carry it, unset by default. Python and Go gain the
   worker option; PostgreSQL already accepted the parameter through `fail_v1`.

**The action after the shutdown deadline is the one accepted exception.** A TypeScript or Python
worker owns a process and ends it. A Go `Worker` runs inside a caller's process, so it cancels the
handlers that outlive the deadline, gives them one bounded window to unwind, stops renewing the
leases of whatever still runs, and returns `ErrShutdownIncomplete`. The caller decides whether to
exit.

Each SDK asserts its own resolved defaults in a test, so a published value cannot outlive the
behavior it describes. The registry in `typescript/core/test/support/parity-capabilities.ts` keeps
binding each published cell to the source line that sets it.

## Consequences

### Positive

- An operator running two languages reads one number per setting and can compare incidents.
- Python and Go stop sending sixty `run_maintenance` calls a minute per worker, and Go stops
  sending a claim a second per worker while its subscription is healthy.
- `Worker.Run` always returns. A handler that ignores cancellation no longer holds a Go process
  open until the platform kills it.
- A Go or Python caller can shape one attempt's retry delay without persisting a policy.

### Negative

- Go's defaults change under a caller that set none, which a public beta minor release allows. A Go
  worker that relied on a 30 second grace now has 25. A changelog here records releases only, so
  the release that ships this must say so in `go/CHANGELOG.md`: the claim intervals, the routine
  cadence, the shutdown grace, and `ErrShutdownIncomplete`. `python/CHANGELOG.md` must name the
  routine cadence and `retry_delay_ms`.
- `ErrShutdownIncomplete` returns while abandoned goroutines still run. They may still use the
  pool, so a caller that receives it should end the process rather than close the pool and carry
  on. The doc comment says so.
- Three independent default assertions could drift apart while each stays internally consistent.
  The generated table is what catches that: a value that moves without the document moving fails
  `pnpm parity:check`.

## Rejected alternatives

### Ship a Go worker process runner

`typescript/core/src/worker-process.ts` and `python/src/workhorse/worker_process.py` own a process,
trap `SIGINT` and `SIGTERM`, and exit at a deadline. A Go equivalent would converge the shutdown
action completely.

It was rejected. A Go caller already writes `signal.NotifyContext` and `worker.Run(ctx)`, which is
three idiomatic lines shown in `go/examples/dedicated-worker/main.go`, and the standard library
owns that pattern. A library that calls `os.Exit` inside someone else's server takes a decision
that is not its own. The two existing runners are not one surface either: only the TypeScript one
serves liveness and readiness probes. A third shape would add a governed surface to fix a
difference that the database cannot observe.

### Converge the claim poll interval on 1000 ms instead of 250 ms

This would move one number in Go instead of two, and reduce polling-only claim traffic further.

It was rejected because it regresses every TypeScript and Python deployment that cannot use
`LISTEN`, which is the common shape behind a connection pooler in transaction mode. The exposure it
would fix is bounded: the backoff reaches the shared 5000 ms ceiling within about eight seconds of
a queue draining, so the shorter base costs a handful of extra claims per drain.

### Keep the divergences and document them

`docs/parity.md` already described them accurately after SM-817.

It was rejected because a table of differences is a description, not a contract. The next
contributor reads it as permission and adds a fifth row. The rule above, plus a test per SDK, makes
the table a statement about what the SDKs promise.
