package run.workhorse;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.lang.reflect.Proxy;
import java.sql.Connection;
import java.sql.SQLException;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicInteger;
import javax.sql.DataSource;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.function.Executable;

/**
 * SM-1883: a child set, a task group create, and a task group add check the options of every
 * request before the first statement. That statement can be a payload contract read, the
 * compatibility query, or a membership read. Each case puts a valid request before an invalid one.
 * The connections of the data source refuse each statement and count it, so a statement fails the
 * case.
 */
class BatchOptionOrderTest {
  private static final UUID TASK_ID = UUID.fromString("00000000-0000-4000-8000-000000000001");

  private final AtomicInteger statements = new AtomicInteger();
  private final Worker worker = Worker.builder(refusingDataSource()).queues("default").build();
  private final Queue queue = worker.queue();
  private final EnqueueRequest valid = EnqueueRequest.of("valid", null);
  private final EnqueueRequest invalid =
      EnqueueRequest.of("invalid", null, EnqueueOptions.builder().maxAttempts(101).build());

  private DataSource refusingDataSource() {
    return (DataSource)
        Proxy.newProxyInstance(
            DataSource.class.getClassLoader(),
            new Class<?>[] {DataSource.class},
            (proxy, method, arguments) ->
                method.getName().equals("getConnection") ? refusingConnection() : null);
  }

  /** A connection in autocommit that counts and refuses each statement. */
  private Connection refusingConnection() {
    return (Connection)
        Proxy.newProxyInstance(
            Connection.class.getClassLoader(),
            new Class<?>[] {Connection.class},
            (proxy, method, arguments) -> {
              String name = method.getName();
              if (name.startsWith("prepare") || name.equals("createStatement")) {
                statements.incrementAndGet();
                throw new SQLException("the case sent a statement");
              }
              Class<?> type = method.getReturnType();
              return type == boolean.class ? name.equals("getAutoCommit") : null;
            });
  }

  private void refused(String prefix, Executable call) {
    IllegalArgumentException error = assertThrows(IllegalArgumentException.class, call);
    assertTrue(error.getMessage().startsWith(prefix), error.getMessage());
    assertTrue(error.getMessage().contains("max attempts"), error.getMessage());
    assertEquals(0, statements.get());
  }

  private static ClaimedTask sampleTask() {
    return new ClaimedTask(
        TASK_ID, "default", "sample", 0, null, null, null, false, null, 1, 1, null, null, null,
        null, 1, null);
  }

  private HandlerContext context() {
    // The tier lookup can read PostgreSQL, so the option check must run before it.
    return new TaskContext(
        worker,
        sampleTask(),
        new TaskCancellation(),
        new Worker.Arbiter(),
        () -> {
          throw new AssertionError("the tier lookup must not run");
        });
  }

  @Test
  void aChildSetChecksEveryChildBeforeAContractRead() {
    List<ChildRequest> children =
        List.of(
            ChildRequest.of("valid", "valid", null),
            ChildRequest.of(
                "invalid", "invalid", null, EnqueueOptions.builder().maxAttempts(101).build()));
    refused("", () -> context().runChildren(children));
    refused("", () -> context().runChildrenAll(children));
  }

  @Test
  void aTaskGroupCreateChecksEveryCallbackAndMemberBeforeAStatement() {
    refused(
        "on_success callback: ",
        () -> queue.createTaskGroup(new TaskGroupCallbacks(valid, invalid, null)));
    refused(
        "on_finish callback: ",
        () ->
            queue.taskGroup(
                new TaskGroupCallbacks(invalid, null, null), group -> group.add(List.of(valid))));
    refused(
        "enqueue request 2: ",
        () ->
            queue.taskGroup(
                TaskGroupCallbacks.none(), group -> group.add(List.of(valid, invalid))));
  }

  @Test
  void aTaskGroupAddChecksEveryRequestBeforeAStatement() {
    String message = "enqueue request 2: ";
    refused(message, () -> queue.addToTaskGroup(UUID.randomUUID(), List.of(valid, invalid)));
    refused(message, () -> context().taskGroup().add(List.of(valid, invalid)));
  }
}
