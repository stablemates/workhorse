package dev.stablemates.workhorse.internal;

import java.math.BigDecimal;
import java.math.BigInteger;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.function.BiConsumer;
import org.jspecify.annotations.Nullable;

/**
 * A compiled payload contract schema in the Workhorse contract profile (ADR 0039). Internal to the
 * SDK; the counterpart of Ruby's {@code ContractSchema}.
 *
 * <p>The schema and each instance are values of the core's JSON tree. The constructor throws {@link
 * IllegalArgumentException} for a schema outside the profile. The profile excludes {@code pattern}
 * and {@code patternProperties} at any depth, so the validator never compiles a regular expression.
 * {@code format} is an annotation, and only a reference to the root schema or to one root
 * definition resolves.
 */
public final class ContractSchema {
  private static final String DIALECT = "https://json-schema.org/draft/2020-12/schema";
  private static final Set<String> SCHEMA_VALUES =
      Set.of(
          "additionalProperties",
          "contains",
          "else",
          "if",
          "items",
          "not",
          "propertyNames",
          "then");
  private static final Set<String> SCHEMA_ARRAYS = Set.of("allOf", "anyOf", "oneOf", "prefixItems");
  private static final Set<String> SCHEMA_MAPS = Set.of("$defs", "dependentSchemas", "properties");
  private static final Set<String> PLAIN_KEYWORDS =
      Set.of(
          "$comment",
          "$schema",
          "default",
          "deprecated",
          "description",
          "examples",
          "format",
          "readOnly",
          "title",
          "writeOnly",
          "const",
          "dependentRequired",
          "enum",
          "exclusiveMaximum",
          "exclusiveMinimum",
          "maxContains",
          "maximum",
          "maxItems",
          "maxLength",
          "maxProperties",
          "minContains",
          "minimum",
          "minItems",
          "minLength",
          "minProperties",
          "multipleOf",
          "required",
          "type",
          "uniqueItems");
  private static final int MAX_DEPTH = 256;
  private static final Set<String> TYPES =
      Set.of("array", "boolean", "integer", "null", "number", "object", "string");
  private static final Set<String> NUMBERS =
      Set.of("exclusiveMaximum", "exclusiveMinimum", "maximum", "minimum");
  private static final Set<String> COUNTS =
      Set.of(
          "maxContains",
          "maxItems",
          "maxLength",
          "maxProperties",
          "minContains",
          "minItems",
          "minLength",
          "minProperties");
  private static final Set<String> STRINGS = Set.of("$comment", "description", "format", "title");
  private static final Set<String> BOOLEANS =
      Set.of("deprecated", "readOnly", "uniqueItems", "writeOnly");
  private static final String DEFINITION_REFERENCE_PREFIX = "#/$defs/";

  private final @Nullable Object schema;

  /**
   * Compiles a schema.
   *
   * @throws IllegalArgumentException if the schema is outside the Workhorse contract profile
   */
  public ContractSchema(@Nullable Object schema) {
    String violation = profileViolation(schema, "$");
    if (violation != null) {
      throw new IllegalArgumentException(violation);
    }
    this.schema = schema;
    checkReferences(schema, "$");
  }

  /** The profile violation in {@code schema}, or {@code null}. */
  static @Nullable String profileViolation(@Nullable Object schema, String path) {
    if (schema instanceof Boolean) {
      return null;
    }
    Map<String, @Nullable Object> object = Json.object(schema);
    if (object == null) {
      return path + " must be an object or boolean JSON Schema";
    }
    for (Map.Entry<String, @Nullable Object> entry : object.entrySet()) {
      String violation =
          keywordViolation(
              entry.getKey(), entry.getValue(), path + "." + entry.getKey(), path.equals("$"));
      if (violation != null) {
        return violation;
      }
    }
    return null;
  }

