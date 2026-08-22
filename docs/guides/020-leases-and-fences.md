# Who owns a job right now: leases and fence tokens

Only the current owner may commit a job transition. This guide explains the mechanism that
guarantees it, because almost every other rule in Workhorse depends on it.

## Claiming a job

When a worker is free, it calls `claim_v1`. That picks an admissible ready job in the queue and
stamps the `job_runtime` row with three things:

- **the worker's id** — who owns it
- **`expires_at`** — until when
- **a fence token** — a number that goes up every single time a job is claimed, anywhere in
  the database

The worker now holds a **lease**. It owns the job, but not forever — only until `expires_at`.

## Keeping the lease

While your handler runs, the worker calls `heartbeat_v1` on a timer in the background. Each
successful heartbeat pushes `expires_at` further into the future.

You never call this yourself. It happens for you as long as your handler is running.

## When a worker dies

If the process crashes, or its network drops, or someone pulls the plug on the machine, the
heartbeats simply stop. Nothing notifies the database — it just notices, eventually, that
`expires_at` has passed.

A background pass called `recover_expired_v1` finds those abandoned rows and puts the jobs
back in the queue for another attempt. The new claim gets a **new, higher fence token**.

## The clever part

Now imagine the original worker wasn't really dead. Its machine was frozen, or it was stuck
on a slow network call, and thirty seconds later it wakes up and tries to mark the job
complete.

By now another worker is running that job. If the first worker's write went through, you'd
have chaos: a job marked succeeded while a second copy is still running it.

It doesn't go through. The old worker's write carries the _old_ fence token. Every SQL
function checks the token before it writes anything, sees it doesn't match what's on the
row, and refuses. The zombie can't touch the job that replaced it.

This is why the reference keeps saying things like "locks the exact active worker and fence
generation". That phrase means: this write only lands if you are still genuinely the owner.

## What this means for you

You mostly don't think about it. But it explains two things you will run into:

- A handler that hangs for a long time without finishing may find its job has already been
  retried elsewhere. Its final write will be rejected, silently and correctly.
- "Still running" and "still owns the job" are different questions. Heartbeats answer the
  second one.

## Next

- [030-delivery-guarantees.md](030-delivery-guarantees.md) — what a recovered job means for you
- [110-retries.md](110-retries.md) — what happens on the next attempt
- [310-workers.md](310-workers.md) — the process that holds the lease

---

Exact semantics of claim, heartbeat, and recovery:
[`architecture.md`](../architecture.md#claim).
