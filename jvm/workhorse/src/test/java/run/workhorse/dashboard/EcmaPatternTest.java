package run.workhorse.dashboard;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;
import java.util.regex.Pattern;
import org.jspecify.annotations.Nullable;
import org.junit.jupiter.api.Test;
import run.workhorse.internal.Json;

/** The ECMA-262 pattern policy of ADR 0103 on the {@code dashboard/v1} input schemas. */
class EcmaPatternTest {
  private static final String INSTANT =
      "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29"
          + "|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)"
          + "|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d";

  /** For each schema pattern: a value it accepts and a value it refuses. */
  private static final Map<String, List<String>> VECTORS =
      Map.of(
          INSTANT + "(?:\\.\\d+)?(?:Z))$",
          List.of("2024-02-29T23:59:59.5Z", "2023-02-29T00:00:00Z"),
          INSTANT + "\\.\\d{6}(?:Z))$",
          List.of("2026-10-17T08:30:00.123456Z", "2026-10-17T08:30:00.123Z"),
          "^(?:[01]\\d|2[0-3]):[0-5]\\d$",
          List.of("23:59", "24:00"),
          "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}"
              + "|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
          List.of("018f0000-0000-7000-8000-000000000001", "018f0000-0000-9000-8000-000000000001"),
          "^(event|attempt):[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
          List.of(
              "attempt:018f0000-0000-7000-8000-000000000001", "task:018f0000-0000-7000-8000-0"));

  @Test
  void compilesEveryPatternInTheInputSchemasAndRefusesAFinalLineTerminator() {
    Set<String> patterns = new TreeSet<>();
    collect(Validator.schemas(), patterns);
    assertFalse(patterns.isEmpty());
    assertEquals(
        new TreeSet<>(VECTORS.keySet()),
        patterns,
        "each dashboard/v1 pattern needs vectors here; widen the translator for a new construct");
    for (String source : patterns) {
      Pattern pattern = EcmaPattern.compile(source);
      String accepted = VECTORS.get(source).get(0);
      String refused = VECTORS.get(source).get(1);
      assertTrue(pattern.matcher(accepted).find(), source + " accepts " + accepted);
      assertFalse(pattern.matcher(refused).find(), source + " refuses " + refused);
      for (String terminator : List.of("\n", "\r\n", "\r", " ")) {
        assertFalse(
            pattern.matcher(accepted + terminator).find(),
            source + " refuses a final line terminator");
        // Without the translation, java.util.regex accepts the value before a final \n.
        if (terminator.equals("\n")) {
          assertTrue(Pattern.compile(source).matcher(accepted + terminator).find());
        }
      }
    }
  }

  @Test
  void rewritesAnchorsOnlyOutsideACharacterClass() {
    assertEquals("\\A[\\^$a-z]+\\z", EcmaPattern.translate("^[\\^$a-z]+$"));
    assertEquals("(?:a|b){2,3}?", EcmaPattern.translate("(?:a|b){2,3}?"));
    assertEquals("[\\[\\&\\&x]", EcmaPattern.translate("[[&&x]"));
  }

  @Test
  void refusesEveryConstructOutsideTheSubset() {
    for (String source :
        List.of(
            "(?=a)",
            "(?!a)",
            "(?<=a)",
            "(?<name>a)",
            "(a)\\1",
            "\\s",
            "\\b",
            "\\w",
            "\\p{L}",
            "\\u0041",
            "a.b",
            "(?i)a",
            "a{,2}",
            "*a",
            "a]",
            "[]",
            "(a",
            "a)",
            "a\\",
            "[\\d-a]",
            "[a-\\d]")) {
      assertThrows(IllegalArgumentException.class, () -> EcmaPattern.translate(source), source);
    }
  }

  @Test
  void validatesInputAgainstATranslatedPattern() {
    String id = "018f0000-0000-7000-8000-000000000001";
    Validator.validate("taskDetail", Map.of("id", id));
    assertThrows(
        Validator.InputValidationException.class,
        () -> Validator.validate("taskDetail", Map.of("id", id + "\n")));
  }

  private static void collect(@Nullable Object value, Set<String> patterns) {
    Map<String, @Nullable Object> object = Json.object(value);
    if (object != null) {
      if (object.get("pattern") instanceof String pattern) {
        patterns.add(pattern);
      }
      object.values().forEach(child -> collect(child, patterns));
    } else if (value instanceof List<?> items) {
      items.forEach(item -> collect(item, patterns));
    }
  }
}
