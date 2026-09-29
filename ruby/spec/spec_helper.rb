# frozen_string_literal: true

require "securerandom"
require "time"
require "stablemates/workhorse"
require_relative "support/scratch_database"

W = Stablemates::Workhorse

# Answers each statement from a block, after reporting a compatible schema.
class FakeExecutor < W::Executor
  COMPATIBLE = [
    {"kind" => "schema", "version" => W::SqlCatalogue::MAXIMUM_SCHEMA_VERSION.to_s},
    {"kind" => "protocol", "version" => W::SqlCatalogue::CLIENT_PROTOCOL_VERSION.to_s}
  ].freeze

  attr_reader :statements

  def initialize(&answer)
    super(nil)
    @answer = answer
    @statements = []
  end

  def rows(sql, params = [])
    return COMPATIBLE if sql == W::SqlCatalogue::COMPATIBILITY_STATE

    @statements << [sql, params]
    @answer ? @answer.call(sql, params) : []
  end
end

# An example that runs against the process's scratch database. Each example uses its own queue, so
# examples share one schema without observing each other's tasks.
RSpec.shared_context "with a scratch database" do
  before do
    reason = ScratchDatabase.skip_reason
    skip(reason) if reason
    @connection = ScratchDatabase.connect
    @queue_name = "rb-#{SecureRandom.hex(6)}"
  end

  after { @connection&.close }

  def queue(executor = @connection) = W::Queue.new(executor, default_queue: @queue_name)

  # The task row as a Hash of column name to text, read on a connection outside the caller's.
  def task_row(task_id, connection = @connection)
    connection.exec_params("SELECT * FROM workhorse.task WHERE id = $1", [task_id]).first
  end

  def task_count(connection = @connection)
    Integer(connection.exec_params("SELECT count(*) FROM workhorse.task WHERE queue_name = $1",
      [@queue_name]).getvalue(0, 0), 10)
  end
end

RSpec.configure do |config|
  config.disable_monkey_patching!
  config.order = :random
  Kernel.srand config.seed
  config.expect_with(:rspec) { |expectations| expectations.max_formatted_output_length = nil }
  config.after(:suite) { ScratchDatabase.drop }
end
