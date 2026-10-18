package run.workhorse;

import java.time.Instant;
import java.util.List;
import org.jspecify.annotations.Nullable;

/**
 * The filter and the page of {@link Admin#listDeadLetters}. Each field is a keyword of Ruby's
 * {@code Admin#list_dead_letters}.
 *
 * @param limit the page size, 1 to 1,000
 * @param cursor the cursor of the previous page, or {@code null} for the first page
 * @param queue the queue, or {@code null} for every queue
 * @param type the task type, or {@code null} for every type
 * @param tags the tags that each failed task must have, or an empty list
 * @param errorName the error name of the last attempt, or {@code null} or empty for every name
 * @param finishedAfter the earliest finish time, or {@code null}
 * @param finishedBefore the latest finish time, or {@code null}
 */
public record DeadLetterQuery(
    int limit,
    @Nullable DeadLetterCursor cursor,
    @Nullable String queue,
    @Nullable String type,
    List<String> tags,
    @Nullable String errorName,
    @Nullable Instant finishedAfter,
    @Nullable Instant finishedBefore) {
  private static final DeadLetterQuery DEFAULTS = builder().build();

  /** Copies the tags. */
  public DeadLetterQuery {
    tags = List.copyOf(tags);
  }

  /** The first page of 100 failed tasks of every queue. */
  public static DeadLetterQuery defaults() {
    return DEFAULTS;
  }

  /** A builder with every default. */
  public static Builder builder() {
    return new Builder();
  }

  /** A builder that starts from this query. */
  public Builder toBuilder() {
    return new Builder()
        .limit(limit)
        .cursor(cursor)
        .queue(queue)
        .type(type)
        .tags(tags)
        .errorName(errorName)
        .finishedAfter(finishedAfter)
        .finishedBefore(finishedBefore);
  }

  /** Builds a {@link DeadLetterQuery}. */
  public static final class Builder {
    private int limit = 100;
    private @Nullable DeadLetterCursor cursor;
    private @Nullable String queue;
    private @Nullable String type;
    private List<String> tags = List.of();
    private @Nullable String errorName;
    private @Nullable Instant finishedAfter;
    private @Nullable Instant finishedBefore;

    private Builder() {}

    /** Sets {@link DeadLetterQuery#limit}. */
    public Builder limit(int value) {
      limit = value;
      return this;
    }

    /** Sets {@link DeadLetterQuery#cursor}. */
    public Builder cursor(@Nullable DeadLetterCursor value) {
      cursor = value;
      return this;
    }

    /** Sets {@link DeadLetterQuery#queue}. */
    public Builder queue(@Nullable String value) {
      queue = value;
      return this;
    }

    /** Sets {@link DeadLetterQuery#type}. */
    public Builder type(@Nullable String value) {
      type = value;
      return this;
    }

    /** Sets {@link DeadLetterQuery#tags}. */
    public Builder tags(List<String> value) {
      tags = value;
      return this;
    }

    /** Sets {@link DeadLetterQuery#errorName}. */
    public Builder errorName(@Nullable String value) {
      errorName = value;
      return this;
    }

    /** Sets {@link DeadLetterQuery#finishedAfter}. */
    public Builder finishedAfter(@Nullable Instant value) {
      finishedAfter = value;
      return this;
    }

    /** Sets {@link DeadLetterQuery#finishedBefore}. */
    public Builder finishedBefore(@Nullable Instant value) {
      finishedBefore = value;
      return this;
    }

    /** The query. */
    public DeadLetterQuery build() {
      return new DeadLetterQuery(
          limit, cursor, queue, type, tags, errorName, finishedAfter, finishedBefore);
    }
  }
}
