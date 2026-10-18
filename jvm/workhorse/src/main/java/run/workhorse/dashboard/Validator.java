package run.workhorse.dashboard;

import java.math.BigDecimal;
import java.math.BigInteger;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.concurrent.ConcurrentHashMap;
import java.util.regex.Pattern;
import org.jspecify.annotations.Nullable;
import run.workhorse.internal.Json;

/**
 * Checks a request against its {@code dashboard/v1} JSON Schema, in the subset that the contract
 * uses. Internal to the SDK; the counterpart of Ruby's {@code Dashboard::Validator}.
 */
final class Validator {
  /** A dashboard request does not match its {@code dashboard/v1} JSON Schema. */
  static final class InputValidationException extends IllegalArgumentException {
    private static final long serialVersionUID = 1L;

    InputValidationException(String message) {
      super(message);
    }
  }

  private static final Map<String, @Nullable Object> SCHEMAS =
      Objects.requireNonNull(Json.object(Json.parse(V1.INPUT_SCHEMAS)));
  private static final Map<String, Pattern> PATTERNS = new ConcurrentHashMap<>();

  private Validator() {}

  /** The request schemas by procedure, as the core's JSON tree. */
  static Map<String, @Nullable Object> schemas() {
    return SCHEMAS;
  }

  /**
   * Checks the input of one procedure.
   *
   * @throws InputValidationException unless {@code value} satisfies the request schema
   */
  static void validate(String procedure, @Nullable Object value) {
    if (!SCHEMAS.containsKey(procedure)) {
      throw new InputValidationException("unknown dashboard procedure \"" + procedure + "\"");
    }
    Map<String, @Nullable Object> schema = Json.object(SCHEMAS.get(procedure));
    if (schema == null) {
      if (value != null) {
        throw new InputValidationException(procedure + " does not accept input");
      }
      return;
    }
    check(schema, schema, value, "$");
  }

  private static void check(
      Map<String, @Nullable Object> schema,
      Map<String, @Nullable Object> root,
      @Nullable Object value,
      String path) {
    if (schema.get("$ref") instanceof String reference) {
      check(definition(root, reference, path), root, value, path);
      return;
    }
    if (schema.get("anyOf") instanceof List<?> branches) {
      anyOf(branches, root, value, path);
      return;
    }
    if (schema.containsKey("const") && !same(schema.get("const"), value)) {
      throw fail(path, "value must equal " + Json.write(schema.get("const")));
    }
    if (schema.get("enum") instanceof List<?> allowed
        && allowed.stream().noneMatch(item -> same(item, value))) {
      throw fail(path, "value is not in the allowed set");
    }
    if (!(schema.get("type") instanceof String type)) {
      return;
    }
    switch (type) {
      case "null" -> {
        if (value != null) {
          throw fail(path, "expected null");
        }
      }
      case "boolean" -> {
        if (!(value instanceof Boolean)) {
          throw fail(path, "expected boolean");
        }
      }
      case "string" -> string(schema, value, path);
      case "integer", "number" -> number(schema, type, value, path);
      case "array" -> array(schema, root, value, path);
      case "object" -> object(schema, root, value, path);
      default -> {}
    }
  }

  private static Map<String, @Nullable Object> definition(
      Map<String, @Nullable Object> root, String reference, String path) {
    Map<String, @Nullable Object> definitions = Json.object(root.get("$defs"));
    String name =
        reference.startsWith("#/$defs/") ? reference.substring("#/$defs/".length()) : reference;
    Map<String, @Nullable Object> found =
        definitions == null ? null : Json.object(definitions.get(name));
    if (found == null) {
      throw fail(path, "unresolved schema reference " + reference);
    }
    return found;
  }

  private static void anyOf(
      List<?> branches, Map<String, @Nullable Object> root, @Nullable Object value, String path) {
    for (Object branch : branches) {
      Map<String, @Nullable Object> schema = Json.object(branch);
      if (schema == null) {
        continue;
      }
      try {
        check(schema, root, value, path);
        return;
      } catch (InputValidationException error) {
        // Try the next branch.
      }
    }
    throw fail(path, "value does not match any allowed schema");
  }

