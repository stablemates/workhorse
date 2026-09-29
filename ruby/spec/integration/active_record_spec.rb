# frozen_string_literal: true

require "active_record"

# An ActiveRecordExecutor enqueue joins the caller's Active Record transaction.
RSpec.describe Stablemates::Workhorse::ActiveRecordExecutor do
  include_context "with a scratch database"

  before { ActiveRecord::Base.establish_connection(ScratchDatabase.url) }

  after do
    ActiveRecord::Base.connection_handler.clear_all_connections!
    ActiveRecord::Base.remove_connection
  end

  it "commits the enqueue with the Active Record transaction" do
    records = queue(described_class.new(ActiveRecord::Base))
    result = nil
    ActiveRecord::Base.transaction do
      result = records.enqueue("invoice.send", {"invoice" => 1})
      expect(task_count).to eq(0), "the enqueue is invisible before commit"
    end

    expect(task_count).to eq(1)
    expect(task_row(result.task_id)["task_type"]).to eq("invoice.send")
  end

  it "rolls the enqueue back with the Active Record transaction" do
    records = queue(described_class.new(ActiveRecord::Base))
    ActiveRecord::Base.transaction do
      records.enqueue("invoice.send", {"invoice" => 2})
      raise ActiveRecord::Rollback
    end

    expect(task_count).to eq(0)
  end
end
