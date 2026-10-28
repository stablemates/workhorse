# frozen_string_literal: true

require "logger"
require "spec_helper"

RSpec.describe "Worker heartbeat round bound" do
  heartbeat = Stablemates::Workhorse::Worker.const_get(:Heartbeat)

  it "is three quarters of the interval from 200 ms, and the interval up to 50 ms" do
    expect([0.01, 0.04, 0.05, 0.066, 0.069, 0.2, 10.0].map { |interval| heartbeat.round_bound(interval) })
      .to eq([0.01, 0.04, 0.05, 0.05, 0.051, 0.15, 7.5])
  end

  it "leaves a renewal margin after one timed-out round with the defaults" do
    lease = 30.0
    interval = lease / 3
    expect(2 * interval + heartbeat.round_bound(interval)).to be < lease
  end
end

RSpec.describe "Worker heartbeat batches" do
  heartbeat_class = Stablemates::Workhorse::Worker.const_get(:Heartbeat)
  member = Struct.new(:worker_id, :name)

  it "puts the members of each worker in batches of at most 100 leases" do
    members = Array.new(250) { |index| member.new("a", index) } + [member.new("b", 250)]
    batches = heartbeat_class.new(nil).send(:batches, members)
    expect(batches.map { |worker_id, group| [worker_id, group.size] }).to eq([["a", 100], ["a", 100], ["a", 50], ["b", 1]])
  end

  # SM-1633: the heartbeat statement and each idle gap get one quarter of the time that remains, and
  # one quarter is kept for the settings statement and COMMIT.
  it "gives the heartbeat statement and each idle gap one quarter, and at least 1 ms" do
    heartbeat = heartbeat_class.new(nil)
    expect([0.45, 0.1, 0.008, 0.003].map { |remaining| heartbeat.send(:round_timeouts, remaining) })
      .to eq([%w[112 112], %w[25 25], %w[2 2], %w[1 1]])
  end
end

