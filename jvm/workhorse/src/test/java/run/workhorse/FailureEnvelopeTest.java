package run.workhorse;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.function.Supplier;
import org.jspecify.annotations.Nullable;
import org.junit.jupiter.api.Test;
import run.workhorse.internal.Json;

/** The worker's failure envelope against {@code protocol/v1/failures.json}. */
class FailureEnvelopeTest {
  /** An error that names itself, as the fixtures' {@code PaymentDeclined} does. */
  static final class PaymentDeclined extends Exception {
    private static final long serialVersionUID = 1L;

    PaymentDeclined(String message) {
      super(message);
    }
  }

  private static Map<String, @Nullable Object> failures() throws IOException {
    String schema = System.getProperty("workhorse.schema");
    assertNotNull(schema, "the build sets the workhorse.schema system property");
    // sql/schema/current.sql -> the repository root.
    Path root = Path.of(schema).toAbsolutePath().getParent().getParent().getParent();
    Map<String, @Nullable Object> document =
        Json.object(Json.parse(Files.readString(root.resolve("protocol/v1/failures.json"))));
    assertNotNull(document);
    return document;
  }

  // The fixture's shape fixes each value's type, so the call site names it.
  @SuppressWarnings({"unchecked", "TypeParameterUnusedInFormals"})
  private static <T> T at(Map<String, @Nullable Object> map, String key) {
    Object value = map.get(key);
    assertNotNull(value, key);
    return (T) value;
  }

  @Test
  void anAnonymousOrHiddenClassRecordsTheJavaGenericName() throws IOException {
    Map<String, @Nullable Object> envelope = at(failures(), "envelope");
    Map<String, @Nullable Object> generic = at(envelope, "genericName");
    String java = at(generic, "java");

    Exception anonymous =
        new RuntimeException("boom") {
          private static final long serialVersionUID = 1L;
        };
    Supplier<Exception> lambda = () -> new IllegalStateException("named");
    assertEquals(java, Worker.failureName(anonymous));
    assertEquals("IllegalStateException", Worker.failureName(lambda.get()));
    assertTrue(anonymous.getClass().isAnonymousClass());
  }

  @Test
  void everyNameAvoidsTheForbiddenCharacters() throws IOException {
    Map<String, @Nullable Object> envelope = at(failures(), "envelope");
    List<String> forbidden = at(envelope, "forbiddenNameCharacters");
    for (Throwable error :
        List.of(
            new PaymentDeclined("x"),
            new RuntimeException("x") {
              private static final long serialVersionUID = 1L;
            },
            new IllegalArgumentException("x"))) {
      String name = Worker.failureName(error);
      for (String character : forbidden) {
        assertFalse(name.contains(character), name + " contains " + character);
      }
    }
  }

  @Test
  void replacesTheCharactersThatPostgreSqlCannotStore() {
    Map<String, @Nullable Object> envelope =
        Worker.failureEnvelope(new IllegalStateException("a\0b \ud800 c \ud83d\ude00"), false);
    assertEquals("a\uFFFDb \uFFFD c \ud83d\ude00", envelope.get("message"));
    String stack = String.valueOf(envelope.get("stack"));
    assertFalse(stack.indexOf('\0') >= 0);
    // The core's strict writer refuses a lone surrogate, so a write proves the text is storable.
    Json.write(envelope);
    assertEquals("plain", Worker.storable("plain"));
  }

  @Test
  void matchesEveryFixture() throws IOException {
    Map<String, @Nullable Object> document = failures();
    Map<String, @Nullable Object> envelope = at(document, "envelope");
    Map<String, @Nullable Object> redacted = at(envelope, "redacted");
    String generic = at(at(envelope, "genericName"), "java");
    List<Map<String, @Nullable Object>> fixtures = at(document, "fixtures");
    for (Map<String, @Nullable Object> fixture : fixtures) {
      Map<String, @Nullable Object> input = at(fixture, "error");
      Map<String, @Nullable Object> expected = at(fixture, "envelope");
      String message = at(input, "message");
      Exception error =
          Boolean.TRUE.equals(input.get("declaresName"))
              ? new PaymentDeclined(message)
              : new Exception(message) {
                private static final long serialVersionUID = 1L;
              };
      if (!Boolean.TRUE.equals(input.get("declaresStack"))) {
        error.setStackTrace(new StackTraceElement[0]);
      }
      boolean redact = Boolean.TRUE.equals(fixture.get("redactErrorDetails"));
      Map<String, @Nullable Object> actual = Worker.failureEnvelope(error, redact);
      String id = at(fixture, "id");

      if (redact) {
        assertEquals(redacted, actual, id);
        continue;
      }
      String name = at(expected, "name");
      assertEquals(name.equals("$generic") ? generic : name, actual.get("name"), id);
      assertEquals(expected.get("message"), actual.get("message"), id);
      assertTrue(actual.get("stack") instanceof String, id + " records a stack");
    }
  }
}
