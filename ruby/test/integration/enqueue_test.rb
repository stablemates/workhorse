# frozen_string_literal: true

require_relative "../test_helper"

class EnqueueTest < DatabaseTest
  STORED = <<~SQL
    SELECT task.queue_name, task.task_type, task.payload, task.priority, task.max_attempts, task.tags,
           task.retry_policy, task.deadline_at, task.execution_timeout_ms, task.concurrency_key,
           task.budget_name, runtime.run_at, runtime.state
      FROM workhorse.task task
      JOIN workhorse.task_runtime runtime ON runtime.task_id = task.id
     WHERE task.id = $1
  SQL

  def stored(task_id) = @connection.exec_params(STORED, [task_id]).first

  def test_enqueue_persists_run_at_priority_tags_and_max_attempts
    run_at = Time.at(Time.now.to_i + 3600)
    result = queue.enqueue("email.send", { "to" => "a@b.c" }, run_at: run_at, priority: 7,
                                                              tags: %w[billing eu], max_attempts: 3)

    assert_equal :accepted, result.outcome
    row = stored(result.task_id)
    assert_equal [@queue_name, "email.send", { "to" => "a@b.c" }],
                 [row["queue_name"], row["task_type"], JSON.parse(row["payload"])]
    assert_equal %w[7 3 {billing,eu} scheduled],
                 row.values_at("priority", "max_attempts", "tags", "state")
    assert_equal run_at, Time.parse(row["run_at"])
  end

  def test_enqueue_persists_retry_policy_deadline_and_execution_timeout
    deadline = Time.at(Time.now.to_i + 7200)
    result = queue.enqueue("t", {}, retry_policy: { "type" => "fixed", "delayMs" => 1000 },
                                    deadline: deadline, execution_timeout: 30)

    row = stored(result.task_id)
    assert_equal({ "type" => "fixed", "delayMs" => 1000 }, JSON.parse(row["retry_policy"]))
    assert_equal deadline, Time.parse(row["deadline_at"])
    assert_equal "30000", row["execution_timeout_ms"]
    assert_equal "ready", row["state"]
    assert_equal "25", row["max_attempts"], "an unset max attempts takes the protocol default"
  end

  def test_enqueue_persists_concurrency_key_and_budget
    result = queue.enqueue("t", {}, concurrency_key: "tenant-1", budget: "openai")

    assert_equal %w[tenant-1 openai], stored(result.task_id).values_at("concurrency_key", "budget_name")
  end

  def test_enqueue_many_writes_an_atomic_batch_in_request_order
    requests = [
      W::EnqueueRequest.new(task_type: "a", payload: { "n" => 1 }),
      W::EnqueueRequest.new(task_type: "b", payload: { "n" => 2 }, queue: "#{@queue_name}-other")
    ]
    results = queue.enqueue_many(requests)

    assert_equal %i[accepted accepted], results.map(&:outcome)
    assert_equal(%w[a b], results.map { |result| stored(result.task_id)["task_type"] })
    assert_equal "#{@queue_name}-other", stored(results[1].task_id)["queue_name"]
    assert_empty queue.enqueue_many([])

    invalid = [W::EnqueueRequest.new(task_type: "a", payload: {}),
               W::EnqueueRequest.new(task_type: "a", payload: {}, priority: 101)]
    error = assert_raises(ArgumentError) { queue.enqueue_many(invalid) }
    assert_equal "enqueue request 2: invalid enqueue options: priority must be between 0 and 100", error.message
    assert_equal 1, task_count, "a refused batch writes nothing"
  end

  def test_enqueue_idempotency_replays_and_rejects_a_conflicting_request
    idempotency = W::Idempotency.new(key: "order-42")
    first = queue.enqueue("order.ship", { "id" => 42 }, idempotency: idempotency)
    replay = queue.enqueue("order.ship", { "id" => 42 }, idempotency: idempotency)

    assert_equal %i[accepted replayed], [first.outcome, replay.outcome]
    assert_equal first.task_id, replay.task_id

    error = assert_raises(W::EnqueueIdempotencyConflictError) do
      queue.enqueue("order.ship", { "id" => 99 }, idempotency: idempotency)
    end
    assert_equal first.task_id, error.details["existingTaskId"]
    assert_includes error.details["conflictingFields"], "payload"
    assert_equal 1, task_count
  end

  def test_debounce_replaces_a_pending_task_inside_its_window
    debounce = W::Debounce.new(key: "search-index", window: 60)
    first = queue.enqueue("index.rebuild", { "v" => 1 }, debounce: debounce)
    row = stored(first.task_id)

    assert_equal "scheduled", row["state"]
    assert_operator Time.parse(row["run_at"]), :>, Time.now + 50

    second = queue.enqueue("index.rebuild", { "v" => 2 }, debounce: debounce)
    assert_equal :replaced, second.outcome
    assert_equal first.task_id, second.task_id
    assert_equal({ "v" => 2 }, JSON.parse(stored(first.task_id)["payload"]))
    assert_equal 1, task_count
  end

  def test_throttle_coalesces_requests_inside_its_window
    throttle = W::Throttle.new(key: "digest", window: 60)
    first = queue.enqueue("digest.send", {}, throttle: throttle)
    second = queue.enqueue("digest.send", {}, throttle: throttle)

    assert_equal %i[accepted coalesced], [first.outcome, second.outcome]
    assert_equal first.task_id, second.task_id
    assert_equal "ready", stored(first.task_id)["state"]
  end

  def test_dependencies_block_a_task_with_its_terminal_policies
    prerequisite = queue.enqueue("extract", {})
    dependencies = W::Dependencies.new(prerequisite_task_ids: [prerequisite.task_id.upcase], on_success: :release,
                                       on_failure: :cancel, on_cancellation: :fail)
    dependent = queue.enqueue("load", {}, dependencies: dependencies)

    assert_equal "blocked", stored(dependent.task_id)["state"]
    edge = @connection.exec_params(
      "SELECT prerequisite_task_id, on_success, on_failure, on_cancellation FROM workhorse.task_dependency " \
      "WHERE dependent_task_id = $1", [dependent.task_id]
    ).first
    assert_equal [prerequisite.task_id, "release", "cancel", "fail"], edge.values
  end

  def test_transactional_enqueue_commits_and_rolls_back_with_the_caller
    caller = ScratchDatabase.connect
    caller.transaction do
      queue(caller).enqueue("t", {})
      assert_equal 0, task_count, "an uncommitted enqueue is invisible to another session"
    end
    assert_equal 1, task_count

    caller.transaction do
      queue(caller).enqueue("t", {})
      raise PG::RollbackTransaction
    end
    assert_equal 1, task_count, "a rolled-back enqueue leaves no task"
  ensure
    caller&.close
  end

  def test_connection_pool_executor_enqueues_through_the_pool
    pool = ConnectionPool.new(size: 2) { ScratchDatabase.connect }
    results = Array.new(4) { queue(pool).enqueue("t", {}) }

    assert_equal 4, results.map(&:task_id).uniq.length
    assert_equal 4, task_count
  ensure
    pool&.shutdown(&:close)
  end

  def test_incompatible_schema_refuses_before_the_first_write
    @connection.transaction do |connection|
      connection.exec("DELETE FROM workhorse.schema_version; INSERT INTO workhorse.schema_version(version) VALUES (17)")
      error = assert_raises(W::CompatibilityError) { queue(connection).enqueue("t", {}) }
      assert_equal :schema_too_old, error.code
      assert_equal 0, task_count(connection)
      raise PG::RollbackTransaction
    end
  end

  def test_the_caller_session_keeps_its_own_type_map_and_search_path
    @connection.exec("SET search_path TO pg_catalog")
    @connection.type_map_for_results = PG::BasicTypeMapForResults.new(@connection)
    result = queue.enqueue("t", { "n" => 1 })

    assert_equal "pg_catalog", @connection.exec("SHOW search_path").getvalue(0, 0)
    assert_equal 1, @connection.exec("SELECT 1 AS n").getvalue(0, 0)
    assert_match(/\A\h{8}-/, result.task_id)
  end
end
