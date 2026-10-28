# frozen_string_literal: true

require "logger"
require "spec_helper"

# SM-1495: one batch of a heartbeat_pool_v1 statement accepts at most 100 leases. A fused completion
# claim registers its tasks before the completing attempts unregister, so a round can hold more
# members than the concurrency limit.
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

  # The size of each batch of each heartbeat_pool_v1 statement.
  let(:batch_sizes) { Concurrent::Array.new }
  # A pool that lends the heartbeat a connection that refuses a batch of more than 100 leases, as
  # heartbeat_pool_v1 does.
  let(:pool) do
    sizes = batch_sizes
    connection_class = Class.new(FakeHeartbeatConnection) do
      define_method(:get_last_result) do
        kind, params, sql = @pending
        if kind == :heartbeat && sql == W::SqlCatalogue::HEARTBEAT_POOL_V1
          batches = JSON.parse(params[0]).map { |batch| batch["leases"].size }
          sizes.concat(batches)
          raise PG::RaiseException, "leases must contain between 1 and 100 entries" if batches.max > 100
        end
        super()
      end
    end
    Class.new { define_method(:with) { |&block| connection_class.lend(&block) } }.new
  end
  let(:heartbeat) { heartbeat_class.new(pool) }
  let(:renewals) { Concurrent::Array.new }

  it "sends at most 100 leases in each batch and renews every member" do
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
    expect(batch_sizes.max).to eq(100)
    expect(batch_sizes).to include(50)
  end
end
