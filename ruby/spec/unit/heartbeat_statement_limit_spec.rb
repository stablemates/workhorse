# frozen_string_literal: true

require "logger"
require "spec_helper"

# SM-1495: one heartbeat_many_v2 statement accepts at most 100 leases. A fused completion claim
# registers its tasks before the completing attempts unregister, so a round can hold more members
# than the concurrency limit.
RSpec.describe "Worker heartbeat statement limit" do
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

  let(:executor) do
    FakeExecutor.new do |sql, params|
      next [] unless sql == W::SqlCatalogue::HEARTBEAT_MANY_V2

      leases = JSON.parse(params[1])
      raise PG::RaiseException, "leases must contain between 1 and 100 entries" if leases.size > 100

      leases.map { |lease| {"task_id" => lease["taskId"], "status" => "accepted"} }
    end
  end
  let(:heartbeat) { heartbeat_class.new(executor, dedicated: false) }
  let(:renewals) { Concurrent::Array.new }

  it "sends at most 100 leases in each statement and renews every member" do
    tasks = (1..150).map { |number| claimed(number) }
    leaves = tasks.map do |task|
      heartbeat.register(
        W::Worker::Heartbeat::Member.new(
          worker_id: "w", task: task, lease_ms: 30_000, interval: 0.2, logger: Logger.new(IO::NULL),
          renew: ->(_sent_at) { renewals << task.id }, settle: ->(_status) {}, fail: ->(_error) {},
          lease_ends_at: -> { monotonic + 60 }
        )
      )
    end
    deadline = monotonic + 5
    sleep 0.005 until renewals.uniq.size == tasks.size || monotonic > deadline
    leaves.each(&:call)
    thread = heartbeat.instance_variable_get(:@thread)
    expect(thread.join(2)).not_to be_nil if thread

    expect(renewals.uniq.size).to eq(tasks.size)
    sizes = executor.statements.select { |sql, _| sql == W::SqlCatalogue::HEARTBEAT_MANY_V2 }
      .map { |_, params| JSON.parse(params[1]).size }
    expect(sizes.max).to be <= 100
  end
end
