package run.workhorse.internal;

import java.math.BigDecimal;
import java.math.BigInteger;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.jspecify.annotations.Nullable;

/**
 * The core's own JSON tree, parser, and writer (ADR 0103, "Values and durations").
 *
 * <p>A tree value is a {@code Map<String, @Nullable Object>} in source order, a {@code
 * List<@Nullable Object>}, a {@code Long} or a {@code BigInteger} for an integer, a {@code Double}
 * for a number with a fraction or an exponent, a {@code String}, a {@code Boolean}, or {@code
 * null}. The parser is strict: it refuses a token that is not JSON, a lone surrogate, and trailing
 * text. A duplicate object key keeps the last value, as PostgreSQL's {@code jsonb} does.
 */
public final class Json {
  private static final int MAX_DEPTH = 1000;
  private static final BigInteger LONG_MIN = BigInteger.valueOf(Long.MIN_VALUE);
  private static final BigInteger LONG_MAX = BigInteger.valueOf(Long.MAX_VALUE);

  private Json() {}

  /**
   * Parses {@code text} into a tree.
   *
   * @throws IllegalArgumentException if the text is not one strict JSON value
   */
  public static @Nullable Object parse(String text) {
    Parser parser = new Parser(text);
    parser.skipSpace();
    Object value = parser.value(0);
    parser.skipSpace();
    if (parser.position != text.length()) {
      throw parser.error("trailing text");
    }
    return value;
  }

  /**
   * Writes a value as compact JSON text.
   *
   * <p>The writer accepts the tree types and {@code Integer}, {@code Short}, {@code Byte}, {@code
   * Float}, and {@code BigDecimal}. Map keys must be strings.
   *
   * @throws IllegalArgumentException if the value holds another type, a non-finite number, or a
   *     string with a lone surrogate
   */
  public static String write(@Nullable Object value) {
    StringBuilder out = new StringBuilder();
    write(value, out, 0);
    return out.toString();
  }

  /** A map view of a parsed object, or {@code null} when the value is not an object. */
  @SuppressWarnings("unchecked")
  public static @Nullable Map<String, @Nullable Object> object(@Nullable Object value) {
    return value instanceof Map<?, ?> map ? (Map<String, @Nullable Object>) map : null;
  }

  private static void write(@Nullable Object value, StringBuilder out, int depth) {
    if (depth > MAX_DEPTH) {
      throw new IllegalArgumentException("value nests deeper than " + MAX_DEPTH + " levels");
    }
    switch (value) {
      case null -> out.append("null");
      case String text -> string(text, out);
      case Boolean flag -> out.append(flag ? "true" : "false");
      case Long number -> out.append(number);
      case Integer number -> out.append(number);
      case Short number -> out.append(number);
      case Byte number -> out.append(number);
      case BigInteger number -> out.append(number);
      case Double number -> out.append(finite(number));
      case Float number -> out.append(finite(number.doubleValue()));
      case BigDecimal number -> out.append(number.toString());
      case Map<?, ?> map -> {
        out.append('{');
        boolean first = true;
        for (Map.Entry<?, ?> entry : map.entrySet()) {
          if (!(entry.getKey() instanceof String key)) {
            throw new IllegalArgumentException("object keys must be strings");
          }
          if (!first) {
            out.append(',');
          }
          first = false;
          string(key, out);
          out.append(':');
          write(entry.getValue(), out, depth + 1);
        }
        out.append('}');
      }
      case List<?> list -> {
        out.append('[');
        for (int index = 0; index < list.size(); index++) {
          if (index > 0) {
            out.append(',');
          }
          write(list.get(index), out, depth + 1);
        }
        out.append(']');
      }
      default ->
          throw new IllegalArgumentException(
              value.getClass().getName() + " is not a JSON value the core can write");
    }
  }

  private static String finite(double number) {
    if (!Double.isFinite(number)) {
      throw new IllegalArgumentException("a non-finite number is not a JSON value");
    }
    if (number == Math.rint(number) && Math.abs(number) < 1e15) {
      return BigDecimal.valueOf(number).toBigInteger().toString() + ".0";
    }
    return Double.toString(number);
  }

  private static void string(String text, StringBuilder out) {
    out.append('"');
    for (int index = 0; index < text.length(); index++) {
      char character = text.charAt(index);
      switch (character) {
        case '"' -> out.append("\\\"");
        case '\\' -> out.append("\\\\");
        case '\n' -> out.append("\\n");
        case '\r' -> out.append("\\r");
        case '\t' -> out.append("\\t");
        case '\b' -> out.append("\\b");
        case '\f' -> out.append("\\f");
        default -> {
          if (character < 0x20) {
            out.append(String.format("\\u%04x", (int) character));
          } else if (Character.isHighSurrogate(character)) {
            if (index + 1 >= text.length() || !Character.isLowSurrogate(text.charAt(index + 1))) {
              throw new IllegalArgumentException("a string holds a lone surrogate");
            }
            out.append(character).append(text.charAt(++index));
          } else if (Character.isLowSurrogate(character)) {
            throw new IllegalArgumentException("a string holds a lone surrogate");
          } else {
            out.append(character);
          }
        }
      }
    }
    out.append('"');
  }

  private static final class Parser {
    private final String text;
    private int position;

    Parser(String text) {
      this.text = text;
    }

