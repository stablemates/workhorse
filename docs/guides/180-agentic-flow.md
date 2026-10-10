# How do I build a durable agent loop?

<!-- scenario-names: agent.loop, research, calculate, reportProgress, conv-12, tools-complete, tool-call -->

An agent loop plans with a model, calls tools, pauses, and waits for a person. Any of those steps
can outlive a worker process. The loop becomes durable when each restart boundary lives in
PostgreSQL. Workhorse builds those boundaries from ordinary tasks, so your application still owns
the model calls and the tools.

## One conversation, from plan to approval

**Example.** An `agent.loop` task answers a prompt for conversation `conv-12`. It plans with a
model, runs two tool tasks, cools down, and waits for a reviewer to approve the answer.

1. **The plan.** Worker A claims the task. The `plan` checkpoint calls the model and stores the
   plan under the name `plan`.
2. **The tools.** `HandlerContext.runChildrenAll` creates two [child tasks](170-child-tasks.md),
   `research` and `calculate`, on a tool queue. The parent blocks, and worker A's slot is free.
3. **The release.** Tool workers run both children. Both succeed, so Workhorse releases the parent.
4. **The first replay.** Worker B runs the handler from its entry point. The `plan` checkpoint
   returns the stored plan without calling the model. `runChildrenAll` returns the stored tool
   results. The handler then reaches `HandlerContext.sleep`, and the task pauses on a
   [durable timer](130-durable-waits.md).
5. **The second replay.** The cooldown ends. A worker replays the handler again, passes every
   earlier boundary, and reaches `HandlerContext.waitForSignal`. The task pauses again.
6. **The approval.** The reviewer's app calls `Queue.sendSignal` with the signal `approval`. The
   task becomes ready, as the [signal contract](135-signals.md) describes.
7. **The last replay.** A worker replays the handler once more. `waitForSignal` returns the
   approval, and the handler finishes the answer.

The handler ran four times, but the model planned once and each tool ran once. Each boundary
released the lease instead of keeping an in-memory continuation. So the loop survived every worker
that left between steps.

The handler starts from its entry point after every durable boundary, as described in
[delivery guarantees](030-delivery-guarantees.md). Compose those boundaries in ordinary handler
code:

```js
const plan = await context.checkpoint("plan", () => callModel(prompt));
await reportProgress(context, "planned");

const tools = await context.runChildrenAll(toolRequests);
await context.sleep("model-cooldown", cooldownMs);
const approval = await context.waitForSignal("approval");
```

Keep the boundaries stable across replays. The child set must keep stable names and requests,
because a changed replay conflicts. A checkpoint reuses its stored result once it is saved. A
relative timer keeps its first wake target.

`runChildrenAll` joins independent tool children and propagates a rejected tool outcome to the
parent. Use `runChildren` when the model should inspect every settled outcome instead.

The example puts the tool children on a queue governed by `Queue.syncRateLimitPolicies`. Each tool
request carries the conversation identity as its `concurrencyKey`. One busy conversation then
cannot take the whole tool rate, as [per-key traffic control](250-rate-limits.md) explains.

<details>
<summary>Reference: boundaries in the example</summary>

| Call                                               | SQL function                        | On replay                                                          |
| -------------------------------------------------- | ----------------------------------- | ------------------------------------------------------------------ |
| `HandlerContext.checkpoint(name, fn)`              | `save_checkpoint_v1`                | Returns the stored value without running `fn`.                     |
| `HandlerContext.runChildrenAll(set)`               | `create_children_v1`, `all_success` | Returns the stored results. A changed set conflicts.               |
| `HandlerContext.runChildren(set)`                  | `create_children_v1`, `settled`     | Returns one outcome per child.                                     |
| `HandlerContext.sleep(name, ms)`                   | `schedule_wait_v1`                  | Returns the first stored wake target, even if `ms` changed.        |
| `HandlerContext.waitForSignal(name)`               | `wait_for_signal_v1`                | Returns the retained signal payload.                               |
| `Queue.sendSignal(taskId, name, payload, request)` | `send_signal_v1`                    | An equal retry with the same `idempotencyKey` returns `duplicate`. |

- Each suspension clears ownership without closing the logical attempt.
- Each wake makes the same attempt claimable under a new fence token.
- An omitted signal timeout defaults to `MAX_EXTERNAL_WAIT_TIMEOUT_MS`, 604,800,000 ms (7 days).
- In the example, each tool request sets `queue` and `concurrencyKey` in its `options`.
- A keyed rate-limit policy gives each non-null concurrency key its own bucket within the queue.