  private static @Nullable String keywordViolation(
      String keyword, @Nullable Object value, String path, boolean root) {
    if (keyword.equals("$ref")) {
      return value instanceof String text && text.startsWith("#")
          ? null
          : path + " must be a bundled local reference";
    }
    if (keyword.equals("$schema")) {
      return DIALECT.equals(value) ? null : path + " must select Draft 2020-12";
    }
    if (keyword.equals("$defs") && !root) {
      return path + " must appear only on the root schema";
    }
    if (SCHEMA_VALUES.contains(keyword)) {
      return profileViolation(value, path);
    }
    if (SCHEMA_ARRAYS.contains(keyword)) {
      if (!(value instanceof List<?> list) || list.isEmpty()) {
        return path + " must be a non-empty array";
      }
      for (int index = 0; index < list.size(); index++) {
        String violation = profileViolation(list.get(index), path + "[" + index + "]");
        if (violation != null) {
          return violation;
        }
      }
      return null;
    }
    if (SCHEMA_MAPS.contains(keyword)) {
      Map<String, @Nullable Object> members = Json.object(value);
      if (members == null) {
        return path + " must be an object";
      }
      for (Map.Entry<String, @Nullable Object> member : members.entrySet()) {
        String memberPath = path + "." + member.getKey();
        if (keyword.equals("$defs") && !definitionName(member.getKey())) {
          return memberPath + " must be a definition name matching ^[A-Za-z_][-A-Za-z0-9._]*$";
        }
        String violation = profileViolation(member.getValue(), memberPath);
        if (violation != null) {
          return violation;
        }
      }
      return null;
    }
    if (PLAIN_KEYWORDS.contains(keyword)) {
      return valueViolation(keyword, value, path);
    }
    return path + " is outside the Workhorse contract profile";
  }

  /** The Draft 2020-12 meta-schema's rule for the value of {@code keyword}. */
  private static @Nullable String valueViolation(
      String keyword, @Nullable Object value, String path) {
    if (keyword.equals("type")) {
      return typeNames(value)
          ? null
          : path + " must name a JSON type or a non-empty array of unique JSON types";
    }
    if (keyword.equals("enum") || keyword.equals("examples")) {
      return value instanceof List<?> ? null : path + " must be an array";
    }
    if (keyword.equals("multipleOf")) {
      return isNumber(value) && decimal(value).signum() > 0
          ? null
          : path + " must be a number greater than 0";
    }
    if (NUMBERS.contains(keyword)) {
      return isNumber(value) ? null : path + " must be a number";
    }
    if (COUNTS.contains(keyword)) {
      return isCount(value) ? null : path + " must be a non-negative integer";
    }
    if (STRINGS.contains(keyword)) {
      return value instanceof String ? null : path + " must be a string";
    }
    if (BOOLEANS.contains(keyword)) {
      return value instanceof Boolean ? null : path + " must be a boolean";
    }
    if (keyword.equals("required")) {
      return names(value) ? null : path + " must be an array of unique strings";
    }
    if (keyword.equals("dependentRequired")) {
      Map<String, @Nullable Object> map = Json.object(value);
      if (map == null || !map.values().stream().allMatch(ContractSchema::names)) {
        return path + " must map each property to an array of unique strings";
      }
    }
    return null;
  }

  /** Whether {@code name} matches {@code ^[A-Za-z_][-A-Za-z0-9._]*$}, without a regex. */
  private static boolean definitionName(String name) {
    for (int index = 0; index < name.length(); index++) {
      char character = name.charAt(index);
      boolean letter =
          (character >= 'A' && character <= 'Z')
              || (character >= 'a' && character <= 'z')
              || character == '_';
      boolean later =
          (character >= '0' && character <= '9') || character == '-' || character == '.';
      if (!letter && (index == 0 || !later)) {
        return false;
      }
    }
    return !name.isEmpty();
  }

  private static boolean typeNames(@Nullable Object value) {
    if (value instanceof String text) {
      return TYPES.contains(text);
    }
    if (!(value instanceof List<?> list) || list.isEmpty()) {
      return false;
    }
    Set<Object> seen = new HashSet<>();
    for (Object item : list) {
      if (!(item instanceof String text) || !TYPES.contains(text) || !seen.add(text)) {
        return false;
      }
    }
    return true;
  }

