package run.workhorse.internal;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.math.BigDecimal;
import java.math.BigInteger;
import java.time.Instant;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import run.workhorse.JsonCodec;

class JsonTest {
  @Test
  void parsesEachJsonTypeIntoTheTreeTypes() {
    Object value =
        Json.parse(
            "{\"b\":[1,-2.5,1e2,9223372036854775808,true,false,null],\"a\":\"\\u00e9\\ud83d\\ude00\"}");
    Map<String, Object> expected = new LinkedHashMap<>();
    expected.put(
        "b",
        Arrays.asList(1L, -2.5, 100.0, new BigInteger("9223372036854775808"), true, false, null));
    expected.put("a", "é😀");
    assertEquals(expected, value);
    assertEquals(List.of("b", "a"), List.copyOf(Json.object(value).keySet()));
    assertNull(Json.parse(" null "));
  }

  @Test
  void keepsTheLastValueOfADuplicateKey() {
    assertEquals(Map.of("a", 2L), Json.parse("{\"a\":1,\"a\":2}"));
  }

  @Test
  void refusesTextThatIsNotStrictJson() {
    for (String text :
        List.of(
            "",
            "NaN",
            "Infinity",
            "-Infinity",
            "01",
            "1.",
            "[1,]",
            "{\"a\":1,}",
            "'a'",
            "tru",
            "\"\\ud800\"",
            "\"\\u\uff10\uff10\uff14\uff11\"",
            "\"\\udc00x\"",
            "\"a\nb\"",
            "1 2",
            "{a:1}",
            "1e999")) {
      assertThrows(IllegalArgumentException.class, () -> Json.parse(text), text);
    }
  }

  @Test
  void readsANumberAsLongAsTheLongestJsonbInteger() {
    String digits = "9".repeat(Json.MAX_NUMBER_LENGTH);
    assertEquals(new BigInteger(digits), Json.parse(digits));
    assertEquals(List.of(new BigInteger("-" + digits)), Json.parse("[-" + digits + "]"));
    for (String text :
        List.of(
            digits + "9",
            "-" + digits + "9",
            "{\"a\":" + digits + "9}",
            "1." + digits,
            "1e" + digits)) {
      IllegalArgumentException error =
          assertThrows(IllegalArgumentException.class, () -> Json.parse(text));
      assertTrue(error.getMessage().contains("a number longer than 131072 characters"));
    }
  }

  @Test
  void refusesANumberLongerThanTheLimitOfTheCaller() {
    String digits = "1".repeat(1000);
    assertEquals(new BigInteger(digits), Json.parse(digits, 1000));
    assertEquals(new BigInteger("-" + digits), Json.parse("-" + digits, 1000));
    assertEquals(1.5, Json.parse("1.5", 3));
    for (String text : List.of(digits + "1", "-" + digits + "1", "0." + digits)) {
      assertThrows(IllegalArgumentException.class, () -> Json.parse(text, 1000), text);
    }
    assertThrows(IllegalArgumentException.class, () -> Json.parse("1", 0));
  }

  @Test
  void writesTheTreeTypesAndTheExtraNumberTypes() {
    Map<String, Object> value = new LinkedHashMap<>();
    value.put("i", 1);
    value.put("s", (short) 2);
    value.put("f", 1.5f);
    value.put("d", new BigDecimal("1.25"));
    value.put("t", "q\"\\\n\u0001");
    value.put("l", Arrays.asList(true, null, 3.0));
    assertEquals(
        "{\"i\":1,\"s\":2,\"f\":1.5,\"d\":1.25,\"t\":\"q\\\"\\\\\\n\\u0001\",\"l\":[true,null,3.0]}",
        Json.write(value));
  }

  @Test
  void theStandardCodecRefusesNonJsonValues() {
    JsonCodec codec = JsonCodec.standard();
    for (Object value :
        List.of(
            Double.NaN,
            Double.POSITIVE_INFINITY,
            Float.NEGATIVE_INFINITY,
            "\ud800",
            "a\udc00",
            Instant.EPOCH,
            Map.of(1, "key"),
            new Object())) {
      assertThrows(IllegalArgumentException.class, () -> codec.encode(value), value.toString());
    }
  }

  @Test
  void theStandardCodecDecodesIntoTheTreeTypes() {
    JsonCodec codec = JsonCodec.standard();
    Object number = codec.decode("12", Object.class);
    assertEquals(12L, number);
    Map<String, Object> object = codec.decode("{\"a\":[1]}", Map.class);
    assertEquals(Map.of("a", List.of(1L)), object);
    Object nothing = codec.decode("null", String.class);
    assertNull(nothing);
    assertThrows(IllegalArgumentException.class, () -> codec.decode("1", String.class));
  }

  @Test
  void anExactParseKeepsADecimalThatADoubleCannotHold() {
    String text = "[12345678901234567.89,1E+400,1e-400,0.1,-0.0,1.10,100000.0,1e2]";
    List<?> tree = (List<?>) Json.parseExact(text);
    assertEquals(new BigDecimal("12345678901234567.89"), tree.get(0));
    assertEquals(new BigDecimal("1E+400"), tree.get(1));
    assertEquals(new BigDecimal("1e-400"), tree.get(2));
    assertEquals(Arrays.asList(0.1, -0.0, 1.1, 100000.0, 100.0), tree.subList(3, 8));
    assertEquals(
        "[12345678901234567.89,1E+400,1E-400,0.1,0.0,1.1,100000.0,100.0]", Json.write(tree));
  }

  @Test
  void anExactParseWritesEveryValueThatADoubleHoldsAsBefore() {
    String text = "{\"a\":[1.5,-2.25e-3,6.02214076e23,1e15,123456789.125]}";
    assertEquals(Json.write(Json.parse(text)), Json.write(Json.parseExact(text)));
  }

  @Test
  void anExactParseRefusesADecimalOutsideTheNumericRange() {
    for (String text : List.of("1e131072", "1e-16384", "1e2147483648", "0.5e-99999")) {
      IllegalArgumentException error =
          assertThrows(IllegalArgumentException.class, () -> Json.parseExact(text), text);
      assertTrue(error.getMessage().endsWith("a number outside the numeric range"), text);
    }
    assertEquals(new BigDecimal("1e131071"), Json.parseExact("1e131071"));
    assertEquals(new BigDecimal("1e-16383"), Json.parseExact("1e-16383"));
  }

  @Test
  void anExactParseRefusesAFractionThatTheDefaultParseCannotReadBack() {
    String integer = "1" + "0".repeat(400);
    for (String text : List.of(integer + ".00", "-" + integer + ".5")) {
      IllegalArgumentException error =
          assertThrows(IllegalArgumentException.class, () -> Json.parseExact(text), text);
      assertTrue(error.getMessage().endsWith("a fraction outside the double range"), text);
    }
    // PostgreSQL writes a decimal without fraction digits back as an integer, which parse() reads.
    assertEquals(new BigDecimal("1.5E+400"), Json.parseExact("1.5e400"));
    assertEquals(new BigInteger(integer), Json.parse(integer));
  }

  @Test
  void theDefaultParseStillGivesADouble() {
    assertEquals(1.2345678901234568E16, Json.parse("12345678901234567.89"));
    assertThrows(IllegalArgumentException.class, () -> Json.parse("1E+400"));
  }
}
