# frozen_string_literal: true

require_relative "../test_helper"
require "active_record"

# An ActiveRecordExecutor enqueue joins the caller's Active Record transaction.
class ActiveRecordTest < DatabaseTest
  def setup
    super
    ActiveRecord::Base.establish_connection(ScratchDatabase.url)
  end

  def teardown
    ActiveRecord::Base.connection_handler.clear_all_connections!
    ActiveRecord::Base.remove_connection
    super
  end

  def test_enqueue_commits_with_the_active_record_transaction
    records = queue(W::ActiveRecordExecutor.new(ActiveRecord::Base))
    result = nil
    ActiveRecord::Base.transaction do
      result = records.enqueue("invoice.send", { "invoice" => 1 })
      assert_equal 0, task_count, "the enqueue is invisible before commit"
    end

    assert_equal 1, task_count
    assert_equal "invoice.send", task_row(result.task_id)["task_type"]
  end

  def test_enqueue_rolls_back_with_the_active_record_transaction
    records = queue(W::ActiveRecordExecutor.new(ActiveRecord::Base))
    ActiveRecord::Base.transaction do
      records.enqueue("invoice.send", { "invoice" => 2 })
      raise ActiveRecord::Rollback
    end

    assert_equal 0, task_count
  end
end
