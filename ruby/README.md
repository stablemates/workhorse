# Workhorse for Ruby

The Ruby queue client for the Workhorse durable task queue for PostgreSQL.

> **Unreleased:** this gem is under construction and not yet published. It enqueues, cancels,
> delivers signals, completes human waits, and syncs schedules and contracts. It runs workers and
> carries the durable handler steps, the operator client, the dashboard, and an Active Job adapter.

An AI agent should read [the Workhorse documentation index](https://workhorse.run/llms.txt) first.

## Install

Add the gem to the application's `Gemfile`:

```ruby
gem "stablemates-workhorse"
gem "connection_pool"
```

Install the schema once, as a deployment step. The application never installs or migrates it.

```bash
npx --package @stablemates/workhorse workhorse schema install
```

Runtime processes verify compatibility instead of changing the schema. Call
`Queue#assert_compatible` at startup. A refusal is `Stablemates::Workhorse::CompatibilityError`,
whose `code` names the reason.

Requires Ruby 3.3 or newer and PostgreSQL 15 through 18.

## Enqueue a task

A queue runs on a `PG::Connection`, a `ConnectionPool` of them, or any object whose `with` yields
one.

```ruby
require "connection_pool"
require "pg"
require "stablemates/workhorse"

pool = ConnectionPool.new(size: 4) { PG.connect(ENV.fetch("DATABASE_URL")) }
queue = Stablemates::Workhorse::Queue.new(pool)
queue.assert_compatible

result = queue.enqueue("email.welcome", { "to" => "ada@example.com" },
                       idempotency: Stablemates::Workhorse::Idempotency.new(key: "welcome:ada"))
puts "#{result.task_id} #{result.outcome}"
```

## Enqueue inside the caller's transaction

An enqueue runs on the connection the executor yields, so it joins whatever transaction that
connection holds. With Active Record, wrap the model class in `ActiveRecordExecutor`:

```ruby
queue = Stablemates::Workhorse::Queue.new(Stablemates::Workhorse::ActiveRecordExecutor.new(ActiveRecord::Base))

ActiveRecord::Base.transaction do
  user = User.create!(email: "ada@example.com")
  queue.enqueue("email.welcome", { "userId" => user.id })
end
```

The task becomes visible when the transaction commits. A rollback removes it with the rest of the
transaction.

## Run a worker

A `Worker` claims tasks from its queues and runs the handler registered for each task type. The
handler receives the payload and a `HandlerContext`, and its return value becomes the task's result.
A handler that raises fails the attempt, and PostgreSQL decides whether it retries.

```ruby
pool = ConnectionPool.new(size: 5) { PG.connect(ENV.fetch("DATABASE_URL")) }
worker = Stablemates::Workhorse::Worker.new(pool, queues: ["email"], concurrency: 4)

worker.handle("email.welcome") do |payload, context|
  context.cancellation.check!
  Mailer.welcome(payload.fetch("userId")).deliver_now
  { "sent" => true }
end

Stablemates::Workhorse.run_worker_process(worker)
```

`run_worker_process` stops the worker on `TERM` or `INT` and exits once running handlers finish. A
second signal exits at once. Long handlers should poll `context.cancellation`, because the worker
never interrupts a handler thread.

To run several worker processes from one loaded application, pass a block that builds each worker:

```ruby
Stablemates::Workhorse.run_worker_processes(processes: 4) do
  pool = ConnectionPool.new(size: 5) { PG.connect(ENV.fetch("DATABASE_URL")) }
  Stablemates::Workhorse::Worker.new(pool, queues: ["email"], concurrency: 4)
    .handle("email.welcome") { |payload, _context| WelcomeMailer.call(payload) }
end
```

The context also carries durable steps. A checkpoint saves a value once, so a retry replays it
instead of running its block again. A sleep, a signal wait, a human wait, or a child suspends the
attempt and frees the worker thread. The task resumes when the wait ends, and earlier steps replay.

```ruby
worker.handle("order.fulfil") do |payload, context|
  charge = context.checkpoint("charge") { Payments.charge(payload.fetch("orderId")) }
  context.sleep("settle", 60)
  approval = context.wait_for_human("approve", { "charge" => charge })
  label = context.run_child("label", "shipping.label", { "orderId" => payload.fetch("orderId") })
  { "approved" => approval, "label" => label }
end
```

A handler must let `HandlerContext::Suspension` propagate. It descends from `Exception`, so a bare
`rescue` does not catch it.

Under Rails, each handler runs inside the Rails executor. Size the Active Record pool to at least
the worker's `concurrency`; `run` warns when it is smaller.

To handle several tasks of one type in one call, register a batch handler. It receives one item per
task, holding the payload and that task's own context, and returns one outcome per item, in order.
Each task still succeeds or fails on its own. `max_size` cannot exceed the worker's `concurrency`,
and `linger` is in seconds:

```ruby
worker.handle_batch("email.digest", max_size: 4, linger: 0.2) do |items|
  items.map do |item|
    digest = item.context.checkpoint("digest") { DigestMailer.call(item.payload) }
    { status: :succeeded, result: digest }
  rescue => e
    { status: :failed, error: e }
  end
end
```

A member's context offers `task`, `cancellation`, `get_checkpoint`, `checkpoint`, `get_progress`,
and `set_progress`, and nothing that suspends. A checkpoint belongs to its task, so a retry replays
it whatever batch the task lands in.

## Run Active Job jobs

A Rails application selects the adapter by name:

```ruby
# config/application.rb
require "stablemates/workhorse"

config.active_job.queue_adapter = :stablemates_workhorse
```

The adapter enqueues through Active Record, so a `perform_later` inside a transaction commits and
rolls back with the caller's rows. Active Job can instead defer the enqueue until after commit. Rails
defers nothing through 8.1, and `load_defaults "8.2"` turns deferral on. A deferred job is enqueued
only after the commit, so a crash in between loses it. Deferral stays a valid choice. A job that
must commit with its caller's rows turns it off:

```ruby
class ApplicationJob < ActiveJob::Base
  self.enqueue_after_transaction_commit = false
end
```

A default job needs nothing more. It runs under the `active_job` task type with Active Job's own
serialization as its payload, and `retry_on` and `discard_on` behave as they do on any adapter. A
typed job declares its own task type and takes one JSON `Hash` with String keys, so any SDK can
enqueue or handle it. Its retries belong to the Workhorse retry policy, so `retry_job` raises.

```ruby
class ApplicationJob < ActiveJob::Base
  include Stablemates::Workhorse::ActiveJob::Options
end

class WelcomeJob < ApplicationJob
  workhorse_options task_type: "email.welcome", max_attempts: 5, tags: ["email"]

  def perform(payload) = Mailer.welcome(payload.fetch("userId")).deliver_now
end
```

The gem adds no Railtie or Rake task. A short script starts the worker. `handle` registers the
default task type and each typed class the script lists:

```ruby
#!/usr/bin/env ruby
# bin/workhorse
require_relative "../config/environment"

pool = ConnectionPool.new(size: 5) { PG.connect(ENV.fetch("DATABASE_URL")) }
worker = Stablemates::Workhorse::Worker.new(pool, queues: ["default"], concurrency: 4)
Stablemates::Workhorse::ActiveJob.handle(worker, jobs: [WelcomeJob])
Stablemates::Workhorse.run_worker_process(worker)
```

A continuation checks `stopping?`, which turns true once the worker begins to stop, and resumes
as a new task. Workhorse runs higher priorities first, from 0 through 100.

## Operate queues and tasks

`Admin` inspects and controls tasks, dead letters, workers, and queues. It takes the same executors
as `Queue`, so a control joins the caller's transaction. Every control takes an `AdminAudit`, which
PostgreSQL records. Its request ID makes a retried control replay instead of repeating.

```ruby
admin = Stablemates::Workhorse::Admin.new(pool)
audit = Stablemates::Workhorse::AdminAudit.new(actor: "ops@example.com", reason: "Provider outage",
                                               request_id: SecureRandom.uuid)

admin.pause_queue("email", audit: audit)
page = admin.list_dead_letters(queue: "email", limit: 50)
page.items.each { |letter| puts "#{letter.task_id} #{letter.type}" }
```

## Mount the dashboard

`Dashboard` is a Rack application that serves the operator dashboard and its procedure calls. The
host application decides who may use it: `authorize` receives the Rack environment and returns a
`Dashboard::Principal`, `false` for a 401, or a Rack response such as a login redirect.

```ruby
dashboard = Stablemates::Workhorse::Dashboard.new(
  pool,
  authorize: ->(env) { Stablemates::Workhorse::Dashboard::Principal.new(env["warden"]&.user&.email) },
  allowed_hosts: ["ops.example.com"]
)

# config/routes.rb
mount dashboard, at: "/workhorse"

# config.ru
map("/workhorse") { run dashboard }
```

The `path` option, `"/workhorse"` by default, must match the mount point. Pass `read_only: true` to
refuse every mutation. A request whose `Host` is outside `allowed_hosts` is refused before
`authorize` runs.

## Errors

Every error the gem raises is a `Stablemates::Workhorse::Error`. A protocol status the gem does not
recognize raises `UnexpectedStatusError` rather than being guessed at. A database failure without a
Workhorse meaning raises `DatabaseError`, whose `sqlstate` names the cause.
