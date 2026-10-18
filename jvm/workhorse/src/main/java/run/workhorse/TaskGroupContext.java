package run.workhorse;

import java.util.List;
import java.util.Optional;

/**
 * The task group operations of one handler activation (ADR 0095). {@link HandlerContext#taskGroup}
 * returns it. The counterpart of Ruby's {@code TaskGroupContext}.
 */
public interface TaskGroupContext {
  /**
   * The group this task is a member of, or whose callback this task is, with its counts. It is
   * empty for a task with no group. The activation reads it one time and keeps it.
   */
  Optional<TaskGroupLink> get();

  /**
   * Adds at most 1,000 requests to the group of this member task, under the current fenced lease,
   * and returns their results in request order. A request with no queue goes to the queue of this
   * task. A running member task can add tasks after the seal, until its group is canceled.
   *
   * @throws IllegalArgumentException if this task is not a member task, or a request uses debounce
   *     or throttle
   * @throws LeaseLostException if the attempt lost its lease
   */
  List<EnqueueResult> add(List<EnqueueRequest> requests);
}
