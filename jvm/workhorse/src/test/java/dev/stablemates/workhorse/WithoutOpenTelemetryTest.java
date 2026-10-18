package dev.stablemates.workhorse;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import dev.stablemates.workhorse.internal.telemetry.Telemetry;
import dev.stablemates.workhorse.testing.ScratchDataSource;
import dev.stablemates.workhorse.testing.ScratchDatabase;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.time.Duration;
import java.util.UUID;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;

/**
 * The SDK with no OpenTelemetry jar on the class path (ADR 0103, "Telemetry"). The {@code
 * testWithoutOpenTelemetry} task runs this class on a class path without the optional API, and
 * {@code test} skips it.
 */
@Tag("without-opentelemetry")
@ExtendWith(ScratchDatabase.class)
class WithoutOpenTelemetryTest {
  private final ScratchDataSource dataSource = new ScratchDataSource(true);
  private final String queueName = "without-opentelemetry-" + UUID.randomUUID();

  @Test
  void runsTheClassPathWithoutTheOpenTelemetryApi() {
    assertThrows(
        ClassNotFoundException.class, () -> Class.forName("io.opentelemetry.api.OpenTelemetry"));
    assertThrows(
        ClassNotFoundException.class, () -> Class.forName("io.opentelemetry.context.Context"));
  }

  @Test
  void usesTheTelemetryThatRecordsNothing() {
    assertSame(Telemetry.NOOP, Telemetry.global());
    assertSame(Telemetry.NOOP, QueueOptions.defaults().telemetry().telemetry());
  }

  @Test
  void enqueuesAndRunsATaskWithoutTraceContext() throws Exception {
    Queue queue = new Queue(ConnectionSource.of(dataSource));
    UUID taskId =
        queue.enqueue("echo", "hello", EnqueueOptions.builder().queue(queueName).build()).taskId();
    Worker worker =
        Worker.builder(dataSource)
            .queues(queueName)
            .pollingOnly(true)
            .pollInterval(Duration.ofMillis(10))
            .disableRegistry(true)
            .handle("echo", String.class, (context, payload) -> payload)
            .build();
    assertTrue(worker.runOnce());
    try (Connection connection = ScratchDatabase.connect();
        PreparedStatement statement =
            connection.prepareStatement(
                "SELECT t.trace_context IS NULL, o.state FROM workhorse.task t"
                    + " LEFT JOIN workhorse.task_outcome o ON o.task_id = t.id WHERE t.id = ?")) {
      statement.setObject(1, taskId);
      try (ResultSet result = statement.executeQuery()) {
        assertTrue(result.next());
        assertTrue(result.getBoolean(1), "the task carries no trace context");
        assertEquals("succeeded", result.getString(2));
      }
    }
  }
}
