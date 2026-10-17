package dev.stablemates.workhorse.internal;

import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * The run-time check of the PgJDBC version.
 *
 * <p>The build declares PgJDBC at its floor, but a caller's dependency resolution can select
 * another version. The SDK therefore reads the version of the driver that is on the class path when
 * it starts, and refuses a driver below the floor of ADR 0103.
 */
public final class PgjdbcVersion {
  /** The lowest PgJDBC release that the SDK supports. */
  public static final String FLOOR = "42.7.8";

  private static final Pattern RELEASE = Pattern.compile("^(\\d+)\\.(\\d+)\\.(\\d+)");

  private PgjdbcVersion() {}

  /**
   * Refuses a PgJDBC driver below {@link #FLOOR}.
   *
   * @throws IllegalStateException if the driver on the class path is older than the floor, or
   *     reports a version that the SDK cannot read
   */
  public static void require() {
    require(installed());
  }

  /**
   * The version that the PgJDBC driver on the class path reports.
   *
   * <p>{@code DriverInfo.DRIVER_VERSION} is a compile-time constant, so a direct reference would
   * give the version that this module compiled against. Reflection reads the loaded class.
   */
  static String installed() {
    try {
      Object version =
          Class.forName("org.postgresql.util.DriverInfo").getField("DRIVER_VERSION").get(null);
      if (version instanceof String text) {
        return text;
      }
      throw new IllegalStateException("PgJDBC reports no DRIVER_VERSION string");
    } catch (ReflectiveOperationException error) {
      throw new IllegalStateException("PgJDBC is not on the class path", error);
    }
  }

  static void require(String version) {
    int[] floor = release(FLOOR);
    int[] found = release(version);
    for (int index = 0; index < floor.length; index++) {
      if (found[index] != floor[index]) {
        if (found[index] < floor[index]) {
          throw new IllegalStateException(
              "Workhorse needs PgJDBC " + FLOOR + " or later, but found PgJDBC " + version);
        }
        return;
      }
    }
  }

  private static int[] release(String version) {
    Matcher matcher = RELEASE.matcher(version);
    if (!matcher.find()) {
      throw new IllegalStateException("PgJDBC reports an unknown version: " + version);
    }
    return new int[] {
      Integer.parseInt(matcher.group(1)),
      Integer.parseInt(matcher.group(2)),
      Integer.parseInt(matcher.group(3))
    };
  }
}
