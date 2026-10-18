package run.workhorse;

import java.time.Duration;
import java.time.Instant;
import java.util.UUID;
import org.jspecify.annotations.Nullable;

/**
 * One durable wait of a task.
 *
 * @param taskId the task
 * @param name the wait name
 * @param mode how the wait sets its wake time
 * @param duration the requested duration of a relative wait, or {@code null}
 * @param requestedWakeAt the requested wake time of an absolute wait, or {@code null}
 * @param wakeAt the wake time that PostgreSQL set
 * @param attempt the attempt that scheduled the wait
 * @param fenceToken the fence token of that attempt
 * @param workerId the worker that scheduled the wait
 * @param createdAt when the wait was scheduled
 */
public record TaskWait(
    UUID taskId,
    String name,
    TaskWaitMode mode,
    @Nullable Duration duration,
    @Nullable Instant requestedWakeAt,
    Instant wakeAt,
    int attempt,
    long fenceToken,
    String workerId,
    Instant createdAt) {}
