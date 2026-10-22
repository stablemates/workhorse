package run.workhorse.internal;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.stream.Stream;
import org.jspecify.annotations.Nullable;
import org.junit.jupiter.api.DynamicTest;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestFactory;

class ContractSchemaTest {
  /**
   * The kinds of number a JVM value cannot hold. An exact tree holds a {@code BigDecimal} and a
   * {@code BigInteger}, so the JVM runs every instance of the shared table.
   */
  private static final Set<String> UNHELD_NUMBERS = Set.of();

  /** Every case of {@code protocol/v1/contracts.json}, run against the contract validator. */
  @TestFactory
  Stream<DynamicTest> matchesEveryProtocolContractCase() throws IOException {
    List<DynamicTest> tests = new ArrayList<>();
    for (Object item : (List<?>) Json.parse(Files.readString(fixtures()))) {
      Map<String, @Nullable Object> fixture = Json.object(item);
      tests.add(
          DynamicTest.dynamicTest(
              String.valueOf(fixture.get("id")),
              () -> {
                // A schema in JSON text reads the way a schema that PostgreSQL stores does.
                Object document =
                    fixture.get("schemaJson") instanceof String text
                        ? Json.parseExact(text)
                        : fixture.get("schema");
                if (Boolean.TRUE.equals(fixture.get("schemaError"))) {
                  assertThrows(IllegalArgumentException.class, () -> new ContractSchema(document));
                  return;
                }
                ContractSchema schema = new ContractSchema(document);
                Object instances = fixture.get("instances");
                for (Object instance : instances == null ? List.of() : (List<?>) instances) {
                  Map<String, @Nullable Object> example = Json.object(instance);
                  Object needs = example.get("needs");
                  if (needs != null && UNHELD_NUMBERS.contains(needs)) {
                    continue;
                  }
                  Object text = example.get("json");
                  Object value =
                      text == null ? example.get("value") : Json.parseExact((String) text);
                  assertEquals(example.get("valid"), schema.valid(value), instance.toString());
                }
              }));
    }
    assertTrue(tests.size() >= 38, "the fixture file holds every case");
    return tests.stream();
  }

  @Test
  void readsAStoredSchemaFractionThatADoubleCannotHold() {
    Map<String, @Nullable Object> columns = new HashMap<>();
    columns.put("schema", "{\"payload\": {\"minimum\": 0.30000000000000000001}}");
    Map<String, @Nullable Object> document =
        Objects.requireNonNull(Json.object(Contracts.storedSchema(new Row(columns))));
    ContractSchema schema = new ContractSchema(document.get("payload"));
    assertFalse(schema.valid(0.3));
    assertTrue(schema.valid(0.30000000000000004));
    columns.put("schema", null);
    assertNull(Contracts.storedSchema(new Row(columns)));
  }

  @Test
  void namesThePatternKeywordItRefusesAtAnyDepth() {
    Map<String, String> cases =
        Map.of(
            "$.pattern",
            "{\"type\":\"string\",\"pattern\":\"^a$\"}",
            "$.properties.a.pattern",
            "{\"properties\":{\"a\":{\"type\":\"string\",\"pattern\":\"^a$\"}}}",
            "$.items.patternProperties",
            "{\"items\":{\"patternProperties\":{\"^a\":true}}}",
            "$.$defs.code.pattern",
            "{\"$defs\":{\"code\":{\"pattern\":\"(\"}},\"$ref\":\"#/$defs/code\"}");
    cases.forEach(
        (path, schema) -> {
          IllegalArgumentException error =
              assertThrows(
                  IllegalArgumentException.class, () -> new ContractSchema(Json.parse(schema)));
          assertEquals(path + " is outside the Workhorse contract profile", error.getMessage());
        });
  }

  @Test
  void validatesDraft202012Keywords() {
    ContractSchema person =
        new ContractSchema(
            Json.parse(
                """
                {"$defs": {"name": {"type": "string", "minLength": 1}},
                 "type": "object",
                 "properties": {"name": {"$ref": "#/$defs/name"},
                                "age": {"type": "integer", "minimum": 0},
                                "tags": {"type": "array", "items": {"enum": ["a", "b"]},
                                         "uniqueItems": true}},
                 "required": ["name"],
                 "additionalProperties": false}
                """));
    assertTrue(person.valid(Json.parse("{\"name\":\"Ann\",\"age\":3,\"tags\":[\"a\"]}")));
    assertFalse(person.valid(Json.parse("{\"age\":3}")));
    assertFalse(person.valid(Json.parse("{\"name\":\"\"}")));
    assertFalse(person.valid(Json.parse("{\"name\":\"Ann\",\"age\":-1}")));
    assertFalse(person.valid(Json.parse("{\"name\":\"Ann\",\"age\":1.5}")));
    assertTrue(person.valid(Json.parse("{\"name\":\"Ann\",\"age\":2.0}")));
    assertFalse(person.valid(Json.parse("{\"name\":\"Ann\",\"tags\":[\"a\",\"a\"]}")));
    assertFalse(person.valid(Json.parse("{\"name\":\"Ann\",\"extra\":true}")));
    assertTrue(new ContractSchema(true).valid(1L));
    assertFalse(new ContractSchema(false).valid(1L));
  }

  @Test
  void comparesNumbersAsJsonDoes() {
    ContractSchema schema =
        new ContractSchema(Json.parse("{\"multipleOf\":0.1,\"enum\":[1, 0.3]}"));
    assertTrue(schema.valid(1.0));
    assertTrue(schema.valid(0.3));
    assertFalse(schema.valid(true));
    assertTrue(new ContractSchema(Json.parse("{\"maxLength\":1}")).valid("😀"));
  }

  @Test
  void refusesAKeywordValueTheMetaSchemaRefuses() {
    for (String schema :
        List.of(
            "{\"type\":\"strnig\"}",
            "{\"type\":[\"string\",\"string\"]}",
            "{\"minimum\":\"1\"}",
            "{\"maxLength\":-1}",
            "{\"maxItems\":1.5}",
            "{\"required\":[1]}",
            "{\"enum\":\"a\"}",
            "{\"uniqueItems\":\"yes\"}",
            "{\"properties\":[]}",
            "{\"items\":1}",
            "{\"allOf\":[]}",
            "{\"$defs\":{\"\":true}}",
            "{\"$defs\":{\"a b\":true}}",
            "{\"$schema\":\"http://json-schema.org/draft-07/schema#\"}")) {
      assertThrows(
          IllegalArgumentException.class, () -> new ContractSchema(Json.parse(schema)), schema);
    }
  }

  @Test
  void acceptsEachDefinitionNameTheGrammarAllows() {
    new ContractSchema(Json.parse("{\"$defs\":{\"_a-1.b\":true,\"Z\":false}}"));
  }

  private static Path fixtures() {
    String schema = System.getProperty("workhorse.schema");
    if (schema == null) {
      throw new IllegalStateException("The build sets the workhorse.schema system property");
    }
    return Path.of(schema)
        .toAbsolutePath()
        .getParent()
        .getParent()
        .getParent()
        .resolve("protocol/v1/contracts.json");
  }
}