More detail: [Task lifecycle: Durable timer suspension](../architecture/lifecycle.md#durable-timer-suspension) and [Data model: Timeout and deadline](../architecture/data-model.md#timeout-and-deadline).

</details>

## Keep the progress view moving forward

Operators watch the loop through its progress value. The example stores the furthest stage the
loop has reached, such as `planned` or `tools-complete`.

Go back to step 5 of the story. When the handler replays after the cooldown, it calls
`reportProgress(context, "planned")` again. The stored stage is already `tools-complete`. A plain
write would move the operator view backward. So the example's `reportProgress` first reads the
stored stage with `HandlerContext.getProgress`. It writes with `HandlerContext.setProgress` only
when the new stage is further along.

Python uses `HandlerContext.get_progress` and `HandlerContext.set_progress`. Go uses
`HandlerContext.GetProgress` and `HandlerContext.SetProgress`. A Python or Go handler reads the
stored stage the same way before it advances it.

<details>
<summary>Reference: progress</summary>

| SDK        | Read           | Write          |
| ---------- | -------------- | -------------- |
| TypeScript | `getProgress`  | `setProgress`  |
| Python     | `get_progress` | `set_progress` |
| Go         | `GetProgress`  | `SetProgress`  |

- `update_progress_v1` accepts only the exact unexpired worker and fence.
- Workhorse keeps one latest value per task. Each accepted change replaces it and increments a
  monotonic revision. Keeping stages in order is the handler's responsibility.
- An identical value is a no-op.
- A value holds at most 64 KiB of canonical JSONB text.
- One fence may commit a changed value at most every 100 ms. A faster change raises
  `ProgressRateLimitError`. A new ownership generation may report at once.
- A stale write raises `ProgressLeaseLostError`.
- The latest value survives retry and terminal materialization.

More detail: [Data model: Limits and lifetime](../architecture/data-model.md#limits-and-lifetime).

</details>

## Make model and tool calls safe to repeat

Suppose the `research` tool calls a search provider, and the provider stores the request. Then the
tool worker's process dies before the `tool-call` checkpoint commits. The lease expires, and another
worker runs the tool again. The provider sees the same call twice.

Model and tool calls remain at least once. Give their providers a stable idempotency key, or use an
outbox, an inbox, or compensation. The example derives each key from the task ID and the checkpoint
name. Workhorse provides no exactly-once effect, no persisted continuation, and no durable call
stack.

<details>
<summary>Reference: delivery semantics</summary>

- Workhorse provides durable at-least-once execution.
- A process can die after an external effect but before completion commits.
- A process can die after completion commits but before it observes the response.
- Applications use provider idempotency keys or transactional outbox and inbox patterns for
  effects that are not idempotent.
- In the example, each effect receives the idempotency key `${context.task.id}:<checkpoint name>`.

More detail: [Task lifecycle: Delivery semantics](../architecture/lifecycle.md#delivery-semantics).

</details>

## Run the complete example

The repository command builds the publishable packages and runs
`typescript/examples/agentic-flow.mjs`:

```sh
pnpm example:agentic-flow
```

The example connects to `DATABASE_URL` when it is set, and otherwise to the configured
`DATABASE_URL_TEST_PACKED`. The database must already have the current Workhorse schema. The example
enqueues a parent, runs its tool children, crosses a durable timer, and delivers an idempotent
approval signal. It then prints the final result and the progress value.

<details>
<summary>Reference: running the example</summary>

- `pnpm example:agentic-flow` builds the publishable packages and runs
  `typescript/examples/agentic-flow.mjs`.
- Database: `DATABASE_URL`, else `DATABASE_URL_TEST_PACKED`. With neither set, the example throws
  `DATABASE_URL is required`.
- The database must already have the current Workhorse schema. The example calls
  `assertSchemaCompatible` and does not migrate.

More detail: [Features: Durable agent-flow example](../features.md).

</details>

## Next

- [030-delivery-guarantees.md](030-delivery-guarantees.md) — make external effects safe to repeat
- [170-child-tasks.md](170-child-tasks.md) — delegate and join durable tool work
- [135-signals.md](135-signals.md) — resume an execution from another process

---

Exact child-join contracts and limits:
[`architecture/data-model.md`](../architecture/data-model.md#task_child).
