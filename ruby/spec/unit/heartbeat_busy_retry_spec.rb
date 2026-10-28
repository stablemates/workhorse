# frozen_string_literal: true

require "logger"
require "spec_helper"

# SM-1443: a busy lease gets no renewal and no ownership verdict. The heartbeat retries only the
# busy leases soon after the round, without moving the regular schedule.
RSpec.describe "Worker heartbeat busy retry" do
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

  # A member that records its renewals, its settled statuses, and its errors in +events+.
  def member(task, interval, events, ends_at: -> { monotonic + 60 })
    W::Worker::Heartbeat::Member.new(
      worker_id: "w", task: task, lease_ms: 30_000, interval: interval, logger: Logger.new(IO::NULL),
      renew: ->(sent_at) { events << [:renew, task.id, sent_at] },
      settle: ->(status) { events << [:settle, task.id, status] },
      fail: ->(error) { events << [:fail, task.id, error] },
      lease_ends_at: ends_at
    )
  end

  # Runs the rounds of a dedicated heartbeat on a thread, with +answer+ in place of the connection.
  # +answer+ receives the task IDs of each statement and returns their statuses. A round that
  # raises PG::Error starts the rounds again, as a replaced connection does. Each statement is
  # recorded in +calls+.
  def drive(heartbeat, calls, &answer)
    heartbeat.instance_variable_set(:@previous, monotonic)
    statement = lambda do |_sql, params, timeout|
      # The heartbeat sends heartbeat_pool_v1 with batches.
      batches = JSON.parse(params[0]).map { |batch| batch["leases"] }
      ids = batches.flatten.map { |lease| lease["taskId"] }
      calls << {at: monotonic, ids: ids, timeout: timeout}
      statuses = answer.call(ids, calls.size)
      batches.each_with_index.flat_map do |leases, index|
        leases.map { |lease| {"batch" => (index + 1).to_s, "task_id" => lease["taskId"], "status" => statuses[lease["taskId"]]} }
      end
    end
    @driver = Thread.new do
      loop do
        break if heartbeat.send(:rounds, &statement)
      rescue PG::Error
        nil
      end
    end
  end

  def wait_until(timeout = 5)
    deadline = monotonic + timeout
    sleep 0.005 until yield || monotonic > deadline
    raise "condition not met within #{timeout} seconds" unless yield
  end

  # The current thread stands in for the heartbeat thread, so register starts none. Only +drive+
  # runs rounds.
  let(:heartbeat) { heartbeat_class.new(nil).tap { |made| made.instance_variable_set(:@thread, Thread.current) } }
  let(:calls) { Concurrent::Array.new }
  let(:events) { Concurrent::Array.new }
  let(:first) { claimed(1) }
  let(:second) { claimed(2) }

  after do
    @unregister&.each(&:call)
    expect(@driver.join(2)).not_to be_nil if @driver
  end

  it "waits base × (1 + random), with base = min(100 ms, interval / 8)" do
    delays = [[1.0, 0], [1.0, 0.5], [0.4, 0], [0.4, 0.999]].map { |args| heartbeat_class.busy_retry_delay(*args) }
    expect(delays).to match([0.1, 0.15, 0.05, 0.05 * 1.999].map { |delay| be_within(1e-9).of(delay) })
  end

  it "retries only the busy lease, sooner than the interval, and renews it then" do
    @unregister = [first, second].map { |task| heartbeat.register(member(task, 0.4, events)) }
    drive(heartbeat, calls) do |ids, number|
      ids.to_h { |id| [id, (number == 1 && id == second.id) ? "busy" : "accepted"] }
    end
    wait_until { calls.size >= 2 }
    expect(calls[0][:ids]).to eq([first.id, second.id])
    expect(calls[1][:ids]).to eq([second.id])
    expect(calls[1][:at] - calls[0][:at]).to be_between(0.05, 0.2)
    wait_until { events.count { |event| event[0] == :renew } >= 2 }
    expect(events.map { |event| event.first(2) }).to eq([[:renew, first.id], [:renew, second.id]])
  end

  it "keeps the regular slots fixed while retries run, with one statement in flight" do
    interval = 0.3
    active = Concurrent::AtomicFixnum.new
    overlap = Concurrent::AtomicFixnum.new
    @unregister = [first, second].map { |task| heartbeat.register(member(task, interval, events)) }
    started = monotonic
    drive(heartbeat, calls) do |ids, _number|
      overlap.update { |value| [value, active.increment].max }
      sleep 0.01
      active.decrement
      ids.to_h { |id| [id, (id == second.id) ? "busy" : "accepted"] }
    end
    sleep 0.05 until monotonic > started + 4.5 * interval
    regular = calls.select { |entry| entry[:ids].size == 2 }.map { |entry| entry[:at] }
    expect(regular.size).to be >= 4
    regular.each_cons(2) { |previous, current| expect(current - previous).to be_within(0.08).of(interval) }
    retries = calls.select { |entry| entry[:ids] == [second.id] }
    expect(retries.size).to be >= 2 * (regular.size - 1)
    expect(overlap.value).to eq(1)
    expect(events.select { |event| event[1] == second.id }).to be_empty
  end

  it "stops retrying a busy lease at the end of its local window, with a deadline before it" do
    # The local window ends 250 ms after the first round. The regular slot is one second away.
    window_end = -> { calls.empty? ? monotonic + 60 : calls[0][:at] + 0.25 }
    @unregister = [heartbeat.register(member(second, 1.0, events, ends_at: window_end))]
    drive(heartbeat, calls) { |ids, _number| ids.to_h { |id| [id, "busy"] } }
    wait_until(3) { calls.any? }
    sleep 0.05 until monotonic > calls[0][:at] + 0.7
    retries = calls.drop(1)
    expect(retries).not_to be_empty
    retries.each do |entry|
      expect(entry[:at]).to be < window_end.call
      expect(entry[:timeout]).to be <= window_end.call - entry[:at] + 0.005
    end
    # The watchdog, not the heartbeat, ends the attempt: no status reached the member.
    expect(events).to be_empty
  end

  # SM-1492: a bounded retry that starts with less than the busy retry minimum left would fail at its
  # settings statement. It sends nothing, and the next regular round renews every lease.
  it "skips a busy retry that falls due 10 ms before the regular slot, and renews the lease in the regular round" do
    interval = 0.4
    # The retry falls due 10 ms before the next regular slot, so its deadline leaves at most 10 ms.
    allow(heartbeat_class).to receive(:busy_retry_delay) do
      heartbeat.instance_variable_get(:@previous) + interval - 0.01 - monotonic
    end
    @unregister = [first, second].map { |task| heartbeat.register(member(task, interval, events)) }
    drive(heartbeat, calls) do |ids, number|
      ids.to_h { |id| [id, (number == 1 && id == second.id) ? "busy" : "accepted"] }
    end
    wait_until { calls.size >= 2 }
    expect(calls[1][:ids]).to eq([first.id, second.id])
    expect(calls[1][:at] - calls[0][:at]).to be_within(0.05).of(interval)
    wait_until { events.count { |event| event[0] == :renew } >= 3 }
    expect(events.map { |event| event.first(2) }.first(3))
      .to eq([[:renew, first.id], [:renew, first.id], [:renew, second.id]])
  end

  it "runs a busy retry whose deadline leaves at least the busy retry minimum" do
    interval = 0.4
    # The retry falls due 60 ms before the next regular slot.
    allow(heartbeat_class).to receive(:busy_retry_delay) do
      heartbeat.instance_variable_get(:@previous) + interval - 0.06 - monotonic
    end
    @unregister = [first, second].map { |task| heartbeat.register(member(task, interval, events)) }
    drive(heartbeat, calls) do |ids, number|
      ids.to_h { |id| [id, (number == 1 && id == second.id) ? "busy" : "accepted"] }
    end
    wait_until { calls.size >= 2 }
    expect(calls[1][:ids]).to eq([second.id])
    expect(calls[1][:timeout]).to be_between(0.02, 0.07)
  end

  it "ignores a result for a member that was replaced or left while the round ran" do
    replacement = member(first, 0.4, events)
    unregister = [first, second].map { |task| heartbeat.register(member(task, 0.4, events)) }
    drive(heartbeat, calls) do |ids, number|
      if number == 1
        unregister.each(&:call)
        @unregister = [heartbeat.register(replacement)]
      end
      ids.to_h { |id| [id, (id == second.id) ? "busy" : "accepted"] }
    end
    wait_until { calls.size >= 2 }
    # No retry ran for the busy member that left, and the replacement waited for the regular slot.
    expect(calls[1][:ids]).to eq([first.id])
    expect(calls[1][:at] - calls[0][:at]).to be > 0.35
    wait_until { events.any? }
    expect(events.map { |event| event.first(2) }).to eq([[:renew, first.id]])
    expect(events.first[2]).to be_within(0.01).of(calls[1][:at])
  end

  it "runs no early round when the busy member left before its retry" do
    @unregister = [heartbeat.register(member(first, 0.8, events))]
    leave = heartbeat.register(member(second, 0.8, events))
    drive(heartbeat, calls) do |ids, number|
      ids.to_h { |id| [id, (number == 1 && id == second.id) ? "busy" : "accepted"] }
    end
    # The retry waits at least 100 ms, so the member leaves before it falls due.
    wait_until { calls.size == 1 }
    sleep 0.02
    leave.call
    wait_until { calls.size >= 2 }
    expect(calls[1][:ids]).to eq([first.id])
    expect(calls[1][:at] - calls[0][:at]).to be > 0.75
  end

  it "schedules no new retry after a failed retry, and lets the next regular round try again" do
    @unregister = [first, second].map { |task| heartbeat.register(member(task, 0.4, events)) }
    drive(heartbeat, calls) do |ids, number|
      raise PG::ConnectionBad, "injected" if number == 2

      ids.to_h { |id| [id, (id == second.id) ? "busy" : "accepted"] }
    end
    wait_until { calls.size >= 3 }
    expect(calls.map { |entry| entry[:ids] }.first(3)).to eq([[first.id, second.id], [second.id], [first.id, second.id]])
    expect(calls[2][:at] - calls[0][:at]).to be_within(0.05).of(0.4)
  end
end
