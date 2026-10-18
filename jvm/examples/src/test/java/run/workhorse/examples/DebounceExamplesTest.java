package run.workhorse.examples;

import static org.junit.jupiter.api.Assertions.assertEquals;

import java.sql.SQLException;
import java.time.Duration;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.TimeUnit;
import javax.sql.DataSource;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.extension.ExtendWith;
import run.workhorse.ConnectionSource;
import run.workhorse.EnqueueOutcome;
import run.workhorse.EnqueueResult;
import run.workhorse.Queue;
import run.workhorse.testing.ScratchDatabase;

/** Runs the Java snippets of the site page about debounce. */
@ExtendWith(ScratchDatabase.class)
@Timeout(value = 120, unit = TimeUnit.SECONDS)
class DebounceExamplesTest {
  private final DataSource dataSource = ExampleDatabase.dataSource();
  private final DebounceExamples examples =
      new DebounceExamples(new Queue(ConnectionSource.of(dataSource)));

  @Test
  void aSecondRevisionReplacesThePendingTask() throws SQLException {
    String documentId = "java-" + UUID.randomUUID();
    EnqueueResult first = examples.debounce(documentId, 1, Duration.ofMinutes(5));
    EnqueueResult second = examples.debounce(documentId, 2, Duration.ofMinutes(5));
    assertEquals(EnqueueOutcome.ACCEPTED, first.outcome());
    assertEquals(EnqueueOutcome.REPLACED, second.outcome());
    assertEquals(first.taskId(), second.taskId());
    // The payload holds the latest revision.
    assertEquals(
        List.of(first.taskId()),
        ExampleDatabase.tasks("search.reindex", "revision", "2").stream()
            .filter(id -> id.equals(first.taskId()))
            .toList());
    assertEquals(
        first.taskId(), ExampleDatabase.task("search.reindex", "documentId", documentId).id());
  }
}
