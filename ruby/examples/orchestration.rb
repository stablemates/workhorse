# frozen_string_literal: true

# Runs an order handler that fans out two child tasks, then waits for a signal and a human decision.
require "connection_pool"
require "pg"
require "stablemates/workhorse"

url = ENV.fetch("WORKHORSE_DATABASE_URL")
pool = ConnectionPool.new(size: 10) { PG.connect(url) }

worker = Stablemates::Workhorse::Worker.new(pool, queues: ["orders"])
worker.handle("order.process") do |payload, context|
  children = context.run_children_all([
    Stablemates::Workhorse::ChildTaskRequest.new(name: "invoice", task_type: "invoice.create", payload: payload),
    Stablemates::Workhorse::ChildTaskRequest.new(name: "receipt", task_type: "receipt.send", payload: payload)
  ])
  approval = context.wait_for_signal("approval")
  decision = context.wait_for_human("review", {"payload" => payload, "approval" => approval})
  {"children" => children, "approval" => approval, "decision" => decision}
end
complete_child = ->(payload, _context) { {"completed" => true, "payload" => payload} }
worker.handle("invoice.create", &complete_child)
worker.handle("receipt.send", &complete_child)
Stablemates::Workhorse.run_worker_process(worker)
