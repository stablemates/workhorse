package run.workhorse.examples.programs;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import io.opentelemetry.api.common.AttributeKey;
import io.opentelemetry.api.common.Attributes;
import io.opentelemetry.api.logs.Severity;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.logging.Level;
import java.util.logging.LogRecord;
import java.util.stream.Stream;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class DemoLogFileTest {
  @TempDir Path directory;

  @Test
  void needsADirectoryAndAServiceName() {
    assertTrue(DemoLogFile.fromEnvironment(Map.of()).isEmpty());
    assertTrue(
        DemoLogFile.fromEnvironment(Map.of("WORKHORSE_DEMO_LOG_DIRECTORY", "/tmp/x")).isEmpty());
  }

  @Test
  void refusesAnInvalidSize() {
    Map<String, String> environment =
        Map.of(
            "WORKHORSE_DEMO_LOG_DIRECTORY", "/tmp/x",
            "WORKHORSE_DEMO_SERVICE_NAME", "w",
            "WORKHORSE_DEMO_LOG_MAX_BYTES", "0");
    IllegalArgumentException error =
        assertThrows(
            IllegalArgumentException.class, () -> DemoLogFile.fromEnvironment(environment));
    assertTrue(error.getMessage().contains("WORKHORSE_DEMO_LOG_MAX_BYTES"));
  }

  @Test
  void formatsUtcMilliseconds() {
    assertEquals(
        "2026-11-21T15:12:55.802Z",
        DemoLogFile.timestamp(Instant.ofEpochMilli(1_795_273_975_802L)));
    assertEquals("1970-01-01T00:00:00.000Z", DemoLogFile.timestamp(Instant.EPOCH));
  }

  @Test
  void writesBridgedRecordsAndSkipsTheirTextCopy() throws IOException {
    DemoLogFile file =
        DemoLogFile.fromEnvironment(
                Map.of(
                    "WORKHORSE_DEMO_LOG_DIRECTORY", directory.toString(),
                    "WORKHORSE_DEMO_SERVICE_NAME", "workhorse-demo-worker-jvm",
                    "WORKHORSE_DEMO_ENV", "test env"))
            .orElseThrow();
    file.openTelemetry()
        .getLogsBridge()
        .get("run.workhorse")
        .logRecordBuilder()
        .setSeverity(Severity.INFO)
        .setSeverityText("INFO")
        .setEventName("workhorse.task.completed")
        .setBody("Task completed")
        .setAllAttributes(
            Attributes.of(
                AttributeKey.stringKey("workhorse.task.id"),
                "a",
                AttributeKey.stringArrayKey("workhorse.worker.queues"),
                List.of("q1", "q2")))
        .emit();
    var handler = file.julHandler();
    handler.publish(
        new LogRecord(
            Level.INFO,
            "Task completed {event.name=workhorse.task.completed, workhorse.task.id=a}"));
    handler.publish(
        new LogRecord(
            Level.WARNING,
            "Claims abandoned {event.name=workhorse.worker.claims_abandoned, count=2}"));

    List<String> lines =
        Files.readAllLines(
            directory.resolve("test_env").resolve("workhorse-demo-worker-jvm.ndjson"));
    assertEquals(2, lines.size(), String.join("\n", lines));
    String bridged = lines.get(0);
    int last = -1;
    for (String key :
        List.of(
            "\"timestamp\"",
            "\"observedTimestamp\"",
            "\"severityText\"",
            "\"severityNumber\"",
            "\"eventName\"",
            "\"body\"",
            "\"attributes\"",
            "\"resource\"",
            "\"scope\"")) {
      int index = bridged.indexOf(key);
      assertTrue(index > last, key + " is out of order in " + bridged);
      last = index;
    }
    assertTrue(bridged.contains("\"severityText\":\"INFO\",\"severityNumber\":9"), bridged);
    assertTrue(bridged.contains("\"eventName\":\"workhorse.task.completed\""), bridged);
    assertTrue(
        bridged.contains(
                "\"attributes\":{\"workhorse.task.id\":\"a\",\"workhorse.worker.queues\":[\"q1\",\"q2\"]}")
            || bridged.contains(
                "\"attributes\":{\"workhorse.worker.queues\":[\"q1\",\"q2\"],\"workhorse.task.id\":\"a\"}"),
        bridged);
    assertTrue(bridged.contains("\"service.name\":\"workhorse-demo-worker-jvm\""), bridged);
    assertTrue(bridged.contains("\"deployment.environment.name\":\"test env\""), bridged);
    assertTrue(bridged.contains("\"telemetry.sdk.language\":\"java\""), bridged);
    assertTrue(bridged.contains("\"scope\":{\"name\":\"run.workhorse\"}}"), bridged);
    String javaOnly = lines.get(1);
    assertTrue(javaOnly.contains("\"severityText\":\"WARN\",\"severityNumber\":13"), javaOnly);
    assertTrue(javaOnly.contains("\"eventName\":\"workhorse.worker.claims_abandoned\""), javaOnly);
    assertFalse(lines.stream().anyMatch(line -> line.contains("\"body\":\"Task completed {")));
  }

  @Test
  void escapesTextAndRotatesBeforeTheLimit() throws IOException {
    Path path = directory.resolve("w.ndjson");
    DemoLogFile file = new DemoLogFile(path, 400, 2, Map.of());
    for (int index = 0; index < 12; index++) {
      file.write("INFO", 9, null, "record \"" + index + "\"\n", Map.of(), "test", Instant.now());
    }
    try (Stream<Path> files = Files.list(directory)) {
      List<Path> paths = files.sorted().toList();
      assertEquals(
          List.of("w.ndjson", "w.ndjson.1", "w.ndjson.2"),
          paths.stream().map(entry -> entry.getFileName().toString()).toList());
      for (Path entry : paths) {
        assertTrue(Files.size(entry) <= 400);
      }
    }
    List<String> current = Files.readAllLines(path);
    assertTrue(current.get(current.size() - 1).contains("\"body\":\"record \\\"11\\\"\\n\""));
  }
}
