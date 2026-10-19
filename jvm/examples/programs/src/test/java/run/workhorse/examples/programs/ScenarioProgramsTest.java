package run.workhorse.examples.programs;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.TimeUnit;
import java.util.function.Supplier;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.extension.ExtendWith;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import run.workhorse.EnqueueOptions;
import run.workhorse.HumanWaitStatus;
import run.workhorse.JsonCodec;
import run.workhorse.Queue;
import run.workhorse.SignalStatus;
import run.workhorse.TaskDetail;
import run.workhorse.TaskState;
import run.workhorse.examples.ExampleDatabase;
import run.workhorse.examples.IsolatedExampleDatabase;
import run.workhorse.testing.ScratchDatabase;

/**
 * Runs each scenario program in a child JVM, as the Ruby documentation spec runs the programs of
 * {@code ruby/examples}. The programs use fixed queues such as {@code orders}, so each run has a
 * database of its own.
 */
@ExtendWith(ScratchDatabase.class)
@Timeout(value = 180, unit = TimeUnit.SECONDS)
class ScenarioProgramsTest {
  /** The JVM's exit status for {@code SIGTERM}: 128 plus signal 15. */
  private static final int SIGTERM_STATUS = 143;

  private static final String PACKAGE = "run.workhorse.examples.programs.";

  @Test
  void theQuickstartRunsOneTask() throws Exception {
    try (IsolatedExampleDatabase db = IsolatedExampleDatabase.create("program-quickstart");
        ProgramProcess program =
            ProgramProcess.start(PACKAGE + "QuickstartProgram", db.jdbcUrl())) {
      assertEquals(0, program.awaitExit(), program.describe());
      assertEquals("succeeded {\"deliveredTo\":\"ada@example.com\"}\n", program.output());
    }
  }

  @Test
  void theTransactionCommitsOneTask() throws Exception {
    try (IsolatedExampleDatabase db = IsolatedExampleDatabase.create("program-transaction");
        ProgramProcess program =
            ProgramProcess.start(PACKAGE + "TransactionProgram", db.jdbcUrl())) {
      assertEquals(0, program.awaitExit(), program.describe());
      UUID taskId = UUID.fromString(program.output().strip());
      TaskDetail task = db.detail(taskId);
      assertEquals(
          List.of("orders", "order.accepted", 3, Map.of("orderId", "order-42")),
          List.of(task.queue(), task.type(), task.maxAttempts(), task.payload()));
    }
  }

  @Test
  void theDedicatedWorkerRunsATaskAndDrainsOnSigterm() throws Exception {
    try (IsolatedExampleDatabase db = IsolatedExampleDatabase.create("program-dedicated");
        ProgramProcess program =
            ProgramProcess.start(PACKAGE + "DedicatedWorkerProgram", db.jdbcUrl())) {
      UUID taskId = enqueueOrder(db.queue(), "order.accepted");
      TaskDetail task = db.awaitTerminal(taskId);
      assertEquals(TaskState.SUCCEEDED, task.state(), program.describe());
      assertEquals(
          Map.of("payload", Map.of("orderId", "order-42"), "prepared", true), task.result());
      assertEquals(SIGTERM_STATUS, program.terminateRegistered(db), program.describe());
      assertEquals(0, ProgramProcess.registeredWorkers(db), "the worker drains and deregisters");
    }
  }

  @ParameterizedTest
  @ValueSource(strings = {"OrchestrationProgram", "OrchestrationProgramKt"})
  void theOrchestrationRunsChildrenASignalAndAHumanWait(String mainClass) throws Exception {
    try (IsolatedExampleDatabase db = IsolatedExampleDatabase.create("program-orchestration");
        ProgramProcess program = ProgramProcess.start(PACKAGE + mainClass, db.jdbcUrl())) {
      Queue queue = db.queue();
      UUID taskId = enqueueOrder(queue, "order.process");
      // The signal and the decision count only while the task waits for them.
      until(
          () ->
              queue
                      .sendSignal(
                          taskId, "approval", Map.of("approved", true), "approval-1", "test")
                      .status()
                  == SignalStatus.DELIVERED,
          program);
      until(
          () ->
              queue
                      .completeHumanWait(
                          taskId, "review", Map.of("decision", "ship"), "review-1", "test")
                      .status()
                  == HumanWaitStatus.COMPLETED,
          program);

      TaskDetail task = db.awaitTerminal(taskId);
      assertEquals(TaskState.SUCCEEDED, task.state(), program.describe());
      Map<String, Object> order = Map.of("orderId", "order-42");
      Map<String, Object> child = Map.of("completed", true, "payload", order);
      assertEquals(
          Map.of(
              "children", Map.of("invoice", child, "receipt", child),
              "approval", Map.of("approved", true),
              "decision", Map.of("decision", "ship")),
          task.result());
      assertEquals(SIGTERM_STATUS, program.terminateRegistered(db), program.describe());
      assertEquals(0, ProgramProcess.registeredWorkers(db), "the worker drains and deregisters");
    }
  }

  @ParameterizedTest
  @ValueSource(strings = {"AgenticFlowProgram", "AgenticFlowProgramKt"})
  void theAgenticFlowCompletesItsDurableLifecycle(String mainClass) throws Exception {
    try (IsolatedExampleDatabase db = IsolatedExampleDatabase.create("program-agentic-flow");
        ProgramProcess program = ProgramProcess.start(PACKAGE + mainClass, db.jdbcUrl())) {
      assertEquals(0, program.awaitExit(), program.describe());
      Map<?, ?> outcome = JsonCodec.standard().decode(program.output(), Map.class);
      Map<?, ?> result = (Map<?, ?>) outcome.get("result");
      Map<?, ?> response = (Map<?, ?>) result.get("response");
      assertEquals(
          List.of(
              "completed",
              Map.of("stage", "finalizing"),
              "Approved answer for Explain durable agent execution: durable context for Explain"
                  + " durable agent execution; total=31"),
          List.of(result.get("status"), outcome.get("progress"), response.get("text")),
          program.describe());
    }
  }

  private static UUID enqueueOrder(Queue queue, String taskType) {
    return queue
        .enqueue(
            taskType,
            Map.of("orderId", "order-42"),
            EnqueueOptions.builder().queue("orders").build())
        .taskId();
  }

  private static void until(Supplier<Boolean> condition, ProgramProcess program)
      throws InterruptedException {
    long deadline = System.nanoTime() + ExampleDatabase.WAIT.toNanos();
    while (!condition.get()) {
      assertTrue(System.nanoTime() < deadline, "the condition holds; " + program.describe());
      Thread.sleep(50);
    }
  }
}
