package dev.stablemates.workhorse.spring;

import dev.stablemates.workhorse.JsonCodec;
import java.lang.reflect.Type;
import java.nio.charset.StandardCharsets;
import java.util.ArrayDeque;
import java.util.Deque;
import java.util.Map;
import org.jspecify.annotations.Nullable;
import tools.jackson.core.JacksonException;
import tools.jackson.core.json.JsonReadFeature;
import tools.jackson.core.json.JsonWriteFeature;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

/**
 * A {@link JsonCodec} on the application's Jackson {@link JsonMapper} (ADR 0103, "Values and
 * durations"), so a handler receives its record type.
 *
 * <p>The codec uses a copy of the mapper that turns off {@code WRITE_NAN_AS_STRINGS} and the
 * reading of non-numeric numbers. So a non-finite number throws, and a lone surrogate throws too.
 * The application's own mapper does not change.
 *
 * <p>An untyped value decodes as Jackson decodes it. Unlike {@link JsonCodec#standard()}, an
 * integer becomes the smallest of {@code Integer}, {@code Long}, and {@code BigInteger} that holds
 * it.
 */
public final class JacksonJsonCodec implements JsonCodec {
  private final JsonMapper mapper;

  /** A codec on a copy of {@code mapper}. */
  public JacksonJsonCodec(JsonMapper mapper) {
    this.mapper =
        mapper
            .rebuild()
            .disable(JsonWriteFeature.WRITE_NAN_AS_STRINGS)
            .disable(JsonReadFeature.ALLOW_NON_NUMERIC_NUMBERS)
            .build();
  }

  @Override
  public String encode(@Nullable Object value) {
    byte[] json;
    try {
      json = mapper.writeValueAsBytes(value);
      // Without WRITE_NAN_AS_STRINGS, Jackson writes a non-finite number as a bare token, which is
      // not JSON, so the strict read refuses it. Jackson writes a lone surrogate as a \\u escape,
      // so the check of the read tree refuses it.
      requireWellFormed(mapper.readTree(json));
    } catch (JacksonException error) {
      throw new IllegalArgumentException(
          "the value is not JSON: " + error.getOriginalMessage(), error);
    }
    return new String(json, StandardCharsets.UTF_8);
  }

  private static void requireWellFormed(JsonNode root) {
    Deque<JsonNode> pending = new ArrayDeque<>();
    pending.push(root);
    while (!pending.isEmpty()) {
      JsonNode node = pending.pop();
      if (node.isString()) {
        requireWellFormed(node.asString());
      } else if (node.isObject()) {
        for (Map.Entry<String, JsonNode> property : node.properties()) {
          requireWellFormed(property.getKey());
          pending.push(property.getValue());
        }
      } else if (node.isArray()) {
        for (JsonNode element : node) {
          pending.push(element);
        }
      }
    }
  }

  private static void requireWellFormed(String text) {
    for (int index = 0; index < text.length(); index++) {
      char current = text.charAt(index);
      if (Character.isHighSurrogate(current)
          && index + 1 < text.length()
          && Character.isLowSurrogate(text.charAt(index + 1))) {
        index++;
      } else if (Character.isSurrogate(current)) {
        throw new IllegalArgumentException(
            "the value is not JSON: a string holds a lone surrogate");
      }
    }
  }

  @Override
  @SuppressWarnings("TypeParameterUnusedInFormals") // JsonCodec fixes this signature.
  public <T extends @Nullable Object> T decode(String json, Type type) {
    try {
      return mapper.readValue(json, mapper.getTypeFactory().constructType(type));
    } catch (JacksonException error) {
      throw new IllegalArgumentException(
          "the JSON does not decode as " + type.getTypeName() + ": " + error.getOriginalMessage(),
          error);
    }
  }
}
