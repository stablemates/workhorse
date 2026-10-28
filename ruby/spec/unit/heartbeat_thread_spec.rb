# frozen_string_literal: true

require "logger"
require "spec_helper"

# A heartbeat lock that runs +hook+ once, on the heartbeat thread, after the first critical section
# that finds no member and returns nil: the read of the shortest interval. +members+ is the member
# table of the heartbeat.
class HookedHeartbeatLock
  def initialize(lock, members)
    @lock = lock
    @members = members
    @hook = nil
  end

  def arm(&hook) = @hook = hook

  def synchronize(&)
    result = @lock.synchronize(&)
    hook = @hook
    if hook && result.nil? && Thread.current.name == "workhorse-heartbeats" && idle?
      @hook = nil
      hook.call
    end
    result
  end

  private

  def idle? = @lock.synchronize { @members.empty? }
end

# SM-1493: the heartbeat thread must not end while a member is registered. A register that sees a
# live thread starts no new one, so a thread that ended after it would leave the lease unrenewed.
RSpec.describe "Worker heartbeat thread" do
  heartbeat_class = W::Worker.const_get(:Heartbeat)

  def monotonic = Process.clock_gettime(Process::CLOCK_MONOTONIC)

  def claimed(number)
    W::ClaimedTask.new(
      id: format("00000000-0000-4000-8000-%012d", number), queue: "default", type: "t", priority: 0, payload: {},
      contract_version: nil, result_max_bytes: nil, redact_error_details: false, trace_context: nil,
      attempt: 1, max_attempts: 3, retry_policy: nil, deadline_at: nil, execution_timeout_ms: nil,
      attempt_timeout_at: nil, fence_token: 7, lease_expires_at: nil
    )
  end

  def member(task, renewals)
    W::Worker::Heartbeat::Member.new(
      worker_id: "w", task: task, lease_ms: 30_000, interval: 0.05, logger: Logger.new(IO::NULL),
      renew: ->(_sent_at) { renewals << task.id }, settle: ->(_status) {}, fail: ->(_error) {},
      lease_ends_at: -> { monotonic + 60 }
    )
  end

  def wait_until(timeout = 5)
    deadline = monotonic + timeout
    sleep 0.005 until yield || monotonic > deadline
    raise "condition not met within #{timeout} seconds" unless yield
  end

  # Lends a new FakeHeartbeatConnection, which accepts every lease, to each heartbeat checkout.
  let(:heartbeat) { heartbeat_class.new(FakeLendingPool.new) }
  let(:renewals) { Concurrent::Array.new }
  let(:first) { claimed(1) }
  let(:second) { claimed(2) }

  after do
    @unregister&.call
    thread = heartbeat.instance_variable_get(:@thread)
    expect(thread.join(2)).not_to be_nil if thread
  end

  it "keeps renewing a member that registers between the interval read and the idle check" do
    lock = HookedHeartbeatLock.new(heartbeat.instance_variable_get(:@lock), heartbeat.instance_variable_get(:@members))
    heartbeat.instance_variable_set(:@lock, lock)
    leave = heartbeat.register(member(first, renewals))
    wait_until { renewals.include?(first.id) }
    lock.arm { @unregister = heartbeat.register(member(second, renewals)) }
    leave.call
    wait_until { renewals.count(second.id) >= 2 }
    expect(heartbeat.instance_variable_get(:@thread)).to be_alive
  end

  it "keeps the thread when a round raises while a member is registered" do
    raised = Concurrent::AtomicBoolean.new
    original = heartbeat.method(:send_round)
    heartbeat.define_singleton_method(:send_round) do |*args, **options, &block|
      raise NoMethodError, "injected" if raised.make_true

      original.call(*args, **options, &block)
    end
    @unregister = heartbeat.register(member(first, renewals))
    wait_until { raised.true? }
    thread = heartbeat.instance_variable_get(:@thread)
    wait_until { renewals.count(first.id) >= 2 }
    expect(heartbeat.instance_variable_get(:@thread)).to equal(thread)
    expect(thread).to be_alive
  end
end
