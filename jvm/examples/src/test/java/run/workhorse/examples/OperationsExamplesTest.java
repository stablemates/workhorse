package run.workhorse.examples;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.time.Duration;
import java.util.UUID;
import java.util.concurrent.TimeUnit;
import javax.sql.DataSource;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.extension.ExtendWith;
import run.workhorse.Admin;
import run.workhorse.ConnectionSource;
import run.workhorse.Worker;
import run.workhorse.WorkerPauseResult;
import run.workhorse.testing.ScratchDatabase;

/** Runs the Java snippet of the site page about operations. */
@ExtendWith(ScratchDatabase.class)
@Timeout(value = 120, unit = TimeUnit.SECONDS)
class OperationsExamplesTest {
  private final DataSource dataSource = ExampleDatabase.dataSource();

  @Test
  void theOperatorPausesTheRegisteredWorker() throws InterruptedException {
    try (Worker worker = OperationsExamplesTest.startBillingWorker(dataSource)) {
      String incidentId = "java-" + UUID.randomUUID();
      OperationsExamples.Pause pause =
          new OperationsExamples(dataSource)
              .pauseWorker(new OperationsActor("dana@example.com"), incidentId);
      assertTrue(
          pause.workers().stream()
              .anyMatch(candidate -> candidate.workerId().equals("billing-worker-1")));
      WorkerPauseResult result = pause.result().orElseThrow();
      assertTrue(result.paused());
      assertEquals("dana@example.com", result.pausedBy());
      assertEquals("investigating slow provider", result.reason());
      worker.stop();
    }
  }

  /** Starts {@code billing-worker-1} on its own thread, and waits until it registers. */
  static Worker startBillingWorker(DataSource dataSource) throws InterruptedException {
    Worker worker =
        Worker.builder(dataSource)
            .queues("operations-pause")
            .workerId("billing-worker-1")
            .registryInterval(Duration.ofMillis(200))
            .build();
    worker.start();
    Admin admin = new Admin(ConnectionSource.of(dataSource));
    long deadline = System.nanoTime() + ExampleDatabase.WAIT.toNanos();
    while (admin.listWorkers().stream()
        .noneMatch(candidate -> candidate.workerId().equals("billing-worker-1"))) {
      assertTrue(System.nanoTime() < deadline, "billing-worker-1 registers");
      Thread.sleep(50);
    }
    return worker;
  }
}
