package run.workhorse.internal;

import java.lang.reflect.ParameterizedType;
import java.lang.reflect.Type;
import org.jspecify.annotations.Nullable;
import run.workhorse.JsonCodec;

/**
 * The core's default {@link JsonCodec}, built on {@link Json}. It decodes into the tree types, so a
 * target type must be {@code Object} or a supertype of the decoded value, such as {@code Map} or
 * {@code List<Object>}.
 */
public final class DefaultJsonCodec implements JsonCodec {
  /** The one instance. */
  public static final DefaultJsonCodec INSTANCE = new DefaultJsonCodec();

  private DefaultJsonCodec() {}

  @Override
  public String encode(@Nullable Object value) {
    return Json.write(value);
  }

  @Override
  // T can be a nullable type, so a JSON null is a valid result. NullAway cannot see the bound.
  @SuppressWarnings({"unchecked", "TypeParameterUnusedInFormals", "NullAway"})
  public <T extends @Nullable Object> T decode(String json, Type type) {
    Object value = Json.parse(json);
    Type raw = type instanceof ParameterizedType parameterized ? parameterized.getRawType() : type;
    if (value != null && raw instanceof Class<?> target && !target.isInstance(value)) {
      throw new IllegalArgumentException(
          "the default codec decodes " + value.getClass().getName() + ", not " + type);
    }
    return (T) value;
  }
}
