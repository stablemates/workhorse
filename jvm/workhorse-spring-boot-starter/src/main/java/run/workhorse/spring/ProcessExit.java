package run.workhorse.spring;

import java.util.function.IntConsumer;
import org.springframework.boot.SpringApplication;
import org.springframework.context.ConfigurableApplicationContext;

/**
 * Ends an application that serves no web requests after its worker run ended without a stop. The
 * status is never 0, so a supervisor such as systemd with {@code Restart=on-failure} restarts the
 * process.
 */
final class ProcessExit {
  private ProcessExit() {}

  /**
   * Closes {@code context} through {@link SpringApplication#exit}, which stops the other lifecycle
   * beans and runs the exit code generators, and then calls {@code halt} with the status. A status
   * of 0 from the generators becomes 1.
   */
  static void exit(ConfigurableApplicationContext context, IntConsumer halt) {
    int status = 1;
    try {
      status = SpringApplication.exit(context, () -> 1);
    } finally {
      halt.accept(status == 0 ? 1 : status);
    }
  }
}
