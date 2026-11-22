package run.workhorse;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import io.opentelemetry.api.GlobalOpenTelemetry;
import java.time.Duration;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import run.workhorse.internal.telemetry.Names;
import run.workhorse.testing.RecordingOpenTelemetry;
import run.workhorse.testing.ScratchDataSource;
import run.workhorse.testing.ScratchDatabase;

/**
 * A queue, an admin client, and a worker with the default telemetry record through the global
 * OpenTelemetry instance. The application registers that instance after it builds and uses them.
 * The TypeScript SDK reads its telemetry provider at each use in the same way.
 */
@ExtendWith(ScratchDatabase.class)
class GlobalTelemetryDatabaseTest {
  private final ScratchDataSource dataSource = new ScratchDataSource(true);
  private final RecordingOpenTelemetry recording = new RecordingOpenTelemetry();
  private final String queueName = "global-telemetry-" + UUID.randomUUID();

  @BeforeEach
  void reset() {
    GlobalOpenTelemetry.resetForTest();
  }

  @AfterEach
  void close() {
    GlobalOpenTelemetry.resetForTest();
    recording.close();
  }

  private static AdminAudit audit() {
    return new AdminAudit("operator", "global telemetry", UUID.randomUUID().toString());
  }

  @Test
  void recordsThroughAGlobalInstanceThatTheApplicationRegistersAfterTheFirstUse() {
    ConnectionSource connections = ConnectionSource.of(dataSource);
    Queue queue = new Queue(connections);
    Admin admin = new Admin(connections);
    Worker worker =
        Worker.builder(dataSource)
            .queues(queueName)
            .pollingOnly(true)
            .pollInterval(Duration.ofMillis(10))
            .disableRegistry(true)
            .handle("email.send", Object.class, (context, payload) -> null)
            .build();
    EnqueueOptions options = EnqueueOptions.builder().queue(queueName).build();

    queue.enqueue("email.send", Map.of(), options);
    admin.pauseQueue(queueName, audit());
    admin.resumeQueue(queueName, audit());
    assertTrue(worker.runOnce());

    assertFalse(GlobalOpenTelemetry.isSet());
    GlobalOpenTelemetry.set(recording.sdk());

    queue.enqueue("email.send", Map.of(), options);
    admin.pauseQueue(queueName, audit());
    admin.resumeQueue(queueName, audit());
    assertTrue(worker.runOnce());

    assertEquals(1, recording.spans(Names.SPAN_ENQUEUE).size());
    assertEquals(1, recording.spans(Names.SPAN_HANDLER).size());
    assertEquals(1, recording.logs("workhorse.queue.paused").size());
    assertEquals(1, recording.logs("workhorse.queue.resumed").size());
    assertTrue(
        recording.metrics().stream()
            .anyMatch(metric -> metric.getName().equals("workhorse.tasks.claimed")));
  }
}