  private static boolean names(@Nullable Object value) {
    if (!(value instanceof List<?> list)) {
      return false;
    }
    Set<Object> seen = new HashSet<>();
    for (Object item : list) {
      if (!(item instanceof String text) || !seen.add(text)) {
        return false;
      }
    }
    return true;
  }

  /** A non-negative integer, which JSON can write as {@code 3.0}. */
  private static boolean isCount(@Nullable Object value) {
    if (!isNumber(value)) {
      return false;
    }
    BigDecimal number = decimal(value);
    return number.signum() >= 0 && number.stripTrailingZeros().scale() <= 0;
  }

  /** Validates an instance, a value of the core's JSON tree. */
  public boolean valid(@Nullable Object instance) {
    return validAt(schema, instance, 0);
  }

  private void checkReferences(@Nullable Object node, String path) {
    Map<String, @Nullable Object> object = Json.object(node);
    if (object == null) {
      return;
    }
    if (object.containsKey("$ref") && resolve(text(object.get("$ref"))) == null) {
      throw new IllegalArgumentException(path + ".$ref must point at a subschema of the contract");
    }
    eachSubschema(object, path, this::checkReferences);
  }

  private static void eachSubschema(
      Map<String, @Nullable Object> schema,
      String path,
      BiConsumer<@Nullable Object, String> visit) {
    for (Map.Entry<String, @Nullable Object> entry : schema.entrySet()) {
      String keyword = entry.getKey();
      Object value = entry.getValue();
      if (SCHEMA_VALUES.contains(keyword)) {
        visit.accept(value, path + "." + keyword);
      } else if (SCHEMA_ARRAYS.contains(keyword) && value instanceof List<?> list) {
        for (int index = 0; index < list.size(); index++) {
          visit.accept(list.get(index), path + "." + keyword + "[" + index + "]");
        }
      } else if (SCHEMA_MAPS.contains(keyword)) {
        Map<String, @Nullable Object> members = Json.object(value);
        if (members != null) {
          members.forEach((name, child) -> visit.accept(child, path + "." + keyword + "." + name));
        }
      }
    }
  }

  /**
   * The schema a reference names, or {@code null} when it names neither the root nor a root
   * definition. A schema is never {@code null}: the profile check allows only objects and booleans.
   */
  private @Nullable Object resolve(String reference) {
    if (reference.equals("#")) {
      return schema;
    }
    if (!reference.startsWith(DEFINITION_REFERENCE_PREFIX)) {
      return null;
    }
    Map<String, @Nullable Object> root = Json.object(schema);
    Map<String, @Nullable Object> definitions =
        root == null ? null : Json.object(root.get("$defs"));
    return definitions == null
        ? null
        : definitions.get(reference.substring(DEFINITION_REFERENCE_PREFIX.length()));
  }

  private boolean validAt(@Nullable Object node, @Nullable Object instance, int depth) {
    if (node instanceof Boolean flag) {
      return flag;
    }
    if (depth > MAX_DEPTH) {
      throw new IllegalArgumentException("contract schema references recurse too deeply");
    }
    Map<String, @Nullable Object> object = Json.object(node);
    if (object == null) {
      return false;
    }
    for (Map.Entry<String, @Nullable Object> entry : object.entrySet()) {
      if (!keywordValid(object, entry.getKey(), entry.getValue(), instance, depth)) {
        return false;
      }
    }
    return true;
  }

