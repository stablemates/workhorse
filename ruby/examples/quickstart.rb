# frozen_string_literal: true

# Enqueues one task, runs the worker once, and prints the task's outcome.
#
# Documentation: https://workhorse.run/docs/quickstart
# docs:start quickstart-program
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
# docs:end
