# frozen_string_literal: true

RSpec.describe Stablemates::Workhorse::Queue do
  task = "0190a6f8-0000-7000-8000-000000000001"

  def refusal(**options)
    executor = FakeExecutor.new
    message = nil
    expect { described_class.new(executor).enqueue("t", {}, **options) }
      .to raise_error(ArgumentError) { |error| message = error.message }
    expect(executor.statements).to be_empty, "an invalid request runs no statement"
    message
  end

  def refusal_for_payload(payload)
    message = nil
    expect { described_class.new(FakeExecutor.new).enqueue("t", payload) }
      .to raise_error(ArgumentError) { |error| message = error.message }
    message
  end

  it "raises ArgumentError for invalid options before any statement" do
    prefix = "enqueue request 1: invalid enqueue options: "
    expect(refusal(priority: -1)).to eq("enqueue request 1: priority must be an Integer between 0 and 100")
    expect(refusal(idempotency: W::Idempotency.new(key: "k"), throttle: W::Throttle.new(key: "k", window: 1)))
      .to eq("#{prefix}cannot combine idempotency, debounce, or throttle")
    expect(refusal(debounce: W::Debounce.new(key: "k", window: 1), run_at: Time.now))
      .to eq("#{prefix}debounced enqueue uses its PostgreSQL-owned window instead of run at")
    dependencies = W::Dependencies.new(prerequisite_task_ids: [task, task.upcase], on_success: :release,
      on_failure: :cancel, on_cancellation: :cancel)
    expect(refusal(dependencies: dependencies)).to eq("#{prefix}dependencies must contain unique prerequisite task IDs")
  end

  it "requires a JSON payload" do
    expect(refusal_for_payload({"a" => :b})).to match(/payload contains Symbol, which is not a JSON value/)
    expect(refusal_for_payload({a: 1})).to match(/payload object keys must be Strings/)
    expect(refusal_for_payload([Float::NAN])).to match(/non-finite number/)
  end

  it "requires UUID task IDs" do
    expect { described_class.new(FakeExecutor.new).cancel("42", requested_by: nil) }
      .to raise_error(ArgumentError, "task ID must be a UUID String")
  end

  it "raises UnexpectedStatusError for an unknown status" do
    cancel = described_class.new(FakeExecutor.new { [{"status" => "vaporized", "state" => nil}] })
    expect { cancel.cancel(task, requested_by: "ops") }.to raise_error(W::UnexpectedStatusError) { |error|
      expect([error.operation, error.status]).to eq([:cancel, "vaporized"])
    }

    signal = described_class.new(FakeExecutor.new { [{"status" => "teleported"}] })
    expect { signal.send_signal(task, "go", {}, idempotency_key: "k", requested_by: "ops") }
      .to raise_error(W::UnexpectedStatusError) { |error|
        expect([error.operation, error.status]).to eq([:send_signal, "teleported"])
      }

    human = described_class.new(FakeExecutor.new { [{"status" => "shrugged"}] })
    expect { human.complete_human_wait(task, "review", {}, idempotency_key: "k", requested_by: "ann") }
      .to raise_error(W::UnexpectedStatusError)
  end

  it "measures signal payloads and human wait results as jsonb text before any statement runs" do
    # Compact JSON writes 30,000 zeros in 60,001 bytes. PostgreSQL's jsonb text puts a space after
    # each comma, so it writes the same array in 90,000 bytes, which is above the limit.
    zeros = [0] * 30_000
    expect(JSON.generate(zeros).bytesize).to be < 65_536
    executor = FakeExecutor.new
    queue = described_class.new(executor)
    expect { queue.send_signal(task, "go", zeros, idempotency_key: "k", requested_by: "ops") }
      .to raise_error(ArgumentError, "signal payload must be at most 65536 bytes of JSON")
    expect { queue.complete_human_wait(task, "review", zeros, idempotency_key: "k", requested_by: "ann") }
      .to raise_error(ArgumentError, "human wait result must be at most 65536 bytes of JSON")
    expect(executor.statements).to be_empty
  end

  it "refuses an unknown enqueue outcome" do
    queue = described_class.new(FakeExecutor.new do
      [{"ordinal" => "1", "task_id" => task, "outcome" => "levitated", "reason" => nil}]
    end)
    expect { queue.enqueue("t", {}) }.to raise_error(W::UnexpectedStatusError) { |error|
      expect([error.operation, error.status]).to eq([:enqueue, "levitated"])
    }
  end

  it "reports why a debounced enqueue was not replaceable" do
    %w[incompatible_key_mode not_pending window_elapsed_pending].each do |reason|
      queue = described_class.new(FakeExecutor.new do
        [{"ordinal" => "1", "task_id" => task, "outcome" => "non_replaceable", "reason" => reason}]
      end)
      result = queue.enqueue("t", {}, debounce: W::Debounce.new(key: "k", window: 1))
      expect([result.outcome, result.reason]).to eq([:non_replaceable, reason.to_sym])
    end

    accepted = described_class.new(FakeExecutor.new do
      [{"ordinal" => "1", "task_id" => task, "outcome" => "accepted", "reason" => nil}]
    end).enqueue("t", {})
    expect([accepted.outcome, accepted.reason]).to eq([:accepted, nil])
    expect(W::EnqueueResult.new(task_id: task, outcome: :accepted).reason).to be_nil
  end

  it "refuses an enqueue reason that does not match its outcome" do
    [["non_replaceable", nil], ["non_replaceable", "vanished"], ["accepted", "not_pending"]].each do |outcome, reason|
      queue = described_class.new(FakeExecutor.new do
        [{"ordinal" => "1", "task_id" => task, "outcome" => outcome, "reason" => reason}]
      end)
      expect { queue.enqueue("t", {}) }
        .to raise_error(ArgumentError, "PostgreSQL returned an invalid enqueue result")
    end
  end

  it "refuses an incompatible schema before the statement" do
    executor = Class.new(FakeExecutor) do
      def rows(sql, params = [])
        return [{"kind" => "schema", "version" => "1"}] if sql == W::SqlCatalogue::COMPATIBILITY_STATE

        super
      end
    end.new
    expect { described_class.new(executor).enqueue("t", {}) }
      .to raise_error(W::CompatibilityError) { |error| expect(error.code).to eq(:schema_too_old) }
    expect(executor.statements).to be_empty
  end

  it "requires an executor that responds to with" do
    expect { described_class.new(Object.new) }.to raise_error(ArgumentError)
  end

  it "sends each policy sync as its namespace, JSON definitions, and prune" do
    executor = FakeExecutor.new
    queue = described_class.new(executor)
    rate = W::RateLimit.new(limit: 10, interval: 1, burst: 20)
    queue.sync_concurrency_policies("app", [W::ConcurrencyPolicyDefinition.new(queue: "q", max_active: 3)])
    queue.sync_rate_limit_policies("app", [W::RateLimitPolicyDefinition.new(queue: "q", rate: rate)], prune: false)
    queue.sync_budgets("app", [W::BudgetDefinition.new(name: "b", rate: rate)])

    expect(executor.statements.map(&:last)).to eq([
      ["app", '[{"queue":"q","maxActive":3,"maxActivePerKey":null}]', "true"],
      ["app", '[{"queue":"q","rate":{"limit":10,"intervalMs":1000,"burst":20},"perKey":null}]', "false"],
      ["app", '[{"name":"b","maxActive":null,"rate":{"limit":10,"intervalMs":1000,"burst":20}}]', "true"]
    ])
  end

  it "refuses an invalid policy sync before any statement" do
    executor = FakeExecutor.new
    queue = described_class.new(executor)
    policy = W::ConcurrencyPolicyDefinition.new(queue: "q", max_active: 1)
    expect { queue.sync_concurrency_policies("", [policy]) }
      .to raise_error(ArgumentError, "namespace must contain between 1 and 256 UTF-8 bytes")
    expect { queue.sync_concurrency_policies("app", [policy], prune: nil) }
      .to raise_error(ArgumentError, "prune must be true or false")
    expect { queue.sync_budgets("app", [policy]) }
      .to raise_error(ArgumentError, "definitions must be an Array of BudgetDefinition")
    expect { queue.sync_rate_limit_policies("app", [W::RateLimitPolicyDefinition.new(queue: "q", rate: 5)]) }
      .to raise_error(ArgumentError, "rate limit policy definition 1: rate must be a RateLimit")
    expect(executor.statements).to be_empty
  end

  it "refuses every value outside a protocol bound before any statement" do
    prefix = "enqueue request 1: "
    seconds = "must be a finite Numeric count of seconds between"
    expect(refusal(execution_timeout: -1)).to eq("#{prefix}execution timeout #{seconds} 0.001 and 31536000")
    expect(refusal(execution_timeout: Float::INFINITY)).to start_with("#{prefix}execution timeout #{seconds}")
    expect(refusal(execution_timeout: Complex(1, 1))).to start_with("#{prefix}execution timeout #{seconds}")
    expect(refusal(execution_timeout: "5")).to start_with("#{prefix}execution timeout #{seconds}")
    expect(refusal(idempotency: W::Idempotency.new(key: "k", ttl: 31_536_001)))
      .to start_with("#{prefix}idempotency TTL #{seconds}")
    expect(refusal(debounce: W::Debounce.new(key: "k", window: 0))).to start_with("#{prefix}debounce window #{seconds}")
    expect(refusal(throttle: W::Throttle.new(key: "x" * 513, window: 1)))
      .to eq("#{prefix}throttle key must contain between 1 and 512 UTF-8 bytes")
    expect(refusal(throttle: W::Throttle.new(key: "k", window: 1, scope: "é" * 129)))
      .to eq("#{prefix}scope must contain at most 256 UTF-8 bytes")
    expect(refusal(max_attempts: 101)).to eq("#{prefix}max attempts must be an Integer between 1 and 100")
    expect(refusal(max_attempts: 1.5)).to eq("#{prefix}max attempts must be an Integer between 1 and 100")
    expect(refusal(priority: 101)).to eq("#{prefix}priority must be an Integer between 0 and 100")
    expect(refusal(queue: "q" * 257)).to eq("#{prefix}queue must contain at most 256 UTF-8 bytes")
    expect(refusal(concurrency_key: "k" * 257)).to eq("#{prefix}concurrency key must contain at most 256 UTF-8 bytes")
    expect(refusal(budget: "b" * 257)).to eq("#{prefix}budget must contain at most 256 UTF-8 bytes")
    expect(refusal(tags: Array.new(21, "t"))).to start_with("#{prefix}tags must be an Array of at most 20 Strings")
    expect(refusal(tags: ["x" * 101])).to start_with("#{prefix}tags must be an Array of at most 20 Strings")
    expect(refusal(tags: [""])).to start_with("#{prefix}tags must be an Array of at most 20 Strings")
  end

  it "checks a retry policy's shape and bounds before any statement" do
    prefix = "enqueue request 1: "
    expect(refusal(retry_policy: {"type" => "linear"}))
      .to eq("#{prefix}retry policy type must be fixed, exponential, or decorrelated-jitter")
    expect(refusal(retry_policy: {"type" => "fixed", "delayMs" => 1, "extra" => 1}))
      .to eq("#{prefix}fixed retry policy requires exactly type, delayMs")
    expect(refusal(retry_policy: {"type" => "fixed", "delayMs" => -1}))
      .to eq("#{prefix}retry policy delayMs must be an integer between 0 and 31536000000")
    expect(refusal(retry_policy: {"type" => "exponential", "initialDelayMs" => 1, "multiplier" => 101, "maxDelayMs" => 2}))
      .to eq("#{prefix}retry policy multiplier must be an integer between 1 and 100")
    expect(refusal(retry_policy: {"type" => "decorrelated-jitter", "baseDelayMs" => 10, "maxDelayMs" => 5}))
      .to eq("#{prefix}retry policy maxDelayMs must be at least 10")

    executor = FakeExecutor.new { [] }
    policy = {"type" => "exponential", "initialDelayMs" => 1000.0, "multiplier" => 2, "maxDelayMs" => 60_000}
    expect { described_class.new(executor).enqueue("t", {}, retry_policy: policy) }.to raise_error(ArgumentError)
    expect(executor.statements.last.last.first).to include('"retryPolicy":{"type":"exponential","initialDelayMs":1000.0')
  end

  it "converts durations in seconds to whole milliseconds" do
    executor = FakeExecutor.new { [] }
    expect { described_class.new(executor).enqueue("t", {}, execution_timeout: 1.5) }.to raise_error(ArgumentError)
    expect(executor.statements.last.last.first).to include('"executionTimeoutMs":1500')
  end

  it "sends no execution timeout for an omitted or zero value" do
    sent = lambda do |**options|
      executor = FakeExecutor.new { [] }
      expect { described_class.new(executor).enqueue("t", {}, **options) }.to raise_error(ArgumentError)
      JSON.parse(executor.statements.last.last.first).first.fetch("executionTimeoutMs")
    end

    expect(sent.call).to be_nil
    expect(sent.call(execution_timeout: 0)).to be_nil
    expect(sent.call(execution_timeout: 0.0)).to be_nil
    expect(sent.call(execution_timeout: 0.001)).to eq(1)
    expect(sent.call(execution_timeout: 0.0005)).to eq(1)
    expect(sent.call(execution_timeout: 31_536_000)).to eq(31_536_000_000)
  end

  it "sends the default idempotency TTL for a zero value" do
    sent = lambda do |ttl|
      executor = FakeExecutor.new { [] }
      idempotency = W::Idempotency.new(key: "k", ttl: ttl)
      expect { described_class.new(executor).enqueue("t", {}, idempotency: idempotency) }.to raise_error(ArgumentError)
      JSON.parse(executor.statements.last.last.first).first.fetch("idempotency").fetch("ttlMs")
    end

    expect(sent.call(0)).to eq(86_400_000)
    expect(sent.call(0.0)).to eq(86_400_000)
    expect(sent.call(0.001)).to eq(1)
    expect(sent.call(0.0005)).to eq(1)
    expect(sent.call(31_536_000)).to eq(31_536_000_000)
  end

  it "refuses a nonzero idempotency TTL that rounds to 0 ms" do
    message = "enqueue request 1: idempotency TTL must be a finite Numeric count of seconds between " \
      "0.001 and 31536000"
    expect(refusal(idempotency: W::Idempotency.new(key: "k", ttl: 0.0004))).to eq(message)
    expect(refusal(idempotency: W::Idempotency.new(key: "k", ttl: -0.0004))).to eq(message)
    expect(refusal(idempotency: W::Idempotency.new(key: "k", ttl: -1))).to eq(message)
  end

  it "sends 25 attempts for a zero max attempts" do
    executor = FakeExecutor.new { [] }
    expect { described_class.new(executor).enqueue("t", {}, max_attempts: 0) }.to raise_error(ArgumentError)
    expect(JSON.parse(executor.statements.last.last.first).first.fetch("maxAttempts")).to eq(25)
    expect(refusal(max_attempts: -1)).to eq("enqueue request 1: max attempts must be an Integer between 1 and 100")
  end

  it "refuses a nonzero execution timeout that rounds to 0 ms" do
    message = "enqueue request 1: execution timeout must be a finite Numeric count of seconds between " \
      "0.001 and 31536000"
    expect(refusal(execution_timeout: 0.0004)).to eq(message)
    expect(refusal(execution_timeout: -0.0004)).to eq(message)
    expect(refusal(execution_timeout: 31_536_000.001)).to eq(message)
  end

  it "refuses a policy definition outside a protocol bound before any statement" do
    executor = FakeExecutor.new
    queue = described_class.new(executor)
    concurrency = ->(**options) { W::ConcurrencyPolicyDefinition.new(queue: "q", max_active: 1, **options) }
    expect { queue.sync_concurrency_policies("app", [concurrency.call(max_active: 0)]) }
      .to raise_error(ArgumentError, "concurrency policy definition 1: max active must be an Integer between 1 and 1000000")
    expect { queue.sync_concurrency_policies("app", [concurrency.call(max_active: 2, max_active_per_key: 3)]) }
      .to raise_error(ArgumentError,
        "concurrency policy definition 1: max active per key must be an Integer between 1 and 2")
    expect { queue.sync_concurrency_policies("app", [concurrency.call, concurrency.call]) }
      .to raise_error(ArgumentError, "concurrency policy queue names must be unique")
    expect { queue.sync_concurrency_policies("app", [concurrency.call(queue: "")]) }
      .to raise_error(ArgumentError, "concurrency policy definition 1: queue must contain between 1 and 256 UTF-8 bytes")
    expect { queue.sync_concurrency_policies("x" * 257, []) }
      .to raise_error(ArgumentError, "namespace must contain between 1 and 256 UTF-8 bytes")

    rate = ->(**options) { W::RateLimit.new(limit: 1, interval: 1, burst: 1, **options) }
    rate_policy = ->(limit) { [W::RateLimitPolicyDefinition.new(queue: "q", rate: limit)] }
    expect { queue.sync_rate_limit_policies("app", rate_policy.call(rate.call(interval: 86_401))) }
      .to raise_error(ArgumentError, /\Arate limit policy definition 1: rate interval must be a finite Numeric/)
    expect { queue.sync_rate_limit_policies("app", rate_policy.call(rate.call(interval: 0.0001))) }
      .to raise_error(ArgumentError, /rate interval must be a finite Numeric count of seconds between 0.001 and 86400/)
    expect { queue.sync_rate_limit_policies("app", rate_policy.call(rate.call(limit: 1_000_001))) }
      .to raise_error(ArgumentError, "rate limit policy definition 1: rate limit must be an Integer between 1 and 1000000")
    expect { queue.sync_budgets("app", [W::BudgetDefinition.new(name: "b")]) }
      .to raise_error(ArgumentError, "budget definition 1: budget requires max active, rate, or both")
    expect { queue.sync_budgets("app", [W::BudgetDefinition.new(name: "b", max_active: 0)]) }
      .to raise_error(ArgumentError, "budget definition 1: max active must be an Integer between 1 and 1000000")
    expect(executor.statements).to be_empty
  end

  it "checks prune before the compatibility check" do
    executor = Class.new(FakeExecutor) do
      attr_reader :checks

      def rows(sql, params = [])
        return super unless sql == W::SqlCatalogue::COMPATIBILITY_STATE

        @checks = (@checks || 0) + 1
        []
      end
    end.new
    expect { described_class.new(executor).sync_schedules("app", [], prune: nil) }
      .to raise_error(ArgumentError, "prune must be true or false")
    expect(executor.checks).to be_nil
  end

  it "resends a concurrency policy sync that PostgreSQL chose as a deadlock victim" do
    failures = [W::DatabaseError.new("deadlock detected", "40P01")]
    executor = FakeExecutor.new { failures.empty? ? [] : raise(failures.shift) }
    described_class.new(executor).sync_concurrency_policies("app", [])
    expect(executor.statements.length).to eq(2)

    deadlock = W::DatabaseError.new("deadlock detected", "40P01")
    aborted = [deadlock, W::DatabaseError.new("current transaction is aborted", "25P02")]
    caller_owned = described_class.new(FakeExecutor.new { raise(aborted.shift) })
    expect { caller_owned.sync_concurrency_policies("app", []) }.to raise_error(deadlock)

    always = described_class.new(FakeExecutor.new { raise W::DatabaseError.new("deadlock detected", "40P01") })
    expect { always.sync_concurrency_policies("app", []) }.to raise_error(W::DatabaseError, "deadlock detected")
  end

  it "sends a callback without a run time and retries a group once after a contract mismatch" do
    group = "0190a6f8-0000-7000-8000-0000000000aa"
    snapshot = {"group_id" => group, "state" => "sealed", "result" => nil, "total" => "1", "succeeded" => "0",
                "failed" => "0", "canceled" => "0", "pending" => "1", "created_at" => nil, "sealed_at" => nil,
                "finished_at" => nil, "canceled_at" => nil, "canceled_by" => nil, "cancel_reason" => nil,
                "callbacks" => '{"on_finish": {"taskId": null}}'}
    creates = 0
    executor = FakeExecutor.new do |sql, _params|
      case sql
      when W::SqlCatalogue::CREATE_TASK_GROUP_V1
        creates += 1
        if creates == 1
          [{"group_id" => nil, "ordinal" => "0", "task_id" => nil, "outcome" => "contract_mismatch",
            "reason" => '{"taskTypes":["report"]}'}]
        else
          [{"group_id" => group, "ordinal" => "1", "task_id" => task, "outcome" => "accepted", "reason" => nil}]
        end
      when W::SqlCatalogue::GET_TASK_GROUP_V1 then [snapshot]
      else []
      end
    end
    report = W::EnqueueRequest.new(task_type: "report", payload: {})

    result = described_class.new(executor).task_group(on_finish: report) { |builder| builder.enqueue("member", {}) }

    expect(creates).to eq(2)
    expect([result.group.id, result.group.state, result.tasks.map(&:task_id)]).to eq([group, :sealed, [task]])
    expect(result.group.callbacks).to eq([W::TaskGroupCallback.new(kind: :on_finish, task_id: nil)])
    sql, params = executor.statements.find { |statement, _| statement == W::SqlCatalogue::CREATE_TASK_GROUP_V1 }
    expect(sql).to eq(W::SqlCatalogue::CREATE_TASK_GROUP_V1)
    callbacks = JSON.parse(params[0])
    expect(callbacks.keys).to eq(["onFinish"])
    expect(callbacks["onFinish"]).not_to have_key("runAt")
    expect(JSON.parse(params[1]).first).to have_key("runAt")
    expect(params[2]).to eq("true")
  end

  it "refuses a group request before any statement" do
    executor = FakeExecutor.new
    queue = described_class.new(executor)

    expect { queue.add_to_task_group("not-a-uuid", []) }.to raise_error(ArgumentError, "task group ID must be a UUID String")
    expect { queue.list_task_group_members(task, limit: 1001) }.to raise_error(ArgumentError, /between 1 and 1000/)
    expect { queue.list_task_group_members(task, after: -1) }.to raise_error(ArgumentError, /non-negative/)
    expect { queue.task_group { |builder| builder.add([{}]) } }
      .to raise_error(ArgumentError, "requests must be an Array of EnqueueRequest")
    expect(executor.statements).to be_empty
  end
end
