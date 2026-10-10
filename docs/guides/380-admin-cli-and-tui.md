# How do I operate a queue from the terminal?

<!-- scenario-names: workhorse_staging, emails, order-88, reserve-stock, w-7, billing, decision.json -->

The dashboard is not always where you are. Sometimes you are in a shell on a bastion host, or
writing a runbook script, and you still need to see what a queue is doing, or stop it.

`workhorse admin` and `workhorse tui` are that surface. One is for scripts and one-off commands; the
other is a live terminal view. Both are the same client underneath, with the same safety checks, so
nothing you learn in one is wrong in the other.

## Looking around is always safe

> **Example.** At 02:00 an on-call engineer is paged: payments on queue `billing` are failing. They
> open a shell on the bastion host.
>
> 1. They run `admin failures --queue billing` and get an aligned table of the newest failures.
> 2. They want the task ids for a script, so they add `--json`. The output is the same object the
>    TypeScript operator API returns.
> 3. Nothing they ran changed the queue, so they did not need to name the database or confirm
>    anything.

The inspection commands are `admin tasks`, `admin task`, `admin timeline`, `admin checkpoints`,
`admin waits`, `admin external-waits`, `admin failures`, `admin queues`, `admin schedules`,
`admin workers`, and `admin maintenance`. They only read. You can run them against production
without ceremony, the same way you would run `queue.health` from code.

Each command answers in two registers. By default you get an aligned table for a human reading a
terminal. With `--json` you get the machine-readable result. A script that parses it reads the
documented shape, not a private CLI format.

```sh
workhorse admin failures --queue billing --json | jq '.items[].taskId'
```

<details>
<summary>Reference: inspection commands</summary>

| Command                       | Reads                                                           |
| ----------------------------- | --------------------------------------------------------------- |
| `admin tasks`                 | `Admin.listTasks`                                               |
| `admin task <id>`             | `Admin.getTask`                                                 |
| `admin timeline <id>`         | `Admin.getTaskTimeline`                                         |
| `admin checkpoints <task-id>` | `Admin.listCheckpoints`, or `Admin.getCheckpoint` with `--name` |
| `admin waits <task-id>`       | `Admin.listWaits`, or `Admin.getWait` with `--name`             |
| `admin external-waits`        | `Admin.listHumanWaits` and `Admin.listSignalWaits`              |
| `admin failures`              | `Admin.listDeadLetters`                                         |
| `admin queues`                | `Admin.queueMetricSnapshot` and `workhorse.queue_control`       |
| `admin schedules`             | `Admin.schedules`                                               |
| `admin workers`               | `Admin.listWorkers`                                             |
| `admin maintenance`           | `Admin.getMaintenancePolicy` and `Admin.getRetentionPolicy`     |

- Listing filters: `--queue`, `--type`, `--state` (repeatable or comma-separated), `--limit`, and
  `--namespace` for schedules.
- `--json` emits the underlying API result. Bigint fence tokens and schedule revisions serialize as
  strings.
- Both front ends use `WorkhorseAdminClient` in `typescript/core/src/cli/admin-client.ts`.