# SM-1492: a dedicated round that expires before its heartbeat statement leaves its connection
# clean. The worker keeps that connection, because handlers can hold every other pool connection.
RSpec.describe "Worker heartbeat round expiry" do
  heartbeat_class = Stablemates::Workhorse::Worker.const_get(:Heartbeat)

  def monotonic = Process.clock_gettime(Process::CLOCK_MONOTONIC)

  def claimed(number)
    W::ClaimedTask.new(
      id: format("00000000-0000-4000-8000-%012d", number), queue: "default", type: "t", priority: 0, payload: {},
      contract_version: nil, result_max_bytes: nil, redact_error_details: false, trace_context: nil,
      attempt: 1, max_attempts: 3, retry_policy: nil, deadline_at: nil, execution_timeout_ms: nil,
      attempt_timeout_at: nil, fence_token: 7, lease_expires_at: nil
    )
  end

  def member(worker_id, number, interval, renewals)
    W::Worker::Heartbeat::Member.new(
      worker_id: worker_id, task: claimed(number), lease_ms: 30_000, interval: interval, logger: Logger.new(IO::NULL),
      renew: ->(_sent_at) { renewals << worker_id }, settle: ->(_status) {}, fail: ->(_error) {},
      lease_ends_at: -> { monotonic + 60 }
    )
  end

  def wait_until(timeout = 5)
    deadline = monotonic + timeout
    sleep 0.005 until yield || monotonic > deadline
    raise "condition not met within #{timeout} seconds" unless yield
  end

  # The kinds of the statements of each round on +connection+, split at each BEGIN.
  def rounds_of(connection)
    connection.sent.map(&:first).slice_before(:begin).to_a
  end

  # An interval of 0.6 s gives a round bound of 0.45 s, so a settings statement of 0.2 s uses more
  # than its quarter and still leaves time for the ROLLBACK.
  let(:interval) { 0.6 }
  let(:renewals) { Concurrent::Array.new }

  after { @unregister&.each(&:call) }

  it "sends nothing and keeps the connection when a round has less than 8 ms left before BEGIN" do
    connection = FakeHeartbeatConnection.new
    heartbeat = heartbeat_class.new(nil)
    expect { heartbeat.send(:bounded_rows, connection, W::SqlCatalogue::HEARTBEAT_MANY_V2, ["w", "[]"], 0.005) }
      .to raise_error(heartbeat_class.const_get(:RoundExpired))
    expect(connection.sent).to be_empty
    expect(connection.closed?).to be(false)
  end

  it "rolls back a round whose settings statement used more than its quarter, and keeps the connection" do
    connection = FakeHeartbeatConnection.new { |kind, count| (kind == :settings && count.zero?) ? 0.2 : 0 }
    pool = FakeHeartbeatPool.new([connection])
    heartbeat = heartbeat_class.new(pool)
    @unregister = [heartbeat.register(member("w", 1, interval, renewals))]
    wait_until { renewals.any? }
    expect(rounds_of(connection).first(2)).to eq([%i[begin settings rollback], %i[begin settings heartbeat commit]])
    expect(pool.lent).to eq([connection])
    expect(pool.discarded).to be_empty
    expect(connection.closed?).to be(false)
  end

  it "discards the connection when the ROLLBACK does not end by the round's deadline" do
    first = FakeHeartbeatConnection.new do |kind, count|
      if kind == :settings && count.zero? then 0.2
      elsif kind == :rollback then 1
      else 0
      end
    end
    second = FakeHeartbeatConnection.new
    pool = FakeHeartbeatPool.new([first, second])
    heartbeat = heartbeat_class.new(pool)
    @unregister = [heartbeat.register(member("w", 1, interval, renewals))]
    wait_until { renewals.any? }
    expect(rounds_of(first)).to eq([%i[begin settings rollback]])
    expect(pool.discarded).to eq([first])
    expect(first.closed?).to be(true)
    expect(rounds_of(second).first).to eq(%i[begin settings heartbeat commit])
  end

  it "discards the connection when the round's deadline passes while its heartbeat statement runs" do
    first = FakeHeartbeatConnection.new { |kind, _count| (kind == :heartbeat) ? 1 : 0 }
    second = FakeHeartbeatConnection.new
    pool = FakeHeartbeatPool.new([first, second])
    heartbeat = heartbeat_class.new(pool)
    @unregister = [heartbeat.register(member("w", 1, interval, renewals))]
    wait_until { renewals.any? }
    expect(rounds_of(first)).to eq([%i[begin settings heartbeat]])
    expect(pool.discarded).to eq([first])
    expect(first.closed?).to be(true)
  end

  # SM-1633: one transaction renews every worker on the pool, with one batch for each worker.
  it "renews the leases of every worker in one heartbeat statement in one transaction" do
    connection = FakeHeartbeatConnection.new
    pool = FakeHeartbeatPool.new([connection])
    heartbeat = heartbeat_class.new(pool)
    @unregister = %w[a b c].each_with_index.map { |worker_id, index| heartbeat.register(member(worker_id, index + 1, interval, renewals)) }
    wait_until { renewals.size >= 3 }
    expect(rounds_of(connection).first).to eq(%i[begin settings heartbeat commit])
    workers = connection.sent.find { |kind, _| kind == :heartbeat }[1]
    expect(workers).to contain_exactly("a", "b", "c")
    expect(renewals.first(3)).to contain_exactly("a", "b", "c")
    expect(pool.discarded).to be_empty
  end

  it "renews no lease of a round that expires at its settings statement, and renews every worker in the next round" do
    connection = FakeHeartbeatConnection.new { |kind, count| (kind == :settings && count.zero?) ? 0.2 : 0 }
    pool = FakeHeartbeatPool.new([connection])
    heartbeat = heartbeat_class.new(pool)
    @unregister = %w[a b c].each_with_index.map { |worker_id, index| heartbeat.register(member(worker_id, index + 1, interval, renewals)) }
    wait_until { renewals.size >= 3 }
    expect(rounds_of(connection).first(2)).to eq([%i[begin settings rollback], %i[begin settings heartbeat commit]])
    expect(renewals.first(3)).to contain_exactly("a", "b", "c")
    expect(pool.lent).to eq([connection])
    expect(pool.discarded).to be_empty
  end

  it "renews no lease of a round whose COMMIT fails, and discards the connection" do
    failing = Class.new(FakeHeartbeatConnection) do
      def send_query_params(sql, *rest)
        super
        raise PG::ConnectionBad, "injected" if sql == "COMMIT" && sent.count { |entry| entry[0] == :commit } == 1
      end
    end
    first = failing.new
    second = FakeHeartbeatConnection.new
    pool = FakeHeartbeatPool.new([first, second])
    heartbeat = heartbeat_class.new(pool)
    @unregister = %w[a b].each_with_index.map { |worker_id, index| heartbeat.register(member(worker_id, index + 1, interval, renewals)) }
    wait_until { renewals.size >= 2 }
    expect(rounds_of(first)).to eq([%i[begin settings heartbeat commit]])
    expect(pool.discarded).to eq([first])
    expect(rounds_of(second).first).to eq(%i[begin settings heartbeat commit])
    expect(renewals.first(2)).to contain_exactly("a", "b")
  end
end
