package run.workhorse;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assertions.fail;

import java.io.IOException;
import java.math.BigDecimal;
import java.math.BigInteger;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.stream.Stream;
import org.jspecify.annotations.Nullable;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.Arguments;
import org.junit.jupiter.params.provider.MethodSource;
import run.workhorse.internal.Json;

/** {@link Checkpoints#inputFingerprint} against the digest vectors that every SDK shares. */
class CheckpointsTest {
  private static Map<String, @Nullable Object> object(@Nullable Object... members) {
    Map<String, @Nullable Object> object = new LinkedHashMap<>();
    for (int index = 0; index < members.length; index += 2) {
      object.put((String) members[index], members[index + 1]);
    }
    return object;
  }

  /**
   * The vectors of {@code protocol/v1/checkpoint-fingerprints.json}, which every SDK must give.
   * Each argument is the vector id and the vector.
   */
  static Stream<Arguments> sharedVectors() throws IOException {
    String schema = System.getProperty("workhorse.schema");
    assertNotNull(schema, "the build sets the workhorse.schema system property");
    // sql/schema/current.sql -> the repository root.
    Path root = Path.of(schema).toAbsolutePath().getParent().getParent().getParent();
    Map<String, @Nullable Object> fixture =
        Json.object(
            Json.parse(Files.readString(root.resolve("protocol/v1/checkpoint-fingerprints.json"))));
    assertNotNull(fixture);
    List<?> vectors = (List<?>) fixture.get("vectors");
    assertNotNull(vectors);
    assertFalse(vectors.isEmpty());
    return vectors.stream()
        .map(Json::object)
        .map(vector -> Arguments.of(Objects.requireNonNull(vector).get("id"), vector));
  }

  /**
   * {@link Json#parse} refuses a lone surrogate escape and a number outside the double range when
   * it decodes the text, before the fingerprint.
   */
  @ParameterizedTest(name = "{0}")
  @MethodSource("sharedVectors")
  void givesTheOutcomeOfEachSharedVector(String id, Map<String, @Nullable Object> vector) {
    String input = (String) Objects.requireNonNull(vector.get("input"));
    Object refusal = vector.get("refusal");
    if (refusal == null) {
      assertEquals(vector.get("digest"), Checkpoints.inputFingerprint(Json.parse(input)), id);
      return;
    }
    IllegalArgumentException error =
        assertThrows(
            IllegalArgumentException.class,
            () -> Checkpoints.inputFingerprint(Json.parse(input)),
            id);
    String message = Objects.requireNonNull(error.getMessage());
    switch ((String) refusal) {
      case "loneSurrogate" -> assertTrue(message.endsWith(": a lone surrogate"), message);
      case "nonFinite" ->
          assertTrue(message.endsWith(": a number outside the double range"), message);
      case "unsafeNumber" ->
          assertEquals("checkpoint input numbers must be at most 2^53 - 1 in magnitude", message);
      default -> fail("unknown refusal " + refusal);
    }
  }

  @Test
  void acceptsADecimalAtTheBoundAndAStringThatLooksLikeALargeNumber() {
    // JVM regression cases from review round 3 of SM-1387. The token check reads no string.
    assertEquals(
        Checkpoints.inputFingerprint(9_007_199_254_740_991L),
        Checkpoints.inputFingerprint(new BigDecimal("9007199254740991")));
    assertEquals(64, Checkpoints.inputFingerprint(object("id", "99999999999999999999")).length());
    assertEquals(64, Checkpoints.inputFingerprint(object("q\"9e99", 1L)).length());
  }

  @Test
  void rejectsAnInputThatIsNotJsonWithFiniteNumbers() {
    // A Java value reaches the fingerprint without the parse, so the fingerprint refuses it itself.
    assertThrows(
        IllegalArgumentException.class,
        () -> Checkpoints.inputFingerprint(object("amount", Double.NaN)));
    assertThrows(IllegalArgumentException.class, () -> Checkpoints.inputFingerprint("\uD800"));
    assertThrows(
        IllegalArgumentException.class, () -> Checkpoints.inputFingerprint(List.of("\uDE00x")));
    assertThrows(
        IllegalArgumentException.class, () -> Checkpoints.inputFingerprint(object("\uD83D", 1L)));
    assertThrows(IllegalArgumentException.class, () -> Checkpoints.inputFingerprint(new Object()));
  }

  @Test
  void rejectsANumberLargerThan2To53Minus1InMagnitude() {
    // Java number types that the parse of a shared vector does not make.
    List<@Nullable Object> inputs =
        Arrays.asList(
            1L << 53,
            BigInteger.TWO.pow(64),
            Math.pow(2, 53),
            // JVM regression cases from review round 3 of SM-1387: the parse rounds each of these
            // decimals to 2^53 - 1, so only the exact token shows that it is above the bound.
            new BigDecimal("9007199254740991.1"),
            new BigDecimal("-9007199254740991.1"),
            object("nested", List.of(new BigDecimal("9007199254740991.1"))));
    for (Object input : inputs) {
      IllegalArgumentException error =
          assertThrows(IllegalArgumentException.class, () -> Checkpoints.inputFingerprint(input));
      assertEquals(
          "checkpoint input numbers must be at most 2^53 - 1 in magnitude", error.getMessage());
    }
  }

  // SM-1528: a Float input has the fingerprint of its shortest float digits.
  @Test
  void givesAFloatTheFingerprintOfItsShortestDigits() {
    assertEquals(
        Checkpoints.inputFingerprint(Map.of("rate", 0.1)),
        Checkpoints.inputFingerprint(Map.of("rate", 0.1f)));
  }
}
