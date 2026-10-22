package run.workhorse.internal;

import static org.junit.jupiter.api.Assertions.assertEquals;

import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;

/**
 * The RFC 8785 text of numbers, including numbers above 2^53 - 1. The fingerprint refuses those
 * numbers, so the vectors of {@code protocol/v1/checkpoint-fingerprints.json} cannot show their
 * text. The vectors cover strings, escapes, and the object member whose value is null.
 */
class CanonicalJsonTest {
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
}
