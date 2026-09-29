# frozen_string_literal: true

require "minitest/autorun"
require "stablemates/workhorse"

# Answers each statement from a block, after reporting a compatible schema.
class FakeExecutor < Stablemates::Workhorse::Executor
  COMPATIBLE = [
    { "kind" => "schema", "version" => Stablemates::Workhorse::SqlCatalogue::MAXIMUM_SCHEMA_VERSION.to_s },
    { "kind" => "protocol", "version" => Stablemates::Workhorse::SqlCatalogue::CLIENT_PROTOCOL_VERSION.to_s }
  ].freeze

  attr_reader :statements

  def initialize(&answer)
    super(nil)
    @answer = answer
    @statements = []
  end

  def rows(sql, params = [])
    return COMPATIBLE if sql == Stablemates::Workhorse::SqlCatalogue::COMPATIBILITY_STATE

    @statements << [sql, params]
    @answer ? @answer.call(sql, params) : []
  end
end

class UnitTest < Minitest::Test
  W = Stablemates::Workhorse
  TASK = "0190a6f8-0000-7000-8000-000000000001"
end
