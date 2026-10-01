# frozen_string_literal: true

module Stablemates
  module Workhorse
    # One version of a task type's payload and result contract. A schema is a Draft 2020-12 JSON
    # Schema inside the Workhorse contract profile, and +true+ accepts anything. A byte limit of nil
    # or 0 uses the protocol default.
    TaskContractVersion = Data.define(
      :payload_schema, :result_schema, :max_payload_bytes, :max_result_bytes, :sensitive_payload_keys,
      :sensitive_result_keys
    ) do
      def initialize(payload_schema: true, result_schema: true, max_payload_bytes: nil, max_result_bytes: nil,
        sensitive_payload_keys: [], sensitive_result_keys: [])
        super
      end
    end

    # Every retained contract version of one task type, keyed by version, and the version new tasks
    # use.
    TaskTypeContracts = Data.define(:current_version, :versions)

    # A compiled contract schema. +new+ raises ArgumentError for a schema outside the Workhorse
    # contract profile. +format+ is an annotation, and only bundled local references resolve.
    class ContractSchema
      DIALECT = "https://json-schema.org/draft/2020-12/schema"
      SCHEMA_VALUES = %w[additionalProperties contains else if items not propertyNames then].freeze
      SCHEMA_ARRAYS = %w[allOf anyOf oneOf prefixItems].freeze
      SCHEMA_MAPS = %w[$defs dependentSchemas patternProperties properties].freeze
      PLAIN_KEYWORDS = %w[
        $anchor $comment $schema default deprecated description examples format readOnly title writeOnly
        const dependentRequired enum exclusiveMaximum exclusiveMinimum maxContains maximum maxItems
        maxLength maxProperties minContains minimum minItems minLength minProperties multipleOf pattern
        required type uniqueItems
      ].freeze
      MAX_DEPTH = 256
      TYPES = %w[array boolean integer null number object string].freeze
      NUMBERS = %w[exclusiveMaximum exclusiveMinimum maximum minimum].freeze
      COUNTS = %w[maxContains maxItems maxLength maxProperties minContains minItems minLength minProperties].freeze
      STRINGS = %w[$comment description format pattern title].freeze
      BOOLEANS = %w[deprecated readOnly uniqueItems writeOnly].freeze
      ANCHOR = /\A[A-Za-z_][-A-Za-z0-9._]*\z/
      private_constant :DIALECT, :SCHEMA_VALUES, :SCHEMA_ARRAYS, :SCHEMA_MAPS, :PLAIN_KEYWORDS, :MAX_DEPTH, :TYPES,
        :NUMBERS, :COUNTS, :STRINGS, :BOOLEANS, :ANCHOR

      # The profile violation in +schema+, or nil. Internal to the SDK.
      def self.profile_violation(schema, path = "$") # :nodoc:
        return nil if [true, false].include?(schema)
        return "#{path} must be an object or boolean JSON Schema" unless schema.is_a?(Hash)

        schema.each do |keyword, value|
          violation = keyword_violation(keyword, value, "#{path}.#{keyword}")
          return violation if violation
        end
        nil
      end

      def self.keyword_violation(keyword, value, path)
        if keyword == "$ref"
          "#{path} must be a bundled local reference" unless value.is_a?(String) && value.start_with?("#")
        elsif keyword == "$schema"
          "#{path} must select Draft 2020-12" unless value == DIALECT
        elsif SCHEMA_VALUES.include?(keyword)
          profile_violation(value, path)
        elsif SCHEMA_ARRAYS.include?(keyword)
          return "#{path} must be a non-empty array" unless value.is_a?(Array) && !value.empty?

          value.each_with_index.lazy.filter_map { |child, index| profile_violation(child, "#{path}[#{index}]") }.first
        elsif SCHEMA_MAPS.include?(keyword)
          return "#{path} must be an object" unless value.is_a?(Hash)

          value.lazy.filter_map do |name, child|
            (keyword == "patternProperties" && backreference_violation(name, "#{path}.#{name}")) ||
              profile_violation(child, "#{path}.#{name}")
          end.first
        elsif keyword == "pattern" && value.is_a?(String)
          backreference_violation(value, path)
        elsif PLAIN_KEYWORDS.include?(keyword)
          value_violation(keyword, value, path)
        else
          "#{path} is outside the Workhorse contract profile"
        end
      end
      private_class_method :keyword_violation

      def self.backreference_violation(source, path)
        "#{path} uses a backreference, which is outside the Workhorse contract profile" if EcmaPattern.backreference?(source)
      end
      private_class_method :backreference_violation

      # The Draft 2020-12 meta-schema's rule for the value of +keyword+, as a violation or nil.
      def self.value_violation(keyword, value, path)
        case keyword
        when "type"
          "#{path} must name a JSON type or a non-empty array of unique JSON types" unless type_names?(value)
        when "enum", "examples" then "#{path} must be an array" unless value.is_a?(Array)
        when "multipleOf" then "#{path} must be a number greater than 0" unless number?(value) && value.positive?
        when *NUMBERS then "#{path} must be a number" unless number?(value)
        when *COUNTS then "#{path} must be a non-negative integer" unless count?(value)
        when *STRINGS then "#{path} must be a string" unless value.is_a?(String)
        when *BOOLEANS then "#{path} must be a boolean" unless [true, false].include?(value)
        when "required" then "#{path} must be an array of unique strings" unless names?(value)
        when "dependentRequired"
          unless value.is_a?(Hash) && value.each_value.all? { |names| names?(names) }
            "#{path} must map each property to an array of unique strings"
          end
        when "$anchor" then "#{path} must be a plain-name anchor" unless value.is_a?(String) && value.match?(ANCHOR)
        end
      end
      private_class_method :value_violation

      def self.type_names?(value)
        return TYPES.include?(value) if value.is_a?(String)

        value.is_a?(Array) && !value.empty? && value.all? { |type| TYPES.include?(type) } && value.uniq.size == value.size
      end
      private_class_method :type_names?

      def self.names?(value)
        value.is_a?(Array) && value.all?(String) && value.uniq.size == value.size
      end
      private_class_method :names?

      def self.number?(value) = value.is_a?(Integer) || (value.is_a?(Float) && value.finite?)
      private_class_method :number?

      # A non-negative integer, which JSON may write as 3.0.
      def self.count?(value) = number?(value) && value >= 0 && (value % 1).zero?
      private_class_method :count?

      attr_reader :schema

      def initialize(schema)
        Values.check_json(schema, "contract schema")
        violation = ContractSchema.profile_violation(schema)
        raise ArgumentError, violation if violation

        @schema = schema
        @anchors = {}
        @patterns = {}
        prepare(schema)
      end

      def valid?(instance) = valid_at?(@schema, instance, 0)

      private

      # Collects every anchor, then compiles every pattern and checks every reference, so +valid?+
      # cannot fail on the schema and a reference may name an anchor that comes later.
      def prepare(schema)
        collect_anchors(schema)
        compile(schema)
      end

      def collect_anchors(schema)
        return unless schema.is_a?(Hash)

        if schema.key?("$anchor")
          anchor = schema["$anchor"]
          raise ArgumentError, "invalid contract schema: anchor #{anchor} is duplicated" if @anchors.key?(anchor)

          @anchors[anchor] = schema
        end
        each_subschema(schema) { |child| collect_anchors(child) }
      end

      def compile(schema)
        return unless schema.is_a?(Hash)

        pattern(schema["pattern"]) if schema.key?("pattern")
        schema.fetch("patternProperties", {}).each_key { |source| pattern(source) }
        each_subschema(schema) { |child| compile(child) }
        return unless schema.key?("$ref")

        target = resolve(schema["$ref"])
        violation = ContractSchema.profile_violation(target, schema["$ref"])
        raise ArgumentError, "invalid contract schema: #{violation}" if violation
      end

      def each_subschema(schema, &)
        schema.each do |keyword, value|
          if SCHEMA_VALUES.include?(keyword) then yield value
          elsif SCHEMA_ARRAYS.include?(keyword) then value.each(&)
          elsif SCHEMA_MAPS.include?(keyword) then value.each_value(&)
          end
        end
      end

      def pattern(source)
        @patterns[source] ||= EcmaPattern.compile(source)
      rescue ArgumentError => e
        raise ArgumentError, "invalid contract schema: pattern #{source.inspect} does not compile: #{e.message}"
      end

      def resolve(reference)
        fragment = reference.delete_prefix("#")
        return @schema if fragment.empty?

        target = if fragment.start_with?("/")
          pointer(fragment)
        else
          @anchors[fragment]
        end
        raise ArgumentError, "invalid contract schema: #{reference} does not resolve" if target.nil?

        target
      end

      def pointer(fragment)
        fragment.split("/", -1).drop(1).reduce(@schema) do |node, token|
          token = URI.decode_uri_component(token).gsub("~1", "/").gsub("~0", "~")
          case node
          when Hash then node.fetch(token) { return nil }
          when Array then token.match?(/\A(0|[1-9]\d*)\z/) ? node[Integer(token, 10)] : (return nil)
          else return nil
          end
        end
      end

      def valid_at?(schema, instance, depth)
        return schema if [true, false].include?(schema)
        raise ArgumentError, "contract schema references recurse too deeply" if depth > MAX_DEPTH

        schema.all? { |keyword, value| keyword_valid?(schema, keyword, value, instance, depth) }
      end

      def keyword_valid?(schema, keyword, value, instance, depth)
        case keyword
        when "$ref" then valid_at?(resolve(value), instance, depth + 1)
        when "type" then Array(value).any? { |type| type?(instance, type) }
        when "enum" then value.any? { |candidate| equal?(candidate, instance) }
        when "const" then equal?(value, instance)
        when "allOf" then value.all? { |child| valid_at?(child, instance, depth + 1) }
        when "anyOf" then value.any? { |child| valid_at?(child, instance, depth + 1) }
        when "oneOf" then value.one? { |child| valid_at?(child, instance, depth + 1) }
        when "not" then !valid_at?(value, instance, depth + 1)
        when "if" then conditional_valid?(schema, value, instance, depth)
        else
          if number?(instance) then number_valid?(keyword, value, instance)
          elsif instance.is_a?(String) then string_valid?(keyword, value, instance)
          elsif instance.is_a?(Array) then array_valid?(schema, keyword, value, instance, depth)
          elsif instance.is_a?(Hash) then object_valid?(schema, keyword, value, instance, depth)
          else true
          end
        end
      end

      def conditional_valid?(schema, condition, instance, depth)
        branch = valid_at?(condition, instance, depth + 1) ? "then" : "else"
        !schema.key?(branch) || valid_at?(schema[branch], instance, depth + 1)
      end

      def number_valid?(keyword, value, instance)
        case keyword
        when "minimum" then instance >= value
        when "maximum" then instance <= value
        when "exclusiveMinimum" then instance > value
        when "exclusiveMaximum" then instance < value
        when "multipleOf" then (Rational(instance.to_s) / Rational(value.to_s)).denominator == 1
        else true
        end
      end

      def string_valid?(keyword, value, instance)
        case keyword
        when "minLength" then instance.length >= value
        when "maxLength" then instance.length <= value
        when "pattern" then pattern(value).match?(instance)
        else true
        end
      end

      def array_valid?(schema, keyword, value, instance, depth)
        case keyword
        when "minItems" then instance.length >= value
        when "maxItems" then instance.length <= value
        when "uniqueItems" then !value || unique?(instance)
        when "prefixItems"
          value.zip(instance).take(instance.length).all? { |child, item| valid_at?(child, item, depth + 1) }
        when "items"
          instance.drop(schema.fetch("prefixItems", []).length).all? { |item| valid_at?(value, item, depth + 1) }
        when "contains" then contains_valid?(schema, value, instance, depth)
        else true
        end
      end

      def contains_valid?(schema, value, instance, depth)
        matches = instance.count { |item| valid_at?(value, item, depth + 1) }
        matches >= schema.fetch("minContains", 1) && (!schema.key?("maxContains") || matches <= schema["maxContains"])
      end

      def object_valid?(schema, keyword, value, instance, depth)
        case keyword
        when "minProperties" then instance.length >= value
        when "maxProperties" then instance.length <= value
        when "required" then value.all? { |name| instance.key?(name) }
        when "dependentRequired"
          value.all? { |name, names| !instance.key?(name) || names.all? { |other| instance.key?(other) } }
        when "dependentSchemas"
          value.all? { |name, child| !instance.key?(name) || valid_at?(child, instance, depth + 1) }
        when "propertyNames" then instance.each_key.all? { |name| valid_at?(value, name, depth + 1) }
        when "properties"
          value.all? { |name, child| !instance.key?(name) || valid_at?(child, instance[name], depth + 1) }
        when "patternProperties"
          value.all? do |source, child|
            instance.all? { |name, item| !pattern(source).match?(name) || valid_at?(child, item, depth + 1) }
          end
        when "additionalProperties" then additional_valid?(schema, value, instance, depth)
        else true
        end
      end

      def additional_valid?(schema, value, instance, depth)
        named = schema.fetch("properties", {})
        patterns = schema.fetch("patternProperties", {}).keys.map { |source| pattern(source) }
        instance.all? do |name, item|
          named.key?(name) || patterns.any? { |regexp| regexp.match?(name) } || valid_at?(value, item, depth + 1)
        end
      end

      def type?(instance, type)
        case type
        when "null" then instance.nil?
        when "boolean" then [true, false].include?(instance)
        when "string" then instance.is_a?(String)
        when "array" then instance.is_a?(Array)
        when "object" then instance.is_a?(Hash)
        when "number" then number?(instance)
        when "integer"
          instance.is_a?(Integer) || (instance.is_a?(Float) && instance.finite? && (instance % 1).zero?)
        else false
        end
      end

      def number?(instance) = instance.is_a?(Integer) || instance.is_a?(Float)

      # JSON equality: 1 equals 1.0, and true equals neither 1 nor 1.0.
      def equal?(left, right)
        case left
        when Hash then right.is_a?(Hash) && left.size == right.size && left.all? do |k, v|
          right.key?(k) && equal?(v, right[k])
        end
        when Array then right.is_a?(Array) && left.size == right.size && left.zip(right).all? { |l, r| equal?(l, r) }
        when true, false, nil then left.equal?(right)
        when Integer, Float then number?(right) && left == right
        else left == right
        end
      end

      def unique?(items)
        items.each_with_index.none? { |item, index| items.drop(index + 1).any? { |other| equal?(item, other) } }
      end
    end

    # The current contract PostgreSQL holds for one task type. Internal to the SDK.
    PayloadContract = Data.define(
      :version, :schema, :payload_max_bytes, :result_max_bytes, :payload_redact_keys, :result_redact_keys
    )
    private_constant :PayloadContract

    # Loads and renders contracts. Internal to the SDK.
    module Contracts # :nodoc:
      module_function

      # The current contract PostgreSQL holds for +task_type+, or its +version+ when given, or nil
      # when there is none.
      def load(executor, task_type, version = nil)
        rows = executor.rows(SqlCatalogue::GET_CONTRACT_DEFINITION_V1, [task_type, version])
        return nil if rows.empty?
        raise invalid_definition unless rows.one?

        decode(rows.first)
      end

      def decode(row)
        schema = Values.parse_json(row.fetch("schema"))
        raise invalid_definition unless schema.is_a?(Hash) && schema.key?("payload")

        PayloadContract.new(
          version: row.fetch("version"),
          schema: ContractSchema.new(schema["payload"]),
          payload_max_bytes: Values.parse_integer(row.fetch("payload_max_bytes")),
          result_max_bytes: Values.parse_integer(row.fetch("result_max_bytes")),
          payload_redact_keys: Values.parse_text_array(row.fetch("payload_redact_keys")),
          result_redact_keys: Values.parse_text_array(row.fetch("result_redact_keys"))
        )
      rescue KeyError, ArgumentError, JSON::ParserError
        raise invalid_definition
      end

      def invalid_definition = Error.new("invalid contract definition returned by PostgreSQL")

      # Compiles every schema, then renders the +sync_contract_definitions_v1+ document.
      def document(contracts)
        raise ArgumentError, "contracts must be a Hash of task type to TaskTypeContracts" unless contracts.is_a?(Hash)

        contracts.map do |task_type, type_contracts|
          unless task_type.is_a?(String) && type_contracts.is_a?(TaskTypeContracts)
            raise ArgumentError, "contracts must be a Hash of task type to TaskTypeContracts"
          end

          {
            "taskType" => task_type,
            "currentVersion" => type_contracts.current_version,
            "versions" => type_contracts.versions.to_h { |version, contract| [version, version_document(contract)] }
          }
        end
      end

      def version_document(contract)
        ContractSchema.new(contract.payload_schema)
        ContractSchema.new(contract.result_schema)
        {
          "payloadSchema" => contract.payload_schema,
          "resultSchema" => contract.result_schema,
          "maxPayloadBytes" => limit(contract.max_payload_bytes),
          "maxResultBytes" => limit(contract.max_result_bytes),
          "sensitivePayloadKeys" => contract.sensitive_payload_keys,
          "sensitiveResultKeys" => contract.sensitive_result_keys
        }
      end

      def limit(value) = (value.nil? || value.zero?) ? SqlCatalogue::DEFAULT_TASK_VALUE_MAX_BYTES : value
    end
  end
end
