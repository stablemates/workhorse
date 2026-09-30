# frozen_string_literal: true

# Runs a dedicated worker process until SIGINT or SIGTERM, then drains its active tasks.
require "connection_pool"
require "pg"
require "stablemates/workhorse"

url = ENV.fetch("WORKHORSE_DATABASE_URL")
pool = ConnectionPool.new(size: 10) { PG.connect(url) }

worker = Stablemates::Workhorse::Worker.new(pool,
  queues: ["orders"], worker_id: "orders-worker", concurrency: 8, shutdown_grace: 20)
worker.handle("order.accepted") do |payload, context|
  context.cancellation.check!
  {"payload" => payload, "prepared" => true}
end
Stablemates::Workhorse.run_worker_process(worker)
