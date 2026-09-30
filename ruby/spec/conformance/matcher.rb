# frozen_string_literal: true

require "date"
require "json"

module Conformance
  # A fixture that disagrees with the Ruby adapter. The message names the first mismatch.
  class Failure < StandardError; end

  # The shared fixture value language, ported from the other conformance lanes.
  #
  # A fixture writes expected values as JSON. `{"$ref" => name}` compares with a value an earlier
  # step captured, and `{"$type" => kind}` accepts any value of that kind. Every other value must
  # match exactly, and an object must have the same keys.
  module Matcher
    TIMESTAMP = /\A(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})\z/
    UUID = /\A\h{8}-\h{4}-\h{4}-\h{4}-\h{12}\z/

    module_function

    # Replace every `{"$ref" => name}` parameter with the captured value.
    def resolve(value, references)
      case value
      when Array then value.map { |item| resolve(item, references) }
      when Hash
        if value.keys == ["$ref"]
          name = value["$ref"]
          raise Failure, "unknown reference #{name}" unless references.key?(name)

          return references[name]
        end
        value.transform_values { |item| resolve(item, references) }
      else value
      end
    end

    # Match +actual+ against the expected fixture value, naming the first mismatch.
    def assert_value(expected, actual, references, location)
      case expected
      when Hash
        if expected.key?("$ref")
          assert_reference(expected["$ref"], actual, references, location)
        elsif expected.key?("$type")
          assert_matcher(expected["$type"], actual, location)
        else
          assert_object(expected, actual, references, location)
        end
      when Array then assert_array(expected, actual, references, location)
      else
        return if same?(expected, actual)

        raise Failure, "#{location} expected #{render(expected)}, received #{render(actual)}"
      end
    end

    # Accept +actual+ when it is a value of the named fixture type.
    def assert_matcher(kind, actual, location)
      accepted = case kind
      when "any" then true
      when "uuid" then actual.is_a?(String) && uuid?(actual)
      when "timestamp" then actual.is_a?(String) && timestamp?(actual)
      when "string" then actual.is_a?(String)
      when "integer" then actual.is_a?(Integer)
      when "number" then actual.is_a?(Numeric) && actual.finite?
      when "boolean" then [true, false].include?(actual)
      else raise Failure, "#{location} names unknown matcher type #{kind}"
      end
      raise Failure, "#{location} expected #{kind}, received #{render(actual)}" unless accepted
    end

    # Follow a dotted capture path, reading list segments as indexes.
    def read_pointer(value, pointer)
      pointer.split(".").reduce(value) do |current, segment|
        found = case current
        when Array
          index = Integer(segment, 10, exception: false)
          [current[index]] if index&.between?(0, current.length - 1)
        when Hash then [current[segment]] if current.key?(segment)
        end
        raise Failure, "capture pointer #{pointer} does not resolve at #{segment}" unless found

        found.first
      end
    end

    # Render an instant the way every lane normalizes one: UTC, trailing fractional zeros removed.
    def normalize_timestamp(time)
      time = time.utc
      fraction = format("%09d", time.nsec).sub(/0+\z/, "")
      "#{time.strftime("%Y-%m-%dT%H:%M:%S")}#{".#{fraction}" unless fraction.empty?}Z"
    end

    def uuid?(value) = value.match?(UUID)

    # Accept an RFC 3339 instant with an explicit offset and at most nine fractional digits.
    def timestamp?(value)
      match = TIMESTAMP.match(value)
      return false unless match

      year, month, day, hour, minute, second = match.captures.first(6).map { |part| Integer(part, 10) }
      Date.valid_date?(year, month, day) && hour < 24 && minute < 60 && second < 60 &&
        valid_offset?(match[8])
    end

    def valid_offset?(offset)
      return true if offset == "Z"

      Integer(offset[1, 2], 10) < 24 && Integer(offset[4, 2], 10) < 60
    end

    # Compare two JSON values, treating numbers by value so `1` and `1.0` agree as they do elsewhere.
    def same?(left, right)
      case left
      when Numeric then right.is_a?(Numeric) && left == right
      when Array
        right.is_a?(Array) && left.length == right.length &&
          left.zip(right).all? { |item, other| same?(item, other) }
      when Hash
        right.is_a?(Hash) && left.keys.sort == right.keys.sort &&
          left.all? { |key, item| same?(item, right[key]) }
      else left == right
      end
    end

    def render(value)
      JSON.generate(value)
    rescue JSON::GeneratorError
      value.inspect
    end

    def assert_reference(name, actual, references, location)
      raise Failure, "#{location} names unknown reference #{name}" unless references.key?(name)

      captured = references[name]
      return if same?(captured, actual)

      raise Failure, "#{location} expected reference #{name} = #{render(captured)}, received #{render(actual)}"
    end

    def assert_object(expected, actual, references, location)
      raise Failure, "#{location} expected an object, received #{render(actual)}" unless actual.is_a?(Hash)

      expected_keys = expected.keys.sort
      actual_keys = actual.keys.sort
      unless expected_keys == actual_keys
        raise Failure, "#{location} expected keys #{expected_keys}, received #{actual_keys}"
      end

      expected.each { |key, value| assert_value(value, actual[key], references, "#{location}.#{key}") }
    end

    def assert_array(expected, actual, references, location)
      raise Failure, "#{location} expected an array, received #{render(actual)}" unless actual.is_a?(Array)

      unless expected.length == actual.length
        raise Failure, "#{location} expected #{expected.length} items, received #{actual.length}: #{render(actual)}"
      end

      expected.zip(actual).each_with_index do |(item, actual_item), index|
        assert_value(item, actual_item, references, "#{location}[#{index}]")
      end
    end
  end
end
