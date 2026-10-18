package run.workhorse;

import java.time.Duration;

/**
 * Retains one canonical request under a scoped key for {@code ttl}.
 *
 * @param key the idempotency key, 1 to 512 UTF-8 bytes
 * @param scope the scope of the key, {@code "default"} by default
 * @param ttl how long PostgreSQL retains the request, one day by default; zero takes the default
 */
public record Idempotency(String key, String scope, Duration ttl) {
  /** A key in the default scope, retained for one day. */
  public Idempotency(String key) {
    this(key, "default", Duration.ofDays(1));
  }
}
