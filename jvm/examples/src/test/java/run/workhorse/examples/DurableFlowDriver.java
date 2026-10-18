package run.workhorse.examples;

import static org.junit.jupiter.api.Assertions.assertTrue;

import java.sql.Connection;
import java.sql.SQLException;
import java.sql.Statement;
import java.time.Duration;
import java.util.UUID;
import javax.sql.DataSource;
import org.jspecify.annotations.Nullable;
import run.workhorse.ConnectionSource;
import run.workhorse.EnqueueOptions;
import run.workhorse.HumanWaitStatus;
import run.workhorse.Queue;
import run.workhorse.SignalStatus;
import run.workhorse.TaskDetail;
import run.workhorse.TaskState;
import run.workhorse.Worker;
import run.workhorse.testing.ScratchDatabase;

/**
 * Drives the durable handlers of the snippet tests on one private queue. Each pass runs the
 * maintenance tick and then one {@link Worker#runOnce}, so a test does not wait for a background
 * worker.
 */
public final class DurableFlowDriver {
  private final Queue queue;
  private final String queueName = "durable-" + UUID.randomUUID();

  /** A driver for the scratch database behind {@code dataSource}. */
  public DurableFlowDriver(DataSource dataSource) {
    this.queue = new Queue(ConnectionSource.of(dataSource));
  }

  /** The private queue of this driver. */
  public String queueName() {
    return queueName;
  }

  /** A worker builder for the private queue, with no background loop and a short retry delay. */
  public Worker.Builder builder(DataSource dataSource) {
    return Worker.builder(dataSource)
        .queues(queueName)
        .pollingOnly(true)
        .pollInterval(Duration.ofMillis(10))
        .disableRegistry(true)
        .retryDelay((attempt, task) -> Duration.ofMillis(10));
  }

  /** Enqueues one task on the private queue, with at most two attempts. */
  public UUID enqueue(String taskType, @Nullable Object payload) {
    return queue
        .enqueue(
            taskType, payload, EnqueueOptions.builder().queue(queueName).maxAttempts(2).build())
        .taskId();
  }

  /** Runs passes until the signal {@code name} reaches the task. */
  public void deliverSignal(Worker worker, UUID taskId, String name, @Nullable Object payload)
      throws SQLException, InterruptedException {
    long deadline = deadline();
    for (int pass = 0; ; pass++) {
      pass(worker);
      SignalStatus status =
          queue.sendSignal(taskId, name, payload, name + "-" + pass, "snippet-test").status();
      if (status == SignalStatus.DELIVERED) {
        return;
      }
      assertTrue(System.nanoTime() < deadline, "the task does not wait for " + name);
      Thread.sleep(20);
    }
  }

  /** Runs passes until the decision for the human wait {@code name} reaches the task. */
  public void completeHumanWait(Worker worker, UUID taskId, String name, @Nullable Object result)
      throws SQLException, InterruptedException {
    long deadline = deadline();
    for (int pass = 0; ; pass++) {
      pass(worker);
      HumanWaitStatus status =
          queue
              .completeHumanWait(taskId, name, result, name + "-" + pass, "snippet-operator")
              .status();
      if (status == HumanWaitStatus.COMPLETED) {
        return;
      }
      assertTrue(System.nanoTime() < deadline, "the task does not wait for " + name);
      Thread.sleep(20);
    }
  }

  /** Runs passes until the task ends, and returns its detail. */
  public TaskDetail finish(Worker worker, UUID taskId) throws SQLException, InterruptedException {
    long deadline = deadline();
    while (true) {
      TaskDetail detail = ExampleDatabase.detail(taskId);
      if (detail.state() == TaskState.SUCCEEDED
          || detail.state() == TaskState.FAILED
          || detail.state() == TaskState.CANCELED) {
        return detail;
      }
      assertTrue(System.nanoTime() < deadline, "task " + taskId + " is still " + detail.state());
      if (!pass(worker)) {
        Thread.sleep(20);
      }
    }
  }

  private static boolean pass(Worker worker) throws SQLException {
    try (Connection connection = ScratchDatabase.connect();
        Statement statement = connection.createStatement()) {
      statement.execute("SELECT * FROM workhorse.tick_v1(100, 100)");
    }
    return worker.runOnce();
  }

  private static long deadline() {
    return System.nanoTime() + ExampleDatabase.WAIT.toNanos();
  }
}
