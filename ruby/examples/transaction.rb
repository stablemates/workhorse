# frozen_string_literal: true

# Enqueues a task inside a caller-owned transaction, so it exists only if the caller commits.
require "pg"
require "stablemates/workhorse"

connection = PG.connect(ENV.fetch("WORKHORSE_DATABASE_URL"))

result = connection.transaction do |transaction|
  # Application writes can use the transaction here. The task becomes visible only if the
  # caller commits the same transaction.
  retry_policy = {"type" => "exponential", "initialDelayMs" => 1_000, "multiplier" => 2, "maxDelayMs" => 60_000}
  Stablemates::Workhorse::Queue.new(transaction, default_queue: "orders")
    .enqueue("order.accepted", {"orderId" => "order-42"}, max_attempts: 3, retry_policy: retry_policy)
end
puts result.task_id
