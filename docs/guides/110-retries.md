# How does a failed task get another attempt?

When a handler throws, the task usually is not finished. Only _this_ attempt failed. This guide
covers how Workhorse schedules the next attempt, how long it waits, and when it gives up.

## One charge, four attempts

**Example.** A task charges a card through a payment provider, and the provider is having an outage.
The task was enqueued with a budget of four attempts and an exponential retry policy: wait 30
seconds after the first failure, double the wait after each failure, and never wait longer than ten
minutes.

1. **At 0 s — attempt 1.** The provider returns an error, and the handler throws. Attempt 1 is
   below the budget of four, so PostgreSQL schedules attempt 2 for 30 seconds later. The task goes
   back to `scheduled`, not straight to `ready`.
2. **At about 30 s — attempt 2.** The provider fails again. The wait doubles, so attempt 3 is
   scheduled about 60 seconds later.
3. **At about 90 s — attempt 3.** This time the worker crashes during the call. About half a
   minute later its lease expires, and recovery returns the task. Recovery uses the same policy as
   a thrown error, so attempt 4 waits 120 seconds.
4. **At about 4 min — attempt 4.** The provider fails once more. Four attempts have now run, and the
   budget is used up. Workhorse stops retrying. It deletes the task's runtime row and writes a
   failed outcome.

The waits grew because each failure suggested the provider needed more time. Retrying at once would
only have used up the attempts faster.

<details>
<summary>Reference: attempt budget</summary>

| Option        | Rule                                  |
| ------------- | ------------------------------------- |
| `maxAttempts` | An integer from 1 to 100. Default 25. |

- PostgreSQL checks the budget in SQL on every failure and recovery. A retry runs only if the failed
  attempt number is less than `maxAttempts`.
- The check applies whatever the source of the delay. No worker setting can turn it off.
- Retry and recovery increment `current_attempt`.
- When the budget is used up, the task moves from `active` to `failed`. The runtime row is deleted.

More detail: [Data model: Priority and attempts](../architecture/data-model.md#priority-and-attempts).

</details>

## Choosing the delay

Go back to the card charge. Its exponential policy waited 30 seconds, then 60, then 120. Two other
policies would have waited differently:

1. **A fixed policy of 30 seconds** waits 30 seconds after every failure.
2. **A decorrelated-jitter policy** picks each task's wait from a range that grows after each
   failure. Suppose a thousand charges fail together at 0 s. Their retries spread across the range
   instead of all landing at 30 s.

You attach a retry policy to a task when you enqueue it. There are three shapes:

- **Fixed.** Always wait the same time.
- **Exponential.** Start small, multiply the wait after each failure, and stop growing at a
  ceiling. The story above used this shape.
- **Decorrelated jitter.** Like exponential, but with a random spread. A thousand tasks that failed
  together then do not all retry at the same moment and knock the recovering service over again.

Jitter is the right default for anything that calls an external service. Workhorse computes the
random spread from the task's own identity and attempt number, so it is stable. Replaying the same
situation picks the same delay, not a fresh random one.

<details>
<summary>Reference: policy shapes and bounds</summary>

| `type`                | Fields                                       | Delay after failed attempt `n`                                                                              |
| --------------------- | -------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `fixed`               | `delayMs`                                    | `delayMs`                                                                                                   |
| `exponential`         | `initialDelayMs`, `multiplier`, `maxDelayMs` | `min(maxDelayMs, initialDelayMs × multiplier^(n − 1))`                                                      |
| `decorrelated-jitter` | `baseDelayMs`, `maxDelayMs`                  | Between `baseDelayMs` and `min(maxDelayMs, 3 × previous delay)`. The first previous delay is `baseDelayMs`. |

Bounds:

- Every delay field is an integer from 0 to 31,536,000,000 ms (365 days).
- `multiplier` is an integer from 1 to 100.
- `maxDelayMs` must be at least `initialDelayMs` or `baseDelayMs`.

Decorrelated jitter hashes the task ID, the attempt number, and the previous delay. The column
`previous_retry_delay_ms` keeps the previous delay for this policy only. Replay and `Queue`
recreation therefore select the same value.

More detail: [Data model: Retry delay selection](../architecture/data-model.md#retry-delay-selection).

</details>

## Who actually picks the number

PostgreSQL does, from the policy stored on the task. In the story, attempt 3 ended in a crash, not
an error, but its wait followed the same policy. A thrown error and an expired lease go through the
same selector, so a crashed worker does not get different retry behavior from a failing one.

You can override the delay. `Queue.fail` takes a delay, and workers can supply one. An explicit
override wins, including an explicit zero for "retry now". A worker callback that returns nothing
defers to the database instead.

A task with _no_ policy behaves differently on the two paths, for historical reasons. A thrown
error gets a legacy random backoff, and an expired lease retries at once. Set a policy, and that
difference goes away.

<details>
<summary>Reference: delay precedence</summary>

`retry_delay_v1` selects the delay in this order:

1. **Override.** A numeric `Queue.fail` delay, a numeric or callback-derived
   `WorkerOptions.retryDelayMs`, or an explicit `Queue.recoverExpired` delay. Zero counts.
2. **Policy.** The persisted retry policy of the task.
3. **No policy.** The source decides:

| Source            | Delay                                                                       |
| ----------------- | --------------------------------------------------------------------------- |
| Handler failure   | `(n − 1)^4 + 15 + floor(random() × 10) × n` seconds, for failed attempt `n` |
| Lease recovery    | 0                                                                           |
| Execution timeout | 0                                                                           |

A callback that returns `undefined` gives no override, so step 2 or 3 applies.

`fail_v1` reserves a delay of `-1` for a terminal failure: the task fails with no retry, even with
attempts left. The worker sends it for a durable replay conflict.

More detail: [Data model: Retry delay selection](../architecture/data-model.md#retry-delay-selection) and [Schema and SQL protocol: Durable replay conflicts](../architecture/schema-and-protocol.md#durable-replay-conflicts).

</details>

## What a retry does not reset

Go back to the card charge. Suppose attempt 1 saved a [checkpoint](030-delivery-guarantees.md)
before the provider failed.

1. **At 0 s** attempt 1 saves the checkpoint and then throws. The attempt counter reads 1.
2. **At about 4 min** a worker claims attempt 4. The attempt counter now reads 4, and the claim
   carries a new [fence token](020-leases-and-fences.md).
3. **Still attempt 4.** The handler receives the same task ID and the same payload as attempt 1.
   The checkpoint from attempt 1 is still there, so the handler reuses its saved result.

So a retry raises the attempt counter and gets a new fence token. The task ID, the payload, and
every checkpoint you saved survive. A retry is the same task having another go, not a new task.

<details>
<summary>Reference: what a retry keeps and changes</summary>

| Kept                                    | Changed                                                          |
| --------------------------------------- | ---------------------------------------------------------------- |
| The `task` row: ID, payload, and policy | `current_attempt`, which retry and recovery increment            |
| Every `task_checkpoint` row             | `fence_token`, which the next claim takes from `fence_token_seq` |

More detail: [Data model: Priority and attempts](../architecture/data-model.md#priority-and-attempts).

</details>

## Next

- [340-redrive.md](340-redrive.md) — running a task again _after_ it has given up
- [140-deadlines-and-timeouts.md](140-deadlines-and-timeouts.md) — the limits that end retrying early
- [030-delivery-guarantees.md](030-delivery-guarantees.md) — making a second attempt safe

---

Exact policy shapes, bounds, and precedence:
[`architecture/data-model.md`](../architecture/data-model.md#task_runtime).
