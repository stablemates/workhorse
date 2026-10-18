package run.workhorse;

import java.time.Instant;
import java.util.List;
import java.util.UUID;
import org.jspecify.annotations.Nullable;

/**
 * One registered worker. The counterpart of Ruby's {@code WorkerRegistryEntry}.
 *
 * @param workerId the worker
 * @param paused {@code true} when the worker claims no new task
 * @param pausedBy who paused the worker, or {@code null}
 * @param reason why, or {@code null}
 * @param pausedAt when the worker was paused, or {@code null}
 * @param lastHeartbeatAt the last heartbeat of the worker
 * @param instanceId the process instance of the worker
 * @param hostname the host of the worker
 * @param pid the process ID of the worker
 * @param queues the queues that the worker claims from
 * @param queue the first queue of the worker
 * @param concurrency the handler limit of the worker
 * @param activeSlots the handlers that run now
 * @param draining {@code true} when the worker stops
 * @param startedAt when the worker started
 */
public record WorkerInfo(
    String workerId,
    boolean paused,
    @Nullable String pausedBy,
    @Nullable String reason,
    @Nullable Instant pausedAt,
    Instant lastHeartbeatAt,
    UUID instanceId,
    String hostname,
    int pid,
    List<String> queues,
    String queue,
    int concurrency,
    int activeSlots,
    boolean draining,
    Instant startedAt) {
  /** Copies the queues. */
  public WorkerInfo {
    queues = List.copyOf(queues);
  }
}
