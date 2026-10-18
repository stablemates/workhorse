package run.workhorse;

import org.jspecify.annotations.Nullable;
import run.workhorse.internal.CanonicalJson;
import run.workhorse.internal.DefaultJsonCodec;
import run.workhorse.internal.Json;

/** The checkpoint input fingerprint of ADR 0098. */
public final class Checkpoints {
  private Checkpoints() {}

  /**
   * The input fingerprint that a checkpoint stores for {@code input}: the SHA-256 digest of the RFC
   * 8785 canonical JSON of the input, as 64 lowercase hexadecimal characters. The counterpart of
   * Ruby's {@code Workhorse.checkpoint_input_fingerprint}.
   *
   * <p>Two inputs that differ only in key order have the same fingerprint, and every SDK gives the
   * same digest for the same input. A {@code null} input is the JSON value {@code null}, which has
   * a fingerprint. The default codec encodes the input, so it must hold only the types that codec
   * writes.
   *
   * @throws IllegalArgumentException if the input is not JSON, or holds a number of more than 2^53
   *     - 1 in magnitude
   */
  public static String inputFingerprint(@Nullable Object input) {
    return inputFingerprint(input, DefaultJsonCodec.INSTANCE);
  }

  /** The fingerprint of {@code input} as {@code codec} encodes it. */
  static String inputFingerprint(@Nullable Object input, JsonCodec codec) {
    String encoded = codec.encode(input);
    Object tree;
    try {
      tree = Json.parse(encoded);
    } catch (IllegalArgumentException error) {
      throw new IllegalArgumentException(
          "checkpoint input is not a JSON value: " + error.getMessage(), error);
    }
    // The parse can round a number above the bound to the bound, so the exact tokens are checked.
    CanonicalJson.checkNumberTokens(encoded);
    return CanonicalJson.fingerprint(tree);
  }
}
