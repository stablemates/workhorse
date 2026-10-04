# frozen_string_literal: true

# The end-to-end integration the agent playbook page shows: a transactional enqueue, a handler
# whose external send is a checkpoint, and a durable read of the settled task.
#
# Documentation: https://workhorse.run/docs/for-ai-agents
# docs:start agent-playbook
require "connection_pool"
require "pg"
require "stablemates/workhorse"

def send_confirmation_email(order_id) = "receipt-for-#{order_id}"

url = ENV.fetch("DATABASE_URL")
pool = ConnectionPool.new(size: 4) { PG.connect(url) }

enqueued = pool.with do |connection|
  connection.transaction do |transaction|
    transaction.exec_params("INSERT INTO orders (id, status) VALUES ($1, $2)", ["order-42", "new"])
    Stablemates::Workhorse::Queue.new(transaction).enqueue("order.created", {"orderId" => "order-42"},
      max_attempts: 5, retry_policy: {"type" => "fixed", "delayMs" => 1_000})
  end # An exception inside the block rolls the transaction back.
end

worker = Stablemates::Workhorse::Worker.new(pool, polling_only: true)
worker.handle("order.created") do |payload, context|
  order_id = payload.fetch("orderId")
  # The send runs once. A replay reuses the recorded receipt.
  receipt = context.checkpoint("confirmation-email") { send_confirmation_email(order_id) }
  {"processedOrderId" => order_id, "receipt" => receipt}
end
worker.run_once # Production workers call Stablemates::Workhorse.run_worker_process(worker).

task = Stablemates::Workhorse::Admin.new(pool).get_task(enqueued.task_id)
puts "#{task.state} #{task.result}" if task
# docs:end
