# How do I build a durable agent loop?

<!-- scenario-names: agent.loop, research, calculate, reportProgress, conv-12, tools-complete, tool-call -->

An agent loop is a handler that plans with a model, calls tools, and waits for a person. These steps
can take more time than one worker process lives. If a worker stops, the loop must continue from the
last step that it finished. Workhorse stores the result of each step in PostgreSQL, so another
worker can continue the loop. Your application keeps the model calls, the tool code, and the
prompts.

A model call is slow and expensive, so the loop must not repeat it. A checkpoint stores the result
of the call, and a later run of the handler uses the stored result. A child task is a task that a
handler creates and then waits for. Each tool runs as a child task, so a tool worker runs it.

All examples on this page use one `agent.loop` task. The task answers a prompt for conversation
`conv-12`.

## Plan one time and run the tools as child tasks

**Example.** The `agent.loop` task for `conv-12` starts on worker A.

1. Worker A runs the handler. The `plan` checkpoint calls the model and stores the plan.
2. `HandlerContext.runChildrenAll` creates the [child tasks](170-child-tasks.md) `research` and
   `calculate` on a tool queue. The handler stops, and worker A gets a free slot.
3. Tool workers run the two child tasks. Both succeed, so Workhorse makes the parent task ready.
4. Worker B runs the handler again from the start. The `plan` checkpoint returns the stored plan
   and does not call the model.
5. `runChildrenAll` returns the stored tool results, and the handler continues.

Worker A can stop after step 2. The loop keeps the plan and the tool results.

Write the steps of the loop in ordinary handler code:

```ts
const plan = await context.checkpoint("plan", () => callModel(prompt));
await context.setProgress({ stage: "planned" });
const tools = await context.runChildrenAll(toolRequests);
await context.sleep("model-cooldown", cooldownMs);
const approval = await context.waitForSignal<{ approved: boolean }>("approval");
```

`runChildrenAll` returns the results only if all child tasks succeed. If a tool fails, the parent
gets the failure. If the model must see the result of each tool, also of a failed tool, use
`runChildren`.

## Wait for a timer and an approval

A loop can wait for time to pass, or for a person to approve the answer. Workhorse stores each wait
in PostgreSQL. While the task waits, it uses no worker slot.

**Example.** The handler for `conv-12` has its tool results.

1. The handler calls `HandlerContext.sleep` with the name `model-cooldown`. The task waits on a
   [durable timer](130-durable-waits.md).
2. The cooldown ends. A worker runs the handler again. The handler gets past the stored steps and
   stops at `HandlerContext.waitForSignal`.
3. The reviewer's application calls `Queue.sendSignal` with the signal `approval`. The task
   becomes ready, as [the signals guide](135-signals.md) describes.
4. A worker runs the handler again. `waitForSignal` returns the approval, and the handler completes
   the answer.

In the two examples, the handler runs four times. The model makes the plan one time, and each tool
runs one time.

After each durable wait, the handler starts again from the start, as the
[delivery guarantees guide](030-delivery-guarantees.md) describes. Thus, each step must give the
same result when the handler runs again:

- Give each child task the same name and the same request each time. If the set of child tasks
  changes, Workhorse raises a conflict.
- A checkpoint returns its stored result after the first save.
- A relative timer keeps the wake time of its first call.

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

More detail: [Task lifecycle: Durable timer suspension](../architecture/lifecycle.md#durable-timer-suspension) and [Data model: Timeout and deadline](../architecture/data-model.md#timeout-and-deadline).

</details>

## Share the tool capacity between conversations

Many conversations can use one tool queue. If one conversation sends many tool calls, the other
conversations must wait. To prevent this, the repository example limits the rate of each
conversation.

The example puts the tool tasks on a queue with a policy from `Queue.syncRateLimitPolicies`. Each
tool request uses the conversation ID as its `concurrencyKey`. The policy gives each key its own
part of the rate, as [the rate limits guide](250-rate-limits.md) describes.

<details>
<summary>Reference: per-conversation rate</summary>

- In the example, each tool request sets `queue` and `concurrencyKey` in its `options`.
- A keyed rate-limit policy gives each non-null concurrency key its own bucket within the queue.

More detail: [Task lifecycle: Key limits and the policy window](../architecture/lifecycle.md#key-limits-and-the-policy-window) and [Data model: Concurrency key](../architecture/data-model.md#concurrency-key).

</details>

## Keep the progress value from moving back

Operators follow the loop through its progress value. The progress value is one JSON value that a
handler writes for its task, and the dashboard shows it. The repository example stores the last
stage of the loop, for example `planned` or `tools-complete`.

**Example.** The handler for `conv-12` runs again after the cooldown.

1. The stored stage is `tools-complete`.
2. The handler starts again from the start and reports the stage `planned` again.
3. If the handler writes `planned`, the dashboard shows an earlier stage.

To prevent this, the repository example uses the helper `reportProgress`. The helper reads the
stored stage with `HandlerContext.getProgress`. It writes the new stage with
`HandlerContext.setProgress` only if the new stage is later. The short code on this page calls
`setProgress` directly, so it does not do this check.

Python, Rust, and Ruby use `get_progress` and `set_progress`. In Python, these are
`HandlerContext.get_progress` and `HandlerContext.set_progress`. Go uses
`HandlerContext.GetProgress` and `HandlerContext.SetProgress`. All SDKs write the same value, so the
dashboard shows one progress value for each task.

<details>
<summary>Reference: progress</summary>

| SDK        | Read           | Write          |
| ---------- | -------------- | -------------- |
| TypeScript | `getProgress`  | `setProgress`  |
| Python     | `get_progress` | `set_progress` |
| Go         | `GetProgress`  | `SetProgress`  |
| Rust, Ruby | `get_progress` | `set_progress` |

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

A worker can stop after it calls a provider, but before Workhorse stores the result. Then another
worker makes the same call again.

**Example.** The `research` tool calls a search provider.

1. The tool worker calls the provider, and the provider stores the request.
2. The tool worker stops before the `tool-call` checkpoint saves its result.
3. The claim of the tool worker expires. Another worker runs the tool again.
4. The provider gets the same call two times.

Thus, Workhorse runs model calls and tool calls at least one time, and sometimes more. To make a
repeated call safe, do one of these:

- Give the provider a stable idempotency key.
- Use an outbox, an inbox, or a compensating action.

The repository example makes each key from the task ID and the checkpoint name. Workhorse does not
give an exactly-once effect. It does not store a continuation or a call stack.

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

## Run the repository example

The repository has a complete version of this loop in `typescript/examples/agentic-flow.mjs`. Run
it to see all the steps of this page.

1. Make sure that the database has the current Workhorse schema. The example does not install it.
2. Set `DATABASE_URL`. If you do not set it, the example uses `DATABASE_URL_TEST_PACKED`.
3. Run this command. It builds the packages and runs the example.

```sh
pnpm example:agentic-flow
```

The example enqueues a parent task, runs its tool tasks, and waits on a durable timer. Then it sends
the approval signal with one idempotency key. It repeats the send until Workhorse reports a
delivery. At the end, it prints the result and the progress value.

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
