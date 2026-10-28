# frozen_string_literal: true

require "connection_pool"
require "logger"
require "stringio"

# SM-1585, SM-1901: a worker needs a pool of at least 3 connections: the dedicated heartbeat
# connection, the shared listener, and one for claims and handlers. On the smallest such pool the
# worker always keeps the listener, so it never falls back to polling.
RSpec.describe "Worker listener on a small pool against PostgreSQL" do
  include_context "with a scratch database"

  # Every wait ends well before the pool timeout. A worker that holds every connection fails a
  # wait, not with ConnectionPool::TimeoutError.
  let(:wait) { 10 }
  let(:pool_timeout) { 30 }
  let(:log) { StringIO.new }
  let(:logger) { Logger.new(log) }

  def polling_warnings = log.string.lines.grep(/workhorse\.worker\.polling_only/)

  # The backends of the pool named +application_name+ whose latest statement is LISTEN.
  def listener_backends(application_name)
    observer = ScratchDatabase.connect
    observer.exec_params("SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() " \
      "AND application_name = $1 AND query LIKE 'LISTEN %'", [application_name]).getvalue(0, 0).to_i
  ensure
    observer&.close
  end

  def succeeded(task_ids)
    @connection.exec_params("SELECT count(*) FROM (SELECT task_id, state FROM workhorse.task_outcome " \
      "UNION ALL SELECT task_id, state FROM workhorse.fast_task_outcome) outcome " \
      "WHERE outcome.state = 'succeeded' AND outcome.task_id::text = ANY($1::text[])",
      [PG::TextEncoder::Array.new.encode(task_ids)]).getvalue(0, 0).to_i
  end

  # Runs one worker on a fresh pool of +size+ connections. Two tasks exist before
  # the start. A third arrives once both ran, so it needs a later claim. The worker yields
  # +listening+, an event that the shared listener sets once its LISTEN has returned, to +started+.
  # Returns the listener backends that each handler saw.
  def complete_three_tasks(size, started: nil)
    name = "#{@queue_name}-#{size}"
    pool = ConnectionPool.new(size: size, timeout: pool_timeout) do
      PG.connect(ScratchDatabase.url, application_name: name, connect_timeout: 10)
    end
    handled = Array.new(3) { Concurrent::Event.new }
    count = Concurrent::AtomicFixnum.new
    seen = Concurrent::Array.new
    errors = Concurrent::Array.new
    subject = W::Worker.new(pool, queues: [name], worker_id: name, poll_interval: 0.05,
      heartbeat: 0.2, lease: 5, logger: logger, on_registration_error: ->(error) { errors << error },
      on_notification_error: ->(error) { errors << error })
    subject.handle("small-pool") do
      pool.with { |connection| connection.exec("SELECT 1") }
      seen << listener_backends(name)
      handled[count.increment - 1]&.set
      {}
    end
    listening = Concurrent::Event.new
    # The shared listener wakes every subscriber once its LISTEN has returned.
    allow(subject).to receive(:notify).and_wrap_original do |original|
      listening.set
      original.call
    end
    tasks = Array.new(2) { W::Queue.new(@connection, default_queue: name).enqueue("small-pool", {}).task_id }
    thread = Thread.new do
      subject.run
    rescue => e
      errors << e
    end
    begin
      started&.call(listening, name)
      expect(handled[1].wait(wait)).to be(true), "the first two tasks did not run: #{errors.to_a.inspect}"
      tasks << W::Queue.new(@connection, default_queue: name).enqueue("small-pool", {}).task_id
      expect(handled[2].wait(wait)).to be(true), "the third task did not run: #{errors.to_a.inspect}"
    ensure
      subject.stop
      thread.join(15)
    end
    expect(thread).not_to be_alive
    expect(errors).to be_empty
    expect(succeeded(tasks)).to eq(3)
    # After the stop, the pool lends every connection at once.
    expect(pool.available).to eq(size)
    pool.with(timeout: 1) { |connection| connection.exec("SELECT 1") }
    {seen: seen.to_a, listened: listening.set?}
  ensure
    pool&.shutdown(&:close)
  end

  it "keeps one shared listener on a pool of 3 and logs no polling warning" do
    observed = []
    result = complete_three_tasks(3, started: lambda do |listening, name|
      expect(listening.wait(wait)).to be(true), "the worker never listened"
      observed << listener_backends(name)
    end)
    expect(observed).to eq([1])
    expect(result[:listened]).to be(true)
    expect(polling_warnings).to be_empty, log.string
  end

  it "refuses a pool of 1 or 2 before it opens a connection" do
    [1, 2].each do |size|
      pool = ConnectionPool.new(size: size, timeout: pool_timeout) { raise "the worker must not connect" }
      expect { W::Worker.new(pool, queues: [@queue_name]) }.to raise_error(ArgumentError,
        "Worker needs a pool with a known maximum size of at least 3 connections (found #{size}). " \
        "Give the worker a pool with a maximum size of at least 3.")
    end
  end
end
