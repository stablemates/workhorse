# How do I run a task on a recurring schedule?

<!-- scenario-names: billing-production, invoice-run, weekly-cleanup, early-sync, billing -->

Some work must run at fixed times, for example each night or each hour. A schedule creates a task
for this work at each of these times. Workhorse stores each schedule definition in PostgreSQL, and
PostgreSQL evaluates it. Thus, you do not deploy or monitor a separate scheduler process, and you do
not install a PostgreSQL extension. Any number of workers can evaluate one schedule, and Workhorse
still creates one task for each time.

An occurrence is one time at which a schedule is due. A namespace is a name for one set of schedule
definitions. A worker does maintenance work at a fixed interval, and one run of this work is a
maintenance tick. At each tick, a worker evaluates the namespaces that it offers. If an occurrence
is due, the schedule fires: Workhorse creates a task for the occurrence.

## Declare your schedules when you deploy

**Example.** The billing service has two schedules in the namespace `billing-production`:
`invoice-run` and `weekly-cleanup`. The service deploys three times.

1. Deploy 1 lists both definitions. Workhorse creates both. Each schedule waits for its first
   occurrence after the deploy.
2. Deploy 2 lists only `invoice-run`. Workhorse does not change `invoice-run`. It disables
   `weekly-cleanup`, but it keeps the row.
3. Deploy 3 lists both definitions again, with a new cron expression for `invoice-run`. Workhorse
   enables `weekly-cleanup` again and updates `invoice-run`.

Workhorse keeps the row of a disabled definition, so the tasks that it created still point to a
definition. Each change to a definition gives it a new revision. A revision is a number that
increases with each change.

To declare your schedules, call `queue.syncSchedules` with all the definitions of one namespace.
Make this call each time that you deploy.

```ts
await queue.syncSchedules(
  "billing-production", // namespace
  [
    {
      name: "invoice-run",
      schedule: nightlyCron,
      timezone: "America/New_York",
      catchupPolicy: "skip",
      task: { type: "invoice.generate", queue: "billing", payload: { scope: "due" } },
    },
  ],
  { prune: true },
);
```

Workhorse creates or updates each definition in the list. If pruning is on, Workhorse disables each
definition that is not in the list. Pruning is on by default. Workhorse does not delete a
definition.

Each `ScheduleDefinition` identifies the schedule with `name` and `schedule`. The optional fields
`timezone`, `catchupPolicy`, and `enabled` control when it fires. The `task` field describes the
task that each occurrence creates: its `type` and `payload`. Optional task fields are `queue`,
`priority`, `concurrencyKey`, `maxAttempts`, and `retryPolicy`.

The namespace keeps the schedules of one deployment apart from the schedules of other deployments.
Thus, two services that share a database do not disable the definitions of each other.

Workhorse checks every definition before it writes a row. If one cron expression is not valid, the
full call fails, and Workhorse changes nothing. To add definitions and keep the definitions that the
list omits, set `prune` to false. Normally, the deploy sends all the definitions of the namespace,
so your code controls the schedules.

<details>
<summary>Reference: definitions and synchronization</summary>

**`Queue.syncSchedules(namespace, definitions, options)`**

| Field                 | Rule                                                     |
| --------------------- | -------------------------------------------------------- |
| `name`                | Required. Unique within the namespace.                   |
| `schedule`            | Required. A cron expression in the Workhorse dialect.    |
| `timezone`            | Optional. A valid IANA name. Default `"UTC"`.            |
| `catchupPolicy`       | Optional. `skip`, `latest`, or `all`. Default `skip`.    |
| `enabled`             | Optional. Default `true`.                                |
| `task.type`           | Required.                                                |
| `task.payload`        | Required.                                                |
| `task.queue`          | Optional. Default: the `Queue` instance's default queue. |
| `task.priority`       | Optional. An integer from 0 to 100. Default 0.           |
| `task.concurrencyKey` | Optional. 1 to 256 UTF-8 bytes.                          |
| `task.maxAttempts`    | Optional. An integer from 1 to 100. Default 25.          |
| `task.retryPolicy`    | Optional. Normalized like an enqueue retry policy.       |
| `options.prune`       | Optional. Default `true`.                                |

Python exposes `sync_schedules`, and Go exposes `SyncSchedules`.

**Synchronization.** The SDK first validates each payload against the current payload contract of
its task type. `sync_schedule_definitions_v2` then validates every definition before it writes any
row. The definition stores that contract version and its size and redaction settings. A fire copies
them into the task, so a later deploy cannot reinterpret an existing definition.

