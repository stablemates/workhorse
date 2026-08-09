# Retries: how a failed job gets another go

When a handler throws, the job usually isn't finished — it's just failed _this_ attempt.
This guide covers how the next attempt gets scheduled, and how long it waits.

## The attempt budget

Every job carries a maximum number of attempts, set when you enqueue it. Each failure uses
one up. When the budget runs out, the job stops retrying: its runtime row is deleted and a
failed outcome is written instead.

That budget check happens in SQL, always. It doesn't matter where the retry delay came from,
or what your worker configuration says — the database is the thing that decides whether a
job is allowed another attempt. You can't accidentally configure infinite retries.

## Choosing the delay

Retrying instantly is usually wrong. If an API is down, hammering it immediately just burns
attempts. So a failed job normally goes back to `scheduled` with a wake time, not straight
to `ready`.

You can attach a retry policy to a job when you enqueue it. There are three shapes:

- **Fixed** — always wait the same amount of time.
- **Exponential** — start small, multiply the wait after each failure, stop growing at a
  ceiling.
- **Decorrelated jitter** — like exponential, but randomised, so a thousand jobs that failed
  together don't all retry at the same instant and knock the recovering service over again.

Jitter is the right default for anything talking to an external service. The randomness is
computed from the job's own identity and attempt number, so it's stable — replaying the same
situation picks the same delay rather than a fresh random one.

## Who actually picks the number

PostgreSQL does, from the policy stored on the job. That matters because the same policy
then applies whether the handler _threw an error_ or the worker _silently died_ and the
lease expired. Both paths go through the same selector, so a crashed worker doesn't get
different retry behaviour from a failing one.

You can override it — `Queue.fail` takes a delay, and workers can supply one — and an
explicit override wins, including an explicit zero for "retry immediately". A worker
callback that returns nothing defers to the database instead.

If a job has _no_ policy at all, the two paths behave differently for historical reasons:
a thrown error gets a legacy randomised backoff, and an expired lease retries immediately.
Set a policy and that inconsistency disappears.

## What a retry does not reset

The attempt counter goes up, and the job gets a new fence token when it's next claimed. But
the job id, payload, and any checkpoints you saved all survive. A retry is the same job
having another go — not a new job.

## Next

- [340-redrive.md](340-redrive.md) — running a job again _after_ it has given up
- [140-deadlines-and-timeouts.md](140-deadlines-and-timeouts.md) — the limits that end retrying early
- [030-delivery-guarantees.md](030-delivery-guarantees.md) — making a second attempt safe

---

Exact policy shapes, bounds, and precedence:
[`architecture.md`](../architecture.md#job_runtime).
