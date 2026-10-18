package run.workhorse;

import java.lang.reflect.Type;
import java.util.Optional;
import java.util.concurrent.Callable;
import org.jspecify.annotations.Nullable;

/**
 * What a batch handler receives for one member. The counterpart of Ruby's {@code
 * BatchHandlerContext} (ADR 0103, "Durable handler context").
 *
 * <p>Each call reads or writes only the durable state of this member, and each write carries the
 * member's own fence token. So a retry replays its checkpoints whatever batch it lands in. The
 * context has no call that suspends a task or creates a child, because one handler call runs every
 * member (ADR 0030).
 *
 * <p>A member on a fast-tier queue has no durable execution state (ADR 0077). {@link #checkpoint}
 * and {@link #setProgress} then throw {@link FastTierUnsupportedException} before any write.
 */
public interface BatchHandlerContext {
  /** The member's task. */
  ClaimedTask task();

  /** The member's cancellation token. */
  CancellationToken cancellation();

  /** The checkpoint named {@code name} that this member saved, or empty when it saved none. */
  Optional<TaskCheckpoint> getCheckpoint(String name);

  /** As {@link HandlerContext#checkpoint(String, Type, Callable)}, for this member. */
  <T extends @Nullable Object> T checkpoint(String name, Type type, Callable<T> operation);

  /**
   * As {@link HandlerContext#checkpoint(String, Type, CheckpointOptions, Callable)}, for this
   * member.
   */
  <T extends @Nullable Object> T checkpoint(
      String name, Type type, CheckpointOptions options, Callable<T> operation);

  /** The progress that this member reported last, or empty. */
  Optional<TaskProgress> getProgress();

  /** As {@link HandlerContext#setProgress}, for this member. */
  TaskProgress setProgress(@Nullable Object progress);

  /** The task group operations of this member. */
  TaskGroupContext taskGroup();
}
