# frozen_string_literal: true

require "active_record"
require "connection_pool"
require "stringio"

RSpec.describe "Worker inside a Rails application" do
  include_context "with a scratch database"

  before { @pool = ConnectionPool.new(size: 4, timeout: 5) { ScratchDatabase.connect } }

  after { @pool&.shutdown(&:close) }

  def worker(**options)
    W::Worker.new(@pool, queues: [@queue_name], polling_only: true, poll_interval: 0.01, disable_registry: true,
      **options)
  end

  # Runs +worker+ for a moment, then stops it.
  def run_briefly(worker)
    runner = Thread.new { worker.run }
    sleep(0.1)
    worker.stop
    runner.value
  end

  it "runs each handler inside the Rails executor" do
    wrapped = []
    executor = Object.new
    executor.define_singleton_method(:wrap) do |&block|
      wrapped << :enter
      block.call.tap { wrapped << :leave }
    end
    stub_const("Rails", Module.new)
    Rails.define_singleton_method(:application) { Struct.new(:executor).new(executor) }

    queue.enqueue("t", {})
    inside = nil
    ran = worker.handle("t") { |_payload, _context|
      inside = wrapped.dup
      {}
    }.run_once
    expect(ran).to be(true)
    expect(inside).to eq([:enter])
    expect(wrapped).to eq(%i[enter leave])
  end

  context "with Active Record connected" do
    before { ActiveRecord::Base.establish_connection("#{ScratchDatabase.url}?pool=1") }

    after do
      ActiveRecord::Base.connection_handler.clear_all_connections!
      ActiveRecord::Base.remove_connection
    end

    it "logs a warning when the pool is smaller than concurrency" do
      output = StringIO.new
      run_briefly(worker(concurrency: 2, logger: Logger.new(output)))
      expect(output.string).to include("workhorse.worker.active_record_pool_too_small")
        .and include('"workhorse.active_record.pool_size":1')
    end

    it "warns on standard error without a logger" do
      expect { run_briefly(worker(concurrency: 2)) }
        .to output(/workhorse: Active Record pool size 1 is smaller than worker concurrency 2/).to_stderr
    end

    it "stays quiet when the pool covers concurrency" do
      output = StringIO.new
      run_briefly(worker(concurrency: 1, logger: Logger.new(output)))
      expect(output.string).not_to include("active_record_pool_too_small")
    end
  end
end
