package run.workhorse.dashboard;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;

import io.opentelemetry.api.common.AttributeKey;
import io.opentelemetry.api.logs.Severity;
import io.opentelemetry.sdk.logs.data.LogRecordData;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import run.workhorse.ConnectionSource;
import run.workhorse.internal.telemetry.OpenTelemetryTelemetry;
import run.workhorse.testing.RecordingOpenTelemetry;
import run.workhorse.testing.ScratchDataSource;
import run.workhorse.testing.ScratchDatabase;

/**
 * The TypeScript dashboard calls the queue, which writes one record for each cancel, signal, and
 * human wait. The Java dashboard runs the statements itself, so it writes the same records.
 */
@ExtendWith(ScratchDatabase.class)
class DashboardLogsDatabaseTest {
  private final ScratchDataSource dataSource = new ScratchDataSource(true);
  private final RecordingOpenTelemetry recording = new RecordingOpenTelemetry();

  @AfterEach
  void close() {
    recording.close();
  }

  @Test
  void writesTheQueueRecordsOfACancelASignalAndAHumanWait() {
    Backend backend =
        new Backend(
            ConnectionSource.of(dataSource),
            "test",
            List.of(),
            Map.of(),
            false,
            Duration.ofSeconds(15),
            false,
            OpenTelemetryTelemetry.of(recording.sdk()));
    String missing = UUID.randomUUID().toString();
    Map<String, Backend.Procedure> procedures = backend.procedures();

    assertThrows(
        DashboardRpcException.class,
        () -> procedures.get("cancelTask").call(Map.of("id", missing, "audit", Map.of()), "ops"));
    assertThrows(
        DashboardRpcException.class,
        () ->
            procedures
                .get("signalTask")
                .call(
                    Map.of(
                        "id",
                        missing,
                        "name",
                        "approval",
                        "payload",
                        Map.of("secret", "never-log-this"),
                        "idempotencyKey",
                        "key-1"),
                    "ops"));
    assertThrows(
        DashboardRpcException.class,
        () ->
            procedures
                .get("completeHumanWait")
                .call(
                    Map.of(
                        "id",
                        missing,
                        "name",
                        "review",
                        "result",
                        Map.of("secret", "never-log-this"),
                        "idempotencyKey",
                        "key-2"),
                    "ops"));

    assertRecord(
        "workhorse.task.cancellation_processed",
        "Task cancellation processed",
        Map.of(
            "workhorse.task.id", missing,
            "workhorse.task.state", "not_found",
            "workhorse.operation.status", "not_found"));
    assertRecord(
        "workhorse.task.signal_processed",
        "Task signal processed",
        Map.of(
            "workhorse.task.id", missing,
            "workhorse.signal.name", "approval",
            "workhorse.signal.status", "not_found"));
    assertRecord(
        "workhorse.task.human_wait_processed",
        "Human wait completion processed",
        Map.of(
            "workhorse.task.id", missing,
            "workhorse.human_wait.name", "review",
            "workhorse.human_wait.status", "not_found"));
  }

  private void assertRecord(String event, String body, Map<String, String> attributes) {
    List<LogRecordData> logs = recording.logs(event);
    assertEquals(1, logs.size(), event + " records");
    LogRecordData log = logs.get(0);
    assertEquals(Severity.INFO, log.getSeverity());
    assertEquals(body, log.getBodyValue().asString());
    Map<AttributeKey<?>, Object> expected = new java.util.HashMap<>();
    attributes.forEach((key, value) -> expected.put(AttributeKey.stringKey(key), value));
    assertEquals(expected, log.getAttributes().asMap());
    assertFalse(log.toString().contains("never-log-this"), log.toString());
  }
}
