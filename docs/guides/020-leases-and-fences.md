# Who owns a task right now, and how do fence tokens prove it?

Only the worker that owns a task can change the state of the task. Workhorse uses leases and fence
tokens to make sure of this. Almost each other rule in Workhorse depends on this mechanism.

A **lease** is the right of one worker to run one task until a time limit. A **fence token** is a
number that Workhorse gives to each claim. A later claim always gets a higher number.

## Know which worker owns a task

**Example.** Worker A runs an invoice task. While the handler runs, the machine of worker A stops.

1. At 0 s, worker A claims the task. Workhorse writes three values on the runtime row: the worker
   ID of A, an expiry at 30 s, and the fence token 41.
2. At 10 s and at 20 s, worker A sends a heartbeat. A heartbeat tells PostgreSQL that the worker
   still runs the task. After the heartbeat at 20 s, the lease expires at 50 s.
3. At 25 s, the machine of worker A stops. The heartbeats stop too, and nothing tells the database.
4. At 50 s, the lease expires.
5. Soon after, a worker finds the expired lease. It makes the task available for another attempt.

The lease gives each task one owner at a time. If the owner stops, the lease expires, and the task
does not stay with a stopped worker. A worker does this check during its usual maintenance, so you
do not run a separate service for it.

<details>
<summary>Reference: claim, lease, and recovery</summary>

| Step    | Function             | Effect on `task_runtime`                                          |
| ------- | -------------------- | ----------------------------------------------------------------- |
| Claim   | `claim_many_v1`      | Sets `worker_id`, `expires_at`, and a new `fence_token`.          |
| Renew   | `heartbeat_many_v1`  | Moves `expires_at` for each accepted lease.                       |
| Recover | `recover_expired_v1` | Returns expired rows to `ready` or `scheduled`. Clears the owner. |

**Fence tokens.** Every claim takes the next value of the sequence `fence_token_seq`. The sequence
covers the whole database, not one task or queue. So a later claim always has a higher token.

**Defaults (TypeScript)**

| Option        | Default                           |
| ------------- | --------------------------------- |
| `leaseMs`     | 30,000 ms                         |
| `heartbeatMs` | `max(100, floor(leaseMs / 3))` ms |

`heartbeatMs` must be shorter than `leaseMs`.

**Recovery cadence.** Each worker calls `tick_v1` once per `maintenanceIntervalMs` (TypeScript
default 1,000 ms). A tick skips the expired-lease scan when another tick ran it within half the
shortest maintenance interval among live registered workers. Unregistered workers do not count.
While registered workers keep ticking, a tick reaches the scan at least once per shortest
registered interval, unless other recovery work fills the limit first. With no live registered
worker, every tick runs the scan. Each run recovers a bounded batch of expired rows.

