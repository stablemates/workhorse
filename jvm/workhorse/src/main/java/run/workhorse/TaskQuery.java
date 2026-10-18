package run.workhorse;

import java.time.Instant;
import java.util.List;
import org.jspecify.annotations.Nullable;

/**
 * The filter, the page, and the payload projection of {@link Admin#listTasks}. Each field is a
 * keyword of Ruby's {@code Admin#list_tasks}.
 *
 * @param queue the queue, or {@code null} for every queue
 * @param type the task type, or {@code null} for every type
 * @param states the unique states to keep, or an empty list for every state
 * @param createdAfter the earliest creation time, or {@code null}
 * @param createdBefore the latest creation time, or {@code null}; it must be later than {@code
 *     createdAfter}
 * @param limit the page size, 1 to 1,000
 * @param cursor the cursor of the previous page, or {@code null} for the first page
 * @param payload the payload projection
 */
public record TaskQuery(
    @Nullable String queue,
    @Nullable String type,
    List<TaskState> states,
    @Nullable Instant createdAfter,
    @Nullable Instant createdBefore,
    int limit,
    @Nullable TaskListCursor cursor,
    TaskPayloadProjection payload) {
  private static final TaskQuery DEFAULTS = builder().build();

  /** Copies the states. */
  public TaskQuery {
    states = List.copyOf(states);
  }

  /** The first page of 100 tasks of every queue, without payloads. */
  public static TaskQuery defaults() {
    return DEFAULTS;
  }

  /** A builder with every default. */
  public static Builder builder() {
    return new Builder();
  }

  /** A builder that starts from this query. */
  public Builder toBuilder() {
    return new Builder()
        .queue(queue)
        .type(type)
        .states(states)
        .createdAfter(createdAfter)
        .createdBefore(createdBefore)
        .limit(limit)
        .cursor(cursor)
        .payload(payload);
  }

  /** Builds a {@link TaskQuery}. */
  public static final class Builder {
    private @Nullable String queue;
    private @Nullable String type;
    private List<TaskState> states = List.of();
    private @Nullable Instant createdAfter;
    private @Nullable Instant createdBefore;
    private int limit = 100;
    private @Nullable TaskListCursor cursor;
    private TaskPayloadProjection payload = TaskPayloadProjection.defaults();

    private Builder() {}

    /** Sets {@link TaskQuery#queue}. */
    public Builder queue(@Nullable String value) {
      queue = value;
      return this;
    }

    /** Sets {@link TaskQuery#type}. */
    public Builder type(@Nullable String value) {
      type = value;
      return this;
    }

    /** Sets {@link TaskQuery#states}. */
    public Builder states(List<TaskState> value) {
      states = value;
      return this;
    }

    /** Sets {@link TaskQuery#createdAfter}. */
    public Builder createdAfter(@Nullable Instant value) {
      createdAfter = value;
      return this;
    }

    /** Sets {@link TaskQuery#createdBefore}. */
    public Builder createdBefore(@Nullable Instant value) {
      createdBefore = value;
      return this;
    }

    /** Sets {@link TaskQuery#limit}. */
    public Builder limit(int value) {
      limit = value;
      return this;
    }

    /** Sets {@link TaskQuery#cursor}. */
    public Builder cursor(@Nullable TaskListCursor value) {
      cursor = value;
      return this;
    }

    /** Sets {@link TaskQuery#payload}. */
    public Builder payload(TaskPayloadProjection value) {
      payload = value;
      return this;
    }

    /** The query. */
    public TaskQuery build() {
      return new TaskQuery(
          queue, type, states, createdAfter, createdBefore, limit, cursor, payload);
    }
  }
}
