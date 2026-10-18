package run.workhorse;

import java.lang.reflect.Type;
import java.util.Optional;
import java.util.concurrent.Callable;
import org.jspecify.annotations.Nullable;

/**
 * The {@link BatchHandlerContext} of one batch member. Each call goes to the member's own {@link
 * HandlerContext}, so it is fenced on the member's lease and refused on the fast tier as that
 * context refuses it.
 */
final class BatchMemberContext implements BatchHandlerContext {
  private final HandlerContext context;

  BatchMemberContext(HandlerContext context) {
    this.context = context;
  }

  @Override
  public ClaimedTask task() {
    return context.task();
  }

  @Override
  public CancellationToken cancellation() {
    return context.cancellation();
  }

  @Override
  public Optional<TaskCheckpoint> getCheckpoint(String name) {
    return context.getCheckpoint(name);
  }

  @Override
  public <T extends @Nullable Object> T checkpoint(String name, Type type, Callable<T> operation) {
    return context.checkpoint(name, type, operation);
  }

  @Override
  public <T extends @Nullable Object> T checkpoint(
      String name, Type type, CheckpointOptions options, Callable<T> operation) {
    return context.checkpoint(name, type, options, operation);
  }

  @Override
  public Optional<TaskProgress> getProgress() {
    return context.getProgress();
  }

  @Override
  public TaskProgress setProgress(@Nullable Object progress) {
    return context.setProgress(progress);
  }

  @Override
  public TaskGroupContext taskGroup() {
    return context.taskGroup();
  }
}
