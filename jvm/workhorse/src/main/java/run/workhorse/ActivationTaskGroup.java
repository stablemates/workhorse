package run.workhorse;

import java.util.List;
import java.util.Optional;
import java.util.function.Function;
import java.util.function.Supplier;

/**
 * The {@link TaskGroupContext} of one activation. A handler context and a batch member context each
 * give it their own read and their own fenced add.
 */
final class ActivationTaskGroup implements TaskGroupContext {
  private final Supplier<Optional<TaskGroupLink>> get;
  private final Function<List<EnqueueRequest>, List<EnqueueResult>> add;

  ActivationTaskGroup(
      Supplier<Optional<TaskGroupLink>> get,
      Function<List<EnqueueRequest>, List<EnqueueResult>> add) {
    this.get = get;
    this.add = add;
  }

  @Override
  public Optional<TaskGroupLink> get() {
    return get.get();
  }

  @Override
  public List<EnqueueResult> add(List<EnqueueRequest> requests) {
    return add.apply(List.copyOf(requests));
  }
}
