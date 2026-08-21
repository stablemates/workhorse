# How do I wait for an external signal?

Some jobs need a decision or event that arrives from another process. A signal wait releases the
worker slot until an application or authenticated operator supplies a named JSON payload.

## The handler restarts when delivery arrives

`ctx.waitForSignal` records a durable boundary and releases the lease. Pass optional `timeoutMs` to
shorten how long PostgreSQL keeps the boundary open. When a caller delivers that signal, Workhorse
makes the same logical attempt ready and a worker starts the handler again.

The handler restarts from its entry point, so checkpoint earlier effects or make them idempotent.
When replay reaches the same name, `waitForSignal` returns the retained payload.

Go handlers call `HandlerContext.WaitForSignal` with the same stable name. They can pass
`ExternalWaitOptions` when the boundary needs a shorter lifetime.

```ts
const approval = await ctx.waitForSignal<{ approved: boolean }>("approval");

if (approval.approved) await publishOrder();
```

## Delivery is idempotent at the state transition

An application calls `Queue.sendSignal` with the stable job identity, name, payload, idempotency
key, and trusted actor. The first accepted delivery resumes the job. An equal retry returns the
retained delivery, so a network retry cannot resume the handler twice.

A reused key conflicts if its payload or actor changes. Another key arriving after acceptance is
late and returns the retained winner. A delivery before the wait exists is rejected without being
buffered, so the caller may retry after the handler declares the boundary.

Go applications call `Queue.SendSignal` with `ExternalWaitDelivery`. The result reports the
database status and retained payload, while a changed retained key returns a typed conflict error.

The dashboard lists pending signals on its external waits page and marks the waiting task in the
task table. An operator can enter the JSON payload there or in the task drawer. The dashboard uses
the same queue operation, but its server replaces browser attribution with the authenticated
principal. Application-owned callers must establish authorization before calling the core API.

Operator tools can call `Queue.listSignalWaits()` to read the current actionable boundaries. Each
row identifies the job, queue, job type, signal name, attempt, creation time, and effective
deadline without exposing a delivered payload. If a page returns `nextCursor`, pass it back to
continue without hiding waits beyond the page bound.

## PostgreSQL closes an unanswered boundary

PostgreSQL applies a finite [timeout](140-deadlines-and-timeouts.md), and a caller can choose a
shorter one. An earlier job deadline wins. Timeout fails the job because replay cannot continue
without a payload. [Cancellation](120-cancellation.md) also closes the boundary, so late delivery
returns `stale`. The signal row follows the parent job's safe [retention](330-retention.md).

## Next

- [130-durable-waits.md](130-durable-waits.md) — pause until a time instead of an external event
- [030-delivery-guarantees.md](030-delivery-guarantees.md) — make replayed work safe
- [120-cancellation.md](120-cancellation.md) — close work that should no longer wait

---

Exact signal bounds, statuses, and SQL transitions:
[`architecture.md`](../architecture.md#durable-signal-suspension).
