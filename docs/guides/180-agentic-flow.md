# How do I build a durable agent loop?

An agent loop becomes durable when each restart boundary lives in PostgreSQL. Workhorse composes
those boundaries from ordinary jobs, so the application still owns the model calls and tools.

## Compose restart boundaries

The handler starts from its entry point after every durable boundary, as described in
[delivery guarantees](030-delivery-guarantees.md). Compose those boundaries in ordinary handler code,
and keep the furthest completed stage in `HandlerContext.setProgress` so replay cannot move the
operator view backward.

Python uses `HandlerContext.set_progress`, while Go uses `HandlerContext.SetProgress`. Both read the
retained stage before advancing it, just like the TypeScript handler.

```js
const plan = await context.checkpoint("plan", () => callModel(prompt));
await reportProgress(context, "planned");

const tools = await context.runChildren(toolRequests);
await context.sleep("model-cooldown", cooldownMs);
const approval = await context.waitForSignal("approval");
```

The child set must keep stable names and requests, because changed replay conflicts. A checkpoint
reuses its stored result after persistence, while a relative timer keeps its first wake target.

`HandlerContext.runChildren` joins independent [child jobs](170-child-jobs.md). The example puts them
on a queue governed by `Queue.syncRateLimitPolicies`, with the conversation identity as each
`concurrencyKey` for [per-key traffic control](250-rate-limits.md).

`HandlerContext.sleep` crosses a [durable timer](130-durable-waits.md), then
`HandlerContext.waitForSignal` waits for approval delivered through `Queue.sendSignal`, following the
[signal contract](135-signals.md). These APIs release the lease instead of retaining an in-memory
continuation.

Model and tool calls remain at least once. Give their providers a stable idempotency key, or use an
outbox, inbox, or compensation, because Workhorse provides no exactly-once effect, persisted
continuation, or durable call stack.

## Run the complete example

The repository command builds the publishable packages and runs `typescript/examples/agentic-flow.mjs` against
the configured `DATABASE_URL_TEST_PACKED`:

```sh
pnpm example:agentic-flow
```

The database must already have the current Workhorse schema. The example enqueues a parent, runs its
tool children, crosses a durable timer, delivers an idempotent approval signal, and prints the final
result and progress projection.

## Next

- [030-delivery-guarantees.md](030-delivery-guarantees.md) — make external effects safe to repeat
- [170-child-jobs.md](170-child-jobs.md) — delegate and join durable tool work
- [135-signals.md](135-signals.md) — resume an execution from another process

---

Exact example contracts, names, and limits:
[`architecture.md`](../architecture.md#agentic-flow-example).
