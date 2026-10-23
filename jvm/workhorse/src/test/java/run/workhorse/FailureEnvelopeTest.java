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

  /** A fixture message: text, or text parts and unpaired surrogates, which a Java string holds. */
  private static String message(@Nullable Object message) {
    if (message instanceof String text) {
      return text;
    }
    StringBuilder built = new StringBuilder();
    for (Object part : (List<?>) java.util.Objects.requireNonNull(message)) {
      built.append(
          part instanceof String text
              ? text
              : String.valueOf(
                  (char)
                      Integer.parseInt(
                          String.valueOf(((Map<?, ?>) part).get("unpairedSurrogate")), 16)));
    }
    return built.toString();
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
      String message = message(input.get("message"));
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

  // SM-1512: a wrapped durable replay conflict keeps its class name, as in Go and Rust.
  @Test
  void namesAWrappedReplayConflictByItsClass() {
    ConflictException conflict = new ConflictException("checkpoint", "charge");
    RuntimeException wrapped =
        new java.util.concurrent.CompletionException(new RuntimeException("inner", conflict));
    Map<String, @Nullable Object> envelope = Worker.failureEnvelope(wrapped, false);
    assertEquals("ConflictException", envelope.get("name"));
    assertEquals(wrapped.getMessage(), envelope.get("message"));
    assertEquals(conflict, Worker.replayConflict(wrapped));
    assertEquals(null, Worker.replayConflict(new RuntimeException("plain")));
  }

  @Test
  void stopsTheConflictWalkAtTheDepthLimit() {
    Throwable error = new ConflictException("checkpoint", "charge");
    for (int depth = 0; depth < 16; depth++) {
      error = new RuntimeException("wrapper " + depth, error);
    }
    assertEquals(null, Worker.replayConflict(error), "a conflict below 16 wrappers is not seen");
    RuntimeException cyclic = new RuntimeException("cyclic");
    RuntimeException other = new RuntimeException("other", cyclic);
    cyclic.initCause(other);
    assertEquals(null, Worker.replayConflict(cyclic));
  }
}
