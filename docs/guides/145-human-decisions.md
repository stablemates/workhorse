# How do I pause for a human decision?

Some jobs need a person to inspect context and decide what happens next. A human wait stores that
context, releases the worker lease, and gives the dashboard an actionable decision.

## The handler names the decision and explains it

Call `ctx.waitForHuman` with stable JSON context for the operator. Pass optional `timeoutMs` to
shorten how long PostgreSQL keeps the decision open. Workhorse parks the job without consuming its
logical attempt, so the worker can claim other work while the decision is pending.

The handler restarts from its entry point after completion. When replay reaches the same name and
context, `waitForHuman` returns the retained result.

```ts
const review = await ctx.waitForHuman<{ accountId: string; prompt: string }, { approved: boolean }>(
  "account-review",
  {
    accountId,
    prompt: "Approve this account?",
  },
);

if (review.approved) await activateAccount(accountId);
```

Checkpoint earlier effects or make them idempotent, because replay starts the handler again rather
than restoring a JavaScript stack.

## An authenticated operator supplies the result

The dashboard lists pending decisions with their job identity, name, and stored context. It accepts
a JSON result only when the host exposes operator mutations, and its server replaces browser
attribution with the authenticated principal.

The `Waiting` task filter includes open signal and human-decision waits. The `Blocked` filter keeps
tasks held by dependencies or child joins separate, because an operator cannot resume those tasks
by supplying a decision.

If one common result should be a button, add `dashboard.quickAction` to the context. Give it the
button `label` and the exact JSON `result`. The dashboard only shows the button when the application
opts in, so the dashboard never assumes that `{ approved: true }` is valid.

Custom operator tools can call `Queue.listHumanWaits()` for the same actionable projection. The
dashboard uses this public method, so both surfaces see the same context and effective deadline.
If `nextCursor` is present, pass it to the next call to continue through every pending decision.

Applications can complete the same decision through `Queue.completeHumanWait`. They must establish
their own authorization before passing the stable job identity, token name, result, idempotency key,
and trusted actor as `requestedBy`.
The response exposes the accepted decision as `payload`, matching `Queue.sendSignal`.

The first accepted completion resumes the job. An equal retry returns the retained result, while a
competing completion returns the accepted winner without overwriting its audit evidence.

## PostgreSQL closes an unanswered decision

PostgreSQL applies a finite [timeout](140-deadlines-and-timeouts.md), and a caller can choose a
shorter one. An earlier job deadline wins. Timeout fails the job because replay cannot continue
without a result. [Cancellation](120-cancellation.md) also closes the decision, so late completion
returns `stale`. The token row follows the parent job's safe [retention](330-retention.md).

## Next

- [135-signals.md](135-signals.md) — wait for an application-owned external event
- [030-delivery-guarantees.md](030-delivery-guarantees.md) — make replayed work safe
- [120-cancellation.md](120-cancellation.md) — close work that should no longer wait

---

Exact human wait bounds, statuses, and SQL transitions:
[`architecture.md`](../architecture.md#human-decision-suspension).
