# frozen_string_literal: true

require_relative "unit_helper"

class ErrorsTest < UnitTest
  Result = Struct.new(:sqlstate, :detail) do
    def error_field(field)
      { PG::PG_DIAG_SQLSTATE => sqlstate, PG::PG_DIAG_MESSAGE_DETAIL => detail }[field]
    end
  end

  def pg_error(sqlstate, detail = nil)
    error = PG::Error.new("boom")
    result = Result.new(sqlstate, detail)
    error.define_singleton_method(:result) { result }
    error
  end

  def test_diagnosed_sqlstates_map_to_their_errors
    conflict = W::Executor.translate(pg_error("P1001", '{"existingTaskId":"x","conflictingFields":["payload"]}'))
    assert_instance_of W::EnqueueIdempotencyConflictError, conflict
    assert_equal({ "existingTaskId" => "x", "conflictingFields" => ["payload"] }, conflict.details)
    assert_instance_of W::DependencyCycleError, W::Executor.translate(pg_error("P1003", "{}"))
    assert_instance_of W::DependencyLimitExceededError, W::Executor.translate(pg_error("P1005", "not json"))

    fast = W::Executor.translate(pg_error("P1007", '{"queue":"q","feature":"dependencies","ordinal":2}'))
    assert_equal ["q", "dependencies", 2], [fast.queue, fast.feature, fast.ordinal]
  end

  def test_other_errors_become_database_errors_with_their_sqlstate
    error = W::Executor.translate(pg_error("23505"))
    assert_instance_of W::DatabaseError, error
    assert_equal "23505", error.sqlstate
    assert_nil W::Executor.translate(PG::Error.new("no result")).sqlstate
  end

  def test_every_error_descends_from_the_root
    errors = W.constants.map { |name| W.const_get(name) }.select { |value| value.is_a?(Class) && value < Exception }
    assert_operator errors.length, :>=, 21
    errors.each { |error| assert_operator error, :<=, W::Error }
  end

  def test_compatibility_codes
    max = W::SqlCatalogue::MAXIMUM_SCHEMA_VERSION
    protocol = W::SqlCatalogue::CLIENT_PROTOCOL_VERSION
    assert_equal :schema_not_installed, W::Compatibility.check(nil, protocol, [])
    assert_equal :schema_too_old, W::Compatibility.check(W::SqlCatalogue::MINIMUM_SCHEMA_VERSION - 1, protocol, [])
    assert_equal :client_protocol_too_old, W::Compatibility.check(max, protocol - 1, [])
    assert_equal :client_protocol_too_new, W::Compatibility.check(max, protocol + 1, [])
    assert_nil W::Compatibility.check(max, protocol, [protocol])
    assert_equal :schema_too_new, W::Compatibility.check(max, protocol, [protocol + 1])
    assert_equal :schema_too_old, W::Compatibility.check(max, protocol, [protocol - 1])
    assert_equal "workhorse compatibility check refused: schema-too-new",
                 W::CompatibilityError.new(:schema_too_new).message
  end
end
