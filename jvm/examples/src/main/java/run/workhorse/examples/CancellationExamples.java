package run.workhorse.examples;

import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.UUID;
import javax.sql.DataSource;
import org.jspecify.annotations.Nullable;
import run.workhorse.CancelResult;
import run.workhorse.CancellationToken;
import run.workhorse.Queue;
import run.workhorse.Worker;

/** The Java tabs of the site page about cancellation. */
public final class CancellationExamples {
  private final Queue queue;
  private final DataSource dataSource;
  private final CancellationPartUploader uploader;

  /** The snippets run on this queue, and their worker uploads each part with {@code uploader}. */
  public CancellationExamples(
      Queue queue, DataSource dataSource, CancellationPartUploader uploader) {
    this.queue = queue;
    this.dataSource = dataSource;
    this.uploader = uploader;
  }

  CancelResult cancelBeforeStart(UUID taskId, CancellationActor actor) {
    // docs:start java-cancellation-cancel
    CancelResult result = queue.cancel(taskId, actor.email(), "customer withdrew the order");
    // docs:end
    return result;
  }

  /** A worker on {@code queueName} whose {@code order.upload} handler obeys the cancellation. */
  Worker uploadWorker(String queueName) {
    return Worker.builder(dataSource)
        .queues(queueName)
        .lease(Duration.ofSeconds(3))
        .handle(
            "order.upload",
            Map.class,
            (context, payload) -> {
              // docs:start java-cancellation-obey-signal
              List<?> parts = (List<?>) Objects.requireNonNull(payload.get("parts"));
              for (Object part : parts) {
                context.cancellation().throwIfCancelled();
                uploadPart(part, context.cancellation());
              }
              // docs:end
              return null;
            })
        .build();
  }

  private void uploadPart(@Nullable Object part, CancellationToken cancellation)
      throws InterruptedException {
    uploader.upload(part, cancellation);
  }
}
