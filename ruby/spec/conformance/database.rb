# frozen_string_literal: true

require "json"
require "pg"
require_relative "matcher"

module Conformance
  # The translation between fixture JSON and PostgreSQL values, keyed by type OID.
  module Database
    BOOL = 16
    INT8 = 20
    INT2 = 21
    INT4 = 23
    TEXT = 25
    JSON_TYPE = 114
    FLOAT4 = 700
    FLOAT8 = 701
    NAME = 19
    BPCHAR = 1042
    VARCHAR = 1043
    TIME = 1083
    TIMESTAMP = 1114
    TIMESTAMPTZ = 1184
    NUMERIC = 1700
    VOID = 2278
    UUID = 2950
    UNKNOWN = 705
    JSONB = 3802
    INT4_ARRAY = 1007
    TEXT_ARRAY = 1009
    INT8_ARRAY = 1016
    UUID_ARRAY = 2951
    JSONB_ARRAY = 3807
    TEXTUAL = [TEXT, VARCHAR, NAME, BPCHAR, UNKNOWN].freeze
    INTEGER_RANGES = {
      INT2 => -(2**15)...(2**15), INT4 => -(2**31)...(2**31), INT8 => -(2**63)...(2**63)
    }.freeze
    ARRAY_ELEMENTS = {
      TEXT_ARRAY => TEXT, INT4_ARRAY => INT4, INT8_ARRAY => INT8, UUID_ARRAY => UUID, JSONB_ARRAY => JSONB
    }.freeze
    TEXT_ARRAY_ENCODER = PG::TextEncoder::Array.new
    ARRAY_DECODER = PG::TextDecoder::Array.new
    TIMESTAMPTZ_DECODER = PG::TextDecoder::TimestampWithTimeZone.new
    TIMESTAMP_DECODER = PG::TextDecoder::TimestampUtc.new

    module_function

    # Render a driver error with the database's own message when PostgreSQL produced it.
    def describe(error)
      result = error.respond_to?(:result) ? error.result : nil
      code = result&.error_field(PG::PG_DIAG_SQLSTATE)
      return error.message.strip unless code

      "#{result.error_field(PG::PG_DIAG_MESSAGE_PRIMARY)} (#{code})"
    end

    # The error shape the fixtures compare: SQLSTATE, primary message, and JSON detail when present.
    def database_error(error)
      result = error.respond_to?(:result) ? error.result : nil
      code = result&.error_field(PG::PG_DIAG_SQLSTATE)
      raise Failure, "expected a database error, received #{describe(error)}" unless code

      actual = {"code" => code, "message" => result.error_field(PG::PG_DIAG_MESSAGE_PRIMARY)}
      detail = result.error_field(PG::PG_DIAG_MESSAGE_DETAIL)
      if detail
        actual["detail"] = begin
          JSON.parse(detail)
        rescue JSON::ParserError => e
          raise Failure, "error detail is not JSON (#{e.message}): #{detail}"
        end
      end
      actual
    end

    # Bind resolved fixture parameters to the types PostgreSQL inferred for a prepared statement.
    def parameters(description, values)
      unless description.nparams == values.length
        raise Failure, "statement takes #{description.nparams} parameters, fixture gives #{values.length}"
      end

      values.each_with_index.map { |value, index| parameter(value, description.paramtype(index)) }
    end

    # The text form of one parameter.
    def parameter(value, oid)
      mismatch = -> { Failure.new("cannot bind #{Matcher.render(value)} as type #{oid}") }
      case oid
      when JSON_TYPE, JSONB then json_text(value, mismatch)
      else
        return nil if value.nil?

        case oid
        when BOOL
          raise mismatch.call unless [true, false].include?(value)

          value ? "t" : "f"
        when INT2, INT4, INT8
          raise mismatch.call unless value.is_a?(Integer) && INTEGER_RANGES.fetch(oid).cover?(value)

          value.to_s
        when FLOAT8
          raise mismatch.call unless value.is_a?(Numeric)

          Float(value).to_s
        when *TEXTUAL, UUID, TIMESTAMPTZ, TIME
          raise mismatch.call unless value.is_a?(String)

          value
        when TEXT_ARRAY
          raise mismatch.call unless value.is_a?(Array) && value.all?(String)

          TEXT_ARRAY_ENCODER.encode(value)
        else raise Failure, "the Ruby runner cannot bind parameters of type #{oid}"
        end
      end
    end

    # A string bound to JSON is JSON text, as psycopg and pgx send it.
    def json_text(value, mismatch)
      case value
      when nil then nil
      when String
        begin
          JSON.parse(value)
        rescue JSON::ParserError
          raise mismatch.call
        end
        value
      else JSON.generate(value)
      end
    end

    # Decode every row into the normalized JSON the fixtures compare.
    def rows(result)
      oids = Array.new(result.nfields) { |index| result.ftype(index) }
      names = result.fields
      result.values.map do |row|
        names.each_with_index.to_h { |name, index| [name, cell(row[index], oids[index])] }
      end
    end

    def cell(text, oid)
      # The fixtures record a void result as an empty string, which is how psycopg reads one.
      return "" if oid == VOID
      return nil if text.nil?

      case oid
      when BOOL then text == "t"
      when INT2, INT4, INT8 then Integer(text, 10)
      when FLOAT4, FLOAT8 then float(text)
      when NUMERIC then numeric(text)
      when TEXT, VARCHAR, NAME, BPCHAR then text
      when UUID then text.downcase
      when TIMESTAMPTZ then Matcher.normalize_timestamp(TIMESTAMPTZ_DECODER.decode(text))
      when TIMESTAMP then Matcher.normalize_timestamp(TIMESTAMP_DECODER.decode(text)).delete_suffix("Z")
      when JSON_TYPE, JSONB then JSON.parse(text)
      when *ARRAY_ELEMENTS.keys
        element = ARRAY_ELEMENTS.fetch(oid)
        ARRAY_DECODER.decode(text).map { |item| cell(item, element) }
      else raise Failure, "the Ruby runner cannot decode column type #{oid}"
      end
    end

    # A non-finite float has no JSON form, so it decodes as null the way serde_json renders one.
    def float(text)
      value = Float(text, exception: false)
      value&.finite? ? value : nil
    end

    # PostgreSQL `numeric`, normalized like the other lanes: integral values become integers.
    def numeric(text)
      raise Failure, "NaN numeric has no JSON form" if text == "NaN"

      whole, fraction = text.split(".", 2)
      (fraction.nil? || fraction.match?(/\A0*\z/)) ? Integer(whole, 10) : Float(text)
    end
  end
end
