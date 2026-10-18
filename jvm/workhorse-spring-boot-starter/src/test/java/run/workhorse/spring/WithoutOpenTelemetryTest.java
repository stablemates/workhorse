package run.workhorse.spring;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.lang.reflect.Type;
import java.util.UUID;
import java.util.concurrent.TimeUnit;
import org.jspecify.annotations.Nullable;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import run.workhorse.Admin;
import run.workhorse.EnqueueOptions;
import run.workhorse.HandlerContext;
import run.workhorse.Queue;
import run.workhorse.TaskHandler;
import run.workhorse.TaskState;
import run.workhorse.Worker;
import run.workhorse.WorkhorseTelemetry;
import run.workhorse.testing.ScratchDatabase;

/**
 * The starter with no OpenTelemetry jar on the class path (ADR 0103, "Telemetry"). The {@code
 * testWithoutOpenTelemetry} task runs this class on a class path without the optional API, and
 * {@code test} skips it.
 */
@Tag("without-opentelemetry")
@ExtendWith(ScratchDatabase.class)
class WithoutOpenTelemetryTest {
  /** A handler bean that returns at once. */
  static final class NoteHandler implements TaskHandler<String> {
    @Override
    public String taskType() {
      return "note.write";
    }

    @Override
    public Type payloadType() {
      return String.class;
    }

    @Override
    public @Nullable Object handle(HandlerContext ctx, String payload) {
      return null;
    }
  }

  @Test
  void runsTheClassPathWithoutTheOpenTelemetryApi() {
    assertThatThrownBy(() -> Class.forName("io.opentelemetry.api.OpenTelemetry"))
        .isInstanceOf(ClassNotFoundException.class);
  }

  @Test
  void startsTheContextAndRunsATask() {
    String queueName = Contexts.unique("without-opentelemetry");
    Contexts.database()
        .withBean(NoteHandler.class, NoteHandler::new)
        .withPropertyValues(
            "workhorse.worker.enabled=true",
            "workhorse.worker.queues=" + queueName,
            "workhorse.worker.poll-interval=50ms",
            "workhorse.worker.disable-registry=true")
        .run(
            context -> {
              assertThat(context).hasNotFailed();
              assertThat(context).hasSingleBean(Queue.class).hasSingleBean(Worker.class);
              assertThat(context).doesNotHaveBean(WorkhorseTelemetry.class);
              UUID taskId =
                  context
                      .getBean(Queue.class)
                      .enqueue(
                          "note.write", "hello", EnqueueOptions.builder().queue(queueName).build())
                      .taskId();
              Admin admin = context.getBean(Admin.class);
              long end = System.nanoTime() + TimeUnit.SECONDS.toNanos(30);
              while (admin.getTask(taskId).orElseThrow().state() != TaskState.SUCCEEDED
                  && System.nanoTime() < end) {
                Thread.sleep(20);
              }
              assertThat(admin.getTask(taskId).orElseThrow().state())
                  .isEqualTo(TaskState.SUCCEEDED);
            });
  }
}
