package run.workhorse.examples;

import java.util.List;
import java.util.Map;
import javax.sql.DataSource;
import run.workhorse.EnqueueOptions;
import run.workhorse.EnqueueRequest;
import run.workhorse.Queue;
import run.workhorse.TaskGroup;
import run.workhorse.TaskGroupCallbacks;
import run.workhorse.TaskGroupCounts;
import run.workhorse.Worker;

/** The Java tabs of the site page about task groups. */
public final class TaskGroupsExamples {
  private final DataSource dataSource;
  private final Queue queue;
  private final TaskGroupsReporter reporter;

  /** The snippets enqueue on this queue, and their worker reports to this reporter. */
  public TaskGroupsExamples(DataSource dataSource, Queue queue, TaskGroupsReporter reporter) {
    this.dataSource = dataSource;
    this.queue = queue;
    this.reporter = reporter;
  }

  /** Creates and seals a group with one task for each row of the file. */
  public TaskGroup importRows(TaskGroupsImportFile file) {
    // docs:start java-task-groups-create
    EnqueueOptions imports = EnqueueOptions.builder().queue("imports").build();
    List<EnqueueRequest> rows =
        file.rows().stream()
            .map(
                row ->
                    EnqueueRequest.of(
                        "imports.row", Map.of("importId", "imp-7", "row", row), imports))
            .toList();
    EnqueueRequest report =
        EnqueueRequest.of("imports.report", Map.of("importId", "imp-7"), imports);

    TaskGroup group =
        queue
            .taskGroup(
                new TaskGroupCallbacks(report, null, null),
                builder -> {
                  for (int start = 0; start < rows.size(); start += 1_000) {
                    builder.add(rows.subList(start, Math.min(start + 1_000, rows.size())));
                  }
                })
            .group();
    // docs:end
    return group;
  }

  /** Builds a worker that sends the report of a group, and does not run it. */
  public Worker reportWorker() {
    // docs:start java-task-groups-read-counts
    Worker worker =
        Worker.builder(dataSource)
            .queues("imports")
            .handle(
                "imports.report",
                Map.class,
                (context, report) -> {
                  TaskGroupCounts counts = context.taskGroup().get().orElseThrow().group().counts();
                  reporter.send(report.get("importId"), counts.succeeded(), counts.failed());
                  return Map.of("sent", true);
                })
            .build();
    // docs:end
    return worker;
  }
}