  private static void string(
      Map<String, @Nullable Object> schema, @Nullable Object value, String path) {
    if (!(value instanceof String text)) {
      throw fail(path, "expected string");
    }
    int length = text.codePointCount(0, text.length());
    if (schema.get("minLength") instanceof Long minimum && length < minimum) {
      throw fail(path, "string is too short");
    }
    if (schema.get("maxLength") instanceof Long maximum && length > maximum) {
      throw fail(path, "string is too long");
    }
    if (schema.get("pattern") instanceof String source
        && !PATTERNS.computeIfAbsent(source, EcmaPattern::compile).matcher(text).find()) {
      throw fail(path, "string does not match " + source);
    }
  }

  private static void number(
      Map<String, @Nullable Object> schema, String type, @Nullable Object value, String path) {
    BigDecimal number = decimal(value);
    if (number == null) {
      throw fail(path, "expected " + type);
    }
    if (type.equals("integer") && !(value instanceof Long || value instanceof BigInteger)) {
      throw fail(path, "expected integer");
    }
    BigDecimal minimum = decimal(schema.get("minimum"));
    if (minimum != null && number.compareTo(minimum) < 0) {
      throw fail(path, "number is below minimum");
    }
    BigDecimal maximum = decimal(schema.get("maximum"));
    if (maximum != null && number.compareTo(maximum) > 0) {
      throw fail(path, "number is above maximum");
    }
  }

  private static void array(
      Map<String, @Nullable Object> schema,
      Map<String, @Nullable Object> root,
      @Nullable Object value,
      String path) {
    if (!(value instanceof List<?> items)) {
      throw fail(path, "expected array");
    }
    if (schema.get("minItems") instanceof Long minimum && items.size() < minimum) {
      throw fail(path, "array has too few items");
    }
    if (schema.get("maxItems") instanceof Long maximum && items.size() > maximum) {
      throw fail(path, "array has too many items");
    }
    Map<String, @Nullable Object> itemSchema = Json.object(schema.get("items"));
    if (itemSchema == null) {
      return;
    }
    for (int index = 0; index < items.size(); index++) {
      check(itemSchema, root, items.get(index), path + "[" + index + "]");
    }
  }

  private static void object(
      Map<String, @Nullable Object> schema,
      Map<String, @Nullable Object> root,
      @Nullable Object value,
      String path) {
    Map<String, @Nullable Object> object = Json.object(value);
    if (object == null) {
      throw fail(path, "expected object");
    }
    Map<String, @Nullable Object> properties = Json.object(schema.get("properties"));
    if (schema.get("required") instanceof List<?> required) {
      for (Object name : required) {
        if (name instanceof String key && !object.containsKey(key)) {
          throw fail(path + "." + key, "required property is missing");
        }
      }
    }
    Object additional = schema.get("additionalProperties");
    for (Map.Entry<String, @Nullable Object> entry : object.entrySet()) {
      String child = path + "." + entry.getKey();
      Map<String, @Nullable Object> property =
          properties == null ? null : Json.object(properties.get(entry.getKey()));
      Map<String, @Nullable Object> additionalSchema = Json.object(additional);
      if (property != null) {
        check(property, root, entry.getValue(), child);
      } else if (Boolean.FALSE.equals(additional)) {
        throw fail(child, "additional property is not allowed");
      } else if (additionalSchema != null) {
        check(additionalSchema, root, entry.getValue(), child);
      }
    }
  }

  /** JSON equality, where {@code 25} and {@code 25.0} are the same number. */
  private static boolean same(@Nullable Object left, @Nullable Object right) {
    BigDecimal leftNumber = decimal(left);
    BigDecimal rightNumber = decimal(right);
    if (leftNumber != null || rightNumber != null) {
      return leftNumber != null && rightNumber != null && leftNumber.compareTo(rightNumber) == 0;
    }
    return Objects.equals(left, right);
  }

  private static @Nullable BigDecimal decimal(@Nullable Object value) {
    return switch (value) {
      case Long number -> BigDecimal.valueOf(number);
      case BigInteger number -> new BigDecimal(number);
      case Double number -> BigDecimal.valueOf(number);
      case null, default -> null;
    };
  }

  private static InputValidationException fail(String path, String message) {
    return new InputValidationException(path + ": " + message);
  }
}
