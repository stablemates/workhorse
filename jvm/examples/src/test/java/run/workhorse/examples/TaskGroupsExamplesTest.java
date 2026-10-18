package run.workhorse.examples;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.sql.SQLException;
import java.time.Duration;
import java.util.Arrays;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.UUID;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.TimeUnit;
import java.util.stream.IntStream;
import javax.sql.DataSource;
import org.jspecify.annotations.Nullable;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.extension.ExtendWith;
import run.workhorse.EnqueueOptions;
import run.workhorse.EnqueueRequest;
import run.workhorse.Queue;
import run.workhorse.TaskDetail;
import run.workhorse.TaskGroup;
import run.workhorse.TaskGroupCallbackKind;
import run.workhorse.TaskGroupCallbacks;
import run.workhorse.TaskGroupResult;
import run.workhorse.TaskGroupState;
import run.workhorse.TaskState;
import run.workhorse.Worker;
import run.workhorse.testing.ScratchDatabase;

/** Runs the Java snippets of the site page about task groups under real workers. */
@ExtendWith(ScratchDatabase.class)
@Timeout(value = 120, unit = TimeUnit.SECONDS)
class TaskGroupsExamplesTest {
  // The workers read `imports` and `import-rows`, which the Kotlin tests also use, so each test has
  // its own database.
  private final IsolatedExampleDatabase database;
  private final DataSource dataSource;
  private final Queue queue;
  private final List<List<@Nullable Object>> reports = new CopyOnWriteArrayList<>();
  private final TaskGroupsExamples examples;

  TaskGroupsExamplesTest() throws Exception {
    database = IsolatedExampleDatabase.create("task-groups-java");
    dataSource = database.dataSource();
    queue = database.queue();
    examples =
        new TaskGroupsExamples(
            dataSource,
            queue,
            (importId, succeeded, failed) ->
                reports.add(Arrays.asList(importId, succeeded, failed)));
  }

  @AfterEach
  void dropDatabase() throws SQLException {
    database.close();
  }

  @Test
  void theGroupHoldsEveryRowAndEnqueuesTheReportWhenItFinishes() throws Exception {
    // 1,001 rows take two add calls of the builder.
    List<String> rows = IntStream.range(0, 1_001).mapToObj(index -> "row-" + index).toList();
    TaskGroup group = examples.importRows(new TaskGroupsImportFile(rows));
    assertEquals(TaskGroupState.SEALED, group.state());
    assertEquals(1_001, group.counts().total());
    assertEquals(TaskGroupCallbackKind.ON_FINISH, group.callbacks().get(0).kind());

    try (Worker worker =
        Worker.builder(dataSource)
            .queues("imports")
            .concurrency(32)
            .pollInterval(Duration.ofMillis(50))
            .handle("imports.row", Map.class, (context, row) -> null)
            .handle("imports.report", Map.class, (context, report) -> Map.of("sent", true))
            .build()) {
      worker.start();
      TaskGroup finished = awaitFinished(group.id());
      assertEquals(TaskGroupResult.SUCCEEDED, finished.result());
      assertEquals(1_001, finished.counts().succeeded());
      TaskDetail report = database.awaitTerminal(callbackTask(finished));
      assertEquals("imports.report", report.type());
      assertEquals("imports", report.queue());
      assertEquals(TaskState.SUCCEEDED, report.state());
    }
  }

  @Test
  void theReportHandlerReadsTheCountsOfItsGroup() throws Exception {
    EnqueueOptions rows = EnqueueOptions.builder().queue("import-rows").maxAttempts(1).build();
    EnqueueRequest report =
        EnqueueRequest.of(
            "imports.report",
            Map.of("importId", "imp-7"),
            EnqueueOptions.builder().queue("imports").build());
    TaskGroup group =
        queue
            .taskGroup(
                new TaskGroupCallbacks(report, null, null),
                builder ->
                    builder.add(
                        List.of(
                            EnqueueRequest.of("imports.row", Map.of("row", "good"), rows),
                            EnqueueRequest.of("imports.row", Map.of("row", "bad"), rows))))
            .group();

    try (Worker rowWorker =
            Worker.builder(dataSource)
                .queues("import-rows")
                .pollInterval(Duration.ofMillis(50))
                .handle(
                    "imports.row",
                    Map.class,
                    (context, row) -> {
                      if ("bad".equals(row.get("row"))) {
                        throw new IllegalArgumentException("the row has no email");
                      }
                      return null;
                    })
                .build();
        Worker reportWorker = examples.reportWorker()) {
      rowWorker.start();
      reportWorker.start();
      TaskDetail done = database.awaitTerminal(callbackTask(awaitFinished(group.id())));
      assertEquals(TaskState.SUCCEEDED, done.state());
      assertEquals(Map.of("sent", true), done.result());
      assertEquals(List.of(List.of("imp-7", 1L, 1L)), reports);
    }
  }

  private UUID callbackTask(TaskGroup group) {
    return Objects.requireNonNull(group.callbacks().get(0).taskId());
  }

  private TaskGroup awaitFinished(UUID groupId) throws InterruptedException {
    long deadline = System.nanoTime() + ExampleDatabase.WAIT.toNanos();
    while (true) {
      TaskGroup group = queue.getTaskGroup(groupId).orElseThrow();
      if (group.state() == TaskGroupState.FINISHED) {
        return group;
      }
      assertTrue(System.nanoTime() < deadline, "group " + groupId + " is still " + group.state());
      Thread.sleep(50);
    }
  }
}
