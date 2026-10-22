package run.workhorse;

/**
 * The history a fast-tier queue records.
 *
 * @param recordAttempts {@code true} when the queue records attempt rows
 * @param recordClaims {@code true} when the queue records claim events
 */
public record QueueHistory(boolean recordAttempts, boolean recordClaims) {}
