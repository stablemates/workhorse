package run.workhorse.examples;

import java.util.Map;
import org.jspecify.annotations.Nullable;

/** The mail provider of the snippets. */
public interface Mailer {
  /** Sends one email and returns the result that the task stores. */
  Map<String, @Nullable Object> send(Map<?, ?> payload);
}
