package run.workhorse;

import java.lang.reflect.Type;
import org.jspecify.annotations.Nullable;

/**
 * A {@link Handler} that names its task type and its payload type, so that {@link
 * Worker.Builder#handle(TaskHandler)} can register it in one call.
 *
 * @param <P> the payload type
 */
public interface TaskHandler<P extends @Nullable Object> extends Handler<P> {
  /** The task type this handler runs. */
  String taskType();

  /** The type that the worker's codec decodes the payload as. */
  Type payloadType();
}
