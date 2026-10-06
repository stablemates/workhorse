# How do I pause for a human decision?

<!-- scenario-names: acct-19, rev-4, rev-5, account-review -->

Some tasks need a person to inspect context and decide what happens next. A human wait stores that
context, releases the worker lease, and gives the dashboard an actionable decision.

## One account, one review

A task activates account `acct-19`, but only after a person approves it. The handler names the
decision `account-review` and stores the context an operator needs to decide.

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

1. **At 0 s** worker A claims the task and calls the handler. The handler reaches
   `ctx.waitForHuman("account-review", …)`. Workhorse stores the decision and its context, and takes
   the task away from worker A. No worker can claim the task now, and worker A's slot is free.
2. **At 40 min** an operator reads the context and approves the account. Workhorse stores the
   result `{ "approved": true }`, makes the task ready, and notifies workers.
3. **Shortly after** worker B claims the task and calls the handler **from the beginning**. The
   handler reaches `ctx.waitForHuman("account-review", …)` again, with the same context. This time
   the call returns the stored result at once, and the handler activates the account.

The wait does not use up the task's logical attempt. Worker B's claim gets a new
[fence token](020-leases-and-fences.md), but it continues the same attempt.

The handler restarts from its entry point, because Workhorse does not restore a JavaScript stack.
Wrap earlier effects in a [checkpoint](030-delivery-guarantees.md) or make them idempotent.

The replay must also pass the same context. Suppose a deployment between steps 1 and 3 changed the
prompt text. The replayed call then conflicts with the stored context. Workhorse fails the task
instead of retrying it, as the [durable waits guide](130-durable-waits.md) explains for every
replay conflict.

Go handlers call `HandlerContext.WaitForHuman` with the stable name and JSON context. They can pass
`ExternalWaitOptions` when the decision needs a shorter lifetime.

<details>
<summary>Reference: declaring a human wait</summary>

| SDK        | Handler call                                                         |
| ---------- | -------------------------------------------------------------------- |
| TypeScript | `HandlerContext.waitForHuman(name, context, { timeoutMs })`          |
| Python     | `wait_for_human(name, context, *, timeout_ms=None)`                  |
| Go         | `HandlerContext.WaitForHuman(name, context, ...ExternalWaitOptions)` |

| Limit                               | Value                                              |
| ----------------------------------- | -------------------------------------------------- |
| `MAX_EXTERNAL_WAIT_NAME_CHARACTERS` | 200 characters. No leading or trailing whitespace. |
| `MAX_EXTERNAL_WAIT_VALUE_BYTES`     | Context: 65,536 bytes of canonical JSONB text      |
| `MAX_EXTERNAL_WAITS_PER_TASK`       | 1,000 human decisions per task                     |

**`wait_for_human_v1` results**

| Status            | Meaning                                                                                          | TypeScript and Go result       |
| ----------------- | ------------------------------------------------------------------------------------------------ | ------------------------------ |
| `waiting`         | Stores the context and parks the task. Appends `human_wait_created`.                             | The handler suspends.          |
| `completed`       | The decision has a result and the context is equal. Appends `human_wait_replayed`.               | Returns the stored result.     |
| `already_waiting` | The same decision is already pending with the same context.                                      | `HumanWaitAlreadyWaitingError` |
| `conflict`        | The stored context differs from the replayed one.                                                | `HumanWaitConflictError`       |
| `stale`           | The lease, fence, deadline, or execution timeout no longer holds, or cancellation was requested. | `HumanWaitLeaseLostError`      |
| `limit_exceeded`  | The task already holds the maximum number of human decisions.                                    | `HumanWaitLimitExceededError`  |

- The wait keeps the logical attempt open and does not increment `current_attempt`.
- `HumanWaitConflictError` fails the task without a retry and keeps the current attempt.
- A [fast-tier queue](305-fast-tier.md) rejects human waits with `FastTierUnsupportedError`.

