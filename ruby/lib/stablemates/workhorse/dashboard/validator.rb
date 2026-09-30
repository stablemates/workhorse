# frozen_string_literal: true

module Stablemates
  module Workhorse
    class Dashboard
      # A dashboard request does not match its dashboard/v1 JSON Schema.
      class InputValidationError < ArgumentError; end

      # Checks a request against the dashboard/v1 JSON Schema subset the contract uses. Internal to
      # the SDK.
      module Validator
        SCHEMAS = JSON.parse(V1::INPUT_SCHEMAS).freeze
        PATTERNS = Hash.new { |cache, source| cache[source] = EcmaPattern.compile(source) }
        LOCK = Mutex.new
        private_constant :SCHEMAS, :PATTERNS, :LOCK

        module_function

        # Raises InputValidationError unless +value+ satisfies the request schema of +procedure+.
        def validate(procedure, value)
          raise InputValidationError, "unknown dashboard procedure #{procedure.inspect}" unless SCHEMAS.key?(procedure)

          schema = SCHEMAS[procedure]
          if schema.nil?
            raise InputValidationError, "#{procedure} does not accept input" unless value.nil?

            return
          end
          check(schema, schema, value, "$")
        end

        def check(schema, root, value, path)
          reference = schema["$ref"]
          return check(definition(root, reference, path), root, value, path) if reference.is_a?(String)

          branches = schema["anyOf"]
          return any_of(branches, root, value, path) if branches.is_a?(Array)

          fail!(path, "value must equal #{schema["const"].inspect}") if schema.key?("const") && value != schema["const"]
          allowed = schema["enum"]
          fail!(path, "value is not in the allowed set") if allowed.is_a?(Array) && !allowed.include?(value)

          case schema["type"]
          when "null" then fail!(path, "expected null") unless value.nil?
          when "boolean" then fail!(path, "expected boolean") unless value == true || value == false
          when "string" then string(schema, value, path)
          when "integer", "number" then number(schema, value, path)
          when "array" then array(schema, root, value, path)
          when "object" then object(schema, root, value, path)
          end
        end

        def definition(root, reference, path)
          definitions = root["$defs"]
          name = reference.delete_prefix("#/$defs/")
          unless definitions.is_a?(Hash) && definitions.key?(name)
            fail!(path, "unresolved schema reference #{reference}")
          end

          definitions[name]
        end

        def any_of(branches, root, value, path)
          matched = branches.any? do |branch|
            check(branch, root, value, path)
            true
          rescue InputValidationError
            false
          end
          fail!(path, "value does not match any allowed schema") unless matched
        end

        def string(schema, value, path)
          fail!(path, "expected string") unless value.is_a?(String)
          fail!(path, "string is too short") if schema["minLength"].is_a?(Integer) && value.length < schema["minLength"]
          fail!(path, "string is too long") if schema["maxLength"].is_a?(Integer) && value.length > schema["maxLength"]
          pattern = schema["pattern"]
          fail!(path, "string does not match #{pattern}") if pattern.is_a?(String) && !pattern(pattern).match?(value)
        end

        def number(schema, value, path)
          kind = schema["type"]
          fail!(path, "expected #{kind}") unless value.is_a?(Integer) || value.is_a?(Float)
          fail!(path, "expected integer") if kind == "integer" && !value.is_a?(Integer)
          fail!(path, "number is below minimum") if schema["minimum"].is_a?(Numeric) && value < schema["minimum"]
          fail!(path, "number is above maximum") if schema["maximum"].is_a?(Numeric) && value > schema["maximum"]
        end

        def array(schema, root, value, path)
          fail!(path, "expected array") unless value.is_a?(Array)
          fail!(path, "array has too few items") if schema["minItems"].is_a?(Integer) && value.length < schema["minItems"]
          fail!(path, "array has too many items") if schema["maxItems"].is_a?(Integer) && value.length > schema["maxItems"]
          items = schema["items"]
          return unless items.is_a?(Hash)

          value.each_with_index { |item, index| check(items, root, item, "#{path}[#{index}]") }
        end

        def object(schema, root, value, path)
          fail!(path, "expected object") unless value.is_a?(Hash) && value.keys.all?(String)
          properties = schema.fetch("properties", {})
          schema.fetch("required", []).each do |name|
            fail!("#{path}.#{name}", "required property is missing") unless value.key?(name)
          end
          additional = schema["additionalProperties"]
          value.each do |name, child|
            if properties[name].is_a?(Hash)
              check(properties[name], root, child, "#{path}.#{name}")
            elsif additional == false
              fail!("#{path}.#{name}", "additional property is not allowed")
            elsif additional.is_a?(Hash)
              check(additional, root, child, "#{path}.#{name}")
            end
          end
        end

        def pattern(source) = LOCK.synchronize { PATTERNS[source] }

        def fail!(path, message) = raise(InputValidationError, "#{path}: #{message}")
      end
      private_constant :Validator
    end
  end
end
