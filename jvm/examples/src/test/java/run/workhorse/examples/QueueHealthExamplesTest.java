package run.workhorse.examples;

import static org.junit.jupiter.api.Assertions.assertInstanceOf;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.List;
import java.util.Map;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.extension.ExtendWith;
import run.workhorse.ConnectionSource;
import run.workhorse.Queue;
import run.workhorse.QueueHealth;
import run.workhorse.testing.ScratchDatabase;

/** Runs the Java snippets of the site page about queue health. */
@ExtendWith(ScratchDatabase.class)
@Timeout(value = 120, unit = TimeUnit.SECONDS)
class QueueHealthExamplesTest {
  private final Queue queue = new Queue(ConnectionSource.of(ExampleDatabase.dataSource()));

  @Test
  void theVerdictHasALevelAndReasons() {
    QueueHealth health = new QueueHealthExamples(queue).checkHealth();
    Map<?, ?> status = assertInstanceOf(Map.class, health.snapshot().get("status"));
    assertTrue(List.of("healthy", "degraded", "critical").contains(status.get("level")));
    assertInstanceOf(List.class, status.get("reasons"));
  }
}
