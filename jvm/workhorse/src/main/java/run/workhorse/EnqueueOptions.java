package run.workhorse;

import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import org.jspecify.annotations.Nullable;

/**
 * The options of one enqueue request. Each field is a keyword of Ruby's {@code Queue#enqueue}, and
 * {@code null} takes that keyword's default.
 *
 * <p>Set at most one of {@code idempotency}, {@code debounce}, and {@code throttle}. A debounce
 * uses its PostgreSQL-owned window instead of {@code runAt}. Debounce and throttle cannot combine
 * with {@code dependencies}.
 *
 * @param queue the queue, or {@code null} for the queue's default queue
 * @param priority the priority, 0 to 100, or {@code null} for 0
 * @param concurrencyKey the concurrency key, or {@code null}
 * @param budget the named budget, or {@code null}
 * @param runAt the earliest run time, or {@code null} for now
 * @param deadline the absolute deadline, or {@code null}
 * @param executionTimeout the timeout of each attempt, or {@code null} or zero for none
 * @param maxAttempts the attempt limit, 1 to 100, or {@code null} or 0 for 25
 * @param retryPolicy the persisted retry policy, such as {@code {"type": "fixed", "delayMs":
 *     1000}}, or {@code null}
 * @param tags at most 20 tags of 1 to 100 characters
 * @param idempotency the enqueue idempotency, or {@code null}
 * @param debounce the keyed debounce, or {@code null}
 * @param throttle the keyed throttle, or {@code null}
 * @param dependencies the prerequisite tasks, or {@code null}
 */
public record EnqueueOptions(
    @Nullable String queue,
    @Nullable Integer priority,
    @Nullable String concurrencyKey,
    @Nullable String budget,
    @Nullable Instant runAt,
    @Nullable Instant deadline,
    @Nullable Duration executionTimeout,
    @Nullable Integer maxAttempts,
    @Nullable Map<String, ?> retryPolicy,
    List<String> tags,
    @Nullable Idempotency idempotency,
    @Nullable Debounce debounce,
    @Nullable Throttle throttle,
    @Nullable Dependencies dependencies) {
  private static final EnqueueOptions DEFAULTS = builder().build();

  /** Copies the tags. */
  public EnqueueOptions {
    tags = List.copyOf(tags);
  }

  /** The options with every default. */
  public static EnqueueOptions defaults() {
    return DEFAULTS;
  }

  /** A builder with every default. */
  public static Builder builder() {
    return new Builder();
  }

  /** A builder that starts from these options. */
  public Builder toBuilder() {
    return new Builder()
        .queue(queue)
        .priority(priority)
        .concurrencyKey(concurrencyKey)
        .budget(budget)
        .runAt(runAt)
        .deadline(deadline)
        .executionTimeout(executionTimeout)
        .maxAttempts(maxAttempts)
        .retryPolicy(retryPolicy)
        .tags(tags)
        .idempotency(idempotency)
        .debounce(debounce)
        .throttle(throttle)
        .dependencies(dependencies);
  }

  /** Builds {@link EnqueueOptions}. Each method replaces one field. */
  public static final class Builder {
    private @Nullable String queue;
    private @Nullable Integer priority;
    private @Nullable String concurrencyKey;
    private @Nullable String budget;
    private @Nullable Instant runAt;
    private @Nullable Instant deadline;
    private @Nullable Duration executionTimeout;
    private @Nullable Integer maxAttempts;
    private @Nullable Map<String, ?> retryPolicy;
    private List<String> tags = List.of();
    private @Nullable Idempotency idempotency;
    private @Nullable Debounce debounce;
    private @Nullable Throttle throttle;
    private @Nullable Dependencies dependencies;

    private Builder() {}

    /** Sets the queue. */
    public Builder queue(@Nullable String queue) {
      this.queue = queue;
      return this;
    }

    /** Sets the priority. */
    public Builder priority(@Nullable Integer priority) {
      this.priority = priority;
      return this;
    }

    /** Sets the concurrency key. */
    public Builder concurrencyKey(@Nullable String concurrencyKey) {
      this.concurrencyKey = concurrencyKey;
      return this;
    }

    /** Sets the named budget. */
    public Builder budget(@Nullable String budget) {
      this.budget = budget;
      return this;
    }

    /** Sets the earliest run time. */
    public Builder runAt(@Nullable Instant runAt) {
      this.runAt = runAt;
      return this;
    }

    /** Sets the absolute deadline. */
    public Builder deadline(@Nullable Instant deadline) {
      this.deadline = deadline;
      return this;
    }

    /** Sets the timeout of each attempt. */
    public Builder executionTimeout(@Nullable Duration executionTimeout) {
      this.executionTimeout = executionTimeout;
      return this;
    }

    /** Sets the attempt limit. */
    public Builder maxAttempts(@Nullable Integer maxAttempts) {
      this.maxAttempts = maxAttempts;
      return this;
    }

    /** Sets the persisted retry policy. */
    public Builder retryPolicy(@Nullable Map<String, ?> retryPolicy) {
      this.retryPolicy = retryPolicy;
      return this;
    }

    /** Sets the tags. */
    public Builder tags(List<String> tags) {
      this.tags = tags;
      return this;
    }

    /** Sets the tags. */
    public Builder tags(String... tags) {
      this.tags = List.of(tags);
      return this;
    }

    /** Sets the enqueue idempotency. */
    public Builder idempotency(@Nullable Idempotency idempotency) {
      this.idempotency = idempotency;
      return this;
    }

    /** Sets the keyed debounce. */
    public Builder debounce(@Nullable Debounce debounce) {
      this.debounce = debounce;
      return this;
    }

    /** Sets the keyed throttle. */
    public Builder throttle(@Nullable Throttle throttle) {
      this.throttle = throttle;
      return this;
    }

    /** Sets the prerequisite tasks. */
    public Builder dependencies(@Nullable Dependencies dependencies) {
      this.dependencies = dependencies;
      return this;
    }

    /** The options. */
    public EnqueueOptions build() {
      return new EnqueueOptions(
          queue,
          priority,
          concurrencyKey,
          budget,
          runAt,
          deadline,
          executionTimeout,
          maxAttempts,
          retryPolicy,
          tags,
          idempotency,
          debounce,
          throttle,
          dependencies);
    }
  }
}
