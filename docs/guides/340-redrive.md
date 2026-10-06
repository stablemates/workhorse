# How do I run a failed task again?

<!-- scenario-names: payments, charge-4711, charge-9020, charge-9311, r-77, outage-0314 -->

A task used up all its attempts and gave up. Later you discover the API it was calling had been
down for an hour. The task would work fine now.

Redriving is an operator saying: make me a fresh copy of this task and run it. TypeScript, Go,
Rust, and Ruby application code make that request through `Admin`. Python uses `Admin` or
`AsyncAdmin`. Each operator client stays separate from the application-shaped `Queue` client. An
operator without a terminal asks for the same thing from the dashboard, in the listing that shows
the failed tasks, one task or one filtered batch at a time.

## Dead letters

On Monday the payment provider is down for an hour. On queue `payments`, task `charge-4711` runs
out of attempts during the outage. Workhorse does not delete it. The task becomes a failed outcome
with its last error attached. On Tuesday you open the list of failed tasks for `payments`.
`charge-4711` is there, beside every other task that failed. The newest failures come first.

Most queues call this the dead letter queue. In Workhorse it is just the set of failed tasks. You
can filter it and page through it to see what has accumulated.

Running out of attempts is the common way in, but not the only one. Some failures end a task while
attempts remain. Suppose a handler saves a different value under a checkpoint name it already used.
That is a durable replay conflict, and the worker fails the task without a retry. Such tasks are in
the same set.

Workhorse keeps that listing off the dispatch path. Full-tier failures have their own index, which
claim never reads. Dead-letter growth therefore does not enlarge the dispatch indexes. Database load
and storage health can still affect both paths.

<details>
<summary>Reference: dead-letter listing</summary>

`Admin.listDeadLetters(query)` calls `list_dead_letters_v1(p_filter, p_limit, p_cursor_finished_at,
p_cursor_task_id)`.

| Input   | Rule                                                                    |
| ------- | ----------------------------------------------------------------------- |
| Filter  | `queue`, `type`, `tags`, `errorName`, `finishedAfter`, `finishedBefore` |
| `limit` | 1 through 1,000 (`MAX_REDRIVE_BATCH_SIZE`). Default 100.                |
| Cursor  | `(finished_at, task_id)` of the previous page's last row                |

- Order is newest-first: `finished_at DESC, task_id DESC`.
- The listing covers failed outcomes of both tiers.
- Each row carries `redriveCount`, the number of redrives of that task.
- The payload is redacted by the task's declared redaction keys.
- A worker settles a durable replay conflict (`CheckpointConflictError`, `WaitConflictError`,
  `ChildConflictError`, or `HumanWaitConflictError`) with `fail_v1` and `p_retry_delay_ms = -1`.
  That fails the task even when `current_attempt < max_attempts`.
- `task_outcome_failed_finished_idx` is a partial index on `(finished_at DESC, task_id DESC)` where
  `state = 'failed'`. It is not a dispatch path.

