package run.workhorse;

import java.time.Instant;
import org.jspecify.annotations.Nullable;

/**
 * The durable pause state of one worker after a pause or a resume.
 *
 * @param workerId the worker
 * @param paused {@code true} when the worker claims no new task
 * @param pausedBy who paused the worker, or {@code null}
 * @param reason why, or {@code null}
 * @param pausedAt when the worker was paused, or {@code null}
 * @param lastHeartbeatAt the last heartbeat of the worker
 */
public record WorkerPauseResult(
    String workerId,
    boolean paused,
    @Nullable String pausedBy,
    @Nullable String reason,
    @Nullable Instant pausedAt,
    Instant lastHeartbeatAt) {}
