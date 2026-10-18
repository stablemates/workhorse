package run.workhorse;

import java.util.ArrayList;
import java.util.List;
import org.jspecify.annotations.Nullable;

/**
 * Collects the member tasks of the block form of {@link Queue#taskGroup(TaskGroupCallbacks,
 * java.util.function.Consumer)}. Nothing is enqueued until the block returns: the queue then
 * creates, adds, and seals the group in one statement.
 */
public final class TaskGroupBuilder {
  /** The member limit of one task group. */
  static final int MAX_MEMBERS = 100_000;

  private final List<EnqueueRequest> requests = new ArrayList<>();

  TaskGroupBuilder() {}

  /**
   * Adds at most 1,000 requests to the group. A request cannot use debounce or throttle.
   *
   * @throws IllegalArgumentException if the add is invalid, or takes the group above 100,000 tasks
   */
  public void add(List<EnqueueRequest> requests) {
    Queue.validateGroupAdd(requests);
    if (this.requests.size() + requests.size() > MAX_MEMBERS) {
      throw new IllegalArgumentException("a task group holds at most " + MAX_MEMBERS + " tasks");
    }
    this.requests.addAll(requests);
  }

  /** Adds one task with the default options. */
  public void enqueue(String taskType, @Nullable Object payload) {
    add(List.of(EnqueueRequest.of(taskType, payload)));
  }

  /** Adds one task. */
  public void enqueue(String taskType, @Nullable Object payload, EnqueueOptions options) {
    add(List.of(EnqueueRequest.of(taskType, payload, options)));
  }

  List<EnqueueRequest> requests() {
    return List.copyOf(requests);
  }
}