  private boolean keywordValid(
      Map<String, @Nullable Object> node,
      String keyword,
      @Nullable Object value,
      @Nullable Object instance,
      int depth) {
    return switch (keyword) {
      case "$ref" -> validAt(resolve(text(value)), instance, depth + 1);
      case "type" ->
          value instanceof List<?> types
              ? types.stream().anyMatch(type -> isType(instance, text(type)))
              : isType(instance, text(value));
      case "enum" -> list(value).stream().anyMatch(candidate -> equal(candidate, instance));
      case "const" -> equal(value, instance);
      case "allOf" -> list(value).stream().allMatch(child -> validAt(child, instance, depth + 1));
      case "anyOf" -> list(value).stream().anyMatch(child -> validAt(child, instance, depth + 1));
      case "oneOf" ->
          list(value).stream().filter(child -> validAt(child, instance, depth + 1)).count() == 1;
      case "not" -> !validAt(value, instance, depth + 1);
      case "if" -> {
        String branch = validAt(value, instance, depth + 1) ? "then" : "else";
        yield !node.containsKey(branch) || validAt(node.get(branch), instance, depth + 1);
      }
      default -> {
        if (instance != null && isNumber(instance)) {
          yield numberValid(keyword, value, instance);
        } else if (instance instanceof String string) {
          yield stringValid(keyword, value, string);
        } else if (instance instanceof List<?> items) {
          yield arrayValid(node, keyword, value, items, depth);
        } else if (instance instanceof Map<?, ?>) {
          yield objectValid(node, keyword, value, Json.object(instance), depth);
        }
        yield true;
      }
    };
  }

  private static String text(@Nullable Object value) {
    if (value instanceof String string) {
      return string;
    }
    throw new IllegalStateException("the profile check admitted a non-string value");
  }

  private static List<?> list(@Nullable Object value) {
    if (value instanceof List<?> items) {
      return items;
    }
    throw new IllegalStateException("the profile check admitted a non-array value");
  }

  private static boolean numberValid(String keyword, @Nullable Object value, Object instance) {
    BigDecimal number = decimal(instance);
    return switch (keyword) {
      case "minimum" -> number.compareTo(decimal(value)) >= 0;
      case "maximum" -> number.compareTo(decimal(value)) <= 0;
      case "exclusiveMinimum" -> number.compareTo(decimal(value)) > 0;
      case "exclusiveMaximum" -> number.compareTo(decimal(value)) < 0;
      case "multipleOf" -> number.remainder(decimal(value)).signum() == 0;
      default -> true;
    };
  }

  private static boolean stringValid(String keyword, @Nullable Object value, String instance) {
    int length = instance.codePointCount(0, instance.length());
    return switch (keyword) {
      case "minLength" -> decimal(value).compareTo(BigDecimal.valueOf(length)) <= 0;
      case "maxLength" -> decimal(value).compareTo(BigDecimal.valueOf(length)) >= 0;
      default -> true;
    };
  }

  private boolean arrayValid(
      Map<String, @Nullable Object> node,
      String keyword,
      @Nullable Object value,
      List<?> instance,
      int depth) {
    return switch (keyword) {
      case "minItems" -> decimal(value).compareTo(BigDecimal.valueOf(instance.size())) <= 0;
      case "maxItems" -> decimal(value).compareTo(BigDecimal.valueOf(instance.size())) >= 0;
      case "uniqueItems" -> !Boolean.TRUE.equals(value) || unique(instance);
      case "prefixItems" -> {
        List<?> prefix = list(value);
        boolean valid = true;
        for (int index = 0; valid && index < Math.min(prefix.size(), instance.size()); index++) {
          valid = validAt(prefix.get(index), instance.get(index), depth + 1);
        }
        yield valid;
      }
      case "items" -> {
        int skip = node.get("prefixItems") instanceof List<?> items ? items.size() : 0;
        boolean valid = true;
        for (int index = skip; valid && index < instance.size(); index++) {
          valid = validAt(value, instance.get(index), depth + 1);
        }
        yield valid;
      }
      case "contains" -> {
        long matches = instance.stream().filter(item -> validAt(value, item, depth + 1)).count();
        BigDecimal found = BigDecimal.valueOf(matches);
        Object minimum = node.get("minContains");
        Object maximum = node.get("maxContains");
        yield found.compareTo(minimum == null ? BigDecimal.ONE : decimal(minimum)) >= 0
            && (maximum == null || found.compareTo(decimal(maximum)) <= 0);
      }
      default -> true;
    };
  }