More detail: [Data model: Dead-letter index](../architecture/data-model.md#dead-letter-index) and [Schema and SQL protocol: Durable replay conflicts](../architecture/schema-and-protocol.md#durable-replay-conflicts).

</details>

## A new task, not a resurrection

You redrive `charge-4711`.

1. **The request.** You pass the task ID, your name, a reason, and a request ID.
2. **The copy.** Workhorse creates a new task, `charge-9020`, with the same queue, type, and
   payload. It is `ready` at once, on attempt 1, with no deadline.
3. **The link.** In the same transaction, Workhorse records that `charge-9020` came from
   `charge-4711`. It appends an event to each task.
4. **The run.** A worker claims `charge-9020` and charges the card.

Redriving does **not** restart the old task. `charge-4711` stays failed, with its error, as evidence.
Its error stays readable until [retention](330-retention.md) retires it.

The new task copies what defines the work: queue, type, payload, tags, attempt budget, retry policy,
and execution timeout. It deliberately does not copy the wreckage. It gets no checkpoints, no waits,
no attempt count, and no old error. It does not get the original deadline either. A deadline that
already passed would make the copy fail at once, which is never what you meant.

Dependency edges, child lineage, signal deliveries, and human decisions stay with the old identity.
See [dependencies](160-task-dependencies.md), [children](170-child-tasks.md),
[signals](135-signals.md), and [human decisions](145-human-decisions.md) for those lifecycles.

<details>
<summary>Reference: redrive_v1</summary>

`Admin.redrive(sourceTaskId, { actor, reason, requestId })` calls `redrive_v1`. It accepts only a
retained failed source.

**Copied:** queue, type, priority, concurrency key, budget name, payload, accepted contract version,
payload and result size limits, redaction keys, tags, `max_attempts`, retry policy, and execution
timeout.

**Not copied:** the absolute deadline, dependency edges, child lineage, checkpoints, waits, signal
deliveries, attempts, results, and cancellation state.

The target starts `ready` with `run_at` now and attempt 1. It takes its queue's current tier. A
fast-tier queue rejects a copy that carries a concurrency key or a budget.

| `status`     | When                                                  |
| ------------ | ----------------------------------------------------- |
| `redriven`   | A new target was created.                             |
| `replayed`   | The same source and request ID already made a target. |
| `not_found`  | No retained task has this ID.                         |
| `not_failed` | The source exists but is not `failed`.                |
| `eligible`   | Bulk dry run only. The source would be redriven.      |

**Events.** The source gets `redriven`, with the target ID. The target gets `redrive_created`, with
the source ID. Both record the actor, reason, request ID preview and digest, and request time.

The source outcome's terminal columns are never updated.

More detail: [Data model: redrive_v1](../architecture/data-model.md#redrive_v1).

</details>

## Why a link and not a copy

The redriven `charge-9020` fails too, because the provider had a second outage. You redrive it
again and get `charge-9311`. Now the chain is `charge-4711` to `charge-9020` to `charge-9311`.
From any of the three, you can walk the chain back to the original failure and read its error.

Every redriven task records where it came from. [Retention](330-retention.md) keeps that lineage
intact. It does not delete `charge-4711` while a descendant remains. When the descendant goes, its
link goes with it, and the ancestor becomes eligible under the normal windows.

<details>
<summary>Reference: lineage and retention</summary>

`task_redrive` is insert-only. One row per edge records:

- source and target task IDs;
- the request ID preview, digest, and length, never the raw ID;
- actor, reason, and the request fingerprint;
- source state `failed`, target initial state `ready`, and request time.

A unique target means every new task has one parent.

`Admin.getRedriveLineage(taskId, limit)` walks the retained connected graph. `limit` is 1 through
1,000, default 1,000. The result has `records` and a `truncated` flag.

**Retention.** Terminal identity pruning skips any source with a retained descendant edge. Deleting
the target cascades its inbound edge.

More detail: [Data model: Lineage retention](../architecture/data-model.md#lineage-retention).

</details>

## Sending the same request twice

An operator's script redrives `charge-4711` and the network drops before the answer arrives. The
script cannot tell whether the redrive happened, so it sends the request again.

1. **The first call.** It sends request ID `r-77`. Workhorse creates `charge-9020` and commits, but
   the answer is lost. The result would have been `redriven`.
2. **The retry.** It sends the same source and the same request ID. Workhorse finds the first
   redrive and returns `charge-9020` again. The result is `replayed`. No second copy runs.

The protection holds only when the caller reuses the request ID. Keep it across retries of one
decision, and use a new one for a new decision.

Now suppose the retry sends request ID `r-77` with a different reason. Workhorse treats that as
a conflict, not a duplicate. The two requests make different claims about what happened. Silently
keeping one would lose an audit record.

<details>
<summary>Reference: request identity and conflicts</summary>

| Field       | Rule                       |
| ----------- | -------------------------- |
| `actor`     | 1 through 200 characters   |
| `reason`    | 1 through 2,000 characters |
| `requestId` | 1 through 512 UTF-8 bytes  |

- Idempotency is keyed by the source task and the SHA-256 of the request ID.
- `redrive_v1` takes a transaction advisory lock on the source and request ID, so concurrent
  repeats run one at a time.
- The fingerprint is the actor and the reason. A replay with a different fingerprint raises SQLSTATE
  `P1002`.
- TypeScript raises `RedriveIdempotencyConflictError`. Its details name `conflictingFields`
  (`requestedBy`, `reason`), the existing target, and digests of the stored and rejected requests.
- The dashboard sends a new random request ID with each confirmed redrive.

More detail: [Data model: Keys and columns](../architecture/data-model.md#keys-and-columns).

</details>

## Bulk redrive

The outage left 300 failed tasks on `payments`. You want to replay them, but the provider may still
be fragile.

1. **The dry run.** You ask for a page of 100 with `dryRun`. Workhorse lists the 100 oldest failures
   that match your filter, each marked `eligible`. It writes nothing.
2. **The first page.** You run the same request without `dryRun`, with request ID `outage-0314`.
   Workhorse redrives the 100 oldest and returns a cursor.
3. **The next pages.** You pass the cursor back, twice, and finish the backlog.

The cursor matters. A redrive leaves the source failed, so a request without the cursor selects the
same page again. With the same request ID, that page only replays.

Use the dry run before you replay a large backlog into a service that may still be unhealthy. A dry
run does not reserve its candidates.

<details>
<summary>Reference: redrive_many_v1</summary>

`Admin.redriveMany(filter, audit, { limit, dryRun, cursor })` calls `redrive_many_v1`.

| Option   | Rule                                        |
| -------- | ------------------------------------------- |
| `filter` | The dead-letter filter                      |
| `limit`  | 1 through 1,000. Default 100.               |
| `dryRun` | Returns `eligible` rows and writes nothing. |
| `cursor` | `nextCursor` of the previous bulk page      |

- Order is oldest-first: `finished_at, task_id`. Dead-letter listing pages newest-first, so use only
  a bulk page's cursor.
- Every source in the page is redriven with the same actor, reason, and request ID.
- `admin redrive-many --dry-run` writes nothing and needs no request ID. Execution requires an
  explicit `--request-id`.
- The dashboard batch accepts a limit of 1 through 1,000 and defaults to 100.

More detail: [Operations and CLI: Bulk redrive](../architecture/operations.md#bulk-redrive).

</details>

## Attribution is not permission

A support script redrives `charge-4711`. It passes an actor name and a reason. Your application
does not allow the person it names to touch payment tasks.

1. **Workhorse checks the shape.** The actor and the reason are within their length limits.
2. **Workhorse records both** on the redrive and creates the copy.
3. **Nothing asks** whether that person may redrive tasks on `payments`.

The person and reason recorded on a redrive are for the audit trail. Workhorse does not check
whether they were allowed to do it. That check belongs in your application, before you call
redrive.

<details>
<summary>Reference: recorded attribution</summary>

- `redrive_v1` and `redrive_many_v1` require `p_requested_by` of 1 through 200 characters and a
  reason of 1 through 2,000 characters.
- Each redrive stores both in its `task_redrive` row and in the `redriven` and `redrive_created`
  events.
- Neither function checks a database role or any other permission.

More detail: [Data model: `task_redrive`](../architecture/data-model.md#task_redrive).

</details>

## Next

- [110-retries.md](110-retries.md) — the automatic attempts that happen first
- [330-retention.md](330-retention.md) — how long a failed task sticks around
- [010-tasks-and-state.md](010-tasks-and-state.md) — why the failed task is still there at all

---

Exact lineage columns, copy rules, and conflict shape:
[`architecture/data-model.md`](../architecture/data-model.md#task_redrive).
