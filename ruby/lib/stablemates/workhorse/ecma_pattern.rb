# frozen_string_literal: true

module Stablemates
  module Workhorse
    # Compiles an ECMA-262 regular expression, as JSON Schema's +pattern+ requires, into a Ruby
    # Regexp with the same matches. The source follows the +u+ flag's grammar, as other Workhorse
    # validators compile it, and +compile+ raises ArgumentError for anything outside that grammar.
    #
    # Onigmo differs from ECMA-262 where this translation intervenes. +^+ and +$+ match at line
    # ends, +.+ excludes only a newline, +\s+ and +\b+ follow Unicode, and a plain group stops
    # capturing beside a named one. Internal to the SDK.
    class EcmaPattern
      SPACE = '\t\n\u000b\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff'
      WORD = "[A-Za-z0-9_]"
      DOT = '[^\n\r\u2028\u2029]'
      WORD_BOUNDARY = "(?:(?<=#{WORD})(?!#{WORD})|(?<!#{WORD})(?=#{WORD}))"
      NOT_WORD_BOUNDARY = "(?:(?<=#{WORD})(?=#{WORD})|(?<!#{WORD})(?!#{WORD}))"
      SYNTAX = "^$\\.*+?()[]{}|/"
      CONTROLS = {"f" => '\f', "n" => '\n', "r" => '\r', "t" => '\t', "v" => '\u000b'}.freeze
      GROUP_NAME = /\A\?<([\p{ID_Start}$_][\p{ID_Continue}$\u200c\u200d]*)>/
      # ECMA-262 names a property in case-sensitive words, where Onigmo matches any spelling and
      # knows names ECMA-262 lacks. This checks the shape, not the Unicode tables.
      PROPERTY = /\A\{(?:(?:General_Category|gc|Script|sc)=)?([A-Z][A-Za-z0-9]*(?:_[A-Z][A-Za-z0-9]*)*)\}/
      ONIGMO_PROPERTIES = %w[Alnum Blank Cntrl Digit Graph Newline Print Punct Space Word XDigit].freeze
      private_constant :SPACE, :WORD, :DOT, :WORD_BOUNDARY, :NOT_WORD_BOUNDARY, :SYNTAX, :CONTROLS,
        :GROUP_NAME, :PROPERTY, :ONIGMO_PROPERTIES

      def self.compile(source) = new(source).regexp

      attr_reader :regexp

      def initialize(source)
        raise ArgumentError, "pattern must be a String" unless source.is_a?(String)

        @source = source
        @at = 0
        @out = +""
        @groups = []
        @last = :none
        @names = group_names
        translate
        raise ArgumentError, "unterminated group" unless @groups.empty?

        @regexp = Regexp.new(@out)
      rescue RegexpError => e
        raise ArgumentError, e.message
      end

      private

      # Numbers every capture group, so a backreference can name one that comes later.
      def group_names
        names = {}
        count = 0
        at = 0
        in_class = false
        while at < @source.length
          char = @source[at]
          if char == "\\"
            at += 1
          elsif in_class
            in_class = char != "]"
          elsif char == "["
            in_class = true
          elsif char == "("
            name = @source[(at + 1)..][GROUP_NAME, 1]
            if name
              raise ArgumentError, "duplicate group name #{name}" if names.key?(name)

              names[name] = count + 1
            end
            count += 1 if name || @source[at + 1] != "?"
          end
          at += 1
        end
        @captures = count
        names
      end

      def translate
        until eos?
          char = take
          case char
          when "\\" then escape
          when "[" then emit(character_class, :atom)
          when "(" then open_group
          when ")" then close_group
          when "|" then emit("|", :none)
          when "^" then emit('\A', :assertion)
          when "$" then emit('\z', :assertion)
          when "." then emit(DOT, :atom)
          when "*", "+", "?" then quantify(char)
          when "{" then quantify(bounds)
          when "}", "]" then raise ArgumentError, "lone #{char}"
          else emit(char, :atom)
          end
        end
      end

      def emit(text, last)
        @out << text
        @last = last
      end

      def quantify(text)
        raise ArgumentError, "nothing to repeat before #{text}" unless @last == :atom

        text += take if peek == "?"
        emit(text, :quantifier)
      end

      def bounds
        match = @source[@at..].match(/\A(\d+)(,(\d*))?\}/) or raise ArgumentError, "lone {"
        @at += match[0].length
        if match[3] && !match[3].empty? && Integer(match[3], 10) < Integer(match[1], 10)
          raise ArgumentError, "numbers out of order in {} quantifier"
        end
        "{#{match[0]}"
      end

      def open_group
        rest = @source[@at..]
        if (name = rest[GROUP_NAME])
          @at += name.length
          return push(:group, "(")
        end

        prefix = rest[/\A\?(?::|=|!|<=|<!)/]
        raise ArgumentError, "invalid group (#{rest[0, 2]}" if rest.start_with?("?") && prefix.nil?

        @at += prefix.to_s.length
        push((prefix.nil? || prefix == "?:") ? :group : :assertion, "(#{prefix}")
      end

      def push(kind, text)
        @groups << kind
        emit(text, :none)
      end

      def close_group
        raise ArgumentError, "lone )" if @groups.empty?

        emit(")", (@groups.pop == :group) ? :atom : :assertion)
      end

      def escape
        char = take or raise ArgumentError, "trailing backslash"
        case char
        when "b" then emit(WORD_BOUNDARY, :assertion)
        when "B" then emit(NOT_WORD_BOUNDARY, :assertion)
        when "k"
          name = @source[@at..][/\A<([^>]*)>/, 1] or raise ArgumentError, "invalid named reference"
          number = @names[name] or raise ArgumentError, "no group named #{name}"
          @at += name.length + 2
          emit("\\k<#{number}>", :atom)
        when "1".."9"
          digits = char + @source[@at..][/\A\d*/]
          @at += digits.length - 1
          raise ArgumentError, "no group #{digits}" if Integer(digits, 10) > @captures

          emit("\\k<#{Integer(digits, 10)}>", :atom)
        else emit(set_escape(char) || character_escape(char, SYNTAX), :atom)
        end
      end

      # A class like +\d+, or nil for any other escape.
      def set_escape(char)
        case char
        when "d", "D", "w", "W" then "\\#{char}"
        when "s" then "[#{SPACE}]"
        when "S" then "[^#{SPACE}]"
        when "p", "P"
          escape = @source[@at..][PROPERTY] or raise ArgumentError, "invalid property escape"
          name = escape[PROPERTY, 1]
          if ONIGMO_PROPERTIES.include?(name) || name.start_with?("In_")
            raise ArgumentError, "unknown property #{name}"
          end

          @at += escape.length
          "\\#{char}{#{name}}"
        end
      end

      # A single character, written as Onigmo reads it.
      def character_escape(char, syntax)
        if CONTROLS.key?(char) then CONTROLS[char]
        elsif syntax.include?(char) then "\\#{char}"
        elsif char == "0" && !peek.to_s.match?(/\d/) then '\u0000'
        elsif char == "c" && peek.to_s.match?(/[A-Za-z]/) then code_point(take.ord % 32)
        elsif char == "x" && (hex = hex_digits(2)) then code_point(hex)
        elsif char == "u" then unicode_escape
        else raise ArgumentError, "invalid escape \\#{char}"
        end
      end

      def unicode_escape
        if (braced = @source[@at..][/\A\{(\h+)\}/, 1])
          @at += braced.length + 2
          return code_point(Integer(braced, 16))
        end

        high = hex_digits(4) or raise ArgumentError, "invalid unicode escape"
        if (0xD800..0xDBFF).cover?(high) && (low = @source[@at..][/\A\\u([dD][c-fC-F]\h\h)/, 1])
          @at += 6
          return code_point(0x10000 + ((high - 0xD800) << 10) + (Integer(low, 16) - 0xDC00))
        end
        code_point(high)
      end

      def code_point(value)
        raise ArgumentError, "code point out of range" if value > 0x10FFFF
        raise ArgumentError, "lone surrogate" if (0xD800..0xDFFF).cover?(value)

        format('\u{%x}', value)
      end

      def hex_digits(count)
        digits = @source[@at, count]
        return nil unless digits&.match?(/\A\h{#{count}}\z/)

        @at += count
        Integer(digits, 16)
      end

      def character_class
        negated = peek == "^" && take
        return negated ? '[\s\S]' : "(?!)" if peek == "]" && take

        out = +(negated ? "[^" : "[")
        loop do
          raise ArgumentError, "unterminated character class" if eos?

          char = take
          break if char == "]"

          first, first_set = class_atom(char)
          unless peek == "-" && ![nil, "]"].include?(@source[@at + 1])
            out << first
            next
          end

          take
          last, last_set = class_atom(take)
          raise ArgumentError, "character class escape in a range" if first_set || last_set

          out << first << "-" << last
        end
        out << "]"
      end

      # One class member and whether it is itself a set, like +\d+.
      def class_atom(char)
        return [("[&^-".include?(char) ? "\\#{char}" : char), false] unless char == "\\"

        char = take or raise ArgumentError, "trailing backslash"
        return [code_point(8), false] if char == "b"
        return [SPACE, true] if char == "s"

        set = set_escape(char)
        set ? [set, true] : [character_escape(char, "#{SYNTAX}-"), false]
      end

      def peek = @source[@at]

      def take
        char = @source[@at]
        @at += 1 if char
        char
      end

      def eos? = @at >= @source.length
    end
    private_constant :EcmaPattern
  end
end
