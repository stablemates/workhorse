# frozen_string_literal: true

require_relative "unit_helper"

class QueueTest < UnitTest
  def refusal(**options)
    executor = FakeExecutor.new
    error = assert_raises(ArgumentError) { W::Queue.new(executor).enqueue("t", {}, **options) }
    assert_empty executor.statements, "an invalid request runs no statement"
    error.message
  end

  def test_invalid_options_raise_argument_error_before_any_statement
    prefix = "enqueue request 1: invalid enqueue options: "
    assert_equal "#{prefix}priority must be between 0 and 100", refusal(priority: -1)
    assert_equal "#{prefix}cannot combine idempotency, debounce, or throttle",
                 refusal(idempotency: W::Idempotency.new(key: "k"), throttle: W::Throttle.new(key: "k", window: 1))
    assert_equal "#{prefix}debounced enqueue uses its PostgreSQL-owned window instead of run at",
                 refusal(debounce: W::Debounce.new(key: "k", window: 1), run_at: Time.now)
    assert_equal "#{prefix}dependencies must contain unique prerequisite task IDs",
                 refusal(dependencies: W::Dependencies.new(prerequisite_task_ids: [TASK, TASK.upcase],
                                                           on_success: :release, on_failure: :cancel,
                                                           on_cancellation: :cancel))
  end

  def test_payload_must_be_json
    assert_match(/payload contains Symbol, which is not a JSON value/, refusal_for_payload({ "a" => :b }))
    assert_match(/payload object keys must be Strings/, refusal_for_payload({ a: 1 }))
    assert_match(/non-finite number/, refusal_for_payload([Float::NAN]))
  end

  def refusal_for_payload(payload)
    assert_raises(ArgumentError) { W::Queue.new(FakeExecutor.new).enqueue("t", payload) }.message
  end

  def test_task_ids_must_be_uuids
    error = assert_raises(ArgumentError) { W::Queue.new(FakeExecutor.new).cancel("42", requested_by: nil) }
    assert_equal "task ID must be a UUID String", error.message
  end

  def test_unknown_statuses_raise_unexpected_status_error
    cancel = W::Queue.new(FakeExecutor.new { [{ "status" => "vaporized", "state" => nil }] })
    error = assert_raises(W::UnexpectedStatusError) { cancel.cancel(TASK, requested_by: "ops") }
    assert_equal [:cancel, "vaporized"], [error.operation, error.status]

    signal = W::Queue.new(FakeExecutor.new { [{ "status" => "teleported" }] })
    error = assert_raises(W::UnexpectedStatusError) do
      signal.send_signal(TASK, "go", {}, idempotency_key: "k", requested_by: "ops")
    end
    assert_equal [:send_signal, "teleported"], [error.operation, error.status]

    human = W::Queue.new(FakeExecutor.new { [{ "status" => "shrugged" }] })
    assert_raises(W::UnexpectedStatusError) do
      human.complete_human_wait(TASK, "review", {}, idempotency_key: "k", requested_by: "ann")
    end
  end

  def test_unknown_enqueue_outcomes_are_refused
    queue = W::Queue.new(FakeExecutor.new do
      [{ "ordinal" => "1", "task_id" => TASK, "outcome" => "levitated", "reason" => nil }]
    end)
    error = assert_raises(W::UnexpectedStatusError) { queue.enqueue("t", {}) }
    assert_equal [:enqueue, "levitated"], [error.operation, error.status]
  end

  def test_incompatible_schema_is_refused_before_the_statement
    executor = Class.new(FakeExecutor) do
      def rows(sql, params = [])
        return [{ "kind" => "schema", "version" => "1" }] if sql == W::SqlCatalogue::COMPATIBILITY_STATE

        super
      end
    end.new
    error = assert_raises(W::CompatibilityError) { W::Queue.new(executor).enqueue("t", {}) }
    assert_equal :schema_too_old, error.code
    assert_empty executor.statements
  end

  def test_executor_must_respond_to_with
    assert_raises(ArgumentError) { W::Queue.new(Object.new) }
  end
end
