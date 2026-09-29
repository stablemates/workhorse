# frozen_string_literal: true

require "securerandom"
require "time"
require "minitest/autorun"
require "stablemates/workhorse"
require_relative "support/scratch_database"

# A test that runs against the process's scratch database. Each test uses its own queue, so tests
# share one schema without observing each other's tasks.
class DatabaseTest < Minitest::Test
  W = Stablemates::Workhorse

  def setup
    reason = ScratchDatabase.skip_reason
    skip(reason) if reason
    @connection = ScratchDatabase.connect
    @queue_name = "rb-#{SecureRandom.hex(6)}"
  end

  def teardown
    @connection&.close
  end

  private

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
