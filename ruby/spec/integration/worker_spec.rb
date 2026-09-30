# frozen_string_literal: true

require "connection_pool"

RSpec.describe "Worker against PostgreSQL" do
  include_context "with a scratch database"

  before { @pool = ConnectionPool.new(size: 4, timeout: 5) { ScratchDatabase.connect } }

  after { @pool&.shutdown(&:close) }

  status_sql = <<~SQL
    SELECT COALESCE(outcome.state, runtime.state) AS state, outcome.result,
           COALESCE(outcome.error, runtime.error) AS error, COALESCE(outcome.current_attempt, runtime.current_attempt) AS attempt
      FROM workhorse.task task
      LEFT JOIN workhorse.task_runtime runtime ON runtime.task_id = task.id
      LEFT JOIN workhorse.task_outcome outcome ON outcome.task_id = task.id
     WHERE task.id = $1
  SQL

  define_method(:status) { |task_id| @connection.exec_params(status_sql, [task_id]).first }

  def worker(**options)
    W::Worker.new(@pool, queues: [@queue_name], polling_only: true, poll_interval: 0.01, disable_registry: true,
      **options)
  end

  def make_ready(task_id)
    @connection.exec_params("UPDATE workhorse.task_runtime SET run_at = clock_timestamp(), state = 'ready',
      ready_at = clock_timestamp() WHERE task_id = $1 AND state = 'scheduled'", [task_id])
  end

  it "completes a task and stores its result" do
    task_id = queue.enqueue("add", {"a" => 2, "b" => 3}).task_id
    seen = nil
    ran = worker.handle("add") { |payload, context|
      seen = context.task.attempt
      {"sum" => payload["a"] + payload["b"]}
    }.run_once

    expect(ran).to be(true)
    expect(seen).to eq(1)
    row = status(task_id)
    expect(row["state"]).to eq("succeeded")
    expect(JSON.parse(row["result"])).to eq({"sum" => 5})
  end

  it "records a failure and schedules the retry by the task's policy" do
    task_id = queue.enqueue("boom", {}, max_attempts: 2).task_id
    worker.handle("boom") { raise ArgumentError, "bad input" }.run_once

    row = status(task_id)
    expect(row["state"]).to eq("scheduled")
    expect(JSON.parse(row["error"]).values_at("name", "message")).to eq(["ArgumentError", "bad input"])
  end

  it "fails the task once its attempts run out and redacts nothing by default" do
    task_id = queue.enqueue("boom", {}, max_attempts: 1).task_id
    worker.handle("boom") { raise "last try" }.run_once

    row = status(task_id)
    expect(row["state"]).to eq("failed")
    expect(JSON.parse(row["error"])["stack"]).to include("last try")
  end

  it "releases a task whose type has no handler without charging the attempt" do
    task_id = queue.enqueue("unknown", {}).task_id
    ran = worker.handle("other") { {} }.run_once

    expect(ran).to be(false)
    expect(status(task_id).values_at("state", "attempt")).to eq(%w[ready 1])
  end

  it "cancels the handler and keeps the task when the lease is taken over" do
    task_id = queue.enqueue("slow", {}).task_id
    reason = nil
    subject = worker(lease: 0.5, heartbeat: 0.05).handle("slow") do |_payload, context|
      @connection.exec_params("UPDATE workhorse.task_runtime SET fence_token = fence_token + 1 WHERE task_id = $1",
        [task_id])
      context.cancellation.wait(5)
      reason = context.cancellation.reason
      {"late" => true}
    end
    subject.run_once

    expect(reason).to eq(:lease_lost)
    expect(status(task_id)["state"]).to eq("active")
  end

  it "rejects a result that breaks the task type's registered contract" do
    task_type = "typed.#{@queue_name}"
    version = W::TaskContractVersion.new(result_schema: {"type" => "object", "required" => ["ok"]})
    queue.sync_contracts(task_type => W::TaskTypeContracts.new(current_version: "v1", versions: {"v1" => version}))
    task_id = queue.enqueue(task_type, {}, max_attempts: 1).task_id
    worker.handle(task_type) { {"wrong" => true} }.run_once

    row = status(task_id)
    expect(row["state"]).to eq("failed")
    expect(JSON.parse(row["error"])["name"]).to eq("Stablemates::Workhorse::ContractValidationError")
  end

  it "raises ShutdownIncompleteError when a handler outlives the grace and the unwind window" do
    queue.enqueue("stuck", {})
    started = Queue.new
    release = Concurrent::Event.new
    subject = worker(shutdown_grace: 0.05).handle("stuck") do
      started << true
      release.wait(5)
      {}
    end
    runner = Thread.new { subject.run }
    runner.report_on_exception = false
    started.pop
    subject.stop

    expect { runner.value }.to raise_error(W::ShutdownIncompleteError) { |error| expect(error.abandoned).to eq(1) }
  ensure
    release&.set
  end
end
