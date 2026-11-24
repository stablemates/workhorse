# ADR 0126: Claim past the tasks that no handler serves before the release wait

- **Status:** Accepted
- **Date:** 2026-11-23
- **Amends:** the release wait of SM-1247 in
  [Task lifecycle: Owned release](../architecture/lifecycle.md#owned-release)
- **Related:** [ADR 0099](0099-report-a-released-only-single-pass-as-no-progress.md)
- **Issue:** SM-1905. SM-2085 records the schema change that this ADR does not make.

## Context

A claim has no task-type filter. Thus a worker can claim a ready task that it has no handler for.
The worker releases the task through `release_owned_v1`, and the task keeps its attempt (SM-823).
SM-1247 then gave the continuous loop a release wait: after a claim that released every task, the
worker waits one empty wait before it claims again. A notification does not end that wait.

The release wait came after every such claim. AwesomeRepos found the result on a worker with
concurrency 1:

1. Queue `default` holds four tasks of a type that no worker serves, and then one `smoke.ping`
   task.
2. The worker claims the first task, releases it, and waits one poll interval.
3. It claims the second task, releases it, and waits again. It does the same for the third and the
   fourth task.
4. Each release puts its task behind the `smoke.ping` task. But the worker reaches that task only
   after four waits: about 20 s with the default 5,000 ms poll interval.

A handled task thus waited one poll interval for each task ahead of it that the worker could not
run. A test with a timeout of 5 s failed each time. In TypeScript on main, the handled task behind
one such task ran after 5.2 s. All seven SDKs did the same.

The release already moves the task back. `release_owned_v1` gives the task a new `sequence`, and
`fast_release_owned_v1` also gives it a new `run_at`. A claim orders the ready tasks by priority,
then by that order. So the next claim reaches the next ready task of the same priority. The wait
after each release was what delayed the work, not the order of the queue.

The 0.16.0 schema is the Gate 3 candidate that 1.0.0 reuses. Thus this change must not change
`sql/` or add a migration. No current claim function takes a task-type filter, and no current
release function takes a delay.

## Decision

**The continuous loop claims again at once after a claim that released every task, until the
release run ends.** A release run is the claims in a row that released every task that they
claimed. The worker keeps the ids of the tasks of the run. All seven SDKs apply these rules:

1. After a claim that released every task, the run claims again at once, without a wait.
2. If the claim returned a task that the run already released, the run ends. That task is the
   first ready task again, so the worker has no other task to reach.
3. After the tenth claim of a run, the run ends. The limit is 10 claims: `RELEASE_RUN_LIMIT`
   (TypeScript, Rust, and Ruby), `_RELEASE_RUN_LIMIT` (Python), `releaseRunLimit` (Go),
   `ReleaseRun.LIMIT` (the JVM), and `ReleaseRun.Limit` (.NET).
4. If a claim inside a run returns no task, the run ends. The claim can have found only the tasks
   whose release is still in flight. Thus this claim starts the release wait, not the empty wait,
   so the notification of that release does not end it.
5. When a run ends, the worker starts the release wait of SM-1247. The wait counts as one empty
   claim for the poll backoff. Its deadline is the next empty wait, and only that deadline, a stop,
   or a pause ends it.
6. A claim that ran a handler ends the run and starts no wait. An empty claim outside a run starts
   the empty wait, as before.

The single-pass call does not change. ADR 0099 still applies: a pass that released every task that
it claimed returns `false`, and the next call claims again at once.

A fused completion claim does not change either. If it returns only tasks that the worker cannot
run, the worker releases them and does not change the backoff.

The fix does not use a new log record. Each release already emits the catalogued
`workhorse.handler.missing` warning, with the task id and type, in every SDK. A second record for
a repeated release would say the same thing again.

## Consequences

- A worker reaches a task that it can run behind up to nine claims of tasks that it cannot run
  without a wait, because the tenth such claim ends the run. Behind more, it waits one release
  wait for each ten such claims.
- A worker that has no handler for any ready task makes at most ten released-only claims between
  two release waits. Before, it made one. With one such task, it makes at most two: the claim that
  releases the task and the claim that gets it back. With more than one slot, the second claim can
  find no task while the release is in flight, and then it starts the wait at once. A fleet of N such workers releases one such task at
  most 2N times in each poll interval.
- Each claim of a run waits for the release before it when the worker has one slot. With more
  slots, a claim can run while a release is in flight. Rule 4 keeps that case from a spin.
- A task without a handler at a higher priority still blocks the lower-priority tasks on that
  worker. Every claim returns it first, because a release keeps the priority. Only a claim that
  filters by task type can fix this case, and that needs a schema change. SM-2085 records it.
- The shared runtime fixture
  `a-listening-worker-claims-a-task-it-cannot-run-at-most-twice-in-each-poll-interval` replaces
  `a-listening-worker-claims-a-released-task-again-only-after-its-poll-interval`. The new fixture
  `a-listening-worker-claims-past-the-tasks-it-cannot-run-before-it-waits` pins rules 1 and 3. Each
  SDK has unit cases for rules 2, 4, and 6.

## Rejected alternatives

### A claim that names the handled task types

It is the full fix: a worker never claims a task that it cannot run, and the priority case goes
away. But no current claim function takes a type filter, and this change must not change `sql/`.
SM-2085 records it for a later additive migration.

### A release with a delay

A delay on the release would move the task out of the way for some time. But `release_owned_v1`
takes no delay. `schedule_wait_v1` can delay a task and keep its attempt, but it records a durable
wait under a name. A later handler run would see that wait, and cancellation would read the
attribution of a suspension that never happened.

### Only a log record for a repeated release

It tells the operator about the delay but does not remove it. The release already moves the task,
so the SDKs can remove the delay without a schema change. The existing `workhorse.handler.missing`
warning already names each release.

### No run limit

A worker would then release every task that it cannot run before each release wait. A queue with
thousands of such tasks, for example of a removed type, would get thousands of `released` events
and notifications in each poll interval from each worker. The limit of ten keeps that cost at ten
times the bound of SM-1247, and it covers the usual case of a few new tasks during a deploy.
