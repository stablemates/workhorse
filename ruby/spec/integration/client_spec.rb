# frozen_string_literal: true

RSpec.describe "Queue client operations against PostgreSQL" do
  include_context "with a scratch database"

  nil_task = "00000000-0000-0000-0000-000000000000"
  worker = "ruby-client-test"

  # Claims the next task on the test queue and returns [task ID, fence token] as text.
  define_method(:claim) do
    @connection.exec_params("SELECT task_id, fence_token FROM workhorse.claim_v1($1, $2, 30000)",
      [@queue_name, worker]).first.values
  end

  it "reports each PostgreSQL cancel disposition" do
    ready = queue.enqueue("t", {})
    result = queue.cancel(ready.task_id, requested_by: "operator", reason: "not needed")

    expect([result.status, result.task_id, result.state]).to eq([:canceled, ready.task_id, :canceled])
    expect([result.requested_by, result.reason]).to eq(["operator", "not needed"])
    expect(result.finished_at).to be_a(Time)
    expect(queue.cancel(ready.task_id, requested_by: "operator").status).to eq(:canceled)

    active = queue.enqueue("t", {})
    claim
    requested = queue.cancel(active.task_id, requested_by: "operator")
    expect([requested.status, requested.state, requested.current_attempt]).to eq([:cancel_requested, :active, 1])
    expect(requested.requested_at).to be_a(Time)

    missing = queue.cancel(nil_task, requested_by: "operator")
    expect([missing.status, missing.state]).to eq([:not_found, nil])
  end

  it "returns the queue health snapshot" do
    queue.enqueue("t", {})
    health = queue.health

    expect(health.dig("status", "level")).to be_a(String)
    expect(health).to have_key("budgets")
  end

  it "delivers a signal once and reports each status" do
    task = queue.enqueue("wait", {})
    not_waiting = queue.send_signal(task.task_id, "approved", {}, idempotency_key: "k0", requested_by: "ops")
    expect(not_waiting.status).to eq(:not_waiting)

    task_id, fence = claim
    @connection.exec_params(W::SqlCatalogue::WAIT_FOR_SIGNAL_V1, [task_id, worker, fence, "approved", "60000"])
    delivered = queue.send_signal(task_id, "approved", {"ok" => true}, idempotency_key: "k1", requested_by: "ops")
    expect([delivered.status, delivered.task_id, delivered.name, delivered.payload, delivered.delivered_by])
      .to eq([:delivered, task_id, "approved", {"ok" => true}, "ops"])
    expect(delivered.delivered_at).to be_a(Time)

    duplicate = queue.send_signal(task_id, "approved", {"ok" => true}, idempotency_key: "k1", requested_by: "ops")
    expect(duplicate.status).to eq(:duplicate)
    expect { queue.send_signal(task_id, "approved", {"ok" => false}, idempotency_key: "k1", requested_by: "ops") }
      .to raise_error(W::SignalIdempotencyConflictError) { |error| expect(error.name).to eq("approved") }

    missing = queue.send_signal(nil_task, "approved", {}, idempotency_key: "k2", requested_by: "ops")
    expect(missing.status).to eq(:not_found)
  end

  it "completes a human wait once and reports each status" do
    task = queue.enqueue("wait", {})
    not_waiting = queue.complete_human_wait(task.task_id, "review", {}, idempotency_key: "k0", requested_by: "ann")
    expect(not_waiting.status).to eq(:not_waiting)

    task_id, fence = claim
    @connection.exec_params(W::SqlCatalogue::WAIT_FOR_HUMAN_V1,
      [task_id, worker, fence, "review", '{"question":"ship it?"}', "60000"])
    answer = {"approved" => true}
    completed = queue.complete_human_wait(task_id, "review", answer, idempotency_key: "k1", requested_by: "ann")
    expect([completed.status, completed.name, completed.payload, completed.completed_by])
      .to eq([:completed, "review", answer, "ann"])
    expect(completed.completed_at).to be_a(Time)

    duplicate = queue.complete_human_wait(task_id, "review", answer, idempotency_key: "k1", requested_by: "ann")
    expect(duplicate.status).to eq(:duplicate)
    expect {
      queue.complete_human_wait(task_id, "review", {"approved" => false}, idempotency_key: "k1", requested_by: "ann")
    }.to raise_error(W::HumanWaitIdempotencyConflictError)
    missing = queue.complete_human_wait(nil_task, "review", answer, idempotency_key: "k2", requested_by: "ann")
    expect(missing.status).to eq(:not_found)
  end

  it "stores and prunes schedule definitions" do
    namespace = @queue_name
    nightly = W::ScheduleDefinition.new(
      name: "nightly", schedule: "0 3 * * *", timezone: "Europe/Berlin", catchup_policy: :latest,
      task: W::ScheduledTask.new(task_type: "report.build", payload: {"kind" => "daily"}, priority: 5,
        concurrency_key: "reports", max_attempts: 4,
        retry_policy: {"type" => "fixed", "delayMs" => 1000})
    )
    hourly = W::ScheduleDefinition.new(name: "hourly", schedule: "0 * * * *",
      task: W::ScheduledTask.new(task_type: "ping", payload: {}))
    expect(queue.sync_schedules(namespace, [nightly, hourly])).to be_nil

    row = @connection.exec_params(<<~SQL, [namespace]).first
      SELECT cron_expression, timezone, queue_name, task_type, payload, priority, concurrency_key,
             max_attempts, retry_policy, catchup_policy, configured_enabled
        FROM workhorse.schedule_definition WHERE namespace = $1 AND schedule_name = 'nightly'
    SQL
    expect(row.values).to eq(["0 3 * * *", "Europe/Berlin", @queue_name, "report.build", '{"kind": "daily"}', "5",
      "reports", "4", '{"type": "fixed", "delayMs": 1000}', "latest", "t"])

    queue.sync_schedules(namespace, [hourly])
    enabled = @connection.exec_params("SELECT schedule_name FROM workhorse.schedule_definition " \
                                      "WHERE namespace = $1 AND configured_enabled", [namespace]).column_values(0)
    expect(enabled).to eq(["hourly"]), "prune disables a schedule missing from the sync"

    invalid = W::ScheduleDefinition.new(name: "bad", schedule: "* * * * *",
      task: W::ScheduledTask.new(task_type: "ping", payload: {}, priority: 101))
    expect { queue.sync_schedules(namespace, [invalid], prune: false) }
      .to raise_error(ArgumentError,
        "schedule definition 1: invalid schedule definition: priority must be an Integer between 0 and 100")
  end

  it "applies the current contract to synced schedules" do
    namespace = @queue_name
    capture = "payment.capture.#{@queue_name}"
    report = "payment.report.#{@queue_name}"
    version = W::TaskContractVersion.new(
      payload_schema: {"type" => "object", "required" => ["account"],
                       "properties" => {"account" => {"type" => "string"}, "card" => {"type" => "string"}}},
      max_payload_bytes: 4096, max_result_bytes: 8192, sensitive_payload_keys: ["card"],
      sensitive_result_keys: ["receipt"]
    )
    queue.sync_contracts(capture => W::TaskTypeContracts.new(current_version: "v2", versions: {"v2" => version}))
    schedules = lambda do |payload|
      [W::ScheduleDefinition.new(name: "capture", schedule: "0 * * * *",
        task: W::ScheduledTask.new(task_type: capture, payload: payload)),
        W::ScheduleDefinition.new(name: "report", schedule: "0 3 * * *",
          task: W::ScheduledTask.new(task_type: report, payload: {}))]
    end
    stored = lambda do
      @connection.exec_params(<<~SQL, [namespace]).values
        SELECT schedule_name, contract_version, payload_max_bytes, result_max_bytes, payload_redact_keys,
               result_redact_keys
          FROM workhorse.schedule_definition WHERE namespace = $1 ORDER BY schedule_name
      SQL
    end

    # A Queue that never synced contracts still reads the current contract from PostgreSQL.
    expect { queue.sync_schedules(namespace, schedules.call({"card" => "4242"})) }
      .to raise_error(W::ContractValidationError) { |error|
        expect([error.task_type, error.version]).to eq([capture, "v2"])
      }
    expect(stored.call).to eq([])

    queue.sync_schedules(namespace, schedules.call({"account" => "acct_1"}))
    expect(stored.call).to eq([
      ["capture", "v2", "4096", "8192", "{card}", "{receipt}"],
      ["report", nil, "1048576", "1048576", "{}", "{}"]
    ])
  end

  it "validates payloads against synced contracts and stamps contract fields" do
    task_type = "email.send.#{@queue_name}"
    version = W::TaskContractVersion.new(
      payload_schema: {"type" => "object", "properties" => {"to" => {"type" => "string"},
                                                            "token" => {"type" => "string"}},
                       "required" => ["to"]},
      max_payload_bytes: 4096, sensitive_payload_keys: ["token"]
    )
    queue.sync_contracts(task_type => W::TaskTypeContracts.new(current_version: "v2", versions: {"v2" => version}))

    expect { queue.enqueue(task_type, {"token" => "x"}) }.to raise_error(W::ContractValidationError) { |error|
      expect([error.task_type, error.version]).to eq([task_type, "v2"])
    }

    accepted = queue.enqueue(task_type, {"to" => "a@b.c", "token" => "x"})
    expect(task_row(accepted.task_id).values_at("contract_version", "payload_max_bytes", "payload_redact_keys"))
      .to eq(%w[v2 4096 {token}])

    # A second Queue has not synced, so it learns the contract from PostgreSQL's mismatch.
    other = queue
    learned = other.enqueue(task_type, {"to" => "b@c.d"})
    expect(task_row(learned.task_id)["contract_version"]).to eq("v2")
    expect { other.enqueue(task_type, {}) }.to raise_error(W::ContractValidationError)

    outside = W::TaskTypeContracts.new(
      current_version: "v1",
      versions: {"v1" => W::TaskContractVersion.new(payload_schema: {"$ref" => "https://example.com/schema"})}
    )
    expect { queue.sync_contracts("bad.#{@queue_name}" => outside) }.to raise_error(ArgumentError)
  end

  it "decodes stored policies and budgets" do
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
    expect(concurrency.map { |policy| [policy.queue, policy.max_active, policy.max_active_per_key] })
      .to eq([[emails, 10, 2], [reports, 3, nil]])
    expect(concurrency.first.namespace).to eq("app")
    expect(concurrency.first.updated_at).to be_a(Time)

    rate = queue.list_rate_limit_policies(queues: [emails, reports]).sort_by(&:queue)
    expect(rate.first.rate).to eq(W::RateLimit.new(limit: 10, interval: 1, burst: 20))
    expect(rate.first.per_key).to eq(W::RateLimit.new(limit: 1, interval: 1, burst: 1))
    expect(rate.last.per_key).to be_nil

    budgets = queue.list_budgets(names: [budget])
    expect(budgets.map { |row| [row.name, row.max_active, row.rate] })
      .to eq([[budget, 8, W::RateLimit.new(limit: 60, interval: 60, burst: 60)]])
    expect(queue.list_budgets.length).to be >= 1
  end

  it "syncs policies and budgets per namespace, pruning what a sync omits" do
    namespace = "ns-#{@queue_name}"
    emails = "#{@queue_name}-emails"
    reports = "#{@queue_name}-reports"
    rate = W::RateLimit.new(limit: 10, interval: 1, burst: 20)

    stored = queue.sync_concurrency_policies(namespace, [
      W::ConcurrencyPolicyDefinition.new(queue: emails, max_active: 10, max_active_per_key: 2),
      W::ConcurrencyPolicyDefinition.new(queue: reports, max_active: 3)
    ])
    expect(stored.map { |policy| [policy.namespace, policy.queue, policy.max_active, policy.max_active_per_key] }
      .sort).to eq([[namespace, emails, 10, 2], [namespace, reports, 3, nil]])

    queue.sync_concurrency_policies(namespace, [W::ConcurrencyPolicyDefinition.new(queue: emails, max_active: 4)],
      prune: false)
    expect(queue.list_concurrency_policies(queues: [emails, reports]).map { |policy| [policy.queue, policy.max_active] }
      .sort).to eq([[emails, 4], [reports, 3]])

    queue.sync_concurrency_policies(namespace, [W::ConcurrencyPolicyDefinition.new(queue: emails, max_active: 4)])
    expect(queue.list_concurrency_policies(queues: [emails, reports]).map(&:queue)).to eq([emails])
    expect { queue.sync_concurrency_policies("other-#{namespace}", [W::ConcurrencyPolicyDefinition.new(queue: emails, max_active: 1)]) }
      .to raise_error(W::DatabaseError, /owned by another namespace/)

    limits = queue.sync_rate_limit_policies(namespace, [W::RateLimitPolicyDefinition.new(queue: emails, rate: rate, per_key: rate)])
    expect(limits.map { |policy| [policy.queue, policy.rate, policy.per_key] }).to eq([[emails, rate, rate]])

    budget = "budget-#{@queue_name}"
    budgets = queue.sync_budgets(namespace, [W::BudgetDefinition.new(name: budget, max_active: 8)])
    expect(budgets.map { |row| [row.namespace, row.name, row.max_active, row.rate] }).to eq([[namespace, budget, 8, nil]])

    expect(queue.sync_concurrency_policies(namespace, [])).to eq([])
    expect(queue.sync_rate_limit_policies(namespace, [])).to eq([])
    expect(queue.sync_budgets(namespace, [])).to eq([])
    expect(queue.list_concurrency_policies(queues: [emails])).to eq([])
    expect(queue.list_budgets(names: [budget])).to eq([])
  end
end
