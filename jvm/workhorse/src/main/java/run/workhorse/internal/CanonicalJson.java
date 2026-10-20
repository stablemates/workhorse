package run.workhorse.internal;

import java.math.BigDecimal;
import java.math.BigInteger;
import java.math.MathContext;
import java.math.RoundingMode;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.AbstractMap;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import org.jspecify.annotations.Nullable;

/**
 * The RFC 8785 canonical JSON of a checkpoint input, and its SHA-256 fingerprint (ADR 0098, ADR
 * 0103 "RFC 8785 canonical JSON"). The counterpart of Ruby's {@code CheckpointFingerprint}.
 *
 * <p>The input is the core's JSON tree. Object keys sort by their UTF-16 code units, which is the
 * order of {@link String#compareTo}. A string escapes only the quote, the backslash, and the
 * control characters. A number writes in the ECMAScript form of its IEEE 754 double.
 */
public final class CanonicalJson {
  // I-JSON (RFC 7493) keeps integers to the range that an IEEE 754 double holds exactly. A double
  // of 2^53 or more in magnitude is an integer, so the bound refuses no fraction (ADR 0098).
  private static final long MAX_SAFE_INTEGER = (1L << 53) - 1;
  private static final BigInteger MAX_SAFE = BigInteger.valueOf(MAX_SAFE_INTEGER);
  private static final String RANGE_MESSAGE =
      "checkpoint input numbers must be at most 2^53 - 1 in magnitude";
  private static final int MAX_DIGITS = 17;
  private static final int MAX_PLAIN_POINT = 21;
  private static final int MIN_PLAIN_POINT = -6;

  private CanonicalJson() {}

  /**
   * The SHA-256 digest of the canonical JSON of {@code tree}, as 64 lowercase hexadecimal digits.
   *
   * @throws IllegalArgumentException if the tree holds a value that ADR 0098 refuses
   */
  public static String fingerprint(@Nullable Object tree) {
    MessageDigest digest;
    try {
      digest = MessageDigest.getInstance("SHA-256");
    } catch (NoSuchAlgorithmException missing) {
      throw new IllegalStateException("the JVM has no SHA-256 digest", missing);
    }
    byte[] bytes = canonical(tree).getBytes(StandardCharsets.UTF_8);
    return HexFormat.of().formatHex(digest.digest(bytes));
  }

  /**
   * Refuses each number token of the JSON text {@code json} of more than 2^53 - 1 in magnitude. The
   * parser reads a number with a fraction as a double, which can round a token above the bound to
   * the bound, so the check reads the exact token first. The text must already be valid JSON.
   *
   * @throws IllegalArgumentException if a number token is outside the bound
   */
  public static void checkNumberTokens(String json) {
    int index = 0;
    while (index < json.length()) {
      char character = json.charAt(index);
      if (character == '"') {
        index++;
        while (index < json.length() && json.charAt(index) != '"') {
          index += json.charAt(index) == '\\' ? 2 : 1;
        }
        index++;
      } else if (character == '-' || (character >= '0' && character <= '9')) {
        int start = index;
        while (index < json.length() && "+-.eE0123456789".indexOf(json.charAt(index)) >= 0) {
          index++;
        }
        BigDecimal number = new BigDecimal(json.substring(start, index));
        if (number.abs().compareTo(new BigDecimal(MAX_SAFE)) > 0) {
          throw new IllegalArgumentException(RANGE_MESSAGE);
        }
      } else {
        index++;
      }
    }
  }

  /**
   * The canonical JSON text of {@code tree}.
   *
   * @throws IllegalArgumentException if the tree holds a value that ADR 0098 refuses
   */
  public static String canonical(@Nullable Object tree) {
    StringBuilder out = new StringBuilder();
    write(tree, out);
    return out.toString();
  }

  private static void write(@Nullable Object value, StringBuilder out) {
    switch (value) {
      case null -> out.append("null");
      case Boolean flag -> out.append(flag ? "true" : "false");
      case String text -> string(text, out);
      case Long number -> out.append(integer(number));
      case Integer number -> out.append(integer(number));
      case Short number -> out.append(integer(number));
      case Byte number -> out.append(integer(number));
      case BigInteger number -> {
        if (number.abs().compareTo(MAX_SAFE) > 0) {
          throw new IllegalArgumentException(RANGE_MESSAGE);
        }
        out.append(number);
      }
      case Double number -> out.append(fraction(number));
      case Float number -> out.append(fraction(Json.shortest(number)));
      case List<?> items -> {
        out.append('[');
        for (int index = 0; index < items.size(); index++) {
          if (index > 0) {
            out.append(',');
          }
          write(items.get(index), out);
        }
        out.append(']');
      }
      case Map<?, ?> members -> object(members, out);
      default ->
          throw new IllegalArgumentException(
              "checkpoint input contains "
                  + value.getClass().getName()
                  + ", which is not a JSON value");
    }
  }

