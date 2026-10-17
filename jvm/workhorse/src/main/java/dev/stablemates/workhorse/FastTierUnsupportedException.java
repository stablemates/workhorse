package dev.stablemates.workhorse;

import org.jspecify.annotations.Nullable;

/** SQLSTATE P1007: a request and a queue's tier disagree (ADR 0077). */
public final class FastTierUnsupportedException extends WorkhorseException {
  private static final long serialVersionUID = 1L;

  private final String queue;
  private final String feature;
  private final @Nullable Long ordinal;

  /** An exception for the queue, the feature, and the position of the request, if any. */
  public FastTierUnsupportedException(String queue, String feature, @Nullable Long ordinal) {
    super("Fast-tier queue " + queue + " does not support " + feature);
    this.queue = queue;
    this.feature = feature;
    this.ordinal = ordinal;
  }

  /** The fast-tier queue. */
  public String queue() {
    return queue;
  }

  /** The feature the queue does not support. */
  public String feature() {
    return feature;
  }

  /** The 1-based position of the rejected request in an enqueue batch, or {@code null}. */
  public @Nullable Long ordinal() {
    return ordinal;
  }
}
