# frozen_string_literal: true

module Stablemates
  module Workhorse
    # Returns the input fingerprint that a checkpoint stores for one input: the SHA-256 digest of the
    # canonical JSON form of the input (RFC 8785), as 64 lowercase hexadecimal characters (ADR 0098).
    #
    # The canonical form sorts the keys of each object by their UTF-16 code units, writes no
    # whitespace, and writes each number in the ECMAScript form of its IEEE 754 double. Thus two
    # inputs that differ only in key order have the same fingerprint, and every SDK gives the same
    # digest for the same input. +input+ must be JSON: a Hash with String keys, an Array, a String, an
    # Integer of at most 2**53 - 1 in magnitude, a finite Float, true, false, or nil. Each String must
    # be valid UTF-8. Another value raises ArgumentError.
    def self.checkpoint_input_fingerprint(input)
      Digest::SHA256.hexdigest(CheckpointFingerprint.canonical(input))
    end

    # The RFC 8785 canonical JSON of a checkpoint input. Internal to the SDK.
    module CheckpointFingerprint # :nodoc:
      # I-JSON (RFC 7493) keeps integers to the range that an IEEE 754 double holds exactly.
      MAX_SAFE_INTEGER = (2**53) - 1
      ESCAPES = {"\"" => "\\\"", "\\" => "\\\\", "\b" => "\\b", "\t" => "\\t", "\n" => "\\n", "\f" => "\\f",
                 "\r" => "\\r"}.freeze
      private_constant :MAX_SAFE_INTEGER, :ESCAPES

      module_function

      def canonical(value)
        case value
        when nil then "null"
        when true then "true"
        when false then "false"
        when String then string(value)
        when Integer then integer(value)
        when Float then number(value)
        when Array then "[#{value.map { |item| canonical(item) }.join(",")}]"
        when Hash then object(value)
        else raise ArgumentError, "checkpoint input contains #{value.class}, which is not a JSON value"
        end
      end

      def object(value)
        members = value.map do |key, item|
          raise ArgumentError, "checkpoint input object keys must be Strings" unless key.is_a?(String)

          [utf16(key), "#{string(key)}:#{canonical(item)}"]
        end
        # Big-endian UTF-16 bytes compare in the order of their code units, which RFC 8785 requires.
        "{#{members.sort_by(&:first).map(&:last).join(",")}}"
      end

      def integer(value)
        raise ArgumentError, "checkpoint input integers must be at most 2**53 - 1 in magnitude" if
          value.abs > MAX_SAFE_INTEGER

        value.to_s
      end

      # The ECMAScript Number::toString form of a double. Float#to_s gives the shortest digits that
      # read back as the same double, as ECMAScript requires. Only the notation differs.
      def number(value)
        raise ArgumentError, "checkpoint input contains a non-finite number" unless value.finite?
        return "0" if value.zero?

        whole, fraction, exponent = value.abs.to_s.match(/\A(\d+)\.(\d+)(?:e([+-]\d+))?\z/).captures
        digits = whole + fraction
        # The value is 0.digits * 10**point.
        point = whole.length + exponent.to_i
        stripped = digits.sub(/\A0+/, "")
        point -= digits.length - stripped.length
        digits = stripped.sub(/0+\z/, "")
        (value.negative? ? "-" : "") + notation(digits, point)
      end

      def notation(digits, point)
        count = digits.length
        if point.between?(count, 21)
          digits + ("0" * (point - count))
        elsif point.positive? && point <= 21
          "#{digits[0, point]}.#{digits[point..]}"
        elsif point > -6 && point <= 0
          "0.#{"0" * -point}#{digits}"
        else
          exponent = point - 1
          mantissa = (count == 1) ? digits : "#{digits[0]}.#{digits[1..]}"
          "#{mantissa}e#{exponent.negative? ? "-" : "+"}#{exponent.abs}"
        end
      end

      # RFC 8785 escapes only the quote, the backslash, and the control characters. A control
      # character without a short escape uses six characters with lowercase hexadecimal digits.
      def string(value)
        text = utf8(value)
        escaped = text.gsub(/["\\\u0000-\u001f]/) { |char| ESCAPES.fetch(char) { format("\\u%04x", char.ord) } }
        "\"#{escaped}\""
      end

      def utf16(value) = utf8(value).encode(Encoding::UTF_16BE).b

      def utf8(value)
        text = (value.encoding == Encoding::UTF_8) ? value : value.encode(Encoding::UTF_8)
        raise ArgumentError, "checkpoint input strings must be valid UTF-8" unless text.valid_encoding?

        text
      rescue EncodingError
        raise ArgumentError, "checkpoint input strings must be valid UTF-8"
      end
    end
  end
end
