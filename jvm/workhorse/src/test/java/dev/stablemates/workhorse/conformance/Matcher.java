package dev.stablemates.workhorse.conformance;

import dev.stablemates.workhorse.internal.Json;
import java.math.BigDecimal;
import java.math.BigInteger;
import java.time.DateTimeException;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeSet;
import java.util.regex.Pattern;
import org.jspecify.annotations.Nullable;

/**
 * The shared fixture value language, ported from the other conformance lanes.
 *
 * <p>A fixture writes expected values as JSON. {@code {"$ref": name}} compares with a value an
 * earlier step captured, and {@code {"$type": kind}} accepts any value of that kind. Every other
 * value must match exactly, and an object must have the same keys. Values are the tree types of
 * {@link Json}.
 */
final class Matcher {
  private static final Pattern TIMESTAMP =
      Pattern.compile(
          "(\\d{4})-(\\d{2})-(\\d{2})T(\\d{2}):(\\d{2}):(\\d{2})(\\.\\d{1,9})?(Z|[+-]\\d{2}:\\d{2})");
  private static final Pattern UUID =
      Pattern.compile(
          "\\p{XDigit}{8}-\\p{XDigit}{4}-\\p{XDigit}{4}-\\p{XDigit}{4}-\\p{XDigit}{12}");
  private static final DateTimeFormatter SECONDS =
      DateTimeFormatter.ofPattern("uuuu-MM-dd'T'HH:mm:ss").withZone(ZoneOffset.UTC);

  private Matcher() {}

  /** Replaces every {@code {"$ref": name}} parameter with the captured value. */
  static @Nullable Object resolve(
      @Nullable Object value, Map<String, @Nullable Object> references) {
    if (value instanceof List<?> list) {
      List<@Nullable Object> resolved = new ArrayList<>();
      for (Object item : list) {
        resolved.add(resolve(item, references));
      }
      return resolved;
    }
    Map<String, @Nullable Object> object = Json.object(value);
    if (object == null) {
      return value;
    }
    if (object.keySet().equals(java.util.Set.of("$ref"))) {
      String name = String.valueOf(object.get("$ref"));
      if (!references.containsKey(name)) {
        throw new Failure("unknown reference " + name);
      }
      return references.get(name);
    }
    Map<String, @Nullable Object> resolved = new LinkedHashMap<>();
    object.forEach((key, item) -> resolved.put(key, resolve(item, references)));
    return resolved;
  }

  /** Matches {@code actual} against the expected fixture value, naming the first mismatch. */
  static void assertValue(
      @Nullable Object expected,
      @Nullable Object actual,
      Map<String, @Nullable Object> references,
      String location) {
    Map<String, @Nullable Object> object = Json.object(expected);
    if (object != null) {
      if (object.containsKey("$ref")) {
        assertReference(String.valueOf(object.get("$ref")), actual, references, location);
      } else if (object.containsKey("$type")) {
        assertMatcher(String.valueOf(object.get("$type")), actual, location);
      } else {
        assertObject(object, actual, references, location);
      }
    } else if (expected instanceof List<?> list) {
      assertArray(list, actual, references, location);
    } else if (!same(expected, actual)) {
      throw new Failure(
          location + " expected " + render(expected) + ", received " + render(actual));
    }
  }

  /** Accepts {@code actual} when it is a value of the named fixture type. */
  static void assertMatcher(String kind, @Nullable Object actual, String location) {
    boolean accepted =
        switch (kind) {
          case "any" -> true;
          case "uuid" -> actual instanceof String text && UUID.matcher(text).matches();
          case "timestamp" -> actual instanceof String text && timestamp(text);
          case "string" -> actual instanceof String;
          case "integer" -> actual instanceof Long || actual instanceof BigInteger;
          case "number" ->
              actual instanceof Long
                  || actual instanceof BigInteger
                  || (actual instanceof Double number && Double.isFinite(number));
          case "boolean" -> actual instanceof Boolean;
          default -> throw new Failure(location + " names unknown matcher type " + kind);
        };
    if (!accepted) {
      throw new Failure(location + " expected " + kind + ", received " + render(actual));
    }
  }

  /** Follows a dotted capture path, reading list segments as indexes. */
  static @Nullable Object readPointer(@Nullable Object value, String pointer) {
    Object current = value;
    for (String segment : pointer.split("\\.", -1)) {
      Map<String, @Nullable Object> object = Json.object(current);
      if (current instanceof List<?> list && segment.matches("\\d+")) {
        int index = Integer.parseInt(segment);
        if (index >= list.size()) {
          throw new Failure("capture pointer " + pointer + " does not resolve at " + segment);
        }
        current = list.get(index);
      } else if (object != null && object.containsKey(segment)) {
        current = object.get(segment);
      } else {
        throw new Failure("capture pointer " + pointer + " does not resolve at " + segment);
      }
    }
    return current;
  }

