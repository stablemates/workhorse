package run.workhorse.internal;

import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Map;

/**
 * Measures the UTF-8 length of PostgreSQL's {@code jsonb} text for a JSON document. Internal to the
 * SDK; the counterpart of Ruby's {@code Values.jsonb_text_bytes}.
 *
 * <p>That text keeps the last of duplicate keys, puts a space after each {@code :} and {@code ,},
 * escapes strings as {@code JSON.stringify} does, and writes numbers in plain decimal notation
 * without the sign of a zero. Each number is measured from its own token, because {@code jsonb}
 * keeps the scale that a {@code double} loses. The input must be JSON that {@link Json#parseExact}
 * accepts.
 */
public final class JsonbSize {
  private final String text;
  private int position;

  private JsonbSize(String text) {
    this.text = text;
  }

  /** The byte length of PostgreSQL's text for the document {@code json}. */
  public static long of(String json) {
    JsonbSize measure = new JsonbSize(json);
    measure.space();
    long bytes = measure.value();
    measure.space();
    if (measure.position != json.length()) {
      throw new IllegalArgumentException("trailing characters after the JSON value");
    }
    return bytes;
  }

  private long value() {
    space();
    char next = text.charAt(position);
    return switch (next) {
      case '{' -> object();
      case '[' -> array();
      case '"' -> stringBytes(string());
      case 't', 'n' -> literal(4);
      case 'f' -> literal(5);
      default -> number();
    };
  }

  private long literal(int length) {
    position += length;
    return length;
  }

  private long object() {
    position++;
    Map<String, Long> members = new HashMap<>();
    space();
    if (text.charAt(position) == '}') {
      position++;
      return 2;
    }
    while (true) {
      space();
      String key = string();
      space();
      position++; // ':'
      members.put(key, value());
      space();
      char separator = text.charAt(position++);
      if (separator == '}') {
        break;
      }
    }
    long bytes = 2L * members.size();
    for (Map.Entry<String, Long> member : members.entrySet()) {
      bytes += stringBytes(member.getKey()) + 2 + member.getValue();
    }
    return bytes;
  }

  private long array() {
    position++;
    space();
    if (text.charAt(position) == ']') {
      position++;
      return 2;
    }
    long bytes = 0;
    int count = 0;
    while (true) {
      bytes += value();
      count++;
      space();
      char separator = text.charAt(position++);
      if (separator == ']') {
        break;
      }
    }
    return bytes + 2L * count;
  }

  /** Reads a string token and returns its decoded text. */
  private String string() {
    position++; // '"'
    StringBuilder out = new StringBuilder();
    while (true) {
      char character = text.charAt(position++);
      if (character == '"') {
        return out.toString();
      }
      if (character != '\\') {
        out.append(character);
        continue;
      }
      char escape = text.charAt(position++);
      switch (escape) {
        case 'b' -> out.append('\b');
        case 'f' -> out.append('\f');
        case 'n' -> out.append('\n');
        case 'r' -> out.append('\r');
        case 't' -> out.append('\t');
        case 'u' -> {
          out.append((char) Integer.parseInt(text.substring(position, position + 4), 16));
          position += 4;
        }
        default -> out.append(escape);
      }
    }
  }

  /** The bytes of {@code value} as a {@code jsonb} string, with its quotes. */
  private static long stringBytes(String value) {
    long bytes = 2;
    for (int index = 0; index < value.length(); index++) {
      char character = value.charAt(index);
      if (character == '"' || character == '\\') {
        bytes += 2;
      } else if (character == '\b'
          || character == '\f'
          || character == '\n'
          || character == '\r'
          || character == '\t') {
        bytes += 2;
      } else if (character < 0x20) {
        bytes += 6;
      } else if (Character.isHighSurrogate(character)
          && index + 1 < value.length()
          && Character.isLowSurrogate(value.charAt(index + 1))) {
        bytes += 4;
        index++;
      } else {
        bytes += String.valueOf(character).getBytes(StandardCharsets.UTF_8).length;
      }
    }
    return bytes;
  }

  /**
   * The bytes of {@code numeric_out} for one number token: the integer part without leading zeros,
   * or a single zero, and as many fraction digits as the token had after its decimal point, shifted
   * by the exponent.
   */
  private long number() {
    int start = position;
    boolean negative = text.charAt(position) == '-';
    if (negative) {
      position++;
    }
    int integerStart = position;
    while (position < text.length() && Character.isDigit(text.charAt(position))) {
      position++;
    }
    String integer = text.substring(integerStart, position);
    String fraction = "";
    if (position < text.length() && text.charAt(position) == '.') {
      int fractionStart = ++position;
      while (position < text.length() && Character.isDigit(text.charAt(position))) {
        position++;
      }
      fraction = text.substring(fractionStart, position);
    }
    long exponent = 0;
    if (position < text.length()
        && (text.charAt(position) == 'e' || text.charAt(position) == 'E')) {
      int exponentStart = ++position;
      if (text.charAt(position) == '+' || text.charAt(position) == '-') {
        position++;
      }
      while (position < text.length() && Character.isDigit(text.charAt(position))) {
        position++;
      }
      exponent = Long.parseLong(text.substring(exponentStart, position).replace("+", ""));
    }
    if (integer.isEmpty()) {
      throw new IllegalArgumentException("invalid number at " + start);
    }
    String digits = integer + fraction;
    String significant = digits.replaceFirst("^0+", "");
    long point = integer.length() + exponent - (digits.length() - significant.length());
    long scale = Math.max(0, fraction.length() - exponent);
    long integerBytes = significant.isEmpty() ? 1 : Math.max(1, point);
    long signBytes = !negative || significant.isEmpty() ? 0 : 1;
    return signBytes + integerBytes + (scale > 0 ? 1 + scale : 0);
  }

  private void space() {
    while (position < text.length()) {
      char character = text.charAt(position);
      if (character != ' ' && character != '\t' && character != '\n' && character != '\r') {
        return;
      }
      position++;
    }
  }
}
