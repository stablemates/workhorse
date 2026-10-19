package run.workhorse.examples;

import java.util.List;
import java.util.Map;
import javax.sql.DataSource;
import run.workhorse.CatchupPolicy;
import run.workhorse.Queue;
import run.workhorse.ScheduleDefinition;
import run.workhorse.ScheduledTask;
import run.workhorse.Worker;

/** The Java tabs of the site page about schedules. */
public final class SchedulesExamples {
  private final Queue queue;
  private final DataSource dataSource;

  /** The snippets run on this queue and build their worker on this data source. */
  public SchedulesExamples(Queue queue, DataSource dataSource) {
    this.queue = queue;
    this.dataSource = dataSource;
  }

  void syncSchedules(String nightlyCron) {
    // docs:start java-schedules-sync
    ScheduledTask task =
        new ScheduledTask(
            "invoice.generate", Map.of("scope", "due"), "billing", 0, null, null, null);
    queue.syncSchedules(
        "billing-production",
        List.of(
            new ScheduleDefinition(
                "invoice-run", nightlyCron, task, "America/New_York", CatchupPolicy.SKIP, true)));
    // docs:end
  }

  Worker scheduleWorker() {
    // docs:start java-schedules-namespaces
    Worker worker = Worker.builder(dataSource).scheduleNamespaces("billing-production").build();
    // docs:end
    return worker;
  }
}
