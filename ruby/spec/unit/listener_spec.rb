# frozen_string_literal: true

require "spec_helper"
require "connection_pool"

# A pool budgets one listener connection however many workers it serves (ADR 0071). Workers on one
# pool share that listener, each woken only for its own queues.
RSpec.describe W::Worker::Listener do
  # Stands in for a PG::Connection. It answers every worker statement with no rows, records
  # LISTEN and UNLISTEN, and delivers the payloads pushed onto +notifications+. While
  # +unlisten_gate+ is unset, UNLISTEN stalls as it would on a hung connection.
  fake = Struct.new(:id, :listening, :notifications, :closed, :unlisten_gate) do
    def exec_params(sql, _params, _format, _type_map)
      FakeRows.new((sql == W::SqlCatalogue::COMPATIBILITY_STATE) ? FakeExecutor::COMPATIBLE : [])
    end

    def exec(sql)
      unlisten_gate&.wait if sql.start_with?("UNLISTEN")
      self.listening = sql.start_with?("LISTEN")
    end

    def wait_for_notify(timeout)
      payload = notifications.pop(timeout:)
      yield "workhorse_tasks", 1, payload if payload
    end

    def status = PG::CONNECTION_OK

    def close = self.closed = true
  end

  rows_class = Struct.new(:rows) do
    attr_writer :type_map

    def to_a = rows

    def clear = nil
  end

  before { stub_const("FakeRows", rows_class) }

  let(:built) { [] }
  let(:pool) do
    ConnectionPool.new(size: 3, timeout: 2) do
      fake.new(built.size + 1, false, Thread::Queue.new, false).tap { |connection| built << connection }
    end
  end

  def worker(queue, concurrency: 1)
    W::Worker.new(pool, queues: [queue], concurrency:, disable_registry: true, maintenance_interval: 3600,
      maintenance_routine_interval: 3600, shutdown_grace: 1)
  end

  def listening = built.select(&:listening)

  def listener_connection
    expect(listening.size).to eq(1)
    listening.first
  end

  def eventually(seconds = 5)
    deadline = Process.clock_gettime(Process::CLOCK_MONOTONIC) + seconds
    until yield
      raise "condition not met within #{seconds}s" if Process.clock_gettime(Process::CLOCK_MONOTONIC) > deadline

      sleep 0.01
    end
  end

  def subscription(subject) = subject.instance_variable_get(:@dispatch_slots)&.listener

  # Starts +subject+ and returns its runner. +woken+ is set on each notification wake.
  def start(subject, woken = Concurrent::Event.new)
    allow(subject).to receive(:notify).and_wrap_original do |original|
      woken.set
      original.call
    end
    runner = Thread.new { subject.run }
    eventually { subscription(subject)&.listening? }
    runner
  end

  def stop(subject, runner)
    subject.stop
    expect(runner.join(5)).not_to be_nil
  end

  it "holds one listener connection for two workers, so a size-3 pool still lends one" do
    first = worker("a", concurrency: 16)
    second = worker("b", concurrency: 16)
    runners = [start(first), start(second)]
    expect(listening.size).to eq(1)
    # Each worker's default cohorts count the pool's one listener and one heartbeat connection.
    expect([first.cohorts, second.cohorts]).to eq([1, 1])

    # The heartbeat holds one connection while attempts run.
    heartbeat_holds = Concurrent::Event.new
    release = Concurrent::Event.new
    heartbeat = Thread.new do
      pool.with do
        heartbeat_holds.set
        release.wait(5)
      end
    end
    heartbeat_holds.wait(5)

    expect(pool.with(timeout: 0.5) { :lent }).to eq(:lent)
  ensure
    release&.set
    heartbeat&.join
    stop(first, runners[0]) if runners&.at(0)
    stop(second, runners[1]) if runners&.at(1)
  end

  it "wakes each worker only for its own queues and keeps the other after one stops" do
    first = worker("a")
    second = worker("b")
    second_woken = Concurrent::Event.new
    first_runner = start(first)
    second_runner = start(second, second_woken)
    connection = listener_connection

    stop(first, first_runner)
    expect(subscription(second).listening?).to be(true)
    expect(listener_connection).to equal(connection)

    second_woken.reset
    connection.notifications << "a"
    expect(second_woken.wait(0.5)).to be(false)
    connection.notifications << "b"
    expect(second_woken.wait(5)).to be(true)

    stop(second, second_runner)
    expect(listening).to be_empty
    expect(connection.closed).to be(false)
    expect(pool.available).to eq(3)
  ensure
    first.stop
    second.stop
  end

  it "keeps waking other subscribers when one callback raises" do
    shared = described_class.shared(pool)
    woken = Concurrent::Event.new
    failing = shared.subscribe(["q"], on_wake: -> { raise "subscriber bug" }, on_error: ->(_) {})
    healthy = shared.subscribe(["q"], on_wake: -> { woken.set }, on_error: ->(_) {})
    eventually { shared.listening? }
    woken.reset

    listener_connection.notifications << "q"
    expect(woken.wait(5)).to be(true)
  ensure
    failing&.close
    healthy&.close
  end

  it "starts again for a subscriber that arrives after the last one left" do
    shared = described_class.shared(pool)
    shared.subscribe(["q"], on_wake: -> {}, on_error: ->(_) {}).close
    again = shared.subscribe(["q"], on_wake: -> {}, on_error: ->(_) {})

    eventually { shared.listening? }
    expect(listening.size).to eq(1)
  ensure
    again&.close
  end

  it "lets a worker run and stop while the previous listener's teardown stalls" do
    shared = described_class.shared(pool)
    first = shared.subscribe(["q"], on_wake: -> {}, on_error: ->(_) {})
    eventually { shared.listening? }
    stalled = listener_connection
    stalled.unlisten_gate = Concurrent::Event.new
    first.close

    # The worker subscribes during the stall, polls without the listener, and still stops.
    subject = worker("q")
    runner = Thread.new { subject.run }
    eventually { subscription(subject) }
    stop(subject, runner)

    # A subscriber that arrives during the stall gets the listener once the old connection is free.
    again = shared.subscribe(["q"], on_wake: -> {}, on_error: ->(_) {})
    expect(shared.listening?).to be(false)
    stalled.unlisten_gate.set
    eventually { shared.listening? }
    expect(listening.size).to eq(1)
  ensure
    stalled&.unlisten_gate&.set
    subject&.stop
    again&.close
  end
end
