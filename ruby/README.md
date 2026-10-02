# Workhorse for Ruby

The Ruby queue client, operator client, and worker runtime for the Workhorse durable task queue for
PostgreSQL.

> **Public beta:** Workhorse is usable for evaluation and early production adoption. A 0.x minor
> release may change behaviour, so read the
> [changelog](https://github.com/stablemates/workhorse/blob/main/ruby/CHANGELOG.md) before you
> upgrade. It will not ask you to recreate your database: migrations are ordered, and inside a major
> line a migration only adds, so a running deployment upgrades in place. The one exception is
> migration 0025: a database from before 0.5.0 crosses it offline, with the
> [0.5.0 upgrade steps](https://github.com/stablemates/workhorse/blob/main/CHANGELOG.md#050--2026-09-28).
> The upgrade from 0.5 to 0.6 only adds.

An AI agent should read [the Workhorse documentation index](https://workhorse.run/llms.txt) first.

## Install

Add the gem and the connection pool it runs on:

```bash
bundle add stablemates-workhorse
bundle add connection_pool
```

Install the schema once, as a deployment step. The application never installs or migrates it.

```bash
npx --package @stablemates/workhorse@0.6.0 workhorse schema install
```

The machine that runs that deployment step needs Node.js 22 or newer. The application itself needs
no Node.js.

Pin that version to the gem version the application depends on. The two come from one commit of
this repository, so the numbers match. A schema tool older than the application leaves a schema the
application refuses to start against.

Runtime processes verify compatibility instead of changing the schema. Call
`Queue#assert_compatible` or `Admin#assert_compatible` at startup. A refusal is
`Stablemates::Workhorse::CompatibilityError`, whose `code` names the reason.

Requires Ruby 3.3 or newer and PostgreSQL 15 through 18.

## Run one task

```ruby
require "connection_pool"
require "pg"
require "stablemates/workhorse"

url = ENV.fetch("DATABASE_URL")
pool = ConnectionPool.new(size: 4) { PG.connect(url) }

queue = Stablemates::Workhorse::Queue.new(pool)
enqueued = queue.enqueue("email.welcome", {"to" => "ada@example.com"})

worker = Stablemates::Workhorse::Worker.new(pool)
worker.handle("email.welcome") do |payload, _context|
  {"deliveredTo" => payload["to"]}
end
worker.run_once # production uses Stablemates::Workhorse.run_worker_process(worker)

task = Stablemates::Workhorse::Admin.new(pool).get_task(enqueued.task_id)
puts "#{task.state} #{task.result}" if task
```

Handlers receive at-least-once delivery. Use stable provider idempotency keys around external
effects. `ruby/examples/` also holds a transactional enqueue, a dedicated worker process, and an
orchestration of child tasks, signals, and human decisions. An integration spec runs every one of
them against PostgreSQL.

## Package boundary

The gem is `stablemates-workhorse`, and its namespace is `Stablemates::Workhorse`.

- `Queue` enqueues, cancels, signals, and synchronizes schedules, policies, budgets, and contracts.
  `Queue.new` accepts a `PG::Connection`, a `ConnectionPool`, or an open `pg` transaction.
  `ActiveRecordExecutor` joins the caller's Active Record transaction instead. Either way, the
  enqueue becomes part of your commit. When a statement finds its pooled connection unusable, the
  SDK discards that connection through the pool's `discard_current_connection`. The SDK never
  closes a connection the caller owns. A source without `discard_current_connection` must replace
  an unusable connection itself.
  Each enqueue returns an `EnqueueResult` with the task ID and an `outcome`. A debounced request
  that was `:non_replaceable` also carries a `reason`: `:incompatible_key_mode`, `:not_pending`, or
  `:window_elapsed_pending`.
- `Worker` takes a pool, registers handlers by task type, and runs them under a lease with a shared
  heartbeat connection. `run_worker_process` drains it on `TERM` or `INT`.
- `HandlerContext` offers checkpoints, durable sleeps, signal and human waits, child tasks, and
  progress. PostgreSQL owns every durable decision, and an unresolved wait suspends the task.
- `Admin` lists, inspects, and repairs tasks, dead letters, waits, workers, and queues.
- `Dashboard` is a Rack application that Rails routes or any Rack builder mounts under its own path.
- The [Active Job adapter](https://workhorse.run/docs/active-job) runs Rails jobs on Workhorse.
- When the application loads `opentelemetry-api`, the gem adds spans and trace propagation. Loading
  `opentelemetry-metrics-api` as well adds metrics.

The gem never installs or migrates the shared PostgreSQL schema.

## Next

- Follow the [quickstart](https://workhorse.run/docs/quickstart) and deploy
  [worker processes](https://workhorse.run/docs/worker-processes).
- Move Rails jobs over with the [Active Job adapter](https://workhorse.run/docs/active-job).
- Read the [compatibility policy](https://workhorse.run/docs/compatibility).
