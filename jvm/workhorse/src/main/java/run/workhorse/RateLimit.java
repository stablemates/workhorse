package run.workhorse;

import java.time.Duration;

/**
 * A token bucket: {@code limit} admissions for each {@code interval}, with at most {@code burst} in
 * reserve. PostgreSQL stores the interval in whole milliseconds.
 *
 * @param limit admissions for each interval, 1 to 1,000,000
 * @param interval the interval, 1 millisecond to 1 day
 * @param burst the reserve, 1 to 1,000,000
 */
public record RateLimit(int limit, Duration interval, int burst) {}
