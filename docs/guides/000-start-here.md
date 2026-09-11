# Start here

Workhorse is a task queue that lives entirely in PostgreSQL. No broker, no Redis, no separate
scheduler service — a task is a row in a table, and every change to it happens inside a SQL
function.

The immediate benefit: you can enqueue a task in the same transaction as your business data.
Insert the order and enqueue "send confirmation email" together, and if the order rolls back
the task goes with it. There's no window where one committed and the other didn't.

These guides explain how the system works and why it's built this way. They don't list exact
limits, function signatures, or column definitions — those live in
[`architecture.md`](../architecture.md), which is the precise reference. Read a guide to
understand something; read the reference when you're changing code.

## Foundations

Read these three in order. Everything else assumes them.

|                                                       |                                                                     |
| ----------------------------------------------------- | ------------------------------------------------------------------- |
| [010 Tasks and state](010-tasks-and-state.md)         | What a task is, and the three tables it lives in                    |
| [020 Leases and fences](020-leases-and-fences.md)     | Who owns a task right now, and why a zombie worker can't corrupt it |
| [030 Delivery guarantees](030-delivery-guarantees.md) | Your handler can run twice — what to do about it                    |

## Running work

How a task behaves once it's executing.

|                                                             |                                                             |
| ----------------------------------------------------------- | ----------------------------------------------------------- |
| [110 Retries](110-retries.md)                               | Attempt budgets, backoff policies, and who picks the delay  |
| [120 Cancellation](120-cancellation.md)                     | Stopping a task is a request, not a kill                    |
| [130 Durable waits](130-durable-waits.md)                   | Sleeping for an hour without holding a worker slot          |
| [135 Signals](135-signals.md)                               | Waiting for an application-owned external event             |
| [140 Deadlines and timeouts](140-deadlines-and-timeouts.md) | Two different clocks, and which one you want                |
| [145 Human decisions](145-human-decisions.md)               | Releasing the worker while an operator chooses what happens |
| [150 Priority](150-priority.md)                             | Running urgent work before ordinary FIFO tasks              |
| [160 Task dependencies](160-task-dependencies.md)           | Waiting for prerequisite tasks before dispatch              |
| [170 Child tasks](170-child-tasks.md)                       | Delegating work and joining its durable results             |
| [180 Agentic flow](180-agentic-flow.md)                     | Composing durable boundaries into a replay-safe agent loop  |

## Getting work in

|                                                           |                                                      |
| --------------------------------------------------------- | ---------------------------------------------------- |
| [200 Transactional enqueue](200-transactional-enqueue.md) | Committing a task and your data together, ORM or not |
| [210 Enqueue idempotency](210-enqueue-idempotency.md)     | Stopping the double-click from creating two tasks    |
| [215 Keyed debounce](215-debounce.md)                     | Replacing pending work while updates keep arriving   |
| [217 Keyed throttle](217-throttle.md)                     | Reusing one accepted task during a busy window       |
| [220 Schedules](220-schedules.md)                         | Recurring tasks on cron, without a scheduler process |
| [230 Payload contracts](230-payload-contracts.md)         | Rejecting malformed data and hiding sensitive fields |
| [240 Concurrency policies](240-concurrency-policies.md)   | Limiting active work across the whole worker fleet   |
| [250 Rate limits](250-rate-limits.md)                     | Controlling starts, bursts, and per-key traffic      |

## Operating the system

|                                                         |                                                              |
| ------------------------------------------------------- | ------------------------------------------------------------ |
| [310 Workers](310-workers.md)                           | The processes that run your tasks, and how they shut down    |
| [315 Batch handlers](315-batch-handlers.md)             | Processing compatible tasks in one application call          |
| [320 Statistics](320-statistics.md)                     | Counting things without melting the database                 |
| [330 Retention](330-retention.md)                       | Deleting old data without losing the audit trail             |
| [340 Redrive](340-redrive.md)                           | Running a task again after it has given up                   |
| [350 Production telemetry](350-production-telemetry.md) | Connecting traces, logs, and metrics to your backend         |
| [355 Observability](355-observability.md)               | Reading bounded runtime metrics and database-wide gauges     |
| [360 Queue health](360-queue-health.md)                 | One consistent snapshot, and when it says something is wrong |

## Deploying and extending

|                                                                 |                                                         |
| --------------------------------------------------------------- | ------------------------------------------------------- |
| [370 Dashboard authentication](370-dashboard-authentication.md) | Protecting a dashboard exposed beyond local development |
| [380 Admin CLI and TUI](380-admin-cli-and-tui.md)               | Operating a queue from the terminal                     |
| [385 AI agent integration](385-agent-integration.md)            | Taking an agent from documentation to a confirmed task  |
| [395 Serverless web tiers](395-serverless-web-tiers.md)         | Enqueueing from serverless and edge runtimes            |

## Adding a guide

Files are numbered in reading order, in bands of one hundred, with gaps of ten. Insert into
a gap — `150-priority.md` sits naturally in "Running work" — and never renumber an existing
file, because the numbers are in links.
