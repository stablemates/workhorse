# How do I operate a queue from the terminal?

<!-- scenario-names: workhorse_staging, emails, order-88, reserve-stock, billing-worker-1, billing, decision.json -->

An operator does not always have the dashboard. For example, the operator can be in a shell on a
bastion host, or can write a runbook script. The operator must still see what a queue does, and
must be able to stop it.

`workhorse admin` runs scripts and single commands. `workhorse tui` shows a live view in the
terminal. The two tools use the same client and the same safety checks. Thus, what you learn in one
tool is also true in the other tool.

## Inspect a queue without risk

**Example.** At 02:00, an on-call engineer gets an alert: payments on the queue `billing` fail. The
engineer opens a shell on the bastion host.

1. The engineer runs `admin failures --queue billing` and gets a table of the newest failures.
2. The engineer needs the task IDs for a script, and adds `--json`. The output is the same object
   that the TypeScript operator API returns.
3. No command changed the queue. Thus, the engineer did not name the database or confirm anything.

These inspection commands only read:

- `admin tasks`
- `admin task`
- `admin timeline`
- `admin checkpoints`
- `admin waits`
- `admin external-waits`
- `admin failures`
- `admin queues`
- `admin schedules`
- `admin workers`
- `admin maintenance`

You can run them on production, as you run `queue.health` from code.

Each command gives its answer in two formats. By default, it shows a table for a person at a
terminal. With `--json`, it gives the result of the API. A script that reads this output reads the
documented shape, not a private format of the CLI.

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

## Read a long list page by page

**Example.** The list of failures on `billing` is longer than one page.

1. The first answer ends with a `nextCursor` object. The text output also shows it.
2. The engineer gives that object to `--cursor`, with the same `--queue billing` filter.
3. The command shows the next page.
4. To see only the time of the incident, the engineer adds `--finished-after` and
   `--finished-before`. Each value has a timezone.

`admin tasks`, `admin timeline`, and `admin failures` accept `--cursor` with the `nextCursor`
object of the previous answer. Keep the same filters on each page. PostgreSQL rejects a cursor of
the task list if the filters change.

To show only the time of an incident, use `--created-after` and `--created-before` on tasks. Lists
of failures accept `--finished-after`, `--finished-before`, repeated `--tag`, and `--error-name`. A
time filter must have a timezone. The lower bound is included, and the upper bound is not included.

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

## Find what a stopped task waits for

A durable handler can stop for a correct reason. It can be between two checkpoints. It can wait for
a durable timer. It can wait for a person or for an external system. From the outside, these cases
look the same: the task does not finish.

**Example.** The task `order-88` did not finish in one hour. Three commands show why.

1. `admin checkpoints order-88` shows the checkpoints that the handler completed. It completed
   `reserve-stock`, so the handler ran.
2. `admin waits order-88` shows the durable timer waits of the task and when each wait ends. The
   task has none.
3. `admin external-waits` lists each task that waits for a person or an external system.
4. `order-88` is in the list, with a pending human decision named `approval`.

`admin checkpoints` and `admin waits` show the records of one task. If you know the name of one
record, give it with `--name`.

`admin external-waits` answers a question about all tasks: which tasks wait for an answer? It lists
pending human decisions and pending signal waits together, oldest first. The oldest wait is usually
the nearest to its time limit. A human decision shows the context that its handler recorded. This
is the text that the person who decides must read.

```sh
workhorse admin external-waits --json | jq '.human.items[] | {taskId, name, context}'
```

A long list has pages. Each `--json` answer has the cursor for its own list. Give that cursor to the
next call. The dashboard uses the same pages, so the two tools show the waits of a busy queue in the
same way.

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

## Name the target database before a change

A frequent operator error is the correct command on the incorrect database. A shell keeps the
environment of the work that you did one hour before. Thus, a command that changes data must name
its database.

**Example.** One hour ago, an engineer tested a fix on staging. The shell still has a
`DATABASE_URL` that points to `workhorse_staging`. Now the engineer wants to redrive a failed task
in production.

1. The engineer runs `admin redrive` with `--env workhorse_production`.
2. The client asks the database for its name. The answer is `workhorse_staging`.
3. The names are different, so the command changes nothing. It shows what it refused and why.
4. The engineer corrects the URL and runs the command again with `--yes`. The names are the same,
   and the redrive occurs.

These guarded commands change a live system:

- `admin cancel`
- `admin redrive`
- `admin pause`
- `admin resume`
- `admin purge`
- `admin set-tier`
- `admin set-history`
- `admin pause-worker`
- `admin resume-worker`
- `admin redrive-many`
- `admin repair-dependencies`
- `admin signal`
- `admin complete-human`

A guarded command has two separate checks:

1. **The database name.** `--env` must give the name of the database. The client compares it with
   the database that it connected to. No flag stops this check.
2. **The confirmation.** In an interactive session, you type the task ID, queue name, or worker ID
   again. In a script, you give `--yes`. Thus, the author of the script decides that the command can
   run without a person.

