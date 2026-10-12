# ADR 0097: Put work that a handler creates on the queue of its task

- **Status:** Accepted
- **Date:** 2026-10-12
- **Amends:** [ADR 0095](0095-add-task-groups-with-completion-callbacks.md). ADR 0095 does not
  state the queue of an add from a handler. This ADR adds that rule.
- **Related:** [ADR 0072](0072-converge-the-worker-runtime-defaults.md)
- **Issue:** SM-1251. SM-1251 applies the rule to an add from a handler to its task group.
  SM-1260 applies it to child task requests.

## Context

A handler can create tasks in two ways. It can add tasks to the task group of its task, and it can
request child tasks. A request can name a queue. If it names no queue, the SDK must choose one.

Before this ADR, the SDKs did not choose the same queue:

| Work from a handler | TypeScript                             | Python    | Go        | Rust      | Ruby                          |
| ------------------- | -------------------------------------- | --------- | --------- | --------- | ----------------------------- |
| Task group add      | `defaultQueue` of the worker's `Queue` | `default` | `default` | `default` | The first queue of the worker |
| Child task request  | `defaultQueue` of the worker's `Queue` | `default` | `default` | `default` | The first queue of the worker |

Thus the same handler code put the same task on different queues in different SDKs. With the
queue `default`, a second problem occurs. If no worker serves `default`, the added task stays
`ready`. A task group then does not finish, and its callbacks do not run. A parent task that waits
for a child task does not continue.

## Decision

If a request that a handler creates names no queue, the task goes to the queue of the task whose
handler creates it. This rule applies in all five SDKs:

1. An add from a handler to its task group. The task goes to the queue of the member task that adds
   it.
2. A child task request. The task goes to the queue of the parent task.

A request that names a queue keeps that queue. An add through `Queue`, with no handler, keeps the
default queue of that `Queue`.

A worker just ran the task whose handler creates the work, so a worker serves its queue. A member
task is always on a full-tier queue, because Workhorse rejects a fast-tier member task. Thus the
queue of a member task always accepts a new member task.

## Consequences

- The queue of work from a handler does not depend on the queue list of the worker or on the
  `defaultQueue` of a TypeScript `Queue`.
- A TypeScript application that sets `defaultQueue` and lets a handler add or child request use it
  must now name that queue on the request.
- New work shares the queue of its task, with its concurrency and its claim order. If the new work
  needs a different queue, the request must name it.
- A parent task can create a child with no queue before an upgrade and replay that request after
  the upgrade. PostgreSQL compares the queue of a replayed request. If the old default queue is not
  the queue of the parent task, the replay gives a conflict. Thus, on a conflict, a replayed child
  request with no queue keeps the queue of its stored child (SM-1260). A request that names a queue
  keeps that queue.
- The task group rule and the child task rule merge separately. Both must merge before the next
  release, so no release has one rule for task group adds and a different rule for child tasks.

## Rejected alternatives

### The queue `default`

Python, Go, and Rust already used `default`, so only Ruby had to change. But an added task stays
`ready` when no worker serves `default`, and Workhorse gives no warning. The group then does not
finish.

### The first queue of the worker

A worker serves that queue. But the result depends on the configuration of the worker and on the
order of its queue list. Two deployments of the same code can put the task on different queues.

### No default queue

A handler add or a child request must name a queue. This gives no surprise, but current code that
names no queue stops working. It is also a different rule from an add through `Queue`.
