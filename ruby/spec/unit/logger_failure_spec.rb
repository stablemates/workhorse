# frozen_string_literal: true

require "logger"
require "spec_helper"

RSpec.describe "A logger that raises" do
  let(:logger) do
    Logger.new(StringIO.new).tap { |raising| allow(raising).to receive(:add).and_raise(IOError, "formatter broke") }
  end

  let(:task) do
    W::ClaimedTask.new(
      id: "00000000-0000-4000-8000-000000000001", queue: "default", type: "t", priority: 0, payload: {},
      contract_version: nil, result_max_bytes: nil, redact_error_details: false, trace_context: nil,
      attempt: 1, max_attempts: 3, retry_policy: nil, deadline_at: nil, execution_timeout_ms: nil,
      attempt_timeout_at: nil, fence_token: 7, lease_expires_at: nil
    )
  end

  it "does not turn an accepted heartbeat into a lost lease" do
    calls = []
    member = W::Worker::Heartbeat::Member.new(
      worker_id: "w", task: task, lease_ms: 30_000, interval: 10.0, logger: logger,
      renew: ->(sent_at) { calls << [:renew, sent_at] },
      settle: ->(status) { calls << [:settle, status] },
      fail: ->(error) { calls << [:fail, error] }
    )
    heartbeat = W::Worker::Heartbeat.new(FakeExecutor.new, dedicated: false)
    heartbeat.instance_variable_get(:@members)[["w", task.id]] = member
    allow(Kernel).to receive(:warn)
    heartbeat.send(:settle, [member], {task.id => "accepted"}, 1.5)
    expect(calls).to eq([[:renew, 1.5]])
  end

  it "lets stop advance the stop version and wake the dispatcher" do
    pool = Class.new(FakeExecutor) do
      def size = 3

      def with = raise("unit specs never check out a connection")
    end.new
    worker = W::Worker.new(pool, queues: ["default"], polling_only: true, disable_registry: true, logger: logger)
    version = worker.send(:stop_version)
    allow(Kernel).to receive(:warn)
    worker.stop
    expect(worker.send(:stop_version)).to eq(version + 1)
    expect(worker.instance_variable_get(:@wake)).to be_set
  end

  it "reports its first failure on standard error without calling it again" do
    expect do
      2.times { W::Telemetry.log(logger, :info, "workhorse.test.event", "Test event") }
    end.to output("workhorse: logger raised IOError while logging workhorse.test.event: formatter broke\n").to_stderr
    expect(logger).to have_received(:add).twice
  end
end
