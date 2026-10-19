package run.workhorse.examples;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.TimeUnit;
import javax.sql.DataSource;
import org.jspecify.annotations.Nullable;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.extension.ExtendWith;
import run.workhorse.ConnectionSource;
import run.workhorse.EnqueueOptions;
import run.workhorse.Queue;
import run.workhorse.TaskDetail;
import run.workhorse.TaskProgress;
import run.workhorse.TaskState;
import run.workhorse.Worker;
import run.workhorse.testing.ScratchDatabase;

/** Runs the Java snippet of the site page about progress under a worker. */
@ExtendWith(ScratchDatabase.class)
@Timeout(value = 120, unit = TimeUnit.SECONDS)
class ProgressExamplesTest {
  private final DataSource dataSource = ExampleDatabase.dataSource();

  @Test
  void theHandlerReportsTheLastBatch() throws InterruptedException {
    String queueName = "progress-java";
    ProgressRows rows = new ProgressRows();
    UUID taskId =
        new Queue(ConnectionSource.of(dataSource))
            .enqueue(
                "import.rows",
                Map.of("source", "rows.csv"),
                EnqueueOptions.builder().queue(queueName).build())
            .taskId();
    ProgressExamples examples = new ProgressExamples(rows);
    try (Worker worker =
        Worker.builder(dataSource)
            .queues(queueName)
            .disableRegistry(true)
            .handle("import.rows", Map.class, examples::importRows)
            .build()) {
      assertTrue(worker.runOnce());
    }

    TaskDetail task = ExampleDatabase.awaitTerminal(taskId);
    assertEquals(TaskState.SUCCEEDED, task.state());
    assertEquals(Map.of("processed", 6L), task.result());
    assertEquals(List.of("rows.csv"), rows.sources);
    assertEquals(3, rows.imported.size());
    TaskProgress progress = task.progress();
    assertNotNull(progress);
    assertEquals(Map.of("phase", "importing", "processed", 6L), progress.value());
  }

  /** Three batches of two rows. Each import waits longer than the progress rate limit. */
  static final class ProgressRows implements ProgressImporter {
    final List<@Nullable Object> sources = new ArrayList<>();
    final List<List<String>> imported = new ArrayList<>();

    @Override
    public List<List<String>> readBatches(@Nullable Object source) {
      sources.add(source);
      return List.of(List.of("a", "b"), List.of("c", "d"), List.of("e", "f"));
    }

    @Override
    public void importBatch(List<String> batch) throws InterruptedException {
      Thread.sleep(150);
      imported.add(batch);
    }
  }
}
