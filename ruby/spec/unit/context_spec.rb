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
  let(:token) { W::CancellationToken.new }
  let(:arbiter) { W::Arbiter.new }

  def context(executor)
    described_class.new(executor: executor, queue: W::Queue.new(executor), task: task, worker_id: "w",
      cancellation: token, arbiter: arbiter)
  end

  def checkpoint_row(status, value)
    {"status" => status, "checkpoint_value" => JSON.generate(value), "attempt" => "1", "fence_token" => "7",
     "worker_id" => "w", "created_at" => "2026-09-29 00:00:00+00"}
  end

  it "replays a saved checkpoint without running its block" do
    executor = FakeExecutor.new do |sql|
      (sql == W::SqlCatalogue::LIST_CHECKPOINTS) ? [checkpoint_row(nil, 5).merge("checkpoint_name" => "a")] : []
    end
    expect(context(executor).checkpoint("a") { raise "ran" }).to eq(5)
  end

  it "saves a new checkpoint under the attempt's fence" do
    executor = FakeExecutor.new do |sql|
      (sql == W::SqlCatalogue::SAVE_CHECKPOINT_V1) ? [checkpoint_row("saved", {"n" => 1})] : []
    end
    ctx = context(executor)
    expect(ctx.checkpoint("a") { {"n" => 1} }).to eq({"n" => 1})
    expect(ctx.checkpoint("a") { raise "ran" }).to eq({"n" => 1})
    expect(executor.statements.last[1]).to eq([task.id, "w", 7, "a", '{"n":1}'])
  end

  it "raises LeaseLostError when a stale attempt writes" do
    executor = FakeExecutor.new { |sql| (sql == W::SqlCatalogue::LIST_CHECKPOINTS) ? [] : [{"status" => "stale"}] }
    expect { context(executor).checkpoint("a") { 1 } }.to raise_error(W::LeaseLostError)
  end

  it "refuses a status the protocol does not define" do
    executor = FakeExecutor.new { [{"status" => "teleported"}] }
    expect { context(executor).wait_for_signal("s") }
      .to raise_error(W::UnexpectedStatusError)
  end

  it "requires exactly one row from a lifecycle write" do
    executor = FakeExecutor.new { [] }
    expect { context(executor).set_progress(1) }.to raise_error(W::Error, /exactly one row/)
  end

  it "suspends a scheduled wait and cancels the token once" do
    executor = FakeExecutor.new { [{"status" => "scheduled", "mode" => "relative"}] }
    ctx = context(executor)
    expect { ctx.sleep("nap", 1) }.to raise_error(W::HandlerContext::Suspension)
    expect(token.reason).to eq(:suspended)
    expect(arbiter.outcome).to eq(:suspended_for_wait)
    expect(executor.statements.last[1]).to eq([task.id, "w", 7, "nap", 1000, nil])
  end

  it "returns from an elapsed wait" do
    executor = FakeExecutor.new { [{"status" => "elapsed", "mode" => "relative"}] }
    expect(context(executor).sleep("nap", 1)).to be_nil
    expect(token.cancelled?).to be(false)
  end

  it "does not cancel the token when another outcome already won" do
    arbiter.submit(:completed)
    executor = FakeExecutor.new { [{"status" => "waiting"}] }
    expect { context(executor).wait_for_signal("s") }.to raise_error(W::HandlerContext::Suspension)
    expect(token.cancelled?).to be(false)
  end

  it "unwinds a scheduled sleep without cancelling the token when another outcome already won" do
    arbiter.submit(:lease_expired)
    executor = FakeExecutor.new { [{"status" => "scheduled", "mode" => "relative"}] }
    expect { context(executor).sleep("nap", 1) }.to raise_error(W::HandlerContext::Suspension)
    expect([token.cancelled?, arbiter.released?, arbiter.outcome]).to eq([false, true, :lease_expired])
  end

  it "unwinds a released task when its processed log fails" do
    logger = Logger.new(StringIO.new)
    allow(logger).to receive(:add).and_raise(IOError, "disk full")
    child = W::ChildTaskRequest.new(name: "a", task_type: "t", payload: {})
    {[{"status" => "scheduled", "mode" => "relative"}, :suspended_for_wait] => ->(ctx) { ctx.sleep("nap", 1) },
     [{"status" => "created"}, :suspended_for_child] => ->(ctx) { ctx.run_child("c", "t", {}) },
     [{"status" => "created", "children" => "[]"}, :suspended_for_child] =>
       ->(ctx) { ctx.run_children_all([child]) }}.each do |(row, outcome), call|
      executor = FakeExecutor.new { [row] }
      token = W::CancellationToken.new
      arbiter = W::Arbiter.new
      ctx = described_class.new(executor: executor, queue: W::Queue.new(executor), task: task, worker_id: "w",
        cancellation: token, arbiter: arbiter, logger: logger)
      expect { call.call(ctx) }.to raise_error(W::HandlerContext::Suspension)
      expect([arbiter.released?, arbiter.outcome, token.reason]).to eq([true, outcome, :suspended])
    end
  end

  it "returns a delivered signal's payload" do
    executor = FakeExecutor.new { [{"status" => "delivered", "payload" => '{"ok":true}'}] }
    expect(context(executor).wait_for_signal("s", timeout: 2)).to eq({"ok" => true})
  end

  it "validates external wait names and timeouts before any statement runs" do
    executor = FakeExecutor.new
    expect { context(executor).wait_for_signal(" s") }.to raise_error(ArgumentError)
    expect { context(executor).wait_for_signal("s", timeout: 0) }.to raise_error(ArgumentError)
    expect { context(executor).wait_for_signal("s", timeout: false) }.to raise_error(ArgumentError)
    expect { context(executor).wait_for_human("h", {}, timeout: false) }.to raise_error(ArgumentError)
    expect { context(executor).wait_for_human("h", Object.new) }.to raise_error(ArgumentError)
    expect(executor.statements).to be_empty
  end

  it "maps a signal wait's statuses" do
    {"already_waiting" => W::AlreadyWaitingError, "limit_exceeded" => W::LimitExceededError,
     "stale" => W::LeaseLostError}.each do |status, error|
      executor = FakeExecutor.new { [{"status" => status}] }
      expect { context(executor).wait_for_signal("s") }.to raise_error(error)
    end
  end

  it "maps a human wait's statuses" do
    {"already_waiting" => W::AlreadyWaitingError, "conflict" => W::ConflictError,
     "limit_exceeded" => W::LimitExceededError}.each do |status, error|
      executor = FakeExecutor.new { [{"status" => status}] }
      expect { context(executor).wait_for_human("h", {}) }.to raise_error(error)
    end
    executor = FakeExecutor.new { [{"status" => "completed", "result" => "3"}] }
    expect(context(executor).wait_for_human("h", {"q" => 1})).to eq(3)
  end

  it "raises ProgressRateLimitedError with the retry delay in seconds" do
    executor = FakeExecutor.new { [{"status" => "rate_limited", "retry_after_ms" => "1500"}] }
    expect { context(executor).set_progress(1) }
      .to raise_error(W::ProgressRateLimitedError) { |error| expect(error.retry_after).to eq(1.5) }
  end

  it "caches the progress it saves" do
    row = {"status" => "updated", "progress_value" => "2", "revision" => "1", "attempt" => "1",
           "fence_token" => "7", "worker_id" => "w", "created_at" => nil, "updated_at" => nil}
    executor = FakeExecutor.new { [row] }
    ctx = context(executor)
    expect(ctx.set_progress(2).value).to eq(2)
    expect(ctx.get_progress.revision).to eq(1)
    expect(executor.statements.length).to eq(1)
  end

  it "suspends the attempt for a created child" do
    executor = FakeExecutor.new { [{"status" => "created"}] }
    expect { context(executor).run_child("c", "t", {}) }.to raise_error(W::HandlerContext::Suspension)
    expect(arbiter.outcome).to eq(:suspended_for_child)
  end

  it "returns a completed child's result" do
    executor = FakeExecutor.new { [{"status" => "completed", "result" => '"done"'}] }
    expect(context(executor).run_child("c", "t", {})).to eq("done")
  end

  it "maps each settled child's outcome" do
    children = [{"name" => "a", "outcome" => {"status" => "succeeded", "result" => 1}},
      {"name" => "b", "outcome" => {"status" => "failed", "error" => {"message" => "no"}}}]
    executor = FakeExecutor.new { [{"status" => "completed", "children" => JSON.generate(children)}] }
    requests = %w[a b].map { |name| W::ChildTaskRequest.new(name: name, task_type: "t", payload: {}) }
    outcomes = context(executor).run_children(requests)
    expect(outcomes["a"]).to eq(W::ChildOutcome.new(status: :succeeded, result: 1, error: nil))
    expect(outcomes["b"].status).to eq(:failed)
    expect(executor.statements.last[1].last).to eq("settled")
  end

  it "refuses duplicate child names and oversized child sets" do
    child = W::ChildTaskRequest.new(name: "a", task_type: "t", payload: {})
    expect { context(FakeExecutor.new).run_children([child, child]) }.to raise_error(ArgumentError)
    expect { context(FakeExecutor.new).run_children_all([child] * 101) }.to raise_error(W::LimitExceededError)
  end

  it "reports a child set whose results exceed the limit" do
    executor = FakeExecutor.new do
      [{"status" => "result_too_large", "result_bytes" => "10", "result_limit_bytes" => "5"}]
    end
    child = W::ChildTaskRequest.new(name: "a", task_type: "t", payload: {})
    expect { context(executor).run_children_all([child]) }.to raise_error(W::ChildResultLimitExceededError)
  end

  it "shares one in-flight request between concurrent callers with the same name" do
    release = Concurrent::Event.new
    executor = FakeExecutor.new do
      release.wait(5)
      [{"status" => "delivered", "payload" => "1"}]
    end
    ctx = context(executor)
    first = Thread.new { ctx.wait_for_signal("s") }
    Thread.pass until executor.statements.any?
    second = Thread.new { ctx.wait_for_signal("s") }
    Thread.pass until second.status == "sleep"
    release.set
    expect([first.value, second.value]).to eq([1, 1])
    expect(executor.statements.length).to eq(1)
  end

  it "refuses a concurrent human wait with a different context" do
    release = Concurrent::Event.new
    executor = FakeExecutor.new do
      release.wait(5)
      [{"status" => "completed", "result" => "1"}]
    end
    ctx = context(executor)
    first = Thread.new { ctx.wait_for_human("h", {"a" => 1}) }
    Thread.pass until executor.statements.any?
    expect { ctx.wait_for_human("h", {"a" => 2}) }.to raise_error(W::ConflictError)
    release.set
    expect(first.value).to eq(1)
  end

  it "shares a concurrent human wait whose context differs only in key order" do
    release = Concurrent::Event.new
    executor = FakeExecutor.new do
      release.wait(5)
      [{"status" => "completed", "result" => "1"}]
    end
    ctx = context(executor)
    first = Thread.new { ctx.wait_for_human("h", {"a" => 1, "b" => {"c" => 2, "d" => 3}}) }
    Thread.pass until executor.statements.any?
    second = Thread.new { ctx.wait_for_human("h", {"b" => {"d" => 3, "c" => 2}, "a" => 1}) }
    Thread.pass until second.status == "sleep"
    release.set
    expect([first.value, second.value]).to eq([1, 1])
    expect(executor.statements.length).to eq(1)
  end

  it "raises ConflictError for a changed child request once the accepted contracts match" do
    child = "00000000-0000-4000-8000-000000000002"
    executor = FakeExecutor.new do |sql, _params|
      case sql
      when W::SqlCatalogue::TASK_CHILD then [{"parent_task_id" => task.id, "child_task_id" => child, "child_name" => "c"}]
      when W::SqlCatalogue::GET_TASK then [{"contract_version" => nil}]
      else [{"status" => "conflict"}]
      end
    end
    expect { context(executor).run_child("c", "t", {}) }.to raise_error(W::ConflictError)
    expect(executor.statements.map(&:first).count(W::SqlCatalogue::CREATE_CHILD_V1)).to eq(1)
  end

  it "shares a relative sleep between concurrent callers and refuses a different wake time" do
    wake_at = Time.now + 60
    release = Concurrent::Event.new
    executor = FakeExecutor.new do
      release.wait(5)
      [{"status" => "elapsed", "mode" => "relative"}]
    end
    ctx = context(executor)
    first = Thread.new { ctx.sleep("nap", 1) }
    Thread.pass until executor.statements.any?
    second = Thread.new { ctx.sleep("nap", 2) }
    Thread.pass until second.status == "sleep"
    expect { ctx.sleep_until("nap", wake_at) }.to raise_error(W::ConflictError)
    release.set
    expect([first.value, second.value, executor.statements.length]).to eq([nil, nil, 1])
  end

  it "refuses a concurrent absolute sleep with a different wake time" do
    wake_at = Time.now + 60
    release = Concurrent::Event.new
    executor = FakeExecutor.new do
      release.wait(5)
      [{"status" => "elapsed", "mode" => "absolute"}]
    end
    ctx = context(executor)
    first = Thread.new { ctx.sleep_until("nap", wake_at) }
    Thread.pass until executor.statements.any?
    expect { ctx.sleep_until("nap", wake_at + 1) }.to raise_error(W::ConflictError)
    expect { ctx.sleep("nap", 1) }.to raise_error(W::ConflictError)
    release.set
    expect(first.value).to be_nil
  end

  it "stops before a durable call once cancelled" do
    token.cancel(:shutdown)
    executor = FakeExecutor.new
    expect { context(executor).set_progress(1) }
      .to raise_error(W::CancelledError)
    expect(executor.statements).to be_empty
  end

  it "raises LeaseLostError before a durable call once the lease is lost" do
    token.cancel(:lease_lost)
    executor = FakeExecutor.new
    expect { context(executor).set_progress(1) }
      .to raise_error(W::LeaseLostError)
    expect(executor.statements).to be_empty
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