```sh
workhorse admin redrive 7d9f… --env workhorse_production --reason "upstream fixed" --yes
```

A redrive records who asked for it and why. It also has a request identity. If a runbook step runs
again, give the same `--request-id`. The command then returns the first target. This is the
[redrive](340-redrive.md) contract of the public `Admin` client. The CLI adds no other behavior. A
queue pause or resume also must have a reason, and it keeps the audit identity of the request.

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

## Answer a wait

`admin signal` sends a signal to a task. `admin complete-human` completes a
[human decision](145-human-decisions.md). Each command selects a task and its wait with `--name`.

**Example.** The task `order-88` waits for the decision `approval`. The answer of the approver is
in `decision.json`.

1. The engineer runs `admin complete-human` with the task, `--name approval`, and
   `--payload-file decision.json`. The engineer gives `--request-id` and `--actor` to identify the
   delivery.
2. The network fails before the engineer sees the result. The engineer does not know if the answer
   arrived.
3. The engineer runs the same command again, with the same request identity, actor, and payload.
4. The first delivery arrived, so this one succeeds as a duplicate. Workhorse does not answer the
   decision two times.

Give the answer with `--payload-json` or `--payload-file`.

```sh
workhorse admin complete-human "$TASK_ID" --name approval --payload-file decision.json \
  --request-id "$DELIVERY_ID" --actor oncall --env workhorse_production --yes
```

If you do not know if a delivery arrived, send it again with the same request identity, actor, and
payload. An exact duplicate succeeds and does not answer again. A different answer fails. A wait
that is not available also fails.

<details>
<summary>Reference: signal and human-wait delivery</summary>

Both commands require `--name`, `--request-id`, and exactly one of `--payload-json` or
`--payload-file`. The file holds UTF-8 JSON. The commands accept any JSON value, including `null`.

The CLI passes `--actor` as `requestedBy` and `--request-id` as `idempotencyKey` to
`Queue.sendSignal` or `Queue.completeHumanWait`. These commands record no reason.

| Outcome                                                                       | Exit    |
| ----------------------------------------------------------------------------- | ------- |
| `delivered`, `completed`, `duplicate`                                         | Success |
| `not_found`, `not_waiting`, `already_delivered`, `already_completed`, `stale` | 1       |

A conflict also fails, and the accepted answer stays.