More detail: [Data model: Declaring a human wait](../architecture/data-model.md#declaring-a-human-wait).

</details>

## An operator answers from the dashboard

The dashboard marks pending decisions in its `Waiting` task list. Go back to step 2. Suppose the
handler's context also carried a quick action: a `dashboard.quickAction` object with the `label`
`"Approve"` and the `result` `{ "approved": true }`.

1. The operator opens the `Waiting` list and finds the task for `acct-19`.
2. The task menu shows **Approve**. The operator selects it.
3. The dashboard shows the stored result `{ "approved": true }` and asks the operator to confirm.
4. The operator confirms. The dashboard server completes the decision. It replaces any
   browser-supplied attribution with the host's audit actor, so the signed-in operator is the
   recorded actor. A Python, Go, Rust, or Ruby host can configure its own audit actor instead; see
   [370-dashboard-authentication.md](370-dashboard-authentication.md).

The quick action is opt-in. Without a valid `dashboard.quickAction`, the menu action stays
disabled. The dashboard never assumes that `{ "approved": true }` is a valid answer to a generic
decision.

The `Waiting` filter includes open signal and human-decision waits. The `Blocked` filter keeps tasks
held by dependencies or child joins separate. An operator cannot resume those tasks by supplying a
decision.

<details>
<summary>Reference: dashboard quick action</summary>

- The dashboard reads `context.dashboard.quickAction` with a string `label` and a JSON `result`.
- It renders `label` in the task-row menu. It submits `result` only after confirmation.
- A missing or malformed object leaves the menu action disabled.
- `DashboardTasksPage.canCompleteHumanWait` reports whether the operator may complete decisions.
- The dashboard derives `requestedBy` from the host's audit actor: the authenticated principal, or a
  configured audit actor in Python, Go, Rust, and Ruby.
- `/tasks?filter=waiting` marks both signal and human-decision waits.

More detail: [Data model: Dashboard quick action](../architecture/data-model.md#dashboard-quick-action).

</details>

## Custom tools can list pending decisions

Go back to account `acct-19`. Not every answer fits one quick action. A reviewer might need to
reject the account and explain why. So your team builds a custom operator tool that collects that
result.

1. **At 0 s** the task parks on `account-review`.
2. **At 30 min** the tool calls `Admin.listHumanWaits`. The first page holds the oldest pending
   decisions. The row for `acct-19` holds its stored context, with the prompt, and its effective
   deadline.
3. **Right after** the page returns `nextCursor`. The tool passes it to the next call, and reads
   pages until it has seen every pending decision.

A completed decision no longer appears in the list. So the tool shows only decisions that still
need an answer.

<details>
<summary>Reference: listing human waits</summary>

`Admin.listHumanWaits({ limit, cursor })` returns a `HumanWaitPage`.

| Field        | Rule                                                                                        |
| ------------ | ------------------------------------------------------------------------------------------- |
| `limit`      | 1 to 1,000 (`MAX_EXTERNAL_WAIT_LIST_SIZE`). Default 100.                                    |
| Order        | Ascending `createdAt`, then `taskId`, then `name`.                                          |
| `HumanWait`  | `taskId`, `queue`, `taskType`, `name`, `attempt`, `createdAt`, `deadlineAt`, and `context`. |
| `nextCursor` | `{ createdAt, taskId, name }` when another page exists, otherwise null.                     |

`dashboard_human_wait_v1` owns the SQL projection. It lists a decision only while it has no
completion and its task still waits on it.

More detail: [Data model: Listing and events](../architecture/data-model.md#listing-and-events) and [Data model: Listing signal waits](../architecture/data-model.md#listing-signal-waits).

</details>

## Applications can complete a decision

Two reviewers use that tool on `acct-19` at about the same time.

1. **At 40 min** reviewer Dana approves. The tool calls `Queue.completeHumanWait` with the task, the
   name `account-review`, the result `{ "approved": true }`, the idempotency key `rev-4`, and Dana
   as `requestedBy`. Workhorse accepts it and resumes the task.
2. **At 40 min + 3 s** Dana's tool retries the same request after a network error. Workhorse
   returns `duplicate` with the stored result. The task does not resume a second time.
3. **At 41 min** reviewer Lee rejects with the key `rev-5`. Workhorse returns `already_completed`
   with Dana's result and Dana as the actor. Lee's answer does not overwrite the audit evidence.

The first accepted completion resumes the task. The response exposes the accepted decision as
`payload`, matching `Queue.sendSignal`. A reused key with a changed result or actor is refused with
a conflict error.

The application must establish authorization before it calls `Queue.completeHumanWait`.
`requestedBy` is attribution only.

Go applications use `Queue.CompleteHumanWait` with `ExternalWaitDelivery`. The result holds the
accepted decision and actor. A changed request under a stored key returns a typed conflict error.

<details>
<summary>Reference: completion request and statuses</summary>

**Request.** `Queue.completeHumanWait(taskId, name, result, { idempotencyKey, requestedBy })`.
Python uses `Queue.complete_human_wait(task_id, name, result, *, idempotency_key, requested_by)`.

| Bound                                     | Limit                                        |
| ----------------------------------------- | -------------------------------------------- |
| `MAX_EXTERNAL_WAIT_VALUE_BYTES`           | Result: 65,536 bytes of canonical JSONB text |
| `MAX_EXTERNAL_WAIT_IDEMPOTENCY_KEY_BYTES` | Key: 1 to 512 UTF-8 bytes                    |
| `MAX_EXTERNAL_WAIT_ACTOR_CHARACTERS`      | `requestedBy`: 1 to 200 characters           |

**`complete_human_wait_v1` statuses**

| Status              | When                                                          | Dispatch state      |
| ------------------- | ------------------------------------------------------------- | ------------------- |
| `completed`         | The decision is pending and owns the parked task.             | Task becomes ready. |
| `duplicate`         | Same key, same result and actor as the stored completion.     | Unchanged.          |
| `already_completed` | Another key, after a completion was accepted.                 | Unchanged.          |
| `not_waiting`       | No decision with this name exists yet.                        | Unchanged.          |
| `stale`             | The decision no longer owns the task, or its deadline passed. | Unchanged.          |
| `not_found`         | No task has this identity.                                    | Unchanged.          |

A same-key request with a changed result or actor raises `HumanWaitIdempotencyConflictError`.

`HumanWaitCompletionResult` has `status`, `taskId`, `name`, `payload`, `completedAt`, and
`completedBy`.

- PostgreSQL keeps only the SHA-256 key hash, a request fingerprint, the first result, the actor,
  and the completion time.
- `human_wait_completed` and `human_wait_rejected` events hold value-free lifecycle evidence.

More detail: [Data model: Completing a human wait](../architecture/data-model.md#completing-a-human-wait).

</details>

## An unanswered decision still closes

This time the handler gives the decision a lifetime of one day through `timeoutMs`.

1. **At 0 s** the task parks on `account-review`. Its boundary closes at 1 day.
2. **At 1 day** no operator has answered. Shortly after, a regular background pass fails the task
   with a deadline error. Workhorse starts no further attempt, because replay cannot continue
   without a result.
3. **At 1 day + 2 h** an operator tries to approve. Workhorse returns `stale` and leaves the failed
   task as it is.

When the handler names no `timeoutMs`, Workhorse applies its longest supported wait instead. An
earlier task [deadline](140-deadlines-and-timeouts.md) wins over either. Choose a `timeoutMs` your
operators can meet. The default is long enough that a decision can sit past the point it mattered.

[Cancellation](120-cancellation.md) also closes the decision, so a late completion returns `stale`.
The decision row follows the parent task's safe [retention](330-retention.md).

<details>
<summary>Reference: timeout, cancellation, and retention</summary>

| Value       | Rule                                                     |
| ----------- | -------------------------------------------------------- |
| `timeoutMs` | Optional. An integer from 1 to 604,800,000 ms (7 days).  |
| Default     | `MAX_EXTERNAL_WAIT_TIMEOUT_MS`, 604,800,000 ms (7 days). |

- `wait_for_human_v1` computes the boundary as signal waits do: the earlier of the task deadline
  and the declaration time plus the timeout.
- `dashboard_human_wait_v1.deadline_at` exposes that effective boundary.
- On expiry the task fails with `DeadlineExceeded` and never resumes without a result.
- Cancellation and deadline failure read `task_human_wait` first. They keep the original attempt,
  fence, worker, and claim time.
- A completion after either returns `stale` and appends `human_wait_rejected`. It cannot overwrite
  the stored decision or the terminal outcome.
- Decision rows have no retention window of their own. They are removed only with the parent `task`.

More detail: [Data model: Timeout, cancellation, and retention](../architecture/data-model.md#timeout-cancellation-and-retention) and [Data model: Timeout and deadline](../architecture/data-model.md#timeout-and-deadline).

</details>

## Next

- [135-signals.md](135-signals.md) — wait for an application-owned external event
- [030-delivery-guarantees.md](030-delivery-guarantees.md) — make replayed work safe
- [120-cancellation.md](120-cancellation.md) — close work that should no longer wait

---

Exact human wait bounds, statuses, and SQL transitions:
[`architecture/lifecycle.md`](../architecture/lifecycle.md#human-decision-suspension).
