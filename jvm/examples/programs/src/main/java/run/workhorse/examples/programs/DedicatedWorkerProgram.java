package run.workhorse.examples.programs;

import java.time.Duration;
import java.util.HashMap;
import java.util.Map;
import org.jspecify.annotations.Nullable;
import run.workhorse.Worker;
import run.workhorse.WorkerProcess;

/**
 * Runs a dedicated worker process until SIGINT or SIGTERM, then drains its active tasks.
 *
 * <p>Documentation: https://workhorse.run/docs/worker-processes
 */
public final class DedicatedWorkerProgram {
  private DedicatedWorkerProgram() {}

  public static void main(String[] arguments) {
    Worker worker =
        Worker.builder(Programs.dataSource("WORKHORSE_DATABASE_URL"))
            .queues("orders")
            .workerId("orders-worker")
            .concurrency(8)
            .shutdownGrace(Duration.ofSeconds(20))
            .handle(
                "order.accepted",
                Map.class,
                (context, payload) -> {
                  context.cancellation().throwIfCancelled();
                  Map<String, @Nullable Object> result = new HashMap<>();
                  result.put("payload", payload);
                  result.put("prepared", true);
                  return result;
                })
            .build();
    WorkerProcess.runWorkerProcess(worker);
  }
}
