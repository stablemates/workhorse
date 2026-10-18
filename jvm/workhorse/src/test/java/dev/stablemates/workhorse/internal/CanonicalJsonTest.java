package dev.stablemates.workhorse.internal;

import static org.junit.jupiter.api.Assertions.assertEquals;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.jspecify.annotations.Nullable;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;

/**
 * The RFC 8785 text of numbers and strings. Each value is a copy of a value that another SDK tests,
 * and each comment names its source.
 */
class CanonicalJsonTest {
  // python/tests/test_checkpoint_input.py:56-76, which includes every value of
  // ruby/spec/unit/checkpoint_fingerprint_spec.rb:46-48. The fingerprint refuses a magnitude above
  // 2^53 - 1, so this test calls the number form.
  @ParameterizedTest
  @CsvSource({
    "1, 1",
    "-1.5, -1.5",
    "100.0, 100",
    "123.456, 123.456",
    "0.1, 0.1",
    "1e16, 10000000000000000",
    "1e20, 100000000000000000000",
    "123456789012345680000.0, 123456789012345680000",
    "1e21, 1e+21",
    "1.25e22, 1.25e+22",
    "0.000001, 0.000001",
    "1.234e-6, 0.000001234",
    "1e-7, 1e-7",
    "-2.5e-8, -2.5e-8",
    "5e-324, 5e-324",
    "1.7976931348623157e308, 1.7976931348623157e+308",
    "9007199254740991, 9007199254740991",
    "-9007199254740991, -9007199254740991",
    // The exact value ends in .25, between two shortest forms. ECMAScript takes the even digit.
    "-1010086764207289.2, -1010086764207289.2",
  })
  void writesEachNumberInTheEcmaScriptForm(double value, String text) {
    assertEquals(text, CanonicalJson.number(value));
  }

  @Test
  void writesTheIntegerBoundInDecimal() {
    // ruby/spec/unit/checkpoint_fingerprint_spec.rb:49.
    assertEquals("9007199254740991", CanonicalJson.canonical(9_007_199_254_740_991L));
  }

  @Test
  void writesAnObjectMemberWhoseValueIsNull() {
    // A JVM regression test, not a shared vector. Review round 1 of SM-1387 found that the object
    // writer threw NullPointerException for a null member. RFC 8785 gives this text in every SDK.
    Map<String, @Nullable Object> input = new LinkedHashMap<>();
    input.put("b", null);
    input.put("a", List.of());
    assertEquals("{\"a\":[],\"b\":null}", CanonicalJson.canonical(input));
    assertEquals(64, CanonicalJson.fingerprint(input).length());
  }

  @Test
  void escapesOnlyTheQuoteTheBackslashAndTheControlCharacters() {
    // python/tests/test_checkpoint_input.py:84-87.
    assertEquals(
        "\"a\\\"\\\\\\b\\f\\n\\r\\t\\u0001\\u001f\u007f é\"",
        CanonicalJson.canonical("a\"\\\b\f\n\r\t\u0001\u001f\u007f é"));
    // ruby/spec/unit/checkpoint_fingerprint_spec.rb:50.
    assertEquals(
        "\"q\\\"\\\\\\b\\t\\n\\f\\r\\u0001\u007f /\"",
        CanonicalJson.canonical("q\"\\\b\t\n\f\r\u0001\u007f /"));
  }
}
