# Workhorse for Ruby

The Ruby queue client for the Workhorse durable task queue for PostgreSQL.

> **Unreleased:** this gem is under construction and not yet published. It enqueues, cancels,
> delivers signals, completes human waits, and syncs schedules and contracts. The worker runtime and
> the operator client arrive in later releases.

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

## Errors

Every error the gem raises is a `Stablemates::Workhorse::Error`. A protocol status the gem does not
recognize raises `UnexpectedStatusError` rather than being guessed at. A database failure without a
Workhorse meaning raises `DatabaseError`, whose `sqlstate` names the cause.
