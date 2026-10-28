# frozen_string_literal: true

require "connection_pool"

# SM-1577: the heartbeat reservation against a real ConnectionPool and a real PostgreSQL backend.
RSpec.describe "Worker heartbeat reservation against PostgreSQL" do
  include_context "with a scratch database"

  def monotonic = Process.clock_gettime(Process::CLOCK_MONOTONIC)

  def wait_until(timeout = 5)
    deadline = monotonic + timeout
    sleep 0.01 until yield || monotonic > deadline
    raise "condition not met within #{timeout} seconds" unless yield
  end

  # The backend process IDs of the connections the heartbeat thread created, in order.
  let(:heartbeat_pids) { Concurrent::Array.new }
  let(:pool) do
    pids = heartbeat_pids
    ConnectionPool.new(size: 3, timeout: 1) do
      ScratchDatabase.connect.tap do |connection|
        pids << connection.backend_pid if Thread.current.name == "workhorse-heartbeat-checkout"
      end
    end
  end

  after { pool.shutdown(&:close) }

  def worker(**options)
    W::Worker.new(pool, queues: [@queue_name], polling_only: true, disable_registry: true, heartbeat: 0.2,
      lease: 5, **options)
  end

  it "refuses to start when every pool connection is busy, and leaves the pool whole" do
    stub_const("Stablemates::Workhorse::Worker::STARTUP_BUDGET_FLOOR", 0.5)
    release = Concurrent::Event.new
    holding = Concurrent::AtomicFixnum.new
    holders = Array.new(3) do
      Thread.new do
        pool.with do
          holding.increment
          release.wait(10)
        end
      end
    end
    wait_until { holding.value == 3 }

    started = monotonic
    expect { worker.run_once }.to raise_error(W::WorkerStartupError, /ConnectionPool \(size 3\).*0\.5 s; grow the pool, or check that the database accepts connections/)
    expect(monotonic - started).to be_between(0.5, 2)

    release.set
    holders.each(&:join)
    # The refused worker keeps no connection.
    wait_until { pool.available == 3 }
  ensure
    release&.set
  end

  it "notices a terminated heartbeat backend while no task runs, and keeps running tasks" do
    subject = worker(poll_interval: 0.05)
    done = Concurrent::Event.new
    subject.handle("t") { done.set && {} }
    runner = Thread.new { subject.run }
    wait_until { heartbeat_pids.size == 1 }

    checkouts = Concurrent::AtomicFixnum.new
    pool.define_singleton_method(:with) do |**options, &block|
      checkouts.increment if Thread.current.name == "workhorse-heartbeat-checkout"
      super(**options, &block)
    end
    @connection.exec_params("SELECT pg_terminate_backend($1)", [heartbeat_pids.first])
    # With no member, the heartbeat probes its held connection, discards it, and takes another
    # from the pool within about one probe interval.
    wait_until(1.5) { checkouts.value >= 1 }

    queue.enqueue("t", {})
    expect(done.wait(5)).to be(true)
    subject.stop
    expect(runner.join(10)).not_to be_nil
  ensure
    subject&.stop
  end
end
