# Who owns a task right now, and how do fence tokens prove it?

Only the current owner may commit a task transition. This guide explains the mechanism that
guarantees it, because almost every other rule in Workhorse depends on it.

## One task, a frozen worker, and a late write

Worker A runs an invoice task. Partway through, A's machine freezes. Later it comes back and tries
to mark the task complete. This is what happens.

1. **At 0 s — the claim.** Worker A has a free slot and asks for work. Workhorse gives it the
   invoice task and stamps three things on the task's runtime row: A's worker id, an expiry at 30 s,
   and fence token 41. Worker A now holds a **lease**: it owns the task until 30 s.
2. **At 10 s and 20 s — heartbeats.** While the handler runs, worker A tells PostgreSQL on a timer
   that it is still working. Each accepted heartbeat moves the expiry later. After the heartbeat at
   20 s, the lease runs until 50 s.
3. **At 25 s — the freeze.** Worker A's machine stops responding. The handler stops, and so do the
   heartbeats. Nothing tells the database. It only notices, later, that the expiry has passed.
4. **At 50 s — the lease expires.** Shortly after, a background pass called recovery finds the
   abandoned row and puts the task back in the queue for another attempt.
5. **At about 52 s — a new owner.** Worker B claims the task. The new claim gets a **new, higher
   fence token**: 57, because other claims happened in between.
6. **At 90 s — the late write.** Worker A's machine recovers. Its handler finishes and tries to mark
   the task complete. The write carries fence token 41. The row now says 57, so PostgreSQL refuses
   the write. Worker A cannot touch the attempt that replaced it.

Without step 6 there would be chaos: a task marked succeeded while a second copy still runs it.

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
shortest live maintenance interval. The scan still runs at least once per interval while workers
keep ticking, and each run recovers a bounded batch of expired rows.

More detail: [Task lifecycle: Claim](../architecture/lifecycle.md#claim), [Task lifecycle: Worker options](../architecture/lifecycle.md#worker-options), and [Task lifecycle: Maintenance cadence](../architecture/lifecycle.md#maintenance-cadence).

</details>

## Keeping the lease

Go back to worker A and the invoice task, before the freeze.

1. **At 10 s** worker A's background timer sends a heartbeat round. The round covers every lease A
   holds, so it renews the invoice task and every other task A runs. You never call heartbeat
   yourself.
2. **At 20 s** suppose the round fails on a network error. Every task keeps running, and the next
   round tries again.
3. **At 20 s** suppose instead the heartbeat waits behind another transaction until 45 s. The
   heartbeat at 10 s had moved the expiry to 40 s, so the lease expired during the wait. When the
   heartbeat finally holds the row lock, PostgreSQL reads the clock, sees the expired lease, and
   does not renew it.
4. **At 24 s** suppose the invoice handler returns instead of freezing. The worker still has to
   check the result and write the completion, and that write waits for a busy connection pool. In
   TypeScript, Python, and Go the lease keeps renewing through that final write, so a finished task
   is not handed to recovery. A Rust task leaves the heartbeat round when its handler returns.

So a heartbeat renews only a lease that is still live when PostgreSQL checks it. A late heartbeat
cannot bring a lease back, and one failed round says nothing about ownership.

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

## Why the fence check works

In the story, worker A was not dead. It was frozen, and it woke up well after its lease had
expired. A slow network call or a long pause can cause the same thing.

Every write that changes a task carries the worker id and the fence token from the claim. Every SQL
function checks both against the row before it writes. If they do not match, the function refuses.
That is why the architecture reference keeps saying "locks the exact active worker and fence
generation". The phrase means: this write only lands if you still own the task.

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

## What this means for you

You mostly do not think about it. But it explains two things you will run into:

- A handler that hangs for a long time without finishing may find that its task was already retried
  elsewhere. Workhorse rejects its final write, silently and correctly.
- "Still running" and "still owns the task" are different questions. Heartbeats answer the second
  one.

## Next

- [030-delivery-guarantees.md](030-delivery-guarantees.md) — what a recovered task means for you
- [110-retries.md](110-retries.md) — what happens on the next attempt
- [310-workers.md](310-workers.md) — the process that holds the lease

---

Exact semantics of claim, heartbeat, and recovery:
[`architecture/lifecycle.md`](../architecture/lifecycle.md#claim).
