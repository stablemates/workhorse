# frozen_string_literal: true

require "spec_helper"

RSpec.describe W::BatchHandlerContext do
  let(:task) do
    W::ClaimedTask.new(
      id: "00000000-0000-4000-8000-000000000001", queue: "default", type: "t", priority: 0, payload: {},
      contract_version: nil, result_max_bytes: nil, redact_error_details: false, trace_context: nil,
      attempt: 2, max_attempts: 3, retry_policy: nil, deadline_at: nil, execution_timeout_ms: nil,
      attempt_timeout_at: nil, fence_token: 7, lease_expires_at: nil
    )
  end
  let(:token) { W::CancellationToken.new }

  def member(executor, fast_tier: false)
    context = W::HandlerContext.new(executor: executor, queue: W::Queue.new(executor), task: task, worker_id: "w",
      cancellation: token, arbiter: W::Arbiter.new, fast_tier: fast_tier)
    described_class.new(context)
  end

  def checkpoint_row(name, value)
    {"checkpoint_name" => name, "status" => "saved", "checkpoint_value" => JSON.generate(value), "attempt" => "1",
     "fence_token" => "7", "worker_id" => "w", "created_at" => "2026-09-29 00:00:00+00"}
  end

  it "exposes the member's task and cancellation" do
    context = member(FakeExecutor.new)
    expect([context.task, context.cancellation]).to eq([task, token])
  end

  it "offers no call that suspends or starts a child" do
    context = member(FakeExecutor.new)
    %i[sleep sleep_until wait_for_signal wait_for_human run_child run_children run_children_all tasks].each do |name|
      expect(context).not_to respond_to(name)
    end
  end

  it "replays the member's own checkpoint from an earlier attempt" do
    executor = FakeExecutor.new do |sql|
      (sql == W::SqlCatalogue::LIST_CHECKPOINTS) ? [checkpoint_row("charge", {"id" => 5})] : []
    end
    context = member(executor)
    expect(context.get_checkpoint("charge")).to have_attributes(name: "charge", value: {"id" => 5}, attempt: 1)
    expect(context.get_checkpoint("refund")).to be_nil
    expect(context.checkpoint("charge") { raise "ran" }).to eq({"id" => 5})
    expect(executor.statements).to eq([[W::SqlCatalogue::LIST_CHECKPOINTS, [task.id]]])
  end

  it "fences the member's checkpoint and progress writes on its own lease" do
    executor = FakeExecutor.new do |sql|
      case sql
      when W::SqlCatalogue::SAVE_CHECKPOINT_V1 then [checkpoint_row("charge", 1)]
      when W::SqlCatalogue::UPDATE_PROGRESS_V1
        [{"status" => "updated", "progress_value" => "3", "revision" => "1", "attempt" => "2", "fence_token" => "7",
          "worker_id" => "w", "created_at" => "2026-09-29 00:00:00+00", "updated_at" => "2026-09-29 00:00:00+00"}]
      else []
      end
    end
    context = member(executor)
    expect(context.checkpoint("charge") { 1 }).to eq(1)
    expect(context.set_progress(3).value).to eq(3)
    expect(context.get_progress.value).to eq(3)
    expect(executor.statements.map { |sql, params| [sql, params.first(3)] }).to eq([
      [W::SqlCatalogue::LIST_CHECKPOINTS, [task.id]],
      [W::SqlCatalogue::SAVE_CHECKPOINT_V1, [task.id, "w", 7]],
      [W::SqlCatalogue::UPDATE_PROGRESS_V1, [task.id, "w", 7]]
    ])
  end

  it "raises LeaseLostError once the member's lease is lost" do
    context = member(FakeExecutor.new)
    token.cancel(:lease_lost)
    expect { context.set_progress(1) }.to raise_error(W::LeaseLostError)
  end

  it "rejects a fast-tier member's durable writes before any statement runs" do
    executor = FakeExecutor.new
    context = member(executor, fast_tier: true)
    expect { context.checkpoint("c") { raise "the block must not run" } }
      .to raise_error(W::FastTierUnsupportedError) { |error| expect(error.feature).to eq("checkpoints") }
    expect { context.set_progress(1) }
      .to raise_error(W::FastTierUnsupportedError) { |error| expect(error.feature).to eq("progress") }
    expect(executor.statements).to be_empty
  end

  it "pairs each payload with its context in a BatchHandlerItem" do
    context = member(FakeExecutor.new)
    item = W::BatchHandlerItem.new(payload: {"n" => 1}, context: context)
    expect([item.payload, item.context]).to eq([{"n" => 1}, context])
  end
end