  /** An instant the way every lane normalizes one: UTC, trailing fractional zeros removed. */
  static String normalizeTimestamp(Instant instant) {
    // The nanoseconds within the second, which the formatter's whole seconds leave out.
    String fraction =
        String.format("%09d", instant.get(java.time.temporal.ChronoField.NANO_OF_SECOND))
            .replaceFirst("0+$", "");
    return SECONDS.format(instant) + (fraction.isEmpty() ? "" : "." + fraction) + "Z";
  }

  /** An RFC 3339 instant with an explicit offset and at most nine fractional digits. */
  static boolean timestamp(String value) {
    java.util.regex.Matcher match = TIMESTAMP.matcher(value);
    if (!match.matches()) {
      return false;
    }
    try {
      LocalDate.of(
          Integer.parseInt(match.group(1)),
          Integer.parseInt(match.group(2)),
          Integer.parseInt(match.group(3)));
    } catch (DateTimeException error) {
      return false;
    }
    String offset = match.group(8);
    return Integer.parseInt(match.group(4)) < 24
        && Integer.parseInt(match.group(5)) < 60
        && Integer.parseInt(match.group(6)) < 60
        && (offset.equals("Z")
            || (Integer.parseInt(offset.substring(1, 3)) < 24
                && Integer.parseInt(offset.substring(4, 6)) < 60));
  }

  /** Two JSON values agree, with numbers compared by value so {@code 1} and {@code 1.0} agree. */
  static boolean same(@Nullable Object left, @Nullable Object right) {
    if (left instanceof Number number) {
      BigDecimal value = decimal(number);
      return right instanceof Number other
          && value != null
          && decimal(other) != null
          && value.compareTo(decimal(other)) == 0;
    }
    if (left instanceof List<?> list) {
      if (!(right instanceof List<?> other) || list.size() != other.size()) {
        return false;
      }
      for (int index = 0; index < list.size(); index++) {
        if (!same(list.get(index), other.get(index))) {
          return false;
        }
      }
      return true;
    }
    Map<String, @Nullable Object> object = Json.object(left);
    if (object != null) {
      Map<String, @Nullable Object> other = Json.object(right);
      if (other == null || !object.keySet().equals(other.keySet())) {
        return false;
      }
      return object.entrySet().stream()
          .allMatch(entry -> same(entry.getValue(), other.get(entry.getKey())));
    }
    return left == null ? right == null : left.equals(right);
  }

  /** The value as JSON text, or its string form when it has no JSON form. */
  static String render(@Nullable Object value) {
    try {
      return Json.write(value);
    } catch (IllegalArgumentException error) {
      return String.valueOf(value);
    }
  }

  private static @Nullable BigDecimal decimal(Number number) {
    return switch (number) {
      case Long value -> BigDecimal.valueOf(value);
      case Integer value -> BigDecimal.valueOf(value);
      case BigInteger value -> new BigDecimal(value);
      case BigDecimal value -> value;
      case Double value -> Double.isFinite(value) ? new BigDecimal(Double.toString(value)) : null;
      default -> new BigDecimal(number.toString());
    };
  }

  private static void assertReference(
      String name,
      @Nullable Object actual,
      Map<String, @Nullable Object> references,
      String location) {
    if (!references.containsKey(name)) {
      throw new Failure(location + " names unknown reference " + name);
    }
    Object captured = references.get(name);
    if (!same(captured, actual)) {
      throw new Failure(
          location
              + " expected reference "
              + name
              + " = "
              + render(captured)
              + ", received "
              + render(actual));
    }
  }

  private static void assertObject(
      Map<String, @Nullable Object> expected,
      @Nullable Object actual,
      Map<String, @Nullable Object> references,
      String location) {
    Map<String, @Nullable Object> object = Json.object(actual);
    if (object == null) {
      throw new Failure(location + " expected an object, received " + render(actual));
    }
    if (!expected.keySet().equals(object.keySet())) {
      throw new Failure(
          location
              + " expected keys "
              + new TreeSet<>(expected.keySet())
              + ", received "
              + new TreeSet<>(object.keySet()));
    }
    expected.forEach(
        (key, value) -> assertValue(value, object.get(key), references, location + "." + key));
  }

  private static void assertArray(
      List<?> expected,
      @Nullable Object actual,
      Map<String, @Nullable Object> references,
      String location) {
    if (!(actual instanceof List<?> list)) {
      throw new Failure(location + " expected an array, received " + render(actual));
    }
    if (expected.size() != list.size()) {
      throw new Failure(
          location
              + " expected "
              + expected.size()
              + " items, received "
              + list.size()
              + ": "
              + render(actual));
    }
    for (int index = 0; index < expected.size(); index++) {
      assertValue(expected.get(index), list.get(index), references, location + "[" + index + "]");
    }
  }
}
