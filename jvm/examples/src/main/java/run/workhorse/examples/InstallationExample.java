package run.workhorse.examples;

import javax.sql.DataSource;
import run.workhorse.ConnectionSource;
import run.workhorse.Queue;

/** The schema check before a runtime starts: the site page about installation. */
public final class InstallationExample {
  private InstallationExample() {}

  /** Throws {@code CompatibilityException} if the installed schema does not match. */
  public static Queue check(DataSource dataSource) {
    // docs:start java-assert-compatible
    Queue queue = new Queue(ConnectionSource.of(dataSource));
    queue.assertCompatible();
    // docs:end
    return queue;
  }
}
