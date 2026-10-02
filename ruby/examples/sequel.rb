# frozen_string_literal: true

require "sequel"
require "securerandom"
require "stablemates/workhorse"

module SequelExample
  module_function

  def enqueue_order(database, order_id:, email:, queue_name: "orders", server: :default)
    # docs:start sequel-transaction
    database.transaction(server: server) do |connection|
      database[:sequel_orders].server(server).insert(id: order_id, email: email)
      Stablemates::Workhorse::Queue.new(connection, default_queue: queue_name)
        .enqueue("order.accepted", {"orderId" => order_id, "email" => email})
    end
    # docs:end
  end
end

if $PROGRAM_NAME == __FILE__
  Sequel.connect(ENV.fetch("WORKHORSE_DATABASE_URL")) do |database|
    database.create_table?(:sequel_orders) do
      String :id, primary_key: true
      String :email, null: false
    end
    puts SequelExample.enqueue_order(database, order_id: SecureRandom.uuid, email: "ada@example.com").task_id
  end
end