    @Nullable Object value(int depth) {
      if (depth > MAX_DEPTH) {
        throw error("value nests deeper than " + MAX_DEPTH + " levels");
      }
      if (position >= text.length()) {
        throw error("unexpected end of text");
      }
      char character = text.charAt(position);
      return switch (character) {
        case '{' -> object(depth);
        case '[' -> array(depth);
        case '"' -> string();
        case 't' -> literal("true", true);
        case 'f' -> literal("false", false);
        case 'n' -> literal("null", null);
        default -> {
          if (character == '-' || (character >= '0' && character <= '9')) {
            yield number();
          }
          throw error("unexpected character");
        }
      };
    }

    private Map<String, @Nullable Object> object(int depth) {
      position++;
      Map<String, @Nullable Object> map = new LinkedHashMap<>();
      skipSpace();
      if (peek() == '}') {
        position++;
        return Collections.unmodifiableMap(map);
      }
      while (true) {
        skipSpace();
        if (peek() != '"') {
          throw error("expected an object key");
        }
        String key = string();
        skipSpace();
        expect(':');
        skipSpace();
        Object value = value(depth + 1);
        map.remove(key);
        map.put(key, value);
        skipSpace();
        if (peek() == ',') {
          position++;
          continue;
        }
        expect('}');
        return Collections.unmodifiableMap(map);
      }
    }

    private List<@Nullable Object> array(int depth) {
      position++;
      List<@Nullable Object> list = new ArrayList<>();
      skipSpace();
      if (peek() == ']') {
        position++;
        return Collections.unmodifiableList(list);
      }
      while (true) {
        skipSpace();
        list.add(value(depth + 1));
        skipSpace();
        if (peek() == ',') {
          position++;
          continue;
        }
        expect(']');
        return Collections.unmodifiableList(list);
      }
    }

    private String string() {
      position++;
      StringBuilder out = new StringBuilder();
      while (true) {
        if (position >= text.length()) {
          throw error("unterminated string");
        }
        char character = text.charAt(position++);
        if (character == '"') {
          break;
        }
        if (character < 0x20) {
          throw error("a control character in a string");
        }
        if (character != '\\') {
          out.append(character);
          continue;
        }
        if (position >= text.length()) {
          throw error("unterminated escape");
        }
        char escape = text.charAt(position++);
        switch (escape) {
          case '"' -> out.append('"');
          case '\\' -> out.append('\\');
          case '/' -> out.append('/');
          case 'b' -> out.append('\b');
          case 'f' -> out.append('\f');
          case 'n' -> out.append('\n');
          case 'r' -> out.append('\r');
          case 't' -> out.append('\t');
          case 'u' -> out.append(unicode());
          default -> throw error("an unknown escape");
        }
      }
      String value = out.toString();
      for (int index = 0; index < value.length(); index++) {
        char character = value.charAt(index);
        if (Character.isHighSurrogate(character)
            && index + 1 < value.length()
            && Character.isLowSurrogate(value.charAt(index + 1))) {
          index++;
        } else if (Character.isSurrogate(character)) {
          throw error("a lone surrogate");
        }
      }
      return value;
    }

    private char unicode() {
      if (position + 4 > text.length()) {
        throw error("a short unicode escape");
      }
      int code = 0;
      for (int index = 0; index < 4; index++) {
        char hex = text.charAt(position++);
        int digit =
            hex >= '0' && hex <= '9'
                ? hex - '0'
                : hex >= 'a' && hex <= 'f'
                    ? hex - 'a' + 10
                    : hex >= 'A' && hex <= 'F' ? hex - 'A' + 10 : -1;
        if (digit < 0) {
          throw error("a bad unicode escape");
        }
        code = code * 16 + digit;
      }
      return (char) code;
    }

    private Object number() {
      int start = position;
      if (peek() == '-') {
        position++;
      }
      if (peek() == '0') {
        position++;
      } else if (isDigit(peek())) {
        digits();
      } else {
        throw error("a bad number");
      }
      boolean integer = true;
      if (peek() == '.') {
        integer = false;
        position++;
        if (!isDigit(peek())) {
          throw error("a bad fraction");
        }
        digits();
      }
      if (peek() == 'e' || peek() == 'E') {
        integer = false;
        position++;
        if (peek() == '+' || peek() == '-') {
          position++;
        }
        if (!isDigit(peek())) {
          throw error("a bad exponent");
        }
        digits();
      }
      String token = text.substring(start, position);
      if (integer) {
        BigInteger value = new BigInteger(token);
        if (value.compareTo(LONG_MIN) >= 0 && value.compareTo(LONG_MAX) <= 0) {
          return value.longValue();
        }
        return value;
      }
      double value = Double.parseDouble(token);
      if (!Double.isFinite(value)) {
        throw error("a number outside the double range");
      }
      return value;
    }

    private void digits() {
      while (isDigit(peek())) {
        position++;
      }
    }

    private static boolean isDigit(int character) {
      return character >= '0' && character <= '9';
    }

    private @Nullable Object literal(String word, @Nullable Object value) {
      if (!text.startsWith(word, position)) {
        throw error("unexpected token");
      }
      position += word.length();
      return value;
    }

    private int peek() {
      return position < text.length() ? text.charAt(position) : -1;
    }

    private void expect(char character) {
      if (peek() != character) {
        throw error("expected '" + character + "'");
      }
      position++;
    }

    void skipSpace() {
      while (position < text.length()) {
        char character = text.charAt(position);
        if (character != ' ' && character != '\t' && character != '\n' && character != '\r') {
          return;
        }
        position++;
      }
    }

    IllegalArgumentException error(String reason) {
      return new IllegalArgumentException("invalid JSON at offset " + position + ": " + reason);
    }
  }
}
