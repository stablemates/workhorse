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
 * null}. A tree from {@link #parseExact(String)} can also hold a {@code BigDecimal}. The parser is
 * strict: it refuses a token that is not JSON, a lone surrogate, and trailing text. A duplicate
 * object key keeps the last value, as PostgreSQL's {@code jsonb} does. It also refuses a number
 * token that is longer than a limit, because {@code new BigInteger(String)} takes time that grows
 * with the square of the number of digits.
 */
public final class Json {
  private static final int MAX_DEPTH = 1000;

  /**
   * The most characters, after an optional minus sign, that {@link #parse(String)} accepts in a
   * number token. PostgreSQL's {@code jsonb} stores at most 131,072 digits before the decimal
   * point, so this limit refuses no integer that a stored value can hold.
   */
  public static final int MAX_NUMBER_LENGTH = 131_072;

  /**
   * The most digits before the decimal point of a {@code BigDecimal} in an exact tree. PostgreSQL's
   * {@code numeric} type, which {@code jsonb} uses for a number, stores no more.
   */
  private static final int MAX_INTEGER_DIGITS = 131_072;

  /** The most digits after the decimal point of a {@code BigDecimal} in an exact tree. */
  private static final int MAX_FRACTION_DIGITS = 16_383;

  private static final BigInteger LONG_MIN = BigInteger.valueOf(Long.MIN_VALUE);
  private static final BigInteger LONG_MAX = BigInteger.valueOf(Long.MAX_VALUE);

  private Json() {}

  /**
   * Parses {@code text} into a tree.
   *
   * @throws IllegalArgumentException if the text is not one strict JSON value
   */
  public static @Nullable Object parse(String text) {
    return parse(text, MAX_NUMBER_LENGTH);
  }

  /**
   * Parses {@code text} into a tree that keeps the value of every number (SM-1520).
   *
   * <p>A number with a fraction or an exponent is a {@code Double} when the shortest digits of that
   * double equal the token in value. Otherwise it is the {@code BigDecimal} of the token, and
   * {@link #write(Object)} writes its digits unchanged. So a value that a double cannot hold, such
   * as {@code 12345678901234567.89} or {@code 1E+400}, reaches PostgreSQL exactly. The parse
   * refuses a number token that PostgreSQL's {@code numeric} type cannot store, also when the token
   * equals a double in value, as {@code 0.5} with 16,384 fraction digits does. It also refuses a
   * {@code BigDecimal} with fraction digits outside the double range, because {@link
   * #parse(String)} cannot read the stored value back.
   *
   * @throws IllegalArgumentException if the text is not one strict JSON value, or if it holds a
   *     number token that is too long, outside the {@code numeric} range, or a fraction outside the
   *     double range
   */
  public static @Nullable Object parseExact(String text) {
    Parser parser = new Parser(text, MAX_NUMBER_LENGTH, true);
    return parser.document();
  }

  /**
   * Parses {@code text} into a tree, and refuses a number token that has more than {@code
   * maxNumberLength} characters after an optional minus sign.
   *
   * @throws IllegalArgumentException if the text is not one strict JSON value, or if it holds a
   *     number token that is too long
   */
  public static @Nullable Object parse(String text, int maxNumberLength) {
    if (maxNumberLength < 1) {
      throw new IllegalArgumentException("maxNumberLength must be at least 1");
    }
    return new Parser(text, maxNumberLength, false).document();
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
      case Float number -> out.append(finite(shortest(number)));
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

  /**
   * The double with the shortest digits of {@code number} as a float, so {@code 0.1f} is {@code
   * 0.1}. A widening conversion would give {@code 0.10000000149011612} (SM-1528).
   */
  public static double shortest(Float number) {
    return Double.parseDouble(Float.toString(number));
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
    private final int maxNumberLength;
    private final boolean exact;
    private int position;

    Parser(String text, int maxNumberLength, boolean exact) {
      this.text = text;
      this.maxNumberLength = maxNumberLength;
      this.exact = exact;
    }

    @Nullable Object document() {
      skipSpace();
      Object value = value(0);
      skipSpace();
      if (position != text.length()) {
        throw error("trailing text");
      }
      return value;
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
      int unsigned = position;
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
      if (position - unsigned > maxNumberLength) {
        throw error("a number longer than " + maxNumberLength + " characters");
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
      if (exact) {
        return exact(token, value);
      }
      if (!Double.isFinite(value)) {
        throw error("a number outside the double range");
      }
      return value;
    }

    /** The double when its shortest digits equal the token in value, or else the decimal. */
    private Object exact(String token, double value) {
      BigDecimal decimal;
      try {
        decimal = new BigDecimal(token);
      } catch (NumberFormatException failure) {
        throw error("a number outside the numeric range");
      }
      // PostgreSQL refuses the token itself, so a token that equals a double in value but has more
      // fraction digits than numeric stores is refused too (SM-1540).
      long integerDigits = (long) decimal.precision() - decimal.scale();
      if (integerDigits > MAX_INTEGER_DIGITS || decimal.scale() > MAX_FRACTION_DIGITS) {
        throw error("a number outside the numeric range");
      }
      if (Double.isFinite(value)
          && new BigDecimal(Double.toString(value)).compareTo(decimal) == 0) {
        return value;
      }
      // PostgreSQL writes such a value back with its fraction digits, and parse() refuses that text
      // (SM-1537). A decimal without a fraction reads back as an integer.
      if (decimal.scale() > 0 && !Double.isFinite(value)) {
        throw error("a fraction outside the double range");
      }
      return decimal;
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
