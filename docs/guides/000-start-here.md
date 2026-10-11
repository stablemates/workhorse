# Start here

Workhorse is a durable task queue for PostgreSQL. A durable task queue keeps its scheduling,
retries, waits, and recovery in the database. Workhorse needs no broker, no Redis, and no separate
scheduler service. Each task is a row in a table, and a SQL function makes each change to it.

Thus, you can enqueue a task in the same transaction as your business data. For example, you insert
an order and enqueue the task "send confirmation email" together. If the transaction rolls back,
PostgreSQL removes the order and the task. The order and the task cannot exist one without the other.

These guides tell how Workhorse operates and why. Each guide starts with one example, and then
gives the general rule.

The first example of each guide starts with a bold **Example.** marker. Its queues, tasks, and
tenants are invented. Its times and counts are only illustrations, unless a Reference block states
them as defaults.

Exact limits, defaults, and identifiers are in collapsed **Reference** blocks below the sections.
Each block links the section of [`architecture.md`](../architecture.md) that owns the facts. That
reference is the precise source. Read a guide to learn a concept. Read the reference when you change
code.

## Foundations

Read these three guides in sequence. All other guides use their concepts.

|                                                       |                                                                     |
| ----------------------------------------------------- | ------------------------------------------------------------------- |
| [010 Tasks and state](010-tasks-and-state.md)         | What a task is, and the three tables that hold it                   |
| [020 Leases and fences](020-leases-and-fences.md)     | Which worker owns a task, and why a stopped worker cannot change it |
| [030 Delivery guarantees](030-delivery-guarantees.md) | Why a handler can run two times, and how to make that safe          |

## Running work

How a task operates while a worker runs it.

|                                                             |                                                           |
| ----------------------------------------------------------- | --------------------------------------------------------- |
| [110 Retries](110-retries.md)                               | Attempt budgets, backoff policies, and who sets the delay |
| [120 Cancellation](120-cancellation.md)                     | How to request that a task stops                          |
| [130 Durable waits](130-durable-waits.md)                   | How to wait for an hour and keep the worker slot free     |
| [135 Signals](135-signals.md)                               | How to wait for an event from your application            |
| [140 Deadlines and timeouts](140-deadlines-and-timeouts.md) | Two different time limits, and which one to use           |
| [145 Human decisions](145-human-decisions.md)               | How to free the worker while a person makes a decision    |
| [150 Priority](150-priority.md)                             | How to run urgent work before usual FIFO tasks            |
| [160 Task dependencies](160-task-dependencies.md)           | How to wait for prerequisite tasks before dispatch        |
| [170 Child tasks](170-child-tasks.md)                       | How to start child tasks and use their durable results    |
| [180 Agentic flow](180-agentic-flow.md)                     | How to build an agent loop that is safe to run again      |

## Getting work in

|                                                           |                                                    |
| --------------------------------------------------------- | -------------------------------------------------- |
| [200 Transactional enqueue](200-transactional-enqueue.md) | How to commit a task and your data together        |
| [210 Enqueue idempotency](210-enqueue-idempotency.md)     | How to stop a repeated request from adding a task  |
| [215 Keyed debounce](215-debounce.md)                     | How to replace pending work while updates arrive   |
| [217 Keyed throttle](217-throttle.md)                     | How to use one task for many requests in a window  |
| [220 Schedules](220-schedules.md)                         | How to enqueue tasks on a cron schedule            |
| [230 Payload contracts](230-payload-contracts.md)         | How to reject bad data and hide sensitive fields   |
| [240 Concurrency policies](240-concurrency-policies.md)   | How to limit active work across all workers        |
| [250 Rate limits](250-rate-limits.md)                     | How to control starts, bursts, and traffic per key |
| [260 Multi-tenancy](260-multi-tenancy.md)                 | How to keep tenants fair, limited, and separate    |

## Operating the system

|                                                         |                                                       |
| ------------------------------------------------------- | ----------------------------------------------------- |
| [310 Workers](310-workers.md)                           | The processes that run your tasks, and how they stop  |
| [315 Batch handlers](315-batch-handlers.md)             | How to process many compatible tasks in one call      |
| [320 Statistics](320-statistics.md)                     | How to count tasks without a high database load       |
| [330 Retention](330-retention.md)                       | How to delete old data and keep the audit history     |
| [335 Cold export](335-cold-export.md)                   | How to keep history longer than PostgreSQL keeps it   |
| [340 Redrive](340-redrive.md)                           | How to run a failed task again                        |
| [350 Production telemetry](350-production-telemetry.md) | How to send traces, logs, and metrics to your backend |
| [355 Observability](355-observability.md)               | How to read runtime metrics and database gauges       |
| [360 Queue health](360-queue-health.md)                 | How to read one snapshot of queue health              |

## Deploying and extending

|                                                                 |                                                        |
| --------------------------------------------------------------- | ------------------------------------------------------ |
| [370 Dashboard authentication](370-dashboard-authentication.md) | How to protect a dashboard that others can reach       |
| [380 Admin CLI and TUI](380-admin-cli-and-tui.md)               | How to operate a queue from the terminal               |
| [385 AI agent integration](385-agent-integration.md)            | How an AI agent gets from the docs to a confirmed task |
| [395 Serverless web tiers](395-serverless-web-tiers.md)         | How to enqueue from serverless and edge runtimes       |

## Add a guide

The file names give the reading sequence. They use bands of one hundred, with gaps of ten. Put a new
guide into a gap in its band. For example, `150-priority.md` is in "Running work". Do not renumber a
file, because links use the numbers.
