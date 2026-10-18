package run.workhorse.spring;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;

import io.opentelemetry.api.OpenTelemetry;
import io.opentelemetry.sdk.trace.data.SpanData;
import java.lang.reflect.Type;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.TimeUnit;
import javax.sql.DataSource;
import org.jspecify.annotations.Nullable;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.springframework.boot.autoconfigure.AutoConfigurations;
import org.springframework.boot.opentelemetry.autoconfigure.OpenTelemetrySdkAutoConfiguration;
import run.workhorse.Admin;
import run.workhorse.EnqueueOptions;
import run.workhorse.HandlerContext;
import run.workhorse.Queue;
import run.workhorse.TaskHandler;
import run.workhorse.TaskState;
import run.workhorse.WorkhorseTelemetry;
import run.workhorse.testing.RecordingOpenTelemetry;
import run.workhorse.testing.ScratchDatabase;

/** The telemetry on the application's {@code OpenTelemetry} bean (ADR 0103, "Telemetry"). */
@ExtendWith(ScratchDatabase.class)
class TelemetryTest {
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

  private final RecordingOpenTelemetry recording = new RecordingOpenTelemetry();

  @AfterEach
  void close() {
    recording.close();
  }

  private static List<SpanData> waitForSpans(RecordingOpenTelemetry recording, String name)
      throws InterruptedException {
    long end = System.nanoTime() + TimeUnit.SECONDS.toNanos(30);
    while (recording.spans(name).isEmpty() && System.nanoTime() < end) {
      Thread.sleep(20);
    }
    return recording.spans(name);
  }

  @Test
  void theQueueAndTheWorkerReportToTheOpenTelemetryBean() {
    String queueName = Contexts.unique("telemetry");
    Contexts.database()
        .withBean(OpenTelemetry.class, recording::sdk)
        .withBean(NoteHandler.class, NoteHandler::new)
        .withPropertyValues(
            "workhorse.worker.enabled=true",
            "workhorse.worker.queues=" + queueName,
            "workhorse.worker.poll-interval=50ms",
            "workhorse.worker.disable-registry=true")
        .run(
            context -> {
              assertThat(context).hasSingleBean(WorkhorseTelemetry.class);
              UUID taskId =
                  context
                      .getBean(Queue.class)
                      .enqueue(
                          "note.write", "hello", EnqueueOptions.builder().queue(queueName).build())
                      .taskId();
              List<SpanData> enqueue = waitForSpans(recording, "workhorse.enqueue");
              List<SpanData> handler = waitForSpans(recording, "workhorse.handler");
              assertThat(context.getBean(Admin.class).getTask(taskId).orElseThrow().state())
                  .isEqualTo(TaskState.SUCCEEDED);
              assertThat(enqueue).hasSize(1);
              assertThat(handler).hasSize(1);
              // The handler span continues the trace of the enqueue, so both came from the bean.
              assertThat(handler.get(0).getTraceId()).isEqualTo(enqueue.get(0).getTraceId());
            });
  }

  @Test
  void usesTheOpenTelemetryBeanOfSpringBootsAutoConfiguration() {
    // Spring Boot's auto-configuration defines the bean. Without the ordering, the starter would
    // evaluate its condition first and find no bean.
    Contexts.runner()
        .withConfiguration(AutoConfigurations.of(OpenTelemetrySdkAutoConfiguration.class))
        .withBean(DataSource.class, () -> mock(DataSource.class))
        .run(
            context -> {
              assertThat(context).hasSingleBean(OpenTelemetry.class);
              assertThat(context).hasSingleBean(WorkhorseTelemetry.class);
            });
  }

  @Test
  void buildsNoTelemetryWithoutAnOpenTelemetryBean() {
    Contexts.runner()
        .withBean(DataSource.class, () -> mock(DataSource.class))
        .run(
            context -> {
              assertThat(context).hasSingleBean(Queue.class);
              assertThat(context).doesNotHaveBean(WorkhorseTelemetry.class);
            });
  }

  @Test
  void backsOffForTheApplicationsOwnTelemetry() {
    WorkhorseTelemetry own = WorkhorseTelemetry.of(OpenTelemetry.noop());
    Contexts.runner()
        .withBean(DataSource.class, () -> mock(DataSource.class))
        .withBean(OpenTelemetry.class, recording::sdk)
        .withBean(WorkhorseTelemetry.class, () -> own)
        .run(context -> assertThat(context.getBean(WorkhorseTelemetry.class)).isSameAs(own));
  }

  @Test
  void buildsNoTelemetryForTwoOpenTelemetryBeans() {
    Contexts.runner()
        .withBean(DataSource.class, () -> mock(DataSource.class))
        .withBean("first", OpenTelemetry.class, recording::sdk)
        .withBean("second", OpenTelemetry.class, OpenTelemetry::noop)
        .run(
            context -> {
              assertThat(context).hasSingleBean(Queue.class);
              assertThat(context).doesNotHaveBean(WorkhorseTelemetry.class);
            });
  }
}
