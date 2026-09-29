# frozen_string_literal: true

require "connection_pool"

RSpec.describe "Queue#enqueue against PostgreSQL" do
  include_context "with a scratch database"

  stored_sql = <<~SQL
    SELECT task.queue_name, task.task_type, task.payload, task.priority, task.max_attempts, task.tags,
           task.retry_policy, task.deadline_at, task.execution_timeout_ms, task.concurrency_key,
           task.budget_name, runtime.run_at, runtime.state
      FROM workhorse.task task
      JOIN workhorse.task_runtime runtime ON runtime.task_id = task.id
     WHERE task.id = $1
  SQL

  define_method(:stored) { |task_id| @connection.exec_params(stored_sql, [task_id]).first }

  it "persists run at, priority, tags, and max attempts" do
    run_at = Time.at(Time.now.to_i + 3600)
    result = queue.enqueue("email.send", {"to" => "a@b.c"}, run_at: run_at, priority: 7,
      tags: %w[billing eu], max_attempts: 3)

    expect(result.outcome).to eq(:accepted)
    row = stored(result.task_id)
    expect([row["queue_name"], row["task_type"], JSON.parse(row["payload"])])
      .to eq([@queue_name, "email.send", {"to" => "a@b.c"}])
    expect(row.values_at("priority", "max_attempts", "tags", "state")).to eq(%w[7 3 {billing,eu} scheduled])
    expect(Time.parse(row["run_at"])).to eq(run_at)
  end

  it "persists the retry policy, deadline, and execution timeout" do
    deadline = Time.at(Time.now.to_i + 7200)
    result = queue.enqueue("t", {}, retry_policy: {"type" => "fixed", "delayMs" => 1000},
      deadline: deadline, execution_timeout: 30)

    row = stored(result.task_id)
    expect(JSON.parse(row["retry_policy"])).to eq({"type" => "fixed", "delayMs" => 1000})
    expect(Time.parse(row["deadline_at"])).to eq(deadline)
    expect(row["execution_timeout_ms"]).to eq("30000")
    expect(row["state"]).to eq("ready")
    expect(row["max_attempts"]).to eq("25"), "an unset max attempts takes the protocol default"
  end

  it "persists the concurrency key and budget" do
    result = queue.enqueue("t", {}, concurrency_key: "tenant-1", budget: "openai")

    expect(stored(result.task_id).values_at("concurrency_key", "budget_name")).to eq(%w[tenant-1 openai])
  end

  it "writes an atomic batch in request order with enqueue_many" do
    requests = [
      W::EnqueueRequest.new(task_type: "a", payload: {"n" => 1}),
      W::EnqueueRequest.new(task_type: "b", payload: {"n" => 2}, queue: "#{@queue_name}-other")
    ]
    results = queue.enqueue_many(requests)

    expect(results.map(&:outcome)).to eq(%i[accepted accepted])
    expect(results.map { |result| stored(result.task_id)["task_type"] }).to eq(%w[a b])
    expect(stored(results[1].task_id)["queue_name"]).to eq("#{@queue_name}-other")
    expect(queue.enqueue_many([])).to be_empty

    invalid = [W::EnqueueRequest.new(task_type: "a", payload: {}),
      W::EnqueueRequest.new(task_type: "a", payload: {}, priority: 101)]
    expect { queue.enqueue_many(invalid) }
      .to raise_error(ArgumentError, "enqueue request 2: invalid enqueue options: priority must be between 0 and 100")
    expect(task_count).to eq(1), "a refused batch writes nothing"
  end

  it "replays an idempotent enqueue and rejects a conflicting request" do
    idempotency = W::Idempotency.new(key: "order-42")
    first = queue.enqueue("order.ship", {"id" => 42}, idempotency: idempotency)
    replay = queue.enqueue("order.ship", {"id" => 42}, idempotency: idempotency)

    expect([first.outcome, replay.outcome]).to eq(%i[accepted replayed])
    expect(replay.task_id).to eq(first.task_id)

    expect { queue.enqueue("order.ship", {"id" => 99}, idempotency: idempotency) }
      .to raise_error(W::EnqueueIdempotencyConflictError) { |error|
        expect(error.details["existingTaskId"]).to eq(first.task_id)
        expect(error.details["conflictingFields"]).to include("payload")
      }
    expect(task_count).to eq(1)
  end

  it "replaces a pending task inside its debounce window" do
    debounce = W::Debounce.new(key: "search-index", window: 60)
    first = queue.enqueue("index.rebuild", {"v" => 1}, debounce: debounce)
    row = stored(first.task_id)

    expect(row["state"]).to eq("scheduled")
    expect(Time.parse(row["run_at"])).to be > Time.now + 50

    second = queue.enqueue("index.rebuild", {"v" => 2}, debounce: debounce)
    expect(second.outcome).to eq(:replaced)
    expect(second.task_id).to eq(first.task_id)
    expect(JSON.parse(stored(first.task_id)["payload"])).to eq({"v" => 2})
    expect(task_count).to eq(1)
  end

  it "coalesces requests inside a throttle window" do
    throttle = W::Throttle.new(key: "digest", window: 60)
    first = queue.enqueue("digest.send", {}, throttle: throttle)
    second = queue.enqueue("digest.send", {}, throttle: throttle)

    expect([first.outcome, second.outcome]).to eq(%i[accepted coalesced])
    expect(second.task_id).to eq(first.task_id)
    expect(stored(first.task_id)["state"]).to eq("ready")
  end

  it "blocks a task on its dependencies with their terminal policies" do
    prerequisite = queue.enqueue("extract", {})
    dependencies = W::Dependencies.new(prerequisite_task_ids: [prerequisite.task_id.upcase], on_success: :release,
      on_failure: :cancel, on_cancellation: :fail)
    dependent = queue.enqueue("load", {}, dependencies: dependencies)

    expect(stored(dependent.task_id)["state"]).to eq("blocked")
    edge = @connection.exec_params(
      "SELECT prerequisite_task_id, on_success, on_failure, on_cancellation FROM workhorse.task_dependency " \
      "WHERE dependent_task_id = $1", [dependent.task_id]
    ).first
    expect(edge.values).to eq([prerequisite.task_id, "release", "cancel", "fail"])
  end

  it "commits and rolls back a transactional enqueue with the caller" do
    caller = ScratchDatabase.connect
    caller.transaction do
      queue(caller).enqueue("t", {})
      expect(task_count).to eq(0), "an uncommitted enqueue is invisible to another session"
    end
    expect(task_count).to eq(1)

    caller.transaction do
      queue(caller).enqueue("t", {})
      raise PG::RollbackTransaction
    end
    expect(task_count).to eq(1), "a rolled-back enqueue leaves no task"
  ensure
    caller&.close
  end

  it "enqueues through a ConnectionPool executor" do
    pool = ConnectionPool.new(size: 2) { ScratchDatabase.connect }
    results = Array.new(4) { queue(pool).enqueue("t", {}) }

    expect(results.map(&:task_id).uniq.length).to eq(4)
    expect(task_count).to eq(4)
  ensure
    pool&.shutdown(&:close)
  end

  it "refuses an incompatible schema before the first write" do
    @connection.transaction do |connection|
      connection.exec("DELETE FROM workhorse.schema_version; INSERT INTO workhorse.schema_version(version) VALUES (17)")
      expect { queue(connection).enqueue("t", {}) }
        .to raise_error(W::CompatibilityError) { |error| expect(error.code).to eq(:schema_too_old) }
      expect(task_count(connection)).to eq(0)
      raise PG::RollbackTransaction
    end
  end

  it "keeps the caller session's own type map and search path" do
    @connection.exec("SET search_path TO pg_catalog")
    @connection.type_map_for_results = PG::BasicTypeMapForResults.new(@connection)
    result = queue.enqueue("t", {"n" => 1})

    expect(@connection.exec("SHOW search_path").getvalue(0, 0)).to eq("pg_catalog")
    expect(@connection.exec("SELECT 1 AS n").getvalue(0, 0)).to eq(1)
    expect(result.task_id).to match(/\A\h{8}-/)
  end
end