More detail: [Operations and CLI: Signal and human-wait delivery](../architecture/operations.md#signal-and-human-wait-delivery).

</details>

## Recover a backlog of failed tasks

`admin redrive-many` redrives many failed tasks, one page at a time. It uses the same filters as
`admin failures`. Before you change data, preview the page with `--dry-run`.

**Example.** The payment provider is available again after an outage. The queue `billing` holds
hundreds of failures with the error name `ProviderError`.

1. The engineer runs `admin redrive-many` with the filters and `--dry-run`. The command shows the
   tasks that it can redrive. It creates nothing and writes no audit.
2. The engineer removes `--dry-run` and adds `--env`, the confirmation, and a `--request-id`.
3. The command recovers one page of tasks, oldest first.
4. The engineer gives the returned `nextCursor` to `--cursor`, with the same filters and request
   identity. The engineer continues until no cursor comes back.

A preview must have a reason. It does not need the database name or the confirmation.

```sh
workhorse admin redrive-many --queue billing --error-name ProviderError \
  --reason "provider restored" --dry-run --json
```

Recovery starts with the oldest task. Thus, its cursor is for recovery, not for the list of
failures, which starts with the newest task. Each call processes its own page. A preview does not
reserve the tasks that it shows.

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

## Empty a queue

`admin purge` empties a queue. It deletes the tasks. It does not cancel them. Use it when the tasks
in a queue cannot succeed.

**Example.** A bad deploy filled the queue `emails` with tasks. Their payloads make each handler
crash.

1. The engineer runs `admin purge emails` with a reason, `--env`, and the confirmation.
2. Workhorse deletes the waiting tasks in `emails`. The tasks that workers run now stay.
3. The command shows how many tasks it deleted.
4. The runbook step times out and runs again with the same request identity. The command shows the
   result of the first purge again and deletes nothing more.

If you use the same request identity with different audit fields, Workhorse refuses the purge.

<details>
<summary>Reference: purge</summary>

- `purge_queue_v1` deletes runtimes in `blocked`, `ready`, and `scheduled`, with their identities and
  history. It leaves `active` tasks. On the fast tier it deletes `ready` rows.
- The command prints the deleted row count. Under `--json` it emits `deletedCount` beside `queue`.
- A reused request identity with different audit fields raises `PurgeIdempotencyConflictError`. The
  CLI prints `Refused:` and exits 1.

More detail: [Operations and CLI: Purge](../architecture/operations.md#purge).

</details>

## Take one worker out of service

Sometimes the queue is correct, but one worker has a problem. For example, the host is bad, the
process uses too much memory, or a deploy reached one host first.

**Example.** The worker `billing-worker-1` times out on each call to a slow payment provider.

1. The engineer finds the worker ID in `admin workers` and runs
   `admin pause-worker billing-worker-1` with a reason.
2. Workhorse records the pause in the worker registry. `admin workers` shows the pause at once, and
   who paused the worker.
3. `billing-worker-1` stops claiming when it next registers. The command does not send a message to
   the process.
4. After the provider is fast again, `admin resume-worker billing-worker-1` lets the worker claim
   again.

The pause is in the worker registry. The command does not connect to a running process. A worker
reads the pause when it next registers. [Workers](310-workers.md) tells what an operator pause
survives and what it does not survive.

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

## Watch the fleet in the TUI

`workhorse tui` shows tasks, queues, schedules, failures, workers, and health. Each view refreshes
itself. Use it to see what occurs now: a backlog that decreases, workers that come back after a
deploy, or a failure count that stops.

**Example.** During the `billing` incident, the engineer starts `workhorse tui` to watch the queue.

1. The engineer starts the TUI without `--env`. The title bar shows that the session is read-only.
2. The engineer can change views and refresh, but cannot change data.
3. The engineer starts the TUI again with `--env workhorse_production`. The TUI does the same check
   of the database name as the CLI.
4. In the queues view, the engineer selects `billing` and pauses it. The TUI applies the pause only
   after the engineer presses the confirmation key.

A queue pause is durable, but a worker pause is not. [Workers](310-workers.md) explains this
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

## Change the tier of a queue

`admin queues` shows the tier of each queue and the history that it records. A full-tier queue
records all history. For a fast-tier queue, the command shows the history that an operator turned
on, or `none`.

**Example.** The handlers of the queue `emails` never suspend. The team moves the queue to the fast
tier.

1. The engineer runs `admin set-tier emails --tier fast` while tasks are live. Workhorse refuses,
   and the command changes nothing.
2. After the queue has no live tasks, the engineer runs the command again. Workhorse moves the
   queue.
3. The engineer turns on `--record-attempts` with `admin set-history`. The claims setting does not
   change.

`admin set-tier` calls `Admin.setQueueTier`, so it has the same checks. Workhorse refuses the change
while the queue holds live tasks. Workhorse refuses the fast tier while a policy names the queue.

```sh
workhorse admin set-tier emails --tier fast --reason "handlers never suspend" \
  --env workhorse_production --yes
```

`admin set-history` turns `--record-attempts` or `--record-claims` on or off. If you do not give a
flag, its setting does not change. Workhorse records no audit for this change, so the command takes
no reason. A full-tier queue records all history already. Thus, for a full-tier queue, the command
tells you that the switches apply after a move to the fast tier. Workhorse also accepts a queue name
that it does not know. Thus, the command shows a warning if no known queue has that name.
[The fast tier](305-fast-tier.md) tells what each switch writes.

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

## Repair dependency counters

Workhorse keeps a counter of open prerequisites on each blocked dependent task. If that counter is
different from the dependency edges, the dependent task can wait permanently.

**Example.** A dependent task waited all day. Its prerequisites finished in the morning.

1. The engineer runs `admin repair-dependencies --dry-run`. The command lists the incorrect
   dependent task and the change that a repair makes. It writes nothing and needs no confirmation.
2. The engineer runs the command again without `--dry-run`, with a reason and `--env`.
3. In the interactive session, the engineer types `dependencies` to confirm.
4. The command shows what it did to each dependent task. Each repair event records who asked and
   why.

```sh
workhorse admin repair-dependencies --dry-run
```

You can run the repair again safely. It finds only the counters that are incorrect again.
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

## What the terminal does not check

The terminal tools use the operator APIs and add no authorization. Workhorse records who did an
action, but it does not check that identity.

**Example.** A person outside the on-call team has a copy of the URL of the production database.

1. The person runs `admin purge emails` with the name of the on-call engineer in `--actor`. The
   person also gives a reason, `--env`, and `--yes`.
2. The two safety checks pass. The database name is correct, and `--yes` confirms the command.
3. Workhorse purges the queue and records the on-call engineer as the actor.
4. Nothing checks who ran the command.

Thus, access to the database URL gives access to each guarded command. The
[dashboard](370-dashboard-authentication.md) adds authentication and records a trusted actor for
each change. Workhorse has no roles.

<details>
<summary>Reference: attribution in the terminal</summary>

- `workhorse admin` and `workhorse tui` call the public `Admin` and `Queue` operations through
  `WorkhorseAdminClient`.
- Workhorse records any `--actor` value within its length limit as given. It defaults to
  `workhorse-admin`.
- The only gates on a guarded command are the `--env` check and the confirmation.

More detail: [Operations and CLI: Audit fields and request identity](../architecture/operations.md#audit-fields-and-request-identity).

</details>

## Next

- [340-redrive.md](340-redrive.md) — what a redrive creates
- [145-human-decisions.md](145-human-decisions.md) — how to answer a human decision
- [360-queue-health.md](360-queue-health.md) — the snapshot that the health view shows

---

Exact commands, flags, guard mechanics, and exit codes:
[`architecture/operations.md`](../architecture/operations.md#administrative-cli-and-tui).
