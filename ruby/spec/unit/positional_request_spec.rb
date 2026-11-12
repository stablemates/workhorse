# frozen_string_literal: true

require "spec_helper"

# SM-2039: the positional arguments are the only source of the task type and the payload. An
# option hash that holds task_type: or payload: raises before any statement, on each path that
# takes the two as positional arguments.
RSpec.describe "Enqueue options that name the task type or the payload" do
  task = W::ClaimedTask.new(
    id: "00000000-0000-4000-8000-000000000001", queue: "default", type: "parent", priority: 0, payload: {},
    contract_version: nil, result_max_bytes: nil, redact_error_details: false, trace_context: nil,
    attempt: 1, max_attempts: 3, retry_policy: nil, deadline_at: nil, execution_timeout_ms: nil,
    attempt_timeout_at: nil, fence_token: 7, lease_expires_at: nil
  )

  def handler_context(executor, task)
    W::HandlerContext.new(executor: executor, queue: W::Queue.new(executor), task: task, worker_id: "w",
      cancellation: W::CancellationToken.new, arbiter: W::Arbiter.new,
      fast_tier: -> { raise "the tier lookup must not run" })
  end

  paths = {
    "Queue#enqueue" => ->(executor, _task, options) {
      W::Queue.new(executor).enqueue("send-invoice", {"id" => 1}, **options)
    },
    "TaskGroupBuilder#enqueue" => ->(executor, _task, options) {
      W::Queue.new(executor).task_group { |group| group.enqueue("send-invoice", {"id" => 1}, **options) }
    },
    "HandlerContext#run_child" => ->(executor, task, options) {
      handler_context(executor, task).run_child("invoice", "send-invoice", {"id" => 1}, **options)
    },
    "ChildTaskRequest#options" => ->(executor, task, options) {
      child = W::ChildTaskRequest.new(name: "invoice", task_type: "send-invoice", payload: {"id" => 1},
        options: options)
      handler_context(executor, task).run_children([child])
    }
  }
  refusals = {
    task_type: {"task_type" => "refund"},
    payload: {"payload" => {"id" => 2}}
  }

  paths.each do |path, call|
    refusals.each do |key, values|
      it "#{path} raises ArgumentError for #{key}: before any statement" do
        executor = RecordingExecutor.new
        options = {key => values.fetch(key.to_s), :priority => 5}
        expect { instance_exec(executor, task, options, &call) }.to raise_error(
          ArgumentError,
          "#{key}: is not an enqueue option; pass the #{key.to_s.tr("_", " ")} as the positional argument"
        )
        expect(executor.statements).to be_empty
      end
    end
  end

  it "keeps the other keywords on each path" do
    executor = RecordingExecutor.new
    expect { W::Queue.new(executor).enqueue("send-invoice", {"id" => 1}, priority: 101) }
      .to raise_error(ArgumentError, /priority/)
    expect(W::EnqueueRequest.new(task_type: "send-invoice", payload: {"id" => 1}, priority: 5).task_type)
      .to eq("send-invoice")
  end
end