  private static void object(Map<?, ?> members, StringBuilder out) {
    List<Map.Entry<String, @Nullable Object>> entries = new ArrayList<>();
    for (Map.Entry<?, ?> member : members.entrySet()) {
      if (!(member.getKey() instanceof String key)) {
        throw new IllegalArgumentException("checkpoint input object keys must be Strings");
      }
      // Map.entry refuses a null value, and a JSON object member can be null.
      entries.add(new AbstractMap.SimpleImmutableEntry<>(key, member.getValue()));
    }
    // A Java String is a sequence of UTF-16 code units, so compareTo gives the RFC 8785 order.
    entries.sort(Map.Entry.comparingByKey());
    out.append('{');
    boolean first = true;
    for (Map.Entry<String, @Nullable Object> entry : entries) {
      if (!first) {
        out.append(',');
      }
      first = false;
      string(entry.getKey(), out);
      out.append(':');
      write(entry.getValue(), out);
    }
    out.append('}');
  }

  private static String integer(long value) {
    if (value > MAX_SAFE_INTEGER || value < -MAX_SAFE_INTEGER) {
      throw new IllegalArgumentException(RANGE_MESSAGE);
    }
    return Long.toString(value);
  }

  private static String fraction(double value) {
    // number refuses a non-finite value with its own message.
    if (Double.isFinite(value) && Math.abs(value) > MAX_SAFE_INTEGER) {
      throw new IllegalArgumentException(RANGE_MESSAGE);
    }
    return number(value);
  }

  /**
   * The ECMAScript {@code Number::toString} form of a double: the shortest digits that read back as
   * the same double, then the ECMAScript notation. {@link Double#toString} keeps at least two
   * digits, so it cannot give this form; for {@link Double#MIN_VALUE} it writes {@code 4.9E-324}.
   *
   * @throws IllegalArgumentException if the value is not finite
   */
  public static String number(double value) {
    if (!Double.isFinite(value)) {
      throw new IllegalArgumentException("checkpoint input contains a non-finite number");
    }
    if (value == 0) {
      return "0";
    }
    BigDecimal shortest = shortest(Math.abs(value)).stripTrailingZeros();
    String digits = shortest.unscaledValue().toString();
    // The value is 0.digits * 10^point.
    int point = digits.length() - shortest.scale();
    return (value < 0 ? "-" : "") + notation(digits, point);
  }

  /**
   * The decimal with the fewest significant digits that reads back as {@code value}. When two such
   * decimals exist, ECMAScript takes the one closer to the value, and the even one on a tie.
   */
  private static BigDecimal shortest(double value) {
    BigDecimal exact = new BigDecimal(value);
    for (int precision = 1; precision <= MAX_DIGITS; precision++) {
      BigDecimal low = exact.round(new MathContext(precision, RoundingMode.FLOOR));
      BigDecimal high = exact.round(new MathContext(precision, RoundingMode.CEILING));
      boolean lowReads = Double.parseDouble(low.toString()) == value;
      boolean highReads = Double.parseDouble(high.toString()) == value;
      if (lowReads && highReads) {
        int closer = exact.subtract(low).compareTo(high.subtract(exact));
        if (closer != 0) {
          return closer < 0 ? low : high;
        }
        return low.unscaledValue().testBit(0) ? high : low;
      }
      if (lowReads) {
        return low;
      }
      if (highReads) {
        return high;
      }
    }
    // Seventeen significant digits always identify a double.
    return exact.round(new MathContext(MAX_DIGITS, RoundingMode.HALF_EVEN));
  }

  private static String notation(String digits, int point) {
    int count = digits.length();
    if (point >= count && point <= MAX_PLAIN_POINT) {
      return digits + "0".repeat(point - count);
    }
    if (point > 0 && point <= MAX_PLAIN_POINT) {
      return digits.substring(0, point) + "." + digits.substring(point);
    }
    if (point > MIN_PLAIN_POINT && point <= 0) {
      return "0." + "0".repeat(-point) + digits;
    }
    int exponent = point - 1;
    String mantissa = count == 1 ? digits : digits.charAt(0) + "." + digits.substring(1);
    return mantissa + "e" + (exponent < 0 ? "-" : "+") + Math.abs(exponent);
  }

  /**
   * RFC 8785 escapes only the quote, the backslash, and the control characters. A control character
   * without a short escape uses six characters with lowercase hexadecimal digits.
   */
  private static void string(String text, StringBuilder out) {
    out.append('"');
    for (int index = 0; index < text.length(); index++) {
      char character = text.charAt(index);
      if (Character.isHighSurrogate(character)
          && index + 1 < text.length()
          && Character.isLowSurrogate(text.charAt(index + 1))) {
        out.append(character).append(text.charAt(index + 1));
        index++;
        continue;
      }
      if (Character.isSurrogate(character)) {
        throw new IllegalArgumentException(
            "checkpoint input strings must not hold a lone surrogate");
      }
      switch (character) {
        case '"' -> out.append("\\\"");
        case '\\' -> out.append("\\\\");
        case '\b' -> out.append("\\b");
        case '\t' -> out.append("\\t");
        case '\n' -> out.append("\\n");
        case '\f' -> out.append("\\f");
        case '\r' -> out.append("\\r");
        default -> {
          if (character < 0x20) {
            out.append(String.format("\\u%04x", (int) character));
          } else {
            out.append(character);
          }
        }
      }
    }
    out.append('"');
  }
}
