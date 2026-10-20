package run.workhorse;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

import java.math.BigDecimal;
import java.math.BigInteger;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.stream.Stream;
import org.jspecify.annotations.Nullable;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.Arguments;
import org.junit.jupiter.params.provider.MethodSource;

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
   * The shared digest vectors. The first thirteen are copies of
   * typescript/core/test/checkpoint-fingerprint.test.ts:8-27. The last vector orders keys by UTF-16
   * code units: U+1F600 encodes as D83D DE00, before U+FB33. The double 2^53 - 1 is a copy of
   * ruby/spec/unit/checkpoint_fingerprint_spec.rb:15.
   */
  static Stream<Arguments> sharedVectors() {
    return Stream.of(
        Arguments.of(null, "74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b"),
        Arguments.of(true, "b5bea41b6c623f7c09f1bf24dcae58ebab3c0cdd90ad966bc43a45b44867e12b"),
        Arguments.of(0L, "5feceb66ffc86f38d952786c6d696c79c2dbc239dd4e91b46729d73a27fb57e9"),
        Arguments.of(1.5, "9f29a130438b81170b92a42650f9a94291ecad60bd47af2a3886e75f7f728725"),
        Arguments.of(
            9_007_199_254_740_991L,
            "f40b423c2dd95ff2b2f027e22208f438cf7242862e5e746860e697308c9add26"),
        Arguments.of(
            -9_007_199_254_740_991L,
            "4c933a456bb8f2e9894b2d0b26480439cd72d52fb8a27cbf8fd7f323f22c7815"),
        Arguments.of(1e-7, "5b33e02f2c5103a05d32f6ba9cb058294452bfbf393967f68bb30c1bdcbbab22"),
        Arguments.of("é", "f2886017e9c7abacf804b54d64787dce2b611c9544ba21f3affdd126a6e50086"),
        Arguments.of(List.of(), "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945"),
        Arguments.of(Map.of(), "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a"),
        Arguments.of(
            object("amountCents", 1000L, "currency", "EUR"),
            "f5e4dce1a6a38b7186257335fb274c4221391505f139b60596c5f57ce4924471"),
        Arguments.of(
            object("b", List.of(1L, object("d", 2L, "c", 3L)), "a", "x"),
            "4bc2f0faf907fa5fdaedde9cbf7002e3cbf041208b96a4ab4ce6693fbf4bea67"),
        Arguments.of(
            object("😀", 1L, "דּ", 2L),
            "2aa3f5086e32bb90ce39c508a6f40fd72e792684f130d0f3b896ea191368f1e3"),
        Arguments.of(
            9_007_199_254_740_991.0,
            "f40b423c2dd95ff2b2f027e22208f438cf7242862e5e746860e697308c9add26"));
  }

  @ParameterizedTest
  @MethodSource("sharedVectors")
  void hashesTheCanonicalJsonOfEachSharedVector(@Nullable Object input, String digest) {
    assertEquals(digest, Checkpoints.inputFingerprint(input));
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
  void givesTheDigestsOfTheCheckpointInputScenarios() {
    // protocol/v1/scenarios.json:249 and :285 pass these two fingerprints. The scenarios do not
    // state the inputs. These are the inputs whose digests they are.
    assertEquals(
        "9d2b4e1adb2bfbf2ee8be37fd8df1e553dac2776ee865a46d86a38cd6e2737c4",
        Checkpoints.inputFingerprint(object("amountCents", 1000L)));
    assertEquals(
        "2f3d79878d3e6c858a9fbb038b327843f2f752501b99581f7ffc54303eb82f7f",
        Checkpoints.inputFingerprint(object("amountCents", 900L)));
  }

  @Test
  void ignoresKeyOrderAndGivesADifferentDigestForADifferentInput() {
    // The cases of typescript/core/test/checkpoint-fingerprint.test.ts:35-44 and
    // ruby/spec/unit/checkpoint_fingerprint_spec.rb:36-43.
    Map<String, @Nullable Object> charge = object("amountCents", 1000L, "currency", "EUR");
    assertEquals(
        Checkpoints.inputFingerprint(charge),
        Checkpoints.inputFingerprint(object("currency", "EUR", "amountCents", 1000L)));
    assertNotEquals(
        Checkpoints.inputFingerprint(charge),
        Checkpoints.inputFingerprint(object("amountCents", 900L, "currency", "EUR")));
    assertEquals(Checkpoints.inputFingerprint(0L), Checkpoints.inputFingerprint(-0.0));
    assertEquals(Checkpoints.inputFingerprint(1L), Checkpoints.inputFingerprint(1.0));
  }

  @Test
  void rejectsAnInputThatIsNotJsonWithFiniteNumbers() {
    // The cases of typescript/core/test/checkpoint-fingerprint.test.ts:47-56.
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
    // The inputs of ruby/spec/unit/checkpoint_fingerprint_spec.rb:59 and
    // typescript/core/test/checkpoint-fingerprint.test.ts:61.
    List<@Nullable Object> inputs =
        Arrays.asList(
            1L << 53,
            -(1L << 53),
            BigInteger.TWO.pow(64),
            object("id", (1L << 53) + 1),
            Math.pow(2, 53),
            List.of(1e21),
            -Double.MAX_VALUE,
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