  private boolean objectValid(
      Map<String, @Nullable Object> node,
      String keyword,
      @Nullable Object value,
      @Nullable Map<String, @Nullable Object> instance,
      int depth) {
    if (instance == null) {
      return true;
    }
    Map<String, @Nullable Object> members = Json.object(value);
    return switch (keyword) {
      case "minProperties" -> decimal(value).compareTo(BigDecimal.valueOf(instance.size())) <= 0;
      case "maxProperties" -> decimal(value).compareTo(BigDecimal.valueOf(instance.size())) >= 0;
      case "required" -> instance.keySet().containsAll(list(value));
      case "dependentRequired" ->
          members == null
              || members.entrySet().stream()
                  .allMatch(
                      entry ->
                          !instance.containsKey(entry.getKey())
                              || instance.keySet().containsAll(list(entry.getValue())));
      case "dependentSchemas" ->
          members == null
              || members.entrySet().stream()
                  .allMatch(
                      entry ->
                          !instance.containsKey(entry.getKey())
                              || validAt(entry.getValue(), instance, depth + 1));
      case "propertyNames" ->
          instance.keySet().stream().allMatch(name -> validAt(value, name, depth + 1));
      case "properties" ->
          members == null
              || members.entrySet().stream()
                  .allMatch(
                      entry ->
                          !instance.containsKey(entry.getKey())
                              || validAt(
                                  entry.getValue(), instance.get(entry.getKey()), depth + 1));
      case "additionalProperties" -> {
        Map<String, @Nullable Object> named = Json.object(node.get("properties"));
        yield instance.entrySet().stream()
            .allMatch(
                entry ->
                    (named != null && named.containsKey(entry.getKey()))
                        || validAt(value, entry.getValue(), depth + 1));
      }
      default -> true;
    };
  }

  private static boolean isType(@Nullable Object instance, String type) {
    return switch (type) {
      case "null" -> instance == null;
      case "boolean" -> instance instanceof Boolean;
      case "string" -> instance instanceof String;
      case "array" -> instance instanceof List<?>;
      case "object" -> instance instanceof Map<?, ?>;
      case "number" -> isNumber(instance);
      case "integer" ->
          instance instanceof Long
              || instance instanceof BigInteger
              || (instance instanceof Double number
                  && Double.isFinite(number)
                  && number == Math.rint(number));
      default -> false;
    };
  }

  private static boolean isNumber(@Nullable Object value) {
    return value instanceof Long
        || value instanceof BigInteger
        || (value instanceof Double number && Double.isFinite(number));
  }

  private static BigDecimal decimal(@Nullable Object value) {
    return switch (value) {
      case Long number -> BigDecimal.valueOf(number);
      case BigInteger number -> new BigDecimal(number);
      case Double number -> new BigDecimal(Double.toString(number));
      case null, default -> throw new IllegalArgumentException("not a JSON number");
    };
  }

  /** JSON equality: 1 equals 1.0, and true equals neither 1 nor 1.0. */
  private static boolean equal(@Nullable Object left, @Nullable Object right) {
    if (isNumber(left)) {
      return isNumber(right) && decimal(left).compareTo(decimal(right)) == 0;
    }
    if (left instanceof Map<?, ?> leftMap) {
      if (!(right instanceof Map<?, ?> rightMap) || leftMap.size() != rightMap.size()) {
        return false;
      }
      for (Map.Entry<?, ?> entry : leftMap.entrySet()) {
        if (!rightMap.containsKey(entry.getKey())
            || !equal(entry.getValue(), rightMap.get(entry.getKey()))) {
          return false;
        }
      }
      return true;
    }
    if (left instanceof List<?> leftList) {
      if (!(right instanceof List<?> rightList) || leftList.size() != rightList.size()) {
        return false;
      }
      for (int index = 0; index < leftList.size(); index++) {
        if (!equal(leftList.get(index), rightList.get(index))) {
          return false;
        }
      }
      return true;
    }
    return left == null ? right == null : left.equals(right);
  }

  private static boolean unique(List<?> items) {
    for (int index = 0; index < items.size(); index++) {
      for (int other = index + 1; other < items.size(); other++) {
        if (equal(items.get(index), items.get(other))) {
          return false;
        }
      }
    }
    return true;
  }
}
