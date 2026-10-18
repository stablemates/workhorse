package run.workhorse.internal;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;

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
}