More detail: [Task lifecycle: Claim](../architecture/lifecycle.md#claim), [Task lifecycle: Worker options](../architecture/lifecycle.md#worker-options), and [Task lifecycle: Maintenance cadence](../architecture/lifecycle.md#maintenance-cadence).

</details>

## Stop a late write from an old owner

A stopped worker can start again later and try to finish its old task. The fence token prevents
this write.

**Example.** The invoice task from the previous example is available again.

1. At about 52 s, worker B claims the task. The claim gets a new, higher fence token: 57. Other
   claims occurred between the two claims, so the token is not 42.
2. At 90 s, the machine of worker A starts again. Its handler finishes.
3. Worker A tries to record that the task is complete. The write has the fence token 41.
4. The row has the fence token 57, so PostgreSQL refuses the write.

Each lifecycle write of a worker has the worker ID and the fence token of the claim. Examples are a
heartbeat, a checkpoint, and the completion. The SQL function compares the two values with the row
before it writes. If they are different, the function writes nothing. Thus, an old handler can
continue to run, but it cannot write the outcome of the task.

The architecture reference often says "locks the exact active worker and fence generation". This
phrase means that the write occurs only if the worker still owns the task.

<details>
<summary>Reference: fenced writes</summary>

These functions lock the exact active `task_id`, `worker_id`, and `fence_token` row before they
write:

- `heartbeat_v1` and `heartbeat_many_v1`;
- `complete_v1` and `fail_v1`;
- `schedule_wait_v1`, `wait_for_signal_v1`, and `wait_for_human_v1`;
- `update_progress_v1` and `save_checkpoint_v1`.

A mismatch writes nothing. A heartbeat reports it as `stale`.

More detail: [Task lifecycle: Terminal transitions](../architecture/lifecycle.md#terminal-transitions).

</details>

## Keep the lease while the handler runs

The worker sends heartbeats for you. A timer in the worker sends one heartbeat round at a time. Each
round renews each lease that the worker has. You do not call a heartbeat function.

If a round fails because of a network error, the tasks continue to run. The next round tries again.
One failed round does not change who owns a task.

A heartbeat renews only a lease that is still live when PostgreSQL checks it. A late heartbeat cannot
start an expired lease again.

**Example.** The heartbeat at 10 s moved the expiry of the invoice task to 40 s.

1. At 20 s, worker A sends the next heartbeat.
2. The heartbeat waits for a row lock, because another transaction holds the lock.
3. At 45 s, the heartbeat gets the lock. PostgreSQL then reads the clock.
4. The lease expired at 40 s, so PostgreSQL does not renew it.

After the handler returns, the worker must still check the result and write the completion. This
write can wait for a connection from a busy pool. In TypeScript, Python, and Go, the worker renews
the lease until this write is complete. Thus, Workhorse does not give a finished task to another
worker. A Rust task stops its heartbeats when its handler returns.

<details>
<summary>Reference: heartbeat functions and results</summary>

**`heartbeat_many_v1(p_worker_id, p_leases jsonb)`**

- `p_leases` holds 1 to 100 entries of `{ taskId, fenceToken, leaseMs }`.
- On the full tier, the function locks the worker's rows in `task_id` order.
- The function reads `clock_timestamp()` after those locks.
- One `UPDATE ... FROM` renews every matching row.
- The function returns `(ordinal, task_id, status)` in input order.

**Statuses** (`heartbeat_v1` and `heartbeat_many_v1`)

| Status              | Effect                                                      |
| ------------------- | ----------------------------------------------------------- |
| `accepted`          | Updates the heartbeat time, `expires_at`, and `updated_at`. |
| `cancel_requested`  | No change.                                                  |
| `deadline_exceeded` | No change.                                                  |
| `timeout_exceeded`  | No change.                                                  |
| `stale`             | No change. The worker no longer owns this fence.            |

**Lease watchdog.** Each attempt also keeps a local countdown. It starts when the claim request
leaves. Every `accepted` heartbeat restarts it from the moment that round's request left. Both
moments come before the database renews, so the local countdown never ends after the stored
`expires_at`.

| SDK        | Watchdog                                                             |
| ---------- | -------------------------------------------------------------------- |
| TypeScript | `TaskAttempt`                                                        |
| Python     | The expiration thread of the attempt                                 |
| Go         | The watchdog timer of the attempt                                    |
| Rust       | The `watchdog` timer in `Inner::execute` (`CancelReason::LeaseLost`) |

The Rust worker matches each heartbeat result to the fence token of the claim. If a suspended task
resumes while an old round is returning, that round cannot renew or cancel the resumed handler.

More detail: [Task lifecycle: Heartbeat](../architecture/lifecycle.md#heartbeat).

</details>

## What this means for you

Usually, you do not think about leases and fence tokens. But they explain two results that you can
see:

- If the process of a worker stops for longer than the lease, another worker can run the task
  again. Workhorse then refuses the final write of the first worker.
- "The handler still runs" and "the worker still owns the task" are two different facts. Heartbeats
  keep the second fact true.

## Next

- [030-delivery-guarantees.md](030-delivery-guarantees.md) — what it means for you when a task runs
  again
- [110-retries.md](110-retries.md) — what occurs on the next attempt
- [310-workers.md](310-workers.md) — the process that holds the lease

---

Exact semantics of claim, heartbeat, and recovery:
[`architecture/lifecycle.md`](../architecture/lifecycle.md#claim).
