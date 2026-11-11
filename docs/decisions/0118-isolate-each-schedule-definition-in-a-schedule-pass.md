# ADR 0118: Isolate each schedule definition in a schedule pass

- **Status:** Accepted
- **Date:** 2026-11-10
- **Issues:** SM-1927, SM-1981

## Context

A worker that offers schedule namespaces calls `fire_due_schedules_v2` at each maintenance tick.
The function evaluates every definition of those namespaces in one statement, and each fire
enqueues its task through `enqueue_v1`.

**Example.** A namespace has two schedules. `invoice-run` has a concurrency key, and an operator
moves its queue to the fast tier. At the next tick, the enqueue of `invoice-run` raises SQLSTATE
`P1007`.

Before this decision, that one error rolled back the fires and the positions of every definition in
the pass. No schedule of the offered namespaces fired. The TypeScript and Go workers ended their
run, and after a restart they ended it again at the first pass. A `skip` schedule then lost each
occurrence that became older than the supported delay. A stored definition with a queue name above
256 UTF-8 bytes, which the enqueue refuses since migration 0094, failed each pass in the same way.
No health reason and no stored record showed which definition failed.

`tick_v1` already runs each of its phases in a subtransaction, and it reports a phase error as data.
The schedule pass had no such boundary.

## Decision

1. **Each definition runs in a subtransaction.** `fire_due_schedules_v2` evaluates and fires each
   definition inside its own `BEGIN ... EXCEPTION` block. If the block raises an error, its fires
   and its occurrence locks roll back, and the pass continues with the next definition. The
   function keeps its name, its arguments, and its result rows under ADR 0109.
2. **The pass stores the error on the definition row.** Three new nullable columns of
   `schedule_definition`, `last_error_at`, `last_error_code`, and `last_error_message`, hold the
   `now` of the failed pass, the SQLSTATE, and the error message, cut to 1,000 characters. The
   position and the skip record of the definition do not change, so the next pass evaluates the same
   occurrences. A later pass that moves the position sets the three columns to null. The error write
   runs outside the subtransaction, so it skips a row that another transaction locks and never waits.
   `dashboard_cron_v1` returns them as `lastErrorAt`, `lastErrorCode`, and `lastErrorMessage`. An
   operator can thus read the evidence with the schedule read that the dashboard and each SDK
   dashboard host already use. The health reason for a schedule whose last pass failed belongs to
   SM-1992, which reads these columns.
3. **Errors of SQLSTATE classes 40 and 57 end the pass.** A serialization failure, a deadlock, a
   cancel, a statement timeout, and a shutdown are not facts of one definition. The pass re-raises
   them, rolls back, and the worker reports the failure as ADR 0078 rule 4 states.
4. **The synchronization refuses what the queue cannot accept now.**
   `sync_schedule_definitions_internal_v1` refuses an enabled definition with a concurrency key
   when the queue has the fast tier, with the `P1007` error of the enqueue. A concurrency key is the
   only fast-tier feature that a definition can carry. A disabled definition never fires, so the
   synchronization accepts it. A tier change after the synchronization is still possible. Rule 1
   and rule 2 cover that case.
5. **The occurrence locks get a documented maximum, not a bound in the pass (SM-1981).** Each fired
   occurrence holds one advisory lock until the pass commits. A test pass with a catch-up limit of
   10 held 10 such locks, and one with 20 held 20. The shared lock table holds
   `max_locks_per_transaction` × the backend slots, and the default `max_locks_per_transaction` is 64. `docs/guides/220-schedules.md` states a safe maximum of 1,000 occurrence locks for one pass
   with the default settings, and it tells the operator to raise `max_locks_per_transaction` for
   more.

A bound in the pass was the other option: stop firing at a fixed number of locks, and let the next
pass continue. It keeps the signature, but it changes which definitions fire when a pass reaches the
bound. Definitions late in the namespace order then wait until an earlier `all` backlog drains, and
a `skip` definition that waits longer than the supported delay skips occurrences. A fair share of
the bound needs the demand of each definition before the first fire, which costs a second cron
evaluation in each pass. Rule 1 already limits the damage of a full lock table: the error
`out of shared memory` is SQLSTATE `53200`, so the definition that takes too many locks fails
alone, and its locks roll back.

## Consequences

- One definition that cannot enqueue no longer stops the other schedules or the worker run. Its
  error stays visible on its row and in the dashboard read until a pass fires it.
- A subtransaction that writes gets a transaction ID, and PostgreSQL caches 64 of these for each
  backend. The position update therefore runs outside the subtransaction, so a definition with no
  due occurrence uses no subtransaction ID. A pass that fires more than 64 definitions still
  overflows the cache while it runs, and other sessions then read `pg_subtrans` for their snapshots
  until the pass commits.
- The pass collects the rows of a definition and returns them only after its subtransaction ends,
  because PostgreSQL keeps a returned row after a rollback.
- A failed definition writes its row at each pass, as a successful pass writes the position.
- A deploy that synchronizes a concurrency key on a fast-tier queue now fails, before any row
  changes. The deployment must remove the key or disable the definition.
- The lock table remains a server limit. A pass with more occurrence locks than the table holds
  still fails lock requests of other sessions for the time of that pass.
