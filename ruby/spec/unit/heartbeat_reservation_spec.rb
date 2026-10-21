# frozen_string_literal: true

require "logger"
require "spec_helper"
require "connection_pool"

# SM-1577: a worker with the dedicated heartbeat connection reserves that connection before it
# registers, keeps it while it runs, and claims nothing while it has no usable reservation. No
# example sleeps for a fixed time: each one waits for a state that it can observe.
RSpec.describe "Worker heartbeat reservation" do
  fast_claim = W::SqlCatalogue::COMPLETE_MANY_AND_CLAIM_V1

  def monotonic = Process.clock_gettime(Process::CLOCK_MONOTONIC)

  def wait_until(timeout = 5)
    deadline = monotonic + timeout
    sleep 0.005 until yield || monotonic > deadline
    raise "condition not met within #{timeout} seconds" unless yield
  end

  def task_row(number)
    {
      "task_id" => format("00000000-0000-4000-8000-%012d", number), "task_type" => "t", "priority" => "0",
      "payload" => "{}", "attempt" => "1", "max_attempts" => "3", "fence_token" => "1",
      "redact_error_details" => "f"
    }
  end

  # The claim statements in +statements+: every claim_many_v1, and every
  # complete_many_and_claim_v1 with a claim limit above zero.
  define_method(:claims_in) do |statements|
    statements.select do |sql, params|
      sql == W::SqlCatalogue::CLAIM_MANY_V1 || (sql == fast_claim && params[5].to_i.positive?)
    end
  end

  define_method(:completions_in) do |statements|
    statements.select { |sql, params| sql == fast_claim && params[1] != "{}" }
  end

  def heartbeat_of(source) = W::Worker.const_get(:Heartbeat).dedicated(source)

  # Whether the heartbeat of +source+ has ended: no registered thread and no checkout in flight.
  def heartbeat_idle?(source)
    heartbeat = heartbeat_of(source)
    heartbeat.instance_variable_get(:@thread).nil? && heartbeat.instance_variable_get(:@acquisition).nil?
  end

  def claim_threads = Thread.list.select { |thread| thread.alive? && thread.name&.start_with?("workhorse-claim") }

  # Lets the dispatch loop of +subject+ run one more pass, and returns when the loop waits again and
  # no claim thread of it runs. A dispatch pass resets the wake event first, so an unset event after
  # the wake shows that the pass ran.
  def dispatch_pass(subject)
    wake = subject.instance_variable_get(:@wake)
    2.times do
      subject.send(:wake_dispatcher)
      wait_until { !wake.set? }
    end
    wait_until { claim_threads.empty? }
  end

  # A PG error that Executor.translate reads as a deadlock (40P01), so fenced_rows sends again.
  def deadlock
    result = Object.new
    result.define_singleton_method(:error_field) { |field| (field == PG::PG_DIAG_SQLSTATE) ? "40P01" : nil }
    error = PG::TRDeadlockDetected.new("deadlock detected")
    error.define_singleton_method(:result) { result }
    error
  end

  # Holds heartbeat checkouts of +source+ until +lend+ is set, and while +hold+ is true, holds the
  # return of each heartbeat connection until +released+ is set. +returning+ is set when a return
  # waits.
  def hold_heartbeat_returns(source, lend:, hold:, returning:, released:)
    source.define_singleton_method(:with) do |&block|
      lend.wait(10) if Thread.current.name == "workhorse-heartbeat-checkout"
      super() do |connection|
        block.call(connection)
      ensure
        if hold.true? && Thread.current.name == "workhorse-heartbeat-checkout"
          returning.set
          released.wait(10)
        end
      end
    end
  end

  # Whether the heartbeat thread of +source+ waits in +acquire+ while +cycle+ is still the current
  # cycle: it starts no second checkout then.
  def waits_for_cycle?(source, cycle)
    heartbeat = heartbeat_of(source)
    thread = heartbeat.instance_variable_get(:@thread)
    heartbeat.instance_variable_get(:@acquisition).equal?(cycle) && thread&.alive? &&
      thread.backtrace&.any? { |line| line.include?("Heartbeat#acquire") }
  end

  # The wake event of a heartbeat, which pauses the heartbeat thread at its next wait once armed.
  # Every other use passes through.
  gated_wake = Class.new do
    attr_reader :paused

    def initialize(inner)
      @inner = inner
      @armed = Concurrent::AtomicBoolean.new(false)
      @paused = Concurrent::Event.new
      @gate = Concurrent::Event.new
    end

    def arm! = @armed.make_true

    def release! = @gate.set

    def set = @inner.set

    def reset = @inner.reset

    def set? = @inner.set?

    def wait(timeout = nil)
      if Thread.current.name == "workhorse-heartbeats" && @armed.make_false
        @paused.set
        @gate.wait(10)
        return true
      end
      @inner.wait(timeout)
    end
  end
  define_method(:gated_wake) { gated_wake }

  # Answers a fast-tier claim, fused or plain, with the tasks in +pending+.
  let(:pending) { Concurrent::Array.new }
  let(:pool) do
    FakeLendingPool.new do |sql, params|
      next [] unless sql == fast_claim

      accepted = W::Values.text_array(W::Values.parse_text_array(params[1]), "accepted")
      claimed = pending.shift(params[5].to_i)
      claimed = [{"task_id" => nil}] if claimed.empty?
      [claimed.first.merge("accepted" => accepted), *claimed.drop(1)]
    end
  end

  def worker(**options)
    W::Worker.new(pool, queues: ["default"], polling_only: true, poll_interval: 0.01, disable_registry: true,
      heartbeat: 0.1, lease: 30, **options)
  end

  def start(subject)
    thread = Thread.new { subject.run }
    @runs << [subject, thread]
    thread
  end

  before { @runs = [] }

  after do
    @runs.each { |subject, _| subject.stop }
    @runs.each { |_, thread| thread.join(5) }
  end

  it "reserves the heartbeat connection before the worker registers or claims" do
    first_checkout = nil
    pool.define_singleton_method(:with) do |&block|
      first_checkout ||= statements.map(&:first)
      super(&block)
    end
    worker(disable_registry: false).run_once
    expect(first_checkout).to eq([])
    expect(pool.statements.map(&:first)).to include(W::SqlCatalogue::REGISTER_WORKER_V1)
    # The heartbeat connection and the readiness query.
    expect(pool.checkouts.value).to eq(2)
    wait_until { pool.held.empty? }
  end

  it "refuses to start when the pool cannot lend the heartbeat connection within the startup budget" do
    stub_const("Stablemates::Workhorse::Worker::STARTUP_BUDGET_FLOOR", 0.3)
    pool.refuse = true
    started = monotonic
    expect { worker.run_once }.to raise_error(W::WorkerStartupError) { |error|
      expect(error.message).to include("FakeLendingPool (size 3)", "0.3 s", "shared_heartbeats: true")
    }
    expect(monotonic - started).to be_between(0.3, 2)
    # Nothing registered and nothing claimed.
    expect(pool.statements).to be_empty
    # The refused worker leaves no thread and no checkout behind.
    wait_until { heartbeat_idle?(pool) }
    expect(pool.held).to be_empty
  end

  it "gives a heartbeat connection that arrives after the startup budget to one owner, which returns it" do
    stub_const("Stablemates::Workhorse::Worker::STARTUP_BUDGET_FLOOR", 0.3)
    lend = Concurrent::Event.new
    pool.define_singleton_method(:with) do |&block|
      lend.wait(10) if Thread.current.name == "workhorse-heartbeat-checkout"
      super(&block)
    end
    expect { worker.run_once }.to raise_error(W::WorkerStartupError, /heartbeat connection/)
    # Repeated refusals wait on the same one pending checkout.
    expect { worker.run_once }.to raise_error(W::WorkerStartupError)
    expect(Thread.list.count { |thread| thread.name == "workhorse-heartbeat-checkout" && thread.alive? }).to eq(1)
    # The heartbeat thread waits for the checkout at most one round bound at a time, so it ends
    # with the last worker, while the checkout thread still owns the pending checkout.
    wait_until { heartbeat_of(pool).instance_variable_get(:@thread).nil? }
    expect(heartbeat_of(pool).instance_variable_get(:@acquisition)).not_to be_nil

    lend.set
    wait_until { heartbeat_idle?(pool) && pool.held.empty? }
    expect(pool.checkouts.value).to eq(1)
  end

  it "keeps its own error when the compatibility query fails on the borrowed connection" do
    pool.define_singleton_method(:with) do |&block|
      next super(&block) unless Thread.current.name == "workhorse-readiness"

      broken = Object.new
      broken.define_singleton_method(:exec_params) { |*| raise PG::InsufficientPrivilege, "permission denied" }
      broken.define_singleton_method(:status) { PG::CONNECTION_OK }
      block.call(broken)
    end
    expect { worker.run_once }.to raise_error(W::DatabaseError, /permission denied/)
    expect(pool.statements).to be_empty
  end

  it "refuses to start when the readiness query does not end within the startup budget" do
    stub_const("Stablemates::Workhorse::Worker::STARTUP_BUDGET_FLOOR", 0.3)
    stall = Concurrent::Event.new
    pool.define_singleton_method(:with) do |&block|
      next super(&block) unless Thread.current.name == "workhorse-readiness"

      stalled = Object.new
      stalled.define_singleton_method(:exec_params) { |*| stall.wait(10) && raise(PG::ConnectionBad, "ended") }
      stalled.define_singleton_method(:status) { PG::CONNECTION_OK }
      block.call(stalled)
    end
    started = monotonic
    expect { worker.run_once }.to raise_error(W::WorkerStartupError, /could not finish its readiness query.*0\.3 s/)
    expect(monotonic - started).to be < 2
  ensure
    stall&.set
  end

  it "refuses to start when the readiness check cannot borrow a connection" do
    stub_const("Stablemates::Workhorse::Worker::STARTUP_BUDGET_FLOOR", 0.3)
    pool.define_singleton_method(:with) do |&block|
      raise PG::ConnectionBad, "connection refused" if Thread.current.name == "workhorse-readiness"

      super(&block)
    end
    expect { worker.run_once }.to raise_error(W::WorkerStartupError, /readiness check.*shared_heartbeats: true/)
    expect(pool.statements).to be_empty
    wait_until { pool.held.empty? }
  end

  it "ends a run at once when it stops while it waits for the heartbeat connection" do
    pool.refuse = true
    subject = worker
    runner = Thread.new { subject.run }
    wait_until { pool.checkouts.value >= 1 }
    stopped = monotonic
    subject.stop
    expect(runner.join(1)).not_to be_nil
    expect(monotonic - stopped).to be < 0.5
    expect(pool.statements).to be_empty
  end

  it "starts under shared_heartbeats without a reserved connection" do
    pool.refuse = true
    expect(worker(shared_heartbeats: true).run_once).to be(false)
    expect(pool.checkouts.value).to eq(0)
  end

  it "keeps the reservation while workers run with no task, and releases it when the last worker stops" do
    first = worker
    second = worker
    start(first)
    wait_until { first.instance_variable_get(:@dispatch_slots)&.gate&.ready? }
    start(second)
    wait_until { second.instance_variable_get(:@dispatch_slots)&.gate&.ready? }
    # Two readiness borrows, one after the other, and the one heartbeat connection.
    expect(pool.checkouts.value).to eq(3)
    held = pool.held.first
    # Three probes with no task: the heartbeat keeps the one connection.
    probes = held.probes.value
    wait_until { held.probes.value >= probes + 3 }
    expect(pool.held).to eq([held])
    expect(pool.checkouts.value).to eq(3)

    first.stop
    @runs.first.last.join(5)
    probes = held.probes.value
    wait_until { held.probes.value >= probes + 2 }
    expect(pool.held).to eq([held])

    second.stop
    @runs.last.last.join(5)
    wait_until { pool.held.empty? && heartbeat_idle?(pool) }
  end

  it "keeps the heartbeat thread registered until the pool has the old connection back" do
    holding = Concurrent::AtomicBoolean.new(false)
    returning = Concurrent::Event.new
    released = Concurrent::Event.new
    pool.define_singleton_method(:with) do |&block|
      super() do |connection|
        block.call(connection)
      ensure
        if holding.true? && Thread.current.name == "workhorse-heartbeat-checkout"
          returning.set
          released.wait(10)
        end
      end
    end
    first = worker
    start(first)
    wait_until { first.instance_variable_get(:@dispatch_slots)&.gate&.ready? }
    heartbeat = heartbeat_of(pool)
    thread = heartbeat.instance_variable_get(:@thread)
    checkouts = pool.checkouts.value

    holding.make_true
    first.stop
    @runs.first.last.join(5)
    expect(returning.wait(5)).to be(true)
    # A worker reserves while the old return is still held: the old thread serves it.
    second = worker
    start(second)
    wait_until { heartbeat.instance_variable_get(:@users).size == 1 }
    expect(heartbeat.instance_variable_get(:@thread)).to equal(thread)
    expect(pool.checkouts.value).to eq(checkouts)

    holding.make_false
    released.set
    wait_until { second.instance_variable_get(:@dispatch_slots)&.gate&.ready? }
    expect(heartbeat.instance_variable_get(:@thread)).to equal(thread)
    expect(pool.held.size).to eq(1)
  ensure
    released&.set
  end

  it "keeps a disposed late checkout current until its pool return settles" do
    stub_const("Stablemates::Workhorse::Worker::STARTUP_BUDGET_FLOOR", 0.3)
    lend = Concurrent::Event.new
    hold = Concurrent::AtomicBoolean.new(false)
    returning = Concurrent::Event.new
    released = Concurrent::Event.new
    hold_heartbeat_returns(pool, lend:, hold:, returning:, released:)
    expect { worker.run_once }.to raise_error(W::WorkerStartupError, /heartbeat connection/)
    heartbeat = heartbeat_of(pool)
    wait_until { heartbeat.instance_variable_get(:@thread).nil? }
    cycle = heartbeat.instance_variable_get(:@acquisition)

    # The connection arrives with no worker left, and its return to the pool waits.
    hold.make_true
    lend.set
    expect(returning.wait(5)).to be(true)
    second = worker
    start(second)
    wait_until { pool.checkouts.value >= 2 || waits_for_cycle?(pool, cycle) }
    expect(pool.checkouts.value).to eq(1)
    expect(pool.held.size).to eq(1)
    expect(second.instance_variable_get(:@dispatch_slots)).to be_nil

    hold.make_false
    released.set
    wait_until { second.instance_variable_get(:@dispatch_slots)&.gate&.ready? }
    # The old checkout, then one new heartbeat checkout and the readiness borrow of the new run.
    expect(pool.checkouts.value).to eq(3)
    expect(pool.held.size).to eq(1)
  ensure
    released&.set
  end

  it "keeps an arrived checkout that no heartbeat took current until its pool return settles" do
    lend = Concurrent::Event.new
    hold = Concurrent::AtomicBoolean.new(false)
    returning = Concurrent::Event.new
    released = Concurrent::Event.new
    hold_heartbeat_returns(pool, lend:, hold:, returning:, released:)
    heartbeat = heartbeat_of(pool)
    wake = gated_wake.new(heartbeat.instance_variable_get(:@wake))
    heartbeat.instance_variable_set(:@wake, wake)
    wake.arm!

    # The heartbeat thread pauses in its backoff while the checkout is still pending.
    first = worker
    start(first)
    expect(wake.paused.wait(5)).to be(true)
    lend.set
    wait_until { heartbeat.instance_variable_get(:@acquisition)&.arrived&.set? }
    cycle = heartbeat.instance_variable_get(:@acquisition)
    first.stop
    @runs.first.last.join(5)

    # The heartbeat thread finds no worker, gives the connection back, and its return waits.
    hold.make_true
    wake.release!
    expect(returning.wait(5)).to be(true)
    second = worker
    start(second)
    wait_until { pool.checkouts.value >= 2 || waits_for_cycle?(pool, cycle) }
    expect(pool.checkouts.value).to eq(1)
    expect(pool.held.size).to eq(1)

    hold.make_false
    released.set
    wait_until { second.instance_variable_get(:@dispatch_slots)&.gate&.ready? }
    # The old checkout, then one new heartbeat checkout and the readiness borrow of the new run.
    expect(pool.checkouts.value).to eq(3)
  ensure
    wake&.release!
    released&.set
  end

  describe "with a registry" do
    let(:registry) { Concurrent::Map.new }
    let(:stall) { Concurrent::Event.new }
    let(:stalling) { Concurrent::AtomicBoolean.new(true) }
    let(:deleted) { Concurrent::Event.new }
    # Answers register_worker_v1 and deregister_worker_v1 as PostgreSQL does: one row for each
    # worker ID, and a deletion by worker ID only. The first deletion waits for +stall+, and sets
    # +deleted+ once it has deleted.
    let(:registry_pool) do
      rows = registry
      gate = stall
      first = stalling
      done = deleted
      FakeLendingPool.new do |sql, params|
        case sql
        when W::SqlCatalogue::REGISTER_WORKER_V1 then rows[params[0]] = params[1]
        when W::SqlCatalogue::DEREGISTER_WORKER_V1
          stalled = first.make_false
          gate.wait(10) if stalled
          rows.delete(params[0])
          done.set if stalled
        end
        []
      end
    end

    def registry_worker
      W::Worker.new(registry_pool, queues: ["default"], polling_only: true, poll_interval: 0.01, heartbeat: 0.1,
        shutdown_grace: 0.1, registry_interval: 60, worker_id: "registered")
    end

    after { stall.set }

    it "refuses a new run while a stop statement of the previous run still runs" do
      stub_const("Stablemates::Workhorse::Worker::STARTUP_BUDGET_FLOOR", 0.3)
      subject = registry_worker
      subject.run_once
      registrations = registry_pool.statements.count { |sql, _| sql == W::SqlCatalogue::REGISTER_WORKER_V1 }
      expect { subject.run_once }.to raise_error(W::WorkerStartupError, /previous run did not end.*0\.3 s/)
      expect(registry_pool.statements.count { |sql, _| sql == W::SqlCatalogue::REGISTER_WORKER_V1 }).to eq(registrations)
    end

    it "ends a restart at a stop while the restart waits for a stop statement of the previous run" do
      subject = registry_worker
      subject.run_once
      registrations = registry_pool.statements.count { |sql, _| sql == W::SqlCatalogue::REGISTER_WORKER_V1 }
      runner = start(subject)
      wait_until { runner.backtrace&.any? { |line| line.include?("await_previous_stop") } }

      stopped = monotonic
      subject.stop
      expect(runner.join(1)).not_to be_nil
      # The grace is 0.1 s and the unwind window 0.25 s. The old deregistration still waits.
      expect(monotonic - stopped).to be < 0.35
      expect(registry_pool.statements.count { |sql, _| sql == W::SqlCatalogue::REGISTER_WORKER_V1 }).to eq(registrations)
      expect(subject.instance_variable_get(:@stop_statements)).not_to be_empty
    end

    it "ends a restart that was stopped during a join in which the old stop statement ended" do
      subject = registry_worker
      subject.run_once
      old = subject.instance_variable_get(:@stop_statements).find(&:alive?)
      # The restart pauses after its next timed join of the old statement.
      armed = Concurrent::AtomicBoolean.new(true)
      paused = Concurrent::Event.new
      resume = Concurrent::Event.new
      old.define_singleton_method(:join) do |*arguments|
        result = super(*arguments)
        if armed.make_false
          paused.set
          resume.wait(10)
        end
        result
      end
      checkouts = registry_pool.checkouts.value
      runner = start(subject)
      expect(paused.wait(5)).to be(true)

      subject.stop
      stall.set
      wait_until { !old.alive? }
      resumed = monotonic
      resume.set
      expect(runner.join(1)).not_to be_nil
      # The grace is 0.1 s and the unwind window 0.25 s.
      expect(monotonic - resumed).to be < 0.35
      # The stopped restart reserved no heartbeat connection and borrowed no readiness connection.
      expect(registry_pool.checkouts.value).to eq(checkouts)
    ensure
      resume&.set
    end

    it "lets no stop statement of the previous run delete the registry row of a new run" do
      subject = registry_worker
      subject.run_once
      first_instance = registry["registered"]
      runner = start(subject)
      wait_until do
        registry["registered"] != first_instance ||
          runner.backtrace&.any? { |line| line.include?("await_previous_stop") }
      end

      stall.set
      expect(deleted.wait(5)).to be(true)
      wait_until(2) do
        instance = subject.instance_variable_get(:@instance_id)
        instance != first_instance && registry["registered"] == instance
      end
    end
  end

  it "replaces a lost connection while no task runs, and claims nothing until the replacement is ready" do
    subject = worker(poll_interval: 60)
    start(subject)
    wait_until { pool.held.size == 1 && claims_in(pool.statements).any? }
    pool.refuse = true
    attempts = pool.checkouts.value
    pool.held.first.lose
    # The heartbeat notices the loss without a member, and tries again with a capped backoff.
    wait_until(1) { pool.checkouts.value >= attempts + 2 }
    mark = pool.statements.size
    dispatch_pass(subject)
    expect(claims_in(pool.statements.drop(mark))).to be_empty

    mark = pool.statements.size
    pool.refuse = false
    # The empty wait of this worker is 5 s. Only the recovery wake claims this soon.
    wait_until(1) { claims_in(pool.statements.drop(mark)).any? }
    expect(pool.held.size).to eq(1)
  end

  it "closes the gate when a failed round discards a connection whose session is still open" do
    pending << task_row(1)
    release = Concurrent::Event.new
    running = Concurrent::Event.new
    subject = worker(poll_interval: 60).handle("t") do
      running.set
      release.wait(5)
      {}
    end
    start(subject)
    expect(running.wait(5)).to be(true)
    gate = subject.instance_variable_get(:@dispatch_slots).gate
    connection = pool.held.first

    # The replacement checkout waits, as on a pool with no free connection.
    pool.block = Concurrent::Event.new
    attempts = pool.checkouts.value
    connection.slow_heartbeats!
    wait_until(2) { pool.checkouts.value > attempts }
    expect(connection.closed?).to be(true)
    expect(gate.ready?).to be(false)

    mark = pool.statements.size
    release.set
    wait_until { completions_in(pool.statements.drop(mark)).any? }
    expect(completions_in(pool.statements.drop(mark)).first[1][5]).to eq("0")

    # The heartbeat waited for that checkout at most one round bound at a time, and it started no
    # second one. When the pool lends the connection late, the one checkout hands it over.
    expect(Thread.list.count { |thread| thread.name == "workhorse-heartbeat-checkout" && thread.alive? }).to eq(1)
    pool.block.set
    wait_until { gate.ready? }
    expect(pool.checkouts.value).to eq(attempts + 1)
  ensure
    pool.block&.set
  end

  it "ends the stop within the grace and the unwind window when a registration statement hangs" do
    stall = Concurrent::Event.new
    hanging = FakeLendingPool.new do |sql, _params|
      stall.wait(10) if sql == W::SqlCatalogue::DEREGISTER_WORKER_V1
      []
    end
    subject = W::Worker.new(hanging, queues: ["default"], polling_only: true, poll_interval: 0.01, heartbeat: 0.1,
      shutdown_grace: 0.2, registry_interval: 0.1)
    runner = Thread.new { subject.run }
    wait_until { hanging.statements.any? { |sql, _| sql == W::SqlCatalogue::REGISTER_WORKER_V1 } }
    stopped = monotonic
    subject.stop
    expect(runner.join(5)).not_to be_nil
    # The grace is 0.2 s and the unwind window 0.25 s. The hanging statement waits up to 10 s.
    expect(monotonic - stopped).to be < 1
    expect(hanging.statements.map(&:first)).to include(W::SqlCatalogue::DEREGISTER_WORKER_V1)
  ensure
    stall&.set
  end

  it "keeps the dedicated heartbeat thread after a round raises an unexpected error" do
    renewals = Concurrent::Array.new
    task = W::ClaimedTask.from_row(task_row(1), "default")
    member = W::Worker::Heartbeat::Member.new(
      worker_id: "w", task: task, lease_ms: 30_000, interval: 0.1, logger: Logger.new(IO::NULL),
      renew: ->(_sent_at) { renewals << task.id }, settle: ->(_status) {}, fail: ->(_error) {},
      lease_ends_at: -> { monotonic + 60 }
    )
    # The second probe of this connection, at the top of the rounds, raises an error that is not a
    # PG error. The first probe, before the gate opens, passes.
    broken = FakeHeartbeatConnection.new
    broken.define_singleton_method(:socket_io) do
      raise "injected" if probes.increment > 1

      super()
    end
    lending = FakeHeartbeatPool.new([broken, FakeHeartbeatConnection.new])
    heartbeat = W::Worker.const_get(:Heartbeat).new(lending, dedicated: true)
    unregister = heartbeat.register(member)
    wait_until { renewals.any? }
    expect(lending.lent.size).to eq(2)
    expect(broken.closed?).to be(true)
  ensure
    unregister&.call
  end

  it "claims nothing of either kind while the heartbeat connection is missing" do
    pending << task_row(1)
    release = Concurrent::Event.new
    running = Concurrent::Event.new
    subject = worker(poll_interval: 60).handle("t") do
      running.set
      release.wait(5)
      {}
    end
    start(subject)
    expect(running.wait(5)).to be(true)

    pool.refuse = true
    attempts = pool.checkouts.value
    pool.held.first.lose
    wait_until(1) { pool.checkouts.value > attempts }
    mark = pool.statements.size
    pending << task_row(2)
    release.set
    # The fused completion settles the task with a claim limit of zero.
    wait_until { completions_in(pool.statements.drop(mark)).any? }
    expect(completions_in(pool.statements.drop(mark)).first[1][5]).to eq("0")
    dispatch_pass(subject)
    expect(claims_in(pool.statements.drop(mark))).to be_empty

    mark = pool.statements.size
    pool.refuse = false
    # Dispatch wakes when the replacement is ready, and claims the waiting task.
    wait_until(1) { claims_in(pool.statements.drop(mark)).any? }
    wait_until { pending.empty? }
  end

  describe "with statements that need a checkout" do
    let(:through) do
      FakeThroughPool.new do |sql, params|
        next [] unless sql == fast_claim

        accepted = W::Values.text_array(W::Values.parse_text_array(params[1]), "accepted")
        claimed = pending.shift(params[5].to_i)
        claimed = [{"task_id" => nil}] if claimed.empty?
        [claimed.first.merge("accepted" => accepted), *claimed.drop(1)]
      end
    end

    def through_worker(**options)
      W::Worker.new(through, queues: ["default"], polling_only: true, poll_interval: 60, disable_registry: true,
        heartbeat: 0.1, lease: 30, maintenance_interval: 3600, **options)
    end

    def start_through(subject)
      thread = Thread.new do
        Thread.current.name = "test-runner"
        subject.run
      end
      @runs << [subject, thread]
      thread
    end

    # Loses the heartbeat connection while the pool refuses a new one, and returns once the
    # heartbeat has asked again, so the claim gate is closed.
    def lose_heartbeat
      through.refuse_heartbeat = true
      attempts = through.heartbeat_checkouts.value
      through.heartbeat.lose
      wait_until(2) { through.heartbeat_checkouts.value > attempts }
    end

    after { through.hold&.set }

    it "sends no claim when the heartbeat connection is lost while the claim waits for its connection" do
      pending << task_row(1)
      through.hold = Concurrent::Event.new
      subject = through_worker.handle("t") { {} }
      start_through(subject)
      wait_until { through.waiting.any? { |thread| thread.name&.start_with?("workhorse-claim") } }

      lose_heartbeat
      through.hold.set
      wait_until { claim_threads.empty? }
      expect(claims_in(through.statements)).to be_empty
      expect(pending.size).to eq(1)

      through.refuse_heartbeat = false
      wait_until(2) { pending.empty? }
    end

    it "sends no claim from a claim of a run that ended, also when a later run holds a reservation" do
      through.hold = Concurrent::Event.new
      subject = through_worker(shutdown_grace: 0.2)
      start_through(subject)
      wait_until { through.waiting.any? { |thread| thread.name&.start_with?("workhorse-claim") } }
      old_claim = through.waiting.find { |thread| thread.name&.start_with?("workhorse-claim") }

      # The first run stops while its claim still waits for a connection, and the claim outlives it.
      subject.stop
      @runs.first.last.join(5)
      expect(old_claim).to be_alive
      start_through(subject)
      wait_until { subject.instance_variable_get(:@dispatch_slots)&.gate&.ready? }

      through.hold.set
      wait_until { !old_claim.alive? }
      expect(through.statements.select { |_, _, thread| thread.equal?(old_claim) }).to be_empty
    end

    # Runs +subject+ on a thread named "test-runner", which ends quietly when the drain abandons
    # a handler.
    def run_quietly(subject)
      thread = Thread.new do
        Thread.current.name = "test-runner"
        Thread.current.report_on_exception = false
        subject.run
      rescue W::ShutdownIncompleteError
        nil
      end
      @runs << [subject, thread]
      thread
    end

    it "keeps the reservation of a stopped run until a claim statement that it sent settles" do
      in_sql = Concurrent::Event.new
      release_sql = Concurrent::Event.new
      through.before_answer = lambda do |sql, params, _thread|
        next unless sql == fast_claim && params[1] == "{}" && params[5].to_i.positive?

        through.before_answer = nil
        in_sql.set
        release_sql.wait(10)
      end
      subject = through_worker(shutdown_grace: 0.1)
      runner = run_quietly(subject)
      expect(in_sql.wait(5)).to be(true)
      heartbeat = heartbeat_of(through)

      # The stop stops waiting for the claim after the grace, and the run ends.
      subject.stop
      expect(runner.join(5)).not_to be_nil
      expect(heartbeat.instance_variable_get(:@users).size).to eq(1)
      expect(heartbeat.ready?).to be(true)

      release_sql.set
      wait_until { heartbeat.instance_variable_get(:@users).empty? && heartbeat_idle?(through) }
    ensure
      release_sql&.set
    end

    it "keeps the reservation of a stopped run until a fused completion that can claim settles" do
      pending << task_row(1)
      in_sql = Concurrent::Event.new
      release_sql = Concurrent::Event.new
      through.before_answer = lambda do |sql, params, _thread|
        next unless sql == fast_claim && params[1] != "{}" && params[5].to_i.positive?

        through.before_answer = nil
        in_sql.set
        release_sql.wait(10)
      end
      subject = through_worker(shutdown_grace: 0.1).handle("t") { {} }
      runner = run_quietly(subject)
      expect(in_sql.wait(5)).to be(true)
      heartbeat = heartbeat_of(through)

      # The drain abandons the handler after the grace and the unwind window, and the run ends.
      subject.stop
      expect(runner.join(5)).not_to be_nil
      expect(heartbeat.instance_variable_get(:@users).size).to eq(1)

      release_sql.set
      wait_until { heartbeat.instance_variable_get(:@users).empty? && heartbeat_idle?(through) }
    ensure
      release_sql&.set
    end

    it "sends no claim in a deadlock retry after the gate closed" do
      through.before_answer = lambda do |sql, params, _thread|
        next unless sql == fast_claim && params[1] == "{}" && params[5].to_i.positive?

        through.before_answer = nil
        lose_heartbeat
        raise deadlock
      end
      subject = through_worker.handle("t") { {} }
      start_through(subject)
      wait_until { through.refuse_heartbeat && claim_threads.empty? }
      # The first attempt ran before the gate closed. Its retry read the gate again.
      expect(claims_in(through.statements).size).to eq(1)
    end

    it "sends a fused completion retry with a claim limit of zero after the gate closed" do
      pending << task_row(1)
      subject = through_worker.handle("t") { {} }
      through.before_answer = lambda do |sql, params, _thread|
        next unless sql == fast_claim && params[1] != "{}"

        through.before_answer = nil
        lose_heartbeat
        raise deadlock
      end
      start_through(subject)
      wait_until { completions_in(through.statements).size == 2 }
      expect(completions_in(through.statements).map { |_, params| params[5] }).to eq(%w[1 0])
    end

    it "sends a queued fused completion with a claim limit of zero when the gate closes before it is sent" do
      pending.concat([task_row(1), task_row(2)])
      running = Concurrent::Map.new
      releases = {task_row(1)["task_id"] => Concurrent::Event.new, task_row(2)["task_id"] => Concurrent::Event.new}
      subject = through_worker(concurrency: 2).handle("t") do |_payload, context|
        running[context.task.id] = true
        releases.fetch(context.task.id).wait(10)
        {}
      end
      start_through(subject)
      wait_until { running.size == 2 }
      batches = subject.instance_variable_get(:@pending_completions)

      # The first completion takes the statement of its batch and waits for its connection. The
      # second completion queues behind it.
      through.hold = Concurrent::Event.new
      releases.values.first.set
      wait_until { batches.size == 1 && through.waiting.size == 1 }
      releases.values.last.set
      wait_until { batches.values.first&.size == 1 }

      lose_heartbeat
      mark = through.statements.size
      through.hold.set
      wait_until { completions_in(through.statements).sum { |_, params| W::Values.parse_text_array(params[1]).size } == 2 }
      expect(completions_in(through.statements).map { |_, params| params[5] }).to all(eq("0"))
      expect(claims_in(through.statements.drop(mark))).to be_empty
    end
  end

  # A connection whose LISTEN stalls until +stall+ is set. It answers the compatibility query and
  # records every other statement in +statements+.
  stalling = Class.new(FakeHeartbeatConnection) do
    def initialize(stall, statements)
      super()
      @stall = stall
      @statements = statements
    end

    def exec(sql)
      @stall.wait(10) if sql.start_with?("LISTEN")
    end

    def wait_for_notify(timeout, &) = sleep(timeout)

    def exec_params(sql, params = [], *)
      @statements << sql unless sql == W::SqlCatalogue::COMPATIBILITY_STATE
      super
    end
  end

  it "starts and polls on a pool of 3 while LISTEN stalls" do
    stall = Concurrent::Event.new
    statements = Concurrent::Array.new
    stalled_pool = ConnectionPool.new(size: 3, timeout: 5) { stalling.new(stall, statements) }
    subject = W::Worker.new(stalled_pool, queues: ["default"], poll_interval: 0.05, disable_registry: true,
      heartbeat: 0.1, maintenance_interval: 3600)
    started = monotonic
    start(subject)
    # The listener holds one connection in its stalled LISTEN, and the heartbeat holds one. The
    # worker still polls on the third, well within the startup budget.
    wait_until(2) { statements.count(fast_claim) >= 2 }
    expect(monotonic - started).to be < 2
    expect(subject.instance_variable_get(:@dispatch_slots).listener.listening?).to be(false)
  ensure
    stall&.set
    @runs.each { |worker, _| worker.stop }
    @runs.each { |_, thread| thread.join(5) }
    @runs.clear
    stalled_pool&.shutdown { nil }
  end
end
