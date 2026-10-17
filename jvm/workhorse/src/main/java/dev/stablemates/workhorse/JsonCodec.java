package dev.stablemates.workhorse;

import dev.stablemates.workhorse.internal.DefaultJsonCodec;
import java.lang.reflect.Type;
import org.jspecify.annotations.Nullable;

/**
 * Reads and writes the JSON values that cross the protocol: payloads, results, checkpoints, and
 * progress (ADR 0103, "Values and durations").
 *
 * <p>Every codec must throw for a value that is not JSON, such as a non-finite number, and must not
 * write such a value as a string. The core parses each encoded text with its own strict parser, so
 * a payload contract gives the same result for every codec.
 */
public interface JsonCodec {
  /**
   * Encodes a value as JSON text.
   *
   * @throws IllegalArgumentException if the value is not a JSON value this codec can write
   */
  String encode(@Nullable Object value);

  /**
   * Decodes JSON text as {@code type}.
   *
   * @throws IllegalArgumentException if the text is not JSON, or does not fit {@code type}
   */
  // ADR 0103 fixes this signature: the type argument comes from the call site.
  @SuppressWarnings("TypeParameterUnusedInFormals")
  <T extends @Nullable Object> T decode(String json, Type type);

  /**
   * The core's default codec. It decodes an object to a {@code Map<String, @Nullable Object>} in
   * source order, an array to a {@code List<@Nullable Object>}, an integer to a {@code Long} or a
   * {@code BigInteger}, and a number with a fraction to a {@code Double}. It encodes only those
   * types, and {@code Integer}, {@code Short}, {@code Float}, and {@code BigDecimal}.
   */
  static JsonCodec standard() {
    return DefaultJsonCodec.INSTANCE;
  }
}
