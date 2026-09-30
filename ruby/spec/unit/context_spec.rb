# frozen_string_literal: true

require "spec_helper"

RSpec.describe W::HandlerContext do
  let(:task) do
    W::ClaimedTask.new(
      id: "00000000-0000-4000-8000-000000000001", queue: "default", type: "t", priority: 0, payload: {},
      contract_version: nil, result_max_bytes: nil, redact_error_details: false, trace_context: nil,
      attempt: 1, max_attempts: 3, retry_policy: nil, deadline_at: nil, execution_timeout_ms: nil,
      attempt_timeout_at: nil, fence_token: 7, lease_expires_at: nil
    )
  end
  it "exposes the task and its cancellation token" do
    token = W::CancellationToken.new
    context = described_class.new(task: task, cancellation: token)
    expect(context.task).to be(task)
    expect(context.cancellation).to be(token)
  end
end

RSpec.describe W::Arbiter do
  it "keeps the first outcome submitted" do
    arbiter = described_class.new
    expect(arbiter.outcome).to be_nil
    expect(arbiter.submit(:completed)).to be(true)
    expect(arbiter.submit(:lease_expired)).to be(false)
    expect(arbiter.outcome).to eq(:completed)
  end
end

RSpec.describe W::CancellationToken do
  it "keeps the first reason and wakes waiters" do
    token = described_class.new
    expect(token.wait(0.01)).to be(false)
    expect(token.cancel(:deadline_exceeded)).to be(true)
    expect(token.cancel(:shutdown)).to be(false)
    expect(token.reason).to eq(:deadline_exceeded)
    expect(token.wait).to be(true)
    expect { token.check! }.to raise_error(W::CancelledError)
  end
end