- Any change to a definition increments its `revision` once.
- Pruning sets `configured_enabled = false` and increments the revision. It never deletes the row.
- A new definition starts its position at the synchronization time. So does a definition whose
  cron expression, timezone, or catch-up policy changed. A `skip` definition that a deploy enables
  again starts there too.

More detail: [Data model: Synchronization](../architecture/data-model.md#synchronization-3).

</details>

## Let workers offer schedule namespaces

**Example.** The workers of the billing service start with an empty namespace list.

1. At 01:00, Deploy 1 synchronizes `billing-production`. No worker evaluates the namespace.
2. At 01:30, Deploy 2 adds `billing-production` to the namespace list of one worker.
3. At 02:00, `invoice-run` is due.
4. At its next maintenance tick, the worker evaluates `billing-production`.
5. Workhorse creates the task for the 02:00 occurrence.

Workhorse has no scheduler process. A worker evaluates the namespaces that you list, as part of its
maintenance. To make a TypeScript worker offer a namespace, set `scheduleNamespaces`. Python workers
use `schedule_namespaces`, and Go workers use `WorkerOptions.ScheduleNamespaces`.

```ts
const worker = new Worker(queue, { scheduleNamespaces: ["billing-production"] });
```

A worker with an empty list fires no schedule. Configure at least one worker to offer each
namespace that you synchronize. If no worker offers a namespace, its schedules do not fire.

Each worker asks PostgreSQL to evaluate the namespaces that it offers. PostgreSQL evaluates every
definition. Thus, every SDK uses the same cron parser and the same stored IANA timezone. The
Schedules page shows how many live workers offer each namespace.

<details>
<summary>Reference: worker options</summary>

A worker offers no namespace by default, so it fires no schedule.

| SDK        | Option                             |
| ---------- | ---------------------------------- |
| TypeScript | `scheduleNamespaces`               |
| Python     | `schedule_namespaces`              |
| Go         | `WorkerOptions.ScheduleNamespaces` |

Every runtime calls `fire_due_schedules_v2` on its maintenance cadence, with a null `now`. The
catch-up limit is also a worker option, as the catch-up reference shows.

More detail: [Data model: Namespace locking](../architecture/data-model.md#namespace-locking).

</details>

## Choose what happens after a gap

If no worker evaluates a namespace for some time, its schedules miss occurrences. The catch-up
policy of a schedule controls what Workhorse does with these missed occurrences.

**Example.** `invoice-run` is due each night at 02:00.

1. On Monday at 01:30, every worker that offers `billing-production` stops.
2. On Monday, Tuesday, Wednesday, and Thursday, no worker fires the 02:00 occurrence.
3. On Thursday at 09:00, the workers start again.

The result of each catch-up policy is different:

- **`skip`.** Workhorse fires none of the missed occurrences. The next task is for Friday at 02:00.
- **`latest`.** Workhorse fires one task, for Thursday at 02:00.
- **`all`.** Workhorse fires four tasks, one for each missed occurrence.

By default, Workhorse skips missed occurrences. A worker evaluates only its current maintenance
interval, and then waits for the next occurrence. Thus, a pause or a worker outage does not make a
backlog of tasks.

Set `catchupPolicy` to `latest` if one current task can replace the missed work. Set it to `all` if
each occurrence must create a task. The catch-up limit of the worker sets the maximum number of
tasks in one `all` evaluation. Later evaluations continue until no missed occurrence remains.

<details>
<summary>Reference: catch-up policies</summary>

| Policy   | Occurrences one pass fires                                                   |
| -------- | ---------------------------------------------------------------------------- |
| `skip`   | Those newer than both the durable position and `now - evaluation_window_ms`. |
| `latest` | The newest occurrence after the durable position.                            |
| `all`    | Those after the durable position, in order, up to the catch-up limit.        |

The evaluation window is the maintenance interval of the worker. An `all` pass that reaches the
limit advances the position only to its last occurrence.

| SDK        | Catch-up policy                     | Catch-up limit                       |
| ---------- | ----------------------------------- | ------------------------------------ |
| TypeScript | `ScheduleDefinition.catchupPolicy`  | `scheduleCatchupLimit`               |
| Python     | `ScheduleDefinition.catchup_policy` | `schedule_catchup_limit`             |
| Go         | `ScheduleDefinition.CatchupPolicy`  | `WorkerOptions.ScheduleCatchupLimit` |

The policy defaults to `skip`. The limit accepts 1 to 10,000 and defaults to 100.

More detail: [Data model: Firing due schedules](../architecture/data-model.md#firing-due-schedules) and [Data model: SDK options](../architecture/data-model.md#sdk-options).

</details>

## Set the timezone of a schedule

A cron expression gives a local time in the timezone of the definition. When local clocks change
for daylight saving time, some local times do not occur, and some occur two times.

**Example.** `invoice-run` uses `0 2 * * *` in `America/New_York`. `early-sync` uses `30 1 * * *` in
the same timezone.

1. On the spring change, local clocks move from 02:00 to 03:00. Workhorse fires `invoice-run` at
   03:00 local time.
2. On the autumn change, local clocks move from 02:00 back to 01:00. 02:00 occurs one time, so
   Workhorse fires `invoice-run` normally.
3. On the same night, 01:30 occurs two times. Workhorse fires `early-sync` only at the first 01:30.

Store the correct IANA timezone on each definition. Use UTC unless the schedule must follow local
time, because UTC has no clock changes.

- If local clocks skip a scheduled time, Workhorse fires after the clocks move forward.
- If local clocks repeat a time, Workhorse fires only at the first occurrence of that time.
- If several cron fields give the same instant, Workhorse creates one occurrence.

An `H` field gives a schedule a fixed offset, so that schedules do not all fire at the same time.
PostgreSQL calculates this offset. Thus, workers in all languages get the same occurrence.

<details>
<summary>Reference: cron dialect</summary>

`cron_occurrences_v1(expression, last_occurrence_at, now, limit, timezone)` evaluates every
expression. It accepts five fields, or six with seconds first, and supports:

- lists, ranges, steps, and names;
- `?`, `L`, `<DOW>L`, and `<DOW>#<ordinal>`;
- `@yearly`, `@annually`, `@monthly`, `@weekly`, `@daily`, `@midnight`, and `@hourly`;
- `H` and `H(lower-upper)`, which hash `${expression}:${fieldIndex}:${tokenIndex}` with SHA-256.

A nonexistent wall time advances across the gap. A repeated wall time selects its first instant.
Occurrences have one-second precision. The search horizon is 128 years.

More detail: [Data model: Cron evaluation](../architecture/data-model.md#cron-evaluation).

</details>

## Pause a schedule from the dashboard

A schedule pause is an operator override. It stops a schedule from firing until an operator resumes
it.

**Example.** An incident occurs in the billing service at night.

1. At 01:00, an operator pauses `invoice-run` from the dashboard.
2. At 01:30, a deploy updates the definition of `invoice-run`. The schedule stays paused.
3. At 02:00, the occurrence is due, but the schedule does not fire.
4. At 06:00, the operator resumes the schedule.

The `enabled` field belongs to the deployment configuration. The Pause action of the dashboard
creates a separate operator override, so a synchronization cannot resume the schedule. If a deploy
updates, removes, or adds the definition again, the schedule stays paused. To resume the schedule,
use the dashboard.

When the operator resumes the schedule, the catch-up policy controls the 02:00 occurrence. The
position of a schedule is the last time that Workhorse evaluated for it. If the policy is `skip`,
Workhorse moves the position to the resume time, so the 02:00 occurrence does not fire. If the
policy is `latest` or `all`, the schedule keeps its old position. Then Workhorse fires the missed
occurrence, as [Choose what happens after a gap](#choose-what-happens-after-a-gap) describes.

<details>
<summary>Reference: pause override</summary>

`set_schedule_paused_v1(namespace, schedule_name, paused, requested_by, reason, occurred_at)` sets
these columns on `schedule_definition`:

- `paused`, `paused_by`, `paused_reason`, and `paused_at`. A resume clears the attribution.
- `last_evaluated_at`, the durable position. A resume of a `skip` definition sets it to the resume
  time.
- `revision`, which every pause or resume increments.

Synchronization updates `configured_enabled` and never changes the pause columns. A definition
fires only when `configured_enabled` is true and `paused` is false.

More detail: [Data model: schedule_definition](../architecture/data-model.md#schedule_definition).

</details>

## Stop a schedule or one of its tasks

A schedule and the tasks that it creates have separate lifecycles. Thus, an action on one task does
not change the schedule.

**Example.** `invoice-run` fires each night.

1. At 02:00, `invoice-run` fires. Workhorse creates an ordinary task in the queue `billing`.
2. At 02:05, an operator cancels that task.
3. On the next night at 02:00, `invoice-run` fires again.

A fired task gets the payload, the attempt budget, and the retry policy of the definition. After the
fire, the usual task rules apply: at-least-once delivery, retries, and cancellation.

To stop future occurrences, pause the schedule from the dashboard. If the deployment must own the
change, set `enabled` to false and synchronize the namespace.

These calls are also available:

- `Admin.schedules` reads the stored definitions and their last occurrence, for operator tools.
- `Admin.runTaskNow` makes one task that waits for its run time ready immediately. It records the
  actor, the reason, and the request identity, as the other operator controls do.
- `Queue.fireSchedule` fires one occurrence with a revision check, for tests and controlled
  integrations.

<details>
<summary>Reference: fired tasks and schedule controls</summary>

| Fired task field      | Source                                                     |
| --------------------- | ---------------------------------------------------------- |
| Queue and task type   | The schedule definition.                                   |
| Payload               | The payload of the definition.                             |
| Attempt budget, retry | The attempt budget and the retry policy of the definition. |

| To stop future occurrences | Owner          | Call                                        |
| -------------------------- | -------------- | ------------------------------------------- |
| Pause from the dashboard   | An operator    | The Pause action of the dashboard           |
| Disable in code            | The deployment | `ScheduleDefinition.enabled`, then sync     |
| Cancel one fired task      | An operator    | Cancels that task only; the schedule stays. |

`fire_due_schedules_v2` fires only definitions whose `configured_enabled` is true and `paused` is
false. `fire_schedule_v1` repeats both checks under the definition row lock.

`Admin.runTaskNow` calls `run_task_now_v1(task_id, requested_by, reason, request_id)`. It releases
an ordinary future-scheduled task and does not change its recurring definition.

More detail: [Data model: Firing due schedules](../architecture/data-model.md#firing-due-schedules)
and [Data model: Running a task now](../architecture/data-model.md#running-a-task-now).

</details>

## Expect each task soon after its occurrence

A worker evaluates schedules only at its maintenance tick. Thus, a schedule fires soon after its
occurrence, not exactly at it.

**Example.** `invoice-run` is due at 02:00:00.

1. At 02:00:00, the occurrence is due.
2. Soon after, a worker that offers `billing-production` starts its next maintenance tick.
3. The worker evaluates the namespace, and Workhorse creates the task.

Schedules give durable recurring work. They are not real-time alarms.

A schedule fires only while a worker that offers its namespace runs. If no worker runs, no schedule
fires. When workers start again, the catch-up policy controls the missed occurrences.

PostgreSQL supplies the time for each evaluation, because the clocks of workers can differ. Thus, a
worker with a fast clock does not fire a schedule early. A worker with a slow clock does not move a
schedule back.

If another transaction holds an occurrence, Workhorse delays that occurrence. It does not skip it.
For example, an operator fires the 02:00 occurrence manually, and the transaction does not commit.
A tick at that time leaves 02:00 and all later occurrences for the next tick. If the manual
transaction rolls back, the next tick creates the task.

<details>
<summary>Reference: clock and busy occurrences</summary>

- A null `now` means `clock_timestamp()`. Every SDK passes null.
- `fire_due_schedules_v2` takes the advisory lock of each occurrence before it fires it.
- A busy occurrence lock ends the pass for that definition. The pass reports no row for it,
  evaluates nothing after it, and leaves `last_evaluated_at` at the last occurrence it evaluated.
- A pass that defers before its first occurrence writes no row.

More detail: [Data model: Busy occurrences](../architecture/data-model.md#busy-occurrences).

</details>

## See schedules in the dashboard

The Schedules page shows each application schedule and each Workhorse routine. Use it to find
schedules that no worker evaluates.

The page lists `invoice-run` with its queue, its evaluator count, and a Pause action. The evaluator
count is the number of live workers that can evaluate the namespace. To see the tasks of that type
in that queue, open the run count. The task list opens in a new browser tab. If the deployment
disabled a definition, the page shows `Config off`. A paused definition does not show `Config off`.

A routine is maintenance work that runs directly in PostgreSQL and creates no task. The page lists
the routines beside the application schedules. The last-run value of a routine records that direct
run. To see recent outcomes, durations, affected rows, phase timings, and errors, expand the row of
the routine.

The row shows the total number of retained runs. The expanded history shows a recent subset. The
page also states the rule for tick records: Workhorse records tick errors immediately, and it
samples successful ticks that change tasks. Workhorse records each eligible run of the other
routines.

<details>
<summary>Reference: Schedules page</summary>

**Application schedules.** `dashboard_cron_v1` returns at most 50 definitions.

- `evaluatorCount` counts worker registrations whose `schedule_namespaces` contain the namespace and
  whose `last_heartbeat_at` is at most 30 seconds old.
- The run count links to `/tasks?queue=<queue>&type=<task type>`. The task listing has no schedule
  filter.
- A deployment-disabled definition shows `Config off`. A paused definition does not show it.

**Maintenance routines.** The page lists `tick`, `history_partitions`, `history_retention`, and
`terminal_storage`. Each shows its retained run total and its five newest `maintenance_run` rows.

`maintenance_run` keeps the newest 50 executions per routine. Slow routines record every eligible
execution. `tick_v1` records only executions that return a phase error or affect at least one task.
It records errors immediately and samples successful task-changing executions at most once per
minute.

More detail: [Dashboard: Schedules page](../architecture/dashboard.md#schedules-page) and
[Data model: Run history](../architecture/data-model.md#run-history).

</details>

## Run many workers without duplicate tasks

Many workers can offer the same namespace at the same time. Workhorse still creates one task for
each occurrence.

**Example.** Three workers offer `billing-production`. At 02:00, the `invoice-run` occurrence is
due. All three workers start their maintenance tick in the same second.

1. Worker A gets the namespace first. It reserves the 02:00 occurrence and creates the task.
2. Worker B finds that the namespace is busy. It skips the namespace on this tick.
3. Worker C evaluates the namespace after worker A commits. The 02:00 occurrence already exists, so
   worker C fires nothing.

Each fire writes a durable key from the namespace, the schedule name, and the occurrence time. The
first fire that reserves the key creates the task. A later fire with the same key creates no task,
so it gets no task ID. For example, a manual `fireSchedule` call for 02:00 gets no task ID.

You do not have to choose a leader or run exactly one scheduler. Any number of workers can evaluate
one namespace at the same time, and Workhorse creates one task.

PostgreSQL coordinates each namespace separately. Thus, workers with different namespaces do not
wait for each other. Workers do not keep private copies of the definitions. Thus, all workers that
offer one namespace evaluate the same definitions.

<details>
<summary>Reference: occurrence keys and namespace locks</summary>

**Occurrence key.** `schedule_occurrence` holds one row per `(namespace, schedule_name,
occurrence_at)`, at one-second precision. `fire_schedule_v1` inserts that row and enqueues the task
in one transaction. The task is ready at once.

**Repeated fire.** `fire_schedule_v1` returns null for an occurrence already fired. Only the call
that creates the task reports a fire.

**Namespace lock.** `fire_due_schedules_v2` tries one transaction advisory lock per namespace. A
caller that finds the lock held skips that namespace and does not wait.

More detail: [Data model: Namespace locking](../architecture/data-model.md#namespace-locking).

</details>

## Deploy while a worker evaluates the namespace

A deploy can synchronize a namespace while a worker evaluates it. Workhorse makes the two operations
run one after the other, so the deploy causes no duplicate task.

**Example.** At 02:00:00, worker A starts to evaluate `billing-production`. At the same time, a
deploy calls `syncSchedules` for the same namespace.

1. The synchronization waits until the evaluation of worker A commits.
2. The synchronization writes the new definitions. Each changed definition gets a new revision.
3. The tick of worker B starts while the synchronization is open. Worker B skips the namespace.
4. At its next tick, worker B evaluates the new definitions.

The synchronization of a deploy and the evaluation of one namespace by a worker never overlap. This
rule also applies to a rolling deployment.

Each fire states the revision that it read. PostgreSQL creates the occurrence only if the definition
still has that revision. If a deploy changed or disabled the definition after the read, the fire
does nothing. This rule also applies to a direct `fireSchedule` call with an old revision.

<details>
<summary>Reference: synchronization lock and revision fence</summary>

- `sync_schedule_definitions_v2` takes `pg_advisory_xact_lock` on
  `workhorse:schedule-namespace:<namespace>` before it reads or writes a definition row.
- A tick only tries that lock. A synchronization waits for it.
- Two synchronizations of one namespace run one after the other.
- `fire_schedule_v1(namespace, schedule_name, expected_revision, occurrence_at)` locks the
  definition row. It returns null unless the row is enabled, not paused, and still at
  `expected_revision`.
- A pause or resume also increments the revision.

A caller that locks definition rows in its own transaction before it synchronizes can still
deadlock with a tick.

More detail: [Data model: Namespace locking](../architecture/data-model.md#namespace-locking).

</details>

## Next

- [210-enqueue-idempotency.md](210-enqueue-idempotency.md) — use the same deduplication idea for
  enqueue
- [310-workers.md](310-workers.md) — configure the processes that offer schedule namespaces
- [120-cancellation.md](120-cancellation.md) — cancel one occurrence

---

Exact reconciliation and revision rules:
[`architecture/data-model.md`](../architecture/data-model.md#declarative-schedules).