More detail: [Operations and CLI: Inspection commands](../architecture/operations.md#inspection-commands).

</details>

## Paging and narrowing

The `billing` failure list is longer than one page.

1. The first answer ends with a `nextCursor` object. Text output prints that continuation too.
2. They pass that object back through `--cursor`, with the same `--queue billing` filter, and get
   the next page.
3. To see only the incident window, they add `--finished-after` and `--finished-before`, both with a
   timezone.

`admin tasks`, `admin timeline`, and `admin failures` accept `--cursor` with the previous answer's
`nextCursor` object. Keep the same filters when continuing. PostgreSQL rejects a task-list cursor
used with different filters.

To narrow an incident window, use `--created-after` and `--created-before` on tasks. Failure
listings accept `--finished-after`, `--finished-before`, repeated `--tag`, and `--error-name`.
Timestamp filters require a timezone. They include the lower bound and exclude the upper bound.

<details>
<summary>Reference: cursors and range filters</summary>

| Command          | Required cursor fields                     |
| ---------------- | ------------------------------------------ |
| `admin tasks`    | `createdAt`, `taskId`, `signature`         |
| `admin failures` | `finishedAt`, `taskId`                     |
| `admin timeline` | `taskId`, `occurredAt`, `kind`, `recordId` |

- A timeline cursor's `kind` is `event` or `attempt`, and its task must match.
- PostgreSQL verifies task-list signatures against the normalized filters.
- Pages are weakly consistent. Continuation adds no snapshot guarantee.
- Repeated `--tag` values must all match.
- `--limit` defaults to 100 and is capped at 1,000 for tasks, timelines, failures, and bulk
  recovery.
- A malformed cursor, a bad range, or an inapplicable flag exits 64.

More detail: [Operations and CLI: Pagination and range filters](../architecture/operations.md#pagination-and-range-filters).

</details>

## Finding out what a stalled task is waiting on

Task `order-88` has not finished in an hour. Three reads tell you why.

1. `admin checkpoints order-88` shows the restart boundaries the handler already got past. It got
   past `reserve-stock`, so the handler did run.
2. `admin waits order-88` shows its durable timer waits and when each one wakes. It has none.
3. `admin external-waits` lists every task waiting on someone. `order-88` appears with a pending
   human decision named `approval`.

A durable handler can stop for a good reason. It saved a checkpoint and is between steps, or it is
sleeping on a timer, or it is waiting for a person or an outside system to answer. From the outside
all four look the same: a task that is not finishing.

Both `admin checkpoints` and `admin waits` take `--name` when you already know which one you want.

`admin external-waits` asks the fleet-wide question: which tasks are waiting on someone. It lists
pending human decisions and pending signal waits together, oldest first. The oldest boundary is
usually the one closest to running out of time. A human decision carries the context its handler
recorded, which is what the person deciding was meant to read.

```sh
workhorse admin external-waits --json | jq '.human.items[] | {taskId, name, context}'
```

Long lists page. Each `--json` answer carries the continuation for its own list, and you hand that
object back on the next call. This is the same paging the dashboard does, so both surfaces walk a
busy queue's waits the same way.

<details>
<summary>Reference: checkpoints, waits, and external waits</summary>

- `admin checkpoints <task-id>` and `admin waits <task-id>` accept `--name <name>`. A name the task
  never recorded prints to stderr and exits 1.
- `admin waits` reads `workhorse.task_wait`.
- `admin external-waits --json` emits
  `{"human": {"items", "nextCursor"}, "signal": {"items", "nextCursor"}}`.
- The table merges both lists oldest-first with a `KIND` column. Only a human decision has
  `CONTEXT`.
- `--limit` applies to both lists. It is capped at `MAX_EXTERNAL_WAIT_LIST_SIZE` (1,000).
- `--human-cursor` and `--signal-cursor` each take the exact `nextCursor` object of their list. A
  value without string `createdAt`, `taskId`, and `name` fields exits 64.

More detail: [Operations and CLI: External waits](../architecture/operations.md#external-waits) and [Operations and CLI: Checkpoints and waits](../architecture/operations.md#checkpoints-and-waits).

</details>

## Answering a wait

`order-88` waits for the decision `approval`. The approver's answer is in `decision.json`.

1. The engineer runs `admin complete-human` with the task, `--name approval`, and
   `--payload-file decision.json`. They identify the delivery with `--request-id` and `--actor`.
2. The network drops before they see the result. They do not know whether the answer arrived.
3. They run the same command again, with the same request identity, actor, and payload. The first
   delivery had arrived, so this one succeeds as a duplicate. The decision is not answered twice.

When you have the answer, `admin signal` delivers a signal and `admin complete-human` completes a
[human decision](145-human-decisions.md). Both select a task and its wait with `--name`. Pass the
answer through `--payload-json` or `--payload-file`.

```sh
workhorse admin complete-human "$TASK_ID" --name approval --payload-file decision.json \
  --request-id "$DELIVERY_ID" --actor oncall --env workhorse_production --yes
```

Reuse the request identity, actor, and payload after an uncertain delivery. An exact duplicate
succeeds without answering again. A conflicting answer or an unavailable wait fails.

<details>
<summary>Reference: signal and human-wait delivery</summary>

Both commands require `--name`, `--request-id`, and exactly one of `--payload-json` or
`--payload-file`. The file holds UTF-8 JSON. Any JSON value is accepted, including `null`.

The CLI passes `--actor` as `requestedBy` and `--request-id` as `idempotencyKey` to
`Queue.sendSignal` or `Queue.completeHumanWait`. These commands record no reason.

| Outcome                                                                       | Exit    |
| ----------------------------------------------------------------------------- | ------- |
| `delivered`, `completed`, `duplicate`                                         | Success |
| `not_found`, `not_waiting`, `already_delivered`, `already_completed`, `stale` | 1       |

A conflict also fails, without replacing the accepted answer.

More detail: [Operations and CLI: Signal and human-wait delivery](../architecture/operations.md#signal-and-human-wait-delivery).

</details>

## Changing things requires naming the target twice

The most common way to hurt yourself with an operator CLI is not a typo in the command. It is
running the right command against the wrong database. A shell still carries the environment of
whatever you were doing an hour ago.

An engineer tested a fix on staging an hour ago. Their shell still has `DATABASE_URL` pointing at
`workhorse_staging`. Now they want to redrive a failed task in production.

1. They run `admin redrive` with `--env workhorse_production`.
2. The client asks the database it reached for its name. The answer is `workhorse_staging`.
3. The names disagree, so nothing happens. The command reports what it refused and why.
4. They fix the URL and run the command again. The names match, and they pass `--yes`, so the
   redrive goes through.

The guarded commands are `admin cancel`, `admin redrive`, `admin pause`, `admin resume`,
`admin purge`, `admin set-tier`, `admin set-history`, `admin pause-worker`, `admin resume-worker`,
`admin redrive-many`, `admin repair-dependencies`, `admin signal`, and `admin complete-human`. They
mutate a live system.

So a guarded command demands that you name the target explicitly. `--env` must state the database's
own name, and the client checks that claim against the database it actually reached. There is no
flag that skips this check.

Confirmation is the second, separate gate. Interactively, you retype the task id, queue name, or
worker id you are about to affect. In a script, you pass `--yes`. The script author, not a default,
decides the command may proceed unattended.

```sh
workhorse admin redrive 7d9f… --env workhorse_production --reason "upstream fixed" --yes
```

A redrive records who asked and why, and carries an idempotency identity. Supply the same
`--request-id` when retrying a runbook step, so it returns the original target. That is the same
contract as [redrive](340-redrive.md) through the public `Admin` client. The CLI adds no separate
semantics. Queue pause and resume also require a reason and retain the request's audit identity.

<details>
<summary>Reference: safety checks and audit fields</summary>

**Database URL.** The CLI takes `--database-url` first, then `WORKHORSE_DATABASE_URL`, then
`DATABASE_URL`. An empty `WORKHORSE_DATABASE_URL` still wins, and then fails.

**Safety checks.** Two independent checks gate every mutation:

1. **Environment.** `--env <database>` is required. `WorkhorseAdminClient.confirmEnvironment`
   compares it with `current_database()` on the live connection. A mismatch throws
   `AdminSafetyError`. The CLI prints `Refused:` and exits 1. Every mutation method on the client
   requires the returned `ConfirmedEnvironment` token.
2. **Confirmation.** Without `--yes`, an interactive session must retype the exact target at a
   prompt on stderr. A mismatched answer changes nothing and exits 1. A non-interactive session
   without `--yes` is a usage error.

**Audit fields**

- Every guarded command except `admin cancel`, `admin signal`, `admin complete-human`, and
  `admin set-history` requires `--reason`.
- `--actor` defaults to `workhorse-admin`.
- `--request-id` defaults to a random UUID. Bulk recovery execution and external-wait delivery
  require it explicitly.
- Redrive and purge use the request identity for idempotency.
- Queue and worker pause keep a request preview, digest, and length with the actor and reason.

**Exit codes.** A non-mutating outcome (`not_found`, `already_terminal`, `not_failed`) exits 1.
Malformed usage exits 64.

More detail: [Operations and CLI: Safety checks](../architecture/operations.md#safety-checks), [Operations and CLI: Audit fields and request identity](../architecture/operations.md#audit-fields-and-request-identity), and [Operations and CLI: Non-mutating outcomes](../architecture/operations.md#non-mutating-outcomes).

</details>

## Emptying a queue

A bad deploy filled queue `emails` with tasks whose payloads crash every handler. Draining them by
hand is not worth the incident.

1. The engineer runs `admin purge emails` with a reason, `--env`, and confirmation.
2. Workhorse deletes the waiting tasks in `emails`. Tasks a worker is already running stay.
3. The command reports how many tasks it removed.
4. Their runbook step times out and retries with the same request identity. The retry re-reports the
   first purge instead of deleting a second time.

`admin purge` empties a queue, and it deletes rather than cancels. Reach for it when a backlog is
poison. Reusing the request identity with different audit fields is refused.

<details>
<summary>Reference: purge</summary>

- `purge_queue_v1` deletes runtimes in `blocked`, `ready`, and `scheduled`, with their identities and
  history. It leaves `active` tasks. On the fast tier it deletes `ready` rows.
- The command prints the deleted row count. Under `--json` it emits `deletedCount` beside `queue`.
- A reused request identity with different audit fields raises `PurgeIdempotencyConflictError`. The
  CLI prints `Refused:` and exits 1.

More detail: [Operations and CLI: Purge](../architecture/operations.md#purge).

</details>

## Changing a queue's tier

`admin queues` shows each queue's tier and the history it records. A full-tier queue records
everything. A fast-tier queue lists the history an operator turned back on, or `none`.

Queue `emails` has handlers that never suspend, so the team moves it to the fast tier.

1. The engineer runs `admin set-tier emails --tier fast` while tasks are still live. Workhorse
   refuses, and the command changes nothing.
2. After the queue drains, they run it again. Workhorse moves the queue.
3. They turn `--record-attempts` on with `admin set-history`. The claims setting stays as it was.

`admin set-tier` carries the same guards as `Admin.setQueueTier`, because it is that call. Workhorse
refuses the switch while the queue holds live tasks. It refuses the fast tier while a policy names
the queue.

```sh
workhorse admin set-tier emails --tier fast --reason "handlers never suspend" \
  --env workhorse_production --yes
```

`admin set-history` turns `--record-attempts` or `--record-claims` on or off. A flag you omit keeps
its setting. Workhorse records no audit for this change, so the command takes no reason. A full-tier
queue already records everything, so the command notes that the switches wait for a move to the
fast tier. Workhorse also accepts a queue name it has never seen, so the command warns when the name
matches no known queue. [The fast tier](305-fast-tier.md) explains what each switch writes.

<details>
<summary>Reference: tier and history commands</summary>

**`admin set-tier <queue> --tier <fast|full>`**

- Calls `Admin.setQueueTier` with `--actor` and `--reason`. `--json` emits `{queue, tier}`.
- Rejects `--request-id` with exit 64.
- A `P1007` refusal prints `Refused:` and exits 1.

**`admin set-history <queue>`**

- Takes `--record-attempts <on|off>`, `--record-claims <on|off>`, or both. Calls
  `Admin.setQueueHistory`.
- `--json` emits `{queue, tier, recordAttempts, recordClaims}`.
- Rejects `--actor`, `--reason`, and `--request-id` with exit 64.
- Writes a `Note:` for a full-tier queue and a `Warning:` for an unknown queue to stderr. Neither
  changes the exit code.

**`admin queues`.** A queue without a `queue_control` row reports `full` with both switches off. The
`HISTORY` column is `all` on the full tier, else `none` or the enabled switches.

More detail: [Operations and CLI: Queue tier](../architecture/operations.md#queue-tier).

</details>

## Recovering a failed backlog

The payment provider is back after an outage. Queue `billing` holds hundreds of failures with error
name `ProviderError`.

1. The engineer runs `admin redrive-many` with the same filters as `admin failures`, plus
   `--dry-run`. They see which sources are eligible. Nothing is created and no audit is written.
2. They remove `--dry-run` and add `--env`, confirmation, and an explicit `--request-id`. The
   command recovers one bounded page, oldest first.
3. They pass the returned `nextCursor` through `--cursor`, with the same filters and request
   identity, until no cursor comes back.

A preview requires a reason but needs no environment confirmation.

```sh
workhorse admin redrive-many --queue billing --error-name ProviderError \
  --reason "provider restored" --dry-run --json
```

Recovery proceeds oldest-first, so its cursor belongs to recovery rather than the newest-first
failure list. Each call processes its own page. A preview does not reserve the candidate set.

<details>
<summary>Reference: bulk redrive</summary>

| Mode                  | Behavior                                                                                                     |
| --------------------- | ------------------------------------------------------------------------------------------------------------ |
| Preview (`--dry-run`) | Passes `dryRun: true` and writes nothing. Requires `--reason`. Default request ID `workhorse-admin-preview`. |
| Execution             | Requires an explicit `--request-id`, `--env`, and confirmation.                                              |

- Each call runs `Admin.redriveMany` once. `--json` emits `BulkRedrivePage`.
- Without a queue filter, interactive confirmation requires typing `all queues`.
- `--limit` defaults to 100 and is capped at `MAX_REDRIVE_BATCH_SIZE` (1,000).
- Preserving the request identity and audit fields replays each source's original target.

More detail: [Operations and CLI: Bulk redrive](../architecture/operations.md#bulk-redrive).

</details>

## Repairing dependency counters

Workhorse keeps a counter of unresolved prerequisites on each blocked dependent. If that counter
drifts from the edges, the dependent can wait forever.

A dependent task has waited all day, though its prerequisites finished in the morning.

1. The engineer runs `admin repair-dependencies --dry-run`. It lists the drifted dependent and what a
   repair would do to it. It writes nothing and needs no confirmation.
2. They run it again without `--dry-run`, with a reason and `--env`. Interactively, they retype
   `dependencies`.
3. The command prints what it did to each dependent. Each repair event records who asked and why.

```sh
workhorse admin repair-dependencies --dry-run
```

A rerun is safe, because it finds only dependents that drifted again.
[Task dependencies](160-task-dependencies.md) explains the counter.

<details>
<summary>Reference: dependency repair</summary>

- `--dry-run` calls `Admin.listDependencyDrift`. It needs no reason, `--env`, or confirmation.
- Without `--dry-run`, it calls `Admin.repairDependencyDrift`. It requires `--reason`, `--env`, and
  confirmation of the target `dependencies`. `--request-id` defaults to a random UUID.
- `--limit` defaults to 1,000 and is capped at `MAX_DEPENDENCY_DRIFT_LIMIT` (100,000).
- Each row's `action` is `recounted`, `released`, or `rejected`. The repair recounts under lock, so
  its action can differ from the preview.
- Each repair appends a `dependency_counter_repaired` event with `requested_by` and
  `request_reason`.
- The request id correlates the repair. It is not an idempotency key.

More detail: [Data model: Governed drift repair (schema version 40)](../architecture/data-model.md#governed-drift-repair-schema-version-40).

</details>

## Taking one worker out of rotation

Sometimes the queue is fine and one worker is not: a bad host, a leaking process, or a deploy that
reached one box first.

Worker `w-7` runs on a host with a failing disk.

1. The engineer reads its id from `admin workers` and runs `admin pause-worker w-7` with a reason.
2. Workhorse records the pause in the fleet registry. Anyone reading `admin workers` sees it at
   once, including who paused it.
3. `w-7` stops claiming when it next registers. The command does not send a message to the
   process.
4. After the disk is replaced, `admin resume-worker w-7` lets it claim again.

The pause lives in the fleet registry, so the command does not reach a running process directly. A
worker finds out on its next registration. That also sets the limit of what the command can do:
[workers](310-workers.md) explains what an operator pause survives and what it does not.

<details>
<summary>Reference: worker pause</summary>

- Both commands write `workhorse.worker_registry.paused` through `Admin.setWorkerPaused`. Both
  require `--reason`.
- `--json` emits `WorkerPauseResult`: `workerId`, `paused`, `pausedBy`, `reason`, `pausedAt`, and
  `lastHeartbeatAt`.
- An unregistered worker id exits 1 with `is not registered`.
- A worker reads the pause on its next `register_worker_v1` call. That call clears the pause when a
  different `instance_id` claims the worker id.

More detail: [Operations and CLI: Worker pause](../architecture/operations.md#worker-pause).

</details>

## The TUI is the same client with a refresh loop

During the `billing` incident, the engineer launches `workhorse tui` to watch the queue.

1. Without `--env`, the title bar says the session is read-only. They can switch views and refresh,
   but cannot change anything.
2. They relaunch with `--env workhorse_production`. The TUI runs the same target check as the CLI.
3. In the queues view they select `billing` and ask to pause it. The TUI applies the pause only
   after they press the confirmation key.

The TUI shows tasks, queues, schedules, failures, workers, and health as switchable views that
refresh themselves. It is the "what is happening right now" tool: watch a backlog drain, watch
workers come back after a deploy, see a failure count stop growing.

Pausing a queue is durable, in contrast to pausing a worker. [Workers](310-workers.md) explains that
difference.

<details>
<summary>Reference: TUI</summary>

| Key     | Action       |
| ------- | ------------ |
| `1`–`6` | Switch views |
| `r`     | Refresh      |
| `q`     | Quit         |

- The current view re-fetches every `TUI_REFRESH_INTERVAL_MS` (5,000 ms).
- List views fetch `TUI_PAGE_SIZE` (50) rows.
- `--env <database>` runs `confirmEnvironment` at startup. Only then can the queues view stage a
  pause or resume, applied after an explicit `y`.
- Launching without an interactive stdin and stdout exits 1.

More detail: [Operations and CLI: TUI](../architecture/operations.md#tui).

</details>

## What this is not

Go back to the poisoned `emails` queue. Someone outside the on-call rotation has a copy of the
production database URL.

1. **They run `admin purge emails`** with `--actor` set to the on-call engineer's name, a reason,
   `--env`, and `--yes`.
2. **Both safety checks pass.** The database name matches, and `--yes` confirms the command.
3. **Workhorse purges the queue** and records the on-call engineer as the actor. Nothing checks who
   actually ran the command.

The terminal surface deliberately stays inside the operator APIs. It adds no authorization.
Workhorse records attribution and never checks it, exactly as everywhere else. So access to a
guarded command is access to the database URL. The [dashboard](370-dashboard-authentication.md)
supplies authentication and records a trusted actor for each mutation. Workhorse has no roles.

<details>
<summary>Reference: attribution in the terminal</summary>

- `workhorse admin` and `workhorse tui` call the public `Admin` and `Queue` operations through
  `WorkhorseAdminClient`.
- Any `--actor` value within its length limit is recorded as given. It defaults to
  `workhorse-admin`.
- The only gates on a guarded command are the `--env` check and the confirmation.

More detail: [Operations and CLI: Audit fields and request identity](../architecture/operations.md#audit-fields-and-request-identity).

</details>

## Next

- [340-redrive.md](340-redrive.md) — what a redrive actually creates
- [145-human-decisions.md](145-human-decisions.md) — how a decision boundary is answered
- [360-queue-health.md](360-queue-health.md) — the health view's underlying snapshot

---

Exact commands, flags, guard mechanics, and exit codes:
[`architecture/operations.md`](../architecture/operations.md#administrative-cli-and-tui).
