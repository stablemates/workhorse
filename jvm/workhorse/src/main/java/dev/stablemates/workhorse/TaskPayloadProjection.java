package dev.stablemates.workhorse;

import java.util.List;

/**
 * How a task page projects each payload.
 *
 * @param include {@code true} to return each payload that fits in {@code maxBytes}
 * @param maxBytes the largest payload that the page includes, 1 to 1,048,576 bytes
 * @param redactKeys at most 50 unique top-level keys of 1 to 200 characters that the page removes
 *     from each payload
 */
public record TaskPayloadProjection(boolean include, int maxBytes, List<String> redactKeys) {
  private static final TaskPayloadProjection DEFAULTS =
      new TaskPayloadProjection(false, 16_384, List.of());

  /** Copies the redacted keys. */
  public TaskPayloadProjection {
    redactKeys = List.copyOf(redactKeys);
  }

  /** The projection that omits every payload. */
  public static TaskPayloadProjection defaults() {
    return DEFAULTS;
  }
}
