package run.workhorse.examples;

import static org.junit.jupiter.api.Assertions.assertEquals;

import java.sql.SQLException;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.TimeUnit;
import javax.sql.DataSource;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.extension.ExtendWith;
import run.workhorse.ConnectionSource;
import run.workhorse.Queue;
import run.workhorse.ScheduleDefinition;
import run.workhorse.ScheduledTask;
import run.workhorse.Worker;
import run.workhorse.testing.ScratchDatabase;

/** Runs the Java snippets of the site page about schedules. */
@ExtendWith(ScratchDatabase.class)
// Each test creates and drops its own database, which is slow on a loaded host.
@Timeout(value = 240, unit = TimeUnit.SECONDS)
class SchedulesExamplesTest {
  private final DataSource dataSource = ExampleDatabase.dataSource();
  private final Queue queue = new Queue(ConnectionSource.of(dataSource));
  private final SchedulesExamples examples = new SchedulesExamples(queue, dataSource);

  @Test
  void theSynchronizationStoresTheDefinition() throws SQLException {
    examples.syncSchedules("0 2 * * *");
    assertEquals(
        Map.of(
            "cron_expression", "0 2 * * *",
            "timezone", "America/New_York",
            "queue_name", "billing",
            "task_type", "invoice.generate",
            "scope", "due",
            "configured_enabled", true),
        SchedulesExampleRows.definition("billing-production", "invoice-run"));
  }

  @Test
  void theWorkerThatOffersTheNamespaceFiresItsSchedule() throws Exception {
    // The snippet's worker reads the default queue, so the test has its own database.
    try (IsolatedExampleDatabase database =
        IsolatedExampleDatabase.create("schedules-java-worker")) {
      Queue isolated = database.queue();
      String scope = "java-" + UUID.randomUUID();
      // Each second is an occurrence, so the worker fires one at its next maintenance tick.
      isolated.syncSchedules(
          "billing-production",
          List.of(
              new ScheduleDefinition(
                  "invoice-run",
                  "* * * * * *",
                  new ScheduledTask(
                      "invoice.generate",
                      Map.of("scope", scope),
                      "billing",
                      0,
                      null,
                      null,
                      null))));
      try (Worker worker =
          new SchedulesExamples(isolated, database.dataSource()).scheduleWorker()) {
        worker.start();
        UUID taskId = SchedulesExampleRows.awaitTask(database, "invoice.generate", scope);
        assertEquals("billing", database.detail(taskId).queue());
      }
    }
  }
}
