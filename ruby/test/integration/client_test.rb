# frozen_string_literal: true

require_relative "../test_helper"

class ClientTest < DatabaseTest
  NIL_TASK = "00000000-0000-0000-0000-000000000000"
  WORKER = "ruby-client-test"

  # Claims the next task on the test queue and returns [task ID, fence token] as text.
  def claim
    @connection.exec_params("SELECT task_id, fence_token FROM workhorse.claim_v1($1, $2, 30000)",
                            [@queue_name, WORKER]).first.values
  end

  def test_cancel_reports_each_postgres_disposition
    ready = queue.enqueue("t", {})
    result = queue.cancel(ready.task_id, requested_by: "operator", reason: "not needed")

    assert_equal [:canceled, ready.task_id, :canceled], [result.status, result.task_id, result.state]
    assert_equal ["operator", "not needed"], [result.requested_by, result.reason]
    assert_kind_of Time, result.finished_at
    assert_equal :canceled, queue.cancel(ready.task_id, requested_by: "operator").status

    active = queue.enqueue("t", {})
    claim
    requested = queue.cancel(active.task_id, requested_by: "operator")
    assert_equal [:cancel_requested, :active, 1], [requested.status, requested.state, requested.current_attempt]
    assert_kind_of Time, requested.requested_at

    missing = queue.cancel(NIL_TASK, requested_by: "operator")
    assert_equal [:not_found, nil], [missing.status, missing.state]
  end

  def test_health_returns_the_queue_health_snapshot
    queue.enqueue("t", {})
    health = queue.health

    assert_kind_of String, health.dig("status", "level")
    assert health.key?("budgets")
  end

  def test_send_signal_delivers_once_and_reports_each_status
    task = queue.enqueue("wait", {})
    not_waiting = queue.send_signal(task.task_id, "approved", {}, idempotency_key: "k0", requested_by: "ops")
    assert_equal :not_waiting, not_waiting.status

    task_id, fence = claim
    @connection.exec_params(W::SqlCatalogue::WAIT_FOR_SIGNAL_V1, [task_id, WORKER, fence, "approved", "60000"])
    delivered = queue.send_signal(task_id, "approved", { "ok" => true }, idempotency_key: "k1", requested_by: "ops")
    assert_equal [:delivered, task_id, "approved", { "ok" => true }, "ops"],
                 [delivered.status, delivered.task_id, delivered.name, delivered.payload, delivered.delivered_by]
    assert_kind_of Time, delivered.delivered_at

    duplicate = queue.send_signal(task_id, "approved", { "ok" => true }, idempotency_key: "k1", requested_by: "ops")
    assert_equal :duplicate, duplicate.status
    error = assert_raises(W::SignalIdempotencyConflictError) do
      queue.send_signal(task_id, "approved", { "ok" => false }, idempotency_key: "k1", requested_by: "ops")
    end
    assert_equal "approved", error.name

    missing = queue.send_signal(NIL_TASK, "approved", {}, idempotency_key: "k2", requested_by: "ops")
    assert_equal :not_found, missing.status
  end

  def test_complete_human_wait_completes_once_and_reports_each_status
    task = queue.enqueue("wait", {})
    not_waiting = queue.complete_human_wait(task.task_id, "review", {}, idempotency_key: "k0", requested_by: "ann")
    assert_equal :not_waiting, not_waiting.status

    task_id, fence = claim
    @connection.exec_params(W::SqlCatalogue::WAIT_FOR_HUMAN_V1,
                            [task_id, WORKER, fence, "review", '{"question":"ship it?"}', "60000"])
    answer = { "approved" => true }
    completed = queue.complete_human_wait(task_id, "review", answer, idempotency_key: "k1", requested_by: "ann")
    assert_equal [:completed, "review", answer, "ann"],
                 [completed.status, completed.name, completed.payload, completed.completed_by]
    assert_kind_of Time, completed.completed_at

    duplicate = queue.complete_human_wait(task_id, "review", answer, idempotency_key: "k1", requested_by: "ann")
    assert_equal :duplicate, duplicate.status
    assert_raises(W::HumanWaitIdempotencyConflictError) do
      queue.complete_human_wait(task_id, "review", { "approved" => false }, idempotency_key: "k1",
                                                                            requested_by: "ann")
    end
    missing = queue.complete_human_wait(NIL_TASK, "review", answer, idempotency_key: "k2", requested_by: "ann")
    assert_equal :not_found, missing.status
  end

  def test_sync_schedules_stores_and_prunes_definitions
    namespace = @queue_name
    nightly = W::ScheduleDefinition.new(
      name: "nightly", schedule: "0 3 * * *", timezone: "Europe/Berlin", catchup_policy: :latest,
      task: W::ScheduledTask.new(task_type: "report.build", payload: { "kind" => "daily" }, priority: 5,
                                 concurrency_key: "reports", max_attempts: 4,
                                 retry_policy: { "type" => "fixed", "delayMs" => 1000 })
    )
    hourly = W::ScheduleDefinition.new(name: "hourly", schedule: "0 * * * *",
                                       task: W::ScheduledTask.new(task_type: "ping", payload: {}))
    assert_nil queue.sync_schedules(namespace, [nightly, hourly])

    row = @connection.exec_params(<<~SQL, [namespace]).first
      SELECT cron_expression, timezone, queue_name, task_type, payload, priority, concurrency_key,
             max_attempts, retry_policy, catchup_policy, configured_enabled
        FROM workhorse.schedule_definition WHERE namespace = $1 AND schedule_name = 'nightly'
    SQL
    assert_equal ["0 3 * * *", "Europe/Berlin", @queue_name, "report.build", '{"kind": "daily"}', "5", "reports",
                  "4", '{"type": "fixed", "delayMs": 1000}', "latest", "t"], row.values

    queue.sync_schedules(namespace, [hourly])
    enabled = @connection.exec_params("SELECT schedule_name FROM workhorse.schedule_definition " \
                                      "WHERE namespace = $1 AND configured_enabled", [namespace]).column_values(0)
    assert_equal ["hourly"], enabled, "prune disables a schedule missing from the sync"

    invalid = W::ScheduleDefinition.new(name: "bad", schedule: "* * * * *",
                                        task: W::ScheduledTask.new(task_type: "ping", payload: {}, priority: 101))
    error = assert_raises(ArgumentError) { queue.sync_schedules(namespace, [invalid], prune: false) }
    assert_equal "schedule definition 1: invalid schedule definition: priority must be between 0 and 100",
                 error.message
  end

  def test_sync_contracts_validates_payloads_and_stamps_contract_fields
    task_type = "email.send.#{@queue_name}"
    version = W::TaskContractVersion.new(
      payload_schema: { "type" => "object", "properties" => { "to" => { "type" => "string" },
                                                              "token" => { "type" => "string" } },
                        "required" => ["to"] },
      max_payload_bytes: 4096, sensitive_payload_keys: ["token"]
    )
    queue.sync_contracts(task_type => W::TaskTypeContracts.new(current_version: "v2", versions: { "v2" => version }))

    error = assert_raises(W::ContractValidationError) { queue.enqueue(task_type, { "token" => "x" }) }
    assert_equal [task_type, "v2"], [error.task_type, error.version]

    accepted = queue.enqueue(task_type, { "to" => "a@b.c", "token" => "x" })
    assert_equal %w[v2 4096 {token}],
                 task_row(accepted.task_id).values_at("contract_version", "payload_max_bytes", "payload_redact_keys")

    # A second Queue has not synced, so it learns the contract from PostgreSQL's mismatch.
    other = queue
    learned = other.enqueue(task_type, { "to" => "b@c.d" })
    assert_equal "v2", task_row(learned.task_id)["contract_version"]
    assert_raises(W::ContractValidationError) { other.enqueue(task_type, {}) }

    outside = W::TaskTypeContracts.new(
      current_version: "v1",
      versions: { "v1" => W::TaskContractVersion.new(payload_schema: { "$ref" => "https://example.com/schema" }) }
    )
    assert_raises(ArgumentError) { queue.sync_contracts("bad.#{@queue_name}" => outside) }
  end

  def test_list_policies_decodes_stored_policies_and_budgets
    emails = "#{@queue_name}-emails"
    reports = "#{@queue_name}-reports"
    budget = "budget-#{@queue_name}"
    @connection.exec_params(<<~SQL, [emails, reports])
      INSERT INTO workhorse.concurrency_policy (queue_name, namespace, max_active, max_active_per_key)
        VALUES ($1, 'app', 10, 2), ($2, 'app', 3, NULL)
    SQL
    @connection.exec_params(<<~SQL, [emails, reports])
      INSERT INTO workhorse.rate_limit_policy
        (queue_name, namespace, rate_limit, rate_interval_ms, rate_burst, per_key_limit, per_key_interval_ms,
         per_key_burst)
        VALUES ($1, 'app', 10, 1000, 20, 1, 1000, 1), ($2, 'app', 5, 60000, 5, NULL, NULL, NULL)
    SQL
    @connection.exec_params(<<~SQL, [budget])
      INSERT INTO workhorse.budget (budget_name, namespace, max_active, rate_limit, rate_interval_ms, rate_burst)
        VALUES ($1, 'app', 8, 60, 60000, 60)
    SQL

    concurrency = queue.list_concurrency_policies(queues: [emails, reports]).sort_by(&:queue)
    assert_equal([[emails, 10, 2], [reports, 3, nil]],
                 concurrency.map { |policy| [policy.queue, policy.max_active, policy.max_active_per_key] })
    assert_equal "app", concurrency.first.namespace
    assert_kind_of Time, concurrency.first.updated_at

    rate = queue.list_rate_limit_policies(queues: [emails, reports]).sort_by(&:queue)
    assert_equal W::RateLimit.new(limit: 10, interval_ms: 1000, burst: 20), rate.first.rate
    assert_equal W::RateLimit.new(limit: 1, interval_ms: 1000, burst: 1), rate.first.per_key
    assert_nil rate.last.per_key

    budgets = queue.list_budgets(names: [budget])
    assert_equal([[budget, 8, W::RateLimit.new(limit: 60, interval_ms: 60_000, burst: 60)]],
                 budgets.map { |row| [row.name, row.max_active, row.rate] })
    assert_operator queue.list_budgets.length, :>=, 1
  end
end
