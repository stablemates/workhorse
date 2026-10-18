package run.workhorse;

import java.time.Instant;
import java.util.UUID;
import org.jspecify.annotations.Nullable;

/**
 * PostgreSQL's disposition for a signal.
 *
 * @param status the disposition
 * @param taskId the task
 * @param name the signal name
 * @param payload the delivered payload, or {@code null}
 * @param deliveredAt when the signal was delivered, or {@code null}
 * @param deliveredBy who delivered it, or {@code null}
 */
public record SignalDeliveryResult(
    SignalStatus status,
    UUID taskId,
    String name,
    @Nullable Object payload,
    @Nullable Instant deliveredAt,
    @Nullable String deliveredBy) {}
