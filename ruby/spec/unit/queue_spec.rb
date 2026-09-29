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
    expect(refusal(priority: -1)).to eq("#{prefix}priority must be between 0 and 100")
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

  it "refuses an unknown enqueue outcome" do
    queue = described_class.new(FakeExecutor.new do
      [{"ordinal" => "1", "task_id" => task, "outcome" => "levitated", "reason" => nil}]
    end)
    expect { queue.enqueue("t", {}) }.to raise_error(W::UnexpectedStatusError) { |error|
      expect([error.operation, error.status]).to eq([:enqueue, "levitated"])
    }
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
end
